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
  daysLate: number | null;
  boughtThroughVeeqo: boolean;
  claimsProtected: boolean;
  shippedOnTime: boolean | null;
}

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
    daysLate: null,
    boughtThroughVeeqo: false,
    claimsProtected: false,
    shippedOnTime: null,
  };

  if (!parsed.amazonOrderId) return enriched;

  const storeId = `store${parsed.storeIndex}`;

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
  try {
    const VEEQO_API_KEY = process.env.VEEQO_API_KEY;
    const VEEQO_BASE_URL =
      process.env.VEEQO_BASE_URL || "https://api.veeqo.com";

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
          const alloc = match.allocations?.[0];
          const shipment = alloc?.shipment;

          if (shipment) {
            enriched.trackingNumber = shipment.tracking_number || null;
            enriched.carrier = shipment.carrier_name || null;
            enriched.service = shipment.service_name || null;
            enriched.shipDate = shipment.shipped_at?.split("T")[0] || null;
          }

          // Check employee_notes for "Label Purchased"
          const notes = match.employee_notes || "";
          if (
            typeof notes === "string" &&
            notes.includes("Label Purchased")
          ) {
            enriched.boughtThroughVeeqo = true;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Calculate daysLate if we have delivery data
  if (enriched.promisedEdd && enriched.actualDelivery) {
    const edd = new Date(enriched.promisedEdd);
    const actual = new Date(enriched.actualDelivery);
    const diff = Math.round(
      (actual.getTime() - edd.getTime()) / (1000 * 60 * 60 * 24)
    );
    enriched.daysLate = diff > 0 ? diff : null;
  }

  return enriched;
}
