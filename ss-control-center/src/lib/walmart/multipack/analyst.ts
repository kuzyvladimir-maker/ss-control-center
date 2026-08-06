// AI analyst for the Listing Optimizer. Given the filtered pool of listings
// (metrics + Walmart's own flagged issues), Claude diagnoses why they
// underperform and recommends actions to lift conversion & sales — grounded in
// Walmart's listing-quality drivers and CONSTRAINED to what we can actually do.
//
// Recommendations are split:
//   - type "auto"     → content/image edits our engine can apply (fields:
//                       image/gallery/title/bullets/description/attributes).
//   - type "advisory" → levers we CANNOT auto-apply (restock, price/buy-box,
//                       fast shipping, reviews) — surfaced as "needs you".

import { claudeWorkerClient } from "@/lib/text-gen/claude-text-worker";

/** What both call sites actually use from the client. */
type AnthropicLikeClient = NonNullable<ReturnType<typeof claudeWorkerClient>>;
import { WALMART_CONTENT_RULES } from "./guidelines";
import { CLAUDE } from "@/lib/ai-models";
import { withMeteredProviderCall } from "@/lib/sourcing/metered-provider-call";

const MODEL = CLAUDE.balanced;

export interface PoolListing {
  sku: string; name: string; status: string | null; pack: number | null;
  lq: number | null; content: number | null; sales: number; units: number;
  conv: number | null; views: number; reviews: number; returns: number;
  inStock: boolean; issues: string[];
}
export interface Recommendation { type: "auto" | "advisory"; title: string; detail: string; skus: string[]; fields: string[]; }
export interface PoolAnalysis { narrative: string; recommendations: Recommendation[]; }

// Runs on Vladimir's Claude Max / ChatGPT Pro subscriptions through the box
// worker, never a paid API key (owner instruction 2026-08-06). The adapter
// speaks the same `messages.create` shape, so the call sites below are unchanged.
function getClient(): AnthropicLikeClient | null {
  return claudeWorkerClient();
}

export async function analyzePool(input: { period: number; aggregates: Record<string, number>; listings: PoolListing[] }): Promise<PoolAnalysis> {
  const c = getClient();
  if (!c) throw new Error("The Claude subscription worker is not configured (CODEX_IMAGE_WORKER_URL / CODEX_IMAGE_WORKER_TOKEN). This platform does not use paid API keys.");
  const rows = input.listings.slice(0, 60).map((l) =>
    `- ${l.sku} | ${l.name?.slice(0, 50)} | status:${l.status || "?"} pack:${l.pack ?? "?"} LQ:${l.lq ?? "?"} content:${l.content ?? "?"} | ${input.period}d sales:$${l.sales} units:${l.units} conv:${l.conv != null ? (l.conv * 100).toFixed(1) + "%" : "—"} views:${l.views} reviews:${l.reviews} returns:${l.returns} inStock:${l.inStock} | issues: ${l.issues.join("; ") || "none"}`
  ).join("\n");

  const prompt = `You are a senior Walmart Marketplace analyst. Analyze this filtered pool of listings and recommend what to do to increase CONVERSION and SALES. Be concrete; reference the data and Walmart's own flagged issues.

POOL (${input.aggregates.count} listings, metrics over ${input.period} days):
aggregates: ${JSON.stringify(input.aggregates)}
${rows}

Walmart listing-quality drivers that move sales: Content & Discoverability, Buy Box / price competitiveness, fast & free shipping (2-day), ratings & reviews, published & in-stock.
${WALMART_CONTENT_RULES}

CRITICAL — split every recommendation by what WE can execute:
- type "auto": our engine CAN apply these directly — fields from this exact set only: ["image","gallery","title","bullets","description","attributes"]. The "image" field (multipack tile showing N units) only applies to multipacks (pack >= 2).
- type "advisory": we CANNOT auto-apply — restock inventory, change price / win Buy Box, enroll fast & free shipping, get reviews. fields must be []. Tell the user what to do and where.

Group recommendations sensibly: pool-wide where it applies, or call out sub-groups ("these 5 SKUs are out of stock → restock"). Put the affected SKUs in "skus".

Return ONLY valid JSON:
{"narrative":"2-6 sentence diagnosis of the pool","recommendations":[{"type":"auto|advisory","title":"short","detail":"what & why","skus":["..."],"fields":["title","bullets"]}]}`;

  const res = await withMeteredProviderCall({
    provider: "anthropic",
    operation: "analysis",
    requestFingerprint: { model: MODEL, period: input.period, aggregates: input.aggregates, listings: input.listings.slice(0, 60) },
  }, () => c.messages.create({ model: MODEL, max_tokens: 2500, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }));
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: PoolAnalysis;
  try { parsed = JSON.parse(json) as PoolAnalysis; }
  catch { throw new Error(`Claude returned non-JSON: ${text.slice(0, 160)}`); }
  if (!parsed.narrative || !Array.isArray(parsed.recommendations)) throw new Error("Claude returned an unexpected shape");
  const ALLOWED = new Set(["image", "gallery", "title", "bullets", "description", "attributes"]);
  parsed.recommendations = parsed.recommendations.map((r) => ({
    type: r.type === "auto" ? "auto" : "advisory",
    title: String(r.title || "").slice(0, 200),
    detail: String(r.detail || "").slice(0, 1500),
    skus: Array.isArray(r.skus) ? r.skus.filter((s) => typeof s === "string").slice(0, 500) : [],
    fields: r.type === "auto" && Array.isArray(r.fields) ? r.fields.filter((x) => ALLOWED.has(x)) : [],
  }));
  return parsed;
}
