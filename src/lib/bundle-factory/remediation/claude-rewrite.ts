/**
 * Phase 2.6.2 — Claude rewrite of listing content.
 *
 * Phase 2.6.1 Smart Scrub passed only 1/5 AMZCOM safety listings — Amazon's
 * PDP classifier (code 99300) rejects subjective/promotional language that
 * sits outside any deterministic regex wordlist ("discover", "experience
 * the ease", "high-quality", "hassle-free", …). Instead of chasing the
 * ML model with more regex rules, we generate fresh compliant copy from
 * scratch using audit metadata + the original copy as inventory reference.
 *
 * Architecture vs Phase 2.6.1:
 *   - plan → execute → verify → rollback pipeline UNCHANGED
 *   - Only the in-plan content-generation step changes (scrub → Claude)
 *   - Disclaimer text still owned by us (constants in `disclaimer-text.ts`),
 *     Claude only generates bullets + description; the plan script appends
 *     the disclaimer bullet + paragraph after Claude returns
 *   - Smart Scrub stays as defensive filter on Claude output (belt+suspenders)
 *
 * Failure modes (all handled by the caller, not here):
 *   - API failure / network → result.error populated, bullets+description empty
 *   - JSON parse failure → one corrective retry, then result.error
 *   - Validation failure (emoji/HTML/length) → result.error, no partial data
 *
 * Cost: ~$0.008 per listing with prompt caching enabled.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE } from "@/lib/ai-models";

const MODEL = CLAUDE.balanced;
const MAX_TOKENS = 1500;

// Sonnet 5 pricing per Anthropic public pricing page (per 1M tokens):
//   input        $3.00  ($2.00 intro through 2026-08-31)
//   cache read   $0.30  (10× cheaper)
//   cache write  $3.75  (1.25× input)
//   output       $15.00
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_CACHE_READ_PER_MTOK = 0.3;
const PRICE_CACHE_WRITE_PER_MTOK = 3.75;
const PRICE_OUTPUT_PER_MTOK = 15.0;

// Defensive validation regexes (also enforced by Smart Scrub on output,
// but failing early here lets the caller fall back without a wasted PATCH).
const EMOJI_AND_SYMBOL_REGEX =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}]/u;
const HTML_TAG_REGEX = /<[a-zA-Z\/]/;
const MANUAL_BULLET_REGEX = /[•●►▪○▶➤→]/;

const MAX_BULLET_CHARS = 500;
const MIN_BULLETS = 4;
const MAX_BULLETS = 9;
const MAX_DESCRIPTION_CHARS = 2000;

const SYSTEM_PROMPT = `You rewrite Amazon product listings owned by Salutem Solutions LLC into
compliant, factual copy that passes Amazon's Product Detail Page (PDP)
policy classifier (code 99300 — "false/promotional claims or external
links").

HARD RULES (every output bullet + description must satisfy ALL):
1. No emojis or pictograph symbols of any kind.
2. No manual bullet markers (•, ●, ►, ▪, ○, etc.). Amazon renders
   bullets automatically; markers are forbidden.
3. No subjective/promotional adjectives. Banned words include but are
   not limited to: ultimate, perfect, delightful, delicious, ideal,
   amazing, incredible, premium, exclusive, must-have, best, finest,
   exceptional, outstanding, magnificent, wonderful, fantastic,
   superior, top-quality, world-class, awesome, high-quality, optimal,
   hassle-free, expertly, satisfying, experience, discover.
4. No HTML tags anywhere. Use plain text only. Paragraph breaks via
   blank lines.
5. No URLs or links of any kind.
6. No health/medical claims (cure, treat, prevent, boost, weight loss,
   detox, antioxidant, immune, etc.) — these are FDA territory and
   Salutem Vita gift sets are food bundles, not supplements.
7. No first-person CTAs ("order now", "buy today", "we recommend",
   "experience the ease").

WHAT TO INCLUDE (factual content only):
- What's in the box: brand names of contained items, quantities, sizes.
  Mention foreign brand names FACTUALLY (e.g. "Includes 8 Oscar Mayer
  Bun-Length Franks, 14 oz") — this is allowed when stated as inventory.
- Size, weight, packaging type.
- How to store (refrigerated / frozen / shelf-stable).
- How to use (preparation hints, serving suggestions, occasions).
- Compatibility (sandwich bun length, etc.).

OUTPUT FORMAT — return ONLY valid JSON, no preamble, no markdown
fences, no commentary:

{
  "bullets": [
    "Bullet 1 (factual statement)",
    "Bullet 2"
  ],
  "description": "Plain-text paragraph 1.\\n\\nPlain-text paragraph 2."
}

BULLET CONSTRAINTS:
- Between 4 and 9 bullets (you must leave at least one slot for the
  caller's appended disclaimer bullet → Amazon's 10-bullet cap).
- Each bullet ≤ 500 characters.
- Capitalised first letter, no trailing period required.

DESCRIPTION CONSTRAINTS:
- 2–4 short paragraphs (≤200 chars each).
- ≤ 2000 characters total.
- Plain text; paragraph break = "\\n\\n".`;

export interface RewriteInput {
  asin: string;
  title: string;
  brand: string;
  browse_node: string | null;
  original_bullets: string[];
  original_description: string;
}

export interface RewriteOutput {
  bullets: string[];
  description: string;
  cost_cents: number;
  cache_hit: boolean;
  error?: string;
}

const EMPTY_RESULT: Omit<RewriteOutput, "error"> = {
  bullets: [],
  description: "",
  cost_cents: 0,
  cache_hit: false,
};

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// Visible for tests.
export function buildUserMessage(input: RewriteInput): string {
  const bulletList =
    input.original_bullets.length > 0
      ? input.original_bullets.map((b) => `  - ${b}`).join("\n")
      : "  (no bullets stored)";
  const desc = input.original_description?.trim() || "(no description stored)";
  return `ASIN: ${input.asin}
Brand: ${input.brand}
Browse node (Amazon category id): ${input.browse_node ?? "unknown"}
Original title (for context only — do NOT rewrite or restate verbatim):
  ${input.title}

Original bullets (for inventory reference — these are policy-violating
and must NOT be reused verbatim):
${bulletList}

Original description (for inventory reference only):
  ${desc}

Generate compliant replacement bullets and description per the rules
above.`;
}

// Tolerant JSON parse: strip ```json fences and surrounding prose.
// Visible for tests.
export function parseClaudeJson(raw: string): {
  bullets: unknown;
  description: unknown;
} | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  // Strip ```json … ``` fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Find outermost JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === "object") {
      return {
        bullets: (parsed as Record<string, unknown>).bullets,
        description: (parsed as Record<string, unknown>).description,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Validate parsed payload against the constraints in the system prompt.
// Returns null on success, an error string on failure.
// Visible for tests.
export function validateRewrite(
  bullets: unknown,
  description: unknown,
): string | null {
  if (!Array.isArray(bullets)) return "bullets is not an array";
  if (bullets.length < MIN_BULLETS || bullets.length > MAX_BULLETS) {
    return `bullets.length=${bullets.length}, expected ${MIN_BULLETS}-${MAX_BULLETS}`;
  }
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (typeof b !== "string") return `bullets[${i}] is not a string`;
    if (b.length === 0) return `bullets[${i}] is empty`;
    if (b.length > MAX_BULLET_CHARS) {
      return `bullets[${i}].length=${b.length} > ${MAX_BULLET_CHARS}`;
    }
    if (EMOJI_AND_SYMBOL_REGEX.test(b)) {
      return `bullets[${i}] contains an emoji/symbol`;
    }
    if (HTML_TAG_REGEX.test(b)) return `bullets[${i}] contains an HTML tag`;
    if (MANUAL_BULLET_REGEX.test(b)) {
      return `bullets[${i}] contains a manual bullet marker`;
    }
  }
  if (typeof description !== "string") return "description is not a string";
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return `description.length=${description.length} > ${MAX_DESCRIPTION_CHARS}`;
  }
  if (HTML_TAG_REGEX.test(description)) {
    return "description contains an HTML tag";
  }
  if (description.includes("&lt;") || description.includes("&gt;")) {
    return "description contains escaped HTML entities";
  }
  return null;
}

function computeCostCents(usage: {
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

interface AnthropicLike {
  messages: {
    create: (args: Record<string, unknown>) => Promise<{
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

async function callOnce(
  client: AnthropicLike,
  userMessage: string,
): Promise<{
  text: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Sonnet 5 defaults thinking ON; keep it off so thinking tokens don't eat
    // MAX_TOKENS and truncate the JSON (parity with the pre-Sonnet-5 behaviour).
    thinking: { type: "disabled" },
    // System block split out so we can attach cache_control. The Anthropic
    // SDK accepts system as either a string OR an array of blocks; arrays
    // are required for cache_control.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("no text block in response");
  }
  return { text: textBlock.text, usage: response.usage };
}

export async function rewriteListingContent(
  input: RewriteInput,
): Promise<RewriteOutput> {
  const client = getClient();
  if (!client) {
    return { ...EMPTY_RESULT, error: "ANTHROPIC_API_KEY not set" };
  }
  return rewriteListingContentWithClient(
    client as unknown as AnthropicLike,
    input,
  );
}

// Visible for tests so we can inject a stub Anthropic client.
export async function rewriteListingContentWithClient(
  client: AnthropicLike,
  input: RewriteInput,
): Promise<RewriteOutput> {
  const userMessage = buildUserMessage(input);

  let firstUsage: Awaited<ReturnType<typeof callOnce>>["usage"] = {};
  let secondUsage: Awaited<ReturnType<typeof callOnce>>["usage"] | null = null;
  let parsed: ReturnType<typeof parseClaudeJson> = null;
  let lastError = "";

  try {
    const first = await callOnce(client, userMessage);
    firstUsage = first.usage;
    parsed = parseClaudeJson(first.text);
    if (!parsed) lastError = "first attempt: invalid JSON";
  } catch (e) {
    return {
      ...EMPTY_RESULT,
      error: `Claude API call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // One corrective retry on JSON parse failure (system prompt forbids
  // fences but Claude occasionally adds them anyway).
  if (!parsed) {
    try {
      const retryMsg =
        userMessage +
        "\n\nYour previous response wasn't valid JSON. Return ONLY the JSON object, no fences, no commentary.";
      const second = await callOnce(client, retryMsg);
      secondUsage = second.usage;
      parsed = parseClaudeJson(second.text);
      if (!parsed) {
        const combined = combineUsage(firstUsage, secondUsage);
        const { cost_cents, cache_hit } = computeCostCents(combined);
        return {
          ...EMPTY_RESULT,
          cost_cents,
          cache_hit,
          error: "JSON parse failed after retry",
        };
      }
    } catch (e) {
      const { cost_cents, cache_hit } = computeCostCents(firstUsage);
      return {
        ...EMPTY_RESULT,
        cost_cents,
        cache_hit,
        error: `retry call failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const totalUsage = secondUsage
    ? combineUsage(firstUsage, secondUsage)
    : firstUsage;
  const { cost_cents, cache_hit } = computeCostCents(totalUsage);

  const validationError = validateRewrite(parsed.bullets, parsed.description);
  if (validationError) {
    return {
      ...EMPTY_RESULT,
      cost_cents,
      cache_hit,
      error: `validation failed: ${validationError}`,
    };
  }

  return {
    bullets: parsed.bullets as string[],
    description: parsed.description as string,
    cost_cents,
    cache_hit,
  };
}

function combineUsage(
  a: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
  b: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
) {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) +
      (b.cache_creation_input_tokens ?? 0),
  };
}
