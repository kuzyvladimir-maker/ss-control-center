/**
 * POST /api/shipping/walmart/rates
 *
 * Rate-shop a Walmart order through Walmart's own "Ship with Walmart" API
 * (NOT Veeqo) and return the carrier/service options + the algorithm's pick.
 * Read-only — buys nothing.
 *
 * Package dims/weight: taken from the body if provided, else from the stored
 * SkuShippingData for the order's SKU (the "default size/weight" the operator
 * referred to). Destination + ship/deliver dates come from the order.
 *
 * Body: { purchaseOrderId: string, length?, width?, height?, weight?,
 *         dimUnit?, weightUnit? }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { estimateShippingRates, type BoxInput } from "@/lib/walmart/shipping";
import { selectBestWalmartRate } from "@/lib/shipping/walmart-rate-selection";

const STORE_INDEX = 1;

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const purchaseOrderId = String(body?.purchaseOrderId ?? "").trim();
  if (!purchaseOrderId) {
    return NextResponse.json({ error: "purchaseOrderId is required" }, { status: 400 });
  }

  const client = getWalmartClient(STORE_INDEX);
  const api = new WalmartOrdersApi(client);

  let order;
  try {
    order = await api.getOrderById(purchaseOrderId);
  } catch (err) {
    if (err instanceof WalmartApiError) {
      return NextResponse.json(
        { error: err.status === 404 ? "Order not found" : `Walmart API ${err.status}` },
        { status: err.status === 404 ? 404 : 502 },
      );
    }
    throw err;
  }

  const addr = order.shippingInfo?.postalAddress;
  if (!addr?.postalCode || !addr?.city || !addr?.state) {
    return NextResponse.json({ error: "Order has no usable shipping address" }, { status: 422 });
  }

  // Resolve package dims/weight: explicit body > stored SkuShippingData.
  let box: BoxInput | null = null;
  if (
    typeof body.length === "number" &&
    typeof body.width === "number" &&
    typeof body.height === "number" &&
    typeof body.weight === "number"
  ) {
    box = {
      length: body.length,
      width: body.width,
      height: body.height,
      weight: body.weight,
      dimUnit: body.dimUnit ?? "IN",
      weightUnit: body.weightUnit ?? "LB",
    };
  } else {
    const sku = order.orderLines[0]?.sku;
    if (sku) {
      const d = await prisma.skuShippingData.findUnique({ where: { sku } });
      if (d?.length && d?.width && d?.height && d?.weight) {
        box = { length: d.length, width: d.width, height: d.height, weight: d.weight, dimUnit: "IN", weightUnit: "LB" };
      }
    }
  }
  if (!box) {
    return NextResponse.json(
      { error: "No package dimensions: pass length/width/height/weight, or add them to SkuShippingData for this SKU." },
      { status: 422 },
    );
  }

  const now = Date.now();
  const shipByDate = order.shippingInfo?.estimatedShipDate ?? new Date(now + 24 * 3600 * 1000);
  const deliverByDate = order.shippingInfo?.estimatedDeliveryDate ?? new Date(now + 5 * 24 * 3600 * 1000);

  try {
    const rates = await estimateShippingRates(client, {
      box,
      to: {
        addressLines: [addr.address1, addr.address2].filter(Boolean) as string[],
        city: addr.city,
        state: addr.state,
        postalCode: addr.postalCode,
        countryCode: addr.country === "USA" ? "US" : addr.country ?? "US",
      },
      shipByDate,
      deliverByDate,
    });
    rates.sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity));
    const selection = selectBestWalmartRate(rates);
    return NextResponse.json({
      ok: true,
      purchaseOrderId,
      box,
      rates,
      selected: selection.chosen,
      selectionReason: selection.reason,
    });
  } catch (err) {
    if (err instanceof WalmartApiError) {
      return NextResponse.json(
        { ok: false, error: `Walmart API ${err.status}`, walmart: err.errorBody },
        { status: 502 },
      );
    }
    throw err;
  }
}
