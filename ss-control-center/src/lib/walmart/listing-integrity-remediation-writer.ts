/**
 * One-SKU Walmart Listing Integrity repair writer core.
 *
 * This module deliberately owns only the irreversible orchestration boundary:
 * exact signed authority/plan/request binding, durable permit consumption,
 * one MP_MAINTENANCE POST, and bounded GET-only feed reconciliation. It does
 * not read or write application data, call a model/provider, build Product
 * Truth, or touch another listing.
 *
 * The production entrypoint remains fail-closed until the payload builder,
 * consumption ledger, artifact sink, native transport, and exact release are
 * frozen together. Tests use the separately gated injection entrypoints.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  verifyCurrentWalmartListingRepairOneSkuPermit,
  verifyWalmartListingRepairSequenceAuthorization,
  type WalmartListingRepairListingIdentity,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairSequenceAuthorization,
} from "./listing-integrity-remediation-authority.ts";
import { walmartListingIntegritySha256 } from "./listing-integrity-audit.ts";
import type { SealedWalmartListingRepairPlan } from "./listing-integrity-remediation-qualification.ts";

export const WALMART_LISTING_REPAIR_WRITER_POLICY =
  "walmart-listing-repair-one-sku-writer/1.0.0" as const;
export const WALMART_LISTING_REPAIR_SURGICAL_REQUEST_MANIFEST_SCHEMA =
  "walmart-listing-repair-surgical-request-manifest/v1" as const;
export const WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA =
  "walmart-listing-repair-http-receipt/v2" as const;
export const WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES = 1024 * 1024;
export const WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES = 4 * 1024 * 1024;
export const WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES = 64 * 1024 * 1024;
export const WALMART_LISTING_REPAIR_MAX_POLL_ATTEMPTS = 20;
export const WALMART_LISTING_REPAIR_MAX_POLL_DELAY_MS = 60_000;
export const WALMART_LISTING_REPAIR_REQUEST_TIMEOUT_MS = 60_000;

/** Filled only by the final frozen release. Null is an intentional production NO-GO. */
const PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256: string | null =
  "632bb723353b9e8ae28024631158a6ba4bbd1061efc1195e222b77ae838cc8d8";

export function inspectWalmartListingRepairWriterProductionReadiness(): {
  apply_writer_release_pinned: boolean;
  apply_engine_release_sha256: string | null;
  fixed_dependency_factory_ready: true;
  native_one_shot_transport_ready: true;
  caller_dependency_injection_allowed: false;
} {
  return Object.freeze({
    apply_writer_release_pinned: PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256 !== null,
    apply_engine_release_sha256: PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256,
    fixed_dependency_factory_ready: true,
    native_one_shot_transport_ready: true,
    caller_dependency_injection_allowed: false,
  });
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const TERMINAL_FEED_STATES = new Set(["PROCESSED", "ERROR"]);
const SURGICAL_MANIFEST_KEYS = Object.freeze([
  "schema_version", "method", "path", "feed_type", "store_index",
  "seller_account_fingerprint_sha256", "listing", "native_identity", "plan_id",
  "plan_body_sha256", "target_sha256", "target_image_certificate_sha256", "permit_id",
  "apply_engine_release_sha256",
  "schema_contract_body_sha256", "schema_mapping_approval_sha256", "get_spec",
  "transport", "changed_fields", "visible_fields", "full_target_written",
  "request_correlation_id_sha256", "request_payload_sha256", "prepared_at", "body_sha256",
] as const);
const QUALIFICATION_SUPPORT_ARTIFACT_NAMES = Object.freeze([
  "surgical-schema-contract.json",
  "surgical-get-spec-receipt.json",
  "surgical-live-item-receipt.json",
  "surgical-get-spec-request.bin",
  "surgical-get-spec-response.bin",
  "surgical-live-item-response.bin",
  "target-image-certificate.json",
] as const);

type JsonRecord = Record<string, unknown>;

export interface WalmartListingRepairProductTruthBinding {
  expected_sha256: string;
  product_truth_snapshot_id: string;
  product_truth_snapshot_body_sha256: string;
  truth_revision_id: string;
  truth_revision_body_sha256: string;
  truth_approval_sha256: string;
}

/**
 * Output of the separately reviewed exact surgical payload builder.
 * The writer independently hashes and parses both byte strings. A TS object or
 * caller-provided digest is never enough to cross the POST boundary.
 */
export interface BuiltWalmartListingRepairSurgicalRequest {
  payload: JsonRecord;
  payload_json: string;
  payload_bytes: Uint8Array;
  payload_sha256: string;
  request_manifest: JsonRecord;
  request_manifest_json: string;
  request_manifest_bytes: Uint8Array;
  request_manifest_sha256: string;
  qualification_support_artifacts: Readonly<Record<
    typeof QUALIFICATION_SUPPORT_ARTIFACT_NAMES[number],
    Uint8Array
  >>;
  filename?: string;
  validation: {
    valid: true;
    exact_listing_count: 1;
    feed_type: "MP_MAINTENANCE";
    changed_fields: readonly string[];
  };
}

export interface WalmartListingRepairPayloadBuilder {
  build(input: {
    plan: SealedWalmartListingRepairPlan;
    sequence: WalmartListingRepairSequenceAuthorization;
    permit: WalmartListingRepairOneSkuPermit;
    request_correlation_id_sha256: string;
    context: unknown;
  }): Promise<BuiltWalmartListingRepairSurgicalRequest>;
}

/**
 * Synchronous, exact-byte hook for the separately frozen Walmart-native
 * verifier.  Its production implementation is expected to call
 * `verifyWalmartListingSurgicalRequestBytes`; it must perform no I/O.  Keeping
 * this as a required dependency makes the missing frozen production closure
 * explicit without duplicating the Walmart schema engine in this writer.
 */
export interface WalmartListingRepairExactRequestVerifier {
  verifyExactBytes(input: {
    plan: SealedWalmartListingRepairPlan;
    sequence: WalmartListingRepairSequenceAuthorization;
    permit: WalmartListingRepairOneSkuPermit;
    context: unknown;
    request_payload_bytes: Uint8Array;
    request_manifest_bytes: Uint8Array;
    request_payload_sha256: string;
    request_manifest_sha256: string;
  }): void;
}

export interface WalmartListingRepairRequestingReceipt {
  authorization_sha256: string;
  state: "REQUESTING";
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  consumption_ledger: WalmartListingRepairOneSkuPermit["signed_body"]["consumption_ledger"];
}

export interface WalmartListingRepairAcceptedReceipt
  extends Omit<WalmartListingRepairRequestingReceipt, "state"> {
  state: "ACCEPTED";
  accepted_at: string;
  apply_id: string;
  feed_id: string;
  response_http_receipt_sha256: string;
  response_payload_sha256: string;
  exact_listing_count: 1;
  marketplace_write_calls: 1;
}

export interface WalmartListingRepairLedgerTerminalOutcome {
  state: "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
  terminal_at: string;
  apply_id: string;
  error_code: string | null;
  marketplace_write_calls: 0 | 1;
  http_status: number | null;
  feed_id: string | null;
  response_http_receipt_sha256: string | null;
  response_payload_sha256: string | null;
  feed_status_http_receipt_sha256: string | null;
  feed_status_payload_sha256: string | null;
  exact_listing_count: 1;
}

export interface WalmartListingRepairLedgerAdapter {
  /** Atomically/durably reaches REQUESTING. It must not perform network I/O. */
  consume(input: {
    permit: WalmartListingRepairOneSkuPermit;
    claimed_at: string;
    requesting_at: string;
    request_manifest_sha256: string;
    request_payload_sha256: string;
  }): Promise<WalmartListingRepairRequestingReceipt>;
  /** Custody-safe read used by GET-only continuation; it must never reset state. */
  loadRequesting(input: {
    permit: WalmartListingRepairOneSkuPermit;
    request_manifest_sha256: string;
    request_payload_sha256: string;
  }): Promise<WalmartListingRepairRequestingReceipt>;
  /** Durable definite-acceptance fence; from here only exact feed GET is legal. */
  recordAccepted(input: {
    permit: WalmartListingRepairOneSkuPermit;
    requesting: WalmartListingRepairRequestingReceipt;
    accepted_at: string;
    apply_id: string;
    feed_id: string;
    response_http_receipt_sha256: string;
    response_payload_sha256: string;
  }): Promise<WalmartListingRepairAcceptedReceipt>;
  loadAccepted(input: {
    permit: WalmartListingRepairOneSkuPermit;
    request_manifest_sha256: string;
    request_payload_sha256: string;
  }): Promise<WalmartListingRepairAcceptedReceipt>;
  terminalize(input: {
    permit: WalmartListingRepairOneSkuPermit;
    prior: WalmartListingRepairRequestingReceipt | WalmartListingRepairAcceptedReceipt;
    outcome: WalmartListingRepairLedgerTerminalOutcome;
  }): Promise<unknown>;
}

export interface WalmartListingRepairTransportAccountBinding {
  channel: "WALMART_US";
  store_index: number;
  seller_id: string;
  seller_account_fingerprint_sha256: string;
}

export interface WalmartListingRepairTransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface WalmartListingRepairTransportCounts {
  oauth_token_calls: number;
  maintenance_post_calls: number;
  feed_status_get_calls: number;
  total_http_calls: number;
}

export interface WalmartListingRepairOneShotTransport {
  /** Must be derived from the exact credentials that this instance uses for OAuth. */
  getAccountBinding(): WalmartListingRepairTransportAccountBinding;
  getCallCounts(): WalmartListingRepairTransportCounts;
  /** Implementation contract: no redirect, retry, 401 refresh, or second POST. */
  postMaintenance(input: {
    path: "/v3/feeds";
    query: { feedType: "MP_MAINTENANCE" };
    request_payload_bytes: Uint8Array;
    filename: string;
    content_type: "application/json";
    correlation_id: string;
    redirect: "error";
    retries: 0;
    timeout_ms: number;
    max_response_bytes: number;
  }): Promise<WalmartListingRepairTransportResponse>;
  /** Read-only and bound to the exact accepted feedId. Never submits a feed. */
  getFeedStatus(input: {
    path: string;
    query: { includeDetails: "true" };
    feed_id: string;
    correlation_id: string;
    redirect: "error";
    retries: 0;
    timeout_ms: number;
    max_response_bytes: number;
  }): Promise<WalmartListingRepairTransportResponse>;
}

export interface WalmartListingRepairArtifactSink {
  /** Must durably persist exact bytes before resolving; throws on any alias/overwrite/race. */
  persist(stage: "PREPARED_REQUEST" | "POST_RESPONSE" | "FEED_STATUS", artifacts: {
    [name: string]: Uint8Array;
  }): Promise<void>;
  /** Custody-safe exact reread. Resume never trusts caller-returned continuation bytes. */
  loadAccepted(input: {
    permit: WalmartListingRepairOneSkuPermit;
    accepted: WalmartListingRepairAcceptedReceipt;
  }): Promise<{
    request_manifest_bytes: Uint8Array;
    request_payload_bytes: Uint8Array;
    response_http_receipt_bytes: Uint8Array;
    response_payload_bytes: Uint8Array;
  }>;
}

export interface WalmartListingRepairSequenceReadyProof {
  sequence_authorization_sha256: string;
  sequence_id: string;
  sequence_epoch: string;
  verifier_engine_release_sha256: string;
  status: "READY_FOR_ONE_SKU_PLAN";
  next_listing_key: string;
  next_sequence_position: number;
  marketplace_write_authorized: false;
  separate_signed_one_sku_permit_required: true;
}

export interface WalmartListingRepairTargetImageCertificateProof {
  status: "CERTIFIED_EXACT_TARGET_IMAGES";
  certificate_sha256: string;
  plan_body_sha256: string;
  target_sha256: string;
  listing: WalmartListingRepairListingIdentity;
  verified_at: string;
  expires_at: string;
  evidence_only_not_write_authority: true;
}

export interface WalmartListingRepairWriterInput {
  sequence_authorization: unknown;
  one_sku_permit: unknown;
  plan: SealedWalmartListingRepairPlan;
  payload_context: unknown;
  target_image_certificate_context: unknown;
  request_correlation_id: string;
  poll_policy: {
    max_attempts: number;
    delay_ms: number;
  };
}

/**
 * Data-only production boundary. Every executable dependency is selected by
 * the frozen engine itself; callers may provide evidence and custody locations
 * but cannot provide builders, verifiers, clocks, transports, or retry policy.
 */
export interface WalmartListingRepairProductionContext {
  ledger_state_directory: string;
  artifact_custody_root: string;
  sequence_evidence_packages: readonly unknown[];
  product_truth_binding: WalmartListingRepairProductTruthBinding;
}

export interface WalmartListingRepairProductionExecutionInput {
  writer_input: WalmartListingRepairWriterInput;
  production_context: WalmartListingRepairProductionContext;
}

export interface WalmartListingRepairAcceptedPostEvidence {
  feed_id: string;
  request_manifest_bytes: Uint8Array;
  request_payload_bytes: Uint8Array;
  response_http_receipt_bytes: Uint8Array;
  response_payload_bytes: Uint8Array;
  accepted: WalmartListingRepairAcceptedReceipt;
}

export interface WalmartListingRepairWriterResult {
  schema_version: "walmart-listing-repair-writer-result/v1";
  policy_id: typeof WALMART_LISTING_REPAIR_WRITER_POLICY;
  status: "SUCCEEDED" | "FAILED" | "AMBIGUOUS_POST" | "APPLIED_PROPAGATING";
  listing: WalmartListingRepairListingIdentity;
  plan_id: string;
  plan_body_sha256: string;
  permit_authorization_sha256: string;
  feed_id: string | null;
  reason_code: string | null;
  marketplace_write_calls: 0 | 1;
  automatic_reapply_allowed: false;
  next_action:
    | "QUALIFY_WITH_FRESH_LIVE_REREAD"
    | "OWNER_REVIEW_REPLAN"
    | "MANUAL_POST_RECONCILIATION_NO_RETRY"
    | "RESUME_EXACT_FEED_GET_ONLY";
  exact_evidence: {
    request_manifest_bytes: Uint8Array;
    request_payload_bytes: Uint8Array;
    response_http_receipt_bytes: Uint8Array | null;
    response_payload_bytes: Uint8Array | null;
    feed_status_http_receipt_bytes: Uint8Array | null;
    feed_status_payload_bytes: Uint8Array | null;
  };
  continuation: WalmartListingRepairAcceptedPostEvidence | null;
  transport_counts: WalmartListingRepairTransportCounts | null;
  external_effects: {
    database_calls_by_core: 0;
    model_calls_by_core: 0;
    paid_provider_calls_by_core: 0;
    other_listing_writes_by_core: 0;
    marketplace_feed_posts_maximum: 1;
  };
}

export interface WalmartListingRepairWriterDependencies {
  payload_builder: WalmartListingRepairPayloadBuilder;
  exact_request_verifier: WalmartListingRepairExactRequestVerifier;
  ledger: WalmartListingRepairLedgerAdapter;
  artifact_sink: WalmartListingRepairArtifactSink;
  /** Rebuilds the source-aware sequence gate; cached PASS data is forbidden. */
  rebuild_sequence_ready_proof(input: {
    sequence_authorization: unknown;
    sequence: WalmartListingRepairSequenceAuthorization;
    plan: SealedWalmartListingRepairPlan;
  }): Promise<WalmartListingRepairSequenceReadyProof>;
  /** Reads/verifies the exact immutable Product Truth binding, locally and read-only. */
  read_current_product_truth(input: {
    plan: SealedWalmartListingRepairPlan;
  }): Promise<WalmartListingRepairProductTruthBinding>;
  /** Rebuilds the exact certificate from immutable image/lineage/rights/vision evidence. */
  verify_target_image_certificate(input: {
    plan: SealedWalmartListingRepairPlan;
    certificate_bytes: Uint8Array;
    context: unknown;
    now: Date;
  }): Promise<WalmartListingRepairTargetImageCertificateProof>;
  /** Factory must be side-effect free; OAuth may begin only in a transport method. */
  open_transport(): WalmartListingRepairOneShotTransport;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  random_id?: () => string;
}

/** Narrow dependency boundary: this recovery path cannot even receive transport hooks. */
export interface WalmartListingRepairRequestingRecoveryDependencies {
  ledger: Pick<WalmartListingRepairLedgerAdapter, "loadRequesting">;
}

export interface WalmartListingRepairRequestingRecoveryResult {
  schema_version: "walmart-listing-repair-requesting-reconciliation/v1";
  policy_id: typeof WALMART_LISTING_REPAIR_WRITER_POLICY;
  status: "MANUAL_REVIEW_REQUIRED";
  listing: WalmartListingRepairListingIdentity;
  plan_id: string;
  plan_body_sha256: string;
  permit_authorization_sha256: string;
  claim_id: string;
  requesting_at: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  marketplace_write_calls: "UNKNOWN_0_OR_1";
  automatic_reapply_allowed: false;
  next_action: "MANUAL_POST_RECONCILIATION_NO_RETRY";
  external_effects: {
    network_calls_by_core: 0;
    database_calls_by_core: 0;
    model_calls_by_core: 0;
    paid_provider_calls_by_core: 0;
    marketplace_writes_by_core: 0;
  };
}

interface WriterAuthorityRuntime {
  verifySequence(value: unknown, now: Date): WalmartListingRepairSequenceAuthorization;
  verifyCurrentPermit(value: unknown, now: Date): WalmartListingRepairOneSkuPermit;
  expected_apply_engine_release_sha256: string;
}

export class WalmartListingRepairWriterError extends Error {
  readonly code: string;
  readonly automatic_reapply_allowed = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairWriterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairWriterError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONTRACT", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_CONTRACT", `${label} keys are not exact`);
  }
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || !SAFE_TEXT.test(value)) {
    fail("INVALID_CONTRACT", `${label} must be a bounded exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail("INVALID_CONTRACT", `${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) {
    fail("INVALID_CONTRACT", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function nowDate(clock: (() => Date) | undefined): Date {
  const value = clock?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_CLOCK", "writer clock is invalid");
  }
  return new Date(value.getTime());
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
  if (encoded === undefined) fail("INVALID_CONTRACT", "canonical JSON rejects undefined");
  return encoded;
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

function boundedBytes(value: Uint8Array, label: string, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    fail("INVALID_BYTES", `${label} must contain bounded non-empty bytes`);
  }
  return Uint8Array.from(value);
}

function parseJsonBytes(value: Uint8Array, label: string, maximum: number): JsonRecord {
  const exact = boundedBytes(value, label, maximum);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(exact);
  } catch {
    fail("INVALID_BYTES", `${label} must be UTF-8 JSON`);
  }
  try {
    return record(JSON.parse(decoded!), label);
  } catch (error) {
    if (error instanceof WalmartListingRepairWriterError) throw error;
    return fail("INVALID_BYTES", `${label} must be JSON`);
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return walmartListingIntegritySha256(left) === walmartListingIntegritySha256(right);
}

function listingIdentity(plan: SealedWalmartListingRepairPlan): WalmartListingRepairListingIdentity {
  return {
    channel: "WALMART_US",
    store_index: plan.listing.store_index,
    sku: plan.listing.sku,
    listing_key: plan.listing.listing_key,
    item_id: plan.listing.item_id,
  };
}

function verifyPlan(value: unknown, now: Date, runtime: WriterAuthorityRuntime): SealedWalmartListingRepairPlan {
  const raw = record(value, "repair plan");
  if (raw.schema_version !== "walmart-listing-integrity-repair-plan/v2") {
    fail("PLAN_MISMATCH", "repair plan schema is invalid");
  }
  const bodySha = digest(raw.body_sha256, "repair plan.body_sha256");
  const body = { ...raw };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== bodySha) {
    fail("PLAN_MISMATCH", "repair plan body SHA is invalid");
  }
  const plan = raw as unknown as SealedWalmartListingRepairPlan;
  if (digest(plan.apply_engine_release_sha256, "plan apply release")
      !== runtime.expected_apply_engine_release_sha256) {
    fail("RELEASE_MISMATCH", "repair plan targets a different apply release");
  }
  if (Date.parse(instant(plan.created_at, "plan.created_at")) > now.getTime()
    || now.getTime() >= Date.parse(instant(plan.expires_at, "plan.expires_at"))) {
    fail("PLAN_EXPIRED", "repair plan is not current");
  }
  if (plan.listing.channel !== "WALMART_US" || plan.listing.store_index < 1
    || plan.listing.published_status !== "PUBLISHED"
    || plan.listing.lifecycle_status !== "ACTIVE"
    || plan.listing.composition !== "same_product") {
    fail("PLAN_MISMATCH", "repair plan listing is not one active published Walmart listing");
  }
  const policy = plan.execution_policy;
  if (policy.signed_one_sku_permit_required !== true
    || policy.durable_permit_consumption_required !== true
    || policy.exact_raw_walmart_exchange_required !== true
    || policy.exact_listing_count !== 1 || policy.max_marketplace_write_calls !== 1
    || policy.fresh_live_reread_required !== true
    || policy.async_source_aware_rebuild_required !== true
    || policy.cached_qualification_is_authority !== false
    || policy.next_sku_requires_rebuilt_pass !== true
    || policy.mass_apply_allowed !== false || policy.automatic_reapply_allowed !== false) {
    fail("PLAN_MISMATCH", "repair plan execution policy is not fail-closed");
  }
  if (!Array.isArray(plan.changed_fields) || plan.changed_fields.length < 1
    || new Set(plan.changed_fields).size !== plan.changed_fields.length
    || walmartListingIntegritySha256({
      surface: plan.target.surface,
      images: plan.target.images,
    }) !== plan.target.target_sha256) {
    fail("PLAN_MISMATCH", "repair plan target/changed fields are invalid");
  }
  return plan;
}

function assertSequencePlanBinding(
  sequence: WalmartListingRepairSequenceAuthorization,
  plan: SealedWalmartListingRepairPlan,
): void {
  const position = plan.sequence.position;
  const expected = sequence.signed_body.ordered_listings[position];
  if (!expected || sequence.authorization_sha256 !== plan.sequence.authorization_sha256
    || sequence.signed_body.sequence_id !== plan.sequence.sequence_id
    || sequence.signed_body.sequence_epoch !== plan.sequence.sequence_epoch
    || sequence.signed_body.population_artifact_sha256
      !== plan.sequence.population_artifact_sha256
    || sequence.signed_body.frozen_verifier_engine_release_sha256
      !== plan.verifier_engine_release_sha256
    || Date.parse(plan.created_at) < Date.parse(sequence.signed_body.issued_at)
    || Date.parse(plan.expires_at) > Date.parse(sequence.signed_body.expires_at)
    || !canonicalEqual(expected, listingIdentity(plan))) {
    fail("SEQUENCE_MISMATCH", "repair plan is not the exact signed sequence position");
  }
}

function permitProductTruth(plan: SealedWalmartListingRepairPlan): WalmartListingRepairProductTruthBinding {
  return {
    expected_sha256: plan.product_truth.expected_sha256,
    product_truth_snapshot_id: plan.product_truth.product_truth_snapshot_id,
    product_truth_snapshot_body_sha256: plan.product_truth.product_truth_snapshot_body_sha256,
    truth_revision_id: plan.product_truth.truth_revision_id,
    truth_revision_body_sha256: plan.product_truth.truth_revision_body_sha256,
    truth_approval_sha256: plan.product_truth.truth_approval_sha256,
  };
}

function assertPermitBinding(
  sequence: WalmartListingRepairSequenceAuthorization,
  permit: WalmartListingRepairOneSkuPermit,
  plan: SealedWalmartListingRepairPlan,
): void {
  const body = permit.signed_body;
  if (body.sequence_authorization_sha256 !== sequence.authorization_sha256
    || body.sequence_id !== sequence.signed_body.sequence_id
    || body.sequence_epoch !== sequence.signed_body.sequence_epoch
    || body.sequence_position !== plan.sequence.position
    || !canonicalEqual(body.listing, listingIdentity(plan))
    || body.plan_id !== plan.plan_id || body.plan_body_sha256 !== plan.body_sha256
    || body.target_sha256 !== plan.target.target_sha256
    || body.baseline_capture_exchange_sha256 !== plan.baseline.live_capture_exchange_sha256
    || !canonicalEqual(body.product_truth, permitProductTruth(plan))
    || body.apply_engine_release_sha256 !== plan.apply_engine_release_sha256
    || Date.parse(body.issued_at) < Date.parse(plan.created_at)
    || Date.parse(body.expires_at) > Date.parse(plan.expires_at)
    || Date.parse(body.issued_at) < Date.parse(sequence.signed_body.issued_at)
    || Date.parse(body.expires_at) > Date.parse(sequence.signed_body.expires_at)) {
    fail("PERMIT_MISMATCH", "one-SKU permit differs from sequence/plan/Product Truth");
  }
}

function assertReadyProof(
  proof: WalmartListingRepairSequenceReadyProof,
  sequence: WalmartListingRepairSequenceAuthorization,
  plan: SealedWalmartListingRepairPlan,
): void {
  if (proof.status !== "READY_FOR_ONE_SKU_PLAN"
    || proof.sequence_authorization_sha256 !== sequence.authorization_sha256
    || proof.sequence_id !== sequence.signed_body.sequence_id
    || proof.sequence_epoch !== sequence.signed_body.sequence_epoch
    || proof.verifier_engine_release_sha256
      !== sequence.signed_body.frozen_verifier_engine_release_sha256
    || proof.verifier_engine_release_sha256 !== plan.verifier_engine_release_sha256
    || proof.next_listing_key !== plan.listing.listing_key
    || proof.next_sequence_position !== plan.sequence.position
    || proof.marketplace_write_authorized !== false
    || proof.separate_signed_one_sku_permit_required !== true) {
    fail("SEQUENCE_NOT_READY", "source-aware sequence gate did not release this exact plan position");
  }
}

function assertProductTruth(
  current: WalmartListingRepairProductTruthBinding,
  plan: SealedWalmartListingRepairPlan,
): void {
  for (const [key, value] of Object.entries(current)) {
    if (key.endsWith("sha256")) digest(value, `current Product Truth ${key}`);
  }
  if (!canonicalEqual(current, permitProductTruth(plan))) {
    fail("PRODUCT_TRUTH_DRIFT", "current Product Truth binding differs from repair plan");
  }
}

function assertTargetImageCertificate(
  proof: WalmartListingRepairTargetImageCertificateProof,
  plan: SealedWalmartListingRepairPlan,
  permit: WalmartListingRepairOneSkuPermit,
  certificateBytes: Uint8Array,
  verifiedFor: Date,
  currentAt: Date = verifiedFor,
): void {
  if (!proof) {
    fail("TARGET_IMAGE_CERTIFICATE_MISMATCH", "target image certificate proof is missing");
  }
  const verifiedAt = Date.parse(instant(proof.verified_at, "image certificate proof verified_at"));
  const expiresAt = Date.parse(instant(proof.expires_at, "image certificate proof expires_at"));
  if (proof.status !== "CERTIFIED_EXACT_TARGET_IMAGES"
    || proof.certificate_sha256 !== permit.signed_body.target_image_certificate_sha256
    || proof.certificate_sha256 !== sha256(certificateBytes)
    || proof.plan_body_sha256 !== plan.body_sha256
    || proof.target_sha256 !== plan.target.target_sha256
    || !canonicalEqual(proof.listing, listingIdentity(plan))
    || verifiedAt !== verifiedFor.getTime() || expiresAt <= currentAt.getTime()
    || proof.evidence_only_not_write_authority !== true) {
    fail(
      "TARGET_IMAGE_CERTIFICATE_MISMATCH",
      "target image certificate is not exact current plan/Product Truth visual evidence",
    );
  }
}

function assertPollPolicy(policy: WalmartListingRepairWriterInput["poll_policy"]): void {
  if (!policy || !Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1
    || policy.max_attempts > WALMART_LISTING_REPAIR_MAX_POLL_ATTEMPTS
    || !Number.isSafeInteger(policy.delay_ms) || policy.delay_ms < 0
    || policy.delay_ms > WALMART_LISTING_REPAIR_MAX_POLL_DELAY_MS) {
    fail("INVALID_POLL_POLICY", "feed poll policy exceeds fixed bounds");
  }
}

function validateBuiltRequest(input: {
  built: BuiltWalmartListingRepairSurgicalRequest;
  plan: SealedWalmartListingRepairPlan;
  sequence: WalmartListingRepairSequenceAuthorization;
  permit: WalmartListingRepairOneSkuPermit;
  request_correlation_id_sha256: string;
}): BuiltWalmartListingRepairSurgicalRequest {
  const { built, plan, sequence, permit } = input;
  const payloadBytes = boundedBytes(
    built.payload_bytes,
    "surgical request payload",
    WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES,
  );
  const manifestBytes = boundedBytes(
    built.request_manifest_bytes,
    "surgical request manifest",
    WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  );
  const rawSupport = built.qualification_support_artifacts;
  if (!rawSupport || typeof rawSupport !== "object" || Array.isArray(rawSupport)) {
    fail("REQUEST_MISMATCH", "surgical qualification support artifacts are missing");
  }
  exactKeys(
    rawSupport as unknown as JsonRecord,
    QUALIFICATION_SUPPORT_ARTIFACT_NAMES,
    "surgical qualification support artifacts",
  );
  const support = Object.fromEntries(QUALIFICATION_SUPPORT_ARTIFACT_NAMES.map((name) => [
    name,
    boundedBytes(
      rawSupport[name],
      `surgical qualification support artifact ${name}`,
      WALMART_LISTING_REPAIR_MAX_SUPPORT_BYTES,
    ),
  ])) as unknown as BuiltWalmartListingRepairSurgicalRequest["qualification_support_artifacts"];
  if (sha256(support["target-image-certificate.json"])
      !== permit.signed_body.target_image_certificate_sha256) {
    fail(
      "TARGET_IMAGE_CERTIFICATE_MISMATCH",
      "immutable target image certificate bytes differ from signed one-SKU permit",
    );
  }
  if (sha256(payloadBytes) !== built.payload_sha256
    || sha256(manifestBytes) !== built.request_manifest_sha256
    || built.payload_sha256 !== permit.signed_body.request_payload_sha256
    || built.request_manifest_sha256 !== permit.signed_body.request_manifest_sha256) {
    fail("REQUEST_MISMATCH", "surgical request bytes differ from signed one-SKU permit");
  }
  const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  const parsedPayload = parseJsonBytes(
    payloadBytes,
    "surgical request payload",
    WALMART_LISTING_REPAIR_MAX_REQUEST_BYTES,
  );
  const manifest = parseJsonBytes(
    manifestBytes,
    "surgical request manifest",
    WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  );
  if (payloadText !== built.payload_json || manifestText !== built.request_manifest_json
    || !canonicalEqual(parsedPayload, built.payload)
    || !canonicalEqual(manifest, built.request_manifest)) {
    fail("REQUEST_MISMATCH", "builder objects/text do not match exact request bytes");
  }
  if (built.validation.valid !== true || built.validation.exact_listing_count !== 1
    || built.validation.feed_type !== "MP_MAINTENANCE"
    || !canonicalEqual([...built.validation.changed_fields], [...plan.changed_fields])) {
    fail("PAYLOAD_VALIDATION_FAILED", "surgical payload did not pass exact one-SKU validation");
  }
  exactKeys(parsedPayload, ["MPItemFeedHeader", "MPItem"], "MP_MAINTENANCE payload");
  const header = record(parsedPayload.MPItemFeedHeader, "MPItemFeedHeader");
  exactKeys(header, ["businessUnit", "locale", "version"], "MPItemFeedHeader");
  const items = parsedPayload.MPItem;
  if (!Array.isArray(items) || items.length !== 1) {
    fail("PAYLOAD_VALIDATION_FAILED", "MP_MAINTENANCE payload must contain one MPItem");
  }
  const item = record(items[0], "MPItem[0]");
  exactKeys(item, ["Orderable", "Visible"], "MPItem[0]");
  const orderable = record(item.Orderable, "MPItem[0].Orderable");
  exactKeys(orderable, ["sku", "productIdentifiers"], "MPItem[0].Orderable");
  if (orderable.sku !== plan.listing.sku) {
    fail("PAYLOAD_VALIDATION_FAILED", "MP_MAINTENANCE payload targets another SKU");
  }
  const visible = record(item.Visible, "MPItem[0].Visible");
  exactKeys(manifest, SURGICAL_MANIFEST_KEYS, "surgical request manifest");
  const nativeIdentity = record(manifest.native_identity, "request manifest.native_identity");
  exactKeys(nativeIdentity, [
    "product_identifier", "product_type", "live_item_response_payload_sha256",
    "live_item_receipt_body_sha256",
  ], "request manifest.native_identity");
  const productType = text(nativeIdentity.product_type, "request manifest product_type", 256);
  exactKeys(visible, [productType], "MPItem[0].Visible");
  const visibleProduct = record(visible[productType], `MPItem[0].Visible.${productType}`);
  const getSpec = record(manifest.get_spec, "request manifest.get_spec");
  exactKeys(getSpec, [
    "request_payload_sha256", "response_payload_sha256", "schema_sha256",
    "receipt_body_sha256", "version", "product_type", "product_identifier",
  ], "request manifest.get_spec");
  const transport = record(manifest.transport, "request manifest.transport");
  exactKeys(transport, ["query", "multipart", "retries", "redirects"], "request manifest.transport");
  const query = record(transport.query, "request manifest.transport.query");
  exactKeys(query, ["feedType"], "request manifest.transport.query");
  const multipart = record(transport.multipart, "request manifest.transport.multipart");
  exactKeys(
    multipart,
    ["field_name", "filename", "content_type"],
    "request manifest.transport.multipart",
  );
  const manifestFilename = text(multipart.filename, "request manifest filename", 512);
  const visibleFields = Array.isArray(manifest.visible_fields)
    ? manifest.visible_fields.map((value, index) => text(value, `visible_fields[${index}]`, 128))
    : fail("REQUEST_MISMATCH", "request manifest.visible_fields must be an array");
  if (visibleFields.length < 1 || new Set(visibleFields).size !== visibleFields.length
    || !canonicalEqual([...visibleFields].sort(), Object.keys(visibleProduct).sort())
    || !canonicalEqual(manifest.changed_fields, [...plan.changed_fields])
    || !canonicalEqual(orderable.productIdentifiers, nativeIdentity.product_identifier)
    || !canonicalEqual(nativeIdentity.product_identifier, getSpec.product_identifier)
    || getSpec.product_type !== productType || header.version !== getSpec.version
    || header.businessUnit !== "WALMART_US" || header.locale !== "en"
    || query.feedType !== "MP_MAINTENANCE" || transport.retries !== 0
    || transport.redirects !== 0 || multipart.field_name !== "file"
    || multipart.content_type !== "application/json" || manifest.full_target_written !== false
    || (built.filename !== undefined && built.filename !== manifestFilename)) {
    fail("PAYLOAD_VALIDATION_FAILED", "payload topology differs from exact surgical manifest");
  }
  for (const [value, label] of [
    [nativeIdentity.live_item_response_payload_sha256, "live item payload SHA"],
    [nativeIdentity.live_item_receipt_body_sha256, "live item receipt SHA"],
    [manifest.schema_contract_body_sha256, "schema contract SHA"],
    [manifest.schema_mapping_approval_sha256, "schema mapping approval SHA"],
    [getSpec.request_payload_sha256, "Get Spec request SHA"],
    [getSpec.response_payload_sha256, "Get Spec response SHA"],
    [getSpec.schema_sha256, "Get Spec schema SHA"],
    [getSpec.receipt_body_sha256, "Get Spec receipt SHA"],
    [manifest.body_sha256, "request manifest body SHA"],
  ] as const) digest(value, label);
  if (manifest.schema_version !== WALMART_LISTING_REPAIR_SURGICAL_REQUEST_MANIFEST_SCHEMA
    || manifest.method !== "POST" || manifest.path !== "/v3/feeds"
    || manifest.feed_type !== "MP_MAINTENANCE"
    || manifest.store_index !== plan.listing.store_index
    || manifest.seller_account_fingerprint_sha256
      !== sequence.signed_body.seller_account_fingerprint_sha256
    || !canonicalEqual(manifest.listing, listingIdentity(plan))
    || manifest.plan_id !== plan.plan_id || manifest.plan_body_sha256 !== plan.body_sha256
    || manifest.target_sha256 !== plan.target.target_sha256
    || manifest.target_image_certificate_sha256
      !== permit.signed_body.target_image_certificate_sha256
    || manifest.permit_id !== permit.signed_body.permit_id
    || manifest.apply_engine_release_sha256 !== plan.apply_engine_release_sha256
    || manifest.request_correlation_id_sha256 !== input.request_correlation_id_sha256
    || manifest.request_payload_sha256 !== built.payload_sha256) {
    fail("REQUEST_MISMATCH", "surgical request manifest is not exact sequence/plan/permit scope");
  }
  const preparedAt = instant(manifest.prepared_at, "request manifest.prepared_at");
  if (Date.parse(preparedAt) < Date.parse(plan.created_at)
    || Date.parse(preparedAt) > Date.parse(permit.signed_body.issued_at)) {
    fail("REQUEST_MISMATCH", "request must be prepared after plan and before permit signing");
  }
  return {
    ...built,
    payload_bytes: payloadBytes,
    request_manifest_bytes: manifestBytes,
    qualification_support_artifacts: support,
    filename: manifestFilename,
  };
}

function assertRequestingReceiptHashes(
  receipt: WalmartListingRepairRequestingReceipt,
  permit: WalmartListingRepairOneSkuPermit,
  requestManifestSha256: string,
  requestPayloadSha256: string,
): void {
  if (!receipt || receipt.state !== "REQUESTING"
    || receipt.authorization_sha256 !== permit.authorization_sha256
    || receipt.request_manifest_sha256 !== requestManifestSha256
    || receipt.request_payload_sha256 !== requestPayloadSha256
    || !canonicalEqual(receipt.consumption_ledger, permit.signed_body.consumption_ledger)) {
    fail("LEDGER_MISMATCH", "durable REQUESTING receipt differs from exact permit/request");
  }
  instant(receipt.claimed_at, "ledger claimed_at");
  const requestingAt = instant(receipt.requesting_at, "ledger requesting_at");
  if (Date.parse(requestingAt) < Date.parse(permit.signed_body.issued_at)
    || Date.parse(requestingAt) >= Date.parse(permit.signed_body.expires_at)) {
    fail("LEDGER_MISMATCH", "REQUESTING was not durably reached inside permit window");
  }
}

function assertRequestingReceipt(
  receipt: WalmartListingRepairRequestingReceipt,
  permit: WalmartListingRepairOneSkuPermit,
  built: BuiltWalmartListingRepairSurgicalRequest,
): void {
  assertRequestingReceiptHashes(
    receipt,
    permit,
    built.request_manifest_sha256,
    built.payload_sha256,
  );
}

function assertAcceptedReceipt(
  accepted: WalmartListingRepairAcceptedReceipt,
  requesting: WalmartListingRepairRequestingReceipt,
  feedId: string,
  responseHttpBytes: Uint8Array,
  responseBodyBytes: Uint8Array,
): void {
  if (!accepted || accepted.state !== "ACCEPTED"
    || accepted.authorization_sha256 !== requesting.authorization_sha256
    || accepted.claim_id !== requesting.claim_id
    || accepted.claimed_at !== requesting.claimed_at
    || accepted.requesting_at !== requesting.requesting_at
    || accepted.request_manifest_sha256 !== requesting.request_manifest_sha256
    || accepted.request_payload_sha256 !== requesting.request_payload_sha256
    || !canonicalEqual(accepted.consumption_ledger, requesting.consumption_ledger)
    || accepted.feed_id !== feedId
    || accepted.response_http_receipt_sha256 !== sha256(responseHttpBytes)
    || accepted.response_payload_sha256 !== sha256(responseBodyBytes)
    || accepted.exact_listing_count !== 1 || accepted.marketplace_write_calls !== 1) {
    fail("LEDGER_MISMATCH", "durable ACCEPTED receipt differs from exact POST response");
  }
  const acceptedAt = instant(accepted.accepted_at, "ledger accepted_at");
  if (Date.parse(acceptedAt) < Date.parse(requesting.requesting_at)) {
    fail("LEDGER_MISMATCH", "ACCEPTED checkpoint predates REQUESTING");
  }
}

function assertAccountBinding(
  transport: WalmartListingRepairOneShotTransport,
  sequence: WalmartListingRepairSequenceAuthorization,
  plan: SealedWalmartListingRepairPlan,
): void {
  const binding = transport.getAccountBinding();
  if (binding.channel !== "WALMART_US" || binding.store_index !== plan.listing.store_index
    || digest(binding.seller_account_fingerprint_sha256, "transport account fingerprint")
      !== sequence.signed_body.seller_account_fingerprint_sha256
    || !text(binding.seller_id, "transport seller_id", 512)) {
    fail("ACCOUNT_BINDING_MISMATCH", "transport credentials target a different seller account");
  }
}

function validateCounts(
  counts: WalmartListingRepairTransportCounts,
  limits: { post: 0 | 1; gets: number },
): void {
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("HTTP_CALL_ACCOUNTING_VIOLATION", `transport count ${key} is invalid`);
    }
  }
  if (counts.maintenance_post_calls > limits.post
    || counts.feed_status_get_calls > limits.gets
    || counts.total_http_calls !== counts.oauth_token_calls
      + counts.maintenance_post_calls + counts.feed_status_get_calls
    || counts.oauth_token_calls > 1) {
    fail("HTTP_CALL_ACCOUNTING_VIOLATION", "transport exceeded exact one-shot bounds");
  }
}

function assertExactlyOneReturnedFeedStatusGet(
  before: WalmartListingRepairTransportCounts,
  after: WalmartListingRepairTransportCounts,
): void {
  const oauthDelta = after.oauth_token_calls - before.oauth_token_calls;
  const getDelta = after.feed_status_get_calls - before.feed_status_get_calls;
  const totalDelta = after.total_http_calls - before.total_http_calls;
  if (after.maintenance_post_calls !== before.maintenance_post_calls
    || getDelta !== 1 || oauthDelta < 0 || oauthDelta > 1
    || totalDelta !== getDelta + oauthDelta) {
    fail(
      "HTTP_CALL_ACCOUNTING_VIOLATION",
      "one returned feed-status response must account for exactly one GET and no POST",
    );
  }
}

function feedStatusArtifactStem(input: {
  feed_id: string;
  correlation_id: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
}): string {
  const callCorrelationSha256 = sha256(canonicalBytes({
    schema_version: "walmart-listing-repair-feed-status-call/v1",
    feed_id: input.feed_id,
    correlation_id_sha256: sha256(input.correlation_id),
    request_manifest_sha256: input.request_manifest_sha256,
    request_payload_sha256: input.request_payload_sha256,
  }));
  return `feed-status-${callCorrelationSha256}`;
}

function responseReceiptBytes(input: {
  response: WalmartListingRepairTransportResponse;
  request:
    | {
      operation: "MAINTENANCE_POST";
      method: "POST";
      path: "/v3/feeds";
      query: { feedType: "MP_MAINTENANCE" };
      feed_id: null;
    }
    | {
      operation: "FEED_STATUS_GET";
      method: "GET";
      path: string;
      query: { includeDetails: "true" };
      feed_id: string;
    };
  request_correlation_id_sha256: string;
  captured_at: string;
}): Uint8Array {
  const body = boundedBytes(
    input.response.body,
    "Walmart response body",
    WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
  );
  const contentType = Object.entries(input.response.headers).find(
    ([key]) => key.toLowerCase() === "content-type",
  )?.[1] ?? "application/octet-stream";
  return canonicalBytes({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    operation: input.request.operation,
    method: input.request.method,
    path: input.request.path,
    query: input.request.query,
    feed_id: input.request.feed_id,
    status: input.response.status,
    content_type: text(contentType, "response content-type", 256),
    content_length: body.byteLength,
    request_correlation_id_sha256: digest(
      input.request_correlation_id_sha256,
      "response request correlation SHA",
    ),
    captured_at: instant(input.captured_at, "response captured_at"),
  });
}

function feedIdFromResponse(bytes: Uint8Array): string {
  const payload = parseJsonBytes(
    bytes,
    "Walmart MP_MAINTENANCE response",
    WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  );
  return text(payload.feedId ?? payload.feed_id, "Walmart response feedId", 512);
}

type FeedVerdict =
  | { state: "PENDING"; reason: string }
  | { state: "SUCCEEDED"; reason: null }
  | { state: "FAILED"; reason: string };

function feedVerdict(bytes: Uint8Array, feedId: string, sku: string): FeedVerdict {
  const raw = parseJsonBytes(
    bytes,
    "Walmart feed-status payload",
    WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
  );
  if (raw.feedId !== undefined && text(raw.feedId, "feed status feedId", 512) !== feedId) {
    return { state: "FAILED", reason: "FEED_ID_MISMATCH" };
  }
  const feedStatus = String(raw.feedStatus ?? "").trim().toUpperCase();
  if (!TERMINAL_FEED_STATES.has(feedStatus)) {
    return { state: "PENDING", reason: "FEED_NOT_TERMINAL" };
  }
  const details = raw.itemDetails && typeof raw.itemDetails === "object"
    ? raw.itemDetails as JsonRecord : {};
  const rows = Array.isArray(details.itemIngestionStatus)
    ? details.itemIngestionStatus
    : Array.isArray(details.itemDetails) ? details.itemDetails : [];
  if (rows.length !== 1) return { state: "FAILED", reason: "EXACT_ITEM_RESULT_MISSING" };
  const item = record(rows[0], "feed item result");
  const exactSku = String(item.sku ?? "") === sku;
  const ingestion = String(item.ingestionStatus ?? "").trim().toUpperCase();
  const countPass = (raw.itemsReceived === undefined || Number(raw.itemsReceived) === 1)
    && (raw.itemsSucceeded === undefined || Number(raw.itemsSucceeded) === 1)
    && (raw.itemsFailed === undefined || Number(raw.itemsFailed) === 0);
  if (feedStatus === "PROCESSED" && exactSku && ingestion === "SUCCESS" && countPass) {
    return { state: "SUCCEEDED", reason: null };
  }
  return { state: "FAILED", reason: exactSku ? "FEED_ITEM_FAILED" : "FEED_ITEM_SKU_MISMATCH" };
}

function correlationId(value: string, label: string): string {
  return text(value, label, 256);
}

function emptyEvidence(
  built: BuiltWalmartListingRepairSurgicalRequest,
): WalmartListingRepairWriterResult["exact_evidence"] {
  return {
    request_manifest_bytes: Uint8Array.from(built.request_manifest_bytes),
    request_payload_bytes: Uint8Array.from(built.payload_bytes),
    response_http_receipt_bytes: null,
    response_payload_bytes: null,
    feed_status_http_receipt_bytes: null,
    feed_status_payload_bytes: null,
  };
}

function resultBase(input: {
  status: WalmartListingRepairWriterResult["status"];
  plan: SealedWalmartListingRepairPlan;
  permit: WalmartListingRepairOneSkuPermit;
  feed_id: string | null;
  reason_code: string | null;
  writes: 0 | 1;
  next_action: WalmartListingRepairWriterResult["next_action"];
  evidence: WalmartListingRepairWriterResult["exact_evidence"];
  continuation?: WalmartListingRepairAcceptedPostEvidence | null;
  counts?: WalmartListingRepairTransportCounts | null;
}): WalmartListingRepairWriterResult {
  return {
    schema_version: "walmart-listing-repair-writer-result/v1",
    policy_id: WALMART_LISTING_REPAIR_WRITER_POLICY,
    status: input.status,
    listing: listingIdentity(input.plan),
    plan_id: input.plan.plan_id,
    plan_body_sha256: input.plan.body_sha256,
    permit_authorization_sha256: input.permit.authorization_sha256,
    feed_id: input.feed_id,
    reason_code: input.reason_code,
    marketplace_write_calls: input.writes,
    automatic_reapply_allowed: false,
    next_action: input.next_action,
    exact_evidence: input.evidence,
    continuation: input.continuation ?? null,
    transport_counts: input.counts ?? null,
    external_effects: {
      database_calls_by_core: 0,
      model_calls_by_core: 0,
      paid_provider_calls_by_core: 0,
      other_listing_writes_by_core: 0,
      marketplace_feed_posts_maximum: 1,
    },
  };
}

async function terminalResult(input: {
  dependencies: WalmartListingRepairWriterDependencies;
  plan: SealedWalmartListingRepairPlan;
  permit: WalmartListingRepairOneSkuPermit;
  prior: WalmartListingRepairRequestingReceipt | WalmartListingRepairAcceptedReceipt;
  outcome: WalmartListingRepairLedgerTerminalOutcome;
  status: "SUCCEEDED" | "FAILED" | "AMBIGUOUS_POST";
  reason_code: string | null;
  feed_id: string | null;
  evidence: WalmartListingRepairWriterResult["exact_evidence"];
  counts: WalmartListingRepairTransportCounts | null;
}): Promise<WalmartListingRepairWriterResult> {
  try {
    await input.dependencies.ledger.terminalize({
      permit: input.permit,
      prior: input.prior,
      outcome: input.outcome,
    });
  } catch {
    fail(
      "LEDGER_TERMINALIZATION_FAILED_NO_RETRY",
      "permit is burned but terminal state could not be durably recorded; never reapply",
    );
  }
  return resultBase({
    status: input.status,
    plan: input.plan,
    permit: input.permit,
    feed_id: input.feed_id,
    reason_code: input.reason_code,
    writes: input.outcome.marketplace_write_calls,
    next_action: input.status === "SUCCEEDED"
      ? "QUALIFY_WITH_FRESH_LIVE_REREAD"
      : input.status === "AMBIGUOUS_POST"
        ? "MANUAL_POST_RECONCILIATION_NO_RETRY" : "OWNER_REVIEW_REPLAN",
    evidence: input.evidence,
    counts: input.counts,
  });
}

function terminalOutcome(input: {
  state: WalmartListingRepairLedgerTerminalOutcome["state"];
  terminal_at: string;
  error_code: string | null;
  apply_id: string;
  writes: 0 | 1;
  http_status?: number | null;
  feed_id?: string | null;
  evidence: WalmartListingRepairWriterResult["exact_evidence"];
}): WalmartListingRepairLedgerTerminalOutcome {
  return {
    state: input.state,
    terminal_at: input.terminal_at,
    apply_id: input.apply_id,
    error_code: input.error_code,
    marketplace_write_calls: input.writes,
    http_status: input.http_status ?? null,
    feed_id: input.feed_id ?? null,
    response_http_receipt_sha256: input.evidence.response_http_receipt_bytes
      ? sha256(input.evidence.response_http_receipt_bytes) : null,
    response_payload_sha256: input.evidence.response_payload_bytes
      ? sha256(input.evidence.response_payload_bytes) : null,
    feed_status_http_receipt_sha256: input.evidence.feed_status_http_receipt_bytes
      ? sha256(input.evidence.feed_status_http_receipt_bytes) : null,
    feed_status_payload_sha256: input.evidence.feed_status_payload_bytes
      ? sha256(input.evidence.feed_status_payload_bytes) : null,
    exact_listing_count: 1,
  };
}

async function postInvocationFailureResult(input: {
  dependencies: WalmartListingRepairWriterDependencies;
  transport: WalmartListingRepairOneShotTransport;
  plan: SealedWalmartListingRepairPlan;
  permit: WalmartListingRepairOneSkuPermit;
  requesting: WalmartListingRepairRequestingReceipt;
  apply_id: string;
  evidence: WalmartListingRepairWriterResult["exact_evidence"];
}): Promise<WalmartListingRepairWriterResult> {
  const counts = input.transport.getCallCounts();
  validateCounts(counts, { post: 1, gets: 0 });
  const postStarted = counts.maintenance_post_calls === 1;
  const reason = postStarted ? "AMBIGUOUS_POST_NETWORK_OUTCOME" : "OAUTH_FAILED_BEFORE_POST";
  return terminalResult({
    dependencies: input.dependencies,
    plan: input.plan,
    permit: input.permit,
    prior: input.requesting,
    outcome: terminalOutcome({
      state: postStarted ? "AMBIGUOUS" : "FAILED",
      terminal_at: nowDate(input.dependencies.now).toISOString(),
      error_code: reason,
      apply_id: input.apply_id,
      writes: postStarted ? 1 : 0,
      evidence: input.evidence,
    }),
    status: postStarted ? "AMBIGUOUS_POST" : "FAILED",
    reason_code: reason,
    feed_id: null,
    evidence: input.evidence,
    counts,
  });
}

async function wait(dependencies: WalmartListingRepairWriterDependencies, milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  if (dependencies.wait) return dependencies.wait(milliseconds);
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function pollAccepted(input: {
  plan: SealedWalmartListingRepairPlan;
  permit: WalmartListingRepairOneSkuPermit;
  built: BuiltWalmartListingRepairSurgicalRequest;
  accepted: WalmartListingRepairAcceptedPostEvidence;
  transport: WalmartListingRepairOneShotTransport;
  dependencies: WalmartListingRepairWriterDependencies;
  poll_policy: WalmartListingRepairWriterInput["poll_policy"];
  post_response_status: number;
}): Promise<WalmartListingRepairWriterResult> {
  const baseEvidence: WalmartListingRepairWriterResult["exact_evidence"] = {
    request_manifest_bytes: Uint8Array.from(input.accepted.request_manifest_bytes),
    request_payload_bytes: Uint8Array.from(input.accepted.request_payload_bytes),
    response_http_receipt_bytes: Uint8Array.from(input.accepted.response_http_receipt_bytes),
    response_payload_bytes: Uint8Array.from(input.accepted.response_payload_bytes),
    feed_status_http_receipt_bytes: null,
    feed_status_payload_bytes: null,
  };
  let lastEvidence = baseEvidence;
  let lastReason = "FEED_NOT_TERMINAL";
  for (let attempt = 0; attempt < input.poll_policy.max_attempts; attempt += 1) {
    if (attempt > 0) await wait(input.dependencies, input.poll_policy.delay_ms);
    const id = correlationId(
      input.dependencies.random_id?.() ?? `repair-feed-poll-${randomUUID()}`,
      "feed poll correlation id",
    );
    const countsBeforeGet = input.transport.getCallCounts();
    validateCounts(countsBeforeGet, {
      post: countsBeforeGet.maintenance_post_calls === 0 ? 0 : 1,
      gets: countsBeforeGet.feed_status_get_calls,
    });
    let response: WalmartListingRepairTransportResponse;
    try {
      response = await input.transport.getFeedStatus({
        path: `/v3/feeds/${encodeURIComponent(input.accepted.feed_id)}`,
        query: { includeDetails: "true" },
        feed_id: input.accepted.feed_id,
        correlation_id: id,
        redirect: "error",
        retries: 0,
        timeout_ms: WALMART_LISTING_REPAIR_REQUEST_TIMEOUT_MS,
        max_response_bytes: WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
      });
    } catch {
      lastReason = "FEED_STATUS_TRANSPORT_PENDING";
      const countsAfterError = input.transport.getCallCounts();
      validateCounts(countsAfterError, {
        post: countsBeforeGet.maintenance_post_calls === 0 ? 0 : 1,
        gets: countsBeforeGet.feed_status_get_calls + 1,
      });
      continue;
    }
    const countsAfterGet = input.transport.getCallCounts();
    assertExactlyOneReturnedFeedStatusGet(countsBeforeGet, countsAfterGet);
    validateCounts(countsAfterGet, {
      post: countsBeforeGet.maintenance_post_calls === 0 ? 0 : 1,
      gets: countsBeforeGet.feed_status_get_calls + 1,
    });
    const body = boundedBytes(
      response.body,
      "feed-status response",
      WALMART_LISTING_REPAIR_MAX_FEED_STATUS_BYTES,
    );
    const capturedAt = nowDate(input.dependencies.now).toISOString();
    const http = responseReceiptBytes({
      response: { ...response, body },
      request: {
        operation: "FEED_STATUS_GET",
        method: "GET",
        path: `/v3/feeds/${encodeURIComponent(input.accepted.feed_id)}`,
        query: { includeDetails: "true" },
        feed_id: input.accepted.feed_id,
      },
      request_correlation_id_sha256: sha256(id),
      captured_at: capturedAt,
    });
    const artifactStem = feedStatusArtifactStem({
      feed_id: input.accepted.feed_id,
      correlation_id: id,
      request_manifest_sha256: input.built.request_manifest_sha256,
      request_payload_sha256: input.built.payload_sha256,
    });
    await input.dependencies.artifact_sink.persist("FEED_STATUS", {
      [`${artifactStem}.http.json`]: http,
      [`${artifactStem}.payload.bin`]: body,
    });
    lastEvidence = {
      ...baseEvidence,
      feed_status_http_receipt_bytes: http,
      feed_status_payload_bytes: body,
    };
    if (response.status !== 200) {
      lastReason = response.status === 429 ? "FEED_STATUS_RATE_LIMITED" : "FEED_STATUS_HTTP_PENDING";
      if (response.status === 429) break;
      continue;
    }
    let verdict: FeedVerdict;
    try {
      verdict = feedVerdict(body, input.accepted.feed_id, input.plan.listing.sku);
    } catch {
      lastReason = "FEED_STATUS_INVALID_PENDING_MANUAL_REVIEW";
      break;
    }
    if (verdict.state === "PENDING") {
      lastReason = verdict.reason;
      continue;
    }
    const terminalAt = capturedAt;
    if (verdict.state === "SUCCEEDED") {
      return terminalResult({
        dependencies: input.dependencies,
        plan: input.plan,
        permit: input.permit,
        prior: input.accepted.accepted,
        outcome: terminalOutcome({
          state: "SUCCEEDED",
          terminal_at: terminalAt,
          error_code: null,
          apply_id: input.accepted.accepted.apply_id,
          writes: 1,
          http_status: input.post_response_status,
          feed_id: input.accepted.feed_id,
          evidence: lastEvidence,
        }),
        status: "SUCCEEDED",
        reason_code: null,
        feed_id: input.accepted.feed_id,
        evidence: lastEvidence,
        counts: input.transport.getCallCounts(),
      });
    }
    return terminalResult({
      dependencies: input.dependencies,
      plan: input.plan,
      permit: input.permit,
      prior: input.accepted.accepted,
      outcome: terminalOutcome({
        state: "FAILED",
        terminal_at: terminalAt,
        error_code: verdict.reason,
        apply_id: input.accepted.accepted.apply_id,
        writes: 1,
        http_status: input.post_response_status,
        feed_id: input.accepted.feed_id,
        evidence: lastEvidence,
      }),
      status: "FAILED",
      reason_code: verdict.reason,
      feed_id: input.accepted.feed_id,
      evidence: lastEvidence,
      counts: input.transport.getCallCounts(),
    });
  }
  // The POST is known accepted and its feedId is durably captured. Poll failure
  // is propagation state, not an ambiguous write and never authorizes a repost.
  return resultBase({
    status: "APPLIED_PROPAGATING",
    plan: input.plan,
    permit: input.permit,
    feed_id: input.accepted.feed_id,
    reason_code: lastReason,
    writes: 1,
    next_action: "RESUME_EXACT_FEED_GET_ONLY",
    evidence: lastEvidence,
    continuation: input.accepted,
    counts: input.transport.getCallCounts(),
  });
}

async function executeInternal(
  input: WalmartListingRepairWriterInput,
  dependencies: WalmartListingRepairWriterDependencies,
  runtime: WriterAuthorityRuntime,
): Promise<WalmartListingRepairWriterResult> {
  assertPollPolicy(input.poll_policy);
  const initialNow = nowDate(dependencies.now);
  const sequence = runtime.verifySequence(input.sequence_authorization, initialNow);
  const permit = runtime.verifyCurrentPermit(input.one_sku_permit, initialNow);
  const plan = verifyPlan(input.plan, initialNow, runtime);
  assertSequencePlanBinding(sequence, plan);
  assertPermitBinding(sequence, permit, plan);
  const ready = await dependencies.rebuild_sequence_ready_proof({
    sequence_authorization: input.sequence_authorization,
    sequence,
    plan,
  });
  assertReadyProof(ready, sequence, plan);
  assertProductTruth(await dependencies.read_current_product_truth({ plan }), plan);

  const requestCorrelationId = correlationId(
    input.request_correlation_id,
    "request correlation id",
  );
  const built = validateBuiltRequest({
    built: await dependencies.payload_builder.build({
      plan,
      sequence,
      permit,
      request_correlation_id_sha256: sha256(requestCorrelationId),
      context: input.payload_context,
    }),
    plan,
    sequence,
    permit,
    request_correlation_id_sha256: sha256(requestCorrelationId),
  });
  dependencies.exact_request_verifier.verifyExactBytes({
    plan,
    sequence,
    permit,
    context: input.payload_context,
    request_payload_bytes: Uint8Array.from(built.payload_bytes),
    request_manifest_bytes: Uint8Array.from(built.request_manifest_bytes),
    request_payload_sha256: built.payload_sha256,
    request_manifest_sha256: built.request_manifest_sha256,
  });
  const initialCertificateCheckAt = nowDate(dependencies.now);
  const initialCertificateProof = await dependencies.verify_target_image_certificate({
    plan,
    certificate_bytes: Uint8Array.from(
      built.qualification_support_artifacts["target-image-certificate.json"],
    ),
    context: input.target_image_certificate_context,
    now: initialCertificateCheckAt,
  });
  assertTargetImageCertificate(
    initialCertificateProof,
    plan,
    permit,
    built.qualification_support_artifacts["target-image-certificate.json"],
    initialCertificateCheckAt,
  );
  await dependencies.artifact_sink.persist("PREPARED_REQUEST", {
    "request-manifest.json": built.request_manifest_bytes,
    "request-payload.json": built.payload_bytes,
    ...built.qualification_support_artifacts,
  });
  const applyId = `repair-apply-${permit.authorization_sha256}`;

  const burnAt = nowDate(dependencies.now).toISOString();
  const requesting = await dependencies.ledger.consume({
    permit,
    claimed_at: burnAt,
    requesting_at: burnAt,
    request_manifest_sha256: built.request_manifest_sha256,
    request_payload_sha256: built.payload_sha256,
  });
  assertRequestingReceipt(requesting, permit, built);

  // From this point the permit is permanently burned. Every failure returns a
  // terminal/no-retry state or a GET-only continuation.
  const beforePostEvidence = emptyEvidence(built);
  let transport: WalmartListingRepairOneShotTransport | null = null;
  let postPromise: Promise<WalmartListingRepairTransportResponse> | null = null;
  let postInvoked = false;
  try {
    // Rebuild the mutable source-aware position after the permit has burned.
    // A stale pre-build READY proof is never sufficient at the write boundary.
    const finalCertificateCheckAt = nowDate(dependencies.now);
    const finalCertificateProof = await dependencies.verify_target_image_certificate({
      plan,
      certificate_bytes: Uint8Array.from(
        built.qualification_support_artifacts["target-image-certificate.json"],
      ),
      context: input.target_image_certificate_context,
      now: finalCertificateCheckAt,
    });

    // The certificate verifier may perform slow external work. Re-read both mutable
    // authorities only after it returns so drift during that await cannot survive as
    // a stale snapshot. Promise.all makes these the final awaited reads; all checks
    // below remain synchronous through the exact POST invocation.
    const [finalReady, finalProductTruth] = await Promise.all([
      dependencies.rebuild_sequence_ready_proof({
        sequence_authorization: input.sequence_authorization,
        sequence,
        plan,
      }),
      dependencies.read_current_product_truth({ plan }),
    ]);

    // Final synchronous boundary: current sequence, plan, permit, fresh READY,
    // Product Truth, and target-image certificate are rebound before transport opens.
    // There is deliberately no await between this block and POST invocation.
    const finalNow = nowDate(dependencies.now);
    const finalSequence = runtime.verifySequence(input.sequence_authorization, finalNow);
    const finalPlan = verifyPlan(input.plan, finalNow, runtime);
    const finalPermit = runtime.verifyCurrentPermit(input.one_sku_permit, finalNow);
    if (finalSequence.authorization_sha256 !== sequence.authorization_sha256
      || finalPlan.body_sha256 !== plan.body_sha256
      || finalPermit.authorization_sha256 !== permit.authorization_sha256) {
      fail("AUTHORITY_DRIFT", "sequence/plan/permit changed at final send boundary");
    }
    assertSequencePlanBinding(finalSequence, finalPlan);
    assertPermitBinding(finalSequence, finalPermit, finalPlan);
    assertReadyProof(finalReady, finalSequence, finalPlan);
    assertProductTruth(finalProductTruth, finalPlan);
    assertTargetImageCertificate(
      finalCertificateProof,
      finalPlan,
      finalPermit,
      built.qualification_support_artifacts["target-image-certificate.json"],
      finalCertificateCheckAt,
      finalNow,
    );
    transport = dependencies.open_transport();
    validateCounts(transport.getCallCounts(), { post: 0, gets: 0 });
    assertAccountBinding(transport, finalSequence, finalPlan);
    validateCounts(transport.getCallCounts(), { post: 0, gets: 0 });

    postInvoked = true;
    postPromise = transport.postMaintenance({
      path: "/v3/feeds",
      query: { feedType: "MP_MAINTENANCE" },
      request_payload_bytes: built.payload_bytes,
      filename: built.filename
        ?? `${plan.listing.sku.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80)}-maintenance.json`,
      content_type: "application/json",
      correlation_id: requestCorrelationId,
      redirect: "error",
      retries: 0,
      timeout_ms: WALMART_LISTING_REPAIR_REQUEST_TIMEOUT_MS,
      max_response_bytes: WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (postInvoked && transport) {
      return postInvocationFailureResult({
        dependencies,
        transport,
        plan,
        permit,
        requesting,
        apply_id: applyId,
        evidence: beforePostEvidence,
      });
    }
    return terminalResult({
      dependencies,
      plan,
      permit,
      prior: requesting,
      outcome: terminalOutcome({
        state: "FAILED",
        terminal_at: nowDate(dependencies.now).toISOString(),
        error_code: error instanceof WalmartListingRepairWriterError
          ? error.code : "FINAL_PRE_SEND_GATE_FAILED",
        apply_id: applyId,
        writes: 0,
        evidence: beforePostEvidence,
      }),
      status: "FAILED",
      reason_code: error instanceof WalmartListingRepairWriterError
        ? error.code : "FINAL_PRE_SEND_GATE_FAILED",
      feed_id: null,
      evidence: beforePostEvidence,
      counts: null,
    });
  }

  let response: WalmartListingRepairTransportResponse;
  try {
    if (!transport || !postPromise) {
      fail("FINAL_PRE_SEND_GATE_FAILED", "POST promise was not created at send boundary");
    }
    response = await postPromise;
  } catch {
    if (!transport) fail("FINAL_PRE_SEND_GATE_FAILED", "transport is unavailable after POST");
    return postInvocationFailureResult({
      dependencies,
      transport,
      plan,
      permit,
      requesting,
      apply_id: applyId,
      evidence: beforePostEvidence,
    });
  }
  const countsAfterPost = transport.getCallCounts();
  validateCounts(countsAfterPost, { post: 1, gets: 0 });
  if (countsAfterPost.maintenance_post_calls !== 1) {
    fail("HTTP_CALL_ACCOUNTING_VIOLATION", "one POST response requires exactly one POST call");
  }
  let responseBody: Uint8Array;
  try {
    responseBody = boundedBytes(
      response.body,
      "MP_MAINTENANCE response",
      WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
    );
  } catch {
    return terminalResult({
      dependencies,
      plan,
      permit,
      prior: requesting,
      outcome: terminalOutcome({
        state: "AMBIGUOUS",
        terminal_at: nowDate(dependencies.now).toISOString(),
        error_code: "POST_RESPONSE_OVERSIZE_OR_EMPTY",
        apply_id: applyId,
        writes: 1,
        http_status: response.status,
        evidence: beforePostEvidence,
      }),
      status: "AMBIGUOUS_POST",
      reason_code: "POST_RESPONSE_OVERSIZE_OR_EMPTY",
      feed_id: null,
      evidence: beforePostEvidence,
      counts: countsAfterPost,
    });
  }
  const responseCapturedAt = nowDate(dependencies.now).toISOString();
  const responseHttp = responseReceiptBytes({
    response: { ...response, body: responseBody },
    request: {
      operation: "MAINTENANCE_POST",
      method: "POST",
      path: "/v3/feeds",
      query: { feedType: "MP_MAINTENANCE" },
      feed_id: null,
    },
    request_correlation_id_sha256: sha256(requestCorrelationId),
    captured_at: responseCapturedAt,
  });
  const responseEvidence = {
    ...beforePostEvidence,
    response_http_receipt_bytes: responseHttp,
    response_payload_bytes: responseBody,
  };
  if (response.status < 200 || response.status >= 300) {
    await dependencies.artifact_sink.persist("POST_RESPONSE", {
      "response-http.json": responseHttp,
      "response-payload.bin": responseBody,
    });
    return terminalResult({
      dependencies,
      plan,
      permit,
      prior: requesting,
      outcome: terminalOutcome({
        state: "FAILED",
        terminal_at: responseCapturedAt,
        error_code: `POST_HTTP_${response.status}`,
        apply_id: applyId,
        writes: 1,
        http_status: response.status,
        evidence: responseEvidence,
      }),
      status: "FAILED",
      reason_code: `POST_HTTP_${response.status}`,
      feed_id: null,
      evidence: responseEvidence,
      counts: countsAfterPost,
    });
  }
  let feedId: string;
  try {
    feedId = feedIdFromResponse(responseBody);
    await dependencies.artifact_sink.persist("POST_RESPONSE", {
      "response-http.json": responseHttp,
      "response-payload.bin": responseBody,
      "accepted-feed-id.txt": Buffer.from(feedId, "utf8"),
    });
  } catch {
    return terminalResult({
      dependencies,
      plan,
      permit,
      prior: requesting,
      outcome: terminalOutcome({
        state: "AMBIGUOUS",
        terminal_at: responseCapturedAt,
        error_code: "POST_ACCEPTED_WITHOUT_DURABLE_FEED_ID",
        apply_id: applyId,
        writes: 1,
        http_status: response.status,
        evidence: responseEvidence,
      }),
      status: "AMBIGUOUS_POST",
      reason_code: "POST_ACCEPTED_WITHOUT_DURABLE_FEED_ID",
      feed_id: null,
      evidence: responseEvidence,
      counts: countsAfterPost,
    });
  }
  let acceptedReceipt: WalmartListingRepairAcceptedReceipt;
  try {
    acceptedReceipt = await dependencies.ledger.recordAccepted({
      permit,
      requesting,
      accepted_at: nowDate(dependencies.now).toISOString(),
      apply_id: applyId,
      feed_id: feedId,
      response_http_receipt_sha256: sha256(responseHttp),
      response_payload_sha256: sha256(responseBody),
    });
    assertAcceptedReceipt(acceptedReceipt, requesting, feedId, responseHttp, responseBody);
  } catch {
    return terminalResult({
      dependencies,
      plan,
      permit,
      prior: requesting,
      outcome: terminalOutcome({
        state: "AMBIGUOUS",
        terminal_at: nowDate(dependencies.now).toISOString(),
        error_code: "ACCEPTED_CHECKPOINT_FAILED_NO_RETRY",
        apply_id: applyId,
        writes: 1,
        http_status: response.status,
        feed_id: feedId,
        evidence: responseEvidence,
      }),
      status: "AMBIGUOUS_POST",
      reason_code: "ACCEPTED_CHECKPOINT_FAILED_NO_RETRY",
      feed_id: feedId,
      evidence: responseEvidence,
      counts: countsAfterPost,
    });
  }
  const accepted: WalmartListingRepairAcceptedPostEvidence = {
    feed_id: feedId,
    request_manifest_bytes: Uint8Array.from(built.request_manifest_bytes),
    request_payload_bytes: Uint8Array.from(built.payload_bytes),
    response_http_receipt_bytes: responseHttp,
    response_payload_bytes: responseBody,
    accepted: acceptedReceipt,
  };
  return pollAccepted({
    plan,
    permit,
    built,
    accepted,
    transport,
    dependencies,
    poll_policy: input.poll_policy,
    post_response_status: response.status,
  });
}

function productionAuthorityRuntime(): WriterAuthorityRuntime {
  if (!PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256) {
    fail(
      "MISSING_PINNED_APPLY_WRITER_RELEASE",
      "production writer is NO-GO until the exact frozen payload/ledger/transport closure is pinned",
    );
  }
  return {
    verifySequence: verifyWalmartListingRepairSequenceAuthorization,
    verifyCurrentPermit: verifyCurrentWalmartListingRepairOneSkuPermit,
    expected_apply_engine_release_sha256: PINNED_PRODUCTION_APPLY_ENGINE_RELEASE_SHA256,
  };
}

function snapshotProductionExecutionInput(
  input: WalmartListingRepairProductionExecutionInput,
): WalmartListingRepairProductionExecutionInput {
  try {
    return structuredClone(input);
  } catch {
    return fail(
      "INVALID_PRODUCTION_EXECUTION_PACKAGE",
      "production execution input must be snapshot-safe data without functions or mutable handles",
    );
  }
}

async function reconcileRequestingInternal(
  input: { writer_input: WalmartListingRepairWriterInput },
  dependencies: WalmartListingRepairRequestingRecoveryDependencies,
  runtime: WriterAuthorityRuntime,
): Promise<WalmartListingRepairRequestingRecoveryResult> {
  const rawPermit = record(input.writer_input.one_sku_permit, "one-SKU permit");
  const rawPermitBody = record(rawPermit.signed_body, "one-SKU permit signed_body");
  const permitIssuedAt = new Date(instant(rawPermitBody.issued_at, "permit issued_at"));
  const permit = runtime.verifyCurrentPermit(input.writer_input.one_sku_permit, permitIssuedAt);
  const rawPlan = record(input.writer_input.plan, "repair plan");
  const planCreatedAt = new Date(instant(rawPlan.created_at, "plan created_at"));
  const sequence = runtime.verifySequence(input.writer_input.sequence_authorization, planCreatedAt);
  const plan = verifyPlan(input.writer_input.plan, planCreatedAt, runtime);
  assertSequencePlanBinding(sequence, plan);
  assertPermitBinding(sequence, permit, plan);

  const requesting = await dependencies.ledger.loadRequesting({
    permit,
    request_manifest_sha256: permit.signed_body.request_manifest_sha256,
    request_payload_sha256: permit.signed_body.request_payload_sha256,
  });
  assertRequestingReceiptHashes(
    requesting,
    permit,
    permit.signed_body.request_manifest_sha256,
    permit.signed_body.request_payload_sha256,
  );
  const requestingAt = new Date(instant(requesting.requesting_at, "recovery requesting_at"));
  const historicalSequence = runtime.verifySequence(
    input.writer_input.sequence_authorization,
    requestingAt,
  );
  const historicalPermit = runtime.verifyCurrentPermit(
    input.writer_input.one_sku_permit,
    requestingAt,
  );
  const historicalPlan = verifyPlan(input.writer_input.plan, requestingAt, runtime);
  if (historicalSequence.authorization_sha256 !== sequence.authorization_sha256
    || historicalPermit.authorization_sha256 !== permit.authorization_sha256
    || historicalPlan.body_sha256 !== plan.body_sha256) {
    fail("REQUESTING_RECOVERY_MISMATCH", "authority differs at durable REQUESTING time");
  }
  assertSequencePlanBinding(historicalSequence, historicalPlan);
  assertPermitBinding(historicalSequence, historicalPermit, historicalPlan);

  return {
    schema_version: "walmart-listing-repair-requesting-reconciliation/v1",
    policy_id: WALMART_LISTING_REPAIR_WRITER_POLICY,
    status: "MANUAL_REVIEW_REQUIRED",
    listing: listingIdentity(plan),
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    permit_authorization_sha256: permit.authorization_sha256,
    claim_id: requesting.claim_id,
    requesting_at: requesting.requesting_at,
    request_manifest_sha256: requesting.request_manifest_sha256,
    request_payload_sha256: requesting.request_payload_sha256,
    marketplace_write_calls: "UNKNOWN_0_OR_1",
    automatic_reapply_allowed: false,
    next_action: "MANUAL_POST_RECONCILIATION_NO_RETRY",
    external_effects: {
      network_calls_by_core: 0,
      database_calls_by_core: 0,
      model_calls_by_core: 0,
      paid_provider_calls_by_core: 0,
      marketplace_writes_by_core: 0,
    },
  };
}

/**
 * Production is intentionally unavailable until a frozen release pins every
 * dependency. This prevents a mutable caller from substituting a permissive
 * payload builder, ledger, sink, or retrying transport.
 */
export async function executeWalmartListingRepairOneSku(
  input: WalmartListingRepairProductionExecutionInput,
): Promise<WalmartListingRepairWriterResult> {
  if (arguments.length !== 1) {
    fail(
      "CALLER_DEPENDENCY_INJECTION_FORBIDDEN",
      "production writer accepts one data-only execution package and no dependency arguments",
    );
  }
  const execution = snapshotProductionExecutionInput(input);
  const runtime = productionAuthorityRuntime();
  const { createWalmartListingRepairProductionDependencies } = await import(
    "./listing-integrity-remediation-production-dependencies.ts"
  );
  const dependencies = createWalmartListingRepairProductionDependencies(execution);
  return executeInternal(execution.writer_input, dependencies, runtime);
}

/** Test-only execution of the real orchestration state machine. */
export async function executeWalmartListingRepairOneSkuForTest(
  input: WalmartListingRepairWriterInput,
  dependencies: WalmartListingRepairWriterDependencies,
  runtime: WriterAuthorityRuntime,
): Promise<WalmartListingRepairWriterResult> {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("TEST_INJECTION_DISABLED", "writer test runtime injection is disabled");
  }
  return executeInternal(input, dependencies, runtime);
}

/**
 * Production no-network inspection of a stranded REQUESTING state. It never
 * authorizes replay; the only successful outcome is manual reconciliation.
 */
export async function reconcileWalmartListingRepairRequestingNoNetwork(
  input: Parameters<typeof reconcileRequestingInternal>[0],
  dependencies: WalmartListingRepairRequestingRecoveryDependencies,
): Promise<WalmartListingRepairRequestingRecoveryResult> {
  return reconcileRequestingInternal(input, dependencies, productionAuthorityRuntime());
}

export async function reconcileWalmartListingRepairRequestingNoNetworkForTest(
  input: Parameters<typeof reconcileRequestingInternal>[0],
  dependencies: WalmartListingRepairRequestingRecoveryDependencies,
  runtime: WriterAuthorityRuntime,
): Promise<WalmartListingRepairRequestingRecoveryResult> {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("TEST_INJECTION_DISABLED", "writer test recovery injection is disabled");
  }
  return reconcileRequestingInternal(input, dependencies, runtime);
}

/**
 * GET-only continuation after a valid feedId response was durably captured.
 * It revalidates authority at the original REQUESTING time, never requires a
 * still-current permit, never consumes a second permit, and cannot call POST.
 */
async function resumeInternal(input: {
  writer_input: WalmartListingRepairWriterInput;
}, dependencies: WalmartListingRepairWriterDependencies, runtime: WriterAuthorityRuntime) {
  assertPollPolicy(input.writer_input.poll_policy);
  const rawPermit = record(input.writer_input.one_sku_permit, "one-SKU permit");
  const rawPermitBody = record(rawPermit.signed_body, "one-SKU permit signed_body");
  const permitIssuedAt = new Date(instant(rawPermitBody.issued_at, "permit issued_at"));
  const permit = runtime.verifyCurrentPermit(input.writer_input.one_sku_permit, permitIssuedAt);
  const rawPlan = record(input.writer_input.plan, "repair plan");
  const planCreatedAt = new Date(instant(rawPlan.created_at, "plan created_at"));
  const sequence = runtime.verifySequence(input.writer_input.sequence_authorization, planCreatedAt);
  const plan = verifyPlan(input.writer_input.plan, planCreatedAt, runtime);
  assertSequencePlanBinding(sequence, plan);
  assertPermitBinding(sequence, permit, plan);
  const correlation = correlationId(
    input.writer_input.request_correlation_id,
    "request correlation id",
  );
  const built = validateBuiltRequest({
    built: await dependencies.payload_builder.build({
      plan,
      sequence,
      permit,
      request_correlation_id_sha256: sha256(correlation),
      context: input.writer_input.payload_context,
    }),
    plan,
    sequence,
    permit,
    request_correlation_id_sha256: sha256(correlation),
  });
  dependencies.exact_request_verifier.verifyExactBytes({
    plan,
    sequence,
    permit,
    context: input.writer_input.payload_context,
    request_payload_bytes: Uint8Array.from(built.payload_bytes),
    request_manifest_bytes: Uint8Array.from(built.request_manifest_bytes),
    request_payload_sha256: built.payload_sha256,
    request_manifest_sha256: built.request_manifest_sha256,
  });
  const acceptedReceipt = await dependencies.ledger.loadAccepted({
    permit,
    request_manifest_sha256: built.request_manifest_sha256,
    request_payload_sha256: built.payload_sha256,
  });
  const requestingAt = new Date(instant(acceptedReceipt.requesting_at, "continuation requesting_at"));
  const historicalSequence = runtime.verifySequence(
    input.writer_input.sequence_authorization,
    requestingAt,
  );
  const historicalPermit = runtime.verifyCurrentPermit(
    input.writer_input.one_sku_permit,
    requestingAt,
  );
  if (historicalSequence.authorization_sha256 !== sequence.authorization_sha256
    || historicalPermit.authorization_sha256 !== permit.authorization_sha256) {
    fail("CONTINUATION_MISMATCH", "authority differs at durable REQUESTING time");
  }
  assertPermitBinding(historicalSequence, historicalPermit, plan);
  const durable = await dependencies.artifact_sink.loadAccepted({
    permit,
    accepted: acceptedReceipt,
  });
  if (sha256(durable.request_manifest_bytes) !== built.request_manifest_sha256
    || sha256(durable.request_payload_bytes) !== built.payload_sha256) {
    fail("CONTINUATION_MISMATCH", "durable accepted request differs from exact permit bytes");
  }
  const responseBody = boundedBytes(
    durable.response_payload_bytes,
    "durable accepted response",
    WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  );
  const responseHttp = boundedBytes(
    durable.response_http_receipt_bytes,
    "durable accepted HTTP receipt",
    WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  );
  const feedId = feedIdFromResponse(responseBody);
  if (feedId !== acceptedReceipt.feed_id) {
    fail("CONTINUATION_MISMATCH", "continuation is not an accepted exact feed response");
  }
  const httpReceipt = parseJsonBytes(
    responseHttp,
    "durable accepted HTTP receipt",
    WALMART_LISTING_REPAIR_MAX_RESPONSE_BYTES,
  );
  const postResponseStatus = Number(httpReceipt.status);
  if (httpReceipt.schema_version !== WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA
    || httpReceipt.operation !== "MAINTENANCE_POST"
    || httpReceipt.method !== "POST"
    || httpReceipt.path !== "/v3/feeds"
    || httpReceipt.feed_id !== null
    || !canonicalEqual(httpReceipt.query, { feedType: "MP_MAINTENANCE" })
    || !Number.isSafeInteger(postResponseStatus) || postResponseStatus < 200
    || postResponseStatus >= 300
    || httpReceipt.content_length !== responseBody.byteLength
    || httpReceipt.request_correlation_id_sha256 !== sha256(correlation)) {
    fail("CONTINUATION_MISMATCH", "accepted HTTP receipt does not bind exact POST response");
  }
  const requestingView: WalmartListingRepairRequestingReceipt = {
    authorization_sha256: acceptedReceipt.authorization_sha256,
    state: "REQUESTING",
    claim_id: acceptedReceipt.claim_id,
    claimed_at: acceptedReceipt.claimed_at,
    requesting_at: acceptedReceipt.requesting_at,
    request_manifest_sha256: acceptedReceipt.request_manifest_sha256,
    request_payload_sha256: acceptedReceipt.request_payload_sha256,
    consumption_ledger: acceptedReceipt.consumption_ledger,
  };
  assertRequestingReceipt(requestingView, permit, built);
  assertAcceptedReceipt(acceptedReceipt, requestingView, feedId, responseHttp, responseBody);
  const transport = dependencies.open_transport();
  assertAccountBinding(transport, sequence, plan);
  validateCounts(transport.getCallCounts(), { post: 0, gets: 0 });
  return pollAccepted({
    plan,
    permit,
    built,
    accepted: {
      feed_id: feedId,
      request_manifest_bytes: Uint8Array.from(durable.request_manifest_bytes),
      request_payload_bytes: Uint8Array.from(durable.request_payload_bytes),
      response_http_receipt_bytes: responseHttp,
      response_payload_bytes: responseBody,
      accepted: acceptedReceipt,
    },
    transport,
    dependencies,
    poll_policy: input.writer_input.poll_policy,
    post_response_status: postResponseStatus,
  });
}

export async function resumeWalmartListingRepairFeedPollForTest(
  input: Parameters<typeof resumeInternal>[0],
  dependencies: WalmartListingRepairWriterDependencies,
  runtime: WriterAuthorityRuntime,
): Promise<WalmartListingRepairWriterResult> {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("TEST_INJECTION_DISABLED", "writer test continuation injection is disabled");
  }
  return resumeInternal(input, dependencies, runtime);
}

/** Production GET-only continuation using the same non-injectable dependency closure. */
export async function resumeWalmartListingRepairFeedPoll(
  input: WalmartListingRepairProductionExecutionInput,
): Promise<WalmartListingRepairWriterResult> {
  if (arguments.length !== 1) {
    fail(
      "CALLER_DEPENDENCY_INJECTION_FORBIDDEN",
      "production continuation accepts one data-only execution package and no dependencies",
    );
  }
  const execution = snapshotProductionExecutionInput(input);
  const runtime = productionAuthorityRuntime();
  const { createWalmartListingRepairProductionDependencies } = await import(
    "./listing-integrity-remediation-production-dependencies.ts"
  );
  const dependencies = createWalmartListingRepairProductionDependencies(execution);
  return resumeInternal({ writer_input: execution.writer_input }, dependencies, runtime);
}
