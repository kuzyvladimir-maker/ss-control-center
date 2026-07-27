/**
 * Walmart Item-Compliance / Trust-&-Safety removals — read tool.
 *
 * WHAT THIS ANSWERS
 * -----------------
 * "Which of our listings did Walmart pull for a policy / Trust-&-Safety
 * violation (Prohibited Products etc.), machine-readable, not by hand from the
 * Seller Center UI?"
 *
 * WHY THIS ENDPOINT (and not the obvious ones)
 * --------------------------------------------
 * Probed live against STARFITSTORE (Walmart store 1, "SIRIUS TRADING
 * INTERNATIONAL LLC", seller 10001624309) on 2026-06-24:
 *
 *   • Insights  GET /v3/insights/items/unpublished/counts  → 200, but for this
 *     seller only ever returns END_DATE + REASONABLE_PRICE… buckets. Trust-&-
 *     Safety removals are NOT counted here (they aren't "unpublished" in the
 *     pricing/lifecycle sense — they're a separate enforcement hold).
 *   • Insights  GET /v3/insights/items/unpublished/items   → 403
 *     "Auth header required for this consumer" (needs a WM_CONSUMER.CHANNEL.TYPE
 *     issued to a registered Solution Provider — we don't have one). POST → 404.
 *   • Reports  POST /v3/reports/reportRequests?reportType=ITEM  → the ITEM
 *     report has PublishedStatus + ComplianceAttributes columns but no
 *     unpublished-reason column, so it can't tell T&S from price.
 *
 * The reliable, plain-OAuth path is the plain Items API:
 *
 *   GET /v3/items?publishedStatus=UNPUBLISHED&limit=200&offset=N   (offset-paged)
 *
 * Each row carries the human-readable removal reason:
 *
 *   "unpublishedReasons": { "reason": [
 *      "Your item has been flagged by our internal team. To find out why,
 *       file a case in Case Management." ] }
 *
 * That exact phrasing IS the Trust-&-Safety / Item-Compliance removal — the same
 * thing the Seller Center "Health & Compliance → Item compliance — Multiple
 * items need attention" task and the T&S "Download Reports" button show. We
 * classify each unpublished row by its reason text and return the violation
 * subset.
 *
 * NB offset pagination on /v3/items is known-flaky (it can repeat rows), so we
 * dedupe by sku+wpid. See [[project_walmart_catalog_search]].
 */

import type { WalmartClient } from "./client";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Buckets we sort every UNPUBLISHED reason string into. */
export type RemovalClass =
  | "TRUST_SAFETY_FLAG" // "flagged by our internal team … file a case" — the T&S/compliance pull
  | "COMPLIANCE" // explicit prohibited / regulatory / IP / hazmat wording
  | "PRICE_RULE" // pricing-rule / price-gouging unpublish
  | "END_DATE" // Site End Date passed
  | "IMAGE_MISSING"
  | "ID_MISMATCH" // UPC / product-id mismatch
  | "OTHER";

/** A violation = the two classes Walmart pulled the item for a policy reason. */
export const VIOLATION_CLASSES: ReadonlySet<RemovalClass> = new Set([
  "TRUST_SAFETY_FLAG",
  "COMPLIANCE",
]);

export interface RemovedItem {
  sku: string;
  itemId: string | null; // Walmart wpid
  upc: string | null;
  gtin: string | null;
  productName: string | null;
  productType: string | null;
  price: number | null;
  currency: string | null;
  publishedStatus: string; // UNPUBLISHED
  lifecycleStatus: string | null; // ACTIVE / ARCHIVED / RETIRED
  classification: RemovalClass;
  /** Cleaned, single-line reason (Walmart ||label@@@url|| markup stripped). */
  reason: string;
  /** Raw reason string(s) exactly as Walmart returned them. */
  reasonRaw: string[];
  /** Any help/learn-more URL embedded in the reason markup. */
  reasonUrl: string | null;
}

export interface ComplianceRemovalsResult {
  storeIndex: number;
  storeName: string;
  sellerId: string | null;
  scannedAt: string;
  /** Total UNPUBLISHED items in the catalog (deduped). */
  totalUnpublished: number;
  /** Count per RemovalClass across all unpublished items. */
  rollup: Record<RemovalClass, number>;
  /** The violation subset (TRUST_SAFETY_FLAG + COMPLIANCE), unless includeAll. */
  removals: RemovedItem[];
}

/** Turn Walmart's "||label@@@https://…||" inline markup into clean text + url. */
function cleanReason(raw: string): { text: string; url: string | null } {
  let url: string | null = null;
  const text = raw.replace(/\|\|([^@]+)@@@([^|]+)\|\|/g, (_m, label, href) => {
    if (!url) url = String(href).trim();
    return String(label).trim();
  });
  return { text: text.replace(/\s+/g, " ").trim(), url };
}

export function classifyReason(reason: string): RemovalClass {
  const r = reason.toLowerCase();
  if (r.includes("flagged by our internal team")) return "TRUST_SAFETY_FLAG";
  if (
    r.includes("prohibited") ||
    r.includes("trust & safety") ||
    r.includes("trust and safety") ||
    r.includes("compliance") ||
    r.includes("regulat") ||
    r.includes("hazard") ||
    r.includes("intellectual property") ||
    r.includes("counterfeit") ||
    r.includes("restricted")
  )
    return "COMPLIANCE";
  if (r.includes("end date")) return "END_DATE";
  if (
    r.includes("pricing rule") ||
    r.includes("price gouging") ||
    r.includes("reasonable price") ||
    r.includes("unfair or abusive pricing")
  )
    return "PRICE_RULE";
  if (r.includes("primary image") || r.includes("image is missing")) return "IMAGE_MISSING";
  if (r.includes("upc") || r.includes("product id") || r.includes("gtin")) return "ID_MISMATCH";
  return "OTHER";
}

function emptyRollup(): Record<RemovalClass, number> {
  return {
    TRUST_SAFETY_FLAG: 0,
    COMPLIANCE: 0,
    PRICE_RULE: 0,
    END_DATE: 0,
    IMAGE_MISSING: 0,
    ID_MISMATCH: 0,
    OTHER: 0,
  };
}

/**
 * Page the whole UNPUBLISHED catalog and return the compliance / Trust-&-Safety
 * removals. ~676 items for STARFITSTORE = ~4 pages of 200, a few seconds live.
 *
 * @param opts.includeAll  return every unpublished class, not just violations.
 * @param opts.maxPages    safety backstop (default 60 ⇒ 12 000 items).
 */
export async function getComplianceRemovals(
  client: WalmartClient,
  opts: { includeAll?: boolean; maxPages?: number; pageSize?: number } = {}
): Promise<ComplianceRemovalsResult> {
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 60;

  const rollup = emptyRollup();
  const seen = new Set<string>();
  const all: RemovedItem[] = [];

  let offset = 0;
  let totalItems = Infinity;
  let pages = 0;

  while (offset < totalItems && pages < maxPages) {
    const res = await client.requestRaw("GET", "/items", {
      params: { publishedStatus: "UNPUBLISHED", limit: pageSize, offset },
    });
    if (!res.ok) {
      const msg =
        typeof res.body === "string" ? res.body : JSON.stringify(res.body)?.slice(0, 300);
      throw new Error(`Walmart /items UNPUBLISHED ${res.status}: ${msg}`);
    }
    const b = res.body as any;
    totalItems = Number(b?.totalItems ?? 0) || totalItems;
    const items: any[] =
      (Array.isArray(b?.ItemResponse) && b.ItemResponse) ||
      (Array.isArray(b?.itemResponse) && b.itemResponse) ||
      (Array.isArray(b?.items) && b.items) ||
      [];
    if (items.length === 0) break;
    offset += items.length;
    pages++;

    for (const it of items) {
      const sku = String(it?.sku ?? "");
      const wpid = it?.wpid ? String(it.wpid) : null;
      const dedupeKey = `${sku}::${wpid ?? ""}`;
      if (seen.has(dedupeKey)) continue; // offset paging can repeat rows
      seen.add(dedupeKey);

      const reasonRaw: string[] = Array.isArray(it?.unpublishedReasons?.reason)
        ? it.unpublishedReasons.reason.map((x: any) => String(x))
        : [];
      const joined = reasonRaw.join(" | ");
      const { text, url } = cleanReason(joined);
      const classification = classifyReason(joined);
      rollup[classification] += 1;

      if (!opts.includeAll && !VIOLATION_CLASSES.has(classification)) continue;

      all.push({
        sku,
        itemId: wpid,
        upc: it?.upc ? String(it.upc) : null,
        gtin: it?.gtin ? String(it.gtin) : null,
        productName: it?.productName ? String(it.productName) : null,
        productType: it?.productType ? String(it.productType) : null,
        price: typeof it?.price?.amount === "number" ? it.price.amount : null,
        currency: it?.price?.currency ? String(it.price.currency) : null,
        publishedStatus: String(it?.publishedStatus ?? "UNPUBLISHED"),
        lifecycleStatus: it?.lifecycleStatus ? String(it.lifecycleStatus) : null,
        classification,
        reason: text || "(no reason given)",
        reasonRaw,
        reasonUrl: url,
      });
    }
  }

  // Violations first (T&S before generic compliance), then by name.
  all.sort((a, b) => {
    const av = VIOLATION_CLASSES.has(a.classification) ? 0 : 1;
    const bv = VIOLATION_CLASSES.has(b.classification) ? 0 : 1;
    if (av !== bv) return av - bv;
    if (a.classification !== b.classification)
      return a.classification.localeCompare(b.classification);
    return (a.productName ?? "").localeCompare(b.productName ?? "");
  });

  const totalUnpublished = Object.values(rollup).reduce((s, n) => s + n, 0);

  return {
    storeIndex: client.storeIndex,
    storeName: client.credentials.storeName,
    sellerId: client.credentials.sellerId,
    scannedAt: new Date().toISOString(),
    totalUnpublished,
    rollup,
    removals: all,
  };
}
