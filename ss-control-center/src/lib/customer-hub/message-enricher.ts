/**
 * Enrich parsed buyer email with SP-API order data + Veeqo tracking
 */

import { spApiGet } from "@/lib/amazon-sp-api/client";
import type { ParsedBuyerEmail } from "./gmail-parser";

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
  boughtThroughVeeqo: boolean;
  claimsProtected: boolean;
  shippedOnTime: boolean | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VeeqoShipment = any;

export async function enrichMessage(
  parsed: ParsedBuyerEmail
): Promise<EnrichedMessage> {
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
    if (order) {
      enriched.orderDate = order.PurchaseDate?.split("T")[0] || null;
      enriched.orderTotal = order.OrderTotal?.Amount
        ? parseFloat(order.OrderTotal.Amount)
        : null;
      enriched.promisedEdd = order.LatestDeliveryDate?.split("T")[0] || null;
      latestShipDate = order.LatestShipDate?.split("T")[0] || null;
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

  try {
    if (VEEQO_API_KEY) {
      const veeqoRes = await fetch(
        `${VEEQO_BASE_URL}/orders?query=${parsed.amazonOrderId}&page_size=5`,
        { headers: { "x-api-key": VEEQO_API_KEY } }
      );

      if (veeqoRes.ok) {
        const veeqoOrders = await veeqoRes.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match = veeqoOrders?.find?.((o: any) =>
          o.channel_order_id?.includes(parsed.amazonOrderId)
        );

        if (match) {
          veeqoAllocation = match.allocations?.[0];
          veeqoShipment = veeqoAllocation?.shipment || null;

          if (veeqoShipment) {
            enriched.trackingNumber = veeqoShipment.tracking_number || null;
            enriched.carrier = veeqoShipment.carrier_name || null;
            enriched.service = veeqoShipment.service_name || null;
            enriched.shipDate =
              veeqoShipment.shipped_at?.split("T")[0] || null;
          }

          // Check employee_notes for "Label Purchased"
          const notes = match.employee_notes || "";
          if (
            typeof notes === "string" &&
            notes.includes("Label Purchased")
          ) {
            enriched.boughtThroughVeeqo = true;
          }
          if (Array.isArray(notes)) {
            enriched.boughtThroughVeeqo = notes.some(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (n: any) =>
                typeof n === "string"
                  ? n.includes("Label Purchased")
                  : n?.text?.includes("Label Purchased")
            );
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

  // 5. Shipment detail fallback — fetch tracking events if we don't yet know
  // delivery date and have a shipment id. Veeqo's /shipments/:id endpoint
  // exposes tracking_events that sometimes carry a "delivered" status the
  // parent /orders query doesn't.
  if (VEEQO_API_KEY && veeqoShipment?.id && !enriched.actualDelivery) {
    try {
      const shipDetailRes = await fetch(
        `${VEEQO_BASE_URL}/shipments/${veeqoShipment.id}`,
        { headers: { "x-api-key": VEEQO_API_KEY } }
      );
      if (shipDetailRes.ok) {
        const shipDetail = await shipDetailRes.json();
        if (shipDetail.delivery_date) {
          enriched.actualDelivery = shipDetail.delivery_date.split("T")[0];
          enriched.trackingStatus = "delivered";
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const events: any[] = shipDetail.tracking_events || [];
        if (events.length > 0) {
          const lastEvent = events[events.length - 1];
          const descr = lastEvent?.description?.toLowerCase?.() || "";
          if (lastEvent?.status === "delivered" || descr.includes("delivered")) {
            enriched.trackingStatus = "delivered";
            enriched.actualDelivery =
              enriched.actualDelivery ||
              lastEvent?.happened_at?.split("T")[0] ||
              null;
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

  return enriched;
}
