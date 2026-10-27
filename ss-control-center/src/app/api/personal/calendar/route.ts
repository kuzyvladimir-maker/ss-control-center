// Personal payment calendar — every upcoming due date (cards + bills + loans + dated
// events) in one timeline, so nothing is missed. GET ?window=60 → entries sorted by date,
// plus what is ALREADY late (`overdue`) and payments with no fixed date (`undated`).
//
// Debts come from both pools (a business-plan debt is still the owner's payment).
// A card/debt with a known next due date skips earlier occurrences; a dated
// payment event replaces that day's minimum (BJ's full statement).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildCalendar, type CalItem } from "@/lib/finance/calendar";
import { knownMinPayment } from "@/lib/finance/cards";
import { cardLabel } from "@/lib/finance/registry";

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;

interface Overdue { refId: string; kind: "card" | "loan" | "event"; label: string; owner: string | null; amount: number | null; since: string | null; reason: string }
interface Undated { refId: string; label: string; owner: string | null; amount: number; frequency: string; note: string | null }

export async function GET(req: NextRequest) {
  const windowDays = Math.min(120, Math.max(7, Number(req.nextUrl.searchParams.get("window") ?? "60") || 60));
  const today = new Date().toISOString().slice(0, 10);
  const lookback = new Date(Date.parse(today + "T00:00:00Z") - 60 * DAY).toISOString().slice(0, 10);

  const [cards, bills, loans, events] = await Promise.all([
    prisma.creditCard.findMany({ where: { scope: "personal", active: true } }),
    prisma.recurringExpense.findMany({ where: { scope: "personal", active: true } }),
    prisma.debt.findMany({ where: { status: "open" } }),
    prisma.obligationEvent.findMany({ where: { scope: "personal", status: "planned", date: { gte: lookback } } }),
  ]);

  const items: CalItem[] = [];
  const overdue: Overdue[] = [];
  const undated: Undated[] = [];

  for (const c of cards) {
    if (c.currentBalance <= 0) continue;
    const label = cardLabel(c);
    const amount = knownMinPayment(c);
    items.push({ kind: "card", label, owner: c.owner, amount, dueDay: c.dueDay, startFrom: c.nextDueDate, standing: c.standing, refId: c.id });
    if (c.standing === "past_due") overdue.push({ refId: c.id, kind: "card", label, owner: c.owner, amount, since: c.standingSince, reason: c.standingNote ?? "Past due" });
    else if (c.nextDueDate && c.nextDueDate < today) overdue.push({ refId: c.id, kind: "card", label, owner: c.owner, amount, since: c.nextDueDate, reason: "Due date passed — confirm the payment and set the next due date" });
  }
  for (const e of bills) items.push({ kind: "bill", label: e.name, owner: e.owner, amount: e.amount, dueDay: e.dueDay, refId: e.id });
  for (const d of loans) {
    const label = d.description || d.creditor || "Loan";
    const amount = d.monthlyPayment ?? null;
    const freq = d.paymentFrequency ?? "monthly";
    if (d.monthlyPayment && freq !== "monthly") {
      undated.push({ refId: d.id, label, owner: d.owner, amount: d.monthlyPayment, frequency: freq, note: d.standingNote });
    } else if (d.dueDay) {
      items.push({ kind: "loan", label, owner: d.owner, amount, dueDay: d.dueDay, startFrom: d.nextDueDate, standing: d.standing, refId: d.id });
    } else if (d.nextDueDate) {
      items.push({ kind: "loan", label, owner: d.owner, amount, date: d.nextDueDate, standing: d.standing, refId: d.id });
    }
    if (d.standing === "past_due") overdue.push({ refId: d.id, kind: "loan", label, owner: d.owner, amount, since: d.standingSince, reason: d.standingNote ?? "Past due" });
    else if (d.nextDueDate && d.nextDueDate < today) overdue.push({ refId: d.id, kind: "loan", label, owner: d.owner, amount, since: d.nextDueDate, reason: "Due date passed — confirm the payment and set the next due date" });
  }
  for (const ev of events) {
    items.push({
      kind: "event", label: ev.title, amount: ev.amount, date: ev.date, endDate: ev.endDate, time: ev.time, eventKind: ev.kind,
      supersedes: ev.kind === "payment" ? ev.cardId ?? ev.debtId : null, refId: ev.id,
    });
    const closedOn = ev.endDate ?? ev.date;
    if (closedOn < today) overdue.push({ refId: ev.id, kind: "event", label: ev.title, owner: null, amount: ev.amount, since: ev.date, reason: "Date passed and the event is still planned — mark it done or missed" });
  }

  const entries = buildCalendar(items, today, windowDays);
  const totalDue = round2(entries.reduce((s, e) => s + (e.amount ?? 0), 0));
  // Payments whose amount isn't known yet (a hearing or a window has no amount by nature).
  const unknownCount = entries.filter((e) => e.amount == null && !["window", "hearing", "mediation", "deadline"].includes(e.eventKind ?? "")).length;
  overdue.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  return NextResponse.json({ entries, overdue, undated, today, windowDays, totalDue, unknownCount, count: entries.length });
}
