/**
 * Per-SKU fulfillment speed, computed from our OWN Walmart order history.
 *
 * Walmart's API exposes only account-level on-time-delivery — there's no
 * per-SKU delivery metric. But each WalmartOrder.rawData carries, per order
 * line: the SKU + the actual ship timestamp (orderLineStatuses[].trackingInfo.
 * shipDateTime). So we derive the TRUE per-SKU handling time =
 * business-days(orderDate → actual ship) and average it across orders.
 *
 * Use: assign genuinely-fast SKUs (ship same/next day) to a faster shipping
 * template (FL-regional / fast-SKU), and keep slow SKUs OFF fast promises so
 * we don't miss delivery and take an on-time-delivery penalty.
 *
 * Classification: FAST ≤1 biz day · MEDIUM ≤2 · SLOW >2.
 */

import type { PrismaClient } from "@/generated/prisma/client";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SkuSpeedRow {
  sku: string;
  orders: number;
  avgHandlingDays: number;
  minHandlingDays: number;
  maxHandlingDays: number;
  classification: "FAST" | "MEDIUM" | "SLOW";
  carriers: string;
  lastOrderAt: Date | null;
}

export interface FulfillmentSpeedResult {
  ordersScanned: number;
  linesWithShipDate: number;
  uniqueSkus: number;
  fast: number;
  medium: number;
  slow: number;
  upserted: number;
}

function getLines(raw: any): any[] {
  const o = raw?.orderLines?.orderLine ?? raw?.orderLines;
  if (!o) return [];
  return Array.isArray(o) ? o : [o];
}

function getStatuses(line: any): any[] {
  const s = line?.orderLineStatuses?.orderLineStatus ?? line?.orderLineStatuses;
  if (!s) return [];
  return Array.isArray(s) ? s : [s];
}

function getShipTs(line: any): number | null {
  for (const st of getStatuses(line)) {
    const ts = st?.trackingInfo?.shipDateTime;
    if (ts) {
      const n = Number(ts);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function getCarrier(line: any): string | null {
  for (const st of getStatuses(line)) {
    const c = st?.trackingInfo?.carrierName?.carrier;
    if (c) return String(c);
  }
  return null;
}

/** Whole business days between two dates (excludes weekends). */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let days = 0;
  const c = new Date(from);
  c.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (c < end) {
    c.setDate(c.getDate() + 1);
    const dow = c.getDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

function classify(avg: number): "FAST" | "MEDIUM" | "SLOW" {
  if (avg <= 1) return "FAST";
  if (avg <= 2) return "MEDIUM";
  return "SLOW";
}

/** Compute per-SKU speed rows from order history (no DB write). */
export async function computeFulfillmentSpeed(
  prisma: PrismaClient,
  storeIndex: number
): Promise<{ rows: SkuSpeedRow[]; ordersScanned: number; linesWithShipDate: number }> {
  const orders = await prisma.walmartOrder.findMany({
    where: { storeIndex },
    select: { orderDate: true, rawData: true },
  });

  const agg = new Map<
    string,
    { n: number; sum: number; min: number; max: number; carriers: Set<string>; last: Date | null }
  >();
  let linesWithShipDate = 0;

  for (const o of orders) {
    if (!o.rawData) continue;
    let raw: any;
    try {
      raw = JSON.parse(o.rawData);
    } catch {
      continue;
    }
    for (const line of getLines(raw)) {
      const sku = line?.item?.sku ?? line?.sku;
      if (!sku) continue;
      const ts = getShipTs(line);
      if (!ts) continue;
      linesWithShipDate++;
      const handling = businessDaysBetween(o.orderDate, new Date(ts));
      const carrier = getCarrier(line) ?? "?";
      const e =
        agg.get(sku) ??
        { n: 0, sum: 0, min: Infinity, max: -Infinity, carriers: new Set<string>(), last: null as Date | null };
      e.n++;
      e.sum += handling;
      e.min = Math.min(e.min, handling);
      e.max = Math.max(e.max, handling);
      e.carriers.add(carrier);
      if (!e.last || o.orderDate > e.last) e.last = o.orderDate;
      agg.set(sku, e);
    }
  }

  const rows: SkuSpeedRow[] = [...agg.entries()].map(([sku, e]) => {
    const avg = e.sum / e.n;
    return {
      sku,
      orders: e.n,
      avgHandlingDays: Math.round(avg * 100) / 100,
      minHandlingDays: e.min === Infinity ? 0 : e.min,
      maxHandlingDays: e.max === -Infinity ? 0 : e.max,
      classification: classify(avg),
      carriers: [...e.carriers].join(","),
      lastOrderAt: e.last,
    };
  });

  return { rows, ordersScanned: orders.length, linesWithShipDate };
}

/** Compute + persist (upsert on store+sku). */
export async function syncFulfillmentSpeed(
  prisma: PrismaClient,
  storeIndex: number
): Promise<FulfillmentSpeedResult> {
  const { rows, ordersScanned, linesWithShipDate } = await computeFulfillmentSpeed(prisma, storeIndex);
  let upserted = 0;
  for (const r of rows) {
    await prisma.walmartSkuFulfillment.upsert({
      where: { walmart_sku_fulfillment_dedup: { storeIndex, sku: r.sku } },
      create: {
        storeIndex,
        sku: r.sku,
        orders: r.orders,
        avgHandlingDays: r.avgHandlingDays,
        minHandlingDays: r.minHandlingDays,
        maxHandlingDays: r.maxHandlingDays,
        classification: r.classification,
        carriers: r.carriers,
        lastOrderAt: r.lastOrderAt,
      },
      update: {
        orders: r.orders,
        avgHandlingDays: r.avgHandlingDays,
        minHandlingDays: r.minHandlingDays,
        maxHandlingDays: r.maxHandlingDays,
        classification: r.classification,
        carriers: r.carriers,
        lastOrderAt: r.lastOrderAt,
        computedAt: new Date(),
      },
    });
    upserted++;
  }
  return {
    ordersScanned,
    linesWithShipDate,
    uniqueSkus: rows.length,
    fast: rows.filter((r) => r.classification === "FAST").length,
    medium: rows.filter((r) => r.classification === "MEDIUM").length,
    slow: rows.filter((r) => r.classification === "SLOW").length,
    upserted,
  };
}
