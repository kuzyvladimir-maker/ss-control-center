/**
 * Buy a NAN Health (Shopify) label from the Command Center through Shopify's
 * official `shippingLabelPurchase` (see src/lib/shipping/nan-shopify-buy.ts).
 *
 *   POST /api/shipping/nan-buy  {orderNumber, carrierCode, serviceCode,
 *        carrier, service, price, pkg:{l,w,h,weight_lb}, product?, qty?}
 *   GET  /api/shipping/nan-buy?order=1379   state of the last purchase
 *        (settles a purchase Shopify was still processing)
 *   GET  /api/shipping/nan-buy?config=1     {configured} — the page offers the
 *        API purchase only when the NAN app credentials are set
 *
 * Duplicate guard — money moves here:
 *   1. Shopify first: the order must have an OPEN fulfillment order and no
 *      tracking number. A label bought anywhere (here or in Shopify admin)
 *      blocks a second one.
 *   2. A per-order lock row (Setting `nan_label_buy:<order>`) is written
 *      BEFORE the mutation. If that write fails we don't buy.
 *   3. The mutation is sent once. An unknown outcome is recorded as such and
 *      never re-sent; only a synchronous refusal or PURCHASE_FAILED (nothing
 *      bought) frees the order for another try.
 * FedEx is refused here: the official mutation can't buy it (Shopify admin).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, prismaBulk } from "@/lib/prisma";
import { uploadLabelPdf } from "@/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "@/lib/shipping-label-files";
import { todayNY } from "@/lib/shipping/dates";
import { normOrderNumber } from "@/lib/shipping/nan-rates";
import {
  NanShopifyConfigError,
  findNanOrder,
  nanShopifyConfigured,
  purchaseNanLabel,
  readNanPurchase,
  waitNanPurchase,
  type NanPurchaseResult,
} from "@/lib/shipping/nan-shopify-buy";

export const maxDuration = 120;

type LockState = "sending" | "pending" | "bought" | "failed" | "unknown";
interface Lock {
  state: LockState;
  at: string;
  resultId?: string;
  rate: { carrier: string; service: string; price: number | null; carrierCode: string; serviceCode: string };
  product?: string;
  qty?: number;
  tracking?: string | null;
  labelUrl?: string | null;
  errors?: string[];
}

const lockKey = (order: string) => `nan_label_buy:${order}`;

async function readLock(order: string): Promise<Lock | null> {
  const row = await prisma.setting.findUnique({ where: { key: lockKey(order) } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Lock;
  } catch {
    return null;
  }
}

async function writeLock(order: string, lock: Lock): Promise<void> {
  await prisma.setting.update({
    where: { key: lockKey(order) },
    data: { value: JSON.stringify(lock) },
  });
}

/** Lock updates after the purchase are bookkeeping: a failure is logged,
 *  never turned into an error for a label that may already be bought. */
async function writeLockQuietly(order: string, lock: Lock): Promise<void> {
  try {
    await writeLock(order, lock);
  } catch (e) {
    console.error(`[nan-buy] lock update failed for #${order} (${lock.state}):`, e instanceof Error ? e.message : e);
  }
}

/** PURCHASED → save the PDF to Drive, record the row in our plan, close the lock. */
async function finalize(order: string, lock: Lock, result: NanPurchaseResult) {
  const label = result.labels.find((l) => l.trackingNumber) ?? result.labels[0] ?? null;
  const tracking = label?.trackingNumber ?? null;
  let labelUrl = label?.pdfUrl ?? null;
  let pdfBase64: string | null = null;
  let driveFileId: string | null = null;
  let driveError: string | null = null;

  if (label?.pdfUrl) {
    try {
      const res = await fetch(label.pdfUrl, { signal: AbortSignal.timeout(30_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.slice(0, 5).toString("ascii") === "%PDF-") {
        pdfBase64 = buf.toString("base64");
        const item = {
          edd: null,
          deliveryBy: null,
          product: lock.product || `NAN #${order}`,
          qty: lock.qty ?? 1,
          actualShipDay: todayNY(),
          channel: "NAN health",
          channelKind: "Shopify",
        };
        const drive = await uploadLabelPdf({
          folderSegments: buildFolderPath(item).split("/"),
          filename: buildPdfFilename(item),
          pdf: buf,
        });
        if (drive.ok) {
          labelUrl = drive.result.webViewLink;
          driveFileId = drive.result.fileId;
        } else {
          driveError = drive.reason;
        }
      } else {
        driveError = `label PDF download: HTTP ${res.status}`;
      }
    } catch (e) {
      driveError = e instanceof Error ? e.message : String(e);
    }
  }

  // Our own record, so "bought today" and the order history include NAN.
  try {
    const plan = await prismaBulk.shippingPlan.create({
      data: { date: todayNY(), status: "completed" },
    });
    await prismaBulk.shippingPlanItem.create({
      data: {
        planId: plan.id,
        orderNumber: `#${order}`,
        orderId: `shopify:${order}`,
        channel: "NAN health",
        channelKind: "Shopify",
        product: lock.product || `NAN #${order}`,
        qty: lock.qty ?? 1,
        productType: "Dry",
        carrier: lock.rate.carrier,
        service: lock.rate.service,
        price: lock.rate.price,
        status: "bought",
        trackingNumber: tracking,
        labelPdfUrl: labelUrl,
        actualShipDay: todayNY(),
        notes: "Bought via Shopify shippingLabelPurchase",
      },
    });
  } catch (e) {
    console.error(`[nan-buy] #${order} bought (${tracking}) but the plan row failed:`, e instanceof Error ? e.message : e);
  }

  await writeLockQuietly(order, { ...lock, state: "bought", tracking, labelUrl });
  return {
    ok: true,
    state: "bought" as const,
    orderNumber: `#${order}`,
    tracking,
    trackingUrl: label?.trackingUrl ?? null,
    carrier: lock.rate.carrier,
    service: lock.rate.service,
    price: lock.rate.price,
    labelUrl,
    pdfBase64,
    driveFileId,
    driveError,
  };
}

export async function POST(request: NextRequest) {
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const order = normOrderNumber(b?.orderNumber);
  const carrierCode = String(b?.carrierCode ?? "").trim();
  const serviceCode = String(b?.serviceCode ?? "").trim();
  const pkg = (b?.pkg ?? {}) as Record<string, unknown>;
  const l = Number(pkg.l), w = Number(pkg.w), h = Number(pkg.h), weightLb = Number(pkg.weight_lb);
  if (!order || !carrierCode || !serviceCode || ![l, w, h, weightLb].every((n) => Number.isFinite(n) && n > 0)) {
    return NextResponse.json(
      { error: "orderNumber, carrierCode, serviceCode and pkg {l,w,h,weight_lb} are required" },
      { status: 400 },
    );
  }
  if (carrierCode.toLowerCase().startsWith("fedex")) {
    return NextResponse.json(
      { error: "Shopify's label API can't buy FedEx — buy this one in Shopify admin.", code: "FEDEX_NOT_SUPPORTED" },
      { status: 400 },
    );
  }

  const lock: Lock = {
    state: "sending",
    at: new Date().toISOString(),
    rate: {
      carrier: String(b?.carrier ?? carrierCode),
      service: String(b?.service ?? serviceCode),
      price: Number.isFinite(Number(b?.price)) ? Number(b?.price) : null,
      carrierCode,
      serviceCode,
    },
    product: typeof b?.product === "string" ? b.product : undefined,
    qty: Number.isFinite(Number(b?.qty)) ? Number(b?.qty) : undefined,
  };

  let fulfillmentOrderId = "";
  try {
    // 1. Our lock: a purchase that is running, done or of unknown outcome blocks.
    const prev = await readLock(order);
    if (prev && prev.state !== "failed") {
      return NextResponse.json(
        {
          error:
            prev.state === "bought"
              ? `Already bought here: ${prev.rate.carrier} ${prev.rate.service}, tracking ${prev.tracking ?? "?"}.`
              : `A purchase for #${order} is ${prev.state === "unknown" ? "of unknown outcome" : "in progress"} — check the order in Shopify, do not buy again.`,
          code: "ALREADY_ATTEMPTED",
          state: prev.state,
          tracking: prev.tracking ?? null,
        },
        { status: 409 },
      );
    }

    // 2. Shopify: still open, no label on it.
    const so = await findNanOrder(order);
    if (!so) {
      return NextResponse.json({ error: `NAN order #${order} not found in Shopify` }, { status: 404 });
    }
    if (so.trackingNumbers.length > 0 || !so.openFulfillmentOrderId) {
      return NextResponse.json(
        {
          error: `#${order} already has a label / is ${so.displayFulfillmentStatus.toLowerCase()} in Shopify${so.trackingNumbers.length ? ` (tracking ${so.trackingNumbers.join(", ")})` : ""}.`,
          code: "ALREADY_FULFILLED",
        },
        { status: 409 },
      );
    }
    fulfillmentOrderId = so.openFulfillmentOrderId;

    // 3. Take the lock BEFORE spending money. If this write fails we stop.
    if (prev) {
      const taken = await prisma.setting.updateMany({
        where: { key: lockKey(order), value: JSON.stringify(prev) },
        data: { value: JSON.stringify(lock) },
      });
      if (taken.count !== 1) {
        return NextResponse.json({ error: "Another purchase for this order just started", code: "ALREADY_ATTEMPTED" }, { status: 409 });
      }
    } else {
      await prisma.setting.create({ data: { key: lockKey(order), value: JSON.stringify(lock) } });
    }
  } catch (e) {
    if (e instanceof NanShopifyConfigError) {
      return NextResponse.json({ error: e.message, code: "NOT_CONFIGURED" }, { status: 503 });
    }
    const unique = (e as { code?: string })?.code === "P2002";
    return NextResponse.json(
      {
        error: unique
          ? "Another purchase for this order just started"
          : `Nothing was bought — couldn't check or lock the order: ${e instanceof Error ? e.message.split("\n").pop() : e}`,
        code: unique ? "ALREADY_ATTEMPTED" : "PRECHECK_FAILED",
      },
      { status: unique ? 409 : 503 },
    );
  }

  // 4. The purchase — sent once, never re-sent.
  let sent: Awaited<ReturnType<typeof purchaseNanLabel>>;
  try {
    sent = await purchaseNanLabel({
      fulfillmentOrderId,
      carrierCode,
      serviceCode,
      pkg: { l, w, h, weightLb },
    });
  } catch (e) {
    await writeLockQuietly(order, { ...lock, state: "unknown", errors: [String(e instanceof Error ? e.message : e)] });
    return NextResponse.json(
      {
        error: "Shopify didn't answer — the label may or may not be bought. Do NOT buy again: check the order in Shopify first.",
        code: "OUTCOME_UNKNOWN",
      },
      { status: 502 },
    );
  }
  if ("errors" in sent) {
    await writeLockQuietly(order, { ...lock, state: "failed", errors: sent.errors });
    return NextResponse.json(
      { error: `Shopify refused, nothing bought: ${sent.errors.join("; ")}`, code: "REFUSED", errors: sent.errors },
      { status: 422 },
    );
  }

  const pending: Lock = { ...lock, state: "pending", resultId: sent.resultId };
  await writeLockQuietly(order, pending);
  const result = await waitNanPurchase(sent.resultId, 40_000);
  if (result.status === "PURCHASED") {
    return NextResponse.json(await finalize(order, pending, result));
  }
  if (result.status === "PURCHASE_FAILED") {
    await writeLockQuietly(order, { ...pending, state: "failed", errors: result.errors });
    return NextResponse.json(
      { error: `Shopify couldn't buy the label, nothing charged: ${result.errors.join("; ") || "no reason given"}`, code: "PURCHASE_FAILED" },
      { status: 422 },
    );
  }
  return NextResponse.json(
    { ok: true, state: "pending", message: "Shopify is still processing the purchase — check again in a minute.", orderNumber: `#${order}` },
    { status: 202 },
  );
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.has("config")) {
    return NextResponse.json({ configured: nanShopifyConfigured() });
  }
  const order = normOrderNumber(request.nextUrl.searchParams.get("order"));
  if (!order) return NextResponse.json({ error: "order is required" }, { status: 400 });
  try {
    const lock = await readLock(order);
    if (!lock) return NextResponse.json({ state: null });
    if (lock.state === "pending" && lock.resultId) {
      const result = await readNanPurchase(lock.resultId);
      if (result.status === "PURCHASED") return NextResponse.json(await finalize(order, lock, result));
      if (result.status === "PURCHASE_FAILED") {
        await writeLockQuietly(order, { ...lock, state: "failed", errors: result.errors });
        return NextResponse.json({ state: "failed", errors: result.errors });
      }
    }
    return NextResponse.json({
      state: lock.state,
      tracking: lock.tracking ?? null,
      labelUrl: lock.labelUrl ?? null,
      rate: lock.rate,
      errors: lock.errors ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
