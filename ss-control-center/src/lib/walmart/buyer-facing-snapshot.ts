/**
 * Strict buyer-facing Walmart PDP snapshot primitives.
 *
 * This module deliberately has no Walmart write, database, R2, or model client.
 * Network access is supplied by read-only adapters so callers and tests can
 * prove exactly which GETs are allowed. Walmart's exact seller-SKU response
 * exposes an alphanumeric WPID rather than the numeric walmart.com itemId, so
 * operational capture consumes a pre-validated seller -> GTIN -> catalog
 * candidate resolution. Only an exact buyer PDP echo of that candidate itemId
 * marks the sealed snapshot buyer-facing verified. There is intentionally no
 * `items[0]` or product-family fallback.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ExactWalmartItemResolution } from "./exact-item-resolution";

const EXACT_ITEM_RESOLUTION_SCHEMA = "walmart-exact-item-resolution/v1";

export const BUYER_SNAPSHOT_REQUEST_SCHEMA =
  "walmart-buyer-facing-snapshot-request/v1";
export const BUYER_SNAPSHOT_SCHEMA = "walmart-buyer-facing-snapshot/v2";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface WalmartBuyerSnapshotTarget {
  sku: string;
  item_id: string;
  expected_title?: string;
  stratum?: string;
}

export interface ReadOnlyImageResponse {
  bytes: Uint8Array;
  status?: number;
  content_type?: string | null;
  final_url?: string | null;
}

/** The only remote capabilities the capture pipeline can invoke. */
export interface WalmartBuyerSnapshotReadAdapters {
  /**
   * Must return the strict result of:
   * GET /v3/items/{exact SKU} -> UPC/GTIN -> catalog search exact standardUpc.
   * The result is still only a catalog candidate, never PDP verification.
   */
  getExactItemResolution(sku: string): Promise<unknown>;
  /** Must perform a buyer-PDP GET bound to this exact Walmart itemId. */
  getBuyerPdpByItemId(itemId: string): Promise<unknown>;
  /** Must perform an HTTPS GET only. */
  getImage(url: string): Promise<ReadOnlyImageResponse>;
}

export interface ResolvedSellerIdentity {
  sku: string;
  item_id: string;
  title: string | null;
  published_status: string | null;
  lifecycle_status: string | null;
}

export interface ResolvedBuyerPdp {
  item_id: string;
  title: string;
  main_image_url: string;
  gallery_image_urls: string[];
  identity_evidence: string[];
}

export interface WalmartBuyerSnapshotAsset {
  slot: "MAIN" | `GALLERY_${number}`;
  source_url: string;
  final_url: string;
  sha256: string;
  bytes: number;
  media_type: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
}

export interface WalmartBuyerSnapshotDraft {
  schema_version: typeof BUYER_SNAPSHOT_SCHEMA;
  captured_at: string;
  target: WalmartBuyerSnapshotTarget;
  identity: {
    exact_sku_match: true;
    exact_item_id_match: true;
    buyer_facing_verified: true;
    seller: ExactWalmartItemResolution["seller"];
    catalog_search_candidate: ExactWalmartItemResolution["catalog_search_candidate"];
    buyer: {
      item_id: string;
      title: string;
      identity_evidence: string[];
    };
    chain_evidence: {
      seller_to_catalog: string[];
      catalog_to_buyer_pdp: string[];
    };
  };
  source_contract: {
    seller: "walmart_marketplace_exact_sku_get";
    candidate: "walmart_catalog_search_exact_upc";
    buyer: "walmart_buyer_pdp_exact_item_get";
    positional_or_fuzzy_fallbacks: 0;
    database_writes: 0;
    walmart_writes: 0;
    r2_writes: 0;
  };
  payload_hashes: {
    seller_payload_canonical_sha256: string;
    catalog_search_payload_canonical_sha256: string;
    resolution_canonical_sha256: string;
    buyer_payload_canonical_sha256: string;
  };
  assets: WalmartBuyerSnapshotAsset[];
  /** Kept out of the JSON seal; keyed by each asset SHA-256. */
  binary_assets: Map<string, Uint8Array>;
}

export interface SealedWalmartBuyerSnapshot {
  schema_version: typeof BUYER_SNAPSHOT_SCHEMA;
  snapshot_id: string;
  body_sha256: string;
  captured_at: string;
  target: WalmartBuyerSnapshotTarget;
  identity: WalmartBuyerSnapshotDraft["identity"];
  source_contract: WalmartBuyerSnapshotDraft["source_contract"];
  payload_hashes: WalmartBuyerSnapshotDraft["payload_hashes"];
  assets: Array<WalmartBuyerSnapshotAsset & { local_path: string }>;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

function assertExactTarget(target: WalmartBuyerSnapshotTarget): void {
  if (!target || typeof target !== "object") throw new Error("snapshot target is required");
  if (!target.sku || target.sku !== target.sku.trim()) {
    throw new Error("target SKU must be non-empty and already trimmed");
  }
  if (!/^\d+$/.test(target.item_id)) {
    throw new Error(`${target.sku}: Walmart item_id must contain digits only`);
  }
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function sellerRows(payload: unknown): JsonObject[] {
  if (!isObject(payload)) throw new Error("seller item response must be an object");
  const envelopeKeys = ["ItemResponse", "itemResponse", "items"] as const;
  for (const key of envelopeKeys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isObject);
    if (isObject(value)) return [value];
  }
  if (isObject(payload.payload)) return [payload.payload];
  if (nonEmpty(payload.sku) || nonEmpty(payload.Sku)) return [payload];
  throw new Error("seller item response has no recognized item envelope");
}

function sellerSku(row: JsonObject): string | null {
  return nonEmpty(row.sku) ?? nonEmpty(row.Sku);
}

function sellerItemIds(row: JsonObject): string[] {
  const mart = isObject(row.mart) ? row.mart : null;
  return unique([
    nonEmpty(mart?.itemId),
    nonEmpty(row.itemId),
    nonEmpty(row.item_id),
  ]);
}

/**
 * Legacy pure parser for synthetic/older seller payloads that really contain a
 * numeric itemId. WPID is deliberately excluded: actual exact-SKU responses use
 * WPID for a different identifier. Operational capture uses the validated
 * seller -> GTIN -> catalog resolution instead.
 */
export function resolveExactSellerItem(
  payload: unknown,
  target: WalmartBuyerSnapshotTarget,
): ResolvedSellerIdentity {
  assertExactTarget(target);
  const exact = sellerRows(payload).filter((row) => sellerSku(row) === target.sku);
  if (exact.length !== 1) {
    throw new Error(`${target.sku}: expected exactly one exact-SKU seller row, found ${exact.length}`);
  }
  const row = exact[0]!;
  const ids = sellerItemIds(row);
  if (ids.length !== 1) {
    throw new Error(`${target.sku}: seller row has ${ids.length ? "conflicting" : "no"} itemId evidence`);
  }
  if (ids[0] !== target.item_id) {
    throw new Error(`${target.sku}: seller itemId ${ids[0]} != requested ${target.item_id}`);
  }
  return {
    sku: target.sku,
    item_id: target.item_id,
    title: nonEmpty(row.productName) ?? nonEmpty(row.title),
    published_status: nonEmpty(row.publishedStatus),
    lifecycle_status: nonEmpty(row.lifecycleStatus),
  };
}

function parseItemIdFromWalmartUrl(value: unknown): string | null {
  const text = nonEmpty(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.hostname !== "walmart.com" && !url.hostname.endsWith(".walmart.com")) return null;
    const match = url.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)(?:\/)?$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function buyerRoot(payload: unknown): JsonObject {
  if (!isObject(payload)) throw new Error("buyer PDP response must be an object");
  if (isObject(payload.product)) return payload.product;
  if (isObject(payload.data) && isObject(payload.data.product)) return payload.data.product;
  if (nonEmpty(payload.main_image) || nonEmpty(payload.mainImage)) return payload;
  throw new Error("buyer PDP response has no recognized product object");
}

function imageUrlFrom(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isObject(value)) return null;
  return nonEmpty(value.link)
    ?? nonEmpty(value.url)
    ?? nonEmpty(value.src)
    ?? nonEmpty(value.image_url)
    ?? nonEmpty(value.imageUrl);
}

function assertHttpsImageUrl(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label}: invalid image URL`); }
  if (url.protocol !== "https:") throw new Error(`${label}: image URL must use HTTPS`);
  url.hash = "";
  return url.toString();
}

/** Resolve a buyer PDP only when it explicitly echoes the expected itemId. */
export function resolveExactBuyerPdp(
  payload: unknown,
  target: WalmartBuyerSnapshotTarget,
): ResolvedBuyerPdp {
  assertExactTarget(target);
  const product = buyerRoot(payload);
  const evidence = [
    ["product.item_id", nonEmpty(product.item_id)],
    ["product.itemId", nonEmpty(product.itemId)],
    ["product.us_item_id", nonEmpty(product.us_item_id)],
    ["product.usItemId", nonEmpty(product.usItemId)],
    ["product.walmart_item_id", nonEmpty(product.walmart_item_id)],
    ["product.walmartItemId", nonEmpty(product.walmartItemId)],
    ["product.product_url", parseItemIdFromWalmartUrl(product.product_url)],
    ["product.productUrl", parseItemIdFromWalmartUrl(product.productUrl)],
    ["product.link", parseItemIdFromWalmartUrl(product.link)],
    ["product.url", parseItemIdFromWalmartUrl(product.url)],
  ].filter((entry): entry is [string, string] => !!entry[1]);
  const identityIds = unique(evidence.map((entry) => entry[1]));
  if (identityIds.length !== 1) {
    throw new Error(`${target.sku}: buyer PDP has ${identityIds.length ? "conflicting" : "no"} itemId evidence`);
  }
  if (identityIds[0] !== target.item_id) {
    throw new Error(`${target.sku}: buyer PDP itemId ${identityIds[0]} != requested ${target.item_id}`);
  }

  const title = nonEmpty(product.title) ?? nonEmpty(product.productName);
  if (!title) throw new Error(`${target.sku}: buyer PDP title is missing`);
  const mainRaw = imageUrlFrom(product.main_image) ?? imageUrlFrom(product.mainImage);
  if (!mainRaw) throw new Error(`${target.sku}: buyer PDP MAIN image is missing`);
  const main = assertHttpsImageUrl(mainRaw, `${target.sku} MAIN`);

  const rawGallery = Array.isArray(product.images)
    ? product.images
    : Array.isArray(product.image_urls)
      ? product.image_urls
      : Array.isArray(product.imageUrls)
        ? product.imageUrls
        : [];
  const seen = new Set([main]);
  const gallery: string[] = [];
  for (let index = 0; index < rawGallery.length; index++) {
    const candidate = imageUrlFrom(rawGallery[index]);
    if (!candidate) continue;
    const url = assertHttpsImageUrl(candidate, `${target.sku} gallery ${index + 1}`);
    if (seen.has(url)) continue;
    seen.add(url);
    gallery.push(url);
  }

  return {
    item_id: target.item_id,
    title,
    main_image_url: main,
    gallery_image_urls: gallery,
    identity_evidence: evidence.map(([source, value]) => `${source}=${value}`),
  };
}

function detectImage(bytes: Uint8Array): Pick<WalmartBuyerSnapshotAsset, "media_type" | "extension"> {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { media_type: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { media_type: "image/png", extension: "png" };
  }
  if (bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") {
    return { media_type: "image/webp", extension: "webp" };
  }
  throw new Error("downloaded bytes are not a supported raster image");
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function normalizedGtin14(value: unknown): string | null {
  const text = nonEmpty(value);
  if (!text || !/^\d+$/.test(text) || ![8, 12, 13, 14].includes(text.length)) {
    return null;
  }
  return text.padStart(14, "0");
}

function assertSha256(value: unknown, label: string): string {
  const text = nonEmpty(value);
  if (!text || !/^[a-f0-9]{64}$/.test(text)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return text;
}

/**
 * Runtime validation for the pre-PDP identity chain. TypeScript types alone
 * are not evidence because an operational adapter may deserialize JSON.
 */
export function validateExactItemResolution(
  value: unknown,
  target: WalmartBuyerSnapshotTarget,
): ExactWalmartItemResolution {
  assertExactTarget(target);
  if (!isObject(value)) throw new Error(`${target.sku}: exact item resolution must be an object`);
  if (value.schema_version !== EXACT_ITEM_RESOLUTION_SCHEMA) {
    throw new Error(`${target.sku}: unsupported exact item resolution schema`);
  }
  if (value.buyer_facing_verified !== false) {
    throw new Error(`${target.sku}: pre-PDP resolution must have buyer_facing_verified=false`);
  }
  if (value.sku !== target.sku) {
    throw new Error(`${target.sku}: resolution SKU does not match target`);
  }

  const seller = value.seller;
  if (!isObject(seller) || seller.sku !== target.sku) {
    throw new Error(`${target.sku}: resolution seller SKU does not match target`);
  }
  const sellerTitle = nonEmpty(seller.title);
  const sellerUpc = nonEmpty(seller.upc);
  const sellerGtin14 = nonEmpty(seller.gtin14);
  if (!sellerTitle || !sellerUpc || !sellerGtin14) {
    throw new Error(`${target.sku}: resolution seller identity is incomplete`);
  }
  const normalizedUpc = normalizedGtin14(sellerUpc);
  if (!normalizedUpc || normalizedUpc !== sellerGtin14 || !/^\d{14}$/.test(sellerGtin14)) {
    throw new Error(`${target.sku}: resolution seller UPC/GTIN chain is invalid`);
  }
  if (seller.wpid !== null && typeof seller.wpid !== "string") {
    throw new Error(`${target.sku}: resolution seller WPID is invalid`);
  }

  const candidate = value.catalog_search_candidate;
  if (!isObject(candidate)) {
    throw new Error(`${target.sku}: catalog search candidate is missing`);
  }
  const candidateItemId = nonEmpty(candidate.item_id);
  if (!candidateItemId || !/^\d+$/.test(candidateItemId)) {
    throw new Error(`${target.sku}: catalog candidate item_id must be numeric`);
  }
  if (candidateItemId !== target.item_id) {
    throw new Error(
      `${target.sku}: catalog candidate itemId ${candidateItemId} != requested ${target.item_id}`,
    );
  }
  if (seller.wpid && seller.wpid === candidateItemId) {
    throw new Error(`${target.sku}: WPID must not be used as public itemId evidence`);
  }
  if (nonEmpty(candidate.title) !== sellerTitle) {
    throw new Error(`${target.sku}: catalog candidate title disagrees with seller title`);
  }
  const candidateMain = nonEmpty(candidate.main_image_url);
  if (!candidateMain) throw new Error(`${target.sku}: catalog candidate MAIN is missing`);
  const mainUrl = new URL(assertHttpsImageUrl(
    candidateMain,
    `${target.sku} catalog candidate MAIN`,
  ));
  if (mainUrl.hostname !== "walmartimages.com"
    && !mainUrl.hostname.endsWith(".walmartimages.com")) {
    throw new Error(`${target.sku}: catalog candidate MAIN is not a Walmart image`);
  }
  if (!Number.isInteger(candidate.duplicate_rows_collapsed)
    || Number(candidate.duplicate_rows_collapsed) < 1) {
    throw new Error(`${target.sku}: invalid catalog duplicate collapse count`);
  }
  if (candidate.is_marketplace_item !== null
    && typeof candidate.is_marketplace_item !== "boolean") {
    throw new Error(`${target.sku}: invalid catalog marketplace flag`);
  }

  const contract = value.source_contract;
  if (!isObject(contract)
    || contract.seller !== "walmart_marketplace_exact_sku_get"
    || contract.candidate !== "walmart_catalog_search_exact_upc"
    || contract.buyer_pdp !== "not_verified"
    || contract.positional_or_fuzzy_fallbacks !== 0) {
    throw new Error(`${target.sku}: invalid pre-PDP source contract`);
  }
  const sourceHashes = value.source_hashes;
  if (!isObject(sourceHashes)) throw new Error(`${target.sku}: source hashes are missing`);
  assertSha256(
    sourceHashes.seller_payload_canonical_sha256,
    `${target.sku} seller payload hash`,
  );
  assertSha256(
    sourceHashes.catalog_search_payload_canonical_sha256,
    `${target.sku} catalog search payload hash`,
  );

  if (!Array.isArray(value.identity_evidence)
    || value.identity_evidence.length < 4
    || !value.identity_evidence.every((entry) => typeof entry === "string" && !!entry)) {
    throw new Error(`${target.sku}: resolution identity evidence is incomplete`);
  }
  const evidence = new Set(value.identity_evidence);
  if (!evidence.has(`request.sku=${target.sku}`)
    || !evidence.has(`seller.normalized_gtin14=${sellerGtin14}`)
    || !evidence.has(`catalog.unique_numeric_public_itemId=${target.item_id}`)) {
    throw new Error(`${target.sku}: resolution identity evidence does not prove the chain`);
  }

  return value as unknown as ExactWalmartItemResolution;
}

/** Capture one exact SKU/itemId pair. Any missing identity or image fails closed. */
export async function captureWalmartBuyerSnapshot(
  target: WalmartBuyerSnapshotTarget,
  adapters: WalmartBuyerSnapshotReadAdapters,
  capturedAt = new Date(),
): Promise<WalmartBuyerSnapshotDraft> {
  assertExactTarget(target);
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new Error("capturedAt must be a valid Date");
  }

  const resolutionPayload = await adapters.getExactItemResolution(target.sku);
  const resolution = validateExactItemResolution(resolutionPayload, target);
  const buyerPayload = await adapters.getBuyerPdpByItemId(target.item_id);
  const buyer = resolveExactBuyerPdp(buyerPayload, target);

  const slots: Array<{ slot: WalmartBuyerSnapshotAsset["slot"]; url: string }> = [
    { slot: "MAIN", url: buyer.main_image_url },
    ...buyer.gallery_image_urls.map((url, index) => ({
      slot: `GALLERY_${index + 1}` as const,
      url,
    })),
  ];
  const binaries = new Map<string, Uint8Array>();
  const assets: WalmartBuyerSnapshotAsset[] = [];
  for (const entry of slots) {
    const response = await adapters.getImage(entry.url);
    if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
      throw new Error(`${target.sku} ${entry.slot}: image GET returned HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(response.bytes);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`${target.sku} ${entry.slot}: invalid image byte length ${bytes.length}`);
    }
    const kind = detectImage(bytes);
    const finalUrl = assertHttpsImageUrl(response.final_url || entry.url, `${target.sku} ${entry.slot} final URL`);
    const digest = sha256(bytes);
    binaries.set(digest, bytes);
    assets.push({
      slot: entry.slot,
      source_url: entry.url,
      final_url: finalUrl,
      sha256: digest,
      bytes: bytes.length,
      ...kind,
    });
  }

  return {
    schema_version: BUYER_SNAPSHOT_SCHEMA,
    captured_at: capturedAt.toISOString(),
    target: { ...target },
    identity: {
      exact_sku_match: true,
      exact_item_id_match: true,
      buyer_facing_verified: true,
      seller: resolution.seller,
      catalog_search_candidate: resolution.catalog_search_candidate,
      buyer: {
        item_id: buyer.item_id,
        title: buyer.title,
        identity_evidence: buyer.identity_evidence,
      },
      chain_evidence: {
        seller_to_catalog: [...resolution.identity_evidence],
        catalog_to_buyer_pdp: [...buyer.identity_evidence],
      },
    },
    source_contract: {
      seller: "walmart_marketplace_exact_sku_get",
      candidate: "walmart_catalog_search_exact_upc",
      buyer: "walmart_buyer_pdp_exact_item_get",
      positional_or_fuzzy_fallbacks: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
    },
    payload_hashes: {
      seller_payload_canonical_sha256:
        resolution.source_hashes.seller_payload_canonical_sha256,
      catalog_search_payload_canonical_sha256:
        resolution.source_hashes.catalog_search_payload_canonical_sha256,
      resolution_canonical_sha256: sha256(canonicalJson(resolution)),
      buyer_payload_canonical_sha256: sha256(canonicalJson(buyerPayload)),
    },
    assets,
    binary_assets: binaries,
  };
}

function safeStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function snapshotBody(draft: WalmartBuyerSnapshotDraft) {
  return {
    schema_version: draft.schema_version,
    captured_at: draft.captured_at,
    target: draft.target,
    identity: draft.identity,
    source_contract: draft.source_contract,
    payload_hashes: draft.payload_hashes,
    assets: draft.assets.map((asset) => ({
      ...asset,
      local_path: `assets/${asset.sha256}.${asset.extension}`,
    })),
  };
}

/**
 * Persist to a new content-sealed local directory. Existing snapshots are
 * verified and reused; files are never overwritten.
 */
export async function writeImmutableWalmartBuyerSnapshot(
  outputRoot: string,
  draft: WalmartBuyerSnapshotDraft,
): Promise<{ directory: string; manifest_path: string; snapshot: SealedWalmartBuyerSnapshot }> {
  const body = snapshotBody(draft);
  const bodySha = sha256(canonicalJson(body));
  const snapshotId = `walmart-buyer-${safeStamp(draft.captured_at)}-${bodySha.slice(0, 12)}`;
  const snapshot = {
    ...body,
    snapshot_id: snapshotId,
    body_sha256: bodySha,
  } as SealedWalmartBuyerSnapshot;
  const directory = path.resolve(outputRoot, snapshotId);
  const manifestPath = path.join(directory, "manifest.json");

  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as SealedWalmartBuyerSnapshot;
    if (existing.body_sha256 !== bodySha || canonicalJson(existing) !== canonicalJson(snapshot)) {
      throw new Error(`${snapshotId}: existing immutable snapshot differs`);
    }
    return { directory, manifest_path: manifestPath, snapshot: existing };
  } catch (error) {
    const code = isObject(error) ? nonEmpty(error.code) : null;
    if (code !== "ENOENT") throw error;
  }

  await mkdir(outputRoot, { recursive: true });
  const temporary = path.resolve(outputRoot, `.${snapshotId}.tmp-${process.pid}`);
  await mkdir(temporary, { recursive: false });
  await mkdir(path.join(temporary, "assets"), { recursive: false });
  for (const asset of draft.assets) {
    const bytes = draft.binary_assets.get(asset.sha256);
    if (!bytes || sha256(bytes) !== asset.sha256) {
      throw new Error(`${asset.slot}: binary missing or hash mismatch before write`);
    }
    await writeFile(path.join(temporary, "assets", `${asset.sha256}.${asset.extension}`), bytes, { flag: "wx" });
  }
  await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, directory);
  return { directory, manifest_path: manifestPath, snapshot };
}
