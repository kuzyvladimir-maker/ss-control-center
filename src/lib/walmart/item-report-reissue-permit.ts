/**
 * Pure, no-I/O contract for one owner-custodied replacement Walmart ITEM v6
 * report-create POST after an ambiguous POST was reconciled to ABSENCE_ONLY.
 *
 * This v1 contract is deliberately hash-bound, not signed. The independently
 * supplied permit/artifact SHA-256 values protect exact bytes and bindings only;
 * they do not authenticate the owner. A caller must keep the permit and its
 * expected hashes under external owner custody. Until a dedicated production
 * trust root is selected, this module must never claim cryptographic owner
 * authentication or accept an action-specific key from another workflow.
 *
 * The module has no filesystem, network, credential, database, or model access.
 */

import { createHash } from "node:crypto";

import {
  WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  walmartItemReportSha256,
  walmartItemReportUtf8Sha256,
} from "./item-report-published-source.ts";

export const WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA =
  "walmart-item-report-reissue-permit/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_ACTION =
  "WALMART_ITEM_V6_REPORT_CREATE_REISSUE" as const;
export const WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA =
  "walmart-item-report-capture-session/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY =
  "default-gitignored-capture-root/direct-child/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS = 30 * 60 * 1000;
export const WALMART_ITEM_REPORT_REISSUE_MAX_EVIDENCE_AGE_MS =
  24 * 60 * 60 * 1000;
export const WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const WALMART_ITEM_REPORT_REISSUE_CONFIRMATION_PREFIX =
  "REISSUE_WALMART_ITEM_REPORT_V1" as const;
export const WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256 = createHash("sha256")
  .update("{}", "utf8")
  .digest("hex");

type JsonRecord = Record<string, unknown>;

export interface WalmartItemReportReissueAccountScope {
  channel: "WALMART_US";
  store_index: number;
  seller_account_fingerprint_sha256: string;
}

export interface WalmartItemReportReissueCorrelation {
  id: string;
  sha256: string;
}

export interface WalmartItemReportReissueSessionAuthority {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA;
  session_id: string;
  created_at: string;
  account_scope: WalmartItemReportReissueAccountScope;
  primary_correlations: {
    create: WalmartItemReportReissueCorrelation;
    ready_status: WalmartItemReportReissueCorrelation;
    download_locator: WalmartItemReportReissueCorrelation;
    report_file: WalmartItemReportReissueCorrelation;
  };
  trust_statement: {
    adapter_atomic_integrity: true;
    walmart_signature_claimed: false;
    tls_server_authenticity_claimed_by_artifact: false;
  };
}

export interface WalmartItemReportReissuePriorAbsenceOnly {
  session_name: string;
  session_id: string;
  session_authority_sha256: string;
  create_manifest_sha256: string;
  request_reserved_sha256: string;
  manual_review_sha256: string;
  manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME";
  manual_review_retry_forbidden: true;
  reconciliation_id: string;
  reconciliation_scope_sha256: string;
  reconciliation_result_sha256: string;
  reconciliation_complete_sha256: string;
  response_set_sha256: string;
  reconciliation_completed_at: string;
  outcome: "ABSENCE_ONLY";
  observed_row_count: 0;
  candidate_count: 0;
  exact_correlation_match_count: 0;
  duplicate_request_id_count: 0;
  request_id_adopted: false;
  original_request_complete_written: false;
}

export interface WalmartItemReportReissueReplacementBinding {
  capture_root_policy_id: typeof WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY;
  session_name: string;
  session_id: string;
  session_authority_schema_version: typeof WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA;
  session_authority: WalmartItemReportReissueSessionAuthority;
  session_authority_sha256: string;
  create_request_manifest_schema_version:
    typeof WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA;
  create_request_manifest: ReturnType<typeof buildWalmartItemReportV6CreateRequestManifest>;
  create_request_manifest_sha256: string;
  create_request_correlation_id_sha256: string;
}

export interface WalmartItemReportReissueFreshness {
  issued_at: string;
  expires_at: string;
  prior_evidence_fresh_until: string;
}

export interface WalmartItemReportReissueAuthorization {
  report_create_post_authorized: true;
  maximum_create_post_calls: 1;
  maximum_oauth_token_calls: 1;
  maximum_walmart_api_calls: 1;
  maximum_request_timeout_ms: 60_000;
  retry_attempts_allowed: 0;
  automatic_replay_allowed: false;
  paid_provider_calls_allowed: false;
  method: "POST";
  endpoint: "/v3/reports/reportRequests";
  report_type: "ITEM";
  report_version: "v6";
  request_body_sha256: typeof WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256;
  request_id_adoption_from_prior: false;
  original_session_mutation_allowed: false;
  database_writes_allowed: false;
  model_calls_allowed: false;
  listing_mutations_allowed: false;
  scheduled_execution_allowed: false;
}

export interface WalmartItemReportReissueTrustBoundary {
  external_owner_custody_required: true;
  independently_supplied_permit_sha256_required: true;
  exact_canonical_artifact_bytes_required: true;
  cryptographic_owner_authentication: false;
  artifact_alone_proves_owner_authorship: false;
}

export interface WalmartItemReportReissueRiskAcknowledgement {
  absence_only_is_not_proof_original_post_failed: true;
  duplicate_report_request_risk_accepted: true;
  original_session_remains_manual_review: true;
  original_request_id_must_not_be_adopted: true;
}

export interface WalmartItemReportReissuePermitBody {
  permit_id: string;
  action: typeof WALMART_ITEM_REPORT_REISSUE_ACTION;
  approved_by: string;
  decision_ref: string;
  source_evidence_release_sha256: string;
  account_scope: WalmartItemReportReissueAccountScope;
  prior_absence_only: WalmartItemReportReissuePriorAbsenceOnly;
  replacement: WalmartItemReportReissueReplacementBinding;
  freshness: WalmartItemReportReissueFreshness;
  authorization: WalmartItemReportReissueAuthorization;
  owner_risk_acknowledgement: WalmartItemReportReissueRiskAcknowledgement;
  trust_boundary: WalmartItemReportReissueTrustBoundary;
}

export interface WalmartItemReportReissuePermit {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA;
  body: WalmartItemReportReissuePermitBody;
  body_sha256: string;
  permit_sha256: string;
}

export interface WalmartItemReportReissuePermitBuildInput {
  permit_id: string;
  approved_by: string;
  decision_ref: string;
  source_evidence_release_sha256: string;
  account_scope: WalmartItemReportReissueAccountScope;
  prior_absence_only: WalmartItemReportReissuePriorAbsenceOnly;
  replacement_session_name: string;
  replacement_session_authority: unknown;
  replacement_create_request_manifest: unknown;
  issued_at: string;
  expires_at: string;
  prior_evidence_fresh_until: string;
}

export interface WalmartItemReportReissuePermitVerificationContext {
  expected_permit_sha256: string;
  expected_source_evidence_release_sha256: string;
  now: Date;
  account_scope: WalmartItemReportReissueAccountScope;
  prior_absence_only: WalmartItemReportReissuePriorAbsenceOnly;
  replacement_session_name: string;
  replacement_session_authority: unknown;
  replacement_create_request_manifest: unknown;
}

export interface WalmartItemReportReissuePermitByteVerificationContext
  extends WalmartItemReportReissuePermitVerificationContext {
  expected_artifact_sha256: string;
}

export class WalmartItemReportReissuePermitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissuePermitError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissuePermitError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_PERMIT", `${label} must be an object`);
  return value;
}

function assertExactKeys(raw: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_PERMIT", `${label} has missing or extra fields`);
  }
}

function exactString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_PERMIT", `${label} is invalid`);
  }
  return value;
}

function exactDigest(value: unknown, label: string): string {
  const digest = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    fail("INVALID_PERMIT", `${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_PERMIT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function literalZero(value: unknown, label: string): 0 {
  if (value !== 0) fail("INVALID_PERMIT", `${label} must be zero`);
  return 0;
}

function strictInstant(value: unknown, label: string): string {
  const instant = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)) {
    fail("INVALID_PERMIT", `${label} must be canonical UTC ISO-8601 milliseconds`);
  }
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== instant) {
    fail("INVALID_PERMIT", `${label} is not a real canonical instant`);
  }
  return instant;
}

function safeIdentifier(value: unknown, label: string, maximum = 200): string {
  const identifier = exactString(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(identifier)
    || identifier.includes("//") || identifier.endsWith("/")) {
    fail("INVALID_PERMIT", `${label} is not a safe identifier`);
  }
  return identifier;
}

function safeSessionName(value: unknown, label: string): string {
  const sessionName = exactString(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(sessionName)
    || sessionName === "." || sessionName === "..") {
    fail("INVALID_PERMIT", `${label} must be one direct-child session name`);
  }
  return sessionName;
}

function decisionReference(value: unknown): string {
  const reference = exactString(value, "decision_ref", 2048);
  let parsed: URL;
  try {
    parsed = new URL(reference);
  } catch {
    fail("INVALID_PERMIT", "decision_ref must be an absolute external reference");
  }
  if (!new Set(["https:", "urn:"]).has(parsed.protocol)) {
    fail("INVALID_PERMIT", "decision_ref protocol is not approved");
  }
  return reference;
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function assertDeepExact(actual: unknown, expected: unknown, label: string): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      fail("BINDING_MISMATCH", `${label} differs from the exact expected value`);
    }
    expected.forEach((value, index) => assertDeepExact(actual[index], value, `${label}[${index}]`));
    return;
  }
  if (isRecord(expected)) {
    const raw = asRecord(actual, label);
    assertExactKeys(raw, Object.keys(expected), label);
    for (const key of Object.keys(expected)) {
      assertDeepExact(raw[key], expected[key], `${label}.${key}`);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    fail("BINDING_MISMATCH", `${label} differs from the exact expected value`);
  }
}

function parseAccountScope(value: unknown, label: string): WalmartItemReportReissueAccountScope {
  const raw = asRecord(value, label);
  assertExactKeys(raw, [
    "channel", "seller_account_fingerprint_sha256", "store_index",
  ], label);
  if (raw.channel !== "WALMART_US") fail("INVALID_PERMIT", `${label}.channel is invalid`);
  return {
    channel: "WALMART_US",
    store_index: positiveInteger(raw.store_index, `${label}.store_index`),
    seller_account_fingerprint_sha256: exactDigest(
      raw.seller_account_fingerprint_sha256,
      `${label}.seller_account_fingerprint_sha256`,
    ),
  };
}

function parseCorrelation(value: unknown, label: string): WalmartItemReportReissueCorrelation {
  const raw = asRecord(value, label);
  assertExactKeys(raw, ["id", "sha256"], label);
  const id = exactString(raw.id, `${label}.id`, 256);
  const sha256 = exactDigest(raw.sha256, `${label}.sha256`);
  if (sha256 !== walmartItemReportUtf8Sha256(id)) {
    fail("INVALID_SESSION_AUTHORITY", `${label} digest does not bind its exact ID`);
  }
  return { id, sha256 };
}

export function parseWalmartItemReportReissueSessionAuthority(
  value: unknown,
): WalmartItemReportReissueSessionAuthority {
  const raw = asRecord(value, "replacement SessionAuthority");
  assertExactKeys(raw, [
    "account_scope", "created_at", "primary_correlations", "schema_version",
    "session_id", "trust_statement",
  ], "replacement SessionAuthority");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA) {
    fail("INVALID_SESSION_AUTHORITY", "replacement SessionAuthority schema is invalid");
  }
  const correlations = asRecord(
    raw.primary_correlations,
    "replacement SessionAuthority.primary_correlations",
  );
  assertExactKeys(correlations, [
    "create", "download_locator", "ready_status", "report_file",
  ], "replacement SessionAuthority.primary_correlations");
  const trust = asRecord(raw.trust_statement, "replacement SessionAuthority.trust_statement");
  assertExactKeys(trust, [
    "adapter_atomic_integrity", "tls_server_authenticity_claimed_by_artifact",
    "walmart_signature_claimed",
  ], "replacement SessionAuthority.trust_statement");
  if (trust.adapter_atomic_integrity !== true
    || trust.walmart_signature_claimed !== false
    || trust.tls_server_authenticity_claimed_by_artifact !== false) {
    fail("INVALID_SESSION_AUTHORITY", "replacement SessionAuthority trust statement is invalid");
  }
  const parsed: WalmartItemReportReissueSessionAuthority = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA,
    session_id: safeIdentifier(raw.session_id, "replacement SessionAuthority.session_id", 256),
    created_at: strictInstant(raw.created_at, "replacement SessionAuthority.created_at"),
    account_scope: parseAccountScope(
      raw.account_scope,
      "replacement SessionAuthority.account_scope",
    ),
    primary_correlations: {
      create: parseCorrelation(correlations.create, "replacement create correlation"),
      ready_status: parseCorrelation(correlations.ready_status, "replacement READY correlation"),
      download_locator: parseCorrelation(
        correlations.download_locator,
        "replacement locator correlation",
      ),
      report_file: parseCorrelation(correlations.report_file, "replacement file correlation"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
  const ids = Object.values(parsed.primary_correlations).map((correlation) => correlation.id);
  const digests = Object.values(parsed.primary_correlations).map((correlation) => correlation.sha256);
  if (new Set(ids).size !== 4 || new Set(digests).size !== 4) {
    fail("INVALID_SESSION_AUTHORITY", "replacement correlations must be distinct");
  }
  return parsed;
}

function parsePriorAbsenceOnly(value: unknown): WalmartItemReportReissuePriorAbsenceOnly {
  const raw = asRecord(value, "prior_absence_only");
  assertExactKeys(raw, [
    "candidate_count", "create_manifest_sha256", "duplicate_request_id_count",
    "exact_correlation_match_count", "manual_review_reason_code",
    "manual_review_retry_forbidden", "manual_review_sha256", "observed_row_count",
    "original_request_complete_written", "outcome", "reconciliation_complete_sha256",
    "reconciliation_completed_at", "reconciliation_id", "reconciliation_result_sha256",
    "reconciliation_scope_sha256", "request_id_adopted", "request_reserved_sha256",
    "response_set_sha256", "session_authority_sha256", "session_id", "session_name",
  ], "prior_absence_only");
  if (raw.manual_review_reason_code !== "AMBIGUOUS_POST_NETWORK_OUTCOME"
    || raw.manual_review_retry_forbidden !== true
    || raw.outcome !== "ABSENCE_ONLY"
    || raw.request_id_adopted !== false
    || raw.original_request_complete_written !== false) {
    fail("PRIOR_EVIDENCE_NOT_ABSENCE_ONLY", "prior evidence is not the exact safe reissue basis");
  }
  const reconciliationId = exactString(raw.reconciliation_id, "prior reconciliation_id", 64);
  if (!/^[a-f0-9]{24}$/u.test(reconciliationId)) {
    fail("INVALID_PERMIT", "prior reconciliation_id is invalid");
  }
  return {
    session_name: safeSessionName(raw.session_name, "prior session_name"),
    session_id: safeIdentifier(raw.session_id, "prior session_id", 256),
    session_authority_sha256: exactDigest(
      raw.session_authority_sha256,
      "prior session_authority_sha256",
    ),
    create_manifest_sha256: exactDigest(
      raw.create_manifest_sha256,
      "prior create_manifest_sha256",
    ),
    request_reserved_sha256: exactDigest(
      raw.request_reserved_sha256,
      "prior request_reserved_sha256",
    ),
    manual_review_sha256: exactDigest(raw.manual_review_sha256, "prior manual_review_sha256"),
    manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
    manual_review_retry_forbidden: true,
    reconciliation_id: reconciliationId,
    reconciliation_scope_sha256: exactDigest(
      raw.reconciliation_scope_sha256,
      "prior reconciliation_scope_sha256",
    ),
    reconciliation_result_sha256: exactDigest(
      raw.reconciliation_result_sha256,
      "prior reconciliation_result_sha256",
    ),
    reconciliation_complete_sha256: exactDigest(
      raw.reconciliation_complete_sha256,
      "prior reconciliation_complete_sha256",
    ),
    response_set_sha256: exactDigest(raw.response_set_sha256, "prior response_set_sha256"),
    reconciliation_completed_at: strictInstant(
      raw.reconciliation_completed_at,
      "prior reconciliation_completed_at",
    ),
    outcome: "ABSENCE_ONLY",
    observed_row_count: literalZero(raw.observed_row_count, "prior observed_row_count"),
    candidate_count: literalZero(raw.candidate_count, "prior candidate_count"),
    exact_correlation_match_count: literalZero(
      raw.exact_correlation_match_count,
      "prior exact_correlation_match_count",
    ),
    duplicate_request_id_count: literalZero(
      raw.duplicate_request_id_count,
      "prior duplicate_request_id_count",
    ),
    request_id_adopted: false,
    original_request_complete_written: false,
  };
}

function replacementBinding(input: {
  account_scope: WalmartItemReportReissueAccountScope;
  session_name: string;
  session_authority: unknown;
  create_request_manifest: unknown;
}): WalmartItemReportReissueReplacementBinding {
  const accountScope = parseAccountScope(input.account_scope, "replacement account_scope");
  const authority = parseWalmartItemReportReissueSessionAuthority(input.session_authority);
  if (!sameCanonical(accountScope, authority.account_scope)) {
    fail("ACCOUNT_SCOPE_MISMATCH", "replacement SessionAuthority account scope differs");
  }
  const expectedManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: accountScope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  assertDeepExact(
    input.create_request_manifest,
    expectedManifest,
    "replacement create request manifest",
  );
  return {
    capture_root_policy_id: WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY,
    session_name: safeSessionName(input.session_name, "replacement session_name"),
    session_id: authority.session_id,
    session_authority_schema_version: WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA,
    session_authority: authority,
    session_authority_sha256: walmartItemReportSha256(authority),
    create_request_manifest_schema_version:
      WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
    create_request_manifest: expectedManifest,
    create_request_manifest_sha256: walmartItemReportSha256(expectedManifest),
    create_request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  };
}

function parseReplacement(value: unknown): WalmartItemReportReissueReplacementBinding {
  const raw = asRecord(value, "replacement");
  assertExactKeys(raw, [
    "capture_root_policy_id", "create_request_correlation_id_sha256",
    "create_request_manifest", "create_request_manifest_schema_version",
    "create_request_manifest_sha256", "session_authority", "session_authority_schema_version",
    "session_authority_sha256", "session_id", "session_name",
  ], "replacement");
  if (raw.capture_root_policy_id !== WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY
    || raw.session_authority_schema_version !== WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA
    || raw.create_request_manifest_schema_version
      !== WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA) {
    fail("INVALID_PERMIT", "replacement schema/root policy is invalid");
  }
  const authority = parseWalmartItemReportReissueSessionAuthority(raw.session_authority);
  const expectedManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  assertDeepExact(raw.create_request_manifest, expectedManifest, "replacement.create_request_manifest");
  const sessionId = safeIdentifier(raw.session_id, "replacement session_id", 256);
  const sessionAuthoritySha = exactDigest(
    raw.session_authority_sha256,
    "replacement session_authority_sha256",
  );
  const createManifestSha = exactDigest(
    raw.create_request_manifest_sha256,
    "replacement create_request_manifest_sha256",
  );
  const createCorrelationSha = exactDigest(
    raw.create_request_correlation_id_sha256,
    "replacement create_request_correlation_id_sha256",
  );
  if (sessionId !== authority.session_id
    || sessionAuthoritySha !== walmartItemReportSha256(authority)
    || createManifestSha !== walmartItemReportSha256(expectedManifest)
    || createCorrelationSha !== authority.primary_correlations.create.sha256) {
    fail("BINDING_MISMATCH", "replacement full preimages do not match their exact identities/hashes");
  }
  return {
    capture_root_policy_id: WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY,
    session_name: safeSessionName(raw.session_name, "replacement session_name"),
    session_id: sessionId,
    session_authority_schema_version: WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA,
    session_authority: authority,
    session_authority_sha256: sessionAuthoritySha,
    create_request_manifest_schema_version:
      WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
    create_request_manifest: expectedManifest,
    create_request_manifest_sha256: createManifestSha,
    create_request_correlation_id_sha256: createCorrelationSha,
  };
}

function fixedAuthorization(): WalmartItemReportReissueAuthorization {
  return {
    report_create_post_authorized: true,
    maximum_create_post_calls: 1,
    maximum_oauth_token_calls: 1,
    maximum_walmart_api_calls: 1,
    maximum_request_timeout_ms: 60_000,
    retry_attempts_allowed: 0,
    automatic_replay_allowed: false,
    paid_provider_calls_allowed: false,
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    report_type: "ITEM",
    report_version: "v6",
    request_body_sha256: WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256,
    request_id_adoption_from_prior: false,
    original_session_mutation_allowed: false,
    database_writes_allowed: false,
    model_calls_allowed: false,
    listing_mutations_allowed: false,
    scheduled_execution_allowed: false,
  };
}

function fixedTrustBoundary(): WalmartItemReportReissueTrustBoundary {
  return {
    external_owner_custody_required: true,
    independently_supplied_permit_sha256_required: true,
    exact_canonical_artifact_bytes_required: true,
    cryptographic_owner_authentication: false,
    artifact_alone_proves_owner_authorship: false,
  };
}

function fixedRiskAcknowledgement(): WalmartItemReportReissueRiskAcknowledgement {
  return {
    absence_only_is_not_proof_original_post_failed: true,
    duplicate_report_request_risk_accepted: true,
    original_session_remains_manual_review: true,
    original_request_id_must_not_be_adopted: true,
  };
}

function parseFixedObject<T extends JsonRecord>(
  value: unknown,
  expected: T,
  label: string,
): T {
  assertDeepExact(value, expected, label);
  return expected;
}

function parseFreshness(value: unknown): WalmartItemReportReissueFreshness {
  const raw = asRecord(value, "freshness");
  assertExactKeys(raw, ["expires_at", "issued_at", "prior_evidence_fresh_until"], "freshness");
  return {
    issued_at: strictInstant(raw.issued_at, "freshness.issued_at"),
    expires_at: strictInstant(raw.expires_at, "freshness.expires_at"),
    prior_evidence_fresh_until: strictInstant(
      raw.prior_evidence_fresh_until,
      "freshness.prior_evidence_fresh_until",
    ),
  };
}

function validateFreshnessShape(
  prior: WalmartItemReportReissuePriorAbsenceOnly,
  replacement: WalmartItemReportReissueReplacementBinding,
  freshness: WalmartItemReportReissueFreshness,
): void {
  const completedAt = Date.parse(prior.reconciliation_completed_at);
  const replacementPreparedAt = Date.parse(replacement.session_authority.created_at);
  const issuedAt = Date.parse(freshness.issued_at);
  const expiresAt = Date.parse(freshness.expires_at);
  const evidenceFreshUntil = Date.parse(freshness.prior_evidence_fresh_until);
  if (replacementPreparedAt < completedAt
    || replacementPreparedAt > issuedAt
    || issuedAt - replacementPreparedAt > WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS
    || issuedAt < completedAt
    || evidenceFreshUntil <= completedAt
    || evidenceFreshUntil - completedAt > WALMART_ITEM_REPORT_REISSUE_MAX_EVIDENCE_AGE_MS
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS
    || issuedAt > evidenceFreshUntil
    || expiresAt > evidenceFreshUntil) {
    fail("INVALID_FRESHNESS", "permit or prior ABSENCE_ONLY freshness bounds are invalid");
  }
}

function parsePermitBody(value: unknown): WalmartItemReportReissuePermitBody {
  const raw = asRecord(value, "permit body");
  assertExactKeys(raw, [
    "account_scope", "action", "approved_by", "authorization", "decision_ref",
    "freshness", "owner_risk_acknowledgement", "permit_id", "prior_absence_only",
    "replacement", "source_evidence_release_sha256", "trust_boundary",
  ], "permit body");
  if (raw.action !== WALMART_ITEM_REPORT_REISSUE_ACTION) {
    fail("INVALID_PERMIT", "permit action is invalid");
  }
  const prior = parsePriorAbsenceOnly(raw.prior_absence_only);
  const replacement = parseReplacement(raw.replacement);
  const freshness = parseFreshness(raw.freshness);
  const accountScope = parseAccountScope(raw.account_scope, "permit account_scope");
  validateFreshnessShape(prior, replacement, freshness);
  if (!sameCanonical(accountScope, replacement.session_authority.account_scope)) {
    fail("ACCOUNT_SCOPE_MISMATCH", "permit account scope differs from replacement SessionAuthority");
  }
  if (prior.session_name === replacement.session_name
    || prior.session_id === replacement.session_id
    || prior.session_authority_sha256 === replacement.session_authority_sha256
    || prior.create_manifest_sha256 === replacement.create_request_manifest_sha256) {
    fail("REPLACEMENT_NOT_DISTINCT", "replacement must be a distinct exact session and POST");
  }
  return {
    permit_id: safeIdentifier(raw.permit_id, "permit_id"),
    action: WALMART_ITEM_REPORT_REISSUE_ACTION,
    approved_by: exactString(raw.approved_by, "approved_by", 256),
    decision_ref: decisionReference(raw.decision_ref),
    source_evidence_release_sha256: exactDigest(
      raw.source_evidence_release_sha256,
      "source_evidence_release_sha256",
    ),
    account_scope: accountScope,
    prior_absence_only: prior,
    replacement,
    freshness,
    authorization: parseFixedObject(
      raw.authorization,
      fixedAuthorization() as unknown as JsonRecord,
      "authorization",
    ) as unknown as WalmartItemReportReissueAuthorization,
    owner_risk_acknowledgement: parseFixedObject(
      raw.owner_risk_acknowledgement,
      fixedRiskAcknowledgement() as unknown as JsonRecord,
      "owner_risk_acknowledgement",
    ) as unknown as WalmartItemReportReissueRiskAcknowledgement,
    trust_boundary: parseFixedObject(
      raw.trust_boundary,
      fixedTrustBoundary() as unknown as JsonRecord,
      "trust_boundary",
    ) as unknown as WalmartItemReportReissueTrustBoundary,
  };
}

function permitPreimage(
  body: WalmartItemReportReissuePermitBody,
  bodySha256: string,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA,
    body,
    body_sha256: bodySha256,
  } as const;
}

export function parseWalmartItemReportReissuePermit(
  value: unknown,
): WalmartItemReportReissuePermit {
  const raw = asRecord(value, "reissue permit");
  assertExactKeys(raw, ["body", "body_sha256", "permit_sha256", "schema_version"], "reissue permit");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA) {
    fail("INVALID_PERMIT", "reissue permit schema is invalid");
  }
  const body = parsePermitBody(raw.body);
  const bodySha256 = exactDigest(raw.body_sha256, "body_sha256");
  const permitSha256 = exactDigest(raw.permit_sha256, "permit_sha256");
  if (bodySha256 !== walmartItemReportSha256(body)
    || permitSha256 !== walmartItemReportSha256(permitPreimage(body, bodySha256))) {
    fail("PERMIT_HASH_MISMATCH", "permit body or envelope hash is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA,
    body,
    body_sha256: bodySha256,
    permit_sha256: permitSha256,
  };
}

export function buildWalmartItemReportReissuePermit(
  input: WalmartItemReportReissuePermitBuildInput,
): WalmartItemReportReissuePermit {
  const accountScope = parseAccountScope(input.account_scope, "input account_scope");
  const prior = parsePriorAbsenceOnly(input.prior_absence_only);
  const replacement = replacementBinding({
    account_scope: accountScope,
    session_name: input.replacement_session_name,
    session_authority: input.replacement_session_authority,
    create_request_manifest: input.replacement_create_request_manifest,
  });
  const body: WalmartItemReportReissuePermitBody = {
    permit_id: safeIdentifier(input.permit_id, "permit_id"),
    action: WALMART_ITEM_REPORT_REISSUE_ACTION,
    approved_by: exactString(input.approved_by, "approved_by", 256),
    decision_ref: decisionReference(input.decision_ref),
    source_evidence_release_sha256: exactDigest(
      input.source_evidence_release_sha256,
      "source_evidence_release_sha256",
    ),
    account_scope: accountScope,
    prior_absence_only: prior,
    replacement,
    freshness: {
      issued_at: strictInstant(input.issued_at, "issued_at"),
      expires_at: strictInstant(input.expires_at, "expires_at"),
      prior_evidence_fresh_until: strictInstant(
        input.prior_evidence_fresh_until,
        "prior_evidence_fresh_until",
      ),
    },
    authorization: fixedAuthorization(),
    owner_risk_acknowledgement: fixedRiskAcknowledgement(),
    trust_boundary: fixedTrustBoundary(),
  };
  validateFreshnessShape(prior, replacement, body.freshness);
  const bodySha256 = walmartItemReportSha256(body);
  return parseWalmartItemReportReissuePermit({
    ...permitPreimage(body, bodySha256),
    permit_sha256: walmartItemReportSha256(permitPreimage(body, bodySha256)),
  });
}

export function canonicalWalmartItemReportReissuePermitBytes(
  value: unknown,
): Uint8Array {
  const permit = parseWalmartItemReportReissuePermit(value);
  return new TextEncoder().encode(canonicalWalmartItemReportJson(permit));
}

export function walmartItemReportReissuePermitArtifactSha256(
  bytes: Uint8Array,
): string {
  return sha256Bytes(bytes);
}

/**
 * Exact non-secret phrase that the owner supplies independently from the
 * permit file. Like the v1 permit itself this is an external-custody binding,
 * not a digital signature.
 */
export function walmartItemReportReissueOwnerConfirmation(
  value: unknown,
): string {
  const permit = parseWalmartItemReportReissuePermit(value);
  return `${WALMART_ITEM_REPORT_REISSUE_CONFIRMATION_PREFIX}:${permit.permit_sha256}:${permit.body.permit_id}`;
}

export function assertWalmartItemReportReissueOwnerConfirmation(
  value: unknown,
  confirmation: unknown,
): void {
  if (confirmation !== walmartItemReportReissueOwnerConfirmation(value)) {
    fail(
      "OWNER_CONFIRMATION_MISMATCH",
      "owner confirmation does not bind the exact reissue permit",
    );
  }
}

export function parseWalmartItemReportReissuePermitBytes(
  bytes: Uint8Array,
): WalmartItemReportReissuePermit {
  if (bytes.byteLength >= 3
    && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("NON_CANONICAL_PERMIT_BYTES", "permit artifact must not contain a UTF-8 BOM");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("INVALID_PERMIT_BYTES", "permit artifact is not exact UTF-8 JSON");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("INVALID_PERMIT_BYTES", "permit artifact is not valid JSON");
  }
  const permit = parseWalmartItemReportReissuePermit(raw);
  const canonical = canonicalWalmartItemReportJson(permit);
  if (text !== canonical) {
    fail("NON_CANONICAL_PERMIT_BYTES", "permit artifact bytes are not exact canonical JSON");
  }
  return permit;
}

function expectedReplacement(
  context: WalmartItemReportReissuePermitVerificationContext,
): WalmartItemReportReissueReplacementBinding {
  return replacementBinding({
    account_scope: context.account_scope,
    session_name: context.replacement_session_name,
    session_authority: context.replacement_session_authority,
    create_request_manifest: context.replacement_create_request_manifest,
  });
}

export function verifyWalmartItemReportReissuePermit(
  value: unknown,
  context: WalmartItemReportReissuePermitVerificationContext,
): WalmartItemReportReissuePermit {
  const permit = parseWalmartItemReportReissuePermit(value);
  const expectedPermitSha = exactDigest(
    context.expected_permit_sha256,
    "externally supplied expected_permit_sha256",
  );
  if (permit.permit_sha256 !== expectedPermitSha) {
    fail("EXTERNAL_CUSTODY_HASH_MISMATCH", "permit differs from the externally supplied owner-custody hash");
  }
  const expectedReleaseSha = exactDigest(
    context.expected_source_evidence_release_sha256,
    "expected_source_evidence_release_sha256",
  );
  if (permit.body.source_evidence_release_sha256 !== expectedReleaseSha) {
    fail("SOURCE_EVIDENCE_RELEASE_MISMATCH", "permit targets a different source-evidence release");
  }
  const accountScope = parseAccountScope(context.account_scope, "active account_scope");
  const prior = parsePriorAbsenceOnly(context.prior_absence_only);
  const replacement = expectedReplacement(context);
  if (!sameCanonical(permit.body.account_scope, accountScope)
    || !sameCanonical(permit.body.prior_absence_only, prior)
    || !sameCanonical(permit.body.replacement, replacement)) {
    fail("BINDING_MISMATCH", "permit differs from active account/prior/replacement bindings");
  }
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
    fail("INVALID_VERIFICATION_TIME", "verification now must be a valid Date");
  }
  const now = context.now.getTime();
  const issuedAt = Date.parse(permit.body.freshness.issued_at);
  const expiresAt = Date.parse(permit.body.freshness.expires_at);
  const evidenceFreshUntil = Date.parse(permit.body.freshness.prior_evidence_fresh_until);
  if (issuedAt > now + WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS
    || now > expiresAt || now > evidenceFreshUntil) {
    fail("PERMIT_EXPIRED_OR_NOT_CURRENT", "permit or prior ABSENCE_ONLY evidence is not current");
  }
  return permit;
}

export function verifyWalmartItemReportReissuePermitBytes(
  bytes: Uint8Array,
  context: WalmartItemReportReissuePermitByteVerificationContext,
): WalmartItemReportReissuePermit {
  const expectedArtifactSha = exactDigest(
    context.expected_artifact_sha256,
    "externally supplied expected_artifact_sha256",
  );
  if (walmartItemReportReissuePermitArtifactSha256(bytes) !== expectedArtifactSha) {
    fail(
      "EXTERNAL_CUSTODY_ARTIFACT_HASH_MISMATCH",
      "permit artifact bytes differ from the externally supplied owner-custody hash",
    );
  }
  const permit = parseWalmartItemReportReissuePermitBytes(bytes);
  return verifyWalmartItemReportReissuePermit(permit, context);
}
