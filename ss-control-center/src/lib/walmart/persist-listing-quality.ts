/**
 * Persist Walmart Listing Quality — seller snapshot + per-item worklist.
 *
 * Called by the nightly /api/cron/walmart sub-job and the manual sync route.
 *
 *   1. fetch seller score → one history row (WalmartListingQualitySnapshot)
 *   2. page the per-item feed → upsert WalmartListingQualityItem on (store, sku)
 *   3. prune rows not seen this pass (item left the feed) — only AFTER a
 *      successful full sweep, so a mid-sweep failure never deletes data.
 *
 * Same safe-degradation contract as catalog-cache.ts.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { WalmartClient } from "./client";
import {
  fetchSellerListingQuality,
  iterateListingQualityItems,
  type LqItem,
} from "./listing-quality";

export interface ListingQualitySyncResult {
  storeIndex: number;
  sellerScore: number;
  itemsUpserted: number;
  itemsPruned: number;
  totalItems: number;
  pages: number;
  durationMs: number;
}

export async function syncListingQuality(
  prisma: PrismaClient,
  client: WalmartClient,
  storeIndex: number
): Promise<ListingQualitySyncResult> {
  const startedAt = Date.now();
  const passStart = new Date();

  // 1. Seller-level headline + components → history row.
  const seller = await fetchSellerListingQuality(client);
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

  // 2. Per-item feed → upsert each row.
  let itemsUpserted = 0;
  let totalItems = 0;
  let pages = 0;
  const iterator = iterateListingQualityItems(client);
  let next = await iterator.next();
  while (!next.done) {
    const item = next.value as LqItem;
    if (item.sku) {
      await upsertItem(prisma, storeIndex, item, passStart);
      itemsUpserted++;
    }
    next = await iterator.next();
  }
  if (next.value) {
    totalItems = next.value.totalItems;
    pages = next.value.pages;
  }

  // 3. Prune rows untouched this pass (only after a complete sweep).
  const pruned = await prisma.walmartListingQualityItem.deleteMany({
    where: { storeIndex, syncedAt: { lt: passStart } },
  });

  return {
    storeIndex,
    sellerScore: seller.listingQuality,
    itemsUpserted,
    itemsPruned: pruned.count,
    totalItems,
    pages,
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
