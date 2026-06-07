/**
 * Walmart Listing Quality — Insights API ("Grow Sales" engine).
 *
 * Walmart ranks listings in search and decides Buy Box / Pro Seller eligibility
 * largely off the Listing Quality Score. Two endpoints power it:
 *
 *   GET  /v3/insights/items/listingQuality/score?wfsFlag=false
 *        → seller-level headline + 6 component scores (0-100).
 *
 *   POST /v3/insights/items/listingQuality/items?limit=200[&nextCursor=…]
 *        body {}  (Content-Type: application/json REQUIRED even when empty)
 *        → per-item quality: component scores, Walmart's own `priority`,
 *          the specific content/offer issues to fix, in-stock + fast-shipping
 *          flags, review count, and an embedded 30-day perf snapshot
 *          (pageViews / conversionRate / GMV / units).
 *
 * The per-item feed is the gold here: it's literally a per-SKU to-do list.
 * Walmart recomputes it ~daily (each item carries `updatedTimestamp`), so we
 * page the whole catalog in a nightly cron and mirror a distilled form into
 * WalmartListingQualityItem — same pattern as the catalog cache. (The
 * "Walmart API first" rule is about not serving live-critical data — orders,
 * inventory — from stale caches; a 4 000-item quality worklist Walmart itself
 * only refreshes daily is correctly a nightly DB mirror.)
 */

import type { WalmartClient } from "./client";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Seller-level score ──────────────────────────────────────────────────────

export interface SellerListingQuality {
  /** Overall 0-100 (the headline "Listing Quality" number). */
  listingQuality: number;
  /** The six component scores Walmart breaks the headline into (0-100). */
  offerScore: number | null;
  ratingReviewScore: number | null;
  contentScore: number | null;
  priceScore: number | null;
  shippingScore: number | null;
  transactibilityScore: number | null;
  itemDefectCnt: number | null;
  defectRatio: number | null;
}

export async function fetchSellerListingQuality(
  client: WalmartClient,
  opts: { wfsFlag?: boolean } = {}
): Promise<SellerListingQuality> {
  const res = await client.requestRaw("GET", "/insights/items/listingQuality/score", {
    params: { wfsFlag: opts.wfsFlag ?? false },
  });
  if (!res.ok) {
    throw new Error(
      `Listing Quality score ${res.status}: ${typeof res.body === "string" ? res.body : JSON.stringify(res.body)?.slice(0, 300)}`
    );
  }
  const p = (res.body as any)?.payload ?? {};
  const s = p.score ?? {};
  const pp = p.postPurchaseQuality ?? {};
  return {
    listingQuality: num(p.listingQuality) ?? 0,
    offerScore: num(s.offerScore),
    ratingReviewScore: num(s.ratingReviewScore),
    contentScore: num(s.contentScore),
    priceScore: num(s.priceScore),
    shippingScore: num(s.shippingScore),
    transactibilityScore: num(s.transactibilityScore),
    itemDefectCnt: num(pp.itemDefectCnt),
    defectRatio: num(pp.defectRatio),
  };
}

// ── Per-item quality ────────────────────────────────────────────────────────

/** Canonical component keys, normalised from Walmart's mixed-case labels. */
export type LqComponent =
  | "ratingReview"
  | "shipping"
  | "publish"
  | "content"
  | "price"
  | "offer";

const COMPONENT_LABEL: Record<string, LqComponent> = {
  "rating & reviews": "ratingReview",
  "shipping speed": "shipping",
  "published and in stock": "publish",
  "content & discoverability": "content",
  "price competitiveness": "price",
  offer: "offer",
};

const COMPONENT_DISPLAY: Record<LqComponent, string> = {
  ratingReview: "Ratings & Reviews",
  shipping: "Shipping speed",
  publish: "Published & in stock",
  content: "Content & Discoverability",
  price: "Price competitiveness",
  offer: "Offer",
};

export type LqImpact = "HIGH" | "MEDIUM" | "LOW" | "ZERO";

/** One distilled, human-actionable problem on an item. */
export interface LqIssue {
  component: LqComponent;
  componentLabel: string;
  impact: LqImpact;
  /** Short title ("Out of stock", "Missing attribute: texture", …). */
  title: string;
  /** Optional longer explanation from Walmart. */
  detail?: string;
}

/** Distilled per-item record we persist + render as the worklist. */
export interface LqItem {
  sku: string;
  itemId: string | null;
  productId: string | null;
  productName: string | null;
  productType: string | null;
  categoryName: string | null;
  condition: string | null;

  lqScore: number | null;
  /** Walmart's own fix-priority for the item. */
  priority: string | null;

  // Component scores (0-100, null when N/A for the item)
  components: Record<LqComponent, { impact: LqImpact; score: number | null }>;

  isInStock: boolean;
  isFastAndFreeShipping: boolean;
  wfsEnabled: boolean;
  ratingCount: number | null;

  // 30-day perf embedded in the LQ feed
  pageViews30d: number | null;
  conversionRate30d: number | null;
  gmv30d: number | null;
  orders30d: number | null;
  units30d: number | null;

  /** The single highest-leverage thing to fix (HIGH impact, lowest score). */
  topFixComponent: LqComponent | null;
  issues: LqIssue[];
  scoredAt: string | null;
}

export interface LqPage {
  items: LqItem[];
  nextCursor: string | null;
  totalItems: number | null;
}

/**
 * Fetch ONE page of the per-item feed. Page size 200 is Walmart's max
 * (limit≥500 returns a 520 backend error). The endpoint's rate bucket is
 * tiny (~1 call / 12-15s sustained), which is why the resumable cron driver
 * paces calls and persists `nextCursor` between runs rather than looping here.
 */
export async function fetchListingQualityPage(
  client: WalmartClient,
  opts: { cursor?: string | null; pageSize?: number } = {}
): Promise<LqPage> {
  const params: Record<string, string | number> = { limit: opts.pageSize ?? 200 };
  if (opts.cursor) params.nextCursor = opts.cursor;

  const res = await client.requestRaw("POST", "/insights/items/listingQuality/items", {
    params,
    body: {},
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const msg =
      typeof res.body === "string" ? res.body : JSON.stringify(res.body)?.slice(0, 300);
    const err = new Error(`Listing Quality items ${res.status}: ${msg}`);
    (err as any).status = res.status;
    throw err;
  }
  const body = res.body as any;
  const rows: any[] = Array.isArray(body?.payload) ? body.payload : [];
  return {
    items: rows.map(distillItem),
    nextCursor: body?.nextCursor || null,
    totalItems: num(body?.totalItems),
  };
}

/**
 * Page through the entire per-item Listing Quality feed. Yields distilled
 * LqItem records. Walmart paginates with an opaque `nextCursor`; page size
 * 200 (its max) keeps the full ~4 000-item sweep to ~20 sequential calls.
 * NOTE: ignores the rate bucket — fine for one-off scripts, but the cron uses
 * the resumable `fetchListingQualityPage` driver instead.
 */
export async function* iterateListingQualityItems(
  client: WalmartClient,
  opts: { pageSize?: number; maxPages?: number } = {}
): AsyncGenerator<LqItem, { totalItems: number; pages: number }, void> {
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 100; // safety backstop (~20k items)
  let cursor: string | undefined;
  let pages = 0;
  let totalItems = 0;

  do {
    const params: Record<string, string | number> = { limit: pageSize };
    if (cursor) params.nextCursor = cursor;

    const res = await client.requestRaw("POST", "/insights/items/listingQuality/items", {
      params,
      body: {},
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Listing Quality items ${res.status}: ${typeof res.body === "string" ? res.body : JSON.stringify(res.body)?.slice(0, 300)}`
      );
    }
    const body = res.body as any;
    totalItems = num(body?.totalItems) ?? totalItems;
    const rows: any[] = Array.isArray(body?.payload) ? body.payload : [];
    for (const raw of rows) yield distillItem(raw);

    cursor = body?.nextCursor || undefined;
    pages++;
  } while (cursor && pages < maxPages);

  return { totalItems, pages };
}

/** Collapse one raw Walmart item into the distilled LqItem we store/render. */
export function distillItem(raw: any): LqItem {
  const components = {
    ratingReview: { impact: "ZERO" as LqImpact, score: null as number | null },
    shipping: { impact: "ZERO" as LqImpact, score: null as number | null },
    publish: { impact: "ZERO" as LqImpact, score: null as number | null },
    content: { impact: "ZERO" as LqImpact, score: null as number | null },
    price: { impact: "ZERO" as LqImpact, score: null as number | null },
    offer: { impact: "ZERO" as LqImpact, score: null as number | null },
  } satisfies Record<LqComponent, { impact: LqImpact; score: number | null }>;

  const values: any[] = raw?.qualityScoreData?.values ?? [];
  for (const v of values) {
    const key = COMPONENT_LABEL[String(v?.scoreType ?? "").toLowerCase()];
    if (!key) continue;
    components[key] = {
      impact: (String(v?.impact ?? "ZERO").toUpperCase() as LqImpact) ?? "ZERO",
      score: num(v?.scoreValue),
    };
  }

  const isInStock = Boolean(raw?.isInStock);
  const isFastAndFreeShipping = Boolean(raw?.isFastAndFreeShipping);
  const ratingCount = num(raw?.scoreDetails?.ratingReviews?.ratingCount);

  const issues: LqIssue[] = [];

  // ── Offer / structural levers ──
  if (!isInStock) {
    issues.push({
      component: "publish",
      componentLabel: COMPONENT_DISPLAY.publish,
      impact: components.publish.impact,
      title: "Out of stock — can't sell",
      detail: "Item is not in stock, so it can't convert and drags the score.",
    });
  }
  if (!isFastAndFreeShipping) {
    issues.push({
      component: "shipping",
      componentLabel: COMPONENT_DISPLAY.shipping,
      impact: components.shipping.impact,
      title: "No fast & free shipping tag",
      detail:
        "Item isn't flagged fast & free. Walmart heavily ranks expedited/TwoDay offers.",
    });
  }
  if (ratingCount !== null && ratingCount === 0) {
    issues.push({
      component: "ratingReview",
      componentLabel: COMPONENT_DISPLAY.ratingReview,
      impact: components.ratingReview.impact,
      title: "No reviews",
      detail: "0 ratings. Review Accelerator / first-review programs help here.",
    });
  }

  // ── Price ──
  const priceDetail = raw?.scoreDetails?.offer?.price;
  if (priceDetail?.issueTitle && priceDetail.issueTitle !== "Not Enough Data") {
    issues.push({
      component: "price",
      componentLabel: COMPONENT_DISPLAY.price,
      impact: components.price.impact,
      title: String(priceDetail.issueTitle),
      detail: priceDetail.additionalDes ? String(priceDetail.additionalDes) : undefined,
    });
  }

  // ── Content attributes (missing / invalid / spelling / capitalization) ──
  const contentIssues: any[] = raw?.scoreDetails?.contentAndDiscoverability?.issues ?? [];
  for (const attr of contentIssues) {
    const subIssues: any[] = attr?.issues ?? [];
    for (const sub of subIssues) {
      issues.push({
        component: "content",
        componentLabel: COMPONENT_DISPLAY.content,
        impact: components.content.impact,
        title: `${String(attr?.attributeName ?? "attribute")}: ${humanizeIssueTitle(sub?.title)}`,
        detail: sub?.value ? String(sub.value) : undefined,
      });
    }
  }

  // Highest-leverage fix: first HIGH-impact component (Walmart orders values
  // by impact already), else first MEDIUM, else null.
  const topFixComponent = pickTopFix(components);

  return {
    sku: String(raw?.sku ?? ""),
    itemId: raw?.itemId ? String(raw.itemId) : null,
    productId: raw?.productId ? String(raw.productId) : null,
    productName: raw?.productName ? String(raw.productName) : null,
    productType: raw?.productType ? String(raw.productType) : null,
    categoryName: raw?.categoryName ? String(raw.categoryName) : null,
    condition: raw?.condition ? String(raw.condition) : null,
    lqScore: num(raw?.qualityScoreData?.score),
    priority: raw?.priority ? String(raw.priority) : null,
    components,
    isInStock,
    isFastAndFreeShipping,
    wfsEnabled: Boolean(raw?.wfsEnabled),
    ratingCount,
    pageViews30d: num(raw?.last30DaysPageViews) ?? num(raw?.stats?.pageViews),
    conversionRate30d: num(raw?.last30DaysConversionRate) ?? num(raw?.stats?.conversionRate),
    gmv30d: num(raw?.gmv) ?? num(raw?.stats?.gmvAmount?.amount),
    orders30d: num(raw?.stats?.orders),
    units30d: num(raw?.stats?.totalUnits),
    topFixComponent,
    issues,
    scoredAt: raw?.updatedTimestamp ? String(raw.updatedTimestamp) : null,
  };
}

function pickTopFix(
  components: Record<LqComponent, { impact: LqImpact; score: number | null }>
): LqComponent | null {
  const order: LqImpact[] = ["HIGH", "MEDIUM", "LOW"];
  for (const impact of order) {
    let best: { key: LqComponent; score: number } | null = null;
    for (const [k, v] of Object.entries(components) as Array<
      [LqComponent, { impact: LqImpact; score: number | null }]
    >) {
      if (v.impact !== impact) continue;
      const score = v.score ?? 0;
      if (!best || score < best.score) best = { key: k, score };
    }
    if (best) return best.key;
  }
  return null;
}

function humanizeIssueTitle(title: unknown): string {
  const t = String(title ?? "").trim();
  if (!t) return "issue";
  // MISSING → "missing", NOT_VALID → "not valid", CONTAINS_SPELLING_ERRORS → …
  return t.toLowerCase().replace(/_/g, " ");
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export { COMPONENT_DISPLAY };
