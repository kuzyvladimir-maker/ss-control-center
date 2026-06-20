// Payout pool. GET recent payouts + totals; POST ?ingest=1 pulls new payouts
// (Walmart from recon in-DB; Amazon from settlement reports, live SP-API).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ingestAllPayouts } from "@/lib/finance/payouts";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const onlyUndistributed = req.nextUrl.searchParams.get("undistributed") === "1";
  const payouts = await prisma.payout.findMany({
    where: onlyUndistributed ? { distributed: false } : {},
    orderBy: { depositDate: "desc" },
    take: 200,
  });
  const undistributed = payouts.filter((p) => !p.distributed);
  return NextResponse.json({
    payouts,
    totals: {
      count: payouts.length,
      undistributedCount: undistributed.length,
      undistributedNet: Math.round(undistributed.reduce((s, p) => s + p.netAmount, 0) * 100) / 100,
    },
  });
}

export async function POST(req: NextRequest) {
  // Auto-ingest (Walmart recon + Amazon settlement).
  if (req.nextUrl.searchParams.get("ingest") === "1") {
    const daysBack = Number(req.nextUrl.searchParams.get("daysBack") ?? "90") || 90;
    try {
      const results = await ingestAllPayouts(daysBack);
      return NextResponse.json({ ok: true, results });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // Manual payout entry — guarantees the engine is usable before auto-ingest data
  // exists (e.g. Walmart recon not yet synced).
  try {
    const b = await req.json();
    const net = Number(b.netAmount);
    if (!Number.isFinite(net) || net === 0) {
      return NextResponse.json({ error: "netAmount required" }, { status: 400 });
    }
    const marketplace = b.marketplace === "walmart" ? "walmart" : b.marketplace === "amazon" ? "amazon" : "manual";
    const depositDate = b.depositDate || new Date().toISOString().slice(0, 10);
    const externalId = `manual:${depositDate}:${Math.round(net * 100)}:${b.note ?? ""}`.slice(0, 120);
    const payout = await prisma.payout.upsert({
      where: { payout_dedup: { marketplace, externalId } },
      create: {
        marketplace, externalId, netAmount: Math.round(net * 100) / 100,
        depositDate, entity: b.entity ?? null, storeIndex: b.storeIndex ?? null, source: "manual",
      },
      update: { netAmount: Math.round(net * 100) / 100 },
    });
    return NextResponse.json({ ok: true, payout });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
