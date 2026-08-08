/**
 * Refuse to put the same product on Walmart twice.
 *
 * `recipe_fingerprint` stops a duplicate DRAFT from being built, which is not
 * the same protection: two drafts of the same product can be created by two
 * different builds, or one can be rebuilt after an earlier one already went
 * live. Nothing stood between that and two identical live listings.
 *
 * Walmart has a duplicate-listings policy, and at a hundred listings a week the
 * cost of tripping it is the account, not the listing. The identity that
 * matters is the one the factory itself already decided: the exact canonical
 * variant plus how many retail units are in the pack. Same variant, same pack
 * count, already out — that is the same listing.
 *
 * This deliberately does NOT compare titles or images. Two listings can differ
 * in wording and still be the same offer, and a title comparison would both
 * miss those and flag legitimate re-wordings.
 */

import { prisma } from "@/lib/prisma";

import {
  WALMART_STUDIO_LISTING_ATTRIBUTE_KEY,
} from "./walmart-studio-listing";

export interface WalmartListingIdentity {
  canonicalVariantId: string;
  packCount: number;
  /**
   * Every product in the box with its count, sorted, as one string.
   *
   * Identity used to be the FIRST variant plus the pack size. For an assortment
   * that was wrong twice over: two different mixes sharing a first flavor
   * looked like duplicates of each other, and the same mix listed in a
   * different order looked like a new product and slipped past the check
   * (independent review 2026-08-08). Sorting makes order irrelevant, which is
   * what "the same box" actually means.
   */
  compositionKey: string;
}

export interface DuplicateListing {
  sku: string;
  channelSkuId: string;
  listingStatus: string;
  liveUrl: string | null;
}

/** The variant-and-pack identity a studio listing claims, if it declares one. */
export function walmartListingIdentity(
  attributes: string | null | undefined,
): WalmartListingIdentity | null {
  if (!attributes) return null;
  try {
    const parsed = JSON.parse(attributes) as Record<string, unknown>;
    const evidence = parsed[WALMART_STUDIO_LISTING_ATTRIBUTE_KEY];
    if (!evidence || typeof evidence !== "object") return null;
    const record = evidence as {
      identity?: { canonical_variant_id?: unknown };
      listing_scope?: { pack_count?: unknown };
      components?: unknown;
    };
    const canonicalVariantId = record.identity?.canonical_variant_id;
    const packCount = Number(record.listing_scope?.pack_count);
    if (typeof canonicalVariantId !== "string" || !canonicalVariantId.trim()) {
      return null;
    }
    if (!Number.isInteger(packCount) || packCount <= 0) return null;
    const primary = canonicalVariantId.trim();
    const components = Array.isArray(record.components) ? record.components : [];
    const parts = components
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const row = entry as {
          canonical_variant_id?: unknown;
          identity?: { canonical_variant_id?: unknown };
          quantity?: unknown;
        };
        // The full chain nests the variant under `identity`; the first shape
        // this shipped with put it at the top level. Read either.
        const raw = row.identity?.canonical_variant_id ?? row.canonical_variant_id;
        const variant = typeof raw === "string" ? raw.trim() : "";
        const quantity = Number(row.quantity);
        if (!variant || !Number.isInteger(quantity) || quantity <= 0) return null;
        return `${variant}x${quantity}`;
      })
      .filter((entry): entry is string => entry !== null)
      .sort();
    // A listing that records no components is the single-product multipack its
    // primary variant and pack count already describe.
    const compositionKey = parts.length > 0
      ? parts.join("|")
      : `${primary}x${packCount}`;
    return { canonicalVariantId: primary, packCount, compositionKey };
  } catch {
    return null;
  }
}

/**
 * Another Walmart listing for the same variant and pack that has already left,
 * or null when this listing is the first of its kind.
 *
 * "Already left" includes everything past submission, not just LIVE: a second
 * feed for a product whose first feed is still processing is the same duplicate,
 * discovered an hour earlier.
 */
export async function findDuplicateWalmartListing(input: {
  channelSkuId: string;
  attributes: string | null;
}): Promise<DuplicateListing | null> {
  const identity = walmartListingIdentity(input.attributes);
  // A listing that declares no identity cannot be compared. That is the frozen
  // pilot lane, which is governed by its own owner-signed evidence.
  if (!identity) return null;

  const candidates = await prisma.channelSKU.findMany({
    where: {
      channel: "WALMART",
      id: { not: input.channelSkuId },
      OR: [
        { live_url: { not: null } },
        {
          listing_status: {
            in: ["SUBMITTED", "SUBMITTING", "PENDING_REVIEW", "SUBMISSION_UNKNOWN", "LIVE"],
          },
        },
      ],
    },
    select: {
      id: true,
      sku: true,
      attributes: true,
      listing_status: true,
      live_url: true,
    },
  });

  for (const candidate of candidates) {
    const other = walmartListingIdentity(candidate.attributes);
    if (!other) continue;
    if (
      other.packCount === identity.packCount
      && other.compositionKey === identity.compositionKey
    ) {
      return {
        sku: candidate.sku,
        channelSkuId: candidate.id,
        listingStatus: candidate.listing_status,
        liveUrl: candidate.live_url,
      };
    }
  }
  return null;
}
