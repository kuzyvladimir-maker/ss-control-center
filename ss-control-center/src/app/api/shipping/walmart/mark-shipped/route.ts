/**
 * POST /api/shipping/walmart/mark-shipped
 *
 * Manually mark a Walmart order Shipped (POST /orders/{po}/shipping), using
 * the tracking from its already-purchased Ship-with-Walmart label. This is the
 * manual counterpart to the walmart-ship-confirm cron — for when the operator
 * knows the package has gone out and wants to confirm now rather than wait for
 * the 10 PM automatic pass. No in-transit gate here: a manual click IS the
 * operator's confirmation.
 *
 * Body: { purchaseOrderId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartShipLineInput } from "@/lib/walmart/types";

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

  let labels;
  try {
    labels = await api.getLabelsByPurchaseOrder(purchaseOrderId);
  } catch (err) {
    if (err instanceof WalmartApiError) {
      return NextResponse.json({ error: `Walmart API ${err.status} fetching labels` }, { status: 502 });
    }
    throw err;
  }
  if (labels.length === 0) {
    return NextResponse.json(
      { error: "No purchased label found for this order — buy a label first." },
      { status: 409 },
    );
  }

  const shipDateTime = new Date();
  const lines: WalmartShipLineInput[] = [];
  for (const label of labels) {
    if (!label.trackingNumber) continue;
    for (const box of label.boxItems) {
      lines.push({
        lineNumber: box.lineNumber,
        quantity: box.quantity,
        shipDateTime,
        carrierName: label.carrierName,
        methodCode: "Standard",
        trackingNumber: label.trackingNumber,
        trackingUrl: label.trackingUrl,
      });
    }
  }
  if (lines.length === 0) {
    return NextResponse.json({ error: "Label has no tracking/box items to ship." }, { status: 409 });
  }

  // The operator clicked Mark as Shipped — that's an explicit "ship anyway"
  // even if the buyer requested cancellation, so we always pass the
  // intentToCancelOverride flag. Without it Walmart 400s with
  // INVALID_REQUEST_CONTENT.GMP_ORDER_API on any cancellation-flagged PO.
  // (The unattended ship-confirm cron does NOT pass this — those orders
  //  land in the watchdog Telegram alerts instead so Vladimir decides.)
  try {
    const updated = await api.shipOrderLines(purchaseOrderId, lines, {
      intentToCancelOverride: true,
    });
    return NextResponse.json({
      ok: true,
      purchaseOrderId,
      orderStatus: updated.status,
      linesShipped: lines.length,
      trackingNumbers: [...new Set(lines.map((l) => l.trackingNumber))],
    });
  } catch (err) {
    if (err instanceof WalmartApiError) {
      // Surface Walmart's verbatim error body so the operator sees the
      // real reason (e.g. "ship date must be today or later", "tracking
      // number invalid", etc.) instead of a generic "Walmart API 400".
      const detail =
        typeof err.errorBody === "object" && err.errorBody !== null
          ? (err.errorBody as Record<string, unknown>)
          : null;
      const firstErr = detail?.errors as
        | { error?: Array<{ description?: string; field?: string }> }
        | undefined;
      const desc = firstErr?.error?.[0]?.description;
      return NextResponse.json(
        {
          ok: false,
          error: desc
            ? `Walmart: ${desc}`
            : `Walmart API ${err.status}`,
          walmart: err.errorBody,
        },
        { status: 502 },
      );
    }
    throw err;
  }
}
