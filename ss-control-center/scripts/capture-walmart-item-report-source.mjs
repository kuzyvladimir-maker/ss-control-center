#!/usr/bin/env -S node --experimental-strip-types

/**
 * Default mode is a zero-network, zero-write plan. Live continuation phases require:
 *   --execute --phase=poll|download|compile --store-index=N --session-dir=/absolute/path
 * Live --phase=request is hard-retired while the reissue-v1 authority is unsigned
 * and not bound to independent source evidence. The low-level session module remains
 * available for offline certification tests, but this production CLI cannot POST.
 *
 * This CLI intentionally bypasses the retrying WalmartClient. Every report API
 * request and every presigned URL hop is one native fetch with redirect=manual.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WALMART_ITEM_REPORT_CAPTURE_PHASES,
  WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
  WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
  WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS,
  WalmartItemReportCaptureError,
  computeWalmartSellerAccountFingerprint,
  runWalmartItemReportCapturePhase,
} from "../src/lib/walmart/item-report-capture-session.ts";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CAPTURE_ROOT = path.resolve(
  SCRIPT_DIR,
  "../data/audits/walmart-source-captures",
);
const WALMART_API_ORIGIN = "https://marketplace.walmartapis.com";
const TOKEN_RESPONSE_CAP = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE =
  "WALMART_ITEM_REPORT_REISSUE_V1_RETIRED";

function throwRetiredReissueV1() {
  throw new WalmartItemReportCaptureError(
    WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE,
    "live ITEM report request is retired until a separately certified bound reissue release exists",
  );
}

function safeString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", `${label} is invalid`);
  }
  return value;
}

function positiveStoreIndex(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--store-index must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--store-index is outside the safe range");
  }
  return parsed;
}

function exactSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new WalmartItemReportCaptureError(
      "INVALID_CLI_INPUT",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

export function parseWalmartItemReportCaptureCliArgs(argv) {
  let execute = false;
  let phase = "request";
  let storeIndex = 1;
  let sessionDir = path.join(DEFAULT_CAPTURE_ROOT, "PLAN-NOT-EXECUTED");
  let phaseProvided = false;
  let storeProvided = false;
  let sessionProvided = false;
  let ownerReissuePermitPath = null;
  let expectedOwnerReissueArtifactSha256 = null;
  let expectedOwnerReissuePermitSha256 = null;
  let expectedSourceEvidenceReleaseSha256 = null;
  let ownerReissueConfirmation = null;
  for (const argument of argv) {
    if (argument === "--execute") {
      if (execute) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--execute was repeated");
      execute = true;
    } else if (argument.startsWith("--phase=")) {
      if (phaseProvided) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--phase was repeated");
      phase = argument.slice("--phase=".length);
      phaseProvided = true;
    } else if (argument.startsWith("--store-index=")) {
      if (storeProvided) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--store-index was repeated");
      storeIndex = positiveStoreIndex(argument.slice("--store-index=".length));
      storeProvided = true;
    } else if (argument.startsWith("--session-dir=")) {
      if (sessionProvided) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--session-dir was repeated");
      const rawSessionDir = safeString(argument.slice("--session-dir=".length), "--session-dir");
      if (!path.isAbsolute(rawSessionDir)) {
        throw new WalmartItemReportCaptureError(
          "INVALID_CLI_INPUT",
          "--session-dir must be an absolute path before normalization",
        );
      }
      sessionDir = path.resolve(rawSessionDir);
      sessionProvided = true;
    } else if (argument.startsWith("--owner-reissue-permit=")) {
      if (ownerReissuePermitPath !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--owner-reissue-permit was repeated");
      }
      const rawPath = safeString(argument.slice("--owner-reissue-permit=".length), "--owner-reissue-permit");
      if (!path.isAbsolute(rawPath) || path.normalize(rawPath) !== rawPath) {
        throw new WalmartItemReportCaptureError(
          "INVALID_CLI_INPUT",
          "--owner-reissue-permit must be an exact normalized absolute path",
        );
      }
      ownerReissuePermitPath = rawPath;
    } else if (argument.startsWith("--expect-owner-reissue-artifact-sha256=")) {
      if (expectedOwnerReissueArtifactSha256 !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--expect-owner-reissue-artifact-sha256 was repeated");
      }
      expectedOwnerReissueArtifactSha256 = exactSha256(
        argument.slice("--expect-owner-reissue-artifact-sha256=".length),
        "--expect-owner-reissue-artifact-sha256",
      );
    } else if (argument.startsWith("--expect-owner-reissue-permit-sha256=")) {
      if (expectedOwnerReissuePermitSha256 !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--expect-owner-reissue-permit-sha256 was repeated");
      }
      expectedOwnerReissuePermitSha256 = exactSha256(
        argument.slice("--expect-owner-reissue-permit-sha256=".length),
        "--expect-owner-reissue-permit-sha256",
      );
    } else if (argument.startsWith("--expect-source-evidence-release-sha256=")) {
      if (expectedSourceEvidenceReleaseSha256 !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--expect-source-evidence-release-sha256 was repeated");
      }
      expectedSourceEvidenceReleaseSha256 = exactSha256(
        argument.slice("--expect-source-evidence-release-sha256=".length),
        "--expect-source-evidence-release-sha256",
      );
    } else if (argument.startsWith("--owner-reissue-confirmation=")) {
      if (ownerReissueConfirmation !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--owner-reissue-confirmation was repeated");
      }
      ownerReissueConfirmation = safeString(
        argument.slice("--owner-reissue-confirmation=".length),
        "--owner-reissue-confirmation",
      );
    } else if (argument === "--help") {
      return {
        execute: false,
        phase: "request",
        store_index: 1,
        session_dir: path.join(DEFAULT_CAPTURE_ROOT, "PLAN-NOT-EXECUTED"),
        allowed_capture_root: DEFAULT_CAPTURE_ROOT,
        owner_reissue_permit_path: null,
        expected_owner_reissue_artifact_sha256: null,
        expected_owner_reissue_permit_sha256: null,
        expected_source_evidence_release_sha256: null,
        owner_reissue_confirmation: null,
      };
    } else {
      throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "unsupported CLI argument");
    }
  }
  if (!WALMART_ITEM_REPORT_CAPTURE_PHASES.includes(phase)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--phase is invalid");
  }
  if (execute && phase === "request") throwRetiredReissueV1();
  if (execute && (!phaseProvided || !storeProvided || !sessionProvided)) {
    throw new WalmartItemReportCaptureError(
      "LIVE_FLAGS_REQUIRED",
      "live execution requires explicit --phase, --store-index, and --session-dir",
    );
  }
  if (execute && !path.isAbsolute(sessionDir)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "live --session-dir must be absolute");
  }
  const ownerPermitInputs = [
    ownerReissuePermitPath,
    expectedOwnerReissueArtifactSha256,
    expectedOwnerReissuePermitSha256,
    expectedSourceEvidenceReleaseSha256,
    ownerReissueConfirmation,
  ];
  if (phase !== "request" && ownerPermitInputs.some((value) => value !== null)) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_FLAGS_PHASE_MISMATCH",
      "owner reissue flags are valid only with --phase=request",
    );
  }
  return {
    execute,
    phase,
    store_index: storeIndex,
    session_dir: sessionDir,
    allowed_capture_root: DEFAULT_CAPTURE_ROOT,
    owner_reissue_permit_path: ownerReissuePermitPath,
    expected_owner_reissue_artifact_sha256: expectedOwnerReissueArtifactSha256,
    expected_owner_reissue_permit_sha256: expectedOwnerReissuePermitSha256,
    expected_source_evidence_release_sha256: expectedSourceEvidenceReleaseSha256,
    owner_reissue_confirmation: ownerReissueConfirmation,
  };
}

function abortable(promise, signal, onAbort = () => {}) {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new WalmartItemReportCaptureError("REQUEST_TIMEOUT", "HTTP attempt deadline elapsed"));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      onAbort();
      reject(new WalmartItemReportCaptureError("REQUEST_TIMEOUT", "HTTP attempt deadline elapsed"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function readExactResponseBytes(
  response,
  maximumBytes,
  maximumRedirectBytes,
  signal,
) {
  const responseCap = REDIRECT_STATUSES.has(response.status)
    ? Math.min(maximumBytes, maximumRedirectBytes)
    : maximumBytes;
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new WalmartItemReportCaptureError(
      "UNSUPPORTED_CONTENT_ENCODING",
      "server ignored Accept-Encoding: identity; exact wire-byte capture was refused",
    );
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength) || Number(rawLength) > responseCap) {
      throw new WalmartItemReportCaptureError("RESPONSE_SIZE_CAP", "HTTP response exceeds its safety cap");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal, () => {
        void reader.cancel().catch(() => {});
      });
      if (done) break;
      total += value.byteLength;
      if (total > responseCap) {
        await reader.cancel();
        throw new WalmartItemReportCaptureError("RESPONSE_SIZE_CAP", "streamed HTTP response exceeds safety cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (rawLength !== null && Number(rawLength) !== output.byteLength) {
    throw new WalmartItemReportCaptureError(
      "CONTENT_LENGTH_MISMATCH",
      "HTTP Content-Length does not match captured bytes",
    );
  }
  return output;
}

function responseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

export function createWalmartItemReportCliTransport({
  credentials,
  fetch_impl = globalThis.fetch,
  random_uuid = randomUUID,
  request_timeout_ms = WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetch_impl !== "function") {
    throw new WalmartItemReportCaptureError("MISSING_FETCH", "native fetch is unavailable");
  }
  const clientId = safeString(credentials.client_id, "Walmart client ID");
  const clientSecret = safeString(credentials.client_secret, "Walmart client secret");
  if (!Number.isSafeInteger(request_timeout_ms) || request_timeout_ms < 1
    || request_timeout_ms > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
    throw new WalmartItemReportCaptureError("INVALID_REQUEST_TIMEOUT", "transport timeout is outside 1..60000 ms");
  }
  let accessToken = null;
  const counters = {
    oauth_token_calls: 0,
    walmart_api_calls: 0,
    presigned_file_calls: 0,
  };

  const token = async (signal) => {
    if (accessToken !== null) return accessToken;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    let response;
    try {
      counters.oauth_token_calls += 1;
      response = await abortable(fetch_impl(`${WALMART_API_ORIGIN}/v3/token`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Basic ${basic}`,
          "wm_qos.correlation_id": random_uuid(),
          "wm_svc.name": "Walmart Marketplace",
          accept: "application/json",
          "accept-encoding": "identity",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal,
      }), signal);
    } catch (error) {
      if (error instanceof WalmartItemReportCaptureError && error.code === "REQUEST_TIMEOUT") throw error;
      throw new WalmartItemReportCaptureError("TOKEN_NETWORK_FAILURE", "Walmart token fetch failed");
    }
    const body = await readExactResponseBytes(
      response,
      TOKEN_RESPONSE_CAP,
      WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
      signal,
    );
    if (response.status !== 200) {
      throw new WalmartItemReportCaptureError("TOKEN_HTTP_FAILURE", "Walmart token fetch returned non-200");
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new WalmartItemReportCaptureError("TOKEN_INVALID_RESPONSE", "Walmart token response is invalid");
    }
    accessToken = safeString(parsed.access_token, "Walmart access token");
    return accessToken;
  };

  return {
    get_http_call_counts() {
      return Object.freeze({
        ...counters,
        total_http_calls: counters.oauth_token_calls
          + counters.walmart_api_calls + counters.presigned_file_calls,
      });
    },
    async send(request) {
      const requestedTimeout = request.timeout_ms ?? request_timeout_ms;
      if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1
        || requestedTimeout > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
        throw new WalmartItemReportCaptureError("INVALID_REQUEST_TIMEOUT", "request timeout is outside 1..60000 ms");
      }
      const timeoutMs = Math.min(request_timeout_ms, requestedTimeout);
      const controller = new AbortController();
      const outerSignal = request.signal;
      const forwardAbort = () => controller.abort();
      outerSignal?.addEventListener("abort", forwardAbort, { once: true });
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
      let url;
      let headers;
      if (request.kind === "walmart-api") {
        if (request.url !== null || request.endpoint === null || request.correlation_id === null) {
          throw new WalmartItemReportCaptureError("INVALID_TRANSPORT_REQUEST", "Walmart API request is invalid");
        }
        const endpoint = safeString(request.endpoint, "Walmart endpoint");
        if (!endpoint.startsWith("/v3/") || endpoint.includes("..")) {
          throw new WalmartItemReportCaptureError("INVALID_TRANSPORT_REQUEST", "Walmart endpoint is not approved");
        }
        const parsedUrl = new URL(endpoint, WALMART_API_ORIGIN);
        for (const [name, value] of Object.entries(request.query)) parsedUrl.searchParams.append(name, value);
        url = parsedUrl.toString();
        const bearer = await token(controller.signal);
        headers = {
          ...request.headers,
          authorization: `Bearer ${bearer}`,
          "wm_sec.access_token": bearer,
          "wm_qos.correlation_id": request.correlation_id,
          "wm_svc.name": "Walmart Marketplace",
        };
      } else {
        if (request.endpoint !== null || request.url === null || request.correlation_id !== null) {
          throw new WalmartItemReportCaptureError("INVALID_TRANSPORT_REQUEST", "presigned request is invalid");
        }
        url = safeString(request.url, "presigned request URL");
        headers = { ...request.headers };
        const forbidden = Object.keys(headers).some((name) => (
          ["authorization", "wm_sec.access_token", "wm_qos.correlation_id", "wm_svc.name"]
            .includes(name.toLowerCase())
        ));
        if (forbidden) {
          throw new WalmartItemReportCaptureError(
            "AUTH_HEADER_LEAK",
            "Walmart authorization headers must never be sent to a presigned report host",
          );
        }
      }
      if (headers["accept-encoding"] !== "identity") {
        throw new WalmartItemReportCaptureError(
          "IDENTITY_ENCODING_REQUIRED",
          "every capture request must send Accept-Encoding: identity",
        );
      }
      let response;
      try {
        if (request.kind === "walmart-api") counters.walmart_api_calls += 1;
        else counters.presigned_file_calls += 1;
        response = await abortable(fetch_impl(url, {
          method: request.method,
          headers,
          body: request.body === null ? undefined : request.body,
          redirect: "manual",
          signal: controller.signal,
        }), controller.signal);
      } catch (error) {
        if (error instanceof WalmartItemReportCaptureError && error.code === "REQUEST_TIMEOUT") throw error;
        throw new WalmartItemReportCaptureError("NETWORK_FAILURE", "capture HTTP request failed");
      }
      const body = await readExactResponseBytes(
        response,
        request.max_response_bytes,
        request.max_redirect_response_bytes ?? WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
        controller.signal,
      );
      return { status: response.status, headers: responseHeaders(response), body };
      } finally {
        clearTimeout(timeoutHandle);
        outerSignal?.removeEventListener("abort", forwardAbort);
      }
    },
  };
}

function loadCredentials(storeIndex) {
  const clientId = process.env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = process.env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = process.env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  if (!clientId || !clientSecret || !sellerId) {
    throw new WalmartItemReportCaptureError(
      "MISSING_CREDENTIALS",
      `Walmart credential scope is not configured for store ${storeIndex}`,
    );
  }
  return { client_id: clientId, client_secret: clientSecret, seller_id: sellerId };
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const input = parseWalmartItemReportCaptureCliArgs(argv);
  if (!input.execute) {
    const plan = await runWalmartItemReportCapturePhase(input, {
      transport: { send: async () => { throw new Error("plan must not call transport"); } },
    });
    (injected.stdout ?? console.log)(JSON.stringify(plan));
    return plan;
  }
  if (input.phase === "request") throwRetiredReissueV1();
  let runInput = {
    execute: input.execute,
    phase: input.phase,
    store_index: input.store_index,
    session_dir: input.session_dir,
    allowed_capture_root: input.allowed_capture_root,
  };
  let transport = { send: async () => { throw new Error("compile phase must not call transport"); } };
  let cliTransport = null;
  let accountScope;
  if (input.phase !== "compile") {
    const credentials = injected.credentials ?? loadCredentials(input.store_index);
    cliTransport = createWalmartItemReportCliTransport({
      credentials,
      fetch_impl: injected.fetch_impl ?? globalThis.fetch,
      random_uuid: injected.random_uuid ?? randomUUID,
      request_timeout_ms: injected.request_timeout_ms
        ?? WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
    });
    transport = cliTransport;
    accountScope = {
      channel: "WALMART_US",
      store_index: input.store_index,
      seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
        store_index: input.store_index,
        client_id: credentials.client_id,
        seller_id: credentials.seller_id,
      }),
    };
  }
  const beforeCounts = cliTransport?.get_http_call_counts() ?? {
    oauth_token_calls: 0,
    walmart_api_calls: 0,
    presigned_file_calls: 0,
    total_http_calls: 0,
  };
  const libraryResult = await runWalmartItemReportCapturePhase(runInput, {
    transport,
    account_scope: accountScope,
    random_uuid: injected.random_uuid ?? randomUUID,
    now: injected.now,
    request_timeout_ms: injected.request_timeout_ms,
  });
  const afterCounts = cliTransport?.get_http_call_counts() ?? beforeCounts;
  const actualCalls = {
    oauth_token_calls: afterCounts.oauth_token_calls - beforeCounts.oauth_token_calls,
    walmart_api_calls: afterCounts.walmart_api_calls - beforeCounts.walmart_api_calls,
    presigned_file_calls: afterCounts.presigned_file_calls - beforeCounts.presigned_file_calls,
  };
  const totalHttpCalls = actualCalls.oauth_token_calls
    + actualCalls.walmart_api_calls + actualCalls.presigned_file_calls;
  if (libraryResult.mode === "EXECUTED"
    && (libraryResult.http_calls.walmart_api_calls !== actualCalls.walmart_api_calls
      || libraryResult.http_calls.presigned_file_calls !== actualCalls.presigned_file_calls)) {
    throw new WalmartItemReportCaptureError(
      "HTTP_ACCOUNTING_MISMATCH",
      "capture session call accounting differs from the CLI transport attempts",
    );
  }
  const result = libraryResult.mode === "EXECUTED" ? {
    ...libraryResult,
    network_calls: totalHttpCalls,
    http_calls: {
      ...actualCalls,
      total_http_calls: totalHttpCalls,
    },
  } : libraryResult;
  (injected.stdout ?? console.log)(JSON.stringify(result));
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const code = error instanceof WalmartItemReportCaptureError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : "capture failed";
    console.error(JSON.stringify({ ok: false, error_code: code, message }));
    process.exitCode = 1;
  });
}
