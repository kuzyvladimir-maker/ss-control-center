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
// It also RECOMMENDS one of them. A merged box is still an ordinary parcel:
// the same Frozen/Dry rules that pick the carrier for a single order apply
// unchanged here (@/lib/shipping/rate-selection — the very code
// /api/shipping/plan runs), with two group-specific inputs:
//
//   deadline    the EARLIEST deliver-by across ALL members. The box travels as
//               one, so the tightest member's promise binds the whole group —
//               the same thing the merge screen warns about in words.
//   frozen risk the WORST pending FrozenRiskAlert across all members, so a hot
//               destination tightens the transit cap to 2 days.
//
// Frozen Amazon groups additionally get the Monday-shift comparison, exactly as
// single orders do: today's pool and next Monday's pool are both quoted through
// the date-anchored Rate Shopping API and the cheaper/faster of the two picks
// wins. When Monday wins, the returned rate list IS Monday's list and
// `shipDate` says so — the buy endpoint re-quotes against that same day.
//
// Read-only: nothing here buys or mutates an order.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { veeqoFetch, getRatesForShipDate, veeqoDateToLocal } from "@/lib/veeqo";
import { getWalmartClient } from "@/lib/walmart/client";
import { estimateShippingRates } from "@/lib/walmart/shipping";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";
import {
  todayNY,
  effectiveBusinessDay,
  nextMondayFrom,
} from "@/lib/shipping/dates";
import {
  selectBestRate,
  chooseTodayOrMonday,
  frozenMaxCalDays,
  type VeeqoRate,
} from "@/lib/shipping/rate-selection";

export const maxDuration = 60;

// Rank order matches LEVEL_ORDER in src/lib/frozen-analytics/rules-engine.ts.
const RISK_RANK: Record<string, number> = {
  ok: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayNameOf(ymd: string): string {
  return DAY_NAMES[new Date(`${ymd}T12:00:00`).getDay()];
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The group's binding deliver-by date: the EARLIEST of the members'.
 *
 * Amazon supplies `due_date`; TikTok/eBay don't, and passing a null through
 * `veeqoDateToLocal` yields "1969-12-31" — which rejects every rate. For those
 * channels we fall back to dispatch + 10 days, the same generous window
 * /api/shipping/plan uses, since those marketplaces don't enforce a per-order
 * delivery deadline.
 */
function groupDeliveryBy(
  orders: Array<Record<string, unknown>>,
  shipDay: string,
): string {
  const dates = orders.map((o) => {
    const due = o.due_date as string | null | undefined;
    if (due) return veeqoDateToLocal(due);
    const dispatch = o.dispatch_date as string | null | undefined;
    return addDays(dispatch ? veeqoDateToLocal(dispatch) : shipDay, 10);
  });
  return dates.sort()[0];
}

export async function GET(request: NextRequest) {
  const groupId = request.nextUrl.searchParams.get("groupId");
  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 });
  }
  const shipDateParam = request.nextUrl.searchParams.get("shipDate");
  // An explicit ?shipDate is the operator overriding the day. We honour it and
  // skip the automatic Monday comparison — they chose, we just quote it.
  const shipDateOverride =
    shipDateParam && /^\d{4}-\d{2}-\d{2}$/.test(shipDateParam)
      ? shipDateParam
      : null;
  // Weekends roll to the next business day: a Sunday quote priced from Sunday
  // would promise transit that no carrier starts until Monday.
  const shipDate = shipDateOverride ?? effectiveBusinessDay(todayNY());

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

    // Worst pending frozen-risk across the WHOLE group. One hot destination is
    // the destination — every member's food rides in the same box.
    let frozenRiskLevel: string | null = null;
    try {
      const alerts = await prisma.frozenRiskAlert.findMany({
        where: {
          orderId: { in: group.members.map((m) => m.orderNumber) },
          status: "pending",
        },
        select: { riskLevel: true },
      });
      for (const a of alerts) {
        const lvl = (a.riskLevel ?? "").toLowerCase();
        if (
          frozenRiskLevel == null ||
          (RISK_RANK[lvl] ?? -1) > (RISK_RANK[frozenRiskLevel] ?? -1)
        ) {
          frozenRiskLevel = lvl;
        }
      }
    } catch (e) {
      // A risk lookup failure must not block the quote — it only widens the
      // frozen cap back to its 3-day default, which is the normal case anyway.
      console.warn(
        "[shipping/merge/rates] frozen risk lookup failed:",
        e instanceof Error ? e.message : e,
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
      const orders = await Promise.all(
        group.members
          .filter((m) => m.walmartPurchaseOrderId)
          .map((m) =>
            client.request<Record<string, unknown>>(
              "GET",
              `/orders/${encodeURIComponent(m.walmartPurchaseOrderId!)}`,
            ),
          ),
      );
      const shippingOf = (o: Record<string, unknown>) =>
        (
          o as {
            shippingInfo?: {
              postalAddress?: Record<string, string>;
              estimatedDeliveryDate?: number | string;
            };
          }
        )?.shippingInfo;
      const primaryIdx = group.members
        .filter((m) => m.walmartPurchaseOrderId)
        .findIndex((m) => m.orderId === group.primaryOrderId);
      const addr = shippingOf(orders[Math.max(primaryIdx, 0)])?.postalAddress;
      if (!addr) {
        return NextResponse.json(
          { error: "Walmart order has no shipping address" },
          { status: 409 },
        );
      }
      // Same rule as the Veeqo side: the tightest member's promise binds the
      // box. Walmart hands the promised delivery date back as an epoch in ms.
      const promises = orders
        .map((o) => shippingOf(o)?.estimatedDeliveryDate)
        .filter((v): v is number | string => v != null)
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      // Falling back to a week out keeps the quote working when the field is
      // absent — the rate list is the same, only the "meets the promise" flag
      // on each option would be optimistic.
      const deliverByDate =
        promises.length > 0
          ? new Date(Math.min(...promises))
          : new Date(Date.now() + 7 * 86400000);

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
        deliverByDate,
      });

      // Walmart groups are Dry by definition (Frozen is Amazon-only, enforced
      // in PATCH /api/shipping/merge), so the Dry rule applies: the cheapest
      // option that still meets the delivery promise.
      const onTime = rates.filter(
        (r) => r.deliveryPromiseFulfilled && typeof r.amount === "number",
      );
      const pool = onTime.length > 0 ? onTime : [];
      const best = [...pool].sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0))[0];
      const recommended = best
        ? {
            carrierName: best.carrierName,
            carrierServiceType: best.serviceType,
            label: best.displayName || best.serviceType,
            price: best.amount,
            edd: best.deliveryDate,
            shipDate,
            reason: `Dry — cheapest option that meets Walmart's delivery promise (${
              onTime.length
            } of ${rates.length} do)`,
          }
        : null;

      return NextResponse.json({
        channel: "walmart",
        shipDate,
        rates,
        recommended,
        deliveryBy: deliverByDate.toISOString().slice(0, 10),
        // Nothing on-time came back — say so instead of silently recommending
        // a late service. The operator can still buy any line by hand.
        noRecommendationReason: recommended
          ? null
          : `None of the ${rates.length} quoted services meet the delivery promise — pick one by hand.`,
      });
    }

    // ── Everything else (Amazon, TikTok, Shopify, …): Veeqo ─────────────
    const memberOrders = (await Promise.all(
      group.members.map((m) =>
        veeqoFetch(`/orders/${m.orderId}`) as Promise<Record<string, unknown>>,
      ),
    )) as Array<Record<string, unknown>>;
    const primaryOrder =
      memberOrders[group.members.findIndex((m) => m.orderId === group.primaryOrderId)] ??
      memberOrders[0];

    const deliveryBy = groupDeliveryBy(memberOrders, shipDate);
    const parcel = {
      // Veeqo's Rate Shopping API takes ounces.
      weightOz: group.weight * 16,
      lengthIn: dims.length,
      widthIn: dims.width,
      heightIn: dims.height,
    };

    const todayResp = await getRatesForShipDate(
      primaryOrder,
      `${shipDate}T16:00:00Z`,
      parcel,
    );
    let rates = todayResp.available as unknown as VeeqoRate[];
    const todaySel = selectBestRate(
      rates,
      group.productType,
      deliveryBy,
      shipDate,
      dayNameOf(shipDate),
      false,
      frozenRiskLevel,
    );
    let picked = todaySel.rate;
    let pickedShipDate = shipDate;
    let diagnostic = todaySel.diagnostic;
    let shiftNote: string | null = null;

    // ── Ship Date Trick (Frozen only — Master Prompt v3.5) ──────────────
    // Same gates as the single-order path: Amazon only, Monday must still beat
    // the deadline, and today mustn't already be Monday (else "next Monday" is
    // a full week out). Skipped when the operator forced a ship date.
    const nextMonday = nextMondayFrom(shipDate);
    const monDeadlineDays = nextMonday
      ? Math.round(
          (new Date(deliveryBy + "T00:00:00").getTime() -
            new Date(nextMonday + "T00:00:00").getTime()) /
            86_400_000,
        )
      : -1;
    if (
      !shipDateOverride &&
      group.productType === "Frozen" &&
      group.channelKind === "amazon" &&
      monDeadlineDays >= 1 &&
      dayNameOf(shipDate) !== "Mon"
    ) {
      try {
        const mondayResp = await getRatesForShipDate(
          primaryOrder,
          `${nextMonday}T16:00:00Z`,
          parcel,
        );
        const mondayRates = mondayResp.available as unknown as VeeqoRate[];
        const mondaySel = selectBestRate(
          mondayRates,
          group.productType,
          deliveryBy,
          nextMonday,
          "Mon",
          false,
          frozenRiskLevel,
        );
        const { takeMonday, reason } = chooseTodayOrMonday({
          todayPick: picked,
          mondayPick: mondaySel.rate,
          todayShipDay: shipDate,
          mondayShipDay: nextMonday,
        });
        if (takeMonday && mondaySel.rate) {
          picked = mondaySel.rate;
          pickedShipDate = nextMonday;
          // Show the pool the pick came from, so "Buy" and the list agree.
          rates = mondayRates;
          diagnostic = mondaySel.diagnostic;
          shiftNote = `Shifted to Mon ${nextMonday}: ${reason}`;
        }
      } catch (e) {
        // Trick failed — keep today's pick. Nothing was mutated.
        console.warn(
          "[shipping/merge/rates] Monday re-quote failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    // Why no recommendation — the two cases need different operator action.
    let noRecommendationReason: string | null = null;
    if (!picked) {
      if (group.productType === "Frozen") {
        const meetingDeadline = rates.filter((r) => {
          const eddDate = new Date(
            veeqoDateToLocal(r.delivery_promise_date) + "T00:00:00",
          );
          return eddDate <= new Date(deliveryBy + "T23:59:59");
        }).length;
        const cap = frozenMaxCalDays(frozenRiskLevel);
        noRecommendationReason =
          meetingDeadline > 0
            ? `Frozen — none of ${meetingDeadline}/${rates.length} on-time rates deliver within ${cap} calendar days (food safety). The Monday shift didn't help either.`
            : `No rate delivers by ${deliveryBy} (the group's tightest deadline). ${rates.length} rates checked.`;
      } else {
        noRecommendationReason = `No rate delivers by ${deliveryBy} (the group's tightest deadline). ${rates.length} rates checked.`;
      }
    }

    return NextResponse.json({
      channel: group.channelKind,
      shipDate: pickedShipDate,
      deliveryBy,
      frozenRiskLevel,
      rates,
      recommended: picked
        ? {
            // What the buy endpoint needs to re-quote and purchase.
            serviceType: picked.name,
            subCarrierId: picked.sub_carrier_id,
            carrier: picked.title,
            label: picked.title,
            price: parseFloat(picked.total_net_charge),
            edd: veeqoDateToLocal(picked.delivery_promise_date),
            shipDate: pickedShipDate,
            reason:
              shiftNote ??
              (group.productType === "Frozen"
                ? `Frozen — within ${frozenMaxCalDays(frozenRiskLevel)} days of transit and on time for ${deliveryBy}`
                : `Dry — cheapest rate that still delivers by ${deliveryBy}`),
            diagnostic,
          }
        : null,
      noRecommendationReason,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge/rates] failed:", reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
