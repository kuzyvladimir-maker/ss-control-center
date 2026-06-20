// Shared types for the Finance Core module — Phase 1 (Funds).
//
// Model: ONE global business pool. Money in = marketplace payouts (already net of
// marketplace fees, cash basis). Each payout is distributed by a waterfall:
//   1. RESERVE fund first   (reserve = payout × reserveRate; covers COGS+shipping+packaging restock)
//   2. FP1 funds (life-support) by priority
//   3. FP2 funds (growth/obligations) by priority
//   4. FREE fund gets whatever is left

export type FundGroup = "RESERVE" | "FP1" | "FP2" | "FREE";
export type AllocationType = "percent" | "absolute";

/** A configured fund (UI-CRUD). `value` is a percent (0–100) when
 *  allocationType==="percent", else an absolute USD amount per run. */
export interface FundConfig {
  id: string;
  name: string;
  group: FundGroup;
  allocationType: AllocationType;
  value: number;
  priority: number; // lower = filled earlier
  cap?: number | null; // optional per-run ceiling (USD)
  active: boolean;
}

export interface AllocationLine {
  fundId: string;
  name: string;
  group: FundGroup;
  amount: number;
}

export interface DistributionResult {
  totalIn: number;
  reserve: number;
  reserveRate: number;
  distributable: number; // totalIn − reserve
  allocations: AllocationLine[];
  free: number; // leftover after all funds (goes to a FREE fund if one exists)
}

export type Marketplace = "amazon" | "walmart";
