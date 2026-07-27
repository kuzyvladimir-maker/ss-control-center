/**
 * Fail-closed, read-only reviewer for the independent Walmart ITEM v6
 * disposition probe and the quarantined ambiguous-create session.
 *
 * This module never contacts Walmart, reads credentials, mutates either input
 * root, or authorizes a replacement POST.  It converts one exact, incident-
 * specific evidence set into a canonical source-evidence release whose limits
 * and residual uncertainty are explicit.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  walmartItemReportSha256,
} from "./item-report-published-source.ts";
import { parseWalmartItemReportReissueSessionAuthority } from "./item-report-reissue-permit.ts";

export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA =
  "walmart-item-report-reissue-source-evidence/v2" as const;
export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY =
  "walmart-item-v6-independent-disposition-probe/2.0.0" as const;
export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS =
  24 * 60 * 60 * 1000;

const EXPECTED_EVIDENCE_ROOT_NAME =
  "item-v6-disposition-probe-store1-20260719-claude-v1";
const EXPECTED_PRIOR_SESSION_NAME = "item-v6-store1-20260718-codex-v1";
const EXPECTED_RELEASE_ID =
  "walmart-item-v6-reissue-source-evidence-store1-20260719-v2";
const EXPECTED_EMPTY_RESPONSE =
  '{"page":1,"totalCount":0,"limit":0,"requests":[]}';
const EXACT_QUERY = Object.freeze({
  reportType: "ITEM",
  reportVersion: "v6",
  src: "API",
  requestSubmissionStartDate: "2026-07-19T03:55:00Z",
  requestSubmissionEndDate: "2026-07-19T04:00:00Z",
});
const EXPECTED_ACCOUNT = Object.freeze({
  channel: "WALMART_US" as const,
  store_index: 1,
  seller_id: "10001624309",
  seller_account_fingerprint_sha256:
    "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127",
});

interface ExpectedFile {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

function freezeExpectedFiles(files: ExpectedFile[]): readonly ExpectedFile[] {
  return Object.freeze(files.map((entry) => Object.freeze(entry)));
}

const PROBE_FILES: readonly ExpectedFile[] = freezeExpectedFiles([
  {
    path: "broad-48h/report-requests-48h.json",
    byte_length: 4893,
    sha256: "9ebc02e7db35eb468fb7d76d34347a70bd965d63367654503b79c4fa8ed3fc55",
  },
  {
    path: "broad-48h/sanitized-request-metadata.json",
    byte_length: 3771,
    sha256: "fcec6a53e27e75286af67997f9ce965cd33598ec41719c36f4586309b68c2f5e",
  },
  {
    path: "exact-v6/request-manifest.json",
    byte_length: 1703,
    sha256: "e233a428a53657b2f835dc61cd48d463e7e9495c5d0fd81b6f981a74d04d9fe0",
  },
  {
    path: "exact-v6/response-raw.bytes",
    byte_length: 49,
    sha256: "fe1f5edce085101e740636b9a577fa1bdee5c36c33c4971f743cb18933249873",
  },
  {
    path: "exact-v6/parsed-summary.json",
    byte_length: 221,
    sha256: "c5b036d462cf9f8fb71e3323872c17b81855b95f7bc152542fd413422c40a385",
  },
  {
    path: "exact-v6/sanitized-http-metadata.json",
    byte_length: 2239,
    sha256: "236f4ec40c2b0d84007689c45bd537a7b354e92d198c9aac0897910bd12ac4ef",
  },
]);

const QUARANTINE_FILES: readonly ExpectedFile[] = freezeExpectedFiles([
  {
    path: "capture/10-create-request-manifest.json",
    byte_length: 494,
    sha256: "fdd21b9cd0028845d96d0b395443195334d37dfbd0809ac75a44931fe85011b9",
  },
  {
    path: "capture/60-item-request-reconcile-8e1f6dc39d35a577f7620c9b-scope.json",
    byte_length: 1516,
    sha256: "be7c292fed5080d1fad8d6c426f19abdb950d02762af6f2201f27e602332a83e",
  },
  {
    path: "capture/61-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-request.json",
    byte_length: 944,
    sha256: "28730ec71da8a73ba9dd4da95bfcbcf9d667342e737668311c12333c40841636",
  },
  {
    path: "capture/62-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-response.bin",
    byte_length: 49,
    sha256: "fe1f5edce085101e740636b9a577fa1bdee5c36c33c4971f743cb18933249873",
  },
  {
    path: "capture/63-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-http.json",
    byte_length: 1718,
    sha256: "9eb0d689c7b9529ade16c232f76ea0a4dfae8213c146287ee634a770cb2139f3",
  },
  {
    path: "checkpoints/10-request-reserved.json",
    byte_length: 367,
    sha256: "21a099d748e9efa214c251c44f708412a8094932f226a2095314eda817ae6eb9",
  },
  {
    path: "checkpoints/19-request-manual-review.json",
    byte_length: 215,
    sha256: "91db33f675c07f8b91fe56f33d2d447cf2510d43d48a157778bb4058b900eeb2",
  },
  {
    path: "checkpoints/61-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-reserved.json",
    byte_length: 436,
    sha256: "e683f64efe56a02dec2a9b4ec138c539d302289f9e215854b007f8e345b6ba58",
  },
  {
    path: "checkpoints/64-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-failed.json",
    byte_length: 273,
    sha256: "edec40ff96882f659d18b4d3b1e1a4d8407f78f22f6ac126fd8f97f214afb3fc",
  },
  {
    path: "checkpoints/65-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-complete.json",
    byte_length: 694,
    sha256: "5f84cc242d13d906595d4ae44594834ab9cd628c919bb8ea7192af90008ee011",
  },
  {
    path: "checkpoints/69-item-request-reconcile-8e1f6dc39d35a577f7620c9b-complete.json",
    byte_length: 388,
    sha256: "d2b1aef9e5d0fc6be9b6e5d5ef3b73a43a5ab27e14589fedeec34b2773a063a4",
  },
  {
    path: "trusted/00-session-authority.json",
    byte_length: 1019,
    sha256: "ec2072fce757fabb0c7cb4ef8e995c9df7be46c127a9c618334aded0a9dcd86e",
  },
  {
    path: "trusted/64-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-seal.json",
    byte_length: 621,
    sha256: "6ac19bcba7cc4314a14f12044c42da491fd2b96d9c785ce56e5f280173214db4",
  },
  {
    path: "trusted/68-item-request-reconcile-8e1f6dc39d35a577f7620c9b-result.json",
    byte_length: 2417,
    sha256: "d0a18766a6509d83467d9b8bac4def2e9c7551c9019c782fc46bd23f65950d1a",
  },
]);

const ORIGINAL_ABSENT_PATHS = Object.freeze([
  "capture/11-create-response.bin",
  "capture/12-create-response-http.json",
  "trusted/13-create-exchange-seal.json",
  "checkpoints/19-request-complete.json",
]);

type JsonRecord = Record<string, unknown>;

interface SecureArtifact {
  bytes: Uint8Array;
  byte_length: number;
  sha256: string;
}

export interface WalmartItemReportReissueSourceEvidenceV2Input {
  evidence_root: string;
  capture_root: string;
  prior_session_name: string;
  release_id: string;
  reviewed_at: string;
}

export interface WalmartItemReportReissueSourceEvidenceV2 {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA;
  body: JsonRecord;
  body_sha256: string;
  release_sha256: string;
}

export class WalmartItemReportReissueSourceEvidenceV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissueSourceEvidenceV2Error";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissueSourceEvidenceV2Error(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_EVIDENCE", `${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_EVIDENCE", `${label} has missing or extra fields`);
  }
}

function releaseExactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_RELEASE", `${label} has missing or extra fields`);
  }
}

function releaseRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_RELEASE", `${label} must be an object`);
  return value;
}

function exactString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_EVIDENCE", `${label} is invalid`);
  }
  return value;
}

function strictInstant(value: unknown, label: string): string {
  const instant = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)
    || !Number.isFinite(Date.parse(instant))
    || new Date(Date.parse(instant)).toISOString() !== instant) {
    fail("INVALID_EVIDENCE", `${label} must be canonical UTC milliseconds`);
  }
  return instant;
}

function strictSecondInstant(value: unknown, label: string): string {
  const instant = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(instant)
    || !Number.isFinite(Date.parse(instant))) {
    fail("INVALID_EVIDENCE", `${label} must be canonical UTC seconds`);
  }
  return instant;
}

function safeIdentifier(value: unknown, label: string): string {
  const parsed = exactString(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed)
    || parsed.includes("//") || parsed.endsWith("/")) {
    fail("INVALID_EVIDENCE", `${label} is not a safe identifier`);
  }
  return parsed;
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeMacAlias(absolutePath: string): string {
  if (process.platform !== "darwin") return absolutePath;
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]] as const) {
    if (absolutePath === alias || absolutePath.startsWith(`${alias}/`)) {
      return `${canonical}${absolutePath.slice(alias.length)}`;
    }
  }
  return absolutePath;
}

function exactAbsolutePath(value: unknown, label: string): string {
  const raw = exactString(value, label);
  if (!path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    fail("UNSAFE_PATH", `${label} must be an exact normalized absolute path`);
  }
  return normalizeMacAlias(raw);
}

function sameOpenFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function assertPrivateRealDirectory(directory: string, label: string): Promise<void> {
  const info = await lstat(directory).catch(() => fail("MISSING_EVIDENCE", `${label} is missing`));
  const permissions = info.mode & 0o777;
  if (!info.isDirectory() || info.isSymbolicLink() || (permissions & 0o077) !== 0
    || (permissions & 0o500) !== 0o500
    || await realpath(directory) !== directory) {
    fail(
      "UNSAFE_EVIDENCE_DIRECTORY",
      `${label} must be a private owner-readable/searchable real directory`,
    );
  }
}

async function secureRead(root: string, expected: ExpectedFile): Promise<SecureArtifact> {
  if (!/^(?:broad-48h|exact-v6|capture|checkpoints|trusted)\/[A-Za-z0-9][A-Za-z0-9._-]*$/u
    .test(expected.path)) {
    fail("UNSAFE_PATH", "evidence relative path is unsafe");
  }
  const absolute = path.join(root, expected.path);
  const parent = path.dirname(absolute);
  await assertPrivateRealDirectory(parent, `${expected.path} parent`);
  const pathBefore = await lstat(absolute).catch(() => fail(
    "MISSING_EVIDENCE",
    `${expected.path} is missing`,
  ));
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1
    || (pathBefore.mode & 0o777) !== 0o400 || pathBefore.size !== expected.byte_length) {
    fail("UNSAFE_EVIDENCE_FILE", `${expected.path} mode, link count, type, or size is unsafe`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(absolute, flags).catch(() => fail(
    "UNSAFE_EVIDENCE_FILE",
    `${expected.path} could not be opened without following links`,
  ));
  let bytes: Buffer;
  let before: Stats;
  let after: Stats;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o400
      || before.size !== expected.byte_length) {
      fail("UNSAFE_EVIDENCE_FILE", `${expected.path} opened identity is unsafe`);
    }
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(absolute).catch(() => fail(
    "EVIDENCE_READ_RACE",
    `${expected.path} disappeared during review`,
  ));
  if (bytes.byteLength !== expected.byte_length || !sameOpenFile(before, after)
    || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
    || !sameOpenFile(before, pathAfter)) {
    fail("EVIDENCE_READ_RACE", `${expected.path} changed while it was reviewed`);
  }
  const sha256 = sha256Bytes(bytes);
  if (sha256 !== expected.sha256) {
    fail("EVIDENCE_HASH_MISMATCH", `${expected.path} differs from the audited bytes`);
  }
  return { bytes: Uint8Array.from(bytes), byte_length: bytes.byteLength, sha256 };
}

async function inventory(root: string, directories: readonly string[]): Promise<string[]> {
  const output: string[] = [];
  for (const directory of directories) {
    const absolute = path.join(root, directory);
    await assertPrivateRealDirectory(absolute, `${directory} directory`);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail("UNEXPECTED_EVIDENCE_ENTRY", `${directory}/${entry.name} is not an allowed file`);
      }
      output.push(`${directory}/${entry.name}`);
    }
  }
  return output.sort();
}

function assertExactInventory(actual: readonly string[], expected: readonly ExpectedFile[]): void {
  const wanted = expected.map((entry) => entry.path).sort();
  if (canonicalWalmartItemReportJson(actual) !== canonicalWalmartItemReportJson(wanted)) {
    fail("UNEXPECTED_EVIDENCE_INVENTORY", "evidence root has a missing or extra artifact");
  }
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_EVIDENCE", `${label} is not UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    fail("INVALID_EVIDENCE", `${label} is not JSON`);
  }
  return record(value, label);
}

function exactQueryArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length !== 5) {
    fail("INVALID_EXACT_PROBE", `${label} must contain five ordered query fields`);
  }
  const expected = Object.entries(EXACT_QUERY).map(([key, queryValue]) => ({ [key]: queryValue }));
  if (canonicalWalmartItemReportJson(value) !== canonicalWalmartItemReportJson(expected)) {
    fail("INVALID_EXACT_PROBE", `${label} differs from the incident-bound ITEM v6 query`);
  }
}

function expectedFullUrl(): string {
  const query = new URLSearchParams(Object.entries(EXACT_QUERY));
  return `https://marketplace.walmartapis.com/v3/reports/reportRequests?${query.toString()}`;
}

function parseExactProbe(input: {
  request: SecureArtifact;
  response: SecureArtifact;
  summary: SecureArtifact;
  http: SecureArtifact;
}): {
  observed_at: string;
  fresh_until: string;
  request_correlation_id: string;
  x_request_id: string;
  created_at: string;
} {
  const request = parseJson(input.request.bytes, "exact request manifest");
  exactKeys(request, [
    "artifact", "created_at_utc", "external_effects_pledge", "network_budget",
    "operator", "planned_request", "purpose", "schema", "store_account",
  ], "exact request manifest");
  if (request.schema !== "walmart-source-intake-request-manifest/v1"
    || request.artifact !== "exact-v6") {
    fail("INVALID_EXACT_PROBE", "exact request manifest schema/artifact is invalid");
  }
  const createdAt = strictInstant(request.created_at_utc, "exact request created_at_utc");
  const store = record(request.store_account, "exact request store_account");
  if (store.store_index !== EXPECTED_ACCOUNT.store_index
    || store.seller_id !== EXPECTED_ACCOUNT.seller_id
    || store.marketplace !== EXPECTED_ACCOUNT.channel) {
    fail("ACCOUNT_SCOPE_MISMATCH", "exact probe store assertion differs from the incident account");
  }
  const planned = record(request.planned_request, "exact request planned_request");
  exactQueryArray(planned.query_ordered, "exact request planned query");
  if (planned.method !== "GET" || planned.endpoint !== "/v3/reports/reportRequests"
    || planned.base_url !== "https://marketplace.walmartapis.com"
    || planned.full_url !== expectedFullUrl()) {
    fail("INVALID_EXACT_PROBE", "exact planned request is not the fixed read-only endpoint");
  }
  const correlation = exactString(
    planned.wm_qos_correlation_id,
    "exact request correlation ID",
    128,
  );
  const budget = record(request.network_budget, "exact request network_budget");
  if (budget.oauth_token_post_max !== 1 || budget.report_requests_get !== 1
    || budget.report_create_post !== 0 || budget.retries !== 0 || budget.cursor_calls !== 0) {
    fail("INVALID_EXACT_PROBE", "exact request budget is not one GET with zero create/retry");
  }
  const effects = record(request.external_effects_pledge, "exact request external effects");
  if (effects.model_calls !== 0 || effects.db_writes !== 0
    || effects.walmart_content_writes !== 0 || effects.quarantined_session_touched !== false) {
    fail("INVALID_EXACT_PROBE", "exact request declared a forbidden external effect");
  }

  const responseText = new TextDecoder("utf-8", { fatal: true }).decode(input.response.bytes);
  if (responseText !== EXPECTED_EMPTY_RESPONSE) {
    fail("NOT_EXACT_ABSENCE_OBSERVATION", "exact raw response is not the literal empty sentinel");
  }
  const summary = parseJson(input.summary.bytes, "exact parsed summary");
  exactKeys(summary, [
    "http_status", "limit", "nextCursor_present", "page", "request_count",
    "schema", "source_raw_file", "totalCount",
  ], "exact parsed summary");
  if (summary.schema !== "walmart-source-intake-parsed-summary/v1"
    || summary.source_raw_file !== "response-raw.bytes" || summary.http_status !== 200
    || summary.page !== 1 || summary.limit !== 0 || summary.totalCount !== 0
    || summary.request_count !== 0 || summary.nextCursor_present !== false) {
    fail("NOT_EXACT_ABSENCE_OBSERVATION", "parsed summary differs from exact raw response");
  }

  const http = parseJson(input.http.bytes, "exact sanitized HTTP metadata");
  exactKeys(http, ["budget_actual", "get", "oauth", "schema", "stopped_without_retry"],
    "exact sanitized HTTP metadata");
  if (http.schema !== "walmart-source-intake-sanitized-http-metadata/v1"
    || http.stopped_without_retry !== false) {
    fail("INVALID_EXACT_PROBE", "exact HTTP metadata schema/terminal state is invalid");
  }
  const oauth = record(http.oauth, "exact HTTP OAuth metadata");
  const oauthAt = strictInstant(oauth.observed_at_utc, "OAuth observed_at_utc");
  if (oauth.method !== "POST" || oauth.endpoint !== "/v3/token"
    || oauth.http_status !== 200 || oauth.token_value_retained !== false) {
    fail("INVALID_EXACT_PROBE", "OAuth metadata is invalid");
  }
  const get = record(http.get, "exact HTTP GET metadata");
  exactQueryArray(get.query_ordered, "exact HTTP query");
  if (get.method !== "GET" || get.endpoint !== "/v3/reports/reportRequests"
    || get.full_url !== expectedFullUrl() || get.wm_qos_correlation_id !== correlation
    || get.http_status !== 200 || get.raw_body_file !== "response-raw.bytes"
    || get.raw_body_bytes !== input.response.byte_length) {
    fail("INVALID_EXACT_PROBE", "exact HTTP GET does not bind the manifest/raw response");
  }
  const observedAt = strictInstant(get.observed_at_utc, "GET observed_at_utc");
  if (!(Date.parse(createdAt) <= Date.parse(oauthAt)
    && Date.parse(oauthAt) <= Date.parse(observedAt))) {
    fail("INVALID_EXACT_PROBE", "manifest/OAuth/GET chronology is invalid");
  }
  const headers = record(get.safe_response_headers, "safe response headers");
  if (headers["content-length"] !== String(input.response.byte_length)
    || typeof headers["content-type"] !== "string"
    || !/^application\/json(?:\s*;|$)/iu.test(headers["content-type"] as string)) {
    fail("INVALID_EXACT_PROBE", "safe response headers do not bind the raw body");
  }
  const xRequestId = exactString(headers["x-request-id"], "x-request-id", 256);
  const actual = record(http.budget_actual, "exact HTTP actual budget");
  if (actual.oauth_token_posts !== 1 || actual.report_requests_gets !== 1
    || actual.retries !== 0 || actual.cursor_calls !== 0 || actual.report_create_posts !== 0) {
    fail("INVALID_EXACT_PROBE", "actual network budget differs from the one-shot read-only plan");
  }
  return {
    observed_at: observedAt,
    fresh_until: new Date(
      Date.parse(observedAt) + WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS,
    ).toISOString(),
    request_correlation_id: correlation,
    x_request_id: xRequestId,
    created_at: createdAt,
  };
}

function parseBroadProbe(reportBytes: Uint8Array, metadataBytes: Uint8Array): JsonRecord {
  const report = parseJson(reportBytes, "broad report envelope");
  exactKeys(report, ["pages", "window"], "broad report envelope");
  if (!Array.isArray(report.pages) || report.pages.length !== 1) {
    fail("INVALID_BROAD_PROBE", "broad report must retain exactly its one captured page");
  }
  const page = record(report.pages[0], "broad page 1");
  if (page.page !== 1 || page.totalCount !== 18 || page.limit !== 10
    || !Array.isArray(page.requests) || page.requests.length !== 10
    || typeof page.nextCursor !== "string") {
    fail("INVALID_BROAD_PROBE", "broad page inventory is invalid");
  }
  const submissionDates: number[] = [];
  for (const [index, raw] of page.requests.entries()) {
    const row = record(raw, `broad request ${index}`);
    if (row.reportType !== "ITEM" || row.reportVersion !== "v2" || row.src !== "API"
      || !new Set(["READY", "RECEIVED"]).has(String(row.requestStatus))) {
      fail("INVALID_BROAD_PROBE", "broad page contains a non-legacy or unexpected row");
    }
    submissionDates.push(Date.parse(strictSecondInstant(
      row.requestSubmissionDate,
      `broad request ${index} submission date`,
    )));
  }
  if (submissionDates.some((value, index) => index > 0 && value >= submissionDates[index - 1])
    || new Date(submissionDates[0]).toISOString() !== "2026-07-19T17:02:02.000Z"
    || new Date(submissionDates.at(-1)!).toISOString() !== "2026-07-18T15:01:50.000Z") {
    fail("INVALID_BROAD_PROBE", "broad rows are not the audited newest-first page");
  }
  const metadata = parseJson(metadataBytes, "broad sanitized request metadata");
  if (metadata.schema !== "walmart-source-intake-sanitized-request-metadata/v1"
    || metadata.artifact !== "broad-48h") {
    fail("INVALID_BROAD_PROBE", "broad metadata schema/artifact is invalid");
  }
  const facts = record(metadata.envelope_facts, "broad envelope facts");
  if (facts.sha256 !== PROBE_FILES[0].sha256 || facts.bytes !== PROBE_FILES[0].byte_length
    || facts.pages_captured !== 1 || facts.walmart_totalCount !== 18
    || facts.unique_requests_captured !== 10
    || typeof facts.not_raw_bytes_disclosure !== "string") {
    fail("INVALID_BROAD_PROBE", "broad metadata does not bind its serialized envelope/caveat");
  }
  const transport = record(metadata.transport, "broad transport metadata");
  if (!Array.isArray(transport.calls) || transport.calls.length !== 2
    || record(transport.calls[0], "broad call 1").http_status !== 200
    || record(transport.calls[1], "broad call 2").http_status !== 429
    || record(transport.calls[1], "broad call 2").attempts !== 5) {
    fail("INVALID_BROAD_PROBE", "broad transport retry/pagination disclosure is missing");
  }
  return {
    role: "CORROBORATING_ONLY",
    raw_http_bytes_retained: false,
    page_2_retained: false,
    reported_total_count: 18,
    retained_row_count: 10,
    retained_v6_row_count: 0,
    newest_submission_at: "2026-07-19T17:02:02.000Z",
    oldest_retained_submission_at: "2026-07-18T15:01:50.000Z",
    pagination_attempt_2_http_status: 429,
    pagination_attempt_2_transport_attempts: 5,
  };
}

async function assertAbsent(root: string, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const absolute = path.join(root, relativePath);
    const found = await lstat(absolute).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (found) fail("ORIGINAL_STATE_MUTATED", `${relativePath} must remain absent`);
  }
}

function parseOriginalSession(artifacts: Map<string, SecureArtifact>): JsonRecord {
  const authorityArtifact = artifacts.get("trusted/00-session-authority.json")!;
  const authority = parseWalmartItemReportReissueSessionAuthority(
    parseJson(authorityArtifact.bytes, "original SessionAuthority"),
  );
  if (authority.account_scope.channel !== EXPECTED_ACCOUNT.channel
    || authority.account_scope.store_index !== EXPECTED_ACCOUNT.store_index
    || authority.account_scope.seller_account_fingerprint_sha256
      !== EXPECTED_ACCOUNT.seller_account_fingerprint_sha256) {
    fail("ACCOUNT_SCOPE_MISMATCH", "original SessionAuthority account scope is unexpected");
  }
  const createArtifact = artifacts.get("capture/10-create-request-manifest.json")!;
  const create = parseJson(createArtifact.bytes, "original create manifest");
  const expectedCreate = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  if (canonicalWalmartItemReportJson(create)
    !== canonicalWalmartItemReportJson(expectedCreate)) {
    fail("INVALID_ORIGINAL_SESSION", "original create manifest differs from SessionAuthority");
  }
  const reservedArtifact = artifacts.get("checkpoints/10-request-reserved.json")!;
  const reserved = parseJson(reservedArtifact.bytes, "original request reservation");
  const reservedAt = strictInstant(reserved.observed_at, "original reservation observed_at");
  if (reserved.state !== "RESERVED" || reserved.phase !== "request" || reserved.attempt !== 1
    || reserved.post_attempt_limit !== 1
    || reserved.request_manifest_sha256 !== createArtifact.sha256
    || reserved.request_correlation_id_sha256 !== authority.primary_correlations.create.sha256) {
    fail("INVALID_ORIGINAL_SESSION", "original reservation does not bind the one POST attempt");
  }
  const manualArtifact = artifacts.get("checkpoints/19-request-manual-review.json")!;
  const manual = parseJson(manualArtifact.bytes, "original manual-review checkpoint");
  const manualAt = strictInstant(manual.observed_at, "original manual-review observed_at");
  if (manual.state !== "MANUAL_REVIEW" || manual.phase !== "request"
    || manual.reason_code !== "AMBIGUOUS_POST_NETWORK_OUTCOME"
    || manual.retry_forbidden !== true || Date.parse(manualAt) < Date.parse(reservedAt)) {
    fail("INVALID_ORIGINAL_SESSION", "original create attempt is not retry-forbidden ambiguous");
  }
  if (Date.parse(EXACT_QUERY.requestSubmissionStartDate) > Date.parse(reservedAt)
    || Date.parse(EXACT_QUERY.requestSubmissionEndDate) < Date.parse(manualAt)) {
    fail("EXACT_QUERY_WINDOW_MISMATCH", "independent exact query does not contain the ambiguous attempt");
  }
  return {
    session_name: EXPECTED_PRIOR_SESSION_NAME,
    session_id: authority.session_id,
    session_authority_sha256: authorityArtifact.sha256,
    create_manifest_sha256: createArtifact.sha256,
    request_reserved_sha256: reservedArtifact.sha256,
    manual_review_sha256: manualArtifact.sha256,
    reserved_at: reservedAt,
    manual_review_at: manualAt,
    create_request_correlation_id_sha256: authority.primary_correlations.create.sha256,
    terminal_page_failure_sha256:
      "edec40ff96882f659d18b4d3b1e1a4d8407f78f22f6ac126fd8f97f214afb3fc",
    prohibited_conflicting_page_complete_sha256:
      "5f84cc242d13d906595d4ae44594834ab9cd628c919bb8ea7192af90008ee011",
    prohibited_conflicting_result_sha256:
      "d0a18766a6509d83467d9b8bac4def2e9c7551c9019c782fc46bd23f65950d1a",
    prohibited_conflicting_complete_sha256:
      "d2b1aef9e5d0fc6be9b6e5d5ef3b73a43a5ab27e14589fedeec34b2773a063a4",
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    terminal_failure_supersedable: false,
    consume_conflicting_final: false,
  };
}

function expectedFile(
  files: readonly ExpectedFile[],
  expectedPath: string,
): ExpectedFile {
  const found = files.find((entry) => entry.path === expectedPath);
  if (!found) {
    throw new Error(`internal expected artifact is missing: ${expectedPath}`);
  }
  return found;
}

function expectedInventory(
  files: readonly ExpectedFile[],
  prefix?: string,
): JsonRecord[] {
  return files
    .filter((entry) => prefix === undefined || entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry }));
}

function assertReleaseInventory(
  value: unknown,
  expected: readonly ExpectedFile[],
  label: string,
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail("INVALID_RELEASE", `${label} does not contain the exact artifact inventory`);
  }
  for (const [index, expectedEntry] of expected.entries()) {
    const entry = releaseRecord(value[index], `${label}[${index}]`);
    releaseExactKeys(entry, ["byte_length", "path", "sha256"], `${label}[${index}]`);
    if (entry.path !== expectedEntry.path
      || entry.byte_length !== expectedEntry.byte_length
      || entry.sha256 !== expectedEntry.sha256) {
      fail("INVALID_RELEASE", `${label}[${index}] differs from the audited artifact`);
    }
  }
}

function assertReleaseConstantRecord(
  value: unknown,
  expected: JsonRecord,
  label: string,
): JsonRecord {
  const parsed = releaseRecord(value, label);
  releaseExactKeys(parsed, Object.keys(expected), label);
  if (canonicalWalmartItemReportJson(parsed) !== canonicalWalmartItemReportJson(expected)) {
    fail("INVALID_RELEASE", `${label} differs from the incident-bound contract`);
  }
  return parsed;
}

/**
 * Parse the complete release body before it can cross the trust boundary.
 *
 * The source artifacts are intentionally incident-specific and their bytes are
 * frozen above.  A valid self-hash only proves internal consistency, so every
 * security-relevant claim is independently constrained here as well: exact
 * keys, audited hashes/lengths/order, fixed query and result, terminal failure
 * semantics, residual risk, and the two separate owner gates.
 */
function parseWalmartItemReportReissueSourceEvidenceV2Body(value: unknown): JsonRecord {
  const body = releaseRecord(value, "source evidence release body");
  releaseExactKeys(body, [
    "account_scope",
    "broad_probe",
    "disposition_basis",
    "exact_probe",
    "original_ambiguous_post",
    "policy",
    "quarantined_session_inventory",
    "release_id",
    "reviewed_at",
  ], "source evidence release body");

  if (body.release_id !== EXPECTED_RELEASE_ID) {
    fail("INVALID_RELEASE", "source evidence release_id is not the incident-bound release");
  }
  const reviewedAt = strictInstant(body.reviewed_at, "source evidence reviewed_at");

  assertReleaseConstantRecord(body.policy, {
    policy_id: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY,
    maximum_exact_probe_age_ms: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS,
    exact_raw_response_required: true,
    exact_zero_result_required: true,
    broad_probe_role: "CORROBORATING_ONLY",
    terminal_failure_supersedable: false,
    quarantined_session_mutation_allowed: false,
    authorizes_replacement_post: false,
  }, "source evidence policy");

  assertReleaseConstantRecord(body.account_scope, {
    ...EXPECTED_ACCOUNT,
    exact_probe_account_match_basis: "OPERATOR_ASSERTION_NOT_MACHINE_VERIFIED",
    active_replacement_credentials_must_match_original_fingerprint: true,
  }, "source evidence account_scope");

  const sessionAuthority = expectedFile(
    QUARANTINE_FILES,
    "trusted/00-session-authority.json",
  );
  const createManifest = expectedFile(
    QUARANTINE_FILES,
    "capture/10-create-request-manifest.json",
  );
  const requestReserved = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/10-request-reserved.json",
  );
  const manualReview = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/19-request-manual-review.json",
  );
  const terminalPageFailure = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/64-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-failed.json",
  );
  const prohibitedPageComplete = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/65-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-complete.json",
  );
  const prohibitedResult = expectedFile(
    QUARANTINE_FILES,
    "trusted/68-item-request-reconcile-8e1f6dc39d35a577f7620c9b-result.json",
  );
  const prohibitedComplete = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/69-item-request-reconcile-8e1f6dc39d35a577f7620c9b-complete.json",
  );
  const original = assertReleaseConstantRecord(body.original_ambiguous_post, {
    session_name: EXPECTED_PRIOR_SESSION_NAME,
    session_id: "688864bd-e1f4-44fb-b97e-167060754931",
    session_authority_sha256: sessionAuthority.sha256,
    create_manifest_sha256: createManifest.sha256,
    request_reserved_sha256: requestReserved.sha256,
    manual_review_sha256: manualReview.sha256,
    reserved_at: "2026-07-19T03:57:17.129Z",
    manual_review_at: "2026-07-19T03:57:17.185Z",
    create_request_correlation_id_sha256:
      "14c61dfa0325d994fa1643369b63436bedb59c2d024ec6ccffceb22d2f7cc53b",
    terminal_page_failure_sha256: terminalPageFailure.sha256,
    prohibited_conflicting_page_complete_sha256: prohibitedPageComplete.sha256,
    prohibited_conflicting_result_sha256: prohibitedResult.sha256,
    prohibited_conflicting_complete_sha256: prohibitedComplete.sha256,
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    terminal_failure_supersedable: false,
    consume_conflicting_final: false,
  }, "source evidence original_ambiguous_post");
  strictInstant(original.reserved_at, "source evidence original reserved_at");
  strictInstant(original.manual_review_at, "source evidence original manual_review_at");

  assertReleaseInventory(
    body.quarantined_session_inventory,
    QUARANTINE_FILES,
    "source evidence quarantined_session_inventory",
  );

  const exactFiles = PROBE_FILES.filter((entry) => entry.path.startsWith("exact-v6/"));
  const rawResponse = expectedFile(PROBE_FILES, "exact-v6/response-raw.bytes");
  const exactProbe = releaseRecord(body.exact_probe, "source evidence exact_probe");
  releaseExactKeys(exactProbe, [
    "artifact_inventory",
    "created_at",
    "cursor_calls",
    "endpoint",
    "evidence_root_name",
    "fresh_until",
    "http_status",
    "limit",
    "method",
    "next_cursor_present",
    "oauth_token_posts",
    "observed_at",
    "page",
    "query",
    "raw_response_byte_length",
    "raw_response_sha256",
    "report_create_posts",
    "report_requests_gets",
    "request_correlation_id",
    "request_count",
    "retries",
    "total_count",
    "transport_authentication_limit",
    "walmart_x_request_id",
  ], "source evidence exact_probe");
  assertReleaseConstantRecord(exactProbe.query, { ...EXACT_QUERY }, "source evidence exact query");
  assertReleaseInventory(
    exactProbe.artifact_inventory,
    exactFiles,
    "source evidence exact_probe artifact_inventory",
  );
  const expectedExactProbe: JsonRecord = {
    evidence_root_name: EXPECTED_EVIDENCE_ROOT_NAME,
    created_at: "2026-07-19T23:13:20.842Z",
    observed_at: "2026-07-19T23:13:21.286Z",
    fresh_until: "2026-07-20T23:13:21.286Z",
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query: { ...EXACT_QUERY },
    request_correlation_id: "e79ba0dc-bd37-4323-9448-1e9a4b2a3df3",
    walmart_x_request_id: "33b6090e-79ec-435b-b435-a10a079a88a5",
    http_status: 200,
    raw_response_sha256: rawResponse.sha256,
    raw_response_byte_length: rawResponse.byte_length,
    page: 1,
    limit: 0,
    total_count: 0,
    request_count: 0,
    next_cursor_present: false,
    oauth_token_posts: 1,
    report_requests_gets: 1,
    report_create_posts: 0,
    retries: 0,
    cursor_calls: 0,
    artifact_inventory: expectedInventory(exactFiles),
    transport_authentication_limit:
      "OPERATOR_CUSTODY_METADATA_NO_WALMART_SIGNATURE_OR_TLS_TRANSCRIPT",
  };
  if (canonicalWalmartItemReportJson(exactProbe)
    !== canonicalWalmartItemReportJson(expectedExactProbe)) {
    fail("INVALID_RELEASE", "source evidence exact_probe differs from the audited probe");
  }
  const observedAt = strictInstant(exactProbe.observed_at, "source evidence exact observed_at");
  const freshUntil = strictInstant(exactProbe.fresh_until, "source evidence exact fresh_until");
  strictInstant(exactProbe.created_at, "source evidence exact created_at");
  if (Date.parse(freshUntil) - Date.parse(observedAt)
      !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS
    || Date.parse(reviewedAt) < Date.parse(observedAt)
    || Date.parse(reviewedAt) >= Date.parse(freshUntil)) {
    fail("INVALID_RELEASE", "source evidence review is outside the exact probe freshness window");
  }

  const broadFiles = PROBE_FILES.filter((entry) => entry.path.startsWith("broad-48h/"));
  const broadProbe = releaseRecord(body.broad_probe, "source evidence broad_probe");
  releaseExactKeys(broadProbe, [
    "artifact_inventory",
    "newest_submission_at",
    "oldest_retained_submission_at",
    "page_2_retained",
    "pagination_attempt_2_http_status",
    "pagination_attempt_2_transport_attempts",
    "raw_http_bytes_retained",
    "reported_total_count",
    "retained_row_count",
    "retained_v6_row_count",
    "role",
  ], "source evidence broad_probe");
  assertReleaseInventory(
    broadProbe.artifact_inventory,
    broadFiles,
    "source evidence broad_probe artifact_inventory",
  );
  const expectedBroadProbe: JsonRecord = {
    role: "CORROBORATING_ONLY",
    raw_http_bytes_retained: false,
    page_2_retained: false,
    reported_total_count: 18,
    retained_row_count: 10,
    retained_v6_row_count: 0,
    newest_submission_at: "2026-07-19T17:02:02.000Z",
    oldest_retained_submission_at: "2026-07-18T15:01:50.000Z",
    pagination_attempt_2_http_status: 429,
    pagination_attempt_2_transport_attempts: 5,
    artifact_inventory: expectedInventory(broadFiles),
  };
  if (canonicalWalmartItemReportJson(broadProbe)
    !== canonicalWalmartItemReportJson(expectedBroadProbe)) {
    fail("INVALID_RELEASE", "source evidence broad_probe differs from the audited probe");
  }
  strictInstant(broadProbe.newest_submission_at, "source evidence broad newest_submission_at");
  strictInstant(
    broadProbe.oldest_retained_submission_at,
    "source evidence broad oldest_retained_submission_at",
  );

  assertReleaseConstantRecord(body.disposition_basis, {
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    original_create_success_proven: false,
    original_create_failure_proven: false,
    independent_exact_absence_observed: true,
    exact_query_contains_original_ambiguous_attempt: true,
    original_request_id_adoption_allowed: false,
    original_session_reinterpretation_allowed: false,
    prohibited_conflicting_final_consumable: false,
    duplicate_replacement_request_risk: "NON_ZERO",
    owner_must_accept_account_binding_limit: true,
    owner_must_accept_transport_authentication_limit: true,
    owner_ed25519_disposition_required: true,
    separate_one_shot_execution_permit_required: true,
  }, "source evidence disposition_basis");

  return body;
}

function releasePreimage(body: JsonRecord, bodySha256: string): JsonRecord {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
    body,
    body_sha256: bodySha256,
  };
}

export function serializeWalmartItemReportReissueSourceEvidenceV2(
  release: WalmartItemReportReissueSourceEvidenceV2,
): Uint8Array {
  verifyWalmartItemReportReissueSourceEvidenceV2(release);
  return Buffer.from(canonicalWalmartItemReportJson(release), "utf8");
}

export function verifyWalmartItemReportReissueSourceEvidenceV2(
  value: unknown,
): WalmartItemReportReissueSourceEvidenceV2 {
  const raw = record(value, "source evidence release");
  exactKeys(raw, ["body", "body_sha256", "release_sha256", "schema_version"],
    "source evidence release");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA) {
    fail("INVALID_RELEASE", "source evidence release schema is invalid");
  }
  const body = record(raw.body, "source evidence release body");
  const bodySha256 = exactString(raw.body_sha256, "body_sha256", 64);
  const releaseSha256 = exactString(raw.release_sha256, "release_sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(bodySha256) || !/^[a-f0-9]{64}$/u.test(releaseSha256)
    || bodySha256 !== walmartItemReportSha256(body)
    || releaseSha256 !== walmartItemReportSha256(releasePreimage(body, bodySha256))) {
    fail("RELEASE_HASH_MISMATCH", "source evidence release hash binding is invalid");
  }
  const parsedBody = parseWalmartItemReportReissueSourceEvidenceV2Body(body);
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
    body: parsedBody,
    body_sha256: bodySha256,
    release_sha256: releaseSha256,
  };
}

export function parseWalmartItemReportReissueSourceEvidenceV2Bytes(
  bytes: Uint8Array,
): WalmartItemReportReissueSourceEvidenceV2 {
  const value = parseJson(bytes, "source evidence release bytes");
  const release = verifyWalmartItemReportReissueSourceEvidenceV2(value);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    !== canonicalWalmartItemReportJson(release)) {
    fail("NON_CANONICAL_RELEASE_BYTES", "source evidence release bytes are not canonical JSON");
  }
  return release;
}

export async function buildWalmartItemReportReissueSourceEvidenceV2(
  input: WalmartItemReportReissueSourceEvidenceV2Input,
): Promise<WalmartItemReportReissueSourceEvidenceV2> {
  const evidenceRoot = exactAbsolutePath(input.evidence_root, "evidence_root");
  const captureRoot = exactAbsolutePath(input.capture_root, "capture_root");
  if (path.basename(evidenceRoot) !== EXPECTED_EVIDENCE_ROOT_NAME
    || input.prior_session_name !== EXPECTED_PRIOR_SESSION_NAME) {
    fail("WRONG_INCIDENT_SCOPE", "input roots do not identify the exact reviewed incident");
  }
  await assertPrivateRealDirectory(evidenceRoot, "evidence_root");
  await assertPrivateRealDirectory(captureRoot, "capture_root");
  const priorSession = path.join(captureRoot, input.prior_session_name);
  await assertPrivateRealDirectory(priorSession, "prior quarantined session");

  assertExactInventory(await inventory(evidenceRoot, ["broad-48h", "exact-v6"]), PROBE_FILES);
  assertExactInventory(
    await inventory(priorSession, ["capture", "checkpoints", "trusted"]),
    QUARANTINE_FILES,
  );

  const probeArtifacts = new Map<string, SecureArtifact>();
  for (const expected of PROBE_FILES) {
    probeArtifacts.set(expected.path, await secureRead(evidenceRoot, expected));
  }
  const quarantineArtifacts = new Map<string, SecureArtifact>();
  for (const expected of QUARANTINE_FILES) {
    quarantineArtifacts.set(expected.path, await secureRead(priorSession, expected));
  }
  await assertAbsent(priorSession, ORIGINAL_ABSENT_PATHS);

  const exact = parseExactProbe({
    request: probeArtifacts.get("exact-v6/request-manifest.json")!,
    response: probeArtifacts.get("exact-v6/response-raw.bytes")!,
    summary: probeArtifacts.get("exact-v6/parsed-summary.json")!,
    http: probeArtifacts.get("exact-v6/sanitized-http-metadata.json")!,
  });
  const broad = parseBroadProbe(
    probeArtifacts.get("broad-48h/report-requests-48h.json")!.bytes,
    probeArtifacts.get("broad-48h/sanitized-request-metadata.json")!.bytes,
  );
  const original = parseOriginalSession(quarantineArtifacts);
  const reviewedAt = strictInstant(input.reviewed_at, "reviewed_at");
  if (Date.parse(reviewedAt) < Date.parse(exact.observed_at)
    || Date.parse(reviewedAt) >= Date.parse(exact.fresh_until)) {
    fail("STALE_EVIDENCE", "reviewed_at must fall inside the exact probe freshness window");
  }

  const body: JsonRecord = {
    release_id: safeIdentifier(input.release_id, "release_id"),
    reviewed_at: reviewedAt,
    policy: {
      policy_id: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY,
      maximum_exact_probe_age_ms:
        WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS,
      exact_raw_response_required: true,
      exact_zero_result_required: true,
      broad_probe_role: "CORROBORATING_ONLY",
      terminal_failure_supersedable: false,
      quarantined_session_mutation_allowed: false,
      authorizes_replacement_post: false,
    },
    account_scope: {
      ...EXPECTED_ACCOUNT,
      exact_probe_account_match_basis: "OPERATOR_ASSERTION_NOT_MACHINE_VERIFIED",
      active_replacement_credentials_must_match_original_fingerprint: true,
    },
    original_ambiguous_post: original,
    quarantined_session_inventory: QUARANTINE_FILES.map((entry) => ({ ...entry })),
    exact_probe: {
      evidence_root_name: EXPECTED_EVIDENCE_ROOT_NAME,
      created_at: exact.created_at,
      observed_at: exact.observed_at,
      fresh_until: exact.fresh_until,
      method: "GET",
      endpoint: "/v3/reports/reportRequests",
      query: { ...EXACT_QUERY },
      request_correlation_id: exact.request_correlation_id,
      walmart_x_request_id: exact.x_request_id,
      http_status: 200,
      raw_response_sha256: PROBE_FILES[3].sha256,
      raw_response_byte_length: PROBE_FILES[3].byte_length,
      page: 1,
      limit: 0,
      total_count: 0,
      request_count: 0,
      next_cursor_present: false,
      oauth_token_posts: 1,
      report_requests_gets: 1,
      report_create_posts: 0,
      retries: 0,
      cursor_calls: 0,
      artifact_inventory: PROBE_FILES.filter((entry) => entry.path.startsWith("exact-v6/"))
        .map((entry) => ({ ...entry })),
      transport_authentication_limit:
        "OPERATOR_CUSTODY_METADATA_NO_WALMART_SIGNATURE_OR_TLS_TRANSCRIPT",
    },
    broad_probe: {
      ...broad,
      artifact_inventory: PROBE_FILES.filter((entry) => entry.path.startsWith("broad-48h/"))
        .map((entry) => ({ ...entry })),
    },
    disposition_basis: {
      verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
      original_create_success_proven: false,
      original_create_failure_proven: false,
      independent_exact_absence_observed: true,
      exact_query_contains_original_ambiguous_attempt: true,
      original_request_id_adoption_allowed: false,
      original_session_reinterpretation_allowed: false,
      prohibited_conflicting_final_consumable: false,
      duplicate_replacement_request_risk: "NON_ZERO",
      owner_must_accept_account_binding_limit: true,
      owner_must_accept_transport_authentication_limit: true,
      owner_ed25519_disposition_required: true,
      separate_one_shot_execution_permit_required: true,
    },
  };
  const bodySha256 = walmartItemReportSha256(body);
  const releaseSha256 = walmartItemReportSha256(releasePreimage(body, bodySha256));
  return verifyWalmartItemReportReissueSourceEvidenceV2({
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
    body,
    body_sha256: bodySha256,
    release_sha256: releaseSha256,
  });
}

export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES =
  PROBE_FILES;
export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES =
  QUARANTINE_FILES;
