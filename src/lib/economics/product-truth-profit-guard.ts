import { computeProfit } from "./compute-profit";
import type { ProfitInput, ProfitResult } from "./types";

export const ECONOMICS_COGS_BLOCKER = "COGS_NOT_AVAILABLE" as const;

export type GuardedProfitResult =
  | {
      status: "CALCULATED";
      blockers: [];
      result: ProfitResult;
    }
  | {
      status: "BLOCKED";
      blockers: [typeof ECONOMICS_COGS_BLOCKER];
      result: null;
    };

/**
 * Fail-closed boundary for Unit Economics.
 *
 * `computeProfit` intentionally accepts numeric primitives and therefore
 * cannot distinguish a real zero from an unknown cost. Runtime assemblers
 * must pass through this guard so NULL/UNSOURCEABLE COGS never becomes a
 * deceptively precise profit computed with zero product cost.
 */
export function computeProfitWithProductTruthGuard(
  input: Omit<ProfitInput, "cogs"> & { cogs: number | null },
  extraFlags: string[] = [],
): GuardedProfitResult {
  if (input.cogs == null || !Number.isFinite(input.cogs) || input.cogs <= 0) {
    return {
      status: "BLOCKED",
      blockers: [ECONOMICS_COGS_BLOCKER],
      result: null,
    };
  }
  return {
    status: "CALCULATED",
    blockers: [],
    result: computeProfit({ ...input, cogs: input.cogs }, extraFlags),
  };
}
