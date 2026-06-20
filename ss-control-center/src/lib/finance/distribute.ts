// distributeFunds — the pure waterfall at the heart of the Funds engine.
//
// No I/O: give it the money in, the reserve rate, and the configured funds; get
// back exactly where every dollar goes. Easy to unit-test (see
// scripts/check-finance-core.ts) and to preview in the UI before committing.
//
// Order:
//   reserve      = totalIn × reserveRate            → the RESERVE fund
//   distributable= totalIn − reserve
//   then, by ascending priority, each FP1/FP2 fund draws from `remaining`:
//       percent  → distributable × value%   (capped at remaining and at `cap`)
//       absolute → value                    (capped at remaining and at `cap`)
//   FREE fund    = whatever is left after all funds
//
// Percent funds are computed against `distributable` (the post-reserve base) but
// can never draw more than what is still `remaining` — so if funds are
// over-subscribed, priority order decides who gets paid (true waterfall).

import type { FundConfig, AllocationLine, DistributionResult } from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}

export function distributeFunds(
  totalIn: number,
  reserveRate: number,
  funds: FundConfig[],
): DistributionResult {
  const amount = Number.isFinite(totalIn) && totalIn > 0 ? totalIn : 0;
  const rate = clamp01(reserveRate);
  const reserve = round2(amount * rate);
  const distributable = round2(amount - reserve);

  const active = funds
    .filter((f) => f.active)
    .sort((a, b) => a.priority - b.priority);

  const allocations: AllocationLine[] = [];
  let remaining = distributable;
  let reserveAssigned = false;
  let freeFund: FundConfig | null = null;

  for (const f of active) {
    if (f.group === "RESERVE") {
      // The reserve is computed from the rate, not from the fund's value.
      // Only the first RESERVE fund carries it; extras get 0.
      const amt = reserveAssigned ? 0 : reserve;
      reserveAssigned = true;
      allocations.push({ fundId: f.id, name: f.name, group: f.group, amount: amt });
      continue;
    }
    if (f.group === "FREE") {
      // Resolve at the end with whatever remains. Keep the first FREE fund.
      if (!freeFund) freeFund = f;
      continue;
    }
    let raw = f.allocationType === "percent" ? distributable * (f.value / 100) : f.value;
    if (f.cap != null) raw = Math.min(raw, f.cap);
    const amt = Math.max(0, round2(Math.min(raw, remaining)));
    remaining = round2(remaining - amt);
    allocations.push({ fundId: f.id, name: f.name, group: f.group, amount: amt });
  }

  const free = round2(remaining);
  if (freeFund) {
    allocations.push({ fundId: freeFund.id, name: freeFund.name, group: "FREE", amount: free });
  }

  return {
    totalIn: round2(amount),
    reserve,
    reserveRate: rate,
    distributable,
    allocations,
    free,
  };
}
