/**
 * Ask Walmart whether a product ID is free BEFORE spending ninety minutes on it.
 *
 * Our pool is not exclusively ours. Sampling the next twenty-five numbers in
 * line on 2026-08-05 found SIX already carrying other companies' products —
 * `756441906035` is an Ice Breakers mints pack, `756441906097` is Extra
 * chewing gum. That is 24%, and it is why listings were failing with
 * `ERR_EXT_DATA_0101119`: the error meant exactly what it said.
 *
 * Discovering that costs a feed submission and 60–90 minutes of Walmart
 * processing. Discovering it here costs one GET. At ten listings an hour, the
 * difference is whether roughly a quarter of a batch quietly parks itself.
 *
 * This also changes what rotation means. Rotating blindly is guesswork and
 * burns the pool; rotating to a number we have just CONFIRMED is free is a
 * repair, and can safely repeat until it finds one.
 */

import { getWalmartClient } from "@/lib/walmart/client";
import { prisma } from "@/lib/prisma";

/** How many numbers to try before giving up and asking for a human. */
export const MAX_UPC_SEARCH_ATTEMPTS = 12;

export interface UpcAvailability {
  upc: string;
  taken: boolean;
  /** The Walmart item already using it, when there is one. */
  existingItemId: string | null;
  /** Null when Walmart could not be asked; the caller must not guess. */
  checked: boolean;
}

interface WalmartCatalogSearch {
  items?: Array<{ itemId?: string }>;
}

/**
 * Is this product ID already in Walmart's catalog?
 *
 * `checked: false` means the question could not be answered — a network
 * failure is not evidence the number is free, and the caller must treat it as
 * unknown rather than proceed as if it had passed.
 */
export async function checkUpcAvailability(
  upc: string,
  storeIndex = 1,
): Promise<UpcAvailability> {
  const gtin = upc.length === 13 ? upc : `0${upc}`;
  try {
    const res = await getWalmartClient(storeIndex).requestRaw(
      "GET",
      "/items/walmart/search",
      { params: { gtin } },
    );
    if (res.status !== 200) {
      return { upc, taken: false, existingItemId: null, checked: false };
    }
    const body = res.body as WalmartCatalogSearch;
    const existing = body.items?.[0]?.itemId ?? null;
    return {
      upc,
      taken: Boolean(existing),
      existingItemId: existing,
      checked: true,
    };
  } catch {
    return { upc, taken: false, existingItemId: null, checked: false };
  }
}

export interface FreeUpcResult {
  upc: string;
  rotations: number;
  /** Numbers found to be taken and therefore quarantined on the way. */
  quarantined: Array<{ upc: string; existingItemId: string | null }>;
}

export class NoFreeUpcAvailable extends Error {}

/**
 * Make sure this listing holds a product ID Walmart will actually accept.
 *
 * Returns immediately when the current number is confirmed free. Otherwise it
 * quarantines the taken number — with the item that owns it, so the note says
 * something true — and takes the next from the pool, until it finds a free one
 * or runs out of patience.
 */
export async function ensureFreeWalmartUpc(input: {
  channelSkuId: string;
  storeIndex?: number;
  maxAttempts?: number;
}): Promise<FreeUpcResult> {
  const maxAttempts = input.maxAttempts ?? MAX_UPC_SEARCH_ATTEMPTS;
  const quarantined: FreeUpcResult["quarantined"] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const sku = await prisma.channelSKU.findUnique({
      where: { id: input.channelSkuId },
      select: { id: true, sku: true, upc: true, upc_pool_id: true, live_url: true },
    });
    if (!sku) throw new NoFreeUpcAvailable(`ChannelSKU ${input.channelSkuId} not found`);
    // A live listing is addressed by its number on Walmart's side; changing
    // ours would orphan theirs.
    if (sku.live_url) {
      return { upc: sku.upc, rotations: quarantined.length, quarantined };
    }

    const availability = await checkUpcAvailability(sku.upc, input.storeIndex);
    if (!availability.checked) {
      // Unknown is not free. Publishing anyway is what produced the 90-minute
      // failures this function exists to prevent.
      throw new NoFreeUpcAvailable(
        `Walmart could not be asked whether ${sku.upc} is free; not publishing on an unverified product ID.`,
      );
    }
    if (!availability.taken) {
      return { upc: sku.upc, rotations: quarantined.length, quarantined };
    }

    // Taken by someone else's product. Retire it with the reason, and release
    // its hold on this SKU — `assigned_to_id` is unique, so the replacement
    // cannot be attached while the dead number still claims the listing.
    if (sku.upc_pool_id) {
      const pool = await prisma.uPCPool.findUnique({
        where: { id: sku.upc_pool_id },
        select: { notes: true },
      });
      const note = `${new Date().toISOString()} UPC_TAKEN_IN_WALMART_CATALOG: `
        + `SKU ${sku.sku} — item ${availability.existingItemId ?? "unknown"} already uses this product ID`;
      await prisma.uPCPool.update({
        where: { id: sku.upc_pool_id },
        data: {
          status: "QUARANTINED",
          assigned_to_id: null,
          notes: pool?.notes ? `${pool.notes}\n${note}` : note,
        },
      });
    }
    quarantined.push({
      upc: sku.upc,
      existingItemId: availability.existingItemId,
    });

    const replacement = await prisma.uPCPool.findFirst({
      where: { status: "AVAILABLE", assigned_to_id: null },
      orderBy: { acquired_at: "asc" },
      select: { id: true, upc: true },
    });
    if (!replacement) {
      throw new NoFreeUpcAvailable("The UPC pool has no available numbers left.");
    }
    await prisma.$transaction([
      prisma.uPCPool.update({
        where: { id: replacement.id },
        data: { status: "ASSIGNED", assigned_to_id: sku.id },
      }),
      prisma.channelSKU.update({
        where: { id: sku.id },
        data: { upc: replacement.upc, upc_pool_id: replacement.id },
      }),
    ]);
  }

  throw new NoFreeUpcAvailable(
    `Tried ${maxAttempts} product IDs and every one was already in Walmart's catalog. `
    + "The pool block is contaminated; this needs numbers we actually own.",
  );
}
