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

const DEFAULT_WINDOWS: PerformanceWindow[] = [30, 90];

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

  const results: Array<{
    windowDays: number;
    metricsCaptured: number;
    error?: string;
  }> = [];

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
            rawData: JSON.stringify(m.raw ?? null),
          },
        });
        captured++;
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

  return NextResponse.json({ ok: true, storeIndex, results });
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
