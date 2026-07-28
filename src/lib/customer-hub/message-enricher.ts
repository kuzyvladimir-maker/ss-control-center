/**
 * Enrich parsed buyer email with SP-API order data + Veeqo tracking
 */

import { spApiGet } from "@/lib/amazon-sp-api/client";
import { prisma } from "@/lib/prisma";
import type { ParsedBuyerEmail } from "./gmail-parser";
import { getUpsTracking, type UpsTrackingEvent } from "@/lib/carriers/ups-tracking";
import { getFedexTracking } from "@/lib/carriers/fedex-tracking";
import { getUspsTracking } from "@/lib/carriers/usps-tracking";

export interface EnrichedMessage extends ParsedBuyerEmail {
  orderDate: string | null;
  orderTotal: number | null;
  product: string | null;
  productType: string | null;
  quantity: number | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
  promisedEdd: string | null;
  actualDelivery: string | null;
  trackingStatus: string | null;
  daysInTransit: number | null;
  daysLate: number | null;
  requestedShippingService: string | null;
  actualShippingService: string | null;
  shippingMismatch: boolean;
  carrierEstimatedDelivery: string | null;
  trackingEvents: UpsTrackingEvent[] | null;
  /** True if any tracking event explicitly says "delay/delayed/exception/
   *  weather/late/missed delivery". This is documentary evidence of
   *  carrier fault — used by the analyzer to redirect carrier-fault
   *  cases to Amazon A-to-Z (Buy Shipping Claims Protection). */
  carrierSelfDeclaredDelay: boolean;
  boughtThroughVeeqo: boolean;
  claimsProtected: boolean;
  shippedOnTime: boolean | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VeeqoShipment = any;

export async function enrichMessage(
  parsed: ParsedBuyerEmail
): Promise<EnrichedMessage> {
  console.log(
    "[Enricher] Starting enrichment for order:",
    parsed.amazonOrderId,
    "store:",
    parsed.storeIndex
  );
  const enriched: EnrichedMessage = {
    ...parsed,
    orderDate: null,
    orderTotal: null,
    product: parsed.productName,
    productType: null,
    quantity: null,
    carrier: null,
    service: null,
    trackingNumber: null,
    shipDate: null,
    promisedEdd: null,
    actualDelivery: null,
    trackingStatus: null,
    daysInTransit: null,
    daysLate: null,
    requestedShippingService: null,
    actualShippingService: null,
    shippingMismatch: false,
    carrierEstimatedDelivery: null,
    trackingEvents: null,
    carrierSelfDeclaredDelay: false,
    boughtThroughVeeqo: false,
    claimsProtected: false,
    shippedOnTime: null,
  };

  if (!parsed.amazonOrderId) return enriched;

  const storeId = `store${parsed.storeIndex}`;
  // Amazon's "latest ship date" promise — used for on-time shipment check.
  // Separate from promisedEdd (latest delivery date).
  let latestShipDate: string | null = null;

  // 1. SP-API: Order details
  try {
    const orderRes = await spApiGet(
      `/orders/v0/orders/${parsed.amazonOrderId}`,
      { storeId }
    );
    const order = orderRes.payload;
    console.log(
      "[Enricher] SP-API order response:",
      JSON.stringify(order || "null").substring(0, 500)
    );
    if (order) {
      enriched.orderDate = order.PurchaseDate?.split("T")[0] || null;
      enriched.orderTotal = order.OrderTotal?.Amount
        ? parseFloat(order.OrderTotal.Amount)
        : null;
      enriched.promisedEdd = order.LatestDeliveryDate?.split("T")[0] || null;
      latestShipDate = order.LatestShipDate?.split("T")[0] || null;

      // Extract requested shipping service — Amazon exposes this as either
      // ShipmentServiceLevelCategory (e.g. "Expedited", "Standard", "NextDay")
      // or the older ShippingService string. Used to detect T21 mismatches
      // against the actual Veeqo service below.
      const requestedService =
        order.ShipmentServiceLevelCategory ||
        order.ShippingService ||
        null;
      enriched.requestedShippingService = requestedService;
      console.log(
        "[Enricher] Requested shipping service:",
        requestedService
      );
    }
  } catch (e) {
    console.error(
      `[Enricher] SP-API order fetch failed for ${parsed.amazonOrderId}:`,
      e instanceof Error ? e.message : e
    );
  }

  // 2. SP-API: Order items
  try {
    const itemsRes = await spApiGet(
      `/orders/v0/orders/${parsed.amazonOrderId}/orderItems`,
      { storeId }
    );
    const items = itemsRes.payload?.OrderItems || [];
    if (items.length > 0) {
      const first = items[0];
      enriched.product = enriched.product || first.Title || null;
      enriched.asin = enriched.asin || first.ASIN || null;
      enriched.quantity = first.QuantityOrdered || null;
    }
  } catch (e) {
    console.error(
      `[Enricher] SP-API items fetch failed for ${parsed.amazonOrderId}:`,
      e instanceof Error ? e.message : e
    );
  }

  // 3. Veeqo: tracking info
  let veeqoShipment: VeeqoShipment | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let veeqoAllocation: any = null;
  const VEEQO_API_KEY = process.env.VEEQO_API_KEY;
  const VEEQO_BASE_URL =
    process.env.VEEQO_BASE_URL || "https://api.veeqo.com";

  console.log("[Enricher] VEEQO_API_KEY exists:", !!VEEQO_API_KEY);
  const veeqoUrl = `${VEEQO_BASE_URL}/orders?query=${parsed.amazonOrderId}&page_size=5`;
  console.log("[Enricher] Veeqo URL:", veeqoUrl);

  try {
    if (VEEQO_API_KEY) {
      const veeqoRes = await fetch(veeqoUrl, {
        headers: { "x-api-key": VEEQO_API_KEY },
      });
      console.log("[Enricher] Veeqo status:", veeqoRes.status);

      if (veeqoRes.ok) {
        const veeqoRaw = await veeqoRes.text();
        console.log(
          "[Enricher] Veeqo raw response (first 500 chars):",
          veeqoRaw.substring(0, 500)
        );
        const veeqoOrders = JSON.parse(veeqoRaw);
        console.log(
          "[Enricher] Veeqo orders count:",
          Array.isArray(veeqoOrders) ? veeqoOrders.length : "(not an array)"
        );
        // Veeqo returns the Amazon order ID in the `number` field, not
        // `channel_order_id`. Check both for safety across channel types.
        const targetOrderId = parsed.amazonOrderId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match = veeqoOrders?.find?.((o: any) => {
          const candidates: string[] = [o.number, o.channel_order_id].filter(
            (v: unknown): v is string => typeof v === "string" && v.length > 0
          );
          console.log(
            "[Enricher] Checking Veeqo order:",
            candidates.join(" | ") || "(no identifiers)",
            "vs",
            targetOrderId
          );
          return candidates.some(
            (id) => id === targetOrderId || id.includes(targetOrderId)
          );
        });

        if (match) {
          console.log(
            "[Enricher] MATCH FOUND. Allocations:",
            match.allocations?.length
          );
          console.log(
            "[Enricher] Allocation[0]:",
            JSON.stringify(match.allocations?.[0] || "null").substring(0, 500)
          );
        } else {
          console.log(
            "[Enricher] NO MATCH in Veeqo for",
            parsed.amazonOrderId
          );
        }

        if (match) {
          veeqoAllocation = match.allocations?.[0];
          veeqoShipment = veeqoAllocation?.shipment || null;

          if (veeqoShipment) {
            // Veeqo's `tracking_number` can be either a plain string OR a
            // nested object `{ tracking_number: "1Z...", shipment_id, ... }`
            // depending on how the allocation was created. Normalise to
            // a string before saving — Prisma will reject an object.
            const rawTracking = veeqoShipment.tracking_number;
            if (typeof rawTracking === "string") {
              enriched.trackingNumber = rawTracking;
            } else if (
              rawTracking &&
              typeof rawTracking === "object" &&
              typeof rawTracking.tracking_number === "string"
            ) {
              enriched.trackingNumber = rawTracking.tracking_number;
            } else {
              enriched.trackingNumber = null;
            }

            // Carrier name can live in several places depending on Veeqo
            // setup. Try the most specific first and fall back.
            // Note: Veeqo returns "Buy Shipping" (billing program label)
            // instead of a real carrier when we purchased via Amazon Buy
            // Shipping. That's useless for customer-facing copy, so we
            // skip it and derive the carrier from service_name below.
            const carrierCandidates = [
              veeqoShipment.carrier_name,
              veeqoShipment.carrier?.name,
              veeqoAllocation?.carrier?.name,
              veeqoAllocation?.carrier_name,
            ].filter(
              (v: unknown): v is string =>
                typeof v === "string" &&
                v.length > 0 &&
                v.toLowerCase() !== "buy shipping"
            );
            let resolvedCarrier = carrierCandidates[0] || null;
            // Fall back to deriving from service_name if nothing useful
            // came back. "UPS® Ground" → "UPS", "USPS Priority" → "USPS"
            if (!resolvedCarrier) {
              const svc = (veeqoShipment.service_name || "").toLowerCase();
              if (svc.includes("ups")) resolvedCarrier = "UPS";
              else if (svc.includes("usps") || svc.includes("priority"))
                resolvedCarrier = "USPS";
              else if (svc.includes("fedex")) resolvedCarrier = "FedEx";
              else if (svc.includes("dhl")) resolvedCarrier = "DHL";
            }
            enriched.carrier = resolvedCarrier;

            const serviceCandidates = [
              veeqoShipment.service_name,
              veeqoShipment.service?.name,
              veeqoAllocation?.service?.name,
            ].filter(
              (v: unknown): v is string =>
                typeof v === "string" && v.length > 0
            );
            enriched.service = serviceCandidates[0] || null;

            // Ship date: shipment.shipped_at → allocation.updated_at → order.shipped_at
            const shipCandidates = [
              veeqoShipment.shipped_at,
              veeqoAllocation?.updated_at,
              match.shipped_at,
            ].filter(
              (v: unknown): v is string =>
                typeof v === "string" && v.length > 0
            );
            enriched.shipDate =
              shipCandidates[0]?.split("T")[0] || null;
          }

          // Buy Shipping detection — per Vladimir's policy, ALL of our
          // labels are purchased through Amazon Buy Shipping via Veeqo.
          // Therefore: if a Veeqo shipment with a tracking number exists,
          // we used Buy Shipping. Don't try to parse employee_notes — that
          // string was unreliable and stayed false even on real Buy
          // Shipping orders, which broke claimsProtected detection
          // downstream. The "Label Purchased" check is kept as additional
          // confirmation but no longer the only signal.
          if (veeqoShipment?.tracking_number || veeqoShipment?.id) {
            enriched.boughtThroughVeeqo = true;
          }
          // Belt-and-braces: also pick up the legacy "Label Purchased"
          // marker if Veeqo set it explicitly.
          const notes = match.employee_notes || "";
          if (
            typeof notes === "string" &&
            notes.includes("Label Purchased")
          ) {
            enriched.boughtThroughVeeqo = true;
          }
          if (Array.isArray(notes)) {
            const hasLabelNote = notes.some(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (n: any) =>
                typeof n === "string"
                  ? n.includes("Label Purchased")
                  : n?.text?.includes("Label Purchased")
            );
            if (hasLabelNote) enriched.boughtThroughVeeqo = true;
          }

          // Determine product type from Veeqo product tags
          const lineItem = match.line_items?.[0];
          if (lineItem?.sellable?.product?.tags) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tags = lineItem.sellable.product.tags.map((t: any) =>
              typeof t === "string" ? t : t.name
            );
            if (tags.includes("Frozen")) enriched.productType = "Frozen";
            else if (tags.includes("Dry")) enriched.productType = "Dry";
          }
        }
      }
    }
  } catch (e) {
    console.error(
      `[Enricher] Veeqo fetch failed for ${parsed.amazonOrderId}:`,
      e instanceof Error ? e.message : e
    );
  }

  // 4. Tracking status — derive from allocation/shipment fields
  if (veeqoAllocation) {
    const allocStatus: string = veeqoAllocation.status || "";
    if (allocStatus === "delivered" || veeqoShipment?.delivery_date) {
      enriched.trackingStatus = "delivered";
      enriched.actualDelivery =
        veeqoShipment?.delivery_date?.split("T")[0] || null;
    } else if (allocStatus === "shipped" || veeqoShipment?.tracking_number) {
      enriched.trackingStatus = "in_transit";
    } else if (allocStatus === "cancelled") {
      enriched.trackingStatus = "exception";
    }
  }

  // 5. Shipment detail fetch — Veeqo's /shipments/:id endpoint exposes
  // tracking_events (for delivered detection) AND an updated
  // estimated_delivery_date field that reflects the carrier's current
  // promise, which is NOT the same as Amazon's LatestDeliveryDate (which
  // stays frozen at the original purchase promise). We need the fresh
  // carrier ETA so customer-facing templates don't quote a stale date.
  let shipDetailEstimatedDelivery: string | null = null;
  if (VEEQO_API_KEY && veeqoShipment?.id) {
    try {
      const shipDetailRes = await fetch(
        `${VEEQO_BASE_URL}/shipments/${veeqoShipment.id}`,
        { headers: { "x-api-key": VEEQO_API_KEY } }
      );
      if (shipDetailRes.ok) {
        const shipDetail = await shipDetailRes.json();
        // Try several field names — Veeqo has historically renamed this
        const estCandidates = [
          shipDetail.estimated_delivery_date,
          shipDetail.expected_delivery_date,
          shipDetail.carrier_estimated_delivery_date,
        ].filter(
          (v: unknown): v is string => typeof v === "string" && v.length > 0
        );
        if (estCandidates.length > 0) {
          shipDetailEstimatedDelivery = estCandidates[0].split("T")[0];
          console.log(
            "[Enricher] Veeqo shipment detail estimated_delivery:",
            shipDetailEstimatedDelivery
          );
        }

        if (shipDetail.delivery_date && !enriched.actualDelivery) {
          enriched.actualDelivery = shipDetail.delivery_date.split("T")[0];
          enriched.trackingStatus = "delivered";
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const events: any[] = shipDetail.tracking_events || [];
        // Detect "delivered" status from events
        if (events.length > 0 && !enriched.actualDelivery) {
          const lastEvent = events[events.length - 1];
          const descr = lastEvent?.description?.toLowerCase?.() || "";
          if (lastEvent?.status === "delivered" || descr.includes("delivered")) {
            enriched.trackingStatus = "delivered";
            enriched.actualDelivery =
              lastEvent?.happened_at?.split("T")[0] || null;
          }
        }
        // Look for an "expected delivery" event if we still don't have an ETA
        if (!shipDetailEstimatedDelivery && events.length > 0) {
          for (let i = events.length - 1; i >= 0; i--) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const e: any = events[i];
            const estField =
              e?.estimated_delivery_date ||
              e?.expected_delivery ||
              null;
            if (typeof estField === "string" && estField.length > 0) {
              shipDetailEstimatedDelivery = estField.split("T")[0];
              console.log(
                "[Enricher] Estimated delivery from tracking event:",
                shipDetailEstimatedDelivery
              );
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error(
        "[Enricher] Veeqo shipment detail failed:",
        e instanceof Error ? e.message : e
      );
    }
  }

  // 5c. Carrier direct API — UPS / FedEx Tracking. When the carrier is
  //   UPS or FedEx and we have a tracking number, fetch the carrier's own
  //   details. This is the only reliable source for the current
  //   (re-)scheduled delivery date after pickup; Veeqo's shipment endpoint
  //   doesn't expose it, and Amazon's LatestDeliveryDate is frozen at
  //   purchase time. Also pulls the full event history so the analyzer
  //   can reason over "where exactly is the package and what happened
  //   at each step". USPS will be added the same way once those keys
  //   are provisioned.
  const carrierUpper = (enriched.carrier || "").toUpperCase();
  const carrierServiceHint =
    (enriched.actualShippingService || enriched.service || "").toUpperCase();
  const carrierBlob = `${carrierUpper} ${carrierServiceHint}`;

  let carrierLookup:
    | "ups"
    | "fedex"
    | "usps"
    | null = null;
  if (carrierBlob.includes("UPS")) carrierLookup = "ups";
  else if (carrierBlob.includes("FEDEX") || carrierBlob.includes("FED EX"))
    carrierLookup = "fedex";
  else if (
    carrierBlob.includes("USPS") ||
    carrierBlob.includes("PRIORITY MAIL") ||
    carrierBlob.includes("FIRST CLASS") ||
    carrierBlob.includes("GROUND ADVANTAGE")
  )
    carrierLookup = "usps";

  if (carrierLookup && enriched.trackingNumber) {
    try {
      console.log(
        `[Enricher] ${carrierLookup.toUpperCase()} direct tracking lookup for`,
        enriched.trackingNumber
      );
      const info =
        carrierLookup === "ups"
          ? await getUpsTracking(enriched.trackingNumber)
          : carrierLookup === "fedex"
            ? await getFedexTracking(enriched.trackingNumber)
            : await getUspsTracking(enriched.trackingNumber);

      if (info) {
        console.log(
          `[Enricher] ${carrierLookup.toUpperCase()} response:`,
          JSON.stringify({
            currentStatus: info.currentStatus,
            estimatedDelivery: info.estimatedDelivery,
            actualDelivery: info.actualDelivery,
            events: info.events.length,
          })
        );

        // Carrier ETA takes priority over any Veeqo-sourced value —
        // the carrier's own data is authoritative for their shipments.
        if (info.estimatedDelivery) {
          shipDetailEstimatedDelivery = info.estimatedDelivery;
        }

        // If the carrier says delivered, propagate immediately.
        if (info.delivered && info.actualDelivery) {
          enriched.actualDelivery = info.actualDelivery;
          enriched.trackingStatus = "delivered";
        } else if (info.currentStatus && !enriched.trackingStatus) {
          const s = info.currentStatus.toLowerCase();
          if (s.includes("transit") || s.includes("on the way")) {
            enriched.trackingStatus = "in_transit";
          } else if (s.includes("exception")) {
            enriched.trackingStatus = "exception";
          }
        }

        if (info.events.length > 0) {
          enriched.trackingEvents = info.events;
        }
      }
    } catch (e) {
      console.error(
        `[Enricher] ${carrierLookup.toUpperCase()} tracking lookup failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  // 5b. Database fallback — if Veeqo didn't return tracking, pull any
  // previously-cached values. Two sources:
  //   1) AmazonOrder  — has status, latestShipDate, latestDeliveryDate
  //   2) BuyerMessage — earlier messages on the same order may already have
  //      tracking number, carrier, shipDate, actualDelivery populated from
  //      an earlier successful Veeqo lookup
  if (!enriched.trackingNumber || !enriched.shipDate) {
    try {
      const [prevMsg, amazonOrder] = await Promise.all([
        prisma.buyerMessage.findFirst({
          where: {
            amazonOrderId: parsed.amazonOrderId,
            trackingNumber: { not: null },
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.amazonOrder.findUnique({
          where: { amazonOrderId: parsed.amazonOrderId },
        }),
      ]);

      if (prevMsg) {
        console.log(
          `[Enricher] DB fallback: found cached tracking from ${prevMsg.id}`
        );
        enriched.trackingNumber ??= prevMsg.trackingNumber;
        enriched.carrier ??= prevMsg.carrier;
        enriched.service ??= prevMsg.service;
        enriched.shipDate ??= prevMsg.shipDate;
        enriched.actualDelivery ??= prevMsg.actualDelivery;
        enriched.trackingStatus ??= prevMsg.trackingStatus;
      }

      if (amazonOrder) {
        console.log(
          "[Enricher] DB fallback: found AmazonOrder with status",
          amazonOrder.status
        );
        if (!enriched.promisedEdd && amazonOrder.latestDeliveryDate) {
          enriched.promisedEdd = amazonOrder.latestDeliveryDate
            .toISOString()
            .split("T")[0];
        }
        if (!enriched.trackingStatus) {
          // Map Amazon's status to our tracking terms
          const s = (amazonOrder.status || "").toLowerCase();
          if (s === "shipped") enriched.trackingStatus = "in_transit";
          else if (s === "canceled" || s === "cancelled") {
            enriched.trackingStatus = "exception";
          }
        }
      }
    } catch (e) {
      console.error(
        "[Enricher] DB fallback failed:",
        e instanceof Error ? e.message : e
      );
    }
  }

  // 6. Transit duration — days the package has been in motion. If delivered,
  // this is the actual trip length; otherwise it counts from shipDate to
  // today so Claude knows "package has been in transit for N days".
  if (enriched.shipDate) {
    const shipDateObj = new Date(enriched.shipDate);
    const endDate = enriched.actualDelivery
      ? new Date(enriched.actualDelivery)
      : new Date();
    const diff = Math.round(
      (endDate.getTime() - shipDateObj.getTime()) / 86_400_000
    );
    enriched.daysInTransit = Number.isFinite(diff) && diff >= 0 ? diff : null;
  }

  // 7. Days late — positive values only. For in-transit orders compared to
  // today; for delivered orders compared to actual delivery date.
  if (enriched.promisedEdd) {
    const eddDate = new Date(enriched.promisedEdd);
    const compareDate = enriched.actualDelivery
      ? new Date(enriched.actualDelivery)
      : new Date();
    const diff = Math.round(
      (compareDate.getTime() - eddDate.getTime()) / 86_400_000
    );
    enriched.daysLate = diff > 0 ? diff : 0;
  }

  // 8. Shipped on time — did we ship by Amazon's latestShipDate promise?
  if (enriched.shipDate && latestShipDate) {
    enriched.shippedOnTime = enriched.shipDate <= latestShipDate;
  } else if (enriched.shipDate) {
    // Default to true if Amazon didn't return a ship-by date but we shipped
    enriched.shippedOnTime = true;
  }

  // 9. Claims Protected — Veeqo Buy Shipping AND shipped on time
  enriched.claimsProtected =
    enriched.boughtThroughVeeqo && enriched.shippedOnTime === true;

  // 9b. Carrier-self-declared delay — scan tracking events for documentary
  //     proof that the carrier itself flagged a delay/exception/late event.
  //     This is the strongest signal for "carrier fault" routing per
  //     CUSTOMER_HUB_ALGORITHM_v3.0 §9. The analyzer uses this together
  //     with claimsProtected to redirect customer to Amazon A-to-Z.
  if (enriched.trackingEvents && enriched.trackingEvents.length > 0) {
    const delayKeywords = [
      "delay",
      "delayed",
      "exception",
      "weather",
      "missed",
      "late",
      "rescheduled",
      "unable to deliver",
    ];
    enriched.carrierSelfDeclaredDelay = enriched.trackingEvents.some((e) => {
      const blob = `${e.description || ""} ${e.status || ""}`.toLowerCase();
      return delayKeywords.some((kw) => blob.includes(kw));
    });
    if (enriched.carrierSelfDeclaredDelay) {
      console.log("[Enricher] Carrier self-declared delay detected in events");
    }
  }

  // 10. Shipping service mismatch detection (T21)
  //   Compare ShipmentServiceLevelCategory from Amazon (Next Day / Expedited
  //   / Priority / Overnight) with the actual Veeqo shipping service label.
  //   If the customer paid for expedited but we shipped a ground/standard
  //   service, flag shippingMismatch=true so the analyzer prompt + UI
  //   policy guidance surface it as T21.
  enriched.actualShippingService = enriched.service;
  if (enriched.requestedShippingService && enriched.actualShippingService) {
    const requested = enriched.requestedShippingService.toLowerCase();
    const actual = enriched.actualShippingService.toLowerCase();

    const isExpedited =
      requested.includes("next") ||
      requested.includes("expedit") ||
      requested.includes("one day") ||
      requested.includes("overnight") ||
      requested.includes("priority");
    const isActualStandard =
      actual.includes("ground") ||
      actual.includes("standard") ||
      actual.includes("saver");

    enriched.shippingMismatch = isExpedited && isActualStandard;

    if (enriched.shippingMismatch) {
      console.log(
        "[Enricher] ⚠️ SHIPPING MISMATCH: Customer paid for",
        requested,
        "but shipped via",
        actual
      );
    }
  }

  // 11. Carrier estimated delivery — only trust real carrier-sourced ETAs
  //   (shipment detail fetch, then shipment-level fields). We deliberately
  //   do NOT fall back to promisedEdd here: that's Amazon's original
  //   purchase-time promise, frozen at checkout, and quoting it as a
  //   "carrier ETA" misleads customers when the real carrier has re-ETA'd.
  const estimatedCandidates = [
    shipDetailEstimatedDelivery,
    veeqoShipment?.estimated_delivery_date,
    veeqoShipment?.expected_delivery_date,
    veeqoAllocation?.estimated_delivery_date,
  ].filter(
    (v: unknown): v is string => typeof v === "string" && v.length > 0
  );
  enriched.carrierEstimatedDelivery =
    estimatedCandidates[0]?.split("T")[0] || null;

  console.log(
    "[Enricher] FINAL enriched data:",
    JSON.stringify({
      carrier: enriched.carrier,
      trackingNumber: enriched.trackingNumber,
      trackingStatus: enriched.trackingStatus,
      shipDate: enriched.shipDate,
      actualDelivery: enriched.actualDelivery,
      daysInTransit: enriched.daysInTransit,
      boughtThroughVeeqo: enriched.boughtThroughVeeqo,
      requestedShippingService: enriched.requestedShippingService,
      actualShippingService: enriched.actualShippingService,
      shippingMismatch: enriched.shippingMismatch,
      carrierEstimatedDelivery: enriched.carrierEstimatedDelivery,
    })
  );

  return enriched;
}
