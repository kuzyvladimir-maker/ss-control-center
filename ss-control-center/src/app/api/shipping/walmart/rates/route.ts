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
import { effectiveBusinessDay } from "@/lib/shipping/dates";
import {
  buildPackingSignature,
  requiresPackingProfile,
} from "@/lib/shipping/packing-signature";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";

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

  // If a label was already bought (or the order is already Shipped), skip the
  // rate quote and tell the UI — so the row shows "bought / not yet shipped"
  // (or "shipped") instead of offering to buy again.
  const orderStatus = order.status;
  let existingLabel: {
    trackingNumber: string;
    carrierName: string;
    trackingUrl?: string;
  } | null = null;
  try {
    const labels = await api.getLabelsByPurchaseOrder(purchaseOrderId);
    if (labels.length > 0 && labels[0].trackingNumber) {
      existingLabel = {
        trackingNumber: labels[0].trackingNumber,
        carrierName: labels[0].carrierName,
        trackingUrl: labels[0].trackingUrl,
      };
    }
  } catch {
    /* label lookup failed — fall through to normal rate quote */
  }
  if (existingLabel || orderStatus === "Shipped") {
    return NextResponse.json({
      ok: true,
      purchaseOrderId,
      orderStatus,
      alreadyBought: !!existingLabel,
      existingLabel,
      rates: [],
      selected: null,
    });
  }

  // Resolve package dims/weight using the SAME rule as the Veeqo plan, so
  // dims are remembered per SKU+QUANTITY:
  //   - explicit body override wins;
  //   - multi-item OR single-SKU×qty>1 → PackingProfile keyed by the
  //     "SKU:qty" signature (so a 7-pack ×1 and ×2 get DIFFERENT boxes);
  //   - single SKU ×1 → SkuShippingData (per-SKU).
  // boxSize (preset label or "LxWxH") is resolved to numeric L/W/H.
  let box: BoxInput | null = null;
  let dimsSource = "none";

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
    dimsSource = "override";
  } else {
    const lines = order.orderLines
      .filter((l) => l.sku && l.orderedQty > 0)
      .map((l) => ({ sku: l.sku as string, quantity: l.orderedQty }));

    if (requiresPackingProfile(lines)) {
      const signature = buildPackingSignature(lines);
      const profile = await prisma.packingProfile.findUnique({ where: { signature } });
      const dims = profile ? resolveBoxDimensions(profile.boxSize) : null;
      if (profile && dims) {
        box = { ...dims, weight: profile.weight, dimUnit: "IN", weightUnit: "LB" };
        dimsSource = `packing_profile:${signature}`;
      }
    } else {
      const sku = lines[0]?.sku;
      if (sku) {
        const d = await prisma.skuShippingData.findUnique({ where: { sku } });
        if (d?.length && d?.width && d?.height && d?.weight) {
          box = {
            length: d.length,
            width: d.width,
            height: d.height,
            weight: d.weight,
            dimUnit: "IN",
            weightUnit: "LB",
          };
          dimsSource = `sku_shipping_data:${sku}`;
        }
      }
    }
  }

  if (!box) {
    const lines = order.orderLines
      .filter((l) => l.sku && l.orderedQty > 0)
      .map((l) => ({ sku: l.sku as string, quantity: l.orderedQty }));
    const needsProfile = requiresPackingProfile(lines);
    return NextResponse.json(
      {
        ok: false,
        error: needsProfile
          ? `No saved package for this SKU+quantity (${buildPackingSignature(lines)}). Set the box/weight and Save — it'll be remembered for this exact quantity.`
          : "No package dimensions for this SKU yet. Set the box/weight and Save.",
        needsDimensions: true,
      },
      { status: 422 },
    );
  }

  // Ship date: operator can override (the editable ship-date control) to
  // re-quote against a different dispatch day; otherwise the order's
  // estimated ship date (or tomorrow). Walmart estimates differ by ship date.
  const now = Date.now();
  const requestedShipByDate: string | Date =
    typeof body.shipByDate === "string" && body.shipByDate
      ? body.shipByDate
      : order.shippingInfo?.estimatedShipDate ?? new Date(now + 24 * 3600 * 1000);
  const deliverByDate: string | Date =
    typeof body.deliverByDate === "string" && body.deliverByDate
      ? body.deliverByDate
      : order.shippingInfo?.estimatedDeliveryDate ?? new Date(now + 5 * 24 * 3600 * 1000);

  // Walmart doesn't ship on Saturdays/Sundays/US federal holidays — push
  // the quoted ship date forward to the next business day so the rate
  // we get back reflects the day the package will really leave.
  // (Amazon's /plan does this via computeLabelDate; the Walmart path
  // missed it after the rate-source swap, leaving Sunday rates being
  // quoted against today.)
  const requestedYmd =
    typeof requestedShipByDate === "string"
      ? requestedShipByDate.slice(0, 10)
      : new Date(requestedShipByDate).toISOString().slice(0, 10);
  const shipByDate = effectiveBusinessDay(requestedYmd);

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
      orderStatus,
      alreadyBought: false,
      existingLabel: null,
      box,
      dimsSource,
      shipByDate,
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
