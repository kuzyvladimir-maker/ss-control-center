// Pure credit-card math — the heart of the Personal Finance card view.
// No I/O: minimum payment, utilization, monthly interest, and portfolio totals.
// Unit-testable (see scripts/check-personal-finance.ts).
//
// minPaymentPct is in PERCENT POINTS (2 = 2%). The minimum due is the greater of
// the fixed floor and the percent-of-balance, but never more than the balance.
// minPaymentDue — the real statement minimum — wins over the rule when known.

export interface CardLike {
  currentBalance: number;
  statementBalance?: number;
  creditLimit?: number;
  apr?: number | null;
  minPaymentFixed?: number;
  minPaymentPct?: number; // percent points (2 = 2%)
  minPaymentDue?: number | null; // statement minimum, when known
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minimum payment due = the statement minimum if known, else max(fixed floor,
 *  balance×pct); always capped at the balance. 0 when nothing is known. */
export function minPayment(c: CardLike): number {
  const bal = Math.max(0, c.currentBalance || 0);
  if (bal <= 0) return 0;
  if (c.minPaymentDue != null) return round2(Math.min(bal, Math.max(0, c.minPaymentDue)));
  const pct = bal * ((c.minPaymentPct || 0) / 100);
  const due = Math.max(c.minPaymentFixed || 0, pct);
  return round2(Math.min(bal, due));
}

/** Like minPayment, but null when the minimum is simply not known (no statement
 *  minimum and no rule) — so the UI can say "not set" instead of $0. */
export function knownMinPayment(c: CardLike): number | null {
  if (Math.max(0, c.currentBalance || 0) <= 0) return 0;
  if (c.minPaymentDue == null && !(c.minPaymentFixed || 0) && !(c.minPaymentPct || 0)) return null;
  return minPayment(c);
}

/** Utilization ratio (0..1+) = balance ÷ limit. */
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
  limitsUnknown: number;
  aprsUnknown: number;
  minimumsUnknown: number;
}

/** Utilization uses only cards with known limits in BOTH numerator and denominator.
 * Missing limits, APRs and minimums are reported separately from known totals. */
export function cardTotals(cards: CardLike[]): CardTotals {
  let totalBalance = 0, totalLimit = 0, totalStatement = 0, totalMin = 0, mInt = 0;
  let limitedBalance = 0, limitsUnknown = 0, aprsUnknown = 0, minimumsUnknown = 0;
  for (const c of cards) {
    totalBalance += Math.max(0, c.currentBalance || 0);
    if (c.creditLimit != null && c.creditLimit > 0) {
      totalLimit += c.creditLimit;
      limitedBalance += Math.max(0, c.currentBalance || 0);
    } else limitsUnknown++;
    if (c.currentBalance > 0 && c.apr == null) aprsUnknown++;
    if (knownMinPayment(c) == null) minimumsUnknown++;
    totalStatement += Math.max(0, c.statementBalance || 0);
    totalMin += minPayment(c);
    mInt += monthlyInterest(c);
  }
  return {
    count: cards.length,
    totalBalance: round2(totalBalance),
    totalLimit: round2(totalLimit),
    totalStatement: round2(totalStatement),
    overallUtilization: totalLimit > 0 ? round2(limitedBalance / totalLimit) : 0,
    totalMinPayment: round2(totalMin),
    monthlyInterest: round2(mInt),
    limitsUnknown, aprsUnknown, minimumsUnknown,
  };
}
