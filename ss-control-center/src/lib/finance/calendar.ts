// Pure payment-calendar builder — the headline of the Personal Finance dashboard.
//
// Given dated obligations (credit cards, bills, loans) each with a `dueDay`
// (day-of-month), return the upcoming due dates within a window, sorted. No
// Date.now — the caller passes todayISO so this stays deterministic/testable.
//
// Month-end clamp: an obligation due on the 31st fires on the last day of a
// shorter month (e.g. the 30th in a 30-day month, the 28th in February).
//
// Phase 2 (2026-10-27) adds, without changing the rules above:
//   • one-off items (`date`, optional `endDate` for a window such as an IRS
//     payment-plan window — shown while it is open);
//   • `startFrom` — skip recurring occurrences before the known next due date
//     (a minimum already paid this month);
//   • `amount: null` — the date is known, the amount is not; still shown;
//   • `supersedes` — a one-off payment that replaces a recurring item's occurrence
//     on the same date (pay the full statement instead of the minimum).

export type CalKind = "card" | "bill" | "loan" | "event";

export interface CalItem {
  kind: CalKind;
  label: string;
  owner?: string | null;
  amount: number | null;
  dueDay?: number | null; // day of month (1..31) — recurring
  date?: string | null; // ISO — one-off
  endDate?: string | null; // ISO — one-off window end
  startFrom?: string | null; // ISO — no recurring occurrence before this date
  supersedes?: string | null; // refId whose occurrence on `date` this replaces
  standing?: string | null;
  time?: string | null;
  eventKind?: string | null; // payment | installment | hearing | mediation | window | deadline
  refId?: string;
  amountAsOf?: string | null;
  amountSource?: string | null;
  done?: boolean; // suppress a completed payment and its replaced minimum
}

export interface CalEntry {
  date: string; // ISO yyyy-mm-dd
  day: number;
  kind: CalKind;
  label: string;
  owner: string | null;
  amount: number | null;
  refId?: string;
  endDate?: string | null;
  standing?: string | null;
  time?: string | null;
  eventKind?: string | null;
  amountAsOf?: string | null;
  amountSource?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;

export function buildCalendar(items: CalItem[], todayISO: string, windowDays = 45): CalEntry[] {
  const start = new Date(todayISO + "T00:00:00Z");
  if (isNaN(start.getTime())) return [];
  const endISO = new Date(start.getTime() + windowDays * DAY).toISOString().slice(0, 10);
  const entries: CalEntry[] = [];
  const entry = (it: CalItem, iso: string): CalEntry => ({
    date: iso, day: Number(iso.slice(8, 10)), kind: it.kind, label: it.label,
    owner: it.owner ?? null, amount: it.amount == null ? null : round2(it.amount), refId: it.refId,
    amountAsOf: it.amountAsOf ?? null, amountSource: it.amountSource ?? null,
    ...(it.endDate ? { endDate: it.endDate } : {}),
    ...(it.standing ? { standing: it.standing } : {}),
    ...(it.time ? { time: it.time } : {}),
    ...(it.eventKind ? { eventKind: it.eventKind } : {}),
  });

  // Recurring (day-of-month) items.
  for (let i = 0; i <= windowDays; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const dom = d.getUTCDate();
    const isLastDay = new Date(d.getTime() + DAY).getUTCMonth() !== d.getUTCMonth();
    const iso = d.toISOString().slice(0, 10);
    for (const it of items) {
      if (it.date || !it.dueDay || (it.amount != null && it.amount <= 0)) continue;
      if (it.startFrom && iso < it.startFrom) continue;
      const match = it.dueDay === dom || (isLastDay && it.dueDay > dom);
      if (match) entries.push(entry(it, iso));
    }
  }

  // One-off items: inside the window, or a window that is open today.
  const replaced = new Set<string>();
  for (const it of items) {
    if (!it.date) continue;
    if (it.supersedes) replaced.add(`${it.supersedes}|${it.date}`);
    if (it.done) continue;
    const open = it.endDate ? it.date <= endISO && it.endDate >= todayISO : it.date >= todayISO && it.date <= endISO;
    if (!open) continue;
    const iso = it.date < todayISO ? todayISO : it.date; // an open window shows from today
    entries.push(entry(it, iso));
  }

  const out = entries.filter((e) => !(e.kind !== "event" && e.refId && replaced.has(`${e.refId}|${e.date}`)));
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
