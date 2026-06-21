// Company debts tracked inside the Debt-repayment fund.
//   GET  ?fundId=                              → debts + totals
//   POST { action:"add", fundId, amount, description, dateIncurred }
//   POST { action:"pay", debtId, amount }      → debit the fund + reduce the debt
//   PATCH { id, amount?, description?, dateIncurred? }
//   DELETE ?id=

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const fundId = req.nextUrl.searchParams.get("fundId");
  const debts = await prisma.debt.findMany({
    where: fundId ? { fundId } : {},
    orderBy: [{ status: "asc" }, { dateIncurred: "asc" }],
  });
  const totalOriginal = round2(debts.reduce((s, d) => s + d.amount, 0));
  const totalRemaining = round2(debts.reduce((s, d) => s + Math.max(0, d.amount - d.paid), 0));
  return NextResponse.json({ debts, totalOriginal, totalRemaining });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();

    if (b.action === "add") {
      const amount = Math.abs(Number(b.amount));
      if (!b.fundId || !Number.isFinite(amount) || amount === 0) return NextResponse.json({ error: "fundId + amount required" }, { status: 400 });
      const debt = await prisma.debt.create({
        data: { fundId: b.fundId, amount: round2(amount), description: b.description ?? null, dateIncurred: b.dateIncurred ?? null },
      });
      return NextResponse.json({ ok: true, debt });
    }

    if (b.action === "pay") {
      const debt = await prisma.debt.findUnique({ where: { id: b.debtId } });
      if (!debt) return NextResponse.json({ error: "debt not found" }, { status: 404 });
      const remaining = round2(debt.amount - debt.paid);
      const amount = Math.min(Math.abs(Number(b.amount)) || remaining, remaining);
      if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "nothing to pay" }, { status: 400 });
      // Debit the fund.
      const entry = await prisma.fundEntry.create({
        data: { fundId: debt.fundId, type: "spend", amount: -round2(amount), description: `Debt payment: ${debt.description ?? "debt"}`, status: "applied" },
      });
      await prisma.fund.update({ where: { id: debt.fundId }, data: { balance: { decrement: round2(amount) } } });
      const paid = round2(debt.paid + amount);
      await prisma.debt.update({ where: { id: debt.id }, data: { paid, status: paid >= debt.amount - 0.005 ? "settled" : "open" } });
      return NextResponse.json({ ok: true, entry });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const data: Record<string, unknown> = {};
    if (b.amount != null) data.amount = round2(Math.abs(Number(b.amount)));
    if (b.description !== undefined) data.description = b.description;
    if (b.dateIncurred !== undefined) data.dateIncurred = b.dateIncurred;
    const debt = await prisma.debt.update({ where: { id: b.id }, data });
    return NextResponse.json({ ok: true, debt });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.debt.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
