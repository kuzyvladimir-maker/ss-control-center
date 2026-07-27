/**
 * A+ Content Factory — coverage scanner.
 *
 * Determines which OWN-BRAND listings (Salutem Vita / Starfit, incl. gift sets)
 * LACK A+ content — the opportunity list the factory works on. Builds the set of
 * ASINs that already have A+ from the live A+ API (content docs → ASIN relations),
 * then subtracts it from our own-brand mirror. Prioritizes by opportunity/revenue.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { listContentDocuments, listAsinRelations } from "./client";
import { classifyConcept } from "./concepts";

export interface AplusOpportunity {
  sku: string;
  asin: string;
  itemName: string | null;
  opportunityScore: number | null;
  revenue30d: number | null;
  sessions30d: number | null;
}
/** A full catalog row for the filterable selection pool. */
export interface AplusPoolItem {
  sku: string;
  asin: string;
  itemName: string | null;
  concept: string;
  hasAplus: boolean;
  revenue30d: number | null;
  unitsOrdered30d: number | null;
  unitSessionPct: number | null;
  sessions30d: number | null;
  healthScore: number | null;
  opportunityScore: number | null;
}
export interface CoverageResult {
  aplusDocs: number;
  asinsWithAplus: number;
  ownBrandTotal: number;
  ownBrandWithAplus: number;
  ownBrandWithout: number;
  opportunities: AplusOpportunity[]; // own-brand WITHOUT A+, prioritized
  pool: AplusPoolItem[]; // ALL own-brand (with hasAplus flag) for the selection UI
}

/** Build the set of ASINs that already have A+ content (across all our docs). */
export async function asinsWithAplus(storeIndex: number): Promise<{ asins: Set<string>; docCount: number }> {
  const docs = await listContentDocuments(storeIndex);
  const asins = new Set<string>();
  for (const d of docs) {
    if (!d.contentReferenceKey) continue;
    try {
      const rel = await listAsinRelations(storeIndex, d.contentReferenceKey);
      rel.forEach((a) => asins.add(a));
    } catch {
      /* skip a doc whose relations fail to load */
    }
  }
  return { asins, docCount: docs.length };
}

export async function scanCoverage(prisma: PrismaClient, storeIndex: number): Promise<CoverageResult> {
  const { asins: withAplus, docCount } = await asinsWithAplus(storeIndex);

  // Own-brand listings (gift sets included) from the mirror, with an ASIN.
  const items = await prisma.amazonListingHealthItem.findMany({
    where: {
      storeIndex,
      asin: { not: null },
      OR: [{ itemName: { contains: "Salutem Vita" } }, { itemName: { contains: "Starfit" } }],
    },
    select: {
      sku: true, asin: true, itemName: true, productType: true, opportunityScore: true,
      revenue30d: true, sessions30d: true, unitsOrdered30d: true, unitSessionPct: true, healthScore: true,
    },
  });

  const opportunities: AplusOpportunity[] = [];
  const pool: AplusPoolItem[] = [];
  let ownWith = 0;
  for (const it of items) {
    if (!it.asin) continue;
    const hasAplus = withAplus.has(it.asin);
    const brand = it.itemName && /starfit/i.test(it.itemName) ? "Starfit" : "Salutem Vita";
    pool.push({
      sku: it.sku, asin: it.asin, itemName: it.itemName,
      concept: classifyConcept(it.itemName, it.productType, brand),
      hasAplus,
      revenue30d: it.revenue30d, unitsOrdered30d: it.unitsOrdered30d, unitSessionPct: it.unitSessionPct,
      sessions30d: it.sessions30d, healthScore: it.healthScore, opportunityScore: it.opportunityScore,
    });
    if (hasAplus) { ownWith++; continue; }
    opportunities.push({
      sku: it.sku, asin: it.asin, itemName: it.itemName,
      opportunityScore: it.opportunityScore, revenue30d: it.revenue30d, sessions30d: it.sessions30d,
    });
  }
  opportunities.sort(
    (a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0) || (b.revenue30d ?? 0) - (a.revenue30d ?? 0),
  );
  pool.sort((a, b) => (b.revenue30d ?? 0) - (a.revenue30d ?? 0));

  return {
    aplusDocs: docCount,
    asinsWithAplus: withAplus.size,
    ownBrandTotal: items.length,
    ownBrandWithAplus: ownWith,
    ownBrandWithout: opportunities.length,
    opportunities,
    pool,
  };
}
