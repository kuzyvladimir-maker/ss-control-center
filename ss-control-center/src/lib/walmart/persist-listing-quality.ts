/**
 * Persist Walmart Listing Quality — seller snapshot + per-item worklist.
 *
 * The per-item Insights endpoint has a TINY rate bucket (~1 call / 12-15s
 * sustained; limit caps at 200/page → ~21 pages for our ~4 000 items). A full
 * sweep therefore can't finish inside one cron's 300s budget, so this is a
 * RESUMABLE driver:
 *
 *   - On a fresh sweep (no saved cursor) we write the seller-level snapshot
 *     (history row) and stamp sweepStartedAt.
 *   - Each run pulls pages from the saved cursor, pacing PACING_MS between
 *     calls, upserting items, until budget/maxPages is hit, a 429 stops us, or
 *     the cursor runs out.
 *   - The cursor + counters are persisted after every page (WalmartLqSyncState).
 *   - When the cursor runs out the sweep is COMPLETE: prune items not seen this
 *     sweep (syncedAt < sweepStartedAt), stamp lastFullSweepAt, clear cursor.
 *
 * Same safe-degradation contract as catalog-cache.ts — a mid-sweep failure
 * never prunes (prune only runs on a clean sweep completion).
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { WalmartClient } from "./client";
import {
  fetchSellerListingQuality,
  fetchListingQualityPage,
  type LqItem,
} from "./listing-quality";

/** Pace between page calls. The bucket sustains ~1 call / 12-15s. */
const PACING_MS = 13_000;
/** Default wall-clock budget for one run (stay well under cron maxDuration). */
const DEFAULT_BUDGET_MS = 230_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ListingQualitySyncResult {
  storeIndex: number;
  /** True when this run finished a full sweep (snapshot fresh, prune ran). */
  sweepComplete: boolean;
  sweepStartedFresh: boolean;
  sellerScore: number | null;
  pagesThisRun: number;
  itemsThisRun: number;
  pagesThisSweep: number;
  itemsThisSweep: number;
  itemsPruned: number;
  totalItems: number | null;
  stoppedReason: "complete" | "budget" | "maxPages" | "rateLimited" | "error";
  durationMs: number;
}

export async function syncListingQuality(
  prisma: PrismaClient,
  client: WalmartClient,
  storeIndex: number,
  opts: { budgetMs?: number; maxPages?: number; pacingMs?: number } = {}
): Promise<ListingQualitySyncResult> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxPages = opts.maxPages ?? 25;
  const pacingMs = opts.pacingMs ?? PACING_MS;

  // Load (or seed) sweep state.
  let state = await prisma.walmartLqSyncState.findUnique({ where: { storeIndex } });
  let sweepStartedFresh = false;
  let sellerScore: number | null = null;

  if (!state || !state.cursor || !state.sweepStartedAt) {
    // Fresh sweep — write the seller snapshot up front so the headline
    // refreshes even if the item sweep takes several runs.
    sweepStartedFresh = true;
    const seller = await fetchSellerListingQuality(client);
    sellerScore = seller.listingQuality;
    await prisma.walmartListingQualitySnapshot.create({
      data: {
        storeIndex,
        listingQuality: seller.listingQuality,
        offerScore: seller.offerScore,
        ratingReviewScore: seller.ratingReviewScore,
        contentScore: seller.contentScore,
        priceScore: seller.priceScore,
        shippingScore: seller.shippingScore,
        transactibilityScore: seller.transactibilityScore,
        itemDefectCnt: seller.itemDefectCnt,
        defectRatio: seller.defectRatio,
        rawData: JSON.stringify(seller),
      },
    });
    state = await prisma.walmartLqSyncState.upsert({
      where: { storeIndex },
      create: {
        storeIndex,
        cursor: null,
        sweepStartedAt: new Date(),
        pagesThisSweep: 0,
        itemsThisSweep: 0,
      },
      update: {
        cursor: null,
        sweepStartedAt: new Date(),
        pagesThisSweep: 0,
        itemsThisSweep: 0,
      },
    });
  }

  const sweepStartedAt = state.sweepStartedAt!;
  let cursor: string | null = state.cursor ?? null;
  let pagesThisSweep = state.pagesThisSweep;
  let itemsThisSweep = state.itemsThisSweep;
  let pagesThisRun = 0;
  let itemsThisRun = 0;
  let totalItems: number | null = null;
  let stoppedReason: ListingQualitySyncResult["stoppedReason"] = "complete";
  let sweepComplete = false;

  try {
    // First page of the run goes immediately; subsequent pages are paced.
    for (let firstOfRun = true; ; firstOfRun = false) {
      if (pagesThisRun >= maxPages) {
        stoppedReason = "maxPages";
        break;
      }
      if (Date.now() - startedAt > budgetMs) {
        stoppedReason = "budget";
        break;
      }
      if (!firstOfRun) await sleep(pacingMs);

      let page;
      try {
        page = await fetchListingQualityPage(client, { cursor, pageSize: 200 });
      } catch (err) {
        if ((err as { status?: number }).status === 429) {
          stoppedReason = "rateLimited";
          break;
        }
        throw err;
      }

      totalItems = page.totalItems;
      const now = new Date();
      for (const item of page.items) {
        if (!item.sku) continue;
        await upsertItem(prisma, storeIndex, item, now);
        itemsThisSweep++;
        itemsThisRun++;
      }
      pagesThisSweep++;
      pagesThisRun++;
      cursor = page.nextCursor;

      // Persist progress after each page so a crash resumes cleanly.
      await prisma.walmartLqSyncState.update({
        where: { storeIndex },
        data: { cursor, pagesThisSweep, itemsThisSweep },
      });

      if (!cursor) {
        sweepComplete = true;
        stoppedReason = "complete";
        break;
      }
    }
  } catch (err) {
    stoppedReason = "error";
    // Persist whatever cursor we reached so the next run resumes.
    await prisma.walmartLqSyncState
      .update({ where: { storeIndex }, data: { cursor, pagesThisSweep, itemsThisSweep } })
      .catch(() => {});
    throw err;
  }

  // Sweep complete → prune items not refreshed this sweep, reset state.
  let itemsPruned = 0;
  if (sweepComplete) {
    const pruned = await prisma.walmartListingQualityItem.deleteMany({
      where: { storeIndex, syncedAt: { lt: sweepStartedAt } },
    });
    itemsPruned = pruned.count;
    await prisma.walmartLqSyncState.update({
      where: { storeIndex },
      data: { cursor: null, sweepStartedAt: null, lastFullSweepAt: new Date() },
    });
  }

  return {
    storeIndex,
    sweepComplete,
    sweepStartedFresh,
    sellerScore,
    pagesThisRun,
    itemsThisRun,
    pagesThisSweep,
    itemsThisSweep,
    itemsPruned,
    totalItems,
    stoppedReason,
    durationMs: Date.now() - startedAt,
  };
}

async function upsertItem(
  prisma: PrismaClient,
  storeIndex: number,
  item: LqItem,
  syncedAt: Date
): Promise<void> {
  const data = {
    storeIndex,
    itemId: item.itemId,
    productId: item.productId,
    productName: item.productName,
    productType: item.productType,
    categoryName: item.categoryName,
    condition: item.condition,
    lqScore: item.lqScore,
    priority: item.priority,
    ratingReviewScore: item.components.ratingReview.score,
    shippingScore: item.components.shipping.score,
    publishScore: item.components.publish.score,
    contentScore: item.components.content.score,
    priceScore: item.components.price.score,
    offerScore: item.components.offer.score,
    isInStock: item.isInStock,
    isFastAndFreeShipping: item.isFastAndFreeShipping,
    wfsEnabled: item.wfsEnabled,
    ratingCount: item.ratingCount,
    pageViews30d: item.pageViews30d,
    conversionRate30d: item.conversionRate30d,
    gmv30d: item.gmv30d,
    orders30d: item.orders30d,
    units30d: item.units30d,
    topFixComponent: item.topFixComponent,
    issueCount: item.issues.length,
    issuesSummary: JSON.stringify(item.issues),
    scoredAt: parseScoredAt(item.scoredAt),
    syncedAt,
  };

  await prisma.walmartListingQualityItem.upsert({
    where: { walmart_lq_item_dedup: { storeIndex, sku: item.sku } },
    create: { sku: item.sku, ...data },
    update: data,
  });
}

/** Walmart's updatedTimestamp is "YYYY-MM-DD HH:mm:ss.SSS" (no tz). */
function parseScoredAt(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}
