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

import {
  TRACKING_FETCHERS as FETCHERS,
  detectCarrierOrder,
  type TrackCarrier as Carrier,
} from "@/lib/carriers/track";
import type { UpsTrackingInfo } from "@/lib/carriers/ups-tracking";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

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
