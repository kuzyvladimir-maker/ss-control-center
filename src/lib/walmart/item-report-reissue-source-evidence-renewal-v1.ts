/**
 * Self-contained freshness renewal for the frozen R4 ITEM-v6 incident
 * evidence. The artifact embeds the exact canonical R4 release and every byte
 * of one independently verified fresh absence probe. It does not authorize a
 * replacement POST; external Ed25519 owner disposition remains mandatory.
 */

import { createHash } from "node:crypto";

import {
  WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES,
  WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT,
  WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY,
  verifyWalmartItemV6AbsenceProbeEvidenceFamily,
  type VerifiedWalmartItemV6AbsenceProbeEvidenceFamily,
  type WalmartItemV6AbsenceProbeEvidenceArtifact,
} from "./item-report-reissue-absence-probe-evidence.ts";
import {
  parseWalmartItemReportReissueSourceEvidenceV2Bytes,
  type WalmartItemReportReissueSourceEvidenceV2,
} from "./item-report-reissue-source-evidence-v2.ts";
import {
  canonicalWalmartItemReportJson,
  walmartItemReportSha256,
} from "./item-report-published-source.ts";

export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA =
  "walmart-item-report-reissue-source-evidence-renewal/v1" as const;
export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_POLICY =
  "walmart-item-v6-incident-evidence-renewal/1.0.0" as const;
export const WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_BASELINE_SHA256 =
  "3efd693468f9c0761d6091d379c06e2daddb7d8dadc908228eb282ddeab4fa31";

type JsonRecord = Record<string, unknown>;

export interface WalmartItemReportReissueSourceEvidenceRenewalV1Artifact {
  path: string;
  byte_length: number;
  sha256: string;
  bytes_base64: string;
}

export interface WalmartItemReportReissueSourceEvidenceRenewalV1Baseline {
  schema_version: "walmart-item-report-reissue-source-evidence/v2";
  artifact_sha256: string;
  release_id: string;
  release_sha256: string;
  body_sha256: string;
  canonical_bytes_base64: string;
}

export interface WalmartItemReportReissueSourceEvidenceRenewalV1FreshProbe {
  probe_id: string;
  account_scope: VerifiedWalmartItemV6AbsenceProbeEvidenceFamily["account_scope"];
  query: typeof WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY;
  created_at: string;
  reserved_at: string;
  observed_at: string;
  completed_at: string;
  fresh_until: string;
  request_correlation_id_sha256: string;
  walmart_x_request_id: string | null;
  raw_response_sha256: string;
  raw_response_byte_length: number;
  artifact_inventory: WalmartItemReportReissueSourceEvidenceRenewalV1Artifact[];
  evidence_family_sha256: string;
  result_artifact_sha256: string;
  outcome: "ABSENCE_ONLY";
  exact_query_absence_verified: true;
  http_calls: VerifiedWalmartItemV6AbsenceProbeEvidenceFamily["http_calls"];
}

export interface WalmartItemReportReissueSourceEvidenceRenewalV1Body extends JsonRecord {
  release_id: string;
  reviewed_at: string;
  policy: JsonRecord;
  baseline: WalmartItemReportReissueSourceEvidenceRenewalV1Baseline;
  fresh_probe: WalmartItemReportReissueSourceEvidenceRenewalV1FreshProbe;
  disposition_basis: JsonRecord;
}

export interface WalmartItemReportReissueSourceEvidenceRenewalV1 {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA;
  body: WalmartItemReportReissueSourceEvidenceRenewalV1Body;
  body_sha256: string;
  release_sha256: string;
}

export class WalmartItemReportReissueSourceEvidenceRenewalV1Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissueSourceEvidenceRenewalV1Error";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissueSourceEvidenceRenewalV1Error(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_RENEWAL", `${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_RENEWAL", `${label} has missing or extra fields`);
  }
}

function exactString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_RENEWAL", `${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = exactString(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed)
    || parsed.includes("//") || parsed.endsWith("/")) {
    fail("INVALID_RENEWAL", `${label} is not a safe identifier`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail("INVALID_RENEWAL", `${label} is not a lowercase SHA-256`);
  }
  return parsed;
}

function strictInstant(value: unknown, label: string): string {
  const parsed = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(Date.parse(parsed)).toISOString() !== parsed) {
    fail("INVALID_RENEWAL", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function exactBase64(value: unknown, label: string, maximum = 8 * 1024 * 1024): Buffer {
  const parsed = exactString(value, label, maximum);
  if (/\s/u.test(parsed)) fail("INVALID_RENEWAL", `${label} contains whitespace`);
  const bytes = Buffer.from(parsed, "base64");
  if (bytes.byteLength < 1 || bytes.toString("base64") !== parsed) {
    fail("INVALID_RENEWAL", `${label} is not canonical base64`);
  }
  return bytes;
}

function releasePreimage(body: JsonRecord, bodySha256: string): JsonRecord {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
    body,
    body_sha256: bodySha256,
  };
}

function fixedPolicy(): JsonRecord {
  return {
    policy_id: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_POLICY,
    baseline_r4_exact_bytes_required: true,
    fresh_probe_exact_bytes_embedded: true,
    fresh_probe_maximum_age_ms: 24 * 60 * 60 * 1000,
    exact_zero_result_required: true,
    quarantined_session_mutation_allowed: false,
    authorizes_replacement_post: false,
  };
}

function fixedDispositionBasis(): JsonRecord {
  return {
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    baseline_incident_evidence_retained: true,
    baseline_terminal_failure_supersedable: false,
    fresh_independent_exact_absence_observed: true,
    fresh_probe_account_machine_bound_to_active_credentials: true,
    original_create_success_proven: false,
    original_create_failure_proven: false,
    original_request_id_adoption_allowed: false,
    original_session_reinterpretation_allowed: false,
    duplicate_replacement_request_risk: "NON_ZERO",
    external_owner_ed25519_disposition_required: true,
    separate_one_shot_execution_ledger_required: true,
  };
}

function baselineFromBytes(
  bytes: Uint8Array,
): {
  binding: WalmartItemReportReissueSourceEvidenceRenewalV1Baseline;
  release: WalmartItemReportReissueSourceEvidenceV2;
} {
  const artifactSha = sha256(bytes);
  if (artifactSha !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_BASELINE_SHA256) {
    fail("BASELINE_HASH_MISMATCH", "baseline source evidence is not the frozen R4 artifact");
  }
  const release = parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes);
  const canonical = Buffer.from(canonicalWalmartItemReportJson(release), "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    fail("BASELINE_HASH_MISMATCH", "baseline source evidence bytes are not canonical R4");
  }
  return {
    binding: {
      schema_version: "walmart-item-report-reissue-source-evidence/v2",
      artifact_sha256: artifactSha,
      release_id: String(release.body.release_id),
      release_sha256: release.release_sha256,
      body_sha256: release.body_sha256,
      canonical_bytes_base64: canonical.toString("base64"),
    },
    release,
  };
}

function embeddedProbeArtifacts(
  raw: Readonly<Record<string, Uint8Array>>,
): WalmartItemReportReissueSourceEvidenceRenewalV1Artifact[] {
  return WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES.map((name) => {
    const bytes = raw[name];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
      fail("INVALID_RENEWAL", `fresh probe artifact is missing: ${name}`);
    }
    return {
      path: name,
      byte_length: bytes.byteLength,
      sha256: sha256(bytes),
      bytes_base64: Buffer.from(bytes).toString("base64"),
    };
  });
}

function freshProbeBinding(
  verified: VerifiedWalmartItemV6AbsenceProbeEvidenceFamily,
  raw: Readonly<Record<string, Uint8Array>>,
): WalmartItemReportReissueSourceEvidenceRenewalV1FreshProbe {
  return {
    probe_id: verified.probe_id,
    account_scope: verified.account_scope,
    query: verified.query,
    created_at: verified.created_at,
    reserved_at: verified.reserved_at,
    observed_at: verified.observed_at,
    completed_at: verified.completed_at,
    fresh_until: verified.fresh_until,
    request_correlation_id_sha256: verified.request_correlation_id_sha256,
    walmart_x_request_id: verified.walmart_x_request_id,
    raw_response_sha256: verified.raw_response_sha256,
    raw_response_byte_length: verified.raw_response_byte_length,
    artifact_inventory: embeddedProbeArtifacts(raw),
    evidence_family_sha256: verified.evidence_family_sha256,
    result_artifact_sha256: verified.result_artifact_sha256,
    outcome: "ABSENCE_ONLY",
    exact_query_absence_verified: true,
    http_calls: verified.http_calls,
  };
}

export function buildWalmartItemReportReissueSourceEvidenceRenewalV1(input: {
  release_id: string;
  reviewed_at: string;
  baseline_source_evidence_bytes: Uint8Array;
  fresh_probe_artifacts: Readonly<Record<string, Uint8Array>>;
  expected_probe_id?: string;
  expected_account_fingerprint_for_test?: string;
}): WalmartItemReportReissueSourceEvidenceRenewalV1 {
  const baseline = baselineFromBytes(input.baseline_source_evidence_bytes);
  const fresh = verifyWalmartItemV6AbsenceProbeEvidenceFamily({
    artifacts: input.fresh_probe_artifacts,
    expected_probe_id: input.expected_probe_id,
    expected_account_fingerprint_for_test: input.expected_account_fingerprint_for_test,
  });
  const reviewedAt = strictInstant(input.reviewed_at, "reviewed_at");
  if (Date.parse(reviewedAt) < Date.parse(fresh.observed_at)
    || Date.parse(reviewedAt) >= Date.parse(fresh.fresh_until)) {
    fail("STALE_RENEWAL", "reviewed_at is outside the fresh probe window");
  }
  const body: WalmartItemReportReissueSourceEvidenceRenewalV1Body = {
    release_id: identifier(input.release_id, "release_id"),
    reviewed_at: reviewedAt,
    policy: fixedPolicy(),
    baseline: baseline.binding,
    fresh_probe: freshProbeBinding(fresh, input.fresh_probe_artifacts),
    disposition_basis: fixedDispositionBasis(),
  };
  const bodySha256 = walmartItemReportSha256(body);
  const releaseSha256 = walmartItemReportSha256(releasePreimage(body, bodySha256));
  return verifyWalmartItemReportReissueSourceEvidenceRenewalV1({
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
    body,
    body_sha256: bodySha256,
    release_sha256: releaseSha256,
  });
}

function parseBaseline(value: unknown): {
  binding: WalmartItemReportReissueSourceEvidenceRenewalV1Baseline;
  release: WalmartItemReportReissueSourceEvidenceV2;
} {
  const raw = record(value, "renewal baseline");
  exactKeys(raw, [
    "artifact_sha256", "body_sha256", "canonical_bytes_base64", "release_id",
    "release_sha256", "schema_version",
  ], "renewal baseline");
  if (raw.schema_version !== "walmart-item-report-reissue-source-evidence/v2") {
    fail("INVALID_RENEWAL", "renewal baseline schema is invalid");
  }
  const bytes = exactBase64(raw.canonical_bytes_base64, "baseline canonical bytes");
  const parsed = baselineFromBytes(bytes);
  if (!sameCanonical(raw, parsed.binding)) {
    fail("BASELINE_HASH_MISMATCH", "renewal baseline binding differs from exact R4 bytes");
  }
  return parsed;
}

function decodeProbeArtifacts(value: unknown): Record<string, Uint8Array> {
  if (!Array.isArray(value)
    || value.length !== WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES.length) {
    fail("INVALID_RENEWAL", "renewal fresh probe inventory is incomplete");
  }
  const output: Record<string, Uint8Array> = {};
  for (const [index, item] of value.entries()) {
    const raw = record(item, `fresh probe artifact ${index}`);
    exactKeys(raw, ["byte_length", "bytes_base64", "path", "sha256"], `fresh probe artifact ${index}`);
    const expectedPath = WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES[index];
    if (raw.path !== expectedPath || !Number.isSafeInteger(raw.byte_length)
      || Number(raw.byte_length) < 1) {
      fail("INVALID_RENEWAL", "fresh probe artifact order/path/length is invalid");
    }
    const bytes = exactBase64(raw.bytes_base64, `fresh probe artifact ${index} bytes`);
    const artifactSha = digest(raw.sha256, `fresh probe artifact ${index} SHA-256`);
    if (bytes.byteLength !== raw.byte_length || sha256(bytes) !== artifactSha) {
      fail("PROBE_HASH_MISMATCH", "fresh probe embedded artifact bytes differ");
    }
    output[expectedPath] = Uint8Array.from(bytes);
  }
  return output;
}

function parseFreshProbe(
  value: unknown,
): WalmartItemReportReissueSourceEvidenceRenewalV1FreshProbe {
  const raw = record(value, "renewal fresh_probe");
  exactKeys(raw, [
    "account_scope", "artifact_inventory", "completed_at", "created_at",
    "evidence_family_sha256", "exact_query_absence_verified", "fresh_until",
    "http_calls", "observed_at", "outcome", "probe_id", "query",
    "raw_response_byte_length", "raw_response_sha256", "request_correlation_id_sha256",
    "reserved_at", "result_artifact_sha256", "walmart_x_request_id",
  ], "renewal fresh_probe");
  const artifacts = decodeProbeArtifacts(raw.artifact_inventory);
  const verified = verifyWalmartItemV6AbsenceProbeEvidenceFamily({
    artifacts,
    expected_probe_id: identifier(raw.probe_id, "fresh_probe.probe_id"),
  });
  const expected = freshProbeBinding(verified, artifacts);
  if (!sameCanonical(raw, expected)) {
    fail("PROBE_HASH_MISMATCH", "renewal fresh_probe differs from embedded exact bytes");
  }
  return expected;
}

function parseBody(value: unknown): WalmartItemReportReissueSourceEvidenceRenewalV1Body {
  const raw = record(value, "renewal body");
  exactKeys(raw, [
    "baseline", "disposition_basis", "fresh_probe", "policy", "release_id",
    "reviewed_at",
  ], "renewal body");
  const releaseId = identifier(raw.release_id, "release_id");
  const reviewedAt = strictInstant(raw.reviewed_at, "reviewed_at");
  const baseline = parseBaseline(raw.baseline);
  const fresh = parseFreshProbe(raw.fresh_probe);
  if (!sameCanonical(raw.policy, fixedPolicy())) {
    fail("INVALID_RENEWAL", "renewal policy differs from the fixed contract");
  }
  if (!sameCanonical(raw.disposition_basis, fixedDispositionBasis())) {
    fail("INVALID_RENEWAL", "renewal disposition basis differs from the fixed contract");
  }
  if (fresh.account_scope.seller_account_fingerprint_sha256
      !== WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT
    || !sameCanonical(fresh.query, WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY)) {
    fail("ACCOUNT_SCOPE_MISMATCH", "renewal fresh probe account/query is invalid");
  }
  if (Date.parse(reviewedAt) < Date.parse(fresh.observed_at)
    || Date.parse(reviewedAt) >= Date.parse(fresh.fresh_until)) {
    fail("STALE_RENEWAL", "renewal reviewed_at is outside the fresh probe window");
  }
  return {
    release_id: releaseId,
    reviewed_at: reviewedAt,
    policy: fixedPolicy(),
    baseline: baseline.binding,
    fresh_probe: fresh,
    disposition_basis: fixedDispositionBasis(),
  };
}

export function verifyWalmartItemReportReissueSourceEvidenceRenewalV1(
  value: unknown,
): WalmartItemReportReissueSourceEvidenceRenewalV1 {
  const raw = record(value, "renewal release");
  exactKeys(raw, ["body", "body_sha256", "release_sha256", "schema_version"], "renewal release");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA) {
    fail("INVALID_RENEWAL", "renewal release schema is invalid");
  }
  const body = parseBody(raw.body);
  const bodySha256 = digest(raw.body_sha256, "body_sha256");
  const releaseSha256 = digest(raw.release_sha256, "release_sha256");
  if (bodySha256 !== walmartItemReportSha256(body)
    || releaseSha256 !== walmartItemReportSha256(releasePreimage(body, bodySha256))) {
    fail("RENEWAL_HASH_MISMATCH", "renewal release hash binding is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
    body,
    body_sha256: bodySha256,
    release_sha256: releaseSha256,
  };
}

export function parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes(
  bytes: Uint8Array,
): WalmartItemReportReissueSourceEvidenceRenewalV1 {
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("INVALID_RENEWAL", "renewal release bytes are not UTF-8 JSON");
  }
  const parsed = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(value);
  if (text !== canonicalWalmartItemReportJson(parsed)) {
    fail("NON_CANONICAL_RENEWAL", "renewal release bytes are not canonical JSON");
  }
  return parsed;
}

export function serializeWalmartItemReportReissueSourceEvidenceRenewalV1(
  release: WalmartItemReportReissueSourceEvidenceRenewalV1,
): Uint8Array {
  return Buffer.from(
    canonicalWalmartItemReportJson(
      verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release),
    ),
    "utf8",
  );
}

export function walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease(
  release: WalmartItemReportReissueSourceEvidenceRenewalV1,
): WalmartItemReportReissueSourceEvidenceV2 {
  const verified = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release);
  return parseWalmartItemReportReissueSourceEvidenceV2Bytes(
    Buffer.from(verified.body.baseline.canonical_bytes_base64, "base64"),
  );
}

export function walmartItemReportReissueSourceEvidenceRenewalV1FreshProbeArtifacts(
  release: WalmartItemReportReissueSourceEvidenceRenewalV1,
): Readonly<Record<string, Uint8Array>> {
  const verified = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release);
  return decodeProbeArtifacts(verified.body.fresh_probe.artifact_inventory);
}

export function walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory(
  release: WalmartItemReportReissueSourceEvidenceRenewalV1,
): readonly WalmartItemV6AbsenceProbeEvidenceArtifact[] {
  const verified = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release);
  return verified.body.fresh_probe.artifact_inventory.map((entry) => ({
    path: entry.path,
    byte_length: entry.byte_length,
    sha256: entry.sha256,
  }));
}
