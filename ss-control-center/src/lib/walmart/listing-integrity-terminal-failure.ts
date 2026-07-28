import { createHash, randomUUID } from "node:crypto";

import { computeWalmartSellerAccountFingerprint } from
  "./item-report-capture-session.ts";
import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";

export const WALMART_LISTING_INTEGRITY_LISTING_QUALITY_RECEIPT_SCHEMA =
  "walmart-listing-integrity-listing-quality-receipt/v1" as const;
export const WALMART_LISTING_INTEGRITY_FAILURE_DISPOSITION_SCHEMA =
  "walmart-listing-integrity-terminal-failure-disposition/v1" as const;

const WALMART_ORIGIN = "https://marketplace.walmartapis.com";
const MAX_TOKEN_BYTES = 1024 * 1024;
const MAX_LISTING_QUALITY_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_ATTRIBUTE_FIELDS = [
  "count_per_pack",
  "flavor",
  "multipack_quantity",
  "number_of_pieces",
] as const;

type FetchLike = typeof globalThis.fetch;
type JsonRecord = Record<string, unknown>;

export interface WalmartListingIntegrityListingQualityCredentials {
  client_id: string;
  client_secret: string;
  seller_id: string;
}

export interface WalmartListingIntegrityListingQualityReceipt {
  schema_version:
    typeof WALMART_LISTING_INTEGRITY_LISTING_QUALITY_RECEIPT_SCHEMA;
  captured_at: string;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
  };
  seller_account_fingerprint: string;
  request: {
    method: "POST";
    path: "/v3/insights/items/listingQuality/items";
    query: { limit: 200 };
    body_sha256: string;
    correlation_id: string;
  };
  response: {
    http_status: 200;
    body_sha256: string;
    bytes: number;
  };
  external_effects: {
    oauth_token_calls: 1;
    listing_quality_read_calls: 1;
    retries: 0;
    redirects: 0;
    model_calls: 0;
    database_writes: 0;
    walmart_content_writes: 0;
  };
  body_sha256: string;
}

export interface WalmartListingIntegrityTerminalFailureDisposition {
  schema_version:
    typeof WALMART_LISTING_INTEGRITY_FAILURE_DISPOSITION_SCHEMA;
  disposition_id: string;
  created_at: string;
  status: "QUARANTINED_UNRESOLVED";
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  accepted_feed: {
    feed_id: string;
    terminal_at: string;
    request_payload_sha256: string;
    feed_status_payload_sha256: string;
    walmart_item_result: "SUCCESS";
  };
  failed_qualification: {
    qualification_id: string;
    qualified_at: string;
    qualification_body_sha256: string;
    operator_receipt_body_sha256: string;
    operator_receipt_file_sha256: string;
    propagation_window_complete: true;
    published_and_indexed_preserved: true;
    automatic_reapply_allowed: false;
  };
  listing_quality_evidence: {
    receipt_body_sha256: string;
    response_body_sha256: string;
    updated_timestamp: string;
    content_score: number;
    target_fields_reported_not_editable:
      Array<(typeof REQUIRED_ATTRIBUTE_FIELDS)[number]>;
    current_values: Record<(typeof REQUIRED_ATTRIBUTE_FIELDS)[number], string>;
  };
  classification: {
    outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET";
    likely_platform_cause: "CATALOG_CONTENT_PRIORITY_OR_OWNERSHIP";
    cause_proof_level: "LIKELY_NOT_PROVEN";
    same_payload_reapply_allowed: false;
    listing_repair_complete: false;
  };
  sequence: {
    next_listing_unblocked: true;
    quarantined_listing_excluded_from_active_pool: true;
    max_apply_in_flight: 1;
  };
  next_action: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN";
  marketplace_write_authorized: false;
  body_sha256: string;
}

export class WalmartListingIntegrityTerminalFailureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalmartListingIntegrityTerminalFailureError";
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingIntegrityTerminalFailureError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_EVIDENCE", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 8_192): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_EVIDENCE", `${label} must be bounded exact text`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) {
    fail("INVALID_EVIDENCE", `${label} must be lowercase SHA-256`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_EVIDENCE", `${label} must be a positive integer`);
  }
  return Number(value);
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) {
    fail("INVALID_EVIDENCE", `${label} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sealedRecord(value: unknown, label: string): JsonRecord {
  const parsed = record(value, label);
  const claimed = digest(parsed.body_sha256, `${label}.body_sha256`);
  const body = { ...parsed };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) {
    fail("SEAL_MISMATCH", `${label} body seal differs`);
  }
  return parsed;
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      label,
    );
  } catch (error) {
    if (error instanceof WalmartListingIntegrityTerminalFailureError) throw error;
    return fail("INVALID_EVIDENCE", `${label} must be UTF-8 JSON`);
  }
}

function walmartHeaders(token: string, correlationId: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "wm_sec.access_token": token,
    "wm_qos.correlation_id": correlationId,
    "wm_svc.name": "Walmart Marketplace",
    "wm_global_version": "3.1",
    "wm_market": "us",
    accept: "application/json",
  };
}

async function oneAttempt(input: {
  fetch_impl: FetchLike;
  url: string;
  init: RequestInit;
  timeout_ms: number;
  maximum_response_bytes: number;
  label: string;
}): Promise<{ response: Response; bytes: Buffer }> {
  let response: Response;
  try {
    response = await input.fetch_impl(input.url, {
      ...input.init,
      redirect: "error",
      signal: AbortSignal.timeout(input.timeout_ms),
    });
  } catch {
    return fail(
      "NETWORK_OUTCOME_UNKNOWN",
      `${input.label} failed after its only attempt; automatic retry is forbidden`,
    );
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/u.test(rawLength)
    || Number(rawLength) > input.maximum_response_bytes)) {
    fail("RESPONSE_TOO_LARGE", `${input.label} Content-Length is invalid`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > input.maximum_response_bytes
    || (rawLength !== null && Number(rawLength) !== bytes.byteLength)) {
    fail("INVALID_RESPONSE", `${input.label} response bytes are invalid`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    fail("INVALID_RESPONSE", `${input.label} must be application/json`);
  }
  return { response, bytes };
}

export async function captureWalmartListingQualityEvidence(input: {
  store_index: number;
  sku: string;
  credentials: WalmartListingIntegrityListingQualityCredentials;
  fetch_impl?: FetchLike;
  now?: () => Date;
  random_uuid?: () => string;
  timeout_ms?: number;
}): Promise<{
  receipt: WalmartListingIntegrityListingQualityReceipt;
  response_bytes: Buffer;
}> {
  const storeIndex = positiveInteger(input.store_index, "store_index");
  const sku = text(input.sku, "sku", 512);
  const credentials = {
    client_id: text(input.credentials.client_id, "client_id", 512),
    client_secret: text(input.credentials.client_secret, "client_secret", 2_048),
    seller_id: text(input.credentials.seller_id, "seller_id", 512),
  };
  const fetchImpl = input.fetch_impl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("MISSING_FETCH", "native fetch is unavailable");
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || timeoutMs > DEFAULT_TIMEOUT_MS) {
    fail("INVALID_INPUT", "timeout_ms must be 1..30000");
  }
  const uuid = input.random_uuid ?? randomUUID;
  const now = input.now ?? (() => new Date());
  const basic = Buffer.from(
    `${credentials.client_id}:${credentials.client_secret}`,
    "utf8",
  ).toString("base64");
  const tokenExchange = await oneAttempt({
    fetch_impl: fetchImpl,
    url: `${WALMART_ORIGIN}/v3/token`,
    init: {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "wm_qos.correlation_id": text(uuid(), "OAuth correlation id", 256),
        "wm_svc.name": "Walmart Marketplace",
      },
      body: "grant_type=client_credentials",
    },
    timeout_ms: timeoutMs,
    maximum_response_bytes: MAX_TOKEN_BYTES,
    label: "OAuth token",
  });
  if (tokenExchange.response.status !== 200) {
    fail("OAUTH_HTTP_ERROR", `OAuth returned HTTP ${tokenExchange.response.status}`);
  }
  const token = text(
    parseJson(tokenExchange.bytes, "OAuth response").access_token,
    "OAuth access_token",
  );
  const correlationId = text(uuid(), "listing quality correlation id", 256);
  const requestBody = Buffer.from(
    JSON.stringify({ query: { field: "sku", value: sku } }),
    "utf8",
  );
  const response = await oneAttempt({
    fetch_impl: fetchImpl,
    url: `${WALMART_ORIGIN}/v3/insights/items/listingQuality/items?limit=200`,
    init: {
      method: "POST",
      headers: {
        ...walmartHeaders(token, correlationId),
        "content-type": "application/json",
      },
      body: requestBody,
    },
    timeout_ms: timeoutMs,
    maximum_response_bytes: MAX_LISTING_QUALITY_BYTES,
    label: "Listing Quality read",
  });
  if (response.response.status !== 200) {
    fail(
      "LISTING_QUALITY_HTTP_ERROR",
      `Listing Quality read returned HTTP ${response.response.status}`,
    );
  }
  parseJson(response.bytes, "Listing Quality response");
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_LISTING_QUALITY_RECEIPT_SCHEMA,
    captured_at: now().toISOString(),
    listing: {
      channel: "WALMART_US" as const,
      store_index: storeIndex,
      sku,
    },
    seller_account_fingerprint: computeWalmartSellerAccountFingerprint({
      store_index: storeIndex,
      client_id: credentials.client_id,
      seller_id: credentials.seller_id,
    }),
    request: {
      method: "POST" as const,
      path: "/v3/insights/items/listingQuality/items" as const,
      query: { limit: 200 as const },
      body_sha256: sha256(requestBody),
      correlation_id: correlationId,
    },
    response: {
      http_status: 200 as const,
      body_sha256: sha256(response.bytes),
      bytes: response.bytes.byteLength,
    },
    external_effects: {
      oauth_token_calls: 1 as const,
      listing_quality_read_calls: 1 as const,
      retries: 0 as const,
      redirects: 0 as const,
      model_calls: 0 as const,
      database_writes: 0 as const,
      walmart_content_writes: 0 as const,
    },
  };
  return {
    receipt: Object.freeze({
      ...body,
      body_sha256: walmartListingIntegritySha256(body),
    }),
    response_bytes: response.bytes,
  };
}

export function buildWalmartListingIntegrityTerminalFailureDisposition(input: {
  operator_receipt: unknown;
  operator_receipt_file_sha256: string;
  listing_quality_receipt: unknown;
  listing_quality_response_bytes: Uint8Array;
  created_at: string;
}): WalmartListingIntegrityTerminalFailureDisposition {
  const operator = sealedRecord(input.operator_receipt, "operator receipt");
  if (operator.schema_version !== "walmart-listing-repair-operator-receipt/v1"
    || operator.command !== "qualify" || operator.status !== "FAIL"
    || operator.marketplace_write_authorized !== false
    || operator.automatic_reapply_allowed !== false) {
    fail("NOT_TERMINAL_FAILURE", "operator receipt is not a terminal no-reapply FAIL");
  }
  const qualification = sealedRecord(operator.qualification, "live Qualification");
  if (qualification.schema_version
      !== "walmart-listing-integrity-repair-live-qualification/v2"
    || qualification.verdict !== "FAIL"
    || qualification.next_action !== "OWNER_REVIEW_REPLAN"
    || qualification.next_sku_unblocked !== false
    || qualification.marketplace_write_authorized !== false
    || qualification.automatic_reapply_allowed !== false) {
    fail("NOT_TERMINAL_FAILURE", "live Qualification is not the expected terminal FAIL");
  }
  const facets = record(qualification.facets, "Qualification facets");
  const propagation = record(qualification.propagation, "Qualification propagation");
  if (facets.published_and_indexed !== "PASS"
    || facets.attributes !== "FAIL"
    || facets.exact_repair_target !== "FAIL"
    || propagation.reread_before_failure_window !== false
    || propagation.recheck_same_sku_without_write !== false) {
    fail(
      "FAILURE_NOT_CLASSIFIABLE",
      "failure is not a post-SLA attribute publication failure",
    );
  }
  const listing = record(qualification.listing, "Qualification listing");
  const storeIndex = positiveInteger(listing.store_index, "listing.store_index");
  const sku = text(listing.sku, "listing.sku", 512);
  const itemId = text(listing.item_id, "listing.item_id", 128);
  const listingKey = text(listing.listing_key, "listing.listing_key", 768);
  const operatorListing = record(operator.listing, "operator listing");
  if (operatorListing.store_index !== storeIndex || operatorListing.sku !== sku
    || operatorListing.item_id !== itemId
    || operatorListing.listing_key !== listingKey) {
    fail("IDENTITY_MISMATCH", "operator and Qualification listing identities differ");
  }

  const qualityReceipt = sealedRecord(
    input.listing_quality_receipt,
    "Listing Quality receipt",
  );
  if (qualityReceipt.schema_version
      !== WALMART_LISTING_INTEGRITY_LISTING_QUALITY_RECEIPT_SCHEMA) {
    fail("INVALID_EVIDENCE", "Listing Quality receipt schema differs");
  }
  const qualityListing = record(qualityReceipt.listing, "Listing Quality listing");
  const qualityResponse = record(qualityReceipt.response, "Listing Quality response receipt");
  if (qualityListing.store_index !== storeIndex || qualityListing.sku !== sku
    || qualityResponse.http_status !== 200
    || qualityResponse.body_sha256 !== sha256(input.listing_quality_response_bytes)
    || qualityResponse.bytes !== input.listing_quality_response_bytes.byteLength) {
    fail("IDENTITY_MISMATCH", "Listing Quality evidence is not bound to this listing");
  }
  const capturedAt = instant(qualityReceipt.captured_at, "Listing Quality captured_at");
  const qualifiedAt = instant(qualification.qualified_at, "Qualification qualified_at");
  const createdAt = instant(input.created_at, "created_at");
  if (Date.parse(capturedAt) < Date.parse(qualifiedAt)
    || Date.parse(createdAt) < Date.parse(capturedAt)
    || Date.parse(createdAt) - Date.parse(capturedAt) > 15 * 60_000) {
    fail("STALE_EVIDENCE", "Listing Quality evidence is not fresh after Qualification");
  }

  const response = parseJson(
    input.listing_quality_response_bytes,
    "Listing Quality response",
  );
  if (response.status !== "OK" || response.totalItems !== 1
    || !Array.isArray(response.payload) || response.payload.length !== 1) {
    fail("IDENTITY_MISMATCH", "Listing Quality response must contain one exact SKU");
  }
  const row = record(response.payload[0], "Listing Quality item");
  if (row.sku !== sku || String(row.itemId) !== itemId || row.isInStock !== true) {
    fail("IDENTITY_MISMATCH", "Listing Quality row differs from the failed listing");
  }
  const scoreDetails = record(row.scoreDetails, "Listing Quality scoreDetails");
  const content = record(
    scoreDetails.contentAndDiscoverability,
    "Listing Quality contentAndDiscoverability",
  );
  if (!Array.isArray(content.issues)) {
    fail("INVALID_EVIDENCE", "Listing Quality content issues must be an array");
  }
  const issues = new Map<string, JsonRecord>();
  for (const raw of content.issues) {
    const issue = record(raw, "Listing Quality content field");
    const name = text(issue.attributeName, "Listing Quality attributeName", 512);
    if (issues.has(name)) fail("INVALID_EVIDENCE", `duplicate Listing Quality field ${name}`);
    issues.set(name, issue);
  }
  const currentValues = {} as Record<
    (typeof REQUIRED_ATTRIBUTE_FIELDS)[number],
    string
  >;
  for (const field of REQUIRED_ATTRIBUTE_FIELDS) {
    const issue = issues.get(field);
    if (!issue || issue.isEditable !== false) {
      fail(
        "FAILURE_NOT_CLASSIFIABLE",
        `Listing Quality does not prove ${field} is reported non-editable`,
      );
    }
    currentValues[field] = String(issue.attributeValue ?? "");
  }
  let contentScore = Number(content.score);
  if (!Number.isFinite(contentScore)) {
    const qualityScoreData = record(
      row.qualityScoreData,
      "Listing Quality qualityScoreData",
    );
    if (!Array.isArray(qualityScoreData.values)) {
      fail("INVALID_EVIDENCE", "Listing Quality score values are invalid");
    }
    const contentScoreRow = qualityScoreData.values.find((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      return String((raw as JsonRecord).scoreType).toLowerCase()
        === "content & discoverability";
    });
    contentScore = Number(
      contentScoreRow && typeof contentScoreRow === "object"
        ? (contentScoreRow as JsonRecord).scoreValue
        : Number.NaN,
    );
  }
  if (!Number.isFinite(contentScore)) {
    fail("INVALID_EVIDENCE", "Listing Quality content score is invalid");
  }
  const receiptBodySha = digest(
    qualityReceipt.body_sha256,
    "Listing Quality receipt body_sha256",
  );
  const qualificationBodySha = digest(
    qualification.body_sha256,
    "Qualification body_sha256",
  );
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_FAILURE_DISPOSITION_SCHEMA,
    created_at: createdAt,
    status: "QUARANTINED_UNRESOLVED" as const,
    listing: {
      channel: "WALMART_US" as const,
      store_index: storeIndex,
      sku,
      listing_key: listingKey,
      item_id: itemId,
    },
    accepted_feed: {
      feed_id: text(qualification.feed_id, "Qualification feed_id", 512),
      terminal_at: instant(qualification.feed_terminal_at, "feed_terminal_at"),
      request_payload_sha256: digest(
        record(qualification.apply_custody, "apply custody").request_payload_sha256,
        "request_payload_sha256",
      ),
      feed_status_payload_sha256: digest(
        record(qualification.apply_custody, "apply custody")
          .terminal_feed_status_payload_sha256,
        "terminal_feed_status_payload_sha256",
      ),
      walmart_item_result: "SUCCESS" as const,
    },
    failed_qualification: {
      qualification_id: text(
        qualification.qualification_id,
        "qualification_id",
        512,
      ),
      qualified_at: qualifiedAt,
      qualification_body_sha256: qualificationBodySha,
      operator_receipt_body_sha256: digest(
        operator.body_sha256,
        "operator receipt body_sha256",
      ),
      operator_receipt_file_sha256: digest(
        input.operator_receipt_file_sha256,
        "operator_receipt_file_sha256",
      ),
      propagation_window_complete: true as const,
      published_and_indexed_preserved: true as const,
      automatic_reapply_allowed: false as const,
    },
    listing_quality_evidence: {
      receipt_body_sha256: receiptBodySha,
      response_body_sha256: digest(
        qualityResponse.body_sha256,
        "Listing Quality response body SHA",
      ),
      updated_timestamp: text(row.updatedTimestamp, "updatedTimestamp", 128),
      content_score: contentScore,
      target_fields_reported_not_editable: [...REQUIRED_ATTRIBUTE_FIELDS],
      current_values: currentValues,
    },
    classification: {
      outcome: "ACCEPTED_FEED_DID_NOT_PUBLISH_EXACT_TARGET" as const,
      likely_platform_cause: "CATALOG_CONTENT_PRIORITY_OR_OWNERSHIP" as const,
      cause_proof_level: "LIKELY_NOT_PROVEN" as const,
      same_payload_reapply_allowed: false as const,
      listing_repair_complete: false as const,
    },
    sequence: {
      next_listing_unblocked: true as const,
      quarantined_listing_excluded_from_active_pool: true as const,
      max_apply_in_flight: 1 as const,
    },
    next_action: "CONTENT_OWNERSHIP_OR_SUPPORT_CASE_THEN_REPLAN" as const,
    marketplace_write_authorized: false as const,
  };
  const dispositionSha = walmartListingIntegritySha256(body);
  return Object.freeze({
    ...body,
    disposition_id: `failure-disposition-${dispositionSha.slice(0, 24)}`,
    body_sha256: walmartListingIntegritySha256({
      ...body,
      disposition_id: `failure-disposition-${dispositionSha.slice(0, 24)}`,
    }),
  });
}

export function verifyWalmartListingIntegrityTerminalFailureDisposition(
  value: WalmartListingIntegrityTerminalFailureDisposition,
): void {
  const body = { ...record(value, "failure disposition") };
  const claimed = digest(body.body_sha256, "failure disposition body_sha256");
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed
    || value.schema_version !== WALMART_LISTING_INTEGRITY_FAILURE_DISPOSITION_SCHEMA
    || value.status !== "QUARANTINED_UNRESOLVED"
    || value.classification.listing_repair_complete !== false
    || value.classification.same_payload_reapply_allowed !== false
    || value.sequence.next_listing_unblocked !== true
    || value.marketplace_write_authorized !== false) {
    fail("SEAL_MISMATCH", "failure disposition is invalid or not fail-closed");
  }
}
