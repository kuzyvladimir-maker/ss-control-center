// Accrual meter — every expense (and every installment debt) "ticks" each day and
// builds up a running OWED counter (`accrued`). It goes UP daily by the item's
// monthly cost ÷ 30.44, and only DOWN when you press "Paid" on that item. So the
// owed amount carries forward: if a Financial Plan doesn't cover an item, its debt
// stays and the next plan sees (old unpaid debt + newly accrued days).
//
// `lastAccruedDate` is the cursor (last day we ticked to). On the very first tick we
// bootstrap one week of debt (BOOTSTRAP_DAYS) so a freshly-set-up fund shows a
// meaningful week-one number instead of $0; after that it ticks one real day per day.
//
// Distribution "Needed" = the sum of these owed counters per fund. Taxes/Reserve are
// NOT accrued (they're a % of the payout); the Expansion/Debt fund is not accrued.

import { prisma } from "@/lib/prisma";
import { monthlyAmount, installmentMonthly } from "./expenses";

const DAYS_PER_MONTH = 30.44;
const BOOTSTRAP_DAYS = 7; // first-ever tick seeds one week of owed debt
const round2 = (n: number) => Math.round(n * 100) / 100;
export const SALARY_CATEGORY = "Salaries";

/** Smooth per-CALENDAR-day owed rate = monthly cost ÷ 30.44 (same basis for all). */
export function dailyOwedRate(amount: number, frequency: string): number {
  return monthlyAmount(amount, frequency) / DAYS_PER_MONTH;
}

/** Whole calendar days strictly after `fromISO`, up to and including `toISO`. */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** ISO date `days` before `today` (used to bootstrap the meter's first tick). */
export function daysBefore(today: string, days: number): string {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(t)) return today;
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

/** Pure: amount to ADD to an item's `accrued`, accruing fromISO → today (smooth). */
export function accrualAmount(monthlyCost: number, fromISO: string, today: string): number {
  if (!Number.isFinite(monthlyCost) || monthlyCost <= 0) return 0;
  return round2(daysBetween(fromISO, today) * (monthlyCost / DAYS_PER_MONTH));
}

/**
 * Accrue all active expenses in a category (or all when null) up to `today`.
 * First-ever tick bootstraps BOOTSTRAP_DAYS of debt. Returns total added.
 */
export async function accrueCategory(category: string | null, today: string): Promise<number> {
  const where = category ? { category, active: true } : { active: true };
  const exps = await prisma.recurringExpense.findMany({ where });
  let added = 0;
  for (const e of exps) {
    // Salaries are NOT smooth-accrued — their owed counter is driven by the timesheet
    // (worked days × per-day rate), adjusted on toggle/pay. Skip them here.
    if (e.category === SALARY_CATEGORY) continue;
    const from = e.lastAccruedDate ?? daysBefore(today, BOOTSTRAP_DAYS);
    if (from >= today) continue; // already up to date
    const add = accrualAmount(monthlyAmount(e.amount, e.frequency), from, today);
    await prisma.recurringExpense.update({
      where: { id: e.id },
      data: { accrued: round2((e.accrued ?? 0) + add), lastAccruedDate: today },
    });
    added += add;
  }
  return round2(added);
}

/**
 * Accrue open installment debts (those with a monthlyPayment) up to `today`. Each
 * ticks by its averaged monthly installment ÷ 30.44, capped so owed never exceeds
 * the remaining balance. First-ever tick bootstraps BOOTSTRAP_DAYS. Returns total.
 */
export async function accrueInstallments(today: string): Promise<number> {
  const debts = await prisma.debt.findMany({ where: { status: "open" } });
  let added = 0;
  for (const d of debts) {
    if (!d.monthlyPayment) continue;
    const from = d.lastAccruedDate ?? daysBefore(today, BOOTSTRAP_DAYS);
    if (from >= today) continue;
    const monthly = installmentMonthly(d.monthlyPayment, d.paymentFrequency);
    const remaining = Math.max(0, d.amount - d.paid);
    const owed = Math.min(round2((d.accrued ?? 0) + accrualAmount(monthly, from, today)), remaining);
    await prisma.debt.update({ where: { id: d.id }, data: { accrued: owed, lastAccruedDate: today } });
    added += Math.max(0, owed - (d.accrued ?? 0));
  }
  return round2(added);
}
