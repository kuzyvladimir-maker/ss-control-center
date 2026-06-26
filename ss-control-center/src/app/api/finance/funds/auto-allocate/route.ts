// Auto-set FP1 fund distribution % from each fund's monthly OBLIGATION.
//
// Idea: you don't guess a % per fund — you derive it. Each FP1 fund's monthly
// need = sum of its expense items (Salaries $5,512, Warehouse $2,003, …). Set each
// fund's allocation % = its share of the TOTAL FP1 need. The post-reserve payout
// then fills funds in proportion to what they actually owe. If income ≥ needs,
// every fund covers its bills; if not, they underfill proportionally (deficit →
// unpaid red bills). Reserve % (restock) is separate and set on the FP page.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { monthlyAmount, installmentMonthly } from "@/lib/finance/expenses";
import { scopeOf } from "@/lib/finance/scope";
import { minPayment } from "@/lib/finance/cards";
import { CREDIT_CARDS_FUND } from "@/lib/finance/personal";

export async function POST(req: NextRequest) {
  try {
    const scope = scopeOf(req);
    const funds = await prisma.fund.findMany({ where: { group: "FP1", active: true, scope } });
    const expenses = await prisma.recurringExpense.findMany({ where: { active: true, scope } });

    // Monthly need per category (= fund name): recurring expenses + installment debts.
    const need = new Map<string, number>();
    for (const e of expenses) need.set(e.category, (need.get(e.category) ?? 0) + monthlyAmount(e.amount, e.frequency));
    const fundName = new Map(funds.map((f) => [f.id, f.name]));
    const debts = await prisma.debt.findMany({ where: { status: "open", scope } });
    for (const d of debts) {
      if (!d.monthlyPayment) continue;
      const name = fundName.get(d.fundId);
      if (name) need.set(name, (need.get(name) ?? 0) + installmentMonthly(d.monthlyPayment, d.paymentFrequency));
    }

    // Personal: credit-card minimums make up the "Credit Cards" fund's monthly need.
    if (scope === "personal") {
      const cards = await prisma.creditCard.findMany({ where: { active: true, scope } });
      const totalMin = cards.reduce((s, c) => s + minPayment(c), 0);
      if (totalMin > 0) need.set(CREDIT_CARDS_FUND, (need.get(CREDIT_CARDS_FUND) ?? 0) + totalMin);
    }

    const totalNeed = funds.reduce((s, f) => s + (need.get(f.name) ?? 0), 0);
    const result: { fund: string; monthlyNeed: number; pct: number }[] = [];
    for (const f of funds) {
      const m = Math.round((need.get(f.name) ?? 0) * 100) / 100;
      const pct = totalNeed > 0 ? Math.round((m / totalNeed) * 1000) / 10 : 0; // 0.1% precision
      await prisma.fund.update({ where: { id: f.id }, data: { allocationType: "percent", value: pct } });
      result.push({ fund: f.name, monthlyNeed: m, pct });
    }
    return NextResponse.json({ ok: true, totalMonthlyNeed: Math.round(totalNeed * 100) / 100, allocations: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
