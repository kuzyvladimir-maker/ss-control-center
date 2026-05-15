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
      let raw: {
        status?: string;
        trend?: string;
        performanceRiskLevel?: string;
        riskLevel?: string;
        updatedTimestamp?: string;
        standard?: string;
        ordersImpacted?: number;
        impactedCustomerCount?: number;
        gmvLoss?: number;
        recommendations?: Array<{ recommendation: string; moreInfoLink: string }>;
        httpStatus?: number;
        errorMessage?: string;
      } = {};
      try {
        raw = r.rawData ? JSON.parse(r.rawData) : {};
      } catch {
        // malformed snapshot — fall through with raw={}
      }
      return {
        metric: r.metric,
        windowDays: r.windowDays,
        value: r.value,
        threshold: r.threshold,
        isHealthy: r.isHealthy,
        status: r.status ?? (r.isHealthy ? "GOOD" : "URGENT"),
        capturedAt: r.capturedAt,
        // v2 enrichments
        resultStatus: raw.status ?? null,
        trend: raw.trend ?? null,
        performanceRiskLevel:
          raw.performanceRiskLevel ?? raw.riskLevel ?? null,
        updatedTimestamp: raw.updatedTimestamp ?? null,
        standard: raw.standard ?? null,
        ordersImpacted: raw.ordersImpacted ?? null,
        impactedCustomerCount: raw.impactedCustomerCount ?? null,
        gmvLoss: raw.gmvLoss ?? null,
        recommendations: raw.recommendations ?? null,
        httpStatus: raw.httpStatus ?? null,
        errorMessage: raw.errorMessage ?? null,
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
