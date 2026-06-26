// Personal payment calendar — every upcoming due date (cards + bills + loans) in one
// timeline, so nothing is missed. GET ?window=45 → entries sorted by date.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildCalendar, type CalItem } from "@/lib/finance/calendar";
import { minPayment } from "@/lib/finance/cards";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const windowDays = Math.min(120, Math.max(7, Number(req.nextUrl.searchParams.get("window") ?? "45") || 45));
  const today = new Date().toISOString().slice(0, 10);

  const [cards, bills, loans] = await Promise.all([
    prisma.creditCard.findMany({ where: { scope: "personal", active: true } }),
    prisma.recurringExpense.findMany({ where: { scope: "personal", active: true } }),
    prisma.debt.findMany({ where: { scope: "personal", status: "open" } }),
  ]);

  const items: CalItem[] = [];
  for (const c of cards) items.push({ kind: "card", label: c.name || c.issuer, owner: c.owner, amount: minPayment(c), dueDay: c.dueDay, refId: c.id });
  for (const e of bills) items.push({ kind: "bill", label: e.name, owner: e.owner, amount: e.amount, dueDay: e.dueDay, refId: e.id });
  for (const d of loans) items.push({ kind: "loan", label: d.description || "Loan", owner: d.owner, amount: d.monthlyPayment ?? 0, dueDay: d.dueDay, refId: d.id });

  const entries = buildCalendar(items, today, windowDays);
  const totalDue = round2(entries.reduce((s, e) => s + e.amount, 0));
  return NextResponse.json({ entries, today, windowDays, totalDue, count: entries.length });
}
