/**
 * Pure Walmart-native MP_MAINTENANCE request builder for one existing listing.
 *
 * Security boundary:
 *  - the full repair target remains a post-write QA reference;
 *  - only fields proven changed against the exact baseline are emitted;
 *  - audit claims never become Walmart keys or values by convention;
 *  - every attribute write needs an explicit, plan-bound schema mapping;
 *  - exact raw Get Spec request/response evidence is re-hashed and the final
 *    payload is validated against the extracted MP_MAINTENANCE schema;
 *  - payload and pre-sign request manifest use canonical bytes and hashes.
 *
 * This module performs zero network, model, database, or marketplace calls.
 */

import { createHash } from "node:crypto";

import Ajv from "ajv";

import { WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION } from
  "../bundle-factory/validation/walmart-prepublication-policy.ts";
import {
  walmartListingIntegritySha256,
  type ListingAttributeClaim,
  type WalmartListingSurface,
} from "./listing-integrity-audit.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
  type WalmartListingRepairTargetImage,
} from "./listing-integrity-remediation-qualification.ts";

export const WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA =
  "walmart-listing-integrity-surgical-get-spec-receipt/v1" as const;
export const WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA =
  "walmart-listing-integrity-surgical-live-item-receipt/v1" as const;
export const WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA =
  "walmart-listing-integrity-surgical-schema-contract/v1" as const;
export const WALMART_LISTING_SURGICAL_REQUEST_MANIFEST_SCHEMA =
  "walmart-listing-repair-surgical-request-manifest/v1" as const;
export const WALMART_LISTING_SURGICAL_VALIDATION_SCHEMA =
  "walmart-listing-integrity-surgical-validation/v1" as const;

export const WALMART_LISTING_SURGICAL_MAX_SPEC_AGE_MS = 30 * 60 * 1_000;
export const WALMART_LISTING_SURGICAL_MAX_LIVE_ITEM_AGE_MS = 30 * 60 * 1_000;
export const WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION =
  WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const SPEC_VERSION = /^5\.0\.\d{8}-\d{2}_\d{2}_\d{2}-api$/u;
const VISIBLE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const MAX_EXACT_BYTES = 64 * 1024 * 1024;
const FIELD_ORDER = Object.freeze([
  "title", "description", "bullets", "attributes", "main", "gallery",
] as const);
const CORE_VISIBLE_FIELDS = Object.freeze({
  title: "productName",
  description: "shortDescription",
  bullets: "keyFeatures",
  main: "mainImageUrl",
  gallery: "productSecondaryImageURL",
} as const);
function normalizedField(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}
const FORBIDDEN_VISIBLE_FIELDS = new Set([
  "brand",
  "price",
  "msrp",
  "sku",
  "upc",
  "gtin",
  "ean",
  "isbn",
  "productIdentifiers",
  "specProductType",
  "inventory",
  "ShippingWeight",
  "countryOfOriginSubstantialTransformation",
  "productPackageDimensionsAndWeight",
].map(normalizedField));
const CORE_VISIBLE_FIELD_KEYS = new Set(
  Object.values(CORE_VISIBLE_FIELDS).map(normalizedField),
);
const PRESERVED_BY_OMISSION = Object.freeze([
  "brand",
  "price",
  "inventory",
  "shipping_weight_and_dimensions",
  "country_of_origin",
  "fulfillment",
  "all_unapproved_visible_attributes",
] as const);

type RepairField = typeof FIELD_ORDER[number];
type JsonRecord = Record<string, unknown>;
export type WalmartListingSurgicalJsonValue =
  | null
  | boolean
  | number
  | string
  | WalmartListingSurgicalJsonValue[]
  | { [key: string]: WalmartListingSurgicalJsonValue };

export type WalmartListingSurgicalProductIdentifier =
  | { productIdType: "UPC"; productId: string }
  | { productIdType: "GTIN"; productId: string }
  | { productIdType: "EAN"; productId: string }
  | { productIdType: "ISBN"; productId: string };

export interface WalmartListingSurgicalGetSpecReceipt {
  schema_version: typeof WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA;
  method: "POST";
  path: "/v3/items/spec";
  request_content_type: "application/json";
  response_content_type: "application/json";
  http_status: 200;
  correlation_id_sha256: string;
  seller_account_fingerprint_sha256: string;
  request_payload_sha256: string;
  response_payload_sha256: string;
  fetched_at: string;
  body_sha256: string;
}

export interface WalmartListingSurgicalLiveItemReceipt {
  schema_version: typeof WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA;
  method: "GET";
  path: string;
  response_content_type: "application/json";
  http_status: 200;
  correlation_id_sha256: string;
  seller_account_fingerprint_sha256: string;
  response_payload_sha256: string;
  captured_at: string;
  body_sha256: string;
}

export interface WalmartListingSurgicalAttributeMapping {
  /** Exact source claim identity. It is a binding only, never a Walmart key. */
  source_field_path: string;
  source_kind: ListingAttributeClaim["kind"];
  source_claim_sha256: string;
  /** Explicit approved top-level key under Visible[productType]. */
  walmart_visible_field: string;
  /** Explicit approved value. It is never derived from the audit claim. */
  walmart_value: Exclude<WalmartListingSurgicalJsonValue, null>;
  walmart_value_sha256: string;
}

export interface WalmartListingSurgicalSchemaContract {
  schema_version: typeof WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA;
  contract_id: string;
  plan_id: string;
  plan_body_sha256: string;
  target_sha256: string;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
    product_identifier: WalmartListingSurgicalProductIdentifier;
    product_type: string;
    live_item_capture_sha256: string;
    live_item_receipt_body_sha256: string;
    live_item_captured_at: string;
  };
  spec: {
    feed_type: "MP_MAINTENANCE";
    business_unit: "WALMART_US";
    locale: "en";
    version: string;
    product_type: string;
    request_payload_sha256: string;
    response_payload_sha256: string;
    schema_sha256: string;
    get_spec_receipt_body_sha256: string;
    valid_until: string;
  };
  schema_mapping_approval_sha256: string;
  attribute_mappings: WalmartListingSurgicalAttributeMapping[];
  claims: {
    exact_one_sku: true;
    changed_fields_only: true;
    full_target_is_qa_reference_only: true;
    audit_claims_are_not_write_schema: true;
    blank_or_null_clear_forbidden: true;
    preserve_unapproved_fields_by_omission: true;
    retries: 0;
    redirects: 0;
  };
  body_sha256: string;
}

export interface WalmartListingSurgicalBaselineReference {
  surface: WalmartListingSurface;
  images: WalmartListingRepairTargetImage[];
}

export interface WalmartListingSurgicalRequestInput {
  permit_id: string;
  seller_account_fingerprint_sha256: string;
  request_correlation_id_sha256: string;
  prepared_at: string;
}

export interface WalmartListingSurgicalRequestManifest {
  schema_version: typeof WALMART_LISTING_SURGICAL_REQUEST_MANIFEST_SCHEMA;
  method: "POST";
  path: "/v3/feeds";
  feed_type: "MP_MAINTENANCE";
  store_index: number;
  seller_account_fingerprint_sha256: string;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  native_identity: {
    product_identifier: WalmartListingSurgicalProductIdentifier;
    product_type: string;
    live_item_response_payload_sha256: string;
    live_item_receipt_body_sha256: string;
  };
  plan_id: string;
  plan_body_sha256: string;
  target_sha256: string;
  permit_id: string;
  apply_engine_release_sha256: string;
  schema_contract_body_sha256: string;
  schema_mapping_approval_sha256: string;
  get_spec: {
    request_payload_sha256: string;
    response_payload_sha256: string;
    schema_sha256: string;
    receipt_body_sha256: string;
    version: string;
    product_type: string;
    product_identifier: WalmartListingSurgicalProductIdentifier;
  };
  transport: {
    query: { feedType: "MP_MAINTENANCE" };
    multipart: {
      field_name: "file";
      filename: string;
      content_type: "application/json";
    };
    retries: 0;
    redirects: 0;
  };
  changed_fields: RepairField[];
  visible_fields: string[];
  full_target_written: false;
  request_correlation_id_sha256: string;
  request_payload_sha256: string;
  prepared_at: string;
  body_sha256: string;
}

export interface WalmartListingSurgicalValidation {
  schema_version: typeof WALMART_LISTING_SURGICAL_VALIDATION_SCHEMA;
  valid: true;
  status: "PASSED";
  exact_listing_count: 1;
  feed_type: "MP_MAINTENANCE";
  exact_item_count: 1;
  changed_fields_recomputed: true;
  full_target_written: false;
  schema_contract_body_sha256: string;
  schema_mapping_approval_sha256: string;
  get_spec_receipt_body_sha256: string;
  get_spec_request_payload_sha256: string;
  get_spec_response_payload_sha256: string;
  get_spec_schema_sha256: string;
  live_item_response_payload_sha256: string;
  live_item_receipt_body_sha256: string;
  spec_version: string;
  product_type: string;
  product_identifier: WalmartListingSurgicalProductIdentifier;
  changed_fields: RepairField[];
  visible_fields: string[];
  preserved_by_omission: readonly string[];
  retries: 0;
  redirects: 0;
  network_calls: 0;
  model_calls: 0;
  database_writes: 0;
  marketplace_writes: 0;
}

export interface BuiltWalmartListingSurgicalRequest {
  payload: Readonly<JsonRecord>;
  payload_json: string;
  payload_bytes: Uint8Array;
  payload_sha256: string;
  /** Exact multipart filename frozen inside request_manifest.transport. */
  filename: string;
  request_manifest: Readonly<WalmartListingSurgicalRequestManifest>;
  request_manifest_json: string;
  request_manifest_bytes: Uint8Array;
  request_manifest_sha256: string;
  validation: Readonly<WalmartListingSurgicalValidation>;
}

export class WalmartListingSurgicalPayloadError extends Error {
  readonly code = "WALMART_LISTING_SURGICAL_PAYLOAD_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "WalmartListingSurgicalPayloadError";
  }
}

function fail(message: string): never {
  throw new WalmartListingSurgicalPayloadError(message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys are invalid`);
  }
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = text(value, label, 200);
  if (!SAFE_ID.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail(`${label} must be a safe identifier`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) {
    fail(`${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function jsonValue(value: unknown, label: string, depth = 0): WalmartListingSurgicalJsonValue {
  if (depth > 20) fail(`${label} exceeds maximum JSON depth`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, WalmartListingSurgicalJsonValue> = {};
    for (const key of Object.keys(value as JsonRecord).sort()) {
      if (!key || /[\u0000-\u001f\u007f]/u.test(key)) fail(`${label} has an invalid key`);
      output[key] = jsonValue((value as JsonRecord)[key], `${label}.${key}`, depth + 1);
    }
    return output;
  }
  fail(`${label} is not JSON-safe`);
}

function nonBlankWriteValue(
  value: unknown,
  label: string,
): Exclude<WalmartListingSurgicalJsonValue, null> {
  const parsed = jsonValue(value, label);
  if (parsed === null) fail(`${label} cannot be null because blank means no change`);
  if (typeof parsed === "string" && parsed.trim().length === 0) {
    fail(`${label} cannot be blank because blank means no change`);
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    fail(`${label} cannot be an empty array because clear semantics are not approved`);
  }
  if (typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(parsed).length === 0) {
    fail(`${label} cannot be an empty object because clear semantics are not approved`);
  }
  return parsed;
}

function canonicalValue(value: unknown): WalmartListingSurgicalJsonValue {
  return jsonValue(value, "canonical JSON");
}

export function canonicalWalmartListingSurgicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function walmartListingSurgicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalWalmartListingSurgicalJson(value)).digest("hex");
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): { json: string; bytes: Uint8Array; sha256: string } {
  const json = canonicalWalmartListingSurgicalJson(value);
  const bytes = Buffer.from(json, "utf8");
  return { json, bytes, sha256: bytesSha256(bytes) };
}

function exactBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > MAX_EXACT_BYTES) {
    fail(`${label} must be bounded non-empty exact bytes`);
  }
  return Buffer.from(value);
}

function parseJsonBytes(value: Uint8Array, label: string): unknown {
  const raw = exactBytes(value, label);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
  if (decoded.charCodeAt(0) === 0xfeff) fail(`${label} must not contain a UTF-8 BOM`);
  try {
    return JSON.parse(decoded);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
}

function assertCanonicalInputBytes(value: Uint8Array, parsed: unknown, label: string): void {
  if (!Buffer.from(value).equals(Buffer.from(canonicalWalmartListingSurgicalJson(parsed), "utf8"))) {
    fail(`${label} must use exact canonical JSON bytes`);
  }
}

function verifySeal(value: JsonRecord, label: string): string {
  const claimed = digest(value.body_sha256, `${label}.body_sha256`);
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingSurgicalSha256(body) !== claimed) fail(`${label} body SHA mismatch`);
  return claimed;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return walmartListingSurgicalSha256(left) === walmartListingSurgicalSha256(right);
}

function productIdentifier(value: unknown, label: string): WalmartListingSurgicalProductIdentifier {
  const raw = record(value, label);
  exactKeys(raw, ["productIdType", "productId"], label);
  const productId = text(raw.productId, `${label}.productId`, 64);
  if (raw.productIdType === "UPC" && /^\d{12}$/u.test(productId)) {
    return { productIdType: "UPC", productId };
  }
  if (raw.productIdType === "GTIN" && /^\d{14}$/u.test(productId)) {
    return { productIdType: "GTIN", productId };
  }
  if (raw.productIdType === "EAN" && /^\d{13}$/u.test(productId)) {
    return { productIdType: "EAN", productId };
  }
  if (raw.productIdType === "ISBN"
    && (/^\d{13}$/u.test(productId) || /^\d{9}[\dX]$/u.test(productId))) {
    return { productIdType: "ISBN", productId };
  }
  fail(`${label} must be an exact supported UPC/GTIN/EAN/ISBN identifier`);
}

function publicImageUrl(value: unknown, label: string): string {
  const parsed = text(value, label, 10_000);
  let url: URL;
  try { url = new URL(parsed); } catch { fail(`${label} must be a valid URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail(`${label} must be a stable public HTTPS URL without credentials/query/fragment`);
  }
  return parsed;
}

function assertImages(value: unknown, label: string): WalmartListingRepairTargetImage[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) {
    fail(`${label} must contain MAIN and at least one gallery image`);
  }
  const rows = value.map((entry, index) => {
    const raw = record(entry, `${label}[${index}]`);
    exactKeys(raw, ["slot", "source_url", "sha256"], `${label}[${index}]`);
    const slot = index === 0 ? "main" : `gallery-${index}`;
    if (raw.slot !== slot) fail(`${label} must use exact contiguous image ordering`);
    return {
      slot,
      source_url: publicImageUrl(raw.source_url, `${label}[${index}].source_url`),
      sha256: digest(raw.sha256, `${label}[${index}].sha256`),
    } as WalmartListingRepairTargetImage;
  });
  if (new Set(rows.map((row) => row.source_url)).size !== rows.length
    || new Set(rows.map((row) => row.sha256)).size !== rows.length) {
    fail(`${label} must not repeat image URLs or exact image bytes`);
  }
  return rows;
}

function assertPlan(plan: SealedWalmartListingRepairPlan): void {
  const raw = record(plan, "repair plan");
  if (raw.schema_version !== WALMART_LISTING_REPAIR_PLAN_SCHEMA) {
    fail("repair plan schema is invalid");
  }
  verifySeal(raw, "repair plan");
  if (plan.target.target_sha256 !== walmartListingIntegritySha256({
    surface: plan.target.surface,
    images: plan.target.images,
  })) {
    fail("repair plan target SHA mismatch");
  }
  if (plan.execution_policy.exact_listing_count !== 1
    || plan.execution_policy.max_marketplace_write_calls !== 1
    || plan.execution_policy.mass_apply_allowed !== false
    || plan.execution_policy.automatic_reapply_allowed !== false) {
    fail("repair plan does not authorize an exact one-SKU non-replay boundary");
  }
}

function changedFields(
  baseline: WalmartListingSurgicalBaselineReference,
  target: SealedWalmartListingRepairPlan["target"],
): RepairField[] {
  const changed = new Set<RepairField>();
  if (!canonicalEqual(baseline.surface.title, target.surface.title)) changed.add("title");
  if (!canonicalEqual(baseline.surface.description, target.surface.description)) {
    changed.add("description");
  }
  if (!canonicalEqual(baseline.surface.bullets, target.surface.bullets)) changed.add("bullets");
  if (!canonicalEqual(
    [baseline.surface.attribute_claims, baseline.surface.unmapped_attributes],
    [target.surface.attribute_claims, target.surface.unmapped_attributes],
  )) changed.add("attributes");
  if (!canonicalEqual(baseline.images[0], target.images[0])) changed.add("main");
  if (!canonicalEqual(baseline.images.slice(1), target.images.slice(1))) changed.add("gallery");
  return FIELD_ORDER.filter((field) => changed.has(field));
}

function claimKey(claim: ListingAttributeClaim): string {
  return `${claim.field_path}\u0000${claim.kind}`;
}

function claimMap(
  claims: readonly ListingAttributeClaim[],
  label: string,
): Map<string, ListingAttributeClaim> {
  const output = new Map<string, ListingAttributeClaim>();
  for (const claim of claims) {
    const key = claimKey(claim);
    if (output.has(key)) fail(`${label} contains duplicate field_path/kind`);
    output.set(key, claim);
  }
  return output;
}

function changedTargetClaims(
  baseline: WalmartListingSurface,
  target: WalmartListingSurface,
): Map<string, ListingAttributeClaim> {
  if (target.unmapped_attributes.length !== 0) {
    fail("repair target cannot write unresolved/unmapped attributes");
  }
  if (baseline.unmapped_attributes.length !== 0) {
    fail("removing opaque baseline attributes is unsupported without clear semantics");
  }
  const before = claimMap(baseline.attribute_claims, "baseline attribute claims");
  const after = claimMap(target.attribute_claims, "target attribute claims");
  for (const key of before.keys()) {
    if (!after.has(key)) {
      fail("removing an existing attribute is unsupported without an explicit clear contract");
    }
  }
  const changed = new Map<string, ListingAttributeClaim>();
  for (const [key, claim] of after) {
    const prior = before.get(key);
    if (!prior || !canonicalEqual(prior, claim)) changed.set(key, claim);
  }
  return changed;
}

function parseReceipt(value: unknown): WalmartListingSurgicalGetSpecReceipt {
  const raw = record(value, "Get Spec receipt");
  exactKeys(raw, [
    "schema_version", "method", "path", "request_content_type",
    "response_content_type", "http_status", "correlation_id_sha256",
    "seller_account_fingerprint_sha256", "request_payload_sha256",
    "response_payload_sha256", "fetched_at", "body_sha256",
  ], "Get Spec receipt");
  if (raw.schema_version !== WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA
    || raw.method !== "POST" || raw.path !== "/v3/items/spec"
    || raw.request_content_type !== "application/json"
    || raw.response_content_type !== "application/json" || raw.http_status !== 200) {
    fail("Get Spec receipt route/content/status is invalid");
  }
  verifySeal(raw, "Get Spec receipt");
  return {
    schema_version: WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
    method: "POST",
    path: "/v3/items/spec",
    request_content_type: "application/json",
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: digest(raw.correlation_id_sha256, "Get Spec correlation SHA"),
    seller_account_fingerprint_sha256: digest(
      raw.seller_account_fingerprint_sha256,
      "Get Spec seller account fingerprint",
    ),
    request_payload_sha256: digest(raw.request_payload_sha256, "Get Spec request SHA"),
    response_payload_sha256: digest(raw.response_payload_sha256, "Get Spec response SHA"),
    fetched_at: instant(raw.fetched_at, "Get Spec fetched_at"),
    body_sha256: digest(raw.body_sha256, "Get Spec receipt body SHA"),
  };
}

function parseLiveItemReceipt(
  value: unknown,
  sku: string,
): WalmartListingSurgicalLiveItemReceipt {
  const raw = record(value, "live item receipt");
  exactKeys(raw, [
    "schema_version", "method", "path", "response_content_type", "http_status",
    "correlation_id_sha256", "seller_account_fingerprint_sha256",
    "response_payload_sha256", "captured_at", "body_sha256",
  ], "live item receipt");
  const expectedPath = `/v3/items/${encodeURIComponent(sku)}`;
  if (raw.schema_version !== WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA
    || raw.method !== "GET" || raw.path !== expectedPath
    || raw.response_content_type !== "application/json" || raw.http_status !== 200) {
    fail("live item receipt route/content/status is invalid");
  }
  verifySeal(raw, "live item receipt");
  return {
    schema_version: WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
    method: "GET",
    path: expectedPath,
    response_content_type: "application/json",
    http_status: 200,
    correlation_id_sha256: digest(
      raw.correlation_id_sha256,
      "live item correlation SHA",
    ),
    seller_account_fingerprint_sha256: digest(
      raw.seller_account_fingerprint_sha256,
      "live item seller account fingerprint",
    ),
    response_payload_sha256: digest(
      raw.response_payload_sha256,
      "live item response SHA",
    ),
    captured_at: instant(raw.captured_at, "live item captured_at"),
    body_sha256: digest(raw.body_sha256, "live item receipt body SHA"),
  };
}

function parseSchemaContract(value: unknown): WalmartListingSurgicalSchemaContract {
  const raw = record(value, "schema contract");
  exactKeys(raw, [
    "schema_version", "contract_id", "plan_id", "plan_body_sha256", "target_sha256",
    "listing", "spec", "schema_mapping_approval_sha256", "attribute_mappings",
    "claims", "body_sha256",
  ], "schema contract");
  if (raw.schema_version !== WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA) {
    fail("schema contract version is invalid");
  }
  verifySeal(raw, "schema contract");
  const listing = record(raw.listing, "schema contract listing");
  exactKeys(listing, [
    "channel", "store_index", "sku", "listing_key", "item_id", "product_identifier",
    "product_type", "live_item_capture_sha256", "live_item_receipt_body_sha256",
    "live_item_captured_at",
  ], "schema contract listing");
  if (listing.channel !== "WALMART_US") fail("schema contract listing channel is invalid");
  const spec = record(raw.spec, "schema contract spec");
  exactKeys(spec, [
    "feed_type", "business_unit", "locale", "version", "product_type",
    "request_payload_sha256", "response_payload_sha256", "schema_sha256",
    "get_spec_receipt_body_sha256", "valid_until",
  ], "schema contract spec");
  if (spec.feed_type !== "MP_MAINTENANCE" || spec.business_unit !== "WALMART_US"
    || spec.locale !== "en" || typeof spec.version !== "string"
    || !SPEC_VERSION.test(spec.version)
    || spec.version !== WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION) {
    fail("schema contract is not bound to the configured current MP_MAINTENANCE spec");
  }
  const productType = text(listing.product_type, "schema contract product_type", 512);
  if (text(spec.product_type, "schema contract spec.product_type", 512) !== productType) {
    fail("schema contract listing/spec product type mismatch");
  }
  const claims = record(raw.claims, "schema contract claims");
  exactKeys(claims, [
    "exact_one_sku", "changed_fields_only", "full_target_is_qa_reference_only",
    "audit_claims_are_not_write_schema", "blank_or_null_clear_forbidden",
    "preserve_unapproved_fields_by_omission", "retries", "redirects",
  ], "schema contract claims");
  if (claims.exact_one_sku !== true || claims.changed_fields_only !== true
    || claims.full_target_is_qa_reference_only !== true
    || claims.audit_claims_are_not_write_schema !== true
    || claims.blank_or_null_clear_forbidden !== true
    || claims.preserve_unapproved_fields_by_omission !== true
    || claims.retries !== 0 || claims.redirects !== 0) {
    fail("schema contract safety claims are invalid");
  }
  if (!Array.isArray(raw.attribute_mappings) || raw.attribute_mappings.length > 500) {
    fail("schema contract attribute_mappings must be a bounded array");
  }
  const mappings = raw.attribute_mappings.map((entry, index) => {
    const mapping = record(entry, `attribute_mappings[${index}]`);
    exactKeys(mapping, [
      "source_field_path", "source_kind", "source_claim_sha256",
      "walmart_visible_field", "walmart_value", "walmart_value_sha256",
    ], `attribute_mappings[${index}]`);
    const field = text(mapping.walmart_visible_field, `attribute_mappings[${index}].field`, 128);
    const normalized = normalizedField(field);
    if (!VISIBLE_FIELD.test(field) || FORBIDDEN_VISIBLE_FIELDS.has(normalized)
      || CORE_VISIBLE_FIELD_KEYS.has(normalized)) {
      fail(`attribute_mappings[${index}] targets a reserved/forbidden Walmart field`);
    }
    if (!["brand", "product", "variant", "outer_units", "inner_item_count", "net_content"]
      .includes(String(mapping.source_kind))) {
      fail(`attribute_mappings[${index}].source_kind is invalid`);
    }
    const walmartValue = nonBlankWriteValue(
      mapping.walmart_value,
      `attribute_mappings[${index}].walmart_value`,
    );
    const valueSha = digest(
      mapping.walmart_value_sha256,
      `attribute_mappings[${index}].walmart_value_sha256`,
    );
    if (walmartListingSurgicalSha256(walmartValue) !== valueSha) {
      fail(`attribute_mappings[${index}] Walmart value SHA mismatch`);
    }
    return {
      source_field_path: text(
        mapping.source_field_path,
        `attribute_mappings[${index}].source_field_path`,
        2_048,
      ),
      source_kind: mapping.source_kind as ListingAttributeClaim["kind"],
      source_claim_sha256: digest(
        mapping.source_claim_sha256,
        `attribute_mappings[${index}].source_claim_sha256`,
      ),
      walmart_visible_field: field,
      walmart_value: walmartValue,
      walmart_value_sha256: valueSha,
    };
  });
  if (new Set(mappings.map((entry) => normalizedField(entry.walmart_visible_field))).size
    !== mappings.length) {
    fail("schema contract repeats a normalized Walmart Visible attribute field");
  }
  const orderedFields = mappings.map((entry) => entry.walmart_visible_field);
  if (orderedFields.some((field, index) => index > 0 && field <= orderedFields[index - 1]!)) {
    fail("schema contract attribute mappings must be ordered by Walmart Visible field");
  }
  return {
    schema_version: WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
    contract_id: safeId(raw.contract_id, "schema contract_id"),
    plan_id: safeId(raw.plan_id, "schema contract plan_id"),
    plan_body_sha256: digest(raw.plan_body_sha256, "schema contract plan SHA"),
    target_sha256: digest(raw.target_sha256, "schema contract target SHA"),
    listing: {
      channel: "WALMART_US",
      store_index: positiveInteger(listing.store_index, "schema contract store_index"),
      sku: text(listing.sku, "schema contract sku", 512),
      listing_key: text(listing.listing_key, "schema contract listing_key", 1_024),
      item_id: optionalExactNumericItemId(
        listing.item_id,
        "schema contract item_id",
      ) ?? fail("schema contract item_id is required"),
      product_identifier: productIdentifier(
        listing.product_identifier,
        "schema contract product_identifier",
      ),
      product_type: productType,
      live_item_capture_sha256: digest(
        listing.live_item_capture_sha256,
        "schema contract live item capture SHA",
      ),
      live_item_receipt_body_sha256: digest(
        listing.live_item_receipt_body_sha256,
        "schema contract live item receipt body SHA",
      ),
      live_item_captured_at: instant(
        listing.live_item_captured_at,
        "schema contract live_item_captured_at",
      ),
    },
    spec: {
      feed_type: "MP_MAINTENANCE",
      business_unit: "WALMART_US",
      locale: "en",
      version: spec.version,
      product_type: productType,
      request_payload_sha256: digest(spec.request_payload_sha256, "spec request SHA"),
      response_payload_sha256: digest(spec.response_payload_sha256, "spec response SHA"),
      schema_sha256: digest(spec.schema_sha256, "spec schema SHA"),
      get_spec_receipt_body_sha256: digest(
        spec.get_spec_receipt_body_sha256,
        "Get Spec receipt body SHA",
      ),
      valid_until: instant(spec.valid_until, "schema contract spec valid_until"),
    },
    schema_mapping_approval_sha256: digest(
      raw.schema_mapping_approval_sha256,
      "schema mapping approval SHA",
    ),
    attribute_mappings: mappings,
    claims: {
      exact_one_sku: true,
      changed_fields_only: true,
      full_target_is_qa_reference_only: true,
      audit_claims_are_not_write_schema: true,
      blank_or_null_clear_forbidden: true,
      preserve_unapproved_fields_by_omission: true,
      retries: 0,
      redirects: 0,
    },
    body_sha256: digest(raw.body_sha256, "schema contract body SHA"),
  };
}

function extractSchema(value: unknown): JsonRecord {
  const response = record(value, "Get Spec response");
  const candidate = Object.hasOwn(response, "schema") ? response.schema : response;
  if (typeof candidate === "string") {
    try { return record(JSON.parse(candidate), "Get Spec response.schema"); }
    catch { fail("Get Spec response.schema must contain valid JSON Schema"); }
  }
  return record(candidate, "Get Spec response schema");
}

function createMaintenanceAjv(): Ajv.Ajv {
  const ajv = new Ajv({
    allErrors: true,
    jsonPointers: true,
    unknownFormats: "ignore",
    verbose: true,
  });
  ajv.addKeyword("minEntries", {
    type: "array",
    metaSchema: { type: "integer", minimum: 0 },
    validate: (minimum: number, data: unknown) => Array.isArray(data) && data.length >= minimum,
    errors: false,
  });
  ajv.addKeyword("maxEntries", {
    type: "array",
    metaSchema: { type: "integer", minimum: 0 },
    validate: (maximum: number, data: unknown) => Array.isArray(data) && data.length <= maximum,
    errors: false,
  });
  return ajv;
}

function validateAgainstSchema(payload: JsonRecord, schema: JsonRecord): void {
  try {
    const validate = createMaintenanceAjv().compile(schema);
    if (!validate(payload)) {
      const errors = (validate.errors ?? []).slice(0, 10).map((entry) => (
        `${entry.dataPath || entry.schemaPath}: ${entry.message ?? "invalid"}`
      ));
      fail(`surgical payload failed exact MP_MAINTENANCE schema: ${errors.join("; ")}`);
    }
  } catch (error) {
    if (error instanceof WalmartListingSurgicalPayloadError) throw error;
    fail(`exact MP_MAINTENANCE schema could not be compiled: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function verifyGetSpec(input: {
  contract: WalmartListingSurgicalSchemaContract;
  receipt: WalmartListingSurgicalGetSpecReceipt;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  preparedAt: string;
  sellerAccountFingerprintSha256: string;
}): JsonRecord {
  const request = parseJsonBytes(input.requestBytes, "Get Spec request bytes");
  assertCanonicalInputBytes(input.requestBytes, request, "Get Spec request bytes");
  const requestRaw = record(request, "Get Spec request");
  exactKeys(requestRaw, ["feedType", "version", "productTypes"], "Get Spec request");
  if (requestRaw.feedType !== "MP_MAINTENANCE"
    || requestRaw.version !== input.contract.spec.version
    || !Array.isArray(requestRaw.productTypes) || requestRaw.productTypes.length !== 1
    || requestRaw.productTypes[0] !== input.contract.listing.product_type) {
    fail("Get Spec request is not exact MP_MAINTENANCE version/productType");
  }
  const requestSha = bytesSha256(input.requestBytes);
  const responseSha = bytesSha256(exactBytes(input.responseBytes, "Get Spec response bytes"));
  if (requestSha !== input.receipt.request_payload_sha256
    || responseSha !== input.receipt.response_payload_sha256
    || requestSha !== input.contract.spec.request_payload_sha256
    || responseSha !== input.contract.spec.response_payload_sha256) {
    fail("raw Get Spec request/response bytes differ from receipt/schema contract");
  }
  if (input.receipt.body_sha256 !== input.contract.spec.get_spec_receipt_body_sha256
    || input.receipt.seller_account_fingerprint_sha256
      !== input.sellerAccountFingerprintSha256) {
    fail("Get Spec receipt differs from schema contract/active seller account");
  }
  const fetched = Date.parse(input.receipt.fetched_at);
  const prepared = Date.parse(input.preparedAt);
  const validUntil = Date.parse(input.contract.spec.valid_until);
  if (fetched > prepared || prepared >= validUntil
    || validUntil <= fetched
    || validUntil - fetched > WALMART_LISTING_SURGICAL_MAX_SPEC_AGE_MS
    || prepared - fetched > WALMART_LISTING_SURGICAL_MAX_SPEC_AGE_MS) {
    fail("Get Spec evidence is stale/future or exceeds the 30-minute freshness contract");
  }
  const schema = extractSchema(parseJsonBytes(input.responseBytes, "Get Spec response bytes"));
  if (walmartListingSurgicalSha256(schema) !== input.contract.spec.schema_sha256) {
    fail("schema extracted from exact Get Spec response differs from schema contract");
  }
  return schema;
}

function optionalExactNumericItemId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(`${label} must be an exact positive numeric itemId`);
    }
    return String(value);
  }
  if (typeof value !== "string" || value !== value.trim() || !/^[1-9]\d*$/u.test(value)) {
    fail(`${label} must be an exact positive numeric itemId`);
  }
  return value;
}

function liveIdentifierCandidates(
  row: JsonRecord,
  expected: WalmartListingSurgicalProductIdentifier,
): Set<string> {
  const values = new Set<string>();
  const rawIdentifiers = row.productIdentifiers;
  if (rawIdentifiers !== undefined && rawIdentifiers !== null) {
    const candidates = Array.isArray(rawIdentifiers) ? rawIdentifiers : [rawIdentifiers];
    if (candidates.length < 1 || candidates.length > 100) {
      fail("live item productIdentifiers must be a bounded object or array");
    }
    for (const [index, candidate] of candidates.entries()) {
      const identifier = record(candidate, `live item productIdentifiers[${index}]`);
      const identifierType = text(
        identifier.productIdType,
        `live item productIdentifiers[${index}].productIdType`,
        16,
      );
      const identifierValue = text(
        identifier.productId,
        `live item productIdentifiers[${index}].productId`,
        64,
      );
      if (identifierType === expected.productIdType) values.add(identifierValue);
    }
  }
  const field = expected.productIdType.toLowerCase();
  const direct = row[field];
  if (direct !== undefined && direct !== null) {
    values.add(text(direct, `live item ${field}`, 64));
  }
  return values;
}

function verifyLiveItem(input: {
  contract: WalmartListingSurgicalSchemaContract;
  receipt: WalmartListingSurgicalLiveItemReceipt;
  responseBytes: Uint8Array;
  preparedAt: string;
  sellerAccountFingerprintSha256: string;
}): void {
  const responseBytes = exactBytes(input.responseBytes, "live item response bytes");
  const responseSha = bytesSha256(responseBytes);
  if (responseSha !== input.receipt.response_payload_sha256
    || responseSha !== input.contract.listing.live_item_capture_sha256) {
    fail("raw live item response bytes differ from receipt/schema contract");
  }
  if (input.receipt.body_sha256 !== input.contract.listing.live_item_receipt_body_sha256
    || input.receipt.seller_account_fingerprint_sha256
      !== input.sellerAccountFingerprintSha256
    || input.receipt.captured_at !== input.contract.listing.live_item_captured_at) {
    fail("live item receipt differs from schema contract/active seller account");
  }
  const captured = Date.parse(input.receipt.captured_at);
  const prepared = Date.parse(input.preparedAt);
  if (captured > prepared
    || prepared - captured > WALMART_LISTING_SURGICAL_MAX_LIVE_ITEM_AGE_MS) {
    fail("live item evidence is stale or from the future");
  }

  const response = record(
    parseJsonBytes(responseBytes, "live item response bytes"),
    "live item response",
  );
  if (!Array.isArray(response.ItemResponse) || response.ItemResponse.length !== 1) {
    fail("live item response must contain exactly one ItemResponse row");
  }
  const row = record(response.ItemResponse[0], "live item ItemResponse[0]");
  if (text(row.sku, "live item sku", 512) !== input.contract.listing.sku) {
    fail("live item response SKU differs from the exact repair listing");
  }
  if (text(row.productType, "live item productType", 512)
    !== input.contract.listing.product_type) {
    fail("live item response productType differs from the schema contract");
  }
  if (text(row.publishedStatus, "live item publishedStatus", 64) !== "PUBLISHED"
    || text(row.lifecycleStatus, "live item lifecycleStatus", 64) !== "ACTIVE") {
    fail("live item response is not PUBLISHED/ACTIVE");
  }

  const mart = row.mart === undefined || row.mart === null
    ? null
    : record(row.mart, "live item mart");
  const itemIds = new Set<string>();
  const directItemId = optionalExactNumericItemId(row.itemId, "live item itemId");
  const martItemId = optionalExactNumericItemId(mart?.itemId, "live item mart.itemId");
  if (directItemId) itemIds.add(directItemId);
  if (martItemId) itemIds.add(martItemId);
  if (itemIds.size !== 1 || !itemIds.has(input.contract.listing.item_id)) {
    fail("live item response does not prove one exact matching numeric itemId");
  }

  const identifiers = liveIdentifierCandidates(
    row,
    input.contract.listing.product_identifier,
  );
  if (identifiers.size !== 1
    || !identifiers.has(input.contract.listing.product_identifier.productId)) {
    fail("live item response does not prove one exact matching product identifier");
  }
}

function validateContractBindings(input: {
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
  contract: WalmartListingSurgicalSchemaContract;
  receipt: WalmartListingSurgicalGetSpecReceipt;
  request: WalmartListingSurgicalRequestInput;
}): RepairField[] {
  const { plan, baseline, contract, receipt, request } = input;
  if (walmartListingIntegritySha256(baseline.surface) !== plan.baseline.surface_sha256
    || walmartListingIntegritySha256(baseline.images) !== plan.baseline.images_sha256) {
    fail("baseline reference differs from exact repair plan baseline hashes");
  }
  const baselineImages = assertImages(baseline.images, "baseline images");
  const targetImages = assertImages(plan.target.images, "target images");
  if (!canonicalEqual(baselineImages, baseline.images)
    || !canonicalEqual(targetImages, plan.target.images)) {
    fail("baseline/target image reference is not canonical");
  }
  const changes = changedFields(baseline, plan.target);
  if (changes.length === 0 || !canonicalEqual(changes, plan.changed_fields)) {
    fail("repair plan changed_fields differ from recomputed baseline/target diff");
  }
  if (contract.plan_id !== plan.plan_id || contract.plan_body_sha256 !== plan.body_sha256
    || contract.target_sha256 !== plan.target.target_sha256
    || contract.listing.channel !== plan.listing.channel
    || contract.listing.store_index !== plan.listing.store_index
    || contract.listing.sku !== plan.listing.sku
    || contract.listing.listing_key !== plan.listing.listing_key
    || contract.listing.item_id !== plan.listing.item_id
    || contract.spec.product_type !== contract.listing.product_type) {
    fail("schema contract differs from exact plan/listing/target");
  }
  const prepared = instant(request.prepared_at, "request prepared_at");
  const planCreated = instant(plan.created_at, "repair plan created_at");
  const planExpires = instant(plan.expires_at, "repair plan expires_at");
  if (Date.parse(prepared) < Date.parse(planCreated)
    || Date.parse(prepared) >= Date.parse(planExpires)) {
    fail("request preparation is outside the exact repair plan validity window");
  }
  const liveCaptured = Date.parse(contract.listing.live_item_captured_at);
  if (liveCaptured > Date.parse(prepared)
    || Date.parse(prepared) - liveCaptured > WALMART_LISTING_SURGICAL_MAX_LIVE_ITEM_AGE_MS) {
    fail("live item identifier/productType capture is stale or from the future");
  }
  if (receipt.seller_account_fingerprint_sha256
    !== digest(request.seller_account_fingerprint_sha256, "seller account fingerprint")) {
    fail("request seller account differs from Get Spec seller account");
  }
  if (plan.apply_engine_release_sha256 !== digest(
    plan.apply_engine_release_sha256,
    "apply engine release SHA",
  )) {
    fail("repair plan apply engine release SHA is invalid");
  }
  return changes;
}

function buildVisible(input: {
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
  contract: WalmartListingSurgicalSchemaContract;
  changed: RepairField[];
}): JsonRecord {
  const { plan, baseline, contract, changed } = input;
  const changedSet = new Set(changed);
  const visible: JsonRecord = {};
  if (changedSet.has("title")) {
    visible.productName = text(plan.target.surface.title, "target title", 1_000);
  }
  if (changedSet.has("description")) {
    if (plan.target.surface.description === null) {
      fail("clearing description is unsupported because blank means no change");
    }
    visible.shortDescription = text(
      plan.target.surface.description,
      "target description",
      100_000,
    );
  }
  if (changedSet.has("bullets")) {
    if (!Array.isArray(plan.target.surface.bullets)
      || plan.target.surface.bullets.length < 1
      || plan.target.surface.bullets.length > 100) {
      fail("target bullets must be a bounded non-empty array");
    }
    visible.keyFeatures = plan.target.surface.bullets.map((entry, index) => (
      text(entry, `target bullets[${index}]`, 10_000)
    ));
  }
  if (changedSet.has("main")) {
    visible.mainImageUrl = publicImageUrl(
      plan.target.images[0]?.source_url,
      "target MAIN image URL",
    );
  }
  if (changedSet.has("gallery")) {
    const gallery = plan.target.images.slice(1).map((entry, index) => (
      publicImageUrl(entry.source_url, `target gallery image ${index + 1}`)
    ));
    if (gallery.length < 1) fail("gallery update cannot clear the gallery implicitly");
    visible.productSecondaryImageURL = gallery;
  }

  const changedClaims = changedSet.has("attributes")
    ? changedTargetClaims(baseline.surface, plan.target.surface)
    : new Map<string, ListingAttributeClaim>();
  if (!changedSet.has("attributes") && contract.attribute_mappings.length !== 0) {
    fail("schema contract maps attributes when attributes are not changed");
  }
  if (changedSet.has("attributes") && changedClaims.size === 0) {
    fail("attribute repair has no safely representable changed target claims");
  }
  const coveredClaims = new Set<string>();
  for (const mapping of contract.attribute_mappings) {
    const key = `${mapping.source_field_path}\u0000${mapping.source_kind}`;
    const claim = changedClaims.get(key);
    if (!claim || walmartListingIntegritySha256(claim) !== mapping.source_claim_sha256) {
      fail(`attribute mapping ${mapping.walmart_visible_field} is not bound to a changed target claim`);
    }
    if (Object.hasOwn(visible, mapping.walmart_visible_field)) {
      fail(`attribute mapping repeats/reserves ${mapping.walmart_visible_field}`);
    }
    visible[mapping.walmart_visible_field] = mapping.walmart_value;
    coveredClaims.add(key);
  }
  if (changedClaims.size !== coveredClaims.size
    || [...changedClaims.keys()].some((key) => !coveredClaims.has(key))) {
    fail("every changed target attribute claim needs an explicit approved mapping");
  }
  if (Object.keys(visible).length === 0) fail("surgical payload cannot be empty");
  return visible;
}

function safeFilename(sku: string): string {
  const safe = sku.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (!safe) fail("SKU cannot produce a safe multipart filename");
  return `${safe}-mp-maintenance.json`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as JsonRecord)) deepFreeze(entry);
  }
  return value;
}

export function buildWalmartListingSurgicalRequest(input: {
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
  schema_contract: WalmartListingSurgicalSchemaContract;
  get_spec_receipt: WalmartListingSurgicalGetSpecReceipt;
  live_item_receipt: WalmartListingSurgicalLiveItemReceipt;
  get_spec_request_bytes: Uint8Array;
  get_spec_response_bytes: Uint8Array;
  live_item_response_bytes: Uint8Array;
  request: WalmartListingSurgicalRequestInput;
}): BuiltWalmartListingSurgicalRequest {
  assertPlan(input.plan);
  const contract = parseSchemaContract(input.schema_contract);
  const receipt = parseReceipt(input.get_spec_receipt);
  const liveReceipt = parseLiveItemReceipt(
    input.live_item_receipt,
    contract.listing.sku,
  );
  const changed = validateContractBindings({
    plan: input.plan,
    baseline: input.baseline,
    contract,
    receipt,
    request: input.request,
  });
  const preparedAt = instant(input.request.prepared_at, "request prepared_at");
  const sellerFingerprint = digest(
    input.request.seller_account_fingerprint_sha256,
    "seller account fingerprint",
  );
  const schema = verifyGetSpec({
    contract,
    receipt,
    requestBytes: input.get_spec_request_bytes,
    responseBytes: input.get_spec_response_bytes,
    preparedAt,
    sellerAccountFingerprintSha256: sellerFingerprint,
  });
  verifyLiveItem({
    contract,
    receipt: liveReceipt,
    responseBytes: input.live_item_response_bytes,
    preparedAt,
    sellerAccountFingerprintSha256: sellerFingerprint,
  });
  const visible = buildVisible({
    plan: input.plan,
    baseline: input.baseline,
    contract,
    changed,
  });
  const visibleFields = Object.keys(visible).sort();
  const payload: JsonRecord = {
    MPItemFeedHeader: {
      businessUnit: "WALMART_US",
      locale: "en",
      version: contract.spec.version,
    },
    MPItem: [{
      Orderable: {
        sku: contract.listing.sku,
        productIdentifiers: contract.listing.product_identifier,
      },
      Visible: { [contract.listing.product_type]: visible },
    }],
  };
  validateAgainstSchema(payload, schema);
  const payloadArtifact = canonicalBytes(payload);
  const filename = safeFilename(contract.listing.sku);
  const manifestBody = {
    schema_version: WALMART_LISTING_SURGICAL_REQUEST_MANIFEST_SCHEMA,
    method: "POST" as const,
    path: "/v3/feeds" as const,
    feed_type: "MP_MAINTENANCE" as const,
    store_index: contract.listing.store_index,
    seller_account_fingerprint_sha256: sellerFingerprint,
    listing: {
      channel: contract.listing.channel,
      store_index: contract.listing.store_index,
      sku: contract.listing.sku,
      listing_key: contract.listing.listing_key,
      item_id: contract.listing.item_id,
    },
    native_identity: {
      product_identifier: contract.listing.product_identifier,
      product_type: contract.listing.product_type,
      live_item_response_payload_sha256: liveReceipt.response_payload_sha256,
      live_item_receipt_body_sha256: liveReceipt.body_sha256,
    },
    plan_id: input.plan.plan_id,
    plan_body_sha256: input.plan.body_sha256,
    target_sha256: input.plan.target.target_sha256,
    permit_id: safeId(input.request.permit_id, "permit_id"),
    apply_engine_release_sha256: input.plan.apply_engine_release_sha256,
    schema_contract_body_sha256: contract.body_sha256,
    schema_mapping_approval_sha256: contract.schema_mapping_approval_sha256,
    get_spec: {
      request_payload_sha256: receipt.request_payload_sha256,
      response_payload_sha256: receipt.response_payload_sha256,
      schema_sha256: contract.spec.schema_sha256,
      receipt_body_sha256: receipt.body_sha256,
      version: contract.spec.version,
      product_type: contract.listing.product_type,
      product_identifier: contract.listing.product_identifier,
    },
    transport: {
      query: { feedType: "MP_MAINTENANCE" as const },
      multipart: {
        field_name: "file" as const,
        filename,
        content_type: "application/json" as const,
      },
      retries: 0 as const,
      redirects: 0 as const,
    },
    changed_fields: changed,
    visible_fields: visibleFields,
    full_target_written: false as const,
    request_correlation_id_sha256: digest(
      input.request.request_correlation_id_sha256,
      "request correlation SHA",
    ),
    request_payload_sha256: payloadArtifact.sha256,
    prepared_at: preparedAt,
  };
  const manifest = {
    ...manifestBody,
    body_sha256: walmartListingSurgicalSha256(manifestBody),
  } satisfies WalmartListingSurgicalRequestManifest;
  const manifestArtifact = canonicalBytes(manifest);
  const validation: WalmartListingSurgicalValidation = {
    schema_version: WALMART_LISTING_SURGICAL_VALIDATION_SCHEMA,
    valid: true,
    status: "PASSED",
    exact_listing_count: 1,
    feed_type: "MP_MAINTENANCE",
    exact_item_count: 1,
    changed_fields_recomputed: true,
    full_target_written: false,
    schema_contract_body_sha256: contract.body_sha256,
    schema_mapping_approval_sha256: contract.schema_mapping_approval_sha256,
    get_spec_receipt_body_sha256: receipt.body_sha256,
    get_spec_request_payload_sha256: receipt.request_payload_sha256,
    get_spec_response_payload_sha256: receipt.response_payload_sha256,
    get_spec_schema_sha256: contract.spec.schema_sha256,
    live_item_response_payload_sha256: liveReceipt.response_payload_sha256,
    live_item_receipt_body_sha256: liveReceipt.body_sha256,
    spec_version: contract.spec.version,
    product_type: contract.listing.product_type,
    product_identifier: contract.listing.product_identifier,
    changed_fields: changed,
    visible_fields: visibleFields,
    preserved_by_omission: PRESERVED_BY_OMISSION,
    retries: 0,
    redirects: 0,
    network_calls: 0,
    model_calls: 0,
    database_writes: 0,
    marketplace_writes: 0,
  };
  return {
    payload: deepFreeze(payload),
    payload_json: payloadArtifact.json,
    payload_bytes: payloadArtifact.bytes,
    payload_sha256: payloadArtifact.sha256,
    filename,
    request_manifest: deepFreeze(manifest),
    request_manifest_json: manifestArtifact.json,
    request_manifest_bytes: manifestArtifact.bytes,
    request_manifest_sha256: manifestArtifact.sha256,
    validation: deepFreeze(validation),
  };
}

/**
 * Rebuild and compare exact bytes. The writer/evidence verifier should call
 * this immediately before transport or qualification; a parsed object alone
 * is never evidence of the bytes that were/will be sent.
 */
export function verifyWalmartListingSurgicalRequestBytes(input: {
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
  schema_contract: WalmartListingSurgicalSchemaContract;
  get_spec_receipt: WalmartListingSurgicalGetSpecReceipt;
  live_item_receipt: WalmartListingSurgicalLiveItemReceipt;
  get_spec_request_bytes: Uint8Array;
  get_spec_response_bytes: Uint8Array;
  live_item_response_bytes: Uint8Array;
  request: WalmartListingSurgicalRequestInput;
  request_payload_bytes: Uint8Array;
  request_manifest_bytes: Uint8Array;
}): BuiltWalmartListingSurgicalRequest {
  const rebuilt = buildWalmartListingSurgicalRequest(input);
  if (!Buffer.from(rebuilt.payload_bytes).equals(Buffer.from(input.request_payload_bytes))) {
    fail("exact MP_MAINTENANCE request payload bytes differ from rebuilt surgical payload");
  }
  if (!Buffer.from(rebuilt.request_manifest_bytes).equals(
    Buffer.from(input.request_manifest_bytes),
  )) {
    fail("exact request manifest bytes differ from rebuilt surgical manifest");
  }
  return rebuilt;
}
