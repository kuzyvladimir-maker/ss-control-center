// Personal income = the personal pool's "money in" (Payout, scope=personal).
//   GET                                   → recent income + totals
//   POST { action:"manual", amount, note? }            → record income
//   POST { action:"draw", fromFundId, amount, note? }  → OWNER DRAW bridge:
//        debit a business fund AND record the same amount as personal income, in one go.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
  const incomes = await prisma.payout.findMany({
    where: { scope: "personal" },
    orderBy: { depositDate: "desc" },
    take: 100,
  });
  const undistributed = incomes.filter((p) => !p.distributed);
  return NextResponse.json({
    incomes,
    totals: {
      count: incomes.length,
      undistributedCount: undistributed.length,
      undistributedNet: round2(undistributed.reduce((s, p) => s + p.netAmount, 0)),
      totalNet: round2(incomes.reduce((s, p) => s + p.netAmount, 0)),
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const amount = round2(Math.abs(Number(b.amount)));
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount required" }, { status: 400 });
    const depositDate = b.depositDate || new Date().toISOString().slice(0, 10);
    const note: string = b.note ?? "";

    // Owner-draw bridge: take money out of a BUSINESS fund and book it as personal income.
    let drawEntry = null;
    let source = "manual";
    if (b.action === "draw") {
      if (!b.fromFundId) return NextResponse.json({ error: "fromFundId required for a draw" }, { status: 400 });
      const fund = await prisma.fund.findUnique({ where: { id: b.fromFundId } });
      if (!fund || fund.scope !== "business") return NextResponse.json({ error: "not a business fund" }, { status: 400 });
      drawEntry = await prisma.fundEntry.create({
        data: { fundId: fund.id, type: "spend", amount: -amount, description: `Owner draw → personal${note ? `: ${note}` : ""}`, status: "applied" },
      });
      await prisma.fund.update({ where: { id: fund.id }, data: { balance: { decrement: amount } } });
      source = "owner_draw";
    }

    const externalId = `${source}:${Date.now()}:${Math.round(amount * 100)}`.slice(0, 120);
    const payout = await prisma.payout.create({
      data: { scope: "personal", marketplace: "personal", externalId, netAmount: amount, depositDate, source, entity: b.entity ?? null },
    });
    return NextResponse.json({ ok: true, payout, drawEntry });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
