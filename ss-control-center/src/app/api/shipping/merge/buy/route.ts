// POST /api/shipping/merge/buy   { groupId, rate }
//
// Buy ONE label for a merged group and put its tracking on every order in it.
//
// ── The shape of the operation ──────────────────────────────────────────
// One real label is purchased against the PRIMARY member — the earliest order,
// which carries the tightest dispatch deadline. Every other member is then
// ship-confirmed with that same tracking number, which is exactly what Veeqo's
// own merge does internally: verified 2026-07-31 on order #P-1988529619, where
// the paid parent shipment carried a $10.30 charge and each original order
// received a zero-cost shipment with the identical tracking half a second
// later.
//
// ── Why the purchase is channel-specific ────────────────────────────────
// Amazon  → Veeqo. Veeqo is Amazon's own subsidiary, so a label bought through
//           it keeps Amazon's Buy Shipping protections, and Amazon labels
//           cannot be bought directly through their API anyway.
// Walmart → Ship with Walmart, never Veeqo. Walmart's rates are materially
//           cheaper and SWW carries delivery-defect protection that a label
//           bought on Veeqo's own carrier accounts does not.
//
// ── Known, accepted cost (owner's decision, 2026-07-31) ─────────────────
// SWW protections attach to the purchase order the label was bought for. The
// SIBLING Walmart orders in a group are ship-confirmed with a tracking number
// belonging to the primary's label, so they do not carry SWW's lost-parcel
// cover or on-time-delivery protection. The owner accepted this trade against
// the saved label. Recorded here so nobody has to re-derive it later.
//
// ── Safety ──────────────────────────────────────────────────────────────
// One label, one POST, zero retries: an unknown purchase outcome is never
// re-sent. The tracking is persisted BEFORE any fan-out, so a fan-out failure
// can never lead to buying a second label. Fan-out runs one order at a time and
// records its result per member; a member already marked synced is skipped, so
// re-running finishes the remainder instead of double-shipping what succeeded.

import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buyShippingLabel as buyVeeqoLabel,
  getShippingRates,
  extractVasFromRate,
  updateAllocationPackage,
  createManualShipment,
} from "@/lib/veeqo";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { buyShippingLabel as buyWalmartLabel } from "@/lib/walmart/shipping";
import type { WalmartShipLineInput } from "@/lib/walmart/types";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";

export const maxDuration = 300;

interface RateSelection {
  // Veeqo path
  serviceType?: string | null;
  subCarrierId?: string | null;
  carrier?: string | null;
  // Walmart path
  carrierName?: string | null;
  carrierServiceType?: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const groupId = String(body.groupId ?? "");
    const rate: RateSelection = body.rate ?? {};
    if (!groupId) {
      return NextResponse.json({ error: "groupId is required" }, { status: 400 });
    }

    const group = await prisma.mergeGroup.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    // A bought group already has a real label and a real tracking number on the
    // marketplaces. Buying again would spend money twice for one box.
    if (group.status === "bought") {
      return NextResponse.json(
        {
          error:
            "This group's label is already bought. Use Resend tracking if some orders still need it.",
          alreadyBought: true,
        },
        { status: 409 },
      );
    }
    if (group.status !== "open") {
      return NextResponse.json(
        { error: `Group is ${group.status}` },
        { status: 409 },
      );
    }
    if (group.weight == null || !group.boxSize || !group.productType) {
      return NextResponse.json(
        { error: "Set the type, weight and box for the merged package first" },
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
    const primary = group.members.find((m) => m.orderId === group.primaryOrderId);
    if (!primary) {
      return NextResponse.json(
        { error: "Group has no primary member" },
        { status: 409 },
      );
    }

    let tracking = "";
    let carrier = "";
    let service = "";
    let price: number | null = null;
    // Veeqo's numeric carrier id for the purchased shipment. Their own merge
    // mirrors reuse the real carrier rather than the generic "Other", so we
    // pass it through to the sibling shipments too.
    let veeqoCarrierId: number | undefined;

    if (group.channelKind === "walmart") {
      // ── Walmart: Ship with Walmart on the primary purchase order ──────
      if (!primary.walmartPurchaseOrderId) {
        return NextResponse.json(
          { error: "Primary member has no Walmart purchase order id" },
          { status: 409 },
        );
      }
      if (!rate.carrierName || !rate.carrierServiceType) {
        return NextResponse.json(
          { error: "Pick a Walmart rate first (carrierName + carrierServiceType)" },
          { status: 400 },
        );
      }
      const client = getWalmartClient();
      const api = new WalmartOrdersApi(client);
      const primaryOrder = await api.getOrderById(primary.walmartPurchaseOrderId);
      // The label is bought against the primary PO, so its declared contents
      // are that PO's lines. The physical box also holds the siblings' items —
      // the carrier prices on weight and dimensions, which are the combined
      // ones we set here.
      const boxItems = primaryOrder.orderLines.map((l) => ({
        sku: l.sku,
        quantity: l.orderedQty,
        lineNumber: l.lineNumber,
      }));
      const label = await buyWalmartLabel(client, {
        purchaseOrderId: primary.walmartPurchaseOrderId,
        carrierName: rate.carrierName,
        carrierServiceType: rate.carrierServiceType,
        box: {
          length: dims.length,
          width: dims.width,
          height: dims.height,
          weight: group.weight,
        },
        boxItems,
      });
      tracking = label.trackingNumber;
      carrier = label.carrierName;
      service = label.carrierServiceType;
    } else {
      // ── Veeqo (Amazon and every other Veeqo-shipped channel) ──────────
      if (!primary.allocationId) {
        return NextResponse.json(
          { error: "Primary member has no Veeqo allocation" },
          { status: 409 },
        );
      }
      // Set the COMBINED package on the allocation before quoting. Veeqo buys
      // against the allocation's package, not against anything in the purchase
      // body, so this has to land first or the label prints the wrong box.
      await updateAllocationPackage(primary.allocationId, {
        weightLbs: group.weight,
        lengthIn: dims.length,
        widthIn: dims.width,
        heightIn: dims.height,
      });

      // Re-quote against the package we just set and buy the matching service.
      // Buying on a stale quote is what produced wrong-dimension labels before.
      const live = await getShippingRates(primary.allocationId);
      const rates: Record<string, unknown>[] = (live?.available as Record<string, unknown>[]) ?? [];
      const wanted = (rate.serviceType ?? "").trim();
      const match =
        rates.find((r) => String(r.name) === wanted) ??
        rates.find(
          (r) =>
            String(r.sub_carrier_id) === (rate.subCarrierId ?? "") &&
            String(r.title).trim().toLowerCase() ===
              (rate.carrier ?? "").trim().toLowerCase(),
        );
      if (!match) {
        return NextResponse.json(
          {
            error:
              "Could not re-quote the chosen service at the combined package size — " +
              "label NOT bought. Refresh the rates and try again.",
          },
          { status: 409 },
        );
      }

      const str = (v: unknown, fallback = "") => (v != null ? String(v) : fallback);
      const shipment = await buyVeeqoLabel({
        allocationId: primary.allocationId,
        carrierId: str(match.carrier),
        remoteShipmentId: str(match.remote_shipment_id),
        serviceType: str(match.name),
        subCarrierId: str(match.sub_carrier_id),
        serviceCarrier: str(match.service_carrier),
        totalNetCharge: str(match.total_net_charge),
        baseRate: str(match.base_rate),
        vas: extractVasFromRate(match),
      });
      tracking = pickTracking(shipment) ?? "";
      carrier = str(match.sub_carrier_id);
      service = str(match.title);
      price = match.total_net_charge != null ? parseFloat(String(match.total_net_charge)) : null;
      const s = shipment as { carrier_id?: number } | null;
      if (typeof s?.carrier_id === "number") veeqoCarrierId = s.carrier_id;
    }

    if (!tracking) {
      // The purchase call returned without a tracking number. We do NOT retry —
      // the label may well exist. Record nothing as bought and let the operator
      // check the carrier/marketplace before acting.
      return NextResponse.json(
        {
          error:
            "The label call returned no tracking number. Do NOT buy again — " +
            "check the order in Veeqo/Walmart first, the label may already exist.",
        },
        { status: 502 },
      );
    }

    // Persist BEFORE fan-out. From here on, a failure can only leave tracking
    // un-mirrored — never a second label bought for the same box.
    await prisma.mergeGroup.update({
      where: { id: groupId },
      data: {
        status: "bought",
        trackingNumber: tracking,
        carrier,
        service,
        price,
        boughtAt: new Date(),
      },
    });

    // ── Fan the tracking out, one order at a time ─────────────────────────
    const results: Array<{
      orderNumber: string;
      ok: boolean;
      skipped?: boolean;
      error?: string;
    }> = [];

    for (const m of group.members) {
      if (m.shipmentSyncedAt) {
        results.push({ orderNumber: m.orderNumber, ok: true, skipped: true });
        continue;
      }
      // Veeqo's own purchase already shipped the primary and pushed it to the
      // marketplace; only the siblings need a mirror shipment. On Walmart,
      // buying a label deliberately does NOT ship-confirm, so every member —
      // primary included — still needs one.
      const primaryAlreadyShipped =
        group.channelKind !== "walmart" && m.orderId === group.primaryOrderId;
      if (primaryAlreadyShipped) {
        await prisma.mergeGroupMember.update({
          where: { id: m.id },
          data: { shipmentSyncedAt: new Date(), shipmentSyncError: null },
        });
        results.push({ orderNumber: m.orderNumber, ok: true });
        continue;
      }

      try {
        if (group.channelKind === "walmart") {
          if (!m.walmartPurchaseOrderId) {
            throw new Error("member has no Walmart purchase order id");
          }
          const client = getWalmartClient();
          const api = new WalmartOrdersApi(client);
          const order = await api.getOrderById(m.walmartPurchaseOrderId);
          const shipDateTime = new Date();
          const lines: WalmartShipLineInput[] = order.orderLines.map((l) => ({
            lineNumber: l.lineNumber,
            quantity: l.orderedQty,
            shipDateTime,
            carrierName: carrier,
            methodCode: "Standard",
            trackingNumber: tracking,
          }));
          if (lines.length === 0) throw new Error("order has no lines to ship");
          await api.shipOrderLines(m.walmartPurchaseOrderId, lines, {
            // The operator explicitly merged and bought — that is a deliberate
            // "ship anyway" even if the buyer has since requested cancellation.
            intentToCancelOverride: true,
          });
        } else {
          if (!m.allocationId) throw new Error("member has no Veeqo allocation");
          await createManualShipment({
            orderId: m.orderId,
            allocationId: m.allocationId,
            trackingNumber: tracking,
            carrierId: veeqoCarrierId,
            // This is the whole point: Veeqo pushes the fulfilment to the
            // marketplace through the integration that already works.
            updateRemoteOrder: true,
          });
        }
        await prisma.mergeGroupMember.update({
          where: { id: m.id },
          data: { shipmentSyncedAt: new Date(), shipmentSyncError: null },
        });
        results.push({ orderNumber: m.orderNumber, ok: true });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[merge/buy] tracking fan-out failed for ${m.orderNumber}:`,
          reason,
        );
        await prisma.mergeGroupMember.update({
          where: { id: m.id },
          data: { shipmentSyncError: reason.slice(0, 500) },
        });
        results.push({ orderNumber: m.orderNumber, ok: false, error: reason });
        // Keep going: the remaining orders are independent, and stopping here
        // would leave more of them un-shipped than necessary.
      }
    }

    const failed = results.filter((r) => !r.ok);
    after(() => {
      console.log(
        `[merge/buy] group=${groupId} channel=${group.channelKind} ` +
          `tracking=${tracking} members=${results.length} failed=${failed.length}`,
      );
    });

    return NextResponse.json({
      ok: failed.length === 0,
      groupId,
      tracking,
      carrier,
      service,
      price,
      members: results,
      // Said plainly, because a half-mirrored group is the one state that needs
      // a human: the box ships either way, but a marketplace order without its
      // tracking will read as late.
      warning:
        failed.length > 0
          ? `Label bought, but ${failed.length} order(s) did not receive the tracking. ` +
            "Fix the cause and use Resend tracking — do NOT buy another label."
          : null,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge/buy] failed:", reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

// Veeqo's tracking field varies by carrier: a plain string, an object with
// `value`/`number`, or nested under `shipment`.
function pickTracking(shipment: unknown): string | null {
  if (!shipment || typeof shipment !== "object") return null;
  const s = shipment as Record<string, unknown>;
  const inner = s.shipment as Record<string, unknown> | undefined;
  for (const c of [s.tracking_number, s.trackingNumber, inner?.tracking_number]) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const v =
        (typeof o.tracking_number === "string" && o.tracking_number) ||
        (typeof o.value === "string" && o.value) ||
        (typeof o.number === "string" && o.number);
      if (v) return v;
    }
  }
  return null;
}
