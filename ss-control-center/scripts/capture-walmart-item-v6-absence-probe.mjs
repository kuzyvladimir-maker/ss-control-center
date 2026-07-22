#!/usr/bin/env -S node --experimental-strip-types

/**
 * One-shot, read-only Walmart ITEM v6 absence probe for the exact window of the
 * 2026-07-19 ambiguous create incident.
 *
 * Default `plan` mode performs zero network calls and zero filesystem writes.
 * `execute` durably reserves the sole GET before OAuth/network, never retries,
 * never follows redirects, and retains exact response bytes plus a canonical
 * evidence family in a new private directory.  There is no report-create path.
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWalmartItemReportCliTransport,
} from "./capture-walmart-item-report-source.mjs";
import {
  WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
  computeWalmartSellerAccountFingerprint,
} from "../src/lib/walmart/item-report-capture-session.ts";
import {
  canonicalWalmartItemReportJson,
} from "../src/lib/walmart/item-report-published-source.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_OUTPUT_ROOT = path.join(
  PROJECT_ROOT,
  "data/audits/walmart-source-intake",
);
const API_ENDPOINT = "/v3/reports/reportRequests";
const EXPECTED_STORE_INDEX = 1;
const EXPECTED_SELLER_ID = "10001624309";
const EXPECTED_ACCOUNT_FINGERPRINT =
  "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127";
const EXACT_QUERY = Object.freeze({
  reportType: "ITEM",
  reportVersion: "v6",
  src: "API",
  requestSubmissionStartDate: "2026-07-19T03:55:00Z",
  requestSubmissionEndDate: "2026-07-19T04:00:00Z",
});
const CONFIRMATION = "CAPTURE_WALMART_ITEM_V6_ABSENCE_PROBE_STORE1_ONCE";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_BYTES = 64 * 1024;

export const WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA =
  "walmart-item-v6-absence-probe/1.0.0";

export class WalmartItemV6AbsenceProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemV6AbsenceProbeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WalmartItemV6AbsenceProbeError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
}

function exactString(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function exactAbsolute(value, label) {
  const parsed = exactString(value, label);
  if (!path.isAbsolute(parsed) || path.normalize(parsed) !== parsed) {
    fail("INVALID_INPUT", `${label} must be an exact normalized absolute path`);
  }
  return parsed;
}

function exactInstant(value, label) {
  const parsed = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(Date.parse(parsed)).toISOString() !== parsed) {
    fail("INVALID_CLOCK", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function clockNow(injected) {
  const value = injected.now ? injected.now() : new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_CLOCK", "clock returned an invalid Date");
  }
  return exactInstant(value.toISOString(), "clock");
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

async function assertPrivateRealDirectory(directory, label) {
  const info = await lstat(directory).catch(() => fail(
    "UNSAFE_OUTPUT_ROOT",
    `${label} must already exist`,
  ));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (info.mode & 0o500) !== 0o500 || await realpath(directory) !== directory) {
    fail(
      "UNSAFE_OUTPUT_ROOT",
      `${label} must be a private real directory with no group/other access`,
    );
  }
}

async function validateOutputPath(output, allowedRoot, requireNew = true) {
  const exactOutput = exactAbsolute(output, "--out");
  const exactRoot = exactAbsolute(allowedRoot, "allowed output root");
  await assertPrivateRealDirectory(exactRoot, "allowed output root");
  if (path.dirname(exactOutput) !== exactRoot || !isWithin(exactOutput, exactRoot)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u.test(path.basename(exactOutput))) {
    fail("INVALID_OUTPUT", "--out must be one safe direct child of the allowed output root");
  }
  const found = await lstat(exactOutput).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (requireNew && found) fail("OUTPUT_EXISTS", "--out already exists; retry is forbidden");
  if (!requireNew && !found) fail("OUTPUT_NOT_FOUND", "--out does not exist");
  return { output: exactOutput, root: exactRoot };
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeImmutable(directory, name, bytes) {
  if (!/^[0-9]{2}-[a-z0-9-]+\.(?:json|bytes)$/u.test(name)) {
    fail("INVALID_ARTIFACT_NAME", "artifact name is outside the fixed policy");
  }
  const target = path.join(directory, name);
  const handle = await open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o400,
  ).catch((error) => {
    if (error?.code === "EEXIST") fail("ARTIFACT_EXISTS", `${name} already exists`);
    fail("ARTIFACT_WRITE_FAILED", `${name} could not be created`);
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  return {
    path: name,
    byte_length: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function writeImmutableJson(directory, name, value) {
  return writeImmutable(directory, name, canonicalBytes(value));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readStableArtifact(directory, name, maximumBytes = MAX_RESPONSE_BYTES) {
  const target = path.join(directory, name);
  const beforePath = await lstat(target).catch(() => fail(
    "MISSING_ARTIFACT",
    `${name} is missing`,
  ));
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1
    || (beforePath.mode & 0o777) !== 0o400 || beforePath.size < 1
    || beforePath.size > maximumBytes || await realpath(target) !== target) {
    fail("UNSAFE_ARTIFACT", `${name} is not an immutable private regular file`);
  }
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!sameFile(beforePath, before)) fail("ARTIFACT_READ_RACE", `${name} raced before read`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(target);
    if (bytes.byteLength !== before.size || !sameFile(before, after)
      || !sameFile(after, afterPath) || await realpath(target) !== target) {
      fail("ARTIFACT_READ_RACE", `${name} changed while being read`);
    }
    return Buffer.from(bytes);
  } finally {
    await handle.close();
  }
}

function parseCanonicalArtifact(bytes, name) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("INVALID_ARTIFACT", `${name} is not UTF-8 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || text !== canonicalWalmartItemReportJson(value)) {
    fail("NON_CANONICAL_ARTIFACT", `${name} is not one canonical JSON object`);
  }
  return value;
}

function assertCanonicalEqual(actual, expected, label) {
  if (canonicalWalmartItemReportJson(actual) !== canonicalWalmartItemReportJson(expected)) {
    fail("EVIDENCE_BINDING_MISMATCH", `${label} differs from the sealed probe family`);
  }
}

function parseArgs(argv) {
  const command = argv[0] ?? "plan";
  const values = new Map();
  for (const argument of argv.slice(1)) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      fail("INVALID_CLI", "arguments must use exact --name=value form");
    }
    const offset = argument.indexOf("=");
    const name = argument.slice(2, offset);
    const value = argument.slice(offset + 1);
    if (!name || !value || values.has(name)) {
      fail("INVALID_CLI", "CLI argument is empty or repeated");
    }
    values.set(name, value);
  }
  return { command, values };
}

function requireExactOptions(values, names) {
  const actual = [...values.keys()].sort();
  const expected = [...names].sort();
  if (canonicalWalmartItemReportJson(actual) !== canonicalWalmartItemReportJson(expected)) {
    fail("INVALID_CLI", `exact options required: ${expected.map((name) => `--${name}`).join(", ")}`);
  }
}

function parseStoreIndex(value) {
  if (value !== String(EXPECTED_STORE_INDEX)) {
    fail("ACCOUNT_SCOPE_MISMATCH", `--store-index must be ${EXPECTED_STORE_INDEX}`);
  }
  return EXPECTED_STORE_INDEX;
}

function loadCredentials(storeIndex, env) {
  const clientId = env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  if (!clientId || !clientSecret || !sellerId) {
    fail("MISSING_CREDENTIALS", "Walmart credential scope is not configured");
  }
  const fingerprint = computeWalmartSellerAccountFingerprint({
    store_index: storeIndex,
    client_id: clientId,
    seller_id: sellerId,
  });
  if (sellerId !== EXPECTED_SELLER_ID || fingerprint !== EXPECTED_ACCOUNT_FINGERPRINT) {
    fail("ACCOUNT_SCOPE_MISMATCH", "active Walmart credentials do not match the incident account");
  }
  return {
    client_id: clientId,
    client_secret: clientSecret,
    seller_id: sellerId,
    fingerprint,
  };
}

function safeResponseHeaders(headers) {
  const output = {};
  for (const name of [
    "content-length",
    "content-type",
    "x-request-id",
    "wm_qos.correlation_id",
    "wm-qos-correlation-id",
  ]) {
    const value = headers?.[name];
    if (typeof value === "string" && value.length > 0 && value.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(value)) {
      output[name] = value;
    }
  }
  return output;
}

function validateResponse(response) {
  if (!response || !Number.isSafeInteger(response.status)
    || !(response.body instanceof Uint8Array) || !response.headers
    || typeof response.headers !== "object") {
    fail("INVALID_HTTP_RESPONSE", "transport returned an invalid response");
  }
  const headers = safeResponseHeaders(response.headers);
  if (response.status !== 200) fail("HTTP_STATUS_FAILURE", "Walmart GET returned non-200");
  if (typeof headers["content-type"] !== "string"
    || !/^application\/json(?:\s*;|$)/iu.test(headers["content-type"])) {
    fail("UNSUPPORTED_CONTENT_TYPE", "Walmart GET response is not JSON");
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    fail("INVALID_RESPONSE_JSON", "Walmart GET response is not valid UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Number.isSafeInteger(parsed.page) || parsed.page !== 1
    || !Number.isSafeInteger(parsed.totalCount) || parsed.totalCount < 0
    || !Number.isSafeInteger(parsed.limit) || parsed.limit < 0
    || !Array.isArray(parsed.requests)) {
    fail("INVALID_RESPONSE_SHAPE", "Walmart GET response has an invalid page shape");
  }
  const cursorPresent = typeof parsed.nextCursor === "string" && parsed.nextCursor.length > 0;
  const absence = parsed.totalCount === 0 && parsed.requests.length === 0 && !cursorPresent;
  let outcome;
  if (absence) outcome = "ABSENCE_ONLY";
  else if (parsed.requests.length > 0 || parsed.totalCount > 0) outcome = "CANDIDATES_FOUND";
  else outcome = "PAGINATION_AMBIGUITY";
  return {
    parsed,
    headers,
    outcome,
    cursor_present: cursorPresent,
  };
}

function fixedRequest(correlationId) {
  return {
    kind: "walmart-api",
    method: "GET",
    endpoint: API_ENDPOINT,
    query: { ...EXACT_QUERY },
    url: null,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    correlation_id: correlationId,
    redirect: "manual",
    max_response_bytes: MAX_RESPONSE_BYTES,
    max_redirect_response_bytes: MAX_REDIRECT_BYTES,
    timeout_ms: WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function failureCode(error) {
  if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.code)) {
    return error.code;
  }
  return "NETWORK_OR_PROTOCOL_FAILURE";
}

async function executeProbe(input, injected) {
  const { output, root } = await validateOutputPath(
    input.out,
    injected.allowed_output_root ?? DEFAULT_OUTPUT_ROOT,
  );
  const credentials = injected.credentials ?? loadCredentials(input.store_index, injected.env ?? process.env);
  const expectedFingerprint = injected.expected_account_fingerprint_for_test
    ?? EXPECTED_ACCOUNT_FINGERPRINT;
  const derivedFingerprint = computeWalmartSellerAccountFingerprint({
    store_index: input.store_index,
    client_id: credentials.client_id,
    seller_id: credentials.seller_id,
  });
  if (credentials.seller_id !== EXPECTED_SELLER_ID
    || derivedFingerprint !== expectedFingerprint) {
    fail("ACCOUNT_SCOPE_MISMATCH", "active Walmart credentials do not match the incident account");
  }
  const uuid = injected.random_uuid ?? randomUUID;
  const correlationId = exactString(uuid(), "correlation ID", 128);
  const correlationSha = sha256(Buffer.from(correlationId, "utf8"));
  const createdAt = clockNow(injected);
  const request = fixedRequest(correlationId);
  const authority = {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "probe-authority",
    probe_id: exactString(path.basename(output), "probe id", 180),
    created_at: createdAt,
    account_scope: {
      channel: "WALMART_US",
      store_index: EXPECTED_STORE_INDEX,
      seller_id: EXPECTED_SELLER_ID,
      seller_account_fingerprint_sha256: expectedFingerprint,
    },
    request: {
      method: "GET",
      endpoint: API_ENDPOINT,
      query: { ...EXACT_QUERY },
      request_correlation_id: correlationId,
      request_correlation_id_sha256: correlationSha,
    },
    budget: {
      oauth_token_posts_maximum: 1,
      report_requests_gets_maximum: 1,
      report_create_posts_maximum: 0,
      retries_allowed: 0,
      redirects_allowed: 0,
      cursor_calls_allowed: 0,
      listing_content_writes_allowed: 0,
      model_calls_allowed: 0,
      database_calls_allowed: 0,
    },
  };
  const authorityBytes = canonicalBytes(authority);
  const reservation = {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "get-reservation",
    probe_id: authority.probe_id,
    reserved_at: clockNow(injected),
    authority_sha256: sha256(authorityBytes),
    request_sha256: sha256(canonicalBytes(request)),
    state: "GET_RESERVED",
    retry_allowed: false,
  };
  await mkdir(output, { mode: 0o700 });
  await chmod(output, 0o700);
  await syncDirectory(root);
  const inventory = [];
  inventory.push(await writeImmutable(output, "00-probe-authority.json", authorityBytes));
  inventory.push(await writeImmutableJson(output, "10-get-reserved.json", reservation));

  const transport = createWalmartItemReportCliTransport({
    credentials,
    fetch_impl: injected.fetch_impl ?? globalThis.fetch,
    random_uuid: uuid,
    request_timeout_ms: injected.request_timeout_ms
      ?? WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const before = transport.get_http_call_counts();
  let response;
  try {
    response = await transport.send(request);
  } catch (error) {
    const after = transport.get_http_call_counts();
    const failure = {
      schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
      artifact: "terminal-failure",
      probe_id: authority.probe_id,
      failed_at: clockNow(injected),
      state: "AMBIGUOUS_GET_OUTCOME",
      reason_code: failureCode(error),
      retry_allowed: false,
      http_calls: {
        oauth_token_posts: after.oauth_token_calls - before.oauth_token_calls,
        report_requests_gets: after.walmart_api_calls - before.walmart_api_calls,
        presigned_file_calls: after.presigned_file_calls - before.presigned_file_calls,
      },
      report_create_posts: 0,
      listing_content_writes: 0,
      model_calls: 0,
      database_calls: 0,
    };
    await writeImmutableJson(output, "19-terminal-failure.json", failure);
    throw new WalmartItemV6AbsenceProbeError(
      failure.reason_code,
      "bounded Walmart ITEM v6 absence GET is ambiguous; retry is forbidden",
    );
  }

  const observedAt = clockNow(injected);
  const after = transport.get_http_call_counts();
  const actual = {
    oauth_token_posts: after.oauth_token_calls - before.oauth_token_calls,
    report_requests_gets: after.walmart_api_calls - before.walmart_api_calls,
    presigned_file_calls: after.presigned_file_calls - before.presigned_file_calls,
  };
  if (actual.oauth_token_posts !== 1 || actual.report_requests_gets !== 1
    || actual.presigned_file_calls !== 0) {
    await writeImmutableJson(output, "19-terminal-failure.json", {
      schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
      artifact: "terminal-failure",
      probe_id: authority.probe_id,
      failed_at: observedAt,
      state: "HTTP_ACCOUNTING_MISMATCH",
      reason_code: "HTTP_ACCOUNTING_MISMATCH",
      retry_allowed: false,
      http_calls: actual,
      report_create_posts: 0,
      listing_content_writes: 0,
      model_calls: 0,
      database_calls: 0,
    });
    fail("HTTP_ACCOUNTING_MISMATCH", "probe transport call accounting is invalid");
  }

  inventory.push(await writeImmutable(output, "20-response-raw.bytes", Buffer.from(response.body)));
  let validated;
  try {
    validated = validateResponse(response);
  } catch (error) {
    const http = {
      schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
      artifact: "response-http",
      probe_id: authority.probe_id,
      observed_at: observedAt,
      status: response.status,
      safe_response_headers: safeResponseHeaders(response.headers),
      raw_response_byte_length: response.body.byteLength,
      raw_response_sha256: sha256(response.body),
      request_correlation_id_sha256: correlationSha,
      validation_error_code: failureCode(error),
    };
    inventory.push(await writeImmutableJson(output, "21-response-http.json", http));
    await writeImmutableJson(output, "29-review-required.json", {
      schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
      artifact: "review-required",
      probe_id: authority.probe_id,
      observed_at: observedAt,
      outcome: "REVIEW_REQUIRED",
      reason_code: failureCode(error),
      retry_allowed: false,
      http_calls: actual,
      report_create_posts: 0,
      listing_content_writes: 0,
      model_calls: 0,
      database_calls: 0,
    });
    throw error;
  }

  const responseArtifact = inventory.find((entry) => entry.path === "20-response-raw.bytes");
  const http = {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "response-http",
    probe_id: authority.probe_id,
    observed_at: observedAt,
    status: response.status,
    safe_response_headers: validated.headers,
    raw_response_byte_length: response.body.byteLength,
    raw_response_sha256: responseArtifact.sha256,
    request_correlation_id_sha256: correlationSha,
    validation_error_code: null,
  };
  const httpArtifact = await writeImmutableJson(output, "21-response-http.json", http);
  inventory.push(httpArtifact);
  const seal = {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "exchange-seal",
    probe_id: authority.probe_id,
    authority_sha256: inventory[0].sha256,
    reservation_sha256: inventory[1].sha256,
    raw_response_sha256: responseArtifact.sha256,
    http_metadata_sha256: httpArtifact.sha256,
    exchange_sha256: sha256(canonicalBytes({
      authority_sha256: inventory[0].sha256,
      reservation_sha256: inventory[1].sha256,
      raw_response_sha256: responseArtifact.sha256,
      http_metadata_sha256: httpArtifact.sha256,
    })),
  };
  inventory.push(await writeImmutableJson(output, "22-exchange-seal.json", seal));
  const result = {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "result",
    probe_id: authority.probe_id,
    completed_at: clockNow(injected),
    outcome: validated.outcome,
    absence_proven_for_exact_query: validated.outcome === "ABSENCE_ONLY",
    stop_required: validated.outcome !== "ABSENCE_ONLY",
    response: {
      page: validated.parsed.page,
      total_count: validated.parsed.totalCount,
      limit: validated.parsed.limit,
      request_count: validated.parsed.requests.length,
      next_cursor_present: validated.cursor_present,
    },
    http_calls: actual,
    report_create_posts: 0,
    retries: 0,
    cursor_calls: 0,
    listing_content_writes: 0,
    model_calls: 0,
    database_calls: 0,
    evidence_inventory: inventory,
    evidence_family_sha256: sha256(canonicalBytes(inventory)),
  };
  const resultArtifact = await writeImmutableJson(output, "30-result.json", result);
  return {
    mode: "EXECUTED",
    output,
    outcome: result.outcome,
    absence_proven_for_exact_query: result.absence_proven_for_exact_query,
    stop_required: result.stop_required,
    result_artifact: resultArtifact,
    evidence_family_sha256: result.evidence_family_sha256,
    network_calls: actual.oauth_token_posts + actual.report_requests_gets,
    http_calls: actual,
    report_create_posts: 0,
    retries: 0,
    listing_content_writes: 0,
    model_calls: 0,
    database_calls: 0,
  };
}

async function inspectProbe(input, injected) {
  const { output } = await validateOutputPath(
    input.out,
    injected.allowed_output_root ?? DEFAULT_OUTPUT_ROOT,
    false,
  );
  await assertPrivateRealDirectory(output, "probe output");
  const names = (await readdir(output)).sort();
  const terminal = names.includes("30-result.json")
    ? "COMPLETED"
    : names.includes("29-review-required.json")
      ? "REVIEW_REQUIRED"
      : names.includes("19-terminal-failure.json")
        ? "AMBIGUOUS_GET_OUTCOME"
        : "INCOMPLETE";
  return {
    mode: "INSPECT",
    output,
    terminal,
    files: names,
    network_calls: 0,
    filesystem_writes: 0,
    report_create_posts: 0,
    listing_content_writes: 0,
  };
}

async function verifyProbe(input, injected) {
  const { output } = await validateOutputPath(
    input.out,
    injected.allowed_output_root ?? DEFAULT_OUTPUT_ROOT,
    false,
  );
  await assertPrivateRealDirectory(output, "probe output");
  const expectedNames = [
    "00-probe-authority.json",
    "10-get-reserved.json",
    "20-response-raw.bytes",
    "21-response-http.json",
    "22-exchange-seal.json",
    "30-result.json",
  ];
  const actualNames = (await readdir(output)).sort();
  assertCanonicalEqual(actualNames, expectedNames, "completed evidence inventory");
  const [authorityBytes, reservationBytes, responseBytes, httpBytes, sealBytes, resultBytes] =
    await Promise.all(expectedNames.map((name) => readStableArtifact(output, name)));
  const authority = parseCanonicalArtifact(authorityBytes, expectedNames[0]);
  const reservation = parseCanonicalArtifact(reservationBytes, expectedNames[1]);
  const http = parseCanonicalArtifact(httpBytes, expectedNames[3]);
  const seal = parseCanonicalArtifact(sealBytes, expectedNames[4]);
  const result = parseCanonicalArtifact(resultBytes, expectedNames[5]);
  const probeId = path.basename(output);
  const expectedFingerprint = injected.expected_account_fingerprint_for_test
    ?? EXPECTED_ACCOUNT_FINGERPRINT;
  const correlationId = exactString(
    authority?.request?.request_correlation_id,
    "authority correlation ID",
    128,
  );
  const correlationSha = sha256(Buffer.from(correlationId, "utf8"));
  const createdAt = exactInstant(authority.created_at, "authority created_at");
  assertCanonicalEqual(authority, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "probe-authority",
    probe_id: probeId,
    created_at: createdAt,
    account_scope: {
      channel: "WALMART_US",
      store_index: EXPECTED_STORE_INDEX,
      seller_id: EXPECTED_SELLER_ID,
      seller_account_fingerprint_sha256: expectedFingerprint,
    },
    request: {
      method: "GET",
      endpoint: API_ENDPOINT,
      query: { ...EXACT_QUERY },
      request_correlation_id: correlationId,
      request_correlation_id_sha256: correlationSha,
    },
    budget: {
      oauth_token_posts_maximum: 1,
      report_requests_gets_maximum: 1,
      report_create_posts_maximum: 0,
      retries_allowed: 0,
      redirects_allowed: 0,
      cursor_calls_allowed: 0,
      listing_content_writes_allowed: 0,
      model_calls_allowed: 0,
      database_calls_allowed: 0,
    },
  }, "probe authority");
  const reservedAt = exactInstant(reservation.reserved_at, "reservation reserved_at");
  assertCanonicalEqual(reservation, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "get-reservation",
    probe_id: probeId,
    reserved_at: reservedAt,
    authority_sha256: sha256(authorityBytes),
    request_sha256: sha256(canonicalBytes(fixedRequest(correlationId))),
    state: "GET_RESERVED",
    retry_allowed: false,
  }, "GET reservation");
  const observedAt = exactInstant(http.observed_at, "HTTP observed_at");
  const safeHeaders = http.safe_response_headers;
  if (!safeHeaders || typeof safeHeaders !== "object" || Array.isArray(safeHeaders)) {
    fail("INVALID_ARTIFACT", "HTTP safe_response_headers is invalid");
  }
  assertCanonicalEqual(http, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "response-http",
    probe_id: probeId,
    observed_at: observedAt,
    status: 200,
    safe_response_headers: safeHeaders,
    raw_response_byte_length: responseBytes.byteLength,
    raw_response_sha256: sha256(responseBytes),
    request_correlation_id_sha256: correlationSha,
    validation_error_code: null,
  }, "HTTP metadata");
  const validated = validateResponse({
    status: http.status,
    headers: safeHeaders,
    body: Uint8Array.from(responseBytes),
  });
  const artifacts = [
    { path: expectedNames[0], byte_length: authorityBytes.byteLength, sha256: sha256(authorityBytes) },
    { path: expectedNames[1], byte_length: reservationBytes.byteLength, sha256: sha256(reservationBytes) },
    { path: expectedNames[2], byte_length: responseBytes.byteLength, sha256: sha256(responseBytes) },
    { path: expectedNames[3], byte_length: httpBytes.byteLength, sha256: sha256(httpBytes) },
  ];
  const sealPreimage = {
    authority_sha256: artifacts[0].sha256,
    reservation_sha256: artifacts[1].sha256,
    raw_response_sha256: artifacts[2].sha256,
    http_metadata_sha256: artifacts[3].sha256,
  };
  assertCanonicalEqual(seal, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "exchange-seal",
    probe_id: probeId,
    ...sealPreimage,
    exchange_sha256: sha256(canonicalBytes(sealPreimage)),
  }, "exchange seal");
  artifacts.push({
    path: expectedNames[4],
    byte_length: sealBytes.byteLength,
    sha256: sha256(sealBytes),
  });
  const completedAt = exactInstant(result.completed_at, "result completed_at");
  assertCanonicalEqual(result, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
    artifact: "result",
    probe_id: probeId,
    completed_at: completedAt,
    outcome: validated.outcome,
    absence_proven_for_exact_query: validated.outcome === "ABSENCE_ONLY",
    stop_required: validated.outcome !== "ABSENCE_ONLY",
    response: {
      page: validated.parsed.page,
      total_count: validated.parsed.totalCount,
      limit: validated.parsed.limit,
      request_count: validated.parsed.requests.length,
      next_cursor_present: validated.cursor_present,
    },
    http_calls: {
      oauth_token_posts: 1,
      report_requests_gets: 1,
      presigned_file_calls: 0,
    },
    report_create_posts: 0,
    retries: 0,
    cursor_calls: 0,
    listing_content_writes: 0,
    model_calls: 0,
    database_calls: 0,
    evidence_inventory: artifacts,
    evidence_family_sha256: sha256(canonicalBytes(artifacts)),
  }, "probe result");
  if (!(Date.parse(createdAt) <= Date.parse(reservedAt)
    && Date.parse(reservedAt) <= Date.parse(observedAt)
    && Date.parse(observedAt) <= Date.parse(completedAt))) {
    fail("INVALID_CHRONOLOGY", "probe artifact chronology is invalid");
  }
  if (validated.outcome !== "ABSENCE_ONLY") {
    fail("ABSENCE_NOT_PROVEN", "probe did not prove exact-query absence");
  }
  return {
    mode: "VERIFIED",
    output,
    outcome: "ABSENCE_ONLY",
    exact_query_absence_verified: true,
    observed_at: observedAt,
    fresh_until: new Date(Date.parse(observedAt) + 24 * 60 * 60 * 1000).toISOString(),
    evidence_family_sha256: result.evidence_family_sha256,
    result_artifact_sha256: sha256(resultBytes),
    network_calls: 0,
    filesystem_writes: 0,
    report_create_posts: 0,
    listing_content_writes: 0,
    model_calls: 0,
    database_calls: 0,
  };
}

export async function runWalmartItemV6AbsenceProbeCli(argv, injected = {}) {
  const { command, values } = parseArgs(argv);
  if (command === "help" || command === "--help") {
    requireExactOptions(values, []);
    return {
      schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_SCHEMA,
      commands: ["plan", "execute", "inspect", "verify"],
      confirmation: CONFIRMATION,
      exact_query: { ...EXACT_QUERY },
      report_create_available: false,
    };
  }
  if (command === "plan") {
    requireExactOptions(values, ["store-index", "out"]);
    const storeIndex = parseStoreIndex(values.get("store-index"));
    const out = exactAbsolute(values.get("out"), "--out");
    await validateOutputPath(out, injected.allowed_output_root ?? DEFAULT_OUTPUT_ROOT);
    return {
      mode: "PLAN",
      store_index: storeIndex,
      out,
      exact_query: { ...EXACT_QUERY },
      live_requires: `execute + --confirm=${CONFIRMATION}`,
      allowed_network_operations: [
        "POST https://marketplace.walmartapis.com/v3/token",
        "GET https://marketplace.walmartapis.com/v3/reports/reportRequests",
      ],
      maximum_http_calls: 2,
      report_create_posts: 0,
      retries: 0,
      cursor_calls: 0,
      listing_content_writes: 0,
      model_calls: 0,
      database_calls: 0,
      network_calls: 0,
      filesystem_writes: 0,
    };
  }
  if (command === "execute") {
    requireExactOptions(values, ["store-index", "out", "confirm"]);
    const storeIndex = parseStoreIndex(values.get("store-index"));
    if (values.get("confirm") !== CONFIRMATION) {
      fail("CONFIRMATION_MISMATCH", "exact one-shot confirmation is required");
    }
    return executeProbe({
      store_index: storeIndex,
      out: exactAbsolute(values.get("out"), "--out"),
    }, injected);
  }
  if (command === "inspect") {
    requireExactOptions(values, ["out"]);
    return inspectProbe({ out: exactAbsolute(values.get("out"), "--out") }, injected);
  }
  if (command === "verify") {
    requireExactOptions(values, ["out"]);
    return verifyProbe({ out: exactAbsolute(values.get("out"), "--out") }, injected);
  }
  fail("INVALID_CLI", "command must be plan, execute, inspect, verify, or help");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runWalmartItemV6AbsenceProbeCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${canonicalWalmartItemReportJson(result)}\n`),
    (error) => {
      const code = typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR";
      const message = error instanceof Error ? error.message : "absence probe failed";
      process.stderr.write(`${canonicalWalmartItemReportJson({ ok: false, error_code: code, message })}\n`);
      process.exitCode = 1;
    },
  );
}

export const WALMART_ITEM_V6_ABSENCE_PROBE_DEFAULT_OUTPUT_ROOT = DEFAULT_OUTPUT_ROOT;
export const WALMART_ITEM_V6_ABSENCE_PROBE_CONFIRMATION = CONFIRMATION;
export const WALMART_ITEM_V6_ABSENCE_PROBE_EXACT_QUERY = EXACT_QUERY;
