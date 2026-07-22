/**
 * Native, non-retrying Walmart transport for one-SKU Listing Integrity repair.
 *
 * This module deliberately does not use WalmartClient: that client owns token
 * caching, refresh and retry behaviour that is forbidden at the irreversible
 * repair boundary. Construction is side-effect free. A transport instance can
 * obtain one OAuth token, submit at most one MP_MAINTENANCE feed, and perform a
 * bounded number of exact feed-status GETs. Every HTTP attempt is counted before
 * native fetch is invoked and is never retried or redirected.
 */

import { randomUUID } from "node:crypto";

import { computeWalmartSellerAccountFingerprint } from "./item-report-capture-session.ts";
import {
  WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
  WALMART_LISTING_REPAIR_MAX_POLL_ATTEMPTS,
  WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES,
  WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  WALMART_LISTING_REPAIR_REQUEST_TIMEOUT_MS,
  type WalmartListingRepairOneShotTransport,
  type WalmartListingRepairTransportCounts,
  type WalmartListingRepairTransportResponse,
} from "./listing-integrity-remediation-writer.ts";

const WALMART_API_ORIGIN = "https://marketplace.walmartapis.com";
const TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/u;
const CAPTURED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-type",
  "retry-after",
  "wm-qos-correlation-id",
  "wm-report-request-id",
  "wm_qos.correlation_id",
  "wm_qos.report_request_id",
]);

type FetchLike = typeof globalThis.fetch;

interface WalmartListingRepairNativeTransportCredentials {
  client_id: string;
  client_secret: string;
  seller_id: string;
}

interface WalmartListingRepairNativeTransportFactoryInput {
  store_index: number;
  credentials: WalmartListingRepairNativeTransportCredentials;
  fetch_impl: FetchLike;
  random_uuid: () => string;
}

export class WalmartListingRepairNativeTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalmartListingRepairNativeTransportError";
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairNativeTransportError(code, message);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_TRANSPORT_CONFIG", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function exactText(value: unknown, label: string, maximum = 1024): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value !== value.trim() || !SAFE_TEXT.test(value)) {
    fail("INVALID_TRANSPORT_CONFIG", `${label} is invalid`);
  }
  return value;
}

function exactTimeout(value: unknown): number {
  const parsed = positiveInteger(value, "timeout_ms");
  if (parsed > WALMART_LISTING_REPAIR_REQUEST_TIMEOUT_MS) {
    fail("INVALID_TRANSPORT_REQUEST", "timeout_ms exceeds the frozen transport cap");
  }
  return parsed;
}

function exactResponseCap(value: unknown, maximum: number): number {
  const parsed = positiveInteger(value, "max_response_bytes");
  if (parsed > maximum) {
    fail("INVALID_TRANSPORT_REQUEST", "max_response_bytes exceeds the frozen operation cap");
  }
  return parsed;
}

function exactCorrelationId(value: unknown): string {
  return exactText(value, "correlation_id", 256);
}

function exactCredentials(
  value: WalmartListingRepairNativeTransportCredentials,
): WalmartListingRepairNativeTransportCredentials {
  return Object.freeze({
    client_id: exactText(value.client_id, "Walmart client ID", 512),
    client_secret: exactText(value.client_secret, "Walmart client secret", 2048),
    seller_id: exactText(value.seller_id, "Walmart seller ID", 512),
  });
}

function counts(value: {
  oauth_token_calls: number;
  maintenance_post_calls: number;
  feed_status_get_calls: number;
}): WalmartListingRepairTransportCounts {
  return Object.freeze({
    ...value,
    total_http_calls: value.oauth_token_calls
      + value.maintenance_post_calls + value.feed_status_get_calls,
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new WalmartListingRepairNativeTransportError(
      "REQUEST_TIMEOUT",
      "Walmart request exceeded the frozen timeout",
    ));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new WalmartListingRepairNativeTransportError(
      "REQUEST_TIMEOUT",
      "Walmart request exceeded the frozen timeout",
    ));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await abortable(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null
    && (!/^(?:0|[1-9]\d*)$/u.test(rawLength) || Number(rawLength) > maximumBytes)) {
    fail("RESPONSE_SIZE_CAP", "HTTP Content-Length exceeds the frozen response cap");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail("RESPONSE_SIZE_CAP", "streamed HTTP response exceeds the frozen response cap");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (rawLength !== null && Number(rawLength) !== result.byteLength) {
    fail("CONTENT_LENGTH_MISMATCH", "HTTP Content-Length differs from captured bytes");
  }
  return result;
}

function responseHeaders(response: Response): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (CAPTURED_RESPONSE_HEADERS.has(normalized)) selected[normalized] = value;
  });
  return Object.freeze(selected);
}

function deterministicMultipartBody(input: {
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

function nativeTransport(
  input: WalmartListingRepairNativeTransportFactoryInput,
): WalmartListingRepairOneShotTransport {
  const storeIndex = positiveInteger(input.store_index, "store_index");
  const credentials = exactCredentials(input.credentials);
  if (typeof input.fetch_impl !== "function") {
    fail("MISSING_NATIVE_FETCH", "native fetch is unavailable");
  }
  if (typeof input.random_uuid !== "function") {
    fail("INVALID_TRANSPORT_CONFIG", "random UUID source is unavailable");
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
    maintenance_post_calls: 0,
    feed_status_get_calls: 0,
  };
  let tokenPromise: Promise<string> | null = null;
  let postSlotConsumed = false;

  const fetchOnce = async (
    url: string,
    init: RequestInit,
    responseCap: number,
    signal: AbortSignal,
    networkCode: string,
  ): Promise<WalmartListingRepairTransportResponse> => {
    let response: Response;
    try {
      response = await abortable(input.fetch_impl(url, { ...init, signal }), signal);
    } catch (error) {
      if (error instanceof WalmartListingRepairNativeTransportError) throw error;
      fail(networkCode, "native Walmart fetch failed; the request was not retried");
    }
    const body = await readBoundedResponseBytes(response, responseCap, signal);
    return { status: response.status, headers: responseHeaders(response), body };
  };

  const accessToken = (signal: AbortSignal): Promise<string> => {
    if (tokenPromise) return tokenPromise;
    callCounts.oauth_token_calls += 1;
    tokenPromise = (async () => {
      const basic = Buffer.from(
        `${credentials.client_id}:${credentials.client_secret}`,
        "utf8",
      ).toString("base64");
      const response = await fetchOnce(
        `${WALMART_API_ORIGIN}/v3/token`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded",
            "wm_qos.correlation_id": exactText(input.random_uuid(), "OAuth correlation ID", 256),
            "wm_svc.name": "Walmart Marketplace",
          },
          body: "grant_type=client_credentials",
        },
        TOKEN_RESPONSE_MAX_BYTES,
        signal,
        "OAUTH_NETWORK_FAILURE",
      );
      if (response.status !== 200) {
        fail("OAUTH_HTTP_FAILURE", `Walmart OAuth returned HTTP ${response.status}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
      } catch {
        fail("OAUTH_INVALID_RESPONSE", "Walmart OAuth response is not valid UTF-8 JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("OAUTH_INVALID_RESPONSE", "Walmart OAuth response is not an object");
      }
      return exactText((parsed as Record<string, unknown>).access_token, "Walmart access token", 8192);
    })();
    return tokenPromise;
  };

  const apiHeaders = (token: string, correlationId: string): Record<string, string> => ({
    accept: "application/json",
    "accept-encoding": "identity",
    authorization: `Bearer ${token}`,
    "wm_qos.correlation_id": correlationId,
    "wm_sec.access_token": token,
    "wm_svc.name": "Walmart Marketplace",
  });

  const transport: WalmartListingRepairOneShotTransport = {
    getAccountBinding() {
      return { ...accountBinding };
    },
    getCallCounts() {
      return counts(callCounts);
    },
    async postMaintenance(request) {
      if (postSlotConsumed) {
        fail("SECOND_POST_FORBIDDEN", "this transport has already consumed its only POST slot");
      }
      postSlotConsumed = true;
      if (request.path !== "/v3/feeds"
        || request.query.feedType !== "MP_MAINTENANCE"
        || request.content_type !== "application/json"
        || request.redirect !== "error" || request.retries !== 0) {
        fail("INVALID_TRANSPORT_REQUEST", "maintenance request differs from the frozen operation");
      }
      const payload = request.request_payload_bytes;
      if (!(payload instanceof Uint8Array) || payload.byteLength < 1
        || payload.byteLength > WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES) {
        fail("INVALID_TRANSPORT_REQUEST", "maintenance payload is empty or oversized");
      }
      const filename = exactText(request.filename, "maintenance filename", 160);
      if (!SAFE_FILENAME.test(filename)) {
        fail("INVALID_TRANSPORT_REQUEST", "maintenance filename contains unsafe characters");
      }
      const correlationId = exactCorrelationId(request.correlation_id);
      const timeoutMs = exactTimeout(request.timeout_ms);
      const responseCap = exactResponseCap(
        request.max_response_bytes,
        WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
      );
      return withTimeout(timeoutMs, async (signal) => {
        const token = await accessToken(signal);
        const boundary = `codex-walmart-repair-${exactText(input.random_uuid(), "multipart boundary nonce", 128)}`;
        if (!/^[A-Za-z0-9._-]+$/u.test(boundary)) {
          fail("INVALID_TRANSPORT_CONFIG", "multipart boundary source is unsafe");
        }
        const body = deterministicMultipartBody({ boundary, filename, payload });
        callCounts.maintenance_post_calls += 1;
        return fetchOnce(
          `${WALMART_API_ORIGIN}/v3/feeds?feedType=MP_MAINTENANCE`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              ...apiHeaders(token, correlationId),
              "content-length": String(body.byteLength),
              "content-type": `multipart/form-data; boundary=${boundary}`,
            },
            body: body as unknown as BodyInit,
          },
          responseCap,
          signal,
          "MAINTENANCE_POST_NETWORK_FAILURE",
        );
      });
    },
    async getFeedStatus(request) {
      if (callCounts.feed_status_get_calls >= WALMART_LISTING_REPAIR_MAX_POLL_ATTEMPTS) {
        fail("GET_BUDGET_EXHAUSTED", "feed-status GET budget is exhausted");
      }
      if (request.query.includeDetails !== "true" || request.redirect !== "error"
        || request.retries !== 0) {
        fail("INVALID_TRANSPORT_REQUEST", "feed-status request differs from the frozen operation");
      }
      const feedId = exactText(request.feed_id, "feed_id", 512);
      const expectedPath = `/v3/feeds/${encodeURIComponent(feedId)}`;
      if (request.path !== expectedPath) {
        fail("INVALID_TRANSPORT_REQUEST", "feed-status path is not bound to the exact feed_id");
      }
      const correlationId = exactCorrelationId(request.correlation_id);
      const timeoutMs = exactTimeout(request.timeout_ms);
      const responseCap = exactResponseCap(
        request.max_response_bytes,
        WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
      );
      return withTimeout(timeoutMs, async (signal) => {
        const token = await accessToken(signal);
        callCounts.feed_status_get_calls += 1;
        return fetchOnce(
          `${WALMART_API_ORIGIN}${expectedPath}?includeDetails=true`,
          {
            method: "GET",
            redirect: "error",
            headers: apiHeaders(token, correlationId),
          },
          responseCap,
          signal,
          "FEED_STATUS_NETWORK_FAILURE",
        );
      });
    },
  };
  return Object.freeze(transport);
}

function credentialsFromEnvironment(
  storeIndex: number,
  environment: NodeJS.ProcessEnv,
): WalmartListingRepairNativeTransportCredentials {
  const credentials = {
    client_id: environment[`WALMART_CLIENT_ID_STORE${storeIndex}`],
    client_secret: environment[`WALMART_CLIENT_SECRET_STORE${storeIndex}`],
    seller_id: environment[`WALMART_STORE${storeIndex}_SELLER_ID`],
  };
  if (!credentials.client_id || !credentials.client_secret || !credentials.seller_id) {
    fail("MISSING_WALMART_CREDENTIALS", `Walmart credential scope is incomplete for store ${storeIndex}`);
  }
  return credentials as WalmartListingRepairNativeTransportCredentials;
}

/** Production factory: environment credentials and native fetch are not injectable. */
export function createWalmartListingRepairNativeTransport(input: {
  store_index: number;
}): WalmartListingRepairOneShotTransport {
  const storeIndex = positiveInteger(input.store_index, "store_index");
  return nativeTransport({
    store_index: storeIndex,
    credentials: credentialsFromEnvironment(storeIndex, process.env),
    fetch_impl: globalThis.fetch,
    random_uuid: randomUUID,
  });
}

/** Test-only injection boundary; production callers cannot substitute fetch or credentials. */
export function createWalmartListingRepairNativeTransportForTest(input: {
  store_index: number;
  credentials: WalmartListingRepairNativeTransportCredentials;
  fetch_impl: FetchLike;
  random_uuid?: () => string;
}): WalmartListingRepairOneShotTransport {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("TEST_INJECTION_DISABLED", "native transport test injection is disabled");
  }
  return nativeTransport({
    ...input,
    random_uuid: input.random_uuid ?? randomUUID,
  });
}
