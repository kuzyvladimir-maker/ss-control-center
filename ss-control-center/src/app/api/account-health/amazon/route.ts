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
  // "At Risk" mirrors Amazon's actual deactivation rule: AHR < 200 and
  // nothing else. Open policy violations, ODR/LSR/VTR/OTDR breaches and
  // cancel-rate spikes all feed into Amazon's AHR algorithm — if any of
  // them are bad enough to put the account at risk, the AHR will drop
  // below 200 and the store will be counted here. Counting those
  // metrics again on top of AHR double-counts and produces the "3 of 4
  // need action" alarm even when every store is above the 200 line.
  // Vladimir confirmed this is the wrong framing 2026-05-15.
  const breaches = result.filter((r) => {
    const snap = r.snapshot as
      | { accountHealthRating?: number | null }
      | null;
    if (!snap) return false;
    return (
      typeof snap.accountHealthRating === "number" &&
      snap.accountHealthRating < 200
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
