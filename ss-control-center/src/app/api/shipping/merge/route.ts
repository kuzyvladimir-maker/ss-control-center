// Merge Orders — combine same-address orders into one shipment, here rather
// than in Veeqo.
//
//   GET    /api/shipping/merge   → candidate groups + the groups already open
//   POST   /api/shipping/merge   → create a group from selected order ids
//   PATCH  /api/shipping/merge   → set the combined package (type/box/weight)
//   DELETE /api/shipping/merge?groupId=…  → dissolve a group (before purchase)
//
// Why this lives here and not in Veeqo: merging in Veeqo lets an operator buy
// a label for an order whose goods were never procured. The order then leaves
// the Procurement queue and nobody sees the shortfall — that happened several
// times. Every gate this module enforces is therefore enforced across the WHOLE
// group: if one member isn't Placed, the group can't be created.
//
// Mechanics + evidence for the grouping key: docs/wiki/merge-orders-veeqo-mechanics.md

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchAllOrders } from "@/lib/veeqo/client";
import { findMergeableGroups, type MergeableGroup } from "@/lib/shipping/mergeable";

export const maxDuration = 60;

const PLACED_TAG = "Placed";

interface VeeqoOrderLite {
  id?: number | string;
  number?: string;
  status?: string;
  // When the buyer placed it. The earliest order in a group carries the real
  // label; see the primary-selection note below.
  created_at?: string | null;
  // Veeqo's dispatch deadline, used to warn when a LATER order in the group
  // is actually the tighter one.
  dispatch_date?: string | null;
  tags?: Array<{ name?: string }> | null;
  channel?: { type_code?: string | null; name?: string | null } | null;
  allocations?: Array<{ id?: number | string }> | null;
  mergable_checksum?: string | null;
  merged_to_id?: number | string | null;
  merged_order?: boolean | null;
}

function isPlaced(o: VeeqoOrderLite): boolean {
  return (o.tags ?? []).some(
    (t) => String(t?.name ?? "").toLowerCase() === PLACED_TAG.toLowerCase(),
  );
}

// Shopify channels are third-party clients whose stock already sits in our
// warehouse — they never go through supplier procurement, so the Placed gate
// is meaningless for them. Same carve-out the dashboard makes.
function skipPlacedGate(o: VeeqoOrderLite): boolean {
  return (o.channel?.type_code ?? "").toLowerCase() === "shopify";
}

function walmartPoOf(o: VeeqoOrderLite): string | null {
  // Walmart's purchase order id IS the Veeqo order number for this account —
  // the same assumption the Walmart buy path makes.
  const kind = (o.channel?.type_code ?? "").toLowerCase();
  return kind === "walmart" ? (o.number ?? null) : null;
}

export async function GET() {
  try {
    const orders = (await fetchAllOrders(
      "awaiting_fulfillment",
    )) as VeeqoOrderLite[];

    const openGroups = await prisma.mergeGroup.findMany({
      where: { status: "open" },
      include: { members: true },
      orderBy: { createdAt: "desc" },
    });

    // An order already inside an open group is not a candidate again.
    const claimed = new Set<string>();
    for (const g of openGroups) {
      for (const m of g.members) claimed.add(m.orderId);
    }

    const candidates = findMergeableGroups(
      orders.filter((o) => !claimed.has(String(o.id ?? ""))),
    );

    // Annotate each candidate with whether the WHOLE group can be merged.
    // Surfacing the blocked ones (rather than hiding them) is deliberate: the
    // operator needs to see "these two could ship together once the goods are
    // bought", which is a procurement signal, not noise.
    const byId = new Map(orders.map((o) => [String(o.id ?? ""), o]));
    const annotated = candidates.map((g: MergeableGroup) => {
      const blocked = g.orders.filter((m) => {
        const o = byId.get(m.id);
        return o ? !isPlaced(o) && !skipPlacedGate(o) : true;
      });
      return {
        ...g,
        mergeable: blocked.length === 0,
        blockedOrderNumbers: blocked.map((b) => b.orderNumber),
      };
    });

    return NextResponse.json({
      groupCount: annotated.length,
      orderCount: annotated.reduce((s, g) => s + g.orders.length, 0),
      readyCount: annotated.filter((g) => g.mergeable).length,
      candidates: annotated,
      groups: openGroups,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge] GET failed:", reason);
    return NextResponse.json(
      { error: reason, groupCount: 0, orderCount: 0, candidates: [], groups: [] },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const orderIds: string[] = (body.orderIds ?? []).map(String);
    if (orderIds.length < 2) {
      return NextResponse.json(
        { error: "Select at least two orders to merge" },
        { status: 400 },
      );
    }

    const orders = (await fetchAllOrders(
      "awaiting_fulfillment",
    )) as VeeqoOrderLite[];
    const byId = new Map(orders.map((o) => [String(o.id ?? ""), o]));
    const picked = orderIds.map((id) => byId.get(id)).filter(Boolean) as VeeqoOrderLite[];

    if (picked.length !== orderIds.length) {
      return NextResponse.json(
        {
          error:
            "Some selected orders are no longer awaiting fulfillment — refresh and try again",
        },
        { status: 409 },
      );
    }

    // ── Gate 1: procurement. The reason this feature exists at all. ──────
    const notPlaced = picked.filter((o) => !isPlaced(o) && !skipPlacedGate(o));
    if (notPlaced.length > 0) {
      return NextResponse.json(
        {
          error:
            `Not purchased yet: ${notPlaced.map((o) => o.number).join(", ")}. ` +
            "Every order in a group must be marked Placed before it can be merged — " +
            "otherwise the goods drop out of Procurement unbought.",
        },
        { status: 409 },
      );
    }

    // ── Gate 2: one channel, one store. Each marketplace's protections and
    // label source are its own; a mixed group has no coherent way to buy. ──
    const kinds = new Set(
      picked.map((o) => (o.channel?.type_code ?? "").toLowerCase()),
    );
    if (kinds.size !== 1) {
      return NextResponse.json(
        { error: `A group can't span channels (${[...kinds].join(", ")})` },
        { status: 409 },
      );
    }
    // Deliberately NOT gated on store. One buyer can order from Salutem and
    // from AMZ Commerce to the same address, and the owner merges those: one
    // box, one label bought on one account, the tracking copied to the other
    // (owner's decision, 2026-07-31). Channel still can't be crossed — the
    // label source and the marketplace protections differ per channel.
    //
    // Worth knowing when this first runs: none of the 16 merges in this
    // account's recent history actually spanned stores, so the cross-store
    // path is new ground for our code and is the one to watch in the pilot.
    const stores = new Set(picked.map((o) => o.channel?.name ?? ""));
    const spansStores = stores.size > 1;

    // ── Gate 3: same destination. Veeqo's own address fingerprint is the
    // key — matching their grouping by construction rather than by imitating
    // their address normalisation. ──────────────────────────────────────
    const sums = new Set(picked.map((o) => o.mergable_checksum ?? ""));
    if (sums.size !== 1 || [...sums][0] === "") {
      return NextResponse.json(
        { error: "Selected orders do not share an identical delivery address" },
        { status: 409 },
      );
    }

    // ── Gate 4: nothing already merged or already in another open group. ──
    const alreadyMerged = picked.filter(
      (o) => o.merged_to_id != null || o.merged_order === true,
    );
    if (alreadyMerged.length > 0) {
      return NextResponse.json(
        {
          error: `Already merged in Veeqo: ${alreadyMerged.map((o) => o.number).join(", ")}`,
        },
        { status: 409 },
      );
    }
    const claimed = await prisma.mergeGroupMember.findMany({
      where: { orderId: { in: orderIds }, group: { status: "open" } },
      select: { orderId: true },
    });
    if (claimed.length > 0) {
      return NextResponse.json(
        { error: "Some of those orders are already in an open group" },
        { status: 409 },
      );
    }

    const channelKind = [...kinds][0];

    // Order the members oldest-first so the primary is unambiguous.
    const placedAt = (o: VeeqoOrderLite) => {
      const t = o.created_at ? new Date(o.created_at).getTime() : NaN;
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    const byAge = [...picked].sort((a, b) => placedAt(a) - placedAt(b));
    const primaryId = String(byAge[0].id ?? "");

    // The primary is the earliest ORDER, but the binding deadline is the
    // earliest DISPATCH DATE — usually the same row, not always (an expedited
    // later order can be due sooner). Flag the mismatch rather than silently
    // re-anchoring, so the operator decides with the facts in front of them.
    const dispatchAt = (o: VeeqoOrderLite) => {
      const t = o.dispatch_date ? new Date(o.dispatch_date).getTime() : NaN;
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    const tightest = [...picked].sort((a, b) => dispatchAt(a) - dispatchAt(b))[0];
    const deadlineWarning =
      String(tightest.id ?? "") !== primaryId
        ? `Heads up: ${tightest.number} is due to ship before the earliest order ` +
          `${byAge[0].number}. The group must meet ${tightest.number}'s deadline.`
        : null;

    const group = await prisma.mergeGroup.create({
      data: {
        checksum: [...sums][0],
        channelKind,
        // The store the LABEL is bought under. With a cross-store group the
        // members differ, and this is the one that actually pays for and owns
        // the shipment.
        storeName: byAge[0].channel?.name ?? null,
        // The EARLIEST order carries the real label; the later ones are
        // ship-confirmed with its tracking (owner's rule, 2026-07-31). The
        // earliest order also has the tightest dispatch deadline in the normal
        // case, so buying against it is what keeps every member on time.
        primaryOrderId: primaryId,
        members: {
          create: byAge.map((o) => ({
            orderId: String(o.id ?? ""),
            orderNumber: o.number ?? String(o.id ?? ""),
            allocationId: o.allocations?.[0]?.id
              ? String(o.allocations[0].id)
              : null,
            walmartPurchaseOrderId: walmartPoOf(o),
          })),
        },
      },
      include: { members: true },
    });

    return NextResponse.json({ group, deadlineWarning, spansStores });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge] POST failed:", reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const groupId = String(body.groupId ?? "");
    if (!groupId) {
      return NextResponse.json({ error: "groupId is required" }, { status: 400 });
    }
    const group = await prisma.mergeGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    if (group.status !== "open") {
      return NextResponse.json(
        { error: `Group is ${group.status} — its package can no longer change` },
        { status: 409 },
      );
    }

    const data: {
      productType?: string;
      boxSize?: string;
      weight?: number;
      primaryOrderId?: string;
    } = {};

    if (body.productType != null) {
      const t = String(body.productType);
      if (t !== "Frozen" && t !== "Dry") {
        return NextResponse.json(
          { error: "productType must be Frozen or Dry" },
          { status: 400 },
        );
      }
      // Frozen ships only on Amazon — a frozen donor behind a Walmart listing
      // is the wrong product, and Walmart has no frozen lane at all.
      if (t === "Frozen" && group.channelKind !== "amazon") {
        return NextResponse.json(
          { error: "Frozen is Amazon-only — this group is " + group.channelKind },
          { status: 409 },
        );
      }
      data.productType = t;
    }
    if (body.boxSize != null) data.boxSize = String(body.boxSize);
    if (body.weight != null) {
      const w = Number(body.weight);
      if (!Number.isFinite(w) || w <= 0) {
        return NextResponse.json(
          { error: "weight must be a positive number" },
          { status: 400 },
        );
      }
      data.weight = w;
    }
    if (body.primaryOrderId != null) {
      const primary = String(body.primaryOrderId);
      const member = await prisma.mergeGroupMember.findFirst({
        where: { groupId, orderId: primary },
      });
      if (!member) {
        return NextResponse.json(
          { error: "primaryOrderId must be a member of the group" },
          { status: 400 },
        );
      }
      data.primaryOrderId = primary;
    }

    const updated = await prisma.mergeGroup.update({
      where: { id: groupId },
      data,
      include: { members: true },
    });
    return NextResponse.json({ group: updated });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge] PATCH failed:", reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const groupId = request.nextUrl.searchParams.get("groupId");
    if (!groupId) {
      return NextResponse.json({ error: "groupId is required" }, { status: 400 });
    }
    const group = await prisma.mergeGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    // A bought group is a real shipment with a real tracking number already on
    // the marketplaces. Dissolving it here would only desynchronise our record
    // from reality — there is nothing to undo.
    if (group.status === "bought") {
      return NextResponse.json(
        {
          error:
            "This group's label is already purchased — it can't be dissolved.",
        },
        { status: 409 },
      );
    }
    await prisma.mergeGroup.update({
      where: { id: groupId },
      data: { status: "dissolved" },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/merge] DELETE failed:", reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
