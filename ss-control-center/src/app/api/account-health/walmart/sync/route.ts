/**
 * POST /api/account-health/walmart/sync
 * GET  /api/account-health/walmart/sync   (latest snapshot per metric/window)
 *
 * POST drives one synchronous sync pass:
 *   1. Pull the Walmart Performance v2 fan-out (10 metric endpoints via
 *      /v3/insights/performance/{metric}/summary) for the configured store.
 *   2. Write one WalmartPerformanceSnapshot row per metric (history-only,
 *      no upsert) so trend charts later have data.
 *   3. Pull /v3/items compliance issues into WalmartItemCompliance.
 *   4. Hand the flat metrics map to the critical alerts evaluator.
 *
 * The whole pass runs well under Vercel's 10s budget when the metrics fan
 * out in parallel — typical wall time is 3-6s.
 *
 * Body (optional):
 *   { storeIndex?: number }   // default 1 (Sirius Trading International)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { fetchAllPerformanceMetrics } from "@/lib/walmart/seller-performance";
import { persistPerformanceSnapshots } from "@/lib/walmart/persist-performance";
import { WalmartItemsApi } from "@/lib/walmart/items";
import { evaluateCriticalAlerts } from "@/lib/account-health/critical-alert-evaluator";

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body fine
  }
  const storeIndex = body.storeIndex ?? 1;

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  // 1. + 2. Performance metrics — parallel fan-out + DB writes.
  let perfPersist;
  let perfError: string | undefined;
  try {
    const data = await fetchAllPerformanceMetrics(client);
    perfPersist = await persistPerformanceSnapshots(prisma, storeIndex, data);
  } catch (err) {
    perfError =
      err instanceof WalmartApiError
        ? `${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
  }

  // 3. Item Compliance pull (separate endpoint, lives in /v3/items).
  let itemsTouched = 0;
  let itemsError: string | undefined;
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
  } catch (err) {
    itemsError =
      err instanceof Error ? err.message : String(err);
    console.warn(`[walmart sync] items failed:`, itemsError);
  }

  // 4. Critical alerts evaluator — same metricsMap the cron uses.
  let alertsCreated = 0;
  try {
    const store = await prisma.store.findFirst({
      where: { storeIndex, channel: "Walmart" },
      select: { id: true, name: true },
    });
    if (store) {
      const metricsMap: Record<string, number | null> = {
        ...(perfPersist?.metricsMap ?? {}),
        newItemCompliance: itemsTouched,
      };
      const created = await evaluateCriticalAlerts({
        storeId: store.id,
        storeName: store.name,
        channel: "Walmart",
        metrics: metricsMap,
      });
      alertsCreated = created.length;
    }
  } catch (err) {
    console.error("[walmart sync] alert evaluation failed:", err);
  }

  return NextResponse.json({
    ok: true,
    storeIndex,
    performance: perfPersist
      ? {
          snapshotsWritten: perfPersist.snapshotsWritten,
          ok: perfPersist.okCount,
          noData: perfPersist.noDataCount,
          errors: perfPersist.errorCount,
        }
      : { error: perfError ?? "no result" },
    items: itemsError
      ? { error: itemsError }
      : { touched: itemsTouched },
    alertsCreated,
  });
}

/**
 * GET — return the most recent snapshot for each (storeIndex, windowDays,
 * metric) combination. Same shape the WalmartHealthTab UI consumes.
 */
export async function GET() {
  const snapshots = await prisma.walmartPerformanceSnapshot.findMany({
    orderBy: { capturedAt: "desc" },
    take: 400,
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
    status: s.status,
    capturedAt: s.capturedAt,
  }));

  return NextResponse.json({
    items,
    issues: items.filter((i) => !i.isHealthy).length,
  });
}
