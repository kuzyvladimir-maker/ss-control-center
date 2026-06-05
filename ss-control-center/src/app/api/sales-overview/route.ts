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
import { fetchOrdersInRange } from "@/lib/veeqo/client";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
} from "date-fns";

// Veeqo paginate of even a single month (~20 pages × 1.5s with retries)
// can scrape past 60s when the upstream is throttling — give it room.
export const maxDuration = 120;

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
interface OrderLineItem {
  sku: string;
  productName: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: number;
}

interface NormalizedOrder {
  source: "amazon" | "walmart" | "veeqo";
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
  zip: string | null;
  itemsCount: number;
  storeIndex: number;
  storeName: string;
  /** Channel kind from Veeqo's `type_code` — "amazon" / "walmart" /
   *  "ebay" / "tiktok" / "shopify" / "direct" (merged-orders bucket)
   *  / etc. Amazon and Walmart still come from our local cache; the
   *  rest come live from Veeqo per-request. */
  channel: string;
  /** Veeqo-sourced line items (with thumbnail). Cached AmazonOrder /
   *  WalmartOrder rows return []; only the Veeqo loaders populate this.
   *  The Sales Overview UI renders these inline per row, Veeqo-style. */
  items: OrderLineItem[];
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
  const units = orders.reduce((s, o) => s + (o.itemsCount || 0), 0);
  const n = orders.length;
  const status = (s: string) =>
    orders.filter((o) => o.status.toLowerCase() === s.toLowerCase()).length;
  return {
    revenue: Math.round(revenue * 100) / 100,
    orders: n,
    units,
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
/** Aggregate top SKUs from the (already-loaded) Veeqo orders' line
 *  items. Covers every channel that has line items, not just Amazon. */
function buildTopSkusFromOrders(
  orders: NormalizedOrder[],
  limit = 10,
): Array<{ sku: string; productName: string | null; qty: number }> {
  const map = new Map<
    string,
    { productName: string | null; qty: number }
  >();
  for (const o of orders) {
    for (const li of o.items) {
      if (!li.sku) continue;
      const row = map.get(li.sku) ?? { productName: li.productName, qty: 0 };
      row.qty += li.quantity;
      if (!row.productName && li.productName) row.productName = li.productName;
      map.set(li.sku, row);
    }
  }
  return [...map.entries()]
    .map(([sku, v]) => ({ sku, productName: v.productName, qty: v.qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

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
    zip: r.shipZip,
    itemsCount: r.numberOfItems,
    storeIndex: r.storeIndex,
    storeName: amazonStoreName(r.storeIndex),
    channel: "amazon",
    items: [],
  }));
}

/**
 * Pull EVERY order Veeqo has for the range — used as the single source
 * for the Sales Overview orders list so we get line items (product
 * image, title, sku, qty) for every channel including Amazon + Walmart.
 *
 * Pass `skipAmazonWalmart: true` to keep the old "non-cached channels
 * only" behaviour (used historically for tile aggregations).
 *
 * Best-effort: a Veeqo failure logs a warning and returns [].
 */
async function loadAllVeeqoOrders(
  from: Date,
  to: Date,
): Promise<NormalizedOrder[]> {
  return loadVeeqoOrdersInternal(from, to, false);
}

async function loadOtherChannelOrders(
  from: Date,
  to: Date,
): Promise<NormalizedOrder[]> {
  return loadVeeqoOrdersInternal(from, to, true);
}

async function loadVeeqoOrdersInternal(
  from: Date,
  to: Date,
  skipAmazonWalmart: boolean,
): Promise<NormalizedOrder[]> {
  let raw: unknown[];
  try {
    raw = await fetchOrdersInRange({
      createdAtMin: from.toISOString(),
      createdAtMax: to.toISOString(),
      batchSize: 2,
      // Hard cap matches the orders-list display cap — fetching more
      // would just be JSON we'd throw away (and 5000 orders × ~10
      // line items each pushes the response to >5MB which crashes
      // older browsers on the parse step).
      maxOrders: 5000,
    });
  } catch (e) {
    console.warn(
      "[sales-overview] Veeqo fetch failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }

  const out: NormalizedOrder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const channelInfo = o.channel as Record<string, unknown> | undefined;
    const typeCodeRaw = channelInfo?.type_code;
    const typeCode =
      typeof typeCodeRaw === "string" ? typeCodeRaw.toLowerCase() : "";

    if (skipAmazonWalmart && (typeCode === "amazon" || typeCode === "walmart"))
      continue;

    const channelName =
      typeof channelInfo?.name === "string"
        ? (channelInfo.name as string)
        : "";

    // Best-effort field extraction. Veeqo returns slightly different
    // shapes per channel, so we try each common key in order.
    const id = String(o.id ?? "");
    if (!id) continue;
    const number = String(o.number ?? o.id);
    const createdAt = String(o.created_at ?? "");
    if (!createdAt) continue;
    const date = new Date(createdAt);
    const totalRaw = o.total_price ?? o.subtotal_price ?? 0;
    const total = typeof totalRaw === "string"
      ? parseFloat(totalRaw) || 0
      : typeof totalRaw === "number"
        ? totalRaw
        : 0;
    const currency = String(o.currency_code ?? "USD");
    const rawStatus = String(o.status ?? "unknown");
    const deliverTo = o.deliver_to as Record<string, unknown> | undefined;
    const customer = (() => {
      const fn = String(deliverTo?.first_name ?? "").trim();
      const ln = String(deliverTo?.last_name ?? "").trim();
      const full = [fn, ln].filter(Boolean).join(" ");
      return full || null;
    })();
    const lineItems = Array.isArray(o.line_items) ? o.line_items : [];
    const itemsCount = lineItems.reduce(
      (s: number, li: unknown) => {
        if (!li || typeof li !== "object") return s;
        const q = (li as { quantity?: number }).quantity;
        return s + (typeof q === "number" ? q : 0);
      },
      0,
    );

    // Extract per-line product info — image, title, sku, qty —
    // straight from Veeqo's line_items[].sellable. The Sales Overview
    // UI renders these inline in each row so the operator sees the
    // products in the order without having to drill down (Veeqo's
    // own order-list aesthetic). Image URL lives in different fields
    // per channel, so we try them in order.
    const items: OrderLineItem[] = [];
    for (const li of lineItems) {
      if (!li || typeof li !== "object") continue;
      const liObj = li as Record<string, unknown>;
      const sellable = liObj.sellable as Record<string, unknown> | undefined;
      const product = sellable?.product as Record<string, unknown> | undefined;
      const sku = String(
        sellable?.sku_code ?? sellable?.sku ?? "",
      );
      const title = String(
        sellable?.product_title ??
          product?.title ??
          sellable?.title ??
          sku ??
          "Untitled",
      );
      // First non-empty wins. Veeqo's image field lives in
      // sellable.image_url (eBay), product.main_image_src (Amazon),
      // product.images[0].src (Shopify), and a few other variants.
      const imageCandidates: Array<unknown> = [
        sellable?.image_url,
        (sellable?.main_image as Record<string, unknown> | undefined)?.src,
        (sellable?.main_image as Record<string, unknown> | undefined)?.url,
        product?.main_image_src,
        product?.main_image_url,
        product?.image_url,
        (() => {
          const imgs = product?.images;
          if (Array.isArray(imgs) && imgs.length > 0) {
            const first = imgs[0] as Record<string, unknown>;
            return first?.src ?? first?.url ?? first?.image_url;
          }
          return null;
        })(),
      ];
      let imageUrl: string | null = null;
      for (const c of imageCandidates) {
        if (typeof c === "string" && c.trim()) {
          imageUrl = c;
          break;
        }
      }
      const qty =
        typeof liObj.quantity === "number" ? (liObj.quantity as number) : 1;
      const priceRaw = liObj.price_per_unit ?? liObj.unit_price ?? 0;
      const unitPrice =
        typeof priceRaw === "string"
          ? parseFloat(priceRaw) || 0
          : typeof priceRaw === "number"
            ? priceRaw
            : 0;
      items.push({ sku, productName: title, imageUrl, quantity: qty, unitPrice });
    }

    out.push({
      source: "veeqo",
      id,
      number,
      date,
      total,
      currency,
      status: normalizeStatus(rawStatus),
      rawStatus,
      customer,
      city: deliverTo?.city ? String(deliverTo.city) : null,
      state: deliverTo?.state ? String(deliverTo.state) : null,
      zip: deliverTo?.zip ? String(deliverTo.zip) : null,
      itemsCount: itemsCount || 1,
      storeIndex: 0,
      // Friendly store name: prefer Veeqo's channel.name (e.g. "AMZ
      // eBay", "NAN health", "Salutem Solutions", "SIRIUS TRADING…")
      // since it's what the operator recognises. Fall back to
      // capitalised type_code otherwise.
      storeName:
        channelName ||
        (typeCode ? typeCode.charAt(0).toUpperCase() + typeCode.slice(1) : "Other"),
      channel: typeCode || "other",
      items,
    });
  }
  return out;
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
    zip: r.shipZip,
    itemsCount: r.numberOfItems,
    items: [],
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
    // Channel filter accepts ANY Veeqo type_code (amazon / walmart /
    // ebay / tiktok / shopify / direct / etc.) plus the special "all"
    // value. For unknown values we fall back to "all".
    const channelRaw = (sp.get("channel") || "all").toLowerCase();
    const channel = channelRaw;
    const isOtherChannel =
      channel !== "all" && channel !== "amazon" && channel !== "walmart";
    const storeIndexRaw = sp.get("storeIndex");
    const storeIndex = storeIndexRaw ? parseInt(storeIndexRaw, 10) : null;
    // Default cap 500 — keeps the response under ~1MB so the browser
    // doesn't choke on JSON parse + render even with line items.
    // Can be overridden via ?limitOrders= up to a hard ceiling of 5000.
    // For larger windows the operator narrows the date range instead.
    const limitOrders = Math.min(
      Math.max(parseInt(sp.get("limitOrders") || "500", 10), 1),
      5000,
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

    // Veeqo is now the SINGLE source for the current window — it
    // returns every channel (Amazon / Walmart / eBay / TikTok /
    // Shopify / Merged) WITH line items (product image, title, sku,
    // qty per line). Cached AmazonOrder / WalmartOrder rows don't
    // carry line items, so showing "Veeqo-style" rows with thumbnails
    // requires the live fetch regardless.
    //
    // Prior-period (for delta arrows) still uses the cache — pulling
    // Veeqo a second time for the prior window would double total
    // latency without unlocking anything the deltas need.
    const wantAmazon = channel === "all" || channel === "amazon";
    const wantWalmart = channel === "all" || channel === "walmart";
    const [veeqoAll, amzPrior, wmPrior] = await Promise.all([
      loadAllVeeqoOrders(from, to),
      wantAmazon
        ? loadAmazonOrders(priorFrom, priorTo, storeIndex)
        : Promise.resolve([] as NormalizedOrder[]),
      wantWalmart
        ? loadWalmartOrders(priorFrom, priorTo)
        : Promise.resolve([] as NormalizedOrder[]),
    ]);

    // Narrow to the selected channel (skipped for "all"). Store-index
    // filter (Amazon-multi-account) is applied post-hoc on Veeqo
    // orders by matching channel.name against the configured store
    // name — Veeqo doesn't expose our storeIndex.
    let all = channel === "all"
      ? veeqoAll
      : veeqoAll.filter((o) => o.channel === channel);
    if (storeIndex && channel === "amazon") {
      const targetName = amazonStoreName(storeIndex).toLowerCase();
      all = all.filter((o) => o.storeName.toLowerCase() === targetName);
    }

    const prior = [...amzPrior, ...wmPrior];

    // Top SKUs aggregated from the Veeqo line items — covers every
    // channel that has them, not just Amazon.
    const topSkus = buildTopSkusFromOrders(all, 10);

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
      zip: o.zip,
      itemsCount: o.itemsCount,
      storeIndex: o.storeIndex,
      storeName: o.storeName,
      channel: o.channel,
      // items[] carries product image + title + sku + qty per line —
      // the Sales Overview UI renders them inline in each row.
      // Always include (even empty array) so the client can rely on
      // `o.items.length` without a guard.
      items: o.items ?? [],
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
