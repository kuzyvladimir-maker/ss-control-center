/**
 * Phase 2.2 Stage 4 — Per-channel content generation.
 *
 * Wraps Claude Sonnet 4.5 with the marketplace-rules KB cached at every
 * file breakpoint (kb-loader). Returns `{ title, bullets, description }`
 * for one channel template (`amazon` or `walmart`). The caller orchestrates
 * the per-channel fan-out (5 Amazon accounts share one Claude call; only
 * Walmart needs a second). See PHASE_2_2_README for the full pipeline.
 *
 * Style invariants — same as Phase 2.6.2 (claude-rewrite.ts):
 *   - No emojis, no manual bullet markers, no HTML.
 *   - No promotional/health adjectives (full negative-example list
 *     injected from `compliance/banned-words.ts`).
 *   - Disclaimer is INJECTED BY THE COMPLIANCE GATE (rules 3 + 4 with
 *     autoFix:true) — this module does NOT include the disclaimer. The
 *     gate's auto-fix runs AFTER our output lands, which keeps the
 *     disclaimer text in a single place (`remediation/disclaimer-text.ts`).
 *
 * Cost: ~$0.012 per Claude call with caching (Sonnet 4.5 pricing). At
 * 1000 bundles × 2 templates = ~$24/month. The 5 Amazon channels reuse
 * the same output so we pay for one Claude call across them.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  loadKnowledgeBase,
  enforceCacheMarkerLimit,
  type KbChannelTemplate,
  type SystemBlockWithCache,
} from "./kb-loader";
import {
  PROMOTIONAL_BANNED,
  HEALTH_CLAIM_BANNED,
} from "./compliance/banned-words";
import { isOwnBrandPassthrough } from "./own-brand";
import type { Variant, VariantComponent } from "./variation-matrix";
import { CLAUDE } from "@/lib/ai-models";
import { claudeWorkerClient } from "@/lib/text-gen/claude-text-worker";

const MODEL = CLAUDE.balanced;
const MAX_TOKENS = 2000;

// Sonnet 5 pricing (dollars per 1M tokens): $3 in / $15 out standard
// (intro $2 / $10 through 2026-08-31). Kept at the standard rate below so the
// displayed cost is conservative.
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_CACHE_READ_PER_MTOK = 0.3;
const PRICE_CACHE_WRITE_PER_MTOK = 3.75;
const PRICE_OUTPUT_PER_MTOK = 15.0;

// Per-channel hard limits. Caller validates after generation; if Claude
// exceeds, we trim+retry once via the feedback loop.
export const CHANNEL_LIMITS: Record<KbChannelTemplate, {
  title_max: number;
  bullet_max: number;
  bullets_min: number;
  bullets_max: number; // leaves slot for disclaimer auto-injection
  description_max: number;
}> = {
  amazon: {
    title_max: 200,
    bullet_max: 500,
    bullets_min: 4,
    bullets_max: 9, // 9 + 1 disclaimer = 10 (Amazon cap)
    description_max: 2000,
  },
  walmart: {
    title_max: 75,
    bullet_max: 500,
    bullets_min: 4,
    bullets_max: 9,
    description_max: 4000,
  },
};

const EMOJI_AND_SYMBOL_REGEX =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}]/u;
const HTML_TAG_REGEX = /<[a-zA-Z\/]/;
const MANUAL_BULLET_REGEX = /[•●►▪○▶➤→]/;

export interface ContentGenerationInput {
  template: KbChannelTemplate;
  draft_name: string;
  brand: string; // "Salutem Vita" | "Starfit" | ...
  category: string; // PRODUCT_CATEGORY enum
  composition_type: string;
  pack_count: number;
  selected_variant: Variant;
  /** Real harvested manufacturer data for the primary donor product (from the
   *  donor catalog — Walmart/Sam's/BJ's/etc.). Claude ADAPTS this into
   *  brand-voice copy rather than inventing facts. Phase 1. */
  donor_reference?: {
    title?: string;
    bullets?: string[];
    description?: string;
    ingredients?: string;
    nutrition?: string;
  };
  /** Additional regeneration context — populated by the feedback loop. */
  prior_failure?: {
    attempt: number;
    failed_rules: Array<{ rule_id: string; reason?: string; details?: unknown }>;
    last_title: string;
    last_bullets: string[];
    last_description: string;
  };
}

export interface ContentGenerationOutput {
  title: string;
  bullets: string[];
  description: string;
  cost_cents: number;
  cache_hit: boolean;
  claude_response_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  raw_response: string;
  error?: string;
}

const EMPTY_OUTPUT: Omit<ContentGenerationOutput, "error"> = {
  title: "",
  bullets: [],
  description: "",
  cost_cents: 0,
  cache_hit: false,
  claude_response_id: "",
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  raw_response: "",
};

// Built once per module load. Banned words are static, only the list
// content matters — order-irrelevant.
const BANNED_PROMO_LIST = PROMOTIONAL_BANNED.join(", ");
const BANNED_HEALTH_LIST = HEALTH_CLAIM_BANNED.join(", ");

function buildStyleBlock(
  template: KbChannelTemplate,
  ownBrand: boolean,
  brand: string,
): SystemBlockWithCache {
  const limits = CHANNEL_LIMITS[template];

  // Rule 7 differs by mode:
  //  - Gift-set (default): foreign brands are forbidden in the title (the
  //    listing is Salutem's; the components are inventory, not endorsement).
  //  - Own-brand passthrough (Uncrustables): the listing IS published under the
  //    donor's own brand, so THAT brand belongs in the title. Any OTHER foreign
  //    brand is still forbidden.
  const rule7 = ownBrand
    ? `7. BRAND IN TITLE: this listing is published UNDER THE BRAND "${brand}".
   Use "${brand}" in the title — it is the genuine product's own brand, not a
   foreign mark. Do NOT add any OTHER brand name to the title. Do NOT add
   "Salutem", "Salutem Vita", "Starfit", "gift set", "gift basket", "curated",
   or "assembled" anywhere — this is a standard product listing, not a gift set.`
    : `7. NO FOREIGN BRAND IN TITLE under Salutem Vita / Starfit. You MAY
   mention foreign brand names FACTUALLY in bullets/description ("Includes
   8 Oscar Mayer Bun-Length Franks") — they are inventory, not endorsement.
   Title positions belong to Salutem only.`;

  // Disclaimer note only applies to gift-set listings. Own-brand listings get
  // NO curator/assembler disclaimer (Rules 3+4 skip them).
  const disclaimerNote = ownBrand
    ? `This is a standard resale listing of a genuine branded product. Do NOT
write any curator / assembler / "gift basket" disclaimer — there is none.`
    : `The compliance gate appends a curator disclaimer bullet + description
paragraph AFTER your output. DO NOT include the disclaimer yourself —
duplicates trip Amazon's classifier. Leave at least one bullet slot
unused (cap of ${limits.bullets_max} for that reason).`;

  const intro = ownBrand
    ? `You generate compliant marketplace listing content for a genuine branded
product sold under its OWN brand ("${brand}"). This is NOT a Salutem gift set —
do not frame it as one. This block is cached and applies to every request.`
    : `You generate compliant marketplace listing content for Salutem Solutions
LLC (brands: Salutem Vita, Starfit). This block is cached — it applies
to every generation request and never changes mid-session.`;

  return {
    type: "text",
    text: `=== SALUTEM BRAND VOICE — STRICT (Vladimir 2026-05-19) ===

${intro}

HARD RULES (output MUST satisfy every one):

1. NO EMOJIS. No pictographs, no decorative unicode symbols, no
   ✅🍽🎁💚🧊⭐🔥⚡. Plain ASCII + ordinary punctuation only.
2. NO MANUAL BULLET CHARACTERS. The marketplace renders bullets from
   your array; never prefix lines with •, ●, ►, ▪, ○, ▶, ➤, →, –.
3. NO HTML TAGS anywhere — title, bullets, OR description. Plain text.
   Paragraph break in description = blank line ("\\n\\n"). Amazon's PDP
   classifier (code 99300) rejects HTML in grocery/food descriptions.
4. NO PROMOTIONAL ADJECTIVES. Banned (substring match, case-insensitive):
   ${BANNED_PROMO_LIST}.
5. NO HEALTH OR MEDICAL CLAIMS. Banned: ${BANNED_HEALTH_LIST}. Salutem
   bundles are FOOD, never supplements.
6. NO FIRST-PERSON CTAs. Never write "we recommend", "order now", "buy
   today", "experience the ease", "discover".
${rule7}
8. NO URLs, social handles, phone numbers.

CHANNEL-SPECIFIC LIMITS (${template}):
  - title:       ≤ ${limits.title_max} characters
  - bullets:     ${limits.bullets_min}–${limits.bullets_max} items, each ≤ ${limits.bullet_max} chars
  - description: ≤ ${limits.description_max} characters total

${disclaimerNote}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no prose:

{
  "title": "string",
  "bullets": ["bullet 1", "bullet 2", "..."],
  "description": "Paragraph 1.\\n\\nParagraph 2."
}`,
    cache_control: { type: "ephemeral" },
  };
}

/** Strip retail pack-size fragments ("- 8oz/4ct", "10 Count", "Pack of 6")
 *  from a donor title. Own-brand listings count INDIVIDUAL units — a raw
 *  "45× …7.2oz/4ct" line led the model to write "45 boxes … totaling 180
 *  sandwiches" on a 45-sandwich listing (owner caught it 2026-07-07). */
function stripPackFragments(name: string): string {
  return name
    .replace(/[-–—]?\s*\d+(?:\.\d+)?\s*oz\s*\/\s*\d+\s*ct\b/gi, "")
    .replace(/[-–—]?\s*\d+\s*ct\s*\/\s*\d+(?:\.\d+)?\s*oz\b/gi, "")
    .replace(/,?\s*\d+\s*(?:count|ct)\b/gi, "")
    .replace(/,?\s*pack of\s*\d+/gi, "")
    .replace(/,?\s*\d+(?:\.\d+)?\s*oz\b(?:\s*each)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,–—-]+$/g, "")
    .trim();
}

function formatComposition(
  components: VariantComponent[],
  opts: { unitSemantics?: boolean } = {},
): string {
  return components
    .map((c) => {
      const name = opts.unitSemantics ? stripPackFragments(c.product_name) : c.product_name;
      const unitWord = opts.unitSemantics ? " individual sandwiches/pieces of" : "×";
      return `  - ${c.qty}${unitWord} ${name} (${c.brand}, $${(c.unit_price_cents / 100).toFixed(2)} per piece)`;
    })
    .join("\n");
}

function buildUserMessage(input: ContentGenerationInput): string {
  const variant = input.selected_variant;
  const ownBrand = isOwnBrandPassthrough(input.brand);
  const lines: string[] = [];

  if (ownBrand) {
    lines.push(`Generate ${input.template === "amazon" ? "Amazon" : "Walmart"} listing content for the following genuine branded product (sold under its own brand, NOT a gift set).`);
    lines.push("");
    lines.push(`Draft name (concept reference, do NOT use verbatim as title): ${input.draft_name}`);
    lines.push(`Brand (publish the listing under this brand, and use it in the title): ${input.brand}`);
  } else {
    lines.push(`Generate ${input.template === "amazon" ? "Amazon" : "Walmart"} listing content for the following gift basket.`);
    lines.push("");
    lines.push(`Draft name (concept reference, do NOT use verbatim as title): ${input.draft_name}`);
    lines.push(`House brand (the Salutem brand that owns the listing): ${input.brand}`);
  }
  lines.push(`Category: ${input.category.replace(/_/g, " ").toLowerCase()}`);
  lines.push(`Composition type: ${input.composition_type.replace(/_/g, " ").toLowerCase()}`);
  lines.push(`Pack count: ${input.pack_count} total units`);
  lines.push(`Suggested retail price: $${(variant.suggested_price_cents / 100).toFixed(2)}`);
  lines.push("");
  if (ownBrand) {
    lines.push(
      `COUNT SEMANTICS (CRITICAL): this listing contains exactly ${input.pack_count} INDIVIDUAL sandwiches/pieces in total. ` +
        `Quantities below are single pieces, NEVER retail boxes or cases. The donor's retail pack size ` +
        `(e.g. "4ct box") describes only how the manufacturer sells it in stores — do NOT multiply by it, ` +
        `do NOT describe this listing as boxes/cases, and never state a total other than ${input.pack_count}.`,
    );
    lines.push("");
  }
  lines.push(ownBrand
    ? `Product contents (what is included — describe factually):`
    : `Bundle contents (inventory the listing must describe):`);
  lines.push(formatComposition(variant.composition, { unitSemantics: ownBrand }));
  lines.push("");
  lines.push(`Selected variant rationale: ${variant.notes}`);

  // Real manufacturer reference data (Phase 1) — ground the copy in facts from
  // the donor catalog instead of inventing. Claude ADAPTS, never copies verbatim.
  const ref = input.donor_reference;
  if (ref && (ref.title || ref.description || ref.bullets?.length || ref.ingredients || ref.nutrition)) {
    lines.push("");
    lines.push(
      "MANUFACTURER REFERENCE DATA (real harvested product info — ADAPT into your own brand-voice copy; do NOT copy verbatim and do NOT invent facts not present here):",
    );
    if (ref.title) lines.push(`  Reference title: ${ref.title}`);
    if (ref.bullets && ref.bullets.length > 0) {
      lines.push("  Reference bullets:");
      for (const b of ref.bullets.slice(0, 8)) lines.push(`    - ${b}`);
    }
    if (ref.description) lines.push(`  Reference description: ${ref.description.slice(0, 1200)}`);
    if (ref.ingredients) lines.push(`  Ingredients: ${ref.ingredients.slice(0, 800)}`);
    if (ref.nutrition) lines.push(`  Nutrition facts: ${ref.nutrition.slice(0, 600)}`);
    lines.push(
      "Ground the title, bullets, and description in this real data (flavors, format, preparation, storage, count). Stay strictly factual.",
    );
  }

  // Feedback context for regeneration attempts.
  if (input.prior_failure) {
    const f = input.prior_failure;
    lines.push("");
    lines.push(`-------- PRIOR ATTEMPT ${f.attempt} WAS REJECTED --------`);
    lines.push(`Failed compliance rules:`);
    for (const r of f.failed_rules) {
      const detailStr = r.details
        ? ` — ${JSON.stringify(r.details).slice(0, 220)}`
        : "";
      lines.push(`  - ${r.rule_id}${r.reason ? ` (${r.reason})` : ""}${detailStr}`);
    }
    lines.push("");
    lines.push(`Your previous output (DO NOT repeat the violations):`);
    lines.push(`  title: ${f.last_title}`);
    lines.push(`  bullets:`);
    for (const b of f.last_bullets) lines.push(`    - ${b}`);
    lines.push(`  description: ${f.last_description.slice(0, 600)}`);
    lines.push("");
    lines.push(
      `Address EACH failed rule above. Read the KB blocks if you need a refresher on the policy text.`,
    );
  }

  lines.push("");
  lines.push(`Return the JSON object now.`);
  return lines.join("\n");
}

// ── Public surface ──────────────────────────────────────────────────────

let _client: Anthropic | null = null;
function getClient(): AnthropicLike | null {
  const stub = (globalThis as { __BUNDLE_FACTORY_CLAUDE_STUB__?: AnthropicLike })
    .__BUNDLE_FACTORY_CLAUDE_STUB__;
  if (stub) return stub;
  if (_client) return _client as unknown as AnthropicLike;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client as unknown as AnthropicLike;
}

interface AnthropicLike {
  messages: {
    create: (args: Record<string, unknown>) => Promise<{
      id: string;
      content: Array<{ type: string; text?: string }>;
      usage: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
    }>;
  };
}

export async function generateContent(
  input: ContentGenerationInput,
): Promise<ContentGenerationOutput> {
  // Subscription FIRST (Vladimir 2026-07-07, same architecture as images +
  // vision): the Claude worker on the OpenClaw box writes the copy at $0 on
  // the Max subscription. The paid Anthropic API is only the INFRASTRUCTURE
  // fallback — a transport/worker failure falls through to it; model-quality
  // failures (JSON/validation) do NOT, the compliance retry loop handles those.
  const stub = (globalThis as { __BUNDLE_FACTORY_CLAUDE_STUB__?: AnthropicLike })
    .__BUNDLE_FACTORY_CLAUDE_STUB__;
  const worker = stub ? null : claudeWorkerClient();
  if (worker) {
    const viaWorker = await generateContentWithClient(worker, input);
    const infraFailure = viaWorker.error?.startsWith("Claude API call failed");
    if (!infraFailure) return viaWorker;
    console.error(`[content-gen] subscription worker failed, falling back to paid API: ${viaWorker.error}`);
  }
  const client = getClient();
  if (!client) {
    return {
      ...EMPTY_OUTPUT,
      error: worker
        ? "subscription worker failed and ANTHROPIC_API_KEY not set"
        : "ANTHROPIC_API_KEY not set (and claude text worker not configured)",
    };
  }
  return generateContentWithClient(client, input);
}

export async function generateContentWithClient(
  client: AnthropicLike,
  input: ContentGenerationInput,
): Promise<ContentGenerationOutput> {
  const kb = await loadKnowledgeBase(input.template);
  const ownBrand = isOwnBrandPassthrough(input.brand);
  const styleBlock = buildStyleBlock(input.template, ownBrand, input.brand);

  // KB blocks come FIRST (largest, most stable, cache-friendly), style
  // block comes LAST so it's still in the cached prefix but invalidates
  // separately if banned-words list changes.
  const systemBlocks = enforceCacheMarkerLimit(
    [...kb.blocks, styleBlock],
    4,
  );

  const userMessage = buildUserMessage(input);

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Sonnet 5 turns adaptive thinking ON by default; disable it so thinking
      // tokens don't eat MAX_TOKENS and truncate the JSON (behaviour parity
      // with the pre-Sonnet-5 workhorse).
      thinking: { type: "disabled" },
      system: systemBlocks,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (e) {
    return {
      ...EMPTY_OUTPUT,
      error: `Claude API call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    const cost = computeCost(response.usage);
    return {
      ...EMPTY_OUTPUT,
      ...cost,
      claude_response_id: response.id,
      input_tokens: response.usage.input_tokens ?? 0,
      output_tokens: response.usage.output_tokens ?? 0,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
      error: "no text block in Claude response",
    };
  }

  const raw = textBlock.text;
  const parsed = parseClaudeJson(raw);
  const usage = response.usage;
  const cost = computeCost(usage);
  const base = {
    ...EMPTY_OUTPUT,
    ...cost,
    claude_response_id: response.id,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    raw_response: raw,
  };

  if (!parsed) {
    return { ...base, error: "JSON parse failed" };
  }

  const validation = validateOutput(parsed, input.template);
  if (validation) {
    return {
      ...base,
      title: typeof parsed.title === "string" ? parsed.title : "",
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.filter((b: unknown): b is string => typeof b === "string")
        : [],
      description:
        typeof parsed.description === "string" ? parsed.description : "",
      error: `validation failed: ${validation}`,
    };
  }

  return {
    ...base,
    title: parsed.title as string,
    bullets: parsed.bullets as string[],
    description: parsed.description as string,
  };
}

// Visible for tests.
export function parseClaudeJson(raw: string): {
  title: unknown;
  bullets: unknown;
  description: unknown;
} | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      return {
        title: o.title,
        bullets: o.bullets,
        description: o.description,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Visible for tests.
export function validateOutput(
  parsed: { title: unknown; bullets: unknown; description: unknown },
  template: KbChannelTemplate,
): string | null {
  const limits = CHANNEL_LIMITS[template];
  if (typeof parsed.title !== "string") return "title is not a string";
  if (parsed.title.length === 0) return "title is empty";
  if (parsed.title.length > limits.title_max) {
    return `title.length=${parsed.title.length} > ${limits.title_max}`;
  }
  if (EMOJI_AND_SYMBOL_REGEX.test(parsed.title)) return "title contains emoji";
  if (HTML_TAG_REGEX.test(parsed.title)) return "title contains HTML";

  if (!Array.isArray(parsed.bullets)) return "bullets is not an array";
  if (
    parsed.bullets.length < limits.bullets_min ||
    parsed.bullets.length > limits.bullets_max
  ) {
    return `bullets.length=${parsed.bullets.length}, expected ${limits.bullets_min}-${limits.bullets_max}`;
  }
  for (let i = 0; i < parsed.bullets.length; i++) {
    const b = parsed.bullets[i];
    if (typeof b !== "string") return `bullets[${i}] is not a string`;
    if (b.length === 0) return `bullets[${i}] is empty`;
    if (b.length > limits.bullet_max) {
      return `bullets[${i}].length=${b.length} > ${limits.bullet_max}`;
    }
    if (EMOJI_AND_SYMBOL_REGEX.test(b)) return `bullets[${i}] contains emoji`;
    if (HTML_TAG_REGEX.test(b)) return `bullets[${i}] contains HTML`;
    if (MANUAL_BULLET_REGEX.test(b)) {
      return `bullets[${i}] contains manual bullet marker`;
    }
  }

  if (typeof parsed.description !== "string") {
    return "description is not a string";
  }
  if (parsed.description.length === 0) return "description is empty";
  if (parsed.description.length > limits.description_max) {
    return `description.length=${parsed.description.length} > ${limits.description_max}`;
  }
  if (HTML_TAG_REGEX.test(parsed.description)) {
    return "description contains HTML";
  }
  if (EMOJI_AND_SYMBOL_REGEX.test(parsed.description)) {
    return "description contains emoji";
  }

  return null;
}

function computeCost(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): { cost_cents: number; cache_hit: boolean } {
  const inputTokens = usage.input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const dollars =
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (cacheReadTokens / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
    (cacheWriteTokens / 1_000_000) * PRICE_CACHE_WRITE_PER_MTOK +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK;
  return {
    cost_cents: Math.max(1, Math.ceil(dollars * 100)),
    cache_hit: cacheReadTokens > 0,
  };
}

// ── Test seam — exposes the user-message builder for fixtures ───────────
export const __test__ = { buildUserMessage, buildStyleBlock };
