/**
 * SKU adjustment profile aggregator.
 *
 * Rebuilds SkuAdjustmentProfile rows from the underlying ShippingAdjustment
 * data. Called by every sync endpoint (scan / settlement-sync /
 * walmart/sync) after they bulk-insert so the SKU Issues panel reflects
 * current data without manual intervention.
 *
 * Originally this logic lived inline inside POST /api/adjustments (manual
 * single-row create). The sync routes never called it, so the panel
 * always read 0 rows even when the underlying adjustments table had
 * hundreds. Extracting + invoking from every entry-point fixes that.
 */

import { prisma } from "@/lib/prisma";

const NEEDS_UPDATE_THRESHOLD = 3; // 3+ adjustments → flag for SKU-DB review

export async function rebuildSkuProfile(sku: string): Promise<void> {
  const adjustments = await prisma.shippingAdjustment.findMany({
    where: { sku },
  });
  if (adjustments.length === 0) return;

  const totalAmount = adjustments.reduce(
    (s, a) => s + a.adjustmentAmount,
    0
  );
  const avgAmount = totalAmount / adjustments.length;

  const typeCounts: Record<string, number> = {};
  for (const a of adjustments) {
    typeCounts[a.adjustmentType] = (typeCounts[a.adjustmentType] || 0) + 1;
  }
  const mostCommonType =
    Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const adjustedWeights = adjustments
    .map((a) => a.adjustedWeightLbs)
    .filter((w): w is number => w !== null);
  const suggestedWeight =
    adjustedWeights.length > 0
      ? adjustedWeights.reduce((s, w) => s + w, 0) / adjustedWeights.length
      : null;

  const channelCounts: Record<string, number> = {};
  for (const a of adjustments) {
    channelCounts[a.channel] = (channelCounts[a.channel] || 0) + 1;
  }
  const channel =
    Object.entries(channelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const last = adjustments.sort((a, b) =>
    b.adjustmentDate.localeCompare(a.adjustmentDate)
  )[0];

  const productName = adjustments.find((a) => a.productName)?.productName;

  await prisma.skuAdjustmentProfile.upsert({
    where: { sku },
    create: {
      sku,
      productName,
      totalAdjustments: adjustments.length,
      totalAmountLost: totalAmount,
      avgAdjustmentAmount: avgAmount,
      mostCommonType,
      needsSkuDbUpdate: adjustments.length >= NEEDS_UPDATE_THRESHOLD,
      suggestedWeight,
      lastAdjustmentDate: last?.adjustmentDate,
      channel,
    },
    update: {
      productName: productName || undefined,
      totalAdjustments: adjustments.length,
      totalAmountLost: totalAmount,
      avgAdjustmentAmount: avgAmount,
      mostCommonType,
      needsSkuDbUpdate: adjustments.length >= NEEDS_UPDATE_THRESHOLD,
      suggestedWeight,
      lastAdjustmentDate: last?.adjustmentDate,
      channel,
    },
  });
}

/**
 * Rebuild profiles for every SKU touched by the given adjustment-row
 * SKUs (deduplicated). Call after bulk inserts in sync routes.
 */
export async function rebuildSkuProfilesFor(
  skus: Array<string | null | undefined>
): Promise<{ profilesUpdated: number }> {
  const unique = [...new Set(skus.filter((s): s is string => Boolean(s)))];
  for (const sku of unique) {
    try {
      await rebuildSkuProfile(sku);
    } catch (err) {
      console.warn(
        `[sku-profiles] failed for ${sku}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  return { profilesUpdated: unique.length };
}

/** Full rebuild — used by Phase F backfill + any future "rebuild all" CLI. */
export async function rebuildAllSkuProfiles(): Promise<{
  profilesUpdated: number;
}> {
  const rows = await prisma.shippingAdjustment.findMany({
    where: { sku: { not: null } },
    select: { sku: true },
    distinct: ["sku"],
  });
  return rebuildSkuProfilesFor(rows.map((r) => r.sku));
}
