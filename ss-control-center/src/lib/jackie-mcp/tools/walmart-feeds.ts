/**
 * Jackie MCP tools — Walmart WRITE path for price + listing content.
 *
 *   walmart_update_price — List Price for 1..N SKUs. Single SKU goes through
 *     the synchronous PUT /v3/price; 2+ SKUs go through one bulk Price feed
 *     (POST /v3/feeds?feedType=price) and return a feedId to poll.
 *
 *   walmart_update_item — title / description / key features / attributes
 *     for one SKU via an MP_MAINTENANCE partial feed (the same mechanism the
 *     multipack remediation pipeline uses). Never touches price, UPC or brand
 *     (brand triggers Walmart's ERR_EXT_DATA_0101119 catalog conflict).
 *
 *   walmart_feed_status — read-only poll of GET /v3/feeds/{feedId} with
 *     per-item ingestion errors, for verifying the async feeds above.
 *
 * All write tools take dry_run to preview the exact payload without calling
 * Walmart. Content fields are screened against the owner's brand-voice rules
 * (no emojis / promo adjectives / sale-shipping claims — the Amazon 99300
 * lists apply to ALL channels per CLAUDE.md); violations block the submit.
 *
 * Store: hardcoded storeIndex=1 (Sirius Trading International LLC — the only
 * Walmart account), same convention as every other walmart_* tool. Its token
 * has price/item/feeds full_access, verified via /v3/token/detail 2026-07-13.
 */

import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import {
  MAX_PRICE_FEED_ITEMS,
  buildSinglePriceBody,
  buildPriceFeedPayload,
  submitPriceFeed,
  updateSinglePrice,
  validatePriceUpdates,
  type PriceUpdate,
} from "@/lib/walmart/price";
import { SPEC_VERSION } from "@/lib/walmart/multipack/remediate";
import {
  PROMOTIONAL_BANNED,
  PROMOTIONAL_BANNED_LOWER,
  SALE_SHIPPING_CLAIM_BANNED,
  SALE_SHIPPING_CLAIM_BANNED_LOWER,
  findBannedSubstrings,
} from "@/lib/bundle-factory/compliance/banned-words";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const STORE_INDEX = 1;

/** Brand-voice screen (owner rule, strict, all channels): emojis, promo
 *  adjectives, sale/shipping claims. Returns human-readable violations. */
function brandVoiceViolations(label: string, text: string): string[] {
  const out: string[] = [];
  // Surrogate-pair + pictographic ranges cover the emoji families that have
  // historically leaked into listings (✅🍽🎁💚🧊⭐🔥⚡ etc.).
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/u.test(text)) {
    out.push(`${label}: contains emoji`);
  }
  for (const hit of findBannedSubstrings(text, PROMOTIONAL_BANNED, PROMOTIONAL_BANNED_LOWER)) {
    out.push(`${label}: promotional word "${hit}"`);
  }
  for (const hit of findBannedSubstrings(text, SALE_SHIPPING_CLAIM_BANNED, SALE_SHIPPING_CLAIM_BANNED_LOWER)) {
    out.push(`${label}: sale/shipping claim "${hit}"`);
  }
  return out;
}

function walmartErrorResult(err: WalmartApiError, extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    error:
      err.status === 401 || err.status === 403
        ? "Walmart auth failed — check WALMART_CLIENT_ID_STORE1 / WALMART_CLIENT_SECRET_STORE1"
        : `Walmart API ${err.status}`,
    walmart_status: err.status,
    walmart_correlation_id: err.correlationId,
    walmart_response: err.errorBody,
    ...extra,
  };
}

const walmartUpdatePrice: JackieTool = {
  name: "walmart_update_price",
  description:
    "Update the List Price for one or many Walmart SKUs. One SKU = instant synchronous update (PUT /v3/price). Multiple SKUs = one bulk price feed; returns a feed_id — verify it a few minutes later with walmart_feed_status. ALWAYS run with dry_run=true first and show the operator the preview before applying.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description:
          `Price changes, 1 to ${MAX_PRICE_FEED_ITEMS} entries. Each entry: {sku, price}. Price is the new List Price in dollars (e.g. 12.99).`,
        items: {
          type: "object",
          properties: {
            sku: { type: "string", description: "Seller SKU exactly as in Walmart Seller Center." },
            price: { type: "number", description: "New List Price in USD, > 0." },
          },
          required: ["sku", "price"],
          additionalProperties: false,
        },
      },
      dry_run: {
        type: "boolean",
        default: false,
        description: "When true, return the exact payload + endpoint without calling Walmart.",
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const raw = args.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("'items' must be a non-empty array of {sku, price}.");
    }
    if (raw.length > MAX_PRICE_FEED_ITEMS) {
      throw new Error(
        `'items' has ${raw.length} entries — max ${MAX_PRICE_FEED_ITEMS} per call. Split into batches.`,
      );
    }
    const updates = raw as PriceUpdate[];
    const problems = validatePriceUpdates(updates);
    if (problems.length > 0) {
      return { ok: false, error: "Input validation failed — nothing sent to Walmart.", problems };
    }
    const dryRun = args.dry_run === true;

    if (updates.length === 1) {
      const body = buildSinglePriceBody(updates[0]);
      if (dryRun) {
        return {
          dry_run: true,
          mode: "single_put",
          endpoint: "PUT https://marketplace.walmartapis.com/v3/price",
          body,
          note: "No changes made. Call again with dry_run=false to apply. Single-SKU PUT is synchronous — the response confirms acceptance immediately.",
        };
      }
      try {
        const resp = await updateSinglePrice(getWalmartClient(STORE_INDEX), updates[0]);
        return { ok: true, mode: "single_put", sku: updates[0].sku, price_set: updates[0].price, walmart_response: resp };
      } catch (err) {
        if (err instanceof WalmartApiError) return walmartErrorResult(err, { sku: updates[0].sku });
        throw err;
      }
    }

    const payload = buildPriceFeedPayload(updates);
    if (dryRun) {
      return {
        dry_run: true,
        mode: "bulk_feed",
        endpoint: "POST https://marketplace.walmartapis.com/v3/feeds?feedType=price",
        items_count: updates.length,
        // The full payload can be huge; the first entries are enough to
        // verify shape + values, and items_count confirms coverage.
        payload_preview: { ...payload, Price: payload.Price.slice(0, 5) },
        note: `No changes made. ${updates.length} SKUs would be sent in ONE price feed. Call again with dry_run=false to apply, then poll walmart_feed_status with the returned feed_id.`,
      };
    }
    try {
      const { feedId, raw: feedRaw } = await submitPriceFeed(getWalmartClient(STORE_INDEX), updates);
      return {
        ok: !!feedId,
        mode: "bulk_feed",
        items_submitted: updates.length,
        feed_id: feedId,
        ...(feedId
          ? { note: "Feed accepted. Walmart processes it asynchronously (usually minutes). Verify with walmart_feed_status." }
          : { error: "Walmart did not return a feedId", walmart_response: feedRaw }),
      };
    } catch (err) {
      if (err instanceof WalmartApiError) return walmartErrorResult(err);
      throw err;
    }
  },
};

const walmartUpdateItem: JackieTool = {
  name: "walmart_update_item",
  description:
    "Update listing content for ONE Walmart SKU: title, description, key feature bullets, and/or extra attributes — via an MP_MAINTENANCE partial feed. Only the fields you pass are changed; price/UPC/brand are never touched. Content is screened against brand-voice rules (no emojis, promo adjectives, or sale/shipping claims) and blocked on violations. Async: returns feed_id — verify with walmart_feed_status. ALWAYS run with dry_run=true first and show the operator the preview. NOTE: some multipack cards are QARTH-locked (Walmart accepts only image changes there); a feed that reports success but changes nothing is the QARTH signature.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Seller SKU exactly as in Walmart Seller Center." },
      title: { type: "string", description: "New product title (productName). Max 150 chars. Omit to keep current." },
      description: { type: "string", description: "New description (shortDescription). Plain factual text. Omit to keep current." },
      key_features: {
        type: "array",
        items: { type: "string" },
        description: "New bullet list (keyFeatures), 3-10 entries, replaces ALL existing bullets. Omit to keep current.",
      },
      attributes: {
        type: "object",
        description:
          'Optional extra Visible attributes for the item\'s product type, e.g. {"multipackQuantity": 4, "flavor": "Strawberry"}. Keys must be valid MP_ITEM 5.0 attribute names. brand/price/UPC keys are rejected.',
      },
      dry_run: {
        type: "boolean",
        default: false,
        description: "When true, return the exact feed payload + current live values without calling Walmart.",
      },
    },
    required: ["sku"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const sku = requireString(args, "sku");
    const title = optionalString(args, "title");
    const description = optionalString(args, "description");
    const keyFeatures = Array.isArray(args.key_features)
      ? (args.key_features as unknown[]).map(String)
      : undefined;
    const attributes =
      args.attributes && typeof args.attributes === "object" && !Array.isArray(args.attributes)
        ? (args.attributes as Record<string, unknown>)
        : undefined;
    const dryRun = args.dry_run === true;

    if (!title && !description && !keyFeatures && !attributes) {
      throw new Error("Nothing to update — pass at least one of title / description / key_features / attributes.");
    }
    if (title && title.length > 150) {
      return { ok: false, error: `Title is ${title.length} chars — Walmart limit is 150.` };
    }
    if (keyFeatures && (keyFeatures.length < 3 || keyFeatures.length > 10)) {
      return { ok: false, error: `key_features must have 3-10 bullets (got ${keyFeatures.length}).` };
    }
    if (attributes) {
      // Catalog-identity + pricing fields must never ride an item feed: brand
      // diffs trigger the QARTH ERR_EXT_DATA_0101119 conflict, and price has
      // its own dedicated tool with its own guardrails.
      const forbidden = Object.keys(attributes).filter((k) =>
        /^(brand|price|msrp|upc|gtin|productIdentifiers|sku)$/i.test(k),
      );
      if (forbidden.length > 0) {
        return {
          ok: false,
          error: `attributes may not contain catalog-identity/pricing keys: ${forbidden.join(", ")}. Use walmart_update_price for price.`,
        };
      }
    }

    // Brand voice — owner's strict rule, applies to all channels.
    const violations = [
      ...(title ? brandVoiceViolations("title", title) : []),
      ...(description ? brandVoiceViolations("description", description) : []),
      ...(keyFeatures ?? []).flatMap((b, i) => brandVoiceViolations(`bullet ${i + 1}`, b)),
    ];
    if (violations.length > 0) {
      return {
        ok: false,
        error: "Brand-voice violations — rewrite the content and try again. Nothing sent to Walmart.",
        violations,
      };
    }

    // Current live item supplies the two feed prerequisites (UPC + productType)
    // and doubles as the dry-run "before" snapshot.
    const client = getWalmartClient(STORE_INDEX);
    let cur: Record<string, unknown> | undefined;
    try {
      const itemRes = (await client.request<{ ItemResponse?: Record<string, unknown>[] }>(
        "GET",
        `/items/${encodeURIComponent(sku)}`,
      ));
      cur = itemRes?.ItemResponse?.[0];
    } catch (err) {
      if (err instanceof WalmartApiError) return walmartErrorResult(err, { sku });
      throw err;
    }
    if (!cur) return { ok: false, sku, error: `SKU "${sku}" not found in this Walmart account.` };
    const upc = cur.upc as string | undefined;
    const productType = cur.productType as string | undefined;
    if (!upc || !productType) {
      return {
        ok: false,
        sku,
        error: `Walmart returned the item without ${!upc ? "upc" : "productType"} — cannot build an MP_MAINTENANCE feed for it.`,
      };
    }

    const visible: Record<string, unknown> = {};
    if (title) visible.productName = title;
    if (description) visible.shortDescription = description;
    if (keyFeatures) visible.keyFeatures = keyFeatures;
    if (attributes) Object.assign(visible, attributes);

    const payload = {
      MPItemFeedHeader: { businessUnit: "WALMART_US", locale: "en", version: SPEC_VERSION },
      MPItem: [
        {
          Orderable: { sku, productIdentifiers: { productIdType: "UPC", productId: upc } },
          Visible: { [productType]: visible },
        },
      ],
    };

    if (dryRun) {
      return {
        dry_run: true,
        endpoint: "POST https://marketplace.walmartapis.com/v3/feeds?feedType=MP_MAINTENANCE",
        current: {
          title: cur.productName ?? null,
          published_status: cur.publishedStatus ?? null,
          product_type: productType,
          upc,
        },
        payload,
        fields_changing: Object.keys(visible),
        note: "No changes made. Call again with dry_run=false to apply, then poll walmart_feed_status with the returned feed_id.",
      };
    }

    try {
      const resp = await client.requestRaw("POST", "/feeds", {
        params: { feedType: "MP_MAINTENANCE" },
        body: payload,
      });
      const feedId = (resp.body as { feedId?: string } | null)?.feedId ?? null;
      return {
        ok: !!feedId,
        sku,
        fields_changed: Object.keys(visible),
        feed_id: feedId,
        ...(feedId
          ? { note: "Feed accepted. Walmart processes it asynchronously (minutes to hours for content). Verify with walmart_feed_status, then re-check the live listing." }
          : { error: "Walmart did not return a feedId", walmart_response: resp.body }),
      };
    } catch (err) {
      if (err instanceof WalmartApiError) return walmartErrorResult(err, { sku });
      throw err;
    }
  },
};

const walmartFeedStatus: JackieTool = {
  name: "walmart_feed_status",
  description:
    "Check the processing status of a Walmart feed submitted by walmart_update_price or walmart_update_item. Returns overall status (RECEIVED / INPROGRESS / PROCESSED / ERROR), counts, and per-SKU ingestion errors. Feeds usually process within minutes; re-poll if still INPROGRESS.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      feed_id: { type: "string", description: "The feed_id returned by a write tool." },
      limit: {
        type: "number",
        default: 50,
        description: "Max per-item results to return (default 50).",
      },
    },
    required: ["feed_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const feedId = requireString(args, "feed_id");
    const limitRaw = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 50;
    const limit = Math.min(Math.max(Math.floor(limitRaw), 1), 1000);
    const client = getWalmartClient(STORE_INDEX);
    try {
      const body = await client.request<Record<string, unknown>>(
        "GET",
        `/feeds/${encodeURIComponent(feedId)}`,
        { params: { includeDetails: "true", limit: String(limit) } },
      );
      const items = (body.itemDetails as { itemIngestionStatus?: Record<string, unknown>[] } | undefined)
        ?.itemIngestionStatus;
      return {
        feed_id: feedId,
        feed_status: body.feedStatus ?? null,
        items_received: body.itemsReceived ?? null,
        items_succeeded: body.itemsSucceeded ?? null,
        items_failed: body.itemsFailed ?? null,
        items_processing: body.itemsProcessing ?? null,
        item_results: (items ?? []).map((it) => ({
          sku: it.sku ?? null,
          status: it.ingestionStatus ?? null,
          errors: it.ingestionErrors ?? null,
        })),
      };
    } catch (err) {
      if (err instanceof WalmartApiError) return walmartErrorResult(err, { feed_id: feedId });
      throw err;
    }
  },
};

export const tools: JackieTool[] = [walmartUpdatePrice, walmartUpdateItem, walmartFeedStatus];
