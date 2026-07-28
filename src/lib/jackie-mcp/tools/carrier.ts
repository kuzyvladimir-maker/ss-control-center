/**
 * Jackie MCP tool — carrier_track.
 *
 * Read-only tracking lookup across UPS / USPS / FedEx. Reuses the existing
 * carrier libs in `src/lib/carriers/` (OAuth client_credentials + parsers),
 * which already read the carrier API keys from env. We add no new
 * credentials here.
 *
 * The three libs return the same flat shape (UpsTrackingInfo), so this tool
 * just picks a carrier, calls the matching fetcher, and flattens the result
 * into the small status envelope Jackie needs.
 */

import { getUpsTracking } from "@/lib/carriers/ups-tracking";
import { getUspsTracking } from "@/lib/carriers/usps-tracking";
import { getFedexTracking } from "@/lib/carriers/fedex-tracking";
import type { UpsTrackingInfo } from "@/lib/carriers/ups-tracking";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

type Carrier = "UPS" | "USPS" | "FEDEX";

const FETCHERS: Record<Carrier, (tn: string) => Promise<UpsTrackingInfo | null>> = {
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
function detectCarrierOrder(raw: string): Carrier[] {
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

/** Flatten a carrier lib result into Jackie's status envelope. */
function flatten(carrier: Carrier, info: UpsTrackingInfo) {
  // events are ordered earliest-first, so the most recent is the last one.
  const last = info.events[info.events.length - 1];
  const lastEventText = last
    ? [last.description, [last.date, last.time].filter(Boolean).join(" ").trim()]
        .filter(Boolean)
        .join(" — ")
    : info.currentStatus;
  const delivered = info.delivered;
  return {
    carrier,
    status: info.currentStatus,
    last_event: lastEventText || null,
    location: last?.location ?? null,
    in_transit: !delivered && (info.currentStatus != null || info.events.length > 0),
    delivered,
    estimated_delivery: delivered
      ? info.actualDelivery ?? info.estimatedDelivery
      : info.estimatedDelivery,
  };
}

const carrierTrack: JackieTool = {
  name: "carrier_track",
  description:
    "Look up live shipment tracking for one tracking number via UPS, USPS, or FedEx. Set carrier to the known carrier, or 'auto' to detect it from the tracking-number format (and fall back across carriers if the guess misses). Read-only.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      tracking_number: {
        type: "string",
        description: "The carrier tracking number.",
      },
      carrier: {
        type: "string",
        enum: ["UPS", "USPS", "FEDEX", "auto"],
        default: "auto",
        description:
          "Which carrier API to query. 'auto' detects from the tracking-number format and tries carriers in likelihood order.",
      },
    },
    required: ["tracking_number"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const trackingNumber = requireString(args, "tracking_number").trim();
    const carrierArg = (optionalString(args, "carrier") ?? "auto").toUpperCase();

    const candidates: Carrier[] =
      carrierArg === "AUTO"
        ? detectCarrierOrder(trackingNumber)
        : carrierArg === "UPS" || carrierArg === "USPS" || carrierArg === "FEDEX"
          ? [carrierArg]
          : detectCarrierOrder(trackingNumber); // unknown value → treat as auto

    const tried: Carrier[] = [];
    for (const c of candidates) {
      tried.push(c);
      const info = await FETCHERS[c](trackingNumber);
      if (info) {
        return {
          ok: true,
          tracking_number: trackingNumber,
          carrier_detection: carrierArg === "AUTO" ? "auto" : "explicit",
          ...flatten(c, info),
        };
      }
    }

    return {
      ok: false,
      tracking_number: trackingNumber,
      carriers_tried: tried,
      error:
        carrierArg === "AUTO"
          ? "No carrier returned tracking data. The number may be invalid, not yet scanned, or from an unsupported carrier. Ask the operator to confirm the carrier and re-run with it set explicitly."
          : `${candidates[0]} returned no tracking data for this number (invalid, not yet scanned, or wrong carrier).`,
    };
  },
};

export const tools: JackieTool[] = [carrierTrack];
