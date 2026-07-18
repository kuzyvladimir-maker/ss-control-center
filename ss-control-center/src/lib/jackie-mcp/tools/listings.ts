/**
 * Jackie MCP tools — Listings.
 *
 * Read paths query our ChannelSKU + ListingAuditResult tables (already
 * synced from marketplaces). Write path wraps `patchListing` with the
 * existing dry-run / VALIDATION_PREVIEW behaviour from Phase 2.6.2.
 */

import { prisma } from "@/lib/prisma";
import {
  getListing,
  patchListing,
  flattenListing,
} from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import {
  isUncrustablesListingItem,
  mergePurchasableOffer,
} from "@/lib/amazon-sp-api/pricing";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import {
  amazonChannelToStoreIndex,
  channelSkipReason,
  optionalNumber,
  optionalString,
  requireAmazonChannel,
  requireChannel,
  requireString,
} from "../channels";
import type { JackieTool } from "../registry";

const listingsSearch: JackieTool = {
  name: "listings_search",
  description:
    "Search ChannelSKU rows for one channel by SKU/ASIN/title fragment. Returns up to `limit` matches from our internal mirror — fast, no marketplace round-trip.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      query: { type: "string" },
      limit: { type: "number", default: 20 },
    },
    required: ["channel", "query"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireChannel(args);
    const query = requireString(args, "query");
    const limit = optionalNumber(args, "limit") ?? 20;
    const rows = await prisma.channelSKU.findMany({
      where: {
        channel,
        OR: [
          { sku: { contains: query } },
          { asin: { contains: query } },
          { title: { contains: query } },
        ],
      },
      take: Math.min(limit, 100),
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        price_cents: true,
        compliance_status: true,
        validation_status: true,
        listing_status: true,
        live_url: true,
      },
    });
    return { count: rows.length, listings: rows };
  },
};

const listingsGet: JackieTool = {
  name: "listings_get",
  description:
    "Fetch one listing's current title/bullets/description/image. By default reads from our ChannelSKU mirror; pass `fresh=true` to round-trip Amazon for the up-to-date attributes (slower, costs an SP-API call).",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      sku: { type: "string" },
      fresh: { type: "boolean", default: false },
    },
    required: ["channel", "sku"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireChannel(args);
    const sku = requireString(args, "sku");
    const fresh = args.fresh === true;
    if (!fresh) {
      const row = await prisma.channelSKU.findFirst({
        where: { channel, sku },
      });
      if (!row) {
        return { error: "not_found", note: "No ChannelSKU mirror — try fresh=true to query marketplace directly." };
      }
      return { source: "mirror", listing: row };
    }
    if (!channel.startsWith("AMAZON_")) {
      throw new Error("fresh=true only supported for Amazon channels right now.");
    }
    const storeIndex = amazonChannelToStoreIndex(channel);
    const sellerId = await getMerchantToken(storeIndex);
    const raw = await getListing(storeIndex, sellerId, sku);
    return { source: "amazon-live", listing: flattenListing(raw) };
  },
};

/** Accept `39.9` or `{ amount: 39.9, currency: "USD" }`. */
function readPrice(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const amt = (v as { amount?: unknown }).amount;
    if (typeof amt === "number" && Number.isFinite(amt)) return amt;
  }
  return null;
}

const listingsUpdate: JackieTool = {
  name: "listings_update",
  description:
    "PATCH an existing Amazon listing's attributes: title, bullets, description, main image, PRICE (purchasable_offer, merged so the B2B offer and min/max bounds survive) and GALLERY images (other_product_image_locator_1..8). product_type is auto-resolved from the live listing when omitted. Server runs Amazon VALIDATION_PREVIEW first. dry_run=true returns the payload without calling Amazon. Amazon-only for now.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      sku: { type: "string" },
      patches: {
        type: "object",
        properties: {
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          main_image_url: { type: "string" },
          /** Number (39.9) or { amount, currency }. Sets purchasable_offer.our_price. */
          price: { type: ["number", "object"] },
          /** Optional repricer bounds written into the same offer entry. */
          min_price: { type: ["number", "object"] },
          max_price: { type: ["number", "object"] },
          currency: { type: "string", default: "USD" },
          /** Publicly fetchable URLs → other_product_image_locator_{slot..}. */
          other_images: { type: "array", items: { type: "string" }, maxItems: 8 },
          /** First gallery slot to write (1-8). Default 1 — note this OVERWRITES
           *  whatever occupies that slot. */
          gallery_start_slot: { type: "number", default: 1 },
        },
      },
      /** Must equal the listing's real productType (e.g. ICE_CHEST, GROCERY).
       *  Omit to auto-resolve from the live listing summary — recommended. */
      product_type: { type: "string" },
      dry_run: { type: "boolean", default: false },
    },
    required: ["channel", "sku", "patches"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireAmazonChannel(args);
    const skip = channelSkipReason(channel);
    if (skip) return { skipped: true, reason: skip };
    const sku = requireString(args, "sku");
    const dry_run = args.dry_run === true;
    const patches = (args.patches ?? {}) as Record<string, unknown>;

    const price = readPrice(patches.price);
    const minPrice = readPrice(patches.min_price);
    const maxPrice = readPrice(patches.max_price);
    const currency = optionalString(patches, "currency");
    const otherImages = Array.isArray(patches.other_images)
      ? (patches.other_images as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0)
      : [];
    const startSlot = typeof patches.gallery_start_slot === "number" ? patches.gallery_start_slot : 1;

    const needsLiveRead = price != null || minPrice != null || maxPrice != null || !optionalString(args, "product_type");
    const storeIndex = amazonChannelToStoreIndex(channel);

    // `productType` must match what Amazon already has (a wrong one is rejected
    // with 4000004). Read it from the listing rather than guessing "PRODUCT".
    let product_type = optionalString(args, "product_type") ?? "";
    let liveOffer: unknown = undefined;
    if (needsLiveRead) {
      const sellerId = await getMerchantToken(storeIndex);
      const live = await getListing(storeIndex, sellerId, sku);
      if (
        (price != null || minPrice != null || maxPrice != null) &&
        isUncrustablesListingItem(live)
      ) {
        throw new Error(
          "Uncrustables offer prices are policy-locked; use the sealed surgical repair for canonical corrections and Amazon Coupons for promotions",
        );
      }
      product_type = product_type || live.summaries?.[0]?.productType || "PRODUCT";
      liveOffer = live.attributes?.purchasable_offer;
    }

    const lt = (value: string) => ({
      value,
      language_tag: "en_US",
      marketplace_id: MARKETPLACE_ID,
    });
    const jsonPatches: Array<{ op: "replace"; path: string; value: unknown }> = [];
    if (typeof patches.title === "string") {
      jsonPatches.push({ op: "replace", path: "/attributes/item_name", value: [lt(patches.title)] });
    }
    if (Array.isArray(patches.bullets)) {
      jsonPatches.push({
        op: "replace",
        path: "/attributes/bullet_point",
        value: (patches.bullets as string[]).map(lt),
      });
    }
    if (typeof patches.description === "string") {
      jsonPatches.push({
        op: "replace",
        path: "/attributes/product_description",
        value: [lt(patches.description)],
      });
    }
    if (typeof patches.main_image_url === "string") {
      jsonPatches.push({
        op: "replace",
        path: "/attributes/main_product_image_locator",
        value: [{ media_location: patches.main_image_url, language_tag: "en_US", marketplace_id: MARKETPLACE_ID }],
      });
    }
    if (price != null || minPrice != null || maxPrice != null) {
      jsonPatches.push({
        op: "replace",
        path: "/attributes/purchasable_offer",
        value: mergePurchasableOffer(liveOffer, { price, minPrice, maxPrice, currency }),
      });
    }
    if (otherImages.length > 0) {
      if (startSlot < 1 || startSlot + otherImages.length - 1 > 8) {
        throw new Error(
          `gallery slots out of range: ${otherImages.length} image(s) from slot ${startSlot} would exceed other_product_image_locator_8`,
        );
      }
      // One attribute per slot → one patch op per slot.
      otherImages.forEach((url, i) => {
        jsonPatches.push({
          op: "replace",
          path: `/attributes/other_product_image_locator_${startSlot + i}`,
          value: [{ media_location: url, language_tag: "en_US", marketplace_id: MARKETPLACE_ID }],
        });
      });
    }
    if (jsonPatches.length === 0) {
      throw new Error(
        "patches must contain at least one of: title, bullets, description, main_image_url, price, min_price, max_price, other_images",
      );
    }

    if (dry_run) {
      return { dry_run: true, product_type, would_patch: { product_type, patches: jsonPatches } };
    }

    const sellerId = await getMerchantToken(storeIndex);
    // VALIDATION_PREVIEW first.
    const preview = await patchListing(storeIndex, sellerId, sku, product_type, jsonPatches, {
      validationPreview: true,
    });
    if (preview?.status === "INVALID") {
      return { ok: false, stage: "validation_preview", product_type, issues: preview.issues ?? [] };
    }
    const real = await patchListing(storeIndex, sellerId, sku, product_type, jsonPatches);
    return {
      ok: real?.status === "ACCEPTED" || real?.status === "IN_PROGRESS",
      stage: "submitted",
      product_type,
      submission_id: real?.submissionId ?? null,
      amazon_status: real?.status ?? null,
      issues: real?.issues ?? [],
    };
  },
};

export const tools: JackieTool[] = [listingsSearch, listingsGet, listingsUpdate];
