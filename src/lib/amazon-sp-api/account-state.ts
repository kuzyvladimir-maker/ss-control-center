/**
 * Resolves the *operational* state of an Amazon account — whether the
 * account can currently sell on Amazon.com — independently of its AHR
 * score. AHR alone is insufficient: Retailer Distributor on 2026-05-17
 * had AHR=220 (Healthy band) but a "Your account has been deactivated"
 * banner on Seller Central, because Amazon enforcement removed selling
 * privileges separately from the score.
 *
 * Source of truth: the Sellers API marketplaceParticipations endpoint.
 * For each account it returns the marketplaces the account participates
 * in and an `isParticipating` flag per marketplace. When Amazon
 * deactivates an account at the policy level, `isParticipating` on the
 * US Amazon.com marketplace (ATVPDKIKX0DER) flips to false.
 *
 * AT_RISK_OF_DEACTIVATION is the literal label Amazon prints on Seller
 * Central when AHR falls below 200; we lift it from the parsed report
 * (accountHealthRatingStatus) rather than re-deriving from the score so
 * we stay aligned with Amazon's own threshold logic.
 *
 * Caveats:
 *  - POA-pending state: when an account is deactivated but has an open
 *    appeal, Amazon sometimes keeps `isParticipating: true` until the
 *    appeal resolves. In that window this helper will report ACTIVE
 *    even though Seller Central shows the deactivation banner. The
 *    planned Gmail fallback (parse "Your account has been deactivated"
 *    notification emails) covers that gap; see GMAIL_FALLBACK_TODO.
 */

import { spApiGet, MARKETPLACE_ID } from "./client";

export type AccountState =
  | "ACTIVE"
  | "AT_RISK_OF_DEACTIVATION"
  | "DEACTIVATED";

interface MarketplaceParticipation {
  marketplace?: { id?: string };
  participation?: { isParticipating?: boolean };
}

/**
 * Calls /sellers/v1/marketplaceParticipations for the given store and
 * derives whether the US marketplace is still participating. Returns
 * `null` (not `DEACTIVATED`) on transient/auth errors — we don't want a
 * throttled Sellers API call to flip a healthy account to DEACTIVATED
 * across the entire UI on a single bad request.
 */
async function checkUsParticipating(
  storeIndex: number,
): Promise<boolean | null> {
  try {
    const resp = await spApiGet("/sellers/v1/marketplaceParticipations", {
      storeId: `store${storeIndex}`,
    });
    const list: MarketplaceParticipation[] = Array.isArray(resp?.payload)
      ? resp.payload
      : Array.isArray(resp)
        ? resp
        : [];
    if (list.length === 0) {
      // Empty payload: account has no participations at all. That's a
      // hard deactivation signal — keep it as `false`.
      return false;
    }
    const us = list.find((p) => p?.marketplace?.id === MARKETPLACE_ID);
    if (!us) {
      // No US entry returned. Account never participated in US OR has
      // been entirely removed from US Amazon.com. Treat as deactivated
      // for status purposes.
      return false;
    }
    // `isParticipating` may be missing on legacy responses; Amazon's
    // documented default is true when the marketplace entry exists.
    return us.participation?.isParticipating !== false;
  } catch (err) {
    console.error(
      `[account-state] marketplaceParticipations failed for store${storeIndex}:`,
      err,
    );
    return null;
  }
}

/**
 * Top-level resolver — combines the Sellers API signal with the AHR
 * status string from the V2 Seller Performance Report.
 *
 * Priority (most severe wins):
 *   1. Sellers API says isParticipating=false → DEACTIVATED
 *   2. Report says AT_RISK_OF_DEACTIVATION    → AT_RISK_OF_DEACTIVATION
 *   3. Otherwise                              → ACTIVE
 *
 * Returns `null` only when BOTH signals are unavailable (sync error).
 */
export async function resolveAccountState(
  storeIndex: number,
  ahrStatus: string | null,
): Promise<AccountState | null> {
  const usActive = await checkUsParticipating(storeIndex);

  if (usActive === false) return "DEACTIVATED";

  if (ahrStatus === "AT_RISK_OF_DEACTIVATION") {
    return "AT_RISK_OF_DEACTIVATION";
  }

  if (usActive === true) return "ACTIVE";

  // Sellers API errored AND AHR isn't at-risk: we genuinely don't know.
  // Preserve null so the UI shows "—" rather than a false-positive
  // healthy state.
  return null;
}
