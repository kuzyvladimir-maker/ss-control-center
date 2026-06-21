// Per-fund "needed" amount for the distribution hints: how much each fund needs
// to cover its accrued (ticked) expenses. Accrues the meter to today first, then
// sums each category's accrued. Funds without expense items (Debt/Reserve/Free/
// Taxes-until-defined) return 0.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { accrueCategory } from "@/lib/finance/accrual";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  try { await accrueCategory(null, today); } catch { /* never break */ }

  const expenses = await prisma.recurringExpense.findMany({ where: { active: true } });
  const needs: Record<string, number> = {};
  for (const e of expenses) needs[e.category] = round2((needs[e.category] ?? 0) + (e.accrued ?? 0));

  // Installment debts add their monthly payment (capped at remaining) to their fund.
  const funds = await prisma.fund.findMany({ select: { id: true, name: true } });
  const fundName = new Map(funds.map((f) => [f.id, f.name]));
  const debts = await prisma.debt.findMany({ where: { status: "open" } });
  for (const d of debts) {
    if (!d.monthlyPayment) continue;
    const due = Math.min(d.monthlyPayment, Math.max(0, d.amount - d.paid));
    const name = fundName.get(d.fundId);
    if (name && due > 0) needs[name] = round2((needs[name] ?? 0) + due);
  }

  return NextResponse.json({ needs, today });
}
