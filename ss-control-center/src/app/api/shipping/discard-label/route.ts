// POST /api/shipping/discard-label
//
// Body: { orderId: string }
//
// Cancels the already-bought shipping label for an order. Routes by
// channel:
//   - Amazon → POST /shipping/shipments/{shipment_id}/refund in Veeqo
//   - Walmart → DELETE /v3/shipping/labels/carriers/{carrier}/trackings/{tracking}
//     via the Walmart Shipping API (using the existing
//     discardShippingLabel helper).
//
// After a successful cancel Veeqo/Walmart flip the order back to
// `awaiting_fulfillment` / `Acknowledged`, so on next dashboard refresh
// the row reverts to "ready to buy" — operator can re-quote a fresh
// label without dropping the order out of Shipping Labels.

import { NextRequest, NextResponse } from "next/server";
import { veeqoFetch } from "@/lib/veeqo/client";
import { refundShipmentForOrder } from "@/lib/veeqo/refund";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { discardShippingLabel } from "@/lib/walmart/shipping";

export const dynamic = "force-dynamic";

interface Body {
  orderId?: string;
}

interface VeeqoOrderForDiscard {
  id?: string | number;
  number?: string;
  channel?: { type_code?: string; name?: string } | null;
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body falls back to ?orderId= */
  }
  const orderId =
    body.orderId ?? new URL(req.url).searchParams.get("orderId") ?? "";
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  try {
    // Figure out the channel from the Veeqo order itself — frontend
    // could lie / be stale, server-side is the source of truth.
    const order = (await veeqoFetch(
      `/orders/${orderId}`,
    )) as VeeqoOrderForDiscard;
    const channelType = (order?.channel?.type_code ?? "").toLowerCase();
    const orderNumber = String(order?.number ?? orderId);

    if (channelType === "walmart") {
      const client = getWalmartClient(1);
      const api = new WalmartOrdersApi(client);
      const labels = await api.getLabelsByPurchaseOrder(orderNumber);
      if (labels.length === 0) {
        return NextResponse.json(
          { error: "No Walmart label found for this order" },
          { status: 404 },
        );
      }
      // In our flow there's only ever one label per Walmart order,
      // but defensively discard every label we see.
      const discarded: Array<{ carrier: string; tracking: string }> = [];
      for (const l of labels) {
        if (!l.trackingNumber || !l.carrierName) continue;
        // Walmart returns carrierName as the short code Walmart's
        // discard endpoint accepts (FedEx / UPS / USPS / etc.).
        await discardShippingLabel(client, l.carrierName, l.trackingNumber);
        discarded.push({
          carrier: l.carrierName,
          tracking: l.trackingNumber,
        });
      }
      return NextResponse.json({
        ok: true,
        channel: "walmart",
        orderId,
        orderNumber,
        discarded,
      });
    }

    // Amazon (and anything else that buys through Veeqo).
    const result = await refundShipmentForOrder(orderId);
    return NextResponse.json({
      ok: true,
      channel: channelType || "amazon",
      orderId,
      orderNumber,
      shipmentId: result.shipmentId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[shipping/discard-label]", { orderId, error: e });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
