/**
 * GET /api/sales-overview
 *
 * Unified sales analytics across all channels we cache locally
 * (AmazonOrder + WalmartOrder). Powers the /analytics page rewrite
 * as "Sales Overview".
 *
 * Query params:
 *   from=YYYY-MM-DD                 — start of window (Eastern TZ wall date)
 *   to=YYYY-MM-DD                   — end of window (inclusive)
 *   preset=today|yesterday|mtd|lastMonth|last7|last30|last90  — convenience
 *   channel=amazon|walmart|all      — limit to one channel (default: all)
 *   storeIndex=1..5                 — Amazon store filter; ignored when channel=walmart
 *   limitOrders=200                 — max orders to return in `orders` list (default 200)
 *
 * Response shape:
 *   {
 *     period: { from, to, days, label },
 *     comparison: { from, to, days, label },  // prior window of same length
 *     summary: {
 *       revenue, orders, avgOrder, shipped, cancelled, pending,
 *       prior: { revenue, orders, avgOrder, shipped, cancelled, pending },
 *     },
 *     dailyRevenue: [{ date, revenue, orders }],
 *     byChannel: [{ channel, revenue, orders }],   // amazon / walmart split
 *     byStore: [{ storeIndex, storeName, channel, revenue, orders }],
 *     byStatus: [{ status, count }],
 *     topSkus: [{ sku, productName, revenue, qty }],   // Amazon-cached SKUs (Walmart SKUs live in rawData JSON, parsed on demand)
 *     orders: [{ source, id, number, date, total, currency, status, customer, city, state, itemsCount, storeIndex, storeName }],
 *     totalOrdersInWindow: number,                 // != orders.length when truncated
 *   }
 *
 * The endpoint reads only from our local cache (AmazonOrder / WalmartOrder),
 * which the existing orders-amazon / orders-walmart crons keep fresh. No
 * Veeqo calls here — that keeps response time well under a second even
 * for year-long windows.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
} from "date-fns";

export const maxDuration = 60;

const TZ = "America/New_York";

type Preset =
  | "today"
  | "yesterday"
  | "mtd"
  | "lastMonth"
  | "last7"
  | "last30"
  | "last90";

function asUtc(zoned: Date): Date {
  return fromZonedTime(zoned, TZ);
}

function presetWindow(
  preset: Preset,
  now: Date,
): { from: Date; to: Date; label: string } {
  const nowEt = toZonedTime(now, TZ);
  switch (preset) {
    case "today":
      return { from: asUtc(startOfDay(nowEt)), to: now, label: "Today" };
    case "yesterday": {
      const y = subDays(nowEt, 1);
      return {
        from: asUtc(startOfDay(y)),
        to: asUtc(endOfDay(y)),
        label: "Yesterday",
      };
    }
    case "mtd":
      return {
        from: asUtc(startOfMonth(nowEt)),
        to: now,
        label: "Month to date",
      };
    case "lastMonth": {
      const lm = subMonths(nowEt, 1);
      return {
        from: asUtc(startOfMonth(lm)),
        to: asUtc(endOfMonth(lm)),
        label: "Last month",
      };
    }
    case "last7":
      return {
        from: asUtc(startOfDay(subDays(nowEt, 6))),
        to: now,
        label: "Last 7 days",
      };
    case "last30":
      return {
        from: asUtc(startOfDay(subDays(nowEt, 29))),
        to: now,
        label: "Last 30 days",
      };
    case "last90":
      return {
        from: asUtc(startOfDay(subDays(nowEt, 89))),
        to: now,
        label: "Last 90 days",
      };
  }
}

function parseDateParam(value: string | null, endOfTheDay = false): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const wall = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
  const inEt = toZonedTime(wall, TZ);
  return asUtc(endOfTheDay ? endOfDay(inEt) : startOfDay(inEt));
}

function amazonStoreName(storeIndex: number): string {
  return process.env[`STORE${storeIndex}_NAME`] || `Amazon Store ${storeIndex}`;
}

function walmartStoreName(storeIndex: number): string {
  return (
    process.env[`WALMART_STORE${storeIndex}_NAME`] || `Walmart Store ${storeIndex}`
  );
}

// ─────────────────────────────────────────────────────────────────────
// Order normalization — collapse the two cached schemas into one
// uniform shape so the rest of the analytics layer is channel-agnostic.
// ─────────────────────────────────────────────────────────────────────
interface NormalizedOrder {
  source: "amazon" | "walmart";
  id: string;
  number: string;
  date: Date;
  total: number;
  currency: string;
  status: string; // normalized: shipped / cancelled / pending / unshipped / etc
  rawStatus: string;
  customer: string | null;
  city: string | null;
  state: string | null;
  itemsCount: number;
  storeIndex: number;
  storeName: string;
  channel: "amazon" | "walmart";
}

/** Normalize cancelled/canceled and Walmart's status terms onto a single
 *  vocabulary so the byStatus chart aggregates cleanly. */
function normalizeStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "cancelled" || s === "canceled") return "Cancelled";
  if (s === "shipped" || s === "delivered") return "Shipped";
  if (s === "unshipped") return "Unshipped";
  if (s === "pending") return "Pending";
  if (s === "acknowledged") return "Acknowledged";
  if (s === "created") return "Created";
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────
// Aggregations — pure functions over a NormalizedOrder[]; tested via
// the page just by inspection.
// ─────────────────────────────────────────────────────────────────────
function buildDailyRevenue(
  orders: NormalizedOrder[],
  from: Date,
  to: Date,
): Array<{ date: string; revenue: number; orders: number }> {
  const map = new Map<string, { revenue: number; orders: number }>();
  for (const o of orders) {
    // Bucket on the local-Eastern date so day boundaries match the
    // operator's clock, not UTC's. Without this an order placed at
    // 22:00 ET would land in tomorrow's bucket.
    const etDate = toZonedTime(o.date, TZ);
    const key = `${etDate.getFullYear()}-${String(etDate.getMonth() + 1).padStart(2, "0")}-${String(etDate.getDate()).padStart(2, "0")}`;
    const row = map.get(key) ?? { revenue: 0, orders: 0 };
    row.revenue += o.total;
    row.orders++;
    map.set(key, row);
  }
  // Fill missing days with zero so the chart x-axis is continuous.
  const out: Array<{ date: string; revenue: number; orders: number }> = [];
  const fromEt = toZonedTime(from, TZ);
  const toEt = toZonedTime(to, TZ);
  const cursor = new Date(
    fromEt.getFullYear(),
    fromEt.getMonth(),
    fromEt.getDate(),
  );
  const end = new Date(
    toEt.getFullYear(),
    toEt.getMonth(),
    toEt.getDate(),
  );
  while (cursor <= end) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const row = map.get(key) ?? { revenue: 0, orders: 0 };
    out.push({
      date: key,
      revenue: Math.round(row.revenue * 100) / 100,
      orders: row.orders,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function buildChannelBreakdown(orders: NormalizedOrder[]) {
  const map = new Map<string, { revenue: number; orders: number }>();
  for (const o of orders) {
    const row = map.get(o.channel) ?? { revenue: 0, orders: 0 };
    row.revenue += o.total;
    row.orders++;
    map.set(o.channel, row);
  }
  return [...map.entries()]
    .map(([channel, v]) => ({
      channel,
      revenue: Math.round(v.revenue * 100) / 100,
      orders: v.orders,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function buildStoreBreakdown(orders: NormalizedOrder[]) {
  const map = new Map<
    string,
    {
      storeIndex: number;
      storeName: string;
      channel: string;
      revenue: number;
      orders: number;
    }
  >();
  for (const o of orders) {
    const key = `${o.channel}-${o.storeIndex}`;
    const row = map.get(key) ?? {
      storeIndex: o.storeIndex,
      storeName: o.storeName,
      channel: o.channel,
      revenue: 0,
      orders: 0,
    };
    row.revenue += o.total;
    row.orders++;
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);
}

function buildStatusBreakdown(orders: NormalizedOrder[]) {
  const map = new Map<string, number>();
  for (const o of orders) map.set(o.status, (map.get(o.status) ?? 0) + 1);
  return [...map.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}

function summarize(orders: NormalizedOrder[]) {
  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const n = orders.length;
  const status = (s: string) =>
    orders.filter((o) => o.status.toLowerCase() === s.toLowerCase()).length;
  return {
    revenue: Math.round(revenue * 100) / 100,
    orders: n,
    avgOrder: n > 0 ? Math.round((revenue / n) * 100) / 100 : 0,
    shipped: status("Shipped"),
    cancelled: status("Cancelled"),
    pending: status("Pending") + status("Acknowledged") + status("Created"),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Top SKUs — Amazon SKUs come from AmazonOrderShipment.sku +
// productName (already enriched by the shipments-amazon cron). Walmart
// line items live in WalmartOrder.rawData JSON; parsing every order
// on every page-load is wasteful, so for v1 we only roll up Amazon
// SKUs. Walmart top-SKU is a follow-up that probably wants its own
// pre-aggregated table.
// ─────────────────────────────────────────────────────────────────────
async function buildTopSkus(
  from: Date,
  to: Date,
  amazonStoreIndex: number | null,
  limit = 10,
): Promise<Array<{ sku: string; productName: string | null; qty: number }>> {
  const shipments = await prisma.amazonOrderShipment.findMany({
    where: {
      sku: { not: null },
      // Approximate: shipments cron writes records around the time the
      // matching AmazonOrder was synced; createdAt is the closest field
      // we have for a date filter without joining the orders table.
      createdAt: { gte: from, lte: to },
      ...(amazonStoreIndex ? { storeIndex: amazonStoreIndex } : {}),
    },
    select: { sku: true, productName: true },
  });
  const map = new Map<string, { productName: string | null; qty: number }>();
  for (const s of shipments) {
    if (!s.sku) continue;
    const row = map.get(s.sku) ?? { productName: s.productName, qty: 0 };
    row.qty++;
    if (!row.productName && s.productName) row.productName = s.productName;
    map.set(s.sku, row);
  }
  return [...map.entries()]
    .map(([sku, v]) => ({ sku, productName: v.productName, qty: v.qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────
// Order loaders — Amazon + Walmart fetched in parallel, normalized,
// merged into one array.
// ─────────────────────────────────────────────────────────────────────
async function loadAmazonOrders(
  from: Date,
  to: Date,
  storeIndex: number | null,
): Promise<NormalizedOrder[]> {
  const rows = await prisma.amazonOrder.findMany({
    where: {
      purchaseDate: { gte: from, lte: to },
      ...(storeIndex ? { storeIndex } : {}),
    },
    orderBy: { purchaseDate: "desc" },
  });
  return rows.map((r) => ({
    source: "amazon",
    id: r.id,
    number: r.amazonOrderId,
    date: r.purchaseDate,
    total: r.orderTotal,
    currency: r.currency,
    status: normalizeStatus(r.status),
    rawStatus: r.status,
    customer: r.buyerName,
    city: r.shipCity,
    state: r.shipState,
    itemsCount: r.numberOfItems,
    storeIndex: r.storeIndex,
    storeName: amazonStoreName(r.storeIndex),
    channel: "amazon",
  }));
}

async function loadWalmartOrders(
  from: Date,
  to: Date,
): Promise<NormalizedOrder[]> {
  const rows = await prisma.walmartOrder.findMany({
    where: { orderDate: { gte: from, lte: to } },
    orderBy: { orderDate: "desc" },
  });
  return rows.map((r) => ({
    source: "walmart",
    id: r.id,
    number: r.customerOrderId,
    date: r.orderDate,
    total: r.orderTotal,
    currency: r.currency,
    status: normalizeStatus(r.status),
    rawStatus: r.status,
    customer: null, // Walmart doesn't expose buyer name on the order resource
    city: r.shipCity,
    state: r.shipState,
    itemsCount: r.numberOfItems,
    storeIndex: r.storeIndex,
    storeName: walmartStoreName(r.storeIndex),
    channel: "walmart",
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const presetParam = sp.get("preset") as Preset | null;
    const fromParam = parseDateParam(sp.get("from"));
    const toParam = parseDateParam(sp.get("to"), true);
    const channelParam = sp.get("channel") as
      | "amazon"
      | "walmart"
      | "all"
      | null;
    const channel = channelParam ?? "all";
    const storeIndexRaw = sp.get("storeIndex");
    const storeIndex = storeIndexRaw ? parseInt(storeIndexRaw, 10) : null;
    const limitOrders = Math.min(
      Math.max(parseInt(sp.get("limitOrders") || "200", 10), 1),
      1000,
    );

    const now = new Date();
    let from: Date;
    let to: Date;
    let label: string;
    if (fromParam && toParam) {
      from = fromParam;
      to = toParam;
      label = "Custom range";
    } else {
      const win = presetWindow(presetParam ?? "last30", now);
      from = win.from;
      to = win.to;
      label = win.label;
    }

    // Prior window = same length immediately before `from`. Used for
    // delta metrics ("revenue +14% vs prior period").
    const windowMs = to.getTime() - from.getTime();
    const priorTo = new Date(from.getTime() - 1);
    const priorFrom = new Date(priorTo.getTime() - windowMs);

    // Run current + prior window loads in parallel so the response time
    // is dominated by the slower of the two, not their sum.
    const [
      amzCurrent,
      wmCurrent,
      amzPrior,
      wmPrior,
      topSkus,
    ] = await Promise.all([
      channel === "walmart"
        ? Promise.resolve([] as NormalizedOrder[])
        : loadAmazonOrders(from, to, storeIndex),
      channel === "amazon"
        ? Promise.resolve([] as NormalizedOrder[])
        : loadWalmartOrders(from, to),
      channel === "walmart"
        ? Promise.resolve([] as NormalizedOrder[])
        : loadAmazonOrders(priorFrom, priorTo, storeIndex),
      channel === "amazon"
        ? Promise.resolve([] as NormalizedOrder[])
        : loadWalmartOrders(priorFrom, priorTo),
      channel === "walmart"
        ? Promise.resolve([] as Array<{ sku: string; productName: string | null; qty: number }>)
        : buildTopSkus(from, to, storeIndex, 10),
    ]);

    const all = [...amzCurrent, ...wmCurrent];
    const prior = [...amzPrior, ...wmPrior];

    const dailyRevenue = buildDailyRevenue(all, from, to);
    const byChannel = buildChannelBreakdown(all);
    const byStore = buildStoreBreakdown(all);
    const byStatus = buildStatusBreakdown(all);
    const summary = summarize(all);
    const priorSummary = summarize(prior);

    // Order list — sort by most recent first and cap. Frontend shows
    // the actual count vs total so a truncated list isn't misleading.
    const sortedOrders = [...all].sort(
      (a, b) => b.date.getTime() - a.date.getTime(),
    );
    const orderRows = sortedOrders.slice(0, limitOrders).map((o) => ({
      source: o.source,
      id: o.id,
      number: o.number,
      date: o.date.toISOString(),
      total: o.total,
      currency: o.currency,
      status: o.status,
      rawStatus: o.rawStatus,
      customer: o.customer,
      city: o.city,
      state: o.state,
      itemsCount: o.itemsCount,
      storeIndex: o.storeIndex,
      storeName: o.storeName,
      channel: o.channel,
    }));

    return NextResponse.json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: Math.max(1, Math.round(windowMs / 86400000)),
        label,
      },
      comparison: {
        from: priorFrom.toISOString(),
        to: priorTo.toISOString(),
        days: Math.max(1, Math.round(windowMs / 86400000)),
        label: "Prior period",
      },
      summary: { ...summary, prior: priorSummary },
      dailyRevenue,
      byChannel,
      byStore,
      byStatus,
      topSkus,
      orders: orderRows,
      totalOrdersInWindow: all.length,
    });
  } catch (err) {
    console.error("[sales-overview]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to load overview",
      },
      { status: 500 },
    );
  }
}
