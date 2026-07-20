/**
 * Durable, local, single-custody consumption ledger for one-SKU Walmart
 * Listing Integrity repair permits.
 *
 * The ledger deliberately imports no network, credential, database, model, or
 * marketplace code. A writer must durably reach REQUESTING before the first
 * write call. A definite accepted POST is then fenced as ACCEPTED so a crash
 * can resume GET-only polling without ever making the permit replayable.
 * CLAIMED and every later state permanently burn the permit authorization SHA.
 *
 * At-most-once is claimed only while this exact mode-0700 directory remains
 * intact under one custody boundary. This module does not claim resistance to
 * a hostile process with the same UID and does not claim distributed
 * at-most-once semantics.
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

import type {
  WalmartListingRepairConsumptionLedgerBinding,
} from "./listing-integrity-remediation-authority.ts";

export const WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA =
  "walmart-listing-repair-consumption-ledger-identity/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA =
  "walmart-listing-repair-permit-claim/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA =
  "walmart-listing-repair-permit-requesting/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA =
  "walmart-listing-repair-permit-accepted/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA =
  "walmart-listing-repair-permit-terminal/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA =
  "walmart-listing-repair-consumption-ledger-head/v1" as const;

const LEDGER_POLICY_ID =
  "walmart-listing-repair-permit-consumption-ledger/1.0.0" as const;
const RESERVATION_FILENAME_POLICY =
  "authorization-sha256.json/exclusive-create/v1" as const;
const IDENTITY_FILE_NAME = ".ledger-identity.json";
const HEAD_FILE_NAME = ".ledger-head.json";
const OPERATION_LOCK_FILE_NAME = ".ledger-operation.lock";
const HEAD_TEMP_FILE_PATTERN = /^\.ledger-head\.[0-9a-f-]+\.tmp$/u;
const CLAIM_FILE_PATTERN = /^([a-f0-9]{64})\.json$/u;
const REQUESTING_FILE_PATTERN = /^\.([a-f0-9]{64})\.requesting\.json$/u;
const ACCEPTED_FILE_PATTERN = /^\.([a-f0-9]{64})\.accepted\.json$/u;
const TERMINAL_FILE_PATTERN = /^\.([a-f0-9]{64})\.terminal\.json$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;
const MAX_LEDGER_FILE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;
export type WalmartListingRepairPermitTerminalState =
  | "SUCCEEDED"
  | "AMBIGUOUS"
  | "FAILED";
export type WalmartListingRepairPermitState =
  | "CLAIMED"
  | "REQUESTING"
  | "ACCEPTED"
  | WalmartListingRepairPermitTerminalState;

interface DirectoryCustody {
  directory: string;
  canonical_path: string;
  device: string;
  inode: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
}

interface BoundJsonFile {
  bytes: Buffer;
  value: unknown;
  sha256: string;
}

interface LedgerEnvelope<TBody extends JsonRecord> {
  schema_version: string;
  body: TBody;
  body_sha256: string;
}

interface LedgerIdentityBody extends JsonRecord {
  ledger_id: string;
  ledger_epoch: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
  created_at: string;
}

interface ClaimBody extends JsonRecord {
  authorization_sha256: string;
  state: "CLAIMED";
  claim_id: string;
  claimed_at: string;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
}

interface RequestingBody extends JsonRecord {
  authorization_sha256: string;
  state: "REQUESTING";
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  claim_file_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
}

interface AcceptedBody extends JsonRecord {
  authorization_sha256: string;
  state: "ACCEPTED";
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  accepted_at: string;
  requesting_file_sha256: string;
  apply_id: string;
  feed_id: string;
  response_http_receipt_sha256: string;
  response_payload_sha256: string;
  exact_listing_count: 1;
  marketplace_write_calls: 1;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
}

interface TerminalBody extends JsonRecord {
  authorization_sha256: string;
  state: WalmartListingRepairPermitTerminalState;
  consumption_id: string;
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  accepted_at: string | null;
  terminal_at: string;
  prior_state: "REQUESTING" | "ACCEPTED";
  prior_state_file_sha256: string;
  requesting_file_sha256: string;
  accepted_file_sha256: string | null;
  apply_id: string;
  feed_id: string | null;
  response_http_receipt_sha256: string | null;
  response_payload_sha256: string | null;
  feed_status_http_receipt_sha256: string | null;
  feed_status_payload_sha256: string | null;
  exact_listing_count: 1;
  marketplace_write_calls: 0 | 1;
  error_code: string | null;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
}

export interface WalmartListingRepairLedgerHeadEvent extends JsonRecord {
  file_name: string;
  file_sha256: string;
  authorization_sha256: string;
  state: WalmartListingRepairPermitState;
}

interface LedgerHeadBody extends JsonRecord {
  identity_artifact_sha256: string;
  previous_head_artifact_sha256: string | null;
  event_count: number;
  events: WalmartListingRepairLedgerHeadEvent[];
  events_sha256: string;
  updated_at: string;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

export interface WalmartListingRepairLedgerHead {
  artifact_path: string;
  artifact_sha256: string;
  previous_head_artifact_sha256: string | null;
  event_count: number;
  events: WalmartListingRepairLedgerHeadEvent[];
  events_sha256: string;
  updated_at: string;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

interface CommonReceipt {
  authorization_sha256: string;
  claim_id: string;
  claimed_at: string;
  claim_path: string;
  claim_file_sha256: string;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
  ledger_head_path: string;
  ledger_head_sha256: string;
}

export interface WalmartListingRepairPermitClaimReceipt extends CommonReceipt {
  state: "CLAIMED";
}

export interface WalmartListingRepairPermitRequestingReceipt extends CommonReceipt {
  state: "REQUESTING";
  requesting_at: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  requesting_path: string;
  requesting_file_sha256: string;
}

export interface WalmartListingRepairPermitAcceptedReceipt
  extends Omit<WalmartListingRepairPermitRequestingReceipt, "state"> {
  state: "ACCEPTED";
  accepted_at: string;
  accepted_path: string;
  accepted_file_sha256: string;
  apply_id: string;
  feed_id: string;
  response_http_receipt_sha256: string;
  response_payload_sha256: string;
  exact_listing_count: 1;
  marketplace_write_calls: 1;
}

export interface WalmartListingRepairPermitTerminalReceipt
  extends Omit<WalmartListingRepairPermitRequestingReceipt, "state"> {
  state: WalmartListingRepairPermitTerminalState;
  consumption_id: string;
  accepted_at: string | null;
  terminal_at: string;
  prior_state: "REQUESTING" | "ACCEPTED";
  prior_state_file_sha256: string;
  accepted_path: string | null;
  accepted_file_sha256: string | null;
  terminal_path: string;
  terminal_file_sha256: string;
  apply_id: string;
  feed_id: string | null;
  response_http_receipt_sha256: string | null;
  response_payload_sha256: string | null;
  feed_status_http_receipt_sha256: string | null;
  feed_status_payload_sha256: string | null;
  exact_listing_count: 1;
  marketplace_write_calls: 0 | 1;
  error_code: string | null;
}

export type WalmartListingRepairPermitLedgerEntry =
  | WalmartListingRepairPermitClaimReceipt
  | WalmartListingRepairPermitRequestingReceipt
  | WalmartListingRepairPermitAcceptedReceipt
  | WalmartListingRepairPermitTerminalReceipt;

export interface WalmartListingRepairConsumptionLedgerSnapshot {
  state_directory: string;
  identity_artifact_path: string;
  identity_artifact_sha256: string;
  created_at: string;
  binding: WalmartListingRepairConsumptionLedgerBinding;
  head: WalmartListingRepairLedgerHead;
  permits: WalmartListingRepairPermitLedgerEntry[];
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

export interface WalmartListingRepairPermitLedgerEvidence {
  state: WalmartListingRepairPermitState;
  receipt: WalmartListingRepairPermitLedgerEntry;
  identity_bytes: Uint8Array;
  identity_sha256: string;
  head_bytes: Uint8Array;
  head_sha256: string;
  exact_event_inventory: WalmartListingRepairLedgerHeadEvent[];
  claim_bytes: Uint8Array;
  claim_sha256: string;
  requesting_bytes: Uint8Array | null;
  requesting_sha256: string | null;
  accepted_bytes: Uint8Array | null;
  accepted_sha256: string | null;
  terminal_bytes: Uint8Array | null;
  terminal_sha256: string | null;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

export interface WalmartListingRepairPermitRequestingLoad {
  receipt: WalmartListingRepairPermitRequestingReceipt;
  requesting_bytes: Uint8Array;
  requesting_sha256: string;
  head_bytes: Uint8Array;
  head_sha256: string;
  exact_event_inventory: WalmartListingRepairLedgerHeadEvent[];
}

export interface WalmartListingRepairPermitClaimedLoad {
  receipt: WalmartListingRepairPermitClaimReceipt;
  claim_bytes: Uint8Array;
  claim_sha256: string;
  head_bytes: Uint8Array;
  head_sha256: string;
  exact_event_inventory: WalmartListingRepairLedgerHeadEvent[];
}

export interface WalmartListingRepairPermitAcceptedLoad {
  receipt: WalmartListingRepairPermitAcceptedReceipt;
  accepted_bytes: Uint8Array;
  accepted_sha256: string;
  head_bytes: Uint8Array;
  head_sha256: string;
  exact_event_inventory: WalmartListingRepairLedgerHeadEvent[];
}

export interface WalmartListingRepairPermitTerminalOutcome {
  state: WalmartListingRepairPermitTerminalState;
  terminal_at: Date | string;
  apply_id: string;
  marketplace_write_calls: 0 | 1;
  feed_id: string | null;
  response_http_receipt_sha256: string | null;
  response_payload_sha256: string | null;
  feed_status_http_receipt_sha256: string | null;
  feed_status_payload_sha256: string | null;
  error_code: string | null;
}

export class WalmartListingRepairConsumptionLedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairConsumptionLedgerError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairConsumptionLedgerError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("LEDGER_CORRUPT", `${label} must be an object`);
  }
  return value as JsonRecord;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("INVALID_INPUT", "canonical JSON rejects undefined");
  return encoded;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

function safeIdentifier(value: unknown, label: string, code = "INVALID_INPUT"): string {
  if (typeof value !== "string" || value !== value.trim()
    || !SAFE_IDENTIFIER_PATTERN.test(value) || value.includes("//") || value.endsWith("/")) {
    fail(code, `${label} must be a safe exact identifier`);
  }
  return value;
}

function instant(value: Date | string | undefined, label: string, fallback = new Date()): string {
  const parsed = value instanceof Date ? value.toISOString() : (value ?? fallback.toISOString());
  if (typeof parsed !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(parsed).toISOString() !== parsed) {
    fail("INVALID_INPUT", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function nullableDigest(value: unknown, label: string, code = "INVALID_INPUT"): string | null {
  return value === null ? null : digest(value, label, code);
}

function terminalState(value: unknown, code = "INVALID_INPUT"):
WalmartListingRepairPermitTerminalState {
  if (value !== "SUCCEEDED" && value !== "AMBIGUOUS" && value !== "FAILED") {
    fail(code, "terminal state is invalid");
  }
  return value;
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

function noFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_NOFOLLOW is required for ledger custody");
  }
  return fsConstants.O_NOFOLLOW;
}

function directoryFlag(): number {
  if (typeof fsConstants.O_DIRECTORY !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_DIRECTORY is required for ledger custody");
  }
  return fsConstants.O_DIRECTORY;
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameStableStat(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode
    && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function inspectDirectory(value: string): Promise<DirectoryCustody> {
  const directory = normalizedStateDirectory(value);
  const before = await lstat(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory cannot be inspected");
  });
  if (!before.isDirectory() || before.isSymbolicLink()
    || (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("LEDGER_CUSTODY_INVALID", "state directory must be a real mode-0700 directory");
  }
  const canonicalBefore = await realpath(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory realpath cannot be resolved");
  });
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | noFollowFlag() | directoryFlag(),
  ).catch(() => fail("LEDGER_CUSTODY_INVALID", "state directory cannot be opened safely"));
  let descriptor;
  try {
    descriptor = await handle.stat();
  } finally {
    await handle.close();
  }
  const after = await lstat(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory changed during inspection");
  });
  const canonicalAfter = await realpath(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory realpath changed during inspection");
  });
  if (!descriptor.isDirectory() || !sameIdentity(before, descriptor)
    || !sameIdentity(descriptor, after) || canonicalBefore !== canonicalAfter
    || (descriptor.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("LEDGER_CUSTODY_INVALID", "state directory identity or mode is unstable");
  }
  const identity = { device: String(descriptor.dev), inode: String(descriptor.ino) };
  return {
    directory,
    canonical_path: canonicalAfter,
    ...identity,
    state_directory_path_sha256: sha256(Buffer.from(canonicalAfter, "utf8")),
    directory_identity_sha256: sha256(Buffer.from(canonicalJson(identity), "utf8")),
  };
}

function assertSameDirectory(before: DirectoryCustody, after: DirectoryCustody): void {
  if (!exactJsonEqual(before, after)) {
    fail("LEDGER_CUSTODY_INVALID", "state directory identity changed during operation");
  }
}

async function fsyncDirectory(custody: DirectoryCustody): Promise<void> {
  const handle = await open(
    custody.directory,
    fsConstants.O_RDONLY | noFollowFlag() | directoryFlag(),
  ).catch(() => fail("LEDGER_CUSTODY_INVALID", "state directory cannot be opened for fsync"));
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || String(info.dev) !== custody.device
      || String(info.ino) !== custody.inode || (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      fail("LEDGER_CUSTODY_INVALID", "state directory changed before fsync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertSameDirectory(custody, await inspectDirectory(custody.directory));
}

async function readBoundJson(file: string, label: string): Promise<BoundJsonFile> {
  const pathBefore = await lstat(file).catch(() => {
    fail("LEDGER_CORRUPT", `${label} cannot be inspected`);
  });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1
    || (pathBefore.mode & 0o777) !== IMMUTABLE_FILE_MODE
    || pathBefore.size < 1 || pathBefore.size > MAX_LEDGER_FILE_BYTES) {
    fail("LEDGER_CORRUPT", `${label} must be a mode-0400 nlink-1 regular file`);
  }
  const handle = await open(file, fsConstants.O_RDONLY | noFollowFlag()).catch(() => {
    fail("LEDGER_CORRUPT", `${label} cannot be opened without following links`);
  });
  let before;
  let after;
  let loaded;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || (before.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || !sameIdentity(pathBefore, before)) {
      fail("LEDGER_CORRUPT", `${label} descriptor custody is invalid`);
    }
    loaded = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(file).catch(() => {
    fail("LEDGER_CORRUPT", `${label} disappeared during read`);
  });
  if (!sameStableStat(before, after) || !sameIdentity(after, pathAfter)
    || pathAfter.nlink !== 1 || (pathAfter.mode & 0o777) !== IMMUTABLE_FILE_MODE
    || loaded.byteLength !== after.size) {
    fail("LEDGER_CORRUPT", `${label} changed during read`);
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(loaded);
    value = JSON.parse(text);
  } catch {
    fail("LEDGER_CORRUPT", `${label} must contain valid UTF-8 JSON`);
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (!Buffer.from(loaded).equals(canonicalBytes)) {
    fail("LEDGER_CORRUPT", `${label} bytes are not canonical`);
  }
  return { bytes: Buffer.from(loaded), value, sha256: sha256(loaded) };
}

async function writeExclusiveJson(
  file: string,
  value: unknown,
  label: string,
): Promise<BoundJsonFile> {
  const payload = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (payload.byteLength > MAX_LEDGER_FILE_BYTES) {
    fail("INVALID_INPUT", `${label} exceeds ledger byte cap`);
  }
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    IMMUTABLE_FILE_MODE,
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw error;
    return fail("LEDGER_CUSTODY_INVALID", `${label} cannot be exclusively created`);
  });
  try {
    await handle.writeFile(payload);
    await handle.chmod(IMMUTABLE_FILE_MODE);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || info.size !== payload.byteLength) {
      fail("LEDGER_CUSTODY_INVALID", `${label} was created with unsafe custody`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const loaded = await readBoundJson(file, label);
  if (!loaded.bytes.equals(payload)) fail("LEDGER_CORRUPT", `${label} changed after write`);
  return loaded;
}

function envelope<TBody extends JsonRecord>(schema: string, body: TBody): LedgerEnvelope<TBody> {
  return { schema_version: schema, body, body_sha256: sha256(canonicalJson(body)) };
}

function parseEnvelope(
  value: unknown,
  schema: string,
  label: string,
): JsonRecord {
  const raw = record(value, label);
  exactKeys(raw, ["schema_version", "body", "body_sha256"], label);
  if (raw.schema_version !== schema) fail("LEDGER_CORRUPT", `${label} schema is invalid`);
  const body = record(raw.body, `${label}.body`);
  if (digest(raw.body_sha256, `${label}.body_sha256`, "LEDGER_CORRUPT")
    !== sha256(canonicalJson(body))) {
    fail("LEDGER_CORRUPT", `${label} body hash is invalid`);
  }
  return body;
}

function parseBinding(
  value: unknown,
  code = "LEDGER_BINDING_MISMATCH",
): WalmartListingRepairConsumptionLedgerBinding {
  const raw = record(value, "consumption ledger binding");
  exactKeys(raw, [
    "policy_id", "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "identity_artifact_sha256",
    "reservation_filename_policy", "trusted_single_custody_host_only",
    "distributed_at_most_once_claimed",
  ], "consumption ledger binding", code);
  if (raw.policy_id !== LEDGER_POLICY_ID
    || raw.reservation_filename_policy !== RESERVATION_FILENAME_POLICY
    || raw.trusted_single_custody_host_only !== true
    || raw.distributed_at_most_once_claimed !== false) {
    fail(code, "consumption ledger safety policy is invalid");
  }
  return {
    policy_id: LEDGER_POLICY_ID,
    ledger_id: safeIdentifier(raw.ledger_id, "ledger_id", code),
    ledger_epoch: safeIdentifier(raw.ledger_epoch, "ledger_epoch", code),
    state_directory_path_sha256: digest(raw.state_directory_path_sha256, "path hash", code),
    directory_identity_sha256: digest(raw.directory_identity_sha256, "directory hash", code),
    identity_artifact_sha256: digest(raw.identity_artifact_sha256, "identity hash", code),
    reservation_filename_policy: RESERVATION_FILENAME_POLICY,
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

function parseIdentity(
  value: unknown,
  custody: DirectoryCustody,
): LedgerIdentityBody {
  const raw = parseEnvelope(value, WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA, "ledger identity");
  exactKeys(raw, [
    "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "created_at",
  ], "ledger identity body");
  const body: LedgerIdentityBody = {
    ledger_id: safeIdentifier(raw.ledger_id, "identity ledger_id", "LEDGER_CORRUPT"),
    ledger_epoch: safeIdentifier(raw.ledger_epoch, "identity ledger_epoch", "LEDGER_CORRUPT"),
    state_directory_path_sha256: digest(
      raw.state_directory_path_sha256,
      "identity path hash",
      "LEDGER_CORRUPT",
    ),
    directory_identity_sha256: digest(
      raw.directory_identity_sha256,
      "identity directory hash",
      "LEDGER_CORRUPT",
    ),
    created_at: instant(typeof raw.created_at === "string" ? raw.created_at : "", "created_at"),
  };
  if (body.state_directory_path_sha256 !== custody.state_directory_path_sha256
    || body.directory_identity_sha256 !== custody.directory_identity_sha256) {
    fail("LEDGER_CUSTODY_INVALID", "ledger identity differs from directory custody");
  }
  return body;
}

function bindingFromIdentity(
  identity: LedgerIdentityBody,
  identityArtifactSha256: string,
): WalmartListingRepairConsumptionLedgerBinding {
  return {
    policy_id: LEDGER_POLICY_ID,
    ledger_id: identity.ledger_id,
    ledger_epoch: identity.ledger_epoch,
    state_directory_path_sha256: identity.state_directory_path_sha256,
    directory_identity_sha256: identity.directory_identity_sha256,
    identity_artifact_sha256: identityArtifactSha256,
    reservation_filename_policy: RESERVATION_FILENAME_POLICY,
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

function claimPath(directory: string, authorizationSha: string): string {
  return path.join(directory, `${authorizationSha}.json`);
}

function requestingPath(directory: string, authorizationSha: string): string {
  return path.join(directory, `.${authorizationSha}.requesting.json`);
}

function acceptedPath(directory: string, authorizationSha: string): string {
  return path.join(directory, `.${authorizationSha}.accepted.json`);
}

function terminalPath(directory: string, authorizationSha: string): string {
  return path.join(directory, `.${authorizationSha}.terminal.json`);
}

function eventFileName(authorizationSha: string, state: WalmartListingRepairPermitState): string {
  if (state === "CLAIMED") return path.basename(claimPath("/", authorizationSha));
  if (state === "REQUESTING") return path.basename(requestingPath("/", authorizationSha));
  if (state === "ACCEPTED") return path.basename(acceptedPath("/", authorizationSha));
  return path.basename(terminalPath("/", authorizationSha));
}

function parseClaim(
  value: unknown,
  authorizationSha: string,
  binding: WalmartListingRepairConsumptionLedgerBinding,
  identityCreatedAt: string,
): ClaimBody {
  const raw = parseEnvelope(value, WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA, "permit claim");
  exactKeys(raw, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "consumption_ledger",
  ], "permit claim body");
  const body: ClaimBody = {
    authorization_sha256: digest(raw.authorization_sha256, "claim authorization", "LEDGER_CORRUPT"),
    state: raw.state === "CLAIMED"
      ? "CLAIMED" : fail("LEDGER_CORRUPT", "claim state is invalid"),
    claim_id: safeIdentifier(raw.claim_id, "claim_id", "LEDGER_CORRUPT"),
    claimed_at: instant(typeof raw.claimed_at === "string" ? raw.claimed_at : "", "claimed_at"),
    consumption_ledger: parseBinding(raw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  if (body.authorization_sha256 !== authorizationSha
    || Date.parse(body.claimed_at) < Date.parse(identityCreatedAt)
    || !exactJsonEqual(body.consumption_ledger, binding)) {
    fail("LEDGER_CORRUPT", "claim binding or timestamp is invalid");
  }
  return body;
}

function parseRequesting(
  value: unknown,
  authorizationSha: string,
  binding: WalmartListingRepairConsumptionLedgerBinding,
  claim: ClaimBody,
  claimFileSha: string,
): RequestingBody {
  const raw = parseEnvelope(
    value,
    WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
    "permit REQUESTING",
  );
  exactKeys(raw, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "requesting_at",
    "claim_file_sha256", "request_manifest_sha256", "request_payload_sha256",
    "consumption_ledger",
  ], "permit REQUESTING body");
  const body: RequestingBody = {
    authorization_sha256: digest(raw.authorization_sha256, "requesting authorization", "LEDGER_CORRUPT"),
    state: raw.state === "REQUESTING"
      ? "REQUESTING" : fail("LEDGER_CORRUPT", "REQUESTING state is invalid"),
    claim_id: safeIdentifier(raw.claim_id, "requesting claim_id", "LEDGER_CORRUPT"),
    claimed_at: instant(typeof raw.claimed_at === "string" ? raw.claimed_at : "", "requesting claimed_at"),
    requesting_at: instant(
      typeof raw.requesting_at === "string" ? raw.requesting_at : "",
      "requesting_at",
    ),
    claim_file_sha256: digest(raw.claim_file_sha256, "claim file hash", "LEDGER_CORRUPT"),
    request_manifest_sha256: digest(
      raw.request_manifest_sha256,
      "request manifest hash",
      "LEDGER_CORRUPT",
    ),
    request_payload_sha256: digest(
      raw.request_payload_sha256,
      "request payload hash",
      "LEDGER_CORRUPT",
    ),
    consumption_ledger: parseBinding(raw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  if (body.authorization_sha256 !== authorizationSha || body.claim_id !== claim.claim_id
    || body.claimed_at !== claim.claimed_at
    || Date.parse(body.requesting_at) < Date.parse(body.claimed_at)
    || body.claim_file_sha256 !== claimFileSha
    || !exactJsonEqual(body.consumption_ledger, binding)) {
    fail("LEDGER_CORRUPT", "REQUESTING binding or timestamp is invalid");
  }
  return body;
}

function parseAccepted(
  value: unknown,
  authorizationSha: string,
  binding: WalmartListingRepairConsumptionLedgerBinding,
  requesting: RequestingBody,
  requestingFileSha: string,
): AcceptedBody {
  const raw = parseEnvelope(value, WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA, "permit ACCEPTED");
  exactKeys(raw, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "requesting_at",
    "accepted_at", "requesting_file_sha256", "apply_id", "feed_id",
    "response_http_receipt_sha256", "response_payload_sha256", "exact_listing_count",
    "marketplace_write_calls", "consumption_ledger",
  ], "permit ACCEPTED body");
  const body: AcceptedBody = {
    authorization_sha256: digest(raw.authorization_sha256, "accepted authorization", "LEDGER_CORRUPT"),
    state: raw.state === "ACCEPTED"
      ? "ACCEPTED" : fail("LEDGER_CORRUPT", "ACCEPTED state is invalid"),
    claim_id: safeIdentifier(raw.claim_id, "accepted claim_id", "LEDGER_CORRUPT"),
    claimed_at: instant(typeof raw.claimed_at === "string" ? raw.claimed_at : "", "accepted claimed_at"),
    requesting_at: instant(
      typeof raw.requesting_at === "string" ? raw.requesting_at : "",
      "accepted requesting_at",
    ),
    accepted_at: instant(typeof raw.accepted_at === "string" ? raw.accepted_at : "", "accepted_at"),
    requesting_file_sha256: digest(
      raw.requesting_file_sha256,
      "requesting file hash",
      "LEDGER_CORRUPT",
    ),
    apply_id: safeIdentifier(raw.apply_id, "accepted apply_id", "LEDGER_CORRUPT"),
    feed_id: safeIdentifier(raw.feed_id, "accepted feed_id", "LEDGER_CORRUPT"),
    response_http_receipt_sha256: digest(
      raw.response_http_receipt_sha256,
      "response HTTP receipt hash",
      "LEDGER_CORRUPT",
    ),
    response_payload_sha256: digest(
      raw.response_payload_sha256,
      "response payload hash",
      "LEDGER_CORRUPT",
    ),
    exact_listing_count: raw.exact_listing_count === 1
      ? 1 : fail("LEDGER_CORRUPT", "ACCEPTED exact listing count must be one"),
    marketplace_write_calls: raw.marketplace_write_calls === 1
      ? 1 : fail("LEDGER_CORRUPT", "ACCEPTED write-call count must be one"),
    consumption_ledger: parseBinding(raw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  if (body.authorization_sha256 !== authorizationSha
    || body.claim_id !== requesting.claim_id || body.claimed_at !== requesting.claimed_at
    || body.requesting_at !== requesting.requesting_at
    || Date.parse(body.accepted_at) < Date.parse(body.requesting_at)
    || body.requesting_file_sha256 !== requestingFileSha
    || !exactJsonEqual(body.consumption_ledger, binding)) {
    fail("LEDGER_CORRUPT", "ACCEPTED binding or timestamp is invalid");
  }
  return body;
}

function parseTerminal(
  value: unknown,
  authorizationSha: string,
  binding: WalmartListingRepairConsumptionLedgerBinding,
  requesting: RequestingBody,
  requestingFileSha: string,
  accepted: AcceptedBody | null,
  acceptedFileSha: string | null,
): TerminalBody {
  const raw = parseEnvelope(value, WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA, "permit terminal");
  exactKeys(raw, [
    "authorization_sha256", "state", "consumption_id", "claim_id", "claimed_at",
    "requesting_at", "accepted_at", "terminal_at", "prior_state",
    "prior_state_file_sha256", "requesting_file_sha256", "accepted_file_sha256",
    "apply_id", "feed_id", "response_http_receipt_sha256", "response_payload_sha256",
    "feed_status_http_receipt_sha256", "feed_status_payload_sha256",
    "exact_listing_count", "marketplace_write_calls", "error_code", "consumption_ledger",
  ], "permit terminal body");
  const writeCalls = raw.marketplace_write_calls;
  if (writeCalls !== 0 && writeCalls !== 1) {
    fail("LEDGER_CORRUPT", "terminal write-call count must be zero or one");
  }
  const priorState = raw.prior_state;
  if (priorState !== "REQUESTING" && priorState !== "ACCEPTED") {
    fail("LEDGER_CORRUPT", "terminal prior state is invalid");
  }
  const body: TerminalBody = {
    authorization_sha256: digest(raw.authorization_sha256, "terminal authorization", "LEDGER_CORRUPT"),
    state: terminalState(raw.state, "LEDGER_CORRUPT"),
    consumption_id: safeIdentifier(raw.consumption_id, "consumption_id", "LEDGER_CORRUPT"),
    claim_id: safeIdentifier(raw.claim_id, "terminal claim_id", "LEDGER_CORRUPT"),
    claimed_at: instant(typeof raw.claimed_at === "string" ? raw.claimed_at : "", "terminal claimed_at"),
    requesting_at: instant(
      typeof raw.requesting_at === "string" ? raw.requesting_at : "",
      "terminal requesting_at",
    ),
    accepted_at: raw.accepted_at === null
      ? null : instant(typeof raw.accepted_at === "string" ? raw.accepted_at : "", "terminal accepted_at"),
    terminal_at: instant(typeof raw.terminal_at === "string" ? raw.terminal_at : "", "terminal_at"),
    prior_state: priorState,
    prior_state_file_sha256: digest(
      raw.prior_state_file_sha256,
      "prior state file hash",
      "LEDGER_CORRUPT",
    ),
    requesting_file_sha256: digest(
      raw.requesting_file_sha256,
      "terminal requesting file hash",
      "LEDGER_CORRUPT",
    ),
    accepted_file_sha256: nullableDigest(
      raw.accepted_file_sha256,
      "terminal accepted file hash",
      "LEDGER_CORRUPT",
    ),
    apply_id: safeIdentifier(raw.apply_id, "terminal apply_id", "LEDGER_CORRUPT"),
    feed_id: raw.feed_id === null
      ? null : safeIdentifier(raw.feed_id, "terminal feed_id", "LEDGER_CORRUPT"),
    response_http_receipt_sha256: nullableDigest(
      raw.response_http_receipt_sha256,
      "terminal response HTTP receipt hash",
      "LEDGER_CORRUPT",
    ),
    response_payload_sha256: nullableDigest(
      raw.response_payload_sha256,
      "terminal response payload hash",
      "LEDGER_CORRUPT",
    ),
    feed_status_http_receipt_sha256: nullableDigest(
      raw.feed_status_http_receipt_sha256,
      "terminal feed status HTTP receipt hash",
      "LEDGER_CORRUPT",
    ),
    feed_status_payload_sha256: nullableDigest(
      raw.feed_status_payload_sha256,
      "terminal feed status payload hash",
      "LEDGER_CORRUPT",
    ),
    exact_listing_count: raw.exact_listing_count === 1
      ? 1 : fail("LEDGER_CORRUPT", "terminal exact listing count must be one"),
    marketplace_write_calls: writeCalls,
    error_code: raw.error_code === null
      ? null : safeIdentifier(raw.error_code, "terminal error_code", "LEDGER_CORRUPT"),
    consumption_ledger: parseBinding(raw.consumption_ledger, "LEDGER_CORRUPT"),
  };
  const responsePair = (body.response_http_receipt_sha256 === null)
    === (body.response_payload_sha256 === null);
  const statusPair = (body.feed_status_http_receipt_sha256 === null)
    === (body.feed_status_payload_sha256 === null);
  const expectedPriorHash = accepted ? acceptedFileSha : requestingFileSha;
  if (body.authorization_sha256 !== authorizationSha
    || body.claim_id !== requesting.claim_id || body.claimed_at !== requesting.claimed_at
    || body.requesting_at !== requesting.requesting_at
    || Date.parse(body.terminal_at) < Date.parse(accepted?.accepted_at ?? body.requesting_at)
    || body.prior_state !== (accepted ? "ACCEPTED" : "REQUESTING")
    || body.prior_state_file_sha256 !== expectedPriorHash
    || body.requesting_file_sha256 !== requestingFileSha
    || body.accepted_file_sha256 !== acceptedFileSha
    || body.accepted_at !== (accepted?.accepted_at ?? null)
    || !responsePair || !statusPair || !exactJsonEqual(body.consumption_ledger, binding)) {
    fail("LEDGER_CORRUPT", "terminal binding, evidence pairs, or timestamp is invalid");
  }
  if (accepted && (body.marketplace_write_calls !== 1 || body.apply_id !== accepted.apply_id
    || body.feed_id !== accepted.feed_id
    || body.response_http_receipt_sha256 !== accepted.response_http_receipt_sha256
    || body.response_payload_sha256 !== accepted.response_payload_sha256)) {
    fail("LEDGER_CORRUPT", "terminal does not preserve ACCEPTED POST evidence");
  }
  if (body.state === "SUCCEEDED" && (!accepted || body.marketplace_write_calls !== 1
    || body.feed_status_http_receipt_sha256 === null
    || body.feed_status_payload_sha256 === null || body.error_code !== null)) {
    fail("LEDGER_CORRUPT", "SUCCEEDED requires accepted POST and exact feed-status evidence");
  }
  if (body.state !== "SUCCEEDED" && body.error_code === null) {
    fail("LEDGER_CORRUPT", "non-success terminal state requires error_code");
  }
  if (!accepted && body.marketplace_write_calls === 0
    && (body.feed_id !== null || body.response_http_receipt_sha256 !== null
      || body.feed_status_http_receipt_sha256 !== null)) {
    fail("LEDGER_CORRUPT", "zero-call terminal state may not claim marketplace evidence");
  }
  if (!accepted && body.state === "FAILED" && body.marketplace_write_calls === 1
    && body.response_http_receipt_sha256 === null) {
    fail("LEDGER_CORRUPT", "definite one-call FAILED state requires exact response evidence");
  }
  return body;
}

interface ScannedPermit {
  claim: ClaimBody;
  claim_file: BoundJsonFile;
  requesting: RequestingBody | null;
  requesting_file: BoundJsonFile | null;
  accepted: AcceptedBody | null;
  accepted_file: BoundJsonFile | null;
  terminal: TerminalBody | null;
  terminal_file: BoundJsonFile | null;
}

function parseHeadEvent(value: unknown, index: number): WalmartListingRepairLedgerHeadEvent {
  const raw = record(value, `ledger head event ${index}`);
  exactKeys(raw, ["file_name", "file_sha256", "authorization_sha256", "state"], `head event ${index}`);
  const fileName = typeof raw.file_name === "string" ? raw.file_name : "";
  const claim = CLAIM_FILE_PATTERN.exec(fileName);
  const requesting = REQUESTING_FILE_PATTERN.exec(fileName);
  const accepted = ACCEPTED_FILE_PATTERN.exec(fileName);
  const terminal = TERMINAL_FILE_PATTERN.exec(fileName);
  const authorizationFromName = (claim ?? requesting ?? accepted ?? terminal)?.[1];
  const authorizationSha = digest(raw.authorization_sha256, "head authorization", "LEDGER_CORRUPT");
  const state = raw.state;
  if (!authorizationFromName || authorizationFromName !== authorizationSha
    || (claim && state !== "CLAIMED") || (requesting && state !== "REQUESTING")
    || (accepted && state !== "ACCEPTED")
    || (terminal && state !== "SUCCEEDED" && state !== "AMBIGUOUS" && state !== "FAILED")) {
    fail("LEDGER_CORRUPT", `head event ${index} filename/state binding is invalid`);
  }
  return {
    file_name: fileName,
    file_sha256: digest(raw.file_sha256, "head event file hash", "LEDGER_CORRUPT"),
    authorization_sha256: authorizationSha,
    state: state as WalmartListingRepairPermitState,
  };
}

function sortedEvents(events: readonly WalmartListingRepairLedgerHeadEvent[]):
WalmartListingRepairLedgerHeadEvent[] {
  return [...events].sort((left, right) => left.file_name.localeCompare(right.file_name));
}

function buildHead(
  identitySha: string,
  previousHeadSha: string | null,
  events: readonly WalmartListingRepairLedgerHeadEvent[],
  updatedAt: string,
): LedgerEnvelope<LedgerHeadBody> {
  const inventory = sortedEvents(events);
  const body: LedgerHeadBody = {
    identity_artifact_sha256: identitySha,
    previous_head_artifact_sha256: previousHeadSha,
    event_count: inventory.length,
    events: inventory,
    events_sha256: sha256(canonicalJson(inventory)),
    updated_at: updatedAt,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
  return envelope(WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA, body);
}

function parseHead(
  value: unknown,
  fileSha: string,
  identitySha: string,
  actualEvents: readonly WalmartListingRepairLedgerHeadEvent[],
  identityCreatedAt: string,
): { body: LedgerHeadBody; snapshot_sha256: string } {
  const raw = parseEnvelope(value, WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA, "ledger head");
  exactKeys(raw, [
    "identity_artifact_sha256", "previous_head_artifact_sha256", "event_count", "events",
    "events_sha256", "updated_at", "at_most_once_scope",
    "hostile_same_uid_resistance_claimed", "distributed_at_most_once_claimed",
  ], "ledger head body");
  if (!Array.isArray(raw.events)) fail("LEDGER_CORRUPT", "ledger head events must be an array");
  const events = raw.events.map(parseHeadEvent);
  const eventCount = raw.event_count;
  if (!Number.isSafeInteger(eventCount) || typeof eventCount !== "number" || eventCount < 0) {
    fail("LEDGER_CORRUPT", "ledger head event_count is invalid");
  }
  const body: LedgerHeadBody = {
    identity_artifact_sha256: digest(raw.identity_artifact_sha256, "head identity hash", "LEDGER_CORRUPT"),
    previous_head_artifact_sha256: raw.previous_head_artifact_sha256 === null
      ? null : digest(raw.previous_head_artifact_sha256, "previous head hash", "LEDGER_CORRUPT"),
    event_count: eventCount,
    events,
    events_sha256: digest(raw.events_sha256, "head events hash", "LEDGER_CORRUPT"),
    updated_at: instant(typeof raw.updated_at === "string" ? raw.updated_at : "", "head updated_at"),
    at_most_once_scope: raw.at_most_once_scope === "INTACT_SINGLE_CUSTODY_DIRECTORY"
      ? "INTACT_SINGLE_CUSTODY_DIRECTORY"
      : fail("LEDGER_CORRUPT", "ledger head at-most-once scope is invalid"),
    hostile_same_uid_resistance_claimed: raw.hostile_same_uid_resistance_claimed === false
      ? false : fail("LEDGER_CORRUPT", "ledger head may not claim hostile same-UID resistance"),
    distributed_at_most_once_claimed: raw.distributed_at_most_once_claimed === false
      ? false : fail("LEDGER_CORRUPT", "ledger head may not claim distributed at-most-once"),
  };
  if (body.identity_artifact_sha256 !== identitySha || body.event_count !== events.length
    || !exactJsonEqual(events, sortedEvents(events))
    || new Set(events.map((event) => event.file_name)).size !== events.length
    || body.events_sha256 !== sha256(canonicalJson(events))
    || !exactJsonEqual(events, sortedEvents(actualEvents))
    || Date.parse(body.updated_at) < Date.parse(identityCreatedAt)
    || (events.length === 0 && body.previous_head_artifact_sha256 !== null)
    || (events.length > 0 && body.previous_head_artifact_sha256 === null)) {
    fail("LEDGER_ROLLBACK_OR_DELETION_DETECTED", "ledger head and exact event inventory differ");
  }
  return { body, snapshot_sha256: digest(fileSha, "head file hash", "LEDGER_CORRUPT") };
}

async function scanPermits(
  custody: DirectoryCustody,
  binding: WalmartListingRepairConsumptionLedgerBinding,
  identityCreatedAt: string,
  allowOperationLock: boolean,
): Promise<Map<string, ScannedPermit>> {
  const before = (await readdir(custody.directory)).sort();
  if (before.includes(OPERATION_LOCK_FILE_NAME) && !allowOperationLock) {
    fail("LEDGER_MANUAL_REVIEW_REQUIRED", "ledger operation lock exists; never auto-reclaim it");
  }
  if (before.some((name) => HEAD_TEMP_FILE_PATTERN.test(name))) {
    fail("LEDGER_MANUAL_REVIEW_REQUIRED", "incomplete atomic head update requires review");
  }
  const claims = new Map<string, BoundJsonFile>();
  const requestings = new Map<string, BoundJsonFile>();
  const accepteds = new Map<string, BoundJsonFile>();
  const terminals = new Map<string, BoundJsonFile>();
  for (const name of before) {
    if (name === IDENTITY_FILE_NAME || name === HEAD_FILE_NAME
      || (allowOperationLock && name === OPERATION_LOCK_FILE_NAME)) continue;
    const claim = CLAIM_FILE_PATTERN.exec(name);
    const requesting = REQUESTING_FILE_PATTERN.exec(name);
    const accepted = ACCEPTED_FILE_PATTERN.exec(name);
    const terminal = TERMINAL_FILE_PATTERN.exec(name);
    const authorizationSha = (claim ?? requesting ?? accepted ?? terminal)?.[1];
    if (!authorizationSha) fail("LEDGER_CORRUPT", `unexpected ledger entry ${name}`);
    const target = claim ? claims : requesting ? requestings : accepted ? accepteds : terminals;
    if (target.has(authorizationSha)) fail("LEDGER_CORRUPT", `duplicate permit state ${name}`);
    target.set(authorizationSha, await readBoundJson(path.join(custody.directory, name), name));
  }
  const after = (await readdir(custody.directory)).sort();
  if (!exactJsonEqual(before, after)) {
    fail("LEDGER_CHANGED_DURING_READ", "ledger inventory changed during read");
  }
  assertSameDirectory(custody, await inspectDirectory(custody.directory));
  const all = [...new Set([
    ...claims.keys(), ...requestings.keys(), ...accepteds.keys(), ...terminals.keys(),
  ])].sort();
  const scanned = new Map<string, ScannedPermit>();
  for (const authorizationSha of all) {
    const claimFile = claims.get(authorizationSha);
    if (!claimFile) fail("LEDGER_CORRUPT", `${authorizationSha} has state without claim`);
    const claim = parseClaim(
      claimFile.value,
      authorizationSha,
      binding,
      identityCreatedAt,
    );
    const requestingFile = requestings.get(authorizationSha) ?? null;
    const requesting = requestingFile
      ? parseRequesting(
        requestingFile.value,
        authorizationSha,
        binding,
        claim,
        claimFile.sha256,
      ) : null;
    const acceptedFile = accepteds.get(authorizationSha) ?? null;
    if ((acceptedFile || terminals.has(authorizationSha)) && !requesting) {
      fail("LEDGER_CORRUPT", `${authorizationSha} has post-request state without REQUESTING`);
    }
    const accepted = acceptedFile && requesting && requestingFile
      ? parseAccepted(
        acceptedFile.value,
        authorizationSha,
        binding,
        requesting,
        requestingFile.sha256,
      ) : null;
    const terminalFile = terminals.get(authorizationSha) ?? null;
    const terminal = terminalFile && requesting && requestingFile
      ? parseTerminal(
        terminalFile.value,
        authorizationSha,
        binding,
        requesting,
        requestingFile.sha256,
        accepted,
        acceptedFile?.sha256 ?? null,
      ) : null;
    scanned.set(authorizationSha, {
      claim,
      claim_file: claimFile,
      requesting,
      requesting_file: requestingFile,
      accepted,
      accepted_file: acceptedFile,
      terminal,
      terminal_file: terminalFile,
    });
  }
  return scanned;
}

function eventsFromScan(scanned: ReadonlyMap<string, ScannedPermit>):
WalmartListingRepairLedgerHeadEvent[] {
  const events: WalmartListingRepairLedgerHeadEvent[] = [];
  for (const [authorizationSha, row] of scanned) {
    events.push({
      file_name: eventFileName(authorizationSha, "CLAIMED"),
      file_sha256: row.claim_file.sha256,
      authorization_sha256: authorizationSha,
      state: "CLAIMED",
    });
    if (row.requesting_file) events.push({
      file_name: eventFileName(authorizationSha, "REQUESTING"),
      file_sha256: row.requesting_file.sha256,
      authorization_sha256: authorizationSha,
      state: "REQUESTING",
    });
    if (row.accepted_file) events.push({
      file_name: eventFileName(authorizationSha, "ACCEPTED"),
      file_sha256: row.accepted_file.sha256,
      authorization_sha256: authorizationSha,
      state: "ACCEPTED",
    });
    if (row.terminal && row.terminal_file) events.push({
      file_name: eventFileName(authorizationSha, row.terminal.state),
      file_sha256: row.terminal_file.sha256,
      authorization_sha256: authorizationSha,
      state: row.terminal.state,
    });
  }
  return sortedEvents(events);
}

function headSnapshot(
  directory: string,
  body: LedgerHeadBody,
  artifactSha: string,
): WalmartListingRepairLedgerHead {
  return {
    artifact_path: path.join(directory, HEAD_FILE_NAME),
    artifact_sha256: artifactSha,
    previous_head_artifact_sha256: body.previous_head_artifact_sha256,
    event_count: body.event_count,
    events: body.events,
    events_sha256: body.events_sha256,
    updated_at: body.updated_at,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
}

function receiptFromScan(
  directory: string,
  row: ScannedPermit,
  head: WalmartListingRepairLedgerHead,
): WalmartListingRepairPermitLedgerEntry {
  const common: CommonReceipt = {
    authorization_sha256: row.claim.authorization_sha256,
    claim_id: row.claim.claim_id,
    claimed_at: row.claim.claimed_at,
    claim_path: claimPath(directory, row.claim.authorization_sha256),
    claim_file_sha256: row.claim_file.sha256,
    consumption_ledger: row.claim.consumption_ledger,
    ledger_head_path: head.artifact_path,
    ledger_head_sha256: head.artifact_sha256,
  };
  if (!row.requesting || !row.requesting_file) return { ...common, state: "CLAIMED" };
  const requesting: WalmartListingRepairPermitRequestingReceipt = {
    ...common,
    state: "REQUESTING",
    requesting_at: row.requesting.requesting_at,
    request_manifest_sha256: row.requesting.request_manifest_sha256,
    request_payload_sha256: row.requesting.request_payload_sha256,
    requesting_path: requestingPath(directory, row.claim.authorization_sha256),
    requesting_file_sha256: row.requesting_file.sha256,
  };
  if (row.terminal && row.terminal_file) {
    return {
      ...requesting,
      state: row.terminal.state,
      consumption_id: row.terminal.consumption_id,
      accepted_at: row.terminal.accepted_at,
      terminal_at: row.terminal.terminal_at,
      prior_state: row.terminal.prior_state,
      prior_state_file_sha256: row.terminal.prior_state_file_sha256,
      accepted_path: row.accepted ? acceptedPath(directory, row.claim.authorization_sha256) : null,
      accepted_file_sha256: row.terminal.accepted_file_sha256,
      terminal_path: terminalPath(directory, row.claim.authorization_sha256),
      terminal_file_sha256: row.terminal_file.sha256,
      apply_id: row.terminal.apply_id,
      feed_id: row.terminal.feed_id,
      response_http_receipt_sha256: row.terminal.response_http_receipt_sha256,
      response_payload_sha256: row.terminal.response_payload_sha256,
      feed_status_http_receipt_sha256: row.terminal.feed_status_http_receipt_sha256,
      feed_status_payload_sha256: row.terminal.feed_status_payload_sha256,
      exact_listing_count: 1,
      marketplace_write_calls: row.terminal.marketplace_write_calls,
      error_code: row.terminal.error_code,
    };
  }
  if (!row.accepted || !row.accepted_file) return requesting;
  return {
    ...requesting,
    state: "ACCEPTED",
    accepted_at: row.accepted.accepted_at,
    accepted_path: acceptedPath(directory, row.claim.authorization_sha256),
    accepted_file_sha256: row.accepted_file.sha256,
    apply_id: row.accepted.apply_id,
    feed_id: row.accepted.feed_id,
    response_http_receipt_sha256: row.accepted.response_http_receipt_sha256,
    response_payload_sha256: row.accepted.response_payload_sha256,
    exact_listing_count: 1,
    marketplace_write_calls: 1,
  };
}

async function openInternal(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
}, allowOperationLock: boolean): Promise<{
  snapshot: WalmartListingRepairConsumptionLedgerSnapshot;
  custody: DirectoryCustody;
  scanned: Map<string, ScannedPermit>;
}> {
  const expected = parseBinding(options.expected_binding);
  const custody = await inspectDirectory(options.state_directory);
  if (expected.state_directory_path_sha256 !== custody.state_directory_path_sha256
    || expected.directory_identity_sha256 !== custody.directory_identity_sha256) {
    fail("LEDGER_BINDING_MISMATCH", "signed directory binding differs from custody");
  }
  const identityPath = path.join(custody.directory, IDENTITY_FILE_NAME);
  const identityFile = await readBoundJson(identityPath, "ledger identity");
  const identity = parseIdentity(identityFile.value, custody);
  const binding = bindingFromIdentity(identity, identityFile.sha256);
  if (!exactJsonEqual(binding, expected)) {
    fail("LEDGER_BINDING_MISMATCH", "signed ledger binding differs from local identity");
  }
  const scanned = await scanPermits(custody, binding, identity.created_at, allowOperationLock);
  const actualEvents = eventsFromScan(scanned);
  const headPath = path.join(custody.directory, HEAD_FILE_NAME);
  const headFile = await readBoundJson(headPath, "ledger head");
  const parsedHead = parseHead(
    headFile.value,
    headFile.sha256,
    identityFile.sha256,
    actualEvents,
    identity.created_at,
  );
  const head = headSnapshot(custody.directory, parsedHead.body, headFile.sha256);
  const permits = [...scanned.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => receiptFromScan(custody.directory, row, head));
  assertSameDirectory(custody, await inspectDirectory(custody.directory));
  return {
    custody,
    scanned,
    snapshot: {
      state_directory: custody.directory,
      identity_artifact_path: identityPath,
      identity_artifact_sha256: identityFile.sha256,
      created_at: identity.created_at,
      binding,
      head,
      permits,
      at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
      hostile_same_uid_resistance_claimed: false,
      distributed_at_most_once_claimed: false,
    },
  };
}

async function advanceHead(
  custody: DirectoryCustody,
  current: WalmartListingRepairLedgerHead,
  identitySha: string,
  events: readonly WalmartListingRepairLedgerHeadEvent[],
  updatedAt: string,
): Promise<void> {
  if (Date.parse(updatedAt) < Date.parse(current.updated_at)) {
    fail("INVALID_INPUT", "ledger event timestamp cannot precede current head");
  }
  const headPath = path.join(custody.directory, HEAD_FILE_NAME);
  const before = await readBoundJson(headPath, "ledger head before update");
  if (before.sha256 !== current.artifact_sha256) {
    fail("LEDGER_CONCURRENT_UPDATE", "ledger head changed before update");
  }
  const next = buildHead(identitySha, current.artifact_sha256, events, updatedAt);
  const tempName = `.ledger-head.${randomUUID()}.tmp`;
  if (!HEAD_TEMP_FILE_PATTERN.test(tempName)) fail("INVALID_INPUT", "invalid head temp name");
  const tempPath = path.join(custody.directory, tempName);
  let written = false;
  try {
    await writeExclusiveJson(tempPath, next, "next ledger head");
    written = true;
    const beforeRename = await readBoundJson(headPath, "ledger head before atomic replace");
    if (beforeRename.sha256 !== current.artifact_sha256) {
      fail("LEDGER_CONCURRENT_UPDATE", "ledger head changed during update");
    }
    await rename(tempPath, headPath);
    written = false;
    await fsyncDirectory(custody);
  } finally {
    if (written) await unlink(tempPath).catch(() => {});
  }
}

async function acquireOperationLock(custody: DirectoryCustody): Promise<void> {
  const lockPath = path.join(custody.directory, OPERATION_LOCK_FILE_NAME);
  const artifact = envelope("walmart-listing-repair-ledger-operation-lock/v1", {
    operation_id: `operation-${randomUUID()}`,
    created_at: new Date().toISOString(),
  });
  try {
    await writeExclusiveJson(lockPath, artifact, "ledger operation lock");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("LEDGER_MANUAL_REVIEW_REQUIRED", "ledger operation lock already exists");
    }
    throw error;
  }
  await fsyncDirectory(custody);
}

async function releaseOperationLock(custody: DirectoryCustody): Promise<void> {
  const lockPath = path.join(custody.directory, OPERATION_LOCK_FILE_NAME);
  await unlink(lockPath).catch(() => {
    fail("LEDGER_MANUAL_REVIEW_REQUIRED", "ledger operation lock cannot be released");
  });
  await fsyncDirectory(custody);
}

async function mutate<T>(
  options: {
    state_directory: string;
    expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  },
  operation: (opened: Awaited<ReturnType<typeof openInternal>>) => Promise<T>,
): Promise<T> {
  const before = await openInternal(options, false);
  await acquireOperationLock(before.custody);
  let result: T;
  try {
    const locked = await openInternal(options, true);
    if (locked.snapshot.head.artifact_sha256 !== before.snapshot.head.artifact_sha256) {
      fail("LEDGER_CONCURRENT_UPDATE", "ledger changed while acquiring operation lock");
    }
    result = await operation(locked);
    await openInternal(options, true);
  } finally {
    await releaseOperationLock(before.custody);
  }
  return result;
}

function uuidId(prefix: string, randomUuid: () => string): string {
  const value = randomUuid();
  if (!UUID_PATTERN.test(value)) fail("INVALID_INPUT", `${prefix} UUID source is invalid`);
  return `${prefix}-${value}`;
}

export async function bootstrapWalmartListingRepairConsumptionLedger(options: {
  state_directory: string;
  now?: Date | string;
  random_uuid?: () => string;
}): Promise<{
  state_directory: string;
  identity_artifact_path: string;
  identity_artifact_sha256: string;
  head_artifact_path: string;
  head_artifact_sha256: string;
  binding: WalmartListingRepairConsumptionLedgerBinding;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}> {
  const directory = normalizedStateDirectory(options.state_directory);
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      fail("LEDGER_CUSTODY_INVALID", "state directory cannot be created");
    }
  }
  const custody = await inspectDirectory(directory);
  if ((await readdir(directory)).length !== 0) {
    fail("LEDGER_ALREADY_INITIALIZED", "bootstrap requires an empty custody directory");
  }
  const random = options.random_uuid ?? randomUUID;
  const createdAt = instant(options.now, "ledger created_at");
  const identityBody: LedgerIdentityBody = {
    ledger_id: uuidId("ledger", random),
    ledger_epoch: uuidId("epoch", random),
    state_directory_path_sha256: custody.state_directory_path_sha256,
    directory_identity_sha256: custody.directory_identity_sha256,
    created_at: createdAt,
  };
  const identityPath = path.join(directory, IDENTITY_FILE_NAME);
  const identity = await writeExclusiveJson(
    identityPath,
    envelope(WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA, identityBody),
    "ledger identity",
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("LEDGER_ALREADY_INITIALIZED", "ledger identity already exists");
    }
    throw error;
  });
  await fsyncDirectory(custody);
  const binding = bindingFromIdentity(identityBody, identity.sha256);
  const headPath = path.join(directory, HEAD_FILE_NAME);
  const head = await writeExclusiveJson(
    headPath,
    buildHead(identity.sha256, null, [], createdAt),
    "initial ledger head",
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail("LEDGER_ALREADY_INITIALIZED", "ledger head already exists");
    }
    throw error;
  });
  await fsyncDirectory(custody);
  await openWalmartListingRepairConsumptionLedger({
    state_directory: directory,
    expected_binding: binding,
  });
  return {
    state_directory: directory,
    identity_artifact_path: identityPath,
    identity_artifact_sha256: identity.sha256,
    head_artifact_path: headPath,
    head_artifact_sha256: head.sha256,
    binding,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
}

export async function openWalmartListingRepairConsumptionLedger(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
}): Promise<WalmartListingRepairConsumptionLedgerSnapshot> {
  return (await openInternal(options, false)).snapshot;
}

export async function claimWalmartListingRepairPermit(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  permit_authorization_sha256: string;
  claimed_at?: Date | string;
  random_uuid?: () => string;
}): Promise<WalmartListingRepairPermitClaimReceipt> {
  const authorizationSha = digest(options.permit_authorization_sha256, "permit authorization hash");
  return mutate(options, async (opened) => {
    if (opened.scanned.has(authorizationSha)) {
      fail("PERMIT_ALREADY_CONSUMED", "permit is already CLAIMED or later");
    }
    const claimedAt = instant(options.claimed_at, "claimed_at");
    if (Date.parse(claimedAt) < Date.parse(opened.snapshot.head.updated_at)) {
      fail("INVALID_INPUT", "claimed_at cannot precede current ledger head");
    }
    const body: ClaimBody = {
      authorization_sha256: authorizationSha,
      state: "CLAIMED",
      claim_id: uuidId("claim", options.random_uuid ?? randomUUID),
      claimed_at: claimedAt,
      consumption_ledger: opened.snapshot.binding,
    };
    let written: BoundJsonFile;
    try {
      written = await writeExclusiveJson(
        claimPath(opened.custody.directory, authorizationSha),
        envelope(WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA, body),
        "permit claim",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        fail("PERMIT_ALREADY_CONSUMED", "permit lost exclusive claim race");
      }
      throw error;
    }
    await fsyncDirectory(opened.custody);
    await advanceHead(
      opened.custody,
      opened.snapshot.head,
      opened.snapshot.identity_artifact_sha256,
      [...opened.snapshot.head.events, {
        file_name: eventFileName(authorizationSha, "CLAIMED"),
        file_sha256: written.sha256,
        authorization_sha256: authorizationSha,
        state: "CLAIMED",
      }],
      claimedAt,
    );
    const verified = await openInternal(options, true);
    const receipt = verified.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === authorizationSha,
    );
    if (!receipt || receipt.state !== "CLAIMED") {
      fail("LEDGER_CORRUPT", "durable claim cannot be re-read exactly");
    }
    return receipt;
  });
}

export async function markWalmartListingRepairPermitRequesting(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  claim: WalmartListingRepairPermitClaimReceipt;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  requesting_at?: Date | string;
}): Promise<WalmartListingRepairPermitRequestingReceipt> {
  const manifestSha = digest(options.request_manifest_sha256, "request manifest hash");
  const payloadSha = digest(options.request_payload_sha256, "request payload hash");
  return mutate(options, async (opened) => {
    const current = opened.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === options.claim.authorization_sha256,
    );
    if (!current || current.state !== "CLAIMED" || !exactJsonEqual(current, options.claim)) {
      fail("CLAIM_BINDING_MISMATCH", "claim receipt differs from unique durable CLAIMED state");
    }
    const requestingAt = instant(options.requesting_at, "requesting_at");
    if (Date.parse(requestingAt) < Date.parse(current.claimed_at)
      || Date.parse(requestingAt) < Date.parse(opened.snapshot.head.updated_at)) {
      fail("INVALID_INPUT", "requesting_at is not monotonic");
    }
    const body: RequestingBody = {
      authorization_sha256: current.authorization_sha256,
      state: "REQUESTING",
      claim_id: current.claim_id,
      claimed_at: current.claimed_at,
      requesting_at: requestingAt,
      claim_file_sha256: current.claim_file_sha256,
      request_manifest_sha256: manifestSha,
      request_payload_sha256: payloadSha,
      consumption_ledger: opened.snapshot.binding,
    };
    const target = requestingPath(opened.custody.directory, current.authorization_sha256);
    const written = await writeExclusiveJson(
      target,
      envelope(WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA, body),
      "permit REQUESTING fence",
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        fail("PERMIT_ALREADY_CONSUMED", "permit is already REQUESTING or later");
      }
      throw error;
    });
    await fsyncDirectory(opened.custody);
    await advanceHead(
      opened.custody,
      opened.snapshot.head,
      opened.snapshot.identity_artifact_sha256,
      [...opened.snapshot.head.events, {
        file_name: path.basename(target),
        file_sha256: written.sha256,
        authorization_sha256: current.authorization_sha256,
        state: "REQUESTING",
      }],
      requestingAt,
    );
    const verified = await openInternal(options, true);
    const receipt = verified.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === current.authorization_sha256,
    );
    if (!receipt || receipt.state !== "REQUESTING") {
      fail("LEDGER_CORRUPT", "durable REQUESTING fence cannot be re-read exactly");
    }
    return receipt;
  });
}

export async function consumeWalmartListingRepairPermit(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  permit_authorization_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  claimed_at?: Date | string;
  requesting_at?: Date | string;
  random_uuid?: () => string;
}): Promise<WalmartListingRepairPermitRequestingReceipt> {
  const claim = await claimWalmartListingRepairPermit(options);
  return markWalmartListingRepairPermitRequesting({
    state_directory: options.state_directory,
    expected_binding: options.expected_binding,
    claim,
    request_manifest_sha256: options.request_manifest_sha256,
    request_payload_sha256: options.request_payload_sha256,
    requesting_at: options.requesting_at,
  });
}

export async function recordWalmartListingRepairPermitAccepted(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  requesting: WalmartListingRepairPermitRequestingReceipt;
  accepted_at?: Date | string;
  apply_id: string;
  feed_id: string;
  response_http_receipt_sha256: string;
  response_payload_sha256: string;
}): Promise<WalmartListingRepairPermitAcceptedReceipt> {
  const applyId = safeIdentifier(options.apply_id, "apply_id");
  const feedId = safeIdentifier(options.feed_id, "feed_id");
  const responseHttpSha = digest(options.response_http_receipt_sha256, "response HTTP receipt hash");
  const responseSha = digest(options.response_payload_sha256, "response payload hash");
  return mutate(options, async (opened) => {
    const current = opened.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === options.requesting.authorization_sha256,
    );
    if (!current || current.state !== "REQUESTING"
      || !exactJsonEqual(current, options.requesting)) {
      fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt differs from durable state");
    }
    const acceptedAt = instant(options.accepted_at, "accepted_at");
    if (Date.parse(acceptedAt) < Date.parse(current.requesting_at)
      || Date.parse(acceptedAt) < Date.parse(opened.snapshot.head.updated_at)) {
      fail("INVALID_INPUT", "accepted_at is not monotonic");
    }
    const body: AcceptedBody = {
      authorization_sha256: current.authorization_sha256,
      state: "ACCEPTED",
      claim_id: current.claim_id,
      claimed_at: current.claimed_at,
      requesting_at: current.requesting_at,
      accepted_at: acceptedAt,
      requesting_file_sha256: current.requesting_file_sha256,
      apply_id: applyId,
      feed_id: feedId,
      response_http_receipt_sha256: responseHttpSha,
      response_payload_sha256: responseSha,
      exact_listing_count: 1,
      marketplace_write_calls: 1,
      consumption_ledger: opened.snapshot.binding,
    };
    const target = acceptedPath(opened.custody.directory, current.authorization_sha256);
    const written = await writeExclusiveJson(
      target,
      envelope(WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA, body),
      "permit ACCEPTED checkpoint",
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        fail("PERMIT_ALREADY_CONSUMED", "permit already has an ACCEPTED checkpoint");
      }
      throw error;
    });
    await fsyncDirectory(opened.custody);
    await advanceHead(
      opened.custody,
      opened.snapshot.head,
      opened.snapshot.identity_artifact_sha256,
      [...opened.snapshot.head.events, {
        file_name: path.basename(target),
        file_sha256: written.sha256,
        authorization_sha256: current.authorization_sha256,
        state: "ACCEPTED",
      }],
      acceptedAt,
    );
    const verified = await openInternal(options, true);
    const receipt = verified.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === current.authorization_sha256,
    );
    if (!receipt || receipt.state !== "ACCEPTED") {
      fail("LEDGER_CORRUPT", "durable ACCEPTED checkpoint cannot be re-read exactly");
    }
    return receipt;
  });
}

function parseOutcome(
  outcome: WalmartListingRepairPermitTerminalOutcome,
  hasAccepted: boolean,
): Omit<WalmartListingRepairPermitTerminalOutcome, "terminal_at"> & { terminal_at: string } {
  const raw = record(outcome, "terminal outcome");
  exactKeys(raw, [
    "state", "terminal_at", "apply_id", "marketplace_write_calls", "feed_id",
    "response_http_receipt_sha256", "response_payload_sha256",
    "feed_status_http_receipt_sha256", "feed_status_payload_sha256", "error_code",
  ], "terminal outcome", "INVALID_INPUT");
  const parsed = {
    state: terminalState(raw.state),
    terminal_at: instant(
      raw.terminal_at instanceof Date || typeof raw.terminal_at === "string"
        ? raw.terminal_at : undefined,
      "terminal_at",
    ),
    apply_id: safeIdentifier(raw.apply_id, "apply_id"),
    marketplace_write_calls: raw.marketplace_write_calls === 0
      ? 0 as const : raw.marketplace_write_calls === 1
        ? 1 as const : fail("INVALID_INPUT", "marketplace_write_calls must be zero or one"),
    feed_id: raw.feed_id === null ? null : safeIdentifier(raw.feed_id, "feed_id"),
    response_http_receipt_sha256: nullableDigest(
      raw.response_http_receipt_sha256,
      "response HTTP receipt hash",
    ),
    response_payload_sha256: nullableDigest(raw.response_payload_sha256, "response payload hash"),
    feed_status_http_receipt_sha256: nullableDigest(
      raw.feed_status_http_receipt_sha256,
      "feed status HTTP receipt hash",
    ),
    feed_status_payload_sha256: nullableDigest(
      raw.feed_status_payload_sha256,
      "feed status payload hash",
    ),
    error_code: raw.error_code === null ? null : safeIdentifier(raw.error_code, "error_code"),
  };
  const responsePair = (parsed.response_http_receipt_sha256 === null)
    === (parsed.response_payload_sha256 === null);
  const statusPair = (parsed.feed_status_http_receipt_sha256 === null)
    === (parsed.feed_status_payload_sha256 === null);
  if (!responsePair || !statusPair) fail("INVALID_INPUT", "terminal evidence hashes must be pairs");
  if (parsed.state === "SUCCEEDED" && (!hasAccepted || parsed.marketplace_write_calls !== 1
    || parsed.feed_status_http_receipt_sha256 === null || parsed.error_code !== null)) {
    fail("INVALID_INPUT", "SUCCEEDED requires ACCEPTED plus feed-status evidence");
  }
  if (parsed.state !== "SUCCEEDED" && parsed.error_code === null) {
    fail("INVALID_INPUT", "non-success terminal outcome requires error_code");
  }
  if (hasAccepted && parsed.marketplace_write_calls !== 1) {
    fail("INVALID_INPUT", "ACCEPTED permit has exactly one marketplace write call");
  }
  if (!hasAccepted && parsed.marketplace_write_calls === 0
    && (parsed.feed_id !== null || parsed.response_http_receipt_sha256 !== null
      || parsed.feed_status_http_receipt_sha256 !== null)) {
    fail("INVALID_INPUT", "zero-call outcome cannot claim marketplace evidence");
  }
  if (!hasAccepted && parsed.state === "FAILED" && parsed.marketplace_write_calls === 1
    && parsed.response_http_receipt_sha256 === null) {
    fail("INVALID_INPUT", "definite one-call FAILED outcome requires response evidence");
  }
  return parsed;
}

export async function terminalizeWalmartListingRepairPermit(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  prior: WalmartListingRepairPermitRequestingReceipt | WalmartListingRepairPermitAcceptedReceipt;
  outcome: WalmartListingRepairPermitTerminalOutcome;
  random_uuid?: () => string;
}): Promise<WalmartListingRepairPermitTerminalReceipt> {
  return mutate(options, async (opened) => {
    const current = opened.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === options.prior.authorization_sha256,
    );
    if (!current || (current.state !== "REQUESTING" && current.state !== "ACCEPTED")
      || !exactJsonEqual(current, options.prior)) {
      fail("PRIOR_STATE_BINDING_MISMATCH", "terminal prior receipt differs from durable state");
    }
    const parsed = parseOutcome(options.outcome, current.state === "ACCEPTED");
    if (Date.parse(parsed.terminal_at) < Date.parse(
      current.state === "ACCEPTED" ? current.accepted_at : current.requesting_at,
    ) || Date.parse(parsed.terminal_at) < Date.parse(opened.snapshot.head.updated_at)) {
      fail("INVALID_INPUT", "terminal_at is not monotonic");
    }
    const accepted = current.state === "ACCEPTED" ? current : null;
    if (accepted && (parsed.apply_id !== accepted.apply_id
      || (parsed.feed_id !== null && parsed.feed_id !== accepted.feed_id)
      || (parsed.response_http_receipt_sha256 !== null
        && parsed.response_http_receipt_sha256 !== accepted.response_http_receipt_sha256)
      || (parsed.response_payload_sha256 !== null
        && parsed.response_payload_sha256 !== accepted.response_payload_sha256))) {
      fail("INVALID_INPUT", "terminal outcome conflicts with durable ACCEPTED checkpoint");
    }
    const body: TerminalBody = {
      authorization_sha256: current.authorization_sha256,
      state: parsed.state,
      consumption_id: uuidId("consumption", options.random_uuid ?? randomUUID),
      claim_id: current.claim_id,
      claimed_at: current.claimed_at,
      requesting_at: current.requesting_at,
      accepted_at: accepted?.accepted_at ?? null,
      terminal_at: parsed.terminal_at,
      prior_state: accepted ? "ACCEPTED" : "REQUESTING",
      prior_state_file_sha256: accepted
        ? accepted.accepted_file_sha256 : current.requesting_file_sha256,
      requesting_file_sha256: current.requesting_file_sha256,
      accepted_file_sha256: accepted?.accepted_file_sha256 ?? null,
      apply_id: accepted?.apply_id ?? parsed.apply_id,
      feed_id: accepted?.feed_id ?? parsed.feed_id,
      response_http_receipt_sha256: accepted?.response_http_receipt_sha256
        ?? parsed.response_http_receipt_sha256,
      response_payload_sha256: accepted?.response_payload_sha256
        ?? parsed.response_payload_sha256,
      feed_status_http_receipt_sha256: parsed.feed_status_http_receipt_sha256,
      feed_status_payload_sha256: parsed.feed_status_payload_sha256,
      exact_listing_count: 1,
      marketplace_write_calls: parsed.marketplace_write_calls,
      error_code: parsed.error_code,
      consumption_ledger: opened.snapshot.binding,
    };
    const target = terminalPath(opened.custody.directory, current.authorization_sha256);
    const written = await writeExclusiveJson(
      target,
      envelope(WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA, body),
      "permit terminal outcome",
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        fail("PERMIT_ALREADY_CONSUMED", "permit already has a terminal outcome");
      }
      throw error;
    });
    await fsyncDirectory(opened.custody);
    await advanceHead(
      opened.custody,
      opened.snapshot.head,
      opened.snapshot.identity_artifact_sha256,
      [...opened.snapshot.head.events, {
        file_name: path.basename(target),
        file_sha256: written.sha256,
        authorization_sha256: current.authorization_sha256,
        state: body.state,
      }],
      body.terminal_at,
    );
    const verified = await openInternal(options, true);
    const receipt = verified.snapshot.permits.find(
      (entry) => entry.authorization_sha256 === current.authorization_sha256,
    );
    if (!receipt || receipt.state !== body.state
      || !("terminal_file_sha256" in receipt)
      || receipt.terminal_file_sha256 !== written.sha256) {
      fail("LEDGER_CORRUPT", "durable terminal outcome cannot be re-read exactly");
    }
    return receipt;
  });
}

export async function readWalmartListingRepairPermitLedgerEvidence(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  permit_authorization_sha256: string;
}): Promise<WalmartListingRepairPermitLedgerEvidence> {
  const authorizationSha = digest(options.permit_authorization_sha256, "permit authorization hash");
  const before = await openInternal(options, false);
  const row = before.scanned.get(authorizationSha);
  const receipt = before.snapshot.permits.find(
    (entry) => entry.authorization_sha256 === authorizationSha,
  );
  if (!row || !receipt) fail("PERMIT_NOT_FOUND", "permit has no durable ledger entry");
  const identity = await readBoundJson(before.snapshot.identity_artifact_path, "ledger identity evidence");
  const head = await readBoundJson(before.snapshot.head.artifact_path, "ledger head evidence");
  const after = await openInternal(options, false);
  if (after.snapshot.head.artifact_sha256 !== before.snapshot.head.artifact_sha256
    || identity.sha256 !== before.snapshot.identity_artifact_sha256
    || head.sha256 !== before.snapshot.head.artifact_sha256) {
    fail("LEDGER_CHANGED_DURING_READ", "ledger changed during evidence capture");
  }
  return {
    state: receipt.state,
    receipt,
    identity_bytes: identity.bytes,
    identity_sha256: identity.sha256,
    head_bytes: head.bytes,
    head_sha256: head.sha256,
    exact_event_inventory: before.snapshot.head.events,
    claim_bytes: row.claim_file.bytes,
    claim_sha256: row.claim_file.sha256,
    requesting_bytes: row.requesting_file?.bytes ?? null,
    requesting_sha256: row.requesting_file?.sha256 ?? null,
    accepted_bytes: row.accepted_file?.bytes ?? null,
    accepted_sha256: row.accepted_file?.sha256 ?? null,
    terminal_bytes: row.terminal_file?.bytes ?? null,
    terminal_sha256: row.terminal_file?.sha256 ?? null,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
}

/** Exact custody read used immediately before the only permitted write call. */
export async function loadWalmartListingRepairPermitRequesting(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  permit_authorization_sha256: string;
}): Promise<WalmartListingRepairPermitRequestingLoad> {
  const evidence = await readWalmartListingRepairPermitLedgerEvidence(options);
  if (evidence.state !== "REQUESTING" || evidence.receipt.state !== "REQUESTING"
    || evidence.requesting_bytes === null || evidence.requesting_sha256 === null) {
    fail("PERMIT_NOT_REQUESTING", "permit is not in the unique REQUESTING state");
  }
  return {
    receipt: evidence.receipt,
    requesting_bytes: evidence.requesting_bytes,
    requesting_sha256: evidence.requesting_sha256,
    head_bytes: evidence.head_bytes,
    head_sha256: evidence.head_sha256,
    exact_event_inventory: evidence.exact_event_inventory,
  };
}

/**
 * Crash recovery for the non-replayable CLAIMED fence. The caller must verify
 * the same signed permit and then pass its exact request hashes to
 * markWalmartListingRepairPermitRequesting; this never creates a second claim.
 */
export async function loadWalmartListingRepairPermitClaimed(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  permit_authorization_sha256: string;
}): Promise<WalmartListingRepairPermitClaimedLoad> {
  const evidence = await readWalmartListingRepairPermitLedgerEvidence(options);
  if (evidence.state !== "CLAIMED" || evidence.receipt.state !== "CLAIMED") {
    fail("PERMIT_NOT_CLAIMED", "permit is not in the unique CLAIMED state");
  }
  return {
    receipt: evidence.receipt,
    claim_bytes: evidence.claim_bytes,
    claim_sha256: evidence.claim_sha256,
    head_bytes: evidence.head_bytes,
    head_sha256: evidence.head_sha256,
    exact_event_inventory: evidence.exact_event_inventory,
  };
}

/** Exact custody read for GET-only resume after a definite accepted POST. */
export async function loadWalmartListingRepairPermitAccepted(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
  permit_authorization_sha256: string;
}): Promise<WalmartListingRepairPermitAcceptedLoad> {
  const evidence = await readWalmartListingRepairPermitLedgerEvidence(options);
  if (evidence.state !== "ACCEPTED" || evidence.receipt.state !== "ACCEPTED"
    || evidence.accepted_bytes === null || evidence.accepted_sha256 === null) {
    fail("PERMIT_NOT_ACCEPTED", "permit is not in the unique ACCEPTED state");
  }
  return {
    receipt: evidence.receipt,
    accepted_bytes: evidence.accepted_bytes,
    accepted_sha256: evidence.accepted_sha256,
    head_bytes: evidence.head_bytes,
    head_sha256: evidence.head_sha256,
    exact_event_inventory: evidence.exact_event_inventory,
  };
}
