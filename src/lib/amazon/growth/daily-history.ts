/**
 * Amazon Growth — per-ASIN daily funnel history (experiment engine, Phase 0).
 *
 * Each day = one 1-day Sales & Traffic report (the report aggregates per-ASIN over
 * the requested window, so a 1-day window gives that day's per-ASIN numbers). We
 * upsert into AmazonAsinDaily. Going forward a cron ingests the latest settled day;
 * backfillDays fills a historical range once (resumable — skips days already stored).
 *
 * Amazon's funnel data settles ~2 days late, so the "latest settled day" is now-2d.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { runSalesTrafficWindow } from "./reports";

const DAY_MS = 864e5;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** UTC midnight for a given Date. */
function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The most recent day whose data has settled (Amazon lags ~2 days). */
export function latestSettledDay(): Date {
  return dayStart(new Date(Date.now() - 2 * DAY_MS));
}

/** Ingest ONE day for one store. Returns rows written (0 if the report was empty). */
export async function ingestDay(prisma: PrismaClient, storeIndex: number, day: Date): Promise<number> {
  const start = dayStart(day);
  const startISO = start.toISOString();
  const endISO = new Date(start.getTime() + DAY_MS - 1000).toISOString();

  const rows = await runSalesTrafficWindow(storeIndex, startISO, endISO);
  let written = 0;
  for (const r of rows) {
    await prisma.amazonAsinDaily.upsert({
      where: { amazon_asin_daily_dedup: { storeIndex, asin: r.asin, date: start } },
      create: {
        storeIndex, asin: r.asin, date: start,
        sessions: r.sessions, pageViews: r.pageViews, unitsOrdered: r.units,
        totalOrderItems: r.totalOrderItems, orderedProductSales: r.revenue,
        featuredOfferPct: r.featuredOfferPct, unitSessionPct: r.unitSessionPct, avgSellingPrice: r.avgSellingPrice,
      },
      update: {
        sessions: r.sessions, pageViews: r.pageViews, unitsOrdered: r.units,
        totalOrderItems: r.totalOrderItems, orderedProductSales: r.revenue,
        featuredOfferPct: r.featuredOfferPct, unitSessionPct: r.unitSessionPct, avgSellingPrice: r.avgSellingPrice,
        syncedAt: new Date(),
      },
    });
    written++;
  }
  return written;
}

/** True if we already have rows for that store+day (so backfill can skip it). */
export async function hasDay(prisma: PrismaClient, storeIndex: number, day: Date): Promise<boolean> {
  const n = await prisma.amazonAsinDaily.count({ where: { storeIndex, date: dayStart(day) } });
  return n > 0;
}

export interface BackfillResult { days: number; ingested: number; skipped: number; rows: number; errors: number }

/** Backfill a [from,to] day range for one store, newest→oldest. Resumable: skips
 *  days already stored. Bounded by maxDays so a single invocation stays sane. */
export async function backfillDays(
  prisma: PrismaClient,
  storeIndex: number,
  fromDay: Date,
  toDay: Date,
  opts: { maxDays?: number; betweenMs?: number; onProgress?: (msg: string) => void } = {},
): Promise<BackfillResult> {
  const maxDays = opts.maxDays ?? 120;
  const betweenMs = opts.betweenMs ?? 1500;
  const start = dayStart(fromDay).getTime();
  const end = dayStart(toDay).getTime();

  const res: BackfillResult = { days: 0, ingested: 0, skipped: 0, rows: 0, errors: 0 };
  for (let t = end; t >= start && res.days < maxDays; t -= DAY_MS) {
    const day = new Date(t);
    res.days++;
    if (await hasDay(prisma, storeIndex, day)) { res.skipped++; continue; }
    try {
      const written = await ingestDay(prisma, storeIndex, day);
      res.ingested++;
      res.rows += written;
      opts.onProgress?.(`${day.toISOString().slice(0, 10)}: ${written} rows`);
    } catch (e) {
      res.errors++;
      opts.onProgress?.(`${day.toISOString().slice(0, 10)}: ERROR ${(e as Error).message}`);
    }
    await sleep(betweenMs);
  }
  return res;
}
