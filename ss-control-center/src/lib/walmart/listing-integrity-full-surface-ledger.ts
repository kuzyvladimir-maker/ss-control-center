/**
 * Durable single-custody operation-consumption ledger for Walmart full-surface
 * writes. The authorization reservation is created exclusively and is never
 * removed, so a signed permit cannot become replayable after any later state.
 *
 * At-most-once is intentionally scoped to one intact mode-0700 directory on
 * one custody host. Distributed and hostile-same-UID guarantees are not
 * claimed.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID,
  type WalmartListingFullSurfaceLedgerBinding,
} from "./listing-integrity-full-surface-authority.ts";

export const WALMART_LISTING_FULL_SURFACE_LEDGER_IDENTITY_SCHEMA =
  "walmart-listing-full-surface-ledger-identity/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_LEDGER_CLAIM_SCHEMA =
  "walmart-listing-full-surface-operation-claim/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_LEDGER_REQUESTING_SCHEMA =
  "walmart-listing-full-surface-operation-requesting/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_LEDGER_ACCEPTED_SCHEMA =
  "walmart-listing-full-surface-operation-accepted/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_LEDGER_TERMINAL_SCHEMA =
  "walmart-listing-full-surface-operation-terminal/v1" as const;

const IDENTITY_FILE_NAME = ".ledger-identity.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;
const MAX_LEDGER_FILE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type LedgerTerminalState =
  | "SUCCEEDED_AND_READ_BACK"
  | "DEFINITELY_REJECTED"
  | "UNKNOWN"
  | "READBACK_FAILED";

interface LedgerEnvelope<TBody extends JsonRecord> {
  schema_version: string;
  body: TBody;
  body_sha256: string;
}

interface IdentityBody extends JsonRecord {
  ledger_id: string;
  ledger_epoch: string;
  canonical_directory_path_sha256: string;
  directory_identity_sha256: string;
  created_at: string;
  policy_id: typeof WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
}

interface ClaimBody extends JsonRecord {
  authorization_sha256: string;
  state: "CLAIMED";
  claim_id: string;
  claimed_at: string;
  plan_body_sha256: string;
  operation_id: string;
  operation_body_sha256: string;
  request_payload_sha256: string;
  request_byte_length: number;
  seller_account_fingerprint_sha256: string;
  consumption_ledger: WalmartListingFullSurfaceLedgerBinding;
}

interface RequestingBody extends JsonRecord {
  authorization_sha256: string;
  state: "REQUESTING";
  requesting_at: string;
  claim_artifact_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  correlation_id: string;
  marketplace_write_calls_before_transition: 0;
  consumption_ledger: WalmartListingFullSurfaceLedgerBinding;
}

interface AcceptedBody extends JsonRecord {
  authorization_sha256: string;
  state: "ACCEPTED";
  accepted_at: string;
  requesting_artifact_sha256: string;
  response_http_status: number;
  response_headers_sha256: string;
  response_payload_sha256: string;
  walmart_feed_id: string | null;
  marketplace_write_calls: 1;
  further_mutation_allowed: false;
  get_only_resume_allowed: boolean;
  consumption_ledger: WalmartListingFullSurfaceLedgerBinding;
}

interface TerminalBody extends JsonRecord {
  authorization_sha256: string;
  state: LedgerTerminalState;
  terminal_at: string;
  prior_state: "REQUESTING" | "ACCEPTED";
  prior_state_artifact_sha256: string;
  response_http_status: number | null;
  response_headers_sha256: string | null;
  response_payload_sha256: string | null;
  readback_sha256: string | null;
  error_code: string | null;
  marketplace_write_calls: 1;
  further_mutation_allowed: false;
  get_only_resume_allowed: false;
  consumption_ledger: WalmartListingFullSurfaceLedgerBinding;
}

export interface WalmartListingFullSurfaceLedgerClaim {
  authorization_sha256: string;
  state: "CLAIMED";
  claim_path: string;
  claim_artifact_sha256: string;
  claim_id: string;
  claimed_at: string;
}

export interface WalmartListingFullSurfaceLedgerRequesting {
  authorization_sha256: string;
  state: "REQUESTING";
  requesting_path: string;
  requesting_artifact_sha256: string;
  requesting_at: string;
  correlation_id: string;
}

export interface WalmartListingFullSurfaceLedgerAccepted {
  authorization_sha256: string;
  state: "ACCEPTED";
  accepted_path: string;
  accepted_artifact_sha256: string;
  accepted_at: string;
  walmart_feed_id: string | null;
  get_only_resume_allowed: boolean;
}

export interface WalmartListingFullSurfaceLedgerTerminal {
  authorization_sha256: string;
  state: LedgerTerminalState;
  terminal_path: string;
  terminal_artifact_sha256: string;
  terminal_at: string;
}

export interface WalmartListingFullSurfaceLedgerInspection {
  authorization_sha256: string;
  state:
    | "UNCLAIMED"
    | "CLAIMED"
    | "REQUESTING"
    | "ACCEPTED"
    | LedgerTerminalState;
  claim_artifact_sha256: string | null;
  requesting_artifact_sha256: string | null;
  accepted_artifact_sha256: string | null;
  terminal_artifact_sha256: string | null;
  walmart_feed_id: string | null;
  mutation_replay_allowed: false;
  get_only_resume_allowed: boolean;
}

export interface WalmartListingFullSurfaceLedgerClaimInput {
  authorization_sha256: string;
  plan_body_sha256: string;
  operation_id: string;
  operation_body_sha256: string;
  request_payload_sha256: string;
  request_byte_length: number;
  seller_account_fingerprint_sha256: string;
  now?: string;
}

export interface WalmartListingFullSurfaceLedgerRequestingInput {
  authorization_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  correlation_id: string;
  now?: string;
}

export interface WalmartListingFullSurfaceLedgerAcceptedInput {
  authorization_sha256: string;
  response_http_status: number;
  response_headers_sha256: string;
  response_payload_sha256: string;
  walmart_feed_id?: string | null;
  now?: string;
}

export interface WalmartListingFullSurfaceLedgerTerminalInput {
  authorization_sha256: string;
  state: LedgerTerminalState;
  response_http_status?: number | null;
  response_headers_sha256?: string | null;
  response_payload_sha256?: string | null;
  readback_sha256?: string | null;
  error_code?: string | null;
  now?: string;
}

export interface WalmartListingFullSurfaceLedger {
  readonly directory: string;
  readonly binding: WalmartListingFullSurfaceLedgerBinding;
  claim(
    input: WalmartListingFullSurfaceLedgerClaimInput,
  ): Promise<WalmartListingFullSurfaceLedgerClaim>;
  markRequesting(
    input: WalmartListingFullSurfaceLedgerRequestingInput,
  ): Promise<WalmartListingFullSurfaceLedgerRequesting>;
  markAccepted(
    input: WalmartListingFullSurfaceLedgerAcceptedInput,
  ): Promise<WalmartListingFullSurfaceLedgerAccepted>;
  markTerminal(
    input: WalmartListingFullSurfaceLedgerTerminalInput,
  ): Promise<WalmartListingFullSurfaceLedgerTerminal>;
  inspect(
    authorizationSha256: string,
  ): Promise<WalmartListingFullSurfaceLedgerInspection>;
}

function fail(code: string, message: string): never {
  const error = new Error(`Walmart full-surface ledger: ${message}`);
  (error as Error & { code: string }).code = code;
  throw error;
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
  if (encoded === undefined) fail("INVALID_LEDGER_DATA", "undefined is forbidden");
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("INVALID_LEDGER_DATA", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_ID.test(value)
    || value.includes("//")
    || value.endsWith("/")
  ) {
    fail("INVALID_LEDGER_DATA", `${label} is invalid`);
  }
  return value;
}

function exactTime(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("INVALID_LEDGER_DATA", `${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("INVALID_LEDGER_DATA", `${label} must be exact ISO-8601 UTC`);
  }
  return value;
}

function now(value: string | undefined): string {
  return exactTime(value ?? new Date().toISOString(), "ledger timestamp");
}

function envelope<TBody extends JsonRecord>(
  schemaVersion: string,
  body: TBody,
): LedgerEnvelope<TBody> {
  return {
    schema_version: schemaVersion,
    body,
    body_sha256: sha256(canonicalJson(body)),
  };
}

function artifactBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

async function writeExclusive(
  filePath: string,
  value: unknown,
): Promise<string> {
  const bytes = artifactBytes(value);
  if (bytes.byteLength > MAX_LEDGER_FILE_BYTES) {
    fail("LEDGER_FILE_TOO_LARGE", "ledger artifact exceeds size cap");
  }
  let handle;
  try {
    handle = await open(filePath, "wx", IMMUTABLE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", `${path.basename(filePath)} exists`);
    }
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(IMMUTABLE_FILE_MODE);
  } finally {
    await handle.close();
  }
  return sha256(bytes);
}

async function readBound<TBody extends JsonRecord>(
  filePath: string,
  schemaVersion: string,
): Promise<{
  value: LedgerEnvelope<TBody>;
  artifact_sha256: string;
}> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail("LEDGER_STATE_MISSING", `${path.basename(filePath)} is missing`);
    }
    throw error;
  }
  if (bytes.byteLength > MAX_LEDGER_FILE_BYTES) {
    fail("LEDGER_FILE_TOO_LARGE", "ledger artifact exceeds size cap");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("LEDGER_ARTIFACT_INVALID", `${path.basename(filePath)} is not JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("LEDGER_ARTIFACT_INVALID", "ledger artifact is not an object");
  }
  const parsed = value as LedgerEnvelope<TBody>;
  if (
    parsed.schema_version !== schemaVersion
    || !parsed.body
    || typeof parsed.body !== "object"
    || Array.isArray(parsed.body)
    || !SHA256.test(parsed.body_sha256)
    || sha256(canonicalJson(parsed.body)) !== parsed.body_sha256
    || artifactBytes(parsed).compare(bytes) !== 0
  ) {
    fail("LEDGER_ARTIFACT_INVALID", `${path.basename(filePath)} is not canonical`);
  }
  return { value: parsed, artifact_sha256: sha256(bytes) };
}

function statePaths(directory: string, authorizationSha256: string) {
  const authorization = exactSha(
    authorizationSha256,
    "authorization_sha256",
  );
  return {
    claim: path.join(directory, `${authorization}.json`),
    requesting: path.join(directory, `.${authorization}.requesting.json`),
    accepted: path.join(directory, `.${authorization}.accepted.json`),
    terminal: path.join(directory, `.${authorization}.terminal.json`),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertPrivateDirectory(directory: string): Promise<{
  canonical_path: string;
  directory_identity_sha256: string;
}> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("INVALID_LEDGER_CUSTODY", "ledger path must be a real directory");
  }
  if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("INVALID_LEDGER_CUSTODY", "ledger directory mode must be 0700");
  }
  const canonicalPath = await realpath(directory);
  return {
    canonical_path: canonicalPath,
    directory_identity_sha256: sha256(
      `${String(info.dev)}\0${String(info.ino)}\0${canonicalPath}`,
    ),
  };
}

async function readOptional<TBody extends JsonRecord>(
  filePath: string,
  schemaVersion: string,
): Promise<{
  value: LedgerEnvelope<TBody>;
  artifact_sha256: string;
} | null> {
  if (!await exists(filePath)) return null;
  return readBound<TBody>(filePath, schemaVersion);
}

export async function openWalmartListingFullSurfaceLedger(input: {
  directory: string;
  ledger_id: string;
  ledger_epoch?: string;
  now?: string;
}): Promise<WalmartListingFullSurfaceLedger> {
  const directory = path.resolve(input.directory);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const custody = await assertPrivateDirectory(directory);
  const identityPath = path.join(directory, IDENTITY_FILE_NAME);
  const createdAt = now(input.now);
  const proposedBody: IdentityBody = {
    ledger_id: safeId(input.ledger_id, "ledger_id"),
    ledger_epoch: safeId(
      input.ledger_epoch ?? createdAt,
      "ledger_epoch",
    ),
    canonical_directory_path_sha256: sha256(custody.canonical_path),
    directory_identity_sha256: custody.directory_identity_sha256,
    created_at: createdAt,
    policy_id: WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
  };
  if (!await exists(identityPath)) {
    try {
      await writeExclusive(
        identityPath,
        envelope(
          WALMART_LISTING_FULL_SURFACE_LEDGER_IDENTITY_SCHEMA,
          proposedBody,
        ),
      );
    } catch (error) {
      if (
        (error as Error & { code?: string }).code
        !== "AUTHORIZATION_ALREADY_CONSUMED"
      ) {
        throw error;
      }
    }
  }
  const identity = await readBound<IdentityBody>(
    identityPath,
    WALMART_LISTING_FULL_SURFACE_LEDGER_IDENTITY_SCHEMA,
  );
  if (
    identity.value.body.ledger_id !== proposedBody.ledger_id
    || identity.value.body.canonical_directory_path_sha256
      !== proposedBody.canonical_directory_path_sha256
    || identity.value.body.directory_identity_sha256
      !== proposedBody.directory_identity_sha256
    || (
      input.ledger_epoch !== undefined
      && identity.value.body.ledger_epoch !== input.ledger_epoch
    )
  ) {
    fail("LEDGER_IDENTITY_MISMATCH", "ledger identity/custody drifted");
  }
  const binding: WalmartListingFullSurfaceLedgerBinding = Object.freeze({
    policy_id: WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID,
    ledger_id: identity.value.body.ledger_id,
    ledger_epoch: identity.value.body.ledger_epoch,
    state_directory_path_sha256:
      identity.value.body.canonical_directory_path_sha256,
    directory_identity_sha256:
      identity.value.body.directory_identity_sha256,
    identity_artifact_sha256: identity.artifact_sha256,
    reservation_filename_policy:
      "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  });

  const inspect = async (
    authorizationSha256: string,
  ): Promise<WalmartListingFullSurfaceLedgerInspection> => {
    const authorization = exactSha(
      authorizationSha256,
      "authorization_sha256",
    );
    const paths = statePaths(directory, authorization);
    const claim = await readOptional<ClaimBody>(
      paths.claim,
      WALMART_LISTING_FULL_SURFACE_LEDGER_CLAIM_SCHEMA,
    );
    if (!claim) {
      return {
        authorization_sha256: authorization,
        state: "UNCLAIMED",
        claim_artifact_sha256: null,
        requesting_artifact_sha256: null,
        accepted_artifact_sha256: null,
        terminal_artifact_sha256: null,
        walmart_feed_id: null,
        mutation_replay_allowed: false,
        get_only_resume_allowed: false,
      };
    }
    if (
      claim.value.body.authorization_sha256 !== authorization
      || !Object.is(
        canonicalJson(claim.value.body.consumption_ledger),
        canonicalJson(binding),
      )
    ) {
      fail("LEDGER_ARTIFACT_INVALID", "claim binding is invalid");
    }
    const requesting = await readOptional<RequestingBody>(
      paths.requesting,
      WALMART_LISTING_FULL_SURFACE_LEDGER_REQUESTING_SCHEMA,
    );
    const accepted = await readOptional<AcceptedBody>(
      paths.accepted,
      WALMART_LISTING_FULL_SURFACE_LEDGER_ACCEPTED_SCHEMA,
    );
    const terminal = await readOptional<TerminalBody>(
      paths.terminal,
      WALMART_LISTING_FULL_SURFACE_LEDGER_TERMINAL_SCHEMA,
    );
    if (accepted && !requesting) {
      fail("LEDGER_ARTIFACT_INVALID", "ACCEPTED exists without REQUESTING");
    }
    if (terminal && !requesting) {
      fail("LEDGER_ARTIFACT_INVALID", "terminal exists without REQUESTING");
    }
    const state = terminal?.value.body.state
      ?? (accepted ? "ACCEPTED" : requesting ? "REQUESTING" : "CLAIMED");
    return {
      authorization_sha256: authorization,
      state,
      claim_artifact_sha256: claim.artifact_sha256,
      requesting_artifact_sha256: requesting?.artifact_sha256 ?? null,
      accepted_artifact_sha256: accepted?.artifact_sha256 ?? null,
      terminal_artifact_sha256: terminal?.artifact_sha256 ?? null,
      walmart_feed_id: accepted?.value.body.walmart_feed_id ?? null,
      mutation_replay_allowed: false,
      get_only_resume_allowed:
        state === "ACCEPTED"
        && accepted?.value.body.get_only_resume_allowed === true,
    };
  };

  return Object.freeze({
    directory,
    binding,
    claim: async (claimInput: WalmartListingFullSurfaceLedgerClaimInput) => {
      const authorization = exactSha(
        claimInput.authorization_sha256,
        "authorization_sha256",
      );
      const paths = statePaths(directory, authorization);
      const body: ClaimBody = {
        authorization_sha256: authorization,
        state: "CLAIMED",
        claim_id: randomUUID(),
        claimed_at: now(claimInput.now),
        plan_body_sha256: exactSha(
          claimInput.plan_body_sha256,
          "plan_body_sha256",
        ),
        operation_id: safeId(claimInput.operation_id, "operation_id"),
        operation_body_sha256: exactSha(
          claimInput.operation_body_sha256,
          "operation_body_sha256",
        ),
        request_payload_sha256: exactSha(
          claimInput.request_payload_sha256,
          "request_payload_sha256",
        ),
        request_byte_length: claimInput.request_byte_length,
        seller_account_fingerprint_sha256: exactSha(
          claimInput.seller_account_fingerprint_sha256,
          "seller_account_fingerprint_sha256",
        ),
        consumption_ledger: binding,
      };
      if (
        !Number.isSafeInteger(body.request_byte_length)
        || body.request_byte_length < 0
      ) {
        fail("INVALID_LEDGER_DATA", "request_byte_length is invalid");
      }
      const artifactSha = await writeExclusive(
        paths.claim,
        envelope(WALMART_LISTING_FULL_SURFACE_LEDGER_CLAIM_SCHEMA, body),
      );
      return Object.freeze({
        authorization_sha256: authorization,
        state: "CLAIMED" as const,
        claim_path: paths.claim,
        claim_artifact_sha256: artifactSha,
        claim_id: body.claim_id,
        claimed_at: body.claimed_at,
      });
    },
    markRequesting: async (
      requestingInput: WalmartListingFullSurfaceLedgerRequestingInput,
    ) => {
      const authorization = exactSha(
        requestingInput.authorization_sha256,
        "authorization_sha256",
      );
      const paths = statePaths(directory, authorization);
      const prior = await inspect(authorization);
      if (prior.state !== "CLAIMED" || !prior.claim_artifact_sha256) {
        fail("INVALID_LEDGER_TRANSITION", "REQUESTING requires CLAIMED");
      }
      const body: RequestingBody = {
        authorization_sha256: authorization,
        state: "REQUESTING",
        requesting_at: now(requestingInput.now),
        claim_artifact_sha256: prior.claim_artifact_sha256,
        request_manifest_sha256: exactSha(
          requestingInput.request_manifest_sha256,
          "request_manifest_sha256",
        ),
        request_payload_sha256: exactSha(
          requestingInput.request_payload_sha256,
          "request_payload_sha256",
        ),
        correlation_id: safeId(
          requestingInput.correlation_id,
          "correlation_id",
        ),
        marketplace_write_calls_before_transition: 0,
        consumption_ledger: binding,
      };
      const artifactSha = await writeExclusive(
        paths.requesting,
        envelope(
          WALMART_LISTING_FULL_SURFACE_LEDGER_REQUESTING_SCHEMA,
          body,
        ),
      );
      return Object.freeze({
        authorization_sha256: authorization,
        state: "REQUESTING" as const,
        requesting_path: paths.requesting,
        requesting_artifact_sha256: artifactSha,
        requesting_at: body.requesting_at,
        correlation_id: body.correlation_id,
      });
    },
    markAccepted: async (
      acceptedInput: WalmartListingFullSurfaceLedgerAcceptedInput,
    ) => {
      const authorization = exactSha(
        acceptedInput.authorization_sha256,
        "authorization_sha256",
      );
      const paths = statePaths(directory, authorization);
      const prior = await inspect(authorization);
      if (prior.state !== "REQUESTING" || !prior.requesting_artifact_sha256) {
        fail("INVALID_LEDGER_TRANSITION", "ACCEPTED requires REQUESTING");
      }
      if (
        !Number.isSafeInteger(acceptedInput.response_http_status)
        || acceptedInput.response_http_status < 200
        || acceptedInput.response_http_status > 299
      ) {
        fail("INVALID_LEDGER_DATA", "ACCEPTED requires exact HTTP 2xx");
      }
      const feedId = acceptedInput.walmart_feed_id ?? null;
      if (
        feedId !== null
        && (
          typeof feedId !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(feedId)
        )
      ) {
        fail("INVALID_LEDGER_DATA", "walmart_feed_id is invalid");
      }
      const body: AcceptedBody = {
        authorization_sha256: authorization,
        state: "ACCEPTED",
        accepted_at: now(acceptedInput.now),
        requesting_artifact_sha256: prior.requesting_artifact_sha256,
        response_http_status: acceptedInput.response_http_status,
        response_headers_sha256: exactSha(
          acceptedInput.response_headers_sha256,
          "response_headers_sha256",
        ),
        response_payload_sha256: exactSha(
          acceptedInput.response_payload_sha256,
          "response_payload_sha256",
        ),
        walmart_feed_id: feedId,
        marketplace_write_calls: 1,
        further_mutation_allowed: false,
        get_only_resume_allowed: feedId !== null,
        consumption_ledger: binding,
      };
      const artifactSha = await writeExclusive(
        paths.accepted,
        envelope(WALMART_LISTING_FULL_SURFACE_LEDGER_ACCEPTED_SCHEMA, body),
      );
      return Object.freeze({
        authorization_sha256: authorization,
        state: "ACCEPTED" as const,
        accepted_path: paths.accepted,
        accepted_artifact_sha256: artifactSha,
        accepted_at: body.accepted_at,
        walmart_feed_id: feedId,
        get_only_resume_allowed: feedId !== null,
      });
    },
    markTerminal: async (
      terminalInput: WalmartListingFullSurfaceLedgerTerminalInput,
    ) => {
      const authorization = exactSha(
        terminalInput.authorization_sha256,
        "authorization_sha256",
      );
      const paths = statePaths(directory, authorization);
      const prior = await inspect(authorization);
      if (
        !["REQUESTING", "ACCEPTED"].includes(prior.state)
        || !prior.requesting_artifact_sha256
      ) {
        fail(
          "INVALID_LEDGER_TRANSITION",
          "terminal state requires REQUESTING or ACCEPTED",
        );
      }
      if (
        terminalInput.state === "SUCCEEDED_AND_READ_BACK"
        && (
          prior.state !== "ACCEPTED"
          || terminalInput.readback_sha256 == null
        )
      ) {
        fail(
          "INVALID_LEDGER_TRANSITION",
          "success requires ACCEPTED plus exact readback",
        );
      }
      if (
        terminalInput.state === "UNKNOWN"
        && prior.state !== "REQUESTING"
      ) {
        fail("INVALID_LEDGER_TRANSITION", "UNKNOWN follows REQUESTING only");
      }
      const optionalSha = (
        value: string | null | undefined,
        label: string,
      ): string | null => value == null ? null : exactSha(value, label);
      const status = terminalInput.response_http_status ?? null;
      if (
        status !== null
        && (!Number.isSafeInteger(status) || status < 100 || status > 599)
      ) {
        fail("INVALID_LEDGER_DATA", "response_http_status is invalid");
      }
      const errorCode = terminalInput.error_code ?? null;
      if (errorCode !== null) safeId(errorCode, "error_code");
      const body: TerminalBody = {
        authorization_sha256: authorization,
        state: terminalInput.state,
        terminal_at: now(terminalInput.now),
        prior_state: prior.state as "REQUESTING" | "ACCEPTED",
        prior_state_artifact_sha256: prior.state === "ACCEPTED"
          ? prior.accepted_artifact_sha256!
          : prior.requesting_artifact_sha256,
        response_http_status: status,
        response_headers_sha256: optionalSha(
          terminalInput.response_headers_sha256,
          "response_headers_sha256",
        ),
        response_payload_sha256: optionalSha(
          terminalInput.response_payload_sha256,
          "response_payload_sha256",
        ),
        readback_sha256: optionalSha(
          terminalInput.readback_sha256,
          "readback_sha256",
        ),
        error_code: errorCode,
        marketplace_write_calls: 1,
        further_mutation_allowed: false,
        get_only_resume_allowed: false,
        consumption_ledger: binding,
      };
      const artifactSha = await writeExclusive(
        paths.terminal,
        envelope(WALMART_LISTING_FULL_SURFACE_LEDGER_TERMINAL_SCHEMA, body),
      );
      return Object.freeze({
        authorization_sha256: authorization,
        state: body.state,
        terminal_path: paths.terminal,
        terminal_artifact_sha256: artifactSha,
        terminal_at: body.terminal_at,
      });
    },
    inspect,
  });
}
