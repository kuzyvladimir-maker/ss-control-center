/** Pure legacy COGS row selection shared by the business reader and SHADOW diagnostics. */

/** A cost older than this is flagged `stale` (project rule: refresh ≈ every 3mo). */
export const STALE_DAYS = 90;

export interface CogsResult {
  /** Exact selected legacy SkuCost row; diagnostic only, never listing scope. */
  skuCostId: string | null;
  /** Landed product cost for the WHOLE listing (pack-aware). null when missing. */
  cost: number | null;
  perUnit: number | null;
  packSize: number;
  includesPackaging: boolean;
  source: string | null;
  effectiveDate: string | null;
  stale: boolean;
  missing: boolean;
  outcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "UNKNOWN" | "MISSING";
}

export interface CogsSourceRow {
  id?: string | null;
  sku: string;
  totalCost: number | null;
  costPerUnit: number | null;
  packSize: number | null;
  includesPackaging: boolean;
  source: string;
  effectiveDate: string | null;
  evidenceOutcome?: string | null;
  needsReview?: boolean;
}

export const MISSING_COGS_RESULT: CogsResult = Object.freeze({
  skuCostId: null,
  cost: null,
  perUnit: null,
  packSize: 1,
  includesPackaging: false,
  source: null,
  effectiveDate: null,
  stale: false,
  missing: true,
  outcome: "MISSING",
});

function isStale(effectiveDate: string | null, now: Date): boolean {
  if (!effectiveDate) return false;
  const timestamp = Date.parse(effectiveDate);
  if (Number.isNaN(timestamp)) return false;
  return (now.getTime() - timestamp) / 86_400_000 > STALE_DAYS;
}

function fromRow(row: CogsSourceRow, now: Date): CogsResult {
  const packSize = row.packSize && row.packSize > 0 ? row.packSize : 1;
  let cost = row.totalCost ?? null;
  const perUnit = row.costPerUnit ?? (cost != null ? cost / packSize : null);
  if (cost == null && row.costPerUnit != null) cost = row.costPerUnit * packSize;
  const usableCost = cost != null && cost > 0 && row.evidenceOutcome !== "UNSOURCEABLE"
    ? Math.round(cost * 100) / 100
    : null;
  const outcome = row.evidenceOutcome === "FACT"
      || row.evidenceOutcome === "ESTIMATE"
      || row.evidenceOutcome === "UNSOURCEABLE"
    ? row.evidenceOutcome
    : usableCost == null
      ? "MISSING"
      : row.needsReview === true
        ? "ESTIMATE"
        : "UNKNOWN";
  return {
    skuCostId: typeof row.id === "string" && row.id ? row.id : null,
    cost: usableCost,
    perUnit: usableCost != null && perUnit != null
      ? Math.round(perUnit * 100) / 100
      : null,
    packSize,
    includesPackaging: row.includesPackaging,
    source: row.source,
    effectiveDate: row.effectiveDate,
    stale: isStale(row.effectiveDate, now),
    missing: usableCost == null,
    outcome,
  };
}

/** Select the first row for each SKU from an already newest-first result set. */
export function selectCurrentCogsRows(
  skus: readonly string[],
  rows: readonly CogsSourceRow[],
  now: Date,
): Map<string, CogsResult> {
  const output = new Map<string, CogsResult>();
  for (const sku of skus) output.set(sku, MISSING_COGS_RESULT);
  const requested = new Set(skus);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!requested.has(row.sku) || seen.has(row.sku)) continue;
    seen.add(row.sku);
    output.set(row.sku, fromRow(row, now));
  }
  return output;
}
