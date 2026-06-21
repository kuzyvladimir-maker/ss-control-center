// Company debts tracked inside the Debt-repayment fund.
//   GET  ?fundId=                              → debts + totals
//   POST { action:"add", fundId, amount, description, dateIncurred }
//   POST { action:"pay", debtId, amount }      → debit the fund + reduce the debt
//   PATCH { id, amount?, description?, dateIncurred? }
//   DELETE ?id=

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { installmentMonthly } from "@/lib/finance/expenses";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const fundId = req.nextUrl.searchParams.get("fundId");
  // Read-only: installment meters advance once a day via /api/cron/finance-accrual.
  const debts = await prisma.debt.findMany({
    where: fundId ? { fundId } : {},
    orderBy: [{ status: "asc" }, { dateIncurred: "asc" }],
  });
  const totalOriginal = round2(debts.reduce((s, d) => s + d.amount, 0));
  const totalRemaining = round2(debts.reduce((s, d) => s + Math.max(0, d.amount - d.paid), 0));
  // Sum of monthly installments still owed (capped at remaining) — the monthly need.
  const monthlyDue = round2(debts.reduce((s, d) => {
    const rem = Math.max(0, d.amount - d.paid);
    if (!d.monthlyPayment) return s;
    return s + Math.min(installmentMonthly(d.monthlyPayment, d.paymentFrequency), rem);
  }, 0));
  // Owed right now = the daily-ticking accrued debt across installments (drives Needed).
  const owedNow = round2(debts.reduce((s, d) => s + (d.accrued ?? 0), 0));
  return NextResponse.json({ debts, totalOriginal, totalRemaining, monthlyDue, owedNow });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();

    if (b.action === "add") {
      const amount = Math.abs(Number(b.amount));
      if (!b.fundId || !Number.isFinite(amount) || amount === 0) return NextResponse.json({ error: "fundId + amount required" }, { status: 400 });
      const debt = await prisma.debt.create({
        data: { fundId: b.fundId, amount: round2(amount), description: b.description ?? null, dateIncurred: b.dateIncurred ?? null, monthlyPayment: b.monthlyPayment != null && Number(b.monthlyPayment) > 0 ? round2(Number(b.monthlyPayment)) : null, paymentFrequency: b.paymentFrequency ?? (b.monthlyPayment ? "monthly" : null) },
      });
      return NextResponse.json({ ok: true, debt });
    }

    if (b.action === "pay") {
      const debt = await prisma.debt.findUnique({ where: { id: b.debtId } });
      if (!debt) return NextResponse.json({ error: "debt not found" }, { status: 404 });
      const remaining = round2(debt.amount - debt.paid);
      const amount = Math.min(Math.abs(Number(b.amount)) || remaining, remaining);
      if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "nothing to pay" }, { status: 400 });
      const paid = round2(debt.paid + amount);
      // Paying an installment also draws down its owed counter (the Needed meter).
      const accrued = Math.max(0, round2((debt.accrued ?? 0) - amount));
      // Atomic: ledger debit + fund balance + debt paid/accrued/status all-or-nothing.
      const [entry] = await prisma.$transaction([
        prisma.fundEntry.create({ data: { fundId: debt.fundId, type: "spend", amount: -round2(amount), description: `Debt payment: ${debt.description ?? "debt"}`, status: "applied" } }),
        prisma.fund.update({ where: { id: debt.fundId }, data: { balance: { decrement: round2(amount) } } }),
        prisma.debt.update({ where: { id: debt.id }, data: { paid, accrued, status: paid >= debt.amount - 0.005 ? "settled" : "open" } }),
      ]);
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
    if (b.monthlyPayment !== undefined) data.monthlyPayment = b.monthlyPayment === null || b.monthlyPayment === "" ? null : round2(Number(b.monthlyPayment));
    if (b.paymentFrequency !== undefined) data.paymentFrequency = b.paymentFrequency || null;
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
