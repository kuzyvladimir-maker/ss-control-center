/**
 * Amazon Growth — daily history + recovery API (experiment engine, Phase 0).
 *
 * GET ?storeIndex                  → coverage stats + lost-winner candidates + snapshot count
 * GET ?storeIndex&asin=XXX         → that ASIN's daily funnel series (trend)
 * POST { action }                  → ingestLatest | snapshot | backfill (operator-triggered)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ingestDay, backfillDays, latestSettledDay } from "@/lib/amazon/growth/daily-history";
import { snapshotOwnBrand } from "@/lib/amazon/growth/snapshots";
import { detectLostWinners } from "@/lib/amazon/growth/lost-winners";

export const maxDuration = 300;

const DAY_MS = 864e5;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const asin = sp.get("asin");

  // Per-ASIN trend.
  if (asin) {
    const rows = await prisma.amazonAsinDaily.findMany({
      where: { storeIndex, asin },
      orderBy: { date: "asc" },
      select: { date: true, sessions: true, unitsOrdered: true, orderedProductSales: true, unitSessionPct: true, featuredOfferPct: true },
    });
    return NextResponse.json({ asin, series: rows });
  }

  const [rowCount, distinctDays, distinctAsins, range, snapCount, lastSnap, lostWinners] = await Promise.all([
    prisma.amazonAsinDaily.count({ where: { storeIndex } }),
    prisma.amazonAsinDaily.findMany({ where: { storeIndex }, distinct: ["date"], select: { date: true } }),
    prisma.amazonAsinDaily.findMany({ where: { storeIndex }, distinct: ["asin"], select: { asin: true } }),
    prisma.amazonAsinDaily.aggregate({ where: { storeIndex }, _min: { date: true }, _max: { date: true } }),
    prisma.amazonListingSnapshot.count({ where: { storeIndex } }),
    prisma.amazonListingSnapshot.findFirst({ where: { storeIndex }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true } }),
    detectLostWinners(prisma, storeIndex).catch(() => []),
  ]);

  return NextResponse.json({
    storeIndex,
    coverage: {
      rows: rowCount,
      days: distinctDays.length,
      asins: distinctAsins.length,
      firstDate: range._min.date,
      lastDate: range._max.date,
    },
    snapshots: { count: snapCount, lastAt: lastSnap?.capturedAt ?? null },
    lostWinners,
  });
}

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let action = "";
  let days = 90;
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    action = String(body?.action ?? "");
    if (body?.days) days = Math.min(Number(body.days), 120);
  } catch {
    /* */
  }

  try {
    if (action === "ingestLatest") {
      const written = await ingestDay(prisma, storeIndex, latestSettledDay());
      return NextResponse.json({ ok: true, action, written });
    }
    if (action === "snapshot") {
      const res = await snapshotOwnBrand(prisma, storeIndex, { max: 60 });
      return NextResponse.json({ ok: true, action, ...res });
    }
    if (action === "backfill") {
      const to = latestSettledDay();
      const from = new Date(to.getTime() - days * DAY_MS);
      // Bounded per call so the function never times out; call repeatedly to finish.
      const res = await backfillDays(prisma, storeIndex, from, to, { maxDays: 6 });
      return NextResponse.json({ ok: true, action, ...res });
    }
    return NextResponse.json({ ok: false, error: `unknown action ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
