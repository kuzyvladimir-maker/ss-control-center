// COGS lookup for the Economics module.
//
// CONSUMES the SkuCost table (the COGS store the parallel sourcing engine fills);
// it does NOT match donor products itself. "No fresh SkuCost row" is surfaced as
// `missing: true` so the caller can flag the SKU and enqueue sourcing elsewhere.
//
// Mirrors reprice-engine.loadCostFloors' "latest effectiveDate wins" rule, but
// returns more (packSize / includesPackaging / source / date / staleness) so the
// profit math can be pack-aware and the UI can flag low-quality cost data.

import { prisma } from "@/lib/prisma";

/** A cost older than this is flagged `stale` (project rule: refresh ≈ every 3mo). */
export const STALE_DAYS = 90;

export interface CogsResult {
  /** Landed product cost for the WHOLE listing (pack-aware). null when missing. */
  cost: number | null;
  perUnit: number | null;
  packSize: number;
  includesPackaging: boolean;
  source: string | null;
  effectiveDate: string | null;
  /** effectiveDate older than STALE_DAYS. */
  stale: boolean;
  /** No usable SkuCost row → caller should flag + enqueue sourcing. */
  missing: boolean;
}

const MISSING: CogsResult = {
  cost: null,
  perUnit: null,
  packSize: 1,
  includesPackaging: false,
  source: null,
  effectiveDate: null,
  stale: false,
  missing: true,
};

function isStale(effectiveDate: string | null, now: Date): boolean {
  if (!effectiveDate) return false;
  const t = Date.parse(effectiveDate);
  if (Number.isNaN(t)) return false;
  const ageDays = (now.getTime() - t) / 86_400_000;
  return ageDays > STALE_DAYS;
}

/** Build a CogsResult from a SkuCost row, deriving the whole-listing cost. */
function fromRow(r: {
  totalCost: number | null;
  costPerUnit: number | null;
  packSize: number | null;
  includesPackaging: boolean;
  source: string;
  effectiveDate: string | null;
}, now: Date): CogsResult {
  const packSize = r.packSize && r.packSize > 0 ? r.packSize : 1;
  // Prefer the explicit total; otherwise derive perUnit × packSize.
  let cost = r.totalCost ?? null;
  const perUnit = r.costPerUnit ?? (cost != null ? cost / packSize : null);
  if (cost == null && r.costPerUnit != null) cost = r.costPerUnit * packSize;
  return {
    cost: cost != null && cost > 0 ? Math.round(cost * 100) / 100 : null,
    perUnit: perUnit != null ? Math.round(perUnit * 100) / 100 : null,
    packSize,
    includesPackaging: r.includesPackaging,
    source: r.source,
    effectiveDate: r.effectiveDate,
    stale: isStale(r.effectiveDate, now),
    missing: cost == null || cost <= 0,
  };
}

/** COGS for many SKUs in one query. Always returns an entry for every input SKU
 *  (missing ones get the MISSING sentinel). */
export async function getCogsForSkus(skus: string[]): Promise<Map<string, CogsResult>> {
  const now = new Date();
  const out = new Map<string, CogsResult>();
  for (const s of skus) out.set(s, MISSING);
  if (skus.length === 0) return out;

  const rows = await prisma.skuCost.findMany({
    where: { sku: { in: skus } },
    orderBy: { effectiveDate: "desc" }, // ISO strings sort correctly; newest first
    select: {
      sku: true,
      totalCost: true,
      costPerUnit: true,
      packSize: true,
      includesPackaging: true,
      source: true,
      effectiveDate: true,
    },
  });
  for (const r of rows) {
    // newest-first → keep only the first (latest) row we see per SKU.
    if (out.get(r.sku)?.missing === false) continue;
    out.set(r.sku, fromRow(r, now));
  }
  return out;
}

export async function getCogsForSku(sku: string): Promise<CogsResult> {
  const m = await getCogsForSkus([sku]);
  return m.get(sku) ?? MISSING;
}
