/**
 * Phase 2.3 Stage 5 — Main image generation via OpenAI gpt-image-1.
 *
 * One call = one image. Returns a PERMANENT R2 URL (re-hosted from the
 * temporary OpenAI URL or decoded from the base64 the API returns) plus
 * the cost in cents and the prompt that was actually sent (so the
 * pipeline can persist it for audit).
 *
 * Why we re-host every image to R2:
 *   OpenAI's hosted result URLs are signed and expire after 1 hour. The
 *   listing must point at a stable URL forever, and Vladimir's standing
 *   rule (see r2-image-mirror.ts) is "all production images live on our
 *   infrastructure" so retailer/manufacturer URL rotations can't break
 *   listings retroactively.
 *
 * Cost: gpt-image-1 1024×1024 standard = ~$0.04. Higher resolutions
 * available but Amazon's main-image displayable area maxes at ~2000px
 * and our zoom requirement is 1600×1600 — 1024 upscaled cleanly meets
 * both. Configurable via input.size.
 *
 * Dev-mock path: if OPENAI_API_KEY is missing OR a global stub is
 * registered (`globalThis.__BUNDLE_FACTORY_OPENAI_STUB__`), we return a
 * deterministic placeholder URL so the rest of the pipeline (compliance
 * gate, persistence, UI) can be exercised without OpenAI credits.
 */

import OpenAI from "openai";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const MODEL = "gpt-image-1";
const DEFAULT_BUCKET = "salutem-bundle-factory";
const PLACEHOLDER = "placeholder";

// Per Amazon's main-image guidelines: 1:1 square, white background,
// product fills ≥85% of frame. gpt-image-1 returns square by default
// for "1024x1024" / "1536x1536"; we ask for 1024 to keep cost down and
// upscale on the client if needed.
const DEFAULT_SIZE = "1024x1024";

// Cost table (USD per image) — source: OpenAI pricing page snapshot
// 2026-05-19. Update when OpenAI publishes a new tier. Standard quality
// is what we use; HD doubles the cost without meaningful gain on a
// flat-lay studio shot.
const COST_USD_BY_SIZE: Record<string, number> = {
  "1024x1024": 0.04,
  "1024x1536": 0.06,
  "1536x1024": 0.06,
  "1536x1536": 0.06,
};

export interface RewriteFeedback {
  /** Logos surfaced by Rule 6 on the prior attempt — used to build a
   *  stronger negative prompt. */
  detected_logos?: string[];
  /** Free-text reason from the prior compliance failure (e.g. "main_image_foreign_logos"). */
  failure_reason?: string;
  /** 1-based attempt number — first retry is `attempt: 2`. */
  attempt: number;
}

export interface ImageGenerationInput {
  /** Required: the prompt produced by image-pipeline's prompt builder. */
  prompt: string;
  /** Subdirectory under `prod/` in R2 — typically
   *  `draft-<id>-<channel>`. Sanitised by the R2 mirror. */
  r2_path_slug: string;
  /** Optional: retry feedback so the cost/log can show why we redrew. */
  retry_context?: RewriteFeedback;
  /** Size override; default `1024x1024`. */
  size?: keyof typeof COST_USD_BY_SIZE;
}

export interface ImageGenerationOutput {
  /** Permanent R2 public URL, OR `null` when the call failed. */
  image_url: string | null;
  cost_cents: number;
  /** What we sent to OpenAI (after retry-context augmentation). Stored
   *  for audit so we can later answer "why did Claude generate this image?". */
  prompt_used: string;
  /** Set when we used the dev-mock path (no OPENAI_API_KEY, or stub). */
  mock_mode: boolean;
  /** Set on error — the rest of the pipeline treats this as fail-CLOSED. */
  error?: string;
}

// ── Client init (graceful nulls, never throws) ────────────────────────

interface OpenAILike {
  images: {
    generate: (args: Record<string, unknown>) => Promise<{
      data?: Array<{ url?: string; b64_json?: string }>;
    }>;
  };
}

let _openai: OpenAI | null = null;
function getOpenAIClient(): OpenAILike | null {
  const stub = (globalThis as { __BUNDLE_FACTORY_OPENAI_STUB__?: OpenAILike })
    .__BUNDLE_FACTORY_OPENAI_STUB__;
  if (stub) return stub;
  if (_openai) return _openai as unknown as OpenAILike;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _openai = new OpenAI({ apiKey: key });
  return _openai as unknown as OpenAILike;
}

let _r2: S3Client | null = null;
function getR2Client(): S3Client | null {
  const stub = (globalThis as { __BUNDLE_FACTORY_R2_STUB__?: S3Client })
    .__BUNDLE_FACTORY_R2_STUB__;
  if (stub) return stub;
  if (_r2) return _r2;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (
    !accountId ||
    !accessKey ||
    !secret ||
    accountId === PLACEHOLDER ||
    accessKey === PLACEHOLDER ||
    secret === PLACEHOLDER
  ) {
    return null;
  }
  _r2 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });
  return _r2;
}

// ── Public surface ─────────────────────────────────────────────────────

const SLUG_RE = /[^a-zA-Z0-9_-]+/g;
function safeSlug(s: string): string {
  return s.replace(SLUG_RE, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "anon";
}

function costCentsForSize(size: string): number {
  const usd = COST_USD_BY_SIZE[size] ?? COST_USD_BY_SIZE[DEFAULT_SIZE];
  return Math.ceil(usd * 100);
}

/** Augment the prompt with retry-aware negative constraints. Visible
 *  for tests so the pipeline doesn't have to round-trip OpenAI just to
 *  verify the negative-brand list rendering. */
export function buildFinalPrompt(input: ImageGenerationInput): string {
  if (!input.retry_context || input.retry_context.attempt < 2) {
    return input.prompt;
  }
  const logos = input.retry_context.detected_logos ?? [];
  const extras: string[] = [];
  if (logos.length > 0) {
    const banList = logos
      .map((l) => `"${l}"`)
      .join(", ");
    extras.push(
      `CRITICAL — previous attempt was rejected for showing branded packaging. Do NOT show any of these brand names/logos anywhere in the image: ${banList}. Use entirely generic, unbranded packaging.`,
    );
  } else if (input.retry_context.failure_reason) {
    extras.push(
      `Previous attempt failed compliance review (${input.retry_context.failure_reason}). Show generic, unbranded packaging only.`,
    );
  }
  return [input.prompt, ...extras].join("\n\n");
}

export async function generateMainImage(
  input: ImageGenerationInput,
): Promise<ImageGenerationOutput> {
  const openai = getOpenAIClient();
  const r2 = getR2Client();
  const size = input.size ?? DEFAULT_SIZE;
  const finalPrompt = buildFinalPrompt(input);

  // Dev-mock path — no OpenAI client.
  if (!openai) {
    return {
      image_url: mockPlaceholderUrl(input.r2_path_slug),
      cost_cents: 0,
      prompt_used: finalPrompt,
      mock_mode: true,
      error: undefined,
    };
  }

  let response: { data?: Array<{ url?: string; b64_json?: string }> };
  try {
    response = await openai.images.generate({
      model: MODEL,
      prompt: finalPrompt,
      size,
      n: 1,
    });
  } catch (e) {
    return {
      image_url: null,
      cost_cents: 0,
      prompt_used: finalPrompt,
      mock_mode: false,
      error: `OpenAI Images API failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const first = response.data?.[0];
  if (!first || (!first.url && !first.b64_json)) {
    return {
      image_url: null,
      cost_cents: costCentsForSize(size),
      prompt_used: finalPrompt,
      mock_mode: false,
      error: "OpenAI returned no image data",
    };
  }

  // Materialise to bytes — handle both URL and base64 responses.
  let imageBytes: Buffer;
  try {
    if (first.b64_json) {
      imageBytes = Buffer.from(first.b64_json, "base64");
    } else {
      const fetched = await fetch(first.url!, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!fetched.ok) {
        throw new Error(`HTTP ${fetched.status} downloading OpenAI URL`);
      }
      imageBytes = Buffer.from(await fetched.arrayBuffer());
    }
  } catch (e) {
    return {
      image_url: null,
      cost_cents: costCentsForSize(size),
      prompt_used: finalPrompt,
      mock_mode: false,
      error: `Failed to materialise OpenAI image: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Upload to R2. If R2 unconfigured, fall back to returning a data URL
  // — useful for local dev where R2 creds aren't set. Production has
  // R2 wired up.
  const r2PublicUrl = process.env.R2_PUBLIC_URL;
  if (!r2 || !r2PublicUrl) {
    return {
      image_url: `data:image/png;base64,${imageBytes.toString("base64")}`,
      cost_cents: costCentsForSize(size),
      prompt_used: finalPrompt,
      mock_mode: false,
      error: "R2 not configured — returned data: URL (not for production)",
    };
  }

  const bucket = process.env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const slug = safeSlug(input.r2_path_slug);
  // Phase 2.3 spec puts generated assets under `prod/` — distinct from
  // the `sec/` prefix used by r2-image-mirror.ts for sourced retailer
  // images. Pipeline appends an attempt suffix so retries don't overwrite
  // a still-pending compliance check on the previous attempt.
  const attemptSuffix =
    input.retry_context && input.retry_context.attempt > 1
      ? `-retry${input.retry_context.attempt}`
      : "";
  const key = `prod/${slug}/main${attemptSuffix}.png`;

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: imageBytes,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000",
      }),
    );
  } catch (e) {
    return {
      image_url: null,
      cost_cents: costCentsForSize(size),
      prompt_used: finalPrompt,
      mock_mode: false,
      error: `R2 upload failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const base = r2PublicUrl.replace(/\/+$/, "");
  return {
    image_url: `${base}/${key}`,
    cost_cents: costCentsForSize(size),
    prompt_used: finalPrompt,
    mock_mode: false,
  };
}

/** Deterministic placeholder used in dev when OPENAI_API_KEY is missing.
 *  Returns a stable URL per slug so re-runs don't break the pipeline. */
function mockPlaceholderUrl(slug: string): string {
  const safe = safeSlug(slug);
  // 1024×1024 grey square from placehold.co — no auth, no rate limit.
  return `https://placehold.co/1024x1024/e5e5e5/666666.png?text=mock+${safe}`;
}
