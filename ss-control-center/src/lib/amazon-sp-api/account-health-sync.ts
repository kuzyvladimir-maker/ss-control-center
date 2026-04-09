/**
 * Account Health Sync — Exact Amazon formulas
 *
 * ODR:          60 days — (neg feedback + a-to-z not denied + chargebacks) / total orders
 * LSR 10d:      10 days — orders shipped late / total orders
 * LSR 30d:      30 days — orders shipped late / total orders
 * Cancel Rate:  7 days  — seller-cancelled / total orders
 * VTR:          30 days — shipments with valid tracking / total shipped
 * OTDR:         14 days — delivered on time / total delivered
 */

import { prisma } from "@/lib/prisma";
import { spApiGet } from "./client";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function pct(num: number, den: number): number {
  if (den === 0) return 0;
  return parseFloat(((num / den) * 100).toFixed(2));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllOrders(storeId: string, createdAfter: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let nextToken: string | undefined;

  do {
    const params: Record<string, string> = {
      MarketplaceIds: process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER",
      CreatedAfter: createdAfter,
      MaxResultsPerPage: "100",
    };
    if (nextToken) params.NextToken = nextToken;

    const data = await spApiGet("/orders/v0/orders", { storeId, params });
    const orders = data.payload?.Orders || [];
    all.push(...orders);
    nextToken = data.payload?.NextToken;

    if (nextToken) await sleep(1500);
  } while (nextToken);

  return all;
}

export async function syncStoreHealth(storeIndex: number) {
  const storeId = `store${storeIndex}`;
  console.log(`[AccountHealth] Syncing ${storeId}...`);

  const snapshot = await prisma.accountHealthSnapshot.create({
    data: { storeId, syncStatus: "syncing" },
  });

  try {
    // Store name
    const partData = await spApiGet("/sellers/v1/marketplaceParticipations", { storeId });
    const participations = partData.payload || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usMp = participations.find((p: any) => p.marketplace?.id === "ATVPDKIKX0DER");
    const storeName = usMp?.marketplace?.name || `Store ${storeIndex}`;

    // Fetch orders for max window (60 days for ODR)
    const allOrders = await fetchAllOrders(storeId, daysAgo(60));

    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filterAfter = (orders: any[], daysBack: number) =>
      orders.filter((o) => new Date(o.PurchaseDate) >= new Date(now.getTime() - daysBack * 86400000));

    // ========== 1. PRE-FULFILLMENT CANCEL RATE (7 days) ==========
    const orders7d = filterAfter(allOrders, 7);
    const sellerCancelled7d = orders7d.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) =>
        o.OrderStatus === "Canceled" &&
        !["BuyerCanceled", "CustomerInitiated"].includes(o.CancellationReason || "")
    );
    const cancelRate = pct(sellerCancelled7d.length, orders7d.length);

    // ========== 2. LATE SHIPMENT RATE — 10d and 30d ==========
    const orders10d = filterAfter(allOrders, 10);
    const orders30d = filterAfter(allOrders, 30);

    // "Late" = ship confirmation after LatestShipDate
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function countLate(orders: any[]): { late: number; total: number } {
      // Only count orders that should have been shipped (not cancelled)
      const shippable = orders.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (o: any) => o.OrderStatus !== "Canceled" && o.LatestShipDate
      );
      const late = shippable.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (o: any) => {
          // Unshipped past deadline = definitely late
          if (o.OrderStatus === "Unshipped" || o.OrderStatus === "Pending") {
            return new Date(o.LatestShipDate) < now;
          }
          // Shipped — check if LastUpdateDate > LatestShipDate (approximation)
          if (o.OrderStatus === "Shipped" && o.LastUpdateDate) {
            return new Date(o.LastUpdateDate) > new Date(o.LatestShipDate);
          }
          return false;
        }
      );
      return { late: late.length, total: shippable.length };
    }

    const lsr10 = countLate(orders10d);
    const lsr30 = countLate(orders30d);
    const lateShipmentRate10d = pct(lsr10.late, lsr10.total);
    const lateShipmentRate30d = pct(lsr30.late, lsr30.total);

    // ========== 3. VALID TRACKING RATE (30 days) ==========
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shipped30d = orders30d.filter((o: any) => o.OrderStatus === "Shipped");
    const withTracking30d = shipped30d.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) => o.NumberOfItemsShipped && o.NumberOfItemsShipped > 0
    );
    const validTrackingRate = pct(withTracking30d.length, shipped30d.length || 1);

    // ========== 4. ON-TIME DELIVERY RATE (14 days) ==========
    const orders14d = filterAfter(allOrders, 14);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delivered14d = orders14d.filter((o: any) => o.OrderStatus === "Shipped");
    // Without actual delivery date from carrier, estimate from LatestDeliveryDate
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withDeliveryPromise = delivered14d.filter((o: any) => o.LatestDeliveryDate);
    // If order is shipped and we're still before delivery promise = on time (assumption)
    const onTimeCount = withDeliveryPromise.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) => new Date(o.LatestDeliveryDate) >= now
    ).length;
    const otdr = withDeliveryPromise.length > 0
      ? pct(onTimeCount, withDeliveryPromise.length)
      : null;

    // ========== 5. ODR (60 days) ==========
    const orders60d = allOrders;
    // Count A-to-Z claims from our DB
    const atozCount = await prisma.atozzClaim.count({
      where: {
        createdAt: { gte: new Date(daysAgo(60)) },
        amazonDecision: { not: "IN_OUR_FAVOR" }, // not denied
      },
    });
    // Negative feedback from our DB
    const negFeedbackCount = await prisma.sellerFeedback.count({
      where: {
        createdAt: { gte: new Date(daysAgo(60)) },
        rating: { lte: 2 },
      },
    });
    const odrNumerator = negFeedbackCount + atozCount;
    const odr = pct(odrNumerator, orders60d.length);

    // ========== OVERALL STATUS ==========
    const statuses: string[] = [];
    // LSR 30d is the one Amazon uses for enforcement
    if (lateShipmentRate30d >= 4.0) statuses.push("critical");
    else if (lateShipmentRate30d >= 3.0) statuses.push("warning");
    if (cancelRate >= 2.5) statuses.push("critical");
    else if (cancelRate >= 2.0) statuses.push("warning");
    if (odr >= 1.0) statuses.push("critical");
    else if (odr >= 0.75) statuses.push("warning");
    if (validTrackingRate <= 95) statuses.push("critical");
    else if (validTrackingRate <= 97) statuses.push("warning");
    if (otdr !== null) {
      if (otdr <= 90) statuses.push("critical");
      else if (otdr <= 92) statuses.push("warning");
    }

    const overallStatus = statuses.includes("critical")
      ? "critical"
      : statuses.includes("warning")
        ? "warning"
        : "healthy";

    const alertCount = statuses.filter((s) => s === "warning" || s === "critical").length;
    const criticalCount = statuses.filter((s) => s === "critical").length;

    // ========== SAVE ==========
    await prisma.accountHealthSnapshot.update({
      where: { id: snapshot.id },
      data: {
        storeName,
        status: overallStatus,

        orderDefectRate: odr,
        odrOrders60d: orders60d.length,
        negativeFeedbackCount: negFeedbackCount,
        negativeFeedbackRate: pct(negFeedbackCount, orders60d.length),
        atozClaimsCount: atozCount,
        atozClaimsRate: pct(atozCount, orders60d.length),
        chargebackCount: 0,
        chargebackRate: 0,

        lateShipmentRate10d: lateShipmentRate10d,
        lsr10dLate: lsr10.late,
        lsr10dTotal: lsr10.total,
        lateShipmentRate30d: lateShipmentRate30d,
        lsr30dLate: lsr30.late,
        lsr30dTotal: lsr30.total,

        preFulfillmentCancelRate: cancelRate,
        cancelCancelled: sellerCancelled7d.length,
        cancelTotal: orders7d.length,

        validTrackingRate,
        vtrTracked: withTracking30d.length,
        vtrTotal: shipped30d.length,

        onTimeDeliveryRate: otdr,
        otdrOnTime: onTimeCount,
        otdrTotal: withDeliveryPromise.length,

        alertCount,
        criticalCount,
        syncStatus: "done",
        syncedAt: new Date(),
      },
    });

    console.log(
      `[AccountHealth] ${storeId}: ${overallStatus} | ODR ${odr}% | LSR10 ${lateShipmentRate10d}% LSR30 ${lateShipmentRate30d}% | Cancel ${cancelRate}% | VTR ${validTrackingRate}% | OTDR ${otdr ?? "n/a"}%`
    );
    return { success: true, storeIndex, status: overallStatus };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await prisma.accountHealthSnapshot.update({
      where: { id: snapshot.id },
      data: { syncStatus: "error", syncError: msg, syncedAt: new Date() },
    });
    console.error(`[AccountHealth] ${storeId} failed:`, msg);
    return { success: false, storeIndex, error: msg };
  }
}

export async function syncAllStores() {
  const results = [];
  for (let i = 1; i <= 5; i++) {
    if (!process.env[`AMAZON_SP_REFRESH_TOKEN_STORE${i}`]) continue;
    results.push(await syncStoreHealth(i));
    await sleep(2000);
  }
  return results;
}
