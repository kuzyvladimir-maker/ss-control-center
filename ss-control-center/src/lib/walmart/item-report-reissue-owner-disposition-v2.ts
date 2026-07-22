/**
 * Pure Ed25519 owner-disposition contract for one Walmart ITEM v6 replacement
 * request after the 2026-07-19 ambiguous-create incident.
 *
 * Production deliberately fails closed until a dedicated owner public key is
 * enrolled in PINNED_OWNER_KEYS.  Private-key generation/signing is outside
 * this repository and outside the Claude operator runtime.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import {
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  walmartItemReportSha256,
} from "./item-report-published-source.ts";
import {
  parseWalmartItemReportReissueSessionAuthority,
  type WalmartItemReportReissueSessionAuthority,
} from "./item-report-reissue-permit.ts";
import {
  WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES,
  WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES,
  parseWalmartItemReportReissueSourceEvidenceV2Bytes,
  type WalmartItemReportReissueSourceEvidenceV2,
} from "./item-report-reissue-source-evidence-v2.ts";
import {
  WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
  parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes,
  walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease,
  walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory,
  type WalmartItemReportReissueSourceEvidenceRenewalV1,
} from "./item-report-reissue-source-evidence-renewal-v1.ts";
import {
  WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES,
} from "./item-report-reissue-absence-probe-evidence.ts";

export const WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA =
  "walmart-item-report-reissue-owner-disposition/v2" as const;
export const WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM =
  "Ed25519" as const;
export const WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION =
  "WALMART_ITEM_V6_REPORT_CREATE_REISSUE" as const;
export const WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_MAX_TTL_MS =
  30 * 60 * 1000;
export const WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_CLOCK_SKEW_MS =
  5 * 60 * 1000;

const SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION\0v2\0",
  "utf8",
);
const EMPTY_BODY_SHA256 = createHash("sha256").update("{}", "utf8").digest("hex");

type JsonRecord = Record<string, unknown>;
export type WalmartItemReportReissueOwnerDispositionV2Environment =
  | "PRODUCTION"
  | "TEST_FIXTURE_ONLY";

export interface WalmartItemReportReissueOwnerDispositionV2TrustedKey {
  key_id: string;
  public_key_spki_der_base64: string;
  public_key_spki_sha256: string;
  status: "ACTIVE" | "REVOKED";
  environment: WalmartItemReportReissueOwnerDispositionV2Environment;
}

/**
 * Dedicated trust root only.  Never add worker, Listing Integrity family, or
 * Walmart new-SKU keys here.  Enrollment is a reviewed owner action.
 */
const PINNED_OWNER_KEYS: readonly WalmartItemReportReissueOwnerDispositionV2TrustedKey[] =
  Object.freeze([]);

export interface WalmartItemReportReissueReplacementPlanV2 {
  session_name: string;
  session_authority: WalmartItemReportReissueSessionAuthority;
  session_authority_sha256: string;
  create_request_manifest: ReturnType<typeof buildWalmartItemReportV6CreateRequestManifest>;
  create_request_manifest_sha256: string;
  create_request_correlation_id_sha256: string;
}

export interface WalmartItemReportReissueConsumptionLedgerBindingV2 {
  policy_id: "walmart-item-report-reissue-consumption-ledger/1.0.0";
  ledger_id: string;
  ledger_epoch: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
  identity_artifact_sha256: string;
  reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1";
  trusted_single_custody_host_only: true;
  distributed_at_most_once_claimed: false;
}

export interface WalmartItemReportReissueSourceArtifactBindingV2 {
  path: string;
  byte_length: number;
  sha256: string;
}

export interface WalmartItemReportReissueSourceEvidenceBindingV2 extends JsonRecord {
  artifact_sha256: string;
  release_sha256: string;
  body_sha256: string;
  release_id: string;
  verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW";
  exact_probe_observed_at: string;
  exact_probe_fresh_until: string;
  exact_probe_artifacts: WalmartItemReportReissueSourceArtifactBindingV2[];
  broad_probe_artifacts: WalmartItemReportReissueSourceArtifactBindingV2[];
  original_four: {
    session_authority_sha256: string;
    create_manifest_sha256: string;
    request_reserved_sha256: string;
    manual_review_sha256: string;
  };
  terminal_failure_sha256: string;
  prohibited_conflicting_page_complete_sha256: string;
  prohibited_conflicting_result_sha256: string;
  prohibited_conflicting_complete_sha256: string;
  quarantined_inventory_sha256: string;
}

export interface WalmartItemReportReissuePriorIncidentBindingV2 extends JsonRecord {
  session_name: string;
  session_id: string;
  terminal_failure_retained: true;
  terminal_failure_supersedable: false;
  original_request_complete_written: false;
  original_create_response_retained: false;
  request_id_adopted: false;
  retry_allowed: false;
  consume_conflicting_final: false;
}

export interface WalmartItemReportReissueOwnerDispositionV2SignedBody extends JsonRecord {
  disposition_id: string;
  action: typeof WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION;
  environment: WalmartItemReportReissueOwnerDispositionV2Environment;
  approved_by: string;
  decision_ref: string;
  engine_release_sha256: string;
  source_evidence: WalmartItemReportReissueSourceEvidenceBindingV2;
  account_scope: JsonRecord;
  prior_incident: WalmartItemReportReissuePriorIncidentBindingV2;
  replacement: WalmartItemReportReissueReplacementPlanV2;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
  issued_at: string;
  expires_at: string;
  evidence_fresh_until: string;
  authorization: JsonRecord;
  owner_risk_acknowledgement: JsonRecord;
}

export interface WalmartItemReportReissueOwnerDispositionV2SigningEnvelope {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA;
  algorithm: typeof WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM;
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: WalmartItemReportReissueOwnerDispositionV2SignedBody;
}

export interface WalmartItemReportReissueOwnerDispositionV2
  extends WalmartItemReportReissueOwnerDispositionV2SigningEnvelope {
  signature_base64: string;
  signature_sha256: string;
  authorization_sha256: string;
}

export interface WalmartItemReportReissueOwnerDispositionV2SigningRequest
  extends WalmartItemReportReissueOwnerDispositionV2SigningEnvelope {
  signing_message_base64: string;
  signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64";
  signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE";
  authorization_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE";
}

export class WalmartItemReportReissueOwnerDispositionV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissueOwnerDispositionV2Error";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissueOwnerDispositionV2Error(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_DISPOSITION", `${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_DISPOSITION", `${label} has missing or extra fields`);
  }
}

function exactString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_DISPOSITION", `${label} is invalid`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const parsed = exactString(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed)
    || parsed.includes("//") || parsed.endsWith("/")) {
    fail("INVALID_DISPOSITION", `${label} is not a safe identifier`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail("INVALID_DISPOSITION", `${label} must be a lowercase SHA-256 digest`);
  }
  return parsed;
}

function strictInstant(value: unknown, label: string): string {
  const instant = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)
    || !Number.isFinite(Date.parse(instant))
    || new Date(Date.parse(instant)).toISOString() !== instant) {
    fail("INVALID_DISPOSITION", `${label} must be canonical UTC milliseconds`);
  }
  return instant;
}

function decisionReference(value: unknown): string {
  const reference = exactString(value, "decision_ref", 2048);
  let parsed: URL;
  try {
    parsed = new URL(reference);
  } catch {
    fail("INVALID_DISPOSITION", "decision_ref must be an absolute external reference");
  }
  if (!new Set(["https:", "urn:"]).has(parsed.protocol)) {
    fail("INVALID_DISPOSITION", "decision_ref protocol is not approved");
  }
  return reference;
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: unknown, label: string, maximum = 16_384): {
  value: string;
  bytes: Buffer;
} {
  const parsed = exactString(value, label, maximum);
  if (/\s/u.test(parsed)) fail("INVALID_DISPOSITION", `${label} contains whitespace`);
  const bytes = Buffer.from(parsed, "base64");
  if (bytes.byteLength < 1 || bytes.toString("base64") !== parsed) {
    fail("INVALID_DISPOSITION", `${label} must be canonical base64`);
  }
  return { value: parsed, bytes };
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function validateTrustedKey(
  key: WalmartItemReportReissueOwnerDispositionV2TrustedKey,
): void {
  safeIdentifier(key.key_id, "owner key_id");
  const encoded = canonicalBase64(key.public_key_spki_der_base64, "owner public key");
  if (digest(key.public_key_spki_sha256, "owner public-key fingerprint")
      !== sha256Bytes(encoded.bytes)) {
    fail("INVALID_TRUST_ROOT", "owner public-key fingerprint mismatch");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: encoded.bytes, format: "der", type: "spki" });
  } catch {
    fail("INVALID_TRUST_ROOT", "owner public key is not SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("INVALID_TRUST_ROOT", "owner public key must be Ed25519");
  }
  if (!new Set(["ACTIVE", "REVOKED"]).has(key.status)
    || !new Set(["PRODUCTION", "TEST_FIXTURE_ONLY"]).has(key.environment)) {
    fail("INVALID_TRUST_ROOT", "owner trust-root status/environment is invalid");
  }
}

function testFixtureKey(
  env: NodeJS.ProcessEnv,
): WalmartItemReportReissueOwnerDispositionV2TrustedKey | null {
  if (env.NODE_ENV !== "test" || env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_MODE !== "1") {
    return null;
  }
  const keyId = env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID;
  const publicKey = env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64;
  if (!keyId || !publicKey) return null;
  const bytes = Buffer.from(publicKey, "base64");
  return {
    key_id: keyId,
    public_key_spki_der_base64: publicKey,
    public_key_spki_sha256: sha256Bytes(bytes),
    status: "ACTIVE",
    environment: "TEST_FIXTURE_ONLY",
  };
}

export function walmartItemReportReissueOwnerDispositionV2TrustedKeys(
  env: NodeJS.ProcessEnv = process.env,
): readonly WalmartItemReportReissueOwnerDispositionV2TrustedKey[] {
  const fixture = testFixtureKey(env);
  const keys = fixture ? [...PINNED_OWNER_KEYS, fixture] : [...PINNED_OWNER_KEYS];
  const ids = new Set<string>();
  for (const key of keys) {
    validateTrustedKey(key);
    if (ids.has(key.key_id)) fail("INVALID_TRUST_ROOT", "duplicate owner key_id");
    ids.add(key.key_id);
  }
  return Object.freeze(keys);
}

export function inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot(
  env: NodeJS.ProcessEnv = process.env,
  environment: WalmartItemReportReissueOwnerDispositionV2Environment = "PRODUCTION",
): { ready: boolean; active_key_ids: string[]; active_key_fingerprints: string[] } {
  const active = walmartItemReportReissueOwnerDispositionV2TrustedKeys(env)
    .filter((key) => key.status === "ACTIVE" && key.environment === environment);
  return {
    ready: active.length > 0,
    active_key_ids: active.map((key) => key.key_id).sort(),
    active_key_fingerprints: active.map((key) => key.public_key_spki_sha256).sort(),
  };
}

function resolveTrustedKey(
  keyId: string,
  environment: WalmartItemReportReissueOwnerDispositionV2Environment,
  env: NodeJS.ProcessEnv,
): WalmartItemReportReissueOwnerDispositionV2TrustedKey {
  const key = walmartItemReportReissueOwnerDispositionV2TrustedKeys(env)
    .find((candidate) => candidate.key_id === keyId);
  if (!key || key.status !== "ACTIVE" || key.environment !== environment) {
    fail("OWNER_KEY_UNTRUSTED_OR_REVOKED", "owner disposition key is not active in this domain");
  }
  return key;
}

function parseLedgerBinding(
  value: unknown,
): WalmartItemReportReissueConsumptionLedgerBindingV2 {
  const raw = record(value, "consumption_ledger");
  exactKeys(raw, [
    "directory_identity_sha256", "distributed_at_most_once_claimed",
    "identity_artifact_sha256", "ledger_epoch", "ledger_id", "policy_id",
    "reservation_filename_policy", "state_directory_path_sha256",
    "trusted_single_custody_host_only",
  ], "consumption_ledger");
  if (raw.policy_id !== "walmart-item-report-reissue-consumption-ledger/1.0.0"
    || raw.reservation_filename_policy !== "authorization-sha256.json/exclusive-create/v1"
    || raw.trusted_single_custody_host_only !== true
    || raw.distributed_at_most_once_claimed !== false) {
    fail("INVALID_DISPOSITION", "consumption ledger safety policy is invalid");
  }
  return {
    policy_id: "walmart-item-report-reissue-consumption-ledger/1.0.0",
    ledger_id: safeIdentifier(raw.ledger_id, "consumption_ledger.ledger_id"),
    ledger_epoch: safeIdentifier(raw.ledger_epoch, "consumption_ledger.ledger_epoch"),
    state_directory_path_sha256: digest(
      raw.state_directory_path_sha256,
      "consumption_ledger.state_directory_path_sha256",
    ),
    directory_identity_sha256: digest(
      raw.directory_identity_sha256,
      "consumption_ledger.directory_identity_sha256",
    ),
    identity_artifact_sha256: digest(
      raw.identity_artifact_sha256,
      "consumption_ledger.identity_artifact_sha256",
    ),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

function fixedAuthorization(): JsonRecord {
  return {
    report_create_post_authorized: true,
    maximum_create_post_calls: 1,
    maximum_oauth_token_calls: 1,
    maximum_walmart_report_api_calls: 1,
    maximum_total_http_calls: 2,
    maximum_request_timeout_ms: 60_000,
    retry_attempts_allowed: 0,
    fallbacks_allowed: 0,
    redirects_followed_allowed: 0,
    automatic_replay_allowed: false,
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    report_type: "ITEM",
    report_version: "v6",
    request_body_sha256: EMPTY_BODY_SHA256,
    request_id_adoption_from_prior: false,
    original_session_writes_allowed: 0,
    database_calls_allowed: 0,
    model_calls_allowed: 0,
    paid_provider_calls_allowed: 0,
    listing_content_writes_allowed: 0,
    scheduled_execution_allowed: false,
  };
}

function fixedRiskAcknowledgement(): JsonRecord {
  return {
    exact_probe_observed_no_api_visible_v6_request: true,
    exact_probe_does_not_prove_original_post_failed: true,
    original_post_may_have_reached_walmart: true,
    duplicate_report_request_risk_is_non_zero: true,
    duplicate_report_request_risk_accepted: true,
    exact_probe_account_match_is_operator_asserted_not_machine_verified: true,
    operator_custody_metadata_is_not_walmart_signature_or_tls_transcript: true,
    broad_probe_is_corroborating_only: true,
    quarantined_terminal_failure_remains_authoritative: true,
    prohibited_conflicting_final_must_not_be_consumed: true,
    original_request_id_must_not_be_adopted: true,
    crash_or_ambiguous_replacement_outcome_burns_authorization: true,
    single_custody_ledger_is_not_distributed_at_most_once: true,
  };
}

export function buildWalmartItemReportReissueReplacementPlanV2(input: {
  session_name: string;
  session_authority: unknown;
}): WalmartItemReportReissueReplacementPlanV2 {
  const authority = parseWalmartItemReportReissueSessionAuthority(input.session_authority);
  const sessionName = safeIdentifier(input.session_name, "replacement session_name");
  if (sessionName.includes("/") || sessionName.includes("\\")
    || sessionName === "." || sessionName === "..") {
    fail("INVALID_REPLACEMENT", "replacement session_name must be one direct-child name");
  }
  const createManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  return {
    session_name: sessionName,
    session_authority: authority,
    session_authority_sha256: walmartItemReportSha256(authority),
    create_request_manifest: createManifest,
    create_request_manifest_sha256: walmartItemReportSha256(createManifest),
    create_request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  };
}

function parseSourceArtifactInventory(
  value: unknown,
  expected: readonly { path: string; byte_length: number; sha256: string }[],
  label: string,
): WalmartItemReportReissueSourceArtifactBindingV2[] {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail("INVALID_DISPOSITION", `${label} has the wrong artifact count`);
  }
  const parsed = value.map((entry, index) => {
    const raw = record(entry, `${label}[${index}]`);
    exactKeys(raw, ["byte_length", "path", "sha256"], `${label}[${index}]`);
    if (!Number.isSafeInteger(raw.byte_length) || Number(raw.byte_length) < 0) {
      fail("INVALID_DISPOSITION", `${label}[${index}].byte_length is invalid`);
    }
    return {
      path: exactString(raw.path, `${label}[${index}].path`, 512),
      byte_length: Number(raw.byte_length),
      sha256: digest(raw.sha256, `${label}[${index}].sha256`),
    };
  });
  if (!exactJsonEqual(parsed, expected)) {
    fail("INVALID_DISPOSITION", `${label} differs from the incident-bound inventory`);
  }
  return parsed;
}

function parseCurrentExactProbeInventory(
  value: unknown,
): WalmartItemReportReissueSourceArtifactBindingV2[] {
  const legacy = WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES
    .filter((entry) => entry.path.startsWith("exact-v6/"));
  if (Array.isArray(value) && exactJsonEqual(value, legacy)) {
    return parseSourceArtifactInventory(value, legacy, "source_evidence.exact_probe_artifacts");
  }
  if (!Array.isArray(value)
    || value.length !== WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES.length) {
    fail("INVALID_DISPOSITION", "source_evidence exact probe artifact count is invalid");
  }
  return value.map((entry, index) => {
    const raw = record(entry, `source_evidence.exact_probe_artifacts[${index}]`);
    exactKeys(raw, ["byte_length", "path", "sha256"],
      `source_evidence.exact_probe_artifacts[${index}]`);
    if (raw.path !== WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES[index]
      || !Number.isSafeInteger(raw.byte_length) || Number(raw.byte_length) < 1) {
      fail("INVALID_DISPOSITION", "source_evidence renewal probe inventory is invalid");
    }
    return {
      path: String(raw.path),
      byte_length: Number(raw.byte_length),
      sha256: digest(raw.sha256, `source_evidence exact artifact ${index} SHA-256`),
    };
  });
}

function parseSourceEvidenceBinding(
  value: unknown,
): WalmartItemReportReissueSourceEvidenceBindingV2 {
  const raw = record(value, "source_evidence");
  exactKeys(raw, [
    "artifact_sha256", "body_sha256", "broad_probe_artifacts",
    "exact_probe_artifacts", "exact_probe_fresh_until", "exact_probe_observed_at",
    "original_four", "prohibited_conflicting_complete_sha256",
    "prohibited_conflicting_page_complete_sha256",
    "prohibited_conflicting_result_sha256", "quarantined_inventory_sha256",
    "release_id", "release_sha256", "terminal_failure_sha256", "verdict",
  ], "source_evidence");
  if (raw.verdict !== "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW") {
    fail("INVALID_DISPOSITION", "source_evidence verdict is invalid");
  }
  const originalFour = record(raw.original_four, "source_evidence.original_four");
  exactKeys(originalFour, [
    "create_manifest_sha256", "manual_review_sha256", "request_reserved_sha256",
    "session_authority_sha256",
  ], "source_evidence.original_four");
  const expectedBroad =
    WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES
      .filter((entry) => entry.path.startsWith("broad-48h/"));
  const expectedInventorySha = walmartItemReportSha256(
    WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES,
  );
  const inventorySha = digest(
    raw.quarantined_inventory_sha256,
    "source_evidence.quarantined_inventory_sha256",
  );
  if (inventorySha !== expectedInventorySha) {
    fail("INVALID_DISPOSITION", "source_evidence quarantine inventory binding is invalid");
  }
  return {
    artifact_sha256: digest(raw.artifact_sha256, "source_evidence.artifact_sha256"),
    release_sha256: digest(raw.release_sha256, "source_evidence.release_sha256"),
    body_sha256: digest(raw.body_sha256, "source_evidence.body_sha256"),
    release_id: safeIdentifier(raw.release_id, "source_evidence.release_id"),
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    exact_probe_observed_at: strictInstant(
      raw.exact_probe_observed_at,
      "source_evidence.exact_probe_observed_at",
    ),
    exact_probe_fresh_until: strictInstant(
      raw.exact_probe_fresh_until,
      "source_evidence.exact_probe_fresh_until",
    ),
    exact_probe_artifacts: parseCurrentExactProbeInventory(
      raw.exact_probe_artifacts,
    ),
    broad_probe_artifacts: parseSourceArtifactInventory(
      raw.broad_probe_artifacts,
      expectedBroad,
      "source_evidence.broad_probe_artifacts",
    ),
    original_four: {
      session_authority_sha256: digest(
        originalFour.session_authority_sha256,
        "source_evidence.original_four.session_authority_sha256",
      ),
      create_manifest_sha256: digest(
        originalFour.create_manifest_sha256,
        "source_evidence.original_four.create_manifest_sha256",
      ),
      request_reserved_sha256: digest(
        originalFour.request_reserved_sha256,
        "source_evidence.original_four.request_reserved_sha256",
      ),
      manual_review_sha256: digest(
        originalFour.manual_review_sha256,
        "source_evidence.original_four.manual_review_sha256",
      ),
    },
    terminal_failure_sha256: digest(
      raw.terminal_failure_sha256,
      "source_evidence.terminal_failure_sha256",
    ),
    prohibited_conflicting_page_complete_sha256: digest(
      raw.prohibited_conflicting_page_complete_sha256,
      "source_evidence.prohibited_conflicting_page_complete_sha256",
    ),
    prohibited_conflicting_result_sha256: digest(
      raw.prohibited_conflicting_result_sha256,
      "source_evidence.prohibited_conflicting_result_sha256",
    ),
    prohibited_conflicting_complete_sha256: digest(
      raw.prohibited_conflicting_complete_sha256,
      "source_evidence.prohibited_conflicting_complete_sha256",
    ),
    quarantined_inventory_sha256: inventorySha,
  };
}

function parsePriorIncidentBinding(
  value: unknown,
): WalmartItemReportReissuePriorIncidentBindingV2 {
  const raw = record(value, "prior_incident");
  exactKeys(raw, [
    "consume_conflicting_final", "original_create_response_retained",
    "original_request_complete_written", "request_id_adopted", "retry_allowed",
    "session_id", "session_name", "terminal_failure_retained",
    "terminal_failure_supersedable",
  ], "prior_incident");
  if (raw.terminal_failure_retained !== true
    || raw.terminal_failure_supersedable !== false
    || raw.original_request_complete_written !== false
    || raw.original_create_response_retained !== false
    || raw.request_id_adopted !== false
    || raw.retry_allowed !== false
    || raw.consume_conflicting_final !== false) {
    fail("INVALID_DISPOSITION", "prior_incident relaxes the retained terminal failure");
  }
  const sessionName = safeIdentifier(raw.session_name, "prior_incident.session_name");
  if (sessionName.includes("/") || sessionName.includes("\\")
    || sessionName === "." || sessionName === "..") {
    fail("INVALID_DISPOSITION", "prior_incident.session_name must be one direct-child name");
  }
  return {
    session_name: sessionName,
    session_id: safeIdentifier(raw.session_id, "prior_incident.session_id"),
    terminal_failure_retained: true,
    terminal_failure_supersedable: false,
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    consume_conflicting_final: false,
  };
}

interface WalmartItemReportReissueCurrentSourceEvidence {
  release_sha256: string;
  body_sha256: string;
  release_id: string;
  account_scope: JsonRecord;
  original_incident: JsonRecord;
  exact_probe_observed_at: string;
  exact_probe_fresh_until: string;
  exact_probe_artifacts: WalmartItemReportReissueSourceArtifactBindingV2[];
  baseline: WalmartItemReportReissueSourceEvidenceV2;
}

function parseWalmartItemReportReissueCurrentSourceEvidenceBytes(
  bytes: Uint8Array,
): WalmartItemReportReissueCurrentSourceEvidence {
  let schemaVersion: unknown;
  try {
    schemaVersion = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      ?.schema_version;
  } catch {
    fail("INVALID_DISPOSITION", "source evidence bytes are not UTF-8 JSON");
  }
  if (schemaVersion === WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA) {
    const renewal: WalmartItemReportReissueSourceEvidenceRenewalV1 =
      parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes(bytes);
    const baseline = walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease(renewal);
    const fresh = renewal.body.fresh_probe;
    return {
      release_sha256: renewal.release_sha256,
      body_sha256: renewal.body_sha256,
      release_id: safeIdentifier(renewal.body.release_id, "renewal source release_id"),
      account_scope: record(fresh.account_scope, "renewal fresh account_scope"),
      original_incident: record(
        baseline.body.original_ambiguous_post,
        "renewal baseline original incident",
      ),
      exact_probe_observed_at: strictInstant(
        fresh.observed_at,
        "renewal exact probe observed_at",
      ),
      exact_probe_fresh_until: strictInstant(
        fresh.fresh_until,
        "renewal exact probe fresh_until",
      ),
      exact_probe_artifacts:
        walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory(renewal)
          .map((entry) => ({ ...entry })),
      baseline,
    };
  }
  const release = parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes);
  const exact = record(release.body.exact_probe, "source release exact_probe");
  return {
    release_sha256: release.release_sha256,
    body_sha256: release.body_sha256,
    release_id: safeIdentifier(release.body.release_id, "source release release_id"),
    account_scope: record(release.body.account_scope, "source release account_scope"),
    original_incident: record(
      release.body.original_ambiguous_post,
      "source release original incident",
    ),
    exact_probe_observed_at: strictInstant(exact.observed_at, "exact probe observed_at"),
    exact_probe_fresh_until: strictInstant(exact.fresh_until, "exact probe fresh_until"),
    exact_probe_artifacts:
      WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES
        .filter((entry) => entry.path.startsWith("exact-v6/"))
        .map((entry) => ({ ...entry })),
    baseline: release,
  };
}

function sourceEvidenceBinding(
  evidence: WalmartItemReportReissueCurrentSourceEvidence,
  artifactSha256: string,
): WalmartItemReportReissueSourceEvidenceBindingV2 {
  const original = evidence.original_incident;
  return parseSourceEvidenceBinding({
    artifact_sha256: artifactSha256,
    release_sha256: evidence.release_sha256,
    body_sha256: evidence.body_sha256,
    release_id: evidence.release_id,
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    exact_probe_observed_at: evidence.exact_probe_observed_at,
    exact_probe_fresh_until: evidence.exact_probe_fresh_until,
    exact_probe_artifacts: evidence.exact_probe_artifacts,
    broad_probe_artifacts:
      WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES
        .filter((entry) => entry.path.startsWith("broad-48h/"))
        .map((entry) => ({ ...entry })),
    original_four: {
      session_authority_sha256: digest(
        original.session_authority_sha256,
        "original session authority digest",
      ),
      create_manifest_sha256: digest(
        original.create_manifest_sha256,
        "original create manifest digest",
      ),
      request_reserved_sha256: digest(
        original.request_reserved_sha256,
        "original reservation digest",
      ),
      manual_review_sha256: digest(
        original.manual_review_sha256,
        "original manual-review digest",
      ),
    },
    terminal_failure_sha256: digest(
      original.terminal_page_failure_sha256,
      "terminal page failure digest",
    ),
    prohibited_conflicting_page_complete_sha256: digest(
      original.prohibited_conflicting_page_complete_sha256,
      "prohibited page complete digest",
    ),
    prohibited_conflicting_result_sha256: digest(
      original.prohibited_conflicting_result_sha256,
      "prohibited result digest",
    ),
    prohibited_conflicting_complete_sha256: digest(
      original.prohibited_conflicting_complete_sha256,
      "prohibited final checkpoint digest",
    ),
    quarantined_inventory_sha256: walmartItemReportSha256(
      WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES,
    ),
  });
}

function priorIncidentBinding(
  release: WalmartItemReportReissueSourceEvidenceV2,
): WalmartItemReportReissuePriorIncidentBindingV2 {
  const original = record(
    release.body.original_ambiguous_post,
    "source release original_ambiguous_post",
  );
  if (original.terminal_failure_supersedable !== false
    || original.original_request_complete_written !== false
    || original.original_create_response_retained !== false
    || original.request_id_adopted !== false
    || original.retry_allowed !== false
    || original.consume_conflicting_final !== false) {
    fail("INVALID_DISPOSITION", "source evidence does not retain the terminal incident state");
  }
  return parsePriorIncidentBinding({
    session_name: original.session_name,
    session_id: original.session_id,
    terminal_failure_retained: true,
    terminal_failure_supersedable: false,
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    consume_conflicting_final: false,
  });
}

function parseAccountScope(value: unknown): JsonRecord {
  const raw = record(value, "account_scope");
  exactKeys(raw, [
    "channel", "seller_account_fingerprint_sha256", "seller_id", "store_index",
  ], "account_scope");
  if (raw.channel !== "WALMART_US" || raw.store_index !== 1
    || raw.seller_id !== "10001624309") {
    fail("ACCOUNT_SCOPE_MISMATCH", "owner disposition account scope is invalid");
  }
  return {
    channel: "WALMART_US",
    store_index: 1,
    seller_id: "10001624309",
    seller_account_fingerprint_sha256: digest(
      raw.seller_account_fingerprint_sha256,
      "account seller fingerprint",
    ),
  };
}

function parseReplacement(value: unknown): WalmartItemReportReissueReplacementPlanV2 {
  const raw = record(value, "replacement");
  exactKeys(raw, [
    "create_request_correlation_id_sha256", "create_request_manifest",
    "create_request_manifest_sha256", "session_authority",
    "session_authority_sha256", "session_name",
  ], "replacement");
  const expected = buildWalmartItemReportReissueReplacementPlanV2({
    session_name: raw.session_name as string,
    session_authority: raw.session_authority,
  });
  if (!exactJsonEqual(raw, expected)) {
    fail("INVALID_REPLACEMENT", "replacement preimages/hashes are inconsistent");
  }
  return expected;
}

function parseFixed(value: unknown, expected: JsonRecord, label: string): JsonRecord {
  const raw = record(value, label);
  exactKeys(raw, Object.keys(expected), label);
  if (!exactJsonEqual(raw, expected)) {
    fail("INVALID_DISPOSITION", `${label} relaxes the fixed safety contract`);
  }
  return expected;
}

function parseSignedBody(value: unknown): WalmartItemReportReissueOwnerDispositionV2SignedBody {
  const raw = record(value, "signed_body");
  exactKeys(raw, [
    "account_scope", "action", "approved_by", "authorization", "consumption_ledger",
    "decision_ref", "disposition_id", "engine_release_sha256", "environment",
    "evidence_fresh_until", "expires_at", "issued_at", "owner_risk_acknowledgement",
    "prior_incident", "replacement", "source_evidence",
  ], "signed_body");
  if (raw.action !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION
    || !new Set(["PRODUCTION", "TEST_FIXTURE_ONLY"]).has(String(raw.environment))) {
    fail("INVALID_DISPOSITION", "signed body action/environment is invalid");
  }
  const issuedAt = strictInstant(raw.issued_at, "signed_body.issued_at");
  const expiresAt = strictInstant(raw.expires_at, "signed_body.expires_at");
  const evidenceFreshUntil = strictInstant(
    raw.evidence_fresh_until,
    "signed_body.evidence_fresh_until",
  );
  const sourceEvidence = parseSourceEvidenceBinding(raw.source_evidence);
  const priorIncident = parsePriorIncidentBinding(raw.prior_incident);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt)
      > WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_MAX_TTL_MS
    || Date.parse(expiresAt) > Date.parse(evidenceFreshUntil)
    || sourceEvidence.exact_probe_fresh_until !== evidenceFreshUntil
    || Date.parse(sourceEvidence.exact_probe_observed_at) > Date.parse(issuedAt)) {
    fail("INVALID_FRESHNESS", "owner disposition TTL/evidence deadline is invalid");
  }
  const replacement = parseReplacement(raw.replacement);
  const accountScope = parseAccountScope(raw.account_scope);
  if (!exactJsonEqual(accountScope, {
    ...replacement.session_authority.account_scope,
    seller_id: "10001624309",
  })) {
    fail("ACCOUNT_SCOPE_MISMATCH", "replacement SessionAuthority differs from signed account");
  }
  if (Date.parse(replacement.session_authority.created_at) > Date.parse(issuedAt)) {
    fail("INVALID_FRESHNESS", "replacement SessionAuthority was created after owner issuance");
  }
  return {
    disposition_id: safeIdentifier(raw.disposition_id, "disposition_id"),
    action: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION,
    environment: raw.environment as WalmartItemReportReissueOwnerDispositionV2Environment,
    approved_by: exactString(raw.approved_by, "approved_by", 256),
    decision_ref: decisionReference(raw.decision_ref),
    engine_release_sha256: digest(raw.engine_release_sha256, "engine_release_sha256"),
    source_evidence: sourceEvidence,
    account_scope: accountScope,
    prior_incident: priorIncident,
    replacement,
    consumption_ledger: parseLedgerBinding(raw.consumption_ledger),
    issued_at: issuedAt,
    expires_at: expiresAt,
    evidence_fresh_until: evidenceFreshUntil,
    authorization: parseFixed(raw.authorization, fixedAuthorization(), "authorization"),
    owner_risk_acknowledgement: parseFixed(
      raw.owner_risk_acknowledgement,
      fixedRiskAcknowledgement(),
      "owner_risk_acknowledgement",
    ),
  };
}

export function buildWalmartItemReportReissueOwnerDispositionV2Body(input: {
  disposition_id: string;
  environment: WalmartItemReportReissueOwnerDispositionV2Environment;
  approved_by: string;
  decision_ref: string;
  engine_release_sha256: string;
  source_evidence_bytes: Uint8Array;
  expected_source_evidence_artifact_sha256: string;
  replacement: WalmartItemReportReissueReplacementPlanV2;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
  issued_at: string;
  expires_at: string;
}): WalmartItemReportReissueOwnerDispositionV2SignedBody {
  const artifactSha = digest(
    input.expected_source_evidence_artifact_sha256,
    "expected source-evidence artifact SHA-256",
  );
  if (sha256Bytes(input.source_evidence_bytes) !== artifactSha) {
    fail("SOURCE_EVIDENCE_ARTIFACT_HASH_MISMATCH", "source-evidence exact bytes differ");
  }
  const evidence = parseWalmartItemReportReissueCurrentSourceEvidenceBytes(
    input.source_evidence_bytes,
  );
  const sourceBinding = sourceEvidenceBinding(evidence, artifactSha);
  const sourceAccount = evidence.account_scope;
  const original = evidence.original_incident;
  const replacement = parseReplacement(input.replacement);
  const accountScope = parseAccountScope({
    channel: sourceAccount.channel,
    store_index: sourceAccount.store_index,
    seller_id: sourceAccount.seller_id,
    seller_account_fingerprint_sha256: sourceAccount.seller_account_fingerprint_sha256,
  });
  if (!exactJsonEqual(replacement.session_authority.account_scope, {
    channel: accountScope.channel,
    store_index: accountScope.store_index,
    seller_account_fingerprint_sha256: accountScope.seller_account_fingerprint_sha256,
  }) || replacement.session_name === original.session_name
    || replacement.session_authority.session_id === original.session_id
    || replacement.session_authority_sha256 === original.session_authority_sha256
    || replacement.create_request_manifest_sha256 === original.create_manifest_sha256) {
    fail("INVALID_REPLACEMENT", "replacement is not distinct or account-bound");
  }
  const evidenceFreshUntil = evidence.exact_probe_fresh_until;
  const signedBody = {
    disposition_id: input.disposition_id,
    action: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION,
    environment: input.environment,
    approved_by: input.approved_by,
    decision_ref: input.decision_ref,
    engine_release_sha256: input.engine_release_sha256,
    source_evidence: sourceBinding,
    account_scope: accountScope,
    prior_incident: priorIncidentBinding(evidence.baseline),
    replacement,
    consumption_ledger: input.consumption_ledger,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    evidence_fresh_until: evidenceFreshUntil,
    authorization: fixedAuthorization(),
    owner_risk_acknowledgement: fixedRiskAcknowledgement(),
  };
  return parseSignedBody(signedBody);
}

export function walmartItemReportReissueOwnerDispositionV2SigningMessage(
  envelope: WalmartItemReportReissueOwnerDispositionV2SigningEnvelope,
): Buffer {
  return Buffer.concat([
    SIGNING_DOMAIN,
    Buffer.from(canonicalWalmartItemReportJson(envelope), "utf8"),
  ]);
}

export function buildWalmartItemReportReissueOwnerDispositionV2SigningRequest(input: {
  key_id: string;
  signed_body: WalmartItemReportReissueOwnerDispositionV2SignedBody;
  env?: NodeJS.ProcessEnv;
}): WalmartItemReportReissueOwnerDispositionV2SigningRequest {
  const body = parseSignedBody(input.signed_body);
  const key = resolveTrustedKey(input.key_id, body.environment, input.env ?? process.env);
  const envelope: WalmartItemReportReissueOwnerDispositionV2SigningEnvelope = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA,
    algorithm: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: body,
  };
  return {
    ...envelope,
    signing_message_base64:
      walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope).toString("base64"),
    signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
    signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    authorization_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
  };
}

export interface WalmartItemReportReissueOwnerDispositionV2VerificationBindings {
  env?: NodeJS.ProcessEnv;
  expected_environment?: WalmartItemReportReissueOwnerDispositionV2Environment;
  expected_engine_release_sha256: string;
  expected_source_evidence_bytes: Uint8Array;
  expected_source_evidence_artifact_sha256: string;
  expected_replacement: WalmartItemReportReissueReplacementPlanV2;
  expected_consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
  now?: Date;
}

interface ParsedVerificationBindings {
  env: NodeJS.ProcessEnv;
  environment: WalmartItemReportReissueOwnerDispositionV2Environment;
  engine_release_sha256: string;
  source_evidence: WalmartItemReportReissueSourceEvidenceBindingV2;
  source_account_scope: JsonRecord;
  prior_incident: WalmartItemReportReissuePriorIncidentBindingV2;
  original_incident: JsonRecord;
  replacement: WalmartItemReportReissueReplacementPlanV2;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
  now?: Date;
}

function parseVerificationBindings(
  options: WalmartItemReportReissueOwnerDispositionV2VerificationBindings,
): ParsedVerificationBindings {
  if (!isRecord(options)) {
    fail("BINDING_REQUIRED", "production verification bindings are required");
  }
  const missing = [
    "expected_engine_release_sha256",
    "expected_source_evidence_bytes",
    "expected_source_evidence_artifact_sha256",
    "expected_replacement",
    "expected_consumption_ledger",
  ].filter((key) => options[key as keyof typeof options] === undefined);
  if (missing.length > 0) {
    fail(
      "BINDING_REQUIRED",
      `production verification binding is missing: ${missing.join(", ")}`,
    );
  }
  if (!(options.expected_source_evidence_bytes instanceof Uint8Array)
    || options.expected_source_evidence_bytes.byteLength === 0) {
    fail("BINDING_REQUIRED", "expected source-evidence exact bytes are required");
  }
  const artifactSha = digest(
    options.expected_source_evidence_artifact_sha256,
    "expected_source_evidence_artifact_sha256",
  );
  if (sha256Bytes(options.expected_source_evidence_bytes) !== artifactSha) {
    fail("SOURCE_EVIDENCE_ARTIFACT_HASH_MISMATCH", "expected source-evidence bytes differ");
  }
  const evidence = parseWalmartItemReportReissueCurrentSourceEvidenceBytes(
    options.expected_source_evidence_bytes,
  );
  const sourceAccount = evidence.account_scope;
  const accountScope = parseAccountScope({
    channel: sourceAccount.channel,
    store_index: sourceAccount.store_index,
    seller_id: sourceAccount.seller_id,
    seller_account_fingerprint_sha256:
      sourceAccount.seller_account_fingerprint_sha256,
  });
  const environment = options.expected_environment ?? "PRODUCTION";
  if (!new Set(["PRODUCTION", "TEST_FIXTURE_ONLY"]).has(environment)) {
    fail("INVALID_DISPOSITION", "expected environment is invalid");
  }
  return {
    env: options.env ?? process.env,
    environment,
    engine_release_sha256: digest(
      options.expected_engine_release_sha256,
      "expected_engine_release_sha256",
    ),
    source_evidence: sourceEvidenceBinding(evidence, artifactSha),
    source_account_scope: accountScope,
    prior_incident: priorIncidentBinding(evidence.baseline),
    original_incident: evidence.original_incident,
    replacement: parseReplacement(options.expected_replacement),
    consumption_ledger: parseLedgerBinding(options.expected_consumption_ledger),
    now: options.now,
  };
}

function assertReplacementBoundToSourceEvidence(
  replacement: WalmartItemReportReissueReplacementPlanV2,
  accountScope: JsonRecord,
  original: JsonRecord,
): void {
  if (!exactJsonEqual(replacement.session_authority.account_scope, {
    channel: accountScope.channel,
    store_index: accountScope.store_index,
    seller_account_fingerprint_sha256: accountScope.seller_account_fingerprint_sha256,
  }) || replacement.session_name === original.session_name
    || replacement.session_authority.session_id === original.session_id
    || replacement.session_authority_sha256 === original.session_authority_sha256
    || replacement.create_request_manifest_sha256 === original.create_manifest_sha256) {
    fail("BINDING_MISMATCH", "replacement is not distinct from and bound to source evidence");
  }
}

export function verifyWalmartItemReportReissueOwnerDispositionV2(
  value: unknown,
  options: WalmartItemReportReissueOwnerDispositionV2VerificationBindings,
): WalmartItemReportReissueOwnerDispositionV2 {
  const expected = parseVerificationBindings(options);
  const raw = record(value, "owner disposition");
  exactKeys(raw, [
    "algorithm", "authorization_sha256", "key_id", "owner_public_key_spki_sha256",
    "schema_version", "signature_base64", "signature_sha256", "signed_body",
  ], "owner disposition");
  const body = parseSignedBody(raw.signed_body);
  const environment = expected.environment;
  if (body.environment !== environment
    || raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA
    || raw.algorithm !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM) {
    fail("INVALID_DISPOSITION", "owner disposition schema/action domain is invalid");
  }
  const keyId = safeIdentifier(raw.key_id, "owner disposition key_id");
  const key = resolveTrustedKey(keyId, environment, expected.env);
  const ownerFingerprint = digest(
    raw.owner_public_key_spki_sha256,
    "owner_public_key_spki_sha256",
  );
  if (ownerFingerprint !== key.public_key_spki_sha256) {
    fail("OWNER_KEY_UNTRUSTED_OR_REVOKED", "owner disposition fingerprint is not pinned");
  }
  const signature = canonicalBase64(raw.signature_base64, "signature_base64", 256);
  const signatureSha = digest(raw.signature_sha256, "signature_sha256");
  if (signature.bytes.byteLength !== 64 || signatureSha !== sha256Bytes(signature.bytes)) {
    fail("INVALID_SIGNATURE", "owner signature bytes/hash are invalid");
  }
  const envelope: WalmartItemReportReissueOwnerDispositionV2SigningEnvelope = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA,
    algorithm: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: body,
  };
  const publicKey = createPublicKey({
    key: Buffer.from(key.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    null,
    walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope),
    publicKey,
    signature.bytes,
  )) {
    fail("INVALID_SIGNATURE", "owner Ed25519 signature is invalid");
  }
  const unsigned = {
    ...envelope,
    signature_base64: signature.value,
    signature_sha256: signatureSha,
  };
  const authorizationSha = digest(raw.authorization_sha256, "authorization_sha256");
  if (authorizationSha !== sha256Bytes(canonicalWalmartItemReportJson(unsigned))) {
    fail("AUTHORIZATION_HASH_MISMATCH", "owner authorization hash is invalid");
  }
  if (body.engine_release_sha256 !== expected.engine_release_sha256) {
    fail("BINDING_MISMATCH", "owner disposition is bound to a different engine release");
  }
  if (!exactJsonEqual(body.source_evidence, expected.source_evidence)
    || !exactJsonEqual(body.prior_incident, expected.prior_incident)
    || !exactJsonEqual(body.account_scope, expected.source_account_scope)
    || body.evidence_fresh_until !== expected.source_evidence.exact_probe_fresh_until) {
    fail(
      "BINDING_MISMATCH",
      "owner disposition source/prior/account binding differs from exact evidence bytes",
    );
  }
  if (!exactJsonEqual(body.replacement, expected.replacement)) {
    fail("BINDING_MISMATCH", "owner disposition is bound to a different replacement");
  }
  if (!exactJsonEqual(body.consumption_ledger, expected.consumption_ledger)) {
    fail("BINDING_MISMATCH", "owner disposition is bound to a different ledger");
  }
  assertReplacementBoundToSourceEvidence(
    body.replacement,
    expected.source_account_scope,
    expected.original_incident,
  );
  const parsed: WalmartItemReportReissueOwnerDispositionV2 = {
    ...unsigned,
    authorization_sha256: authorizationSha,
  };
  if (expected.now !== undefined) {
    assertWalmartItemReportReissueOwnerDispositionV2Current(parsed, expected.now);
  }
  return parsed;
}

export function assembleWalmartItemReportReissueOwnerDispositionV2(input: {
  signing_request: WalmartItemReportReissueOwnerDispositionV2SigningRequest;
  detached_signature: Uint8Array;
  expected_engine_release_sha256: string;
  expected_source_evidence_bytes: Uint8Array;
  expected_source_evidence_artifact_sha256: string;
  expected_replacement: WalmartItemReportReissueReplacementPlanV2;
  expected_consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): WalmartItemReportReissueOwnerDispositionV2 {
  if (!(input.detached_signature instanceof Uint8Array)
    || input.detached_signature.byteLength !== 64) {
    fail("INVALID_SIGNATURE", "detached Ed25519 signature must contain exactly 64 raw bytes");
  }
  const request = input.signing_request;
  const envelope: WalmartItemReportReissueOwnerDispositionV2SigningEnvelope = {
    schema_version: request.schema_version,
    algorithm: request.algorithm,
    key_id: request.key_id,
    owner_public_key_spki_sha256: request.owner_public_key_spki_sha256,
    signed_body: request.signed_body,
  };
  if (request.signing_message_base64
    !== walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope).toString("base64")) {
    fail("INVALID_SIGNING_REQUEST", "signing request message does not bind its envelope");
  }
  const signatureBase64 = Buffer.from(input.detached_signature).toString("base64");
  const signatureSha256 = sha256Bytes(input.detached_signature);
  const unsigned = { ...envelope, signature_base64: signatureBase64, signature_sha256: signatureSha256 };
  return verifyWalmartItemReportReissueOwnerDispositionV2({
    ...unsigned,
    authorization_sha256: sha256Bytes(canonicalWalmartItemReportJson(unsigned)),
  }, {
    env: input.env,
    expected_environment: request.signed_body.environment,
    expected_engine_release_sha256: input.expected_engine_release_sha256,
    expected_source_evidence_bytes: input.expected_source_evidence_bytes,
    expected_source_evidence_artifact_sha256:
      input.expected_source_evidence_artifact_sha256,
    expected_replacement: input.expected_replacement,
    expected_consumption_ledger: input.expected_consumption_ledger,
    now: input.now,
  });
}

export function assertWalmartItemReportReissueOwnerDispositionV2Current(
  disposition: WalmartItemReportReissueOwnerDispositionV2,
  now: Date = new Date(),
): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("INVALID_CLOCK", "owner disposition clock is invalid");
  }
  const issuedAt = Date.parse(disposition.signed_body.issued_at);
  const effectiveDeadline = Math.min(
    Date.parse(disposition.signed_body.expires_at),
    Date.parse(disposition.signed_body.evidence_fresh_until),
  );
  if (issuedAt > now.getTime() + WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_CLOCK_SKEW_MS
    || now.getTime() < issuedAt - WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_CLOCK_SKEW_MS) {
    fail("AUTHORIZATION_NOT_CURRENT", "owner disposition issuance window has not opened");
  }
  if (now.getTime() >= effectiveDeadline) {
    fail("AUTHORIZATION_EXPIRED", "owner disposition or source evidence has expired");
  }
  return new Date(effectiveDeadline).toISOString();
}

export const WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256 =
  EMPTY_BODY_SHA256;
