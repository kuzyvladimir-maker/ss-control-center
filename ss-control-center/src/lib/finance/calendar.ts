// Pure payment-calendar builder — the headline of the Personal Finance dashboard.
//
// Given dated obligations (credit cards, bills, loans) each with a `dueDay`
// (day-of-month), return the upcoming due dates within a window, sorted. No
// Date.now — the caller passes todayISO so this stays deterministic/testable.
//
// Month-end clamp: an obligation due on the 31st fires on the last day of a
// shorter month (e.g. the 30th in a 30-day month, the 28th in February).

export type CalKind = "card" | "bill" | "loan";

export interface CalItem {
  kind: CalKind;
  label: string;
  owner?: string | null;
  amount: number;
  dueDay: number | null | undefined; // day of month (1..31)
  refId?: string;
}

export interface CalEntry {
  date: string; // ISO yyyy-mm-dd
  day: number;
  kind: CalKind;
  label: string;
  owner: string | null;
  amount: number;
  refId?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;

export function buildCalendar(items: CalItem[], todayISO: string, windowDays = 45): CalEntry[] {
  const start = new Date(todayISO + "T00:00:00Z");
  if (isNaN(start.getTime())) return [];
  const entries: CalEntry[] = [];
  for (let i = 0; i <= windowDays; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const dom = d.getUTCDate();
    const isLastDay = new Date(d.getTime() + DAY).getUTCMonth() !== d.getUTCMonth();
    const iso = d.toISOString().slice(0, 10);
    for (const it of items) {
      if (!it.dueDay || it.amount <= 0) continue;
      const match = it.dueDay === dom || (isLastDay && it.dueDay > dom);
      if (!match) continue;
      entries.push({
        date: iso, day: dom, kind: it.kind, label: it.label,
        owner: it.owner ?? null, amount: round2(it.amount), refId: it.refId,
      });
    }
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return entries;
}
