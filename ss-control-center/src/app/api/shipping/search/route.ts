/**
 * GET /api/shipping/search?q=<free text>
 *
 * "Найти любой заказ" — the archive search behind the Shipping Labels
 * search box. Unlike /api/shipping/dashboard (which loads ONLY Veeqo's
 * `awaiting_fulfillment` bucket), this endpoint answers across EVERY
 * order status: shipped, delivered, cancelled, refunded, on hold. That
 * is the whole point — the operator uses it to look up an order they
 * already shipped, by tracking number, by address, by customer name or
 * by what was in the box.
 *
 * Two independent sources, queried in parallel and merged by order
 * number:
 *
 *   1. Veeqo `/orders?query=…` — their documented free-text search, with
 *      `status` deliberately omitted so every status comes back. This is
 *      the richest record: full address, line items, images, money.
 *
 *   2. Our own database — everything Veeqo's free-text index does NOT
 *      reliably cover, above all TRACKING NUMBERS of labels we bought:
 *        · AmazonOrder            — order id, buyer, city/state/ZIP
 *        · AmazonOrderShipment    — tracking, carrier, product, SKU/ASIN
 *        · WalmartOrder           — PO, customer order id, address, and
 *                                   the raw JSON payload (street, items)
 *        · WalmartLabelPurchase   — tracking of a Ship-with-Walmart label
 *        · MergeGroup             — tracking of a merged shipment
 *        · ShippingPlanItem       — tracking + the label PDF link
 *
 * Neither source is allowed to break the other: both run under
 * Promise.allSettled and a failure degrades the answer instead of
 * failing the request. `sources` on every hit says where it came from,
 * and `degraded` lists whichever source could not be reached.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchOrders } from "@/lib/veeqo/client";
import { utcToPacificYMD } from "@/lib/shipping/dates";

// Below 3 characters the result set is meaningless (every order matches
// "1") and the DB does a full-table LIKE scan for nothing.
const MIN_QUERY = 3;
const MAX_HITS = 60;
// Per-source row cap. Generous enough that a real lookup is never
// truncated, small enough that a two-character-ish query can't drag the
// whole orders table into memory.
const PER_SOURCE = 40;

type Tracking = {
  number: string;
  carrier: string | null;
  service: string | null;
};

type HitItem = {
  sku: string | null;
  title: string;
  quantity: number;
  imageUrl: string | null;
};

type SearchHit = {
  /** Dedupe key — normalised order number. */
  key: string;
  sources: string[];
  orderNumber: string;
  veeqoOrderId: string | null;
  channel: string | null;
  channelKind: string | null;
  /** Raw marketplace/Veeqo status, lower-cased. */
  status: string;
  /** Human label for the badge. */
  statusLabel: string;
  statusTone: "ok" | "warn" | "danger" | "neutral";
  orderDate: string | null;
  shipBy: string | null;
  deliverBy: string | null;
  customerName: string | null;
  customerEmail: string | null;
  /** Street + city/state/ZIP, as much as the source carried. */
  address: string | null;
  total: number | null;
  currency: string;
  items: HitItem[];
  tracking: Tracking[];
  labelPdfUrl: string | null;
  walmartPurchaseOrderId: string | null;
  storeName: string | null;
};

const norm = (s: string) => s.trim().toUpperCase();

/** Status → badge label + colour tone. Shared by every source. */
function statusMeta(raw: string): {
  label: string;
  tone: SearchHit["statusTone"];
} {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (s === "shipped") return { label: "Shipped", tone: "ok" };
  if (s === "delivered") return { label: "Delivered", tone: "ok" };
  if (s === "cancelled" || s === "canceled")
    return { label: "Cancelled", tone: "danger" };
  if (s === "refunded") return { label: "Refunded", tone: "danger" };
  if (s === "onhold") return { label: "On hold", tone: "warn" };
  if (s === "awaitingfulfillment" || s === "unshipped" || s === "acknowledged")
    return { label: "Awaiting fulfillment", tone: "warn" };
  if (s === "awaitingpayment") return { label: "Awaiting payment", tone: "warn" };
  if (s === "awaitingstock") return { label: "Awaiting stock", tone: "warn" };
  if (s === "created" || s === "pending") return { label: "New", tone: "warn" };
  return { label: raw || "—", tone: "neutral" };
}

function joinAddress(parts: Array<string | null | undefined>): string | null {
  const line = parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(", ");
  return line || null;
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Veeqo carries the image under a different key per channel. */
function pickImage(li: any): string | null {
  const s = li?.sellable ?? {};
  const p = s.product ?? {};
  for (const c of [
    s.image_url,
    s.main_image?.src,
    s.main_image?.url,
    p.main_image_src,
    p.main_image_url,
    p.image_url,
    p.images?.[0]?.src,
    p.images?.[0]?.url,
  ]) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return null;
}

/** Tracking lives on the allocation's shipment; shape varies by carrier. */
function veeqoTracking(o: any): Tracking[] {
  const out: Tracking[] = [];
  const seen = new Set<string>();
  for (const alloc of o?.allocations ?? []) {
    const shipments = [
      alloc?.shipment,
      ...(Array.isArray(alloc?.shipments) ? alloc.shipments : []),
    ].filter(Boolean);
    for (const sh of shipments) {
      const num = String(
        sh?.tracking_number ?? sh?.tracking_number_string ?? "",
      ).trim();
      if (!num || seen.has(num)) continue;
      seen.add(num);
      out.push({
        number: num,
        carrier:
          (sh?.carrier?.name as string | undefined) ??
          (sh?.carrier_name as string | undefined) ??
          null,
        service:
          (sh?.service_carrier as string | undefined) ??
          (sh?.shipping_method as string | undefined) ??
          null,
      });
    }
  }
  return out;
}

function fromVeeqo(o: any): SearchHit {
  const dt = o?.deliver_to ?? {};
  const name =
    [dt.first_name, dt.last_name]
      .map((x: unknown) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
      .join(" ") || null;
  const status = String(o?.status ?? "").toLowerCase();
  const meta = statusMeta(status);
  const number = String(o?.number ?? o?.id ?? "");
  return {
    key: norm(number),
    sources: ["veeqo"],
    orderNumber: number,
    veeqoOrderId: o?.id != null ? String(o.id) : null,
    channel: (o?.channel?.name as string | undefined) ?? null,
    channelKind:
      ((o?.channel?.type_code as string | undefined) ?? "").toLowerCase() ||
      null,
    status,
    statusLabel: meta.label,
    statusTone: meta.tone,
    orderDate: isoOrNull(o?.created_at ?? o?.ordered_at ?? null),
    shipBy: o?.dispatch_date ? utcToPacificYMD(o.dispatch_date) : null,
    deliverBy: o?.due_date ? utcToPacificYMD(o.due_date) : null,
    customerName: name,
    customerEmail:
      (o?.customer?.email as string | undefined) ??
      (dt.email as string | undefined) ??
      null,
    address: joinAddress([
      dt.address1,
      dt.address2,
      dt.city,
      dt.state,
      dt.zip,
    ]),
    total: Number(o?.total_price ?? o?.subtotal_price ?? 0) || null,
    currency: (o?.currency_code as string | undefined) ?? "USD",
    items: (o?.line_items ?? []).map((li: any): HitItem => {
      const sellable = li?.sellable ?? {};
      const sku = String(sellable?.sku_code ?? sellable?.sku ?? "").trim();
      return {
        sku: sku || null,
        title: String(
          sellable?.product_title ?? sellable?.product?.title ?? sku ?? "",
        ),
        quantity: Number(li?.quantity ?? 1) || 1,
        imageUrl: pickImage(li),
      };
    }),
    tracking: veeqoTracking(o),
    labelPdfUrl: null,
    walmartPurchaseOrderId: null,
    storeName: (o?.channel?.name as string | undefined) ?? null,
  };
}

/**
 * Merge a hit into the accumulator. The first record for an order number
 * wins on identity fields; later ones only FILL IN what is still empty
 * and append tracking. Veeqo is seeded first (richest record), so DB
 * rows contribute exactly what Veeqo lacks — tracking, the label PDF,
 * the Walmart PO — without overwriting a good address with a partial one.
 */
function mergeHit(acc: Map<string, SearchHit>, hit: SearchHit) {
  const existing = acc.get(hit.key);
  if (!existing) {
    acc.set(hit.key, hit);
    return;
  }
  for (const s of hit.sources) {
    if (!existing.sources.includes(s)) existing.sources.push(s);
  }
  const fill = <K extends keyof SearchHit>(k: K) => {
    if (
      (existing[k] === null || existing[k] === undefined || existing[k] === "") &&
      hit[k] != null &&
      hit[k] !== ""
    ) {
      existing[k] = hit[k];
    }
  };
  (
    [
      "veeqoOrderId",
      "channel",
      "channelKind",
      "orderDate",
      "shipBy",
      "deliverBy",
      "customerName",
      "customerEmail",
      "address",
      "total",
      "labelPdfUrl",
      "walmartPurchaseOrderId",
      "storeName",
    ] as Array<keyof SearchHit>
  ).forEach(fill);
  if (existing.items.length === 0 && hit.items.length > 0)
    existing.items = hit.items;
  for (const t of hit.tracking) {
    if (!existing.tracking.some((x) => x.number === t.number))
      existing.tracking.push(t);
  }
  // A marketplace status (Amazon "Canceled", Walmart "Delivered") is more
  // specific than Veeqo's — take it when Veeqo only said "shipped".
  if (
    existing.statusTone === "neutral" ||
    (existing.status === "shipped" && hit.status === "delivered") ||
    (existing.status !== "cancelled" && hit.status.startsWith("cancel"))
  ) {
    existing.status = hit.status;
    existing.statusLabel = hit.statusLabel;
    existing.statusTone = hit.statusTone;
  }
}

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY) {
    return NextResponse.json({
      query: q,
      hits: [],
      degraded: [],
      note: `Введите минимум ${MIN_QUERY} символа`,
    });
  }

  // Wall-clock per source. This endpoint is type-ahead: anything over a
  // second is felt, and when it IS slow we need to know which half to
  // blame (Veeqo's API vs our Turso queries) without reproducing it.
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  // ── Source 1: Veeqo free-text, ALL statuses ────────────────────────
  const veeqoTask = searchOrders(q, { pageSize: PER_SOURCE }).finally(() => {
    timings.veeqo = Date.now() - t0;
  });

  // ── Source 2: our DB ───────────────────────────────────────────────
  const dbTask = (async () => {
    const tDb = Date.now();
    const like = { contains: q } as const; // SQLite LIKE — ASCII case-insensitive
    const [
      amazonOrders,
      amazonShipments,
      walmartOrders,
      walmartLabels,
      mergeGroups,
      planItems,
    ] = await Promise.all([
      prisma.amazonOrder.findMany({
        where: {
          OR: [
            { amazonOrderId: like },
            { buyerName: like },
            { buyerEmail: like },
            { shipCity: like },
            { shipState: like },
            { shipZip: like },
          ],
        },
        orderBy: { purchaseDate: "desc" },
        take: PER_SOURCE,
      }),
      prisma.amazonOrderShipment.findMany({
        where: {
          OR: [
            { amazonOrderId: like },
            { trackingNumber: like },
            { productName: like },
            { sku: like },
            { asin: like },
          ],
        },
        take: PER_SOURCE,
      }),
      prisma.walmartOrder.findMany({
        where: {
          OR: [
            { purchaseOrderId: like },
            { customerOrderId: like },
            { customerEmailId: like },
            { shipCity: like },
            { shipState: like },
            { shipZip: like },
            // The raw payload carries the street address, the buyer name
            // and every line item — the fields Walmart's own columns on
            // this table don't model.
            { rawData: like },
          ],
        },
        orderBy: { orderDate: "desc" },
        take: PER_SOURCE,
      }),
      prisma.walmartLabelPurchase.findMany({
        where: {
          OR: [
            { trackingNumber: like },
            { customerOrderId: like },
            { purchaseOrderId: like },
          ],
        },
        take: PER_SOURCE,
      }),
      prisma.mergeGroup.findMany({
        where: { OR: [{ trackingNumber: like }, { id: like }] },
        include: { members: true },
        take: PER_SOURCE,
      }),
      // ShippingPlanItem is by far the biggest table here (>120k rows) and
      // none of the columns we search are indexed, so every predicate is a
      // full scan. Two deliberate limits keep it from dominating the whole
      // request:
      //   · IDENTIFIER COLUMNS ONLY. Searching `product`/`sku` here added
      //     seconds and returned nothing the other sources don't already
      //     cover (Amazon products come from AmazonOrderShipment, Walmart
      //     products from WalmartOrder.rawData). What this table uniquely
      //     owns is the tracking number and the label PDF link.
      //   · NO ORDER BY. Sorting 120k unindexed rows by createdAt cost ~10s
      //     on its own; the merged result set is sorted by date afterwards
      //     anyway.
      prisma.shippingPlanItem.findMany({
        where: {
          OR: [
            { orderNumber: like },
            { orderId: like },
            { trackingNumber: like },
          ],
        },
        take: PER_SOURCE,
      }),
    ]);
    timings.dbPrimary = Date.now() - tDb;

    // Shipment rows point at an order that may not itself have matched
    // (e.g. the query IS a tracking number) — pull those parents in.
    const parentIds = [
      ...new Set(amazonShipments.map((s) => s.amazonOrderId)),
    ].filter((id) => !amazonOrders.some((o) => o.amazonOrderId === id));
    const parentOrders = parentIds.length
      ? await prisma.amazonOrder.findMany({
          where: { amazonOrderId: { in: parentIds } },
        })
      : [];

    // Same for Walmart: a matched label/PO needs its order record.
    const wmIds = [
      ...new Set(walmartLabels.map((l) => l.purchaseOrderId)),
    ].filter((id) => !walmartOrders.some((o) => o.purchaseOrderId === id));
    const wmParents = wmIds.length
      ? await prisma.walmartOrder.findMany({
          where: { purchaseOrderId: { in: wmIds } },
        })
      : [];

    // …and the reverse: a Walmart order matched by product or address
    // still needs the tracking number of the label we bought for it, which
    // only the label table has. Without this backfill a product search
    // shows the order with an empty tracking chip while the same order
    // searched BY its tracking number shows it — the same record, two
    // different answers.
    const allWalmart = [...walmartOrders, ...wmParents];
    const missingLabelPos = allWalmart
      .map((o) => o.purchaseOrderId)
      .filter((po) => !walmartLabels.some((l) => l.purchaseOrderId === po));
    const extraLabels = missingLabelPos.length
      ? await prisma.walmartLabelPurchase.findMany({
          where: { purchaseOrderId: { in: missingLabelPos } },
        })
      : [];

    timings.db = Date.now() - tDb;
    return {
      amazonOrders: [...amazonOrders, ...parentOrders],
      amazonShipments,
      walmartOrders: allWalmart,
      walmartLabels: [...walmartLabels, ...extraLabels],
      mergeGroups,
      planItems,
    };
  })();

  const [veeqoRes, dbRes] = await Promise.allSettled([veeqoTask, dbTask]);
  const degraded: string[] = [];

  const acc = new Map<string, SearchHit>();

  // Veeqo first — richest record, so it seeds identity for each order.
  if (veeqoRes.status === "fulfilled") {
    for (const o of veeqoRes.value) mergeHit(acc, fromVeeqo(o));
  } else {
    degraded.push("veeqo");
    console.warn(
      "[api/shipping/search] Veeqo search failed:",
      veeqoRes.reason instanceof Error ? veeqoRes.reason.message : veeqoRes.reason,
    );
  }

  if (dbRes.status === "fulfilled") {
    const db = dbRes.value;

    // Amazon orders + their shipments (tracking, product, image).
    const shipmentsByOrder = new Map<string, typeof db.amazonShipments>();
    for (const s of db.amazonShipments) {
      const list = shipmentsByOrder.get(s.amazonOrderId) ?? [];
      list.push(s);
      shipmentsByOrder.set(s.amazonOrderId, list);
    }
    for (const o of db.amazonOrders) {
      const shipments = shipmentsByOrder.get(o.amazonOrderId) ?? [];
      const meta = statusMeta(o.status);
      mergeHit(acc, {
        key: norm(o.amazonOrderId),
        sources: ["amazon-db"],
        orderNumber: o.amazonOrderId,
        veeqoOrderId: null,
        channel: o.salesChannel ?? "Amazon",
        channelKind: "amazon",
        status: o.status.toLowerCase(),
        statusLabel: meta.label,
        statusTone: meta.tone,
        orderDate: isoOrNull(o.purchaseDate),
        shipBy: o.latestShipDate ? utcToPacificYMD(o.latestShipDate) : null,
        deliverBy: o.latestDeliveryDate
          ? utcToPacificYMD(o.latestDeliveryDate)
          : null,
        customerName: o.buyerName,
        customerEmail: o.buyerEmail,
        address: joinAddress([o.shipCity, o.shipState, o.shipZip]),
        total: o.orderTotal || null,
        currency: o.currency || "USD",
        items: shipments
          .filter((s) => s.productName || s.sku)
          .map((s) => ({
            sku: s.sku,
            title: s.productName ?? s.sku ?? "",
            quantity: 1,
            imageUrl: s.productImageUrl,
          })),
        tracking: shipments
          .filter((s) => s.trackingNumber)
          .map((s) => ({
            number: s.trackingNumber as string,
            carrier: s.carrier ?? s.carrierInferred ?? null,
            service: s.shipServiceLevel ?? null,
          })),
        labelPdfUrl: null,
        walmartPurchaseOrderId: null,
        storeName: null,
      });
    }

    // Orphan shipments — the parent order never synced, but we still know
    // the tracking and what was in it. Better a partial row than nothing.
    for (const s of db.amazonShipments) {
      if (db.amazonOrders.some((o) => o.amazonOrderId === s.amazonOrderId))
        continue;
      mergeHit(acc, {
        key: norm(s.amazonOrderId),
        sources: ["amazon-shipment"],
        orderNumber: s.amazonOrderId,
        veeqoOrderId: null,
        channel: "Amazon",
        channelKind: "amazon",
        status: "shipped",
        statusLabel: "Shipped",
        statusTone: "ok",
        orderDate: s.shipDate ? isoOrNull(s.shipDate) : null,
        shipBy: s.shipDate ?? null,
        deliverBy: s.promiseDate ?? null,
        customerName: null,
        customerEmail: null,
        address: null,
        total: null,
        currency: "USD",
        items:
          s.productName || s.sku
            ? [
                {
                  sku: s.sku,
                  title: s.productName ?? s.sku ?? "",
                  quantity: 1,
                  imageUrl: s.productImageUrl,
                },
              ]
            : [],
        tracking: s.trackingNumber
          ? [
              {
                number: s.trackingNumber,
                carrier: s.carrier ?? s.carrierInferred ?? null,
                service: s.shipServiceLevel ?? null,
              },
            ]
          : [],
        labelPdfUrl: null,
        walmartPurchaseOrderId: null,
        storeName: null,
      });
    }

    // Walmart orders — the raw payload has the address + line items.
    // An active label wins over a discarded one for the same PO: after a
    // discard-and-rebuy both rows exist, and the tracking that matters is
    // the one actually on the box.
    const labelsByPo = new Map<string, (typeof db.walmartLabels)[number]>();
    for (const l of db.walmartLabels) {
      const cur = labelsByPo.get(l.purchaseOrderId);
      if (!cur || (cur.discardedAt && !l.discardedAt))
        labelsByPo.set(l.purchaseOrderId, l);
    }
    for (const o of db.walmartOrders) {
      let raw: any = null;
      try {
        raw = JSON.parse(o.rawData);
      } catch {
        /* a malformed cache blob must not sink the search */
      }
      const post = raw?.shippingInfo?.postalAddress ?? {};
      const label = labelsByPo.get(o.purchaseOrderId);
      const meta = statusMeta(o.status);
      // `rawData` is Walmart's own payload, where the lines are nested one
      // level deeper: `orderLines.orderLine[]`. (Our WalmartOrdersApi
      // wrapper flattens that to `orderLines[]`, but what got persisted
      // here is the raw body, not the wrapper's view of it.) Accept both
      // so an older cached row still yields its items.
      const lines: any[] = Array.isArray(raw?.orderLines?.orderLine)
        ? raw.orderLines.orderLine
        : Array.isArray(raw?.orderLines)
          ? raw.orderLines
          : [];
      mergeHit(acc, {
        key: norm(o.customerOrderId),
        sources: ["walmart-db"],
        orderNumber: o.customerOrderId,
        veeqoOrderId: null,
        channel: "Walmart",
        channelKind: "walmart",
        status: o.status.toLowerCase(),
        statusLabel: meta.label,
        statusTone: meta.tone,
        orderDate: isoOrNull(o.orderDate),
        shipBy: o.estimatedShipDate ? utcToPacificYMD(o.estimatedShipDate) : null,
        deliverBy: o.estimatedDeliveryDate
          ? utcToPacificYMD(o.estimatedDeliveryDate)
          : null,
        customerName:
          (typeof post?.name === "string" ? post.name : null) ?? null,
        customerEmail: o.customerEmailId,
        address:
          joinAddress([
            post?.address1,
            post?.address2,
            post?.city ?? o.shipCity,
            post?.state ?? o.shipState,
            post?.postalCode ?? o.shipZip,
          ]) ?? joinAddress([o.shipCity, o.shipState, o.shipZip]),
        total: o.orderTotal || null,
        currency: o.currency || "USD",
        items: lines.map((l) => ({
          sku: (l?.item?.sku as string | undefined) ?? null,
          title: String(l?.item?.productName ?? l?.item?.sku ?? ""),
          quantity:
            Number(l?.orderLineQuantity?.amount ?? l?.orderedQty ?? 1) || 1,
          imageUrl: (l?.item?.imageUrl as string | undefined) ?? null,
        })),
        tracking: label
          ? [
              {
                number: label.trackingNumber,
                carrier: label.carrierName,
                // A discarded label is still findable by its tracking
                // number, so say so instead of showing it as live.
                service: label.discardedAt
                  ? "этикетка отменена"
                  : label.serviceType,
              },
            ]
          : [],
        labelPdfUrl: null,
        walmartPurchaseOrderId: o.purchaseOrderId,
        storeName: "Walmart",
      });
    }

    // A label whose Walmart order row never synced — keyed by the
    // customer order number the dashboard also uses.
    for (const l of db.walmartLabels) {
      if (db.walmartOrders.some((o) => o.purchaseOrderId === l.purchaseOrderId))
        continue;
      mergeHit(acc, {
        key: norm(l.customerOrderId),
        sources: ["walmart-label"],
        orderNumber: l.customerOrderId,
        veeqoOrderId: null,
        channel: "Walmart",
        channelKind: "walmart",
        status: l.discardedAt ? "cancelled" : "shipped",
        statusLabel: l.discardedAt ? "Label discarded" : "Label bought",
        statusTone: l.discardedAt ? "danger" : "ok",
        orderDate: isoOrNull(l.boughtAt),
        shipBy: null,
        deliverBy: null,
        customerName: null,
        customerEmail: null,
        address: null,
        total: null,
        currency: "USD",
        items: [],
        tracking: [
          {
            number: l.trackingNumber,
            carrier: l.carrierName,
            service: l.serviceType,
          },
        ],
        labelPdfUrl: null,
        walmartPurchaseOrderId: l.purchaseOrderId,
        storeName: "Walmart",
      });
    }

    // Merged shipments — one tracking number covering several orders.
    for (const g of db.mergeGroups) {
      for (const m of g.members) {
        mergeHit(acc, {
          key: norm(m.orderNumber),
          sources: ["merge-group"],
          orderNumber: m.orderNumber,
          veeqoOrderId: m.orderId,
          channel: g.storeName ?? null,
          channelKind: g.channelKind,
          status: g.status === "bought" ? "shipped" : g.status,
          statusLabel:
            g.status === "bought" ? "Shipped (merged)" : `Merge ${g.status}`,
          statusTone: g.status === "bought" ? "ok" : "neutral",
          orderDate: isoOrNull(g.boughtAt ?? g.createdAt),
          shipBy: null,
          deliverBy: null,
          customerName: null,
          customerEmail: null,
          address: null,
          total: null,
          currency: "USD",
          items: [],
          tracking: g.trackingNumber
            ? [
                {
                  number: g.trackingNumber,
                  carrier: g.carrier,
                  service: g.service,
                },
              ]
            : [],
          labelPdfUrl: g.labelPdfUrl,
          walmartPurchaseOrderId: m.walmartPurchaseOrderId,
          storeName: g.storeName,
        });
      }
    }

    // Plan items — where the label PDF link lives for Veeqo-bought labels.
    for (const p of db.planItems) {
      mergeHit(acc, {
        key: norm(p.orderNumber),
        sources: ["plan"],
        orderNumber: p.orderNumber,
        veeqoOrderId: p.orderId,
        channel: p.channel,
        channelKind: p.channelKind?.toLowerCase() ?? null,
        status: p.status === "bought" ? "shipped" : p.status,
        statusLabel: p.status === "bought" ? "Label bought" : p.status,
        statusTone: p.status === "bought" ? "ok" : "neutral",
        orderDate: isoOrNull(p.createdAt),
        shipBy: p.physicalShipDate ?? p.actualShipDay ?? p.labelDate ?? null,
        deliverBy: p.deliveryBy,
        customerName: null,
        customerEmail: null,
        address: null,
        total: null,
        currency: "USD",
        items: p.product
          ? [
              {
                sku: p.sku,
                title: p.product,
                quantity: p.qty,
                imageUrl: null,
              },
            ]
          : [],
        tracking: p.trackingNumber
          ? [
              {
                number: p.trackingNumber,
                carrier: p.carrier,
                service: p.service ?? p.serviceType,
              },
            ]
          : [],
        labelPdfUrl: p.labelPdfUrl,
        walmartPurchaseOrderId: null,
        storeName: null,
      });
    }
  } else {
    degraded.push("database");
    console.warn(
      "[api/shipping/search] DB search failed:",
      dbRes.reason instanceof Error ? dbRes.reason.message : dbRes.reason,
    );
  }

  const hits = [...acc.values()]
    .sort((a, b) => {
      const at = a.orderDate ? new Date(a.orderDate).getTime() : 0;
      const bt = b.orderDate ? new Date(b.orderDate).getTime() : 0;
      return bt - at;
    })
    .slice(0, MAX_HITS);

  timings.total = Date.now() - t0;
  if (timings.total > 1500) {
    console.warn(
      `[api/shipping/search] slow: q=${JSON.stringify(q)} ${JSON.stringify(timings)}`,
    );
  }

  return NextResponse.json({
    query: q,
    hits,
    total: acc.size,
    truncated: acc.size > hits.length,
    degraded,
    timings,
  });
}
