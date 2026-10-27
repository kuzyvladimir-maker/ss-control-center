import { buildCalendar, type CalItem } from "./calendar";
import { knownMinPayment } from "./cards";
import { cardLabel, type CardRow, type DebtRow } from "./registry";

interface Bill {
  id: string; name: string; owner: string | null; amount: number;
  dueDay: number | null; source: string; notes: string | null;
}
interface Event {
  id: string; cardId: string | null; debtId: string | null; title: string;
  date: string; endDate: string | null; time: string | null; kind: string;
  amount: number | null; status: string; source: string | null;
}
interface Evidence { amountAsOf: string | null; amountSource: string | null }
export interface OverduePayment extends Evidence {
  refId: string; kind: "card" | "loan" | "event"; label: string; owner: string | null;
  amount: number | null; since: string | null; reason: string;
}
export interface UndatedPayment extends Evidence {
  refId: string; label: string; owner: string | null; amount: number; frequency: string; note: string | null;
}

/** Read model only. Unresolved dates stay visible until completed/cancelled;
 * completing a replacement payment never resurrects its card minimum. */
export function buildPersonalCalendar(data: { cards: CardRow[]; bills: Bill[]; loans: DebtRow[]; events: Event[] }, today: string, windowDays = 60) {
  const { cards, bills, loans } = data;
  const events = data.events.filter((e) => e.status !== "cancelled");
  const items: CalItem[] = [];
  const overdue: OverduePayment[] = [];
  const undated: UndatedPayment[] = [];
  const parents = new Map([...cards, ...loans].map((p) => [p.id, p]));
  const replacements = new Set(events.filter((e) => e.kind === "payment").map((e) => `${e.cardId ?? e.debtId}|${e.date}`));
  const evidence = (p: CardRow | DebtRow): Evidence => ({ amountAsOf: p.balanceAsOf ?? null, amountSource: p.balanceSource ?? null });

  for (const c of cards) {
    if (!c.active || c.currentBalance <= 0) continue;
    const label = cardLabel(c), amount = knownMinPayment(c), source = evidence(c);
    items.push({ kind: "card", label, owner: c.owner, amount, dueDay: c.dueDay,
      date: c.dueDay ? null : c.nextDueDate, startFrom: c.nextDueDate, standing: c.standing, refId: c.id, ...source });
    if (c.standing === "past_due") overdue.push({ refId: c.id, kind: "card", label, owner: c.owner, amount, since: c.standingSince ?? null, reason: c.standingNote ?? "Past due", ...source });
    else if (c.nextDueDate && c.nextDueDate < today && !replacements.has(`${c.id}|${c.nextDueDate}`)) overdue.push({ refId: c.id, kind: "card", label, owner: c.owner, amount, since: c.nextDueDate, reason: "Due date passed — confirm the payment and set the next due date", ...source });
    if (!c.dueDay && !c.nextDueDate && amount != null && amount > 0) undated.push({ refId: c.id, label, owner: c.owner, amount, frequency: "monthly", note: c.standingNote ?? null, ...source });
  }
  for (const b of bills) items.push({ kind: "bill", label: b.name, owner: b.owner, amount: b.amount, dueDay: b.dueDay, refId: b.id,
    amountAsOf: null, amountSource: [b.source, b.notes].filter(Boolean).join(" · ") || null });
  for (const d of loans) {
    if (d.status !== "open") continue;
    const label = d.description || d.creditor || "Loan", amount = d.monthlyPayment ?? null;
    const frequency = d.paymentFrequency ?? "monthly", source = evidence(d);
    if (amount != null && amount > 0 && (frequency !== "monthly" || (!d.dueDay && !d.nextDueDate))) {
      undated.push({ refId: d.id, label, owner: d.owner, amount, frequency, note: d.standingNote ?? null, ...source });
    } else {
      items.push({ kind: "loan", label, owner: d.owner, amount, dueDay: d.dueDay,
        date: d.dueDay ? null : d.nextDueDate, startFrom: d.nextDueDate, standing: d.standing, refId: d.id, ...source });
    }
    if (d.standing === "past_due") overdue.push({ refId: d.id, kind: "loan", label, owner: d.owner, amount, since: d.standingSince ?? null, reason: d.standingNote ?? "Past due", ...source });
    else if (d.nextDueDate && d.nextDueDate < today && !replacements.has(`${d.id}|${d.nextDueDate}`)) overdue.push({ refId: d.id, kind: "loan", label, owner: d.owner, amount, since: d.nextDueDate, reason: "Due date passed — confirm the payment and set the next due date", ...source });
  }
  for (const ev of events) {
    const parent = parents.get(ev.cardId ?? ev.debtId ?? "");
    const source = { amountAsOf: ev.source?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null, amountSource: ev.source };
    items.push({ kind: "event", label: ev.title, owner: parent?.owner, standing: parent?.standing,
      amount: ev.amount, date: ev.date, endDate: ev.endDate, time: ev.time, eventKind: ev.kind,
      supersedes: ev.kind === "payment" ? ev.cardId ?? ev.debtId : null, refId: ev.id, done: ev.status === "done", ...source });
    if (ev.status !== "done" && ((ev.endDate ?? ev.date) < today || ev.status === "missed")) overdue.push({ refId: ev.id, kind: "event", label: ev.title, owner: parent?.owner ?? null, amount: ev.amount, since: ev.date,
      reason: ev.status === "missed" ? "Marked missed — still unresolved" : "Date passed — confirm completion", ...source });
  }
  const entries = buildCalendar(items, today, windowDays);
  const totalDue = Math.round(entries.reduce((s, e) => s + (e.amount ?? 0), 0) * 100) / 100;
  const unknownCount = entries.filter((e) => e.amount == null && !["window", "hearing", "mediation", "deadline"].includes(e.eventKind ?? "")).length;
  overdue.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  return { entries, overdue, undated, today, windowDays, totalDue, unknownCount, count: entries.length };
}
