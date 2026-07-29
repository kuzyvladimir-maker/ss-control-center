/**
 * Native non-retrying transport for one exact full-surface operation.
 *
 * One instance owns one mutation slot.  It may reuse its single OAuth token for
 * bounded GET-only readback, but a network exception after mutation dispatch is
 * classified UNKNOWN and never retried.  Construction is side-effect free.
 */

import { createHash, randomUUID } from "node:crypto";

import { computeWalmartSellerAccountFingerprint } from
  "./item-report-capture-session.ts";
import {
  WALMART_LISTING_FULL_SURFACE_CAPABILITIES,
  walmartListingFullSurfaceSha256,
  type WalmartListingFullSurfaceOperation,
} from "./listing-integrity-full-surface.ts";

const WALMART_API_ORIGIN = "https://marketplace.walmartapis.com";
const TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024;
const MUTATION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const READ_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_READBACK_CALLS = 32;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

type FetchLike = typeof globalThis.fetch;

export interface WalmartListingFullSurfaceTransportCredentials {
  client_id: string;
  client_secret: string;
  seller_id: string;
}

export interface WalmartListingFullSurfaceTransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface WalmartListingFullSurfaceTransportCounts {
  oauth_token_calls: number;
  mutation_calls: number;
  readback_get_calls: number;
  semantic_read_post_calls: number;
  total_http_calls: number;
}

export interface WalmartListingFullSurfaceReadRequest {
  path: string;
  query: Readonly<Record<string, string>>;
  correlation_id: string;
  timeout_ms?: number;
  max_response_bytes?: number;
}

export interface WalmartListingFullSurfaceSemanticReadRequest {
  path: "/v3/items/associations" | "/v3/price/getPricingInsights";
  request_payload_bytes: Uint8Array;
  correlation_id: string;
  timeout_ms?: number;
  max_response_bytes?: number;
}

export interface WalmartListingFullSurfaceOneShotTransport {
  readonly account_binding: {
    channel: "WALMART_US";
    store_index: number;
    seller_id: string;
    seller_account_fingerprint_sha256: string;
  };
  mutate(input: {
    operation: WalmartListingFullSurfaceOperation;
    request_payload_bytes: Uint8Array;
    correlation_id: string;
    timeout_ms?: number;
  }): Promise<WalmartListingFullSurfaceTransportResponse>;
  read(input: WalmartListingFullSurfaceReadRequest):
  Promise<WalmartListingFullSurfaceTransportResponse>;
  semanticRead(input: WalmartListingFullSurfaceSemanticReadRequest):
  Promise<WalmartListingFullSurfaceTransportResponse>;
  counts(): WalmartListingFullSurfaceTransportCounts;
}

interface FactoryInput {
  store_index: number;
  credentials: WalmartListingFullSurfaceTransportCredentials;
  fetch_impl: FetchLike;
  random_uuid: () => string;
}

export class WalmartListingFullSurfaceTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalmartListingFullSurfaceTransportError";
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingFullSurfaceTransportError(code, message);
}

function text(value: unknown, label: string, maximum = 2048): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || !SAFE_TEXT.test(value)
  ) {
    fail("INVALID_TRANSPORT_INPUT", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_TRANSPORT_INPUT", `${label} must be a positive integer`);
  }
  return Number(value);
}

function timeout(value: number | undefined): number {
  const parsed = value === undefined ? REQUEST_TIMEOUT_MS : positiveInteger(value, "timeout");
  if (parsed > REQUEST_TIMEOUT_MS) {
    fail("INVALID_TRANSPORT_INPUT", "timeout exceeds the operation cap");
  }
  return parsed;
}

function responseCap(value: number | undefined, maximum: number): number {
  const parsed = value === undefined ? maximum : positiveInteger(value, "response cap");
  if (parsed > maximum) {
    fail("INVALID_TRANSPORT_INPUT", "response cap exceeds the operation cap");
  }
  return parsed;
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const result: Partial<T> = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}

function safePath(value: string): string {
  const path = text(value, "path", 2048);
  if (!path.startsWith("/v3/") || path.includes("?") || path.includes("#")) {
    fail("INVALID_TRANSPORT_INPUT", "path must be an exact /v3 path without query");
  }
  return path;
}

function queryString(value: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(value).sort()) {
    const safeKey = text(key, "query key", 128);
    const safeValue = text(value[key], "query value", 512);
    params.append(safeKey, safeValue);
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

function selectedHeaders(response: Response): Readonly<Record<string, string>> {
  const allowed = new Set([
    "content-encoding",
    "content-length",
    "content-type",
    "retry-after",
    "wm-qos-correlation-id",
    "wm_qos.correlation_id",
  ]);
  const result: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (allowed.has(name.toLowerCase())) result[name.toLowerCase()] = value;
  });
  return Object.freeze(result);
}

async function boundedBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximum)
  ) {
    fail("RESPONSE_SIZE_CAP", "declared response exceeds cap");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) fail("REQUEST_TIMEOUT", "request timed out");
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        fail("RESPONSE_SIZE_CAP", "streamed response exceeds cap");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declared !== null && Number(declared) !== bytes.byteLength) {
    fail("CONTENT_LENGTH_MISMATCH", "declared and captured response sizes differ");
  }
  return bytes;
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function multipart(input: {
  boundary: string;
  filename: string;
  payload: Uint8Array;
}): Uint8Array {
  const prefix = Buffer.from(
    `--${input.boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${input.filename}"\r\n`
      + "Content-Type: application/json\r\n\r\n",
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${input.boundary}--\r\n`, "utf8");
  return Buffer.concat([prefix, Buffer.from(input.payload), suffix]);
}

function nativeTransport(input: FactoryInput):
WalmartListingFullSurfaceOneShotTransport {
  const storeIndex = positiveInteger(input.store_index, "store_index");
  const credentials = Object.freeze({
    client_id: text(input.credentials.client_id, "client_id", 512),
    client_secret: text(input.credentials.client_secret, "client_secret", 4096),
    seller_id: text(input.credentials.seller_id, "seller_id", 512),
  });
  if (typeof input.fetch_impl !== "function") {
    fail("INVALID_TRANSPORT_INPUT", "native fetch is unavailable");
  }
  const accountBinding = Object.freeze({
    channel: "WALMART_US" as const,
    store_index: storeIndex,
    seller_id: credentials.seller_id,
    seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
      store_index: storeIndex,
      client_id: credentials.client_id,
      seller_id: credentials.seller_id,
    }),
  });
  const callCounts = {
    oauth_token_calls: 0,
    mutation_calls: 0,
    readback_get_calls: 0,
    semantic_read_post_calls: 0,
  };
  let tokenPromise: Promise<string> | null = null;
  let mutationSlotConsumed = false;

  const fetchOnce = async (
    url: string,
    init: RequestInit,
    maximumBytes: number,
    signal: AbortSignal,
    unknownMutation: boolean,
  ): Promise<WalmartListingFullSurfaceTransportResponse> => {
    let response: Response;
    try {
      response = await input.fetch_impl(url, {
        ...init,
        redirect: "error",
        signal,
      });
    } catch {
      fail(
        unknownMutation ? "MUTATION_OUTCOME_UNKNOWN" : "READBACK_NETWORK_FAILURE",
        "native Walmart fetch failed and was not retried",
      );
    }
    return Object.freeze({
      status: response.status,
      headers: selectedHeaders(response),
      body: await boundedBytes(response, maximumBytes, signal),
    });
  };

  const accessToken = async (signal: AbortSignal): Promise<string> => {
    if (tokenPromise) return tokenPromise;
    callCounts.oauth_token_calls += 1;
    tokenPromise = (async () => {
      const authorization = Buffer.from(
        `${credentials.client_id}:${credentials.client_secret}`,
        "utf8",
      ).toString("base64");
      const response = await fetchOnce(
        `${WALMART_API_ORIGIN}/v3/token`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            authorization: `Basic ${authorization}`,
            "content-type": "application/x-www-form-urlencoded",
            "wm_qos.correlation_id": text(input.random_uuid(), "OAuth correlation"),
            "wm_svc.name": "Walmart Marketplace",
          },
          body: "grant_type=client_credentials",
        },
        TOKEN_RESPONSE_MAX_BYTES,
        signal,
        false,
      );
      if (response.status !== 200) {
        fail("OAUTH_HTTP_FAILURE", `OAuth returned HTTP ${response.status}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
      } catch {
        fail("OAUTH_INVALID_RESPONSE", "OAuth response is not UTF-8 JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("OAUTH_INVALID_RESPONSE", "OAuth response is not an object");
      }
      return text(
        (parsed as Record<string, unknown>).access_token,
        "access_token",
        8192,
      );
    })();
    return tokenPromise;
  };

  const apiHeaders = (
    tokenValue: string,
    correlationId: string,
  ): Record<string, string> => ({
    accept: "application/json",
    "accept-encoding": "identity",
    authorization: `Bearer ${tokenValue}`,
    "wm_qos.correlation_id": text(correlationId, "correlation_id", 256),
    "wm_sec.access_token": tokenValue,
    "wm_svc.name": "Walmart Marketplace",
  });

  const transport: WalmartListingFullSurfaceOneShotTransport = {
    account_binding: accountBinding,
    mutate: async ({
      operation,
      request_payload_bytes: requestPayloadBytes,
      correlation_id: correlationId,
      timeout_ms: timeoutMs,
    }) => {
      if (mutationSlotConsumed) {
        fail("MUTATION_SLOT_CONSUMED", "this transport cannot send another mutation");
      }
      mutationSlotConsumed = true;
      callCounts.mutation_calls += 1;
      const operationBody = withoutKey(operation, "body_sha256");
      if (walmartListingFullSurfaceSha256(operationBody) !== operation.body_sha256) {
        fail("OPERATION_HASH_MISMATCH", "operation bytes are not sealed");
      }
      const capability = WALMART_LISTING_FULL_SURFACE_CAPABILITIES[
        operation.operation_kind
      ];
      if (
        !capability
        || capability.method !== operation.exact_request.method
        || bytesSha256(requestPayloadBytes)
          !== operation.exact_request.request_payload_sha256
        || requestPayloadBytes.byteLength
          !== operation.exact_request.request_byte_length
      ) {
        fail("OPERATION_REQUEST_MISMATCH", "exact operation request binding failed");
      }
      return withTimeout(timeout(timeoutMs), async (signal) => {
        const tokenValue = await accessToken(signal);
        const headers = apiHeaders(tokenValue, correlationId);
        let body: Uint8Array | undefined;
        if (operation.exact_request.content_type === "multipart/form-data") {
          const boundary = `ss-${operation.exact_request.request_payload_sha256.slice(0, 32)}`;
          body = multipart({
            boundary,
            filename: `${operation.operation_id}.json`,
            payload: requestPayloadBytes,
          });
          headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
        } else if (operation.exact_request.content_type === "application/json") {
          body = requestPayloadBytes;
          headers["content-type"] = "application/json";
        } else if (requestPayloadBytes.byteLength !== 0) {
          fail("OPERATION_REQUEST_MISMATCH", "body forbidden for this operation");
        }
        return fetchOnce(
          `${WALMART_API_ORIGIN}${safePath(operation.exact_request.path)}`
            + queryString(operation.exact_request.query),
          {
            method: operation.exact_request.method,
            headers,
            body: body === undefined
              ? undefined
              : Buffer.from(body) as unknown as BodyInit,
          },
          MUTATION_RESPONSE_MAX_BYTES,
          signal,
          true,
        );
      });
    },
    read: async ({
      path,
      query,
      correlation_id: correlationId,
      timeout_ms: timeoutMs,
      max_response_bytes: maximumBytes,
    }) => {
      if (callCounts.readback_get_calls >= MAX_READBACK_CALLS) {
        fail("READBACK_CALL_CAP", "readback GET cap reached");
      }
      callCounts.readback_get_calls += 1;
      return withTimeout(timeout(timeoutMs), async (signal) => {
        const tokenValue = await accessToken(signal);
        return fetchOnce(
          `${WALMART_API_ORIGIN}${safePath(path)}${queryString(query)}`,
          {
            method: "GET",
            headers: apiHeaders(tokenValue, correlationId),
          },
          responseCap(maximumBytes, READ_RESPONSE_MAX_BYTES),
          signal,
          false,
        );
      });
    },
    semanticRead: async ({
      path: requestPath,
      request_payload_bytes: requestPayloadBytes,
      correlation_id: correlationId,
      timeout_ms: timeoutMs,
      max_response_bytes: maximumBytes,
    }) => {
      if (
        requestPath !== "/v3/items/associations"
        && requestPath !== "/v3/price/getPricingInsights"
      ) {
        fail("INVALID_TRANSPORT_INPUT", "semantic POST read path is not allowlisted");
      }
      if (
        !(requestPayloadBytes instanceof Uint8Array)
        || requestPayloadBytes.byteLength < 2
        || requestPayloadBytes.byteLength > 1024 * 1024
      ) {
        fail("INVALID_TRANSPORT_INPUT", "semantic POST read payload is invalid");
      }
      if (callCounts.semantic_read_post_calls >= MAX_READBACK_CALLS) {
        fail("READBACK_CALL_CAP", "semantic POST read cap reached");
      }
      callCounts.semantic_read_post_calls += 1;
      return withTimeout(timeout(timeoutMs), async (signal) => {
        const tokenValue = await accessToken(signal);
        return fetchOnce(
          `${WALMART_API_ORIGIN}${requestPath}`,
          {
            method: "POST",
            headers: {
              ...apiHeaders(tokenValue, correlationId),
              "content-type": "application/json",
            },
            body: Buffer.from(requestPayloadBytes) as unknown as BodyInit,
          },
          responseCap(maximumBytes, READ_RESPONSE_MAX_BYTES),
          signal,
          false,
        );
      });
    },
    counts: () => Object.freeze({
      ...callCounts,
      total_http_calls: callCounts.oauth_token_calls
        + callCounts.mutation_calls + callCounts.readback_get_calls
        + callCounts.semantic_read_post_calls,
    }),
  };
  return Object.freeze(transport);
}

export function createWalmartListingFullSurfaceTransport(input: {
  store_index: number;
  credentials: WalmartListingFullSurfaceTransportCredentials;
}): WalmartListingFullSurfaceOneShotTransport {
  if (typeof globalThis.fetch !== "function") {
    fail("INVALID_TRANSPORT_INPUT", "native fetch is unavailable");
  }
  return nativeTransport({
    ...input,
    fetch_impl: globalThis.fetch.bind(globalThis),
    random_uuid: randomUUID,
  });
}

export function createWalmartListingFullSurfaceTransportForTest(
  input: FactoryInput,
): WalmartListingFullSurfaceOneShotTransport {
  return nativeTransport(input);
}
