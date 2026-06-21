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

  return NextResponse.json({ needs, today });
}
