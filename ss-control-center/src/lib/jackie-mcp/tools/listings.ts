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

const listingsUpdate: JackieTool = {
  name: "listings_update",
  description:
    "PATCH a listing's attributes (title, bullets, description, price, image). Server runs Amazon VALIDATION_PREVIEW first. Set dry_run=true to see the payload without submitting. Amazon-only for now — Walmart updates are out of scope until Phase 3.1.",
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
        },
      },
      product_type: { type: "string", default: "PRODUCT" },
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
    const product_type = optionalString(args, "product_type") ?? "PRODUCT";
    const dry_run = args.dry_run === true;
    const patches = (args.patches ?? {}) as Record<string, unknown>;

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
    if (jsonPatches.length === 0) {
      throw new Error("patches must contain at least one of: title, bullets, description, main_image_url");
    }

    if (dry_run) {
      return { dry_run: true, would_patch: { product_type, patches: jsonPatches } };
    }

    const storeIndex = amazonChannelToStoreIndex(channel);
    const sellerId = await getMerchantToken(storeIndex);
    // VALIDATION_PREVIEW first.
    const preview = await patchListing(storeIndex, sellerId, sku, product_type, jsonPatches, {
      validationPreview: true,
    });
    if (preview?.status === "INVALID") {
      return { ok: false, stage: "validation_preview", issues: preview.issues ?? [] };
    }
    const real = await patchListing(storeIndex, sellerId, sku, product_type, jsonPatches);
    return {
      ok: real?.status === "ACCEPTED" || real?.status === "IN_PROGRESS",
      stage: "submitted",
      submission_id: real?.submissionId ?? null,
      amazon_status: real?.status ?? null,
      issues: real?.issues ?? [],
    };
  },
};

export const tools: JackieTool[] = [listingsSearch, listingsGet, listingsUpdate];
