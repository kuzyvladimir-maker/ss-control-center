// computeProfit — the one pure formula of the Economics module.
//
//   revenue  = itemPrice + shippingCharged
//   referral = referralFee(marketplace, category, revenue)   ← on the TOTAL sale
//   profit   = revenue − cogs − packaging − referral − ownShipping
//   margin%  = profit / revenue
//
// No I/O, no DB — give it primitives, get a result. This is what every consumer
// (the /economics table, the ad-hoc calculator, the P&L rollup) calls. The
// referral fee is charged by the marketplace on the total sales price including
// the shipping the customer pays (Amazon/Walmart, seller-fulfilled non-media),
// which is why the fee base is `revenue`, not `itemPrice`.

import type { ProfitInput, ProfitResult } from "./types";
import { referralFee } from "./fee-tables";

// Project rule: keep ≥20% of total landed revenue as margin. Mirrors
// reprice-engine.TARGET_MARGIN, but kept local so this core stays pure (no
// prisma/SP-API import chain). It only drives the soft "below_target_margin"
// UI flag here — the repricer remains the authority on the hard pricing floor.
export const TARGET_MARGIN = 0.2;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeProfit(input: ProfitInput, extraFlags: string[] = []): ProfitResult {
  const itemPrice = input.itemPrice || 0;
  const shippingCharged = input.shippingCharged || 0;
  const cogs = input.cogs || 0;
  const packaging = input.packaging || 0;
  const ownShipping = input.ownShipping || 0;

  const revenue = round2(itemPrice + shippingCharged);
  const fee = referralFee(input.marketplace, input.category, revenue);
  const profit = round2(revenue - cogs - packaging - fee - ownShipping);
  const marginPct = revenue > 0 ? profit / revenue : 0;

  const flags = [...extraFlags];
  if (revenue > 0 && marginPct < TARGET_MARGIN) flags.push("below_target_margin");

  return {
    sku: input.sku,
    marketplace: input.marketplace,
    profit,
    marginPct,
    referralFee: fee,
    revenue,
    breakdown: {
      itemPrice: round2(itemPrice),
      shippingCharged: round2(shippingCharged),
      cogs: round2(cogs),
      packaging: round2(packaging),
      referralFee: fee,
      ownShipping: round2(ownShipping),
    },
    flags,
  };
}
