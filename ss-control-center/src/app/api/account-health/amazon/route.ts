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
  const worstAhrRow = result.reduce<{ store: string; value: number } | null>(
    (acc, r) => {
      const v = (r.snapshot as { accountHealthRating?: number } | null)
        ?.accountHealthRating;
      if (typeof v !== "number") return acc;
      if (!acc || v < acc.value) return { store: r.storeName, value: v };
      return acc;
    },
    null
  );
  const worstOdr = result.reduce<{ store: string; value: number } | null>(
    (acc, r) => {
      const v = (r.snapshot as { orderDefectRate?: number } | null)?.orderDefectRate;
      if (v == null) return acc;
      if (!acc || v > acc.value) return { store: r.storeName, value: v };
      return acc;
    },
    null
  );
  // Total open policy violations across all stores (sum of defectsCount).
  const openPolicyViolations = result.reduce(
    (sum, r) => sum + r.policyCategories.reduce((s, p) => s + p.count, 0),
    0
  );
  // A store is "at risk" by Amazon's deactivation criteria, NOT "at risk"
  // in the broad sense. The line is:
  //   - AHR < 200  (deactivation threshold per Amazon docs / Seller Central)
  //   - OR a hard shipping/ODR threshold is breached (ODR ≥ 1%, LSR ≥ 4%,
  //     Cancel ≥ 2.5%, VTR ≤ 95%, OTDR ≤ 90%)
  //   - OR any policy category has an open violation
  // AHR in the 200–399 "warned" band is NOT at-risk here — it's a warning
  // but Amazon doesn't deactivate over it.
  const breaches = result.filter((r) => {
    const snap = r.snapshot as
      | {
          lateShipmentRate30d?: number;
          validTrackingRate?: number;
          onTimeDeliveryRate?: number;
          orderDefectRate?: number;
          preFulfillmentCancelRate?: number;
          accountHealthRating?: number | null;
        }
      | null;
    if (!snap) return false;
    const ahrCritical =
      typeof snap.accountHealthRating === "number" &&
      snap.accountHealthRating < 200;
    const policyHot = r.policyCategories.some((p) => p.count > 0);
    return (
      ahrCritical ||
      policyHot ||
      (snap.orderDefectRate ?? 0) >= 1 ||
      (snap.lateShipmentRate30d ?? 0) >= 4 ||
      (snap.preFulfillmentCancelRate ?? 0) >= 2.5 ||
      (snap.validTrackingRate ?? 100) <= 95 ||
      (snap.onTimeDeliveryRate ?? 100) <= 90
    );
  }).length;

  // Configured stores = those that have a snapshot (sync ran for them).
  // Stores without snapshots (no SP-API creds yet) shouldn't pollute the
  // "X of Y" count in the hero card.
  const configured = result.filter((r) => r.snapshot !== null).length;
  return NextResponse.json({
    stores: result,
    summary: {
      total: result.length,
      configured,
      breaches,
      healthy: configured - breaches,
      worstAhr: worstAhrRow,
      worstOdr,
      openPolicyViolations,
    },
  });
}
