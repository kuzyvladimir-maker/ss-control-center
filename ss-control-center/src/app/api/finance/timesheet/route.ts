// Timesheet (табель) for salary employees (= Salaries-category expense items).
//   GET ?month=YYYY-MM            → employees + their worked dates + per-day rate
//   POST { action:"toggle", expenseId, date }   → toggle a worked day
//   POST { action:"create_bills", month }        → worked days × per-day rate → bills in Salaries fund

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { perDayRate } from "@/lib/finance/expenses";

const round2 = (n: number) => Math.round(n * 100) / 100;
const SALARY_CATEGORY = "Salaries";

async function employees() {
  return prisma.recurringExpense.findMany({ where: { category: SALARY_CATEGORY, active: true }, orderBy: { name: "asc" } });
}

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") || new Date().toISOString().slice(0, 7); // YYYY-MM
  const emps = await employees();
  const logs = await prisma.timeLog.findMany({ where: { expenseId: { in: emps.map((e) => e.id) }, date: { startsWith: month } } });
  const byEmp = new Map<string, string[]>();
  for (const l of logs) { const a = byEmp.get(l.expenseId) ?? []; a.push(l.date); byEmp.set(l.expenseId, a); }

  const rows = emps.map((e) => {
    const dates = (byEmp.get(e.id) ?? []).sort();
    const rate = perDayRate(e.amount, e.frequency);
    return { id: e.id, name: e.name, amount: e.amount, frequency: e.frequency, perDay: rate, workedDates: dates, days: dates.length, pay: round2(dates.length * rate) };
  });
  return NextResponse.json({ month, employees: rows });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();

    if (b.action === "toggle") {
      if (!b.expenseId || !b.date) return NextResponse.json({ error: "expenseId + date required" }, { status: 400 });
      const existing = await prisma.timeLog.findUnique({ where: { timelog_dedup: { expenseId: b.expenseId, date: b.date } } });
      if (existing) { await prisma.timeLog.delete({ where: { id: existing.id } }); return NextResponse.json({ ok: true, worked: false }); }
      await prisma.timeLog.create({ data: { expenseId: b.expenseId, date: b.date } });
      return NextResponse.json({ ok: true, worked: true });
    }

    if (b.action === "create_bills") {
      const month = String(b.month || new Date().toISOString().slice(0, 7));
      const fund = await prisma.fund.findFirst({ where: { name: SALARY_CATEGORY, group: "FP1" } });
      if (!fund) return NextResponse.json({ error: "Salaries fund not found" }, { status: 404 });
      const emps = await employees();
      const logs = await prisma.timeLog.findMany({ where: { expenseId: { in: emps.map((e) => e.id) }, date: { startsWith: month } } });
      const days = new Map<string, number>();
      for (const l of logs) days.set(l.expenseId, (days.get(l.expenseId) ?? 0) + 1);

      const existingBills = await prisma.fundEntry.findMany({ where: { fundId: fund.id, type: "planned_expense", status: "planned" } });
      const have = new Set(existingBills.map((e) => e.description));

      let created = 0;
      const result: { name: string; days: number; pay: number }[] = [];
      for (const e of emps) {
        const d = days.get(e.id) ?? 0;
        const pay = round2(d * perDayRate(e.amount, e.frequency));
        if (pay <= 0) continue;
        const description = `${e.name} — ${d}d (${month})`;
        result.push({ name: e.name, days: d, pay });
        if (have.has(description)) continue;
        await prisma.fundEntry.create({ data: { fundId: fund.id, type: "planned_expense", amount: -pay, description, status: "planned" } });
        created++;
      }
      return NextResponse.json({ ok: true, created, fundId: fund.id, result });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
