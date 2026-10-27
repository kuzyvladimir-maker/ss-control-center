// Deployed temporary percentage-reserve contract, not the approved final scheme.
// Owner decision 2026-10-27: payouts minus actual spending; period still open.
// Economics is deferred. See docs/wiki/treasury-module.md at repository root.
import type { DistributionResult } from "./types";

export const TREASURY_KEY = "finance:treasury";
export interface TreasurySettings {
  updatedAt?: string;
  grossMargin: { source: "constant" | "economics"; rate: number | null };
  personalShare: number | null;
}
export type GrossMargin = TreasurySettings["grossMargin"] & {
  basis: "net_payout";
  temporary: boolean;
  provenance: string;
  asOf: string | null;
}
export interface TreasuryConfig extends Omit<TreasurySettings, "grossMargin"> {
  grossMargin: GrossMargin;
}
export const roundMoney = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isFinanceWriteConflict(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked|write conflict/i.test(error.message);
}

export function resolveTreasury(
  stored: string | null,
  legacyReserve: string | null,
  asOf: string | null = null,
): TreasuryConfig {
  if (stored != null) {
    const value = JSON.parse(stored) as TreasurySettings;
    if (!value?.grossMargin || !["constant", "economics"].includes(value.grossMargin.source)
      || (value.grossMargin.rate !== null && !isRate(value.grossMargin.rate))
      || (value.personalShare !== null && !isRate(value.personalShare))) throw new Error("Invalid Treasury settings");
    return {
      personalShare: value.personalShare,
      grossMargin: {
        ...value.grossMargin,
        // Retain the deployed enum for compatibility; Economics is not an
        // approved input. Never use a stale constant as though it came from it.
        rate: value.grossMargin.source === "economics" ? null : value.grossMargin.rate,
        basis: "net_payout", temporary: value.grossMargin.source === "constant",
        provenance: value.grossMargin.source === "constant" ? "Owner setting" : "Economics is not connected",
        asOf: value.updatedAt ?? asOf,
      },
    };
  }
  const reserve = legacyReserve == null || legacyReserve.trim() === "" ? null : Number(legacyReserve);
  return {
    personalShare: null,
    grossMargin: {
      source: "constant", rate: isRate(reserve) ? Math.round((1 - reserve) * 10000) / 10000 : null,
      basis: "net_payout", temporary: true,
      provenance: isRate(reserve) ? "Existing restock reserve setting (1 − reserve)" : "Not set",
      asOf,
    },
  };
}

/** The share applies only to NEW FREE allocation, after business obligations.
 * Existing negative FREE must be covered before any money leaves the business. */
export function personalFromFree(distribution: DistributionResult, share: number | null, openingFree = 0) {
  if (share !== null && !isRate(share)) throw new Error("Invalid personal share");
  const requested = share === null ? 0 : roundMoney(distribution.free * share);
  const available = Math.max(0, roundMoney(openingFree + distribution.free));
  const amount = Math.min(requested, available);
  return {
    share, freeBefore: distribution.free, requested, amount,
    freeRetained: roundMoney(distribution.free - amount),
    limitedByBalance: amount < requested,
  };
}
