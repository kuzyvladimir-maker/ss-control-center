// Per-fund "Needed" for the distribution = the fund's OWED counter right now:
// the sum of its expenses' accrued debt + its installment debts' accrued debt.
// The meter ticks here (accrual is idempotent by date), so opening the plan always
// shows the current owed amount — carried forward from prior unpaid plans, never a
// fresh "since last click" number. Taxes/Reserve are %-of-payout (computed on the
// page); the Expansion/Debt fund has no accrual → 0.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  // Read-only: the meters are advanced once a day by /api/cron/finance-accrual.
  // We do NOT tick on every page load — that wrote dozens of rows per view and
  // throttled Turso. Here we just read the stored accrued/paid.
  const fundOf = new Map((await prisma.fund.findMany({ select: { id: true, name: true } })).map((f) => [f.id, f.name]));
  const needs: Record<string, number> = {};

  // Recurring expenses: owed (остаток) = accrued − paid, grouped by category (= fund).
  const expenses = await prisma.recurringExpense.findMany({ where: { active: true } });
  for (const e of expenses) needs[e.category] = round2((needs[e.category] ?? 0) + Math.max(0, (e.accrued ?? 0) - (e.paid ?? 0)));

  // Installment debts: owed = accrued, grouped by their fund.
  const debts = await prisma.debt.findMany({ where: { status: "open" } });
  for (const d of debts) {
    const name = fundOf.get(d.fundId);
    if (name && (d.accrued ?? 0) > 0) needs[name] = round2((needs[name] ?? 0) + (d.accrued ?? 0));
  }

  return NextResponse.json({ needs, today });
}
