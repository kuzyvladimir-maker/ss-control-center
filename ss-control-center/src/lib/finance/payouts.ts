// Payout ingest with bucketed breakdown — the "Get Report" pipeline.
//
// Amazon: list auto-generated V2 settlement reports, skip ones already pulled,
//         download + parseAmazonSettlement → Payout + PayoutLines (the molecule
//         breakdown). Net = settlement header total-amount.
// Walmart: list available recon report dates (LIVE API, walmart-api-first), skip
//          dates already pulled, getFullReconReport → categorize → Payout + lines.
// Both are incremental: closed periods are immutable, dedup by externalId, and
// Amazon report-doc ids are tracked in a Setting so we never re-download.

import { prisma } from "@/lib/prisma";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";
import { listSettlementReports } from "@/lib/amazon-sp-api/settlement-reports";
import { getReportDocumentUrl, downloadReport } from "@/lib/amazon-sp-api/reports";
import { getWalmartClient, getWalmartStoreStatus } from "@/lib/walmart/client";
import { WalmartReportsApi } from "@/lib/walmart/reports";
import {
  parseAmazonSettlement,
  bucketWalmartRow,
  BUCKET_META,
  type Bucket,
} from "./settlement";
import { AMAZON_STORE_ENTITY, WALMART_ENTITY, storeIdToIndex } from "./entities";

const SKIPPED_AMAZON_STORES = new Set<string>(["store2"]);
const PULLED_REPORTS_KEY = "finance:amazon:pulledReports";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface IngestResult {
  marketplace: string;
  created: number;
  updated: number;
  periods: { externalId: string; net: number; period: string | null }[];
  errors: string[];
}

/** Split bucket lines into gross income and total fees/costs for the summary. */
function summarize(lines: { bucket: Bucket; amount: number }[]) {
  let grossSales = 0;
  let feesTotal = 0;
  for (const l of lines) {
    const nature = BUCKET_META[l.bucket].nature;
    if (nature === "income") grossSales += l.amount;
    else if (nature === "cost") feesTotal += l.amount; // negative
  }
  return { grossSales: round2(grossSales), feesTotal: round2(feesTotal) };
}

/** Upsert one Payout and replace its PayoutLines (idempotent). */
async function upsertPayoutWithLines(opts: {
  marketplace: string;
  externalId: string;
  storeIndex: number | null;
  entity: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  depositDate: string | null;
  netAmount: number;
  source: string;
  lines: { bucket: Bucket; amount: number; count: number }[];
}): Promise<"created" | "updated"> {
  const { grossSales, feesTotal } = summarize(opts.lines);
  const existing = await prisma.payout.findUnique({
    where: { payout_dedup: { marketplace: opts.marketplace, externalId: opts.externalId } },
  });
  const payout = await prisma.payout.upsert({
    where: { payout_dedup: { marketplace: opts.marketplace, externalId: opts.externalId } },
    create: {
      marketplace: opts.marketplace, externalId: opts.externalId,
      storeIndex: opts.storeIndex, entity: opts.entity,
      periodStart: opts.periodStart, periodEnd: opts.periodEnd, depositDate: opts.depositDate,
      grossSales, feesTotal, netAmount: round2(opts.netAmount), source: opts.source,
    },
    update: {
      grossSales, feesTotal, netAmount: round2(opts.netAmount),
      periodStart: opts.periodStart, periodEnd: opts.periodEnd, depositDate: opts.depositDate,
    },
  });
  // Replace lines.
  await prisma.payoutLine.deleteMany({ where: { payoutId: payout.id } });
  if (opts.lines.length) {
    await prisma.payoutLine.createMany({
      data: opts.lines.map((l) => ({
        payoutId: payout.id, marketplace: opts.marketplace,
        bucket: l.bucket, amount: round2(l.amount), count: l.count,
      })),
    });
  }
  return existing ? "updated" : "created";
}

async function readPulledReports(): Promise<Set<string>> {
  const row = await prisma.setting.findUnique({ where: { key: PULLED_REPORTS_KEY } });
  try {
    return new Set<string>(row?.value ? JSON.parse(row.value) : []);
  } catch {
    return new Set<string>();
  }
}
async function writePulledReports(set: Set<string>) {
  const value = JSON.stringify([...set].slice(-500)); // cap history
  await prisma.setting.upsert({
    where: { key: PULLED_REPORTS_KEY }, update: { value }, create: { key: PULLED_REPORTS_KEY, value },
  });
}

/** Amazon: pull NEW closed settlement reports → Payout + bucketed PayoutLines. */
export async function ingestAmazonPayouts(daysBack = 120): Promise<IngestResult> {
  const res: IngestResult = { marketplace: "amazon", created: 0, updated: 0, periods: [], errors: [] };
  const stores = getConfiguredStores().filter((s) => !SKIPPED_AMAZON_STORES.has(s));
  const createdSince = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const pulled = await readPulledReports();

  for (const storeId of stores) {
    const idx = storeIdToIndex(storeId);
    let reports;
    try {
      reports = await listSettlementReports(storeId, { createdSince });
    } catch (e) {
      res.errors.push(`amazon ${storeId} list: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const seen = new Set<string>();
    for (const rep of reports) {
      if (seen.has(rep.reportDocumentId)) continue;
      seen.add(rep.reportDocumentId);
      if (pulled.has(rep.reportDocumentId)) continue; // already processed — skip download
      try {
        const url = await getReportDocumentUrl(storeId, rep.reportDocumentId);
        const tsv = await downloadReport(url);
        const settlements = parseAmazonSettlement(tsv);
        for (const s of settlements) {
          if (!s.settlementId) continue;
          const externalId = `amazon:${storeId}:${s.settlementId}`;
          const status = await upsertPayoutWithLines({
            marketplace: "amazon", externalId, storeIndex: idx,
            entity: AMAZON_STORE_ENTITY[idx] ?? storeId,
            periodStart: s.periodStart, periodEnd: s.periodEnd, depositDate: s.depositDate,
            netAmount: s.netAmount, source: "settlement", lines: s.lines,
          });
          res[status]++;
          res.periods.push({ externalId, net: s.netAmount, period: s.periodEnd ?? s.depositDate });
        }
        pulled.add(rep.reportDocumentId);
      } catch (e) {
        res.errors.push(`amazon ${rep.reportDocumentId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await writePulledReports(pulled);
  return res;
}

/** Walmart: pull NEW recon report dates (live API) → Payout + bucketed lines. */
export async function ingestWalmartPayouts(): Promise<IngestResult> {
  const res: IngestResult = { marketplace: "walmart", created: 0, updated: 0, periods: [], errors: [] };
  if (!getWalmartStoreStatus(1).configured) {
    res.errors.push("walmart store1 not configured");
    return res;
  }
  const api = new WalmartReportsApi(getWalmartClient(1));
  let dates: string[];
  try {
    dates = await api.getAvailableReconReportDates();
  } catch (e) {
    res.errors.push(`walmart dates: ${e instanceof Error ? e.message : e}`);
    return res;
  }

  // Skip dates we already have as a Payout.
  const existing = await prisma.payout.findMany({
    where: { marketplace: "walmart" }, select: { externalId: true },
  });
  const have = new Set(existing.map((p) => p.externalId));

  for (const date of dates) {
    const externalId = `walmart:recon:${date}`;
    if (have.has(externalId)) continue;
    try {
      const rows = await api.getFullReconReport(date);
      if (!rows.length) continue;
      const buckets = new Map<Bucket, { amount: number; count: number }>();
      let net = 0;
      for (const r of rows) {
        net += r.amount ?? 0;
        const b = bucketWalmartRow(r.transactionType, r.feeType, r.transactionDescription);
        const cur = buckets.get(b) ?? { amount: 0, count: 0 };
        cur.amount += r.amount ?? 0;
        cur.count += 1;
        buckets.set(b, cur);
      }
      const lines = [...buckets.entries()].map(([bucket, v]) => ({ bucket, amount: v.amount, count: v.count }));
      const status = await upsertPayoutWithLines({
        marketplace: "walmart", externalId, storeIndex: 1, entity: WALMART_ENTITY,
        periodStart: date, periodEnd: date, depositDate: date,
        netAmount: net, source: "recon", lines,
      });
      res[status]++;
      res.periods.push({ externalId, net: round2(net), period: date });
    } catch (e) {
      res.errors.push(`walmart ${date}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return res;
}

export async function ingestAllPayouts(daysBack = 120): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  try { out.push(await ingestWalmartPayouts()); }
  catch (e) { out.push({ marketplace: "walmart", created: 0, updated: 0, periods: [], errors: [String(e)] }); }
  try { out.push(await ingestAmazonPayouts(daysBack)); }
  catch (e) { out.push({ marketplace: "amazon", created: 0, updated: 0, periods: [], errors: [String(e)] }); }
  return out;
}
