/**
 * Resolve an exact seller SKU to a *candidate* numeric Walmart public itemId.
 *
 * This is deliberately not a buyer-PDP verifier. The Marketplace exact-SKU
 * response exposes an alphanumeric WPID, not the numeric itemId used by
 * walmart.com. We bridge that gap with Walmart's read-only catalog search:
 *
 *   exact seller SKU -> seller UPC/GTIN -> exact standardUpc matches
 *   -> one unique numeric catalog itemId
 *
 * Every ambiguity fails closed. In particular, this module never selects
 * `items[0]`, never treats WPID as itemId, and never calls an external service.
 */

import { createHash } from "node:crypto";

export const EXACT_ITEM_RESOLUTION_SCHEMA =
  "walmart-exact-item-resolution/v1" as const;

type JsonObject = Record<string, unknown>;

export interface ExactWalmartItemResolution {
  schema_version: typeof EXACT_ITEM_RESOLUTION_SCHEMA;
  sku: string;
  buyer_facing_verified: false;
  seller: {
    sku: string;
    title: string;
    upc: string;
    gtin14: string;
    wpid: string | null;
    published_status: string | null;
    lifecycle_status: string | null;
  };
  catalog_search_candidate: {
    item_id: string;
    title: string;
    main_image_url: string;
    is_marketplace_item: boolean | null;
    duplicate_rows_collapsed: number;
  };
  source_contract: {
    seller: "walmart_marketplace_exact_sku_get";
    candidate: "walmart_catalog_search_exact_upc";
    buyer_pdp: "not_verified";
    positional_or_fuzzy_fallbacks: 0;
  };
  source_hashes: {
    seller_payload_canonical_sha256: string;
    catalog_search_payload_canonical_sha256: string;
  };
  identity_evidence: string[];
}

interface SellerIdentity {
  sku: string;
  title: string;
  upc: string;
  gtin14: string;
  wpid: string | null;
  published_status: string | null;
  lifecycle_status: string | null;
  row_index: number;
}

export interface ExactSellerCatalogLookup {
  sku: string;
  upc: string;
  gtin14: string;
}

interface CatalogCandidate {
  item_id: string;
  title: string;
  main_image_url: string;
  is_marketplace_item: boolean | null;
  row_index: number;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeGtin14(value: unknown, label: string): string {
  const text = nonEmpty(value);
  if (!text || !/^\d+$/.test(text) || ![8, 12, 13, 14].includes(text.length)) {
    throw new Error(`${label} must be a GTIN-8/UPC-12/GTIN-13/GTIN-14 digit string`);
  }
  return text.padStart(14, "0");
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function sellerRows(payload: unknown): JsonObject[] {
  if (!isObject(payload) || !Array.isArray(payload.ItemResponse)) {
    throw new Error("seller response must contain ItemResponse[]");
  }
  if (!payload.ItemResponse.every(isObject)) {
    throw new Error("seller ItemResponse must contain objects only");
  }
  return payload.ItemResponse;
}

function resolveSeller(payload: unknown, sku: string): SellerIdentity {
  const rows = sellerRows(payload);
  const exact = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => nonEmpty(row.sku) === sku);
  if (exact.length !== 1) {
    throw new Error(`${sku}: expected exactly one exact-SKU seller row, found ${exact.length}`);
  }

  const { row, rowIndex } = exact[0]!;
  const title = nonEmpty(row.productName);
  if (!title) throw new Error(`${sku}: seller productName is missing`);
  const upc = nonEmpty(row.upc);
  if (!upc) throw new Error(`${sku}: seller UPC is missing`);
  const upcGtin14 = normalizeGtin14(upc, `${sku}: seller UPC`);
  const rawGtin = nonEmpty(row.gtin);
  const gtin14 = rawGtin
    ? normalizeGtin14(rawGtin, `${sku}: seller GTIN`)
    : upcGtin14;
  if (gtin14 !== upcGtin14) {
    throw new Error(`${sku}: seller UPC and GTIN disagree after normalization`);
  }

  return {
    sku,
    title: normalizeTitle(title),
    upc,
    gtin14,
    wpid: nonEmpty(row.wpid) ?? nonEmpty(row.Wpid),
    published_status: nonEmpty(row.publishedStatus),
    lifecycle_status: nonEmpty(row.lifecycleStatus),
    row_index: rowIndex,
  };
}

/**
 * Extract only the exact identifier needed for the second read-only request.
 * This shares the resolver's fail-closed SKU and UPC/GTIN validation and never
 * falls back to another seller row.
 */
export function extractExactSellerCatalogLookup(
  sku: string,
  sellerPayload: unknown,
): ExactSellerCatalogLookup {
  if (typeof sku !== "string" || !sku || sku !== sku.trim()) {
    throw new Error("SKU must be non-empty and already trimmed");
  }
  const seller = resolveSeller(sellerPayload, sku);
  return {
    sku: seller.sku,
    upc: seller.upc,
    gtin14: seller.gtin14,
  };
}

function catalogRows(payload: unknown): JsonObject[] {
  if (!isObject(payload) || !Array.isArray(payload.items)) {
    throw new Error("catalog search response must contain items[]");
  }
  if (!payload.items.every(isObject)) {
    throw new Error("catalog search items must contain objects only");
  }
  return payload.items;
}

function standardUpcs(row: JsonObject, label: string): string[] {
  if (!Array.isArray(row.standardUpc)) return [];
  const normalized: string[] = [];
  for (let index = 0; index < row.standardUpc.length; index++) {
    try {
      normalized.push(normalizeGtin14(
        row.standardUpc[index],
        `${label}.standardUpc[${index}]`,
      ));
    } catch {
      // An invalid identifier cannot be exact evidence. Ignore it, then fail
      // below if the row has no exact normalized identifier.
    }
  }
  return [...new Set(normalized)];
}

function canonicalMainImage(row: JsonObject, label: string): string {
  if (!Array.isArray(row.images) || row.images.length === 0) {
    throw new Error(`${label}: exact catalog row has no MAIN image candidate`);
  }
  const first = row.images[0];
  const raw = typeof first === "string"
    ? nonEmpty(first)
    : isObject(first)
      ? nonEmpty(first.url)
      : null;
  if (!raw) throw new Error(`${label}: exact catalog row MAIN image URL is missing`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}: exact catalog row MAIN image URL is invalid`);
  }
  if (url.protocol !== "https:"
    || (url.hostname !== "walmartimages.com"
      && !url.hostname.endsWith(".walmartimages.com"))) {
    throw new Error(`${label}: exact catalog row MAIN must use walmartimages.com HTTPS`);
  }
  // Walmart emits the same asset both bare and with thumbnail parameters in
  // duplicate search rows. The path is the immutable image identity.
  url.search = "";
  url.hash = "";
  return url.toString();
}

function exactCatalogCandidates(
  payload: unknown,
  seller: SellerIdentity,
): CatalogCandidate[] {
  const candidates: CatalogCandidate[] = [];
  const rows = catalogRows(payload);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    const upcs = standardUpcs(row, `catalog.items[${rowIndex}]`);
    if (!upcs.includes(seller.gtin14)) continue;

    const itemId = nonEmpty(row.itemId);
    if (!itemId || !/^\d+$/.test(itemId)) {
      throw new Error(
        `${seller.sku}: exact standardUpc row ${rowIndex} has no numeric public itemId`,
      );
    }
    const title = nonEmpty(row.title);
    if (!title) {
      throw new Error(`${seller.sku}: exact catalog row ${rowIndex} title is missing`);
    }
    const normalizedTitle = normalizeTitle(title);
    if (normalizedTitle !== seller.title) {
      throw new Error(
        `${seller.sku}: exact standardUpc row ${rowIndex} title disagrees with seller title`,
      );
    }
    const isMarketplace = row.isMarketPlaceItem;
    if (isMarketplace !== undefined && typeof isMarketplace !== "boolean") {
      throw new Error(
        `${seller.sku}: exact catalog row ${rowIndex} has invalid isMarketPlaceItem`,
      );
    }
    candidates.push({
      item_id: itemId,
      title: normalizedTitle,
      main_image_url: canonicalMainImage(
        row,
        `${seller.sku}: catalog.items[${rowIndex}]`,
      ),
      is_marketplace_item: typeof isMarketplace === "boolean" ? isMarketplace : null,
      row_index: rowIndex,
    });
  }
  if (candidates.length === 0) {
    throw new Error(`${seller.sku}: catalog search has no exact standardUpc match`);
  }
  return candidates;
}

function collapseEquivalentCandidates(
  sku: string,
  candidates: CatalogCandidate[],
): CatalogCandidate {
  const itemIds = new Set(candidates.map((candidate) => candidate.item_id));
  if (itemIds.size !== 1) {
    throw new Error(
      `${sku}: exact standardUpc maps to ${itemIds.size} unique numeric public itemIds`,
    );
  }

  const signature = (candidate: CatalogCandidate): string => JSON.stringify({
    item_id: candidate.item_id,
    title: candidate.title,
    main_image_url: candidate.main_image_url,
    is_marketplace_item: candidate.is_marketplace_item,
  });
  const signatures = new Set(candidates.map(signature));
  if (signatures.size !== 1) {
    throw new Error(`${sku}: duplicate catalog rows are not field-equivalent`);
  }
  return candidates[0]!;
}

/**
 * Produce a strict public-item *candidate*. A separate buyer PDP/browser read
 * must still prove canonical URL, buyer title, MAIN, and gallery.
 */
export function resolveExactWalmartItemCandidate(
  sku: string,
  sellerPayload: unknown,
  catalogSearchPayload: unknown,
): ExactWalmartItemResolution {
  if (typeof sku !== "string" || !sku || sku !== sku.trim()) {
    throw new Error("SKU must be non-empty and already trimmed");
  }
  const seller = resolveSeller(sellerPayload, sku);
  const candidates = exactCatalogCandidates(catalogSearchPayload, seller);
  const candidate = collapseEquivalentCandidates(sku, candidates);

  return {
    schema_version: EXACT_ITEM_RESOLUTION_SCHEMA,
    sku,
    buyer_facing_verified: false,
    seller: {
      sku: seller.sku,
      title: seller.title,
      upc: seller.upc,
      gtin14: seller.gtin14,
      wpid: seller.wpid,
      published_status: seller.published_status,
      lifecycle_status: seller.lifecycle_status,
    },
    catalog_search_candidate: {
      item_id: candidate.item_id,
      title: candidate.title,
      main_image_url: candidate.main_image_url,
      is_marketplace_item: candidate.is_marketplace_item,
      duplicate_rows_collapsed: candidates.length,
    },
    source_contract: {
      seller: "walmart_marketplace_exact_sku_get",
      candidate: "walmart_catalog_search_exact_upc",
      buyer_pdp: "not_verified",
      positional_or_fuzzy_fallbacks: 0,
    },
    source_hashes: {
      seller_payload_canonical_sha256: payloadHash(sellerPayload),
      catalog_search_payload_canonical_sha256: payloadHash(catalogSearchPayload),
    },
    identity_evidence: [
      `request.sku=${sku}`,
      `seller.ItemResponse[${seller.row_index}].sku=${seller.sku}`,
      `seller.ItemResponse[${seller.row_index}].upc=${seller.upc}`,
      `seller.normalized_gtin14=${seller.gtin14}`,
      ...(seller.wpid ? [`seller.wpid_not_itemId=${seller.wpid}`] : []),
      ...candidates.map((entry) =>
        `catalog.items[${entry.row_index}].standardUpc~=${seller.gtin14};itemId=${entry.item_id}`),
      `catalog.unique_numeric_public_itemId=${candidate.item_id}`,
    ],
  };
}
