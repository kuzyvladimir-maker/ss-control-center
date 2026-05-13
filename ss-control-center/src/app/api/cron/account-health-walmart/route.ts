/**
 * GET /api/cron/account-health-walmart
 *
 * Vercel cron triggers this daily at 03:00 UTC. Delegates to the same
 * /api/account-health/walmart/sync handler the UI calls (Performance
 * summaries + Items API + Critical Alerts evaluator).
 *
 * Note: /api/cron/walmart already runs the per-metric performance
 * snapshots nightly. This separate cron exists so the Account Health v2
 * additions (item compliance + alerts) ride a dedicated schedule and
 * can be tuned without touching the existing orders/returns flow.
 *
 * Auth: CRON_SECRET via Bearer header.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  WalmartClient,
  WalmartItemsApi,
  WalmartSellerPerformanceApi,
  getWalmartStoreStatus,
} from "@/lib/walmart";
import { evaluateCriticalAlerts } from "@/lib/account-health/critical-alert-evaluator";

function toFlatMetricKey(metric: string, days: number): string | null {
  const W = days === 60 ? "60d" : "30d";
  switch (metric) {
    case "onTimeDelivery":     return `onTimeDelivery${W}`;
    case "cancellationRate":   return `cancellations${W}`;
    case "validTrackingRate":  return `validTracking${W}`;
    case "responseRate":       return `sellerResponse${W}`;
    case "onTimeShipment":     return `lateShipment${W}`;
    case "refundRate":         return `returns${W}`;
    default:                   return null;
  }
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = [];
  for (let storeIndex = 1; storeIndex <= 5; storeIndex++) {
    const status = getWalmartStoreStatus(storeIndex);
    if (!status.configured) continue;

    let client: WalmartClient;
    try {
      client = new WalmartClient(storeIndex);
    } catch (err) {
      results.push({
        storeIndex,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const perfApi = new WalmartSellerPerformanceApi(client);
    const itemsApi = new WalmartItemsApi(client);
    const metricsMap: Record<string, number | null> = {};
    let captured = 0;
    let itemsTouched = 0;

    for (const days of [30, 60] as const) {
      try {
        const summary = await perfApi.getSummary(days);
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
      } catch (err) {
        console.warn(
          `[cron AH-walmart] perf w=${days} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

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
        `[cron AH-walmart] items failed:`,
        err instanceof Error ? err.message : err
      );
    }

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
      console.error("[cron AH-walmart] alert eval failed:", err);
    }

    results.push({
      storeIndex,
      success: true,
      captured,
      itemsTouched,
      alertsCreated,
    });
  }

  return NextResponse.json({ ok: true, results });
}
