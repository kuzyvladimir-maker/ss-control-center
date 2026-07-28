/**
 * Pure, offline compiler for a frozen Walmart 180-day listing-performance
 * source. The compiler consumes only content-sealed, paginated raw Orders and
 * Returns captures plus a content-sealed projection of the complete current
 * PUBLISHED population. It has no filesystem, network, database, or clock
 * dependency.
 *
 * Safety properties:
 * - listing identity is store-scoped and SKU case is preserved;
 * - every cursor page and advertised entity count is reconciled;
 * - money is parsed from decimal strings directly into integer cents;
 * - return outcomes are joined to the exact sales-cohort PO + line identity;
 * - outcome buckets are mutually exclusive and cannot exceed sold units;
 * - every PUBLISHED listing receives a row, including all-zero rows;
 * - every emitted artifact can be rebuilt from, and verified against, its
 *   exact sealed source artifacts.
 */

import { createHash } from "node:crypto";

import {
  walmartListingKey,
  type WalmartListingIdentity,
} from "./catalog-truth-export.ts";
import {
  WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
  verifyWalmartItemReportPublishedSource,
  verifyWalmartItemReportPublishedSourceAgainstCapture,
  type WalmartItemReportCaptureEvidence,
  type WalmartItemReportCompileContext,
  type SealedWalmartItemReportPublishedSource,
} from "./item-report-published-source.ts";

export const WALMART_PERFORMANCE_POPULATION_SCHEMA =
  "walmart-performance-published-population/v1" as const;
export const WALMART_RAW_ORDERS_PAGES_SCHEMA =
  "walmart-raw-orders-pages/v2" as const;
export const WALMART_RAW_RETURNS_PAGES_SCHEMA =
  "walmart-raw-returns-pages/v1" as const;
export const WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA =
  "walmart-shadow-performance-source/v3" as const;
export const WALMART_PERFORMANCE_OPERATIONAL_VERIFICATION_SCHEMA =
  "walmart-performance-operational-verification/v1" as const;

const CHANNEL = "WALMART_US" as const;
const WINDOW_DAYS = 180 as const;
const DAY_MS = 86_400_000;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_PAGE_BYTES / 3);
const MAX_ARTIFACT_TRANSPORT_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_BASE64_CHARACTERS = 4 * Math.ceil(MAX_ARTIFACT_TRANSPORT_BYTES / 3);
const MAX_COMPILE_TRANSPORT_BYTES = 1024 * 1024 * 1024;
const MAX_COMPILE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_COMPILE_TRANSPORT_BYTES / 3);
const MAX_PAGES_PER_PARTITION = 10_000;
const MAX_CURSOR_LENGTH = 32_768;
const MAX_ID_LENGTH = 512;
const MAX_SKU_LENGTH = 512;
const MAX_RETURNS_PER_PARTITION = 100_000;
const MAX_PUBLISHED_ROWS_PER_STORE = 1_000_000;
const MAX_ORDER_LINES_PER_ORDER = 1_000;
const MAX_RETURN_LINES_PER_RETURN = 1_000;
const MAX_ORDER_LINES_PER_COMPILE = 2_000_000;
const MAX_RETURN_LINES_PER_COMPILE = 2_000_000;
const MAX_ORDERS_PER_COMPILE = 1_000_000;
const MAX_RETURNS_PER_COMPILE = 1_000_000;
const MAX_STATUSES_PER_ORDER_LINE = 32;
const MAX_CHARGES_PER_ORDER_LINE = 128;
const MAX_TRACKING_EVENTS_PER_RETURN_LINE = 128;
const MAX_REFUND_CHANNELS_PER_RETURN_LINE = 128;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 2_000_000;
const MAX_JSON_KEYS = 1_000_000;
const MAX_JSON_KEYS_PER_OBJECT = 100_000;
const MAX_JSON_STRING_CHARACTERS = 16 * 1024 * 1024;
const MAX_JSON_TOTAL_STRING_CHARACTERS = 256 * 1024 * 1024;

export const WALMART_ORDER_SHIP_NODE_TYPES = Object.freeze([
  "SellerFulfilled",
  "WFSFulfilled",
  "3PLFulfilled",
] as const);
export type WalmartOrderShipNodeType = typeof WALMART_ORDER_SHIP_NODE_TYPES[number];

export const WALMART_RETURN_WFS_SCOPES = Object.freeze(["N", "Y"] as const);
export type WalmartReturnWfsScope = typeof WALMART_RETURN_WFS_SCOPES[number];

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface WalmartPerformanceAccountScope {
  channel: typeof CHANNEL;
  store_index: number;
  seller_account_fingerprint_sha256: string;
}

export interface WalmartPerformanceSourceReference {
  schema_version: typeof WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA;
  source_id: string;
  body_sha256: string;
  raw_transport_sha256: string;
  decoded_report_sha256: string;
  cutoff_at: string;
}

export interface WalmartPerformancePopulationBody {
  schema_version: typeof WALMART_PERFORMANCE_POPULATION_SCHEMA;
  captured_at: string;
  channel: typeof CHANNEL;
  store_index: number;
  account_scope: WalmartPerformanceAccountScope;
  published_population_complete: true;
  upstream_source: WalmartPerformanceSourceReference;
  rows: Array<WalmartListingIdentity & { published_status: "PUBLISHED" }>;
}

export interface WalmartRawPage {
  page_index: number;
  request_cursor: string | null;
  request_method: "GET";
  request_path: "/v3/orders" | "/v3/returns";
  /** Exact URL query component sent on the wire, excluding the leading `?`. */
  request_query_raw: string;
  requested_at: string;
  completed_at: string;
  request_correlation_id_sha256: string;
  response_correlation_id_sha256: string | null;
  response_status: 200;
  response_content_type_raw: string;
  response_media_type: "application/json";
  /** Exact HTTP response body bytes, canonical RFC 4648 base64. */
  response_body_base64: string;
  response_body_byte_length: number;
  response_body_sha256: string;
}

export interface WalmartRawPageProvenance {
  requested_at: string;
  completed_at: string;
  request_correlation_id_sha256: string;
  response_correlation_id_sha256: string | null;
}

export interface WalmartRawOrdersPagesBody {
  schema_version: typeof WALMART_RAW_ORDERS_PAGES_SCHEMA;
  partition_id: string;
  captured_at: string;
  channel: typeof CHANNEL;
  store_index: number;
  account_scope: WalmartPerformanceAccountScope;
  request: {
    sales_window_starts_at_exclusive: string;
    sales_window_ends_at_exclusive: string;
    partition_starts_at_exclusive: string;
    partition_ends_at_exclusive: string;
    api_created_start_date_exclusive: string;
    api_created_end_date_exclusive: string;
    limit: number;
    product_info: true;
    ship_node_type: WalmartOrderShipNodeType;
    replacement_info: true;
    product_charge_amount_scope: "UNPROVEN_UNIT_VS_LINE_TOTAL";
  };
  pages: WalmartRawPage[];
}

export interface WalmartRawReturnsPagesBody {
  schema_version: typeof WALMART_RAW_RETURNS_PAGES_SCHEMA;
  captured_at: string;
  channel: typeof CHANNEL;
  store_index: number;
  account_scope: WalmartPerformanceAccountScope;
  request: {
    observation_starts_at_inclusive: string;
    observation_cutoff_at_exclusive: string;
    api_return_creation_start_date_inclusive: string;
    api_return_creation_end_date_inclusive: string;
    limit: number;
    replacement_info: true;
    wfs_enabled: WalmartReturnWfsScope;
  };
  pages: WalmartRawPage[];
}

export interface ArtifactSeal {
  artifact_id: string;
  body_sha256: string;
}

export type SealedWalmartPerformancePopulation =
  WalmartPerformancePopulationBody & ArtifactSeal;
export type SealedWalmartRawOrdersPages = WalmartRawOrdersPagesBody & ArtifactSeal;
export type SealedWalmartRawReturnsPages = WalmartRawReturnsPagesBody & ArtifactSeal;

export const WALMART_PERFORMANCE_COHORT_SEMANTICS = deepFreeze({
  cohort: "FULFILLED_NON_CANCELLED_ORDER_LINES_CREATED_IN_OPEN_SALES_WINDOW",
  sales_window_boundary: "START_EXCLUSIVE_END_EXCLUSIVE",
  included_order_types: ["REGULAR", "PREORDER"],
  excluded_order_types: ["REPLACEMENT"],
  order_ship_node_scopes: ["SellerFulfilled", "WFSFulfilled", "3PLFulfilled"],
  return_wfs_scopes: ["N", "Y"],
  eligible_order_line_statuses: ["SHIPPED", "DELIVERED"],
  excluded_order_line_statuses: ["CANCELLED", "CREATED", "ACKNOWLEDGED"],
  outcome_join_key: "STORE_INDEX_PURCHASE_ORDER_ID_LINE_NUMBER",
  outcome_precedence: ["REPLACEMENT", "REFUND", "RETURN"],
  allocation: "SEQUENTIAL_AGAINST_REMAINING_SOLD_UNITS",
  unmatched_or_pre_window_outcomes: "RECONCILIATION_ONLY_EXCLUDED_FROM_RATE",
  orders_partition_coverage: "CANONICAL_STRICTLY_OVERLAPPING_OPEN_INTERVAL_UNION",
  minimum_orders_partitions_per_store_scope: 2,
} as const);

export const WALMART_PERFORMANCE_MONEY_SEMANTICS = deepFreeze({
  currency: "USD",
  included_charge_type: "PRODUCT",
  charge_amount_scope: "UNPROVEN_UNIT_VS_LINE_TOTAL",
  gross_sales_cents_status: "PROVISIONAL_PENDING_INDEPENDENT_MLMQ_CALIBRATION",
  input: "DECIMAL_STRING_OR_FINITE_SAFE_JSON_NUMBER_MAX_TWO_FRACTION_DIGITS",
  provisional_partial_line_allocation:
    "TREAT_PRODUCT_CHARGE_AS_LINE_TOTAL_PRO_RATA_ROUND_HALF_UP_PENDING_CALIBRATION",
  returns_are_not_netted_from_gross_sales: true,
} as const);

/**
 * This fixed block is deliberately not caller-configurable. In particular, a
 * caller-authored assertion cannot promote PRODUCT charges to calibrated
 * revenue or make the source operationally ready.
 */
export const WALMART_PERFORMANCE_ASSURANCE = deepFreeze({
  standalone_source_integrity: "CANONICAL_SELF_SEALED_REBUILDABLE_INTEGRITY_ONLY",
  item_report_capture_verification: "NOT_PERFORMED_BY_STANDALONE_COMPILER",
  orders_returns_server_authenticity: "UNVERIFIED_NO_TRUSTED_CAPTURE_ADAPTER",
  gross_sales_calibration: "UNVERIFIED_MLMQ_QUANTITY_GT_ONE",
  gross_sales_operationally_usable: false,
  shadow_sampling_rank_basis: "UNITS_SOLD_ONLY",
  operational_ready: false,
} as const);

export interface WalmartFrozenPerformanceRow extends WalmartListingIdentity {
  gross_sales_cents: number;
  units_sold: number;
  units_returned: number;
  units_refunded: number;
  units_replaced: number;
}

export interface WalmartFrozenPerformanceSourceBinding {
  schema_version: string;
  source_scope: string;
  seller_account_fingerprint_sha256: string;
  artifact_id: string;
  body_sha256: string;
  captured_at: string;
  store_index: number;
  partition_id: string | null;
  partition_starts_at_exclusive: string | null;
  partition_ends_at_exclusive: string | null;
}

export interface WalmartFrozenPerformanceReconciliation {
  published_population_rows: number;
  unique_orders: number;
  order_lines: number;
  eligible_sold_lines: number;
  unique_returns: number;
  return_lines: number;
  replacement_order_lines_excluded: number;
  order_lines_outside_published_population: number;
  outcome_units_outside_sales_cohort: number;
  outcome_units_outside_published_population: number;
  outcome_units_suppressed_by_precedence: number;
  cancelled_outcome_units_excluded: number;
  order_partitions: number;
  order_partition_ids: string[];
  overlapping_orders_deduplicated: number;
  outcome_units_unknown_or_pre_window_purchase_order: number;
  outcome_units_replacement_purchase_order: number;
}

export interface WalmartFrozen180DayPerformanceSourceBody {
  schema_version: typeof WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA;
  captured_at: string;
  channel: typeof CHANNEL;
  published_population_complete: true;
  sales_window: {
    starts_at: string;
    start_exclusive: true;
    ends_at: string;
    end_exclusive: true;
    days: typeof WINDOW_DAYS;
  };
  outcome_observation: {
    starts_at: string;
    cutoff_at: string;
    end_exclusive: true;
  };
  cohort_semantics: typeof WALMART_PERFORMANCE_COHORT_SEMANTICS;
  money_semantics: typeof WALMART_PERFORMANCE_MONEY_SEMANTICS;
  assurance: typeof WALMART_PERFORMANCE_ASSURANCE;
  source_bindings: {
    published_population: WalmartFrozenPerformanceSourceBinding[];
    orders: WalmartFrozenPerformanceSourceBinding[];
    returns: WalmartFrozenPerformanceSourceBinding[];
  };
  source_reconciliation: WalmartFrozenPerformanceReconciliation;
  rows: WalmartFrozenPerformanceRow[];
}

export type SealedWalmartFrozen180DayPerformanceSource =
  WalmartFrozen180DayPerformanceSourceBody & {
    snapshot_id: string;
    body_sha256: string;
  };

export interface WalmartFrozenPerformanceCompileInput {
  published_populations: readonly SealedWalmartPerformancePopulation[];
  orders: readonly SealedWalmartRawOrdersPages[];
  returns: readonly SealedWalmartRawReturnsPages[];
}

export interface WalmartFrozenPerformanceAuthoritativeCompileInput {
  published_item_sources: readonly SealedWalmartItemReportPublishedSource[];
  orders: readonly SealedWalmartRawOrdersPages[];
  returns: readonly SealedWalmartRawReturnsPages[];
}

export interface WalmartOrdersPartitionIdentityInput {
  store_index: number;
  seller_account_fingerprint_sha256: string;
  ship_node_type: WalmartOrderShipNodeType;
  sales_window_starts_at_exclusive: string;
  sales_window_ends_at_exclusive: string;
  partition_starts_at_exclusive: string;
  partition_ends_at_exclusive: string;
}

export interface WalmartTrustedPerformanceAccount {
  channel: typeof CHANNEL;
  store_index: number;
  seller_account_fingerprint_sha256: string;
}

export interface WalmartCaptureAwareItemReportInput {
  source: SealedWalmartItemReportPublishedSource;
  capture: WalmartItemReportCaptureEvidence;
  trusted_context: WalmartItemReportCompileContext;
}

export interface WalmartFrozenPerformanceOperationalVerificationInput {
  trusted_accounts: readonly WalmartTrustedPerformanceAccount[];
  published_item_captures: readonly WalmartCaptureAwareItemReportInput[];
  orders: readonly SealedWalmartRawOrdersPages[];
  returns: readonly SealedWalmartRawReturnsPages[];
}

export interface WalmartFrozenPerformanceOperationalVerification {
  schema_version: typeof WALMART_PERFORMANCE_OPERATIONAL_VERIFICATION_SCHEMA;
  performance_snapshot_id: string;
  performance_body_sha256: string;
  trusted_account_registry_sha256: string;
  verified_store_indexes: number[];
  item_report_capture_aware_verified: true;
  orders_returns_capture_aware_verified: false;
  gross_sales_calibration_verified: false;
  provisional_sampling_rank_basis: "UNITS_SOLD_ONLY";
  operational_ready: false;
  blockers: readonly [
    "TRUSTED_ORDERS_RETURNS_CAPTURE_ADAPTER_MISSING",
    "MLMQ_PRODUCT_CHARGE_SCOPE_CALIBRATION_MISSING",
  ];
}

interface ParsedPageCollection {
  records: JsonObject[];
  advertised_total_count: number;
}

interface MetricAccumulator {
  gross_sales_cents: number;
  units_sold: number;
  units_returned: number;
  units_refunded: number;
  units_replaced: number;
}

interface CohortLine {
  listing_key: string;
  sku: string;
  ordered_units: number;
  eligible_units: number;
}

type RawReturnType = "PREORDER" | "REFUND" | "REPLACEMENT";
type RawOrderType = "REGULAR" | "PREORDER" | "REPLACEMENT";

interface OutcomeAccumulator {
  RETURN: number;
  REFUND: number;
  REPLACEMENT: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Iterative preflight keeps hostile-but-small deeply nested JSON from reaching
 * recursive canonicalization/freezing. It also makes all resource failures
 * controlled contract errors rather than JavaScript RangeErrors.
 */
function assertJsonComplexity(value: unknown, rootPath = "$"): void {
  type Frame = { value: unknown; path: string; depth: number; exit?: boolean };
  const stack: Frame[] = [{ value, path: rootPath, depth: 0 }];
  const active = new Set<object>();
  let nodes = 0;
  let keys = 0;
  let stringCharacters = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      active.delete(frame.value as object);
      continue;
    }
    nodes = checkedAdd(nodes, 1, `${rootPath} JSON node count`);
    if (nodes > MAX_JSON_NODES) throw new Error(`${rootPath} exceeds the JSON node budget`);
    if (frame.depth > MAX_JSON_DEPTH) throw new Error(`${frame.path} exceeds the JSON depth budget`);
    const current = frame.value;
    if (typeof current === "string") {
      if (current.length > MAX_JSON_STRING_CHARACTERS) {
        throw new Error(`${frame.path} exceeds the per-string JSON character budget`);
      }
      stringCharacters = checkedAdd(
        stringCharacters,
        current.length,
        `${rootPath} JSON string characters`,
      );
      if (stringCharacters > MAX_JSON_TOTAL_STRING_CHARACTERS) {
        throw new Error(`${rootPath} exceeds the aggregate JSON string-character budget`);
      }
      continue;
    }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${frame.path} contains a non-JSON number`);
      if (Object.is(current, -0)) throw new Error(`${frame.path} contains ambiguous negative zero`);
      continue;
    }
    if (typeof current !== "object" || current === undefined) {
      throw new Error(`${frame.path} contains a non-JSON value`);
    }
    if (active.has(current)) throw new Error(`${frame.path} contains a cycle`);
    active.add(current);
    stack.push({ ...frame, exit: true });
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (!(index in current)) throw new Error(`${frame.path}[${index}] is an array hole`);
        stack.push({
          value: current[index],
          path: `${frame.path}[${index}]`,
          depth: frame.depth + 1,
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${frame.path} must contain plain JSON objects only`);
    }
    const objectKeys = Object.keys(current);
    if (objectKeys.length > MAX_JSON_KEYS_PER_OBJECT) {
      throw new Error(`${frame.path} exceeds the per-object JSON key budget`);
    }
    keys = checkedAdd(keys, objectKeys.length, `${rootPath} JSON key count`);
    if (keys > MAX_JSON_KEYS) throw new Error(`${rootPath} exceeds the JSON key budget`);
    for (let index = objectKeys.length - 1; index >= 0; index -= 1) {
      const key = objectKeys[index];
      if (key.length > MAX_JSON_STRING_CHARACTERS) {
        throw new Error(`${frame.path} contains an overlong JSON key`);
      }
      stringCharacters = checkedAdd(
        stringCharacters,
        key.length,
        `${rootPath} JSON string characters`,
      );
      if (stringCharacters > MAX_JSON_TOTAL_STRING_CHARACTERS) {
        throw new Error(`${rootPath} exceeds the aggregate JSON string-character budget`);
      }
      stack.push({
        value: (current as Record<string, unknown>)[key],
        path: `${frame.path}.${key}`,
        depth: frame.depth + 1,
      });
    }
  }
}

function canonicalJsonInternal(value: unknown, path: string, active: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-JSON number`);
    }
    if (Object.is(value, -0)) throw new Error(`${path} contains ambiguous negative zero`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`${path} contains a non-JSON value`);
  }
  if (active.has(value)) throw new Error(`${path} contains a cycle`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error(`${path}[${index}] is an array hole`);
      }
      return `[${value.map((item, index) => canonicalJsonInternal(item, `${path}[${index}]`, active)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain plain JSON objects only`);
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort(compareCodeUnits).map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonInternal(object[key], `${path}.${key}`, active)}`
    )).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function canonicalJson(value: unknown, path = "$"): string {
  assertJsonComplexity(value, path);
  return canonicalJsonInternal(value, path, new Set<object>());
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function walmartPerformanceCanonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${path} must have exact keys ${wanted.join(", ")}`);
  }
}

function requiredString(value: unknown, path: string, maximumLength = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty already-trimmed string`);
  }
  if (value.length > maximumLength) throw new Error(`${path} exceeds ${maximumLength} characters`);
  return value;
}

function requiredOpaqueCursor(value: unknown, path: string): string {
  return requiredString(value, path, MAX_CURSOR_LENGTH);
}

function requiredRawQuery(value: unknown, path: string): string {
  const query = requiredString(value, path, MAX_CURSOR_LENGTH);
  if (query.startsWith("?") || query.includes("#") || /[\r\n]/.test(query)) {
    throw new Error(`${path} must be an exact URL query component without leading ?, fragment, or CR/LF`);
  }
  return query;
}

function cursorToRawQuery(value: string, path: string): string {
  const query = value.startsWith("?") ? value.slice(1) : value;
  if (query.length === 0 || query.startsWith("?")) {
    throw new Error(`${path} cannot be normalized to one URL query component`);
  }
  return requiredRawQuery(query, path);
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function canonicalRawQuery(entries: readonly (readonly [string, string])[]): string {
  return entries.map(([key, value]) => (
    `${encodeQueryValue(key)}=${encodeQueryValue(value)}`
  )).join("&");
}

function requiredSha(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function parseAccountScope(
  value: unknown,
  path: string,
  expectedStoreIndex?: number,
): WalmartPerformanceAccountScope {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "channel", "store_index", "seller_account_fingerprint_sha256",
  ], path);
  if (value.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  const storeIndex = requiredSafeInteger(value.store_index, `${path}.store_index`, 1);
  if (expectedStoreIndex !== undefined && storeIndex !== expectedStoreIndex) {
    throw new Error(`${path}.store_index must match the artifact store_index`);
  }
  return {
    channel: CHANNEL,
    store_index: storeIndex,
    seller_account_fingerprint_sha256: requiredSha(
      value.seller_account_fingerprint_sha256,
      `${path}.seller_account_fingerprint_sha256`,
    ),
  };
}

function requiredIntegerLike(value: unknown, path: string, minimum = 0): number {
  if (typeof value === "number") return requiredSafeInteger(value, path, minimum);
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${path} must be a canonical non-negative integer string or safe integer`);
  }
  const parsed = Number(value);
  return requiredSafeInteger(parsed, path, minimum);
}

function requiredCanonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a canonical UTC timestamp`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${path} must be canonical ISO UTC with millisecond precision`);
  }
  return value;
}

function parseRawInstant(value: unknown, path: string): number {
  if (typeof value === "number") {
    return requiredSafeInteger(value, path, 0);
  }
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${path} must be an ISO timestamp or epoch-millisecond integer`);
  }
  if (/^(0|[1-9]\d*)$/.test(value)) {
    return requiredSafeInteger(Number(value), path, 0);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error(`${path} is not a strict ISO-8601 instant`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const maxDay = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > maxDay
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${path} is not a valid ISO-8601 instant`);
  }
  const localMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMillis = match[8] === "Z"
    ? 0
    : offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const millis = localMillis - offsetMillis;
  if (!Number.isSafeInteger(millis)) throw new Error(`${path} is outside supported range`);
  return millis;
}

function checkedAdd(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${path} exceeds the non-negative safe-integer range`);
  }
  return result;
}

function parseUsdCents(value: unknown, path: string): number {
  let decimal: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
      || Object.is(value, -0)) {
      throw new Error(`${path} must be a finite non-negative safe JSON number`);
    }
    decimal = String(value);
  } else if (typeof value === "string" && value === value.trim()) {
    decimal = value;
  } else {
    throw new Error(`${path} must be a decimal string or finite non-negative safe JSON number`);
  }
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) throw new Error(`${path} must have at most two decimal places`);
  const cents = BigInt(match[1]) * BigInt(100)
    + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${path} exceeds the safe-integer cents range`);
  }
  return Number(cents);
}

function parseIdentity(value: unknown, path: string): WalmartListingIdentity {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  const storeIndex = requiredSafeInteger(value.store_index, `${path}.store_index`, 1);
  const sku = requiredString(value.sku, `${path}.sku`, MAX_SKU_LENGTH);
  const listingKey = requiredString(value.listing_key, `${path}.listing_key`);
  const expected = walmartListingKey(storeIndex, sku);
  if (listingKey !== expected) throw new Error(`${path}.listing_key must equal ${expected}`);
  return { channel: CHANNEL, store_index: storeIndex, sku, listing_key: listingKey };
}

function parseSourceReference(value: unknown, path: string): WalmartPerformanceSourceReference {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "source_id", "body_sha256", "raw_transport_sha256",
    "decoded_report_sha256", "cutoff_at",
  ], path);
  if (value.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error(`${path}.schema_version must be ${WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA}`);
  }
  return {
    schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
    source_id: requiredString(value.source_id, `${path}.source_id`),
    body_sha256: requiredSha(value.body_sha256, `${path}.body_sha256`),
    raw_transport_sha256: requiredSha(
      value.raw_transport_sha256,
      `${path}.raw_transport_sha256`,
    ),
    decoded_report_sha256: requiredSha(
      value.decoded_report_sha256,
      `${path}.decoded_report_sha256`,
    ),
    cutoff_at: requiredCanonicalTimestamp(value.cutoff_at, `${path}.cutoff_at`),
  };
}

function parseWindow(startsAtValue: unknown, endsAtValue: unknown, path: string): {
  starts_at: string;
  ends_at: string;
  starts_ms: number;
  ends_ms: number;
} {
  const startsAt = requiredCanonicalTimestamp(startsAtValue, `${path}.starts_at`);
  const endsAt = requiredCanonicalTimestamp(endsAtValue, `${path}.ends_at`);
  const startsMs = Date.parse(startsAt);
  const endsMs = Date.parse(endsAt);
  if (endsMs - startsMs !== WINDOW_DAYS * DAY_MS) {
    throw new Error(`${path} must span exactly ${WINDOW_DAYS} days`);
  }
  return { starts_at: startsAt, ends_at: endsAt, starts_ms: startsMs, ends_ms: endsMs };
}

function parseOpenInterval(startsAtValue: unknown, endsAtValue: unknown, path: string): {
  starts_at: string;
  ends_at: string;
  starts_ms: number;
  ends_ms: number;
} {
  const startsAt = requiredCanonicalTimestamp(startsAtValue, `${path}.starts_at`);
  const endsAt = requiredCanonicalTimestamp(endsAtValue, `${path}.ends_at`);
  const startsMs = Date.parse(startsAt);
  const endsMs = Date.parse(endsAt);
  if (endsMs <= startsMs) throw new Error(`${path} end must strictly follow start`);
  return { starts_at: startsAt, ends_at: endsAt, starts_ms: startsMs, ends_ms: endsMs };
}

/** Stable identity of one exact API Orders interval inside a final cohort. */
export function walmartOrdersPartitionId(input: WalmartOrdersPartitionIdentityInput): string {
  if (!isRecord(input)) throw new Error("orders partition identity input must be an object");
  assertExactKeys(input, [
    "store_index", "seller_account_fingerprint_sha256", "ship_node_type",
    "sales_window_starts_at_exclusive", "sales_window_ends_at_exclusive",
    "partition_starts_at_exclusive", "partition_ends_at_exclusive",
  ], "orders partition identity input");
  const storeIndex = requiredSafeInteger(input.store_index, "orders partition identity input.store_index", 1);
  const fingerprint = requiredSha(
    input.seller_account_fingerprint_sha256,
    "orders partition identity input.seller_account_fingerprint_sha256",
  );
  if (!WALMART_ORDER_SHIP_NODE_TYPES.includes(input.ship_node_type)) {
    throw new Error("orders partition identity input.ship_node_type is unsupported");
  }
  const window = parseWindow(
    input.sales_window_starts_at_exclusive,
    input.sales_window_ends_at_exclusive,
    "orders partition identity input.sales_window",
  );
  const partition = parseOpenInterval(
    input.partition_starts_at_exclusive,
    input.partition_ends_at_exclusive,
    "orders partition identity input.partition",
  );
  if (partition.starts_ms < window.starts_ms || partition.ends_ms > window.ends_ms) {
    throw new Error("orders partition identity interval must be contained in the final sales window");
  }
  const digest = walmartPerformanceCanonicalSha256({
    channel: CHANNEL,
    store_index: storeIndex,
    seller_account_fingerprint_sha256: fingerprint,
    ship_node_type: input.ship_node_type,
    sales_window_starts_at_exclusive: window.starts_at,
    sales_window_ends_at_exclusive: window.ends_at,
    partition_starts_at_exclusive: partition.starts_at,
    partition_ends_at_exclusive: partition.ends_at,
  });
  return `walmart-orders-partition-${digest.slice(0, 24)}`;
}

function parsePopulationBody(value: unknown): WalmartPerformancePopulationBody {
  const path = "published population body";
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "captured_at", "channel", "store_index",
    "account_scope", "published_population_complete", "upstream_source", "rows",
  ], path);
  if (value.schema_version !== WALMART_PERFORMANCE_POPULATION_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  if (value.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  if (value.published_population_complete !== true) {
    throw new Error(`${path}.published_population_complete must be true`);
  }
  const storeIndex = requiredSafeInteger(value.store_index, `${path}.store_index`, 1);
  const accountScope = parseAccountScope(value.account_scope, `${path}.account_scope`, storeIndex);
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    throw new Error(`${path}.rows must be a non-empty array`);
  }
  if (value.rows.length > MAX_PUBLISHED_ROWS_PER_STORE) {
    throw new Error(`${path}.rows exceeds the published-population cap`);
  }
  const seen = new Set<string>();
  const rows = value.rows.map((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(row, [
      "channel", "store_index", "sku", "listing_key", "published_status",
    ], rowPath);
    const identity = parseIdentity(row, rowPath);
    if (identity.store_index !== storeIndex) {
      throw new Error(`${rowPath}.store_index must match population store_index`);
    }
    if (row.published_status !== "PUBLISHED") {
      throw new Error(`${rowPath}.published_status must be PUBLISHED`);
    }
    if (seen.has(identity.listing_key)) {
      throw new Error(`${path}.rows has duplicate listing_key ${identity.listing_key}`);
    }
    seen.add(identity.listing_key);
    return { ...identity, published_status: "PUBLISHED" as const };
  });
  const keys = rows.map((row) => row.listing_key);
  if (canonicalJson(keys) !== canonicalJson([...keys].sort(compareCodeUnits))) {
    throw new Error(`${path}.rows must be in canonical listing_key order`);
  }
  const capturedAt = requiredCanonicalTimestamp(value.captured_at, `${path}.captured_at`);
  const upstreamSource = parseSourceReference(value.upstream_source, `${path}.upstream_source`);
  if (upstreamSource.cutoff_at !== capturedAt) {
    throw new Error(`${path}.captured_at must equal upstream_source.cutoff_at`);
  }
  return {
    schema_version: WALMART_PERFORMANCE_POPULATION_SCHEMA,
    captured_at: capturedAt,
    channel: CHANNEL,
    store_index: storeIndex,
    account_scope: accountScope,
    published_population_complete: true,
    upstream_source: upstreamSource,
    rows,
  };
}

function parseRawPage(value: unknown, path: string): WalmartRawPage {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "page_index", "request_cursor", "request_method", "request_path", "request_query_raw",
    "requested_at", "completed_at", "request_correlation_id_sha256",
    "response_correlation_id_sha256",
    "response_status", "response_content_type_raw", "response_media_type", "response_body_base64",
    "response_body_byte_length", "response_body_sha256",
  ], path);
  if (value.request_method !== "GET") throw new Error(`${path}.request_method must be GET`);
  if (value.request_path !== "/v3/orders" && value.request_path !== "/v3/returns") {
    throw new Error(`${path}.request_path must be /v3/orders or /v3/returns`);
  }
  const requestQueryRaw = requiredRawQuery(value.request_query_raw, `${path}.request_query_raw`);
  const requestedAt = requiredCanonicalTimestamp(value.requested_at, `${path}.requested_at`);
  const completedAt = requiredCanonicalTimestamp(value.completed_at, `${path}.completed_at`);
  if (Date.parse(completedAt) < Date.parse(requestedAt)) {
    throw new Error(`${path}.completed_at cannot precede requested_at`);
  }
  const requestCorrelation = requiredSha(
    value.request_correlation_id_sha256,
    `${path}.request_correlation_id_sha256`,
  );
  const responseCorrelation = value.response_correlation_id_sha256 === null
    ? null
    : requiredSha(
      value.response_correlation_id_sha256,
      `${path}.response_correlation_id_sha256`,
    );
  if (responseCorrelation !== null && responseCorrelation !== requestCorrelation) {
    throw new Error(`${path}.response_correlation_id_sha256 conflicts with the request correlation`);
  }
  if (value.response_status !== 200) throw new Error(`${path}.response_status must be 200`);
  const contentTypeRaw = requiredString(
    value.response_content_type_raw,
    `${path}.response_content_type_raw`,
    512,
  );
  if (/\r|\n/.test(contentTypeRaw)) throw new Error(`${path}.response_content_type_raw contains CR/LF`);
  const contentTypeParts = contentTypeRaw.split(";").map((part) => part.trim().toLowerCase());
  if (contentTypeParts[0] !== "application/json") {
    throw new Error(`${path}.response_content_type_raw must have application/json media type`);
  }
  for (const parameter of contentTypeParts.slice(1)) {
    if (parameter !== "charset=utf-8" && parameter !== "charset=\"utf-8\"") {
      throw new Error(`${path}.response_content_type_raw has unsupported parameter ${parameter}`);
    }
  }
  if (value.response_media_type !== "application/json") {
    throw new Error(`${path}.response_media_type must be application/json`);
  }
  if (typeof value.response_body_base64 !== "string" || value.response_body_base64.length === 0) {
    throw new Error(`${path}.response_body_base64 must be non-empty canonical base64`);
  }
  if (value.response_body_base64.length > MAX_PAGE_BASE64_CHARACTERS) {
    throw new Error(`${path}.response_body_base64 exceeds the per-page encoded transport cap`);
  }
  const bytes = Buffer.from(value.response_body_base64, "base64");
  if (bytes.toString("base64") !== value.response_body_base64) {
    throw new Error(`${path}.response_body_base64 must be canonical RFC 4648 base64`);
  }
  const declaredLength = requiredSafeInteger(
    value.response_body_byte_length,
    `${path}.response_body_byte_length`,
    1,
  );
  if (declaredLength !== bytes.byteLength) {
    throw new Error(`${path}.response_body_byte_length does not match decoded bytes`);
  }
  if (bytes.byteLength > MAX_PAGE_BYTES) {
    throw new Error(`${path} exceeds the ${MAX_PAGE_BYTES}-byte transport cap`);
  }
  const responseSha = requiredSha(value.response_body_sha256, `${path}.response_body_sha256`);
  if (createHash("sha256").update(bytes).digest("hex") !== responseSha) {
    throw new Error(`${path}.response_body_sha256 does not match the exact response bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path}.response_body_base64 is not valid UTF-8`);
  }
  let response: unknown;
  try {
    response = JSON.parse(text);
  } catch {
    throw new Error(`${path} response bytes are not valid JSON`);
  }
  assertJsonComplexity(response, `${path}.response_json`);
  if (!isRecord(response)) throw new Error(`${path} response JSON must be an object`);
  let requestCursor: string | null;
  if (value.request_cursor === null) requestCursor = null;
  else requestCursor = requiredOpaqueCursor(value.request_cursor, `${path}.request_cursor`);
  return {
    page_index: requiredSafeInteger(value.page_index, `${path}.page_index`),
    request_cursor: requestCursor,
    request_method: "GET",
    request_path: value.request_path,
    request_query_raw: requestQueryRaw,
    requested_at: requestedAt,
    completed_at: completedAt,
    request_correlation_id_sha256: requestCorrelation,
    response_correlation_id_sha256: responseCorrelation,
    response_status: 200,
    response_content_type_raw: contentTypeRaw,
    response_media_type: "application/json",
    response_body_base64: value.response_body_base64,
    response_body_byte_length: declaredLength,
    response_body_sha256: responseSha,
  };
}

/** Build one immutable raw-page record from exact bytes without fetching it. */
export function walmartRawPageFromBytes(
  kind: "orders" | "returns",
  pageIndex: number,
  requestCursor: string | null,
  requestQueryRaw: string,
  responseBytes: Uint8Array,
  provenance: WalmartRawPageProvenance,
  responseContentTypeRaw = "application/json",
): WalmartRawPage {
  const bytes = Buffer.from(responseBytes);
  const page: WalmartRawPage = {
    page_index: pageIndex,
    request_cursor: requestCursor,
    request_method: "GET",
    request_path: kind === "orders" ? "/v3/orders" : "/v3/returns",
    request_query_raw: requestQueryRaw,
    requested_at: provenance.requested_at,
    completed_at: provenance.completed_at,
    request_correlation_id_sha256: provenance.request_correlation_id_sha256,
    response_correlation_id_sha256: provenance.response_correlation_id_sha256,
    response_status: 200,
    response_content_type_raw: responseContentTypeRaw,
    response_media_type: "application/json",
    response_body_base64: bytes.toString("base64"),
    response_body_byte_length: bytes.byteLength,
    response_body_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return parseRawPage(page, "raw page");
}

function assertPageRequestQueries(
  pages: readonly WalmartRawPage[],
  firstPageQueryRaw: string,
  path: string,
): void {
  for (const [index, page] of pages.entries()) {
    if (index === 0 && page.request_cursor !== null) {
      throw new Error(`${path}[0].request_cursor must be null`);
    }
    if (index > 0 && page.request_cursor === null) {
      throw new Error(`${path}[${index}].request_cursor must contain the preceding opaque cursor`);
    }
    const expected = index === 0
      ? firstPageQueryRaw
      : cursorToRawQuery(page.request_cursor as string, `${path}[${index}].request_cursor`);
    if (page.request_query_raw !== expected) {
      throw new Error(`${path}[${index}].request_query_raw does not exactly match the frozen request contract`);
    }
  }
}

function assertPageCaptureChronology(
  pages: readonly WalmartRawPage[],
  capturedAt: string,
  path: string,
): void {
  const correlations = new Set<string>();
  let maximumCompletedAt = "1970-01-01T00:00:00.000Z";
  let priorCompletedMs = -1;
  for (const [index, page] of pages.entries()) {
    const requestedMs = Date.parse(page.requested_at);
    const completedMs = Date.parse(page.completed_at);
    if (index > 0 && requestedMs < priorCompletedMs) {
      throw new Error(`${path}[${index}].requested_at precedes completion of the cursor-producing page`);
    }
    priorCompletedMs = completedMs;
    if (completedMs > Date.parse(maximumCompletedAt)) maximumCompletedAt = page.completed_at;
    if (correlations.has(page.request_correlation_id_sha256)) {
      throw new Error(`${path} reuses a request correlation ID across pages`);
    }
    correlations.add(page.request_correlation_id_sha256);
  }
  if (capturedAt !== maximumCompletedAt) {
    throw new Error(`${path} artifact captured_at must equal the maximum page completed_at`);
  }
}

function assertArtifactTransportAggregate(pages: readonly unknown[], path: string): void {
  let declaredBytes = 0;
  let encodedCharacters = 0;
  for (const [index, page] of pages.entries()) {
    if (!isRecord(page)) throw new Error(`${path}[${index}] must be an object`);
    const byteLength = requiredSafeInteger(
      page.response_body_byte_length,
      `${path}[${index}].response_body_byte_length`,
      1,
    );
    declaredBytes = checkedAdd(declaredBytes, byteLength, `${path} aggregate declared bytes`);
    if (typeof page.response_body_base64 !== "string") {
      throw new Error(`${path}[${index}].response_body_base64 must be a string`);
    }
    encodedCharacters = checkedAdd(
      encodedCharacters,
      page.response_body_base64.length,
      `${path} aggregate base64 characters`,
    );
  }
  if (declaredBytes > MAX_ARTIFACT_TRANSPORT_BYTES) {
    throw new Error(`${path} exceeds the aggregate decoded transport cap`);
  }
  if (encodedCharacters > MAX_ARTIFACT_BASE64_CHARACTERS) {
    throw new Error(`${path} exceeds the aggregate encoded transport cap`);
  }
}

function parseOrdersBody(value: unknown): WalmartRawOrdersPagesBody {
  const path = "orders source body";
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "partition_id", "captured_at", "channel", "store_index",
    "account_scope", "request", "pages",
  ], path);
  if (value.schema_version !== WALMART_RAW_ORDERS_PAGES_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  if (value.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  const storeIndex = requiredSafeInteger(value.store_index, `${path}.store_index`, 1);
  const accountScope = parseAccountScope(value.account_scope, `${path}.account_scope`, storeIndex);
  const capturedAt = requiredCanonicalTimestamp(value.captured_at, `${path}.captured_at`);
  if (!isRecord(value.request)) throw new Error(`${path}.request must be an object`);
  assertExactKeys(value.request, [
    "sales_window_starts_at_exclusive", "sales_window_ends_at_exclusive",
    "partition_starts_at_exclusive", "partition_ends_at_exclusive",
    "api_created_start_date_exclusive", "api_created_end_date_exclusive",
    "limit", "product_info", "ship_node_type", "replacement_info",
    "product_charge_amount_scope",
  ], `${path}.request`);
  if (value.request.product_info !== true) {
    throw new Error(`${path}.request.product_info must be true`);
  }
  if (value.request.product_charge_amount_scope !== "UNPROVEN_UNIT_VS_LINE_TOTAL") {
    throw new Error(`${path}.request.product_charge_amount_scope must remain UNPROVEN_UNIT_VS_LINE_TOTAL`);
  }
  if (!WALMART_ORDER_SHIP_NODE_TYPES.includes(
    value.request.ship_node_type as WalmartOrderShipNodeType,
  )) {
    throw new Error(`${path}.request.ship_node_type is unsupported`);
  }
  const shipNodeType = value.request.ship_node_type as WalmartOrderShipNodeType;
  if (value.request.replacement_info !== true) {
    throw new Error(`${path}.request.replacement_info must be true`);
  }
  const window = parseWindow(
    value.request.sales_window_starts_at_exclusive,
    value.request.sales_window_ends_at_exclusive,
    `${path}.request.sales_window`,
  );
  const partition = parseOpenInterval(
    value.request.partition_starts_at_exclusive,
    value.request.partition_ends_at_exclusive,
    `${path}.request.partition`,
  );
  if (partition.starts_ms < window.starts_ms || partition.ends_ms > window.ends_ms) {
    throw new Error(`${path}.request partition must be contained in the final sales window`);
  }
  const apiStartsAt = requiredCanonicalTimestamp(
    value.request.api_created_start_date_exclusive,
    `${path}.request.api_created_start_date_exclusive`,
  );
  const apiEndsAt = requiredCanonicalTimestamp(
    value.request.api_created_end_date_exclusive,
    `${path}.request.api_created_end_date_exclusive`,
  );
  if (apiStartsAt !== partition.starts_at || apiEndsAt !== partition.ends_at) {
    throw new Error(`${path}.request API dates must equal the exact open partition interval under documented exclusive Orders filters`);
  }
  const expectedPartitionId = walmartOrdersPartitionId({
    store_index: storeIndex,
    seller_account_fingerprint_sha256: accountScope.seller_account_fingerprint_sha256,
    ship_node_type: shipNodeType,
    sales_window_starts_at_exclusive: window.starts_at,
    sales_window_ends_at_exclusive: window.ends_at,
    partition_starts_at_exclusive: partition.starts_at,
    partition_ends_at_exclusive: partition.ends_at,
  });
  const partitionId = requiredString(value.partition_id, `${path}.partition_id`, 256);
  if (partitionId !== expectedPartitionId) {
    throw new Error(`${path}.partition_id is not derived from the immutable partition identity`);
  }
  const limit = requiredSafeInteger(value.request.limit, `${path}.request.limit`, 1);
  if (limit > 200) throw new Error(`${path}.request.limit cannot exceed 200`);
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error(`${path}.pages must contain at least the terminal page`);
  }
  if (value.pages.length > MAX_PAGES_PER_PARTITION) {
    throw new Error(`${path}.pages exceeds the transport page cap`);
  }
  assertArtifactTransportAggregate(value.pages, `${path}.pages`);
  const pages = value.pages.map((page, index) => parseRawPage(page, `${path}.pages[${index}]`));
  if (pages.some((page) => page.request_path !== "/v3/orders")) {
    throw new Error(`${path}.pages must bind request_path /v3/orders`);
  }
  assertPageRequestQueries(pages, canonicalRawQuery([
    ["createdStartDate", apiStartsAt],
    ["createdEndDate", apiEndsAt],
    ["limit", String(limit)],
    ["productInfo", "true"],
    ["shipNodeType", shipNodeType],
    ["replacementInfo", "true"],
  ]), `${path}.pages`);
  assertPageCaptureChronology(pages, capturedAt, `${path}.pages`);
  const firstRequestedMs = Date.parse(pages[0].requested_at);
  if (firstRequestedMs < partition.ends_ms) {
    throw new Error(`${path}.pages[0].requested_at precedes the end of the requested partition`);
  }
  if (firstRequestedMs - partition.starts_ms > WINDOW_DAYS * DAY_MS) {
    throw new Error(`${path}.pages[0] requested the partition start outside Walmart's 180-day Orders horizon`);
  }
  return {
    schema_version: WALMART_RAW_ORDERS_PAGES_SCHEMA,
    partition_id: partitionId,
    captured_at: capturedAt,
    channel: CHANNEL,
    store_index: storeIndex,
    account_scope: accountScope,
    request: {
      sales_window_starts_at_exclusive: window.starts_at,
      sales_window_ends_at_exclusive: window.ends_at,
      partition_starts_at_exclusive: partition.starts_at,
      partition_ends_at_exclusive: partition.ends_at,
      api_created_start_date_exclusive: apiStartsAt,
      api_created_end_date_exclusive: apiEndsAt,
      limit,
      product_info: true,
      ship_node_type: shipNodeType,
      replacement_info: true,
      product_charge_amount_scope: "UNPROVEN_UNIT_VS_LINE_TOTAL",
    },
    pages,
  };
}

function parseReturnsBody(value: unknown): WalmartRawReturnsPagesBody {
  const path = "returns source body";
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "captured_at", "channel", "store_index", "account_scope", "request", "pages",
  ], path);
  if (value.schema_version !== WALMART_RAW_RETURNS_PAGES_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  if (value.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  const storeIndex = requiredSafeInteger(value.store_index, `${path}.store_index`, 1);
  const accountScope = parseAccountScope(value.account_scope, `${path}.account_scope`, storeIndex);
  const capturedAt = requiredCanonicalTimestamp(value.captured_at, `${path}.captured_at`);
  if (!isRecord(value.request)) throw new Error(`${path}.request must be an object`);
  assertExactKeys(value.request, [
    "observation_starts_at_inclusive", "observation_cutoff_at_exclusive",
    "api_return_creation_start_date_inclusive", "api_return_creation_end_date_inclusive",
    "limit", "replacement_info", "wfs_enabled",
  ], `${path}.request`);
  if (value.request.replacement_info !== true) {
    throw new Error(`${path}.request.replacement_info must be true`);
  }
  if (!WALMART_RETURN_WFS_SCOPES.includes(value.request.wfs_enabled as WalmartReturnWfsScope)) {
    throw new Error(`${path}.request.wfs_enabled must be N or Y`);
  }
  const wfsEnabled = value.request.wfs_enabled as WalmartReturnWfsScope;
  const startsAt = requiredCanonicalTimestamp(
    value.request.observation_starts_at_inclusive,
    `${path}.request.observation_starts_at_inclusive`,
  );
  const cutoffAt = requiredCanonicalTimestamp(
    value.request.observation_cutoff_at_exclusive,
    `${path}.request.observation_cutoff_at_exclusive`,
  );
  if (Date.parse(cutoffAt) <= Date.parse(startsAt)) {
    throw new Error(`${path}.request observation cutoff must follow its start`);
  }
  const apiStartsAt = requiredCanonicalTimestamp(
    value.request.api_return_creation_start_date_inclusive,
    `${path}.request.api_return_creation_start_date_inclusive`,
  );
  const apiEndsAt = requiredCanonicalTimestamp(
    value.request.api_return_creation_end_date_inclusive,
    `${path}.request.api_return_creation_end_date_inclusive`,
  );
  if (apiStartsAt !== startsAt || Date.parse(apiEndsAt) !== Date.parse(cutoffAt) - 1) {
    throw new Error(`${path}.request API dates must cover the exact half-open observation under documented inclusive Returns filters`);
  }
  const limit = requiredSafeInteger(value.request.limit, `${path}.request.limit`, 1);
  if (limit > 200) throw new Error(`${path}.request.limit cannot exceed 200`);
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error(`${path}.pages must contain at least the terminal page`);
  }
  if (value.pages.length > MAX_PAGES_PER_PARTITION) {
    throw new Error(`${path}.pages exceeds the transport page cap`);
  }
  assertArtifactTransportAggregate(value.pages, `${path}.pages`);
  const pages = value.pages.map((page, index) => parseRawPage(page, `${path}.pages[${index}]`));
  if (pages.some((page) => page.request_path !== "/v3/returns")) {
    throw new Error(`${path}.pages must bind request_path /v3/returns`);
  }
  assertPageRequestQueries(pages, canonicalRawQuery([
    ["returnCreationStartDate", apiStartsAt],
    ["returnCreationEndDate", apiEndsAt],
    ["limit", String(limit)],
    ["replacementInfo", "true"],
    ["isWFSEnabled", wfsEnabled],
  ]), `${path}.pages`);
  assertPageCaptureChronology(pages, capturedAt, `${path}.pages`);
  if (Date.parse(pages[0].requested_at) < Date.parse(cutoffAt)) {
    throw new Error(`${path}.pages[0].requested_at precedes the outcome observation cutoff`);
  }
  return {
    schema_version: WALMART_RAW_RETURNS_PAGES_SCHEMA,
    captured_at: capturedAt,
    channel: CHANNEL,
    store_index: storeIndex,
    account_scope: accountScope,
    request: {
      observation_starts_at_inclusive: startsAt,
      observation_cutoff_at_exclusive: cutoffAt,
      api_return_creation_start_date_inclusive: apiStartsAt,
      api_return_creation_end_date_inclusive: apiEndsAt,
      limit,
      replacement_info: true,
      wfs_enabled: wfsEnabled,
    },
    pages,
  };
}

function sealBody<T extends object>(body: T, prefix: string): T & ArtifactSeal {
  const clone = canonicalClone(body);
  const bodySha = walmartPerformanceCanonicalSha256(clone);
  return deepFreeze({
    ...clone,
    artifact_id: `${prefix}-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  });
}

export function sealWalmartPerformancePopulation(
  value: WalmartPerformancePopulationBody,
): SealedWalmartPerformancePopulation {
  return sealBody(parsePopulationBody(value), "walmart-performance-population");
}

/**
 * Lossless identity-only bridge from the authoritative complete ITEM report.
 * Rich product identifiers are intentionally not remapped into listing or
 * buyer IDs; the exact upstream body/raw/decoded hashes remain bound.
 */
export function compileWalmartPerformancePopulationFromItemReport(
  value: SealedWalmartItemReportPublishedSource,
): SealedWalmartPerformancePopulation {
  const upstream = verifyWalmartItemReportPublishedSource(value);
  const rows = upstream.rows.map((row) => ({
    channel: row.channel,
    store_index: row.store_index,
    sku: row.sku,
    listing_key: row.listing_key,
    published_status: "PUBLISHED" as const,
  })).sort((left, right) => compareCodeUnits(left.listing_key, right.listing_key));
  return sealWalmartPerformancePopulation({
    schema_version: WALMART_PERFORMANCE_POPULATION_SCHEMA,
    captured_at: upstream.report.cutoff_at,
    channel: CHANNEL,
    store_index: upstream.account_scope.store_index,
    account_scope: {
      channel: CHANNEL,
      store_index: upstream.account_scope.store_index,
      seller_account_fingerprint_sha256:
        upstream.account_scope.seller_account_fingerprint_sha256,
    },
    published_population_complete: true,
    upstream_source: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: upstream.source_id,
      body_sha256: upstream.body_sha256,
      raw_transport_sha256: upstream.report.download_transport.bytes_sha256,
      decoded_report_sha256: upstream.report.decoded_report.bytes_sha256,
      cutoff_at: upstream.report.cutoff_at,
    },
    rows,
  });
}

export function sealWalmartRawOrdersPages(
  value: WalmartRawOrdersPagesBody,
): SealedWalmartRawOrdersPages {
  return sealBody(parseOrdersBody(value), "walmart-raw-orders");
}

export function sealWalmartRawReturnsPages(
  value: WalmartRawReturnsPagesBody,
): SealedWalmartRawReturnsPages {
  return sealBody(parseReturnsBody(value), "walmart-raw-returns");
}

function verifySealedBody<T extends object>(
  value: unknown,
  bodyKeys: readonly string[],
  prefix: string,
  parser: (body: unknown) => T,
  path: string,
): T & ArtifactSeal {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [...bodyKeys, "artifact_id", "body_sha256"], path);
  const artifactId = requiredString(value.artifact_id, `${path}.artifact_id`);
  const bodySha = requiredSha(value.body_sha256, `${path}.body_sha256`);
  const body = { ...value };
  delete body.artifact_id;
  delete body.body_sha256;
  if (walmartPerformanceCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match canonical body`);
  }
  if (artifactId !== `${prefix}-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.artifact_id is not derived from body_sha256`);
  }
  return deepFreeze({ ...parser(body), artifact_id: artifactId, body_sha256: bodySha });
}

const POPULATION_BODY_KEYS = [
  "schema_version", "captured_at", "channel", "store_index",
  "account_scope", "published_population_complete", "upstream_source", "rows",
] as const;
const RAW_ORDERS_BODY_KEYS = [
  "schema_version", "partition_id", "captured_at", "channel", "store_index",
  "account_scope", "request", "pages",
] as const;
const RAW_RETURNS_BODY_KEYS = [
  "schema_version", "captured_at", "channel", "store_index", "account_scope", "request", "pages",
] as const;

export function verifyWalmartPerformancePopulation(
  value: unknown,
): SealedWalmartPerformancePopulation {
  return verifySealedBody(
    value,
    POPULATION_BODY_KEYS,
    "walmart-performance-population",
    parsePopulationBody,
    "published population artifact",
  );
}

export function verifyWalmartRawOrdersPages(
  value: unknown,
): SealedWalmartRawOrdersPages {
  return verifySealedBody(
    value,
    RAW_ORDERS_BODY_KEYS,
    "walmart-raw-orders",
    parseOrdersBody,
    "orders artifact",
  );
}

export function verifyWalmartRawReturnsPages(
  value: unknown,
): SealedWalmartRawReturnsPages {
  return verifySealedBody(
    value,
    RAW_RETURNS_BODY_KEYS,
    "walmart-raw-returns",
    parseReturnsBody,
    "returns artifact",
  );
}

function extractNextCursor(meta: Record<string, unknown>, path: string): string | null {
  const value = meta.nextCursor;
  if (value === undefined || value === null) return null;
  return requiredOpaqueCursor(value, `${path}.nextCursor`);
}

function extractOrdersPage(response: JsonObject, path: string): {
  records: JsonObject[];
  total_count: number;
  page_limit: number;
  next_cursor: string | null;
} {
  if (!isRecord(response.list)) throw new Error(`${path}.list must be an object`);
  if (!isRecord(response.list.meta)) throw new Error(`${path}.list.meta must be an object`);
  const totalCount = requiredIntegerLike(
    response.list.meta.totalCount,
    `${path}.list.meta.totalCount`,
  );
  const pageLimit = requiredIntegerLike(response.list.meta.limit, `${path}.list.meta.limit`, 1);
  if (!isRecord(response.list.elements)) {
    if (totalCount === 0 && response.list.elements === undefined) {
      return {
        records: [],
        total_count: totalCount,
        page_limit: pageLimit,
        next_cursor: extractNextCursor(response.list.meta, `${path}.list.meta`),
      };
    }
    throw new Error(`${path}.list.elements must be an object`);
  }
  const raw = response.list.elements.order;
  let records: unknown[];
  if (raw === undefined || raw === null) records = [];
  else records = Array.isArray(raw) ? raw : [raw];
  if (!records.every(isRecord)) throw new Error(`${path}.list.elements.order must contain objects`);
  if (records.length > pageLimit || records.length > 200) {
    throw new Error(`${path}.list.elements.order exceeds the response page limit`);
  }
  return {
    records: records.map((record) => canonicalClone(record) as JsonObject),
    total_count: totalCount,
    page_limit: pageLimit,
    next_cursor: extractNextCursor(response.list.meta, `${path}.list.meta`),
  };
}

function extractReturnsPage(response: JsonObject, path: string): {
  records: JsonObject[];
  total_count: number;
  page_limit: number;
  next_cursor: string | null;
} {
  if (!isRecord(response.meta)) throw new Error(`${path}.meta must be an object`);
  const totalCount = requiredIntegerLike(response.meta.totalCount, `${path}.meta.totalCount`);
  const pageLimit = requiredIntegerLike(response.meta.limit, `${path}.meta.limit`, 1);
  const raw = response.returnOrders;
  let records: unknown[];
  if (raw === undefined || raw === null) records = [];
  else if (Array.isArray(raw)) records = raw;
  else if (isRecord(raw) && (Array.isArray(raw.returnOrder) || isRecord(raw.returnOrder))) {
    records = Array.isArray(raw.returnOrder) ? raw.returnOrder : [raw.returnOrder];
  } else {
    throw new Error(`${path}.returnOrders must be an array or returnOrder wrapper`);
  }
  if (!records.every(isRecord)) throw new Error(`${path}.returnOrders must contain objects`);
  if (records.length > pageLimit || records.length > 200) {
    throw new Error(`${path}.returnOrders exceeds the response page limit`);
  }
  return {
    records: records.map((record) => canonicalClone(record) as JsonObject),
    total_count: totalCount,
    page_limit: pageLimit,
    next_cursor: extractNextCursor(response.meta, `${path}.meta`),
  };
}

function decodedPageResponse(page: WalmartRawPage, path: string): JsonObject {
  const bytes = Buffer.from(page.response_body_base64, "base64");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${path} sealed response bytes are not valid UTF-8 JSON`);
  }
  assertJsonComplexity(parsed, `${path}.response_json`);
  if (!isRecord(parsed)) throw new Error(`${path} sealed response JSON must be an object`);
  return parsed as JsonObject;
}

function collectPaginatedRecords(
  pages: readonly WalmartRawPage[],
  kind: "orders" | "returns",
  requestedLimit: number,
): ParsedPageCollection {
  const unique = new Map<string, { digest: string; record: JsonObject }>();
  const seenCursors = new Set<string>();
  let advertised: number | null = null;
  let expectedCursor: string | null = null;
  for (const [index, page] of pages.entries()) {
    const path = `${kind}.pages[${index}]`;
    if (page.page_index !== index) throw new Error(`${path}.page_index must equal ${index}`);
    if (page.request_cursor !== expectedCursor) {
      throw new Error(`${path}.request_cursor does not continue the preceding nextCursor`);
    }
    if (page.request_cursor !== null) {
      const normalizedCursor = cursorToRawQuery(page.request_cursor, `${path}.request_cursor`);
      if (seenCursors.has(normalizedCursor)) throw new Error(`${path} contains a cursor cycle`);
      seenCursors.add(normalizedCursor);
    }
    const response = decodedPageResponse(page, path);
    const extracted = kind === "orders"
      ? extractOrdersPage(response, path)
      : extractReturnsPage(response, path);
    if (kind === "orders" && extracted.total_count >= 10_000) {
      throw new Error("orders advertised totalCount reaches Walmart's ambiguous 10,000-order cap; partition more narrowly");
    }
    if (kind === "returns" && extracted.total_count > MAX_RETURNS_PER_PARTITION) {
      throw new Error("returns advertised totalCount exceeds the frozen partition record cap");
    }
    if (advertised === null) advertised = extracted.total_count;
    else if (advertised !== extracted.total_count) {
      throw new Error(`${path} advertises a conflicting totalCount`);
    }
    if (extracted.page_limit !== requestedLimit) {
      throw new Error(`${path} response limit does not match the sealed request limit`);
    }
    if (extracted.records.length > requestedLimit) {
      throw new Error(`${path} contains more records than the sealed page limit`);
    }
    const idField = kind === "orders" ? "purchaseOrderId" : "returnOrderId";
    for (const [recordIndex, record] of extracted.records.entries()) {
      const recordPath = `${path}.${kind}[${recordIndex}]`;
      const id = requiredString(record[idField], `${recordPath}.${idField}`, MAX_ID_LENGTH);
      const digest = walmartPerformanceCanonicalSha256(record);
      const prior = unique.get(id);
      if (prior && prior.digest !== digest) {
        throw new Error(`${recordPath} conflicts with duplicate ${idField} ${id}`);
      }
      if (!prior) unique.set(id, { digest, record });
    }
    if (extracted.next_cursor !== null) {
      const normalizedNextCursor = cursorToRawQuery(
        extracted.next_cursor,
        `${path}.nextCursor`,
      );
      if (seenCursors.has(normalizedNextCursor)) {
        throw new Error(`${path} contains a cursor cycle`);
      }
    }
    if (index < pages.length - 1 && extracted.next_cursor === null) {
      throw new Error(`${path} is terminal but additional pages were supplied`);
    }
    if (index === pages.length - 1 && extracted.next_cursor !== null) {
      throw new Error(`${path} is not terminal; all cursor pages are required`);
    }
    expectedCursor = extracted.next_cursor;
  }
  const total = advertised ?? 0;
  if (unique.size !== total) {
    throw new Error(`${kind} unique record count ${unique.size} does not match advertised totalCount ${total}`);
  }
  return { records: [...unique.values()].map((entry) => entry.record), advertised_total_count: total };
}

function unwrapObjectList(value: unknown, wrapperKey: string, path: string): JsonObject[] {
  if (!isRecord(value)) throw new Error(`${path} must be an object wrapper`);
  const raw = value[wrapperKey];
  const rows = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  if (!rows.every(isRecord)) throw new Error(`${path}.${wrapperKey} must contain objects`);
  return rows.map((row) => row as JsonObject);
}

function uniqueNestedRows(rows: readonly JsonObject[], key: string, path: string): JsonObject[] {
  const unique = new Map<string, { digest: string; row: JsonObject }>();
  for (const [index, row] of rows.entries()) {
    const rawId = row[key];
    const id = typeof rawId === "string"
      ? requiredString(rawId, `${path}[${index}].${key}`, MAX_ID_LENGTH)
      : String(requiredSafeInteger(rawId, `${path}[${index}].${key}`, 1));
    const digest = walmartPerformanceCanonicalSha256(row);
    const prior = unique.get(id);
    if (prior && prior.digest !== digest) {
      throw new Error(`${path}[${index}] conflicts with duplicate ${key} ${id}`);
    }
    if (!prior) unique.set(id, { digest, row });
  }
  return [...unique.values()].map((entry) => entry.row);
}

function parseSku(item: unknown, path: string): string {
  if (!isRecord(item)) throw new Error(`${path} must be an object`);
  return requiredString(item.sku, `${path}.sku`, MAX_SKU_LENGTH);
}

function parseQuantity(value: unknown, path: string): number {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const quantity = requiredIntegerLike(value.amount, `${path}.amount`, 1);
  if (value.unitOfMeasurement !== undefined && value.unitOfMeasurement !== "EACH") {
    throw new Error(`${path}.unitOfMeasurement must be EACH when present`);
  }
  return quantity;
}

function parseReturnQuantity(value: unknown, path: string, minimum = 1): number {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value.unitOfMeasure !== "EACH") throw new Error(`${path}.unitOfMeasure must be EACH`);
  return requiredIntegerLike(value.measurementValue, `${path}.measurementValue`, minimum);
}

function parseProductChargeCents(value: unknown, path: string): number {
  const charges = unwrapObjectList(value, "charge", path);
  if (charges.length > MAX_CHARGES_PER_ORDER_LINE) {
    throw new Error(`${path} exceeds the per-line charge cap`);
  }
  if (charges.length === 0) throw new Error(`${path} must contain charges`);
  let productCents = 0;
  let productCharges = 0;
  for (const [index, charge] of charges.entries()) {
    const chargePath = `${path}.charge[${index}]`;
    const type = requiredString(charge.chargeType, `${chargePath}.chargeType`);
    if (!isRecord(charge.chargeAmount)) {
      throw new Error(`${chargePath}.chargeAmount must be an object`);
    }
    if (charge.chargeAmount.currency !== "USD") {
      throw new Error(`${chargePath}.chargeAmount.currency must be USD`);
    }
    const cents = parseUsdCents(charge.chargeAmount.amount, `${chargePath}.chargeAmount.amount`);
    if (type === "PRODUCT") {
      productCharges += 1;
      productCents = checkedAdd(productCents, cents, `${path} PRODUCT cents`);
    }
  }
  if (productCharges === 0) throw new Error(`${path} has no PRODUCT charge`);
  return productCents;
}

function parseEligibleUnits(value: unknown, orderedUnits: number, path: string): number {
  const statuses = unwrapObjectList(value, "orderLineStatus", path);
  if (statuses.length === 0) throw new Error(`${path} must contain current status quantities`);
  if (statuses.length > MAX_STATUSES_PER_ORDER_LINE) {
    throw new Error(`${path} exceeds the per-line status cap`);
  }
  const allowed = new Set(["Created", "Acknowledged", "Shipped", "Delivered", "Cancelled"]);
  let accounted = 0;
  let eligible = 0;
  for (const [index, status] of statuses.entries()) {
    const statusPath = `${path}.orderLineStatus[${index}]`;
    const name = requiredString(status.status, `${statusPath}.status`);
    if (!allowed.has(name)) throw new Error(`${statusPath}.status ${name} is unsupported`);
    const quantity = parseQuantity(status.statusQuantity, `${statusPath}.statusQuantity`);
    accounted = checkedAdd(accounted, quantity, `${path} accounted quantity`);
    if (name === "Shipped" || name === "Delivered") {
      eligible = checkedAdd(eligible, quantity, `${path} eligible quantity`);
    }
  }
  if (accounted !== orderedUnits) {
    throw new Error(`${path} status quantities ${accounted} do not reconcile to ordered quantity ${orderedUnits}`);
  }
  return eligible;
}

function prorateCents(totalCents: number, eligibleUnits: number, orderedUnits: number, path: string): number {
  if (eligibleUnits === 0) return 0;
  if (eligibleUnits === orderedUnits) return totalCents;
  const numerator = BigInt(totalCents) * BigInt(eligibleUnits);
  const denominator = BigInt(orderedUnits);
  const rounded = (numerator + denominator / BigInt(2)) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${path} exceeds safe cents`);
  return Number(rounded);
}

function returnLineOutcome(value: unknown, path: string): RawReturnType {
  const type = requiredString(value, path);
  if (type !== "PREORDER" && type !== "REFUND" && type !== "REPLACEMENT") {
    throw new Error(`${path} must be PREORDER, REFUND, or REPLACEMENT`);
  }
  return type;
}

function orderType(value: unknown, path: string): RawOrderType {
  const type = requiredString(value, path);
  if (type !== "REGULAR" && type !== "PREORDER" && type !== "REPLACEMENT") {
    throw new Error(`${path} must be REGULAR, PREORDER, or REPLACEMENT`);
  }
  return type;
}


function validateNestedReturnQuantity(
  value: unknown,
  lineQuantity: number,
  path: string,
): number {
  const quantity = isRecord(value)
    ? parseReturnQuantity(value, path)
    : requiredIntegerLike(value, path, 1);
  if (quantity > lineQuantity) {
    throw new Error(`${path} cannot exceed the return-line quantity`);
  }
  return quantity;
}

function validateOptionalReturnQuantities(
  row: JsonObject,
  names: readonly string[],
  lineQuantity: number,
  path: string,
): void {
  const present = names.filter((name) => row[name] !== undefined && row[name] !== null);
  if (present.length > 1) {
    throw new Error(`${path} contains ambiguous duplicate quantity fields ${present.join(", ")}`);
  }
  if (present.length === 1) {
    validateNestedReturnQuantity(row[present[0]], lineQuantity, `${path}.${present[0]}`);
  }
}

function returnLineIsCancelled(line: JsonObject, lineQuantity: number, path: string): boolean {
  const status = requiredString(line.status, `${path}.status`);
  if (status !== "INITIATED" && status !== "DELIVERED" && status !== "COMPLETED") {
    throw new Error(`${path}.status must be INITIATED, DELIVERED, or COMPLETED`);
  }
  const cancellationReason = line.returnCancellationReason;
  if (cancellationReason !== undefined && cancellationReason !== null
    && typeof cancellationReason !== "string") {
    throw new Error(`${path}.returnCancellationReason must be a string or null`);
  }
  let trackingCancelled = false;
  if (line.returnTrackingDetail !== undefined && line.returnTrackingDetail !== null) {
    if (!Array.isArray(line.returnTrackingDetail)) {
      throw new Error(`${path}.returnTrackingDetail must be an array when present`);
    }
    if (line.returnTrackingDetail.length > MAX_TRACKING_EVENTS_PER_RETURN_LINE) {
      throw new Error(`${path}.returnTrackingDetail exceeds the tracking-event cap`);
    }
    for (const [index, detail] of line.returnTrackingDetail.entries()) {
      if (!isRecord(detail)) throw new Error(`${path}.returnTrackingDetail[${index}] must be an object`);
      const eventTag = requiredString(detail.eventTag, `${path}.returnTrackingDetail[${index}].eventTag`);
      if (eventTag === "RETURN_CANCELLED" || eventTag === "CANCELLED") trackingCancelled = true;
    }
  }
  if (line.currentTrackingStatuses !== undefined && line.currentTrackingStatuses !== null) {
    if (!Array.isArray(line.currentTrackingStatuses)) {
      throw new Error(`${path}.currentTrackingStatuses must be an array when present`);
    }
    if (line.currentTrackingStatuses.length > MAX_TRACKING_EVENTS_PER_RETURN_LINE) {
      throw new Error(`${path}.currentTrackingStatuses exceeds the tracking-event cap`);
    }
    for (const [index, trackingStatus] of line.currentTrackingStatuses.entries()) {
      if (!isRecord(trackingStatus)) {
        throw new Error(`${path}.currentTrackingStatuses[${index}] must be an object`);
      }
      const trackingStatusValue = requiredString(
        trackingStatus.status,
        `${path}.currentTrackingStatuses[${index}].status`,
      );
      validateOptionalReturnQuantities(
        trackingStatus,
        ["quantity", "trackingQuantity"],
        lineQuantity,
        `${path}.currentTrackingStatuses[${index}]`,
      );
      if (trackingStatusValue === "CANCELLED") trackingCancelled = true;
    }
  }
  if (line.refundChannels !== undefined && line.refundChannels !== null) {
    if (!Array.isArray(line.refundChannels)) {
      throw new Error(`${path}.refundChannels must be an array when present`);
    }
    if (line.refundChannels.length > MAX_REFUND_CHANNELS_PER_RETURN_LINE) {
      throw new Error(`${path}.refundChannels exceeds the refund-channel cap`);
    }
    for (const [index, refundChannel] of line.refundChannels.entries()) {
      if (!isRecord(refundChannel)) {
        throw new Error(`${path}.refundChannels[${index}] must be an object`);
      }
      validateOptionalReturnQuantities(
        refundChannel,
        ["quantity", "refundQuantity", "refundedQuantity"],
        lineQuantity,
        `${path}.refundChannels[${index}]`,
      );
    }
  }
  return (typeof cancellationReason === "string" && cancellationReason.trim().length > 0)
    || trackingCancelled;
}

function sourceBinding(
  artifact: SealedWalmartPerformancePopulation | SealedWalmartRawOrdersPages | SealedWalmartRawReturnsPages,
): WalmartFrozenPerformanceSourceBinding {
  const sourceScope = artifact.schema_version === WALMART_PERFORMANCE_POPULATION_SCHEMA
    ? "PUBLISHED"
    : artifact.schema_version === WALMART_RAW_ORDERS_PAGES_SCHEMA
      ? artifact.request.ship_node_type
      : `WFS_${artifact.request.wfs_enabled}`;
  return {
    schema_version: artifact.schema_version,
    source_scope: sourceScope,
    seller_account_fingerprint_sha256:
      artifact.account_scope.seller_account_fingerprint_sha256,
    artifact_id: artifact.artifact_id,
    body_sha256: artifact.body_sha256,
    captured_at: artifact.captured_at,
    store_index: artifact.store_index,
    partition_id: artifact.schema_version === WALMART_RAW_ORDERS_PAGES_SCHEMA
      ? artifact.partition_id
      : null,
    partition_starts_at_exclusive:
      artifact.schema_version === WALMART_RAW_ORDERS_PAGES_SCHEMA
        ? artifact.request.partition_starts_at_exclusive
        : null,
    partition_ends_at_exclusive:
      artifact.schema_version === WALMART_RAW_ORDERS_PAGES_SCHEMA
        ? artifact.request.partition_ends_at_exclusive
        : null,
  };
}

function emptyMetric(): MetricAccumulator {
  return {
    gross_sales_cents: 0,
    units_sold: 0,
    units_returned: 0,
    units_refunded: 0,
    units_replaced: 0,
  };
}

function lineJoinKey(storeIndex: number, purchaseOrderId: string, lineNumber: string): string {
  return `${storeIndex}\u0000${purchaseOrderId}\u0000${lineNumber}`;
}

function assertOnePerStore<T extends { store_index: number }>(sources: readonly T[], path: string): Map<number, T> {
  const result = new Map<number, T>();
  for (const source of sources) {
    if (result.has(source.store_index)) {
      throw new Error(`${path} contains more than one artifact for store_index ${source.store_index}`);
    }
    result.set(source.store_index, source);
  }
  return result;
}

function exactScopesByStore<T extends { store_index: number }, Scope extends string>(
  sources: readonly T[],
  expectedScopes: readonly Scope[],
  scopeOf: (source: T) => Scope,
  path: string,
): Map<number, Map<Scope, T>> {
  const result = new Map<number, Map<Scope, T>>();
  for (const source of sources) {
    const scope = scopeOf(source);
    const byScope = result.get(source.store_index) ?? new Map<Scope, T>();
    if (byScope.has(scope)) {
      throw new Error(`${path} contains duplicate ${scope} scope for store_index ${source.store_index}`);
    }
    byScope.set(scope, source);
    result.set(source.store_index, byScope);
  }
  for (const [storeIndex, byScope] of result.entries()) {
    for (const scope of expectedScopes) {
      if (!byScope.has(scope)) {
        throw new Error(`${path} is missing ${scope} scope for store_index ${storeIndex}`);
      }
    }
    if (byScope.size !== expectedScopes.length) {
      throw new Error(`${path} has an unsupported scope for store_index ${storeIndex}`);
    }
  }
  return result;
}

type OrdersByStoreAndScope = Map<
  number,
  Map<WalmartOrderShipNodeType, SealedWalmartRawOrdersPages[]>
>;

function ordersPartitionsByStoreAndScope(
  sources: readonly SealedWalmartRawOrdersPages[],
): OrdersByStoreAndScope {
  const result: OrdersByStoreAndScope = new Map();
  const partitionIds = new Set<string>();
  for (const source of sources) {
    if (partitionIds.has(source.partition_id)) {
      throw new Error(`orders contains duplicate partition_id ${source.partition_id}`);
    }
    partitionIds.add(source.partition_id);
    const byScope = result.get(source.store_index)
      ?? new Map<WalmartOrderShipNodeType, SealedWalmartRawOrdersPages[]>();
    const partitions = byScope.get(source.request.ship_node_type) ?? [];
    partitions.push(source);
    byScope.set(source.request.ship_node_type, partitions);
    result.set(source.store_index, byScope);
  }
  for (const [storeIndex, byScope] of result.entries()) {
    for (const scope of WALMART_ORDER_SHIP_NODE_TYPES) {
      if (!byScope.has(scope)) {
        throw new Error(`orders is missing ${scope} scope for store_index ${storeIndex}`);
      }
    }
    if (byScope.size !== WALMART_ORDER_SHIP_NODE_TYPES.length) {
      throw new Error(`orders has an unsupported scope for store_index ${storeIndex}`);
    }
  }
  return result;
}

function compareOrderPartitions(
  left: SealedWalmartRawOrdersPages,
  right: SealedWalmartRawOrdersPages,
): number {
  return Date.parse(left.request.partition_starts_at_exclusive)
    - Date.parse(right.request.partition_starts_at_exclusive)
    || Date.parse(left.request.partition_ends_at_exclusive)
      - Date.parse(right.request.partition_ends_at_exclusive)
    || compareCodeUnits(left.partition_id, right.partition_id);
}

function assertCanonicalOrderPartitionCoverage(
  partitionsInput: readonly SealedWalmartRawOrdersPages[],
  window: ReturnType<typeof parseWindow>,
  path: string,
): SealedWalmartRawOrdersPages[] {
  if (partitionsInput.length < 2) {
    throw new Error(`${path} must contain at least baseline and post-cutoff tail partitions`);
  }
  const partitions = [...partitionsInput].sort(compareOrderPartitions);
  let coveredEnd = -1;
  let priorCapturedMs = -1;
  for (const [index, partition] of partitions.entries()) {
    if (partition.request.sales_window_starts_at_exclusive !== window.starts_at
      || partition.request.sales_window_ends_at_exclusive !== window.ends_at) {
      throw new Error(`${path}[${index}] final sales window conflicts with the frozen cohort`);
    }
    const startsMs = Date.parse(partition.request.partition_starts_at_exclusive);
    const endsMs = Date.parse(partition.request.partition_ends_at_exclusive);
    if (startsMs < window.starts_ms || endsMs > window.ends_ms) {
      throw new Error(`${path}[${index}] partition is outside the final sales window`);
    }
    if (index === 0) {
      if (startsMs !== window.starts_ms) {
        throw new Error(`${path} first partition must start at the final sales-window start`);
      }
    } else {
      if (coveredEnd - startsMs < 1) {
        throw new Error(`${path}[${index}] must overlap prior coverage by at least 1ms; gaps and touching boundaries are forbidden`);
      }
      if (endsMs <= coveredEnd) {
        throw new Error(`${path}[${index}] is redundant or non-canonical because it does not extend coverage`);
      }
      const firstRequestedMs = Date.parse(partition.pages[0].requested_at);
      if (firstRequestedMs < priorCapturedMs) {
        throw new Error(`${path}[${index}] capture must be sequential after the preceding partition completed`);
      }
    }
    coveredEnd = endsMs;
    priorCapturedMs = Date.parse(partition.captured_at);
  }
  if (coveredEnd !== window.ends_ms) {
    throw new Error(`${path} is missing the post-cutoff tail ending at the final sales-window end`);
  }
  return partitions;
}

interface ScopedPageCollection {
  records: Array<{ record: JsonObject; artifact_id: string; source_scope: string }>;
  advertised_total_count: number;
}

interface PartitionedOrdersCollection extends ScopedPageCollection {
  overlapping_orders_deduplicated: number;
}

function collectPartitionedOrderRecords(
  sources: ReadonlyArray<{
    artifact_id: string;
    partition_id: string;
    source_scope: WalmartOrderShipNodeType;
    partition_starts_ms: number;
    partition_ends_ms: number;
    pages: readonly WalmartRawPage[];
    limit: number;
  }>,
  window: ReturnType<typeof parseWindow>,
): PartitionedOrdersCollection {
  const seen = new Map<string, {
    digest: string;
    source_scope: WalmartOrderShipNodeType;
    record: JsonObject;
    artifact_id: string;
  }>();
  let advertisedTotal = 0;
  let overlappingDeduplicated = 0;
  for (const source of sources) {
    const collected = collectPaginatedRecords(source.pages, "orders", source.limit);
    advertisedTotal = checkedAdd(
      advertisedTotal,
      collected.advertised_total_count,
      "orders advertised total across partitions",
    );
    for (const [recordIndex, record] of collected.records.entries()) {
      const recordPath = `orders[scope=${source.source_scope}]`
        + `[partition=${source.partition_id}][${recordIndex}]`;
      const id = requiredString(record.purchaseOrderId, `${recordPath}.purchaseOrderId`, MAX_ID_LENGTH);
      const orderMillis = parseRawInstant(record.orderDate, `${recordPath}.orderDate`);
      if (orderMillis <= source.partition_starts_ms || orderMillis >= source.partition_ends_ms) {
        throw new Error(`${recordPath}.orderDate is outside its exact open partition interval`);
      }
      if (orderMillis <= window.starts_ms || orderMillis >= window.ends_ms) {
        throw new Error(`${recordPath}.orderDate is outside the final open sales window`);
      }
      const digest = walmartPerformanceCanonicalSha256(record);
      const prior = seen.get(id);
      if (prior) {
        if (prior.source_scope !== source.source_scope) {
          throw new Error(
            `orders purchaseOrderId ${id} appears in mutually exclusive scopes `
            + `${prior.source_scope} and ${source.source_scope}`,
          );
        }
        if (prior.digest !== digest) {
          throw new Error(
            `${recordPath} conflicts with same-scope overlapping purchaseOrderId ${id}`,
          );
        }
        overlappingDeduplicated = checkedAdd(
          overlappingDeduplicated,
          1,
          "orders overlapping deduplication count",
        );
        continue;
      }
      seen.set(id, {
        digest,
        source_scope: source.source_scope,
        record,
        artifact_id: source.artifact_id,
      });
    }
  }
  if (checkedAdd(
    seen.size,
    overlappingDeduplicated,
    "orders unique plus overlap count",
  ) !== advertisedTotal) {
    throw new Error("orders partition records do not reconcile to advertised totals");
  }
  return {
    records: [...seen.values()].map((entry) => ({
      record: entry.record,
      artifact_id: entry.artifact_id,
      source_scope: entry.source_scope,
    })),
    advertised_total_count: seen.size,
    overlapping_orders_deduplicated: overlappingDeduplicated,
  };
}

function collectDisjointScopedRecords(
  sources: ReadonlyArray<{
    artifact_id: string;
    source_scope: string;
    pages: readonly WalmartRawPage[];
    limit: number;
  }>,
  kind: "orders" | "returns",
): ScopedPageCollection {
  const idField = kind === "orders" ? "purchaseOrderId" : "returnOrderId";
  const seen = new Map<string, { digest: string; source_scope: string }>();
  const records: ScopedPageCollection["records"] = [];
  let advertisedTotal = 0;
  for (const source of sources) {
    const collected = collectPaginatedRecords(source.pages, kind, source.limit);
    advertisedTotal = checkedAdd(
      advertisedTotal,
      collected.advertised_total_count,
      `${kind} advertised total across scopes`,
    );
    for (const record of collected.records) {
      const id = requiredString(record[idField], `${kind}.${source.source_scope}.${idField}`, MAX_ID_LENGTH);
      const digest = walmartPerformanceCanonicalSha256(record);
      const prior = seen.get(id);
      if (prior) {
        const qualifier = prior.digest === digest ? "identically" : "conflictingly";
        throw new Error(
          `${kind} ${idField} ${id} appears ${qualifier} in mutually exclusive scopes `
          + `${prior.source_scope} and ${source.source_scope}`,
        );
      }
      seen.set(id, { digest, source_scope: source.source_scope });
      records.push({ record, artifact_id: source.artifact_id, source_scope: source.source_scope });
    }
  }
  if (records.length !== advertisedTotal) {
    throw new Error(`${kind} cross-scope records do not reconcile to advertised totals`);
  }
  return { records, advertised_total_count: advertisedTotal };
}

function sameStoreSet(reference: Map<number, unknown>, candidate: Map<number, unknown>, path: string): void {
  const expected = [...reference.keys()].sort((a, b) => a - b);
  const actual = [...candidate.keys()].sort((a, b) => a - b);
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error(`${path} store_index set must exactly match the published populations`);
  }
}

function assertCompileTransportAggregate(
  sources: readonly unknown[],
): void {
  let declaredBytes = 0;
  let encodedCharacters = 0;
  for (const [sourceIndex, source] of sources.entries()) {
    if (!isRecord(source) || !Array.isArray(source.pages)) continue;
    for (const [pageIndex, page] of source.pages.entries()) {
      if (!isRecord(page)) continue;
      if (Number.isSafeInteger(page.response_body_byte_length)
        && (page.response_body_byte_length as number) >= 0) {
        declaredBytes = checkedAdd(
          declaredBytes,
          page.response_body_byte_length as number,
          `compile raw sources[${sourceIndex}].pages[${pageIndex}] declared bytes`,
        );
      }
      if (typeof page.response_body_base64 === "string") {
        encodedCharacters = checkedAdd(
          encodedCharacters,
          page.response_body_base64.length,
          `compile raw sources[${sourceIndex}].pages[${pageIndex}] base64 characters`,
        );
      }
    }
  }
  if (declaredBytes > MAX_COMPILE_TRANSPORT_BYTES) {
    throw new Error("compile raw inputs exceed the aggregate decoded transport cap");
  }
  if (encodedCharacters > MAX_COMPILE_BASE64_CHARACTERS) {
    throw new Error("compile raw inputs exceed the aggregate encoded transport cap");
  }
}

export function compileWalmartFrozen180DayPerformanceSource(
  input: WalmartFrozenPerformanceCompileInput,
): SealedWalmartFrozen180DayPerformanceSource {
  if (!input || !Array.isArray(input.published_populations)
    || !Array.isArray(input.orders) || !Array.isArray(input.returns)) {
    throw new Error("compile input must contain published_populations, orders, and returns arrays");
  }
  if (input.published_populations.length === 0) {
    throw new Error("at least one complete PUBLISHED population is required");
  }
  assertCompileTransportAggregate([...input.orders, ...input.returns]);
  const populations = input.published_populations.map(verifyWalmartPerformancePopulation);
  const ordersSources = input.orders.map(verifyWalmartRawOrdersPages);
  const returnsSources = input.returns.map(verifyWalmartRawReturnsPages);
  const populationsByStore = assertOnePerStore(populations, "published_populations");
  const ordersByStore = ordersPartitionsByStoreAndScope(ordersSources);
  const returnsByStore = exactScopesByStore(
    returnsSources,
    WALMART_RETURN_WFS_SCOPES,
    (source) => source.request.wfs_enabled,
    "returns",
  );
  sameStoreSet(populationsByStore, ordersByStore, "orders");
  sameStoreSet(populationsByStore, returnsByStore, "returns");
  const allRequestCorrelations = new Set<string>();
  for (const source of [...ordersSources, ...returnsSources]) {
    for (const page of source.pages) {
      if (allRequestCorrelations.has(page.request_correlation_id_sha256)) {
        throw new Error("raw transaction sources reuse a request correlation ID");
      }
      allRequestCorrelations.add(page.request_correlation_id_sha256);
    }
  }

  const sortedStores = [...populationsByStore.keys()].sort((a, b) => a - b);
  const firstOrders = ordersByStore.get(sortedStores[0])!.get("SellerFulfilled")![0];
  const window = parseWindow(
    firstOrders.request.sales_window_starts_at_exclusive,
    firstOrders.request.sales_window_ends_at_exclusive,
    "sales_window",
  );
  const firstReturns = returnsByStore.get(sortedStores[0])!.get("N")!;
  const observationStartsAt = firstReturns.request.observation_starts_at_inclusive;
  const cutoffAt = firstReturns.request.observation_cutoff_at_exclusive;
  if (observationStartsAt !== window.starts_at) {
    throw new Error("outcome observation must start exactly at the sales-window start");
  }
  if (Date.parse(cutoffAt) < window.ends_ms) {
    throw new Error("outcome cutoff cannot precede the end of the sales window");
  }

  let capturedAt = "1970-01-01T00:00:00.000Z";
  const publishedRows = new Map<string, WalmartListingIdentity>();
  for (const storeIndex of sortedStores) {
    const population = populationsByStore.get(storeIndex)!;
    const orders = [...ordersByStore.get(storeIndex)!.values()].flat();
    const returns = [...returnsByStore.get(storeIndex)!.values()];
    const sellerFingerprint = population.account_scope.seller_account_fingerprint_sha256;
    for (const artifact of [...orders, ...returns]) {
      if (artifact.account_scope.seller_account_fingerprint_sha256 !== sellerFingerprint) {
        throw new Error(`store_index ${storeIndex} source account fingerprints do not match`);
      }
    }
    for (const scope of WALMART_ORDER_SHIP_NODE_TYPES) {
      const covered = assertCanonicalOrderPartitionCoverage(
        ordersByStore.get(storeIndex)!.get(scope)!,
        window,
        `orders[store=${storeIndex}][scope=${scope}]`,
      );
      ordersByStore.get(storeIndex)!.set(scope, covered);
    }
    for (const returnsArtifact of returns) {
      if (returnsArtifact.request.observation_starts_at_inclusive !== observationStartsAt
        || returnsArtifact.request.observation_cutoff_at_exclusive !== cutoffAt) {
        throw new Error(`store_index ${storeIndex} returns observation window conflicts with other stores`);
      }
    }
    if (Date.parse(population.captured_at) < Date.parse(cutoffAt)) {
      throw new Error(`${population.artifact_id}.captured_at precedes the outcome cutoff`);
    }
    for (const artifact of [population, ...orders, ...returns]) {
      if (Date.parse(artifact.captured_at) > Date.parse(capturedAt)) capturedAt = artifact.captured_at;
    }
    for (const row of population.rows) {
      publishedRows.set(row.listing_key, {
        channel: row.channel,
        store_index: row.store_index,
        sku: row.sku,
        listing_key: row.listing_key,
      });
    }
  }

  const metrics = new Map<string, MetricAccumulator>();
  for (const listingKey of publishedRows.keys()) metrics.set(listingKey, emptyMetric());
  const cohortLines = new Map<string, CohortLine>();
  const regularPurchaseOrderLines = new Map<string, Set<string>>();
  const replacementPurchaseOrders = new Set<string>();
  const outcomes = new Map<string, OutcomeAccumulator>();
  const reconciliation: WalmartFrozenPerformanceReconciliation = {
    published_population_rows: publishedRows.size,
    unique_orders: 0,
    order_lines: 0,
    eligible_sold_lines: 0,
    unique_returns: 0,
    return_lines: 0,
    replacement_order_lines_excluded: 0,
    order_lines_outside_published_population: 0,
    outcome_units_outside_sales_cohort: 0,
    outcome_units_outside_published_population: 0,
    outcome_units_suppressed_by_precedence: 0,
    cancelled_outcome_units_excluded: 0,
    order_partitions: ordersSources.length,
    order_partition_ids: ordersSources.map((source) => source.partition_id).sort(compareCodeUnits),
    overlapping_orders_deduplicated: 0,
    outcome_units_unknown_or_pre_window_purchase_order: 0,
    outcome_units_replacement_purchase_order: 0,
  };

  for (const storeIndex of sortedStores) {
    const orderScopes = ordersByStore.get(storeIndex)!;
    const collected = collectPartitionedOrderRecords(
      WALMART_ORDER_SHIP_NODE_TYPES.flatMap((scope) => (
        orderScopes.get(scope)!.map((source) => ({
          artifact_id: source.artifact_id,
          partition_id: source.partition_id,
          source_scope: scope,
          partition_starts_ms: Date.parse(source.request.partition_starts_at_exclusive),
          partition_ends_ms: Date.parse(source.request.partition_ends_at_exclusive),
          pages: source.pages,
          limit: source.request.limit,
        }))
      )),
      window,
    );
    reconciliation.overlapping_orders_deduplicated = checkedAdd(
      reconciliation.overlapping_orders_deduplicated,
      collected.overlapping_orders_deduplicated,
      "source_reconciliation.overlapping_orders_deduplicated",
    );
    reconciliation.unique_orders = checkedAdd(
      reconciliation.unique_orders,
      collected.advertised_total_count,
      "source_reconciliation.unique_orders",
    );
    if (reconciliation.unique_orders > MAX_ORDERS_PER_COMPILE) {
      throw new Error("source_reconciliation.unique_orders exceeds the compile cap");
    }
    for (const [orderIndex, scopedOrder] of collected.records.entries()) {
        const order = scopedOrder.record;
        const orderPath = `orders[store=${storeIndex}][scope=${scopedOrder.source_scope}]`
          + `[artifact=${scopedOrder.artifact_id}][${orderIndex}]`;
        const purchaseOrderId = requiredString(
          order.purchaseOrderId,
          `${orderPath}.purchaseOrderId`,
          MAX_ID_LENGTH,
        );
        const orderMillis = parseRawInstant(order.orderDate, `${orderPath}.orderDate`);
        if (orderMillis <= window.starts_ms || orderMillis >= window.ends_ms) {
          throw new Error(`${orderPath}.orderDate is outside the open sales window`);
        }
        const currentOrderType = orderType(order.orderType, `${orderPath}.orderType`);
        const purchaseOrderKey = `${storeIndex}\u0000${purchaseOrderId}`;
        const rawLines = unwrapObjectList(order.orderLines, "orderLine", `${orderPath}.orderLines`);
        if (rawLines.length > MAX_ORDER_LINES_PER_ORDER) {
          throw new Error(`${orderPath} exceeds the per-order line cap`);
        }
        const lines = uniqueNestedRows(rawLines, "lineNumber", `${orderPath}.orderLines.orderLine`);
        if (lines.length === 0) throw new Error(`${orderPath} must contain order lines`);
        reconciliation.order_lines = checkedAdd(
          reconciliation.order_lines,
          lines.length,
          "source_reconciliation.order_lines",
        );
        if (reconciliation.order_lines > MAX_ORDER_LINES_PER_COMPILE) {
          throw new Error("source_reconciliation.order_lines exceeds the compile cap");
        }
        if (currentOrderType === "REPLACEMENT") {
          replacementPurchaseOrders.add(purchaseOrderKey);
        } else {
          regularPurchaseOrderLines.set(
            purchaseOrderKey,
            new Set(lines.map((line, lineIndex) => requiredString(
              line.lineNumber,
              `${orderPath}.orderLines.orderLine[${lineIndex}].lineNumber`,
              MAX_ID_LENGTH,
            ))),
          );
        }
        for (const [lineIndex, line] of lines.entries()) {
          const linePath = `${orderPath}.orderLines.orderLine[${lineIndex}]`;
          const lineNumber = requiredString(line.lineNumber, `${linePath}.lineNumber`, MAX_ID_LENGTH);
          const sku = parseSku(line.item, `${linePath}.item`);
          const listingKey = walmartListingKey(storeIndex, sku);
          const orderedUnits = parseQuantity(line.orderLineQuantity, `${linePath}.orderLineQuantity`);
          const eligibleUnits = parseEligibleUnits(
            line.orderLineStatuses,
            orderedUnits,
            `${linePath}.orderLineStatuses`,
          );
          if (currentOrderType === "REPLACEMENT") {
            reconciliation.replacement_order_lines_excluded = checkedAdd(
              reconciliation.replacement_order_lines_excluded,
              1,
              "source_reconciliation.replacement_order_lines_excluded",
            );
            continue;
          }
          const productCents = parseProductChargeCents(line.charges, `${linePath}.charges`);
          const joinKey = lineJoinKey(storeIndex, purchaseOrderId, lineNumber);
          const prior = cohortLines.get(joinKey);
          if (prior) throw new Error(`${linePath} duplicates sales-cohort PO + line identity`);
          cohortLines.set(joinKey, {
            listing_key: listingKey,
            sku,
            ordered_units: orderedUnits,
            eligible_units: eligibleUnits,
          });
          if (eligibleUnits === 0) continue;
          reconciliation.eligible_sold_lines = checkedAdd(
            reconciliation.eligible_sold_lines,
            1,
            "source_reconciliation.eligible_sold_lines",
          );
          const metric = metrics.get(listingKey);
          if (!metric) {
            reconciliation.order_lines_outside_published_population = checkedAdd(
              reconciliation.order_lines_outside_published_population,
              1,
              "source_reconciliation.order_lines_outside_published_population",
            );
            continue;
          }
          metric.units_sold = checkedAdd(metric.units_sold, eligibleUnits, `${listingKey}.units_sold`);
          metric.gross_sales_cents = checkedAdd(
            metric.gross_sales_cents,
            prorateCents(productCents, eligibleUnits, orderedUnits, `${listingKey}.gross_sales_cents`),
            `${listingKey}.gross_sales_cents`,
          );
      }
    }
  }

  const outcomeMillisStart = Date.parse(observationStartsAt);
  const outcomeMillisEnd = Date.parse(cutoffAt);
  for (const storeIndex of sortedStores) {
    const returnScopes = returnsByStore.get(storeIndex)!;
    const collected = collectDisjointScopedRecords(
      WALMART_RETURN_WFS_SCOPES.map((scope) => {
        const source = returnScopes.get(scope)!;
        return {
          artifact_id: source.artifact_id,
          source_scope: `WFS_${scope}`,
          pages: source.pages,
          limit: source.request.limit,
        };
      }),
      "returns",
    );
    reconciliation.unique_returns = checkedAdd(
      reconciliation.unique_returns,
      collected.advertised_total_count,
      "source_reconciliation.unique_returns",
    );
    if (reconciliation.unique_returns > MAX_RETURNS_PER_COMPILE) {
      throw new Error("source_reconciliation.unique_returns exceeds the compile cap");
    }
    for (const [returnIndex, scopedReturn] of collected.records.entries()) {
        const returnOrder = scopedReturn.record;
        const returnPath = `returns[store=${storeIndex}][scope=${scopedReturn.source_scope}]`
          + `[artifact=${scopedReturn.artifact_id}][${returnIndex}]`;
        requiredString(
          returnOrder.returnOrderId,
          `${returnPath}.returnOrderId`,
          MAX_ID_LENGTH,
        );
        const returnMillis = parseRawInstant(returnOrder.returnOrderDate, `${returnPath}.returnOrderDate`);
        if (returnMillis < outcomeMillisStart || returnMillis >= outcomeMillisEnd) {
          throw new Error(`${returnPath}.returnOrderDate is outside the half-open outcome observation`);
        }
        const type = returnLineOutcome(returnOrder.returnType, `${returnPath}.returnType`);
        if (type === "REPLACEMENT") {
          requiredString(
            returnOrder.replacementCustomerOrderId,
            `${returnPath}.replacementCustomerOrderId`,
            MAX_ID_LENGTH,
          );
        }
        if (!Array.isArray(returnOrder.returnOrderLines)
          || !returnOrder.returnOrderLines.every(isRecord)) {
          throw new Error(`${returnPath}.returnOrderLines must be a flat array of objects`);
        }
        if (returnOrder.returnOrderLines.length > MAX_RETURN_LINES_PER_RETURN) {
          throw new Error(`${returnPath} exceeds the per-return line cap`);
        }
        const lines = uniqueNestedRows(
          returnOrder.returnOrderLines as JsonObject[],
          "returnOrderLineNumber",
          `${returnPath}.returnOrderLines`,
        );
        if (lines.length === 0) throw new Error(`${returnPath} must contain returnOrderLines`);
        reconciliation.return_lines = checkedAdd(
          reconciliation.return_lines,
          lines.length,
          "source_reconciliation.return_lines",
        );
        if (reconciliation.return_lines > MAX_RETURN_LINES_PER_COMPILE) {
          throw new Error("source_reconciliation.return_lines exceeds the compile cap");
        }
        for (const [lineIndex, line] of lines.entries()) {
          const linePath = `${returnPath}.returnOrderLines[${lineIndex}]`;
          const purchaseOrderId = requiredString(
            line.purchaseOrderId,
            `${linePath}.purchaseOrderId`,
            MAX_ID_LENGTH,
          );
          const rawLineNumber = line.purchaseOrderLineNumber;
          const lineNumber = typeof rawLineNumber === "string"
            ? requiredString(rawLineNumber, `${linePath}.purchaseOrderLineNumber`, MAX_ID_LENGTH)
            : String(requiredSafeInteger(rawLineNumber, `${linePath}.purchaseOrderLineNumber`, 1));
          const sku = parseSku(line.item, `${linePath}.item`);
          const quantity = parseReturnQuantity(line.quantity, `${linePath}.quantity`);
          const refundedQty = requiredIntegerLike(line.refundedQty, `${linePath}.refundedQty`);
          if (refundedQty > quantity) {
            throw new Error(`${linePath}.refundedQty cannot exceed quantity`);
          }
          if (line.currentRefundStatus !== undefined && line.currentRefundStatus !== null) {
            requiredString(line.currentRefundStatus, `${linePath}.currentRefundStatus`);
          }
          if (returnLineIsCancelled(line, quantity, linePath)) {
            reconciliation.cancelled_outcome_units_excluded = checkedAdd(
              reconciliation.cancelled_outcome_units_excluded,
              quantity,
              "source_reconciliation.cancelled_outcome_units_excluded",
            );
            continue;
          }
          const joinKey = lineJoinKey(storeIndex, purchaseOrderId, lineNumber);
          const cohortLine = cohortLines.get(joinKey);
          if (!cohortLine) {
            const purchaseOrderKey = `${storeIndex}\u0000${purchaseOrderId}`;
            if (regularPurchaseOrderLines.has(purchaseOrderKey)) {
              throw new Error(
                `${linePath}.purchaseOrderLineNumber does not match a known in-window purchase order line`,
              );
            }
            reconciliation.outcome_units_outside_sales_cohort = checkedAdd(
              reconciliation.outcome_units_outside_sales_cohort,
              quantity,
              "source_reconciliation.outcome_units_outside_sales_cohort",
            );
            if (replacementPurchaseOrders.has(purchaseOrderKey)) {
              reconciliation.outcome_units_replacement_purchase_order = checkedAdd(
                reconciliation.outcome_units_replacement_purchase_order,
                quantity,
                "source_reconciliation.outcome_units_replacement_purchase_order",
              );
            } else {
              reconciliation.outcome_units_unknown_or_pre_window_purchase_order = checkedAdd(
                reconciliation.outcome_units_unknown_or_pre_window_purchase_order,
                quantity,
                "source_reconciliation.outcome_units_unknown_or_pre_window_purchase_order",
              );
            }
            continue;
          }
          if (cohortLine.sku !== sku) {
            throw new Error(`${linePath}.item.sku conflicts with the exact joined order line SKU`);
          }
          if (cohortLine.eligible_units === 0) {
            throw new Error(`${linePath} attaches risk units to a sales-cohort line with zero eligible sold units`);
          }
          const accumulator = outcomes.get(joinKey) ?? { RETURN: 0, REFUND: 0, REPLACEMENT: 0 };
          let lineRemaining = quantity;
          const lineReplaced = type === "REPLACEMENT" ? quantity : 0;
          lineRemaining -= lineReplaced;
          const lineRefunded = Math.min(refundedQty, lineRemaining);
          lineRemaining -= lineRefunded;
          const lineReturned = lineRemaining;
          const rawLineOutcomeUnits = checkedAdd(
            checkedAdd(quantity, lineReplaced, `${joinKey}.raw return line outcomes`),
            refundedQty,
            `${joinKey}.raw return line outcomes`,
          );
          reconciliation.outcome_units_suppressed_by_precedence = checkedAdd(
            reconciliation.outcome_units_suppressed_by_precedence,
            rawLineOutcomeUnits - quantity,
            "source_reconciliation.outcome_units_suppressed_by_precedence",
          );
          accumulator.RETURN = checkedAdd(accumulator.RETURN, lineReturned, `${joinKey}.RETURN`);
          accumulator.REFUND = checkedAdd(accumulator.REFUND, lineRefunded, `${joinKey}.REFUND`);
          accumulator.REPLACEMENT = checkedAdd(
            accumulator.REPLACEMENT,
            lineReplaced,
            `${joinKey}.REPLACEMENT`,
          );
          outcomes.set(joinKey, accumulator);
      }
    }
  }

  for (const [joinKey, outcome] of outcomes.entries()) {
    const cohortLine = cohortLines.get(joinKey)!;
    let remaining = cohortLine.eligible_units;
    const replaced = Math.min(outcome.REPLACEMENT, remaining);
    remaining -= replaced;
    const refunded = Math.min(outcome.REFUND, remaining);
    remaining -= refunded;
    const returned = Math.min(outcome.RETURN, remaining);
    remaining -= returned;
    const rawOutcomeUnits = checkedAdd(
      checkedAdd(outcome.REPLACEMENT, outcome.REFUND, `${joinKey}.raw outcomes`),
      outcome.RETURN,
      `${joinKey}.raw outcomes`,
    );
    const allocated = replaced + refunded + returned;
    reconciliation.outcome_units_suppressed_by_precedence = checkedAdd(
      reconciliation.outcome_units_suppressed_by_precedence,
      rawOutcomeUnits - allocated,
      "source_reconciliation.outcome_units_suppressed_by_precedence",
    );
    const metric = metrics.get(cohortLine.listing_key);
    if (!metric) {
      reconciliation.outcome_units_outside_published_population = checkedAdd(
        reconciliation.outcome_units_outside_published_population,
        allocated,
        "source_reconciliation.outcome_units_outside_published_population",
      );
      continue;
    }
    metric.units_replaced = checkedAdd(metric.units_replaced, replaced, `${cohortLine.listing_key}.units_replaced`);
    metric.units_refunded = checkedAdd(metric.units_refunded, refunded, `${cohortLine.listing_key}.units_refunded`);
    metric.units_returned = checkedAdd(metric.units_returned, returned, `${cohortLine.listing_key}.units_returned`);
  }

  const rows = [...publishedRows.values()]
    .sort((left, right) => compareCodeUnits(left.listing_key, right.listing_key))
    .map((identity): WalmartFrozenPerformanceRow => {
      const metric = metrics.get(identity.listing_key)!;
      const riskUnits = BigInt(metric.units_returned)
        + BigInt(metric.units_refunded)
        + BigInt(metric.units_replaced);
      if (riskUnits > BigInt(metric.units_sold)) {
        throw new Error(`${identity.listing_key} outcome units exceed units_sold`);
      }
      if (metric.units_sold === 0 && riskUnits > BigInt(0)) {
        throw new Error(`${identity.listing_key} has risk units but zero units_sold`);
      }
      if (metric.units_sold === 0 && metric.gross_sales_cents !== 0) {
        throw new Error(`${identity.listing_key} has provisional gross sales but zero units_sold`);
      }
      return { ...identity, ...metric };
    });

  const bindings = {
    published_population: populations.map(sourceBinding).sort(compareBindings),
    orders: ordersSources.map(sourceBinding).sort(compareBindings),
    returns: returnsSources.map(sourceBinding).sort(compareBindings),
  };
  const body: WalmartFrozen180DayPerformanceSourceBody = {
    schema_version: WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA,
    captured_at: capturedAt,
    channel: CHANNEL,
    published_population_complete: true,
    sales_window: {
      starts_at: window.starts_at,
      start_exclusive: true,
      ends_at: window.ends_at,
      end_exclusive: true,
      days: WINDOW_DAYS,
    },
    outcome_observation: {
      starts_at: observationStartsAt,
      cutoff_at: cutoffAt,
      end_exclusive: true,
    },
    cohort_semantics: canonicalClone(WALMART_PERFORMANCE_COHORT_SEMANTICS),
    money_semantics: canonicalClone(WALMART_PERFORMANCE_MONEY_SEMANTICS),
    assurance: canonicalClone(WALMART_PERFORMANCE_ASSURANCE),
    source_bindings: bindings,
    source_reconciliation: reconciliation,
    rows,
  };
  const bodySha = walmartPerformanceCanonicalSha256(body);
  return deepFreeze({
    ...canonicalClone(body),
    snapshot_id: `walmart-shadow-performance-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  });
}

export function compileWalmartFrozen180DayPerformanceSourceFromItemReports(
  input: WalmartFrozenPerformanceAuthoritativeCompileInput,
): SealedWalmartFrozen180DayPerformanceSource {
  if (!input || !Array.isArray(input.published_item_sources)
    || !Array.isArray(input.orders) || !Array.isArray(input.returns)) {
    throw new Error("authoritative compile input must contain published_item_sources, orders, and returns arrays");
  }
  return compileWalmartFrozen180DayPerformanceSource({
    published_populations: input.published_item_sources.map(
      compileWalmartPerformancePopulationFromItemReport,
    ),
    orders: input.orders,
    returns: input.returns,
  });
}

function parseBinding(value: unknown, path: string): WalmartFrozenPerformanceSourceBinding {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "source_scope", "seller_account_fingerprint_sha256",
    "artifact_id", "body_sha256", "captured_at", "store_index", "partition_id",
    "partition_starts_at_exclusive", "partition_ends_at_exclusive",
  ], path);
  const isOrders = value.schema_version === WALMART_RAW_ORDERS_PAGES_SCHEMA;
  const partitionId = value.partition_id === null
    ? null
    : requiredString(value.partition_id, `${path}.partition_id`, 256);
  const partitionStartsAt = value.partition_starts_at_exclusive === null
    ? null
    : requiredCanonicalTimestamp(
      value.partition_starts_at_exclusive,
      `${path}.partition_starts_at_exclusive`,
    );
  const partitionEndsAt = value.partition_ends_at_exclusive === null
    ? null
    : requiredCanonicalTimestamp(
      value.partition_ends_at_exclusive,
      `${path}.partition_ends_at_exclusive`,
    );
  if (isOrders) {
    if (partitionId === null || partitionStartsAt === null || partitionEndsAt === null) {
      throw new Error(`${path} Orders binding must bind its partition identity and interval`);
    }
    if (Date.parse(partitionEndsAt) <= Date.parse(partitionStartsAt)) {
      throw new Error(`${path} Orders partition end must follow its start`);
    }
  } else if (partitionId !== null || partitionStartsAt !== null || partitionEndsAt !== null) {
    throw new Error(`${path} non-Orders binding cannot claim an Orders partition`);
  }
  return {
    schema_version: requiredString(value.schema_version, `${path}.schema_version`),
    source_scope: requiredString(value.source_scope, `${path}.source_scope`),
    seller_account_fingerprint_sha256: requiredSha(
      value.seller_account_fingerprint_sha256,
      `${path}.seller_account_fingerprint_sha256`,
    ),
    artifact_id: requiredString(value.artifact_id, `${path}.artifact_id`),
    body_sha256: requiredSha(value.body_sha256, `${path}.body_sha256`),
    captured_at: requiredCanonicalTimestamp(value.captured_at, `${path}.captured_at`),
    store_index: requiredSafeInteger(value.store_index, `${path}.store_index`, 1),
    partition_id: partitionId,
    partition_starts_at_exclusive: partitionStartsAt,
    partition_ends_at_exclusive: partitionEndsAt,
  };
}

function compareBindings(
  left: WalmartFrozenPerformanceSourceBinding,
  right: WalmartFrozenPerformanceSourceBinding,
): number {
  return left.store_index - right.store_index
    || compareCodeUnits(left.source_scope, right.source_scope)
    || compareCodeUnits(
      left.partition_starts_at_exclusive ?? "",
      right.partition_starts_at_exclusive ?? "",
    )
    || compareCodeUnits(
      left.partition_ends_at_exclusive ?? "",
      right.partition_ends_at_exclusive ?? "",
    )
    || compareCodeUnits(left.artifact_id, right.artifact_id);
}

function parseBindingArray(
  value: unknown,
  path: string,
  expectedSchema: string,
): WalmartFrozenPerformanceSourceBinding[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must be a non-empty array`);
  const rows = value.map((row, index) => parseBinding(row, `${path}[${index}]`));
  if (rows.some((row) => row.schema_version !== expectedSchema)) {
    throw new Error(`${path} bindings must use schema_version ${expectedSchema}`);
  }
  const artifactIds = rows.map((row) => row.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) throw new Error(`${path} has duplicate artifact_id`);
  if (canonicalJson(rows) !== canonicalJson([...rows].sort(compareBindings))) {
    throw new Error(`${path} must be sorted by store_index, source_scope, then artifact_id`);
  }
  return rows;
}

function assertBindingScopes(
  bindings: readonly WalmartFrozenPerformanceSourceBinding[],
  storeIndexes: readonly number[],
  expectedScopes: readonly string[],
  path: string,
): void {
  const expected = [...expectedScopes].sort(compareCodeUnits);
  for (const storeIndex of storeIndexes) {
    const actual = bindings
      .filter((binding) => binding.store_index === storeIndex)
      .map((binding) => binding.source_scope)
      .sort(compareCodeUnits);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`${path} must contain exact scopes ${expected.join(", ")} for store_index ${storeIndex}`);
    }
  }
}

function assertOrderBindingCoverage(
  bindings: readonly WalmartFrozenPerformanceSourceBinding[],
  populationBindings: readonly WalmartFrozenPerformanceSourceBinding[],
  window: ReturnType<typeof parseWindow>,
  path: string,
): void {
  for (const populationBinding of populationBindings) {
    const storeIndex = populationBinding.store_index;
    for (const scope of WALMART_ORDER_SHIP_NODE_TYPES) {
      const partitions = bindings
        .filter((binding) => binding.store_index === storeIndex && binding.source_scope === scope)
        .sort((left, right) => (
          Date.parse(left.partition_starts_at_exclusive!)
            - Date.parse(right.partition_starts_at_exclusive!)
          || Date.parse(left.partition_ends_at_exclusive!)
            - Date.parse(right.partition_ends_at_exclusive!)
          || compareCodeUnits(left.partition_id!, right.partition_id!)
        ));
      if (partitions.length < 2) {
        throw new Error(`${path} must bind baseline and post-cutoff tail for ${storeIndex}/${scope}`);
      }
      let coveredEnd = -1;
      for (const [index, partition] of partitions.entries()) {
        const startsMs = Date.parse(partition.partition_starts_at_exclusive!);
        const endsMs = Date.parse(partition.partition_ends_at_exclusive!);
        const expectedId = walmartOrdersPartitionId({
          store_index: storeIndex,
          seller_account_fingerprint_sha256:
            populationBinding.seller_account_fingerprint_sha256,
          ship_node_type: scope,
          sales_window_starts_at_exclusive: window.starts_at,
          sales_window_ends_at_exclusive: window.ends_at,
          partition_starts_at_exclusive: partition.partition_starts_at_exclusive!,
          partition_ends_at_exclusive: partition.partition_ends_at_exclusive!,
        });
        if (partition.partition_id !== expectedId) {
          throw new Error(`${path} has a partition_id detached from its exact store/scope/window`);
        }
        if (index === 0) {
          if (startsMs !== window.starts_ms) {
            throw new Error(`${path} first partition must start at the final sales-window start`);
          }
        } else {
          if (coveredEnd - startsMs < 1) {
            throw new Error(`${path} partitions must overlap by at least 1ms without gaps`);
          }
          if (endsMs <= coveredEnd) {
            throw new Error(`${path} partitions must extend coverage in canonical order`);
          }
        }
        coveredEnd = endsMs;
      }
      if (coveredEnd !== window.ends_ms) {
        throw new Error(`${path} is missing a tail ending at the final sales-window end`);
      }
    }
    const unsupported = bindings.some((binding) => (
      binding.store_index === storeIndex
      && !WALMART_ORDER_SHIP_NODE_TYPES.includes(
        binding.source_scope as WalmartOrderShipNodeType,
      )
    ));
    if (unsupported) throw new Error(`${path} has an unsupported Orders scope`);
  }
}

function parseReconciliation(value: unknown, path: string): WalmartFrozenPerformanceReconciliation {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const numericKeys = [
    "published_population_rows", "unique_orders", "order_lines", "eligible_sold_lines",
    "unique_returns", "return_lines", "replacement_order_lines_excluded",
    "order_lines_outside_published_population",
    "outcome_units_outside_sales_cohort", "outcome_units_outside_published_population",
    "outcome_units_suppressed_by_precedence", "cancelled_outcome_units_excluded",
    "order_partitions", "overlapping_orders_deduplicated",
    "outcome_units_unknown_or_pre_window_purchase_order",
    "outcome_units_replacement_purchase_order",
  ] as const;
  assertExactKeys(value, [...numericKeys, "order_partition_ids"], path);
  if (!Array.isArray(value.order_partition_ids) || value.order_partition_ids.length === 0) {
    throw new Error(`${path}.order_partition_ids must be a non-empty array`);
  }
  const partitionIds = value.order_partition_ids.map((id, index) => (
    requiredString(id, `${path}.order_partition_ids[${index}]`, 256)
  ));
  if (new Set(partitionIds).size !== partitionIds.length) {
    throw new Error(`${path}.order_partition_ids must be unique`);
  }
  if (canonicalJson(partitionIds) !== canonicalJson([...partitionIds].sort(compareCodeUnits))) {
    throw new Error(`${path}.order_partition_ids must be in canonical order`);
  }
  const parsed = Object.fromEntries(numericKeys.map((key) => [
    key,
    requiredSafeInteger(value[key], `${path}.${key}`),
  ])) as unknown as Omit<WalmartFrozenPerformanceReconciliation, "order_partition_ids">;
  if (parsed.order_partitions !== partitionIds.length) {
    throw new Error(`${path}.order_partitions must equal order_partition_ids.length`);
  }
  return { ...parsed, order_partition_ids: partitionIds };
}

function assertFixedObject(value: unknown, expected: unknown, path: string): void {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(`${path} does not match the frozen compiler semantics`);
  }
}

export function verifyWalmartFrozen180DayPerformanceSource(
  value: unknown,
): SealedWalmartFrozen180DayPerformanceSource {
  const path = "performance source";
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "channel",
    "published_population_complete", "sales_window", "outcome_observation",
    "cohort_semantics", "money_semantics", "assurance", "source_bindings",
    "source_reconciliation", "rows",
  ], path);
  if (value.schema_version !== WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  if (value.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  if (value.published_population_complete !== true) {
    throw new Error(`${path}.published_population_complete must be true`);
  }
  const bodySha = requiredSha(value.body_sha256, `${path}.body_sha256`);
  const bodyForSeal = { ...value };
  delete bodyForSeal.snapshot_id;
  delete bodyForSeal.body_sha256;
  if (walmartPerformanceCanonicalSha256(bodyForSeal) !== bodySha) {
    throw new Error(`${path}.body_sha256 does not match canonical body`);
  }
  const snapshotId = requiredString(value.snapshot_id, `${path}.snapshot_id`);
  if (snapshotId !== `walmart-shadow-performance-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.snapshot_id is not derived from body_sha256`);
  }
  const capturedAt = requiredCanonicalTimestamp(value.captured_at, `${path}.captured_at`);
  if (!isRecord(value.sales_window)) throw new Error(`${path}.sales_window must be an object`);
  assertExactKeys(value.sales_window, [
    "starts_at", "start_exclusive", "ends_at", "end_exclusive", "days",
  ], `${path}.sales_window`);
  if (value.sales_window.start_exclusive !== true || value.sales_window.end_exclusive !== true) {
    throw new Error(`${path}.sales_window boundaries must both be exclusive`);
  }
  if (value.sales_window.days !== WINDOW_DAYS) throw new Error(`${path}.sales_window.days must be ${WINDOW_DAYS}`);
  const window = parseWindow(value.sales_window.starts_at, value.sales_window.ends_at, `${path}.sales_window`);
  if (!isRecord(value.outcome_observation)) throw new Error(`${path}.outcome_observation must be an object`);
  assertExactKeys(value.outcome_observation, [
    "starts_at", "cutoff_at", "end_exclusive",
  ], `${path}.outcome_observation`);
  const observationStartsAt = requiredCanonicalTimestamp(
    value.outcome_observation.starts_at,
    `${path}.outcome_observation.starts_at`,
  );
  const cutoffAt = requiredCanonicalTimestamp(
    value.outcome_observation.cutoff_at,
    `${path}.outcome_observation.cutoff_at`,
  );
  if (value.outcome_observation.end_exclusive !== true) {
    throw new Error(`${path}.outcome_observation.end_exclusive must be true`);
  }
  if (observationStartsAt !== window.starts_at) {
    throw new Error(`${path}.outcome_observation must start at sales-window start`);
  }
  if (Date.parse(cutoffAt) < window.ends_ms || Date.parse(cutoffAt) > Date.parse(capturedAt)) {
    throw new Error(`${path}.outcome_observation.cutoff_at is inconsistent with window/capture`);
  }
  assertFixedObject(value.cohort_semantics, WALMART_PERFORMANCE_COHORT_SEMANTICS, `${path}.cohort_semantics`);
  assertFixedObject(value.money_semantics, WALMART_PERFORMANCE_MONEY_SEMANTICS, `${path}.money_semantics`);
  assertFixedObject(value.assurance, WALMART_PERFORMANCE_ASSURANCE, `${path}.assurance`);
  if (!isRecord(value.source_bindings)) throw new Error(`${path}.source_bindings must be an object`);
  assertExactKeys(value.source_bindings, [
    "published_population", "orders", "returns",
  ], `${path}.source_bindings`);
  const sourceBindings = {
    published_population: parseBindingArray(
      value.source_bindings.published_population,
      `${path}.source_bindings.published_population`,
      WALMART_PERFORMANCE_POPULATION_SCHEMA,
    ),
    orders: parseBindingArray(
      value.source_bindings.orders,
      `${path}.source_bindings.orders`,
      WALMART_RAW_ORDERS_PAGES_SCHEMA,
    ),
    returns: parseBindingArray(
      value.source_bindings.returns,
      `${path}.source_bindings.returns`,
      WALMART_RAW_RETURNS_PAGES_SCHEMA,
    ),
  };
  const allBindings = [
    ...sourceBindings.published_population,
    ...sourceBindings.orders,
    ...sourceBindings.returns,
  ];
  let latestBindingCapture = "1970-01-01T00:00:00.000Z";
  for (const binding of allBindings) {
    if (Date.parse(binding.captured_at) > Date.parse(capturedAt)) {
      throw new Error(`${path}.source_bindings captured_at cannot exceed performance captured_at`);
    }
    if (Date.parse(binding.captured_at) > Date.parse(latestBindingCapture)) {
      latestBindingCapture = binding.captured_at;
    }
  }
  if (capturedAt !== latestBindingCapture) {
    throw new Error(`${path}.captured_at must equal the latest bound source capture`);
  }
  const populationStoreIndexes = sourceBindings.published_population.map((row) => row.store_index);
  if (new Set(populationStoreIndexes).size !== populationStoreIndexes.length) {
    throw new Error(`${path}.source_bindings.published_population must have exactly one binding per store_index`);
  }
  if (sourceBindings.published_population.some((binding) => binding.source_scope !== "PUBLISHED")) {
    throw new Error(`${path}.source_bindings.published_population scope must be PUBLISHED`);
  }
  const bindingStores = canonicalJson(populationStoreIndexes);
  const orderStoreIndexes = [...new Set(sourceBindings.orders.map((row) => row.store_index))];
  const returnStoreIndexes = [...new Set(sourceBindings.returns.map((row) => row.store_index))];
  if (canonicalJson(orderStoreIndexes) !== bindingStores
    || canonicalJson(returnStoreIndexes) !== bindingStores) {
    throw new Error(`${path}.source_bindings store sets do not match`);
  }
  assertOrderBindingCoverage(
    sourceBindings.orders,
    sourceBindings.published_population,
    window,
    `${path}.source_bindings.orders`,
  );
  assertBindingScopes(
    sourceBindings.returns,
    populationStoreIndexes,
    WALMART_RETURN_WFS_SCOPES.map((scope) => `WFS_${scope}`),
    `${path}.source_bindings.returns`,
  );
  for (const binding of [
    ...sourceBindings.published_population,
    ...sourceBindings.returns,
  ]) {
    if (Date.parse(binding.captured_at) < Date.parse(cutoffAt)) {
      throw new Error(`${path}.source_bindings outcome/population capture precedes cutoff_at`);
    }
  }
  for (const populationBinding of sourceBindings.published_population) {
    const storeBindings = [
      ...sourceBindings.orders,
      ...sourceBindings.returns,
    ].filter((binding) => binding.store_index === populationBinding.store_index);
    if (storeBindings.some((binding) => (
      binding.seller_account_fingerprint_sha256
        !== populationBinding.seller_account_fingerprint_sha256
    ))) {
      throw new Error(`${path}.source_bindings seller account fingerprints do not match`);
    }
  }
  const reconciliation = parseReconciliation(value.source_reconciliation, `${path}.source_reconciliation`);
  const boundPartitionIds = sourceBindings.orders.map((binding) => binding.partition_id!).sort(compareCodeUnits);
  if (canonicalJson(boundPartitionIds) !== canonicalJson(reconciliation.order_partition_ids)) {
    throw new Error(`${path}.source_reconciliation.order_partition_ids do not match Orders bindings`);
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) throw new Error(`${path}.rows must be non-empty`);
  const seen = new Set<string>();
  const rows = value.rows.map((row, index): WalmartFrozenPerformanceRow => {
    const rowPath = `${path}.rows[${index}]`;
    if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys(row, [
      "channel", "store_index", "sku", "listing_key", "gross_sales_cents",
      "units_sold", "units_returned", "units_refunded", "units_replaced",
    ], rowPath);
    const identity = parseIdentity(row, rowPath);
    if (!populationStoreIndexes.includes(identity.store_index)) {
      throw new Error(`${rowPath}.store_index has no published-population binding`);
    }
    if (seen.has(identity.listing_key)) throw new Error(`${path}.rows contains duplicate listing_key`);
    seen.add(identity.listing_key);
    const metric = {
      gross_sales_cents: requiredSafeInteger(row.gross_sales_cents, `${rowPath}.gross_sales_cents`),
      units_sold: requiredSafeInteger(row.units_sold, `${rowPath}.units_sold`),
      units_returned: requiredSafeInteger(row.units_returned, `${rowPath}.units_returned`),
      units_refunded: requiredSafeInteger(row.units_refunded, `${rowPath}.units_refunded`),
      units_replaced: requiredSafeInteger(row.units_replaced, `${rowPath}.units_replaced`),
    };
    const riskUnits = BigInt(metric.units_returned) + BigInt(metric.units_refunded) + BigInt(metric.units_replaced);
    if (riskUnits > BigInt(metric.units_sold)) throw new Error(`${rowPath} outcome units exceed units_sold`);
    if (metric.units_sold === 0 && riskUnits > BigInt(0)) throw new Error(`${rowPath} has risk with zero sales`);
    if (metric.units_sold === 0 && metric.gross_sales_cents !== 0) {
      throw new Error(`${rowPath} gross_sales_cents must be zero when units_sold is zero`);
    }
    return { ...identity, ...metric };
  });
  const rowKeys = rows.map((row) => row.listing_key);
  if (canonicalJson(rowKeys) !== canonicalJson([...rowKeys].sort(compareCodeUnits))) {
    throw new Error(`${path}.rows must be in canonical listing_key order`);
  }
  if (reconciliation.published_population_rows !== rows.length) {
    throw new Error(`${path}.source_reconciliation published population count does not match rows`);
  }
  for (const storeIndex of populationStoreIndexes) {
    if (!rows.some((row) => row.store_index === storeIndex)) {
      throw new Error(`${path}.rows has no listing for bound store_index ${storeIndex}`);
    }
  }
  return deepFreeze({
    schema_version: WALMART_FROZEN_180D_PERFORMANCE_SOURCE_SCHEMA,
    snapshot_id: snapshotId,
    body_sha256: bodySha,
    captured_at: capturedAt,
    channel: CHANNEL,
    published_population_complete: true,
    sales_window: {
      starts_at: window.starts_at,
      start_exclusive: true,
      ends_at: window.ends_at,
      end_exclusive: true,
      days: WINDOW_DAYS,
    },
    outcome_observation: { starts_at: observationStartsAt, cutoff_at: cutoffAt, end_exclusive: true },
    cohort_semantics: canonicalClone(WALMART_PERFORMANCE_COHORT_SEMANTICS),
    money_semantics: canonicalClone(WALMART_PERFORMANCE_MONEY_SEMANTICS),
    assurance: canonicalClone(WALMART_PERFORMANCE_ASSURANCE),
    source_bindings: sourceBindings,
    source_reconciliation: reconciliation,
    rows,
  });
}

/**
 * Strong verifier: validates all source seals, recompiles deterministically,
 * and demands byte-equivalent canonical JSON (including source bindings and
 * reconciliation). A detached caller-authored performance hash cannot pass.
 */
export function verifyWalmartFrozen180DayPerformanceSourceAgainstRaw(
  value: unknown,
  input: WalmartFrozenPerformanceCompileInput,
): SealedWalmartFrozen180DayPerformanceSource {
  const verified = verifyWalmartFrozen180DayPerformanceSource(value);
  const rebuilt = compileWalmartFrozen180DayPerformanceSource(input);
  if (canonicalJson(verified) !== canonicalJson(rebuilt)) {
    throw new Error("performance source does not exactly rebuild from the supplied sealed raw sources");
  }
  return verified;
}

/**
 * Rebuild variant that starts at the authoritative sealed ITEM populations,
 * not caller-authored population projections. Operational callers should
 * first authenticate each ITEM source against its exact capture/context with
 * verifyWalmartItemReportPublishedSourceAgainstCapture.
 */
export function verifyWalmartFrozen180DayPerformanceSourceAgainstItemReports(
  value: unknown,
  input: WalmartFrozenPerformanceAuthoritativeCompileInput,
): SealedWalmartFrozen180DayPerformanceSource {
  const verified = verifyWalmartFrozen180DayPerformanceSource(value);
  const rebuilt = compileWalmartFrozen180DayPerformanceSourceFromItemReports(input);
  if (canonicalJson(verified) !== canonicalJson(rebuilt)) {
    throw new Error("performance source does not exactly rebuild from authoritative ITEM and raw transaction sources");
  }
  return verified;
}

function parseTrustedAccountRegistry(
  value: readonly WalmartTrustedPerformanceAccount[],
): WalmartTrustedPerformanceAccount[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("trusted account registry must be a non-empty exact store universe");
  }
  const parsed = value.map((entry, index) => {
    const path = `trusted account registry[${index}]`;
    const account = parseAccountScope(entry, path);
    return account;
  }).sort((left, right) => left.store_index - right.store_index);
  const stores = parsed.map((entry) => entry.store_index);
  if (new Set(stores).size !== stores.length) {
    throw new Error("trusted account registry contains duplicate store_index");
  }
  return parsed;
}

function assertExactTrustedStoreUniverse(
  registry: readonly WalmartTrustedPerformanceAccount[],
  candidates: readonly { store_index: number; account_scope: WalmartPerformanceAccountScope }[],
  path: string,
  allowMultiplePerStore: boolean,
): void {
  const registryByStore = new Map(registry.map((entry) => [entry.store_index, entry]));
  const candidateStores = new Set<number>();
  for (const candidate of candidates) {
    const trusted = registryByStore.get(candidate.store_index);
    if (!trusted) throw new Error(`${path} contains store_index outside trusted account registry`);
    if (candidate.account_scope.seller_account_fingerprint_sha256
      !== trusted.seller_account_fingerprint_sha256) {
      throw new Error(`${path} account fingerprint does not match trusted registry`);
    }
    if (!allowMultiplePerStore && candidateStores.has(candidate.store_index)) {
      throw new Error(`${path} contains duplicate store_index ${candidate.store_index}`);
    }
    candidateStores.add(candidate.store_index);
  }
  if (candidateStores.size !== registry.length
    || registry.some((entry) => !candidateStores.has(entry.store_index))) {
    throw new Error(`${path} must cover every and only trusted registry store_index`);
  }
}

/**
 * Capture-aware composition boundary for ITEM reports and the exact trusted
 * seller-account universe. Orders/Returns remain integrity-only because no
 * trusted transaction capture adapter exists in this repository; therefore
 * this function can never return operational_ready=true.
 */
export function verifyWalmartFrozen180DayPerformanceOperationalReadinessAgainstCaptures(
  value: unknown,
  input: WalmartFrozenPerformanceOperationalVerificationInput,
): WalmartFrozenPerformanceOperationalVerification {
  if (!input || !Array.isArray(input.trusted_accounts)
    || !Array.isArray(input.published_item_captures)
    || !Array.isArray(input.orders) || !Array.isArray(input.returns)) {
    throw new Error(
      "operational verification input must contain trusted_accounts, published_item_captures, orders, and returns arrays",
    );
  }
  const registry = parseTrustedAccountRegistry(input.trusted_accounts);
  const preliminaryItemSources = input.published_item_captures.map((entry, index) => {
    if (!entry || !isRecord(entry)) {
      throw new Error(`published_item_captures[${index}] must be an object`);
    }
    return verifyWalmartItemReportPublishedSource(entry.source);
  });
  assertExactTrustedStoreUniverse(
    registry,
    preliminaryItemSources.map((source) => ({
      store_index: source.account_scope.store_index,
      account_scope: source.account_scope,
    })),
    "published_item_captures",
    false,
  );
  const orders = input.orders.map(verifyWalmartRawOrdersPages);
  const returns = input.returns.map(verifyWalmartRawReturnsPages);
  assertExactTrustedStoreUniverse(registry, orders, "orders", true);
  assertExactTrustedStoreUniverse(registry, returns, "returns", true);
  const captureVerifiedItemSources = input.published_item_captures.map((entry) => (
    verifyWalmartItemReportPublishedSourceAgainstCapture(
      entry.source,
      entry.capture,
      entry.trusted_context,
    )
  ));
  const verified = verifyWalmartFrozen180DayPerformanceSourceAgainstItemReports(value, {
    published_item_sources: captureVerifiedItemSources,
    orders,
    returns,
  });
  const registryBody = registry.map((entry) => ({
    channel: CHANNEL,
    store_index: entry.store_index,
    seller_account_fingerprint_sha256: entry.seller_account_fingerprint_sha256,
  }));
  return deepFreeze({
    schema_version: WALMART_PERFORMANCE_OPERATIONAL_VERIFICATION_SCHEMA,
    performance_snapshot_id: verified.snapshot_id,
    performance_body_sha256: verified.body_sha256,
    trusted_account_registry_sha256: walmartPerformanceCanonicalSha256(registryBody),
    verified_store_indexes: registry.map((entry) => entry.store_index),
    item_report_capture_aware_verified: true,
    orders_returns_capture_aware_verified: false,
    gross_sales_calibration_verified: false,
    provisional_sampling_rank_basis: "UNITS_SOLD_ONLY",
    operational_ready: false,
    blockers: [
      "TRUSTED_ORDERS_RETURNS_CAPTURE_ADAPTER_MISSING",
      "MLMQ_PRODUCT_CHARGE_SCOPE_CALIBRATION_MISSING",
    ],
  });
}
