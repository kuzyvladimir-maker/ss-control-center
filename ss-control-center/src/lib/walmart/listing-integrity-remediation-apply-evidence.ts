/**
 * Pure, fail-closed verifier for one completed Walmart surgical repair.
 *
 * The caller may provide only bytes already loaded by the custody boundary.
 * This module performs no filesystem, network, model, database, or marketplace
 * operations.  It re-hashes and parses those bytes, rebuilds the exact surgical
 * MP_MAINTENANCE request, and proves the CLAIMED -> REQUESTING -> ACCEPTED ->
 * SUCCEEDED ledger chain against the current atomic HEAD inventory.
 */

import { createHash } from "node:crypto";

import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";
import type {
  WalmartListingRepairConsumptionLedgerBinding,
  WalmartListingRepairOneSkuPermit,
  WalmartListingRepairSequenceAuthorization,
} from "./listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
  WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA,
  type WalmartListingRepairLedgerHeadEvent,
  type WalmartListingRepairPermitLedgerEvidence,
  type WalmartListingRepairPermitTerminalReceipt,
} from "./listing-integrity-remediation-ledger.ts";
import {
  canonicalWalmartListingSurgicalJson,
  verifyWalmartListingSurgicalRequestBytes,
  type WalmartListingSurgicalBaselineReference,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
  type WalmartListingSurgicalRequestManifest,
  type WalmartListingSurgicalSchemaContract,
} from "./listing-integrity-remediation-payload.ts";
import type {
  SealedWalmartListingRepairPlan,
} from "./listing-integrity-remediation-qualification.ts";
import {
  verifyWalmartListingRepairTargetImageCertificateBytes,
} from "./listing-integrity-remediation-image-certificate.ts";

export const WALMART_LISTING_REPAIR_HTTP_RECEIPT_V2_SCHEMA =
  "walmart-listing-repair-http-receipt/v2" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const CLAIM_EVENT = /^([a-f0-9]{64})\.json$/u;
const REQUESTING_EVENT = /^\.([a-f0-9]{64})\.requesting\.json$/u;
const ACCEPTED_EVENT = /^\.([a-f0-9]{64})\.accepted\.json$/u;
const TERMINAL_EVENT = /^\.([a-f0-9]{64})\.terminal\.json$/u;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingRepairWriterApplyArtifacts {
  request_manifest_bytes: Uint8Array;
  request_payload_bytes: Uint8Array;
  post_response_http_receipt_bytes: Uint8Array;
  post_response_payload_bytes: Uint8Array;
  terminal_feed_status_http_receipt_bytes: Uint8Array;
  terminal_feed_status_payload_bytes: Uint8Array;
}

export interface WalmartListingRepairSurgicalSupportingArtifacts {
  target_image_certificate_bytes: Uint8Array;
  schema_contract_bytes: Uint8Array;
  get_spec_receipt_bytes: Uint8Array;
  get_spec_request_bytes: Uint8Array;
  get_spec_response_bytes: Uint8Array;
  live_item_receipt_bytes: Uint8Array;
  live_item_response_bytes: Uint8Array;
}

export interface WalmartListingRepairCustodyLoadedApplyEvidence {
  ledger: WalmartListingRepairPermitLedgerEvidence;
  writer_artifacts: WalmartListingRepairWriterApplyArtifacts;
  surgical_supporting: WalmartListingRepairSurgicalSupportingArtifacts;
}

export interface VerifiedWalmartListingRepairCustodyApplyEvidence {
  apply_id: string;
  consumption_id: string;
  permit_authorization_sha256: string;
  feed_id: string;
  apply_engine_release_sha256: string;
  target_image_certificate_sha256: string;
  manifest_prepared_at: string;
  post_response_captured_at: string;
  accepted_at: string;
  feed_confirmed_at: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  post_response_http_receipt_sha256: string;
  post_response_payload_sha256: string;
  terminal_feed_status_http_receipt_sha256: string;
  terminal_feed_status_payload_sha256: string;
  schema_contract_sha256: string;
  get_spec_receipt_sha256: string;
  get_spec_request_sha256: string;
  get_spec_response_sha256: string;
  live_item_receipt_sha256: string;
  live_item_response_sha256: string;
  ledger_identity_sha256: string;
  ledger_claim_sha256: string;
  ledger_requesting_sha256: string;
  ledger_accepted_sha256: string;
  ledger_terminal_sha256: string;
  ledger_head_sha256: string;
  ledger_head_events_sha256: string;
  ledger_head_updated_at: string;
  at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY";
  hostile_same_uid_resistance_claimed: false;
  distributed_at_most_once_claimed: false;
  exact_listing_count: 1;
  marketplace_write_calls: 1;
}

export class WalmartListingRepairApplyEvidenceError extends Error {
  readonly code = "WALMART_LISTING_REPAIR_APPLY_EVIDENCE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "WalmartListingRepairApplyEvidenceError";
  }
}

function fail(message: string): never {
  throw new WalmartListingRepairApplyEvidenceError(message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains missing or extra fields`);
  }
}

function bytes(value: Uint8Array, label: string, maximum = MAX_JSON_BYTES): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    fail(`${label} must contain bounded non-empty exact bytes`);
  }
  return Buffer.from(value);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = text(value, label, 512);
  if (!SAFE_ID.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail(`${label} must be a safe exact identifier`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be a lowercase SHA-256 digest`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) {
    fail(`${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function exactCanonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalWalmartListingSurgicalJson(left)
    === canonicalWalmartListingSurgicalJson(right);
}

function parseJson(value: Uint8Array, label: string, maximum = MAX_JSON_BYTES): unknown {
  const raw = bytes(value, label, maximum);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
  if (decoded.charCodeAt(0) === 0xfeff) fail(`${label} must not contain a UTF-8 BOM`);
  try {
    return JSON.parse(decoded);
  } catch {
    return fail(`${label} must contain valid JSON`);
  }
}

function parseCanonicalJsonObject(
  value: Uint8Array,
  label: string,
  maximum = MAX_JSON_BYTES,
): JsonRecord {
  const parsed = record(parseJson(value, label, maximum), label);
  const canonical = Buffer.from(canonicalWalmartListingSurgicalJson(parsed), "utf8");
  if (!bytes(value, label, maximum).equals(canonical)) {
    fail(`${label} must use exact canonical JSON bytes`);
  }
  return parsed;
}

function parseLedgerEnvelope(
  value: Uint8Array,
  schema: string,
  label: string,
): JsonRecord {
  const parsed = record(parseJson(value, label, MAX_LEDGER_BYTES), label);
  const canonical = Buffer.from(`${canonicalWalmartListingSurgicalJson(parsed)}\n`, "utf8");
  if (!bytes(value, label, MAX_LEDGER_BYTES).equals(canonical)) {
    fail(`${label} must use exact canonical ledger JSON bytes`);
  }
  exactKeys(parsed, ["schema_version", "body", "body_sha256"], label);
  if (parsed.schema_version !== schema) fail(`${label} schema is invalid`);
  const body = record(parsed.body, `${label}.body`);
  if (digest(parsed.body_sha256, `${label}.body_sha256`)
    !== sha256(canonicalWalmartListingSurgicalJson(body))) {
    fail(`${label} body SHA is invalid`);
  }
  return body;
}

function assertSha(value: Uint8Array, claimed: string, label: string): void {
  if (sha256(bytes(value, label)) !== digest(claimed, `${label} SHA`)) {
    fail(`${label} SHA differs from exact bytes`);
  }
}

function assertBinding(
  value: unknown,
  expected: WalmartListingRepairConsumptionLedgerBinding,
  label: string,
): void {
  const raw = record(value, label);
  exactKeys(raw, [
    "policy_id", "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "identity_artifact_sha256",
    "reservation_filename_policy", "trusted_single_custody_host_only",
    "distributed_at_most_once_claimed",
  ], label);
  if (raw.policy_id !== "walmart-listing-repair-permit-consumption-ledger/1.0.0"
    || raw.reservation_filename_policy
      !== "authorization-sha256.json/exclusive-create/v1"
    || raw.trusted_single_custody_host_only !== true
    || raw.distributed_at_most_once_claimed !== false
    || !exactCanonicalEqual(raw, expected)) {
    fail(`${label} differs from the signed permit ledger binding`);
  }
}

function listingIdentity(plan: SealedWalmartListingRepairPlan): {
  channel: "WALMART_US";
  store_index: number;
  sku: string;
  listing_key: string;
  item_id: string;
} {
  return {
    channel: "WALMART_US",
    store_index: plan.listing.store_index,
    sku: plan.listing.sku,
    listing_key: plan.listing.listing_key,
    item_id: plan.listing.item_id,
  };
}

function assertAuthorityBindings(input: {
  sequence: WalmartListingRepairSequenceAuthorization;
  permit: WalmartListingRepairOneSkuPermit;
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
}): void {
  const { sequence, permit, plan, baseline } = input;
  const planBody = { ...plan } as JsonRecord;
  delete planBody.body_sha256;
  if (walmartListingIntegritySha256(planBody) !== plan.body_sha256
    || walmartListingIntegritySha256({
      surface: plan.target.surface,
      images: plan.target.images,
    }) !== plan.target.target_sha256) {
    fail("verified repair plan seal/target binding is invalid");
  }
  if (walmartListingIntegritySha256(baseline.surface) !== plan.baseline.surface_sha256
    || walmartListingIntegritySha256(baseline.images) !== plan.baseline.images_sha256) {
    fail("verified baseline projection differs from the repair plan baseline");
  }
  const expectedListing = sequence.signed_body.ordered_listings[plan.sequence.position];
  const identity = listingIdentity(plan);
  if (!expectedListing
    || sequence.authorization_sha256 !== plan.sequence.authorization_sha256
    || sequence.signed_body.sequence_id !== plan.sequence.sequence_id
    || sequence.signed_body.sequence_epoch !== plan.sequence.sequence_epoch
    || sequence.signed_body.population_artifact_sha256
      !== plan.sequence.population_artifact_sha256
    || sequence.signed_body.frozen_verifier_engine_release_sha256
      !== plan.verifier_engine_release_sha256
    || !exactCanonicalEqual(expectedListing, identity)) {
    fail("verified sequence differs from the exact repair plan position");
  }
  const permitBody = permit.signed_body;
  const productTruth = {
    expected_sha256: plan.product_truth.expected_sha256,
    product_truth_snapshot_id: plan.product_truth.product_truth_snapshot_id,
    product_truth_snapshot_body_sha256: plan.product_truth.product_truth_snapshot_body_sha256,
    truth_revision_id: plan.product_truth.truth_revision_id,
    truth_revision_body_sha256: plan.product_truth.truth_revision_body_sha256,
    truth_approval_sha256: plan.product_truth.truth_approval_sha256,
  };
  if (permitBody.sequence_authorization_sha256 !== sequence.authorization_sha256
    || permitBody.sequence_id !== sequence.signed_body.sequence_id
    || permitBody.sequence_epoch !== sequence.signed_body.sequence_epoch
    || permitBody.sequence_position !== plan.sequence.position
    || !exactCanonicalEqual(permitBody.listing, identity)
    || permitBody.plan_id !== plan.plan_id || permitBody.plan_body_sha256 !== plan.body_sha256
    || permitBody.target_sha256 !== plan.target.target_sha256
    || permitBody.baseline_capture_exchange_sha256
      !== plan.baseline.live_capture_exchange_sha256
    || !exactCanonicalEqual(permitBody.product_truth, productTruth)
    || permitBody.apply_engine_release_sha256 !== plan.apply_engine_release_sha256) {
    fail("verified permit differs from the sequence/plan/Product Truth binding");
  }
}

interface ParsedLedger {
  authorization_sha256: string;
  claim_id: string;
  claimed_at: string;
  requesting_at: string;
  accepted_at: string;
  terminal_at: string;
  apply_id: string;
  consumption_id: string;
  feed_id: string;
  head_events_sha256: string;
  head_updated_at: string;
}

function parseLedger(input: {
  evidence: WalmartListingRepairPermitLedgerEvidence;
  permit: WalmartListingRepairOneSkuPermit;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  post_http_sha256: string;
  post_payload_sha256: string;
  status_http_sha256: string;
  status_payload_sha256: string;
}): ParsedLedger {
  const { evidence, permit } = input;
  const authorization = digest(permit.authorization_sha256, "permit authorization SHA");
  if (evidence.state !== "SUCCEEDED" || evidence.receipt.state !== "SUCCEEDED"
    || !evidence.requesting_bytes || !evidence.requesting_sha256
    || !evidence.accepted_bytes || !evidence.accepted_sha256
    || !evidence.terminal_bytes || !evidence.terminal_sha256) {
    fail("custody ledger evidence must contain REQUESTING, ACCEPTED, and terminal SUCCEEDED");
  }
  if (evidence.at_most_once_scope !== "INTACT_SINGLE_CUSTODY_DIRECTORY"
    || evidence.hostile_same_uid_resistance_claimed !== false
    || evidence.distributed_at_most_once_claimed !== false) {
    fail("custody ledger evidence overclaims its at-most-once scope");
  }

  assertSha(evidence.identity_bytes, evidence.identity_sha256, "ledger identity");
  assertSha(evidence.claim_bytes, evidence.claim_sha256, "ledger claim");
  assertSha(evidence.requesting_bytes, evidence.requesting_sha256, "ledger REQUESTING");
  assertSha(evidence.accepted_bytes, evidence.accepted_sha256, "ledger ACCEPTED");
  assertSha(evidence.terminal_bytes, evidence.terminal_sha256, "ledger terminal");
  assertSha(evidence.head_bytes, evidence.head_sha256, "ledger HEAD");

  const binding = permit.signed_body.consumption_ledger;
  if (evidence.identity_sha256 !== binding.identity_artifact_sha256) {
    fail("ledger identity bytes differ from the signed permit binding");
  }
  const identity = parseLedgerEnvelope(
    evidence.identity_bytes,
    WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA,
    "ledger identity",
  );
  exactKeys(identity, [
    "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "created_at",
  ], "ledger identity body");
  if (safeId(identity.ledger_id, "ledger identity ledger_id") !== binding.ledger_id
    || safeId(identity.ledger_epoch, "ledger identity ledger_epoch") !== binding.ledger_epoch
    || digest(identity.state_directory_path_sha256, "ledger identity path SHA")
      !== binding.state_directory_path_sha256
    || digest(identity.directory_identity_sha256, "ledger identity directory SHA")
      !== binding.directory_identity_sha256) {
    fail("ledger identity body differs from the signed permit binding");
  }
  const identityCreatedAt = instant(identity.created_at, "ledger identity created_at");

  const claim = parseLedgerEnvelope(
    evidence.claim_bytes,
    WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA,
    "ledger claim",
  );
  exactKeys(claim, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "consumption_ledger",
  ], "ledger claim body");
  const claimedAt = instant(claim.claimed_at, "ledger claimed_at");
  const claimId = safeId(claim.claim_id, "ledger claim_id");
  if (digest(claim.authorization_sha256, "ledger claim authorization") !== authorization
    || claim.state !== "CLAIMED" || Date.parse(claimedAt) < Date.parse(identityCreatedAt)) {
    fail("ledger claim authorization/state/timestamp is invalid");
  }
  assertBinding(claim.consumption_ledger, binding, "ledger claim binding");

  const requesting = parseLedgerEnvelope(
    evidence.requesting_bytes,
    WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
    "ledger REQUESTING",
  );
  exactKeys(requesting, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "requesting_at",
    "claim_file_sha256", "request_manifest_sha256", "request_payload_sha256",
    "consumption_ledger",
  ], "ledger REQUESTING body");
  const requestingAt = instant(requesting.requesting_at, "ledger requesting_at");
  if (digest(requesting.authorization_sha256, "REQUESTING authorization") !== authorization
    || requesting.state !== "REQUESTING" || requesting.claim_id !== claimId
    || requesting.claimed_at !== claimedAt
    || Date.parse(requestingAt) < Date.parse(claimedAt)
    || digest(requesting.claim_file_sha256, "REQUESTING claim SHA") !== evidence.claim_sha256
    || digest(requesting.request_manifest_sha256, "REQUESTING manifest SHA")
      !== input.request_manifest_sha256
    || digest(requesting.request_payload_sha256, "REQUESTING payload SHA")
      !== input.request_payload_sha256) {
    fail("ledger REQUESTING chain/request binding is invalid");
  }
  assertBinding(requesting.consumption_ledger, binding, "ledger REQUESTING binding");

  const accepted = parseLedgerEnvelope(
    evidence.accepted_bytes,
    WALMART_LISTING_REPAIR_LEDGER_ACCEPTED_SCHEMA,
    "ledger ACCEPTED",
  );
  exactKeys(accepted, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "requesting_at",
    "accepted_at", "requesting_file_sha256", "apply_id", "feed_id",
    "response_http_receipt_sha256", "response_payload_sha256", "exact_listing_count",
    "marketplace_write_calls", "consumption_ledger",
  ], "ledger ACCEPTED body");
  const acceptedAt = instant(accepted.accepted_at, "ledger accepted_at");
  const applyId = safeId(accepted.apply_id, "ledger apply_id");
  const feedId = safeId(accepted.feed_id, "ledger feed_id");
  if (digest(accepted.authorization_sha256, "ACCEPTED authorization") !== authorization
    || accepted.state !== "ACCEPTED" || accepted.claim_id !== claimId
    || accepted.claimed_at !== claimedAt || accepted.requesting_at !== requestingAt
    || Date.parse(acceptedAt) < Date.parse(requestingAt)
    || digest(accepted.requesting_file_sha256, "ACCEPTED REQUESTING SHA")
      !== evidence.requesting_sha256
    || digest(accepted.response_http_receipt_sha256, "ACCEPTED POST receipt SHA")
      !== input.post_http_sha256
    || digest(accepted.response_payload_sha256, "ACCEPTED POST payload SHA")
      !== input.post_payload_sha256
    || accepted.exact_listing_count !== 1 || accepted.marketplace_write_calls !== 1) {
    fail("ledger ACCEPTED chain/POST binding is invalid");
  }
  assertBinding(accepted.consumption_ledger, binding, "ledger ACCEPTED binding");

  const terminal = parseLedgerEnvelope(
    evidence.terminal_bytes,
    WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA,
    "ledger terminal",
  );
  exactKeys(terminal, [
    "authorization_sha256", "state", "consumption_id", "claim_id", "claimed_at",
    "requesting_at", "accepted_at", "terminal_at", "prior_state",
    "prior_state_file_sha256", "requesting_file_sha256", "accepted_file_sha256",
    "apply_id", "feed_id", "response_http_receipt_sha256", "response_payload_sha256",
    "feed_status_http_receipt_sha256", "feed_status_payload_sha256",
    "exact_listing_count", "marketplace_write_calls", "error_code", "consumption_ledger",
  ], "ledger terminal body");
  const terminalAt = instant(terminal.terminal_at, "ledger terminal_at");
  const consumptionId = safeId(terminal.consumption_id, "ledger consumption_id");
  if (digest(terminal.authorization_sha256, "terminal authorization") !== authorization
    || terminal.state !== "SUCCEEDED" || terminal.claim_id !== claimId
    || terminal.claimed_at !== claimedAt || terminal.requesting_at !== requestingAt
    || terminal.accepted_at !== acceptedAt || Date.parse(terminalAt) < Date.parse(acceptedAt)
    || terminal.prior_state !== "ACCEPTED"
    || digest(terminal.prior_state_file_sha256, "terminal prior-state SHA")
      !== evidence.accepted_sha256
    || digest(terminal.requesting_file_sha256, "terminal REQUESTING SHA")
      !== evidence.requesting_sha256
    || digest(terminal.accepted_file_sha256, "terminal ACCEPTED SHA")
      !== evidence.accepted_sha256
    || terminal.apply_id !== applyId || terminal.feed_id !== feedId
    || digest(terminal.response_http_receipt_sha256, "terminal POST receipt SHA")
      !== input.post_http_sha256
    || digest(terminal.response_payload_sha256, "terminal POST payload SHA")
      !== input.post_payload_sha256
    || digest(terminal.feed_status_http_receipt_sha256, "terminal status receipt SHA")
      !== input.status_http_sha256
    || digest(terminal.feed_status_payload_sha256, "terminal status payload SHA")
      !== input.status_payload_sha256
    || terminal.exact_listing_count !== 1 || terminal.marketplace_write_calls !== 1
    || terminal.error_code !== null) {
    fail("ledger terminal SUCCEEDED chain/evidence binding is invalid");
  }
  assertBinding(terminal.consumption_ledger, binding, "ledger terminal binding");

  const receipt = evidence.receipt as WalmartListingRepairPermitTerminalReceipt;
  if (receipt.authorization_sha256 !== authorization || receipt.claim_id !== claimId
    || receipt.claimed_at !== claimedAt || receipt.requesting_at !== requestingAt
    || receipt.accepted_at !== acceptedAt || receipt.terminal_at !== terminalAt
    || receipt.consumption_id !== consumptionId || receipt.prior_state !== "ACCEPTED"
    || receipt.prior_state_file_sha256 !== evidence.accepted_sha256
    || receipt.apply_id !== applyId || receipt.feed_id !== feedId
    || receipt.claim_file_sha256 !== evidence.claim_sha256
    || receipt.requesting_file_sha256 !== evidence.requesting_sha256
    || receipt.accepted_file_sha256 !== evidence.accepted_sha256
    || receipt.terminal_file_sha256 !== evidence.terminal_sha256
    || receipt.ledger_head_sha256 !== evidence.head_sha256
    || receipt.response_http_receipt_sha256 !== input.post_http_sha256
    || receipt.response_payload_sha256 !== input.post_payload_sha256
    || receipt.feed_status_http_receipt_sha256 !== input.status_http_sha256
    || receipt.feed_status_payload_sha256 !== input.status_payload_sha256
    || receipt.exact_listing_count !== 1 || receipt.marketplace_write_calls !== 1
    || receipt.error_code !== null) {
    fail("parsed ledger receipt differs from exact terminal bytes");
  }
  assertBinding(receipt.consumption_ledger, binding, "parsed ledger receipt binding");

  const head = parseLedgerEnvelope(
    evidence.head_bytes,
    WALMART_LISTING_REPAIR_LEDGER_HEAD_SCHEMA,
    "ledger HEAD",
  );
  exactKeys(head, [
    "identity_artifact_sha256", "previous_head_artifact_sha256", "event_count", "events",
    "events_sha256", "updated_at", "at_most_once_scope",
    "hostile_same_uid_resistance_claimed", "distributed_at_most_once_claimed",
  ], "ledger HEAD body");
  if (!Array.isArray(head.events) || !Number.isSafeInteger(head.event_count)
    || head.event_count !== head.events.length) {
    fail("ledger HEAD event inventory/count is invalid");
  }
  const events = head.events.map((entry, index) => {
    const event = record(entry, `ledger HEAD event ${index}`);
    exactKeys(event, [
      "file_name", "file_sha256", "authorization_sha256", "state",
    ], `ledger HEAD event ${index}`);
    const state = event.state;
    if (state !== "CLAIMED" && state !== "REQUESTING" && state !== "ACCEPTED"
      && state !== "SUCCEEDED" && state !== "AMBIGUOUS" && state !== "FAILED") {
      fail(`ledger HEAD event ${index} state is invalid`);
    }
    const fileName = text(event.file_name, `ledger HEAD event ${index} file_name`, 256);
    const claimMatch = CLAIM_EVENT.exec(fileName);
    const requestingMatch = REQUESTING_EVENT.exec(fileName);
    const acceptedMatch = ACCEPTED_EVENT.exec(fileName);
    const terminalMatch = TERMINAL_EVENT.exec(fileName);
    const authorizationFromName = (
      claimMatch ?? requestingMatch ?? acceptedMatch ?? terminalMatch
    )?.[1];
    const eventAuthorization = digest(
      event.authorization_sha256,
      `ledger HEAD event ${index} authorization`,
    );
    if (!authorizationFromName || authorizationFromName !== eventAuthorization
      || (claimMatch && state !== "CLAIMED")
      || (requestingMatch && state !== "REQUESTING")
      || (acceptedMatch && state !== "ACCEPTED")
      || (terminalMatch && state !== "SUCCEEDED" && state !== "AMBIGUOUS"
        && state !== "FAILED")) {
      fail(`ledger HEAD event ${index} filename/state/authorization binding is invalid`);
    }
    return {
      file_name: fileName,
      file_sha256: digest(event.file_sha256, `ledger HEAD event ${index} file SHA`),
      authorization_sha256: eventAuthorization,
      state,
    } satisfies WalmartListingRepairLedgerHeadEvent;
  });
  const sorted = [...events].sort((left, right) => left.file_name.localeCompare(right.file_name));
  const eventsSha = digest(head.events_sha256, "ledger HEAD events SHA");
  const headUpdatedAt = instant(head.updated_at, "ledger HEAD updated_at");
  if (digest(head.identity_artifact_sha256, "ledger HEAD identity SHA")
      !== evidence.identity_sha256
    || head.previous_head_artifact_sha256 === null
    || digest(head.previous_head_artifact_sha256, "ledger HEAD previous SHA").length !== 64
    || !exactCanonicalEqual(events, sorted)
    || new Set(events.map((event) => event.file_name)).size !== events.length
    || eventsSha !== sha256(canonicalWalmartListingSurgicalJson(events))
    || !exactCanonicalEqual(events, evidence.exact_event_inventory)
    || head.at_most_once_scope !== "INTACT_SINGLE_CUSTODY_DIRECTORY"
    || head.hostile_same_uid_resistance_claimed !== false
    || head.distributed_at_most_once_claimed !== false
    || Date.parse(headUpdatedAt) < Date.parse(terminalAt)) {
    fail("ledger HEAD differs from exact current custody inventory");
  }

  const expectedEvents = new Map<string, { state: string; sha: string }>([
    [`${authorization}.json`, { state: "CLAIMED", sha: evidence.claim_sha256 }],
    [`.${authorization}.requesting.json`, {
      state: "REQUESTING", sha: evidence.requesting_sha256,
    }],
    [`.${authorization}.accepted.json`, {
      state: "ACCEPTED", sha: evidence.accepted_sha256,
    }],
    [`.${authorization}.terminal.json`, {
      state: "SUCCEEDED", sha: evidence.terminal_sha256,
    }],
  ]);
  const targetEvents = events.filter((event) => event.authorization_sha256 === authorization);
  if (targetEvents.length !== expectedEvents.size) {
    fail("ledger HEAD must contain exactly four events for this permit authorization");
  }
  for (const event of targetEvents) {
    const expected = expectedEvents.get(event.file_name);
    if (!expected || event.state !== expected.state || event.file_sha256 !== expected.sha) {
      fail("ledger HEAD target event filename/state/SHA binding is invalid");
    }
  }

  return {
    authorization_sha256: authorization,
    claim_id: claimId,
    claimed_at: claimedAt,
    requesting_at: requestingAt,
    accepted_at: acceptedAt,
    terminal_at: terminalAt,
    apply_id: applyId,
    consumption_id: consumptionId,
    feed_id: feedId,
    head_events_sha256: eventsSha,
    head_updated_at: headUpdatedAt,
  };
}

interface ParsedHttpReceipt {
  operation: "MAINTENANCE_POST" | "FEED_STATUS_GET";
  method: "POST" | "GET";
  path: string;
  query: JsonRecord;
  feed_id: string | null;
  status: number;
  content_type: string;
  content_length: number;
  request_correlation_id_sha256: string;
  captured_at: string;
}

function parseHttpReceipt(value: Uint8Array, label: string): ParsedHttpReceipt {
  const raw = parseCanonicalJsonObject(value, label, MAX_LEDGER_BYTES);
  exactKeys(raw, [
    "schema_version", "operation", "method", "path", "query", "feed_id", "status",
    "content_type", "content_length", "request_correlation_id_sha256", "captured_at",
  ], label);
  if (raw.schema_version !== WALMART_LISTING_REPAIR_HTTP_RECEIPT_V2_SCHEMA) {
    fail(`${label} schema is invalid`);
  }
  if ((raw.operation !== "MAINTENANCE_POST" && raw.operation !== "FEED_STATUS_GET")
    || (raw.method !== "POST" && raw.method !== "GET")) {
    fail(`${label} operation/method is invalid`);
  }
  if (!Number.isSafeInteger(raw.status) || typeof raw.status !== "number"
    || raw.status < 100 || raw.status > 599
    || !Number.isSafeInteger(raw.content_length) || typeof raw.content_length !== "number"
    || raw.content_length < 1) {
    fail(`${label} status/content length is invalid`);
  }
  const contentType = text(raw.content_type, `${label}.content_type`, 256);
  if (contentType.toLowerCase().split(";", 1)[0]!.trim() !== "application/json") {
    fail(`${label} must prove an application/json response`);
  }
  return {
    operation: raw.operation,
    method: raw.method,
    path: text(raw.path, `${label}.path`, 1024),
    query: record(raw.query, `${label}.query`),
    feed_id: raw.feed_id === null ? null : safeId(raw.feed_id, `${label}.feed_id`),
    status: raw.status,
    content_type: contentType,
    content_length: raw.content_length,
    request_correlation_id_sha256: digest(
      raw.request_correlation_id_sha256,
      `${label}.request_correlation_id_sha256`,
    ),
    captured_at: instant(raw.captured_at, `${label}.captured_at`),
  };
}

function parsePostFeedId(value: Uint8Array): string {
  const payload = record(parseJson(value, "POST response payload"), "POST response payload");
  const camel = payload.feedId === undefined
    ? null : safeId(payload.feedId, "POST response feedId");
  const snake = payload.feed_id === undefined
    ? null : safeId(payload.feed_id, "POST response feed_id");
  if (!camel && !snake) fail("POST response payload does not contain feedId");
  if (camel && snake && camel !== snake) fail("POST response payload contains conflicting feed IDs");
  return camel ?? snake!;
}

function assertSuccessfulFeedStatus(value: Uint8Array, feedId: string, sku: string): void {
  const raw = record(parseJson(value, "terminal feed-status payload"), "terminal feed-status payload");
  if (raw.feedId !== undefined && safeId(raw.feedId, "feed-status feedId") !== feedId) {
    fail("terminal feed-status payload feedId differs from ACCEPTED");
  }
  if (text(raw.feedStatus, "feed-status feedStatus", 64).toUpperCase() !== "PROCESSED") {
    fail("terminal feed-status payload is not PROCESSED");
  }
  const details = record(raw.itemDetails, "feed-status itemDetails");
  const rows = Array.isArray(details.itemIngestionStatus)
    ? details.itemIngestionStatus
    : Array.isArray(details.itemDetails) ? details.itemDetails : [];
  if (rows.length !== 1) fail("terminal feed-status must contain exactly one item result");
  const row = record(rows[0], "feed-status item result");
  if (text(row.sku, "feed-status item SKU", 512) !== sku
    || text(row.ingestionStatus, "feed-status ingestion status", 64).toUpperCase()
      !== "SUCCESS") {
    fail("terminal feed-status item does not prove success for the exact SKU");
  }
  const counts: Array<[string, number]> = [
    ["itemsReceived", 1], ["itemsSucceeded", 1], ["itemsFailed", 0],
  ];
  for (const [key, expected] of counts) {
    if (raw[key] !== undefined && raw[key] !== expected) {
      fail(`terminal feed-status ${key} is inconsistent with one successful item`);
    }
  }
}

export function verifyWalmartListingRepairCustodyLoadedApplyEvidence(input: {
  loaded: WalmartListingRepairCustodyLoadedApplyEvidence;
  sequence: WalmartListingRepairSequenceAuthorization;
  permit: WalmartListingRepairOneSkuPermit;
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
}): VerifiedWalmartListingRepairCustodyApplyEvidence {
  assertAuthorityBindings(input);
  const { writer_artifacts: artifacts, surgical_supporting: supporting } = input.loaded;

  const targetImageCertificateSha = sha256(bytes(
    supporting.target_image_certificate_bytes,
    "target image certificate",
  ));

  const manifestRaw = parseCanonicalJsonObject(
    artifacts.request_manifest_bytes,
    "surgical request manifest",
  );
  const manifestPreparedAt = instant(manifestRaw.prepared_at, "request manifest prepared_at");
  try {
    verifyWalmartListingRepairTargetImageCertificateBytes({
      certificate_bytes: supporting.target_image_certificate_bytes,
      plan: input.plan,
      at: manifestPreparedAt,
    });
  } catch (error) {
    fail(`target image certificate semantic validation failed: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
  const manifestTargetImageCertificateSha = digest(
    manifestRaw.target_image_certificate_sha256,
    "request manifest target image certificate SHA",
  );
  if (manifestTargetImageCertificateSha
      !== input.permit.signed_body.target_image_certificate_sha256
    || targetImageCertificateSha !== input.permit.signed_body.target_image_certificate_sha256) {
    fail("target image certificate bytes, manifest, and signed permit SHA differ");
  }
  if (safeId(manifestRaw.permit_id, "request manifest permit_id")
      !== input.permit.signed_body.permit_id
    || digest(
      manifestRaw.seller_account_fingerprint_sha256,
      "request manifest seller fingerprint",
    ) !== input.sequence.signed_body.seller_account_fingerprint_sha256
    || digest(manifestRaw.request_correlation_id_sha256, "request manifest correlation SHA")
      .length !== 64) {
    fail("surgical request manifest differs from the verified permit/seller binding");
  }

  const requestManifestSha = sha256(bytes(
    artifacts.request_manifest_bytes,
    "surgical request manifest",
  ));
  const requestPayloadSha = sha256(bytes(
    artifacts.request_payload_bytes,
    "surgical request payload",
  ));
  if (requestManifestSha !== input.permit.signed_body.request_manifest_sha256
    || requestPayloadSha !== input.permit.signed_body.request_payload_sha256
    || digest(manifestRaw.request_payload_sha256, "manifest request payload SHA")
      !== requestPayloadSha) {
    fail("exact surgical request bytes differ from the signed permit/manifest hashes");
  }

  const schemaContract = parseCanonicalJsonObject(
    supporting.schema_contract_bytes,
    "surgical schema contract",
  ) as unknown as WalmartListingSurgicalSchemaContract;
  const getSpecReceipt = parseCanonicalJsonObject(
    supporting.get_spec_receipt_bytes,
    "Get Spec receipt",
  ) as unknown as WalmartListingSurgicalGetSpecReceipt;
  const liveItemReceipt = parseCanonicalJsonObject(
    supporting.live_item_receipt_bytes,
    "live item receipt",
  ) as unknown as WalmartListingSurgicalLiveItemReceipt;

  const rebuilt = verifyWalmartListingSurgicalRequestBytes({
    plan: input.plan,
    baseline: input.baseline,
    schema_contract: schemaContract,
    get_spec_receipt: getSpecReceipt,
    live_item_receipt: liveItemReceipt,
    target_image_certificate_bytes: supporting.target_image_certificate_bytes,
    get_spec_request_bytes: supporting.get_spec_request_bytes,
    get_spec_response_bytes: supporting.get_spec_response_bytes,
    live_item_response_bytes: supporting.live_item_response_bytes,
    request: {
      permit_id: input.permit.signed_body.permit_id,
      target_image_certificate_sha256:
        input.permit.signed_body.target_image_certificate_sha256,
      seller_account_fingerprint_sha256:
        input.sequence.signed_body.seller_account_fingerprint_sha256,
      request_correlation_id_sha256: digest(
        manifestRaw.request_correlation_id_sha256,
        "request manifest correlation SHA",
      ),
      prepared_at: manifestPreparedAt,
    },
    request_payload_bytes: artifacts.request_payload_bytes,
    request_manifest_bytes: artifacts.request_manifest_bytes,
  });
  const manifest = rebuilt.request_manifest as WalmartListingSurgicalRequestManifest;
  if (rebuilt.request_manifest_sha256 !== requestManifestSha
    || rebuilt.payload_sha256 !== requestPayloadSha
    || manifest.apply_engine_release_sha256 !== input.plan.apply_engine_release_sha256) {
    fail("rebuilt surgical request differs from the verified apply release/bytes");
  }

  const postHttpSha = sha256(bytes(
    artifacts.post_response_http_receipt_bytes,
    "POST response HTTP receipt",
  ));
  const postPayloadSha = sha256(bytes(
    artifacts.post_response_payload_bytes,
    "POST response payload",
  ));
  const statusHttpSha = sha256(bytes(
    artifacts.terminal_feed_status_http_receipt_bytes,
    "terminal feed-status HTTP receipt",
  ));
  const statusPayloadSha = sha256(bytes(
    artifacts.terminal_feed_status_payload_bytes,
    "terminal feed-status payload",
  ));

  const ledger = parseLedger({
    evidence: input.loaded.ledger,
    permit: input.permit,
    request_manifest_sha256: requestManifestSha,
    request_payload_sha256: requestPayloadSha,
    post_http_sha256: postHttpSha,
    post_payload_sha256: postPayloadSha,
    status_http_sha256: statusHttpSha,
    status_payload_sha256: statusPayloadSha,
  });

  const postReceipt = parseHttpReceipt(
    artifacts.post_response_http_receipt_bytes,
    "POST response HTTP receipt",
  );
  exactKeys(postReceipt.query, ["feedType"], "POST response HTTP receipt.query");
  if (postReceipt.operation !== "MAINTENANCE_POST" || postReceipt.method !== "POST"
    || postReceipt.path !== "/v3/feeds"
    || postReceipt.query.feedType !== "MP_MAINTENANCE" || postReceipt.feed_id !== null
    || postReceipt.status < 200 || postReceipt.status >= 300
    || postReceipt.content_length !== artifacts.post_response_payload_bytes.byteLength
    || postReceipt.request_correlation_id_sha256 !== manifest.request_correlation_id_sha256) {
    fail("POST response receipt route/query/status/body/correlation binding is invalid");
  }
  if (parsePostFeedId(artifacts.post_response_payload_bytes) !== ledger.feed_id) {
    fail("POST response feedId differs from ledger ACCEPTED");
  }
  try {
    verifyWalmartListingRepairTargetImageCertificateBytes({
      certificate_bytes: supporting.target_image_certificate_bytes,
      plan: input.plan,
      at: postReceipt.captured_at,
    });
  } catch (error) {
    fail(`target image certificate was not valid at POST response capture: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  const statusReceipt = parseHttpReceipt(
    artifacts.terminal_feed_status_http_receipt_bytes,
    "terminal feed-status HTTP receipt",
  );
  exactKeys(statusReceipt.query, ["includeDetails"], "feed-status HTTP receipt.query");
  if (statusReceipt.operation !== "FEED_STATUS_GET" || statusReceipt.method !== "GET"
    || statusReceipt.path !== `/v3/feeds/${encodeURIComponent(ledger.feed_id)}`
    || statusReceipt.query.includeDetails !== "true" || statusReceipt.feed_id !== ledger.feed_id
    || statusReceipt.status !== 200
    || statusReceipt.content_length
      !== artifacts.terminal_feed_status_payload_bytes.byteLength) {
    fail("terminal feed-status receipt route/query/feedId/status/body binding is invalid");
  }
  assertSuccessfulFeedStatus(
    artifacts.terminal_feed_status_payload_bytes,
    ledger.feed_id,
    input.plan.listing.sku,
  );

  const permitIssuedAt = instant(input.permit.signed_body.issued_at, "permit issued_at");
  const permitExpiresAt = instant(input.permit.signed_body.expires_at, "permit expires_at");
  const permitExpiresMs = Date.parse(permitExpiresAt);
  if (Date.parse(input.plan.created_at) > Date.parse(manifestPreparedAt)
    || Date.parse(manifestPreparedAt) > Date.parse(permitIssuedAt)
    || Date.parse(permitIssuedAt) > Date.parse(ledger.claimed_at)
    || Date.parse(ledger.claimed_at) >= permitExpiresMs
    || Date.parse(ledger.requesting_at) >= permitExpiresMs
    || Date.parse(ledger.requesting_at) > Date.parse(postReceipt.captured_at)
    || Date.parse(postReceipt.captured_at) >= permitExpiresMs
    || Date.parse(postReceipt.captured_at) > Date.parse(ledger.accepted_at)
    || Date.parse(ledger.accepted_at) >= permitExpiresMs
    || statusReceipt.captured_at !== ledger.terminal_at) {
    fail("apply evidence authoritative timestamp chain is invalid");
  }

  return Object.freeze({
    apply_id: ledger.apply_id,
    consumption_id: ledger.consumption_id,
    permit_authorization_sha256: ledger.authorization_sha256,
    feed_id: ledger.feed_id,
    apply_engine_release_sha256: input.plan.apply_engine_release_sha256,
    target_image_certificate_sha256: targetImageCertificateSha,
    manifest_prepared_at: manifestPreparedAt,
    post_response_captured_at: postReceipt.captured_at,
    accepted_at: ledger.accepted_at,
    feed_confirmed_at: statusReceipt.captured_at,
    request_manifest_sha256: requestManifestSha,
    request_payload_sha256: requestPayloadSha,
    post_response_http_receipt_sha256: postHttpSha,
    post_response_payload_sha256: postPayloadSha,
    terminal_feed_status_http_receipt_sha256: statusHttpSha,
    terminal_feed_status_payload_sha256: statusPayloadSha,
    schema_contract_sha256: sha256(supporting.schema_contract_bytes),
    get_spec_receipt_sha256: sha256(supporting.get_spec_receipt_bytes),
    get_spec_request_sha256: sha256(supporting.get_spec_request_bytes),
    get_spec_response_sha256: sha256(supporting.get_spec_response_bytes),
    live_item_receipt_sha256: sha256(supporting.live_item_receipt_bytes),
    live_item_response_sha256: sha256(supporting.live_item_response_bytes),
    ledger_identity_sha256: input.loaded.ledger.identity_sha256,
    ledger_claim_sha256: input.loaded.ledger.claim_sha256,
    ledger_requesting_sha256: input.loaded.ledger.requesting_sha256!,
    ledger_accepted_sha256: input.loaded.ledger.accepted_sha256!,
    ledger_terminal_sha256: input.loaded.ledger.terminal_sha256!,
    ledger_head_sha256: input.loaded.ledger.head_sha256,
    ledger_head_events_sha256: ledger.head_events_sha256,
    ledger_head_updated_at: ledger.head_updated_at,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false,
    exact_listing_count: 1,
    marketplace_write_calls: 1,
  });
}
