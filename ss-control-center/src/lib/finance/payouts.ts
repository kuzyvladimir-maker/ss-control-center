// Payout ingest — the "money in" for the Funds engine (cash basis).
//
// Walmart: aggregate WalmartReconTransaction (already in DB) per recon report →
//          net = sum(amount) (Sales positive, Refunds/Fees negative).
// Amazon:  per settlement report (live SP-API), net = sum of all row amounts =
//          the deposit for that settlement period.
// Both upsert into Payout keyed by (marketplace, externalId) — idempotent.

import { prisma } from "@/lib/prisma";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";
import {
  listSettlementReports,
  parseSettlementTsv,
} from "@/lib/amazon-sp-api/settlement-reports";
import { getReportDocumentUrl, downloadReport } from "@/lib/amazon-sp-api/reports";
import { AMAZON_STORE_ENTITY, WALMART_ENTITY, storeIdToIndex } from "./entities";

// Personal store: SP-API 403s — skip (matches /api/adjustments/settlement-sync).
const SKIPPED_AMAZON_STORES = new Set<string>(["store2"]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface IngestResult {
  marketplace: string;
  created: number;
  updated: number;
  errors: string[];
}

/** Walmart payouts from the recon transactions already stored in our DB. */
export async function ingestWalmartPayouts(): Promise<IngestResult> {
  const res: IngestResult = { marketplace: "walmart", created: 0, updated: 0, errors: [] };

  // One payout per recon report (reportDate). Net = sum of all amounts.
  const groups = await prisma.walmartReconTransaction.groupBy({
    by: ["reportDate"],
    _sum: { amount: true },
    _min: { transactionPostedTimestamp: true },
    _max: { transactionPostedTimestamp: true },
  });

  for (const g of groups) {
    const net = g._sum.amount ?? 0;
    const reportIso = g.reportDate instanceof Date ? g.reportDate.toISOString() : String(g.reportDate);
    const externalId = `walmart:recon:${reportIso.slice(0, 10)}`;
    try {
      const existing = await prisma.payout.findUnique({
        where: { payout_dedup: { marketplace: "walmart", externalId } },
      });
      await prisma.payout.upsert({
        where: { payout_dedup: { marketplace: "walmart", externalId } },
        create: {
          marketplace: "walmart",
          storeIndex: 1,
          entity: WALMART_ENTITY,
          externalId,
          periodStart: g._min.transactionPostedTimestamp?.toISOString().slice(0, 10) ?? null,
          periodEnd: g._max.transactionPostedTimestamp?.toISOString().slice(0, 10) ?? null,
          depositDate: reportIso.slice(0, 10),
          netAmount: round2(net),
          source: "recon",
        },
        update: { netAmount: round2(net) },
      });
      if (existing) res.updated++;
      else res.created++;
    } catch (e) {
      res.errors.push(`walmart ${externalId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return res;
}

/** Amazon payouts from settlement reports (one settlement = one deposit). */
export async function ingestAmazonPayouts(daysBack = 90): Promise<IngestResult> {
  const res: IngestResult = { marketplace: "amazon", created: 0, updated: 0, errors: [] };
  const stores = getConfiguredStores().filter((s) => !SKIPPED_AMAZON_STORES.has(s));
  const createdSince = new Date(Date.now() - daysBack * 86_400_000).toISOString();

  for (const storeId of stores) {
    const idx = storeIdToIndex(storeId);
    let reports;
    try {
      reports = await listSettlementReports(storeId, { createdSince });
    } catch (e) {
      res.errors.push(`amazon ${storeId} list: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // Dedup by reportDocumentId.
    const seen = new Set<string>();
    for (const rep of reports) {
      if (seen.has(rep.reportDocumentId)) continue;
      seen.add(rep.reportDocumentId);
      const externalId = `amazon:${storeId}:${rep.reportId}`;
      try {
        const url = await getReportDocumentUrl(storeId, rep.reportDocumentId);
        const tsv = await downloadReport(url);
        const { rows } = parseSettlementTsv(tsv);
        if (rows.length === 0) continue; // empty/period-only report
        const net = rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0);
        const existing = await prisma.payout.findUnique({
          where: { payout_dedup: { marketplace: "amazon", externalId } },
        });
        await prisma.payout.upsert({
          where: { payout_dedup: { marketplace: "amazon", externalId } },
          create: {
            marketplace: "amazon",
            storeIndex: idx,
            entity: AMAZON_STORE_ENTITY[idx] ?? storeId,
            externalId,
            periodStart: rep.dataStartTime?.slice(0, 10) ?? null,
            periodEnd: rep.dataEndTime?.slice(0, 10) ?? null,
            depositDate: rep.dataEndTime?.slice(0, 10) ?? null,
            netAmount: round2(net),
            source: "settlement",
          },
          update: { netAmount: round2(net) },
        });
        if (existing) res.updated++;
        else res.created++;
      } catch (e) {
        res.errors.push(`amazon ${externalId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return res;
}

export async function ingestAllPayouts(daysBack = 90): Promise<IngestResult[]> {
  // Walmart is in-DB and cheap; Amazon hits live SP-API. Run sequentially.
  const walmart = await ingestWalmartPayouts();
  let amazon: IngestResult;
  try {
    amazon = await ingestAmazonPayouts(daysBack);
  } catch (e) {
    amazon = { marketplace: "amazon", created: 0, updated: 0, errors: [String(e)] };
  }
  return [walmart, amazon];
}
