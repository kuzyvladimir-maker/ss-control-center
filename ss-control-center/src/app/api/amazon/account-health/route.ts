import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const THRESHOLDS: Record<
  string,
  { warning: number; critical: number; limit: string; lowerIsBetter: boolean }
> = {
  orderDefectRate: { warning: 0.75, critical: 1.0, limit: "< 1%", lowerIsBetter: true },
  lateShipmentRate30d: { warning: 3.0, critical: 4.0, limit: "< 4%", lowerIsBetter: true },
  lateShipmentRate10d: { warning: 3.0, critical: 4.0, limit: "< 4%", lowerIsBetter: true },
  preFulfillmentCancelRate: { warning: 2.0, critical: 2.5, limit: "< 2.5%", lowerIsBetter: true },
  validTrackingRate: { warning: 97, critical: 95, limit: "> 95%", lowerIsBetter: false },
  onTimeDeliveryRate: { warning: 92, critical: 90, limit: "> 90%", lowerIsBetter: false },
};

function metricStatus(value: number | null, key: string): "ok" | "warning" | "critical" | "unknown" {
  if (value === null || value === undefined) return "unknown";
  const t = THRESHOLDS[key];
  if (!t) return "unknown";
  if (t.lowerIsBetter) {
    if (value >= t.critical) return "critical";
    if (value >= t.warning) return "warning";
  } else {
    if (value <= t.critical) return "critical";
    if (value <= t.warning) return "warning";
  }
  return "ok";
}

export async function GET() {
  try {
    const stores = [];

    for (let i = 1; i <= 5; i++) {
      const envKey = `AMAZON_SP_REFRESH_TOKEN_STORE${i}`;
      const token = process.env[envKey];
      const sid = `store${i}`;

      if (!token) {
        console.log(`[AccountHealth] ${envKey}: not set`);
        stores.push({ storeIndex: i, configured: false, status: "not_configured" });
        continue;
      }
      console.log(`[AccountHealth] ${envKey}: found (${token.substring(0, 10)}...)`);

      const latest = await prisma.accountHealthSnapshot.findFirst({
        where: { storeId: sid, syncStatus: "done" },
        orderBy: { createdAt: "desc" },
      });

      const syncing = await prisma.accountHealthSnapshot.findFirst({
        where: { storeId: sid, syncStatus: "syncing" },
        orderBy: { createdAt: "desc" },
      });

      if (!latest) {
        stores.push({
          storeIndex: i,
          configured: true,
          status: syncing ? "syncing" : "pending",
          message: syncing ? "Syncing..." : "No data yet — click Sync",
        });
        continue;
      }

      const lsr30Status = metricStatus(latest.lateShipmentRate30d, "lateShipmentRate30d");
      const cancelStatus = metricStatus(latest.preFulfillmentCancelRate, "preFulfillmentCancelRate");
      const odrStatus = metricStatus(latest.orderDefectRate, "orderDefectRate");
      const vtrStatus = metricStatus(latest.validTrackingRate, "validTrackingRate");
      const otdrStatus = metricStatus(latest.onTimeDeliveryRate, "onTimeDeliveryRate");

      const allStatuses = [lsr30Status, cancelStatus, odrStatus, vtrStatus, otdrStatus]
        .filter((s) => s !== "unknown");
      const overallStatus = allStatuses.includes("critical")
        ? "critical"
        : allStatuses.includes("warning")
          ? "warning"
          : "healthy";

      stores.push({
        storeIndex: i,
        configured: true,
        status: overallStatus,
        syncing: !!syncing,
        storeName: latest.storeName || `Store ${i}`,
        sellerId: latest.sellerId,
        metrics: {
          odr: {
            value: latest.orderDefectRate,
            status: odrStatus,
            limit: "< 1%",
            period: "60 days",
            orders: latest.odrOrders60d,
            breakdown: {
              negativeFeedback: { count: latest.negativeFeedbackCount, rate: latest.negativeFeedbackRate },
              atozClaims: { count: latest.atozClaimsCount, rate: latest.atozClaimsRate },
              chargebacks: { count: latest.chargebackCount, rate: latest.chargebackRate },
            },
          },
          lsr10d: {
            value: latest.lateShipmentRate10d,
            status: metricStatus(latest.lateShipmentRate10d, "lateShipmentRate10d"),
            limit: "< 4%",
            period: "10 days",
            numerator: latest.lsr10dLate,
            denominator: latest.lsr10dTotal,
          },
          lsr30d: {
            value: latest.lateShipmentRate30d,
            status: lsr30Status,
            limit: "< 4%",
            period: "30 days",
            numerator: latest.lsr30dLate,
            denominator: latest.lsr30dTotal,
          },
          cancelRate: {
            value: latest.preFulfillmentCancelRate,
            status: cancelStatus,
            limit: "< 2.5%",
            period: "7 days",
            numerator: latest.cancelCancelled,
            denominator: latest.cancelTotal,
          },
          vtr: {
            value: latest.validTrackingRate,
            status: vtrStatus,
            limit: "> 95%",
            period: "30 days",
            numerator: latest.vtrTracked,
            denominator: latest.vtrTotal,
          },
          otdr: {
            value: latest.onTimeDeliveryRate,
            status: otdrStatus,
            limit: "> 90%",
            period: "14 days",
            numerator: latest.otdrOnTime,
            denominator: latest.otdrTotal,
          },
        },
        alertCount: latest.alertCount,
        criticalCount: latest.criticalCount,
        syncedAt: latest.syncedAt,
      });
    }

    const configured = stores.filter((s) => s.configured);
    return NextResponse.json({
      stores,
      summary: {
        total: 5,
        configured: configured.length,
        healthy: stores.filter((s) => s.status === "healthy").length,
        warning: stores.filter((s) => s.status === "warning").length,
        critical: stores.filter((s) => s.status === "critical").length,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Account health GET error:", error);
    return NextResponse.json({
      stores: [],
      summary: { total: 5, configured: 0, healthy: 0, warning: 0, critical: 0 },
      fetchedAt: new Date().toISOString(),
    });
  }
}
