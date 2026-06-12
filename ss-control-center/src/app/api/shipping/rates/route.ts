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
  updateOrderDispatchDate,
} from "@/lib/veeqo";

interface VeeqoOrderLite {
  id?: string | number;
  dispatch_date?: string;
  allocations?: Array<{ id?: string | number }>;
}

export async function GET(request: NextRequest) {
  const orderId = request.nextUrl.searchParams.get("orderId");
  if (!orderId || !/^\d+$/.test(orderId)) {
    return NextResponse.json(
      { error: "orderId query param (numeric Veeqo order id) is required" },
      { status: 400 },
    );
  }
  // Optional `?shipDate=YYYY-MM-DD` — re-quote as if the package dispatches on
  // that day. Veeqo derives every rate's EDD (and any weekend surcharge) from
  // the order's dispatch_date, so to see the rates for a different ship day we
  // PUT dispatch_date → re-quote → restore. Lets the rate modal recompute when
  // the operator changes the ship date (mirrors the plan route's behaviour).
  const shipDateParam = request.nextUrl.searchParams.get("shipDate");
  const shipDate =
    shipDateParam && /^\d{4}-\d{2}-\d{2}$/.test(shipDateParam)
      ? shipDateParam
      : null;
  try {
    const order = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrderLite;
    const allocationId = order?.allocations?.[0]?.id;
    if (!allocationId) {
      return NextResponse.json(
        { error: "Order has no allocation — cannot fetch rates" },
        { status: 404 },
      );
    }

    const origDispatch = order.dispatch_date;
    let movedDispatch = false;
    try {
      if (shipDate) {
        await updateOrderDispatchDate(Number(orderId), `${shipDate}T06:59:59.000Z`);
        movedDispatch = true;
        // Veeqo recomputes the allocation's rate cache asynchronously.
        await new Promise((r) => setTimeout(r, 800));
      }
      const ratesResp = await getShippingRates(String(allocationId));
      const rates = ratesResp?.available || [];
      return NextResponse.json({ rates, shipDate });
    } finally {
      // Always restore — the dispatch dance for the actual purchase happens in
      // /api/shipping/buy from the plan item's physicalShipDate, not here.
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
