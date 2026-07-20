/**
 * Local, single-custody, fail-closed consumption ledger for one-shot Walmart
 * ITEM v6 reissue authorizations.
 *
 * This module deliberately has no network, credential, database, or model
 * imports.  An executor must durably reach REQUESTING through
 * consumeWalmartItemReportReissueAuthorizationV2() before its first OAuth or
 * marketplace call.  CLAIMED and every later state permanently burn the
 * authorization SHA; terminal outcomes are append-only observations and never
 * make an authorization replayable.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  canonicalWalmartItemReportJson,
} from "./item-report-published-source.ts";
import type {
  WalmartItemReportReissueConsumptionLedgerBindingV2,
} from "./item-report-reissue-owner-disposition-v2.ts";

export const WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA =
  "walmart-item-report-reissue-consumption-ledger-identity/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA =
  "walmart-item-report-reissue-authorization-claim/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA =
  "walmart-item-report-reissue-authorization-requesting/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA =
  "walmart-item-report-reissue-authorization-terminal/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA =
  "walmart-item-report-reissue-consumption-ledger-head/v1" as const;

const LEDGER_POLICY_ID =
  "walmart-item-report-reissue-consumption-ledger/1.0.0" as const;
const RESERVATION_FILENAME_POLICY =
  "authorization-sha256.json/exclusive-create/v1" as const;
const IDENTITY_FILE_NAME = ".ledger-identity.json";
const HEAD_FILE_NAME = ".ledger-head.json";
const HEAD_TEMP_FILE_PATTERN = /^\.ledger-head\.[0-9a-f-]+\.tmp$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;
const MAX_LEDGER_FILE_BYTES = 256 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESERVATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/u;
const REQUESTING_FILE_PATTERN = /^\.([a-f0-9]{64})\.requesting\.json$/u;
const TERMINAL_FILE_PATTERN = /^\.([a-f0-9]{64})\.terminal\.json$/u;

type JsonRecord = Record<string, unknown>;
type TerminalState = "SUCCEEDED" | "AMBIGUOUS" | "FAILED";

interface DirectoryCustody {
  directory: string;
  canonical_path: string;
  device: string;
  inode: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
}

interface LedgerIdentityBody extends JsonRecord {
  ledger_id: string;
  ledger_epoch: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
  created_at: string;
}

interface LedgerIdentityArtifact {
  schema_version:
    typeof WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA;
  body: LedgerIdentityBody;
  body_sha256: string;
}

interface ClaimArtifactBody extends JsonRecord {
  authorization_sha256: string;
  state: "CLAIMED";
  claim_id: string;
  claimed_at: string;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
}

interface ClaimArtifact {
  schema_version:
    typeof WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA;
  body: ClaimArtifactBody;
  body_sha256: string;
}

interface RequestingArtifactBody extends JsonRecord {
  authorization_sha256: string;
  state: "REQUESTING";
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  reservation_file_sha256: string;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
}

interface RequestingArtifact {
  schema_version:
    typeof WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA;
  body: RequestingArtifactBody;
  body_sha256: string;
}

interface TerminalArtifactBody extends JsonRecord {
  authorization_sha256: string;
  state: TerminalState;
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  terminal_at: string;
  reservation_file_sha256: string;
  requesting_file_sha256: string;
  http_status: number | null;
  response_body_sha256: string | null;
  report_request_id_sha256: string | null;
  error_code: string | null;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
}

interface TerminalArtifact {
  schema_version:
    typeof WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA;
  body: TerminalArtifactBody;
  body_sha256: string;
}

export interface LedgerHeadEvent extends JsonRecord {
  file_name: string;
  file_sha256: string;
  authorization_sha256: string;
  state: "CLAIMED" | "REQUESTING" | TerminalState;
}

interface LedgerHeadBody extends JsonRecord {
  identity_artifact_sha256: string;
  previous_head_artifact_sha256: string | null;
  event_count: number;
  events: LedgerHeadEvent[];
  events_sha256: string;
  updated_at: string;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

interface LedgerHeadArtifact {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA;
  body: LedgerHeadBody;
  body_sha256: string;
}

export interface WalmartItemReportReissueConsumptionLedgerHeadV2 {
  artifact_path: string;
  artifact_sha256: string;
  previous_head_artifact_sha256: string | null;
  event_count: number;
  events: LedgerHeadEvent[];
  events_sha256: string;
  updated_at: string;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

export interface WalmartItemReportReissueAuthorizationClaimReceiptV2 {
  authorization_sha256: string;
  state: "CLAIMED";
  claim_id: string;
  claimed_at: string;
  reservation_path: string;
  reservation_file_sha256: string;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
}

export interface WalmartItemReportReissueAuthorizationRequestingReceiptV2 {
  authorization_sha256: string;
  state: "REQUESTING";
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  reservation_path: string;
  reservation_file_sha256: string;
  requesting_path: string;
  requesting_file_sha256: string;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
}

export interface WalmartItemReportReissueAuthorizationTerminalOutcomeV2 {
  state: TerminalState;
  terminal_at: Date | string;
  http_status: number | null;
  response_body_sha256: string | null;
  report_request_id_sha256: string | null;
  error_code: string | null;
}

export interface WalmartItemReportReissueAuthorizationTerminalReceiptV2
  extends Omit<WalmartItemReportReissueAuthorizationRequestingReceiptV2, "state"> {
  state: TerminalState;
  terminal_at: string;
  terminal_path: string;
  terminal_file_sha256: string;
  http_status: number | null;
  response_body_sha256: string | null;
  report_request_id_sha256: string | null;
  error_code: string | null;
}

export type WalmartItemReportReissueAuthorizationLedgerEntryV2 =
  | WalmartItemReportReissueAuthorizationClaimReceiptV2
  | WalmartItemReportReissueAuthorizationRequestingReceiptV2
  | WalmartItemReportReissueAuthorizationTerminalReceiptV2;

export interface WalmartItemReportReissueConsumptionLedgerSnapshotV2 {
  state_directory: string;
  identity_artifact_path: string;
  binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
  head: WalmartItemReportReissueConsumptionLedgerHeadV2;
  authorizations: WalmartItemReportReissueAuthorizationLedgerEntryV2[];
}

export class WalmartItemReportReissueConsumptionLedgerV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissueConsumptionLedgerV2Error";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissueConsumptionLedgerV2Error(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("LEDGER_CORRUPT", `${label} must be an object`);
  return value;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
  code = "LEDGER_CORRUPT",
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} has missing or extra fields`);
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown, label: string, code = "INVALID_INPUT"): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(code, `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string, code = "LEDGER_CORRUPT"): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    fail(code, `${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeIdentifier(
  value: unknown,
  label: string,
  code = "INVALID_INPUT",
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200
    || value !== value.trim() || !SAFE_IDENTIFIER_PATTERN.test(value)
    || value.includes("//") || value.endsWith("/")) {
    fail(code, `${label} must be a safe identifier`);
  }
  return value;
}

function strictInstant(
  value: Date | string | undefined,
  label: string,
  fallback = new Date(),
): string {
  const text = value instanceof Date ? value.toISOString() : (value ?? fallback.toISOString());
  if (typeof text !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text)
    || !Number.isFinite(Date.parse(text))
    || new Date(Date.parse(text)).toISOString() !== text) {
    fail("INVALID_INPUT", `${label} must be canonical UTC milliseconds`);
  }
  return text;
}

function normalizedStateDirectory(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()) {
    fail("LEDGER_CUSTODY_INVALID", "state_directory must be a non-empty exact path");
  }
  const directory = path.resolve(value);
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root) {
    fail("LEDGER_CUSTODY_INVALID", "state_directory must be an absolute non-root path");
  }
  return directory;
}

function requiredNoFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_NOFOLLOW is required for ledger custody");
  }
  return fsConstants.O_NOFOLLOW;
}

function requiredDirectoryFlag(): number {
  if (typeof fsConstants.O_DIRECTORY !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_DIRECTORY is required for ledger custody");
  }
  return fsConstants.O_DIRECTORY;
}

function statIdentity(info: { dev: number | bigint; ino: number | bigint }): {
  device: string;
  inode: string;
} {
  return { device: String(info.dev), inode: String(info.ino) };
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameStableFileStat(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function inspectDirectoryCustody(value: string): Promise<DirectoryCustody> {
  const directory = normalizedStateDirectory(value);
  let pathBefore;
  try {
    pathBefore = await lstat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    fail(
      "LEDGER_CUSTODY_INVALID",
      `state directory cannot be inspected${code ? ` (${code})` : ""}`,
    );
  }
  if (!pathBefore.isDirectory() || pathBefore.isSymbolicLink()
    || (pathBefore.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("LEDGER_CUSTODY_INVALID", "state directory must be a real mode-0700 directory");
  }
  const canonicalBefore = await realpath(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory realpath cannot be resolved");
  });
  const flags = fsConstants.O_RDONLY | requiredNoFollowFlag() | requiredDirectoryFlag();
  let handle;
  try {
    handle = await open(directory, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    fail(
      "LEDGER_CUSTODY_INVALID",
      `state directory cannot be opened without following links${code ? ` (${code})` : ""}`,
    );
  }
  let descriptorInfo;
  try {
    descriptorInfo = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory changed while being inspected");
  });
  const canonicalAfter = await realpath(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory realpath changed while being inspected");
  });
  if (!descriptorInfo.isDirectory() || !sameFileIdentity(pathBefore, descriptorInfo)
    || !sameFileIdentity(descriptorInfo, pathAfter)
    || (descriptorInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || (pathAfter.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || canonicalBefore !== canonicalAfter) {
    fail("LEDGER_CUSTODY_INVALID", "state directory identity or mode is unstable");
  }
  const identity = statIdentity(descriptorInfo);
  return {
    directory,
    canonical_path: canonicalAfter,
    ...identity,
    state_directory_path_sha256: sha256(Buffer.from(canonicalAfter, "utf8")),
    directory_identity_sha256: sha256(Buffer.from(canonicalWalmartItemReportJson(identity), "utf8")),
  };
}

function assertSameDirectoryCustody(
  before: DirectoryCustody,
  after: DirectoryCustody,
): void {
  if (before.directory !== after.directory
    || before.canonical_path !== after.canonical_path
    || before.device !== after.device
    || before.inode !== after.inode
    || before.state_directory_path_sha256 !== after.state_directory_path_sha256
    || before.directory_identity_sha256 !== after.directory_identity_sha256) {
    fail("LEDGER_CUSTODY_INVALID", "state directory identity changed during ledger operation");
  }
}

async function fsyncDirectory(custody: DirectoryCustody): Promise<void> {
  const flags = fsConstants.O_RDONLY | requiredNoFollowFlag() | requiredDirectoryFlag();
  let handle;
  try {
    handle = await open(custody.directory, flags);
  } catch {
    fail("LEDGER_CUSTODY_INVALID", "state directory cannot be opened for fsync");
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || String(info.dev) !== custody.device
      || String(info.ino) !== custody.inode
      || (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      fail("LEDGER_CUSTODY_INVALID", "state directory changed before fsync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertSameDirectoryCustody(custody, await inspectDirectoryCustody(custody.directory));
}

interface BoundJsonFile {
  bytes: Buffer;
  value: unknown;
  sha256: string;
}

async function readBoundJsonFile(file: string, label: string): Promise<BoundJsonFile> {
  let pathBefore;
  try {
    pathBefore = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    fail("LEDGER_CORRUPT", `${label} cannot be inspected${code ? ` (${code})` : ""}`);
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1
    || (pathBefore.mode & 0o777) !== IMMUTABLE_FILE_MODE
    || pathBefore.size > MAX_LEDGER_FILE_BYTES) {
    fail(
      "LEDGER_CORRUPT",
      `${label} must be a mode-0400, nlink-1 regular file within its byte cap`,
    );
  }
  const flags = fsConstants.O_RDONLY | requiredNoFollowFlag();
  let handle;
  try {
    handle = await open(file, flags);
  } catch {
    fail("LEDGER_CORRUPT", `${label} cannot be opened without following links`);
  }
  let bytes;
  let before;
  let after;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || (before.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || !sameFileIdentity(pathBefore, before)) {
      fail("LEDGER_CORRUPT", `${label} descriptor custody is invalid`);
    }
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(file).catch(() => {
    fail("LEDGER_CORRUPT", `${label} disappeared while being read`);
  });
  if (!sameStableFileStat(before, after) || !sameFileIdentity(after, pathAfter)
    || pathAfter.nlink !== 1 || (pathAfter.mode & 0o777) !== IMMUTABLE_FILE_MODE
    || bytes.byteLength !== after.size) {
    fail("LEDGER_CORRUPT", `${label} changed while being read`);
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("LEDGER_CORRUPT", `${label} must contain valid UTF-8 JSON`);
  }
  const canonicalBytes = Buffer.from(`${canonicalWalmartItemReportJson(value)}\n`, "utf8");
  if (!Buffer.from(bytes).equals(canonicalBytes)) {
    fail("LEDGER_CORRUPT", `${label} bytes are not canonical`);
  }
  return { bytes: Buffer.from(bytes), value, sha256: sha256(bytes) };
}

async function writeExclusiveJsonFile(
  file: string,
  value: unknown,
  label: string,
): Promise<BoundJsonFile> {
  const bytes = Buffer.from(`${canonicalWalmartItemReportJson(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_LEDGER_FILE_BYTES) {
    fail("INVALID_INPUT", `${label} exceeds its byte cap`);
  }
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | requiredNoFollowFlag();
  let handle;
  try {
    handle = await open(file, flags, IMMUTABLE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw error;
    fail("LEDGER_CUSTODY_INVALID", `${label} cannot be exclusively created`);
  }
  try {
    await handle.writeFile(bytes);
    await handle.chmod(IMMUTABLE_FILE_MODE);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1
      || (info.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || info.size !== bytes.byteLength) {
      fail("LEDGER_CUSTODY_INVALID", `${label} created with unsafe custody`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const loaded = await readBoundJsonFile(file, label);
  if (!loaded.bytes.equals(bytes)) {
    fail("LEDGER_CORRUPT", `${label} exact bytes changed after exclusive create`);
  }
  return loaded;
}

function parseBinding(
  value: unknown,
  code = "LEDGER_BINDING_MISMATCH",
): WalmartItemReportReissueConsumptionLedgerBindingV2 {
  const raw = record(value, "consumption ledger binding");
  exactKeys(raw, [
    "directory_identity_sha256", "distributed_at_most_once_claimed",
    "identity_artifact_sha256", "ledger_epoch", "ledger_id", "policy_id",
    "reservation_filename_policy", "state_directory_path_sha256",
    "trusted_single_custody_host_only",
  ], "consumption ledger binding", code);
  if (raw.policy_id !== LEDGER_POLICY_ID
    || raw.reservation_filename_policy !== RESERVATION_FILENAME_POLICY
    || raw.trusted_single_custody_host_only !== true
    || raw.distributed_at_most_once_claimed !== false) {
    fail(code, "consumption ledger binding safety policy is invalid");
  }
  return {
    policy_id: LEDGER_POLICY_ID,
    ledger_id: safeIdentifier(raw.ledger_id, "ledger_id", code),
    ledger_epoch: safeIdentifier(raw.ledger_epoch, "ledger_epoch", code),
    state_directory_path_sha256: digest(raw.state_directory_path_sha256, "path SHA", code),
    directory_identity_sha256: digest(raw.directory_identity_sha256, "directory SHA", code),
    identity_artifact_sha256: digest(raw.identity_artifact_sha256, "identity artifact SHA", code),
    reservation_filename_policy: RESERVATION_FILENAME_POLICY,
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function parseIdentity(
  value: unknown,
  exactBytesSha256: string,
  custody: DirectoryCustody,
): LedgerIdentityArtifact {
  const raw = record(value, "ledger identity");
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "ledger identity");
  if (raw.schema_version
    !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA) {
    fail("LEDGER_CORRUPT", "ledger identity schema is invalid");
  }
  const bodyRaw = record(raw.body, "ledger identity body");
  exactKeys(bodyRaw, [
    "created_at", "directory_identity_sha256", "ledger_epoch", "ledger_id",
    "state_directory_path_sha256",
  ], "ledger identity body");
  const body: LedgerIdentityBody = {
    ledger_id: safeIdentifier(bodyRaw.ledger_id, "identity ledger_id", "LEDGER_CORRUPT"),
    ledger_epoch: safeIdentifier(
      bodyRaw.ledger_epoch,
      "identity ledger_epoch",
      "LEDGER_CORRUPT",
    ),
    state_directory_path_sha256: digest(
      bodyRaw.state_directory_path_sha256,
      "identity path SHA",
      "LEDGER_CORRUPT",
    ),
    directory_identity_sha256: digest(
      bodyRaw.directory_identity_sha256,
      "identity directory SHA",
      "LEDGER_CORRUPT",
    ),
    created_at: strictInstant(
      typeof bodyRaw.created_at === "string" ? bodyRaw.created_at : "",
      "identity created_at",
    ),
  };
  const bodySha = digest(raw.body_sha256, "identity body SHA", "LEDGER_CORRUPT");
  if (bodySha !== sha256(canonicalWalmartItemReportJson(body))
    || body.state_directory_path_sha256 !== custody.state_directory_path_sha256
    || body.directory_identity_sha256 !== custody.directory_identity_sha256) {
    fail("LEDGER_CUSTODY_INVALID", "ledger identity does not match directory custody");
  }
  digest(exactBytesSha256, "identity exact bytes SHA", "LEDGER_CORRUPT");
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA,
    body,
    body_sha256: bodySha,
  };
}

function bindingFromIdentity(
  identity: LedgerIdentityArtifact,
  identityArtifactSha256: string,
): WalmartItemReportReissueConsumptionLedgerBindingV2 {
  return {
    policy_id: LEDGER_POLICY_ID,
    ledger_id: identity.body.ledger_id,
    ledger_epoch: identity.body.ledger_epoch,
    state_directory_path_sha256: identity.body.state_directory_path_sha256,
    directory_identity_sha256: identity.body.directory_identity_sha256,
    identity_artifact_sha256: identityArtifactSha256,
    reservation_filename_policy: RESERVATION_FILENAME_POLICY,
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

function parseHeadEvent(value: unknown, index: number): LedgerHeadEvent {
  const raw = record(value, `ledger head event ${index}`);
  exactKeys(raw, [
    "authorization_sha256", "file_name", "file_sha256", "state",
  ], `ledger head event ${index}`);
  const fileName = typeof raw.file_name === "string" ? raw.file_name : "";
  const claim = RESERVATION_FILE_PATTERN.exec(fileName);
  const requesting = REQUESTING_FILE_PATTERN.exec(fileName);
  const terminal = TERMINAL_FILE_PATTERN.exec(fileName);
  const authorizationFromName = (claim ?? requesting ?? terminal)?.[1];
  const authorizationSha256 = digest(
    raw.authorization_sha256,
    `ledger head event ${index} authorization SHA`,
    "LEDGER_CORRUPT",
  );
  const state = raw.state;
  if (!authorizationFromName || authorizationFromName !== authorizationSha256
    || (claim && state !== "CLAIMED")
    || (requesting && state !== "REQUESTING")
    || (terminal && state !== "SUCCEEDED" && state !== "AMBIGUOUS" && state !== "FAILED")) {
    fail("LEDGER_CORRUPT", `ledger head event ${index} filename/state binding is invalid`);
  }
  return {
    file_name: fileName,
    file_sha256: digest(
      raw.file_sha256,
      `ledger head event ${index} file SHA`,
      "LEDGER_CORRUPT",
    ),
    authorization_sha256: authorizationSha256,
    state: state as LedgerHeadEvent["state"],
  };
}

function parseLedgerHead(
  value: unknown,
  artifactSha256: string,
  identityArtifactSha256: string,
  actualEvents: readonly LedgerHeadEvent[],
): LedgerHeadArtifact {
  const raw = record(value, "ledger head");
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "ledger head");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA) {
    fail("LEDGER_CORRUPT", "ledger head schema is invalid or legacy head is missing");
  }
  const bodyRaw = record(raw.body, "ledger head body");
  exactKeys(bodyRaw, [
    "at_most_once_scope", "distributed_at_most_once_claimed", "event_count", "events",
    "events_sha256", "hostile_same_uid_resistance_claimed", "identity_artifact_sha256",
    "previous_head_artifact_sha256", "updated_at",
  ], "ledger head body");
  if (!Array.isArray(bodyRaw.events)) fail("LEDGER_CORRUPT", "ledger head events must be an array");
  const events = bodyRaw.events.map(parseHeadEvent);
  const sorted = [...events].sort((left, right) => (
    left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0
  ));
  const previous = bodyRaw.previous_head_artifact_sha256 === null
    ? null
    : digest(
      bodyRaw.previous_head_artifact_sha256,
      "ledger previous head SHA",
      "LEDGER_CORRUPT",
    );
  const body: LedgerHeadBody = {
    identity_artifact_sha256: digest(
      bodyRaw.identity_artifact_sha256,
      "ledger head identity SHA",
      "LEDGER_CORRUPT",
    ),
    previous_head_artifact_sha256: previous,
    event_count: nonNegativeInteger(bodyRaw.event_count, "ledger head event_count"),
    events,
    events_sha256: digest(bodyRaw.events_sha256, "ledger head events SHA", "LEDGER_CORRUPT"),
    updated_at: strictInstant(
      typeof bodyRaw.updated_at === "string" ? bodyRaw.updated_at : "",
      "ledger head updated_at",
    ),
    at_most_once_scope: bodyRaw.at_most_once_scope === "INTACT_SINGLE_CUSTODY_DIRECTORY"
      ? "INTACT_SINGLE_CUSTODY_DIRECTORY"
      : fail("LEDGER_CORRUPT", "ledger head at-most-once scope is invalid"),
    hostile_same_uid_resistance_claimed:
      bodyRaw.hostile_same_uid_resistance_claimed === false
        ? false
        : fail("LEDGER_CORRUPT", "ledger head must not claim hostile same-UID resistance"),
    distributed_at_most_once_claimed: bodyRaw.distributed_at_most_once_claimed === false
      ? false
      : fail("LEDGER_CORRUPT", "ledger head must not claim distributed at-most-once"),
  };
  const bodySha = digest(raw.body_sha256, "ledger head body SHA", "LEDGER_CORRUPT");
  if (body.identity_artifact_sha256 !== identityArtifactSha256
    || body.event_count !== events.length
    || !exactJsonEqual(events, sorted)
    || new Set(events.map((event) => event.file_name)).size !== events.length
    || body.events_sha256 !== sha256(canonicalWalmartItemReportJson(events))
    || !exactJsonEqual(events, actualEvents)
    || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_ROLLBACK_OR_DELETION_DETECTED", "ledger head and event inventory differ");
  }
  digest(artifactSha256, "ledger head artifact SHA", "LEDGER_CORRUPT");
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA,
    body,
    body_sha256: bodySha,
  };
}

function buildLedgerHead(
  identityArtifactSha256: string,
  previousHeadArtifactSha256: string | null,
  events: readonly LedgerHeadEvent[],
  updatedAt: string,
): LedgerHeadArtifact {
  const sortedEvents = [...events].sort((left, right) => (
    left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0
  ));
  const body: LedgerHeadBody = {
    identity_artifact_sha256: identityArtifactSha256,
    previous_head_artifact_sha256: previousHeadArtifactSha256,
    event_count: sortedEvents.length,
    events: sortedEvents,
    events_sha256: sha256(canonicalWalmartItemReportJson(sortedEvents)),
    updated_at: updatedAt,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body)),
  };
}

function parseClaimArtifact(
  value: unknown,
  authorizationSha256: string,
  expectedBinding: WalmartItemReportReissueConsumptionLedgerBindingV2,
): ClaimArtifact {
  const raw = record(value, `authorization ${authorizationSha256} claim`);
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "claim artifact");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA) {
    fail("LEDGER_CORRUPT", "claim artifact schema is invalid");
  }
  const bodyRaw = record(raw.body, "claim artifact body");
  exactKeys(bodyRaw, [
    "authorization_sha256", "claim_id", "claimed_at", "consumption_ledger", "state",
  ], "claim artifact body");
  const body: ClaimArtifactBody = {
    authorization_sha256: digest(
      bodyRaw.authorization_sha256,
      "claim authorization SHA",
      "LEDGER_CORRUPT",
    ),
    state: bodyRaw.state === "CLAIMED"
      ? "CLAIMED"
      : fail("LEDGER_CORRUPT", "claim state must be CLAIMED"),
    claim_id: safeIdentifier(bodyRaw.claim_id, "claim_id", "LEDGER_CORRUPT"),
    claimed_at: strictInstant(
      typeof bodyRaw.claimed_at === "string" ? bodyRaw.claimed_at : "",
      "claimed_at",
    ),
    consumption_ledger: parseBinding(bodyRaw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  const bodySha = digest(raw.body_sha256, "claim body SHA", "LEDGER_CORRUPT");
  if (body.authorization_sha256 !== authorizationSha256
    || !exactJsonEqual(body.consumption_ledger, expectedBinding)
    || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_CORRUPT", "claim artifact binding or body SHA is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA,
    body,
    body_sha256: bodySha,
  };
}

function parseRequestingArtifact(
  value: unknown,
  authorizationSha256: string,
  expectedBinding: WalmartItemReportReissueConsumptionLedgerBindingV2,
  claim: ClaimArtifact,
  reservationFileSha256: string,
): RequestingArtifact {
  const raw = record(value, `authorization ${authorizationSha256} requesting fence`);
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "requesting artifact");
  if (raw.schema_version
    !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA) {
    fail("LEDGER_CORRUPT", "requesting artifact schema is invalid");
  }
  const bodyRaw = record(raw.body, "requesting artifact body");
  exactKeys(bodyRaw, [
    "authorization_sha256", "claim_id", "claimed_at", "consumption_ledger",
    "requesting_at", "reservation_file_sha256", "state",
  ], "requesting artifact body");
  const body: RequestingArtifactBody = {
    authorization_sha256: digest(
      bodyRaw.authorization_sha256,
      "requesting authorization SHA",
      "LEDGER_CORRUPT",
    ),
    state: bodyRaw.state === "REQUESTING"
      ? "REQUESTING"
      : fail("LEDGER_CORRUPT", "requesting state must be REQUESTING"),
    claim_id: safeIdentifier(bodyRaw.claim_id, "requesting claim_id", "LEDGER_CORRUPT"),
    claimed_at: strictInstant(
      typeof bodyRaw.claimed_at === "string" ? bodyRaw.claimed_at : "",
      "requesting claimed_at",
    ),
    requesting_at: strictInstant(
      typeof bodyRaw.requesting_at === "string" ? bodyRaw.requesting_at : "",
      "requesting_at",
    ),
    reservation_file_sha256: digest(
      bodyRaw.reservation_file_sha256,
      "requesting reservation file SHA",
      "LEDGER_CORRUPT",
    ),
    consumption_ledger: parseBinding(bodyRaw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  const bodySha = digest(raw.body_sha256, "requesting body SHA", "LEDGER_CORRUPT");
  if (body.authorization_sha256 !== authorizationSha256
    || body.claim_id !== claim.body.claim_id
    || body.claimed_at !== claim.body.claimed_at
    || Date.parse(body.requesting_at) < Date.parse(body.claimed_at)
    || body.reservation_file_sha256 !== reservationFileSha256
    || !exactJsonEqual(body.consumption_ledger, expectedBinding)
    || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_CORRUPT", "requesting artifact binding or body SHA is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA,
    body,
    body_sha256: bodySha,
  };
}

function nullableDigest(
  value: unknown,
  label: string,
  code = "INVALID_INPUT",
): string | null {
  return value === null ? null : digest(value, label, code);
}

function nullableErrorCode(
  value: unknown,
  label: string,
  code = "INVALID_INPUT",
): string | null {
  return value === null ? null : safeIdentifier(value, label, code);
}

function terminalState(
  value: unknown,
  label: string,
  code: string,
): TerminalState {
  if (value !== "SUCCEEDED" && value !== "AMBIGUOUS" && value !== "FAILED") {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function nullableHttpStatus(value: unknown, label: string, code: string): number | null {
  if (value !== null
    && (!Number.isSafeInteger(value) || typeof value !== "number" || value < 100 || value > 599)) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function parseTerminalArtifact(
  value: unknown,
  authorizationSha256: string,
  expectedBinding: WalmartItemReportReissueConsumptionLedgerBindingV2,
  claim: ClaimArtifact,
  requesting: RequestingArtifact,
  reservationFileSha256: string,
  requestingFileSha256: string,
): TerminalArtifact {
  const raw = record(value, `authorization ${authorizationSha256} terminal artifact`);
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "terminal artifact");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA) {
    fail("LEDGER_CORRUPT", "terminal artifact schema is invalid");
  }
  const bodyRaw = record(raw.body, "terminal artifact body");
  exactKeys(bodyRaw, [
    "authorization_sha256", "claim_id", "claimed_at", "consumption_ledger",
    "error_code", "http_status", "report_request_id_sha256", "requesting_at",
    "requesting_file_sha256", "reservation_file_sha256", "response_body_sha256",
    "state", "terminal_at",
  ], "terminal artifact body");
  const parsedTerminalState = terminalState(
    bodyRaw.state,
    "terminal state",
    "LEDGER_CORRUPT",
  );
  const httpStatus = nullableHttpStatus(
    bodyRaw.http_status,
    "terminal HTTP status",
    "LEDGER_CORRUPT",
  );
  const body: TerminalArtifactBody = {
    authorization_sha256: digest(
      bodyRaw.authorization_sha256,
      "terminal authorization SHA",
      "LEDGER_CORRUPT",
    ),
    state: parsedTerminalState,
    claim_id: safeIdentifier(bodyRaw.claim_id, "terminal claim_id", "LEDGER_CORRUPT"),
    claimed_at: strictInstant(
      typeof bodyRaw.claimed_at === "string" ? bodyRaw.claimed_at : "",
      "terminal claimed_at",
    ),
    requesting_at: strictInstant(
      typeof bodyRaw.requesting_at === "string" ? bodyRaw.requesting_at : "",
      "terminal requesting_at",
    ),
    terminal_at: strictInstant(
      typeof bodyRaw.terminal_at === "string" ? bodyRaw.terminal_at : "",
      "terminal_at",
    ),
    reservation_file_sha256: digest(
      bodyRaw.reservation_file_sha256,
      "terminal reservation file SHA",
      "LEDGER_CORRUPT",
    ),
    requesting_file_sha256: digest(
      bodyRaw.requesting_file_sha256,
      "terminal requesting file SHA",
      "LEDGER_CORRUPT",
    ),
    http_status: httpStatus,
    response_body_sha256: nullableDigest(
      bodyRaw.response_body_sha256,
      "terminal response body SHA",
      "LEDGER_CORRUPT",
    ),
    report_request_id_sha256: nullableDigest(
      bodyRaw.report_request_id_sha256,
      "terminal report request ID SHA",
      "LEDGER_CORRUPT",
    ),
    error_code: nullableErrorCode(
      bodyRaw.error_code,
      "terminal error_code",
      "LEDGER_CORRUPT",
    ),
    consumption_ledger: parseBinding(bodyRaw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  const bodySha = digest(raw.body_sha256, "terminal body SHA", "LEDGER_CORRUPT");
  if (body.authorization_sha256 !== authorizationSha256
    || body.claim_id !== claim.body.claim_id
    || body.claimed_at !== claim.body.claimed_at
    || body.requesting_at !== requesting.body.requesting_at
    || Date.parse(body.terminal_at) < Date.parse(body.requesting_at)
    || body.reservation_file_sha256 !== reservationFileSha256
    || body.requesting_file_sha256 !== requestingFileSha256
    || !exactJsonEqual(body.consumption_ledger, expectedBinding)
    || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_CORRUPT", "terminal artifact binding or body SHA is invalid");
  }
  if (body.state === "SUCCEEDED"
    && (body.http_status === null || body.http_status < 200 || body.http_status > 299
      || body.response_body_sha256 === null || body.report_request_id_sha256 === null
      || body.error_code !== null)) {
    fail("LEDGER_CORRUPT", "SUCCEEDED terminal evidence is incomplete");
  }
  if (body.state !== "SUCCEEDED" && body.error_code === null) {
    fail("LEDGER_CORRUPT", "non-success terminal evidence requires an error_code");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA,
    body,
    body_sha256: bodySha,
  };
}

function reservationPath(directory: string, authorizationSha256: string): string {
  return path.join(directory, `${authorizationSha256}.json`);
}

function requestingPath(directory: string, authorizationSha256: string): string {
  return path.join(directory, `.${authorizationSha256}.requesting.json`);
}

function terminalPath(directory: string, authorizationSha256: string): string {
  return path.join(directory, `.${authorizationSha256}.terminal.json`);
}

function claimReceipt(
  directory: string,
  artifact: ClaimArtifact,
  fileSha256: string,
): WalmartItemReportReissueAuthorizationClaimReceiptV2 {
  return {
    authorization_sha256: artifact.body.authorization_sha256,
    state: "CLAIMED",
    claim_id: artifact.body.claim_id,
    claimed_at: artifact.body.claimed_at,
    reservation_path: reservationPath(directory, artifact.body.authorization_sha256),
    reservation_file_sha256: fileSha256,
    consumption_ledger: artifact.body.consumption_ledger,
  };
}

function requestingReceipt(
  directory: string,
  claim: ClaimArtifact,
  claimFileSha256: string,
  artifact: RequestingArtifact,
  fileSha256: string,
): WalmartItemReportReissueAuthorizationRequestingReceiptV2 {
  return {
    authorization_sha256: artifact.body.authorization_sha256,
    state: "REQUESTING",
    claim_id: artifact.body.claim_id,
    claimed_at: artifact.body.claimed_at,
    requesting_at: artifact.body.requesting_at,
    reservation_path: reservationPath(directory, artifact.body.authorization_sha256),
    reservation_file_sha256: claimFileSha256,
    requesting_path: requestingPath(directory, artifact.body.authorization_sha256),
    requesting_file_sha256: fileSha256,
    consumption_ledger: claim.body.consumption_ledger,
  };
}

function terminalReceipt(
  requestingReceiptValue: WalmartItemReportReissueAuthorizationRequestingReceiptV2,
  artifact: TerminalArtifact,
  fileSha256: string,
): WalmartItemReportReissueAuthorizationTerminalReceiptV2 {
  return {
    ...requestingReceiptValue,
    state: artifact.body.state,
    terminal_at: artifact.body.terminal_at,
    terminal_path: terminalPath(
      path.dirname(requestingReceiptValue.reservation_path),
      artifact.body.authorization_sha256,
    ),
    terminal_file_sha256: fileSha256,
    http_status: artifact.body.http_status,
    response_body_sha256: artifact.body.response_body_sha256,
    report_request_id_sha256: artifact.body.report_request_id_sha256,
    error_code: artifact.body.error_code,
  };
}

interface ScannedAuthorization {
  claim: ClaimArtifact;
  claim_file_sha256: string;
  requesting: RequestingArtifact | null;
  requesting_file_sha256: string | null;
  terminal: TerminalArtifact | null;
  terminal_file_sha256: string | null;
}

async function scanAuthorizations(
  custody: DirectoryCustody,
  binding: WalmartItemReportReissueConsumptionLedgerBindingV2,
): Promise<Map<string, ScannedAuthorization>> {
  const namesBefore = (await readdir(custody.directory)).sort();
  const allowed = namesBefore.filter(
    (name) => name !== IDENTITY_FILE_NAME && name !== HEAD_FILE_NAME,
  );
  const claims = new Map<string, BoundJsonFile>();
  const requesting = new Map<string, BoundJsonFile>();
  const terminal = new Map<string, BoundJsonFile>();
  for (const name of allowed) {
    const claimMatch = RESERVATION_FILE_PATTERN.exec(name);
    const requestingMatch = REQUESTING_FILE_PATTERN.exec(name);
    const terminalMatch = TERMINAL_FILE_PATTERN.exec(name);
    if (!claimMatch && !requestingMatch && !terminalMatch) {
      fail("LEDGER_CORRUPT", `ledger contains unexpected entry: ${name}`);
    }
    const authorizationSha256 = (claimMatch ?? requestingMatch ?? terminalMatch)?.[1];
    if (!authorizationSha256) fail("LEDGER_CORRUPT", `ledger entry name is invalid: ${name}`);
    const target = claimMatch ? claims : (requestingMatch ? requesting : terminal);
    if (target.has(authorizationSha256)) {
      fail("LEDGER_CORRUPT", `ledger contains duplicate state for ${authorizationSha256}`);
    }
    target.set(
      authorizationSha256,
      await readBoundJsonFile(path.join(custody.directory, name), `ledger entry ${name}`),
    );
  }
  const namesAfter = (await readdir(custody.directory)).sort();
  if (!exactJsonEqual(namesBefore, namesAfter)) {
    fail("LEDGER_CHANGED_DURING_READ", "ledger inventory changed while being read");
  }
  assertSameDirectoryCustody(custody, await inspectDirectoryCustody(custody.directory));
  const result = new Map<string, ScannedAuthorization>();
  const allAuthorizationShas = [...new Set([
    ...claims.keys(), ...requesting.keys(), ...terminal.keys(),
  ])].sort();
  for (const authorizationSha256 of allAuthorizationShas) {
    const claimFile = claims.get(authorizationSha256);
    if (!claimFile) {
      fail("LEDGER_CORRUPT", `authorization ${authorizationSha256} has state without claim`);
    }
    const claim = parseClaimArtifact(claimFile.value, authorizationSha256, binding);
    const requestingFile = requesting.get(authorizationSha256) ?? null;
    const parsedRequesting = requestingFile
      ? parseRequestingArtifact(
        requestingFile.value,
        authorizationSha256,
        binding,
        claim,
        claimFile.sha256,
      )
      : null;
    const terminalFile = terminal.get(authorizationSha256) ?? null;
    if (terminalFile && !parsedRequesting) {
      fail("LEDGER_CORRUPT", `authorization ${authorizationSha256} is terminal without REQUESTING`);
    }
    const parsedTerminal = terminalFile && parsedRequesting && requestingFile
      ? parseTerminalArtifact(
        terminalFile.value,
        authorizationSha256,
        binding,
        claim,
        parsedRequesting,
        claimFile.sha256,
        requestingFile.sha256,
      )
      : null;
    result.set(authorizationSha256, {
      claim,
      claim_file_sha256: claimFile.sha256,
      requesting: parsedRequesting,
      requesting_file_sha256: requestingFile?.sha256 ?? null,
      terminal: parsedTerminal,
      terminal_file_sha256: terminalFile?.sha256 ?? null,
    });
  }
  return result;
}

function ledgerHeadEventsFromScan(
  scanned: ReadonlyMap<string, ScannedAuthorization>,
): LedgerHeadEvent[] {
  const events: LedgerHeadEvent[] = [];
  for (const [authorizationSha256, entry] of scanned.entries()) {
    events.push({
      file_name: path.basename(reservationPath("/", authorizationSha256)),
      file_sha256: entry.claim_file_sha256,
      authorization_sha256: authorizationSha256,
      state: "CLAIMED",
    });
    if (entry.requesting && entry.requesting_file_sha256) {
      events.push({
        file_name: path.basename(requestingPath("/", authorizationSha256)),
        file_sha256: entry.requesting_file_sha256,
        authorization_sha256: authorizationSha256,
        state: "REQUESTING",
      });
    }
    if (entry.terminal && entry.terminal_file_sha256) {
      events.push({
        file_name: path.basename(terminalPath("/", authorizationSha256)),
        file_sha256: entry.terminal_file_sha256,
        authorization_sha256: authorizationSha256,
        state: entry.terminal.body.state,
      });
    }
  }
  return events.sort((left, right) => (
    left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0
  ));
}

function ledgerHeadSnapshot(
  directory: string,
  artifact: LedgerHeadArtifact,
  artifactSha256: string,
): WalmartItemReportReissueConsumptionLedgerHeadV2 {
  return {
    artifact_path: path.join(directory, HEAD_FILE_NAME),
    artifact_sha256: artifactSha256,
    previous_head_artifact_sha256: artifact.body.previous_head_artifact_sha256,
    event_count: artifact.body.event_count,
    events: artifact.body.events,
    events_sha256: artifact.body.events_sha256,
    updated_at: artifact.body.updated_at,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
}

async function advanceLedgerHead(
  custody: DirectoryCustody,
  identityArtifactSha256: string,
  previous: WalmartItemReportReissueConsumptionLedgerHeadV2,
  actualEvents: readonly LedgerHeadEvent[],
  updatedAt: string,
): Promise<WalmartItemReportReissueConsumptionLedgerHeadV2> {
  const headPath = path.join(custody.directory, HEAD_FILE_NAME);
  const sortedActualEvents = [...actualEvents].sort((left, right) => (
    left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0
  ));
  const current = await readBoundJsonFile(headPath, "ledger head before advance");
  if (current.sha256 !== previous.artifact_sha256) {
    fail("LEDGER_CONCURRENT_UPDATE", "ledger head changed before event commit");
  }
  const next = buildLedgerHead(
    identityArtifactSha256,
    previous.artifact_sha256,
    sortedActualEvents,
    strictInstant(updatedAt, "ledger head updated_at"),
  );
  const temporaryName = `.ledger-head.${randomUUID()}.tmp`;
  if (!HEAD_TEMP_FILE_PATTERN.test(temporaryName)) {
    fail("INVALID_INPUT", "ledger head temporary filename is invalid");
  }
  const temporaryPath = path.join(custody.directory, temporaryName);
  let temporaryWritten = false;
  try {
    await writeExclusiveJsonFile(temporaryPath, next, "next ledger head");
    temporaryWritten = true;
    const currentAgain = await readBoundJsonFile(headPath, "ledger head before atomic replace");
    if (currentAgain.sha256 !== previous.artifact_sha256) {
      fail("LEDGER_CONCURRENT_UPDATE", "ledger head changed during event commit");
    }
    await rename(temporaryPath, headPath);
    temporaryWritten = false;
    await fsyncDirectory(custody);
    const written = await readBoundJsonFile(headPath, "ledger head after atomic replace");
    const parsed = parseLedgerHead(
      written.value,
      written.sha256,
      identityArtifactSha256,
      sortedActualEvents,
    );
    return ledgerHeadSnapshot(custody.directory, parsed, written.sha256);
  } finally {
    if (temporaryWritten) await unlink(temporaryPath).catch(() => {});
  }
}

function entryReceipt(
  directory: string,
  entry: ScannedAuthorization,
): WalmartItemReportReissueAuthorizationLedgerEntryV2 {
  const claimed = claimReceipt(directory, entry.claim, entry.claim_file_sha256);
  if (!entry.requesting || !entry.requesting_file_sha256) return claimed;
  const request = requestingReceipt(
    directory,
    entry.claim,
    entry.claim_file_sha256,
    entry.requesting,
    entry.requesting_file_sha256,
  );
  if (!entry.terminal || !entry.terminal_file_sha256) return request;
  return terminalReceipt(request, entry.terminal, entry.terminal_file_sha256);
}

function assertExpectedBindingMatches(
  expected: WalmartItemReportReissueConsumptionLedgerBindingV2,
  actual: WalmartItemReportReissueConsumptionLedgerBindingV2,
): void {
  if (!exactJsonEqual(expected, actual)) {
    fail("LEDGER_BINDING_MISMATCH", "signed ledger binding does not match local custody");
  }
}

export async function bootstrapWalmartItemReportReissueConsumptionLedgerV2(options: {
  state_directory: string;
  now?: Date | string;
  random_uuid?: () => string;
}): Promise<{
  state_directory: string;
  identity_artifact_path: string;
  head_artifact_path: string;
  head_artifact_sha256: string;
  binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
}> {
  const directory = normalizedStateDirectory(options.state_directory);
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      fail("LEDGER_CUSTODY_INVALID", "state directory cannot be created");
    }
  }
  const custody = await inspectDirectoryCustody(directory);
  const entries = await readdir(directory);
  if (entries.length !== 0) {
    fail("LEDGER_ALREADY_INITIALIZED", "ledger bootstrap requires an empty custody directory");
  }
  const uuid = options.random_uuid ?? randomUUID;
  const ledgerUuid = uuid();
  const epochUuid = uuid();
  if (!UUID_PATTERN.test(ledgerUuid) || !UUID_PATTERN.test(epochUuid)) {
    fail("INVALID_INPUT", "ledger bootstrap UUID source returned invalid UUIDs");
  }
  const body: LedgerIdentityBody = {
    ledger_id: `ledger-${ledgerUuid}`,
    ledger_epoch: `epoch-${epochUuid}`,
    state_directory_path_sha256: custody.state_directory_path_sha256,
    directory_identity_sha256: custody.directory_identity_sha256,
    created_at: strictInstant(options.now, "ledger created_at"),
  };
  const identity: LedgerIdentityArtifact = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body)),
  };
  const identityPath = path.join(directory, IDENTITY_FILE_NAME);
  let written;
  try {
    written = await writeExclusiveJsonFile(identityPath, identity, "ledger identity artifact");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("LEDGER_ALREADY_INITIALIZED", "ledger identity already exists");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  const parsedIdentity = parseIdentity(written.value, written.sha256, custody);
  const binding = bindingFromIdentity(parsedIdentity, written.sha256);
  const headPath = path.join(directory, HEAD_FILE_NAME);
  const initialHead = buildLedgerHead(
    written.sha256,
    null,
    [],
    body.created_at,
  );
  const writtenHead = await writeExclusiveJsonFile(
    headPath,
    initialHead,
    "initial ledger head",
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("LEDGER_ALREADY_INITIALIZED", "ledger head already exists");
    }
    throw error;
  });
  await fsyncDirectory(custody);
  parseLedgerHead(writtenHead.value, writtenHead.sha256, written.sha256, []);
  return {
    state_directory: directory,
    identity_artifact_path: identityPath,
    head_artifact_path: headPath,
    head_artifact_sha256: writtenHead.sha256,
    binding,
  };
}

export async function openWalmartItemReportReissueConsumptionLedgerV2(options: {
  state_directory: string;
  expected_binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
}): Promise<WalmartItemReportReissueConsumptionLedgerSnapshotV2> {
  const expected = parseBinding(options.expected_binding);
  const custody = await inspectDirectoryCustody(options.state_directory);
  if (expected.state_directory_path_sha256 !== custody.state_directory_path_sha256
    || expected.directory_identity_sha256 !== custody.directory_identity_sha256) {
    fail("LEDGER_BINDING_MISMATCH", "signed path/directory identity does not match custody");
  }
  const identityPath = path.join(custody.directory, IDENTITY_FILE_NAME);
  const identityFile = await readBoundJsonFile(identityPath, "ledger identity artifact");
  const identity = parseIdentity(identityFile.value, identityFile.sha256, custody);
  const actual = bindingFromIdentity(identity, identityFile.sha256);
  assertExpectedBindingMatches(expected, actual);
  const scanned = await scanAuthorizations(custody, actual);
  const actualEvents = ledgerHeadEventsFromScan(scanned);
  const headPath = path.join(custody.directory, HEAD_FILE_NAME);
  const headFile = await readBoundJsonFile(headPath, "ledger head");
  const headArtifact = parseLedgerHead(
    headFile.value,
    headFile.sha256,
    identityFile.sha256,
    actualEvents,
  );
  const namesAfterHead = (await readdir(custody.directory)).sort();
  if (namesAfterHead.some((name) => HEAD_TEMP_FILE_PATTERN.test(name))) {
    fail("LEDGER_CORRUPT", "ledger contains an incomplete head update");
  }
  assertSameDirectoryCustody(custody, await inspectDirectoryCustody(custody.directory));
  return {
    state_directory: custody.directory,
    identity_artifact_path: identityPath,
    binding: actual,
    head: ledgerHeadSnapshot(custody.directory, headArtifact, headFile.sha256),
    authorizations: [...scanned.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entryReceipt(custody.directory, entry)),
  };
}

function parseClaimReceipt(
  value: unknown,
  directory: string,
  binding: WalmartItemReportReissueConsumptionLedgerBindingV2,
): WalmartItemReportReissueAuthorizationClaimReceiptV2 {
  const raw = record(value, "claim receipt");
  exactKeys(raw, [
    "authorization_sha256", "claim_id", "claimed_at", "consumption_ledger",
    "reservation_file_sha256", "reservation_path", "state",
  ], "claim receipt", "CLAIM_BINDING_MISMATCH");
  const authorizationSha256 = digest(
    raw.authorization_sha256,
    "claim receipt authorization SHA",
    "CLAIM_BINDING_MISMATCH",
  );
  const parsed: WalmartItemReportReissueAuthorizationClaimReceiptV2 = {
    authorization_sha256: authorizationSha256,
    state: raw.state === "CLAIMED"
      ? "CLAIMED"
      : fail("CLAIM_BINDING_MISMATCH", "claim receipt state is invalid"),
    claim_id: safeIdentifier(raw.claim_id, "claim receipt claim_id", "CLAIM_BINDING_MISMATCH"),
    claimed_at: strictInstant(
      typeof raw.claimed_at === "string" ? raw.claimed_at : "",
      "claim receipt claimed_at",
    ),
    reservation_path: typeof raw.reservation_path === "string"
      ? raw.reservation_path
      : fail("CLAIM_BINDING_MISMATCH", "claim receipt reservation_path is invalid"),
    reservation_file_sha256: digest(
      raw.reservation_file_sha256,
      "claim receipt file SHA",
      "CLAIM_BINDING_MISMATCH",
    ),
    consumption_ledger: parseBinding(raw.consumption_ledger, "CLAIM_BINDING_MISMATCH"),
  };
  if (parsed.reservation_path !== reservationPath(directory, authorizationSha256)
    || !exactJsonEqual(parsed.consumption_ledger, binding)) {
    fail("CLAIM_BINDING_MISMATCH", "claim receipt path/ledger binding is invalid");
  }
  return parsed;
}

function parseRequestingReceipt(
  value: unknown,
  directory: string,
  binding: WalmartItemReportReissueConsumptionLedgerBindingV2,
): WalmartItemReportReissueAuthorizationRequestingReceiptV2 {
  const raw = record(value, "REQUESTING receipt");
  exactKeys(raw, [
    "authorization_sha256", "claim_id", "claimed_at", "consumption_ledger",
    "requesting_at", "requesting_file_sha256", "requesting_path",
    "reservation_file_sha256", "reservation_path", "state",
  ], "REQUESTING receipt", "REQUESTING_BINDING_MISMATCH");
  const authorizationSha256 = digest(
    raw.authorization_sha256,
    "REQUESTING receipt authorization SHA",
    "REQUESTING_BINDING_MISMATCH",
  );
  const claimedAt = strictInstant(
    typeof raw.claimed_at === "string" ? raw.claimed_at : "",
    "REQUESTING receipt claimed_at",
  );
  const requestingAt = strictInstant(
    typeof raw.requesting_at === "string" ? raw.requesting_at : "",
    "REQUESTING receipt requesting_at",
  );
  if (Date.parse(requestingAt) < Date.parse(claimedAt)) {
    fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt time order is invalid");
  }
  const parsed: WalmartItemReportReissueAuthorizationRequestingReceiptV2 = {
    authorization_sha256: authorizationSha256,
    state: raw.state === "REQUESTING"
      ? "REQUESTING"
      : fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt state is invalid"),
    claim_id: safeIdentifier(
      raw.claim_id,
      "REQUESTING receipt claim_id",
      "REQUESTING_BINDING_MISMATCH",
    ),
    claimed_at: claimedAt,
    requesting_at: requestingAt,
    reservation_path: typeof raw.reservation_path === "string"
      ? raw.reservation_path
      : fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt reservation_path is invalid"),
    reservation_file_sha256: digest(
      raw.reservation_file_sha256,
      "REQUESTING receipt reservation SHA",
      "REQUESTING_BINDING_MISMATCH",
    ),
    requesting_path: typeof raw.requesting_path === "string"
      ? raw.requesting_path
      : fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt path is invalid"),
    requesting_file_sha256: digest(
      raw.requesting_file_sha256,
      "REQUESTING receipt file SHA",
      "REQUESTING_BINDING_MISMATCH",
    ),
    consumption_ledger: parseBinding(
      raw.consumption_ledger,
      "REQUESTING_BINDING_MISMATCH",
    ),
  };
  if (parsed.reservation_path !== reservationPath(directory, authorizationSha256)
    || parsed.requesting_path !== requestingPath(directory, authorizationSha256)
    || !exactJsonEqual(parsed.consumption_ledger, binding)) {
    fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt path/ledger binding is invalid");
  }
  return parsed;
}

function newClaimId(randomUuid: () => string): string {
  const uuid = randomUuid();
  if (!UUID_PATTERN.test(uuid)) fail("INVALID_INPUT", "claim UUID source returned an invalid UUID");
  return `claim-${uuid}`;
}

export async function claimWalmartItemReportReissueAuthorizationV2(options: {
  state_directory: string;
  expected_binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
  authorization_sha256: string;
  claimed_at?: Date | string;
  random_uuid?: () => string;
}): Promise<WalmartItemReportReissueAuthorizationClaimReceiptV2> {
  const authorizationSha256 = digest(options.authorization_sha256, "authorization_sha256");
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  if (opened.authorizations.some((entry) => entry.authorization_sha256 === authorizationSha256)) {
    fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization SHA is already claimed or consumed");
  }
  const body: ClaimArtifactBody = {
    authorization_sha256: authorizationSha256,
    state: "CLAIMED",
    claim_id: newClaimId(options.random_uuid ?? randomUUID),
    claimed_at: strictInstant(options.claimed_at, "claimed_at"),
    consumption_ledger: opened.binding,
  };
  const artifact: ClaimArtifact = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body)),
  };
  const custody = await inspectDirectoryCustody(opened.state_directory);
  let written;
  try {
    written = await writeExclusiveJsonFile(
      reservationPath(opened.state_directory, authorizationSha256),
      artifact,
      "authorization claim",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization SHA lost exclusive-create race");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  const parsed = parseClaimArtifact(written.value, authorizationSha256, opened.binding);
  await advanceLedgerHead(
    custody,
    opened.binding.identity_artifact_sha256,
    opened.head,
    [
      ...opened.head.events,
      {
        file_name: path.basename(reservationPath("/", authorizationSha256)),
        file_sha256: written.sha256,
        authorization_sha256: authorizationSha256,
        state: "CLAIMED",
      },
    ],
    body.claimed_at,
  );
  const verified = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const receipt = verified.authorizations.find(
    (entry) => entry.authorization_sha256 === authorizationSha256,
  );
  if (!receipt || receipt.state !== "CLAIMED"
    || receipt.reservation_file_sha256 !== written.sha256
    || receipt.claim_id !== parsed.body.claim_id) {
    fail("LEDGER_CORRUPT", "durable claim could not be re-read exactly");
  }
  return receipt;
}

export async function markWalmartItemReportReissueAuthorizationRequestingV2(options: {
  state_directory: string;
  expected_binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
  claim: WalmartItemReportReissueAuthorizationClaimReceiptV2;
  requesting_at?: Date | string;
}): Promise<WalmartItemReportReissueAuthorizationRequestingReceiptV2> {
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const claim = parseClaimReceipt(options.claim, opened.state_directory, opened.binding);
  const current = opened.authorizations.find(
    (entry) => entry.authorization_sha256 === claim.authorization_sha256,
  );
  if (!current || current.state !== "CLAIMED") {
    fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization is not in the unique CLAIMED state");
  }
  if (!exactJsonEqual(current, claim)) {
    fail("CLAIM_BINDING_MISMATCH", "claim receipt differs from durable claim bytes");
  }
  const requestingAt = strictInstant(options.requesting_at, "requesting_at");
  if (Date.parse(requestingAt) < Date.parse(claim.claimed_at)) {
    fail("INVALID_INPUT", "requesting_at cannot precede claimed_at");
  }
  const body: RequestingArtifactBody = {
    authorization_sha256: claim.authorization_sha256,
    state: "REQUESTING",
    claim_id: claim.claim_id,
    claimed_at: claim.claimed_at,
    requesting_at: requestingAt,
    reservation_file_sha256: claim.reservation_file_sha256,
    consumption_ledger: opened.binding,
  };
  const artifact: RequestingArtifact = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body)),
  };
  const custody = await inspectDirectoryCustody(opened.state_directory);
  let written;
  try {
    written = await writeExclusiveJsonFile(
      requestingPath(opened.state_directory, claim.authorization_sha256),
      artifact,
      "authorization REQUESTING fence",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization is already REQUESTING or terminal");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  const parsed = parseRequestingArtifact(
    written.value,
    claim.authorization_sha256,
    opened.binding,
    {
      schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA,
      body: {
        authorization_sha256: claim.authorization_sha256,
        state: "CLAIMED",
        claim_id: claim.claim_id,
        claimed_at: claim.claimed_at,
        consumption_ledger: claim.consumption_ledger,
      },
      body_sha256: "",
    },
    claim.reservation_file_sha256,
  );
  await advanceLedgerHead(
    custody,
    opened.binding.identity_artifact_sha256,
    opened.head,
    [
      ...opened.head.events,
      {
        file_name: path.basename(requestingPath("/", claim.authorization_sha256)),
        file_sha256: written.sha256,
        authorization_sha256: claim.authorization_sha256,
        state: "REQUESTING",
      },
    ],
    body.requesting_at,
  );
  const verified = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const receipt = verified.authorizations.find(
    (entry) => entry.authorization_sha256 === claim.authorization_sha256,
  );
  if (!receipt || receipt.state !== "REQUESTING"
    || receipt.requesting_file_sha256 !== written.sha256
    || receipt.claim_id !== parsed.body.claim_id) {
    fail("LEDGER_CORRUPT", "durable REQUESTING fence could not be re-read exactly");
  }
  return receipt;
}

export async function consumeWalmartItemReportReissueAuthorizationV2(options: {
  state_directory: string;
  expected_binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
  authorization_sha256: string;
  claimed_at?: Date | string;
  requesting_at?: Date | string;
  random_uuid?: () => string;
}): Promise<WalmartItemReportReissueAuthorizationRequestingReceiptV2> {
  const claim = await claimWalmartItemReportReissueAuthorizationV2(options);
  return markWalmartItemReportReissueAuthorizationRequestingV2({
    state_directory: options.state_directory,
    expected_binding: options.expected_binding,
    claim,
    requesting_at: options.requesting_at,
  });
}

function parseTerminalOutcome(
  value: WalmartItemReportReissueAuthorizationTerminalOutcomeV2,
  requestingAt: string,
): {
  state: TerminalState;
  terminal_at: string;
  http_status: number | null;
  response_body_sha256: string | null;
  report_request_id_sha256: string | null;
  error_code: string | null;
} {
  const raw = record(value, "terminal outcome");
  exactKeys(raw, [
    "error_code", "http_status", "report_request_id_sha256", "response_body_sha256",
    "state", "terminal_at",
  ], "terminal outcome", "INVALID_INPUT");
  const parsedTerminalState = terminalState(
    raw.state,
    "terminal outcome state",
    "INVALID_INPUT",
  );
  const terminalAt = strictInstant(
    raw.terminal_at instanceof Date || typeof raw.terminal_at === "string"
      ? raw.terminal_at
      : undefined,
    "terminal_at",
  );
  if (Date.parse(terminalAt) < Date.parse(requestingAt)) {
    fail("INVALID_INPUT", "terminal_at cannot precede requesting_at");
  }
  const httpStatus = nullableHttpStatus(
    raw.http_status,
    "terminal outcome HTTP status",
    "INVALID_INPUT",
  );
  const parsed: {
    state: TerminalState;
    terminal_at: string;
    http_status: number | null;
    response_body_sha256: string | null;
    report_request_id_sha256: string | null;
    error_code: string | null;
  } = {
    state: parsedTerminalState,
    terminal_at: terminalAt,
    http_status: httpStatus,
    response_body_sha256: nullableDigest(raw.response_body_sha256, "response body SHA"),
    report_request_id_sha256: nullableDigest(
      raw.report_request_id_sha256,
      "report request ID SHA",
    ),
    error_code: nullableErrorCode(raw.error_code, "terminal error_code"),
  };
  if (parsed.state === "SUCCEEDED"
    && (parsed.http_status === null || parsed.http_status < 200 || parsed.http_status > 299
      || parsed.response_body_sha256 === null || parsed.report_request_id_sha256 === null
      || parsed.error_code !== null)) {
    fail("INVALID_INPUT", "SUCCEEDED outcome requires complete successful response evidence");
  }
  if (parsed.state !== "SUCCEEDED" && parsed.error_code === null) {
    fail("INVALID_INPUT", "non-success outcome requires an error_code");
  }
  return parsed;
}

export async function terminalizeWalmartItemReportReissueAuthorizationV2(options: {
  state_directory: string;
  expected_binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
  requesting: WalmartItemReportReissueAuthorizationRequestingReceiptV2;
  outcome: WalmartItemReportReissueAuthorizationTerminalOutcomeV2;
}): Promise<WalmartItemReportReissueAuthorizationTerminalReceiptV2> {
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const request = parseRequestingReceipt(
    options.requesting,
    opened.state_directory,
    opened.binding,
  );
  const current = opened.authorizations.find(
    (entry) => entry.authorization_sha256 === request.authorization_sha256,
  );
  if (!current || current.state !== "REQUESTING") {
    fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization is not in terminalizable REQUESTING");
  }
  if (!exactJsonEqual(current, request)) {
    fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt differs from durable bytes");
  }
  const outcome = parseTerminalOutcome(options.outcome, request.requesting_at);
  const body: TerminalArtifactBody = {
    authorization_sha256: request.authorization_sha256,
    state: outcome.state,
    claim_id: request.claim_id,
    claimed_at: request.claimed_at,
    requesting_at: request.requesting_at,
    terminal_at: outcome.terminal_at,
    reservation_file_sha256: request.reservation_file_sha256,
    requesting_file_sha256: request.requesting_file_sha256,
    http_status: outcome.http_status,
    response_body_sha256: outcome.response_body_sha256,
    report_request_id_sha256: outcome.report_request_id_sha256,
    error_code: outcome.error_code,
    consumption_ledger: opened.binding,
  };
  const artifact: TerminalArtifact = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body)),
  };
  const custody = await inspectDirectoryCustody(opened.state_directory);
  let written;
  try {
    written = await writeExclusiveJsonFile(
      terminalPath(opened.state_directory, request.authorization_sha256),
      artifact,
      "authorization terminal artifact",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization already has a terminal outcome");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  await advanceLedgerHead(
    custody,
    opened.binding.identity_artifact_sha256,
    opened.head,
    [
      ...opened.head.events,
      {
        file_name: path.basename(terminalPath("/", request.authorization_sha256)),
        file_sha256: written.sha256,
        authorization_sha256: request.authorization_sha256,
        state: outcome.state,
      },
    ],
    body.terminal_at,
  );
  const verified = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const receipt = verified.authorizations.find(
    (entry) => entry.authorization_sha256 === request.authorization_sha256,
  );
  if (!receipt || receipt.state !== outcome.state
    || !("terminal_file_sha256" in receipt)
    || receipt.terminal_file_sha256 !== written.sha256) {
    fail("LEDGER_CORRUPT", "durable terminal artifact could not be re-read exactly");
  }
  return receipt;
}
