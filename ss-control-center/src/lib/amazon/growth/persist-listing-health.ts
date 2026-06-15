/**
 * Persist Amazon Listing Health — per-SKU worklist + seller snapshot.
 *
 * Resumable sweep over the Listings Items feed (5 req/s, ~100 pages of 20 for
 * our ~2000 listings → fits one cron run, but we keep the cursor pattern for
 * safety + parity with Walmart). Each page is scored (listing-health.ts) and
 * upserted. When the page cursor exhausts the sweep is COMPLETE: we compute the
 * seller-level snapshot from the freshly-synced items, prune items not seen
 * this sweep, and reset state.
 *
 * Same safe-degradation contract as Walmart: a mid-sweep failure never prunes
 * and never writes a snapshot (prune + snapshot only on clean completion).
 *
 * Phase A owns the buyability / issues / compliance components; the conversion /
 * buyBox / content columns are enriched by the report cron (Phase B), so the
 * UPDATE path here deliberately does NOT touch those columns — re-sweeping must
 * not wipe report enrichment.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";
import { scoreListing, type ScoredListing } from "./listing-health";
import { measureChanges } from "./change-log";

/** ~5 req/s ceiling per SP-API Listings docs → 220ms between calls. */
const PACING_MS = 230;
const DEFAULT_BUDGET_MS = 240_000;
const PAGE_SIZE = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ListingHealthSyncResult {
  storeIndex: number;
  sweepComplete: boolean;
  sweepStartedFresh: boolean;
  pagesThisRun: number;
  itemsThisRun: number;
  pagesThisSweep: number;
  itemsThisSweep: number;
  itemsPruned: number;
  sellerHealthScore: number | null;
  stoppedReason: "complete" | "budget" | "maxPages" | "rateLimited" | "error";
  durationMs: number;
}

export async function syncListingHealth(
  prisma: PrismaClient,
  storeIndex: number,
  opts: { budgetMs?: number; maxPages?: number; pacingMs?: number } = {},
): Promise<ListingHealthSyncResult> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxPages = opts.maxPages ?? 250;
  const pacingMs = opts.pacingMs ?? PACING_MS;

  const sellerId = await getMerchantToken(storeIndex);

  // Load (or seed) sweep state.
  let state = await prisma.amazonHealthSyncState.findUnique({ where: { storeIndex } });
  let sweepStartedFresh = false;

  if (!state || !state.cursor || !state.sweepStartedAt) {
    sweepStartedFresh = true;
    state = await prisma.amazonHealthSyncState.upsert({
      where: { storeIndex },
      create: { storeIndex, cursor: null, sweepStartedAt: new Date(), pagesThisSweep: 0, itemsThisSweep: 0 },
      update: { cursor: null, sweepStartedAt: new Date(), pagesThisSweep: 0, itemsThisSweep: 0 },
    });
  }

  const sweepStartedAt = state.sweepStartedAt!;
  let cursor: string | null = state.cursor ?? null;
  let pagesThisSweep = state.pagesThisSweep;
  let itemsThisSweep = state.itemsThisSweep;
  let pagesThisRun = 0;
  let itemsThisRun = 0;
  let stoppedReason: ListingHealthSyncResult["stoppedReason"] = "complete";
  let sweepComplete = false;

  try {
    for (let firstOfRun = true; ; firstOfRun = false) {
      if (pagesThisRun >= maxPages) { stoppedReason = "maxPages"; break; }
      if (Date.now() - startedAt > budgetMs) { stoppedReason = "budget"; break; }
      if (!firstOfRun) await sleep(pacingMs);

      let page;
      try {
        page = await listSkus(storeIndex, sellerId, {
          pageSize: PAGE_SIZE,
          pageToken: cursor ?? undefined,
          includedData: ["summaries", "issues"],
        });
      } catch (err) {
        if ((err as { status?: number }).status === 429) { stoppedReason = "rateLimited"; break; }
        throw err;
      }

      const now = new Date();
      for (const raw of page.items) {
        const scored = scoreListing(raw as unknown as Record<string, unknown>);
        if (!scored.sku) continue;
        await upsertItem(prisma, storeIndex, scored, now);
        itemsThisSweep++;
        itemsThisRun++;
      }
      pagesThisSweep++;
      pagesThisRun++;
      cursor = page.pagination?.nextToken ?? null;

      await prisma.amazonHealthSyncState.update({
        where: { storeIndex },
        data: { cursor, pagesThisSweep, itemsThisSweep },
      });

      if (!cursor) { sweepComplete = true; stoppedReason = "complete"; break; }
    }
  } catch (err) {
    stoppedReason = "error";
    await prisma.amazonHealthSyncState
      .update({ where: { storeIndex }, data: { cursor, pagesThisSweep, itemsThisSweep } })
      .catch(() => {});
    throw err;
  }

  // Sweep complete → snapshot + prune + reset.
  let itemsPruned = 0;
  let sellerHealthScore: number | null = null;
  if (sweepComplete) {
    sellerHealthScore = await writeSnapshot(prisma, storeIndex);
    // Prune items the sweep didn't see — EXCEPT FYP-surfaced suppressed rows,
    // which may live beyond the Listings API ~1000-item enumeration. FYP clears
    // isSuppressed itself when a listing is no longer suppressed, after which a
    // later sweep can prune it normally.
    const pruned = await prisma.amazonListingHealthItem.deleteMany({
      where: { storeIndex, syncedAt: { lt: sweepStartedAt }, isSuppressed: false },
    });
    itemsPruned = pruned.count;
    await prisma.amazonHealthSyncState.update({
      where: { storeIndex },
      data: { cursor: null, sweepStartedAt: null, lastFullSweepAt: new Date() },
    });
    await measureRemediations(prisma, storeIndex, sweepStartedAt);
    await measureChanges(prisma, storeIndex, sweepStartedAt);
  }

  return {
    storeIndex,
    sweepComplete,
    sweepStartedFresh,
    pagesThisRun,
    itemsThisRun,
    pagesThisSweep,
    itemsThisSweep,
    itemsPruned,
    sellerHealthScore,
    stoppedReason,
    durationMs: Date.now() - startedAt,
  };
}

async function upsertItem(
  prisma: PrismaClient,
  storeIndex: number,
  s: ScoredListing,
  syncedAt: Date,
): Promise<void> {
  // Fields the sweep owns. Report-enriched columns (content/buyBox/conversion +
  // suppressionReason) are intentionally absent from `update` so re-sweeps keep
  // them. They're set to defaults only on first `create`.
  const swept = {
    asin: s.asin,
    productType: s.productType,
    itemName: s.itemName,
    conditionType: s.conditionType,
    mainImageUrl: s.mainImageUrl,
    healthScore: s.healthScore,
    topFixComponent: s.topFixComponent,
    opportunityScore: s.opportunityScore,
    buyabilityScore: s.components.buyability,
    issuesScore: s.components.issues,
    complianceScore: s.components.compliance,
    isBuyable: s.isBuyable,
    isDiscoverable: s.isDiscoverable,
    isSuppressed: s.isSuppressed,
    errorIssueCount: s.errorIssueCount,
    warningIssueCount: s.warningIssueCount,
    issuesSummary: JSON.stringify(s.issues),
    lastUpdatedAt: parseDate(s.lastUpdatedAt),
    syncedAt,
  };

  await prisma.amazonListingHealthItem.upsert({
    where: { amazon_health_item_dedup: { storeIndex, sku: s.sku } },
    create: { storeIndex, sku: s.sku, ...swept },
    update: swept,
  });
}

/** Seller-level snapshot = catalog-wide averages over the freshly-synced items. */
async function writeSnapshot(prisma: PrismaClient, storeIndex: number): Promise<number> {
  const where = { storeIndex };
  const [agg, total, suppressed] = await Promise.all([
    prisma.amazonListingHealthItem.aggregate({
      where,
      _avg: {
        healthScore: true,
        buyabilityScore: true,
        issuesScore: true,
        contentScore: true,
        complianceScore: true,
        buyBoxScore: true,
        conversionScore: true,
      },
      _sum: { errorIssueCount: true, warningIssueCount: true },
    }),
    prisma.amazonListingHealthItem.count({ where }),
    prisma.amazonListingHealthItem.count({ where: { ...where, isSuppressed: true } }),
  ]);

  const round = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  const healthScore = round(agg._avg.healthScore) ?? 0;

  await prisma.amazonListingHealthSnapshot.create({
    data: {
      storeIndex,
      healthScore,
      buyabilityScore: round(agg._avg.buyabilityScore),
      issuesScore: round(agg._avg.issuesScore),
      contentScore: round(agg._avg.contentScore),
      complianceScore: round(agg._avg.complianceScore),
      buyBoxScore: round(agg._avg.buyBoxScore),
      conversionScore: round(agg._avg.conversionScore),
      totalListings: total,
      suppressedCount: suppressed,
      errorIssueCount: agg._sum.errorIssueCount ?? 0,
      warningIssueCount: agg._sum.warningIssueCount ?? 0,
    },
  });

  return healthScore;
}

/**
 * Fill AFTER-metrics for Optimizer remediations applied before this sweep
 * started — the listing was just re-read, so its current score IS the "after".
 * This is what charts the lift in the Optimizer's Impact section.
 */
async function measureRemediations(
  prisma: PrismaClient,
  storeIndex: number,
  sweepStartedAt: Date,
): Promise<void> {
  const pending = await prisma.amazonListingRemediation.findMany({
    where: { storeIndex, ok: true, afterMeasuredAt: null, runAt: { lt: sweepStartedAt } },
  });
  for (const rem of pending) {
    const item = await prisma.amazonListingHealthItem.findUnique({
      where: { amazon_health_item_dedup: { storeIndex, sku: rem.sku } },
    });
    if (!item) continue;
    await prisma.amazonListingRemediation.update({
      where: { id: rem.id },
      data: {
        afterMeasuredAt: new Date(),
        afterHealthScore: item.healthScore,
        afterErrorCount: item.errorIssueCount,
        afterComplianceScore: item.complianceScore,
      },
    });
  }
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
