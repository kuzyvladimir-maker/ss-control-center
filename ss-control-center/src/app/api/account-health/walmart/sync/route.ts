/**
 * POST /api/account-health/walmart/sync
 * GET  /api/account-health/walmart/sync   (returns latest snapshot per metric)
 *
 * POST: pulls Seller Performance summaries for the requested windows
 * (default 30 + 90 days) and inserts a WalmartPerformanceSnapshot row per
 * metric. We keep history (no upserts) so trends can be plotted later.
 *
 * Body (optional):
 *   { storeIndex?: number, windows?: number[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import {
  WalmartSellerPerformanceApi,
  type PerformanceWindow,
} from "@/lib/walmart/seller-performance";
import { WalmartItemsApi } from "@/lib/walmart/items";
import { evaluateCriticalAlerts } from "@/lib/account-health/critical-alert-evaluator";

const DEFAULT_WINDOWS: PerformanceWindow[] = [30, 60, 90];

// Maps Walmart's canonical metric names + window to the flat keys used by
// alert-rules.ts (e.g. "onTimeDelivery" + 30 → "onTimeDelivery30d").
function toFlatMetricKey(metric: string, days: number): string | null {
  const W = days === 60 ? "60d" : "30d";
  switch (metric) {
    case "onTimeDelivery":
      return `onTimeDelivery${W}`;
    case "cancellationRate":
      return `cancellations${W}`;
    case "validTrackingRate":
      return `validTracking${W}`;
    case "responseRate":
      return `sellerResponse${W}`;
    case "onTimeShipment":
      return `lateShipment${W}`;
    case "refundRate":
      return `returns${W}`;
    default:
      return null;
  }
}

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number; windows?: number[] } = {};
  try {
    body = await request.json();
  } catch {
    // empty body fine
  }
  const storeIndex = body.storeIndex ?? 1;
  const windows: PerformanceWindow[] = (body.windows?.length
    ? body.windows
    : DEFAULT_WINDOWS) as PerformanceWindow[];

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  const api = new WalmartSellerPerformanceApi(client);
  const itemsApi = new WalmartItemsApi(client);

  const results: Array<{
    windowDays: number;
    metricsCaptured: number;
    error?: string;
  }> = [];

  // Flat key→value map for the alert evaluator. Populated as we walk the
  // performance summaries below.
  const metricsMap: Record<string, number | null> = {};

  for (const w of windows) {
    try {
      const summary = await api.getSummary(w);
      let captured = 0;
      for (const m of summary.metrics) {
        await prisma.walmartPerformanceSnapshot.create({
          data: {
            storeIndex,
            windowDays: m.windowDays,
            metric: m.metric,
            value: m.value,
            threshold: m.threshold,
            isHealthy: m.isHealthy,
            status: m.isHealthy ? "GOOD" : "URGENT",
            rawData: JSON.stringify(m.raw ?? null),
          },
        });
        captured++;
        const key = toFlatMetricKey(m.metric, m.windowDays);
        if (key) metricsMap[key] = m.value;
      }
      results.push({ windowDays: w, metricsCaptured: captured });
    } catch (err) {
      const msg =
        err instanceof WalmartApiError
          ? `${err.status}: ${err.message}`
          : (err as Error).message;
      results.push({ windowDays: w, metricsCaptured: 0, error: msg.slice(0, 200) });
    }
  }

  // ── Item compliance pull (Account Health v2) ─────────────────────────
  let itemsTouched = 0;
  try {
    const issues = await itemsApi.getCompliance();
    for (const issue of issues) {
      await prisma.walmartItemCompliance.upsert({
        where: {
          walmart_item_compliance_dedup: {
            itemId: issue.itemId,
            issueType: issue.issueType,
          },
        },
        create: {
          storeIndex,
          itemId: issue.itemId,
          sku: issue.sku ?? null,
          title: issue.title ?? null,
          issueType: issue.issueType,
          issueDetails: issue.issueDetails ?? null,
          severity: issue.severity,
          reportedAt: issue.reportedAt,
        },
        update: {
          storeIndex,
          sku: issue.sku ?? null,
          title: issue.title ?? null,
          issueDetails: issue.issueDetails ?? null,
          severity: issue.severity,
          status: "OPEN",
        },
      });
      itemsTouched++;
    }
    metricsMap.newItemCompliance = issues.length;
  } catch (err) {
    console.warn(
      `[Walmart sync] store${storeIndex} items failed:`,
      err instanceof Error ? err.message : err
    );
  }

  // ── Run alert evaluator ──────────────────────────────────────────────
  let alertsCreated = 0;
  try {
    const store = await prisma.store.findFirst({
      where: { storeIndex, channel: "Walmart" },
      select: { id: true, name: true },
    });
    if (store) {
      const created = await evaluateCriticalAlerts({
        storeId: store.id,
        storeName: store.name,
        channel: "Walmart",
        metrics: metricsMap,
      });
      alertsCreated = created.length;
    }
  } catch (err) {
    console.error("[Walmart sync] alert evaluation failed:", err);
  }

  return NextResponse.json({
    ok: true,
    storeIndex,
    results,
    itemsTouched,
    alertsCreated,
  });
}

export async function GET() {
  // Latest snapshot per (storeIndex, metric, windowDays)
  const snapshots = await prisma.walmartPerformanceSnapshot.findMany({
    orderBy: { capturedAt: "desc" },
    take: 200,
  });

  const latest = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    const key = `${s.storeIndex}|${s.windowDays}|${s.metric}`;
    if (!latest.has(key)) latest.set(key, s);
  }

  const items = Array.from(latest.values()).map((s) => ({
    storeIndex: s.storeIndex,
    windowDays: s.windowDays,
    metric: s.metric,
    value: s.value,
    threshold: s.threshold,
    isHealthy: s.isHealthy,
    capturedAt: s.capturedAt,
  }));

  return NextResponse.json({
    items,
    issues: items.filter((i) => !i.isHealthy).length,
  });
}
