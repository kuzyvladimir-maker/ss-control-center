// Pure debt-payoff simulator — avalanche vs snowball. No I/O, no Date.now: the
// caller passes the start month, so the same inputs always give the same plan.
//
// Each month: interest accrues on every open balance (APR/12; an unknown APR adds
// no interest and is reported as "not modeled"), every minimum is paid, and the
// rest of the budget goes to the first debt in strategy order. A paid-off debt's
// minimum rolls into the extra (the budget stays constant).
//   avalanche = highest APR first (unknown APR last), ties → smaller balance
//   snowball  = smallest balance first, ties → higher APR
// Unit-tested in scripts/check-personal-finance.ts.

export type Strategy = "avalanche" | "snowball";

export interface PayoffDebt {
  id: string;
  label: string;
  balance: number;
  apr: number | null; // annual % (28.74); null = unknown
  minPayment: number; // monthly minimum (0 = none)
}

export interface PayoffLine {
  id: string;
  label: string;
  startBalance: number;
  apr: number | null;
  minPayment: number;
  payoffMonth: number | null; // 1-based month index; null = not paid off within the horizon
  payoffDate: string | null; // "YYYY-MM"
  interestPaid: number;
}

export interface PayoffResult {
  strategy: Strategy;
  monthlyBudget: number;
  minimumsTotal: number;
  feasible: boolean; // false = the budget doesn't cover the minimums
  shortfall: number; // how much more the budget needs to cover the minimums
  months: number | null; // months to debt-free; null = not within the horizon
  debtFreeDate: string | null;
  totalInterest: number;
  totalPaid: number;
  order: PayoffLine[]; // in payoff priority order
  aprUnknown: string[]; // ids whose interest is not modeled
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function orderFor(debts: PayoffDebt[], strategy: Strategy): PayoffDebt[] {
  const apr = (d: PayoffDebt) => (d.apr == null ? -1 : d.apr);
  return [...debts].sort((a, b) =>
    strategy === "avalanche"
      ? apr(b) - apr(a) || a.balance - b.balance || a.label.localeCompare(b.label)
      : a.balance - b.balance || apr(b) - apr(a) || a.label.localeCompare(b.label));
}

/** "2026-11" + n months → "YYYY-MM". */
export function addMonths(startYm: string, n: number): string {
  const [y, m] = startYm.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * Simulate paying `debts` off with a constant `monthlyBudget`.
 * `startYm` = the first payment month ("2026-11"); month 1 = startYm.
 */
export function simulatePayoff(debts: PayoffDebt[], monthlyBudget: number, strategy: Strategy, startYm: string, maxMonths = 600): PayoffResult {
  const ordered = orderFor(debts.filter((d) => d.balance > 0), strategy);
  const lines: PayoffLine[] = ordered.map((d) => ({
    id: d.id, label: d.label, startBalance: round2(d.balance), apr: d.apr, minPayment: round2(Math.max(0, d.minPayment)),
    payoffMonth: null, payoffDate: null, interestPaid: 0,
  }));
  const minimumsTotal = round2(lines.reduce((s, l) => s + Math.min(l.minPayment, l.startBalance), 0));
  const budget = round2(Math.max(0, monthlyBudget));
  const base = { strategy, monthlyBudget: budget, minimumsTotal, aprUnknown: lines.filter((l) => l.apr == null).map((l) => l.id) };

  if (lines.length === 0) {
    return { ...base, feasible: true, shortfall: 0, months: 0, debtFreeDate: null, totalInterest: 0, totalPaid: 0, order: [] };
  }
  if (budget < minimumsTotal) {
    return { ...base, feasible: false, shortfall: round2(minimumsTotal - budget), months: null, debtFreeDate: null, totalInterest: 0, totalPaid: 0, order: lines };
  }

  const bal = lines.map((l) => l.startBalance);
  let totalInterest = 0, totalPaid = 0, month = 0;
  while (month < maxMonths && bal.some((b) => b > 0)) {
    month++;
    // 1. Interest on every open balance.
    for (let i = 0; i < lines.length; i++) {
      if (bal[i] <= 0 || lines[i].apr == null) continue;
      const int = round2(bal[i] * (lines[i].apr! / 100 / 12));
      bal[i] = round2(bal[i] + int);
      lines[i].interestPaid = round2(lines[i].interestPaid + int);
      totalInterest = round2(totalInterest + int);
    }
    // 2. Every minimum.
    let left = budget;
    for (let i = 0; i < lines.length; i++) {
      if (bal[i] <= 0) continue;
      const pay = round2(Math.min(bal[i], lines[i].minPayment, left));
      bal[i] = round2(bal[i] - pay); left = round2(left - pay); totalPaid = round2(totalPaid + pay);
    }
    // 3. The rest to the first open debt in strategy order, cascading.
    for (let i = 0; i < lines.length && left > 0; i++) {
      if (bal[i] <= 0) continue;
      const pay = round2(Math.min(bal[i], left));
      bal[i] = round2(bal[i] - pay); left = round2(left - pay); totalPaid = round2(totalPaid + pay);
    }
    for (let i = 0; i < lines.length; i++) {
      if (bal[i] <= 0 && lines[i].payoffMonth == null) { lines[i].payoffMonth = month; lines[i].payoffDate = addMonths(startYm, month - 1); }
    }
  }
  const done = bal.every((b) => b <= 0);
  return {
    ...base, feasible: true, shortfall: 0,
    months: done ? month : null, debtFreeDate: done ? addMonths(startYm, month - 1) : null,
    totalInterest, totalPaid, order: lines,
  };
}
