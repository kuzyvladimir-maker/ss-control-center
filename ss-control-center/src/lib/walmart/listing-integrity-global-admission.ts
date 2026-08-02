import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";

import type {
  WalmartListingRepairListingIdentity,
} from "./listing-integrity-remediation-authority.ts";

export const WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_IDENTITY_SCHEMA =
  "walmart-listing-integrity-global-admission-identity/v1" as const;
export const WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_CLAIM_SCHEMA =
  "walmart-listing-integrity-global-admission-claim/v1" as const;
export const WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_TERMINAL_SCHEMA =
  "walmart-listing-integrity-global-admission-terminal/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 1024 * 1024;
const IDENTITY_FILE = ".identity.json";
const ACTIVE_DIRECTORY = "active";
const HISTORY_DIRECTORY = "history";
const CLAIM_FILE = "claim.json";
const TERMINAL_FILE = "terminal.json";

type JsonRecord = Record<string, unknown>;

export interface WalmartListingIntegrityGlobalAdmissionIdentity {
  schema_version: typeof WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_IDENTITY_SCHEMA;
  root_id: string;
  created_at: string;
  root_path_sha256: string;
  body_sha256: string;
}

export interface WalmartListingIntegrityGlobalAdmissionClaim {
  schema_version: typeof WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_CLAIM_SCHEMA;
  claim_id: string;
  claimed_at: string;
  listing: WalmartListingRepairListingIdentity;
  permit_authorization_sha256: string;
  execution_package_artifact_sha256: string;
  plan_body_sha256: string;
  frozen_release_id_sha256: string;
  retry_allowed: false;
  body_sha256: string;
}

export interface WalmartListingIntegrityGlobalAdmissionTerminal {
  schema_version: typeof WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_TERMINAL_SCHEMA;
  claim_id: string;
  completed_at: string;
  outcome: "PASS" | "QUARANTINED_UNRESOLVED";
  evidence_file_sha256: string;
  permit_authorization_sha256: string;
  body_sha256: string;
}

export interface WalmartListingIntegrityGlobalAdmissionBinding {
  root: string;
  expected_identity_sha256: string;
}

export interface WalmartListingIntegrityGlobalAdmissionClaimInput {
  listing: WalmartListingRepairListingIdentity;
  permit_authorization_sha256: string;
  execution_package_artifact_sha256: string;
  plan_body_sha256: string;
  frozen_release_id_sha256: string;
  claimed_at: string;
}

export class WalmartListingIntegrityGlobalAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingIntegrityGlobalAdmissionError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingIntegrityGlobalAdmissionError(code, message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
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
  if (encoded === undefined) fail("NON_CANONICAL", "global admission rejects undefined");
  return encoded;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length
    || actual.some((entry, index) => entry !== keys[index])) {
    fail("INVALID_ARTIFACT", `${label} has missing or extra fields`);
  }
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("INVALID_ARTIFACT", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactInstant(value: unknown, label: string): string {
  if (typeof value !== "string") fail("INVALID_ARTIFACT", `${label} must be an instant`);
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
    fail("INVALID_ARTIFACT", `${label} must be a canonical ISO instant`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value !== value.trim()) {
    fail("INVALID_ARTIFACT", `${label} must be bounded exact text`);
  }
  return value;
}

function exactListing(value: unknown): WalmartListingRepairListingIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARTIFACT", "claim listing must be an object");
  }
  const row = value as JsonRecord;
  exactKeys(row, ["channel", "store_index", "sku", "listing_key", "item_id"], "claim listing");
  if (row.channel !== "WALMART_US" || !Number.isSafeInteger(row.store_index)
    || Number(row.store_index) < 1) {
    fail("INVALID_ARTIFACT", "claim listing identity is invalid");
  }
  return {
    channel: "WALMART_US",
    store_index: Number(row.store_index),
    sku: exactText(row.sku, "claim listing sku", 512),
    listing_key: exactText(row.listing_key, "claim listing key"),
    item_id: exactText(row.item_id, "claim item ID", 128),
  };
}

function exactRoot(root: string): string {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    fail("INVALID_ROOT", "global admission root must be an absolute normalized path");
  }
  return root;
}

async function assertPrivateCanonicalDirectory(directory: string, label: string): Promise<void> {
  const metadata = await lstat(directory).catch(() => fail("INVALID_ROOT", `${label} is missing`));
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || await realpath(directory) !== directory) {
    fail("INVALID_ROOT", `${label} must be a private canonical directory`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail("INVALID_ROOT", `${label} must be owned by the current user`);
  }
}

async function readPrivateCanonicalFile(file: string, label: string): Promise<Buffer> {
  const metadata = await lstat(file).catch(() => fail("INVALID_ARTIFACT", `${label} is missing`));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0 || metadata.size < 1
    || metadata.size > MAX_FILE_BYTES || await realpath(file) !== file) {
    fail("INVALID_ARTIFACT", `${label} must be one private canonical regular file`);
  }
  return readFile(file);
}

async function writeExclusivePrivate(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, "wx", 0o400).catch(() => fail(
    "EXCLUSIVE_CREATE_FAILED",
    `exclusive global admission artifact already exists: ${file}`,
  ));
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function seal<T extends JsonRecord>(body: T): T & { body_sha256: string } {
  return Object.freeze({ ...body, body_sha256: sha256(canonicalJson(body)) });
}

function parseCanonicalArtifact(bytes: Uint8Array, label: string): JsonRecord {
  let parsed: unknown;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(decoded);
  } catch {
    return fail("INVALID_ARTIFACT", `${label} is not exact UTF-8 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || decoded !== `${canonicalJson(parsed)}\n`) {
    fail("INVALID_ARTIFACT", `${label} is not canonical JSON plus LF`);
  }
  return parsed as JsonRecord;
}

function verifyBodySha(row: JsonRecord, label: string): void {
  const body = { ...row };
  const claimed = exactSha(body.body_sha256, `${label} body SHA`);
  delete body.body_sha256;
  if (sha256(canonicalJson(body)) !== claimed) {
    fail("INVALID_ARTIFACT", `${label} body SHA differs`);
  }
}

function parseIdentity(bytes: Uint8Array): WalmartListingIntegrityGlobalAdmissionIdentity {
  const row = parseCanonicalArtifact(bytes, "global admission identity");
  exactKeys(row, ["schema_version", "root_id", "created_at", "root_path_sha256", "body_sha256"], "global admission identity");
  verifyBodySha(row, "global admission identity");
  if (row.schema_version !== WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_IDENTITY_SCHEMA) {
    fail("INVALID_ARTIFACT", "global admission identity schema differs");
  }
  return row as unknown as WalmartListingIntegrityGlobalAdmissionIdentity;
}

function parseClaim(bytes: Uint8Array): WalmartListingIntegrityGlobalAdmissionClaim {
  const row = parseCanonicalArtifact(bytes, "global admission claim");
  exactKeys(row, [
    "schema_version", "claim_id", "claimed_at", "listing",
    "permit_authorization_sha256", "execution_package_artifact_sha256",
    "plan_body_sha256", "frozen_release_id_sha256", "retry_allowed", "body_sha256",
  ], "global admission claim");
  verifyBodySha(row, "global admission claim");
  if (row.schema_version !== WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_CLAIM_SCHEMA
    || row.retry_allowed !== false) {
    fail("INVALID_ARTIFACT", "global admission claim policy differs");
  }
  exactText(row.claim_id, "claim ID", 128);
  exactInstant(row.claimed_at, "claimed_at");
  exactListing(row.listing);
  exactSha(row.permit_authorization_sha256, "permit authorization SHA");
  exactSha(row.execution_package_artifact_sha256, "execution package artifact SHA");
  exactSha(row.plan_body_sha256, "plan body SHA");
  exactSha(row.frozen_release_id_sha256, "frozen release ID");
  return row as unknown as WalmartListingIntegrityGlobalAdmissionClaim;
}

function sameClaim(
  claim: WalmartListingIntegrityGlobalAdmissionClaim,
  input: WalmartListingIntegrityGlobalAdmissionClaimInput,
): boolean {
  return claim.permit_authorization_sha256 === input.permit_authorization_sha256
    && claim.execution_package_artifact_sha256 === input.execution_package_artifact_sha256
    && claim.plan_body_sha256 === input.plan_body_sha256
    && claim.frozen_release_id_sha256 === input.frozen_release_id_sha256
    && claim.listing.listing_key === input.listing.listing_key
    && claim.listing.sku === input.listing.sku
    && claim.listing.item_id === input.listing.item_id
    && claim.listing.store_index === input.listing.store_index;
}

async function verifiedRoot(
  binding: WalmartListingIntegrityGlobalAdmissionBinding,
): Promise<{ root: string; identity: WalmartListingIntegrityGlobalAdmissionIdentity }> {
  const root = exactRoot(binding.root);
  exactSha(binding.expected_identity_sha256, "expected global admission identity SHA");
  await assertPrivateCanonicalDirectory(root, "global admission root");
  await assertPrivateCanonicalDirectory(path.join(root, HISTORY_DIRECTORY), "global admission history");
  const identityBytes = await readPrivateCanonicalFile(
    path.join(root, IDENTITY_FILE),
    "global admission identity",
  );
  if (sha256(identityBytes) !== binding.expected_identity_sha256) {
    fail("IDENTITY_MISMATCH", "global admission identity differs from frozen wrapper binding");
  }
  const identity = parseIdentity(identityBytes);
  if (identity.root_path_sha256 !== sha256(root)) {
    fail("IDENTITY_MISMATCH", "global admission identity is bound to another root path");
  }
  return { root, identity };
}

export async function bootstrapWalmartListingIntegrityGlobalAdmissionRoot(input: {
  root: string;
  created_at: string;
}): Promise<{
  identity: WalmartListingIntegrityGlobalAdmissionIdentity;
  identity_file_sha256: string;
}> {
  const root = exactRoot(input.root);
  const createdAt = exactInstant(input.created_at, "created_at");
  await assertPrivateCanonicalDirectory(path.dirname(root), "global admission parent");
  await mkdir(root, { mode: 0o700 }).catch(() => fail(
    "ROOT_ALREADY_EXISTS",
    "global admission root already exists; bootstrap never reuses or replaces it",
  ));
  await mkdir(path.join(root, HISTORY_DIRECTORY), { mode: 0o700 });
  const identity = seal({
    schema_version: WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_IDENTITY_SCHEMA,
    root_id: `listing-integrity-admission-${randomUUID()}`,
    created_at: createdAt,
    root_path_sha256: sha256(root),
  });
  const bytes = canonicalBytes(identity);
  await writeExclusivePrivate(path.join(root, IDENTITY_FILE), bytes);
  return Object.freeze({ identity, identity_file_sha256: sha256(bytes) });
}

export async function inspectWalmartListingIntegrityGlobalAdmissionRoot(
  binding: WalmartListingIntegrityGlobalAdmissionBinding,
): Promise<{
  status: "AVAILABLE" | "OCCUPIED";
  identity: WalmartListingIntegrityGlobalAdmissionIdentity;
  active_claim: WalmartListingIntegrityGlobalAdmissionClaim | null;
}> {
  const { root, identity } = await verifiedRoot(binding);
  const active = path.join(root, ACTIVE_DIRECTORY);
  const activeMetadata = await lstat(active).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!activeMetadata) return Object.freeze({ status: "AVAILABLE", identity, active_claim: null });
  await assertPrivateCanonicalDirectory(active, "global admission active claim");
  const claim = parseClaim(await readPrivateCanonicalFile(
    path.join(active, CLAIM_FILE),
    "global admission active claim",
  ));
  return Object.freeze({ status: "OCCUPIED", identity, active_claim: claim });
}

export async function acquireWalmartListingIntegrityGlobalAdmission(input: {
  binding: WalmartListingIntegrityGlobalAdmissionBinding;
  claim: WalmartListingIntegrityGlobalAdmissionClaimInput;
}): Promise<WalmartListingIntegrityGlobalAdmissionClaim> {
  const { root } = await verifiedRoot(input.binding);
  exactInstant(input.claim.claimed_at, "claimed_at");
  exactListing(input.claim.listing);
  exactSha(input.claim.permit_authorization_sha256, "permit authorization SHA");
  exactSha(input.claim.execution_package_artifact_sha256, "execution package artifact SHA");
  exactSha(input.claim.plan_body_sha256, "plan body SHA");
  exactSha(input.claim.frozen_release_id_sha256, "frozen release ID");
  const claimSeed = canonicalJson({
    listing_key: input.claim.listing.listing_key,
    permit_authorization_sha256: input.claim.permit_authorization_sha256,
    execution_package_artifact_sha256: input.claim.execution_package_artifact_sha256,
  });
  const claim = seal({
    schema_version: WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_CLAIM_SCHEMA,
    claim_id: `admission-${sha256(claimSeed).slice(0, 32)}`,
    claimed_at: input.claim.claimed_at,
    listing: structuredClone(input.claim.listing),
    permit_authorization_sha256: input.claim.permit_authorization_sha256,
    execution_package_artifact_sha256: input.claim.execution_package_artifact_sha256,
    plan_body_sha256: input.claim.plan_body_sha256,
    frozen_release_id_sha256: input.claim.frozen_release_id_sha256,
    retry_allowed: false as const,
  });
  const active = path.join(root, ACTIVE_DIRECTORY);
  await mkdir(active, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      return fail(
        "GLOBAL_ADMISSION_OCCUPIED",
        "another Walmart Listing Integrity live cycle is active; no POST is allowed",
      );
    }
    throw error;
  });
  try {
    await writeExclusivePrivate(path.join(active, CLAIM_FILE), canonicalBytes(claim));
  } catch (error) {
    // Leave the active directory in place. A partial claim is a fail-closed hold,
    // never a reason to permit a second marketplace write.
    throw error;
  }
  return claim;
}

export async function assertWalmartListingIntegrityGlobalAdmission(input: {
  binding: WalmartListingIntegrityGlobalAdmissionBinding;
  claim: WalmartListingIntegrityGlobalAdmissionClaimInput;
}): Promise<WalmartListingIntegrityGlobalAdmissionClaim> {
  const inspected = await inspectWalmartListingIntegrityGlobalAdmissionRoot(input.binding);
  if (!inspected.active_claim || !sameClaim(inspected.active_claim, input.claim)) {
    fail(
      "GLOBAL_ADMISSION_MISMATCH",
      "the active global admission does not bind this exact SKU/package/permit/release",
    );
  }
  return inspected.active_claim;
}

export async function completeWalmartListingIntegrityGlobalAdmission(input: {
  binding: WalmartListingIntegrityGlobalAdmissionBinding;
  claim: WalmartListingIntegrityGlobalAdmissionClaimInput;
  completed_at: string;
  outcome: "PASS" | "QUARANTINED_UNRESOLVED";
  evidence_file_sha256: string;
}): Promise<WalmartListingIntegrityGlobalAdmissionTerminal> {
  const { root } = await verifiedRoot(input.binding);
  const activeClaim = await assertWalmartListingIntegrityGlobalAdmission({
    binding: input.binding,
    claim: input.claim,
  });
  const terminal = seal({
    schema_version: WALMART_LISTING_INTEGRITY_GLOBAL_ADMISSION_TERMINAL_SCHEMA,
    claim_id: activeClaim.claim_id,
    completed_at: exactInstant(input.completed_at, "completed_at"),
    outcome: input.outcome,
    evidence_file_sha256: exactSha(input.evidence_file_sha256, "terminal evidence file SHA"),
    permit_authorization_sha256: input.claim.permit_authorization_sha256,
  });
  const active = path.join(root, ACTIVE_DIRECTORY);
  const terminalPath = path.join(active, TERMINAL_FILE);
  const existingTerminal = await lstat(terminalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existingTerminal) {
    const bytes = await readPrivateCanonicalFile(terminalPath, "global admission terminal");
    if (!bytes.equals(canonicalBytes(terminal))) {
      fail("TERMINAL_MISMATCH", "active admission already has a different terminal outcome");
    }
  } else {
    await writeExclusivePrivate(terminalPath, canonicalBytes(terminal));
  }
  const historyPath = path.join(root, HISTORY_DIRECTORY, activeClaim.claim_id);
  await rename(active, historyPath).catch(() => fail(
    "TERMINAL_ARCHIVE_FAILED",
    "global admission terminal could not be atomically archived; admission remains fail-closed",
  ));
  return terminal;
}
