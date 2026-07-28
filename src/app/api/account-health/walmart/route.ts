import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartStoreStatus } from "@/lib/walmart";

// GET /api/account-health/walmart?storeIds=id1,id2,...
//
// Returns the latest performance snapshot per (storeIndex, metric, window)
// aggregated into a Walmart-shaped payload + item compliance summary.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const idsParam = url.searchParams.get("storeIds");
  const requestedIds = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  // ?debug=1 attaches the full Walmart payload for each metric so we can
  // see exactly what fields are populated when a displayed number looks
  // off vs Seller Center.
  const debug = url.searchParams.get("debug") === "1";

  const stores = await prisma.store.findMany({
    where: {
      channel: "Walmart",
      active: true,
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
    },
  });

  const result = [];
  for (const s of stores) {
    const idx = s.storeIndex ?? 1;
    const status = getWalmartStoreStatus(idx);

    // Latest snapshot per metric per window
    const recent = await prisma.walmartPerformanceSnapshot.findMany({
      where: { storeIndex: idx },
      orderBy: { capturedAt: "desc" },
      take: 200,
    });
    const latest = new Map<string, (typeof recent)[number]>();
    for (const r of recent) {
      const k = `${r.windowDays}|${r.metric}`;
      if (!latest.has(k)) latest.set(k, r);
    }
    const metrics = Array.from(latest.values()).map((r) => {
      // rawData holds the PerformanceMetricResult JSON the v2 sync wrote.
      // Pull trend, risk, updatedTimestamp through so the UI doesn't have
      // to call a second endpoint to enrich each card.
      let raw: Record<string, unknown> = {};
      try {
        raw = r.rawData ? JSON.parse(r.rawData) : {};
      } catch {
        // malformed snapshot — fall through with raw={}
      }
      const rawTyped = raw;
      return {
        metric: r.metric,
        windowDays: r.windowDays,
        value: r.value,
        threshold: r.threshold,
        isHealthy: r.isHealthy,
        status: r.status ?? (r.isHealthy ? "GOOD" : "URGENT"),
        capturedAt: r.capturedAt,
        // v2 enrichments
        resultStatus:
          (rawTyped.status as string | undefined) ?? null,
        trend: (rawTyped.trend as string | undefined) ?? null,
        performanceRiskLevel:
          (rawTyped.performanceRiskLevel as string | undefined) ??
          (rawTyped.riskLevel as string | undefined) ??
          null,
        updatedTimestamp:
          (rawTyped.updatedTimestamp as string | undefined) ?? null,
        standard: (rawTyped.standard as string | undefined) ?? null,
        ordersImpacted:
          (rawTyped.ordersImpacted as number | undefined) ?? null,
        impactedCustomerCount:
          (rawTyped.impactedCustomerCount as number | undefined) ?? null,
        gmvLoss: (rawTyped.gmvLoss as number | undefined) ?? null,
        overallRate: (rawTyped.overallRate as number | undefined) ?? null,
        sellerAccountableRate:
          (rawTyped.sellerAccountableRate as number | undefined) ?? null,
        recommendations:
          (rawTyped.recommendations as unknown[] | undefined) ?? null,
        httpStatus: (rawTyped.httpStatus as number | undefined) ?? null,
        errorMessage:
          (rawTyped.errorMessage as string | undefined) ?? null,
        rawPayload: debug ? rawTyped.rawPayload ?? null : undefined,
      };
    });

    const itemCompliance = await prisma.walmartItemCompliance.findMany({
      where: { storeIndex: idx, status: "OPEN" },
      // Urgent first so blocked/troubled listings surface above MONITOR rows.
      orderBy: [{ severity: "asc" }, { capturedAt: "desc" }],
      take: 200,
    });

    result.push({
      storeId: s.id,
      storeName: s.name,
      storeIndex: idx,
      sellerId: s.sellerId,
      configured: status.configured,
      metrics,
      itemCompliance: {
        totalIssues: itemCompliance.length,
        urgent: itemCompliance.filter((i) => i.severity === "URGENT").length,
        monitor: itemCompliance.filter((i) => i.severity === "MONITOR").length,
        items: itemCompliance.map((i) => ({
          id: i.id,
          itemId: i.itemId,
          sku: i.sku,
          title: i.title,
          issueType: i.issueType,
          issueDetails: i.issueDetails,
          severity: i.severity,
          status: i.status,
          reportedAt: i.reportedAt,
        })),
      },
      lastSyncedAt: metrics[0]?.capturedAt ?? null,
    });
  }

  return NextResponse.json({ stores: result });
}
