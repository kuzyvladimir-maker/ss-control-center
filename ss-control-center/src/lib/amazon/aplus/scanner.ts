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

export interface AplusOpportunity {
  sku: string;
  asin: string;
  itemName: string | null;
  opportunityScore: number | null;
  revenue30d: number | null;
  sessions30d: number | null;
}
export interface CoverageResult {
  aplusDocs: number;
  asinsWithAplus: number;
  ownBrandTotal: number;
  ownBrandWithAplus: number;
  ownBrandWithout: number;
  opportunities: AplusOpportunity[]; // own-brand WITHOUT A+, prioritized
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
    select: { sku: true, asin: true, itemName: true, opportunityScore: true, revenue30d: true, sessions30d: true },
  });

  const opportunities: AplusOpportunity[] = [];
  let ownWith = 0;
  for (const it of items) {
    if (!it.asin) continue;
    if (withAplus.has(it.asin)) { ownWith++; continue; }
    opportunities.push({
      sku: it.sku,
      asin: it.asin,
      itemName: it.itemName,
      opportunityScore: it.opportunityScore,
      revenue30d: it.revenue30d,
      sessions30d: it.sessions30d,
    });
  }
  opportunities.sort(
    (a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0) || (b.revenue30d ?? 0) - (a.revenue30d ?? 0),
  );

  return {
    aplusDocs: docCount,
    asinsWithAplus: withAplus.size,
    ownBrandTotal: items.length,
    ownBrandWithAplus: ownWith,
    ownBrandWithout: opportunities.length,
    opportunities,
  };
}
