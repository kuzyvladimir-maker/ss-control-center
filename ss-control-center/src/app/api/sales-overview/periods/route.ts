/**
 * GET /api/sales-overview/periods
 *
 * Returns 5 period summary blocks in one shot — used to power the
 * Sellerboard-style tile row at the top of the Sales Overview page.
 * Each tile is a separate (from, to) window:
 *   - today          (start of today ET → now)
 *   - yesterday      (full prior day)
 *   - mtd            (start of current month → now)
 *   - thisMonth      (full current month — same range as mtd, but with a
 *                     `forecast` extrapolated to month-end)
 *   - lastMonth      (full prior month)
 *
 * Each block carries the same shape as the `summary` field on the main
 * /api/sales-overview endpoint, plus a `prior` block (same-length
 * window immediately before) so the tile can render +/- deltas.
 *
 * All 10+ DB queries (5 windows × 2 channels × 2 timeframes) run in
 * parallel — total response time is dominated by the slowest single
 * query, not their sum. With our cached AmazonOrder + WalmartOrder
 * tables this comes back in well under a second.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchOrdersInRange } from "@/lib/veeqo/client";
import { isFulfillmentOnlyStoreName } from "@/lib/procurement/excluded-stores";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
  differenceInDays,
} from "date-fns";

export const maxDuration = 30;

const TZ = "America/New_York";

function asUtc(zoned: Date): Date {
  return fromZonedTime(zoned, TZ);
}

interface Window {
  from: Date;
  to: Date;
  label: string;
}

function buildWindows(now: Date): {
  today: Window;
  yesterday: Window;
  mtd: Window;
  thisMonth: Window;
  lastMonth: Window;
} {
  const nowEt = toZonedTime(now, TZ);
  const yest = subDays(nowEt, 1);
  const lm = subMonths(nowEt, 1);
  return {
    today: { from: asUtc(startOfDay(nowEt)), to: now, label: "Today" },
    yesterday: {
      from: asUtc(startOfDay(yest)),
      to: asUtc(endOfDay(yest)),
      label: "Yesterday",
    },
    mtd: {
      from: asUtc(startOfMonth(nowEt)),
      to: now,
      label: "Month to date",
    },
    thisMonth: {
      from: asUtc(startOfMonth(nowEt)),
      to: now,
      label: "This month (Forecast)",
    },
    lastMonth: {
      from: asUtc(startOfMonth(lm)),
      to: asUtc(endOfMonth(lm)),
      label: "Last month",
    },
  };
}

// One unified shape — Amazon and Walmart loaders both map to this.
interface NormalizedOrder {
  total: number;
  itemsCount: number;
  status: string;
}

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

/**
 * Pull non-cached channel orders (eBay / TikTok / Shopify / direct /
 * Merged / Etsy) live from Veeqo for the given range, with each
 * order's createdAt attached so the caller can re-bucket the result
 * into the 5 period windows in memory.
 *
 * Single Veeqo round-trip per page render — the previous version
 * fired 5 separate calls (one per period) which 429-throttled the
 * upstream and silently dropped most channels. We fetch once for the
 * BROADEST needed range (start-of-last-month → now), then filter the
 * in-memory array into each period below.
 *
 * Best-effort: a Veeqo failure logs a warning and returns [].
 */
async function loadOtherChannelOrdersFromVeeqo(
  from: Date,
  to: Date,
): Promise<Array<NormalizedOrder & { createdAt: Date; channel: string }>> {
  let raw: unknown[];
  try {
    raw = await fetchOrdersInRange({
      createdAtMin: from.toISOString(),
      createdAtMax: to.toISOString(),
      batchSize: 2,
    });
  } catch (e) {
    console.warn(
      "[sales-overview/periods] Veeqo fetch failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
  const out: Array<NormalizedOrder & { createdAt: Date; channel: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ch = o.channel as Record<string, unknown> | undefined;
    const typeCode =
      typeof ch?.type_code === "string"
        ? (ch.type_code as string).toLowerCase()
        : "";
    if (typeCode === "amazon" || typeCode === "walmart") continue;
    // NAN health (and other fulfilment-only client stores) ship from our
    // warehouse but the revenue is the client's — keep them out of OUR
    // numbers, same as Procurement and the main overview endpoint.
    const channelName = typeof ch?.name === "string" ? (ch.name as string) : "";
    if (isFulfillmentOnlyStoreName(channelName)) continue;
    const createdAtRaw = String(o.created_at ?? "");
    if (!createdAtRaw) continue;
    const createdAt = new Date(createdAtRaw);
    if (Number.isNaN(createdAt.getTime())) continue;
    const totalRaw = o.total_price ?? o.subtotal_price ?? 0;
    const total =
      typeof totalRaw === "string"
        ? parseFloat(totalRaw) || 0
        : typeof totalRaw === "number"
          ? totalRaw
          : 0;
    const lineItems = Array.isArray(o.line_items) ? o.line_items : [];
    const itemsCount = lineItems.reduce((s: number, li: unknown) => {
      if (!li || typeof li !== "object") return s;
      const q = (li as { quantity?: number }).quantity;
      return s + (typeof q === "number" ? q : 0);
    }, 0);
    out.push({
      total,
      itemsCount: itemsCount || 1,
      status: normalizeStatus(String(o.status ?? "unknown")),
      createdAt,
      channel: typeCode || "other",
    });
  }
  return out;
}

/** Cached loader — Amazon + Walmart from local DB only. The non-cached
 *  channels (eBay/TikTok/Shopify/...) are pulled separately ONCE for
 *  the broadest window and filtered into each period by the route
 *  handler (see GET below) to avoid 5× Veeqo round-trips. */
async function loadCachedOrders(
  from: Date,
  to: Date,
  wantAmazon: boolean,
  wantWalmart: boolean,
  storeIndex: number | null,
): Promise<NormalizedOrder[]> {
  const tasks: Array<Promise<NormalizedOrder[]>> = [];
  if (wantAmazon) {
    tasks.push(
      prisma.amazonOrder
        .findMany({
          where: {
            purchaseDate: { gte: from, lte: to },
            ...(storeIndex ? { storeIndex } : {}),
          },
          select: { orderTotal: true, numberOfItems: true, status: true },
        })
        .then((rows) =>
          rows.map((r) => ({
            total: r.orderTotal,
            itemsCount: r.numberOfItems,
            status: normalizeStatus(r.status),
          })),
        ),
    );
  }
  if (wantWalmart) {
    tasks.push(
      prisma.walmartOrder
        .findMany({
          where: { orderDate: { gte: from, lte: to } },
          select: { orderTotal: true, numberOfItems: true, status: true },
        })
        .then((rows) =>
          rows.map((r) => ({
            total: r.orderTotal,
            itemsCount: r.numberOfItems,
            status: normalizeStatus(r.status),
          })),
        ),
    );
  }
  const chunks = await Promise.all(tasks);
  return chunks.flat();
}

interface Summary {
  revenue: number;
  orders: number;
  units: number;
  avgOrder: number;
  shipped: number;
  cancelled: number;
}

function summarize(orders: NormalizedOrder[]): Summary {
  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const units = orders.reduce((s, o) => s + (o.itemsCount || 0), 0);
  const n = orders.length;
  const status = (s: string) =>
    orders.filter((o) => o.status === s).length;
  return {
    revenue: Math.round(revenue * 100) / 100,
    orders: n,
    units,
    avgOrder: n > 0 ? Math.round((revenue / n) * 100) / 100 : 0,
    shipped: status("Shipped"),
    cancelled: status("Cancelled"),
  };
}

async function summarizeWindow(
  win: Window,
  sel: ChannelSelection,
  storeIndex: number | null,
  veeqoOthers: Array<NormalizedOrder & { createdAt: Date; channel: string }>,
): Promise<Summary> {
  const cached = await loadCachedOrders(
    win.from,
    win.to,
    sel.wantAmazon,
    sel.wantWalmart,
    storeIndex,
  );
  // Filter the pre-fetched Veeqo "other channels" array into this window
  // and down to the requested channel set. Cheap in-memory pass — no
  // extra API call.
  const others = sel.wantOthers
    ? veeqoOthers.filter(
        (o) =>
          o.createdAt >= win.from &&
          o.createdAt <= win.to &&
          (sel.set === null || sel.set.has(o.channel)),
      )
    : [];
  return summarize([...cached, ...others]);
}

/** Resolved multi-select channel filter. `set === null` ⇒ all channels. */
interface ChannelSelection {
  set: Set<string> | null;
  wantAmazon: boolean;
  wantWalmart: boolean;
  wantOthers: boolean;
}

function resolveChannelSelection(raw: string): ChannelSelection {
  const requested = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const set: Set<string> | null =
    requested.length === 0 || requested.includes("all")
      ? null
      : new Set(requested);
  return {
    set,
    wantAmazon: set === null || set.has("amazon"),
    wantWalmart: set === null || set.has("walmart"),
    wantOthers:
      set === null ||
      [...set].some((c) => c !== "amazon" && c !== "walmart"),
  };
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    // Multi-select channel filter — comma list via `channels=` (preferred)
    // or legacy single `channel=`. "all" / empty ⇒ every channel.
    const sel = resolveChannelSelection(
      sp.get("channels") ?? sp.get("channel") ?? "all",
    );
    const storeIndexRaw = sp.get("storeIndex");
    const storeIndex = storeIndexRaw ? parseInt(storeIndexRaw, 10) : null;

    const now = new Date();
    const w = buildWindows(now);

    // Prior windows for delta arrows. "Today vs same-time-yesterday",
    // "Yesterday vs day-before", "MTD vs same days last month",
    // "Last month vs the month before".
    const nowEt = toZonedTime(now, TZ);
    const twoDaysAgo = subDays(nowEt, 2);
    const lmStart = subMonths(nowEt, 1);
    const monthBeforeLast = subMonths(nowEt, 2);
    const priorWindows = {
      today: {
        // Yesterday at this same hour-of-day, so we're comparing
        // apples-to-apples runrates rather than full-yesterday-vs-
        // partial-today which would always show today losing.
        from: asUtc(startOfDay(subDays(nowEt, 1))),
        to: new Date(now.getTime() - 86400_000),
        label: "Yesterday so far",
      },
      yesterday: {
        from: asUtc(startOfDay(twoDaysAgo)),
        to: asUtc(endOfDay(twoDaysAgo)),
        label: "Day before yesterday",
      },
      mtd: {
        // Same number of days at the start of last month.
        from: asUtc(startOfMonth(lmStart)),
        to: asUtc(
          endOfDay(
            new Date(
              lmStart.getFullYear(),
              lmStart.getMonth(),
              Math.min(
                nowEt.getDate(),
                endOfMonth(lmStart).getDate(),
              ),
            ),
          ),
        ),
        label: "Same MTD last month",
      },
      thisMonth: {
        from: asUtc(startOfMonth(lmStart)),
        to: asUtc(endOfMonth(lmStart)),
        label: "Last month (full)",
      },
      lastMonth: {
        from: asUtc(startOfMonth(monthBeforeLast)),
        to: asUtc(endOfMonth(monthBeforeLast)),
        label: "Month before last (full)",
      },
    };

    // Single Veeqo fetch covering the BROADEST range any of our 9
    // windows touches — month-before-last through now. We then filter
    // this array in memory for each window. Replaces what used to be
    // 9 separate Veeqo round-trips (which 429-throttled the upstream
    // and silently dropped every non-cached channel).
    const broadestFrom = priorWindows.lastMonth.from; // start of month-before-last
    const broadestTo = now;
    const veeqoOthers = sel.wantOthers
      ? await loadOtherChannelOrdersFromVeeqo(broadestFrom, broadestTo)
      : [];

    // Fire every window query in parallel — current + prior, all 5 periods.
    // All summarizeWindow calls now reuse the SAME veeqoOthers array,
    // so this loop is pure DB + in-memory filtering at this point.
    const [
      todayCur,
      todayPrior,
      yesterdayCur,
      yesterdayPrior,
      mtdCur,
      mtdPrior,
      thisMonthPrior,
      lastMonthCur,
      lastMonthPrior,
    ] = await Promise.all([
      summarizeWindow(w.today, sel, storeIndex, veeqoOthers),
      summarizeWindow(priorWindows.today, sel, storeIndex, veeqoOthers),
      summarizeWindow(w.yesterday, sel, storeIndex, veeqoOthers),
      summarizeWindow(priorWindows.yesterday, sel, storeIndex, veeqoOthers),
      summarizeWindow(w.mtd, sel, storeIndex, veeqoOthers),
      summarizeWindow(priorWindows.mtd, sel, storeIndex, veeqoOthers),
      // thisMonth current = mtd (same set of orders); skip.
      summarizeWindow(priorWindows.thisMonth, sel, storeIndex, veeqoOthers),
      summarizeWindow(w.lastMonth, sel, storeIndex, veeqoOthers),
      summarizeWindow(priorWindows.lastMonth, sel, storeIndex, veeqoOthers),
    ]);

    // Forecast extrapolates current MTD pace through the rest of the
    // month. `daysElapsed` counts days INCLUDING today as fractional —
    // anchored on Eastern wall-clock to match the operator's day boundary.
    const monthStart = startOfMonth(nowEt);
    const monthEnd = endOfMonth(nowEt);
    const daysInMonth = differenceInDays(monthEnd, monthStart) + 1;
    const elapsedDays =
      differenceInDays(nowEt, monthStart) +
      (nowEt.getHours() * 60 + nowEt.getMinutes()) / (60 * 24);
    const scale = elapsedDays > 0 ? daysInMonth / Math.max(elapsedDays, 0.01) : 1;
    const thisMonthForecast: Summary = {
      revenue: Math.round(mtdCur.revenue * scale * 100) / 100,
      orders: Math.round(mtdCur.orders * scale),
      units: Math.round(mtdCur.units * scale),
      avgOrder: mtdCur.avgOrder,
      shipped: Math.round(mtdCur.shipped * scale),
      cancelled: Math.round(mtdCur.cancelled * scale),
    };

    return NextResponse.json({
      asOf: now.toISOString(),
      forecast: {
        daysInMonth,
        elapsedDays: Math.round(elapsedDays * 100) / 100,
        scale: Math.round(scale * 100) / 100,
      },
      tiles: {
        today: {
          label: w.today.label,
          summary: todayCur,
          prior: todayPrior,
          priorLabel: priorWindows.today.label,
        },
        yesterday: {
          label: w.yesterday.label,
          summary: yesterdayCur,
          prior: yesterdayPrior,
          priorLabel: priorWindows.yesterday.label,
        },
        mtd: {
          label: w.mtd.label,
          summary: mtdCur,
          prior: mtdPrior,
          priorLabel: priorWindows.mtd.label,
        },
        thisMonth: {
          label: w.thisMonth.label,
          summary: thisMonthForecast,
          prior: thisMonthPrior, // last full month
          priorLabel: priorWindows.thisMonth.label,
          isForecast: true,
        },
        lastMonth: {
          label: w.lastMonth.label,
          summary: lastMonthCur,
          prior: lastMonthPrior,
          priorLabel: priorWindows.lastMonth.label,
        },
      },
    });
  } catch (err) {
    console.error("[sales-overview/periods]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load periods" },
      { status: 500 },
    );
  }
}
