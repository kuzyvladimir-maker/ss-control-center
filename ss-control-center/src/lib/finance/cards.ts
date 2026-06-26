// Pure credit-card math — the heart of the Personal Finance card view.
// No I/O: minimum payment, utilization, monthly interest, and portfolio totals.
// Unit-testable (see scripts/check-personal-finance.ts).
//
// minPaymentPct is in PERCENT POINTS (2 = 2%). The minimum due is the greater of
// the fixed floor and the percent-of-balance, but never more than the balance.

export interface CardLike {
  currentBalance: number;
  statementBalance?: number;
  creditLimit?: number;
  apr?: number | null;
  minPaymentFixed?: number;
  minPaymentPct?: number; // percent points (2 = 2%)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minimum payment due = max(fixed floor, balance×pct), capped at the balance. */
export function minPayment(c: CardLike): number {
  const bal = Math.max(0, c.currentBalance || 0);
  if (bal <= 0) return 0;
  const pct = bal * ((c.minPaymentPct || 0) / 100);
  const due = Math.max(c.minPaymentFixed || 0, pct);
  return round2(Math.min(bal, due));
}

/** Utilization ratio (0..1+) = balance ÷ limit. A credit-score driver (<0.30 good). */
export function utilization(c: CardLike): number {
  const lim = c.creditLimit || 0;
  if (lim <= 0) return 0;
  return Math.max(0, c.currentBalance || 0) / lim;
}

/** Interest accrued in one month if the balance is carried (balance × APR/12). */
export function monthlyInterest(c: CardLike): number {
  if (!c.apr) return 0;
  return round2(Math.max(0, c.currentBalance || 0) * (c.apr / 100 / 12));
}

export interface CardTotals {
  count: number;
  totalBalance: number;
  totalLimit: number;
  totalStatement: number;
  overallUtilization: number; // ratio 0..1+
  totalMinPayment: number;
  monthlyInterest: number;
}

/** Portfolio totals across many cards — overall utilization is the household number
 *  that actually moves a credit score (Σbalance ÷ Σlimit). */
export function cardTotals(cards: CardLike[]): CardTotals {
  let totalBalance = 0, totalLimit = 0, totalStatement = 0, totalMin = 0, mInt = 0;
  for (const c of cards) {
    totalBalance += Math.max(0, c.currentBalance || 0);
    totalLimit += c.creditLimit || 0;
    totalStatement += Math.max(0, c.statementBalance || 0);
    totalMin += minPayment(c);
    mInt += monthlyInterest(c);
  }
  return {
    count: cards.length,
    totalBalance: round2(totalBalance),
    totalLimit: round2(totalLimit),
    totalStatement: round2(totalStatement),
    overallUtilization: totalLimit > 0 ? round2(totalBalance / totalLimit) : 0,
    totalMinPayment: round2(totalMin),
    monthlyInterest: round2(mInt),
  };
}
