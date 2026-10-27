// Compatibility adapter for existing finance callers. Treasury owns the only
// margin setting; there is no implicit 58% reserve or silent Economics fallback.
import { getTreasuryConfig } from "./treasury-config";
export const DEFAULT_WINDOW_WEEKS = 4;

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

export interface ReserveRateResult {
  rate: number;
  method: "manual" | "auto";
  fellBackToManual: boolean;
  windowWeeks: number;
}

/** Compatibility adapter: the waterfall now consumes the single grossMargin input. */
export async function getReserveRate(): Promise<ReserveRateResult> {
  const { grossMargin } = await getTreasuryConfig();
  if (grossMargin.rate == null) throw new Error("Set the temporary gross margin before distributing");
  return { rate: 1 - grossMargin.rate, method: grossMargin.source === "constant" ? "manual" : "auto", fellBackToManual: false, windowWeeks: DEFAULT_WINDOW_WEEKS };
}
