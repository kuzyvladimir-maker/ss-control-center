/**
 * POST /api/procurement/inquire-quantity
 *
 * Sends a polite "did you mean this quantity?" email to a Walmart buyer
 * through their per-order relay address, from the registered Sirius CS mailbox
 * (info.siriustrading@gmail.com), and records a WalmartCustomerInquiry row so
 * the procurement card can show "Спросили · ждём ответ" and the poll cron can
 * later surface the reply.
 *
 * Body:
 *   {
 *     orderNumber: string;        // Walmart customerOrderId (the 2000… number)
 *     purchaseOrderId?: string;   // optional fast-path (from cancellationFlags)
 *     sku?: string;
 *     productTitle: string;
 *     orderedQty: number;         // listing-level quantity the buyer selected
 *     packSize?: number;
 *     packLabel?: string;
 *     customerName?: string | null;
 *     subject: string;            // final (possibly edited) email subject
 *     body: string;               // final (possibly edited) email body
 *   }
 *
 * The relay email is ALWAYS resolved server-side from Walmart (never trusted
 * from the client) so we can't be tricked into emailing an arbitrary address.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import {
  getGmailAccountByEmail,
  sendGmailMessage,
} from "@/lib/gmail-api";
import { WALMART_SIRIUS_CS_EMAIL } from "@/lib/procurement/quantity-inquiry";
import type { WalmartOrder } from "@/lib/walmart/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STORE_INDEX = 1;
const MAX_SCAN_PAGES = 10;

interface InquiryBody {
  orderNumber?: string;
  purchaseOrderId?: string;
  sku?: string;
  productTitle?: string;
  orderedQty?: number;
  packSize?: number;
  packLabel?: string;
  customerName?: string | null;
  subject?: string;
  body?: string;
}

interface ResolvedOrder {
  purchaseOrderId: string;
  relayEmail: string | null;
  customerName: string | null;
}

/** Live-scan Walmart's open queues for an order by customerOrderId. Only used
 *  as a fallback when neither the client nor our DB cache knows the PO. */
async function scanForCustomerOrder(
  api: WalmartOrdersApi,
  customerOrderId: string,
): Promise<WalmartOrder | null> {
  for (const status of ["Acknowledged", "Created"] as const) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await api.getAllOrders(
        cursor ? { nextCursor: cursor } : { status, limit: 200 },
      );
      for (const o of page.orders) {
        if (o.customerOrderId === customerOrderId) return o;
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < MAX_SCAN_PAGES);
  }
  return null;
}

function relayFromOrder(order: WalmartOrder): ResolvedOrder {
  return {
    purchaseOrderId: order.purchaseOrderId,
    relayEmail: order.customerEmailId ?? null,
    customerName: order.shippingInfo?.postalAddress?.name ?? null,
  };
}

/**
 * Resolve the purchase order + relay email for the inquiry. Priority:
 *   1. client-supplied purchaseOrderId → fresh getOrderById
 *   2. DB cache (WalmartOrder by customerOrderId) → fresh getOrderById,
 *      falling back to the cached relay email if the live fetch fails
 *   3. live scan of the open queues
 */
async function resolveOrder(
  api: WalmartOrdersApi,
  orderNumber: string,
  purchaseOrderId: string | undefined,
): Promise<ResolvedOrder | null> {
  if (purchaseOrderId) {
    try {
      return relayFromOrder(await api.getOrderById(purchaseOrderId));
    } catch {
      /* fall through to DB / scan */
    }
  }

  const cached = await prisma.walmartOrder.findFirst({
    where: { customerOrderId: orderNumber },
    select: { purchaseOrderId: true, customerEmailId: true },
  });
  if (cached?.purchaseOrderId) {
    try {
      return relayFromOrder(await api.getOrderById(cached.purchaseOrderId));
    } catch {
      // Live fetch failed — use whatever the cache has.
      return {
        purchaseOrderId: cached.purchaseOrderId,
        relayEmail: cached.customerEmailId ?? null,
        customerName: null,
      };
    }
  }

  const scanned = await scanForCustomerOrder(api, orderNumber);
  return scanned ? relayFromOrder(scanned) : null;
}

export async function POST(req: NextRequest) {
  let body: InquiryBody = {};
  try {
    body = (await req.json()) as InquiryBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orderNumber = String(body.orderNumber ?? "").trim();
  const subject = String(body.subject ?? "").trim();
  const emailBody = String(body.body ?? "").trim();
  const productTitle = String(body.productTitle ?? "").trim();

  if (!orderNumber) {
    return NextResponse.json({ error: "orderNumber is required" }, { status: 400 });
  }
  if (!subject || !emailBody) {
    return NextResponse.json(
      { error: "subject and body are required" },
      { status: 400 },
    );
  }

  // 1. Locate the Sirius CS mailbox. Without it we cannot send through the
  //    relay (Walmart only accepts mail from the registered CS address).
  const account = await getGmailAccountByEmail(WALMART_SIRIUS_CS_EMAIL);
  if (!account) {
    return NextResponse.json(
      {
        error:
          `Mailbox ${WALMART_SIRIUS_CS_EMAIL} is not connected. Connect it in ` +
          `Settings (Gmail) — it must be the Sirius Customer-service contact ` +
          `so Walmart's relay accepts the message.`,
      },
      { status: 409 },
    );
  }

  // 2. Resolve the buyer's relay address from Walmart (authoritative).
  let resolved: ResolvedOrder | null;
  try {
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);
    resolved = await resolveOrder(api, orderNumber, body.purchaseOrderId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Walmart lookup failed";
    console.error("[inquire-quantity] resolve failed", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  if (!resolved) {
    return NextResponse.json(
      { error: `Order ${orderNumber} not found on Walmart` },
      { status: 404 },
    );
  }
  if (!resolved.relayEmail) {
    return NextResponse.json(
      {
        error:
          `No relay email on file for order ${orderNumber}. Walmart did not ` +
          `return a customerEmailId — cannot contact the buyer.`,
      },
      { status: 422 },
    );
  }

  // 3. Send the email through the Sirius mailbox.
  try {
    await sendGmailMessage(account.refreshToken, {
      to: resolved.relayEmail,
      subject,
      body: emailBody,
      fromEmail: account.email,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Gmail send failed";
    console.error("[inquire-quantity] send failed", msg);
    // 403 here almost always means the connected token predates the gmail.send
    // scope — surface a clear hint to re-connect.
    const hint = /insufficient|scope|permission|403/i.test(msg)
      ? " — re-connect the mailbox in Settings to grant send permission."
      : "";
    return NextResponse.json({ error: msg + hint }, { status: 502 });
  }

  // 4. Record the inquiry (one row per PO; re-sending updates it and resets
  //    the wait state).
  const orderedQty =
    Number.isFinite(body.orderedQty) && body.orderedQty! > 0
      ? Math.floor(body.orderedQty!)
      : null;
  const packSize =
    Number.isFinite(body.packSize) && body.packSize! > 0
      ? Math.floor(body.packSize!)
      : null;
  const totalUnits =
    orderedQty != null ? orderedQty * (packSize ?? 1) : null;

  await prisma.walmartCustomerInquiry.upsert({
    where: { purchaseOrderId: resolved.purchaseOrderId },
    create: {
      purchaseOrderId: resolved.purchaseOrderId,
      customerOrderId: orderNumber,
      storeIndex: STORE_INDEX,
      relayEmail: resolved.relayEmail,
      sentByEmail: account.email,
      customerName: resolved.customerName ?? body.customerName ?? null,
      sku: body.sku ?? null,
      productTitle: productTitle || null,
      orderedQty,
      packSize,
      totalUnits,
      subject,
      bodySent: emailBody,
      sentAt: new Date(),
      status: "SENT",
    },
    update: {
      customerOrderId: orderNumber,
      relayEmail: resolved.relayEmail,
      sentByEmail: account.email,
      customerName: resolved.customerName ?? body.customerName ?? null,
      sku: body.sku ?? null,
      productTitle: productTitle || null,
      orderedQty,
      packSize,
      totalUnits,
      subject,
      bodySent: emailBody,
      sentAt: new Date(),
      status: "SENT",
      replyText: null,
      repliedAt: null,
    },
  });

  return NextResponse.json({
    ok: true,
    status: "SENT",
    sentByEmail: account.email,
    orderNumber,
  });
}
