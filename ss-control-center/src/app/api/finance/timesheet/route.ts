// Timesheet (табель) for salary employees (= Salaries-category expense items).
// Each employee IS one expense item with its own balance: accrued (начислено) grows
// by per-day rate for every worked day toggled on; paid (выплачено) grows when you
// press Paid (via the fund's pay_expense); owed (остаток) = accrued − paid carries
// forward. Salaries are NOT smooth-accrued by the daily meter — only the timesheet
// moves their `accrued`.
//   GET ?month=YYYY-MM            → employees + worked dates (month) + balance
//   POST { action:"toggle", expenseId, date }  → toggle a worked day (±perDay accrued)

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { perDayRate } from "@/lib/finance/expenses";

const round2 = (n: number) => Math.round(n * 100) / 100;
const SALARY_CATEGORY = "Salaries";

async function employees() {
  return prisma.recurringExpense.findMany({ where: { category: SALARY_CATEGORY, active: true, scope: "business" }, orderBy: { name: "asc" } });
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
    const accrued = round2(e.accrued ?? 0); // начислено (all-time worked days × rate)
    const paid = round2(e.paid ?? 0);        // выплачено (all-time)
    return {
      id: e.id, name: e.name, amount: e.amount, frequency: e.frequency, perDay: rate,
      workedDates: dates, days: dates.length, monthPay: round2(dates.length * rate),
      accrued, paid, owed: round2(Math.max(0, accrued - paid)),
    };
  });
  return NextResponse.json({ month, employees: rows });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();

    if (b.action === "toggle") {
      if (!b.expenseId || !b.date) return NextResponse.json({ error: "expenseId + date required" }, { status: 400 });
      const e = await prisma.recurringExpense.findUnique({ where: { id: b.expenseId } });
      if (!e) return NextResponse.json({ error: "employee not found" }, { status: 404 });
      const rate = perDayRate(e.amount, e.frequency);
      const existing = await prisma.timeLog.findUnique({ where: { timelog_dedup: { expenseId: b.expenseId, date: b.date } } });
      if (existing) {
        // Un-mark a worked day → start owing one day less (накопление −perDay).
        await prisma.$transaction([
          prisma.timeLog.delete({ where: { id: existing.id } }),
          prisma.recurringExpense.update({ where: { id: e.id }, data: { accrued: Math.max(0, round2((e.accrued ?? 0) - rate)) } }),
        ]);
        return NextResponse.json({ ok: true, worked: false });
      }
      // Mark a worked day → accrue one more day of salary (начисление +perDay).
      await prisma.$transaction([
        prisma.timeLog.create({ data: { expenseId: b.expenseId, date: b.date } }),
        prisma.recurringExpense.update({ where: { id: e.id }, data: { accrued: round2((e.accrued ?? 0) + rate) } }),
      ]);
      return NextResponse.json({ ok: true, worked: true });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
