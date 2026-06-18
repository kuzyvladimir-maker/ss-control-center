/**
 * Amazon Growth — lost-winner detector (experiment engine, Phase 0).
 *
 * Compares a HISTORICAL window vs a RECENT window of per-ASIN daily sales
 * (AmazonAsinDaily) to surface listings that used to sell and now don't — gone,
 * suppressed, or sharply declined. These are recovery candidates: we know WHICH
 * to restore from sales history; the content to restore with comes from snapshots
 * / Catalog API (a later step), else rebuild.
 *
 * Brand scope: we can only confirm own-brand for ASINs still in our mirror; ASINs
 * fully absent are flagged needsBrandCheck (resolve via Catalog API later).
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { isOwnBrand } from "./snapshots";
import { getCatalogContent } from "./catalog";

const DAY_MS = 864e5;

export interface LostWinner {
  asin: string;
  itemName: string | null;
  historicalUnitsPerDay: number;
  historicalRevenue: number;
  recentUnitsPerDay: number;
  recentRevenue: number;
  dropPct: number; // 0-100, decline in units/day historical→recent
  inMirror: boolean;
  isBuyable: boolean;
  isSuppressed: boolean;
  ownBrand: boolean;
  needsBrandCheck: boolean;
}

interface Agg { units: number; revenue: number; days: number }

async function aggregate(prisma: PrismaClient, storeIndex: number, from: Date, to: Date): Promise<Map<string, Agg>> {
  const grouped = await prisma.amazonAsinDaily.groupBy({
    by: ["asin"],
    where: { storeIndex, date: { gte: from, lte: to } },
    _sum: { unitsOrdered: true, orderedProductSales: true },
    _count: { _all: true },
  });
  const m = new Map<string, Agg>();
  for (const g of grouped) {
    m.set(g.asin, {
      units: g._sum.unitsOrdered ?? 0,
      revenue: g._sum.orderedProductSales ?? 0,
      days: g._count._all,
    });
  }
  return m;
}

export interface LostWinnerOpts {
  recentDays?: number; // recent window length (default 30, ending at latest data)
  historicalAgoDays?: number; // how far back the historical window ends (default 365)
  historicalDays?: number; // historical window length (default 30)
  minHistoricalRevenue?: number; // ignore noise below this (default 40)
  minDropPct?: number; // only surface declines ≥ this (default 60)
  ownBrandOnly?: boolean; // default true — only confirmed own-brand + needs-check
  resolveBrand?: number; // resolve brand via Catalog API for up to N gone candidates, dropping confirmed non-own-brand (default 0 = off)
}

export async function detectLostWinners(
  prisma: PrismaClient,
  storeIndex: number,
  opts: LostWinnerOpts = {},
): Promise<LostWinner[]> {
  const recentDays = opts.recentDays ?? 30;
  const histAgo = opts.historicalAgoDays ?? 365;
  const histLen = opts.historicalDays ?? 30;
  const minRev = opts.minHistoricalRevenue ?? 40;
  const minDrop = opts.minDropPct ?? 60;
  const ownBrandOnly = opts.ownBrandOnly ?? true;

  const now = Date.now();
  const recentFrom = new Date(now - recentDays * DAY_MS);
  const recentTo = new Date(now);
  const histTo = new Date(now - histAgo * DAY_MS);
  const histFrom = new Date(histTo.getTime() - histLen * DAY_MS);

  const [hist, recent] = await Promise.all([
    aggregate(prisma, storeIndex, histFrom, histTo),
    aggregate(prisma, storeIndex, recentFrom, recentTo),
  ]);

  // Current state for the candidate ASINs (in our active mirror?).
  const asins = [...hist.keys()];
  const mirror = await prisma.amazonListingHealthItem.findMany({
    where: { storeIndex, asin: { in: asins } },
    select: { asin: true, itemName: true, isBuyable: true, isSuppressed: true },
  });
  const mirrorByAsin = new Map(mirror.map((m) => [m.asin ?? "", m]));

  const out: LostWinner[] = [];
  for (const [asin, h] of hist) {
    if (h.revenue < minRev) continue;
    const histPerDay = h.days > 0 ? h.units / h.days : 0;
    const r = recent.get(asin);
    const recentPerDay = r && r.days > 0 ? r.units / r.days : 0;
    const dropPct = histPerDay > 0 ? Math.max(0, Math.round((1 - recentPerDay / histPerDay) * 100)) : 0;
    if (dropPct < minDrop) continue;

    const m = mirrorByAsin.get(asin);
    const inMirror = !!m;
    const own = inMirror ? isOwnBrand(null, m!.itemName) : false;
    const needsBrandCheck = !inMirror;
    if (ownBrandOnly && !own && !needsBrandCheck) continue;

    out.push({
      asin,
      itemName: m?.itemName ?? null,
      historicalUnitsPerDay: Math.round(histPerDay * 100) / 100,
      historicalRevenue: Math.round(h.revenue * 100) / 100,
      recentUnitsPerDay: Math.round(recentPerDay * 100) / 100,
      recentRevenue: Math.round((r?.revenue ?? 0) * 100) / 100,
      dropPct,
      inMirror,
      isBuyable: m?.isBuyable ?? false,
      isSuppressed: m?.isSuppressed ?? false,
      ownBrand: own,
      needsBrandCheck,
    });
  }

  out.sort((a, b) => b.historicalRevenue - a.historicalRevenue);

  // Optionally confirm brand for the top gone-from-catalog candidates via the
  // Catalog API, so the own-brand view isn't cluttered with dropped reseller ASINs.
  const resolveN = opts.resolveBrand ?? 0;
  if (ownBrandOnly && resolveN > 0) {
    const toCheck = out.filter((w) => w.needsBrandCheck).slice(0, resolveN);
    const resolved = await Promise.all(
      toCheck.map(async (w) => {
        const cat = await getCatalogContent(storeIndex, w.asin).catch(() => null);
        return { asin: w.asin, brand: cat?.brand ?? null, title: cat?.title ?? null, fetched: !!cat };
      }),
    );
    const byAsin = new Map(resolved.map((r) => [r.asin, r]));
    return out.filter((w) => {
      if (!w.needsBrandCheck) return true;
      const r = byAsin.get(w.asin);
      if (!r || !r.fetched) return true; // couldn't resolve → keep, still flagged
      const own = isOwnBrand(r.brand, r.title);
      if (own) { w.ownBrand = true; w.needsBrandCheck = false; if (!w.itemName) w.itemName = r.title; }
      return own; // drop confirmed non-own-brand
    });
  }

  return out;
}
