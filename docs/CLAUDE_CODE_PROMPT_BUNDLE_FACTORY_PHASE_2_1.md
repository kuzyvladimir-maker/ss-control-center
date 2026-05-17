# CLAUDE CODE PROMPT — Bundle Factory Phase 2.1 (Brief + Research)

> **For:** Claude Code (VS Code extension)
> **Project path:** `/Users/vladimirkuznetsov/SS Command Center/ss-control-center/`
> **Created:** 2026-05-17
> **Estimated work:** 6-8 hours autonomous execution
> **Branch strategy:** Create `feat/bundle-factory-phase-2.1` from `main`
> **Prerequisite:** Phase 1 merged to main (✅ confirmed 2026-05-17)

---

## 🎯 ТВОЯ ЗАДАЧА

Реализовать **Phase 2.1** Bundle Factory: Stage 1 (Brief Input) + Stage 2 (Research) + Stage 2.5 (Image Mirror — NEW). После этой фазы Vladimir сможет:

1. Войти на `/bundle-factory/briefs/new` → multi-step form → ввести идею ("Pizza Lunch Gift Set, frozen, $40-60, Pack of 12")
2. Submit → создаются `GenerationJob` + `BundleDraft` со статусом DRAFT
3. Click "Run Research" → trigger Stage 2 → Perplexity API ищет products + reference image URLs в radius 10mi
4. **Stage 2.5 (Image Mirror)** — background: downloads reference images из retail/manufacturer sites → uploads в Cloudflare R2 → replaces URLs в DB с self-hosted R2 URLs (Vladimir wants ALL images on own infrastructure, не external)
5. Через ~30-60 секунд видит populated `ResearchPool` (10-30 product candidates) с safely-hosted image URLs
6. Curate pool: approve / remove / edit items
7. Click "Approve Research → Continue to Variation Matrix" → BundleDraft transitions to RESEARCHED status

### Channel scope (clarified 2026-05-17)

**Default target_channels для Phase 2:** 6 channel SKUs per MasterBundle:
- AMAZON_SALUTEM
- AMAZON_PERSONAL
- AMAZON_AMZCOM
- AMAZON_SIRIUS
- AMAZON_RETAILER
- WALMART

**eBay + TikTok отложены к Phase 3-4.** UI должна показывать только эти 6 channels по умолчанию (можно add others в advanced mode, но они marked as "Coming in Phase 3+").

**Не входит в Phase 2.1:** Stage 3+ (Variation Matrix, Content Generation, Main Image Generation, Validation, Distribution). Эти sub-phases — отдельные промпты.

---

## 📚 КРИТИЧЕСКИ ВАЖНЫЕ источники (читать в этом порядке)

1. **`docs/PHASE_1_COMPLETION_REPORT.md`** — что было сделано в Phase 1, какие patterns использованы
2. **`docs/BUNDLE_FACTORY_CONCEPT_v1_0.md`** — section "Stage 1: Brief" и "Stage 2: Research" в pipeline overview
3. **`docs/BUNDLE_FACTORY_DATA_MODEL.md`** — модели `GenerationJob`, `GenerationStage`, `BundleDraft`, `ResearchPool`
4. **`docs/BUNDLE_FACTORY_SOURCING_MAP.md` v1.1** — 37 stores с координатами (use в Perplexity query context)
5. **`docs/marketplace-rules/amazon/gift-set-policy.md`** — правила композиции bundles (Vladimir's brand strategy)
6. **`src/lib/bundle-factory/enums.ts`** — все enum values
7. **`src/app/api/bundle-factory/briefs/route.ts`** — existing POST/GET pattern для bundle factory APIs
8. **`src/app/api/bundle-factory/research/route.ts`** — existing placeholder для ResearchPool CRUD
9. **`src/lib/bundle-factory/api-utils.ts`** — `withErrorHandler`, `badRequest`, `readJson`, `intParam` helpers
10. **`docs/wiki/design/index.md`** — Salutem Design System v1.0

---

## ✅ PHASE 2.1 SCOPE CHECKLIST

Self-managed checklist. Помечай `[x]` по мере выполнения, в финальный `PHASE_2_1_COMPLETION_REPORT.md` поставь итоговые галочки.

### STEP 0 — Production deploy (Phase 1 final piece)

Перед началом implementation work — apply Phase 1 migration к Turso production. Это **обязательный prerequisite** иначе production не работает.

- [ ] **0.1** Apply Turso migration:
  ```bash
  cd ss-control-center
  node scripts/turso-migrate-bundle-factory-phase-1.mjs
  ```
  Expected output: "Tables created: 14, Indexes created: N, Migration complete."

- [ ] **0.2** Seed production Turso:
  ```bash
  SEED_TARGET=turso npx prisma db seed
  ```
  Expected: `stores=37 accounts=9 upcs=0 rules=30 exemptions=63`

- [ ] **0.3** Verify production через quick curl:
  ```bash
  curl https://ss-control-center.vercel.app/api/bundle-factory/stores?tier=TIER_1 | head -50
  ```
  Should return Walmart + BJ's stores.

**Если хоть один из 0.1-0.3 fails — STOP и report. Не идти дальше пока production не работает.**

### STEP 1 — Branch setup

- [ ] **1.1** Pull latest main: `git checkout main && git pull origin main`
- [ ] **1.2** Create branch: `git checkout -b feat/bundle-factory-phase-2.1`

### STEP 2 — Environment & dependencies

- [ ] **2.1** Add `PERPLEXITY_API_KEY` to `.env.example`:
  ```
  # Perplexity API for Bundle Factory Stage 2 (Research)
  # Get key at https://www.perplexity.ai/settings/api
  PERPLEXITY_API_KEY=""
  ```

- [ ] **2.2** Add Cloudflare R2 credentials to `.env.example`:
  ```
  # Cloudflare R2 для Bundle Factory image storage
  # Setup guide: docs/wiki/cloudflare-r2-setup.md
  # Get credentials at https://dash.cloudflare.com/ → R2 → Manage R2 API Tokens
  R2_ACCOUNT_ID=""
  R2_ACCESS_KEY_ID=""
  R2_SECRET_ACCESS_KEY=""
  R2_BUCKET_NAME="salutem-bundle-factory"
  R2_PUBLIC_URL="https://images.salutemsolutions.info"
  ```

- [ ] **2.3** Update `.env` locally с placeholder values (Vladimir fills production values later):
  ```
  PERPLEXITY_API_KEY="pplx-placeholder-vladimir-fills-this"
  R2_ACCOUNT_ID="placeholder"
  R2_ACCESS_KEY_ID="placeholder"
  R2_SECRET_ACCESS_KEY="placeholder"
  R2_BUCKET_NAME="salutem-bundle-factory"
  R2_PUBLIC_URL="https://pub-placeholder.r2.dev"
  ```

  **Note for Vladimir:** R2 credentials не критичны для Phase 2.1 testing — Stage 2.5 (Image Mirror) сможет проверить наличие R2 ключей и graceful skip с warning если ключей нет. Для production R2 setup — see `docs/wiki/cloudflare-r2-setup.md`.

- [ ] **2.4** Install AWS SDK для R2 (S3-compatible):
  ```bash
  npm install @aws-sdk/client-s3
  ```
  
  (R2 supports S3 API, AWS SDK works perfectly with R2 endpoints. Это одна из немногих необходимых dependencies.)

### STEP 3 — Perplexity API client

Создать `src/lib/bundle-factory/perplexity.ts`:

```typescript
/**
 * Perplexity API client for Bundle Factory Stage 2 (Research).
 *
 * Uses sonar-pro model — Perplexity's grounded research model that returns
 * web citations. We instruct it to find retail-available products near
 * Clearwater, FL, and return structured JSON.
 *
 * Docs: https://docs.perplexity.ai/reference/post_chat_completions
 */

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const MODEL = "sonar-pro";

export interface PerplexityResearchProduct {
  product_name: string;
  brand: string;
  manufacturer?: string;
  upc?: string;
  pack_sizes?: string[];        // ["6 ct", "12 ct", "24 ct"]
  flavors?: string[];           // ["Pepperoni", "Cheese", "Ham"]
  weight_oz?: number;
  ingredients?: string;
  allergens?: string[];         // ["Milk", "Wheat", "Soybeans"]
  storage_temp?: "Frozen" | "Refrigerated" | "Ambient";
  expiration_days?: number;
  avg_price_cents?: number;     // e.g. 850 = $8.50
  source_store_name?: string;   // e.g. "Walmart Clearwater US-19"
  source_url?: string;          // direct product URL if available
  reference_image_urls?: string[];
  freshness_score?: number;     // 0-100, AI-assessed retail availability stability
  in_stock_confidence?: "high" | "medium" | "low";
  notes?: string;
}

export interface PerplexityResearchResponse {
  products: PerplexityResearchProduct[];
  citations: string[];
  raw_response: string;
}

export async function researchProducts(params: {
  query: string;                    // user's research query (theme of bundle)
  category: string;                 // product category (FROZEN_GROCERY etc.)
  brand_hint?: string;              // optional brand to focus on (Lunchables, Jimmy Dean)
  max_products?: number;            // default 25
  sourcing_radius_stores: string[]; // names like "Walmart", "Target", "Publix", "BJ's"
}): Promise<PerplexityResearchResponse> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not set");

  const systemPrompt = buildSystemPrompt(params);
  const userPrompt = buildUserPrompt(params);

  const response = await fetch(PERPLEXITY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,           // low — we want grounded, factual results
      max_tokens: 4000,
      return_citations: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Perplexity API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const citations: string[] = data.citations ?? [];

  // Parse JSON from response. Sonar-pro sometimes wraps in ```json fences.
  const products = parseProductsFromResponse(content);

  return {
    products,
    citations,
    raw_response: content,
  };
}

function buildSystemPrompt(params: {
  query: string;
  category: string;
  sourcing_radius_stores: string[];
}): string {
  return `You are a retail product researcher for an e-commerce business in Clearwater, Florida.
Your job is to find retail-available products that can be purchased TODAY from physical stores within a 10-mile radius of zip code 33765 and used as components in gift bundles.

AVAILABLE STORES (in priority order):
${params.sourcing_radius_stores.join(", ")}

PRODUCT CATEGORY: ${params.category}

OUTPUT FORMAT: Return ONLY a valid JSON object with this exact structure:
{
  "products": [
    {
      "product_name": "string (full retail name)",
      "brand": "string (manufacturer brand)",
      "manufacturer": "string (legal manufacturer entity, if known)",
      "upc": "string (12-digit UPC if known, omit otherwise)",
      "pack_sizes": ["array of available pack counts"],
      "flavors": ["array of flavor variants"],
      "weight_oz": number,
      "ingredients": "string (short, if known)",
      "allergens": ["Milk", "Wheat", "Soybeans", "Eggs", "Fish", "Crustacean shellfish", "Tree nuts", "Peanuts", "Sesame"],
      "storage_temp": "Frozen" | "Refrigerated" | "Ambient",
      "expiration_days": number (typical shelf life from production),
      "avg_price_cents": number (e.g. 850 = $8.50, retail single-unit price),
      "source_store_name": "string (best store to buy from)",
      "source_url": "string (direct product URL if available)",
      "reference_image_urls": ["https://..."],
      "freshness_score": number (0-100, your confidence this product is consistently in stock at retail),
      "in_stock_confidence": "high" | "medium" | "low",
      "notes": "string (brief observation, e.g. 'Walmart $0.50 cheaper than Target')"
    }
  ]
}

RULES:
- Only include products that exist at major US retailers TODAY (2026).
- Prefer products with broad availability (Walmart > Target > Publix > specialty).
- For frozen items, verify they ship/store frozen.
- For each product, set freshness_score based on retail consistency — Lunchables, Jimmy Dean, etc. = 90+; seasonal items = 60-80; specialty items = 40-60.
- Allergens MUST use exact FDA terminology from the list above.
- If pack_sizes are not standard, omit the field.
- Return AT LEAST ${params.query.includes("variety") ? "15" : "10"} products if the query allows.
- NO markdown, NO commentary, ONLY the JSON object.`;
}

function buildUserPrompt(params: {
  query: string;
  brand_hint?: string;
}): string {
  const brandLine = params.brand_hint
    ? `Focus brand: ${params.brand_hint}.`
    : "Broad search across multiple brands.";
  return `Find 15-25 retail products that match this concept:

"${params.query}"

${brandLine}

These products will be combined into a gift bundle, so prioritize:
1. Visually appealing packaging
2. Reliable retail availability (in stock 90%+ of the year)
3. Reasonable per-unit price ($1-$10 typical)
4. Compatible storage requirements

Return the JSON object now.`;
}

function parseProductsFromResponse(content: string): PerplexityResearchProduct[] {
  // Strip markdown code fences if present
  let jsonStr = content.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  }

  // Find first { and last } as fallback
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Perplexity response did not contain JSON object");
  }
  jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.products || !Array.isArray(parsed.products)) {
      throw new Error("Perplexity response missing 'products' array");
    }
    return parsed.products as PerplexityResearchProduct[];
  } catch (e) {
    throw new Error(
      `Failed to parse Perplexity JSON: ${e instanceof Error ? e.message : "unknown"}\n\nRaw: ${jsonStr.slice(0, 500)}`
    );
  }
}
```

### STEP 4 — Research pipeline orchestrator

Создать `src/lib/bundle-factory/research-pipeline.ts`. **ВАЖНО:** После шагов 6-8 в research-pipeline добавлен **Stage 2.5 (Image Mirror)** который downloads reference images и uploads в Cloudflare R2 (см. STEP 4.5 ниже).

```typescript
/**
 * Stage 2 (Research) pipeline orchestrator.
 *
 * Given a BundleDraft in DRAFT status, this module:
 *   1. Creates a GenerationStage(stage=RESEARCH, status=IN_PROGRESS)
 *   2. Calls Perplexity API with structured prompt
 *   3. Resolves source_store_name → StoreRegistry.id when possible
 *   4. Creates ResearchPool rows in DB
 *   5. Updates BundleDraft.status to RESEARCHED
 *   6. Marks GenerationStage as COMPLETED (or FAILED on error)
 *
 * Designed to run as a server action / background task. Idempotent on
 * partial failure: re-running deletes prior ResearchPool rows for the
 * same generation_job_id before creating new ones.
 */

import { prisma } from "@/lib/prisma";
import { researchProducts, type PerplexityResearchProduct } from "./perplexity";
import { logLifecycle } from "./lifecycle-log";

export interface RunResearchInput {
  bundle_draft_id: string;
  trigger: "manual" | "auto";
  actor?: string; // for audit log
}

export interface RunResearchResult {
  ok: boolean;
  generation_job_id: string;
  pool_size: number;
  duration_ms: number;
  citations: string[];
  error?: string;
}

export async function runResearch(input: RunResearchInput): Promise<RunResearchResult> {
  const startMs = Date.now();

  // 1. Load BundleDraft + verify state
  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
  });
  if (!draft) throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  if (draft.status !== "DRAFT") {
    throw new Error(
      `BundleDraft ${draft.id} is in status ${draft.status}, expected DRAFT`
    );
  }

  const jobId = draft.generation_job_id;

  // 2. Mark stage IN_PROGRESS
  await upsertStage(jobId, "RESEARCH", "IN_PROGRESS", {
    started_at: new Date(),
  });

  // 3. Delete any prior ResearchPool rows for this job (idempotency)
  await prisma.researchPool.deleteMany({
    where: { generation_job_id: jobId },
  });

  try {
    // 4. Pull Tier 1 + Tier 2 store chain list for prompt context
    const stores = await prisma.storeRegistry.findMany({
      where: { is_active: true, tier: { in: ["TIER_1", "TIER_2"] } },
      orderBy: { default_priority: "asc" },
      take: 20,
    });
    const sourcingChains = Array.from(new Set(stores.map((s) => s.chain)));

    // 5. Build query from BundleDraft
    const query = buildQueryFromDraft(draft);

    // 6. Call Perplexity
    const result = await researchProducts({
      query,
      category: draft.category,
      brand_hint: extractBrandHint(draft),
      sourcing_radius_stores: sourcingChains,
      max_products: 25,
    });

    // 7. Resolve store names → StoreRegistry.id
    const storeIdByName = new Map<string, string>();
    for (const s of stores) {
      // Match by chain (case-insensitive contains)
      storeIdByName.set(s.chain.toLowerCase(), s.id);
    }

    // 8. Create ResearchPool rows
    let createdCount = 0;
    for (const product of result.products) {
      try {
        await prisma.researchPool.create({
          data: {
            generation_job_id: jobId,
            research_query: query,
            product_name: product.product_name,
            brand: product.brand,
            manufacturer: product.manufacturer ?? null,
            upc: product.upc ?? null,
            flavors: product.flavors ? JSON.stringify(product.flavors) : null,
            pack_sizes: product.pack_sizes ? JSON.stringify(product.pack_sizes) : null,
            weight_oz: product.weight_oz ?? null,
            weight_lb: product.weight_oz ? product.weight_oz / 16 : null,
            ingredients: product.ingredients ?? null,
            allergens: product.allergens ? JSON.stringify(product.allergens) : null,
            storage_temp: product.storage_temp ?? null,
            expiration_days: product.expiration_days ?? null,
            avg_price_cents: product.avg_price_cents ?? null,
            source_store_id: resolveStoreId(product.source_store_name, storeIdByName),
            source_url: product.source_url ?? null,
            reference_image_urls: JSON.stringify(product.reference_image_urls ?? []),
            freshness_score: product.freshness_score ?? null,
            last_seen_in_stock: new Date(),
          },
        });
        createdCount++;
      } catch (e) {
        // Skip individual product errors, continue with rest
        console.error(`[research] Failed to insert product ${product.product_name}:`, e);
      }
    }

    // 9. Update BundleDraft status
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "RESEARCHED" },
    });

    // 10. Mark stage COMPLETED
    const durationMs = Date.now() - startMs;
    await upsertStage(jobId, "RESEARCH", "COMPLETED", {
      ended_at: new Date(),
      duration_ms: durationMs,
      metadata: JSON.stringify({
        pool_size: createdCount,
        citations: result.citations,
        query_used: query,
      }),
    });

    // 11. Lifecycle audit log
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: "DRAFT",
      to_status: "RESEARCHED",
      reason: `Research completed: ${createdCount} products in ${(durationMs / 1000).toFixed(1)}s`,
      actor: input.actor ?? "system",
      details: { pool_size: createdCount, trigger: input.trigger },
    });

    return {
      ok: true,
      generation_job_id: jobId,
      pool_size: createdCount,
      duration_ms: durationMs,
      citations: result.citations,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const durationMs = Date.now() - startMs;
    await upsertStage(jobId, "RESEARCH", "FAILED", {
      ended_at: new Date(),
      duration_ms: durationMs,
      error_message: errMsg,
    });
    return {
      ok: false,
      generation_job_id: jobId,
      pool_size: 0,
      duration_ms: durationMs,
      citations: [],
      error: errMsg,
    };
  }
}

function buildQueryFromDraft(draft: {
  draft_name: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
}): string {
  const categoryHuman = draft.category.toLowerCase().replace(/_/g, " ");
  const typeHuman = draft.composition_type.toLowerCase().replace(/_/g, " ");
  return `Find retail products for a gift bundle: "${draft.draft_name}". Category: ${categoryHuman}. Composition type: ${typeHuman}. Target pack count: ${draft.pack_count}. Brand context: ${draft.brand}.`;
}

function extractBrandHint(draft: { brand: string; draft_name: string }): string | undefined {
  // Vladimir's own brands aren't hints — return undefined
  const ownBrands = ["Salutem Vita", "Starfit"];
  if (ownBrands.includes(draft.brand)) return undefined;
  return draft.brand;
}

function resolveStoreId(
  name: string | undefined,
  storeIdByName: Map<string, string>
): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const [chainKey, id] of storeIdByName) {
    if (lower.includes(chainKey)) return id;
  }
  return null;
}

async function upsertStage(
  jobId: string,
  stage: string,
  status: string,
  extra: Record<string, unknown>
) {
  const existing = await prisma.generationStage.findFirst({
    where: { generation_job_id: jobId, stage },
  });
  if (existing) {
    await prisma.generationStage.update({
      where: { id: existing.id },
      data: { status, ...extra },
    });
  } else {
    await prisma.generationStage.create({
      data: {
        generation_job_id: jobId,
        stage,
        status,
        started_at: new Date(),
        ...extra,
      },
    });
  }
}
```

### STEP 4.5 — Image Mirror module (NEW для Phase 2.1)

Создать `src/lib/bundle-factory/r2-image-mirror.ts`:

```typescript
/**
 * Image Mirror — Stage 2.5
 *
 * Downloads reference product images из retail/manufacturer websites
 * и uploads them в Cloudflare R2. Vladimir wants ALL images hosted on
 * our infrastructure (не зависим от external sites which can rotate/remove
 * images).
 *
 * Used by research-pipeline.ts after Perplexity returns reference_image_urls.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp"; // optional: для resize. Если не install — skip resize step

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME ?? "salutem-bundle-factory";
const PUBLIC_URL = process.env.R2_PUBLIC_URL ?? `https://pub-placeholder.r2.dev`;

export interface MirrorResult {
  original_url: string;
  r2_url: string;
  size_bytes: number;
  content_type: string;
  uploaded: boolean;
  error?: string;
}

export async function mirrorImages(params: {
  bundle_sku: string;          // e.g. "draft-XYZ" или "sku-abc123"
  image_urls: string[];        // 3-5 URLs от Perplexity
  max_size_mb?: number;        // default 5 MB per image
}): Promise<MirrorResult[]> {
  if (!process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID === "placeholder") {
    console.warn("[r2-image-mirror] R2 credentials not configured — skipping mirror, keeping original URLs");
    return params.image_urls.map((url) => ({
      original_url: url,
      r2_url: url, // return original — Stage 7 будет use external URL (less safe но works)
      size_bytes: 0,
      content_type: "unknown",
      uploaded: false,
      error: "R2 not configured",
    }));
  }

  const results: MirrorResult[] = [];
  const maxSize = (params.max_size_mb ?? 5) * 1024 * 1024;

  for (let i = 0; i < params.image_urls.length; i++) {
    const url = params.image_urls[i];
    try {
      // 1. Download
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000), // 15s timeout per image
        headers: {
          "User-Agent": "Mozilla/5.0 (Bundle Factory image mirror)",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) {
        throw new Error(`Not an image: content-type=${contentType}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxSize) {
        throw new Error(`Image too large: ${buffer.length} bytes > ${maxSize} max`);
      }

      // 2. Optional: resize если есть sharp (не требуется для Phase 2.1)
      // Phase 2.3 будет add resize logic для Amazon compliance
      let finalBuffer = buffer;

      // 3. Generate R2 key
      const ext = contentTypeToExt(contentType);
      const key = `sec/${params.bundle_sku}/${i + 1}.${ext}`;

      // 4. Upload to R2
      await r2Client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: finalBuffer,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000", // 1 year
        })
      );

      // 5. Build public URL
      const r2Url = `${PUBLIC_URL}/${key}`;

      results.push({
        original_url: url,
        r2_url: r2Url,
        size_bytes: finalBuffer.length,
        content_type: contentType,
        uploaded: true,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[r2-image-mirror] Failed for ${url}: ${errMsg}`);
      results.push({
        original_url: url,
        r2_url: url, // fallback — use original URL (Stage 7 будет use it as-is)
        size_bytes: 0,
        content_type: "unknown",
        uploaded: false,
        error: errMsg,
      });
    }
  }

  return results;
}

function contentTypeToExt(ct: string): string {
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "jpg"; // default
}
```

**Update research-pipeline.ts** чтобы call `mirrorImages` после Perplexity returns reference URLs:

```typescript
// Inside runResearch(), AFTER Perplexity returns products:

// 6.5. Mirror images to R2 (Stage 2.5)
for (const product of result.products) {
  if (!product.reference_image_urls || product.reference_image_urls.length === 0) continue;
  
  const mirrorResults = await mirrorImages({
    bundle_sku: `draft-${draft.id}-${product.product_name.substring(0, 20).replace(/[^a-z0-9]/gi, '-')}`,
    image_urls: product.reference_image_urls,
  });
  
  // Replace external URLs с R2 URLs в product object
  product.reference_image_urls = mirrorResults.map(r => r.r2_url);
}
```

### STEP 5 — Lifecycle audit helper

Создать `src/lib/bundle-factory/lifecycle-log.ts`:

```typescript
/**
 * Audit-trail writer for BundleDraft / MasterBundle / ChannelSKU lifecycle transitions.
 * Reads existing ListingLifecycleLog model from Phase 1.
 */

import { prisma } from "@/lib/prisma";

export interface LifecycleLogInput {
  entity_type: "BundleDraft" | "MasterBundle" | "ChannelSKU" | "GenerationJob";
  entity_id: string;
  from_status?: string;
  to_status: string;
  reason: string;
  actor: string;
  details?: Record<string, unknown>;
}

export async function logLifecycle(input: LifecycleLogInput): Promise<void> {
  await prisma.listingLifecycleLog.create({
    data: {
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      from_status: input.from_status ?? null,
      to_status: input.to_status,
      reason: input.reason,
      actor: input.actor,
      details: input.details ? JSON.stringify(input.details) : null,
    },
  });
}
```

### STEP 6 — API: POST /api/bundle-factory/research/run

Создать `src/app/api/bundle-factory/research/run/route.ts`:

```typescript
/**
 * POST /api/bundle-factory/research/run
 *      Body: { bundle_draft_id }
 *
 * Triggers Stage 2 (Research) pipeline for a BundleDraft.
 * Returns immediately with status=running; the actual research happens
 * synchronously inside the request (Perplexity ~10-30s). For MVP we don't
 * use BullMQ — Next.js server route handles the work and streams result.
 *
 * Future Phase 5+: move to job queue when concurrency matters.
 */

import { NextResponse } from "next/server";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { runResearch } from "@/lib/bundle-factory/research-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // Vercel: allow up to 120s for Perplexity round-trip

export const POST = withErrorHandler("research-run[POST]", async (request: Request) => {
  const body = await readJson<{ bundle_draft_id?: string; trigger?: string }>(request);
  if (!body?.bundle_draft_id) return badRequest("bundle_draft_id is required");

  const result = await runResearch({
    bundle_draft_id: body.bundle_draft_id,
    trigger: (body.trigger as "manual" | "auto") ?? "manual",
    actor: "user", // TODO: pull from session in Phase 3
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, generation_job_id: result.generation_job_id },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    generation_job_id: result.generation_job_id,
    pool_size: result.pool_size,
    duration_ms: result.duration_ms,
    citations: result.citations,
  });
});
```

### STEP 7 — API: GET/PATCH `/api/bundle-factory/briefs/[id]`

Создать `src/app/api/bundle-factory/briefs/[id]/route.ts`:

```typescript
/**
 * GET    /api/bundle-factory/briefs/[id]
 *        Returns BundleDraft + linked ResearchPool items + GenerationStage status.
 *
 * PATCH  /api/bundle-factory/briefs/[id]
 *        Body: { draft_name?, pack_count?, target_channels?, ... }
 *        Allows editing the brief BEFORE research runs (status=DRAFT only).
 *
 * DELETE /api/bundle-factory/briefs/[id]
 *        Soft-archives the brief (sets status to ARCHIVED). Hard delete
 *        is reserved for admin in future phase.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { isOneOf, SALES_CHANNELS } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "briefs[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const researchPool = await prisma.researchPool.findMany({
      where: { generation_job_id: brief.generation_job_id },
      orderBy: { freshness_score: "desc" },
    });

    const stages = await prisma.generationStage.findMany({
      where: { generation_job_id: brief.generation_job_id },
      orderBy: { started_at: "asc" },
    });

    return NextResponse.json({
      brief,
      research_pool: researchPool,
      stages,
    });
  }
);

export const PATCH = withErrorHandler(
  "briefs[id][PATCH]",
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (brief.status !== "DRAFT") {
      return badRequest("Brief can only be edited while in DRAFT status");
    }

    const body = await readJson<Record<string, unknown>>(request);
    if (!body) return badRequest("Body must be JSON");

    const data: Record<string, unknown> = {};
    if (typeof body.draft_name === "string") data.draft_name = body.draft_name;
    if (typeof body.pack_count === "number") data.pack_count = body.pack_count;
    if (Array.isArray(body.target_channels)) {
      for (const ch of body.target_channels) {
        if (!isOneOf(SALES_CHANNELS, ch)) {
          return badRequest(`Invalid target_channels entry: ${ch}`);
        }
      }
      data.target_channels = JSON.stringify(body.target_channels);
    }
    if (body.draft_components !== undefined) {
      data.draft_components = JSON.stringify(body.draft_components);
    }

    const updated = await prisma.bundleDraft.update({
      where: { id },
      data,
    });
    return NextResponse.json({ brief: updated });
  }
);
```

### STEP 8 — API: PATCH/DELETE individual ResearchPool item

Создать `src/app/api/bundle-factory/research/[id]/route.ts`:

```typescript
/**
 * PATCH  /api/bundle-factory/research/[id]
 *        Edit individual research item (override Perplexity's guess).
 *
 * DELETE /api/bundle-factory/research/[id]
 *        Remove an item from the pool (Vladimir curating).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const PATCH = withErrorHandler(
  "research[id][PATCH]",
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const item = await prisma.researchPool.findUnique({ where: { id } });
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await readJson<Record<string, unknown>>(request);
    if (!body) return badRequest("Body must be JSON");

    const data: Record<string, unknown> = {};
    const updatable = [
      "product_name",
      "brand",
      "manufacturer",
      "upc",
      "ingredients",
      "storage_temp",
      "expiration_days",
      "avg_price_cents",
      "source_store_id",
      "source_url",
      "freshness_score",
    ];
    for (const k of updatable) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    // JSON fields
    if (body.flavors !== undefined) data.flavors = JSON.stringify(body.flavors);
    if (body.pack_sizes !== undefined) data.pack_sizes = JSON.stringify(body.pack_sizes);
    if (body.allergens !== undefined) data.allergens = JSON.stringify(body.allergens);

    const updated = await prisma.researchPool.update({ where: { id }, data });
    return NextResponse.json({ research: updated });
  }
);

export const DELETE = withErrorHandler(
  "research[id][DELETE]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await prisma.researchPool.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  }
);
```

### STEP 9 — Update existing `briefs/route.ts` to auto-create GenerationJob

Modify `src/app/api/bundle-factory/briefs/route.ts` POST handler — currently requires `generation_job_id` from caller, but for UX simplicity, POST should **auto-create** a GenerationJob if not provided:

```typescript
// Inside POST handler, BEFORE the prisma.bundleDraft.create call:
let generationJobId = body.generation_job_id;
if (!generationJobId) {
  const job = await prisma.generationJob.create({
    data: {
      brand: body.brand,
      category: body.category,
      composition_type: body.composition_type,
      pack_count: body.pack_count,
      target_channels: JSON.stringify(body.target_channels),
      status: "PENDING",
      triggered_by: "user", // TODO: from session
    },
  });
  generationJobId = job.id;
}
// then use generationJobId in bundleDraft.create
```

Don't break existing callers — keep `generation_job_id` as optional in payload.

### STEP 10 — UI: Brief creation form (`/bundle-factory/briefs/new`)

Создать `src/app/bundle-factory/briefs/new/page.tsx` — **multi-step form** для creating new Brief.

**Design requirements:**
- Multi-step: Step 1 (Idea + Brand) → Step 2 (Category + Composition) → Step 3 (Pack Size + Channels) → Step 4 (Review + Submit)
- Use Salutem Design System (same patterns as existing pages: `bg-surface`, `border-rule`, `text-ink`, `rounded-[14px]`)
- Use Server Action for form submission (Next.js 16 App Router pattern)
- After submit → redirect to `/bundle-factory/briefs/[id]` (detail page)

**Form fields:**

| Step | Field | Type | Validation |
|---|---|---|---|
| 1 | `draft_name` | text input | required, 5-100 chars |
| 1 | `brand` | dropdown | required, options: Salutem Vita, Starfit, Other (с text override) |
| 1 | `description` | textarea (store as part of draft_name) | optional, 0-500 chars |
| 2 | `category` | radio cards | required, from `PRODUCT_CATEGORIES` enum |
| 2 | `composition_type` | radio cards | required, from `COMPOSITION_TYPES` enum |
| 3 | `pack_count` | number input | required, 2-50 |
| 3 | `target_channels` | checkbox grid | required, multi-select. **Show only Phase 2 channels** (Amazon × 5 + Walmart). eBay/TikTok grayed out as "Coming in Phase 3+". Min 1 selected. |
| 4 | (review) | — | Show all values before submit |

**Auto-defaults:**
- Default `target_channels` = **all 5 Amazon accounts + Walmart checked** (6 channels total)
- Default `composition_type` = CROSS_BRAND
- Default `category` = FROZEN_GROCERY (Vladimir's most common)

**Channel display logic:**

```typescript
const PHASE_2_CHANNELS: SalesChannel[] = [
  'AMAZON_SALUTEM',
  'AMAZON_PERSONAL',
  'AMAZON_AMZCOM',
  'AMAZON_SIRIUS',
  'AMAZON_RETAILER',
  'WALMART',
];

const PHASE_3_CHANNELS: SalesChannel[] = ['EBAY', 'TIKTOK_1', 'TIKTOK_2'];

// In UI checkbox grid:
// - Phase 2 channels: full checkboxes, default checked
// - Phase 3 channels: grayed out с tooltip "Coming in Phase 3 — eBay/TikTok distribution"
```

**UI tokens:**
- Step indicator at top: 4 circles connected with lines, active = `bg-green` ring
- Radio cards: `border-rule`, `bg-surface`, hover → `border-ink-3`, active → `border-green ring-2 ring-green/30`
- Submit button: `bg-green text-white px-4 py-2 rounded-[10px]`

### STEP 11 — UI: Brief detail + research view (`/bundle-factory/briefs/[id]`)

Создать `src/app/bundle-factory/briefs/[id]/page.tsx`.

**Sections (top to bottom):**

1. **Header card** — draft_name, brand, status pill, created_at, generation_job_id (small mono text)
2. **Brief details card** — readonly summary of category/composition/pack_count/channels (edit button if status=DRAFT)
3. **Stage progress bar** — visual progress through 7 stages, current stage highlighted
4. **Research section:**
   - If `status === "DRAFT"` and no research yet → big "Run Research" button (triggers POST `/api/bundle-factory/research/run`)
   - If research in progress → spinner + "Researching… ~30s typical"
   - If research complete → table of ResearchPool items with edit/delete actions
   - If error → red banner с retry button
5. **Approve research** — button visible when `status === "RESEARCHED"` and pool size ≥ 5 → "Continue to Variation Matrix →" (this is Phase 2.2 work — for Phase 2.1, button only sets `BundleDraft.status = VARIATION_SELECTED` as placeholder transition; Phase 2.2 will hook actual logic)

**Research pool table columns:**
- Product name (with brand below)
- Pack sizes (chips)
- Storage temp icon
- Price (`$X.XX` tabular-nums)
- Freshness score (visual bar 0-100)
- Source store
- Allergens (chips)
- Action menu (Edit, Remove)

**State management:**
- Use React `useState` for client-side editing
- Mutations via fetch calls to PATCH/DELETE endpoints
- After mutation → revalidate via `router.refresh()`

### STEP 12 — Modify briefs list page

Update `src/app/bundle-factory/briefs/page.tsx`:

1. Add prominent "+ New Brief" button at top-right of header
2. Make each row clickable → links to `/bundle-factory/briefs/[id]`
3. Empty state CTA → also link to `/bundle-factory/briefs/new` (not POST instruction)

### STEP 13 — Modify Overview page KPIs

Update `src/app/bundle-factory/page.tsx`:

Add new KPI card or section: "Research pipeline" showing:
- Briefs awaiting research (DRAFT count)
- Currently researching (count with stage=RESEARCH, status=IN_PROGRESS)
- Researched, pending variation (RESEARCHED count)

Don't break existing 4-card grid — add as second row or replace one of the underused metrics.

### STEP 14 — Manual testing & verification

- [ ] **14.1** Build passes: `npx tsc --noEmit && npx next build`
- [ ] **14.2** Create test brief via UI: theme="Pizza Lunch Gift Set", brand="Salutem Vita", category=FROZEN_GROCERY, composition_type=CROSS_BRAND, pack_count=12, target_channels=[AMAZON_SALUTEM]
- [ ] **14.3** Run research → verify pool populates (10+ items expected for Pizza)
- [ ] **14.4** Edit one ResearchPool item → verify persistence
- [ ] **14.5** Delete one item → verify deletion
- [ ] **14.6** Click "Approve Research" → verify status changes to VARIATION_SELECTED
- [ ] **14.7** Curl test: `POST /api/bundle-factory/research/run` с valid body → 200 + pool_size > 0
- [ ] **14.8** Curl test: `POST /api/bundle-factory/research/run` с invalid bundle_draft_id → 500 with error message

### STEP 15 — Wiki + docs updates

- [ ] **15.1** Update `docs/wiki/bundle-factory.md` — add Phase 2.1 section с deliverables
- [ ] **15.2** Update `docs/wiki/CONNECTIONS.md` — add Perplexity API as new dependency
- [ ] **15.3** Update `docs/wiki/index.md` — refresh Bundle Factory entry
- [ ] **15.4** Create `docs/PHASE_2_1_COMPLETION_REPORT.md` — same format as Phase 1 report (statistics, issues, next phase readiness)

### STEP 16 — Git commits + push

Following same commit style as Phase 1:

- [ ] `feat(bundle-factory): perplexity API client + research orchestrator`
- [ ] `feat(bundle-factory): API endpoints for brief detail + research run`
- [ ] `feat(bundle-factory): UI brief creation form (multi-step)`
- [ ] `feat(bundle-factory): UI brief detail + research pool view`
- [ ] `feat(bundle-factory): Overview page research pipeline metrics`
- [ ] `docs(bundle-factory): wiki + Phase 2.1 completion report`

Push: `git push -u origin feat/bundle-factory-phase-2.1`

---

## ⚠️ ВАЖНЫЕ ПРАВИЛА

1. **DESIGN SYSTEM** — strict adherence to Salutem v1.0. Use only existing design tokens (`text-ink`, `text-ink-2`, `bg-surface`, `border-rule`, `text-green`, etc). No `text-black`, no `bg-white` on green, no red для negative numbers.

2. **TYPESCRIPT STRICT** — все Prisma queries typed. Use `isOneOf` для enum validation. Use Phase 1 helpers (`withErrorHandler`, `badRequest`, `readJson`, `intParam`).

3. **NO NEW NPM PACKAGES** — Perplexity API использует native `fetch()`. Background jobs — Next.js server route + Vercel `maxDuration` config.

4. **ERROR HANDLING** — все API routes должны быть wrapped в `withErrorHandler`. UI должна показывать user-friendly error states (не raw stack traces).

5. **IDEMPOTENCY** — re-running research для same BundleDraft должно clean up prior ResearchPool и start fresh (already implemented в `runResearch` function above).

6. **PROD-DEPLOY GUARD** — Turso seed runs ONLY when `SEED_TARGET=turso` set (Phase 1 already implemented this guard). Don't accidentally write seed to prod.

7. **API timeout** — Perplexity round-trip может занять 10-30s. Используй `export const maxDuration = 120` в research/run route (Vercel limit).

8. **AUDIT LOG** — каждый status transition должен create `ListingLifecycleLog` row через `logLifecycle()` helper.

---

## 🚧 IF YOU GET STUCK

1. **Perplexity returns bad JSON?** → log raw response в DB (`GenerationStage.error_message`), return graceful 500 with hint. Try lower temperature (0.1) or simpler prompt.
2. **TypeScript errors на Prisma types?** → `npx prisma generate` после schema reads.
3. **UI doesn't match design?** → open existing `/bundle-factory/stores/page.tsx` или `/bundle-factory/page.tsx`, copy patterns exactly.
4. **Vercel timeout на Perplexity?** → check `maxDuration = 120` set. If still fails, fallback to async pattern with status polling (Phase 3+ feature, не нужно сейчас).
5. **Don't have Perplexity API key для local testing?** → use mock в development:
   ```typescript
   if (process.env.NODE_ENV === "development" && !process.env.PERPLEXITY_API_KEY) {
     return MOCK_RESEARCH_RESPONSE; // return 3 sample products
   }
   ```

---

## 📤 OUTPUT FORMAT (когда Phase 2.1 complete)

Write `docs/PHASE_2_1_COMPLETION_REPORT.md` со structure аналогичной `PHASE_1_COMPLETION_REPORT.md`:

- ✅ Completed (по checklist выше)
- 📊 Statistics (LOC added, files created, endpoints, etc.)
- 🐛 Issues encountered + workarounds
- 🔜 Phase 2.2 readiness (what's wired для Variation Matrix stage)
- 📦 Vladimir's to-do list after merge (add `PERPLEXITY_API_KEY` to Vercel env vars, etc.)

---

## 🎯 ACCEPTANCE CRITERIA

Phase 2.1 считается готовым, когда:

1. ✅ Production Turso migration applied + seeded (Step 0)
2. ✅ Vladimir может зайти на `/bundle-factory/briefs/new` → создать brief → kick off research → видеть populated ResearchPool через ~30s
3. ✅ Vladimir может edit / delete items in pool
4. ✅ Status transitions tracked в ListingLifecycleLog
5. ✅ Build passes (`npx tsc --noEmit`, `npx next build`)
6. ✅ PR pushed на `feat/bundle-factory-phase-2.1`

---

## 📚 RELATED DOCS

- `docs/CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md` — что было сделано раньше
- `docs/PHASE_1_COMPLETION_REPORT.md` — итоги Phase 1
- `docs/BUNDLE_FACTORY_CONCEPT_v1_0.md` — Phase 2 fits в overall pipeline
- `docs/marketplace-rules/` — Marketplace Rules KB (используется в Stage 4, не Phase 2.1, но read для context)

---

**Удачи в реализации! После завершения отправь PR Vladimir-у с link на review. Phase 2.2 (Variation Matrix + Content Generation) — следующий sub-phase.**

— Claude (in SS Command Center)
