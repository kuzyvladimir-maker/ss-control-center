/**
 * Successor contract for repairing every mutable Walmart listing surface that
 * is exposed by the official Marketplace APIs.
 *
 * This is deliberately separate from the frozen v33 one-feed writer.  A full
 * repair can require several independent Walmart requests (for example an
 * MP_MAINTENANCE feed plus price and inventory calls), so authority and
 * durable consumption are operation-bound instead of pretending that one
 * content feed can own commercial or fulfillment state.
 *
 * This module is pure.  It performs no network, database, model, filesystem or
 * marketplace calls.
 */

import { createHash } from "node:crypto";

export const WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA =
  "walmart-listing-integrity-full-surface-plan/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA =
  "walmart-listing-integrity-full-surface-operation/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA =
  "walmart-listing-integrity-full-surface-outcome/v2" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_OPERATION_COUNT = 64;
const MAX_LISTING_COUNT = 20;

export const WALMART_LISTING_ITEM_MUTABLE_FACETS = Object.freeze([
  "title",
  "description",
  "key_features",
  "main_image",
  "secondary_images",
  "category_attributes",
  "variant_relationship",
  "shipping_weight",
  "package_dimensions",
  "country_of_origin",
  "compliance_attributes",
  "rich_media",
] as const);

export type WalmartListingItemMutableFacet =
  typeof WALMART_LISTING_ITEM_MUTABLE_FACETS[number];

export const WALMART_LISTING_FULL_SURFACE_OPERATION_ORDER = Object.freeze([
  "SHIPPING_TEMPLATE_CREATE",
  "ITEM_MAINTENANCE",
  "SHIPPING_TEMPLATE_ASSOCIATION",
  "LAG_TIME",
  "PRICE",
  "PROMOTIONAL_PRICE",
  "REPRICER_ASSIGNMENT",
  "INVENTORY",
  "ITEM_RETIRE",
] as const);

export type WalmartListingFullSurfaceOperationKind =
  typeof WALMART_LISTING_FULL_SURFACE_OPERATION_ORDER[number];

export type WalmartListingMutationClass =
  | "REVERSIBLE"
  | "COMPENSATABLE"
  | "IRREVERSIBLE";

export interface WalmartListingFullSurfaceCapability {
  operation_kind: WalmartListingFullSurfaceOperationKind;
  plane:
    | "ITEM"
    | "FULFILLMENT"
    | "COMMERCIAL"
    | "AVAILABILITY"
    | "LIFECYCLE";
  method: "POST" | "PUT" | "DELETE";
  path_template: string;
  feed_type: "MP_MAINTENANCE" | "SKU_TEMPLATE_MAP" | "lagtime" | null;
  mutation_class: WalmartListingMutationClass;
  maximum_listings_per_operation: number;
  item_facets: readonly WalmartListingItemMutableFacet[];
  required_readback:
    | "SHIPPING_TEMPLATE_DETAILS"
    | "ITEM_AND_BUYER_SURFACE"
    | "ITEM_ASSOCIATIONS"
    | "LAG_TIME"
    | "PRICE"
    | "REPRICER_AND_PRICE"
    | "INVENTORY_BY_SHIP_NODE"
    | "ITEM_ABSENCE";
}

const ALL_ITEM_FACETS = WALMART_LISTING_ITEM_MUTABLE_FACETS;

/**
 * The registry is the product requirement boundary.  Exact account scopes and
 * category schemas are still discovered at plan time; the engine never turns
 * an unavailable account permission or an immutable Walmart identifier into a
 * fabricated write.
 */
export const WALMART_LISTING_FULL_SURFACE_CAPABILITIES:
Readonly<Record<
  WalmartListingFullSurfaceOperationKind,
  WalmartListingFullSurfaceCapability
>> = Object.freeze({
  SHIPPING_TEMPLATE_CREATE: Object.freeze({
    operation_kind: "SHIPPING_TEMPLATE_CREATE",
    plane: "FULFILLMENT",
    method: "POST",
    path_template: "/v3/settings/shipping/templates",
    feed_type: null,
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 20,
    item_facets: [],
    required_readback: "SHIPPING_TEMPLATE_DETAILS",
  }),
  ITEM_MAINTENANCE: Object.freeze({
    operation_kind: "ITEM_MAINTENANCE",
    plane: "ITEM",
    method: "POST",
    path_template: "/v3/feeds",
    feed_type: "MP_MAINTENANCE",
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 20,
    item_facets: ALL_ITEM_FACETS,
    required_readback: "ITEM_AND_BUYER_SURFACE",
  }),
  SHIPPING_TEMPLATE_ASSOCIATION: Object.freeze({
    operation_kind: "SHIPPING_TEMPLATE_ASSOCIATION",
    plane: "FULFILLMENT",
    method: "POST",
    path_template: "/v3/feeds",
    feed_type: "SKU_TEMPLATE_MAP",
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 20,
    item_facets: [],
    required_readback: "ITEM_ASSOCIATIONS",
  }),
  LAG_TIME: Object.freeze({
    operation_kind: "LAG_TIME",
    plane: "FULFILLMENT",
    method: "POST",
    path_template: "/v3/feeds",
    feed_type: "lagtime",
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 20,
    item_facets: [],
    required_readback: "LAG_TIME",
  }),
  PRICE: Object.freeze({
    operation_kind: "PRICE",
    plane: "COMMERCIAL",
    method: "PUT",
    path_template: "/v3/price",
    feed_type: null,
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 1,
    item_facets: [],
    required_readback: "PRICE",
  }),
  PROMOTIONAL_PRICE: Object.freeze({
    operation_kind: "PROMOTIONAL_PRICE",
    plane: "COMMERCIAL",
    method: "PUT",
    path_template: "/v3/price",
    feed_type: null,
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 1,
    item_facets: [],
    required_readback: "PRICE",
  }),
  REPRICER_ASSIGNMENT: Object.freeze({
    operation_kind: "REPRICER_ASSIGNMENT",
    plane: "COMMERCIAL",
    method: "POST",
    path_template: "/v3/repricerFeeds",
    feed_type: null,
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 20,
    item_facets: [],
    required_readback: "REPRICER_AND_PRICE",
  }),
  INVENTORY: Object.freeze({
    operation_kind: "INVENTORY",
    plane: "AVAILABILITY",
    method: "PUT",
    path_template: "/v3/inventory",
    feed_type: null,
    mutation_class: "COMPENSATABLE",
    maximum_listings_per_operation: 1,
    item_facets: [],
    required_readback: "INVENTORY_BY_SHIP_NODE",
  }),
  ITEM_RETIRE: Object.freeze({
    operation_kind: "ITEM_RETIRE",
    plane: "LIFECYCLE",
    method: "DELETE",
    path_template: "/v3/items/{sku}",
    feed_type: null,
    mutation_class: "IRREVERSIBLE",
    maximum_listings_per_operation: 1,
    item_facets: [],
    required_readback: "ITEM_ABSENCE",
  }),
});

export interface WalmartListingFullSurfaceListing {
  channel: "WALMART_US";
  store_index: number;
  sku: string;
  listing_key: string;
  item_id: string;
}

export interface WalmartListingFullSurfaceExactRequest {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  query: Readonly<Record<string, string>>;
  content_type: "application/json" | "multipart/form-data" | null;
  request_payload_sha256: string;
  request_byte_length: number;
}

export interface WalmartListingFullSurfaceReadback {
  kind: WalmartListingFullSurfaceCapability["required_readback"];
  minimum_delay_ms: number;
  maximum_wait_ms: number;
  exact_skus: readonly string[];
  baseline_state_sha256: string;
  expected_state_sha256: string;
}

export interface WalmartListingFullSurfaceOperation {
  schema_version: typeof WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA;
  operation_id: string;
  sequence_position: number;
  operation_kind: WalmartListingFullSurfaceOperationKind;
  plane: WalmartListingFullSurfaceCapability["plane"];
  exact_skus: readonly string[];
  changed_item_facets: readonly WalmartListingItemMutableFacet[];
  exact_request: WalmartListingFullSurfaceExactRequest;
  evidence_sha256: string;
  account_scope_receipt_sha256: string;
  category_schema_receipt_sha256: string | null;
  mutation_class: WalmartListingMutationClass;
  irreversible_owner_decision_sha256: string | null;
  attempt_policy: {
    max_attempts: 1;
    retries: 0;
    redirects: 0;
    unknown_outcome_action: "STOP_NO_REPLAY";
  };
  readback: WalmartListingFullSurfaceReadback;
  body_sha256: string;
}

export interface WalmartListingFullSurfacePlan {
  schema_version: typeof WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA;
  plan_id: string;
  owner_decision_id: string;
  owner_decision_sha256: string;
  created_at: string;
  expires_at: string;
  seller_account_fingerprint_sha256: string;
  product_truth_snapshot_sha256: string;
  exact_listings: readonly WalmartListingFullSurfaceListing[];
  operations: readonly WalmartListingFullSurfaceOperation[];
  execution_policy: {
    exact_operation_permit_required: true;
    durable_operation_consumption_required: true;
    operation_payload_sha256_binding_required: true;
    maximum_in_flight_operations: 1;
    automatic_retry_allowed: false;
    automatic_replay_allowed: false;
    stop_after_non_success: true;
    fresh_api_specific_readback_required: true;
    buyer_surface_qualification_required_after_item_change: true;
  };
  body_sha256: string;
}

export interface WalmartListingFullSurfaceOperationInput {
  operation_id: string;
  operation_kind: WalmartListingFullSurfaceOperationKind;
  exact_skus: readonly string[];
  changed_item_facets?: readonly WalmartListingItemMutableFacet[];
  request_payload_bytes: Uint8Array;
  path?: string;
  query?: Readonly<Record<string, string>>;
  content_type?: "application/json" | "multipart/form-data" | null;
  evidence_sha256: string;
  account_scope_receipt_sha256: string;
  category_schema_receipt_sha256?: string | null;
  irreversible_owner_decision_sha256?: string | null;
  baseline_state_sha256: string;
  expected_state_sha256: string;
  readback_minimum_delay_ms?: number;
  readback_maximum_wait_ms?: number;
}

export interface BuildWalmartListingFullSurfacePlanInput {
  plan_id: string;
  owner_decision_id: string;
  owner_decision_sha256: string;
  created_at: string;
  expires_at: string;
  seller_account_fingerprint_sha256: string;
  product_truth_snapshot_sha256: string;
  exact_listings: readonly WalmartListingFullSurfaceListing[];
  operations: readonly WalmartListingFullSurfaceOperationInput[];
}

export interface WalmartListingFullSurfaceOutcome {
  schema_version: typeof WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA;
  plan_body_sha256: string;
  operation_id: string;
  operation_body_sha256: string;
  request_payload_sha256: string;
  permit_authorization_sha256: string;
  consumption_ledger_sha256: string;
  attempted_at: string;
  outcome:
    | "SUCCEEDED_AND_READ_BACK"
    | "DEFINITELY_REJECTED"
    | "UNKNOWN"
    | "READBACK_FAILED";
  marketplace_write_calls: 1;
  readback_sha256: string | null;
  diagnostic_sha256: string | null;
  body_sha256: string;
}

export type WalmartListingFullSurfaceFeedVerdict =
  | { state: "PENDING"; reason: string }
  | { state: "SUCCEEDED"; reason: null }
  | {
    state: "FAILED";
    reason: string;
    failure_codes: readonly string[];
  };

export type WalmartListingFullSurfaceNextAction =
  | {
    action: "EXECUTE_OPERATION";
    operation: WalmartListingFullSurfaceOperation;
  }
  | {
    action: "COMPLETE";
  }
  | {
    action: "STOP_NO_REPLAY";
    operation_id: string;
    reason: "DEFINITELY_REJECTED" | "UNKNOWN" | "READBACK_FAILED";
  };

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Walmart full-surface plan rejected input: ${message}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const result: Partial<T> = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}

export function walmartListingFullSurfaceSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Evaluate one exact terminal feed without collapsing item-level Walmart
 * diagnostics. Callers must request includeDetails=true and preserve the raw
 * response bytes; this pure verdict is only the control-flow projection.
 */
export function evaluateWalmartListingFullSurfaceFeed(
  rawValue: unknown,
  exactFeedId: string,
  exactSkus: readonly string[],
): WalmartListingFullSurfaceFeedVerdict {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return {
      state: "FAILED",
      reason: "FEED_RESPONSE_NOT_AN_OBJECT",
      failure_codes: Object.freeze([]),
    };
  }
  const raw = rawValue as JsonRecord;
  if (raw.feedId !== undefined && raw.feedId !== exactFeedId) {
    return {
      state: "FAILED",
      reason: "FEED_ID_MISMATCH",
      failure_codes: Object.freeze([]),
    };
  }
  const status = String(raw.feedStatus ?? "").toUpperCase();
  if (!["PROCESSED", "ERROR"].includes(status)) {
    return { state: "PENDING", reason: "FEED_NOT_TERMINAL" };
  }
  const details = raw.itemDetails && typeof raw.itemDetails === "object"
    && !Array.isArray(raw.itemDetails)
    ? raw.itemDetails as JsonRecord
    : {};
  const candidates = Array.isArray(details.itemIngestionStatus)
    ? details.itemIngestionStatus
    : Array.isArray(details.itemDetails) ? details.itemDetails : [];
  const rows = candidates.filter((row): row is JsonRecord =>
    !!row && typeof row === "object" && !Array.isArray(row));
  const succeeded = new Set(rows.filter((row) =>
    String(row.ingestionStatus ?? "").toUpperCase() === "SUCCESS")
    .map((row) => String(row.sku)));
  const failureCodes = [...new Set(rows.flatMap((row) => {
    const errorsEnvelope = row.ingestionErrors;
    if (
      !errorsEnvelope
      || typeof errorsEnvelope !== "object"
      || Array.isArray(errorsEnvelope)
    ) return [];
    const errors = (errorsEnvelope as JsonRecord).ingestionError;
    if (!Array.isArray(errors)) return [];
    return errors.flatMap((error) => {
      if (!error || typeof error !== "object" || Array.isArray(error)) return [];
      const code = (error as JsonRecord).code;
      return typeof code === "string" && code ? [code] : [];
    });
  }))].sort();
  const exact = [...exactSkus].sort();
  const countPass =
    (raw.itemsReceived === undefined || Number(raw.itemsReceived) === exact.length)
    && (raw.itemsSucceeded === undefined || Number(raw.itemsSucceeded) === exact.length)
    && (raw.itemsFailed === undefined || Number(raw.itemsFailed) === 0);
  if (
    status === "PROCESSED"
    && countPass
    && canonicalJson([...succeeded].sort()) === canonicalJson(exact)
  ) {
    return { state: "SUCCEEDED", reason: null };
  }
  return {
    state: "FAILED",
    reason: failureCodes.length > 0
      ? `FEED_ITEMS_FAILED_OR_MISSING:${failureCodes.join(",")}`
      : "FEED_ITEMS_FAILED_OR_MISSING",
    failure_codes: Object.freeze(failureCodes),
  };
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: string, label: string): string {
  if (!SHA256.test(value)) fail(`${label} must be lowercase SHA-256`);
  return value;
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function exactTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be exact ISO-8601 UTC`);
  }
  return parsed;
}

function exactListing(
  value: WalmartListingFullSurfaceListing,
): WalmartListingFullSurfaceListing {
  if (value.channel !== "WALMART_US") fail("listing channel must be WALMART_US");
  if (!Number.isInteger(value.store_index) || value.store_index < 1) {
    fail("listing store_index is invalid");
  }
  const sku = safeId(value.sku, "listing sku");
  const expectedKey = `walmart:${value.store_index}:${sku}`;
  if (value.listing_key !== expectedKey) {
    fail(`listing_key must equal ${expectedKey}`);
  }
  if (!/^[0-9]{1,20}$/u.test(value.item_id)) fail("listing item_id is invalid");
  return Object.freeze({ ...value });
}

function expectedRequestContract(
  kind: WalmartListingFullSurfaceOperationKind,
  skus: readonly string[],
): Pick<WalmartListingFullSurfaceExactRequest, "method" | "path" | "query"> {
  const capability = WALMART_LISTING_FULL_SURFACE_CAPABILITIES[kind];
  const path = kind === "ITEM_RETIRE"
    ? `/v3/items/${encodeURIComponent(skus[0])}`
    : capability.path_template;
  const query: Record<string, string> = {};
  if (capability.feed_type) query.feedType = capability.feed_type;
  if (kind === "PROMOTIONAL_PRICE") query.promo = "true";
  return {
    method: capability.method,
    path,
    query: Object.freeze(query),
  };
}

function sameQuery(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function buildOperation(
  input: WalmartListingFullSurfaceOperationInput,
  sequencePosition: number,
  listingSkuSet: ReadonlySet<string>,
): WalmartListingFullSurfaceOperation {
  const capability = WALMART_LISTING_FULL_SURFACE_CAPABILITIES[input.operation_kind];
  if (!capability) fail(`unknown operation_kind ${String(input.operation_kind)}`);
  const exactSkus = [...new Set(input.exact_skus.map((sku) => safeId(sku, "operation sku")))]
    .sort();
  if (exactSkus.length !== input.exact_skus.length || exactSkus.length < 1) {
    fail(`${input.operation_id} exact_skus must be unique and non-empty`);
  }
  if (exactSkus.some((sku) => !listingSkuSet.has(sku))) {
    fail(`${input.operation_id} includes an SKU outside exact_listings`);
  }
  if (exactSkus.length > capability.maximum_listings_per_operation) {
    fail(`${input.operation_id} exceeds operation listing limit`);
  }
  const facets = (
    [...new Set(input.changed_item_facets ?? [])].sort()
  ) as WalmartListingItemMutableFacet[];
  if (input.operation_kind === "ITEM_MAINTENANCE") {
    if (facets.length < 1) fail("ITEM_MAINTENANCE requires changed_item_facets");
    if (facets.some((facet) => !capability.item_facets.includes(facet))) {
      fail("ITEM_MAINTENANCE contains an unsupported item facet");
    }
    exactSha(
      input.category_schema_receipt_sha256 ?? "",
      "ITEM_MAINTENANCE category schema receipt",
    );
  } else if (facets.length !== 0 || input.category_schema_receipt_sha256) {
    fail(`${input.operation_id} cannot carry item facets/category schema`);
  }
  const expected = expectedRequestContract(input.operation_kind, exactSkus);
  const path = input.path ?? expected.path;
  const query = Object.freeze({ ...(input.query ?? expected.query) });
  if (
    path !== expected.path
    || !sameQuery(query, expected.query)
    || input.content_type === undefined
  ) {
    fail(`${input.operation_id} request contract does not match capability`);
  }
  if (!(input.request_payload_bytes instanceof Uint8Array)) {
    fail(`${input.operation_id} request payload bytes are required`);
  }
  const requestByteLength = input.request_payload_bytes.byteLength;
  if (
    (input.operation_kind === "ITEM_RETIRE" && requestByteLength !== 0)
    || (input.operation_kind !== "ITEM_RETIRE" && requestByteLength < 2)
  ) {
    fail(`${input.operation_id} request payload byte length is invalid`);
  }
  const irreversibleDecision = input.irreversible_owner_decision_sha256 ?? null;
  if (capability.mutation_class === "IRREVERSIBLE") {
    exactSha(
      irreversibleDecision ?? "",
      `${input.operation_id} irreversible owner decision`,
    );
  } else if (irreversibleDecision !== null) {
    fail(`${input.operation_id} cannot carry irreversible authority`);
  }
  const minimumDelay = input.readback_minimum_delay_ms ?? (
    capability.required_readback === "ITEM_AND_BUYER_SURFACE" ? 300_000 : 0
  );
  const maximumWait = input.readback_maximum_wait_ms ?? (
    capability.required_readback === "ITEM_ABSENCE"
      ? 48 * 60 * 60 * 1_000
      : 24 * 60 * 60 * 1_000
  );
  if (
    !Number.isInteger(minimumDelay)
    || minimumDelay < 0
    || !Number.isInteger(maximumWait)
    || maximumWait < minimumDelay
  ) {
    fail(`${input.operation_id} readback window is invalid`);
  }
  const body = {
    schema_version: WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA,
    operation_id: safeId(input.operation_id, "operation_id"),
    sequence_position: sequencePosition,
    operation_kind: input.operation_kind,
    plane: capability.plane,
    exact_skus: Object.freeze(exactSkus),
    changed_item_facets: Object.freeze(facets),
    exact_request: Object.freeze({
      method: expected.method,
      path,
      query,
      content_type: input.content_type,
      request_payload_sha256: bytesSha256(input.request_payload_bytes),
      request_byte_length: requestByteLength,
    }),
    evidence_sha256: exactSha(input.evidence_sha256, "operation evidence"),
    account_scope_receipt_sha256: exactSha(
      input.account_scope_receipt_sha256,
      "account scope receipt",
    ),
    category_schema_receipt_sha256:
      input.category_schema_receipt_sha256 ?? null,
    mutation_class: capability.mutation_class,
    irreversible_owner_decision_sha256: irreversibleDecision,
    attempt_policy: Object.freeze({
      max_attempts: 1 as const,
      retries: 0 as const,
      redirects: 0 as const,
      unknown_outcome_action: "STOP_NO_REPLAY" as const,
    }),
    readback: Object.freeze({
      kind: capability.required_readback,
      minimum_delay_ms: minimumDelay,
      maximum_wait_ms: maximumWait,
      exact_skus: Object.freeze(exactSkus),
      baseline_state_sha256: exactSha(
        input.baseline_state_sha256,
        "baseline state",
      ),
      expected_state_sha256: exactSha(
        input.expected_state_sha256,
        "expected state",
      ),
    }),
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingFullSurfaceSha256(body),
  });
}

export function buildWalmartListingFullSurfacePlan(
  input: BuildWalmartListingFullSurfacePlanInput,
): WalmartListingFullSurfacePlan {
  const createdMs = exactTime(input.created_at, "created_at");
  const expiresMs = exactTime(input.expires_at, "expires_at");
  if (expiresMs <= createdMs || expiresMs - createdMs > MAX_PLAN_AGE_MS) {
    fail("plan lifetime must be >0 and <=24h");
  }
  if (
    input.exact_listings.length < 1
    || input.exact_listings.length > MAX_LISTING_COUNT
  ) {
    fail(`exact_listings must contain 1-${MAX_LISTING_COUNT} rows`);
  }
  const exactListings = input.exact_listings.map(exactListing)
    .sort((left, right) => left.listing_key.localeCompare(right.listing_key));
  const listingKeys = new Set(exactListings.map((listing) => listing.listing_key));
  const listingSkus = new Set(exactListings.map((listing) => listing.sku));
  if (
    listingKeys.size !== exactListings.length
    || listingSkus.size !== exactListings.length
  ) {
    fail("exact_listings must have unique listing keys and SKUs");
  }
  if (
    input.operations.length < 1
    || input.operations.length > MAX_OPERATION_COUNT
  ) {
    fail(`operations must contain 1-${MAX_OPERATION_COUNT} rows`);
  }
  const rank = new Map(
    WALMART_LISTING_FULL_SURFACE_OPERATION_ORDER.map((kind, index) => [kind, index]),
  );
  let priorRank = -1;
  const operationIds = new Set<string>();
  const operations = input.operations.map((operation, index) => {
    const operationRank = rank.get(operation.operation_kind);
    if (operationRank === undefined || operationRank < priorRank) {
      fail("operations are not in canonical plane order");
    }
    priorRank = operationRank;
    if (operationIds.has(operation.operation_id)) fail("operation_id is duplicated");
    operationIds.add(operation.operation_id);
    return buildOperation(operation, index, listingSkus);
  });
  const body = {
    schema_version: WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA,
    plan_id: safeId(input.plan_id, "plan_id"),
    owner_decision_id: safeId(input.owner_decision_id, "owner_decision_id"),
    owner_decision_sha256: exactSha(
      input.owner_decision_sha256,
      "owner decision",
    ),
    created_at: input.created_at,
    expires_at: input.expires_at,
    seller_account_fingerprint_sha256: exactSha(
      input.seller_account_fingerprint_sha256,
      "seller account fingerprint",
    ),
    product_truth_snapshot_sha256: exactSha(
      input.product_truth_snapshot_sha256,
      "Product Truth snapshot",
    ),
    exact_listings: Object.freeze(exactListings),
    operations: Object.freeze(operations),
    execution_policy: Object.freeze({
      exact_operation_permit_required: true as const,
      durable_operation_consumption_required: true as const,
      operation_payload_sha256_binding_required: true as const,
      maximum_in_flight_operations: 1 as const,
      automatic_retry_allowed: false as const,
      automatic_replay_allowed: false as const,
      stop_after_non_success: true as const,
      fresh_api_specific_readback_required: true as const,
      buyer_surface_qualification_required_after_item_change: true as const,
    }),
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingFullSurfaceSha256(body),
  });
}

export function verifyWalmartListingFullSurfaceOutcome(
  plan: WalmartListingFullSurfacePlan,
  outcome: WalmartListingFullSurfaceOutcome,
): void {
  if (outcome.schema_version !== WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA) {
    fail("outcome schema_version is invalid");
  }
  if (outcome.plan_body_sha256 !== plan.body_sha256) {
    fail("outcome is bound to another plan");
  }
  const operation = plan.operations.find(
    (candidate) => candidate.operation_id === outcome.operation_id,
  );
  if (!operation) fail("outcome operation is outside the plan");
  if (
    outcome.operation_body_sha256 !== operation.body_sha256
    || outcome.request_payload_sha256
      !== operation.exact_request.request_payload_sha256
  ) {
    fail("outcome operation/request binding mismatch");
  }
  exactSha(outcome.permit_authorization_sha256, "outcome permit");
  exactSha(outcome.consumption_ledger_sha256, "outcome consumption ledger");
  exactTime(outcome.attempted_at, "outcome attempted_at");
  if (outcome.marketplace_write_calls !== 1) {
    fail("outcome must prove exactly one marketplace write call");
  }
  if (
    outcome.outcome === "SUCCEEDED_AND_READ_BACK"
      ? outcome.readback_sha256 === null
      : outcome.readback_sha256 !== null
  ) {
    fail("outcome readback binding is inconsistent");
  }
  if (outcome.readback_sha256) exactSha(outcome.readback_sha256, "readback");
  if (outcome.diagnostic_sha256) {
    exactSha(outcome.diagnostic_sha256, "diagnostic");
  }
  const body = withoutKey(outcome, "body_sha256");
  if (walmartListingFullSurfaceSha256(body) !== outcome.body_sha256) {
    fail("outcome body_sha256 mismatch");
  }
}

export function nextWalmartListingFullSurfaceAction(
  plan: WalmartListingFullSurfacePlan,
  outcomes: readonly WalmartListingFullSurfaceOutcome[],
): WalmartListingFullSurfaceNextAction {
  if (outcomes.length > plan.operations.length) fail("too many outcomes");
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const expected = plan.operations[index];
    if (outcome.operation_id !== expected.operation_id) {
      fail("outcomes are not a contiguous operation prefix");
    }
    verifyWalmartListingFullSurfaceOutcome(plan, outcome);
    if (outcome.outcome !== "SUCCEEDED_AND_READ_BACK") {
      return Object.freeze({
        action: "STOP_NO_REPLAY",
        operation_id: outcome.operation_id,
        reason: outcome.outcome,
      });
    }
  }
  if (outcomes.length === plan.operations.length) {
    return Object.freeze({ action: "COMPLETE" });
  }
  return Object.freeze({
    action: "EXECUTE_OPERATION",
    operation: plan.operations[outcomes.length],
  });
}
