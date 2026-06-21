// Accrual meter — expenses "tick" every day. Each expense carries `accrued` (the
// currently-owed amount, not yet paid) and `lastAccruedDate` (cursor). Opening a
// fund (or a daily cron) accrues from the cursor to today, so the owed amount is
// always up to date and never double-counted. Non-salary expenses accrue per
// CALENDAR day; salary expenses accrue per WORKED day (weekdays minus absences —
// the timesheet marks absences, default = worked).

import { prisma } from "@/lib/prisma";
import { perDayRate } from "./expenses";

const DAYS_PER_MONTH = 30.44;
const round2 = (n: number) => Math.round(n * 100) / 100;
export const SALARY_CATEGORY = "Salaries";

/** Calendar per-day accrual rate for a non-salary expense. */
export function dailyAccrualRate(amount: number, frequency: string): number {
  if (!Number.isFinite(amount)) return 0;
  switch (frequency) {
    case "daily": return amount;
    case "weekly": return amount / 7;
    case "monthly": return amount / DAYS_PER_MONTH;
    case "yearly": return amount / 365;
    default: return 0; // one_time — doesn't tick
  }
}

/** Whole calendar days strictly after `fromISO`, up to and including `toISO`. */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** Weekday (Mon–Fri) date strings strictly after `fromISO`, up to/including `toISO`. */
export function weekdayDatesBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const d = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return out;
  d.setUTCDate(d.getUTCDate() + 1);
  let guard = 0;
  while (d <= end && guard++ < 1000) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Pure: amount to ADD to `accrued` for one expense, accruing fromISO → today.
 *  For salary, pass the WORKED dates (from the timesheet); only those strictly
 *  after fromISO and ≤ today are paid. Non-salary accrues per calendar day. */
export function accrualAmount(
  expense: { amount: number; frequency: string; category: string },
  fromISO: string,
  today: string,
  workedDates: Set<string> = new Set(),
): number {
  if (expense.category === SALARY_CATEGORY) {
    let worked = 0;
    for (const d of workedDates) if (d > fromISO && d <= today) worked++;
    return round2(worked * perDayRate(expense.amount, expense.frequency));
  }
  if (expense.frequency === "one_time") return 0; // handled by a manual add
  return round2(daysBetween(fromISO, today) * dailyAccrualRate(expense.amount, expense.frequency));
}

/**
 * Accrue all active expenses in a category (or all categories when null) up to
 * `today`. First-ever accrual just starts the meter (cursor = today, adds 0) so
 * there's no surprise back-charge. Returns how much was added in total.
 */
export async function accrueCategory(category: string | null, today: string): Promise<number> {
  const where = category ? { category, active: true } : { active: true };
  const exps = await prisma.recurringExpense.findMany({ where });
  let added = 0;
  for (const e of exps) {
    const from = e.lastAccruedDate ?? null;
    if (from == null) {
      // Start the meter now.
      await prisma.recurringExpense.update({ where: { id: e.id }, data: { lastAccruedDate: today } });
      continue;
    }
    if (from >= today) continue; // already up to date
    let workedDates = new Set<string>();
    if (e.category === SALARY_CATEGORY) {
      const logs = await prisma.timeLog.findMany({ where: { expenseId: e.id } });
      workedDates = new Set(logs.map((l) => l.date)); // TimeLog = worked days
    }
    const add = accrualAmount(e, from, today, workedDates);
    await prisma.recurringExpense.update({
      where: { id: e.id },
      data: { accrued: round2(e.accrued + add), lastAccruedDate: today },
    });
    added += add;
  }
  return round2(added);
}
