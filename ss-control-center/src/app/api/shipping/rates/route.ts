// GET /api/shipping/rates?orderId=<veeqo-order-id>
//
// Lists every rate Veeqo currently offers for the order's first allocation
// — the same data the plan algorithm picks from internally, but exposed
// raw so the operator can override the algorithmic choice from the
// /shipping page (PickRateDialog).
//
// Shape: { rates: Array<{ name, title, sub_carrier_id, service_carrier,
// remote_shipment_id, service_id, carrier, total_net_charge, base_rate,
// delivery_promise_date, ... }> } — same fields as VeeqoRate used by
// /api/shipping/plan.

import { NextRequest, NextResponse } from "next/server";
import {
  veeqoFetch,
  getShippingRates,
  getRatesForShipDate,
  updateOrderDispatchDate,
} from "@/lib/veeqo";
import { prisma } from "@/lib/prisma";
import { fetchSkuDatabase } from "@/lib/sku-database";
import { resolveOrderParcel } from "@/lib/shipping/order-parcel";

export async function GET(request: NextRequest) {
  const orderId = request.nextUrl.searchParams.get("orderId");
  if (!orderId || !/^\d+$/.test(orderId)) {
    return NextResponse.json(
      { error: "orderId query param (numeric Veeqo order id) is required" },
      { status: 400 },
    );
  }
  // Optional `?shipDate=YYYY-MM-DD` — re-quote as if the package dispatches on
  // that day. For Amazon orders we use the new Rate Shopping API
  // (getRatesForShipDate → preferred_shipment_date), which genuinely re-anchors
  // every rate's EDD to that ship day — exactly what Veeqo's web UI does and the
  // same path the plan card uses (Master Prompt v3.5 +
  // wiki/veeqo-rate-shopping-api.md). The OLD GET /shipping/rates endpoint has
  // NO date parameter, so the previous PUT-dispatch dance was a no-op and the
  // modal showed identical rates whatever date you picked — the exact bug this
  // fixes.
  const shipDateParam = request.nextUrl.searchParams.get("shipDate");
  const shipDate =
    shipDateParam && /^\d{4}-\d{2}-\d{2}$/.test(shipDateParam)
      ? shipDateParam
      : null;
  try {
    const order = (await veeqoFetch(`/orders/${orderId}`)) as Record<string, any>;
    const allocationId = order?.allocations?.[0]?.id;
    if (!allocationId) {
      return NextResponse.json(
        { error: "Order has no allocation — cannot fetch rates" },
        { status: 404 },
      );
    }

    const channelType = (order.channel?.type_code || "").toLowerCase();
    const isAmazon =
      channelType === "amazon" || order.channel?.name === "Merged Orders";

    // Amazon + a chosen ship date → date-anchored quote via the new API.
    //
    // CRITICAL: pass OUR catalog parcel (weight + box dims), exactly like the
    // plan/card does. Without it getRatesForShipDate falls back to Veeqo's
    // stored allocation_package — which Veeqo overwrites with an auto-
    // "SUGGESTION" package (wrong weight/dims), inflating every rate and
    // dropping some. That's the bug where the modal showed UPS 3 Day Select at
    // $35.32 while the card (and Veeqo itself) showed the real $25.38, and the
    // cheaper FedEx 2Day One Rate disappeared from the list. See
    // src/lib/shipping/order-parcel.ts.
    if (shipDate && isAmazon) {
      let parcel;
      try {
        const skuDatabase = await fetchSkuDatabase();
        parcel = await resolveOrderParcel(order, prisma, skuDatabase);
      } catch (e) {
        console.warn(
          `[rates] parcel resolve failed for order ${orderId}, quoting without it:`,
          e instanceof Error ? e.message : e,
        );
      }
      const resp = await getRatesForShipDate(
        order,
        `${shipDate}T16:00:00Z`,
        parcel,
      );
      return NextResponse.json({ rates: resp.available, shipDate });
    }

    // Fallback (non-Amazon channels, or no ship date): the old allocation-rates
    // endpoint. For non-Amazon a shipDate re-quote still does the dispatch dance
    // (harmless even though that endpoint ignores the date), preserving prior
    // behaviour for eBay/TikTok/etc.
    const origDispatch = order.dispatch_date as string | undefined;
    let movedDispatch = false;
    try {
      if (shipDate) {
        await updateOrderDispatchDate(Number(orderId), `${shipDate}T06:59:59.000Z`);
        movedDispatch = true;
        await new Promise((r) => setTimeout(r, 800));
      }
      const ratesResp = await getShippingRates(String(allocationId));
      const rates = ratesResp?.available || [];
      return NextResponse.json({ rates, shipDate });
    } finally {
      if (movedDispatch && origDispatch) {
        try {
          await updateOrderDispatchDate(Number(orderId), origDispatch);
        } catch (e) {
          console.error(
            `CRITICAL: failed to restore dispatch_date after shipDate re-quote on order ${orderId} — left at ${shipDate}. Original: ${origDispatch}`,
            e,
          );
        }
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
