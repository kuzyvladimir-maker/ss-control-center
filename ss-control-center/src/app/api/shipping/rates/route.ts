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
import { veeqoFetch, getShippingRates } from "@/lib/veeqo";

interface VeeqoOrderLite {
  id?: string | number;
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
  try {
    const order = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrderLite;
    const allocationId = order?.allocations?.[0]?.id;
    if (!allocationId) {
      return NextResponse.json(
        { error: "Order has no allocation — cannot fetch rates" },
        { status: 404 },
      );
    }
    const ratesResp = await getShippingRates(String(allocationId));
    const rates = ratesResp?.available || [];
    return NextResponse.json({ rates });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
