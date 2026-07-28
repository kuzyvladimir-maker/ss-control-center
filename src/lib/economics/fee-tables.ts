// Marketplace referral-fee tables — the ESTIMATED (planning) fee model.
//
// These are the published US referral-fee schedules (Amazon Selling on Amazon
// fee schedule + Walmart Marketplace referral fees), encoded as data so the
// math lives in one place and is easy to update when the schedules change.
//
// IMPORTANT — estimated vs actual:
//   This produces a PLANNING estimate. The real fee Amazon/Walmart charged on a
//   given order lives in the settlement report (a "Referral Fee" line). Phase
//   7.3 reconciles estimate-vs-actual and can calibrate these tables. Never let
//   an estimate here silently drive a hard pricing floor without sign-off.
//
// Schedule snapshot: 2026-06 (verify against the current published schedules;
// rates do change). Many food categories are tiered: a low rate up to a price
// threshold, a higher rate above it. Flat categories set threshold = 0.

import type { FeeCategory, Marketplace } from "./types";

/** A referral-fee rule: `pctLow` applies when the fee base ≤ `threshold`,
 *  otherwise `pctHigh`. `minFee` is the per-item minimum (USD). For flat
 *  categories, pctLow === pctHigh and threshold === 0. */
interface FeeRule {
  pctLow: number;
  threshold: number;
  pctHigh: number;
  minFee: number;
}

// Amazon — Selling on Amazon referral fees (US). Grocery & Gourmet Food is the
// one that matters most for us: 8% at or under $15 total, 15% above. Amazon
// waives the $0.30 per-item minimum for Grocery; most other categories apply it.
const AMAZON: Record<FeeCategory, FeeRule> = {
  grocery_food: { pctLow: 0.08, threshold: 15, pctHigh: 0.15, minFee: 0 },
  health_personal_care: { pctLow: 0.08, threshold: 10, pctHigh: 0.15, minFee: 0.3 },
  beauty: { pctLow: 0.08, threshold: 10, pctHigh: 0.15, minFee: 0.3 },
  home_kitchen: { pctLow: 0.15, threshold: 0, pctHigh: 0.15, minFee: 0.3 },
  pet: { pctLow: 0.15, threshold: 0, pctHigh: 0.15, minFee: 0.3 },
  other: { pctLow: 0.15, threshold: 0, pctHigh: 0.15, minFee: 0.3 },
};

// Walmart — Marketplace referral fees (US). Grocery and Health/Beauty are tiered
// at $10; most everything else is a flat 15%.
const WALMART: Record<FeeCategory, FeeRule> = {
  grocery_food: { pctLow: 0.08, threshold: 10, pctHigh: 0.15, minFee: 0 },
  health_personal_care: { pctLow: 0.08, threshold: 10, pctHigh: 0.15, minFee: 0 },
  beauty: { pctLow: 0.08, threshold: 10, pctHigh: 0.15, minFee: 0 },
  home_kitchen: { pctLow: 0.15, threshold: 0, pctHigh: 0.15, minFee: 0 },
  pet: { pctLow: 0.15, threshold: 0, pctHigh: 0.15, minFee: 0 },
  other: { pctLow: 0.15, threshold: 0, pctHigh: 0.15, minFee: 0 },
};

function applyRule(rule: FeeRule, base: number): number {
  if (!Number.isFinite(base) || base <= 0) return 0;
  const pct = rule.threshold > 0 && base <= rule.threshold ? rule.pctLow : rule.pctHigh;
  const fee = base * pct;
  return Math.round(Math.max(fee, rule.minFee) * 100) / 100;
}

/** Amazon referral fee on a given fee base (= total sales price, item + shipping
 *  charged, for seller-fulfilled non-media items). */
export function amazonReferralFee(category: FeeCategory, base: number): number {
  return applyRule(AMAZON[category] ?? AMAZON.other, base);
}

/** Walmart referral fee on a given fee base (= total sale price). */
export function walmartReferralFee(category: FeeCategory, base: number): number {
  return applyRule(WALMART[category] ?? WALMART.other, base);
}

/** Marketplace-dispatching helper used by computeProfit(). */
export function referralFee(
  marketplace: Marketplace,
  category: FeeCategory,
  base: number,
): number {
  return marketplace === "amazon"
    ? amazonReferralFee(category, base)
    : walmartReferralFee(category, base);
}

/** The flat referral rate the legacy repricer assumes (AMAZON_REFERRAL_PCT).
 *  Exposed so a later follow-up can point marginFloorPrice() at this table
 *  instead of its own hardcoded 0.15 — keeping the floor and the economics
 *  page on one fee model. */
export const LEGACY_FLAT_REFERRAL = 0.15;
