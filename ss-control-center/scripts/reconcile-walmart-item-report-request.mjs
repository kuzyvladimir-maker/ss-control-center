#!/usr/bin/env -S node --experimental-strip-types

/**
 * Read-only operator entrypoint for reconciling an ambiguous Walmart ITEM v6
 * report-create POST. Default invocation is a zero-network, zero-write plan.
 * Live mode requires all explicit scope flags and can perform only OAuth POST +
 * GET /v3/reports/reportRequests.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CAPTURE_ROOT,
  createWalmartItemReportCliTransport,
} from "./capture-walmart-item-report-source.mjs";
import {
  WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
  computeWalmartSellerAccountFingerprint,
} from "../src/lib/walmart/item-report-capture-session.ts";
import {
  WalmartItemReportRequestReconciliationError,
  runWalmartItemReportRequestReconciliation,
} from "../src/lib/walmart/item-report-request-reconciliation.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLAN_SESSION = path.join(DEFAULT_CAPTURE_ROOT, "PLAN-NOT-EXECUTED");

function fail(code, message) {
  throw new WalmartItemReportRequestReconciliationError(code, message);
}

function safeString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_CLI_INPUT", `${label} is invalid`);
  }
  return value;
}

function positiveStoreIndex(value) {
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    fail("INVALID_CLI_INPUT", "--store-index must be a positive safe integer");
  }
  return Number(value);
}

export function parseWalmartItemReportReconciliationCliArgs(argv) {
  let execute = false;
  let storeIndex = 1;
  let sessionDir = PLAN_SESSION;
  let start = null;
  let end = null;
  let storeProvided = false;
  let sessionProvided = false;
  let startProvided = false;
  let endProvided = false;
  for (const argument of argv) {
    if (argument === "--execute") {
      if (execute) fail("INVALID_CLI_INPUT", "--execute was repeated");
      execute = true;
    } else if (argument.startsWith("--store-index=")) {
      if (storeProvided) fail("INVALID_CLI_INPUT", "--store-index was repeated");
      storeProvided = true;
      storeIndex = positiveStoreIndex(argument.slice("--store-index=".length));
    } else if (argument.startsWith("--session-dir=")) {
      if (sessionProvided) fail("INVALID_CLI_INPUT", "--session-dir was repeated");
      sessionProvided = true;
      const raw = safeString(argument.slice("--session-dir=".length), "--session-dir");
      if (!path.isAbsolute(raw)) {
        fail("INVALID_CLI_INPUT", "--session-dir must be absolute before normalization");
      }
      sessionDir = path.resolve(raw);
    } else if (argument.startsWith("--request-submission-start-date=")) {
      if (startProvided) {
        fail("INVALID_CLI_INPUT", "--request-submission-start-date was repeated");
      }
      startProvided = true;
      start = safeString(
        argument.slice("--request-submission-start-date=".length),
        "--request-submission-start-date",
      );
    } else if (argument.startsWith("--request-submission-end-date=")) {
      if (endProvided) fail("INVALID_CLI_INPUT", "--request-submission-end-date was repeated");
      endProvided = true;
      end = safeString(
        argument.slice("--request-submission-end-date=".length),
        "--request-submission-end-date",
      );
    } else if (argument === "--help") {
      return {
        execute: false,
        store_index: 1,
        session_dir: PLAN_SESSION,
        allowed_capture_root: DEFAULT_CAPTURE_ROOT,
        request_submission_start_date: null,
        request_submission_end_date: null,
      };
    } else {
      fail("INVALID_CLI_INPUT", "unsupported CLI argument");
    }
  }
  if (execute && (!storeProvided || !sessionProvided || !startProvided || !endProvided)) {
    fail(
      "LIVE_FLAGS_REQUIRED",
      "live execution requires explicit --store-index, --session-dir, "
        + "--request-submission-start-date, and --request-submission-end-date",
    );
  }
  return {
    execute,
    store_index: storeIndex,
    session_dir: sessionDir,
    allowed_capture_root: DEFAULT_CAPTURE_ROOT,
    request_submission_start_date: start,
    request_submission_end_date: end,
  };
}

function loadCredentials(storeIndex) {
  const clientId = process.env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = process.env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = process.env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  if (!clientId || !clientSecret || !sellerId) {
    fail("MISSING_CREDENTIALS", "Walmart credential scope is not configured for the requested store");
  }
  return { client_id: clientId, client_secret: clientSecret, seller_id: sellerId };
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const parsedInput = parseWalmartItemReportReconciliationCliArgs(argv);
  const input = injected.allowed_capture_root === undefined
    ? parsedInput
    : { ...parsedInput, allowed_capture_root: injected.allowed_capture_root };
  if (!input.execute) {
    const plan = await runWalmartItemReportRequestReconciliation(input, {
      transport: { send: async () => { throw new Error("PLAN must not call transport"); } },
    });
    (injected.stdout ?? console.log)(JSON.stringify(plan));
    return plan;
  }

  const credentials = injected.credentials ?? loadCredentials(input.store_index);
  const randomUuid = injected.random_uuid ?? randomUUID;
  const transport = createWalmartItemReportCliTransport({
    credentials,
    fetch_impl: injected.fetch_impl ?? globalThis.fetch,
    random_uuid: randomUuid,
    request_timeout_ms: injected.request_timeout_ms
      ?? WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const before = transport.get_http_call_counts();
  const libraryResult = await runWalmartItemReportRequestReconciliation(input, {
    transport,
    account_scope: {
      channel: "WALMART_US",
      store_index: input.store_index,
      seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
        store_index: input.store_index,
        client_id: credentials.client_id,
        seller_id: credentials.seller_id,
      }),
    },
    random_uuid: randomUuid,
    now: injected.now,
    request_timeout_ms: injected.request_timeout_ms,
    after_immutable_write: injected.after_immutable_write,
  });
  const after = transport.get_http_call_counts();
  const actual = {
    oauth_token_calls: after.oauth_token_calls - before.oauth_token_calls,
    walmart_api_calls: after.walmart_api_calls - before.walmart_api_calls,
    presigned_file_calls: after.presigned_file_calls - before.presigned_file_calls,
  };
  const total = actual.oauth_token_calls + actual.walmart_api_calls + actual.presigned_file_calls;
  if (libraryResult.mode !== "EXECUTED"
    || actual.presigned_file_calls !== 0
    || libraryResult.http_calls.walmart_api_calls !== actual.walmart_api_calls
    || actual.oauth_token_calls > 1) {
    fail("HTTP_ACCOUNTING_MISMATCH", "CLI transport calls differ from sealed reconciliation accounting");
  }
  const result = {
    ...libraryResult,
    network_calls: total,
    http_calls: { ...actual, total_http_calls: total },
  };
  (injected.stdout ?? console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    const code = error instanceof WalmartItemReportRequestReconciliationError
      ? error.code
      : (typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR");
    const safeMessages = new Map([
      ["INVALID_CLI_INPUT", "invalid reconciliation command"],
      ["LIVE_FLAGS_REQUIRED", "required live reconciliation flags are missing"],
      ["MISSING_CREDENTIALS", "Walmart credential scope is not configured"],
    ]);
    const message = safeMessages.get(code)
      ?? (error instanceof Error ? error.message : "reconciliation failed");
    console.error(JSON.stringify({ ok: false, error_code: code, message }));
    process.exitCode = 1;
  });
}
