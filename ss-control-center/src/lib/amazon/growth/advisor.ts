/**
 * Amazon Growth — AI Advisor.
 *
 * The "what do I DO to grow this listing's sales" brain. Feeds a listing's full
 * PRODUCTIVITY funnel (impressions → clicks → sessions → cart-adds → purchases →
 * returns, plus buy-box, conversion, revenue, issues, health) to Claude and gets
 * back a structured, ranked action plan focused on lifting conversion and sales.
 *
 * Model: claude-opus-4-8 (judgment work). Structured output via output_config so
 * the response is a validated plan, not prose we have to parse loosely.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  return new Anthropic({ apiKey });
}

/** Per-listing productivity + health snapshot handed to the advisor. */
export interface AdvisorInput {
  sku: string;
  asin: string | null;
  itemName: string | null;
  productType: string | null;
  status: "suppressed" | "live" | "inactive";
  suppressionReason: string | null;
  healthScore: number | null;
  components: Record<string, number | null>;
  errorIssueCount: number;
  issues: Array<{ code: string; message: string }>;
  // Funnel / productivity (null = not measured)
  impressions30d: number | null;
  clicks30d: number | null;
  ctr: number | null;
  sessions30d: number | null;
  pageViews30d: number | null;
  cartAdds30d: number | null;
  cartAddRate: number | null;
  unitsOrdered30d: number | null;
  unitSessionPct: number | null; // conversion
  purchases30d: number | null;
  purchaseRate: number | null;
  buyBoxPercentage: number | null;
  revenue30d: number | null;
  returns30d: number | null;
  returnRate: number | null;
}

export type ActionLever =
  | "content" | "images" | "price" | "buybox" | "keywords"
  | "reviews" | "suppression" | "attributes" | "other";

export interface AdvisorAction {
  title: string;
  lever: ActionLever;
  rationale: string;
  impact: "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
  kind: "auto" | "semi" | "manual";
}

export interface AdvisorResult {
  diagnosis: string;
  rootCause: string;
  actions: AdvisorAction[];
  expectedOutcome: string;
  confidence: "high" | "medium" | "low";
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: { type: "string", description: "Read the funnel: where exactly does this listing leak (impressions→clicks→conversion→purchase→returns)?" },
    rootCause: { type: "string", description: "The single biggest reason it underperforms." },
    actions: {
      type: "array",
      description: "Ranked actions, highest sales impact first.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          lever: { type: "string", enum: ["content", "images", "price", "buybox", "keywords", "reviews", "suppression", "attributes", "other"] },
          rationale: { type: "string" },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          effort: { type: "string", enum: ["low", "medium", "high"] },
          kind: { type: "string", enum: ["auto", "semi", "manual"] },
        },
        required: ["title", "lever", "rationale", "impact", "effort", "kind"],
        additionalProperties: false,
      },
    },
    expectedOutcome: { type: "string", description: "If the top actions are done, what moves and roughly how much." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["diagnosis", "rootCause", "actions", "expectedOutcome", "confidence"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are the growth analyst for Salutem Solutions, an Amazon seller of food/grocery gift sets (frozen, refrigerated, shelf-stable) and pet food. Your job: read ONE listing's productivity funnel and tell the operator exactly what to do to grow its conversion and sales — ranked by sales impact.

How to think (funnel):
- Impressions → low = a discoverability/keyword problem (search suppression, weak backend keywords, wrong category).
- Clicks / CTR → low CTR with decent impressions = weak main image, title, price, or rating in search results.
- Sessions → page views → the detail page is being seen.
- Cart-add rate low = the detail page doesn't convince (images, bullets, A+, price vs competitors).
- Purchase / unit-session conversion low (but cart-adds OK) = price, buy-box loss, reviews/trust, or checkout friction.
- Buy-box % low = a competitor holds the featured offer; our traffic converts for them.
- Return rate high = listing over-promises or content mismatches the product (fixable by accurate content).
- Suppressed = invisible in search; fix the blocking attribute first — nothing else matters until it's findable.

Diagnose where THIS listing leaks using the numbers given; null means not measured — say so, don't invent. Be specific and quantitative. Then give 2-5 ranked actions. Mark each:
- kind=auto: a deterministic fix we can apply (dedupe attribute, scrub promo/emoji from title, inject disclaimer).
- kind=semi: needs generated content then review (rewrite title/bullets/A+, regenerate images).
- kind=manual: a human/ops or business decision (pricing — gated on COGS; enroll reviews; restock).

Brand rules (NON-NEGOTIABLE — never recommend violating them): no emojis, no promotional adjectives (ultimate/premium/best/perfect/amazing…), no health/medical claims, plain factual text, keep the "curated and assembled by Salutem Solutions LLC" gift-basket disclaimer. Pricing must protect ≥20% margin (COGS work is parallel — pricing actions are gated). Don't fabricate keywords or attribute values we don't have — route missing structural data to the sourcing harvest.

Return only the structured plan.`;

function fmtPct(n: number | null): string {
  return n == null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}
function fmtNum(n: number | null): string {
  return n == null ? "n/a" : String(n);
}

function buildUserPrompt(i: AdvisorInput): string {
  const lines = [
    `Listing: ${i.itemName ?? i.sku}`,
    `SKU ${i.sku}${i.asin ? ` · ASIN ${i.asin}` : ""} · productType ${i.productType ?? "n/a"}`,
    `Status: ${i.status}${i.suppressionReason ? ` — ${i.suppressionReason}` : ""}`,
    `Listing Health: ${fmtNum(i.healthScore)}/100 · components ${JSON.stringify(i.components)}`,
    ``,
    `FUNNEL (last 30 days):`,
    `  Impressions: ${fmtNum(i.impressions30d)}`,
    `  Clicks: ${fmtNum(i.clicks30d)} (CTR ${fmtPct(i.ctr)})`,
    `  Sessions: ${fmtNum(i.sessions30d)} · Page views: ${fmtNum(i.pageViews30d)}`,
    `  Cart-adds: ${fmtNum(i.cartAdds30d)} (cart-add rate ${fmtPct(i.cartAddRate)})`,
    `  Units ordered: ${fmtNum(i.unitsOrdered30d)} · Conversion (unit/session): ${fmtPct(i.unitSessionPct)}`,
    `  Purchases: ${fmtNum(i.purchases30d)} (purchase rate ${fmtPct(i.purchaseRate)})`,
    `  Buy-box held: ${i.buyBoxPercentage == null ? "n/a" : `${i.buyBoxPercentage.toFixed(0)}%`}`,
    `  Revenue: ${i.revenue30d == null ? "n/a" : `$${i.revenue30d.toFixed(0)}`}`,
    `  Returns: ${fmtNum(i.returns30d)} (return rate ${fmtPct(i.returnRate)})`,
    ``,
    `Amazon issues (${i.errorIssueCount} errors):`,
    ...(i.issues.length ? i.issues.slice(0, 12).map((x) => `  - ${x.code}: ${x.message}`) : ["  (none recorded)"]),
  ];
  return lines.join("\n");
}

/** Run the advisor on one listing. Returns a validated, ranked action plan. */
export async function adviseListing(input: AdvisorInput): Promise<AdvisorResult> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Advisor returned no plan");
  }
  return JSON.parse(textBlock.text) as AdvisorResult;
}
