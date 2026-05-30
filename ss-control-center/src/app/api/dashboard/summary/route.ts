import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchProcurementCards } from "@/lib/veeqo/orders-procurement";

// Resolve a CSV `storeIds` param into the native filter keys used by
// AmazonOrder / WalmartOrder / etc. Returns `null` for "no filter — show all"
// when the param is missing OR every active store is selected.
async function resolveStoreFilter(searchParams: URLSearchParams) {
  const raw = searchParams.get("storeIds");
  const allStores = await prisma.store.findMany({ where: { active: true } });
  const total = allStores.length;

  // Missing or empty CSV → show everything.
  if (!raw) {
    return {
      amazonStoreIndexes: null as number[] | null,
      walmartStoreIndexes: null as number[] | null,
      walmartSellerIds: null as string[] | null,
      noneSelected: false,
      total,
    };
  }

  const requested = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  if (requested.size === 0) {
    return {
      amazonStoreIndexes: [] as number[],
      walmartStoreIndexes: [] as number[],
      walmartSellerIds: [] as string[],
      noneSelected: true,
      total,
    };
  }

  // If the caller selected every store, treat as null (no filter) so we
  // skip the IN-list overhead.
  if (requested.size === total && allStores.every((s) => requested.has(s.id))) {
    return {
      amazonStoreIndexes: null,
      walmartStoreIndexes: null,
      walmartSellerIds: null,
      noneSelected: false,
      total,
    };
  }

  const chosen = allStores.filter((s) => requested.has(s.id));
  const amazonStoreIndexes = chosen
    .filter((s) => s.channel === "Amazon" && s.storeIndex != null)
    .map((s) => s.storeIndex as number);
  const walmartStores = chosen.filter((s) => s.channel === "Walmart");
  const walmartStoreIndexes = walmartStores
    .map((s) => s.storeIndex)
    .filter((x): x is number => x != null);
  const walmartSellerIds = walmartStores
    .map((s) => s.sellerId)
    .filter((x): x is string => !!x);

  return {
    amazonStoreIndexes,
    walmartStoreIndexes,
    walmartSellerIds,
    noneSelected: false,
    total,
  };
}

export async function GET(request: NextRequest) {
  try {
    const filter = await resolveStoreFilter(request.nextUrl.searchParams);
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    // When the caller explicitly selected zero stores, short-circuit with
    // zeroed-out values rather than running every aggregation.
    if (filter.noneSelected) {
      return NextResponse.json(emptyResponse());
    }

    // Build Amazon filter clause once — every Amazon-side aggregation reuses it.
    const amazonStoreFilter =
      filter.amazonStoreIndexes !== null
        ? filter.amazonStoreIndexes.length > 0
          ? { storeIndex: { in: filter.amazonStoreIndexes } }
          : { storeIndex: { in: [-1] } } // matches nothing
        : {};

    // Walmart side — gate every Walmart query on at least one Walmart store
    // being selected. When none, return empty Walmart payload (the Dashboard
    // hides that row entirely via the hasWalmart flag client-side).
    const walmartSelected =
      filter.walmartStoreIndexes === null ||
      filter.walmartStoreIndexes.length > 0 ||
      (filter.walmartSellerIds?.length ?? 0) > 0;

    const walmartStoreFilter =
      filter.walmartStoreIndexes !== null
        ? walmartSelected
          ? filter.walmartStoreIndexes.length > 0
            ? { storeIndex: { in: filter.walmartStoreIndexes } }
            : {}
          : { storeIndex: { in: [-1] } }
        : {};

    const [
      totalOrders,
      awaitingShipment,
      shippedToday,
      openCsCases,
      activeClaims,
      healthSnapshots,
      adjustmentsSum,
      adjustmentsUnreviewed,
      ordersStore1,
      ordersStore2,
      frozenIncidents30d,
      // Walmart
      walmartOrdersTotal30d,
      walmartOrdersToday,
      walmartReturnsRecent,
      walmartRefundsSum7d,
      walmartPerfLatest,
    ] = await Promise.all([
      prisma.amazonOrder.count({
        where: { purchaseDate: { gte: thirtyDaysAgo }, ...amazonStoreFilter },
      }),
      prisma.amazonOrder.count({
        where: { status: "Unshipped", ...amazonStoreFilter },
      }),
      prisma.amazonOrder.count({
        where: {
          status: "Shipped",
          lastUpdateDate: { gte: todayStart },
          ...amazonStoreFilter,
        },
      }),
      prisma.csCase.count({ where: { status: "open" } }),
      prisma.atozzClaim.count({
        where: {
          status: {
            in: ["NEW", "EVIDENCE_GATHERED", "RESPONSE_READY", "SUBMITTED"],
          },
          ...(filter.amazonStoreIndexes !== null
            ? filter.amazonStoreIndexes.length > 0
              ? { storeIndex: { in: filter.amazonStoreIndexes } }
              : { storeIndex: { in: [-1] } }
            : {}),
        },
      }),
      prisma.accountHealthSnapshot.findMany({
        where: { syncStatus: "done" },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.shippingAdjustment.aggregate({
        _sum: { adjustmentAmount: true },
        where: { createdAt: { gte: thirtyDaysAgo } },
      }),
      // Actionable adjustments in the last 30d — drives the sidebar pill
      // badge. "Actionable" = unreviewed AND not yet disputed (filed
      // disputes are off Vladimir's queue). The badge was previously
      // bound to A-to-Z claim count by mistake (pre-2026-05-29).
      prisma.shippingAdjustment.count({
        where: {
          createdAt: { gte: thirtyDaysAgo },
          reviewed: false,
          disputeCaseId: null,
        },
      }),
      // S1 / S2 counts MUST share the same purchaseDate window as the
      // total Orders 30d card. Previously these omitted the date filter
      // and reported all-time counts, which broke the math on the card
      // (S1=1132 > total=746). Match the window so S1 + S2 + others
      // adds up to the headline number.
      prisma.amazonOrder.count({
        where: {
          storeIndex: 1,
          purchaseDate: { gte: thirtyDaysAgo },
          ...amazonStoreFilter,
        },
      }),
      prisma.amazonOrder.count({
        where: {
          storeIndex: 2,
          purchaseDate: { gte: thirtyDaysAgo },
          ...amazonStoreFilter,
        },
      }),
      // Frozen incidents in the last 30 days — drives the Dashboard Frozen
      // tile. Excludes `outcome: ok` because those are non-incidents (we
      // log them for the regression model but the operator doesn't need
      // an alert for an order that arrived frozen as intended).
      prisma.frozenIncident.count({
        where: {
          createdAt: { gte: thirtyDaysAgo },
          outcome: { not: "ok" },
        },
      }),
      walmartSelected
        ? prisma.walmartOrder.count({
            where: {
              orderDate: { gte: thirtyDaysAgo },
              ...walmartStoreFilter,
            },
          })
        : 0,
      walmartSelected
        ? prisma.walmartOrder.count({
            where: {
              orderDate: { gte: todayStart },
              ...walmartStoreFilter,
            },
          })
        : 0,
      walmartSelected
        ? prisma.buyerMessage.count({
            where: {
              channel: "Walmart",
              walmartReturnId: { not: null },
              status: { in: ["NEW", "ANALYZED"] },
            },
          })
        : 0,
      walmartSelected
        ? prisma.walmartReconTransaction.aggregate({
            _sum: { amount: true },
            where: {
              transactionType: "Refunds",
              transactionPostedTimestamp: { gte: sevenDaysAgo },
              ...walmartStoreFilter,
            },
          })
        : { _sum: { amount: 0 } },
      walmartSelected
        ? prisma.walmartPerformanceSnapshot.findMany({
            orderBy: { capturedAt: "desc" },
            take: 50,
            where: walmartStoreFilter,
          })
        : [],
    ]);

    // Procurement (Veeqo) is unfiltered — the API doesn't expose a per-store
    // dimension that maps to our Store table cleanly. Surface it as-is.
    let procurementOrdersToBuy = 0;
    try {
      const cards = await fetchProcurementCards();
      const distinctOrders = new Set<string>();
      for (const c of cards) distinctOrders.add(c.orderId);
      procurementOrdersToBuy = distinctOrders.size;
    } catch (err) {
      console.error("[dashboard/summary] procurement count failed:", err);
    }

    const latestByStore = new Map<string, (typeof healthSnapshots)[0]>();
    for (const snap of healthSnapshots) {
      if (!latestByStore.has(snap.storeId)) latestByStore.set(snap.storeId, snap);
    }
    // Match the Account Health hero "At Risk" card: AHR < 200 only.
    // The legacy "status critical/warning" buckets also lit up on a single
    // policy violation, which inflated the sidebar badge with stores that
    // weren't actually at risk of deactivation per Amazon's rule.
    const healthIssues = Array.from(latestByStore.values()).filter(
      (s) =>
        typeof s.accountHealthRating === "number" &&
        s.accountHealthRating < 200
    ).length;

    const latestPerf = new Map<string, (typeof walmartPerfLatest)[number]>();
    for (const s of walmartPerfLatest) {
      const key = `${s.windowDays}|${s.metric}`;
      if (!latestPerf.has(key)) latestPerf.set(key, s);
    }
    // Same alignment for Walmart: only count metrics Walmart itself
    // labels URGENT (status field comes from persist-performance.ts which
    // honours performanceRiskLevel). `!isHealthy` includes "Monitor"
    // rows that Walmart doesn't escalate yet — those don't belong in the
    // top-line badge either.
    const walmartHealthIssues = Array.from(latestPerf.values()).filter(
      (s) => s.status === "URGENT"
    ).length;

    const walmartPayload = walmartSelected
      ? {
          ordersTotal30d: walmartOrdersTotal30d as number,
          ordersToday: walmartOrdersToday as number,
          returnsPending: walmartReturnsRecent as number,
          refundsLast7d: Math.abs(
            (walmartRefundsSum7d as { _sum: { amount: number | null } })._sum
              .amount || 0
          ),
          healthIssues: walmartHealthIssues,
          healthStatus:
            walmartPerfLatest.length === 0
              ? ("no-data" as const)
              : walmartHealthIssues === 0
                ? ("healthy" as const)
                : walmartHealthIssues < 3
                  ? ("warning" as const)
                  : ("critical" as const),
        }
      : null;

    // syncedAt should reflect when the DB last received fresh data from
    // marketplaces — not when the operator's browser last hit this
    // endpoint. We grab the most recent successful SyncLog entry; the
    // header chip then shows e.g. "Synced 18m ago" so stale dashboards
    // are obvious instead of always reading "Synced just now".
    const lastSync = await prisma.syncLog.findFirst({
      where: { status: "done" },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    const syncedAt =
      lastSync?.completedAt?.toISOString() ?? new Date().toISOString();

    return NextResponse.json({
      orders: {
        total30d: totalOrders,
        awaitingShipment,
        shippedToday,
        store1: ordersStore1,
        store2: ordersStore2,
      },
      customerService: { openCases: openCsCases },
      claims: { active: activeClaims },
      health: { issues: healthIssues },
      procurement: { ordersToBuy: procurementOrdersToBuy },
      frozen: { incidents30d: frozenIncidents30d },
      adjustments: {
        monthlyTotal: adjustmentsSum._sum.adjustmentAmount || 0,
        unreviewed: adjustmentsUnreviewed,
      },
      walmart: walmartPayload,
      syncedAt,
    });
  } catch (error) {
    console.error("[dashboard/summary] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load dashboard summary" },
      { status: 500 }
    );
  }
}

function emptyResponse() {
  return {
    orders: {
      total30d: 0,
      awaitingShipment: 0,
      shippedToday: 0,
      store1: 0,
      store2: 0,
    },
    customerService: { openCases: 0 },
    claims: { active: 0 },
    health: { issues: 0 },
    procurement: { ordersToBuy: 0 },
    frozen: { incidents30d: 0 },
    adjustments: { monthlyTotal: 0, unreviewed: 0 },
    walmart: null,
    syncedAt: new Date().toISOString(),
  };
}
