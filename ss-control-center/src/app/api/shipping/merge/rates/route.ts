// GET /api/shipping/merge/rates?groupId=…&shipDate=YYYY-MM-DD
//
// Quote carriers for a merged group against the COMBINED package the operator
// entered, not against any one member's stored dimensions. Merging two orders
// makes a physically different parcel; quoting one member's box would price a
// box that isn't the one being shipped.
//
// The quote is channel-specific, exactly like the purchase that follows:
//   Amazon  → Veeqo's Rate Shopping API. Veeqo is Amazon's own subsidiary, so
//             buying through it keeps Amazon's Buy Shipping protections.
//   Walmart → Ship with Walmart. Walmart's own rates are materially cheaper
//             and SWW carries delivery-defect protection Veeqo's rates don't.
//
// Read-only: nothing here buys or mutates an order.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { veeqoFetch, getRatesForShipDate } from "@/lib/veeqo";
import { getWalmartClient } from "@/lib/walmart/client";
import { estimateShippingRates } from "@/lib/walmart/shipping";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";
import { todayNY } from "@/lib/shipping/dates";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const groupId = request.nextUrl.searchParams.get("groupId");
  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 });
  }
  const shipDateParam = request.nextUrl.searchParams.get("shipDate");
  const shipDate =
    shipDateParam && /^\d{4}-\d{2}-\d{2}$/.test(shipDateParam)
      ? shipDateParam
      : todayNY();

  try {
    const group = await prisma.mergeGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    // The package is the operator's explicit statement about the combined box.
    // Without it there is nothing honest to quote — refuse rather than fall
    // back to a member's dimensions and price the wrong parcel.
    if (group.weight == null || !group.boxSize || !group.productType) {
      return NextResponse.json(
        {
          error:
            "Set the type, weight and box for the merged package before quoting rates",
          needsPackage: true,
        },
        { status: 409 },
      );
    }
    const dims = resolveBoxDimensions(group.boxSize);
    if (!dims) {
      return NextResponse.json(
        { error: `Could not resolve box size "${group.boxSize}"` },
        { status: 409 },
      );
    }

    const primary = group.members.find(
      (m) => m.orderId === group.primaryOrderId,
    );
    if (!primary) {
      return NextResponse.json(
        { error: "Group has no primary member" },
        { status: 409 },
      );
    }

    // ── Walmart: Ship with Walmart ──────────────────────────────────────
    if (group.channelKind === "walmart") {
      if (!primary.walmartPurchaseOrderId) {
        return NextResponse.json(
          { error: "Primary member has no Walmart purchase order id" },
          { status: 409 },
        );
      }
      const client = getWalmartClient();
      const order = await client.request<Record<string, unknown>>(
        "GET",
        `/orders/${encodeURIComponent(primary.walmartPurchaseOrderId)}`,
      );
      const shipping = (
        order as {
          shippingInfo?: {
            postalAddress?: Record<string, string>;
            estimatedDeliveryDate?: number | string;
          };
        }
      )?.shippingInfo;
      const addr = shipping?.postalAddress;
      if (!addr) {
        return NextResponse.json(
          { error: "Walmart order has no shipping address" },
          { status: 409 },
        );
      }
      const rates = await estimateShippingRates(client, {
        box: {
          length: dims.length,
          width: dims.width,
          height: dims.height,
          weight: group.weight,
        },
        to: {
          addressLines: [addr.address1, addr.address2].filter(
            (l): l is string => !!l,
          ),
          city: addr.city ?? "",
          state: addr.state ?? "",
          postalCode: addr.postalCode ?? "",
          countryCode: addr.country ?? "US",
        },
        shipByDate: shipDate,
        // Walmart hands the promised delivery date back as an epoch in ms.
        // Falling back to a week out keeps the quote working when the field is
        // absent — the rate list is the same, only the "meets the promise"
        // flag on each option would be optimistic, and the operator picks the
        // service themselves.
        deliverByDate:
          shipping?.estimatedDeliveryDate != null
            ? new Date(Number(shipping.estimatedDeliveryDate))
            : new Date(Date.now() + 7 * 86400000),
      });
      return NextResponse.json({ channel: "walmart", shipDate, rates });
    }

    // ── Everything else (Amazon, TikTok, Shopify, …): Veeqo ─────────────
    const order = (await veeqoFetch(
      `/orders/${primary.orderId}`,
    )) as Record<string, unknown>;
    const resp = await getRatesForShipDate(order, `${shipDate}T16:00:00Z`, {
      // Veeqo's Rate Shopping API takes ounces.
      weightOz: group.weight * 16,
      lengthIn: dims.length,
      widthIn: dims.width,
      heightIn: dims.height,
    });
    return NextResponse.json({
      channel: group.channelKind,
      shipDate,
      rates: resp.available,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge/rates] failed:", reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
