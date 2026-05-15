/**
 * GET /api/cron/account-health-walmart
 *
 * Vercel cron triggers this daily at 11:00 UTC, which is 7 AM EDT
 * (Vladimir's local time during DST; in winter EST it becomes 6 AM).
 * Schedule lives in vercel.json. Drives the Walmart side of
 * Account Health v2:
 *   - performance fan-out across the 10 Insights API metric endpoints
 *     (via fetchAllPerformanceMetrics → persistPerformanceSnapshots)
 *   - item compliance pull from /v3/items
 *   - critical alerts evaluation (Telegram + UI rows)
 *
 * Walmart refreshes its performance datasets ~once per 24h server-side, so
 * one cron pass per day is the right cadence.
 *
 * Auth: CRON_SECRET via Bearer header.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, getWalmartStoreStatus } from "@/lib/walmart/client";
import { fetchAllPerformanceMetrics } from "@/lib/walmart/seller-performance";
import { persistPerformanceSnapshots } from "@/lib/walmart/persist-performance";
import { WalmartItemsApi } from "@/lib/walmart/items";
import { evaluateCriticalAlerts } from "@/lib/account-health/critical-alert-evaluator";

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Array<{
    storeIndex: number;
    success: boolean;
    captured?: number;
    noData?: number;
    errors?: number;
    itemsTouched?: number;
    alertsCreated?: number;
    error?: string;
  }> = [];

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

    // Performance fan-out — parallel via Promise.allSettled inside.
    let metricsMap: Record<string, number | null> = {};
    let captured = 0;
    let noData = 0;
    let errors = 0;
    try {
      const data = await fetchAllPerformanceMetrics(client);
      const p = await persistPerformanceSnapshots(prisma, storeIndex, data);
      captured = p.okCount;
      noData = p.noDataCount;
      errors = p.errorCount;
      metricsMap = { ...p.metricsMap };
    } catch (err) {
      console.warn(
        `[cron AH-walmart] perf store${storeIndex} failed:`,
        err instanceof Error ? err.message : err
      );
    }

    // Item compliance — separate API surface (/v3/items).
    let itemsTouched = 0;
    try {
      const itemsApi = new WalmartItemsApi(client);
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
        `[cron AH-walmart] items store${storeIndex} failed:`,
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
      noData,
      errors,
      itemsTouched,
      alertsCreated,
    });
  }

  return NextResponse.json({ ok: true, results });
}
