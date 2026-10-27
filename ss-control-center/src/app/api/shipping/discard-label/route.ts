// POST /api/shipping/discard-label
//
// Body: {
//   orderId?: string            — Veeqo order id (queue rows)
//   orderNumber?: string        — marketplace order number (archive rows may
//                                 have no Veeqo id at hand)
//   trackingNumber?: string     — cancel exactly THIS label (archive). Without
//                                 it: the order's label(s), as the queue did.
//   dryRun?: boolean            — run every check, cancel nothing
//   source?: "queue" | "archive"
//   fallbackTracking?, fallbackCarrier? — queue's optimistic Walmart label
// }
//
// Cancels an already-bought shipping label. Routes by where the label was
// bought:
//   - Veeqo (Amazon and anything else bought through Veeqo) →
//     DELETE /shipments/{id}: Veeqo removes the shipment, puts the order
//     back to `awaiting_fulfillment` and requests the carrier refund
//     (unused label, ~24-72h). See src/lib/veeqo/refund.ts.
//   - Ship-with-Walmart → DELETE /v3/shipping/labels/carriers/{c}/trackings/{t}
//     (discardShippingLabel).
//   - NAN Health labels bought in Shopify: Shopify's Admin API has no label
//     void/refund mutation (checked against the 2026-10 schema), so those
//     are voided in Shopify admin — the route only says so.
//
// Guard rails (src/lib/shipping/label-discard.ts): carrier pre-check (a
// delivered / scanned label is refused with the reason), one lock per
// tracking number before the call, the call sent once, an unclear answer
// settled by reading the order back — never by cancelling again.
//
// GET /api/shipping/discard-label?tracking=…  → that label's discard record;
// an unclear ("unknown") Veeqo attempt is re-checked against the order.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchOrders, veeqoFetch } from "@/lib/veeqo/client";
import { refundShipmentForOrder } from "@/lib/veeqo/refund";
import { veeqoShipments, type VeeqoShipmentRef } from "@/lib/veeqo/tracking";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { discardShippingLabel } from "@/lib/walmart/shipping";
import { nanAdminOrderUrl } from "@/lib/shipping/nan-rates";
import {
  cancelErrorInfo,
  checkCarrier,
  isDefinitiveRefusal,
  markLabelDiscarded,
  normTracking,
  readDiscard,
  takeDiscardLock,
  writeDiscard,
  type CarrierCheck,
  type DiscardRecord,
} from "@/lib/shipping/label-discard";

export const dynamic = "force-dynamic";
// Veeqo lookup + carrier check + one cancel call + read-back.
export const maxDuration = 60;

interface Body {
  orderId?: string;
  orderNumber?: string;
  trackingNumber?: string;
  dryRun?: boolean;
  source?: "queue" | "archive";
  /** Dry run only: include the raw shipment's populated keys. */
  debug?: boolean;
  // Optional fallback hints from the client's local walmartStatus when
  // Walmart's getLabelsByPurchaseOrder lookup returns empty. The UI
  // displays a tracking the moment a Walmart label is bought (populated
  // optimistically) — that same tracking can be used to discard directly
  // by carrier+tracking, bypassing the lookup which Walmart sometimes
  // takes minutes to index.
  fallbackTracking?: string | null;
  fallbackCarrier?: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type VeeqoOrder = any;

interface Target {
  via: "veeqo" | "walmart";
  tracking: string | null;
  carrier: string | null;
  shipmentId: string | null;
  createdAt: string | null;
  fields?: string[];
}

interface Assessment {
  target: Target;
  reasons: string[];
  warnings: string[];
  carrierCheck: CarrierCheck | null;
}

const REFUND_NOTE =
  "Label cancelled — the carrier refund is requested (usually 24-72 h).";
// Carriers refund unused labels only within a window; past this age the
// cancel can still go through without the money coming back.
const OLD_LABEL_DAYS = 14;

const sameNumber = (a: unknown, b: unknown) =>
  String(a ?? "").trim().replace(/^#/, "").toUpperCase() ===
  String(b ?? "").trim().replace(/^#/, "").toUpperCase();

async function loadVeeqoOrder(
  orderId: string,
  orderNumber: string,
): Promise<VeeqoOrder | null> {
  if (orderId) return veeqoFetch(`/orders/${orderId}`);
  if (!orderNumber) return null;
  const hits = (await searchOrders(orderNumber, { pageSize: 10 })) as VeeqoOrder[];
  const hit = hits.find((h) => sameNumber(h?.number, orderNumber));
  return hit ? veeqoFetch(`/orders/${hit.id}`) : null;
}

const isNan = (order: VeeqoOrder) => /nan/i.test(String(order?.channel?.name ?? ""));

/** Walmart labels for the order: Walmart's own lookup (by PO), plus our
 *  durable purchase records. */
async function walmartLabels(orderNumber: string) {
  const local = await prisma.walmartLabelPurchase.findMany({
    where: { customerOrderId: orderNumber },
    orderBy: { boughtAt: "desc" },
  });
  const wo = await prisma.walmartOrder
    .findFirst({ where: { customerOrderId: orderNumber }, select: { purchaseOrderId: true } })
    .catch(() => null);
  const po = wo?.purchaseOrderId ?? local[0]?.purchaseOrderId ?? orderNumber;
  const api = new WalmartOrdersApi(getWalmartClient(1));
  const remote = await api.getLabelsByPurchaseOrder(po).catch((e) => {
    console.warn("[discard-label] Walmart label lookup failed:", e instanceof Error ? e.message : e);
    return [];
  });
  return { remote, local };
}

/**
 * Which label(s) to cancel and where they were bought. With a tracking
 * number: exactly that label, or a 404-worthy null. Without: what the
 * queue button always did — the order's Walmart label(s), else the most
 * recent Veeqo shipment.
 */
async function resolveTargets(
  order: VeeqoOrder,
  orderNumber: string,
  body: Body,
): Promise<Target[]> {
  const isWalmart = (order?.channel?.type_code ?? "").toLowerCase() === "walmart";
  const shipments: VeeqoShipmentRef[] = veeqoShipments(order);
  const fromShipment = (s: VeeqoShipmentRef): Target => ({
    via: "veeqo",
    tracking: s.tracking,
    carrier: s.carrier,
    shipmentId: s.shipmentId,
    createdAt: s.createdAt,
    fields: s.fields,
  });
  const want = body.trackingNumber ? normTracking(body.trackingNumber) : null;

  if (isWalmart) {
    const { remote, local } = await walmartLabels(orderNumber);
    const walmartTarget = (tracking: string, carrier: string, createdAt: string | null): Target => ({
      via: "walmart",
      tracking,
      carrier,
      shipmentId: null,
      createdAt,
    });
    if (want) {
      const r = remote.find((l) => l.trackingNumber && normTracking(l.trackingNumber) === want);
      if (r?.carrierName) return [walmartTarget(r.trackingNumber, r.carrierName, null)];
      const l = local.find((x) => normTracking(x.trackingNumber) === want);
      if (l) return [walmartTarget(l.trackingNumber, l.carrierName, l.boughtAt.toISOString())];
      // A legacy Walmart order whose label was bought through Veeqo.
      const s = shipments.find((x) => x.tracking && normTracking(x.tracking) === want);
      if (s) return [fromShipment(s)];
      if (body.fallbackTracking && body.fallbackCarrier && normTracking(body.fallbackTracking) === want) {
        return [walmartTarget(body.fallbackTracking, body.fallbackCarrier, null)];
      }
      return [];
    }
    const out: Target[] = remote
      .filter((l) => l.trackingNumber && l.carrierName)
      .map((l) => walmartTarget(l.trackingNumber, l.carrierName, null));
    if (out.length === 0) {
      const active = local.find((x) => !x.discardedAt);
      if (active) out.push(walmartTarget(active.trackingNumber, active.carrierName, active.boughtAt.toISOString()));
    }
    if (out.length === 0) {
      // Walmart had no label record: a legacy Veeqo-bought label, else the
      // UI's optimistic tracking (Walmart's lookup lags a fresh purchase).
      const latest = latestShipment(shipments);
      if (latest) out.push(fromShipment(latest));
      else if (body.fallbackTracking && body.fallbackCarrier) {
        out.push(walmartTarget(body.fallbackTracking, body.fallbackCarrier, null));
      }
    }
    return out;
  }

  if (want) {
    const s = shipments.find((x) => x.tracking && normTracking(x.tracking) === want);
    return s ? [fromShipment(s)] : [];
  }
  const latest = latestShipment(shipments);
  return latest ? [fromShipment(latest)] : [];
}

function latestShipment(list: VeeqoShipmentRef[]): VeeqoShipmentRef | null {
  let pick: VeeqoShipmentRef | null = null;
  for (const s of list) {
    const t = s.createdAt ? Date.parse(s.createdAt) : 0;
    const pt = pick?.createdAt ? Date.parse(pick.createdAt) : 0;
    if (!pick || t > pt) pick = s;
  }
  return pick;
}

/** Everything that decides whether the cancel may be sent. */
async function assess(target: Target): Promise<Assessment> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let carrierCheck: CarrierCheck | null = null;
  const t = target.tracking;

  // A label Veeqo sold carries the label itself and its charges (seen on
  // Freshpet 113-0990536-6033819: label_url, outbound_label_charges). A
  // shipment without them is a record of a fulfilment done elsewhere.
  if (
    target.via === "veeqo" &&
    target.fields &&
    !target.fields.includes("label_url") &&
    !target.fields.includes("outbound_label_charges")
  ) {
    reasons.push(
      "Veeqo has no label on this shipment — it wasn't bought through Veeqo. Cancel it where it was bought.",
    );
  }
  if (!t) {
    // A Veeqo shipment without tracking is a fulfilment synced from the
    // channel (NAN #1378: bought in Shopify, shipped in Veeqo with no
    // tracking), not a label Veeqo sold — deleting it would void nothing.
    reasons.push(
      "This shipment has no tracking number — it isn't a label bought through Veeqo or Walmart. Cancel it where it was bought.",
    );
  } else {
    const [prev, local, group, cc] = await Promise.all([
      readDiscard(t).catch(() => null),
      target.via === "walmart"
        ? prisma.walmartLabelPurchase.findFirst({ where: { trackingNumber: t } }).catch(() => null)
        : null,
      prisma.mergeGroup
        .findFirst({ where: { trackingNumber: t, status: "bought" }, include: { members: true } })
        .catch(() => null),
      checkCarrier(t, target.carrier),
    ]);
    carrierCheck = cc;
    if (prev?.state === "done") {
      reasons.push(`Already discarded on ${fmtWhen(prev.finishedAt ?? prev.startedAt)}.`);
    } else if (prev?.state === "sending") {
      reasons.push("A discard of this label is already running.");
    } else if (prev?.state === "unknown") {
      reasons.push(
        "An earlier discard of this label got no clear answer. Re-check its status before trying again.",
      );
    } else if (prev?.state === "failed" && prev.message) {
      warnings.push(`The previous attempt failed: ${prev.message}`);
    }
    if (local?.discardedAt && prev?.state !== "done") {
      reasons.push(`Walmart label already discarded on ${fmtWhen(local.discardedAt.toISOString())}.`);
    }
    if (group) {
      reasons.push(
        `This label covers a merged shipment of ${group.members.length} orders — cancelling it from one order would strand the others.`,
      );
    }
    if (cc.delivered) {
      reasons.push(
        `The carrier shows it delivered${cc.deliveredOn ? ` on ${cc.deliveredOn}` : ""} — a used label can't be refunded.`,
      );
    } else if (cc.cancelled) {
      reasons.push(`The carrier already shows this label as cancelled (${cc.lastEvent ?? cc.status ?? "cancelled"}).`);
    } else if (cc.scanned) {
      reasons.push(
        `The carrier already has the package (last scan: ${cc.lastEvent ?? cc.status ?? "in transit"}) — a used label can't be refunded.`,
      );
    } else if (!cc.checked) {
      warnings.push("Couldn't read the carrier's tracking — the carrier decides whether the refund is granted.");
    }
  }

  if (target.createdAt) {
    const days = Math.floor((Date.now() - Date.parse(target.createdAt)) / 86_400_000);
    if (days > OLD_LABEL_DAYS) {
      warnings.push(
        `The label is ${days} days old. Carriers refund unused labels only within a limited window — it may be cancelled without the money coming back.`,
      );
    }
  }
  return { target, reasons, warnings, carrierCheck };
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";
}

/** Is the Veeqo shipment still on the order? null = couldn't read. */
async function veeqoShipmentStillThere(orderId: string, shipmentId: string): Promise<boolean | null> {
  try {
    const order = await veeqoFetch(`/orders/${orderId}`);
    return veeqoShipments(order).some((s) => s.shipmentId === shipmentId);
  } catch {
    return null;
  }
}

/** Send the cancel for one label — once — and settle the outcome. */
async function cancelOne(
  a: Assessment,
  ctx: { order: VeeqoOrder; orderNumber: string; channel: string; source: "queue" | "archive" },
): Promise<{ state: "done" | "failed" | "unknown" | "refused"; message: string; record?: DiscardRecord }> {
  const { target } = a;
  const veeqoOrderId = ctx.order?.id != null ? String(ctx.order.id) : null;
  const rec: DiscardRecord = {
    state: "sending",
    orderNumber: ctx.orderNumber,
    veeqoOrderId,
    channel: ctx.channel,
    via: target.via,
    tracking: target.tracking ?? `shipment-${target.shipmentId}`,
    carrier: target.carrier,
    shipmentId: target.shipmentId,
    source: ctx.source,
    startedAt: new Date().toISOString(),
  };

  // 1. Lock BEFORE the call. If the lock can't be written, nothing is sent.
  let lock: Awaited<ReturnType<typeof takeDiscardLock>>;
  try {
    lock = await takeDiscardLock(rec);
  } catch (e) {
    return {
      state: "refused",
      message: `Nothing was cancelled — couldn't record the attempt: ${e instanceof Error ? e.message.split("\n").pop() : e}`,
    };
  }
  if (!lock.ok) {
    const s = lock.existing.state;
    return {
      state: "refused",
      message:
        s === "done"
          ? `Already discarded on ${fmtWhen(lock.existing.finishedAt ?? lock.existing.startedAt)}.`
          : s === "sending"
            ? "A discard of this label is already running."
            : "An earlier discard of this label got no clear answer. Re-check its status before trying again.",
      record: lock.existing,
    };
  }

  // 2. The cancel call — exactly once.
  try {
    if (target.via === "walmart") {
      await discardShippingLabel(getWalmartClient(1), target.carrier ?? "", target.tracking ?? "");
    } else {
      await refundShipmentForOrder(String(veeqoOrderId), ctx.order, target.shipmentId ?? undefined);
    }
  } catch (e) {
    const { status, text } = cancelErrorInfo(e);
    // Veeqo answers 404 for a shipment that is no longer there — maybe
    // already cancelled. Read the order to know which.
    const unclear = !isDefinitiveRefusal(status) || (target.via === "veeqo" && status === 404);
    if (unclear && target.via === "veeqo" && veeqoOrderId && target.shipmentId) {
      const still = await veeqoShipmentStillThere(veeqoOrderId, target.shipmentId);
      if (still === false) {
        const done = { ...rec, state: "done" as const, finishedAt: new Date().toISOString(), message: `${REFUND_NOTE} (confirmed by reading the order back after: ${text})` };
        await writeDiscard(done);
        await markLabelDiscarded(done);
        return { state: "done", message: REFUND_NOTE, record: done };
      }
      if (still === true && status === 404) {
        const failed = { ...rec, state: "failed" as const, finishedAt: new Date().toISOString(), message: text };
        await writeDiscard(failed);
        return { state: "failed", message: text, record: failed };
      }
    }
    if (!unclear) {
      const failed = { ...rec, state: "failed" as const, finishedAt: new Date().toISOString(), message: text };
      await writeDiscard(failed);
      return { state: "failed", message: text, record: failed };
    }
    const message =
      target.via === "veeqo"
        ? `No clear answer from Veeqo (${text}). The cancel was NOT repeated — check the order in Veeqo, or re-check here in a minute.`
        : `No clear answer from Walmart (${text}). The cancel was NOT repeated — check the label in Seller Center before trying again.`;
    const unknown = { ...rec, state: "unknown" as const, finishedAt: new Date().toISOString(), message };
    await writeDiscard(unknown);
    return { state: "unknown", message, record: unknown };
  }

  const done = { ...rec, state: "done" as const, finishedAt: new Date().toISOString(), message: REFUND_NOTE };
  await writeDiscard(done);
  await markLabelDiscarded(done);
  return { state: "done", message: REFUND_NOTE, record: done };
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body falls back to ?orderId= */
  }
  const orderId = body.orderId ?? new URL(req.url).searchParams.get("orderId") ?? "";
  const orderNumberIn = (body.orderNumber ?? "").trim();
  const source = body.source === "archive" ? "archive" : "queue";
  if (!orderId && !orderNumberIn) {
    return NextResponse.json({ error: "orderId or orderNumber is required" }, { status: 400 });
  }

  try {
    // The channel and the labels come from Veeqo itself — the page could
    // be stale, the server is the source of truth.
    const order = await loadVeeqoOrder(orderId, orderNumberIn);
    if (!order) {
      return NextResponse.json(
        { ok: false, error: `Order ${orderNumberIn || orderId} wasn't found in Veeqo.` },
        { status: 404 },
      );
    }
    const channelType = (order?.channel?.type_code ?? "").toLowerCase();
    const orderNumber = String(order?.number ?? orderNumberIn ?? orderId);
    const channel = channelType || "amazon";

    // NAN labels are bought in Shopify (owner: NAN buys only there), and a
    // Shopify fulfilment shows up in Veeqo as a shipment Veeqo never sold —
    // deleting it would void nothing. Shopify's API can't void labels.
    const targets = isNan(order) ? [] : await resolveTargets(order, orderNumber, body);
    if (targets.length === 0) {
      if (isNan(order)) {
        return NextResponse.json(
          {
            ok: false,
            action: "shopify",
            adminUrl: nanAdminOrderUrl(null, orderNumber),
            error:
              "This NAN label was bought in Shopify — Shopify's API can't void labels. Open the order in Shopify admin and void the label there.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          ok: false,
          error: body.trackingNumber
            ? `Tracking ${body.trackingNumber} isn't a label on this order any more in ${channelType === "walmart" ? "Walmart or Veeqo" : "Veeqo"} — it was cancelled already or bought somewhere else.`
            : "No bought label found on this order.",
        },
        { status: 404 },
      );
    }

    const assessments = await Promise.all(targets.map(assess));
    const orderInfo = {
      orderId: order?.id != null ? String(order.id) : orderId,
      orderNumber,
      channel,
      status: String(order?.status ?? ""),
    };

    if (body.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        ...orderInfo,
        labels: assessments.map((a) => ({
          via: a.target.via,
          tracking: a.target.tracking,
          carrier: a.target.carrier,
          createdAt: a.target.createdAt,
          ...(body.debug ? { shipmentFields: a.target.fields ?? null } : {}),
          eligible: a.reasons.length === 0,
          reasons: a.reasons,
          warnings: a.warnings,
          carrierCheck: a.carrierCheck,
        })),
        eligible: assessments.some((a) => a.reasons.length === 0),
      });
    }

    const sendable = assessments.filter((a) => a.reasons.length === 0);
    if (sendable.length === 0) {
      const reasons = assessments.flatMap((a) => a.reasons);
      return NextResponse.json(
        { ok: false, state: "refused", error: reasons.join(" "), reasons },
        { status: 409 },
      );
    }

    const results = [];
    for (const a of sendable) {
      const r = await cancelOne(a, { order, orderNumber, channel, source });
      results.push({ tracking: a.target.tracking, carrier: a.target.carrier, via: a.target.via, ...r });
    }
    const done = results.filter((r) => r.state === "done");
    const notDone = results.filter((r) => r.state !== "done");
    if (done.length === 0) {
      const first = notDone[0];
      return NextResponse.json(
        { ok: false, state: first.state, error: first.message, results },
        { status: first.state === "unknown" ? 502 : first.state === "refused" ? 409 : 422 },
      );
    }
    return NextResponse.json({
      ok: true,
      state: "done",
      ...orderInfo,
      message: REFUND_NOTE,
      results,
      ...(notDone.length > 0 ? { partialErrors: notDone } : {}),
      ...(done[0].via === "veeqo"
        ? { shipmentId: done[0].record?.shipmentId ?? null }
        : { discarded: done.map((d) => ({ carrier: d.carrier, tracking: d.tracking })) }),
    });
  } catch (e: unknown) {
    const msg = cancelErrorInfo(e).text || "Unknown error";
    console.error("[shipping/discard-label]", { orderId, orderNumber: orderNumberIn, error: e });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/** A label's discard record. An unclear or stuck Veeqo attempt is settled
 *  by reading the order: shipment gone → done; still there → failed (the
 *  operator may then try once more, on purpose). Read-only towards Veeqo. */
export async function GET(req: NextRequest) {
  const tracking = (req.nextUrl.searchParams.get("tracking") ?? "").trim();
  if (!tracking) {
    return NextResponse.json({ error: "tracking is required" }, { status: 400 });
  }
  const rec = await readDiscard(tracking);
  if (!rec) return NextResponse.json({ record: null });
  const ageMs = Date.now() - Date.parse(rec.startedAt);
  if (
    (rec.state === "unknown" || (rec.state === "sending" && ageMs > 120_000)) &&
    rec.via === "veeqo" &&
    rec.veeqoOrderId &&
    rec.shipmentId &&
    ageMs > 30_000
  ) {
    const still = await veeqoShipmentStillThere(rec.veeqoOrderId, rec.shipmentId);
    if (still === false) {
      const done: DiscardRecord = { ...rec, state: "done", finishedAt: new Date().toISOString(), message: `${REFUND_NOTE} (confirmed on re-check)` };
      await writeDiscard(done);
      await markLabelDiscarded(done);
      return NextResponse.json({ record: done });
    }
    if (still === true) {
      const failed: DiscardRecord = {
        ...rec,
        state: "failed",
        finishedAt: new Date().toISOString(),
        message: "Re-checked: the label is still on the Veeqo order, so the cancel didn't go through. You can try once more.",
      };
      await writeDiscard(failed);
      return NextResponse.json({ record: failed });
    }
  }
  return NextResponse.json({ record: rec });
}
