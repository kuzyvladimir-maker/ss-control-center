/**
 * Amazon Growth — listing content snapshots (experiment engine, Phase 0).
 *
 * Versions a listing's content (title/bullets/description/images/price) + the
 * funnel at that moment into AmazonListingSnapshot. A new row is written only when
 * the content hash changes, so the table is a clean change-over-time history —
 * the baseline for diff-in-diff and the source for recovering lost winners.
 *
 * Scope: our own brands only (Salutem Vita + Starfit), incl. gift sets.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, flattenListing } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";

const OWN_BRANDS = [/salutem\s*vita/i, /starfit/i];

export function isOwnBrand(brand: string | null | undefined, title: string | null | undefined): boolean {
  const hay = `${brand ?? ""} ${title ?? ""}`;
  return OWN_BRANDS.some((re) => re.test(hay));
}

function contentHash(parts: (string | number | null | undefined)[]): string {
  return createHash("sha1").update(parts.map((p) => String(p ?? "")).join("")).digest("hex");
}

export interface SnapshotResult { written: boolean; reason: string; brand?: string; hash?: string }

/** Snapshot ONE listing if its content changed since the last snapshot.
 *  source: "cron" | "pre-change" | "manual" | "backfill". */
export async function snapshotListing(
  prisma: PrismaClient,
  storeIndex: number,
  sku: string,
  opts: { sellerId?: string; source?: string; ownBrandOnly?: boolean } = {},
): Promise<SnapshotResult> {
  const sellerId = opts.sellerId ?? (await getMerchantToken(storeIndex));
  const listing = await getListing(storeIndex, sellerId, sku);
  const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
  const flat = flattenListing(listing);
  const brand = flat.brand;

  if (opts.ownBrandOnly !== false && !isOwnBrand(brand, flat.title)) {
    return { written: false, reason: "not own brand", brand };
  }

  const attrs = (listing.attributes ?? {}) as Record<string, unknown>;
  const imageCount =
    (flat.main_image_url ? 1 : 0) +
    Object.keys(attrs).filter((k) => /^other_product_image_locator/.test(k)).length;
  const hash = contentHash([flat.title, flat.bullets.join("|"), flat.description, flat.main_image_url, imageCount]);

  // Skip if identical to the most recent snapshot for this sku.
  const last = await prisma.amazonListingSnapshot.findFirst({
    where: { storeIndex, sku },
    orderBy: { capturedAt: "desc" },
    select: { contentHash: true },
  });
  if (last?.contentHash === hash) return { written: false, reason: "unchanged", brand, hash };

  const item = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
    select: { sessions30d: true, unitSessionPct: true, revenue30d: true, healthScore: true },
  });

  await prisma.amazonListingSnapshot.create({
    data: {
      storeIndex, sku, asin: flat.asin || summary?.asin || null,
      source: opts.source ?? "cron",
      brand: brand || null, productType: summary?.productType ?? null,
      title: flat.title || null, bulletsJson: JSON.stringify(flat.bullets), description: flat.description || null,
      mainImageUrl: flat.main_image_url, imageCount,
      price: null, // TODO: pull from offers/purchasable_offer in a later phase
      attributesJson: JSON.stringify(attrs),
      contentHash: hash,
      sessions30d: item?.sessions30d ?? null, unitSessionPct: item?.unitSessionPct ?? null,
      revenue30d: item?.revenue30d ?? null, healthScore: item?.healthScore ?? null,
    },
  });
  return { written: true, reason: last ? "content changed" : "first snapshot", brand, hash };
}

export interface SnapshotSweepResult { candidates: number; written: number; unchanged: number; skipped: number; errors: number }

/** Snapshot all own-brand listings for a store (cron). Cheap candidate filter by
 *  itemName first (avoids N getListing calls for the whole catalog), then snapshot. */
export async function snapshotOwnBrand(
  prisma: PrismaClient,
  storeIndex: number,
  opts: { max?: number; betweenMs?: number } = {},
): Promise<SnapshotSweepResult> {
  const max = opts.max ?? 400;
  const betweenMs = opts.betweenMs ?? 250;
  const sellerId = await getMerchantToken(storeIndex);

  // Candidate filter: itemName mentions our brand (gift sets included).
  const candidates = await prisma.amazonListingHealthItem.findMany({
    where: { storeIndex, OR: [{ itemName: { contains: "Salutem Vita" } }, { itemName: { contains: "Starfit" } }] },
    select: { sku: true },
    take: max,
  });

  const res: SnapshotSweepResult = { candidates: candidates.length, written: 0, unchanged: 0, skipped: 0, errors: 0 };
  for (const c of candidates) {
    try {
      const r = await snapshotListing(prisma, storeIndex, c.sku, { sellerId, source: "cron" });
      if (r.written) res.written++;
      else if (r.reason === "unchanged") res.unchanged++;
      else res.skipped++;
    } catch {
      res.errors++;
    }
    await new Promise((r) => setTimeout(r, betweenMs));
  }
  return res;
}
