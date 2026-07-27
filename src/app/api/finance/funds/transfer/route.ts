// Move money between two funds. Records BOTH legs in the ledger (debit the source,
// credit the target) and updates both balances — atomically.
//   POST { fromFundId, toFundId, amount, note? }

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const amount = round2(Math.abs(Number(b.amount)));
    if (!b.fromFundId || !b.toFundId) return NextResponse.json({ error: "from + to fund required" }, { status: 400 });
    if (b.fromFundId === b.toFundId) return NextResponse.json({ error: "pick two different funds" }, { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount required" }, { status: 400 });

    const [from, to] = await Promise.all([
      prisma.fund.findUnique({ where: { id: b.fromFundId } }),
      prisma.fund.findUnique({ where: { id: b.toFundId } }),
    ]);
    if (!from || !to) return NextResponse.json({ error: "fund not found" }, { status: 404 });

    const note = b.note ? ` — ${String(b.note)}` : "";
    await prisma.$transaction([
      prisma.fundEntry.create({ data: { fundId: from.id, type: "transfer", amount: -amount, description: `Transfer to ${to.name}${note}`, status: "applied" } }),
      prisma.fund.update({ where: { id: from.id }, data: { balance: { decrement: amount } } }),
      prisma.fundEntry.create({ data: { fundId: to.id, type: "transfer", amount, description: `Transfer from ${from.name}${note}`, status: "applied" } }),
      prisma.fund.update({ where: { id: to.id }, data: { balance: { increment: amount } } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
