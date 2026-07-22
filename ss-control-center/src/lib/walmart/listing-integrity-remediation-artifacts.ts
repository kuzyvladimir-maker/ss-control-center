/**
 * Immutable local custody for one Walmart Listing Integrity repair permit.
 *
 * The only mutable state is the filesystem namespace while an exclusive file
 * is being published. Durable authority comes exclusively from immutable,
 * content-addressed object and commit files. There is no mutable head/index.
 *
 * This is an intact single-host/single-UID custody boundary. It does not resist
 * root or a hostile same-UID actor that can replace the entire tree and reseal
 * it, and it does not claim distributed consensus or a Walmart signature.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
  WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
  parseWalmartListingRepairOneSkuPermitSignedBody,
  walmartListingRepairAuthoritySha256,
  type WalmartListingRepairListingIdentity,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairOneSkuPermitSignedBody,
} from "./listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
  WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
  WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES,
  WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES,
  type WalmartListingRepairAcceptedReceipt,
  type WalmartListingRepairArtifactSink,
} from "./listing-integrity-remediation-writer.ts";
import type {
  WalmartListingRepairPermitTerminalReceipt,
} from "./listing-integrity-remediation-ledger.ts";

export const WALMART_LISTING_REPAIR_ARTIFACT_IDENTITY_SCHEMA =
  "walmart-listing-repair-artifact-custody-identity/v1" as const;
export const WALMART_LISTING_REPAIR_ARTIFACT_COMMIT_SCHEMA =
  "walmart-listing-repair-artifact-custody-commit/v1" as const;
export const WALMART_LISTING_REPAIR_ARTIFACT_EVIDENCE_SCHEMA =
  "walmart-listing-repair-artifact-custody-evidence/v1" as const;

const IDENTITY_FILE = ".artifact-custody-identity.json";
const OPERATION_LOCK_FILE = ".artifact-custody-operation.lock";
const OPERATION_LOCK_SCHEMA = "walmart-listing-repair-artifact-operation-lock/v1";
const OBJECTS_DIR = "objects";
const STAGING_DIR = "staging";
const STAGES = ["PREPARED_REQUEST", "POST_RESPONSE", "FEED_STATUS"] as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;
const MAX_COMMIT_BYTES = 1024 * 1024;
const MAX_INVENTORY_FILES = 20_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OBJECT_FILE_PATTERN = /^sha256-([a-f0-9]{64})\.blob$/u;
const COMMIT_FILE_PATTERN = /^commit-([a-f0-9]{64})\.json$/u;
const STAGING_FILE_PATTERN = /^\.publish-[0-9a-f-]{36}\.tmp$/u;
const FEED_HTTP_PATTERN = /^feed-status-([a-f0-9]{64})\.http\.json$/u;
const FEED_PAYLOAD_PATTERN = /^feed-status-([a-f0-9]{64})\.payload\.bin$/u;

type JsonRecord = Record<string, unknown>;
type Stage = typeof STAGES[number];

interface FileIdentity {
  path: string;
  path_sha256: string;
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: 256;
  nlink: 1;
}

interface DirectoryIdentity {
  path: string;
  path_sha256: string;
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: 448;
}

interface CustodyPaths {
  root: string;
  permit: string;
  objects: string;
  staging: string;
  stages: Record<Stage, string>;
}

interface CustodyDirectories {
  root: DirectoryIdentity;
  permit: DirectoryIdentity;
  objects: DirectoryIdentity;
  staging: DirectoryIdentity;
  stages: Record<Stage, DirectoryIdentity>;
}

interface PermitBinding {
  permit_authorization_sha256: string;
  permit_id: string;
  listing: WalmartListingRepairListingIdentity;
  plan_id: string;
  plan_body_sha256: string;
  target_sha256: string;
  target_image_certificate_sha256: string;
  apply_engine_release_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  ledger_id: string;
  ledger_epoch: string;
  consumption_ledger_binding_sha256: string;
}

interface IdentityBody extends JsonRecord {
  permit_binding: PermitBinding;
  directories: CustodyDirectories;
  object_filename_policy: "sha256-{digest}.blob/exclusive-content-addressed/v1";
  commit_filename_policy: "commit-{file-sha256}.json/exclusive-content-addressed/v1";
  trusted_single_custody_host_only: true;
  hostile_same_uid_resistance_claimed: false;
  distributed_consensus_claimed: false;
}

interface Envelope {
  schema_version: string;
  body: JsonRecord;
  body_sha256: string;
}

interface ObjectArtifact {
  bytes: Buffer;
  sha256: string;
  file_name: string;
  identity: FileIdentity;
}

interface ArtifactReference extends JsonRecord {
  name: string;
  object_file_name: string;
  sha256: string;
  byte_length: number;
  object_path_sha256: string;
  device: string;
  inode: string;
  uid: number;
  gid: number;
}

interface CommitBody extends JsonRecord {
  identity_artifact_sha256: string;
  permit_authorization_sha256: string;
  stage: Stage;
  artifact_set: string;
  feed_id: string | null;
  artifacts: ArtifactReference[];
}

interface CommitArtifact {
  stage: Stage;
  file_name: string;
  file_sha256: string;
  file_identity: FileIdentity;
  body_sha256: string;
  artifact_set: string;
  feed_id: string | null;
  references: ArtifactReference[];
}

interface ParsedHttpReceipt {
  operation: "MAINTENANCE_POST" | "FEED_STATUS_GET";
  feed_id: string | null;
  status: number;
  request_correlation_id_sha256: string;
}

interface OpenedCustody {
  paths: CustodyPaths;
  directories: CustodyDirectories;
  binding: PermitBinding;
  identity_body: IdentityBody;
  identity_file: ObjectArtifact;
  operation_lock: ObjectArtifact;
}

interface CustodyInventoryNames {
  root: string[];
  permit: string[];
  objects: string[];
  staging: string[];
  stages: Record<Stage, string[]>;
}

interface CustodyScan extends OpenedCustody {
  objects: Map<string, ObjectArtifact>;
  commits: CommitArtifact[];
  referenced_by: Map<string, string[]>;
  accepted_feed_id: string | null;
  inventory_names: CustodyInventoryNames;
}

export interface WalmartListingRepairArtifactObjectEvidence {
  file_name: string;
  file_sha256: string;
  byte_length: number;
  file_identity: FileIdentity;
  referenced_by_commit_sha256: string[];
  orphan: boolean;
}

export interface WalmartListingRepairArtifactCommitEvidence {
  stage: Stage;
  file_name: string;
  file_sha256: string;
  body_sha256: string;
  artifact_set: string;
  feed_id: string | null;
  file_identity: FileIdentity;
  artifacts: ArtifactReference[];
}

export interface WalmartListingRepairArtifactCustodyEvidence {
  schema_version: typeof WALMART_LISTING_REPAIR_ARTIFACT_EVIDENCE_SCHEMA;
  permit_binding: PermitBinding;
  identity_artifact_path: string;
  identity_artifact_sha256: string;
  identity_body_sha256: string;
  directories: CustodyDirectories;
  objects: WalmartListingRepairArtifactObjectEvidence[];
  commits: WalmartListingRepairArtifactCommitEvidence[];
  staging_orphans: Array<{
    file_name: string;
    file_sha256: string;
    byte_length: number;
    file_identity: FileIdentity;
  }>;
  inventory_sha256: string;
  claims: {
    content_addressed_objects: true;
    append_only_immutable_commits: true;
    mutable_head_present: false;
    marketplace_authority_claimed: false;
    hostile_same_uid_resistance_claimed: false;
  };
}

export interface WalmartListingRepairArtifactCustody
  extends WalmartListingRepairArtifactSink {
  readonly custody_root: string;
  readonly permit_authorization_sha256: string;
  readEvidence(): Promise<WalmartListingRepairArtifactCustodyEvidence>;
  loadSucceededTerminal(input: {
    permit: WalmartListingRepairOneSkuPermit;
    terminal: WalmartListingRepairPermitTerminalReceipt;
  }): Promise<WalmartListingRepairSucceededTerminalArtifacts>;
}

export interface WalmartListingRepairLockedArtifactCustodyReader {
  readEvidence(): Promise<WalmartListingRepairArtifactCustodyEvidence>;
  loadSucceededTerminal(input: {
    terminal: WalmartListingRepairPermitTerminalReceipt;
  }): Promise<WalmartListingRepairSucceededTerminalArtifacts>;
}

export interface WalmartListingRepairSucceededTerminalArtifacts {
  request_manifest_bytes: Uint8Array;
  request_payload_bytes: Uint8Array;
  response_http_receipt_bytes: Uint8Array;
  response_payload_bytes: Uint8Array;
  feed_status_http_receipt_bytes: Uint8Array;
  feed_status_payload_bytes: Uint8Array;
  surgical: {
    target_image_certificate_bytes: Uint8Array;
    schema_contract_bytes: Uint8Array;
    get_spec_receipt_bytes: Uint8Array;
    live_item_receipt_bytes: Uint8Array;
    get_spec_request_bytes: Uint8Array;
    get_spec_response_bytes: Uint8Array;
    live_item_response_bytes: Uint8Array;
  };
}

export class WalmartListingRepairArtifactCustodyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairArtifactCustodyError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairArtifactCustodyError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ARTIFACT_INVALID", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((entry, index) => entry !== wanted[index])) {
    fail("ARTIFACT_CORRUPT", `${label} has missing or extra fields`);
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
  if (encoded === undefined) fail("ARTIFACT_INVALID", "canonical JSON rejects undefined");
  return encoded;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("ARTIFACT_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("ARTIFACT_INVALID", `${label} must be a bounded exact string`);
  }
  return value;
}

function boundedBytes(value: unknown, label: string, maximum: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    fail("ARTIFACT_INVALID", `${label} must contain bounded non-empty bytes`);
  }
  return Buffer.from(value);
}

function exactEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function noFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail("ARTIFACT_UNSUPPORTED_PLATFORM", "O_NOFOLLOW is required for custody");
  }
  return fsConstants.O_NOFOLLOW;
}

function directoryFlag(): number {
  if (typeof fsConstants.O_DIRECTORY !== "number") {
    fail("ARTIFACT_UNSUPPORTED_PLATFORM", "O_DIRECTORY is required for custody");
  }
  return fsConstants.O_DIRECTORY;
}

function absoluteRoot(value: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || !path.isAbsolute(value) || path.resolve(value) !== value
    || value === path.parse(value).root) {
    fail("ARTIFACT_CUSTODY_INVALID", "custody_root must be an exact absolute non-root path");
  }
  return value;
}

async function assertNoSymlinkAncestry(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => {
      fail("ARTIFACT_CUSTODY_INVALID", `custody ancestry is missing: ${current}`);
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail("ARTIFACT_CUSTODY_INVALID", `custody ancestry is not a real directory: ${current}`);
    }
  }
}

function directoryIdentityFrom(pathname: string, info: {
  dev: number | bigint;
  ino: number | bigint;
  uid: number;
  gid: number;
  mode: number;
}): DirectoryIdentity {
  return {
    path: pathname,
    path_sha256: sha256(pathname),
    device: String(info.dev),
    inode: String(info.ino),
    uid: info.uid,
    gid: info.gid,
    mode: PRIVATE_DIRECTORY_MODE,
  };
}

async function inspectDirectory(directory: string): Promise<DirectoryIdentity> {
  await assertNoSymlinkAncestry(directory);
  const before = await lstat(directory).catch(() => {
    fail("ARTIFACT_CUSTODY_INVALID", `directory cannot be inspected: ${directory}`);
  });
  const canonical = await realpath(directory).catch(() => {
    fail("ARTIFACT_CUSTODY_INVALID", `directory realpath cannot be resolved: ${directory}`);
  });
  if (canonical !== directory || !before.isDirectory() || before.isSymbolicLink()
    || (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("ARTIFACT_CUSTODY_INVALID", `directory must be a real mode-0700 path: ${directory}`);
  }
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | noFollowFlag() | directoryFlag(),
  ).catch(() => fail("ARTIFACT_CUSTODY_INVALID", `directory cannot be opened safely: ${directory}`));
  let descriptor;
  try {
    descriptor = await handle.stat();
  } finally {
    await handle.close();
  }
  const after = await lstat(directory).catch(() => {
    fail("ARTIFACT_CUSTODY_INVALID", `directory changed during inspection: ${directory}`);
  });
  if (!descriptor.isDirectory() || String(before.dev) !== String(descriptor.dev)
    || String(before.ino) !== String(descriptor.ino)
    || String(after.dev) !== String(descriptor.dev)
    || String(after.ino) !== String(descriptor.ino)
    || descriptor.uid !== before.uid || descriptor.gid !== before.gid
    || after.uid !== before.uid || after.gid !== before.gid
    || (descriptor.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("ARTIFACT_CUSTODY_INVALID", `directory identity changed: ${directory}`);
  }
  return directoryIdentityFrom(directory, descriptor);
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return exactEqual(left, right);
}

async function syncDirectory(identity: DirectoryIdentity): Promise<void> {
  const current = await inspectDirectory(identity.path);
  if (!sameDirectory(identity, current)) {
    fail("ARTIFACT_CUSTODY_INVALID", `directory identity drifted: ${identity.path}`);
  }
  const handle = await open(
    identity.path,
    fsConstants.O_RDONLY | noFollowFlag() | directoryFlag(),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!sameDirectory(identity, await inspectDirectory(identity.path))) {
    fail("ARTIFACT_CUSTODY_INVALID", `directory changed after fsync: ${identity.path}`);
  }
}

async function syncRealAncestor(directory: string): Promise<void> {
  await assertNoSymlinkAncestry(directory);
  const before = await lstat(directory);
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | noFollowFlag() | directoryFlag(),
  ).catch(() => fail("ARTIFACT_CUSTODY_INVALID", "custody parent cannot be opened safely"));
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isDirectory() || String(descriptor.dev) !== String(before.dev)
      || String(descriptor.ino) !== String(before.ino)) {
      fail("ARTIFACT_CUSTODY_INVALID", "custody parent identity changed before fsync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileIdentityFrom(pathname: string, info: {
  dev: number | bigint;
  ino: number | bigint;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
}): FileIdentity {
  return {
    path: pathname,
    path_sha256: sha256(pathname),
    device: String(info.dev),
    inode: String(info.ino),
    uid: info.uid,
    gid: info.gid,
    mode: IMMUTABLE_FILE_MODE,
    nlink: 1,
  };
}

async function readImmutableFile(
  file: string,
  maximum: number,
  expectedOwner: { uid: number; gid: number },
): Promise<ObjectArtifact> {
  const pathBefore = await lstat(file).catch(() => {
    fail("ARTIFACT_CORRUPT", `artifact is missing: ${file}`);
  });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1
    || (pathBefore.mode & 0o777) !== IMMUTABLE_FILE_MODE
    || pathBefore.uid !== expectedOwner.uid || pathBefore.gid !== expectedOwner.gid
    || pathBefore.size < 1 || pathBefore.size > maximum) {
    fail("ARTIFACT_CORRUPT", `artifact lacks mode-0400 nlink-1 custody: ${file}`);
  }
  const handle = await open(file, fsConstants.O_RDONLY | noFollowFlag()).catch(() => {
    fail("ARTIFACT_CORRUPT", `artifact cannot be opened no-follow: ${file}`);
  });
  let before;
  let after;
  let bytes;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || (before.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || String(before.dev) !== String(pathBefore.dev)
      || String(before.ino) !== String(pathBefore.ino)
      || before.uid !== expectedOwner.uid || before.gid !== expectedOwner.gid) {
      fail("ARTIFACT_CORRUPT", `artifact descriptor custody is invalid: ${file}`);
    }
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(file).catch(() => {
    fail("ARTIFACT_CORRUPT", `artifact disappeared during read: ${file}`);
  });
  if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
    || String(after.dev) !== String(pathAfter.dev) || String(after.ino) !== String(pathAfter.ino)
    || before.size !== after.size || after.size !== pathAfter.size || bytes.byteLength !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || after.nlink !== 1 || pathAfter.nlink !== 1
    || (after.mode & 0o777) !== IMMUTABLE_FILE_MODE
    || (pathAfter.mode & 0o777) !== IMMUTABLE_FILE_MODE) {
    fail("ARTIFACT_CORRUPT", `artifact changed during read: ${file}`);
  }
  return {
    bytes: Buffer.from(bytes),
    sha256: sha256(bytes),
    file_name: path.basename(file),
    identity: fileIdentityFrom(file, after),
  };
}

function envelope(schema: string, body: JsonRecord): Envelope {
  return { schema_version: schema, body, body_sha256: sha256(canonicalJson(body)) };
}

function parseCanonicalEnvelope(artifact: ObjectArtifact, schema: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes));
  } catch {
    fail("ARTIFACT_CORRUPT", `${label} is not valid UTF-8 JSON`);
  }
  const raw = record(value, label);
  if (!artifact.bytes.equals(canonicalBytes(raw))) {
    fail("ARTIFACT_CORRUPT", `${label} is not canonical immutable JSON`);
  }
  exactKeys(raw, ["schema_version", "body", "body_sha256"], label);
  if (raw.schema_version !== schema) fail("ARTIFACT_CORRUPT", `${label} schema is invalid`);
  const body = record(raw.body, `${label}.body`);
  if (digest(raw.body_sha256, `${label}.body_sha256`) !== sha256(canonicalJson(body))) {
    fail("ARTIFACT_CORRUPT", `${label} body hash is invalid`);
  }
  return body;
}

async function atomicPublish(input: {
  staging: DirectoryIdentity;
  target: DirectoryIdentity;
  final_path: string;
  bytes: Buffer;
  maximum: number;
}): Promise<ObjectArtifact> {
  const finalName = path.basename(input.final_path);
  if (path.dirname(input.final_path) !== input.target.path || finalName.includes(path.sep)) {
    fail("ARTIFACT_INVALID", "publish target escapes its exact directory");
  }
  const temporaryPath = path.join(input.staging.path, `.publish-${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    0o600,
  ).catch(() => fail("ARTIFACT_CUSTODY_INVALID", "exclusive staging create failed"));
  try {
    await handle.writeFile(input.bytes);
    await handle.chmod(IMMUTABLE_FILE_MODE);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1
      || (info.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || info.size !== input.bytes.byteLength
      || info.uid !== input.staging.uid || info.gid !== input.staging.gid) {
      fail("ARTIFACT_CUSTODY_INVALID", "staging artifact custody is invalid");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(input.staging);
  let collision = false;
  try {
    await link(temporaryPath, input.final_path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") collision = true;
    else fail("ARTIFACT_CUSTODY_INVALID", `atomic no-replace publish failed: ${finalName}`);
  }
  if (!collision) await syncDirectory(input.target);
  await unlink(temporaryPath).catch(() => {
    fail("ARTIFACT_CUSTODY_INVALID", "staging artifact could not be unlinked after publish");
  });
  await syncDirectory(input.staging);
  const loaded = await readImmutableFile(
    input.final_path,
    input.maximum,
    { uid: input.target.uid, gid: input.target.gid },
  );
  if (!loaded.bytes.equals(input.bytes)) {
    fail("ARTIFACT_COLLISION", `immutable name collision has different bytes: ${finalName}`);
  }
  return loaded;
}

function permitBinding(permit: WalmartListingRepairOneSkuPermit): {
  body: WalmartListingRepairOneSkuPermitSignedBody;
  binding: PermitBinding;
} {
  const raw = record(permit, "permit");
  exactKeys(raw, [
    "schema_version", "algorithm", "key_id", "owner_public_key_spki_sha256",
    "signed_body", "signature_base64", "signature_sha256", "authorization_sha256",
  ], "permit");
  if (raw.schema_version !== WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA
    || raw.algorithm !== WALMART_LISTING_REPAIR_OWNER_ALGORITHM) {
    fail("ARTIFACT_BINDING_MISMATCH", "permit envelope is invalid");
  }
  const body = parseWalmartListingRepairOneSkuPermitSignedBody(raw.signed_body);
  const signatureText = exactText(raw.signature_base64, "permit signature", 256);
  const signature = Buffer.from(signatureText, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== signatureText
    || sha256(signature) !== digest(raw.signature_sha256, "permit signature SHA")) {
    fail("ARTIFACT_BINDING_MISMATCH", "permit signature encoding/hash is invalid");
  }
  const unsigned = {
    schema_version: raw.schema_version,
    algorithm: raw.algorithm,
    key_id: exactText(raw.key_id, "permit key_id", 200),
    owner_public_key_spki_sha256: digest(
      raw.owner_public_key_spki_sha256,
      "permit owner key fingerprint",
    ),
    signed_body: body,
    signature_base64: signatureText,
    signature_sha256: raw.signature_sha256,
  };
  const authorizationSha = digest(raw.authorization_sha256, "permit authorization SHA");
  if (walmartListingRepairAuthoritySha256(unsigned) !== authorizationSha) {
    fail("ARTIFACT_BINDING_MISMATCH", "permit authorization SHA is invalid");
  }
  const ledger = body.consumption_ledger;
  return {
    body,
    binding: {
      permit_authorization_sha256: authorizationSha,
      permit_id: body.permit_id,
      listing: body.listing,
      plan_id: body.plan_id,
      plan_body_sha256: body.plan_body_sha256,
      target_sha256: body.target_sha256,
      target_image_certificate_sha256: body.target_image_certificate_sha256,
      apply_engine_release_sha256: body.apply_engine_release_sha256,
      request_manifest_sha256: body.request_manifest_sha256,
      request_payload_sha256: body.request_payload_sha256,
      ledger_id: ledger.ledger_id,
      ledger_epoch: ledger.ledger_epoch,
      consumption_ledger_binding_sha256: walmartListingRepairAuthoritySha256(ledger),
    },
  };
}

function custodyPaths(root: string, authorizationSha: string): CustodyPaths {
  const permit = path.join(root, authorizationSha);
  return {
    root,
    permit,
    objects: path.join(permit, OBJECTS_DIR),
    staging: path.join(permit, STAGING_DIR),
    stages: {
      PREPARED_REQUEST: path.join(permit, "PREPARED_REQUEST"),
      POST_RESPONSE: path.join(permit, "POST_RESPONSE"),
      FEED_STATUS: path.join(permit, "FEED_STATUS"),
    },
  };
}

async function inspectAllDirectories(paths: CustodyPaths): Promise<CustodyDirectories> {
  const [root, permit, objects, staging, prepared, post, feed] = await Promise.all([
    inspectDirectory(paths.root),
    inspectDirectory(paths.permit),
    inspectDirectory(paths.objects),
    inspectDirectory(paths.staging),
    inspectDirectory(paths.stages.PREPARED_REQUEST),
    inspectDirectory(paths.stages.POST_RESPONSE),
    inspectDirectory(paths.stages.FEED_STATUS),
  ]);
  for (const entry of [permit, objects, staging, prepared, post, feed]) {
    if (entry.uid !== root.uid || entry.gid !== root.gid) {
      fail("ARTIFACT_CUSTODY_INVALID", "custody directories have different owners");
    }
  }
  return {
    root,
    permit,
    objects,
    staging,
    stages: { PREPARED_REQUEST: prepared, POST_RESPONSE: post, FEED_STATUS: feed },
  };
}

function identityBody(binding: PermitBinding, directories: CustodyDirectories): IdentityBody {
  return {
    permit_binding: binding,
    directories,
    object_filename_policy: "sha256-{digest}.blob/exclusive-content-addressed/v1",
    commit_filename_policy: "commit-{file-sha256}.json/exclusive-content-addressed/v1",
    trusted_single_custody_host_only: true,
    hostile_same_uid_resistance_claimed: false,
    distributed_consensus_claimed: false,
  };
}

async function createPrivateDirectory(directory: string): Promise<void> {
  let created = true;
  await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE }).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      fail("ARTIFACT_CUSTODY_INVALID", `directory cannot be created: ${directory}`);
    }
    created = false;
  });
  if (created) {
    await chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => {
      fail("ARTIFACT_CUSTODY_INVALID", `directory mode cannot be fixed: ${directory}`);
    });
  }
  await inspectDirectory(directory);
}

async function ensureCustodyRoot(root: string): Promise<DirectoryIdentity> {
  const parent = path.dirname(root);
  await assertNoSymlinkAncestry(parent);
  const exists = await lstat(root).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    fail("ARTIFACT_CUSTODY_INVALID", "custody root cannot be inspected");
  });
  if (!exists) {
    await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(root, PRIVATE_DIRECTORY_MODE);
    await syncRealAncestor(parent);
  }
  return inspectDirectory(root);
}

async function acquireOperationLock(
  root: string,
  allowCreateRoot: boolean,
): Promise<ObjectArtifact> {
  const rootIdentity = allowCreateRoot
    ? await ensureCustodyRoot(root)
    : await inspectDirectory(root);
  const lockPath = path.join(root, OPERATION_LOCK_FILE);
  const lockBytes = canonicalBytes(envelope(OPERATION_LOCK_SCHEMA, {
    operation_id: `operation-${randomUUID()}`,
    process_id: process.pid,
  }));
  let handle;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      IMMUTABLE_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      fail(
        "ARTIFACT_MANUAL_REVIEW_REQUIRED",
        "artifact custody operation lock already exists; never auto-reclaim it",
      );
    }
    fail("ARTIFACT_CUSTODY_INVALID", "artifact custody operation lock cannot be created");
  }
  try {
    await handle.writeFile(lockBytes);
    await handle.chmod(IMMUTABLE_FILE_MODE);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1
      || (info.mode & 0o777) !== IMMUTABLE_FILE_MODE
      || info.uid !== rootIdentity.uid || info.gid !== rootIdentity.gid
      || info.size !== lockBytes.byteLength) {
      fail("ARTIFACT_CUSTODY_INVALID", "artifact custody operation lock is invalid");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(rootIdentity);
  const lock = await readImmutableFile(lockPath, MAX_COMMIT_BYTES, rootIdentity);
  if (!lock.bytes.equals(lockBytes)) {
    fail("ARTIFACT_CUSTODY_INVALID", "artifact custody operation lock bytes drifted");
  }
  return lock;
}

async function releaseOperationLock(root: string, expected: ObjectArtifact): Promise<void> {
  const rootIdentity = await inspectDirectory(root);
  const lockPath = path.join(root, OPERATION_LOCK_FILE);
  const current = await readImmutableFile(lockPath, MAX_COMMIT_BYTES, rootIdentity).catch(() => {
    fail(
      "ARTIFACT_MANUAL_REVIEW_REQUIRED",
      "artifact custody operation lock cannot be verified before release",
    );
  });
  if (current.sha256 !== expected.sha256
    || current.identity.device !== expected.identity.device
    || current.identity.inode !== expected.identity.inode
    || !current.bytes.equals(expected.bytes)) {
    fail(
      "ARTIFACT_MANUAL_REVIEW_REQUIRED",
      "artifact custody operation lock identity changed; refusing to unlink it",
    );
  }
  await unlink(lockPath).catch(() => {
    fail(
      "ARTIFACT_MANUAL_REVIEW_REQUIRED",
      "artifact custody operation lock cannot be released",
    );
  });
  await syncDirectory(rootIdentity);
  const remains = await lstat(lockPath).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    fail("ARTIFACT_MANUAL_REVIEW_REQUIRED", "artifact custody lock release is ambiguous");
  });
  if (remains) {
    fail("ARTIFACT_MANUAL_REVIEW_REQUIRED", "artifact custody operation lock still exists");
  }
}

async function bootstrap(
  root: string,
  binding: PermitBinding,
  operationLock: ObjectArtifact,
): Promise<void> {
  await ensureCustodyRoot(root);
  const rootNames = (await readdir(root)).sort();
  if (exactEqual(rootNames, [OPERATION_LOCK_FILE])) {
    // This process owns the only root entry and may initialize the custody tree.
  } else if (rootNames.includes(IDENTITY_FILE)
    && rootNames.includes(binding.permit_authorization_sha256)
    && rootNames.includes(OPERATION_LOCK_FILE)) {
    return;
  } else {
    fail("ARTIFACT_CUSTODY_INVALID", "custody root cannot be bootstrapped from this inventory");
  }
  if (operationLock.identity.path !== path.join(root, OPERATION_LOCK_FILE)) {
    fail("ARTIFACT_CUSTODY_INVALID", "bootstrap operation lock belongs to another root");
  }
  const paths = custodyPaths(root, binding.permit_authorization_sha256);
  await createPrivateDirectory(paths.permit);
  await createPrivateDirectory(paths.objects);
  await createPrivateDirectory(paths.staging);
  for (const stage of STAGES) await createPrivateDirectory(paths.stages[stage]);
  const directories = await inspectAllDirectories(paths);
  await syncDirectory(directories.permit);
  const body = identityBody(binding, directories);
  const bytes = canonicalBytes(envelope(WALMART_LISTING_REPAIR_ARTIFACT_IDENTITY_SCHEMA, body));
  await atomicPublish({
    staging: directories.staging,
    target: directories.root,
    final_path: path.join(root, IDENTITY_FILE),
    bytes,
    maximum: MAX_COMMIT_BYTES,
  });
  await syncDirectory(directories.root);
}

async function exactNames(directory: string): Promise<string[]> {
  const before = (await readdir(directory)).sort();
  if (before.length > MAX_INVENTORY_FILES) {
    fail("ARTIFACT_CORRUPT", `directory inventory is too large: ${directory}`);
  }
  const after = (await readdir(directory)).sort();
  if (!exactEqual(before, after)) fail("ARTIFACT_CORRUPT", "directory changed during scan");
  return before;
}

async function captureInventoryNames(opened: OpenedCustody): Promise<CustodyInventoryNames> {
  const [root, permit, objects, staging, prepared, post, feed] = await Promise.all([
    exactNames(opened.paths.root),
    exactNames(opened.paths.permit),
    exactNames(opened.paths.objects),
    exactNames(opened.paths.staging),
    exactNames(opened.paths.stages.PREPARED_REQUEST),
    exactNames(opened.paths.stages.POST_RESPONSE),
    exactNames(opened.paths.stages.FEED_STATUS),
  ]);
  return {
    root,
    permit,
    objects,
    staging,
    stages: {
      PREPARED_REQUEST: prepared,
      POST_RESPONSE: post,
      FEED_STATUS: feed,
    },
  };
}

async function openCustody(
  rootInput: string,
  permit: WalmartListingRepairOneSkuPermit,
  operationLock: ObjectArtifact,
): Promise<OpenedCustody> {
  const root = absoluteRoot(rootInput);
  const { binding } = permitBinding(permit);
  const paths = custodyPaths(root, binding.permit_authorization_sha256);
  const directories = await inspectAllDirectories(paths);
  const rootNames = await exactNames(root);
  const expectedRootNames = [
    IDENTITY_FILE,
    OPERATION_LOCK_FILE,
    binding.permit_authorization_sha256,
  ].sort();
  if (!exactEqual(rootNames, expectedRootNames)) {
    fail("ARTIFACT_CUSTODY_INVALID", "custody root has missing or extra entries");
  }
  const permitNames = await exactNames(paths.permit);
  const expectedPermitNames = [OBJECTS_DIR, STAGING_DIR, ...STAGES].sort();
  if (!exactEqual(permitNames, expectedPermitNames)) {
    fail("ARTIFACT_CUSTODY_INVALID", "permit directory has missing or extra entries");
  }
  const currentLock = await readImmutableFile(
    path.join(root, OPERATION_LOCK_FILE),
    MAX_COMMIT_BYTES,
    directories.root,
  );
  if (currentLock.sha256 !== operationLock.sha256
    || currentLock.identity.device !== operationLock.identity.device
    || currentLock.identity.inode !== operationLock.identity.inode
    || !currentLock.bytes.equals(operationLock.bytes)) {
    fail("ARTIFACT_CUSTODY_INVALID", "artifact custody operation lock identity drifted");
  }
  const identityFile = await readImmutableFile(
    path.join(root, IDENTITY_FILE),
    MAX_COMMIT_BYTES,
    directories.root,
  );
  const parsedBody = parseCanonicalEnvelope(
    identityFile,
    WALMART_LISTING_REPAIR_ARTIFACT_IDENTITY_SCHEMA,
    "custody identity",
  );
  const expectedBody = identityBody(binding, directories);
  if (!exactEqual(parsedBody, expectedBody)) {
    fail("ARTIFACT_BINDING_MISMATCH", "custody identity differs from root/permit binding");
  }
  return {
    paths,
    directories,
    binding,
    identity_body: expectedBody,
    identity_file: identityFile,
    operation_lock: operationLock,
  };
}

function allowedArtifactSet(
  stage: Stage,
  artifacts: Record<string, Buffer>,
  binding?: PermitBinding,
): {
  set: string;
  feed_id: string | null;
} {
  const names = Object.keys(artifacts).sort();
  if (stage === "PREPARED_REQUEST") {
    const required = [
      "request-manifest.json",
      "request-payload.json",
      "target-image-certificate.json",
      "surgical-get-spec-receipt.json",
      "surgical-get-spec-request.bin",
      "surgical-get-spec-response.bin",
      "surgical-live-item-receipt.json",
      "surgical-live-item-response.bin",
      "surgical-schema-contract.json",
    ].sort();
    if (!exactEqual(names, required)) {
      fail("ARTIFACT_INVALID", "PREPARED_REQUEST artifact names are not exact");
    }
    return { set: "PREPARED_REQUEST/v1", feed_id: null };
  }
  if (stage === "POST_RESPONSE") {
    const two = ["response-http.json", "response-payload.bin"];
    const three = ["accepted-feed-id.txt", ...two].sort();
    if (!exactEqual(names, two) && !exactEqual(names, three)) {
      fail("ARTIFACT_INVALID", "POST_RESPONSE artifact names are not exact");
    }
    const receipt = validateHttpReceipt(
      artifacts["response-http.json"]!,
      artifacts["response-payload.bin"]!,
      "POST_RESPONSE",
    );
    if (names.length === 2) return { set: "POST_RESPONSE_UNACCEPTED/v1", feed_id: null };
    const feedId = exactText(
      new TextDecoder("utf-8", { fatal: true }).decode(artifacts["accepted-feed-id.txt"]!),
      "accepted feed id",
      512,
    );
    if (feedIdFromResponse(artifacts["response-payload.bin"]!) !== feedId) {
      fail("ARTIFACT_INVALID", "accepted feed id differs from response payload");
    }
    if (receipt.status < 200 || receipt.status >= 300) {
      fail("ARTIFACT_INVALID", "accepted POST response receipt is not 2xx");
    }
    return { set: "POST_RESPONSE_ACCEPTED/v1", feed_id: feedId };
  }
  if (names.length !== 2) fail("ARTIFACT_INVALID", "FEED_STATUS needs one exact pair");
  const http = FEED_HTTP_PATTERN.exec(names[0]!) ?? FEED_HTTP_PATTERN.exec(names[1]!);
  const payload = FEED_PAYLOAD_PATTERN.exec(names[0]!) ?? FEED_PAYLOAD_PATTERN.exec(names[1]!);
  if (!http || !payload || http[1] !== payload[1]) {
    fail("ARTIFACT_INVALID", "FEED_STATUS names must share one collision-safe SHA stem");
  }
  const receipt = validateHttpReceipt(
    artifacts[`feed-status-${http[1]}.http.json`]!,
    artifacts[`feed-status-${http[1]}.payload.bin`]!,
    "FEED_STATUS",
  );
  if (binding) {
    const expectedStem = sha256(Buffer.from(canonicalJson({
      schema_version: "walmart-listing-repair-feed-status-call/v1",
      feed_id: receipt.feed_id,
      correlation_id_sha256: receipt.request_correlation_id_sha256,
      request_manifest_sha256: binding.request_manifest_sha256,
      request_payload_sha256: binding.request_payload_sha256,
    }), "utf8"));
    if (http[1] !== expectedStem) {
      fail("ARTIFACT_BINDING_MISMATCH", "FEED_STATUS stem differs from exact call binding");
    }
  }
  return { set: `FEED_STATUS/v1/call-${http[1]}`, feed_id: receipt.feed_id };
}

function validateHttpReceipt(
  receiptBytes: Buffer,
  payloadBytes: Buffer,
  stage: "POST_RESPONSE" | "FEED_STATUS",
): ParsedHttpReceipt {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes));
  } catch {
    fail("ARTIFACT_INVALID", "HTTP receipt is not valid UTF-8 JSON");
  }
  const raw = record(value, "HTTP receipt");
  if (!receiptBytes.equals(Buffer.from(canonicalJson(raw), "utf8"))) {
    fail("ARTIFACT_INVALID", "HTTP receipt must use writer canonical bytes");
  }
  exactKeys(raw, [
    "schema_version", "operation", "method", "path", "query", "feed_id",
    "status", "content_type", "content_length", "request_correlation_id_sha256",
    "captured_at",
  ], "HTTP receipt");
  if (raw.schema_version !== WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA
    || !Number.isSafeInteger(raw.status) || Number(raw.status) < 100 || Number(raw.status) > 599
    || !Number.isSafeInteger(raw.content_length)
    || Number(raw.content_length) !== payloadBytes.byteLength) {
    fail("ARTIFACT_INVALID", "HTTP receipt status/content length is invalid");
  }
  exactText(raw.content_type, "HTTP receipt content type", 256);
  const correlationSha = digest(
    raw.request_correlation_id_sha256,
    "HTTP receipt correlation SHA",
  );
  const captured = exactText(raw.captured_at, "HTTP receipt captured_at", 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(captured)
    || new Date(captured).toISOString() !== captured) {
    fail("ARTIFACT_INVALID", "HTTP receipt captured_at is invalid");
  }
  if (stage === "POST_RESPONSE") {
    if (raw.operation !== "MAINTENANCE_POST" || raw.method !== "POST"
      || raw.path !== "/v3/feeds" || raw.feed_id !== null
      || !exactEqual(raw.query, { feedType: "MP_MAINTENANCE" })) {
      fail("ARTIFACT_INVALID", "POST HTTP receipt does not bind exact maintenance route");
    }
    return {
      operation: "MAINTENANCE_POST",
      feed_id: null,
      status: Number(raw.status),
      request_correlation_id_sha256: correlationSha,
    };
  }
  const feedId = exactText(raw.feed_id, "feed-status HTTP receipt feed_id", 512);
  if (raw.operation !== "FEED_STATUS_GET" || raw.method !== "GET"
    || raw.path !== `/v3/feeds/${encodeURIComponent(feedId)}`
    || !exactEqual(raw.query, { includeDetails: "true" })) {
    fail("ARTIFACT_INVALID", "feed-status HTTP receipt does not bind exact GET route/feed");
  }
  return {
    operation: "FEED_STATUS_GET",
    feed_id: feedId,
    status: Number(raw.status),
    request_correlation_id_sha256: correlationSha,
  };
}

function feedIdFromResponse(bytes: Buffer): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("ARTIFACT_INVALID", "accepted response payload is not valid UTF-8 JSON");
  }
  const raw = record(value, "accepted response payload");
  return exactText(raw.feedId ?? raw.feed_id, "accepted response feed id", 512);
}

function artifactMaximum(stage: Stage, name: string): number {
  if (stage === "PREPARED_REQUEST") {
    if (name.startsWith("surgical-") || name === "target-image-certificate.json") {
      return WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES;
    }
    return name === "request-payload.json" || name.endsWith("-response.bin")
      ? WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES
      : WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES;
  }
  if (stage === "POST_RESPONSE") {
    return name === "accepted-feed-id.txt" ? 512 : WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES;
  }
  return name.endsWith(".payload.bin")
    ? WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES
    : WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES;
}

function normalizeArtifacts(
  stage: Stage,
  input: Record<string, Uint8Array>,
): Record<string, Buffer> {
  if (!STAGES.includes(stage)) fail("ARTIFACT_INVALID", "artifact stage is not allowed");
  const output: Record<string, Buffer> = {};
  for (const name of Object.keys(input).sort()) {
    if (!name || name !== path.basename(name) || name.includes("..")
      || /[\u0000-\u001f\u007f]/u.test(name)) {
      fail("ARTIFACT_INVALID", "artifact name is unsafe");
    }
    output[name] = boundedBytes(input[name], `${stage}/${name}`, artifactMaximum(stage, name));
  }
  allowedArtifactSet(stage, output);
  return output;
}

function referenceFor(name: string, artifact: ObjectArtifact): ArtifactReference {
  return {
    name,
    object_file_name: artifact.file_name,
    sha256: artifact.sha256,
    byte_length: artifact.bytes.byteLength,
    object_path_sha256: artifact.identity.path_sha256,
    device: artifact.identity.device,
    inode: artifact.identity.inode,
    uid: artifact.identity.uid,
    gid: artifact.identity.gid,
  };
}

function parseReference(value: unknown, label: string): ArtifactReference {
  const raw = record(value, label);
  exactKeys(raw, [
    "name", "object_file_name", "sha256", "byte_length", "object_path_sha256",
    "device", "inode", "uid", "gid",
  ], label);
  const objectSha = digest(raw.sha256, `${label}.sha256`);
  if (raw.object_file_name !== `sha256-${objectSha}.blob`
    || !Number.isSafeInteger(raw.byte_length) || Number(raw.byte_length) < 1
    || !Number.isSafeInteger(raw.uid) || !Number.isSafeInteger(raw.gid)) {
    fail("ARTIFACT_CORRUPT", `${label} object metadata is invalid`);
  }
  return {
    name: exactText(raw.name, `${label}.name`, 256),
    object_file_name: raw.object_file_name,
    sha256: objectSha,
    byte_length: Number(raw.byte_length),
    object_path_sha256: digest(raw.object_path_sha256, `${label}.path SHA`),
    device: exactText(raw.device, `${label}.device`, 128),
    inode: exactText(raw.inode, `${label}.inode`, 128),
    uid: Number(raw.uid),
    gid: Number(raw.gid),
  };
}

async function scanCustody(opened: OpenedCustody): Promise<CustodyScan> {
  const inventoryBefore = await captureInventoryNames(opened);
  const objectNames = inventoryBefore.objects;
  const objects = new Map<string, ObjectArtifact>();
  for (const name of objectNames) {
    const match = OBJECT_FILE_PATTERN.exec(name);
    if (!match) fail("ARTIFACT_CORRUPT", `unexpected object entry: ${name}`);
    const artifact = await readImmutableFile(
      path.join(opened.paths.objects, name),
      WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES,
      opened.directories.objects,
    );
    if (artifact.sha256 !== match[1]) fail("ARTIFACT_CORRUPT", `object filename hash mismatch: ${name}`);
    objects.set(artifact.sha256, artifact);
  }
  const stagingNames = inventoryBefore.staging;
  for (const name of stagingNames) {
    if (!STAGING_FILE_PATTERN.test(name)) fail("ARTIFACT_CORRUPT", `unexpected staging entry: ${name}`);
    await readImmutableFile(
      path.join(opened.paths.staging, name),
      WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES,
      opened.directories.staging,
    );
  }
  const commits: CommitArtifact[] = [];
  const referencedBy = new Map<string, string[]>();
  let acceptedFeedId: string | null = null;
  for (const stage of STAGES) {
    const names = inventoryBefore.stages[stage];
    if (stage !== "FEED_STATUS" && names.length > 1) {
      fail("ARTIFACT_CORRUPT", `${stage} has more than one immutable commit`);
    }
    for (const name of names) {
      const match = COMMIT_FILE_PATTERN.exec(name);
      if (!match) fail("ARTIFACT_CORRUPT", `unexpected ${stage} entry: ${name}`);
      const file = await readImmutableFile(
        path.join(opened.paths.stages[stage], name),
        MAX_COMMIT_BYTES,
        opened.directories.stages[stage],
      );
      if (file.sha256 !== match[1]) fail("ARTIFACT_CORRUPT", `${stage} commit filename hash mismatch`);
      const body = parseCanonicalEnvelope(
        file,
        WALMART_LISTING_REPAIR_ARTIFACT_COMMIT_SCHEMA,
        `${stage} commit`,
      );
      exactKeys(body, [
        "identity_artifact_sha256", "permit_authorization_sha256", "stage",
        "artifact_set", "feed_id", "artifacts",
      ], `${stage} commit body`);
      if (body.identity_artifact_sha256 !== opened.identity_file.sha256
        || body.permit_authorization_sha256 !== opened.binding.permit_authorization_sha256
        || body.stage !== stage || !Array.isArray(body.artifacts)) {
        fail("ARTIFACT_BINDING_MISMATCH", `${stage} commit has wrong custody binding`);
      }
      const references = body.artifacts.map((entry, index) => (
        parseReference(entry, `${stage} commit artifacts[${index}]`)
      ));
      const namesInCommit = references.map((entry) => entry.name);
      if (!exactEqual(namesInCommit, [...namesInCommit].sort())
        || new Set(namesInCommit).size !== namesInCommit.length) {
        fail("ARTIFACT_CORRUPT", `${stage} commit artifacts are not uniquely ordered`);
      }
      const artifactBytes: Record<string, Buffer> = {};
      for (const reference of references) {
        const object = objects.get(reference.sha256);
        if (!object || object.file_name !== reference.object_file_name
          || object.bytes.byteLength !== reference.byte_length
          || object.identity.path_sha256 !== reference.object_path_sha256
          || object.identity.device !== reference.device
          || object.identity.inode !== reference.inode
          || object.identity.uid !== reference.uid || object.identity.gid !== reference.gid) {
          fail("ARTIFACT_CORRUPT", `${stage}/${reference.name} object custody differs from commit`);
        }
        artifactBytes[reference.name] = object.bytes;
        const refs = referencedBy.get(reference.sha256) ?? [];
        refs.push(file.sha256);
        referencedBy.set(reference.sha256, refs);
      }
      const set = allowedArtifactSet(stage, artifactBytes, opened.binding);
      const feedId = body.feed_id === null ? null : exactText(body.feed_id, `${stage} feed_id`, 512);
      if (body.artifact_set !== set.set || (stage !== "FEED_STATUS" && feedId !== set.feed_id)) {
        fail("ARTIFACT_CORRUPT", `${stage} commit artifact-set metadata is invalid`);
      }
      if (stage === "PREPARED_REQUEST") {
        if (sha256(artifactBytes["request-manifest.json"]!)
          !== opened.binding.request_manifest_sha256
          || sha256(artifactBytes["request-payload.json"]!)
            !== opened.binding.request_payload_sha256) {
          fail("ARTIFACT_BINDING_MISMATCH", "prepared request differs from permit hashes");
        }
      } else if (stage === "POST_RESPONSE" && set.feed_id) {
        acceptedFeedId = set.feed_id;
      } else if (stage === "FEED_STATUS") {
        if (!acceptedFeedId || feedId !== acceptedFeedId) {
          fail("ARTIFACT_BINDING_MISMATCH", "feed-status commit lacks accepted feed binding");
        }
      }
      commits.push({
        stage,
        file_name: name,
        file_sha256: file.sha256,
        file_identity: file.identity,
        body_sha256: sha256(canonicalJson(body)),
        artifact_set: String(body.artifact_set),
        feed_id: feedId,
        references,
      });
    }
  }
  if (commits.some((entry) => entry.stage !== "PREPARED_REQUEST")
    && !commits.some((entry) => entry.stage === "PREPARED_REQUEST")) {
    fail("ARTIFACT_CORRUPT", "response custody exists without a prepared request commit");
  }
  const feedSets = commits.filter((entry) => entry.stage === "FEED_STATUS")
    .map((entry) => entry.artifact_set);
  if (new Set(feedSets).size !== feedSets.length) {
    fail("ARTIFACT_CORRUPT", "FEED_STATUS contains a duplicate call-stem commit");
  }
  const currentDirectories = await inspectAllDirectories(opened.paths);
  if (!exactEqual(currentDirectories, opened.directories)) {
    fail("ARTIFACT_CUSTODY_INVALID", "custody directory identity changed during scan");
  }
  const inventoryAfter = await captureInventoryNames(opened);
  if (!exactEqual(inventoryBefore, inventoryAfter)) {
    fail(
      "ARTIFACT_CONCURRENT_UPDATE",
      "artifact custody exact inventory changed during the complete scan",
    );
  }
  return {
    ...opened,
    objects,
    commits,
    referenced_by: referencedBy,
    accepted_feed_id: acceptedFeedId,
    inventory_names: inventoryAfter,
  };
}

async function storeObject(opened: OpenedCustody, bytes: Buffer): Promise<ObjectArtifact> {
  const objectSha = sha256(bytes);
  const fileName = `sha256-${objectSha}.blob`;
  return atomicPublish({
    staging: opened.directories.staging,
    target: opened.directories.objects,
    final_path: path.join(opened.paths.objects, fileName),
    bytes,
    maximum: WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES,
  });
}

function eventBody(input: {
  opened: OpenedCustody;
  stage: Stage;
  set: string;
  feedId: string | null;
  artifacts: ArtifactReference[];
}): CommitBody {
  return {
    identity_artifact_sha256: input.opened.identity_file.sha256,
    permit_authorization_sha256: input.opened.binding.permit_authorization_sha256,
    stage: input.stage,
    artifact_set: input.set,
    feed_id: input.feedId,
    artifacts: input.artifacts,
  };
}

const operationTails = new Map<string, Promise<void>>();

async function serialize<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const prior = operationTails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  operationTails.set(root, current);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (operationTails.get(root) === current) operationTails.delete(root);
  }
}

async function withArtifactOperation<T>(
  root: string,
  operation: (operationLock: ObjectArtifact) => Promise<T>,
  allowCreateRoot = false,
): Promise<T> {
  return serialize(root, async () => {
    const operationLock = await acquireOperationLock(root, allowCreateRoot);
    try {
      return await operation(operationLock);
    } finally {
      await releaseOperationLock(root, operationLock);
    }
  });
}

function acceptedBinding(
  permit: WalmartListingRepairOneSkuPermit,
  accepted: WalmartListingRepairAcceptedReceipt,
  binding: PermitBinding,
): void {
  if (!accepted || accepted.state !== "ACCEPTED"
    || accepted.authorization_sha256 !== binding.permit_authorization_sha256
    || accepted.request_manifest_sha256 !== binding.request_manifest_sha256
    || accepted.request_payload_sha256 !== binding.request_payload_sha256
    || accepted.exact_listing_count !== 1 || accepted.marketplace_write_calls !== 1
    || !exactEqual(accepted.consumption_ledger, permit.signed_body.consumption_ledger)) {
    fail("ARTIFACT_BINDING_MISMATCH", "accepted receipt differs from permit custody binding");
  }
  digest(accepted.response_http_receipt_sha256, "accepted response HTTP SHA");
  digest(accepted.response_payload_sha256, "accepted response payload SHA");
  exactText(accepted.feed_id, "accepted feed id", 512);
}

function succeededTerminalBinding(
  permit: WalmartListingRepairOneSkuPermit,
  terminal: WalmartListingRepairPermitTerminalReceipt,
  binding: PermitBinding,
): void {
  if (!terminal || terminal.state !== "SUCCEEDED" || terminal.prior_state !== "ACCEPTED"
    || terminal.authorization_sha256 !== binding.permit_authorization_sha256
    || terminal.request_manifest_sha256 !== binding.request_manifest_sha256
    || terminal.request_payload_sha256 !== binding.request_payload_sha256
    || terminal.exact_listing_count !== 1 || terminal.marketplace_write_calls !== 1
    || terminal.error_code !== null || terminal.feed_id === null
    || terminal.response_http_receipt_sha256 === null
    || terminal.response_payload_sha256 === null
    || terminal.feed_status_http_receipt_sha256 === null
    || terminal.feed_status_payload_sha256 === null
    || !exactEqual(terminal.consumption_ledger, permit.signed_body.consumption_ledger)) {
    fail("ARTIFACT_BINDING_MISMATCH", "terminal receipt is not one exact SUCCEEDED permit result");
  }
  exactText(terminal.feed_id, "terminal feed id", 512);
  digest(terminal.response_http_receipt_sha256, "terminal response HTTP SHA");
  digest(terminal.response_payload_sha256, "terminal response payload SHA");
  digest(terminal.feed_status_http_receipt_sha256, "terminal feed HTTP SHA");
  digest(terminal.feed_status_payload_sha256, "terminal feed payload SHA");
}

function referencesToMap(
  scan: CustodyScan,
  commit: CommitArtifact,
): Record<string, Buffer> {
  const output: Record<string, Buffer> = {};
  for (const reference of commit.references) {
    const object = scan.objects.get(reference.sha256);
    if (!object) fail("ARTIFACT_CORRUPT", `commit object disappeared: ${reference.name}`);
    output[reference.name] = Buffer.from(object.bytes);
  }
  return output;
}

async function evidenceFromScan(scan: CustodyScan): Promise<WalmartListingRepairArtifactCustodyEvidence> {
  const staging: WalmartListingRepairArtifactCustodyEvidence["staging_orphans"] = [];
  for (const name of await exactNames(scan.paths.staging)) {
    if (!STAGING_FILE_PATTERN.test(name)) fail("ARTIFACT_CORRUPT", `unexpected staging entry: ${name}`);
    const file = await readImmutableFile(
      path.join(scan.paths.staging, name),
      WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES,
      scan.directories.staging,
    );
    staging.push({
      file_name: name,
      file_sha256: file.sha256,
      byte_length: file.bytes.byteLength,
      file_identity: file.identity,
    });
  }
  const objects = [...scan.objects.values()].sort((a, b) => a.file_name.localeCompare(b.file_name))
    .map((entry): WalmartListingRepairArtifactObjectEvidence => {
      const refs = [...(scan.referenced_by.get(entry.sha256) ?? [])].sort();
      return {
        file_name: entry.file_name,
        file_sha256: entry.sha256,
        byte_length: entry.bytes.byteLength,
        file_identity: entry.identity,
        referenced_by_commit_sha256: refs,
        orphan: refs.length === 0,
      };
    });
  const commits = scan.commits.map((entry): WalmartListingRepairArtifactCommitEvidence => ({
    stage: entry.stage,
    file_name: entry.file_name,
    file_sha256: entry.file_sha256,
    body_sha256: entry.body_sha256,
    artifact_set: entry.artifact_set,
    feed_id: entry.feed_id,
    file_identity: entry.file_identity,
    artifacts: entry.references,
  }));
  const inventory = {
    permit_binding: scan.binding,
    identity_artifact_sha256: scan.identity_file.sha256,
    directories: scan.directories,
    objects,
    commits,
    staging,
  };
  const inventoryAfterEvidence = await captureInventoryNames(scan);
  if (!exactEqual(scan.inventory_names, inventoryAfterEvidence)) {
    fail(
      "ARTIFACT_CONCURRENT_UPDATE",
      "artifact custody exact inventory changed while evidence was assembled",
    );
  }
  return {
    schema_version: WALMART_LISTING_REPAIR_ARTIFACT_EVIDENCE_SCHEMA,
    permit_binding: scan.binding,
    identity_artifact_path: scan.identity_file.identity.path,
    identity_artifact_sha256: scan.identity_file.sha256,
    identity_body_sha256: sha256(canonicalJson(scan.identity_body)),
    directories: scan.directories,
    objects,
    commits,
    staging_orphans: staging,
    inventory_sha256: sha256(canonicalJson(inventory)),
    claims: {
      content_addressed_objects: true,
      append_only_immutable_commits: true,
      mutable_head_present: false,
      marketplace_authority_claimed: false,
      hostile_same_uid_resistance_claimed: false,
    },
  };
}

async function loadSucceededTerminalFromCustody(input: {
  custody_root: string;
  permit: WalmartListingRepairOneSkuPermit;
  terminal: WalmartListingRepairPermitTerminalReceipt;
  operation_lock: ObjectArtifact;
}): Promise<WalmartListingRepairSucceededTerminalArtifacts> {
  const scan = await scanCustody(await openCustody(
    input.custody_root,
    input.permit,
    input.operation_lock,
  ));
  succeededTerminalBinding(input.permit, input.terminal, scan.binding);
  const prepared = scan.commits.filter((entry) => entry.stage === "PREPARED_REQUEST");
  const responses = scan.commits.filter(
    (entry) => entry.stage === "POST_RESPONSE"
      && entry.artifact_set === "POST_RESPONSE_ACCEPTED/v1",
  );
  if (prepared.length !== 1 || responses.length !== 1
    || responses[0]!.feed_id !== input.terminal.feed_id) {
    fail("ARTIFACT_CORRUPT", "terminal load lacks one prepared/accepted commit");
  }
  const request = referencesToMap(scan, prepared[0]!);
  const response = referencesToMap(scan, responses[0]!);
  if (sha256(request["request-manifest.json"]!) !== input.terminal.request_manifest_sha256
    || sha256(request["request-payload.json"]!) !== input.terminal.request_payload_sha256
    || sha256(response["response-http.json"]!)
      !== input.terminal.response_http_receipt_sha256
    || sha256(response["response-payload.bin"]!) !== input.terminal.response_payload_sha256
    || feedIdFromResponse(response["response-payload.bin"]!) !== input.terminal.feed_id) {
    fail("ARTIFACT_BINDING_MISMATCH", "terminal POST hashes/feed differ from custody");
  }
  const matchingFeed = scan.commits.filter((entry) => {
    if (entry.stage !== "FEED_STATUS" || entry.feed_id !== input.terminal.feed_id) return false;
    const values = referencesToMap(scan, entry);
    const httpName = entry.references.find(
      (reference) => reference.name.endsWith(".http.json"),
    )?.name;
    const payloadName = entry.references.find(
      (reference) => reference.name.endsWith(".payload.bin"),
    )?.name;
    return Boolean(httpName && payloadName
      && sha256(values[httpName!]) === input.terminal.feed_status_http_receipt_sha256
      && sha256(values[payloadName!]) === input.terminal.feed_status_payload_sha256);
  });
  if (matchingFeed.length !== 1) {
    fail("ARTIFACT_CORRUPT", "terminal feed-status hash pair has no unique custody match");
  }
  const feed = referencesToMap(scan, matchingFeed[0]!);
  const feedHttpName = matchingFeed[0]!.references.find(
    (reference) => reference.name.endsWith(".http.json"),
  )!.name;
  const feedPayloadName = matchingFeed[0]!.references.find(
    (reference) => reference.name.endsWith(".payload.bin"),
  )!.name;
  return {
    request_manifest_bytes: Buffer.from(request["request-manifest.json"]!),
    request_payload_bytes: Buffer.from(request["request-payload.json"]!),
    response_http_receipt_bytes: Buffer.from(response["response-http.json"]!),
    response_payload_bytes: Buffer.from(response["response-payload.bin"]!),
    feed_status_http_receipt_bytes: Buffer.from(feed[feedHttpName]!),
    feed_status_payload_bytes: Buffer.from(feed[feedPayloadName]!),
    surgical: {
      target_image_certificate_bytes: Buffer.from(
        request["target-image-certificate.json"]!,
      ),
      schema_contract_bytes: Buffer.from(request["surgical-schema-contract.json"]!),
      get_spec_receipt_bytes: Buffer.from(request["surgical-get-spec-receipt.json"]!),
      live_item_receipt_bytes: Buffer.from(request["surgical-live-item-receipt.json"]!),
      get_spec_request_bytes: Buffer.from(request["surgical-get-spec-request.bin"]!),
      get_spec_response_bytes: Buffer.from(request["surgical-get-spec-response.bin"]!),
      live_item_response_bytes: Buffer.from(request["surgical-live-item-response.bin"]!),
    },
  };
}

class ArtifactCustodySink implements WalmartListingRepairArtifactCustody {
  readonly custody_root: string;
  readonly permit_authorization_sha256: string;
  readonly #permit: WalmartListingRepairOneSkuPermit;

  constructor(root: string, permit: WalmartListingRepairOneSkuPermit, authorizationSha: string) {
    this.custody_root = root;
    this.permit_authorization_sha256 = authorizationSha;
    this.#permit = permit;
  }

  async persist(stage: Stage, input: Record<string, Uint8Array>): Promise<void> {
    await withArtifactOperation(this.custody_root, async (operationLock) => {
      const artifacts = normalizeArtifacts(stage, input);
      let scan = await scanCustody(await openCustody(
        this.custody_root,
        this.#permit,
        operationLock,
      ));
      if (stage === "PREPARED_REQUEST") {
        if (sha256(artifacts["request-manifest.json"]!) !== scan.binding.request_manifest_sha256
          || sha256(artifacts["request-payload.json"]!) !== scan.binding.request_payload_sha256
          || sha256(artifacts["target-image-certificate.json"]!)
            !== scan.binding.target_image_certificate_sha256) {
          fail(
            "ARTIFACT_BINDING_MISMATCH",
            "prepared request/image-certificate bytes differ from permit hashes",
          );
        }
      } else if (!scan.commits.some((entry) => entry.stage === "PREPARED_REQUEST")) {
        fail("ARTIFACT_INVALID_STATE", `${stage} cannot precede PREPARED_REQUEST custody`);
      }
      if (stage === "FEED_STATUS" && !scan.accepted_feed_id) {
        fail("ARTIFACT_INVALID_STATE", "FEED_STATUS requires accepted POST_RESPONSE custody");
      }
      const set = allowedArtifactSet(stage, artifacts, scan.binding);
      if (stage === "FEED_STATUS" && set.feed_id !== scan.accepted_feed_id) {
        fail("ARTIFACT_BINDING_MISMATCH", "feed-status receipt targets another accepted feed");
      }
      const existingStage = scan.commits.filter((entry) => entry.stage === stage);
      if (stage !== "FEED_STATUS" && existingStage.length === 1) {
        const existing = referencesToMap(scan, existingStage[0]!);
        const same = exactEqual(Object.keys(existing).sort(), Object.keys(artifacts).sort())
          && Object.keys(artifacts).every((name) => existing[name]?.equals(artifacts[name]!));
        if (same) return;
        fail("ARTIFACT_COLLISION", `${stage} immutable commit already exists with different bytes`);
      }
      if (stage === "FEED_STATUS") {
        const sameCall = existingStage.find((entry) => entry.artifact_set === set.set);
        if (sameCall) {
          const existing = referencesToMap(scan, sameCall);
          const same = exactEqual(Object.keys(existing).sort(), Object.keys(artifacts).sort())
            && Object.keys(artifacts).every((name) => existing[name]?.equals(artifacts[name]!));
          if (same) return;
          fail("ARTIFACT_COLLISION", "FEED_STATUS call stem already exists with different bytes");
        }
      }
      const references: ArtifactReference[] = [];
      for (const name of Object.keys(artifacts).sort()) {
        references.push(referenceFor(name, await storeObject(scan, artifacts[name]!)));
      }
      const body = eventBody({
        opened: scan,
        stage,
        set: set.set,
        feedId: set.feed_id,
        artifacts: references,
      });
      const commitBytes = canonicalBytes(envelope(
        WALMART_LISTING_REPAIR_ARTIFACT_COMMIT_SCHEMA,
        body,
      ));
      if (commitBytes.byteLength > MAX_COMMIT_BYTES) {
        fail("ARTIFACT_INVALID", "artifact commit exceeds byte limit");
      }
      const commitSha = sha256(commitBytes);
      await atomicPublish({
        staging: scan.directories.staging,
        target: scan.directories.stages[stage],
        final_path: path.join(scan.paths.stages[stage], `commit-${commitSha}.json`),
        bytes: commitBytes,
        maximum: MAX_COMMIT_BYTES,
      });
      scan = await scanCustody(await openCustody(
        this.custody_root,
        this.#permit,
        operationLock,
      ));
      if (!scan.commits.some((entry) => entry.stage === stage && entry.file_sha256 === commitSha)) {
        fail("ARTIFACT_CORRUPT", "published commit is absent after durable rescan");
      }
    });
  }

  async loadAccepted(input: {
    permit: WalmartListingRepairOneSkuPermit;
    accepted: WalmartListingRepairAcceptedReceipt;
  }): Promise<{
    request_manifest_bytes: Uint8Array;
    request_payload_bytes: Uint8Array;
    response_http_receipt_bytes: Uint8Array;
    response_payload_bytes: Uint8Array;
  }> {
    return withArtifactOperation(this.custody_root, async (operationLock) => {
      const supplied = permitBinding(input.permit).binding;
      if (supplied.permit_authorization_sha256 !== this.permit_authorization_sha256) {
        fail("ARTIFACT_BINDING_MISMATCH", "loadAccepted supplied another permit");
      }
      const scan = await scanCustody(await openCustody(
        this.custody_root,
        input.permit,
        operationLock,
      ));
      acceptedBinding(input.permit, input.accepted, scan.binding);
      const prepared = scan.commits.filter((entry) => entry.stage === "PREPARED_REQUEST");
      const responses = scan.commits.filter(
        (entry) => entry.stage === "POST_RESPONSE" && entry.artifact_set === "POST_RESPONSE_ACCEPTED/v1",
      );
      if (prepared.length !== 1 || responses.length !== 1) {
        fail("ARTIFACT_CORRUPT", "accepted load requires exactly one prepared and accepted commit");
      }
      const request = referencesToMap(scan, prepared[0]!);
      const response = referencesToMap(scan, responses[0]!);
      if (responses[0]!.feed_id !== input.accepted.feed_id
        || new TextDecoder("utf-8", { fatal: true }).decode(response["accepted-feed-id.txt"]!)
          !== input.accepted.feed_id
        || feedIdFromResponse(response["response-payload.bin"]!) !== input.accepted.feed_id
        || sha256(request["request-manifest.json"]!) !== input.accepted.request_manifest_sha256
        || sha256(request["request-payload.json"]!) !== input.accepted.request_payload_sha256
        || sha256(response["response-http.json"]!) !== input.accepted.response_http_receipt_sha256
        || sha256(response["response-payload.bin"]!) !== input.accepted.response_payload_sha256) {
        fail("ARTIFACT_BINDING_MISMATCH", "accepted receipt hashes/feed differ from custody bytes");
      }
      return {
        request_manifest_bytes: Buffer.from(request["request-manifest.json"]!),
        request_payload_bytes: Buffer.from(request["request-payload.json"]!),
        response_http_receipt_bytes: Buffer.from(response["response-http.json"]!),
        response_payload_bytes: Buffer.from(response["response-payload.bin"]!),
      };
    });
  }

  async readEvidence(): Promise<WalmartListingRepairArtifactCustodyEvidence> {
    return withArtifactOperation(this.custody_root, async (operationLock) => evidenceFromScan(
      await scanCustody(await openCustody(this.custody_root, this.#permit, operationLock)),
    ));
  }

  async loadSucceededTerminal(input: {
    permit: WalmartListingRepairOneSkuPermit;
    terminal: WalmartListingRepairPermitTerminalReceipt;
  }): Promise<WalmartListingRepairSucceededTerminalArtifacts> {
    return withArtifactOperation(this.custody_root, async (operationLock) => {
      const supplied = permitBinding(input.permit).binding;
      if (supplied.permit_authorization_sha256 !== this.permit_authorization_sha256) {
        fail("ARTIFACT_BINDING_MISMATCH", "terminal load supplied another permit");
      }
      return loadSucceededTerminalFromCustody({
        custody_root: this.custody_root,
        permit: input.permit,
        terminal: input.terminal,
        operation_lock: operationLock,
      });
    });
  }
}

export async function createWalmartListingRepairArtifactCustody(input: {
  custody_root: string;
  permit: WalmartListingRepairOneSkuPermit;
}): Promise<WalmartListingRepairArtifactCustody> {
  const root = absoluteRoot(input.custody_root);
  const binding = permitBinding(input.permit).binding;
  await withArtifactOperation(root, async (operationLock) => {
    await bootstrap(root, binding, operationLock);
    await scanCustody(await openCustody(root, input.permit, operationLock));
  }, true);
  return new ArtifactCustodySink(root, input.permit, binding.permit_authorization_sha256);
}

export async function readWalmartListingRepairArtifactCustodyEvidence(input: {
  custody_root: string;
  permit: WalmartListingRepairOneSkuPermit;
}): Promise<WalmartListingRepairArtifactCustodyEvidence> {
  const root = absoluteRoot(input.custody_root);
  return withArtifactOperation(root, async (operationLock) => evidenceFromScan(
    await scanCustody(await openCustody(root, input.permit, operationLock)),
  ));
}

/**
 * Qualification-only terminal loader. Unlike the writer-facing factory, this
 * function never bootstraps or mutates evidence; it creates only the transient
 * fail-closed cross-process operation lock. The exact immutable root and permit
 * namespace must already exist and pass a complete rescan.
 */
export async function loadWalmartListingRepairSucceededTerminalArtifacts(input: {
  custody_root: string;
  permit: WalmartListingRepairOneSkuPermit;
  terminal: WalmartListingRepairPermitTerminalReceipt;
}): Promise<WalmartListingRepairSucceededTerminalArtifacts> {
  const root = absoluteRoot(input.custody_root);
  return withArtifactOperation(root, async (operationLock) => loadSucceededTerminalFromCustody({
    custody_root: root,
    permit: input.permit,
    terminal: input.terminal,
    operation_lock: operationLock,
  }));
}

/**
 * Holds one OS-visible exclusive custody lock across a complete caller-defined
 * qualification read. The reader cannot persist evidence. A complete rescan is
 * required both before and after the callback, so a legitimate second process
 * cannot append a commit between evidence verification and its return.
 */
export async function withWalmartListingRepairLockedArtifactCustody<T>(input: {
  custody_root: string;
  permit: WalmartListingRepairOneSkuPermit;
  operation: (reader: WalmartListingRepairLockedArtifactCustodyReader) => Promise<T>;
}): Promise<T> {
  const root = absoluteRoot(input.custody_root);
  if (typeof input.operation !== "function") {
    fail("ARTIFACT_INVALID", "locked custody operation must be a function");
  }
  return withArtifactOperation(root, async (operationLock) => {
    await scanCustody(await openCustody(root, input.permit, operationLock));
    const reader: WalmartListingRepairLockedArtifactCustodyReader = Object.freeze({
      readEvidence: async () => evidenceFromScan(
        await scanCustody(await openCustody(root, input.permit, operationLock)),
      ),
      loadSucceededTerminal: async ({ terminal }) => loadSucceededTerminalFromCustody({
        custody_root: root,
        permit: input.permit,
        terminal,
        operation_lock: operationLock,
      }),
    });
    const result = await input.operation(reader);
    await scanCustody(await openCustody(root, input.permit, operationLock));
    return result;
  });
}
