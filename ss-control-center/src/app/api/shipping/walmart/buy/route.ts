/**
 * POST /api/shipping/walmart/buy
 *
 * Buy a Ship-with-Walmart label for a Walmart order DIRECTLY through Walmart
 * (replaces the Veeqo buy for Walmart orders). Critically, this does NOT mark
 * the order Shipped — it stays Acknowledged, and the walmart-ship-confirm cron
 * (or the manual mark-shipped endpoint) confirms it once the package moves.
 *
 * Body: { purchaseOrderId, carrierName, serviceType,
 *         length, width, height, weight, dimUnit?, weightUnit?, packageType? }
 *
 * Pre-flight: refuses to buy if the order is Cancelled / has no shippable
 * lines (same intent as /api/shipping-labels/walmart/verify).
 *
 * Label PDF → Google Drive: best-effort. Walmart's label download is
 * base64-wrapped JSON (not raw %PDF), so the decode is defensive and
 * non-fatal — a Drive failure never blocks the purchase. (Exact base64 field
 * to be confirmed against a live buy; tracking is always returned.)
 */

import { NextRequest, NextResponse } from "next/server";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { buyShippingLabel, downloadLabelPdf, type BoxInput } from "@/lib/walmart/shipping";
import { uploadLabelPdf } from "@/lib/google-drive";
import { buildPdfFilename, buildFolderPath } from "@/lib/shipping-label-files";

const STORE_INDEX = 1;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Try to pull a PDF buffer out of Walmart's label-download response. */
async function extractPdf(res: Response): Promise<Buffer | null> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length >= 1000 && buf.slice(0, 5).toString("ascii") === "%PDF-") return buf;
  // Otherwise it's likely JSON with a base64 label payload — probe common fields.
  try {
    const j = JSON.parse(buf.toString("utf-8"));
    const cand =
      j?.labelData ?? j?.label ?? j?.data?.labelData ?? j?.data?.label ?? j?.payload?.labelData;
    if (typeof cand === "string" && cand.length > 100) {
      const pdf = Buffer.from(cand, "base64");
      if (pdf.slice(0, 5).toString("ascii") === "%PDF-") return pdf;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const purchaseOrderId = String(body?.purchaseOrderId ?? "").trim();
  const carrierName = String(body?.carrierName ?? "").trim();
  const serviceType = String(body?.serviceType ?? "").trim();
  const length = num(body?.length), width = num(body?.width), height = num(body?.height), weight = num(body?.weight);
  if (!purchaseOrderId || !carrierName || !serviceType) {
    return NextResponse.json({ error: "purchaseOrderId, carrierName, serviceType are required" }, { status: 400 });
  }
  if (length === null || width === null || height === null || weight === null) {
    return NextResponse.json({ error: "length, width, height, weight are required numbers" }, { status: 400 });
  }
  const box: BoxInput = { length, width, height, weight, dimUnit: body?.dimUnit ?? "IN", weightUnit: body?.weightUnit ?? "LB" };
  const packageType = body?.packageType ?? "CUSTOM_PACKAGE";

  const client = getWalmartClient(STORE_INDEX);
  const api = new WalmartOrdersApi(client);

  // Pre-flight: fetch order, refuse if Cancelled / no shippable lines.
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
  if (order.status === "Cancelled") {
    return NextResponse.json({ error: "Order is Cancelled — refusing to buy a label." }, { status: 409 });
  }

  // Double-buy guard: if a label already exists for this PO, refuse. The
  // order stays Acknowledged after a buy (Veeqo/Walmart don't flip it), so the
  // UI can't always tell — this server-side check prevents a second paid
  // label. Discard the existing one first to re-buy.
  try {
    const existing = await api.getLabelsByPurchaseOrder(purchaseOrderId);
    if (existing.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `A label was already purchased for this order (tracking ${existing[0].trackingNumber}, ${existing[0].carrierName}). Discard it before buying again.`,
          alreadyBought: true,
          trackingNumber: existing[0].trackingNumber,
        },
        { status: 409 },
      );
    }
  } catch {
    /* label lookup failed — proceed; createLabel itself will error if dup */
  }
  const boxItems = order.orderLines
    .filter((l) => l.orderedQty > 0)
    .map((l) => ({ sku: l.sku, quantity: l.orderedQty, lineNumber: String(l.lineNumber) }));
  if (boxItems.length === 0) {
    return NextResponse.json({ error: "Order has no shippable lines." }, { status: 409 });
  }

  // Buy the label.
  let result;
  try {
    result = await buyShippingLabel(client, {
      purchaseOrderId,
      carrierName,
      carrierServiceType: serviceType,
      box,
      boxItems,
      packageType,
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

  // Best-effort label PDF → Google Drive (never blocks the buy).
  let pdfSaved = false;
  let labelPath: string | null = null;
  let driveError: string | null = null;
  if (result.trackingNumber) {
    try {
      const res = await downloadLabelPdf(client, carrierName, result.trackingNumber);
      const pdf = await extractPdf(res as Response);
      if (pdf) {
        // Match the existing Veeqo flow's Drive layout + filename (full
        // product title, EDD/DL prefix, "MM Month/DD/Walmart" folder).
        const product = order.orderLines.map((l) => l.productName).filter(Boolean).join(" + ") || purchaseOrderId;
        const qty = order.orderLines.reduce((s, l) => s + (l.orderedQty || 0), 0);
        const deliveryBy = order.shippingInfo?.estimatedDeliveryDate?.toISOString().slice(0, 10) ?? null;
        const edd = typeof body?.edd === "string" ? body.edd.slice(0, 10) : deliveryBy;
        // File the label under the operator's chosen ship date (the day the
        // package actually ships), not the moment of purchase. Falls back to
        // today if the UI didn't pass one.
        const shipDay =
          typeof body?.shipByDate === "string" && body.shipByDate
            ? body.shipByDate.slice(0, 10)
            : new Date().toISOString().slice(0, 10);
        const drive = await uploadLabelPdf({
          folderSegments: buildFolderPath({ actualShipDay: shipDay, channel: "Walmart", channelKind: "Walmart" }).split("/"),
          filename: buildPdfFilename({ edd, deliveryBy, product, qty }),
          pdf,
        });
        if (drive.ok) { pdfSaved = true; labelPath = drive.result.webViewLink; }
        else driveError = drive.reason;
      } else {
        driveError = "Could not extract PDF from Walmart label response (format unconfirmed).";
      }
    } catch (e) {
      driveError = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({
    ok: true,
    purchaseOrderId: result.purchaseOrderId,
    trackingNumber: result.trackingNumber,
    carrierName: result.carrierName,
    serviceType: result.carrierServiceType,
    pdfSaved,
    labelPath,
    driveError,
    note: "Label bought. Order is still Acknowledged — not marked Shipped. Use the cron or /api/shipping/walmart/mark-shipped to confirm shipment once the package moves.",
  });
}
