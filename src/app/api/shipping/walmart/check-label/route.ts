/**
 * POST /api/shipping/walmart/check-label
 *
 * Lightweight "is a label already on file for this PO?" check. Used by the
 * Shipping page to detect labels Vladimir bought MANUALLY on Walmart
 * Seller Center (instead of through our Buy flow) — so those orders stop
 * showing the "Add SKU data" / "Awaiting rate" friction and instead route
 * to the Awaiting ship-confirm tab with the carrier/service Walmart returns.
 *
 * Differs from /api/shipping/walmart/rates: we DON'T fetch the order, DON'T
 * resolve dimensions, DON'T rate-shop. One Walmart API call per order
 * (getLabelsByPurchaseOrder) keeps the per-page-load cost manageable when
 * we batch this across 50+ need_attention rows.
 *
 * Body: { purchaseOrderId: string }
 * Returns: { ok, alreadyBought, existingLabel: { trackingNumber, carrierName,
 *           carrierServiceType, trackingUrl } | null }
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";

const STORE_INDEX = 1;

export async function POST(request: NextRequest) {
  let body: { purchaseOrderId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const purchaseOrderId =
    typeof body.purchaseOrderId === "string"
      ? body.purchaseOrderId.trim()
      : "";
  if (!purchaseOrderId) {
    return NextResponse.json(
      { error: "purchaseOrderId is required" },
      { status: 400 },
    );
  }

  try {
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);
    const labels = await api.getLabelsByPurchaseOrder(purchaseOrderId);
    if (labels.length === 0 || !labels[0].trackingNumber) {
      return NextResponse.json({
        ok: true,
        alreadyBought: false,
        orderStatus: null,
        existingLabel: null,
      });
    }
    // When a label IS on file, also fetch the order status — the frontend's
    // shipped-order filter needs orderStatus === "Shipped" to hide
    // already-done rows after a refresh. Without this the row keeps
    // reappearing in Awaiting ship-confirm even though we already marked
    // it Shipped on Walmart. Extra API call only fires when there's
    // actually a label, so the cost only hits orders we already care about.
    let orderStatus: string | null = null;
    try {
      const order = await api.getOrderById(purchaseOrderId);
      orderStatus = order.status ?? null;
    } catch {
      /* status fetch is best-effort — fall through */
    }
    const l = labels[0];
    return NextResponse.json({
      ok: true,
      alreadyBought: true,
      orderStatus,
      existingLabel: {
        trackingNumber: l.trackingNumber,
        carrierName: l.carrierName,
        carrierServiceType: l.carrierServiceType ?? null,
        trackingUrl: l.trackingUrl ?? null,
      },
    });
  } catch (err) {
    if (err instanceof WalmartApiError) {
      // 404 on labels endpoint = no label exists yet → treat as a clean
      // "no label", not an error. Other statuses bubble up so the caller
      // can decide whether to surface them.
      if (err.status === 404) {
        return NextResponse.json({
          ok: true,
          alreadyBought: false,
          orderStatus: null,
          existingLabel: null,
        });
      }
      return NextResponse.json(
        { ok: false, error: `Walmart API ${err.status}` },
        { status: 502 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[walmart/check-label]", purchaseOrderId, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
