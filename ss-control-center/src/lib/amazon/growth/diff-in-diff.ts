/**
 * Amazon Growth — difference-in-differences lift measurement (experiment engine,
 * Phase 1).
 *
 * Honest lift = how the CHANGED listing moved, minus how a matched, UNCHANGED
 * control group moved over the same window. Subtracting the control delta removes
 * market/seasonal/competitive noise — the thing naive "before vs after" can't do,
 * which matters a lot on our low-traffic listings.
 *
 *   lift = (treatment_post − treatment_pre) − (control_post − control_pre)
 *
 * Reads the per-ASIN daily funnel (AmazonAsinDaily). Confidence is gated on having
 * enough days + sessions + control listings; otherwise we say so rather than
 * pretend a noisy number is real.
 */

import type { PrismaClient } from "@/generated/prisma/client";

const DAY_MS = 864e5;

export interface WindowAvg {
  days: number; // daily rows present in the window
  sessionsPerDay: number;
  unitsPerDay: number;
  revenuePerDay: number;
  conversion: number | null; // units / sessions over the window
  sessionsTotal: number;
}

/** Average per-day funnel for one ASIN over [from, to]. */
export async function windowAvg(
  prisma: PrismaClient, storeIndex: number, asin: string, from: Date, to: Date,
): Promise<WindowAvg> {
  const g = await prisma.amazonAsinDaily.aggregate({
    where: { storeIndex, asin, date: { gte: from, lte: to } },
    _sum: { sessions: true, unitsOrdered: true, orderedProductSales: true },
    _count: { _all: true },
  });
  const days = g._count._all;
  const sessions = g._sum.sessions ?? 0;
  const units = g._sum.unitsOrdered ?? 0;
  const revenue = g._sum.orderedProductSales ?? 0;
  return {
    days,
    sessionsPerDay: days > 0 ? sessions / days : 0,
    unitsPerDay: days > 0 ? units / days : 0,
    revenuePerDay: days > 0 ? revenue / days : 0,
    conversion: sessions > 0 ? units / sessions : null,
    sessionsTotal: sessions,
  };
}

/** Average a metric across a set of ASINs (the control group), pre & post. */
async function groupWindowAvg(
  prisma: PrismaClient, storeIndex: number, asins: string[], from: Date, to: Date,
): Promise<WindowAvg> {
  if (asins.length === 0) return { days: 0, sessionsPerDay: 0, unitsPerDay: 0, revenuePerDay: 0, conversion: null, sessionsTotal: 0 };
  const g = await prisma.amazonAsinDaily.aggregate({
    where: { storeIndex, asin: { in: asins }, date: { gte: from, lte: to } },
    _sum: { sessions: true, unitsOrdered: true, orderedProductSales: true },
    _count: { _all: true },
  });
  const rows = g._count._all;
  const sessions = g._sum.sessions ?? 0;
  const units = g._sum.unitsOrdered ?? 0;
  const revenue = g._sum.orderedProductSales ?? 0;
  // Normalize by (rows) which is asin-days, then ×asins gives per-listing-per-day.
  const perListingDays = rows / asins.length;
  return {
    days: Math.round(perListingDays),
    sessionsPerDay: rows > 0 ? sessions / rows : 0,
    unitsPerDay: rows > 0 ? units / rows : 0,
    revenuePerDay: rows > 0 ? revenue / rows : 0,
    conversion: sessions > 0 ? units / sessions : null,
    sessionsTotal: sessions,
  };
}

/** Pick a matched control group: same store, daily data present, NOT changed in
 *  the window, and baseline traffic in a band around the treatment listing. */
export async function pickControlGroup(
  prisma: PrismaClient, storeIndex: number, treatmentAsin: string,
  preFrom: Date, postTo: Date, treatmentBaselineSessions: number, n = 12,
): Promise<string[]> {
  // ASINs changed anywhere in [preFrom, postTo] are disqualified as controls.
  const changed = await prisma.amazonChangeLog.findMany({
    where: { storeIndex, createdAt: { gte: preFrom, lte: postTo }, asin: { not: null } },
    select: { asin: true },
  });
  const changedSet = new Set(changed.map((c) => c.asin!).filter(Boolean));
  changedSet.add(treatmentAsin);

  // Candidates with data in the pre window, baseline within band of treatment.
  const lo = Math.max(1, treatmentBaselineSessions * 0.4);
  const hi = Math.max(3, treatmentBaselineSessions * 2.5);
  const grouped = await prisma.amazonAsinDaily.groupBy({
    by: ["asin"],
    where: { storeIndex, date: { gte: preFrom, lte: postTo } },
    _sum: { sessions: true },
    _count: { _all: true },
  });
  return grouped
    .filter((g) => !changedSet.has(g.asin))
    .map((g) => ({ asin: g.asin, perDay: (g._sum.sessions ?? 0) / Math.max(1, g._count._all) }))
    .filter((x) => x.perDay >= lo && x.perDay <= hi)
    .sort((a, b) => Math.abs(a.perDay - treatmentBaselineSessions) - Math.abs(b.perDay - treatmentBaselineSessions))
    .slice(0, n)
    .map((x) => x.asin);
}

export interface LiftResult {
  asin: string;
  confidence: "insufficient" | "low" | "medium" | "high";
  reason?: string;
  controlN: number;
  pre: { treatment: WindowAvg; control: WindowAvg };
  post: { treatment: WindowAvg; control: WindowAvg };
  liftConversionPp: number | null; // percentage points (DiD), e.g. +2.1pp
  liftRevenuePerDay: number | null; // $ per day (DiD)
}

export interface LiftOpts { burnInDays?: number; preDays?: number; postDays?: number; minDays?: number; minSessions?: number }

/** Diff-in-diff lift for one changed ASIN around a change time. */
export async function measureLift(
  prisma: PrismaClient, storeIndex: number, asin: string, changeAt: Date, opts: LiftOpts = {},
): Promise<LiftResult> {
  const burnIn = opts.burnInDays ?? 3;
  const preDays = opts.preDays ?? 14;
  const postDays = opts.postDays ?? 14;
  const minDays = opts.minDays ?? 5;
  const minSessions = opts.minSessions ?? 30;

  const c = changeAt.getTime();
  const preFrom = new Date(c - preDays * DAY_MS);
  const preTo = new Date(c - 1000);
  const postFrom = new Date(c + burnIn * DAY_MS);
  const postTo = new Date(c + (burnIn + postDays) * DAY_MS);

  const tPre = await windowAvg(prisma, storeIndex, asin, preFrom, preTo);
  const tPost = await windowAvg(prisma, storeIndex, asin, postFrom, postTo);

  const controls = await pickControlGroup(prisma, storeIndex, asin, preFrom, postTo, tPre.sessionsPerDay);
  const cPre = await groupWindowAvg(prisma, storeIndex, controls, preFrom, preTo);
  const cPost = await groupWindowAvg(prisma, storeIndex, controls, postFrom, postTo);

  const base = {
    asin, controlN: controls.length,
    pre: { treatment: tPre, control: cPre },
    post: { treatment: tPost, control: cPost },
  };

  // Gate: enough coverage to say anything honest?
  if (tPre.days < minDays || tPost.days < minDays) {
    return { ...base, confidence: "insufficient", reason: `need ${minDays}d pre+post (have ${tPre.days}/${tPost.days})`, liftConversionPp: null, liftRevenuePerDay: null };
  }
  if (tPre.sessionsTotal + tPost.sessionsTotal < minSessions) {
    return { ...base, confidence: "insufficient", reason: `too little traffic (${tPre.sessionsTotal + tPost.sessionsTotal} sessions)`, liftConversionPp: null, liftRevenuePerDay: null };
  }

  const tConvDelta = (tPost.conversion ?? 0) - (tPre.conversion ?? 0);
  const cConvDelta = controls.length ? (cPost.conversion ?? 0) - (cPre.conversion ?? 0) : 0;
  const liftConversionPp = Math.round((tConvDelta - cConvDelta) * 1000) / 10; // → percentage points

  const tRevDelta = tPost.revenuePerDay - tPre.revenuePerDay;
  const cRevDelta = controls.length ? cPost.revenuePerDay - cPre.revenuePerDay : 0;
  const liftRevenuePerDay = Math.round((tRevDelta - cRevDelta) * 100) / 100;

  const sessions = tPre.sessionsTotal + tPost.sessionsTotal;
  const confidence =
    controls.length < 3 ? "low" : sessions >= 300 ? "high" : sessions >= 120 ? "medium" : "low";

  return { ...base, confidence, liftConversionPp, liftRevenuePerDay };
}
