// Personal Finance constants (Phase 1). The personal pool reuses the Fund engine:
// FP1 = obligatory envelopes (bills you cannot skip), FP2 = goals/savings, plus a
// dedicated "Credit Cards" FP1 fund whose monthly need = sum of card minimums.
//
// Owner = whose obligation (Vladimir / Anna). UI labels are English per the
// project's English-UI rule; everything here is editable in the UI afterwards.

export const PERSONAL_OWNERS = ["Vladimir", "Anna"] as const;
export type PersonalOwner = (typeof PERSONAL_OWNERS)[number];

/** FP1 (obligatory) personal fund categories, in display/priority order. */
export const PERSONAL_FP1_CATEGORIES = [
  "Housing",
  "Transport",
  "Family",
  "Health",
  "Loans",
  "Household",
  "Credit Cards",
] as const;
export type PersonalCategory = (typeof PERSONAL_FP1_CATEGORIES)[number];

/** The fund that pays down credit cards; its monthly need = Σ card minimum payments. */
export const CREDIT_CARDS_FUND = "Credit Cards";

/** A default FP2 savings goal envelope. */
export const PERSONAL_SAVINGS_FUND = "Savings";

/** Priority for a personal FP1 fund by category (lower = filled earlier in the waterfall). */
export function personalFundPriority(category: string): number {
  const i = (PERSONAL_FP1_CATEGORIES as readonly string[]).indexOf(category);
  return 10 + (i < 0 ? 50 : i);
}
