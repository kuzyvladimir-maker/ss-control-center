/**
 * Amazon Listing Health — scoring.
 *
 * Amazon has NO native Listing Quality Score (unlike Walmart Insights), so we
 * compute our own 0-100 "Listing Health Score" from real SP-API signals. The
 * score is a weighted average over the COMPONENTS we have data for; components
 * we can't yet measure for an item are `null` and excluded (weights renormalise),
 * so the headline stays honest as later phases enrich more components.
 *
 * Phase A measures three components straight off the Listings Items list call
 * (status + issues, plus a brand-voice check on the title):
 *   - buyability  — is the listing live + discoverable, or suppressed?
 *   - issues      — count/severity of Amazon's own listing issues
 *   - compliance  — title brand-voice (no emoji / promo language; length)
 * Later phases add content (Catalog), buyBox (Pricing) and conversion (Sales
 * & Traffic). Design: docs/wiki/amazon-growth-roadmap.md.
 */

export type ComponentKey =
  | "buyability"
  | "issues"
  | "content"
  | "compliance"
  | "buyBox"
  | "conversion";

/** Weights from the design doc. Renormalised over available components. */
export const COMPONENT_WEIGHTS: Record<ComponentKey, number> = {
  buyability: 25,
  issues: 20,
  content: 20,
  compliance: 15,
  buyBox: 10,
  conversion: 10,
};

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  buyability: "Buyability",
  issues: "Issues",
  content: "Content",
  compliance: "Compliance",
  buyBox: "Buy Box",
  conversion: "Conversion",
};

export interface HealthIssue {
  code: string;
  message: string;
  severity: string; // ERROR | WARNING | INFO
  attributeNames: string[];
  categories: string[];
}

export type ComponentScores = Record<ComponentKey, number | null>;

export interface ScoredListing {
  sku: string;
  asin: string | null;
  productType: string | null;
  itemName: string | null;
  conditionType: string | null;
  mainImageUrl: string | null;
  lastUpdatedAt: string | null;

  isBuyable: boolean;
  isDiscoverable: boolean;
  isSuppressed: boolean;

  errorIssueCount: number;
  warningIssueCount: number;
  issues: HealthIssue[];

  components: ComponentScores;
  healthScore: number;
  topFixComponent: ComponentKey | null;
  opportunityScore: number;
}

// Promotional adjectives banned by brand voice (CLAUDE.md / Amazon subjective
// claims). Kept here for the title compliance-lite check.
const PROMO_WORDS = [
  "ultimate", "perfect", "delightful", "delicious", "ideal", "amazing",
  "incredible", "premium", "exclusive", "must-have", "best", "finest",
  "exceptional", "outstanding", "magnificent", "wonderful", "fantastic",
  "superior", "top-quality", "world-class", "awesome",
];

// Emoji / pictographs (covers the common ranges Amazon flags as 99300).
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2705}\u{274C}]/u;

const MAX_STORED_ISSUES = 25;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Buyability from Amazon status[]. Suppressed (buyable-but-not-discoverable)
 *  is the costliest non-zero state: live but invisible in search. */
function scoreBuyability(isBuyable: boolean, isDiscoverable: boolean): number {
  if (isBuyable && isDiscoverable) return 100;
  if (isBuyable && !isDiscoverable) return 30; // search-suppressed
  if (!isBuyable && isDiscoverable) return 40; // visible but not purchasable
  return 0; // inactive
}

/** Issues: start clean, dock per defect by severity. */
function scoreIssues(errors: number, warnings: number): number {
  return clamp(100 - errors * 15 - warnings * 5);
}

/** Title brand-voice / compliance-lite. Full compliance gate (brand, browse
 *  node, vision) runs in the Optimizer phase against full attributes. */
function scoreComplianceLite(itemName: string | null): number {
  if (!itemName) return 50; // no title to judge — neutral-ish
  let s = 100;
  if (EMOJI_RE.test(itemName)) s -= 40;
  const lower = itemName.toLowerCase();
  const promoHits = PROMO_WORDS.filter((w) => {
    const re = new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    return re.test(lower);
  }).length;
  s -= Math.min(promoHits * 15, 45);
  if (itemName.length > 200) s -= 20;
  return clamp(s);
}

function parseIssues(raw: unknown): HealthIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STORED_ISSUES).map((i) => {
    const o = (i ?? {}) as Record<string, unknown>;
    return {
      code: String(o.code ?? ""),
      message: String(o.message ?? ""),
      severity: String(o.severity ?? "INFO"),
      attributeNames: Array.isArray(o.attributeNames) ? (o.attributeNames as string[]) : [],
      categories: Array.isArray(o.categories) ? (o.categories as string[]) : [],
    };
  });
}

/** Weighted average over available (non-null) components, weights renormalised. */
export function computeHealthScore(components: ComponentScores): number {
  let weighted = 0;
  let weightSum = 0;
  for (const key of Object.keys(components) as ComponentKey[]) {
    const v = components[key];
    if (v == null) continue;
    weighted += v * COMPONENT_WEIGHTS[key];
    weightSum += COMPONENT_WEIGHTS[key];
  }
  if (weightSum === 0) return 0;
  return Math.round((weighted / weightSum) * 10) / 10;
}

/** Conversion component from Sales & Traffic. Only meaningful with enough
 *  traffic; below `minSessions` we return null (insufficient data → excluded).
 *  Heuristic: 10% unit-session rate maps to 100 (grocery baseline). */
export function scoreConversion(
  sessions: number | null,
  unitSessionPct: number | null,
  minSessions = 10,
): number | null {
  if (sessions == null || sessions < minSessions || unitSessionPct == null) return null;
  return clamp((unitSessionPct / 0.1) * 100);
}

/** Buy Box / Featured Offer component — from Sales & Traffic buyBoxPercentage
 *  (0-100). Null when we have no traffic signal for the ASIN. */
export function scoreBuyBox(buyBoxPercentage: number | null): number | null {
  if (buyBoxPercentage == null) return null;
  return clamp(buyBoxPercentage);
}

/** Buyability value for a search-suppressed listing (FYP-authoritative). */
export const SUPPRESSED_BUYABILITY = 30;

/**
 * Opportunity Score (0-100) — sales-upside rank. NOT "how bad is the listing"
 * but "how much sales can we unlock by fixing it". This is what the worklist
 * sorts by, so operators work the money first.
 *
 * Logic: a listing is a big opportunity when there's DEMAND (traffic, or latent
 * demand if suppressed) AND a fixable GAP (low conversion vs benchmark, lost
 * featured offer, high returns, low health). A high-traffic listing that already
 * converts well and wins the buy box scores LOW — it's productive, leave it.
 */
const CONVERSION_BENCHMARK = 0.1; // 10% unit-session rate (grocery baseline)

export function computeOpportunity(m: {
  isSuppressed: boolean;
  healthScore: number | null;
  errorIssueCount: number;
  sessions: number | null;
  unitSessionPct: number | null;
  buyBoxPercentage: number | null;
  returnRate: number | null;
}): number {
  // Suppressed = invisible in search → fixing unlocks all latent demand. Highest.
  if (m.isSuppressed) return clamp(75 + Math.min(25, m.errorIssueCount * 3));

  // Demand: how much traffic is in play (saturates ~200 sessions/30d).
  const trafficNorm = m.sessions != null ? Math.min(1, m.sessions / 200) : 0;

  // Gaps (each 0..1).
  const conversionGap =
    m.sessions != null && m.sessions >= 10 && m.unitSessionPct != null
      ? Math.max(0, (CONVERSION_BENCHMARK - m.unitSessionPct) / CONVERSION_BENCHMARK)
      : 0;
  const buyBoxGap = m.buyBoxPercentage != null ? Math.max(0, (100 - m.buyBoxPercentage) / 100) : 0;
  const healthGap = m.healthScore != null ? (100 - m.healthScore) / 100 : 0;
  const returnGap = m.returnRate != null ? Math.min(1, m.returnRate * 2) : 0;

  const raw = trafficNorm * (0.45 * conversionGap + 0.3 * buyBoxGap + 0.15 * healthGap + 0.1 * returnGap);

  // Floor: listings with no traffic still carry a little upside from headroom,
  // so a brand-new low-health listing isn't scored exactly 0.
  const floor = m.sessions == null || m.sessions === 0 ? healthGap * 15 : 0;
  return Math.round(clamp(raw * 100 + floor) * 10) / 10;
}

/** Highest-leverage component to fix = largest weight × gap-from-100. */
export function pickTopFix(components: ComponentScores): ComponentKey | null {
  let best: ComponentKey | null = null;
  let bestGap = 0;
  for (const key of Object.keys(components) as ComponentKey[]) {
    const v = components[key];
    if (v == null || v >= 100) continue;
    const gap = (100 - v) * COMPONENT_WEIGHTS[key];
    if (gap > bestGap) {
      bestGap = gap;
      best = key;
    }
  }
  return best;
}

/**
 * Score one raw Listings Items entry (as returned by `listSkus` with
 * includedData=summaries,issues). Components not measurable in Phase A
 * (content/buyBox/conversion) are left null for later enrichment.
 */
export function scoreListing(raw: Record<string, unknown>): ScoredListing {
  const summaries = Array.isArray(raw.summaries) ? (raw.summaries as Record<string, unknown>[]) : [];
  const summary = summaries[0] ?? {};
  const status = Array.isArray(summary.status) ? (summary.status as string[]) : [];
  const isBuyable = status.includes("BUYABLE");
  const isDiscoverable = status.includes("DISCOVERABLE");
  const isSuppressed = isBuyable && !isDiscoverable;

  const issues = parseIssues(raw.issues);
  const errorIssueCount = issues.filter((i) => i.severity === "ERROR").length;
  const warningIssueCount = issues.filter((i) => i.severity === "WARNING").length;

  const itemName = (summary.itemName as string) ?? null;

  const components: ComponentScores = {
    buyability: scoreBuyability(isBuyable, isDiscoverable),
    issues: scoreIssues(errorIssueCount, warningIssueCount),
    content: null, // Catalog enrichment — Phase B
    compliance: scoreComplianceLite(itemName),
    buyBox: null, // Pricing API — Phase B
    conversion: null, // Sales & Traffic — Phase B
  };

  const mainImage = summary.mainImage as { link?: string } | undefined;

  return {
    sku: String(raw.sku ?? ""),
    asin: (summary.asin as string) ?? null,
    productType: (summary.productType as string) ?? null,
    itemName,
    conditionType: (summary.conditionType as string) ?? null,
    mainImageUrl: mainImage?.link ?? null,
    lastUpdatedAt: (summary.lastUpdatedDate as string) ?? null,
    isBuyable,
    isDiscoverable,
    isSuppressed,
    errorIssueCount,
    warningIssueCount,
    issues,
    components,
    healthScore: computeHealthScore(components),
    topFixComponent: pickTopFix(components),
    // Phase A baseline (no traffic yet) — reports recompute with full funnel.
    opportunityScore: computeOpportunity({
      isSuppressed,
      healthScore: computeHealthScore(components),
      errorIssueCount,
      sessions: null,
      unitSessionPct: null,
      buyBoxPercentage: null,
      returnRate: null,
    }),
  };
}
