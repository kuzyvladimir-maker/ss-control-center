// POST /api/shipping/veeqo-rates
//
// Re-quote a Veeqo order's shipping rates AS IF it shipped on a chosen date,
// then restore the original ship date. This is the same trick the Frozen plan
// uses (see plan/route.ts "Ship Date Trick"): Veeqo computes rates from the
// order's dispatch_date, so to quote a future day we temporarily PUT that
// date, re-fetch, and put the original back.
//
// VIEW-ONLY by design. The order's dispatch_date is always restored, so this
// never changes what gets bought — it just lets the operator see how the
// tariff / EDD shifts at a different ship day. For Amazon, the actual purchase
// still happens on the marketplace ship-by date (owner's rule).
//
// Body: { orderId: string|number, shipDate: "YYYY-MM-DD" }
// Returns: { ok, shipDate, restored, originalDispatch, rates: VeeqoRate[] }

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

export async function POST(request: NextRequest) {
  let body: { orderId?: string | number; shipDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orderId = String(body?.orderId ?? "").trim();
  const shipDate = String(body?.shipDate ?? "").trim();
  if (!orderId || !/^\d+$/.test(orderId)) {
    return NextResponse.json(
      { error: "orderId (numeric Veeqo order id) is required" },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)) {
    return NextResponse.json(
      { error: "shipDate (YYYY-MM-DD) is required" },
      { status: 400 },
    );
  }

  let order: VeeqoOrderLite;
  try {
    order = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrderLite;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  const allocationId = order?.allocations?.[0]?.id;
  if (!allocationId) {
    return NextResponse.json(
      { error: "Order has no allocation — cannot fetch rates" },
      { status: 404 },
    );
  }

  const originalDispatch = order.dispatch_date;
  // Veeqo stores dispatch_date as a UTC timestamp; the Frozen trick uses
  // T06:59:59.000Z (early-morning UTC = previous evening ET) so the day lands
  // correctly in the warehouse's timezone. Match that.
  const newDispatch = `${shipDate}T06:59:59.000Z`;

  let restored = true;
  try {
    await updateOrderDispatchDate(orderId, newDispatch);
    // Veeqo recomputes the allocation's rate cache asynchronously after the
    // order update — same ~0.8s pause the Frozen trick uses.
    await new Promise((r) => setTimeout(r, 900));
    const ratesResp = await getShippingRates(String(allocationId));
    const rates = ratesResp?.available || [];

    // Restore the original date BEFORE responding, so a slow client can't
    // leave the order parked on the explored date.
    if (originalDispatch) {
      try {
        await updateOrderDispatchDate(orderId, originalDispatch);
      } catch (e) {
        restored = false;
        console.error(
          `veeqo-rates: failed to restore dispatch_date on order ${orderId} (left as ${shipDate}). Original: ${originalDispatch}`,
          e,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      shipDate,
      restored,
      originalDispatch: originalDispatch ?? null,
      rates,
    });
  } catch (e) {
    // Best-effort restore on the error path too.
    if (originalDispatch) {
      try {
        await updateOrderDispatchDate(orderId, originalDispatch);
      } catch {
        restored = false;
      }
    }
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        restored,
      },
      { status: 502 },
    );
  }
}
