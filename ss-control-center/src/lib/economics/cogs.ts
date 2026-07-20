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
import {
  MISSING_COGS_RESULT,
  selectCurrentCogsRows,
  type CogsResult,
} from "./cogs-selection";

export {
  STALE_DAYS,
  selectCurrentCogsRows,
  type CogsResult,
  type CogsSourceRow,
} from "./cogs-selection";

/** COGS for many SKUs in one query. Always returns an entry for every input SKU
 *  (missing ones get the MISSING sentinel). */
export async function getCogsForSkus(skus: string[]): Promise<Map<string, CogsResult>> {
  const now = new Date();
  if (skus.length === 0) return new Map();

  const rows = await prisma.skuCost.findMany({
    where: { sku: { in: skus } },
    orderBy: [
      { effectiveDate: "desc" },
      { updatedAt: "desc" },
      { createdAt: "desc" },
    ],
    select: {
      id: true,
      sku: true,
      totalCost: true,
      costPerUnit: true,
      packSize: true,
      includesPackaging: true,
      source: true,
      effectiveDate: true,
      evidenceOutcome: true,
      needsReview: true,
    },
  });
  return selectCurrentCogsRows(skus, rows, now);
}

export async function getCogsForSku(sku: string): Promise<CogsResult> {
  const m = await getCogsForSkus([sku]);
  return m.get(sku) ?? MISSING_COGS_RESULT;
}
