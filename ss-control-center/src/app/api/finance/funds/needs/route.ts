// Per-fund "needed" hint for the distribution: how much each fund needs to cover
// its costs FOR THE PERIOD since the last Financial Plan. We don't depend on the
// (still-incremental) accrual meter here — we compute the period need directly:
//   need = monthly obligation × (days since last FP / 30.44)
// Monthly obligation = sum of the fund's recurring expenses + installment debts.
// Funds without obligations (Reserve/Free/Debt-lump) return 0 (Taxes is computed
// on the page from the payout). This always shows a meaningful, period-sized hint.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { monthlyAmount, installmentMonthly } from "@/lib/finance/expenses";
import { daysBetween } from "@/lib/finance/accrual";

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAYS_PER_MONTH = 30.44;
const DEFAULT_PERIOD_DAYS = 7; // assume a weekly plan until there's an FP history

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const lastFp = await prisma.financePlanRun.findFirst({ orderBy: { runDate: "desc" } });
  const periodDays = lastFp?.runDate ? Math.max(1, daysBetween(lastFp.runDate, today)) : DEFAULT_PERIOD_DAYS;
  const factor = periodDays / DAYS_PER_MONTH;

  const expenses = await prisma.recurringExpense.findMany({ where: { active: true } });
  const monthly: Record<string, number> = {};
  for (const e of expenses) monthly[e.category] = (monthly[e.category] ?? 0) + monthlyAmount(e.amount, e.frequency);

  // Installment debts → their fund's monthly obligation.
  const funds = await prisma.fund.findMany({ select: { id: true, name: true } });
  const fundName = new Map(funds.map((f) => [f.id, f.name]));
  const debts = await prisma.debt.findMany({ where: { status: "open" } });
  for (const d of debts) {
    if (!d.monthlyPayment) continue;
    const name = fundName.get(d.fundId);
    if (name) monthly[name] = (monthly[name] ?? 0) + installmentMonthly(d.monthlyPayment, d.paymentFrequency);
  }

  // Scale the monthly obligation to the period since the last FP.
  const needs: Record<string, number> = {};
  for (const [name, m] of Object.entries(monthly)) needs[name] = round2(m * factor);

  return NextResponse.json({ needs, periodDays, today });
}
