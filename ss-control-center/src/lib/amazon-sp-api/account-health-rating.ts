/**
 * Amazon Account Health Rating (AHR) fetcher.
 *
 * Amazon's real-time AHR endpoint sits behind the "Selling Partner Insights"
 * SP-API role. Until that role is approved on a store, this returns null.
 *
 * When approved, the official endpoint to call is:
 *   GET /sellingpartnerinsights/2024-09-10/accountHealth
 * (parsed shape: { accountHealthRating: number, status: string }).
 *
 * As a fallback, the Reports API report
 *   GET_V2_SELLER_PERFORMANCE_REPORT
 * also contains AHR — but it's async (request report → poll → download →
 * parse JSON). The current implementation skips it; flip USE_REPORTS_FALLBACK
 * to true once the report parser is wired.
 */

import { spApiGet } from "./client";

export interface AccountHealthRating {
  rating: number; // 0..1000
  status: "AT_RISK_OF_DEACTIVATION" | "AT_RISK" | "GOOD";
  lastUpdated: string; // ISO
}

const USE_REPORTS_FALLBACK = false;

/**
 * Best-effort AHR fetch. Returns null on any failure or when the role
 * isn't available — callers should treat null as "unknown" and continue
 * the rest of the sync.
 */
export async function fetchAccountHealthRating(
  storeIndex: number
): Promise<AccountHealthRating | null> {
  const storeId = `store${storeIndex}`;
  // Try the real-time endpoint first. If the role isn't granted, SP-API
  // returns 403 — we swallow it and log a soft warning rather than fail.
  try {
    const data = await spApiGet(
      "/sellingpartnerinsights/2024-09-10/accountHealth",
      { storeId }
    );
    const rating = Number(
      data?.payload?.accountHealthRating ??
        data?.accountHealthRating ??
        NaN
    );
    const status = String(
      data?.payload?.status ?? data?.status ?? ""
    ).toUpperCase();
    if (!Number.isFinite(rating)) {
      console.warn(
        `[AHR] ${storeId}: unexpected payload shape, ignoring`,
        Object.keys(data?.payload ?? {})
      );
      return null;
    }
    return {
      rating,
      status:
        status === "AT_RISK_OF_DEACTIVATION" ||
        status === "AT_RISK" ||
        status === "GOOD"
          ? status
          : "GOOD",
      lastUpdated: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 403 / 404 → role not approved or endpoint not exposed for this store.
    // Anything else is logged but still non-fatal.
    console.warn(`[AHR] ${storeId}: ${msg}`);
  }

  if (USE_REPORTS_FALLBACK) {
    // TODO: implement Reports API fallback (GET_V2_SELLER_PERFORMANCE_REPORT)
    // when the report parser is wired. Keep returning null for now.
    return null;
  }

  return null;
}

/**
 * Derive zone label from a numeric rating. Useful for UI when only the
 * raw number is available.
 */
export function zoneFor(rating: number): AccountHealthRating["status"] {
  if (rating < 200) return "AT_RISK_OF_DEACTIVATION";
  if (rating < 400) return "AT_RISK";
  return "GOOD";
}
