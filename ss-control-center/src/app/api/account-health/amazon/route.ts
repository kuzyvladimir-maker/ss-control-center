import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { POLICY_CATEGORIES } from "@/lib/amazon-sp-api/policy-compliance";

// GET /api/account-health/amazon?storeIds=id1,id2,...
//
// Returns one row per active Amazon store with:
//   - the latest AccountHealthSnapshot (v2 fields included)
//   - the 10 fixed policy categories (count + status)
//   - storeIndex / sellerId / configured flag
//
// `summary` aggregates the worst values across the result set for the hero row.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const idsParam = url.searchParams.get("storeIds");
  const requestedIds = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const stores = await prisma.store.findMany({
    where: {
      channel: "Amazon",
      active: true,
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
    },
    orderBy: { storeIndex: "asc" },
  });

  const result: Array<{
    storeId: string;
    storeName: string;
    storeIndex: number | null;
    sellerId: string | null;
    snapshot: unknown;
    policyCategories: Array<{
      category: string;
      displayName: string;
      count: number;
      status: string;
    }>;
    lastSyncedAt: Date | null;
  }> = [];

  for (const s of stores) {
    const snapshot = s.storeIndex
      ? await prisma.accountHealthSnapshot.findFirst({
          where: { storeId: `store${s.storeIndex}` },
          orderBy: { createdAt: "desc" },
        })
      : null;

    const categories = snapshot
      ? await prisma.policyViolationCategory.findMany({
          where: { snapshotId: snapshot.id },
        })
      : [];

    // Ensure we always return all 10 categories in canonical order, even if
    // the snapshot didn't store them (e.g. failed sync).
    const policyCategories = POLICY_CATEGORIES.map((c) => {
      const row = categories.find((x) => x.category === c.code);
      return {
        category: c.code,
        displayName: c.displayName,
        count: row?.count ?? 0,
        status: row?.status ?? "OK",
      };
    });

    result.push({
      storeId: s.id,
      storeName: s.name,
      storeIndex: s.storeIndex,
      sellerId: s.sellerId,
      snapshot,
      policyCategories,
      lastSyncedAt: snapshot?.syncedAt ?? null,
    });
  }

  // Hero summary
  const ahrs = result
    .map((r) => (r.snapshot as { accountHealthRating?: number } | null)?.accountHealthRating)
    .filter((v): v is number => typeof v === "number");
  const worstAhr = ahrs.length ? Math.min(...ahrs) : null;
  const worstOdr = result.reduce<{ store: string; value: number } | null>(
    (acc, r) => {
      const v = (r.snapshot as { orderDefectRate?: number } | null)?.orderDefectRate;
      if (v == null) return acc;
      if (!acc || v > acc.value) return { store: r.storeName, value: v };
      return acc;
    },
    null
  );
  // A store is "at risk" if Amazon's AHR puts it below the safe zone (<400)
  // OR any of the standard shipping/ODR thresholds is breached OR any
  // policy category is in CRITICAL state. This matches what the Amazon
  // Account Health page calls out as "issues".
  const breaches = result.filter((r) => {
    const snap = r.snapshot as
      | {
          status?: string;
          lateShipmentRate30d?: number;
          validTrackingRate?: number;
          onTimeDeliveryRate?: number;
          orderDefectRate?: number;
          accountHealthRating?: number | null;
          accountHealthRatingStatus?: string | null;
        }
      | null;
    if (!snap) return false;
    const ahrAtRisk =
      snap.accountHealthRatingStatus === "AT_RISK" ||
      snap.accountHealthRatingStatus === "AT_RISK_OF_DEACTIVATION" ||
      (typeof snap.accountHealthRating === "number" &&
        snap.accountHealthRating < 400);
    const policyHot = r.policyCategories.some(
      (p) => p.status === "CRITICAL"
    );
    return (
      ahrAtRisk ||
      policyHot ||
      snap.status === "critical" ||
      (snap.orderDefectRate ?? 0) >= 1 ||
      (snap.lateShipmentRate30d ?? 0) >= 4 ||
      (snap.validTrackingRate ?? 100) <= 95 ||
      (snap.onTimeDeliveryRate ?? 100) <= 90
    );
  }).length;

  return NextResponse.json({
    stores: result,
    summary: {
      total: result.length,
      breaches,
      healthy: result.length - breaches,
      worstAhr,
      worstOdr,
    },
  });
}
