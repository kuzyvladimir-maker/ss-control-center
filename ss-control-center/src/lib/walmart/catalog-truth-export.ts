/**
 * Pure, offline compiler from the shared Product Truth Platform into Walmart
 * Listing Improvement audit cases.
 *
 * This module is deliberately a consumer. It has no filesystem, database,
 * marketplace, retailer, or model adapter and it never creates a second truth
 * catalog. The only accepted inputs are a frozen Product Truth Platform
 * snapshot and a frozen index of already-sealed buyer-facing snapshots.
 */

import { createHash } from "node:crypto";

import type {
  SealedWalmartBuyerSnapshot,
} from "./buyer-facing-snapshot.ts";
import type {
  ListingKind,
  ProposedAuditTruth,
  RecipeComposition,
  StructuredCatalogRecord,
  StructuredRecipe,
  TruthPreflightResult,
  TruthSourceEvidence,
} from "./catalog-visual-truth-preflight.ts";
import {
  WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
  WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA,
  parseTruthPreflightInput,
  preflightWalmartAuditTruth,
} from "./catalog-visual-truth-preflight.ts";

export const PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA =
  "product-truth-platform-walmart-audit-snapshot/v2" as const;
export const WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA =
  "walmart-buyer-facing-snapshot-index/v2" as const;
export const WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA =
  "walmart-catalog-truth-audit-export/v2" as const;
const SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA =
  "walmart-buyer-facing-snapshot/v3" as const;

export type CatalogTruthAuditDisposition =
  | "auditable"
  | "truth_review"
  | "unsupported";

export type CatalogTruthCompilerReason =
  | "TRUTH_REVISION_UNAPPROVED"
  | "TRUTH_REVISION_SUPERSEDED"
  | "BUYER_SNAPSHOT_MISSING"
  | "BUYER_BINDING_NOT_EXACT"
  | "BUYER_LISTING_NOT_PUBLISHED"
  | "BUYER_LISTING_NOT_ACTIVE";

export interface ProductTruthRevisionApproval {
  /**
   * Integrity-bound assertion copied from the trusted shared platform.
   * approval_sha256 is not a digital signature and cannot authenticate an
   * arbitrary file by itself; source-aware verification below therefore
   * requires the original trusted Product Truth Platform snapshot.
   */
  decision: "approved";
  revision_body_sha256: string;
  approved_at: string;
  approved_by: string;
  approval_authority: "product_truth_platform_owner_gate";
  approval_method: "trusted_platform_record";
  approval_sha256: string;
}

export interface ProductTruthWalmartRevision {
  revision_id: string;
  body_sha256: string;
  approval: ProductTruthRevisionApproval | null;
  superseded_by_revision_id: string | null;
  listing_kind: ListingKind;
  category: string;
  recipe: StructuredRecipe;
  structured_record: StructuredCatalogRecord;
  proposed_truth: ProposedAuditTruth;
  source_evidence: TruthSourceEvidence[];
}

export interface WalmartListingIdentity {
  channel: "WALMART_US";
  store_index: number;
  sku: string;
  listing_key: string;
}

export function walmartListingKey(storeIndex: number, sku: string): string {
  if (!Number.isInteger(storeIndex) || storeIndex < 1) {
    throw new Error("store_index must be a positive integer");
  }
  if (typeof sku !== "string" || !sku || sku !== sku.trim()) {
    throw new Error("SKU must be non-empty and already trimmed");
  }
  return `walmart:${storeIndex}:${sku}`;
}

export interface ProductTruthWalmartAuditRow extends WalmartListingIdentity {
  item_id: string;
  revision: ProductTruthWalmartRevision;
}

export interface ProductTruthWalmartAuditSnapshot {
  schema_version: typeof PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA;
  snapshot_id: string;
  body_sha256: string;
  captured_at: string;
  producer: "shared_product_truth_platform";
  rows: ProductTruthWalmartAuditRow[];
}

export interface WalmartBuyerSnapshotIndexEntry extends WalmartListingIdentity {
  item_id: string;
  snapshot: SealedWalmartBuyerSnapshot;
}

export interface WalmartBuyerSnapshotIndex {
  schema_version: typeof WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA;
  index_id: string;
  body_sha256: string;
  captured_at: string;
  entries: WalmartBuyerSnapshotIndexEntry[];
}

export interface WalmartCatalogTruthAuditCase extends WalmartListingIdentity {
  case_id: string;
  item_id: string;
  category: string;
  published_status: string | null;
  lifecycle_status: string | null;
  listing_kind: ListingKind;
  recipe_composition: RecipeComposition;
  disposition: CatalogTruthAuditDisposition;
  truth_revision: {
    revision_id: string;
    body_sha256: string;
    approval_sha256: string | null;
  };
  buyer_snapshot: {
    snapshot_id: string;
    body_sha256: string;
    main_asset_sha256: string;
  } | null;
  preflight: TruthPreflightResult | null;
  preflight_sha256: string | null;
  compiler_reasons: CatalogTruthCompilerReason[];
}

export interface WalmartCatalogTruthAuditExport {
  schema_version: typeof WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA;
  export_id: string;
  body_sha256: string;
  product_truth_snapshot: {
    snapshot_id: string;
    body_sha256: string;
    captured_at: string;
  };
  buyer_index: {
    index_id: string;
    body_sha256: string;
    captured_at: string;
  };
  summary: {
    total_cases: number;
    auditable_cases: number;
    truth_review_cases: number;
    unsupported_cases: number;
  };
  cases: WalmartCatalogTruthAuditCase[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: JsonRecord,
  required: readonly string[],
  path: string,
): void {
  const allowed = new Set(required);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function exactSku(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty, already-trimmed exact SKU`);
  }
  return value;
}

function parseListingIdentity(
  raw: JsonRecord,
  path: string,
): WalmartListingIdentity {
  if (raw.channel !== "WALMART_US") {
    throw new Error(`${path}.channel must be WALMART_US`);
  }
  const storeIndex = positiveInteger(raw.store_index, `${path}.store_index`);
  const sku = exactSku(raw.sku, `${path}.sku`);
  const listingKey = requiredString(raw.listing_key, `${path}.listing_key`);
  const expectedKey = walmartListingKey(storeIndex, sku);
  if (listingKey !== expectedKey) {
    throw new Error(`${path}.listing_key must equal ${expectedKey}`);
  }
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: listingKey,
  };
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requiredString(value, path);
}

function numericItemId(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!/^\d+$/.test(parsed)) throw new Error(`${path} must contain digits only`);
  return parsed;
}

function sha256String(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
  return parsed;
}

function validCapturedAt(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed)
    || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${path} must be an ISO-8601 timestamp with timezone`);
  }
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return Number(value);
}

function exactBoolean(value: unknown, expected: boolean, path: string): void {
  if (value !== expected) throw new Error(`${path} must be ${String(expected)}`);
}

/** Canonical JSON used for every body, approval, case, and export seal. */
export function canonicalCatalogTruthJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCatalogTruthJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCatalogTruthJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON does not support undefined values");
  return encoded;
}

export function catalogTruthCanonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalCatalogTruthJson(value)).digest("hex");
}

function productTruthRevisionBody(raw: JsonRecord): JsonRecord {
  return {
    revision_id: raw.revision_id,
    listing_kind: raw.listing_kind,
    category: raw.category,
    recipe: raw.recipe,
    structured_record: raw.structured_record,
    proposed_truth: raw.proposed_truth,
    source_evidence: raw.source_evidence,
  };
}

function parseApproval(
  raw: unknown,
  revisionBodySha: string,
  path: string,
): ProductTruthRevisionApproval | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new Error(`${path} must be an object or null`);
  assertExactKeys(raw, [
    "decision", "revision_body_sha256", "approved_at", "approved_by", "approval_authority",
    "approval_method", "approval_sha256",
  ], path);
  if (raw.decision !== "approved") throw new Error(`${path}.decision must be approved`);
  if (raw.approval_authority !== "product_truth_platform_owner_gate") {
    throw new Error(`${path}.approval_authority must be product_truth_platform_owner_gate`);
  }
  if (raw.approval_method !== "trusted_platform_record") {
    throw new Error(`${path}.approval_method must be trusted_platform_record`);
  }
  const approval = {
    decision: "approved" as const,
    revision_body_sha256: sha256String(
      raw.revision_body_sha256,
      `${path}.revision_body_sha256`,
    ),
    approved_at: validCapturedAt(raw.approved_at, `${path}.approved_at`),
    approved_by: requiredString(raw.approved_by, `${path}.approved_by`),
    approval_authority: "product_truth_platform_owner_gate" as const,
    approval_method: "trusted_platform_record" as const,
    approval_sha256: sha256String(raw.approval_sha256, `${path}.approval_sha256`),
  };
  if (approval.revision_body_sha256 !== revisionBodySha) {
    throw new Error(`${path}.revision_body_sha256 does not bind the exact revision body`);
  }
  const approvalBody = {
    decision: approval.decision,
    revision_body_sha256: approval.revision_body_sha256,
    approved_at: approval.approved_at,
    approved_by: approval.approved_by,
    approval_authority: approval.approval_authority,
    approval_method: approval.approval_method,
  };
  if (catalogTruthCanonicalSha256(approvalBody) !== approval.approval_sha256) {
    throw new Error(`${path}.approval_sha256 does not match the canonical approval body`);
  }
  return approval;
}

function parseTruthRevision(
  raw: unknown,
  sku: string,
  itemId: string,
  path: string,
): ProductTruthWalmartRevision {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "revision_id", "body_sha256", "approval", "superseded_by_revision_id",
    "listing_kind", "category", "recipe", "structured_record", "proposed_truth",
    "source_evidence",
  ], path);
  const bodySha = sha256String(raw.body_sha256, `${path}.body_sha256`);
  if (catalogTruthCanonicalSha256(productTruthRevisionBody(raw)) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical revision body`);
  }

  // Reuse the authoritative strict parser for every nested truth field. The
  // placeholder title is never evaluated; it merely lets us validate a frozen
  // revision even when no exact buyer snapshot is available.
  const parsed = parseTruthPreflightInput({
    schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
    sku,
    item_id: itemId,
    listing_kind: raw.listing_kind,
    current_title: "Buyer title unavailable during revision parsing",
    current_title_source_ref_ids: [],
    recipe: raw.recipe,
    structured_record: raw.structured_record,
    proposed_truth: raw.proposed_truth,
    source_evidence: raw.source_evidence,
  });
  const supersededBy = nullableString(
    raw.superseded_by_revision_id,
    `${path}.superseded_by_revision_id`,
  );
  return {
    revision_id: requiredString(raw.revision_id, `${path}.revision_id`),
    body_sha256: bodySha,
    approval: parseApproval(raw.approval, bodySha, `${path}.approval`),
    superseded_by_revision_id: supersededBy,
    listing_kind: parsed.listing_kind,
    category: requiredString(raw.category, `${path}.category`),
    recipe: parsed.recipe,
    structured_record: parsed.structured_record,
    proposed_truth: parsed.proposed_truth,
    source_evidence: parsed.source_evidence,
  };
}

function parseProductTruthSnapshot(raw: unknown): ProductTruthWalmartAuditSnapshot {
  const path = "product truth snapshot";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "producer", "rows",
  ], path);
  if (raw.schema_version !== PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA}`);
  }
  if (raw.producer !== "shared_product_truth_platform") {
    throw new Error(`${path}.producer must be shared_product_truth_platform`);
  }
  if (!Array.isArray(raw.rows) || raw.rows.length > 100_000) {
    throw new Error(`${path}.rows must be an array with at most 100000 items`);
  }
  const bodySha = sha256String(raw.body_sha256, `${path}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    producer: raw.producer,
    rows: raw.rows,
  };
  if (catalogTruthCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical snapshot body`);
  }
  const snapshotId = requiredString(raw.snapshot_id, `${path}.snapshot_id`);
  if (snapshotId !== `product-truth-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.snapshot_id is not derived from body_sha256`);
  }

  const rows = raw.rows.map((entry, index): ProductTruthWalmartAuditRow => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(entry)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(entry, [
      "channel", "store_index", "sku", "listing_key", "item_id", "revision",
    ], rowPath);
    const identity = parseListingIdentity(entry, rowPath);
    const itemId = numericItemId(entry.item_id, `${rowPath}.item_id`);
    return {
      ...identity,
      item_id: itemId,
      revision: parseTruthRevision(
        entry.revision,
        identity.sku,
        itemId,
        `${rowPath}.revision`,
      ),
    };
  });
  assertUniqueIdentity(rows, `${path}.rows`);
  const revisionIds = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (revisionIds.has(row.revision.revision_id)) {
      throw new Error(`${path}.rows has duplicate revision_id ${row.revision.revision_id} at index ${index}`);
    }
    revisionIds.add(row.revision.revision_id);
  }
  return {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    snapshot_id: snapshotId,
    body_sha256: bodySha,
    captured_at: validCapturedAt(raw.captured_at, `${path}.captured_at`),
    producer: "shared_product_truth_platform",
    rows,
  };
}

function assertUniqueIdentity(
  rows: readonly Pick<WalmartListingIdentity, "listing_key">[],
  path: string,
): void {
  const listingKeys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (listingKeys.has(row.listing_key)) {
      throw new Error(`${path} has duplicate listing_key ${row.listing_key} at index ${index}`);
    }
    listingKeys.add(row.listing_key);
  }
}

function stringArray(value: unknown, path: string, min = 0, max = 500): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${path} must contain ${min}-${max} strings`);
  }
  const parsed = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} contains duplicates`);
  return parsed;
}

function httpsUrl(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${path} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${path} must use HTTPS`);
  return parsed;
}

function walmartImageUrl(value: unknown, path: string): string {
  const parsed = httpsUrl(value, path);
  const hostname = new URL(parsed).hostname.toLowerCase();
  if (hostname !== "walmartimages.com" && !hostname.endsWith(".walmartimages.com")) {
    throw new Error(`${path} must use a walmartimages.com host`);
  }
  return parsed;
}

function parseBuyerSnapshot(raw: unknown, path: string): SealedWalmartBuyerSnapshot {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "target", "identity",
    "source_contract", "payload_hashes", "assets",
  ], path);
  if (raw.schema_version !== SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA}`);
  }
  const bodySha = sha256String(raw.body_sha256, `${path}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    target: raw.target,
    identity: raw.identity,
    source_contract: raw.source_contract,
    payload_hashes: raw.payload_hashes,
    assets: raw.assets,
  };
  if (catalogTruthCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical buyer snapshot body`);
  }
  const capturedAt = validCapturedAt(raw.captured_at, `${path}.captured_at`);
  if (new Date(capturedAt).toISOString() !== capturedAt) {
    throw new Error(`${path}.captured_at must be the normalized UTC timestamp written by v3 capture`);
  }
  const safeStamp = capturedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const snapshotId = requiredString(raw.snapshot_id, `${path}.snapshot_id`);
  if (snapshotId !== `walmart-buyer-${safeStamp}-${bodySha.slice(0, 12)}`) {
    throw new Error(`${path}.snapshot_id is not derived from captured_at and body_sha256`);
  }

  if (!isRecord(raw.target)) throw new Error(`${path}.target must be an object`);
  // expected_title, stratum, expected, risk, and similar caller-derived fields
  // are intentionally rejected here rather than being copied into audit truth.
  assertExactKeys(raw.target, ["sku", "item_id"], `${path}.target`);
  const sku = requiredString(raw.target.sku, `${path}.target.sku`);
  const itemId = numericItemId(raw.target.item_id, `${path}.target.item_id`);

  if (!isRecord(raw.identity)) throw new Error(`${path}.identity must be an object`);
  assertExactKeys(raw.identity, [
    "exact_sku_match", "exact_item_id_match", "buyer_facing_verified", "seller",
    "catalog_search_candidate", "buyer", "chain_evidence",
  ], `${path}.identity`);
  exactBoolean(raw.identity.exact_sku_match, true, `${path}.identity.exact_sku_match`);
  exactBoolean(raw.identity.exact_item_id_match, true, `${path}.identity.exact_item_id_match`);
  exactBoolean(raw.identity.buyer_facing_verified, true, `${path}.identity.buyer_facing_verified`);

  if (!isRecord(raw.identity.seller)) throw new Error(`${path}.identity.seller must be an object`);
  assertExactKeys(raw.identity.seller, [
    "sku", "title", "upc", "gtin14", "wpid", "published_status", "lifecycle_status",
  ], `${path}.identity.seller`);
  if (requiredString(raw.identity.seller.sku, `${path}.identity.seller.sku`) !== sku) {
    throw new Error(`${path}.identity.seller.sku does not match target.sku`);
  }
  const sellerTitle = requiredString(raw.identity.seller.title, `${path}.identity.seller.title`);
  const upc = requiredString(raw.identity.seller.upc, `${path}.identity.seller.upc`);
  if (!/^\d+$/.test(upc) || ![8, 12, 13, 14].includes(upc.length)) {
    throw new Error(`${path}.identity.seller.upc is invalid`);
  }
  const gtin14 = requiredString(raw.identity.seller.gtin14, `${path}.identity.seller.gtin14`);
  if (!/^\d{14}$/.test(gtin14) || upc.padStart(14, "0") !== gtin14) {
    throw new Error(`${path}.identity.seller UPC/GTIN binding is invalid`);
  }
  if (raw.identity.seller.wpid !== null) {
    const wpid = requiredString(raw.identity.seller.wpid, `${path}.identity.seller.wpid`);
    if (wpid === itemId) throw new Error(`${path}.identity.seller.wpid must not be public itemId evidence`);
  }
  if (raw.identity.seller.published_status !== null) {
    requiredString(
      raw.identity.seller.published_status,
      `${path}.identity.seller.published_status`,
    );
  }
  if (raw.identity.seller.lifecycle_status !== null) {
    requiredString(
      raw.identity.seller.lifecycle_status,
      `${path}.identity.seller.lifecycle_status`,
    );
  }

  const candidate = raw.identity.catalog_search_candidate;
  if (!isRecord(candidate)) throw new Error(`${path}.identity.catalog_search_candidate must be an object`);
  assertExactKeys(candidate, [
    "item_id", "title", "main_image_url", "is_marketplace_item", "duplicate_rows_collapsed",
  ], `${path}.identity.catalog_search_candidate`);
  if (numericItemId(candidate.item_id, `${path}.identity.catalog_search_candidate.item_id`) !== itemId) {
    throw new Error(`${path}.identity.catalog_search_candidate.item_id does not match target.item_id`);
  }
  const candidateTitle = requiredString(
    candidate.title,
    `${path}.identity.catalog_search_candidate.title`,
  );
  if (candidateTitle !== sellerTitle) {
    throw new Error(`${path}.identity.catalog_search_candidate.title differs from seller title`);
  }
  walmartImageUrl(
    candidate.main_image_url,
    `${path}.identity.catalog_search_candidate.main_image_url`,
  );
  if (candidate.is_marketplace_item !== null && typeof candidate.is_marketplace_item !== "boolean") {
    throw new Error(`${path}.identity.catalog_search_candidate.is_marketplace_item is invalid`);
  }
  positiveInteger(
    candidate.duplicate_rows_collapsed,
    `${path}.identity.catalog_search_candidate.duplicate_rows_collapsed`,
  );

  const buyer = raw.identity.buyer;
  if (!isRecord(buyer)) throw new Error(`${path}.identity.buyer must be an object`);
  assertExactKeys(buyer, ["item_id", "title", "identity_evidence"], `${path}.identity.buyer`);
  if (numericItemId(buyer.item_id, `${path}.identity.buyer.item_id`) !== itemId) {
    throw new Error(`${path}.identity.buyer.item_id does not match target.item_id`);
  }
  requiredString(buyer.title, `${path}.identity.buyer.title`);
  const buyerEvidence = stringArray(
    buyer.identity_evidence,
    `${path}.identity.buyer.identity_evidence`,
    1,
  );
  if (!buyerEvidence.some((entry) => entry.endsWith(`=${itemId}`))) {
    throw new Error(`${path}.identity.buyer.identity_evidence does not bind target.item_id`);
  }

  const chain = raw.identity.chain_evidence;
  if (!isRecord(chain)) throw new Error(`${path}.identity.chain_evidence must be an object`);
  assertExactKeys(chain, ["seller_to_catalog", "catalog_to_buyer_pdp"], `${path}.identity.chain_evidence`);
  const sellerToCatalog = stringArray(
    chain.seller_to_catalog,
    `${path}.identity.chain_evidence.seller_to_catalog`,
    1,
  );
  const catalogToBuyer = stringArray(
    chain.catalog_to_buyer_pdp,
    `${path}.identity.chain_evidence.catalog_to_buyer_pdp`,
    1,
  );
  if (!sellerToCatalog.includes(`request.sku=${sku}`)
    || !sellerToCatalog.includes(`seller.normalized_gtin14=${gtin14}`)
    || !sellerToCatalog.includes(`catalog.unique_numeric_public_itemId=${itemId}`)) {
    throw new Error(`${path}.identity.chain_evidence does not prove exact seller/catalog binding`);
  }
  if (canonicalCatalogTruthJson(catalogToBuyer) !== canonicalCatalogTruthJson(buyerEvidence)) {
    throw new Error(`${path}.identity.chain_evidence.catalog_to_buyer_pdp differs from buyer evidence`);
  }

  if (!isRecord(raw.source_contract)) throw new Error(`${path}.source_contract must be an object`);
  assertExactKeys(raw.source_contract, [
    "seller", "candidate", "buyer", "positional_or_fuzzy_fallbacks", "database_writes",
    "walmart_writes", "r2_writes",
  ], `${path}.source_contract`);
  if (raw.source_contract.seller !== "walmart_marketplace_exact_sku_get"
    || raw.source_contract.candidate !== "walmart_catalog_search_exact_upc"
    || raw.source_contract.buyer !== "walmart_buyer_pdp_exact_item_get") {
    throw new Error(`${path}.source_contract does not describe the exact buyer chain`);
  }
  for (const field of [
    "positional_or_fuzzy_fallbacks", "database_writes", "walmart_writes", "r2_writes",
  ] as const) {
    if (raw.source_contract[field] !== 0) {
      throw new Error(`${path}.source_contract.${field} must be 0`);
    }
  }

  if (!isRecord(raw.payload_hashes)) throw new Error(`${path}.payload_hashes must be an object`);
  assertExactKeys(raw.payload_hashes, [
    "seller_payload_canonical_sha256", "catalog_search_payload_canonical_sha256",
    "resolution_canonical_sha256", "buyer_payload_canonical_sha256",
  ], `${path}.payload_hashes`);
  for (const field of [
    "seller_payload_canonical_sha256", "catalog_search_payload_canonical_sha256",
    "resolution_canonical_sha256", "buyer_payload_canonical_sha256",
  ] as const) {
    sha256String(raw.payload_hashes[field], `${path}.payload_hashes.${field}`);
  }

  if (!Array.isArray(raw.assets) || raw.assets.length < 1 || raw.assets.length > 100) {
    throw new Error(`${path}.assets must contain 1-100 sealed image manifests`);
  }
  const seenSlots = new Set<string>();
  for (const [index, asset] of raw.assets.entries()) {
    const assetPath = `${path}.assets[${index}]`;
    if (!isRecord(asset)) throw new Error(`${assetPath} must be an object`);
    assertExactKeys(asset, [
      "slot", "source_url", "final_url", "sha256", "bytes", "media_type", "extension",
      "decoded_format", "decoded_width", "decoded_height", "local_path",
    ], assetPath);
    const slot = requiredString(asset.slot, `${assetPath}.slot`);
    if (slot !== "MAIN" && !/^GALLERY_[1-9]\d*$/.test(slot)) {
      throw new Error(`${assetPath}.slot is unsupported`);
    }
    if (seenSlots.has(slot)) throw new Error(`${path}.assets has duplicate slot ${slot}`);
    seenSlots.add(slot);
    walmartImageUrl(asset.source_url, `${assetPath}.source_url`);
    walmartImageUrl(asset.final_url, `${assetPath}.final_url`);
    const digest = sha256String(asset.sha256, `${assetPath}.sha256`);
    positiveInteger(asset.bytes, `${assetPath}.bytes`);
    if (asset.media_type !== "image/jpeg"
      && asset.media_type !== "image/png"
      && asset.media_type !== "image/webp") {
      throw new Error(`${assetPath}.media_type is unsupported`);
    }
    if (asset.extension !== "jpg" && asset.extension !== "png" && asset.extension !== "webp") {
      throw new Error(`${assetPath}.extension is unsupported`);
    }
    const expectedFormat = asset.extension === "jpg" ? "jpeg" : asset.extension;
    if (asset.decoded_format !== expectedFormat) {
      throw new Error(`${assetPath}.decoded_format does not match extension`);
    }
    positiveInteger(asset.decoded_width, `${assetPath}.decoded_width`);
    positiveInteger(asset.decoded_height, `${assetPath}.decoded_height`);
    if (asset.local_path !== `assets/${digest}.${asset.extension}`) {
      throw new Error(`${assetPath}.local_path is not content-addressed`);
    }
  }
  if (!seenSlots.has("MAIN")) throw new Error(`${path}.assets has no MAIN image`);
  const expectedSlots = [
    "MAIN",
    ...Array.from({ length: raw.assets.length - 1 }, (_, index) => `GALLERY_${index + 1}`),
  ];
  if (canonicalCatalogTruthJson(raw.assets.map((asset) => (asset as JsonRecord).slot))
    !== canonicalCatalogTruthJson(expectedSlots)) {
    throw new Error(`${path}.assets must be ordered MAIN then contiguous gallery slots`);
  }

  return raw as unknown as SealedWalmartBuyerSnapshot;
}

function parseBuyerIndex(raw: unknown): WalmartBuyerSnapshotIndex {
  const path = "buyer snapshot index";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "index_id", "body_sha256", "captured_at", "entries",
  ], path);
  if (raw.schema_version !== WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA}`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length > 100_000) {
    throw new Error(`${path}.entries must be an array with at most 100000 items`);
  }
  const bodySha = sha256String(raw.body_sha256, `${path}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    entries: raw.entries,
  };
  if (catalogTruthCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical index body`);
  }
  const indexId = requiredString(raw.index_id, `${path}.index_id`);
  if (indexId !== `walmart-buyer-index-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.index_id is not derived from body_sha256`);
  }
  const entries = raw.entries.map((entry, index): WalmartBuyerSnapshotIndexEntry => {
    const entryPath = `${path}.entries[${index}]`;
    if (!isRecord(entry)) throw new Error(`${entryPath} must be an object`);
    assertExactKeys(entry, [
      "channel", "store_index", "sku", "listing_key", "item_id", "snapshot",
    ], entryPath);
    const identity = parseListingIdentity(entry, entryPath);
    const itemId = numericItemId(entry.item_id, `${entryPath}.item_id`);
    const snapshot = parseBuyerSnapshot(entry.snapshot, `${entryPath}.snapshot`);
    if (snapshot.target.sku !== identity.sku || snapshot.target.item_id !== itemId) {
      throw new Error(`${entryPath}.snapshot target does not match listing identity/item_id`);
    }
    return { ...identity, item_id: itemId, snapshot };
  });
  assertUniqueIdentity(entries, `${path}.entries`);
  const snapshotIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (snapshotIds.has(entry.snapshot.snapshot_id)) {
      throw new Error(
        `${path}.entries has duplicate snapshot_id ${entry.snapshot.snapshot_id} at index ${index}`,
      );
    }
    snapshotIds.add(entry.snapshot.snapshot_id);
  }
  return {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    index_id: indexId,
    body_sha256: bodySha,
    captured_at: validCapturedAt(raw.captured_at, `${path}.captured_at`),
    entries,
  };
}

function mainAssetSha(snapshot: SealedWalmartBuyerSnapshot): string {
  const main = snapshot.assets.filter((asset) => asset.slot === "MAIN");
  if (main.length !== 1) throw new Error(`${snapshot.snapshot_id} must contain exactly one MAIN asset`);
  return main[0]!.sha256;
}

function preflightDisposition(result: TruthPreflightResult): CatalogTruthAuditDisposition {
  if (result.status === "AUDITABLE") return "auditable";
  if (result.status === "TRUTH_REVIEW") return "truth_review";
  return "unsupported";
}

function unsealedCase(value: Omit<WalmartCatalogTruthAuditCase, "case_id">): Omit<WalmartCatalogTruthAuditCase, "case_id"> {
  return value;
}

function sealCase(
  value: Omit<WalmartCatalogTruthAuditCase, "case_id">,
): WalmartCatalogTruthAuditCase {
  const digest = catalogTruthCanonicalSha256(unsealedCase(value));
  return { case_id: `walmart-truth-case-${digest.slice(0, 20)}`, ...value };
}

function compileCase(
  row: ProductTruthWalmartAuditRow,
  exactBuyer: SealedWalmartBuyerSnapshot | null,
  bindingMismatch: boolean,
): WalmartCatalogTruthAuditCase {
  const compilerReasons: CatalogTruthCompilerReason[] = [];
  if (!row.revision.approval) compilerReasons.push("TRUTH_REVISION_UNAPPROVED");
  if (row.revision.superseded_by_revision_id) {
    compilerReasons.push("TRUTH_REVISION_SUPERSEDED");
  }
  if (bindingMismatch) compilerReasons.push("BUYER_BINDING_NOT_EXACT");
  else if (!exactBuyer) compilerReasons.push("BUYER_SNAPSHOT_MISSING");

  const publishedStatus = exactBuyer?.identity.seller.published_status ?? null;
  if (exactBuyer && publishedStatus !== "PUBLISHED") {
    compilerReasons.push("BUYER_LISTING_NOT_PUBLISHED");
  }
  const lifecycleStatus = exactBuyer?.identity.seller.lifecycle_status ?? null;
  if (exactBuyer && lifecycleStatus !== "ACTIVE") {
    compilerReasons.push("BUYER_LISTING_NOT_ACTIVE");
  }

  let preflight: TruthPreflightResult | null = null;
  if (row.revision.approval
    && !row.revision.superseded_by_revision_id
    && exactBuyer
    && !bindingMismatch) {
    const titleEvidenceRef = `buyer-title:${exactBuyer.snapshot_id}`;
    if (row.revision.source_evidence.some((source) => source.source_ref_id === titleEvidenceRef)) {
      throw new Error(`${row.sku}: truth evidence collides with compiler buyer-title evidence`);
    }
    preflight = preflightWalmartAuditTruth({
      schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
      sku: row.sku,
      item_id: row.item_id,
      listing_kind: row.revision.listing_kind,
      current_title: exactBuyer.identity.buyer.title,
      current_title_source_ref_ids: [titleEvidenceRef],
      recipe: row.revision.recipe,
      structured_record: row.revision.structured_record,
      proposed_truth: row.revision.proposed_truth,
      source_evidence: [
        ...row.revision.source_evidence,
        {
          source_ref_id: titleEvidenceRef,
          source_kind: "buyer_pdp",
          locator: `snapshot://${exactBuyer.snapshot_id}#buyer-pdp`,
          captured_at: exactBuyer.captured_at,
          payload_sha256: exactBuyer.payload_hashes.buyer_payload_canonical_sha256,
          supports: ["current_title"],
        },
      ],
    });
  }

  const disposition = compilerReasons.length > 0
    ? "truth_review"
    : preflight ? preflightDisposition(preflight) : "truth_review";
  const preflightSha = preflight ? catalogTruthCanonicalSha256(preflight) : null;
  return sealCase({
    channel: row.channel,
    store_index: row.store_index,
    sku: row.sku,
    listing_key: row.listing_key,
    item_id: row.item_id,
    category: row.revision.category,
    published_status: publishedStatus,
    lifecycle_status: lifecycleStatus,
    listing_kind: row.revision.listing_kind,
    recipe_composition: row.revision.recipe.composition,
    disposition,
    truth_revision: {
      revision_id: row.revision.revision_id,
      body_sha256: row.revision.body_sha256,
      approval_sha256: row.revision.approval?.approval_sha256 ?? null,
    },
    buyer_snapshot: exactBuyer ? {
      snapshot_id: exactBuyer.snapshot_id,
      body_sha256: exactBuyer.body_sha256,
      main_asset_sha256: mainAssetSha(exactBuyer),
    } : null,
    preflight,
    preflight_sha256: preflightSha,
    compiler_reasons: compilerReasons,
  });
}

function summarizeCases(cases: readonly WalmartCatalogTruthAuditCase[]) {
  return {
    total_cases: cases.length,
    auditable_cases: cases.filter((entry) => entry.disposition === "auditable").length,
    truth_review_cases: cases.filter((entry) => entry.disposition === "truth_review").length,
    unsupported_cases: cases.filter((entry) => entry.disposition === "unsupported").length,
  };
}

/**
 * Compile immutable audit cases. Both inputs are completely validated before
 * any case is returned, so a bad seal or duplicate identity cannot produce a
 * partially trusted export.
 */
export function compileWalmartCatalogTruthExport(
  rawTruthSnapshot: unknown,
  rawBuyerIndex: unknown,
): WalmartCatalogTruthAuditExport {
  const truthSnapshot = parseProductTruthSnapshot(rawTruthSnapshot);
  const buyerIndex = parseBuyerIndex(rawBuyerIndex);
  const buyerByListingKey = new Map(
    buyerIndex.entries.map((entry) => [entry.listing_key, entry]),
  );

  const cases = truthSnapshot.rows.map((row) => {
    const byListing = buyerByListingKey.get(row.listing_key) ?? null;
    const exact = byListing && byListing.item_id === row.item_id
      ? byListing.snapshot
      : null;
    const mismatch = !!byListing && byListing.item_id !== row.item_id;
    return compileCase(row, exact, mismatch);
  }).sort((left, right) => (
    compareCanonicalText(left.listing_key, right.listing_key)
      || compareCanonicalText(left.item_id, right.item_id)
  ));

  const body = {
    schema_version: WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
    product_truth_snapshot: {
      snapshot_id: truthSnapshot.snapshot_id,
      body_sha256: truthSnapshot.body_sha256,
      captured_at: truthSnapshot.captured_at,
    },
    buyer_index: {
      index_id: buyerIndex.index_id,
      body_sha256: buyerIndex.body_sha256,
      captured_at: buyerIndex.captured_at,
    },
    summary: summarizeCases(cases),
    cases,
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    export_id: `walmart-truth-audit-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function parseExportBinding(raw: unknown, type: "truth" | "buyer", path: string) {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const idField = type === "truth" ? "snapshot_id" : "index_id";
  assertExactKeys(raw, [idField, "body_sha256", "captured_at"], path);
  return {
    id: requiredString(raw[idField], `${path}.${idField}`),
    body_sha256: sha256String(raw.body_sha256, `${path}.body_sha256`),
    captured_at: validCapturedAt(raw.captured_at, `${path}.captured_at`),
  };
}

function parsePreflightResult(raw: unknown, path: string): TruthPreflightResult {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "status", "sku", "item_id", "input_sha256", "expected",
    "evidence_bindings", "reasons",
  ], path);
  if (raw.schema_version !== WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA}`);
  }
  if (raw.status !== "AUDITABLE" && raw.status !== "TRUTH_REVIEW" && raw.status !== "UNSUPPORTED") {
    throw new Error(`${path}.status is unsupported`);
  }
  requiredString(raw.sku, `${path}.sku`);
  numericItemId(raw.item_id, `${path}.item_id`);
  sha256String(raw.input_sha256, `${path}.input_sha256`);
  if (!Array.isArray(raw.evidence_bindings)) throw new Error(`${path}.evidence_bindings must be an array`);
  if (!Array.isArray(raw.reasons)) throw new Error(`${path}.reasons must be an array`);
  if (raw.status === "AUDITABLE" && raw.expected === null) {
    throw new Error(`${path}.expected must be present for AUDITABLE status`);
  }
  if (raw.status !== "AUDITABLE" && raw.expected !== null) {
    throw new Error(`${path}.expected must be null unless status is AUDITABLE`);
  }
  return raw as unknown as TruthPreflightResult;
}

function parseExportCase(raw: unknown, path: string): WalmartCatalogTruthAuditCase {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "case_id", "channel", "store_index", "sku", "listing_key", "item_id",
    "category", "published_status", "lifecycle_status", "listing_kind",
    "recipe_composition", "disposition", "truth_revision", "buyer_snapshot", "preflight",
    "preflight_sha256", "compiler_reasons",
  ], path);
  const identity = parseListingIdentity(raw, path);
  const sku = identity.sku;
  const itemId = numericItemId(raw.item_id, `${path}.item_id`);
  const category = requiredString(raw.category, `${path}.category`);
  const publishedStatus = nullableString(raw.published_status, `${path}.published_status`);
  const lifecycleStatus = nullableString(raw.lifecycle_status, `${path}.lifecycle_status`);
  if (raw.listing_kind !== "single" && raw.listing_kind !== "multipack"
    && raw.listing_kind !== "bundle" && raw.listing_kind !== "variety") {
    throw new Error(`${path}.listing_kind is unsupported`);
  }
  if (raw.recipe_composition !== "same_product" && raw.recipe_composition !== "mixed_bundle"
    && raw.recipe_composition !== "variety_pack") {
    throw new Error(`${path}.recipe_composition is unsupported`);
  }
  if (raw.disposition !== "auditable" && raw.disposition !== "truth_review"
    && raw.disposition !== "unsupported") {
    throw new Error(`${path}.disposition is unsupported`);
  }

  if (!isRecord(raw.truth_revision)) throw new Error(`${path}.truth_revision must be an object`);
  assertExactKeys(raw.truth_revision, [
    "revision_id", "body_sha256", "approval_sha256",
  ], `${path}.truth_revision`);
  const truthRevision = {
    revision_id: requiredString(raw.truth_revision.revision_id, `${path}.truth_revision.revision_id`),
    body_sha256: sha256String(raw.truth_revision.body_sha256, `${path}.truth_revision.body_sha256`),
    approval_sha256: raw.truth_revision.approval_sha256 === null
      ? null
      : sha256String(raw.truth_revision.approval_sha256, `${path}.truth_revision.approval_sha256`),
  };

  let buyerSnapshot: WalmartCatalogTruthAuditCase["buyer_snapshot"] = null;
  if (raw.buyer_snapshot !== null) {
    if (!isRecord(raw.buyer_snapshot)) throw new Error(`${path}.buyer_snapshot must be an object or null`);
    assertExactKeys(raw.buyer_snapshot, [
      "snapshot_id", "body_sha256", "main_asset_sha256",
    ], `${path}.buyer_snapshot`);
    buyerSnapshot = {
      snapshot_id: requiredString(raw.buyer_snapshot.snapshot_id, `${path}.buyer_snapshot.snapshot_id`),
      body_sha256: sha256String(raw.buyer_snapshot.body_sha256, `${path}.buyer_snapshot.body_sha256`),
      main_asset_sha256: sha256String(
        raw.buyer_snapshot.main_asset_sha256,
        `${path}.buyer_snapshot.main_asset_sha256`,
      ),
    };
  }

  const preflight = raw.preflight === null ? null : parsePreflightResult(raw.preflight, `${path}.preflight`);
  const preflightSha = raw.preflight_sha256 === null
    ? null
    : sha256String(raw.preflight_sha256, `${path}.preflight_sha256`);
  if ((preflight === null) !== (preflightSha === null)) {
    throw new Error(`${path}.preflight and preflight_sha256 must both be present or null`);
  }
  if (preflight && catalogTruthCanonicalSha256(preflight) !== preflightSha) {
    throw new Error(`${path}.preflight_sha256 does not match preflight`);
  }
  if (preflight && (preflight.sku !== sku || preflight.item_id !== itemId)) {
    throw new Error(`${path}.preflight identity does not match the case`);
  }

  if (!Array.isArray(raw.compiler_reasons) || raw.compiler_reasons.length > 6) {
    throw new Error(`${path}.compiler_reasons must be an array with at most 6 items`);
  }
  const allowedReasons = new Set<CatalogTruthCompilerReason>([
    "TRUTH_REVISION_UNAPPROVED", "TRUTH_REVISION_SUPERSEDED", "BUYER_SNAPSHOT_MISSING",
    "BUYER_BINDING_NOT_EXACT", "BUYER_LISTING_NOT_PUBLISHED", "BUYER_LISTING_NOT_ACTIVE",
  ]);
  const compilerReasons = raw.compiler_reasons.map((reason, index) => {
    if (typeof reason !== "string" || !allowedReasons.has(reason as CatalogTruthCompilerReason)) {
      throw new Error(`${path}.compiler_reasons[${index}] is unsupported`);
    }
    return reason as CatalogTruthCompilerReason;
  });
  if (new Set(compilerReasons).size !== compilerReasons.length) {
    throw new Error(`${path}.compiler_reasons contains duplicates`);
  }
  const expectedDisposition = compilerReasons.length > 0
    ? "truth_review"
    : preflight ? preflightDisposition(preflight) : "truth_review";
  if (raw.disposition !== expectedDisposition) {
    throw new Error(`${path}.disposition does not match compiler/preflight evidence`);
  }
  if (!preflight && compilerReasons.length === 0) {
    throw new Error(`${path} has neither preflight evidence nor a compiler review reason`);
  }
  if (raw.disposition === "auditable") {
    if (!truthRevision.approval_sha256 || !buyerSnapshot
      || publishedStatus !== "PUBLISHED" || lifecycleStatus !== "ACTIVE") {
      throw new Error(
        `${path} auditable case lacks approved truth, buyer snapshot, PUBLISHED status, or ACTIVE lifecycle`,
      );
    }
    if (raw.recipe_composition !== "same_product"
      || (raw.listing_kind !== "single" && raw.listing_kind !== "multipack")) {
      throw new Error(`${path} auditable case is outside the current comparator contract`);
    }
  }

  const parsedWithoutId = {
    ...identity,
    item_id: itemId,
    category,
    published_status: publishedStatus,
    lifecycle_status: lifecycleStatus,
    listing_kind: raw.listing_kind,
    recipe_composition: raw.recipe_composition,
    disposition: raw.disposition,
    truth_revision: truthRevision,
    buyer_snapshot: buyerSnapshot,
    preflight,
    preflight_sha256: preflightSha,
    compiler_reasons: compilerReasons,
  } satisfies Omit<WalmartCatalogTruthAuditCase, "case_id">;
  const expectedCaseId = `walmart-truth-case-${catalogTruthCanonicalSha256(parsedWithoutId).slice(0, 20)}`;
  const caseId = requiredString(raw.case_id, `${path}.case_id`);
  if (caseId !== expectedCaseId) throw new Error(`${path}.case_id does not match the canonical case body`);
  return { case_id: caseId, ...parsedWithoutId };
}

/** Strictly verify a compiled artifact before another consumer uses it. */
export function verifyWalmartCatalogTruthAuditExport(raw: unknown): WalmartCatalogTruthAuditExport {
  const path = "catalog truth audit export";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "export_id", "body_sha256", "product_truth_snapshot", "buyer_index",
    "summary", "cases",
  ], path);
  if (raw.schema_version !== WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA}`);
  }
  const truthBinding = parseExportBinding(
    raw.product_truth_snapshot,
    "truth",
    `${path}.product_truth_snapshot`,
  );
  const buyerBinding = parseExportBinding(raw.buyer_index, "buyer", `${path}.buyer_index`);
  if (!Array.isArray(raw.cases) || raw.cases.length > 100_000) {
    throw new Error(`${path}.cases must be an array with at most 100000 items`);
  }
  const cases = raw.cases.map((entry, index) => parseExportCase(entry, `${path}.cases[${index}]`));
  assertUniqueIdentity(cases, `${path}.cases`);
  const sorted = [...cases].sort((left, right) => (
    compareCanonicalText(left.listing_key, right.listing_key)
      || compareCanonicalText(left.item_id, right.item_id)
  ));
  if (canonicalCatalogTruthJson(cases.map((entry) => entry.case_id))
    !== canonicalCatalogTruthJson(sorted.map((entry) => entry.case_id))) {
    throw new Error(`${path}.cases are not in canonical listing_key/item_id order`);
  }

  if (!isRecord(raw.summary)) throw new Error(`${path}.summary must be an object`);
  assertExactKeys(raw.summary, [
    "total_cases", "auditable_cases", "truth_review_cases", "unsupported_cases",
  ], `${path}.summary`);
  const suppliedSummary = {
    total_cases: nonNegativeInteger(raw.summary.total_cases, `${path}.summary.total_cases`),
    auditable_cases: nonNegativeInteger(raw.summary.auditable_cases, `${path}.summary.auditable_cases`),
    truth_review_cases: nonNegativeInteger(
      raw.summary.truth_review_cases,
      `${path}.summary.truth_review_cases`,
    ),
    unsupported_cases: nonNegativeInteger(
      raw.summary.unsupported_cases,
      `${path}.summary.unsupported_cases`,
    ),
  };
  if (canonicalCatalogTruthJson(suppliedSummary) !== canonicalCatalogTruthJson(summarizeCases(cases))) {
    throw new Error(`${path}.summary does not match cases`);
  }

  const parsedBody = {
    schema_version: WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
    product_truth_snapshot: {
      snapshot_id: truthBinding.id,
      body_sha256: truthBinding.body_sha256,
      captured_at: truthBinding.captured_at,
    },
    buyer_index: {
      index_id: buyerBinding.id,
      body_sha256: buyerBinding.body_sha256,
      captured_at: buyerBinding.captured_at,
    },
    summary: suppliedSummary,
    cases,
  };
  const bodySha = sha256String(raw.body_sha256, `${path}.body_sha256`);
  if (catalogTruthCanonicalSha256(parsedBody) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match the canonical export body`);
  }
  const exportId = requiredString(raw.export_id, `${path}.export_id`);
  if (exportId !== `walmart-truth-audit-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.export_id is not derived from body_sha256`);
  }
  return { ...parsedBody, export_id: exportId, body_sha256: bodySha };
}

/**
 * Source-aware verification required before execution or selection.
 *
 * A SHA-256 body seal proves integrity relative to itself, not that an
 * attacker did not replace a result and recompute every unsigned seal. This
 * verifier revalidates both trusted frozen inputs, deterministically recompiles
 * the export, and requires byte-equivalent canonical content. Downstream
 * Shadow/audit consumers should use this function rather than trusting the
 * self-seal verifier alone.
 */
export function verifyWalmartCatalogTruthAuditExportAgainstSources(
  rawExport: unknown,
  rawTruthSnapshot: unknown,
  rawBuyerIndex: unknown,
): WalmartCatalogTruthAuditExport {
  const verified = verifyWalmartCatalogTruthAuditExport(rawExport);
  const recompiled = compileWalmartCatalogTruthExport(rawTruthSnapshot, rawBuyerIndex);
  if (canonicalCatalogTruthJson(verified) !== canonicalCatalogTruthJson(recompiled)) {
    throw new Error(
      "catalog truth audit export does not exactly match deterministic compilation from trusted sources",
    );
  }
  return verified;
}
