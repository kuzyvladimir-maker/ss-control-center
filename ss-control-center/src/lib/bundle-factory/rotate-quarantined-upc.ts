/**
 * Give a listing a fresh UPC after its own was quarantined.
 *
 * Walmart rejects a submission with `ERR_EXT_DATA_0101119` when the product ID
 * already exists in its catalog under different details. The poller quarantines
 * that pool UPC, which is right — it can never be used again. But a UPC is only
 * assigned when the ChannelSKU is CREATED, so an existing listing kept pointing
 * at the dead number and could never be published, no matter how many times it
 * was retried.
 *
 * That is not a rare edge: 2,996 of the pool's UPCs are already quarantined, so
 * collisions are ordinary and a factory that stalls on each one does not scale.
 *
 * What this refuses to do, and why:
 *   · never rotate a listing that reached the marketplace. A live item is
 *     addressed by its UPC; changing ours would orphan theirs.
 *   · never rotate a UPC that is not actually quarantined — if the number is
 *     still good, the failure was something else and swapping it hides that.
 */

import { prisma } from "@/lib/prisma";

export interface UpcRotation {
  channel_sku_id: string;
  sku: string;
  previous_upc: string;
  new_upc: string;
}

export class UpcRotationRefused extends Error {}

/**
 * Swap a quarantined UPC for a fresh one from the pool.
 *
 * Returns the rotation, or throws {@link UpcRotationRefused} with the reason.
 */
export async function rotateQuarantinedUpc(
  channelSkuId: string,
): Promise<UpcRotation> {
  const sku = await prisma.channelSKU.findUnique({
    where: { id: channelSkuId },
    select: {
      id: true, sku: true, upc: true, upc_pool_id: true,
      listing_status: true, live_url: true,
    },
  });
  if (!sku) throw new UpcRotationRefused(`ChannelSKU ${channelSkuId} not found`);

  // A listing Walmart accepted is identified by this number on their side.
  if (sku.live_url || ["LIVE", "SUBMITTED", "PENDING_REVIEW"].includes(sku.listing_status)) {
    throw new UpcRotationRefused(
      `${sku.sku} is ${sku.listing_status} on the marketplace; its UPC cannot be swapped`,
    );
  }
  const attempts = await prisma.marketplaceSubmissionAttempt.count({
    where: {
      channel_sku_id: sku.id,
      state: { in: ["ACCEPTED", "BUYER_VERIFIED", "PENDING_REVIEW", "UNKNOWN"] },
    },
  });
  if (attempts > 0) {
    throw new UpcRotationRefused(
      `${sku.sku} has a submission the marketplace may have accepted; resolve it by reading before rotating`,
    );
  }

  const current = sku.upc_pool_id
    ? await prisma.uPCPool.findUnique({
      where: { id: sku.upc_pool_id }, select: { id: true, upc: true, status: true },
    })
    : null;
  if (!current) {
    throw new UpcRotationRefused(`${sku.sku} has no pool UPC to rotate`);
  }
  if (current.status !== "QUARANTINED") {
    throw new UpcRotationRefused(
      `${sku.sku} still holds a ${current.status} UPC; rotating would hide the real failure`,
    );
  }

  const replacement = await prisma.uPCPool.findFirst({
    where: { status: "AVAILABLE", assigned_to_id: null, reserved_for_id: null },
    orderBy: { acquired_at: "asc" },
    select: { id: true, upc: true },
  });
  if (!replacement) throw new UpcRotationRefused("UPC pool is exhausted");

  await prisma.$transaction(async (tx) => {
    // Release the dead one from the listing but keep it QUARANTINED forever.
    await tx.uPCPool.update({
      where: { id: current.id },
      data: { assigned_to_id: null },
    });
    const claimed = await tx.uPCPool.updateMany({
      where: { id: replacement.id, status: "AVAILABLE", assigned_to_id: null },
      data: { status: "ASSIGNED", assigned_to_id: sku.id },
    });
    if (claimed.count !== 1) {
      throw new UpcRotationRefused("replacement UPC was taken concurrently");
    }
    await tx.channelSKU.update({
      where: { id: sku.id },
      data: { upc: replacement.upc, upc_pool_id: replacement.id },
    });
  });

  return {
    channel_sku_id: sku.id,
    sku: sku.sku,
    previous_upc: current.upc,
    new_upc: replacement.upc,
  };
}
