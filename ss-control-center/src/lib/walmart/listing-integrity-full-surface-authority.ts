/**
 * Domain-separated owner authority for one exact full-surface Walmart
 * operation. A permit authorizes one mutation call only; it is bound to the
 * plan, operation, request bytes, seller account, evidence and durable ledger.
 *
 * Private keys and signing helpers deliberately do not live in this module.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import {
  walmartOwnerControlProductionTrustedKeys,
  type WalmartOwnerControlTrustedKey,
} from "./owner-control-trust-root.ts";
import {
  WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA,
  WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA,
  walmartListingFullSurfaceSha256,
  type WalmartListingFullSurfaceOperation,
  type WalmartListingFullSurfacePlan,
} from "./listing-integrity-full-surface.ts";

export const WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA =
  "walmart-listing-integrity-full-surface-operation-permit/v1" as const;
export const WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION =
  "WALMART_LISTING_FULL_SURFACE_OPERATION" as const;
export const WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM =
  "Ed25519" as const;
export const WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID =
  "walmart-listing-full-surface-operation-ledger/1.0.0" as const;

const SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_LISTING_FULL_SURFACE_OPERATION\0v1\0",
  "utf8",
);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const MAX_PERMIT_TTL_MS = 30 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingFullSurfaceLedgerBinding {
  policy_id: typeof WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID;
  ledger_id: string;
  ledger_epoch: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
  identity_artifact_sha256: string;
  reservation_filename_policy:
    "authorization-sha256.json/exclusive-create/v1";
  trusted_single_custody_host_only: true;
  distributed_at_most_once_claimed: false;
}

export interface WalmartListingFullSurfacePermitSignedBody {
  action: typeof WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION;
  environment: "PRODUCTION" | "TEST_FIXTURE_ONLY";
  permit_id: string;
  issued_at: string;
  expires_at: string;
  approved_by: string;
  decision_ref: string;
  plan_schema_version: typeof WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA;
  plan_id: string;
  plan_body_sha256: string;
  operation_schema_version:
    typeof WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA;
  operation_id: string;
  operation_body_sha256: string;
  operation_kind: WalmartListingFullSurfaceOperation["operation_kind"];
  exact_skus: readonly string[];
  seller_account_fingerprint_sha256: string;
  evidence_sha256: string;
  request_payload_sha256: string;
  request_byte_length: number;
  irreversible_owner_decision_sha256: string | null;
  consumption_ledger: WalmartListingFullSurfaceLedgerBinding;
  claims: {
    exact_operation_count: 1;
    marketplace_write_calls: 1;
    retry_allowed: false;
    automatic_replay_allowed: false;
    payload_substitution_allowed: false;
    account_substitution_allowed: false;
    stop_on_unknown_outcome: true;
  };
}

export interface WalmartListingFullSurfacePermitSigningEnvelope {
  schema_version: typeof WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA;
  algorithm: typeof WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM;
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: WalmartListingFullSurfacePermitSignedBody;
}

export interface WalmartListingFullSurfacePermit
  extends WalmartListingFullSurfacePermitSigningEnvelope {
  signature_base64: string;
  signature_sha256: string;
  authorization_sha256: string;
}

export interface VerifyWalmartListingFullSurfacePermitInput {
  permit: WalmartListingFullSurfacePermit;
  plan: WalmartListingFullSurfacePlan;
  operation: WalmartListingFullSurfaceOperation;
  ledger_binding: WalmartListingFullSurfaceLedgerBinding;
  now?: string;
  trusted_keys?: readonly WalmartOwnerControlTrustedKey[];
}

function fail(message: string): never {
  const error = new Error(`Walmart full-surface permit rejected: ${message}`);
  (error as Error & { code: string }).code =
    "WALMART_LISTING_FULL_SURFACE_AUTHORITY_ERROR";
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
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} contains missing or extra fields`);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactText(value: unknown, label: string, maximum = 4096): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be an exact non-empty string`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = exactText(value, label, 200);
  if (!SAFE_ID.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail(`${label} is invalid`);
  }
  return parsed;
}

function exactSha(value: unknown, label: string): string {
  const parsed = exactText(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function exactTime(value: unknown, label: string): number {
  const parsed = exactText(value, label, 64);
  const milliseconds = Date.parse(parsed);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== parsed
  ) {
    fail(`${label} must be exact ISO-8601 UTC`);
  }
  return milliseconds;
}

function exactBase64(value: unknown, label: string): Buffer {
  const parsed = exactText(value, label, 1024);
  if (/\s/u.test(parsed)) fail(`${label} is not canonical base64`);
  const bytes = Buffer.from(parsed, "base64");
  if (!bytes.length || bytes.toString("base64") !== parsed) {
    fail(`${label} is not canonical base64`);
  }
  return bytes;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const result: Partial<T> = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}

function operationBody(
  operation: WalmartListingFullSurfaceOperation,
): Omit<WalmartListingFullSurfaceOperation, "body_sha256"> {
  return withoutKey(operation, "body_sha256");
}

function planBody(
  plan: WalmartListingFullSurfacePlan,
): Omit<WalmartListingFullSurfacePlan, "body_sha256"> {
  return withoutKey(plan, "body_sha256");
}

function validateLedgerBinding(
  value: unknown,
): WalmartListingFullSurfaceLedgerBinding {
  const row = record(value, "consumption_ledger");
  exactKeys(row, [
    "policy_id",
    "ledger_id",
    "ledger_epoch",
    "state_directory_path_sha256",
    "directory_identity_sha256",
    "identity_artifact_sha256",
    "reservation_filename_policy",
    "trusted_single_custody_host_only",
    "distributed_at_most_once_claimed",
  ], "consumption_ledger");
  if (
    row.policy_id !== WALMART_LISTING_FULL_SURFACE_LEDGER_POLICY_ID
    || row.reservation_filename_policy
      !== "authorization-sha256.json/exclusive-create/v1"
    || row.trusted_single_custody_host_only !== true
    || row.distributed_at_most_once_claimed !== false
  ) {
    fail("consumption_ledger policy claims are invalid");
  }
  safeId(row.ledger_id, "ledger_id");
  safeId(row.ledger_epoch, "ledger_epoch");
  exactSha(row.state_directory_path_sha256, "state directory path");
  exactSha(row.directory_identity_sha256, "directory identity");
  exactSha(row.identity_artifact_sha256, "identity artifact");
  return value as WalmartListingFullSurfaceLedgerBinding;
}

function validateSignedBody(
  value: unknown,
): WalmartListingFullSurfacePermitSignedBody {
  const row = record(value, "signed_body");
  exactKeys(row, [
    "action",
    "environment",
    "permit_id",
    "issued_at",
    "expires_at",
    "approved_by",
    "decision_ref",
    "plan_schema_version",
    "plan_id",
    "plan_body_sha256",
    "operation_schema_version",
    "operation_id",
    "operation_body_sha256",
    "operation_kind",
    "exact_skus",
    "seller_account_fingerprint_sha256",
    "evidence_sha256",
    "request_payload_sha256",
    "request_byte_length",
    "irreversible_owner_decision_sha256",
    "consumption_ledger",
    "claims",
  ], "signed_body");
  if (row.action !== WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION) {
    fail("signed_body action is invalid");
  }
  if (!["PRODUCTION", "TEST_FIXTURE_ONLY"].includes(String(row.environment))) {
    fail("signed_body environment is invalid");
  }
  safeId(row.permit_id, "permit_id");
  const issuedMs = exactTime(row.issued_at, "issued_at");
  const expiresMs = exactTime(row.expires_at, "expires_at");
  if (expiresMs <= issuedMs || expiresMs - issuedMs > MAX_PERMIT_TTL_MS) {
    fail("permit lifetime must be >0 and <=30 minutes");
  }
  exactText(row.approved_by, "approved_by", 512);
  exactText(row.decision_ref, "decision_ref", 4096);
  if (
    row.plan_schema_version !== WALMART_LISTING_FULL_SURFACE_PLAN_SCHEMA
    || row.operation_schema_version
      !== WALMART_LISTING_FULL_SURFACE_OPERATION_SCHEMA
  ) {
    fail("plan/operation schema version is invalid");
  }
  safeId(row.plan_id, "plan_id");
  exactSha(row.plan_body_sha256, "plan body");
  safeId(row.operation_id, "operation_id");
  exactSha(row.operation_body_sha256, "operation body");
  if (
    typeof row.operation_kind !== "string"
    || !row.operation_kind
  ) {
    fail("operation_kind is invalid");
  }
  if (
    !Array.isArray(row.exact_skus)
    || row.exact_skus.length < 1
    || row.exact_skus.some((sku) => {
      try {
        safeId(sku, "exact SKU");
        return false;
      } catch {
        return true;
      }
    })
    || [...new Set(row.exact_skus)].sort().join("\0")
      !== [...row.exact_skus].sort().join("\0")
  ) {
    fail("exact_skus must be non-empty and unique");
  }
  exactSha(row.seller_account_fingerprint_sha256, "seller account");
  exactSha(row.evidence_sha256, "evidence");
  exactSha(row.request_payload_sha256, "request payload");
  if (
    !Number.isSafeInteger(row.request_byte_length)
    || Number(row.request_byte_length) < 0
  ) {
    fail("request_byte_length is invalid");
  }
  if (row.irreversible_owner_decision_sha256 !== null) {
    exactSha(row.irreversible_owner_decision_sha256, "irreversible decision");
  }
  validateLedgerBinding(row.consumption_ledger);
  const claims = record(row.claims, "claims");
  exactKeys(claims, [
    "exact_operation_count",
    "marketplace_write_calls",
    "retry_allowed",
    "automatic_replay_allowed",
    "payload_substitution_allowed",
    "account_substitution_allowed",
    "stop_on_unknown_outcome",
  ], "claims");
  if (
    claims.exact_operation_count !== 1
    || claims.marketplace_write_calls !== 1
    || claims.retry_allowed !== false
    || claims.automatic_replay_allowed !== false
    || claims.payload_substitution_allowed !== false
    || claims.account_substitution_allowed !== false
    || claims.stop_on_unknown_outcome !== true
  ) {
    fail("permit safety claims are invalid");
  }
  return value as WalmartListingFullSurfacePermitSignedBody;
}

export function walmartListingFullSurfacePermitSigningMessage(
  envelope: WalmartListingFullSurfacePermitSigningEnvelope,
): Buffer {
  return Buffer.concat([
    SIGNING_DOMAIN,
    Buffer.from(canonicalJson(envelope), "utf8"),
  ]);
}

export function assembleWalmartListingFullSurfacePermit(input: {
  envelope: WalmartListingFullSurfacePermitSigningEnvelope;
  signature: Uint8Array;
}): WalmartListingFullSurfacePermit {
  validateSignedBody(input.envelope.signed_body);
  const signature = Buffer.from(input.signature);
  if (signature.byteLength !== 64) {
    fail("detached Ed25519 signature must contain exactly 64 raw bytes");
  }
  const authorizationBody = {
    ...input.envelope,
    signature_base64: signature.toString("base64"),
    signature_sha256: sha256Bytes(signature),
  };
  return Object.freeze({
    ...authorizationBody,
    authorization_sha256: sha256Json(authorizationBody),
  });
}

export function verifyWalmartListingFullSurfacePermit(
  input: VerifyWalmartListingFullSurfacePermitInput,
): WalmartListingFullSurfacePermit {
  const permit = record(input.permit, "permit");
  exactKeys(permit, [
    "schema_version",
    "algorithm",
    "key_id",
    "owner_public_key_spki_sha256",
    "signed_body",
    "signature_base64",
    "signature_sha256",
    "authorization_sha256",
  ], "permit");
  if (
    permit.schema_version !== WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA
    || permit.algorithm !== WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM
  ) {
    fail("permit schema/algorithm is invalid");
  }
  const keyId = safeId(permit.key_id, "key_id");
  const fingerprint = exactSha(
    permit.owner_public_key_spki_sha256,
    "owner public key",
  );
  const signedBody = validateSignedBody(permit.signed_body);
  const signature = exactBase64(permit.signature_base64, "signature_base64");
  if (signature.byteLength !== 64) fail("signature must contain 64 raw bytes");
  if (sha256Bytes(signature) !== exactSha(permit.signature_sha256, "signature")) {
    fail("signature SHA-256 mismatch");
  }
  const authorizationBody = withoutKey(
    input.permit,
    "authorization_sha256",
  );
  if (
    sha256Json(authorizationBody)
    !== exactSha(permit.authorization_sha256, "authorization")
  ) {
    fail("authorization SHA-256 mismatch");
  }
  const trustedKeys = input.trusted_keys
    ?? walmartOwnerControlProductionTrustedKeys();
  const trustedKey = trustedKeys.find((candidate) => (
    candidate.key_id === keyId
    && candidate.public_key_spki_sha256 === fingerprint
    && candidate.status === "ACTIVE"
    && candidate.environment === signedBody.environment
  ));
  if (!trustedKey) fail("owner key is not active for this environment");
  const publicKeyBytes = Buffer.from(
    trustedKey.public_key_spki_der_base64,
    "base64",
  );
  if (sha256Bytes(publicKeyBytes) !== fingerprint) {
    fail("trusted owner public-key fingerprint mismatch");
  }
  const envelope: WalmartListingFullSurfacePermitSigningEnvelope = {
    schema_version: WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA,
    algorithm: WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM,
    key_id: keyId,
    owner_public_key_spki_sha256: fingerprint,
    signed_body: signedBody,
  };
  const publicKey = createPublicKey({
    key: publicKeyBytes,
    format: "der",
    type: "spki",
  });
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !verifySignature(
      null,
      walmartListingFullSurfacePermitSigningMessage(envelope),
      publicKey,
      signature,
    )
  ) {
    fail("owner Ed25519 signature is invalid");
  }
  const nowMs = exactTime(
    input.now ?? new Date().toISOString(),
    "verification time",
  );
  const issuedMs = exactTime(signedBody.issued_at, "issued_at");
  const expiresMs = exactTime(signedBody.expires_at, "expires_at");
  if (nowMs + CLOCK_SKEW_MS < issuedMs || nowMs - CLOCK_SKEW_MS > expiresMs) {
    fail("permit is not current");
  }
  const plan = input.plan;
  const operation = input.operation;
  if (
    walmartListingFullSurfaceSha256(planBody(plan)) !== plan.body_sha256
    || walmartListingFullSurfaceSha256(operationBody(operation))
      !== operation.body_sha256
  ) {
    fail("plan or operation body hash is invalid");
  }
  if (!plan.operations.some((candidate) => (
    candidate.operation_id === operation.operation_id
    && candidate.body_sha256 === operation.body_sha256
  ))) {
    fail("operation is not a member of the exact plan");
  }
  const expectedBody: WalmartListingFullSurfacePermitSignedBody = {
    ...signedBody,
    plan_schema_version: plan.schema_version,
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    operation_schema_version: operation.schema_version,
    operation_id: operation.operation_id,
    operation_body_sha256: operation.body_sha256,
    operation_kind: operation.operation_kind,
    exact_skus: operation.exact_skus,
    seller_account_fingerprint_sha256:
      plan.seller_account_fingerprint_sha256,
    evidence_sha256: operation.evidence_sha256,
    request_payload_sha256:
      operation.exact_request.request_payload_sha256,
    request_byte_length: operation.exact_request.request_byte_length,
    irreversible_owner_decision_sha256:
      operation.irreversible_owner_decision_sha256,
    consumption_ledger: input.ledger_binding,
  };
  if (!sameJson(signedBody, expectedBody)) {
    fail("permit does not bind the exact plan, operation, payload and ledger");
  }
  return input.permit;
}
