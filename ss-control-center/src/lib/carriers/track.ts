/**
 * Carrier-agnostic tracking lookup: guess the carrier from the tracking
 * number's format, then ask UPS / USPS / FedEx in likelihood order until one
 * answers. Shared by Jackie's `carrier_track` tool and the label-discard
 * pre-check (a label the carrier already scanned can't be refunded).
 */

import { getUpsTracking } from "./ups-tracking";
import type { UpsTrackingInfo } from "./ups-tracking";
import { getUspsTracking } from "./usps-tracking";
import { getFedexTracking } from "./fedex-tracking";

export type TrackCarrier = "UPS" | "USPS" | "FEDEX";

export const TRACKING_FETCHERS: Record<
  TrackCarrier,
  (tn: string) => Promise<UpsTrackingInfo | null>
> = {
  UPS: getUpsTracking,
  USPS: getUspsTracking,
  FEDEX: getFedexTracking,
};

/**
 * Best-effort carrier guess from tracking-number format, returned as an
 * ORDERED candidate list (most-likely first). For `carrier="auto"` we try
 * each in order until one returns data — formats overlap (USPS IMpb and
 * FedEx are both long numerics), so a single guess can't be trusted alone.
 */
export function detectCarrierOrder(raw: string): TrackCarrier[] {
  const t = raw.replace(/\s+/g, "").toUpperCase();
  // UPS: "1Z" + 16 alphanumerics.
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return ["UPS", "FEDEX", "USPS"];
  // USPS international S10: 2 letters, 9 digits, 2 letters (e.g. EA123456789US).
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(t)) return ["USPS", "FEDEX", "UPS"];
  // USPS IMpb: 20-22 digits, normally starting 91/92/93/94/95/96, or a
  // "420" + ZIP routing prefix.
  if (/^9[1-6]\d{18,20}$/.test(t) || /^420\d{5,}/.test(t)) {
    return ["USPS", "FEDEX", "UPS"];
  }
  // FedEx: 12 or 15 digit numerics are unambiguous.
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return ["FEDEX", "UPS", "USPS"];
  // Other long numerics (20-22) are ambiguous — lean USPS, then FedEx.
  if (/^\d{20,22}$/.test(t)) return ["USPS", "FEDEX", "UPS"];
  // Unknown format — try all three.
  return ["UPS", "USPS", "FEDEX"];
}

/** Map a free-text carrier name ("FedEx", "UPS®", "USPS Ground Advantage")
 *  to a lookup carrier, or null when it names none of the three. */
export function carrierFromName(name: string | null | undefined): TrackCarrier | null {
  const n = (name ?? "").toUpperCase();
  if (n.includes("FEDEX")) return "FEDEX";
  if (n.includes("USPS")) return "USPS";
  if (n.includes("UPS")) return "UPS";
  return null;
}

/** Look one number up, trying the named carrier first, then the format guess. */
export async function trackAny(
  trackingNumber: string,
  carrierHint?: string | null,
): Promise<{ carrier: TrackCarrier; info: UpsTrackingInfo } | null> {
  const hinted = carrierFromName(carrierHint);
  const order = detectCarrierOrder(trackingNumber);
  const candidates = hinted
    ? [hinted, ...order.filter((c) => c !== hinted)]
    : order;
  for (const c of candidates) {
    const info = await TRACKING_FETCHERS[c](trackingNumber);
    if (info) return { carrier: c, info };
  }
  return null;
}
