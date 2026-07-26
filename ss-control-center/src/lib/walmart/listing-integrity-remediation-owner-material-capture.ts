/**
 * Fresh read-only connected materials for one owner-reviewed Walmart repair.
 *
 * The capture performs exactly three non-retrying HTTP attempts:
 * one OAuth token request, one exact seller-item GET, and one Get Spec POST.
 * Get Spec is a schema read; this module has no feed/content write route.
 */

import { createHash, randomUUID } from "node:crypto";

import { computeWalmartSellerAccountFingerprint } from
  "./item-report-capture-session.ts";
import type {
  WalmartListingRepairConsumptionLedgerBinding,
} from "./listing-integrity-remediation-authority.ts";
import type {
  WalmartListingRepairOwnerCompilerMaterials,
} from "./listing-integrity-remediation-owner-compiler.ts";
import {
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
  canonicalWalmartListingSurgicalJson,
  walmartListingSurgicalSha256,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
} from "./listing-integrity-remediation-payload.ts";

const WALMART_ORIGIN = "https://marketplace.walmartapis.com";
const MAX_TOKEN_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = typeof globalThis.fetch;
type JsonRecord = Record<string, unknown>;

export interface WalmartListingRepairMaterialCaptureCredentials {
  client_id: string;
  client_secret: string;
  seller_id: string;
}

export interface WalmartListingRepairMaterialCaptureResult {
  materials: WalmartListingRepairOwnerCompilerMaterials;
  product_type: string;
  call_counts: {
    oauth_token_calls: 1;
    exact_item_get_calls: 1;
    get_spec_post_calls: 1;
    total_http_calls: 3;
    retries: 0;
    redirects: 0;
    walmart_content_writes: 0;
  };
}

export class WalmartListingRepairMaterialCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalmartListingRepairMaterialCaptureError";
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairMaterialCaptureError(code, message);
}

function text(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail("INVALID_INPUT", `${label} must be lowercase SHA-256`);
  }
  return parsed;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RESPONSE", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalWalmartListingSurgicalJson(value), "utf8");
}

async function boundedResponse(
  response: Response,
  maximum: number,
  label: string,
): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/u.test(rawLength)
    || Number(rawLength) > maximum)) {
    fail("RESPONSE_TOO_LARGE", `${label} Content-Length exceeds the bound`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > maximum) {
    fail("INVALID_RESPONSE", `${label} is empty or exceeds the bound`);
  }
  if (rawLength !== null && Number(rawLength) !== bytes.byteLength) {
    fail("CONTENT_LENGTH_MISMATCH", `${label} Content-Length differs from bytes`);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      label,
    );
  } catch (error) {
    if (error instanceof WalmartListingRepairMaterialCaptureError) throw error;
    return fail("INVALID_RESPONSE", `${label} is not UTF-8 JSON`);
  }
}

function itemRow(value: JsonRecord): JsonRecord {
  if (!Array.isArray(value.ItemResponse) || value.ItemResponse.length !== 1) {
    fail("IDENTITY_NOT_EXACT", "exact item GET must contain one ItemResponse row");
  }
  return record(value.ItemResponse[0], "exact item ItemResponse[0]");
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
      `${input.label} failed after one attempt and must not be retried automatically`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    fail("INVALID_CONTENT_TYPE", `${input.label} is not application/json`);
  }
  return {
    response,
    bytes: await boundedResponse(
      response,
      input.maximum_response_bytes,
      input.label,
    ),
  };
}

export async function captureWalmartListingRepairOwnerMaterials(input: {
  store_index: number;
  sku: string;
  credentials: WalmartListingRepairMaterialCaptureCredentials;
  capture_authority_public_key_spki_sha256: string;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
  ledger_state_directory: string;
  artifact_custody_root: string;
  fetch_impl?: FetchLike;
  now?: () => Date;
  random_uuid?: () => string;
  timeout_ms?: number;
}): Promise<WalmartListingRepairMaterialCaptureResult> {
  const storeIndex = positiveInteger(input.store_index, "store_index");
  const sku = text(input.sku, "sku", 512);
  const credentials = {
    client_id: text(input.credentials.client_id, "client_id", 512),
    client_secret: text(input.credentials.client_secret, "client_secret", 2_048),
    seller_id: text(input.credentials.seller_id, "seller_id", 512),
  };
  const captureKey = digest(
    input.capture_authority_public_key_spki_sha256,
    "capture_authority_public_key_spki_sha256",
  );
  const fetchImpl = input.fetch_impl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("MISSING_FETCH", "native fetch is unavailable");
  }
  const now = input.now ?? (() => new Date());
  const uuid = input.random_uuid ?? randomUUID;
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || timeoutMs > DEFAULT_TIMEOUT_MS) {
    fail("INVALID_INPUT", "timeout_ms must be 1..30000");
  }
  const sellerFingerprint = computeWalmartSellerAccountFingerprint({
    store_index: storeIndex,
    client_id: credentials.client_id,
    seller_id: credentials.seller_id,
  });

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
    label: "OAuth token response",
  });
  if (tokenExchange.response.status !== 200) {
    fail("OAUTH_HTTP_ERROR", `OAuth token returned HTTP ${tokenExchange.response.status}`);
  }
  const tokenResponse = parseJson(tokenExchange.bytes, "OAuth token response");
  const token = text(tokenResponse.access_token, "OAuth access_token", 8_192);

  const itemCorrelation = text(uuid(), "item correlation id", 256);
  const itemExchange = await oneAttempt({
    fetch_impl: fetchImpl,
    url: `${WALMART_ORIGIN}/v3/items/${encodeURIComponent(sku)}`,
    init: {
      method: "GET",
      headers: walmartHeaders(token, itemCorrelation),
    },
    timeout_ms: timeoutMs,
    maximum_response_bytes: MAX_JSON_BYTES,
    label: "exact item response",
  });
  if (itemExchange.response.status !== 200) {
    fail(
      "ITEM_HTTP_ERROR",
      `exact item GET returned HTTP ${itemExchange.response.status}`,
    );
  }
  const itemResponse = parseJson(itemExchange.bytes, "exact item response");
  const row = itemRow(itemResponse);
  if (text(row.sku, "live item sku", 512) !== sku
    || row.publishedStatus !== "PUBLISHED"
    || row.lifecycleStatus !== "ACTIVE") {
    fail("IDENTITY_NOT_EXACT", "exact item is not the requested PUBLISHED/ACTIVE SKU");
  }
  const productType = text(row.productType, "live item productType", 512);
  const itemCapturedAt = now().toISOString();

  const getSpecRequest = {
    feedType: "MP_MAINTENANCE",
    version: WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
    productTypes: [productType],
  };
  const getSpecRequestBytes = canonicalBytes(getSpecRequest);
  const specCorrelation = text(uuid(), "Get Spec correlation id", 256);
  const specExchange = await oneAttempt({
    fetch_impl: fetchImpl,
    url: `${WALMART_ORIGIN}/v3/items/spec`,
    init: {
      method: "POST",
      headers: {
        ...walmartHeaders(token, specCorrelation),
        "content-type": "application/json",
      },
      body: getSpecRequestBytes,
    },
    timeout_ms: timeoutMs,
    maximum_response_bytes: MAX_JSON_BYTES,
    label: "Get Spec response",
  });
  if (specExchange.response.status !== 200) {
    fail(
      "GET_SPEC_HTTP_ERROR",
      `Get Spec returned HTTP ${specExchange.response.status}`,
    );
  }
  parseJson(specExchange.bytes, "Get Spec response");
  const specFetchedAt = now().toISOString();

  const liveReceiptBody = {
    schema_version: WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
    method: "GET" as const,
    path: `/v3/items/${encodeURIComponent(sku)}`,
    response_content_type: "application/json" as const,
    http_status: 200 as const,
    correlation_id_sha256: sha256(itemCorrelation),
    seller_account_fingerprint_sha256: sellerFingerprint,
    response_payload_sha256: sha256(itemExchange.bytes),
    captured_at: itemCapturedAt,
  };
  const liveItemReceipt: WalmartListingSurgicalLiveItemReceipt = {
    ...liveReceiptBody,
    body_sha256: walmartListingSurgicalSha256(liveReceiptBody),
  };
  const getSpecReceiptBody = {
    schema_version: WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
    method: "POST" as const,
    path: "/v3/items/spec" as const,
    request_content_type: "application/json" as const,
    response_content_type: "application/json" as const,
    http_status: 200 as const,
    correlation_id_sha256: sha256(specCorrelation),
    seller_account_fingerprint_sha256: sellerFingerprint,
    request_payload_sha256: sha256(getSpecRequestBytes),
    response_payload_sha256: sha256(specExchange.bytes),
    fetched_at: specFetchedAt,
  };
  const getSpecReceipt: WalmartListingSurgicalGetSpecReceipt = {
    ...getSpecReceiptBody,
    body_sha256: walmartListingSurgicalSha256(getSpecReceiptBody),
  };

  return {
    materials: {
      seller_account_fingerprint_sha256: sellerFingerprint,
      capture_authority_public_key_spki_sha256: captureKey,
      get_spec_receipt: getSpecReceipt,
      live_item_receipt: liveItemReceipt,
      get_spec_request_bytes: getSpecRequestBytes,
      get_spec_response_bytes: specExchange.bytes,
      live_item_response_bytes: itemExchange.bytes,
      consumption_ledger: structuredClone(input.consumption_ledger),
      ledger_state_directory: text(
        input.ledger_state_directory,
        "ledger_state_directory",
      ),
      artifact_custody_root: text(
        input.artifact_custody_root,
        "artifact_custody_root",
      ),
    },
    product_type: productType,
    call_counts: {
      oauth_token_calls: 1,
      exact_item_get_calls: 1,
      get_spec_post_calls: 1,
      total_http_calls: 3,
      retries: 0,
      redirects: 0,
      walmart_content_writes: 0,
    },
  };
}
