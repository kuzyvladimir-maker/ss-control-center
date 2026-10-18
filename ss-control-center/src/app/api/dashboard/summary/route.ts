import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isVeeqoAuthError,
  VEEQO_KEY_REJECTED_MESSAGE,
} from "@/lib/veeqo/client";
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

// Midnight in America/New_York as a UTC instant. `setHours(0)` on Vercel is
// UTC midnight = 8pm ET the day before, so "shipped today" mixed two days.
function startOfTodayET(now: Date): Date {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offset = now.getTime() - ny.getTime();
  const midnight = new Date(ny);
  midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + offset);
}

// A source older than this is reported as stale on the Dashboard instead of
// silently rendering 0 (2026-10-18 inspection: Health had no snapshot since
// 2026-06-30, Customer Hub no message since 2026-05-30 — both read "0").
const STALE_MS = 2 * 86400000;

function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export async function GET(request: NextRequest) {
  try {
    const filter = await resolveStoreFilter(request.nextUrl.searchParams);
    const now = new Date();
    const todayStart = startOfTodayET(now);
    const todayYmd = todayStart
      .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);

    // Walmart is only "live" when the Store row is active. While it's off,
    // its 300+ August messages must not inflate the customer counts.
    const walmartLive =
      (await prisma.store.count({ where: { channel: "Walmart", active: true } })) > 0;
    const liveChannels = walmartLive ? ["Amazon", "Walmart"] : ["Amazon"];

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
      // "Cases open" = customer threads still waiting on us, from the last
      // 30 days, on live channels: open CsCase rows + Customer Hub messages
      // not yet answered. Was all-time open CsCase only → 3 April Walmart
      // cases shown forever.
      Promise.all([
        prisma.csCase.count({
          where: {
            status: "open",
            createdAt: { gte: thirtyDaysAgo },
            channel: { in: liveChannels },
          },
        }),
        prisma.buyerMessage.count({
          where: {
            status: { in: ["NEW", "ANALYZED"] },
            createdAt: { gte: thirtyDaysAgo },
            channel: { in: liveChannels },
          },
        }),
      ]).then(([a, b]) => a + b),
      // Active A-to-Z = in-flight AND opened in the last 60 days. Amazon
      // decides a claim within weeks; the 15 rows parked in
      // EVIDENCE_GATHERED since 2026-04-12 are abandoned workflow state,
      // not live claims.
      prisma.atozzClaim.count({
        where: {
          createdAt: { gte: sixtyDaysAgo },
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
      // Frozen incidents in the last 30 days (complaint log). Kept for the
      // sidebar/API contract; the Dashboard tile now leads with the nightly
      // risk forecast below because nothing auto-populates this table. Excludes `outcome: ok` because those are non-incidents (we
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

    // ── Extra signals for the Dashboard (2026-10-18) ──────────────────────
    const [
      ordersByStoreRaw,
      frozenRiskAlerts,
      latestSnapshot,
      recentReportJobs,
      lastAmazonMessage,
      amazonStores,
    ] = await Promise.all([
      prisma.amazonOrder.groupBy({
        by: ["storeIndex"],
        where: { purchaseDate: { gte: thirtyDaysAgo }, ...amazonStoreFilter },
        _count: { _all: true },
        _max: { purchaseDate: true },
      }),
      // Nightly weather-risk forecast for frozen orders shipping today or
      // later, still awaiting the operator's decision.
      prisma.frozenRiskAlert.groupBy({
        by: ["riskLevel"],
        where: { shipDate: { gte: todayYmd }, status: "pending" },
        _count: { _all: true },
      }),
      prisma.accountHealthSnapshot.findFirst({
        where: { syncStatus: "done" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.reportSyncJob.findMany({
        where: { createdAt: { gte: new Date(now.getTime() - 3 * 86400000) } },
        orderBy: { createdAt: "desc" },
        select: { storeId: true, status: true, error: true },
        take: 40,
      }),
      prisma.buyerMessage.findFirst({
        where: { channel: "Amazon" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.store.findMany({
        where: { channel: "Amazon", active: true, storeIndex: { not: null } },
        select: { storeIndex: true, name: true },
        orderBy: { storeIndex: "asc" },
      }),
    ]);

    const ordersByStore = ordersByStoreRaw
      .filter((r) => r.storeIndex != null)
      .map((r) => ({
        storeIndex: r.storeIndex as number,
        count: r._count._all,
        lastOrderAt: r._max.purchaseDate?.toISOString() ?? null,
      }))
      .sort((a, b) => a.storeIndex - b.storeIndex);

    const riskCount = (levels: string[]) =>
      frozenRiskAlerts
        .filter((r) => levels.includes(r.riskLevel))
        .reduce((n, r) => n + r._count._all, 0);
    const frozenRiskElevated = riskCount(["medium", "high", "critical"]);
    const frozenRiskLow = riskCount(["low"]);

    // Plain-English list of broken data feeds, rendered as one banner on the
    // Dashboard so a dead source is visible instead of reading as "0".
    const dataIssues: string[] = [];
    const latestJobByStore = new Map<string, (typeof recentReportJobs)[number]>();
    for (const j of recentReportJobs) {
      if (!latestJobByStore.has(j.storeId)) latestJobByStore.set(j.storeId, j);
    }
    const denied = [...latestJobByStore.values()]
      .filter((j) => j.status === "error" && /\b403\b/.test(j.error ?? ""))
      .map((j) => j.storeId.replace("store", "S"))
      .sort();
    if (denied.length > 0) {
      const lwaExpired = [...latestJobByStore.values()]
        .filter((j) => /LWA/i.test(j.error ?? "") && /expired/i.test(j.error ?? ""))
        .map((j) => j.storeId.replace("store", "S"))
        .sort();
      dataIssues.push(
        `Amazon SP-API access denied (403) for ${denied.join(", ")} — orders, sales and health for ${denied.length === 1 ? "this store" : "these stores"} are not updating.` +
          (lwaExpired.length
            ? ` ${lwaExpired.join(", ")}: LWA client secret expired — renew it in Developer Central.`
            : "")
      );
    }
    for (const r of ordersByStore) {
      const label = amazonStores.find((s) => s.storeIndex === r.storeIndex)?.name ?? `S${r.storeIndex}`;
      if (r.lastOrderAt && now.getTime() - new Date(r.lastOrderAt).getTime() > 3 * 86400000) {
        dataIssues.push(`${label}: no new orders since ${fmtDay(new Date(r.lastOrderAt))}.`);
      }
    }
    const healthStale =
      !latestSnapshot || now.getTime() - latestSnapshot.createdAt.getTime() > STALE_MS;
    if (healthStale) {
      dataIssues.push(
        `Account Health: no fresh report${latestSnapshot ? ` since ${fmtDay(latestSnapshot.createdAt)}` : ""}.`
      );
    }
    const inboxStale =
      !lastAmazonMessage || now.getTime() - lastAmazonMessage.createdAt.getTime() > 7 * 86400000;
    if (inboxStale) {
      dataIssues.push(
        `Customer Hub: no Amazon buyer message ingested${lastAmazonMessage ? ` since ${fmtDay(lastAmazonMessage.createdAt)}` : ""}.`
      );
    }

    // Procurement (Veeqo) is unfiltered — the API doesn't expose a per-store
    // dimension that maps to our Store table cleanly. Surface it as-is.
    let procurementOrdersToBuy = 0;
    let procurementError: string | null = null;
    try {
      const cards = await fetchProcurementCards();
      const distinctOrders = new Set<string>();
      for (const c of cards) distinctOrders.add(c.orderId);
      procurementOrdersToBuy = distinctOrders.size;
    } catch (err) {
      console.error("[dashboard/summary] procurement count failed:", err);
      if (isVeeqoAuthError(err)) procurementError = VEEQO_KEY_REJECTED_MESSAGE;
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
      ordersByStore,
      customerHub: {
        lastAmazonMessageAt: lastAmazonMessage?.createdAt.toISOString() ?? null,
        stale: inboxStale,
      },
      health: {
        issues: healthIssues,
        lastSnapshotAt: latestSnapshot?.createdAt.toISOString() ?? null,
        stale: healthStale,
      },
      procurement: { ordersToBuy: procurementOrdersToBuy, error: procurementError },
      frozen: {
        incidents30d: frozenIncidents30d,
        riskElevated: frozenRiskElevated,
        riskLow: frozenRiskLow,
      },
      dataIssues,
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
    ordersByStore: [],
    customerHub: { lastAmazonMessageAt: null, stale: false },
    health: { issues: 0, lastSnapshotAt: null, stale: false },
    procurement: { ordersToBuy: 0 },
    frozen: { incidents30d: 0, riskElevated: 0, riskLow: 0 },
    dataIssues: [],
    adjustments: { monthlyTotal: 0, unreviewed: 0 },
    walmart: null,
    syncedAt: new Date().toISOString(),
  };
}
