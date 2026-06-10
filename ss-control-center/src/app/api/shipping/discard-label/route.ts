// POST /api/shipping/discard-label
//
// Body: { orderId: string }
//
// Cancels the already-bought shipping label for an order. Routes by
// channel:
//   - Amazon → POST /shipping/shipments/{shipment_id}/refund in Veeqo
//   - Walmart → DELETE /v3/shipping/labels/carriers/{carrier}/trackings/{tracking}
//     via the Walmart Shipping API (using the existing
//     discardShippingLabel helper).
//
// After a successful cancel Veeqo/Walmart flip the order back to
// `awaiting_fulfillment` / `Acknowledged`, so on next dashboard refresh
// the row reverts to "ready to buy" — operator can re-quote a fresh
// label without dropping the order out of Shipping Labels.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { veeqoFetch } from "@/lib/veeqo/client";
import { refundShipmentForOrder } from "@/lib/veeqo/refund";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { discardShippingLabel } from "@/lib/walmart/shipping";

export const dynamic = "force-dynamic";

interface Body {
  orderId?: string;
  // Optional fallback hints from the client's local walmartStatus when
  // Walmart's getLabelsByPurchaseOrder lookup returns empty. The UI
  // displays a tracking the moment a Walmart label is bought (populated
  // optimistically) — that same tracking can be used to discard directly
  // by carrier+tracking, bypassing the lookup which Walmart sometimes
  // takes minutes to index.
  fallbackTracking?: string | null;
  fallbackCarrier?: string | null;
}

interface VeeqoOrderForDiscard {
  id?: string | number;
  number?: string;
  channel?: { type_code?: string; name?: string } | null;
}

// Mark our durable Walmart label record discarded so the order becomes
// buyable again (the buy guard + dashboard detection treat a discarded
// record as "no active label"). Keyed by customerOrderId (= Veeqo
// order.number), which is what this route knows. Non-fatal.
async function clearLocalWalmartLabel(customerOrderId: string) {
  try {
    await prisma.walmartLabelPurchase.updateMany({
      where: { customerOrderId, discardedAt: null },
      data: { discardedAt: new Date() },
    });
  } catch (e) {
    console.warn(
      "[discard-label] failed to clear local Walmart label record (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body falls back to ?orderId= */
  }
  const orderId =
    body.orderId ?? new URL(req.url).searchParams.get("orderId") ?? "";
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  try {
    // Figure out the channel from the Veeqo order itself — frontend
    // could lie / be stale, server-side is the source of truth.
    const order = (await veeqoFetch(
      `/orders/${orderId}`,
    )) as VeeqoOrderForDiscard;
    const channelType = (order?.channel?.type_code ?? "").toLowerCase();
    const orderNumber = String(order?.number ?? orderId);

    if (channelType === "walmart") {
      const client = getWalmartClient(1);
      const api = new WalmartOrdersApi(client);
      const labels = await api.getLabelsByPurchaseOrder(orderNumber);

      // Pick the (carrier, tracking) pairs we'll attempt to discard.
      // Primary source: Walmart's lookup. Fallback: the client's
      // optimistic walmartStatus — Walmart's lookup occasionally takes
      // minutes to index a freshly-bought label and operators were
      // hitting "No Walmart label found for this order" while seeing
      // the tracking right there in the UI.
      const targets: Array<{ carrier: string; tracking: string }> = [];
      for (const l of labels) {
        if (l.trackingNumber && l.carrierName) {
          targets.push({
            carrier: l.carrierName,
            tracking: l.trackingNumber,
          });
        }
      }
      if (
        targets.length === 0 &&
        body.fallbackTracking &&
        body.fallbackCarrier
      ) {
        targets.push({
          carrier: body.fallbackCarrier,
          tracking: body.fallbackTracking,
        });
      }
      if (targets.length === 0) {
        return NextResponse.json(
          {
            error:
              "No Walmart label found for this order (Walmart lookup empty and no fallback tracking from UI).",
          },
          { status: 404 },
        );
      }

      const discarded: Array<{ carrier: string; tracking: string }> = [];
      const discardErrors: Array<{ carrier: string; tracking: string; error: string }> = [];
      for (const t of targets) {
        try {
          await discardShippingLabel(client, t.carrier, t.tracking);
          discarded.push(t);
        } catch (e) {
          discardErrors.push({
            ...t,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // If every Walmart discard failed AND we used the lookup (not the
      // fallback), don't fall through to Veeqo — Walmart is the source
      // of truth for these labels. But if we tried the fallback target
      // and Walmart rejected it, the label may have been bought via
      // Veeqo for some reason (rare, but possible on legacy rows) —
      // attempt a Veeqo refund as last resort.
      if (discarded.length === 0) {
        if (labels.length === 0) {
          // Fallback path failed → try Veeqo refund.
          try {
            const result = await refundShipmentForOrder(orderId);
            await clearLocalWalmartLabel(orderNumber);
            return NextResponse.json({
              ok: true,
              channel: "walmart",
              orderId,
              orderNumber,
              veeqoRefund: result.shipmentId,
              note: "Walmart had no label record; refunded via Veeqo instead.",
            });
          } catch (veeqoErr) {
            return NextResponse.json(
              {
                error: `Could not discard via Walmart (${discardErrors[0]?.error ?? "unknown"}) nor refund via Veeqo (${veeqoErr instanceof Error ? veeqoErr.message : "unknown"}).`,
              },
              { status: 502 },
            );
          }
        }
        return NextResponse.json(
          { error: discardErrors[0]?.error ?? "Discard failed" },
          { status: 502 },
        );
      }

      await clearLocalWalmartLabel(orderNumber);
      return NextResponse.json({
        ok: true,
        channel: "walmart",
        orderId,
        orderNumber,
        discarded,
        ...(discardErrors.length > 0 ? { partialErrors: discardErrors } : {}),
      });
    }

    // Amazon (and anything else that buys through Veeqo).
    const result = await refundShipmentForOrder(orderId);
    return NextResponse.json({
      ok: true,
      channel: channelType || "amazon",
      orderId,
      orderNumber,
      shipmentId: result.shipmentId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[shipping/discard-label]", { orderId, error: e });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
