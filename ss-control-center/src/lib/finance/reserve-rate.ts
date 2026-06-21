// Reserve rate = the share of each payout set aside FIRST to restock
// (COGS + shipping + packaging) before any other fund is filled.
//
// Two modes (Setting `finance:reserve:method`):
//   "manual" (default) — use Setting `finance:reserve:manualPct` (0..1). Vladimir
//                        controls it from the UI. Always works, no data deps.
//   "auto"             — floating trailing % computed from recent sales × SkuCost
//                        over `finance:reserve:windowWeeks` (default 4). Falls back
//                        to the manual % when COGS coverage is too thin to trust
//                        (esp. Walmart, where Sellerboard COGS is absent).
//
// The pure `blendReserveRate` is unit-tested; the data-driven trailing computation
// is intentionally a thin best-effort for Phase 1 (manual % is the safe default).

import { prisma } from "@/lib/prisma";

// Working-capital / restock reserve — the share of each payout we set aside to
// re-buy the next batch: COGS + packaging ONLY. Shipping is NOT reserved: marketplace
// labels (Amazon/Walmart Buy Shipping) are deducted from the payout, so the payout we
// distribute is already net of shipping — reserving for it again would double-count.
// NOTE: the old 0.58 default was derived as COGS+packaging+SHIPPING and is therefore
// too high. Pending Vladimir's real COGS+packaging share to reset; he can override in UI.
export const DEFAULT_MANUAL_PCT = 0.58;
export const DEFAULT_WINDOW_WEEKS = 4;

const K = {
  method: "finance:reserve:method",
  manualPct: "finance:reserve:manualPct",
  windowWeeks: "finance:reserve:windowWeeks",
};

/** Pure: blended reserve rate from summed recent costs vs revenue.
 *  Reserve = COGS + packaging only (what we FRONT to restock). Shipping is excluded —
 *  it's already netted from the payout. `shipping` is accepted for back-compat but
 *  intentionally ignored. */
export function blendReserveRate(input: {
  cogs: number;
  shipping?: number;
  packaging: number;
  revenue: number;
}): number {
  const { cogs, packaging, revenue } = input;
  if (!Number.isFinite(revenue) || revenue <= 0) return 0;
  const rate = (cogs + packaging) / revenue; // shipping excluded — already netted from payout
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return rate > 1 ? 1 : Math.round(rate * 10000) / 10000;
}

async function readSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export interface ReserveRateResult {
  rate: number;
  method: "manual" | "auto";
  /** True when auto was requested but we fell back to the manual % (thin data). */
  fellBackToManual: boolean;
  windowWeeks: number;
}

/** Resolve the reserve rate to use for a run. Reads config from Setting. */
export async function getReserveRate(): Promise<ReserveRateResult> {
  const method = (await readSetting(K.method)) === "auto" ? "auto" : "manual";
  const manualPct = Number(await readSetting(K.manualPct));
  const manual = Number.isFinite(manualPct) && manualPct > 0 ? Math.min(manualPct, 1) : DEFAULT_MANUAL_PCT;
  const ww = Number(await readSetting(K.windowWeeks));
  const windowWeeks = Number.isFinite(ww) && ww > 0 ? ww : DEFAULT_WINDOW_WEEKS;

  if (method === "manual") {
    return { rate: manual, method: "manual", fellBackToManual: false, windowWeeks };
  }

  // AUTO: best-effort trailing rate. Phase 1 keeps this conservative — until the
  // payout→order→SKU×SkuCost aggregation is wired (next iteration), auto falls
  // back to the manual %. blendReserveRate() is ready for when data is plumbed in.
  return { rate: manual, method: "auto", fellBackToManual: true, windowWeeks };
}
