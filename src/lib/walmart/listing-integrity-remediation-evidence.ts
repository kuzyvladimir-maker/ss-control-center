/**
 * Exact-byte evidence loaders for the Walmart Listing Integrity repair gate.
 *
 * The production entry points rebuild source-aware audits from a frozen family
 * run-lock, its signed execution permits, exact Product Truth/buyer artifacts,
 * exact image bytes, and exact observation artifacts. Apply evidence is parsed
 * from raw request/response/feed-status bytes plus an append-only consumption
 * chain. Caller-provided digests or outcome booleans are never accepted.
 *
 * This module performs local computation only: no network, model, DB, or
 * marketplace calls.
 */

import { createHash } from "node:crypto";

import {
  verifyWalmartListingIntegrityReportAgainstSources,
  walmartListingIntegritySha256,
  type SealedWalmartListingIntegrityReport,
  type WalmartListingIntegrityInput,
  type WalmartListingIntegritySourceArtifacts,
} from "./listing-integrity-audit.ts";
import type {
  WalmartListingRepairConsumptionLedgerBinding,
  WalmartListingRepairListingIdentity,
  WalmartListingRepairOneSkuPermit,
  WalmartListingRepairSequenceAuthorization,
} from "./listing-integrity-remediation-authority.ts";

// The authoritative frozen Listing Integrity parser verifies the run-lock,
// family-pinned owner signature, execution permit, and allowance chain.
import {
  parseRunLock,
  parseWalmartListingIntegrityExecutionPermit,
} from "../../../scripts/walmart-listing-integrity-engine.mjs";

export const WALMART_LISTING_REPAIR_SOURCE_EVIDENCE_SCHEMA =
  "walmart-listing-repair-source-evidence/v2" as const;
export const WALMART_LISTING_REPAIR_REQUEST_MANIFEST_SCHEMA =
  "walmart-listing-repair-feed-request-manifest/v1" as const;
export const WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA =
  "walmart-listing-repair-http-receipt/v2" as const;
export const WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA =
  "walmart-listing-repair-consumption-ledger-identity/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA =
  "walmart-listing-repair-permit-claim/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA =
  "walmart-listing-repair-permit-requesting/v1" as const;
export const WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA =
  "walmart-listing-repair-permit-terminal/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const SOURCE_EXCHANGE_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_LISTING_REPAIR_SOURCE_EXCHANGE\0v2\0",
  "utf8",
);

type JsonRecord = Record<string, unknown>;
type SourceVerifier = (
  report: unknown,
  input: unknown,
  sources: WalmartListingIntegritySourceArtifacts,
) => Promise<SealedWalmartListingIntegrityReport>;

export interface WalmartListingRepairExactSourceBundle {
  run_lock_bytes: Uint8Array;
  code_bundle_manifest_bytes: Uint8Array;
  preflight_certificate_bytes: Uint8Array;
  execution_permit_bytes: readonly Uint8Array[];
  product_truth_snapshot_bytes: Uint8Array;
  buyer_snapshot_index_bytes: Uint8Array;
  catalog_truth_export_bytes: Uint8Array;
  buyer_snapshot_manifest_bytes: Uint8Array;
  seller_item_payload_bytes: Uint8Array;
  catalog_search_payload_bytes: Uint8Array;
  buyer_pdp_payload_bytes: Uint8Array;
  surface_snapshot_bytes: Uint8Array;
  input_bytes: Uint8Array;
  report_bytes: Uint8Array;
  asset_bytes: ReadonlyMap<string, Uint8Array>;
  observation_batch_bytes: readonly Uint8Array[];
  observation_terminal_bytes?: readonly Uint8Array[];
}

export interface WalmartListingRepairSourceEvidenceBinding {
  schema_version: typeof WALMART_LISTING_REPAIR_SOURCE_EVIDENCE_SCHEMA;
  listing: WalmartListingRepairListingIdentity;
  captured_at: string;
  run_id: string;
  run_lock_sha256: string;
  run_lock_created_at: string;
  capture_authority_public_key_spki_sha256: string;
  authenticated_capture_nonce_sha256: string;
  frozen_code_bundle_id: string;
  code_bundle_manifest_sha256: string;
  product_truth_snapshot_file_sha256: string;
  seller_item_payload_file_sha256: string;
  catalog_search_payload_file_sha256: string;
  buyer_pdp_payload_file_sha256: string;
  surface_snapshot_file_sha256: string;
  input_file_sha256: string;
  report_file_sha256: string;
  buyer_payload_canonical_sha256: string;
  surface_payload_canonical_sha256: string;
  asset_population_sha256: string;
  artifact_inventory_sha256: string;
  capture_exchange_sha256: string;
}

export interface VerifiedWalmartListingRepairSourceEvidence {
  input: WalmartListingIntegrityInput;
  report: SealedWalmartListingIntegrityReport;
  binding: WalmartListingRepairSourceEvidenceBinding;
}

export interface WalmartListingRepairExactApplyBundle {
  ledger_identity_bytes: Uint8Array;
  ledger_claim_bytes: Uint8Array;
  ledger_requesting_bytes: Uint8Array;
  ledger_terminal_bytes: Uint8Array;
  request_manifest_bytes: Uint8Array;
  request_payload_bytes: Uint8Array;
  response_http_receipt_bytes: Uint8Array;
  response_payload_bytes: Uint8Array;
  feed_status_http_receipt_bytes: Uint8Array;
  feed_status_payload_bytes: Uint8Array;
}

export interface VerifiedWalmartListingRepairApplyEvidence {
  apply_id: string;
  consumption_id: string;
  permit_authorization_sha256: string;
  applied_at: string;
  feed_confirmed_at: string;
  feed_id: string;
  apply_engine_release_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  response_http_receipt_sha256: string;
  response_payload_sha256: string;
  feed_status_http_receipt_sha256: string;
  feed_status_payload_sha256: string;
  ledger_identity_sha256: string;
  ledger_claim_sha256: string;
  ledger_requesting_sha256: string;
  ledger_terminal_sha256: string;
  exact_listing_count: 1;
  marketplace_write_calls: 1;
}

function fail(message: string): never {
  const error = new Error(message);
  (error as Error & { code: string }).code = "WALMART_LISTING_REPAIR_EVIDENCE_ERROR";
  throw error;
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
    fail(`${label} must be a safe identifier`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
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

function bytes(value: Uint8Array, label: string, maximum = MAX_JSON_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    fail(`${label} must contain bounded non-empty bytes`);
  }
  return Uint8Array.from(value);
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
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseJsonBytes(value: Uint8Array, label: string): unknown {
  const exact = bytes(value, label);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(exact);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
  try {
    return JSON.parse(decoded!);
  } catch {
    fail(`${label} must contain JSON`);
  }
}

function fileRefSha(value: unknown, label: string): string {
  const raw = record(value, label);
  return digest(raw.sha256, `${label}.sha256`);
}

function listingIdentity(input: WalmartListingIntegrityInput): WalmartListingRepairListingIdentity {
  return {
    channel: "WALMART_US",
    store_index: input.listing.store_index,
    sku: input.listing.sku,
    listing_key: input.listing.listing_key,
    item_id: input.listing.item_id,
  };
}

interface ControlVerification {
  run_lock: JsonRecord;
  run_lock_sha256: string;
  code_bundle_id: string;
  code_bundle_manifest_sha256: string;
  capture_authority_key_id: string;
  capture_authority_public_key_spki_sha256: string;
  worker_receipt_key_id: string;
  worker_receipt_public_key_sha256: string;
  authenticated_capture_nonce_sha256: string;
}

type ControlVerifier = (
  rawRunLock: unknown,
  runLockBytes: Uint8Array,
  rawCodeManifest: unknown,
  codeManifestBytes: Uint8Array,
  rawPreflight: unknown,
  preflightBytes: Uint8Array,
  rawPermits: unknown[],
  permitBytes: Uint8Array[],
  listingKey: string,
  artifactHashes: ReadonlyMap<string, string>,
) => ControlVerification;

function productionControlVerifier(
  rawRunLock: unknown,
  runLockBytes: Uint8Array,
  rawCodeManifest: unknown,
  codeManifestBytes: Uint8Array,
  _rawPreflight: unknown,
  preflightBytes: Uint8Array,
  rawPermits: unknown[],
  _permitBytes: Uint8Array[],
  listingKey: string,
  artifactHashes: ReadonlyMap<string, string>,
): ControlVerification {
  const runLock = parseRunLock(rawRunLock) as JsonRecord;
  const runLockSha = sha256(runLockBytes);
  const codeManifest = record(rawCodeManifest, "code bundle manifest");
  const codeManifestSha = sha256(codeManifestBytes);
  if (fileRefSha(runLock.code_bundle_manifest, "run_lock.code_bundle_manifest")
      !== codeManifestSha) {
    fail("run-lock code bundle manifest does not match exact bytes");
  }
  const sourceArtifacts = record(runLock.source_artifacts, "run_lock.source_artifacts");
  for (const [field, inventoryKey] of [
    ["product_truth_snapshot", "product_truth_snapshot"],
    ["buyer_snapshot_index", "buyer_snapshot_index"],
    ["catalog_truth_export", "catalog_truth_export"],
  ] as const) {
    if (fileRefSha(sourceArtifacts[field], `run_lock.source_artifacts.${field}`)
        !== artifactHashes.get(inventoryKey)) {
      fail(`run-lock ${field} does not match exact source bytes`);
    }
  }
  const listings = runLock.listings;
  if (!Array.isArray(listings)) fail("run-lock listings must be an array");
  const lockedListing = listings.find((row) => (
    record(row, "run-lock listing").listing_key === listingKey
  ));
  if (!lockedListing) fail("exact listing is absent from the frozen run-lock");
  const listing = record(lockedListing, "run-lock listing");
  for (const [field, inventoryKey] of [
    ["surface_snapshot", "surface_snapshot"],
    ["buyer_snapshot_manifest", "buyer_snapshot_manifest"],
    ["seller_item_payload", "seller_item_payload"],
    ["catalog_search_payload", "catalog_search_payload"],
    ["buyer_pdp_payload", "buyer_pdp_payload"],
  ] as const) {
    if (fileRefSha(listing[field], `run-lock listing.${field}`)
        !== artifactHashes.get(inventoryKey)) {
      fail(`run-lock listing ${field} does not match exact bytes`);
    }
  }
  const authority = record(runLock.owner_execution_authority, "run-lock owner authority");
  const observer = record(runLock.observer_contract, "run-lock observer contract");
  const preflightSha = sha256(preflightBytes);
  const partitions = runLock.observer_partitions;
  if (!Array.isArray(partitions)) fail("run-lock observer_partitions must be an array");
  const listingShards = listing.shard_ids;
  if (!Array.isArray(listingShards) || listingShards.length < 1) {
    fail("run-lock listing must have at least one exact shard");
  }
  const covered = new Set<string>();
  const authorizationShas: string[] = [];
  for (const rawPermit of rawPermits) {
    const rawBody = record(record(rawPermit, "execution permit").body, "execution permit body");
    const partition = partitions.find((row) => (
      record(row, "run-lock partition").partition_id === rawBody.partition_id
    ));
    if (!partition) fail("execution permit partition is absent from run-lock");
    const permit = parseWalmartListingIntegrityExecutionPermit(rawPermit, {
      run_lock: runLock,
      run_lock_sha256: runLockSha,
      run_id: runLock.run_id,
      preflight_certificate_sha256: preflightSha,
      family_created_at: runLock.created_at,
      partition,
    }) as JsonRecord;
    const permitBody = record(permit.body, "verified execution permit body");
    const ownerAuthorization = record(
      permitBody.owner_authorization,
      "verified execution permit owner authorization",
    );
    authorizationShas.push(digest(
      ownerAuthorization.authorization_sha256,
      "execution permit authorization_sha256",
    ));
    const shardIds = permitBody.shard_ids;
    if (!Array.isArray(shardIds)) fail("execution permit shard_ids must be an array");
    for (const shardId of shardIds) covered.add(String(shardId));
  }
  if (rawPermits.length < 1
    || listingShards.some((shardId) => !covered.has(String(shardId)))) {
    fail("signed execution permits do not cover every listing shard");
  }
  const uniqueAuthorizationShas = [...new Set(authorizationShas)].sort();
  if (uniqueAuthorizationShas.length < 1) fail("capture authorization nonce is missing");
  const bundleId = text(codeManifest.bundle_id, "code bundle manifest.bundle_id", 128);
  if (!/^sha256:[a-f0-9]{64}$/u.test(bundleId)) {
    fail("code bundle manifest.bundle_id must be content addressed");
  }
  return {
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    code_bundle_id: bundleId,
    code_bundle_manifest_sha256: codeManifestSha,
    capture_authority_key_id: safeId(authority.key_id, "run-lock owner key_id"),
    capture_authority_public_key_spki_sha256: digest(
      authority.public_key_spki_sha256,
      "run-lock owner public-key fingerprint",
    ),
    worker_receipt_key_id: safeId(
      observer.worker_receipt_key_id,
      "run-lock worker receipt key_id",
    ),
    worker_receipt_public_key_sha256: digest(
      observer.worker_receipt_public_key_sha256,
      "run-lock worker public-key fingerprint",
    ),
    authenticated_capture_nonce_sha256: sha256(canonicalJson({
      run_lock_sha256: runLockSha,
      preflight_certificate_sha256: preflightSha,
      owner_authorization_sha256: uniqueAuthorizationShas,
    })),
  };
}

async function verifySourceBundleInternal(
  bundle: WalmartListingRepairExactSourceBundle,
  expectedCaptureAuthorityFingerprint: string,
  verifier: SourceVerifier,
  controlVerifier: ControlVerifier,
): Promise<VerifiedWalmartListingRepairSourceEvidence> {
  const exact = {
    run_lock: bytes(bundle.run_lock_bytes, "run_lock_bytes"),
    code_bundle_manifest: bytes(bundle.code_bundle_manifest_bytes, "code_bundle_manifest_bytes"),
    preflight_certificate: bytes(bundle.preflight_certificate_bytes, "preflight_certificate_bytes"),
    product_truth_snapshot: bytes(bundle.product_truth_snapshot_bytes, "product_truth_snapshot_bytes"),
    buyer_snapshot_index: bytes(bundle.buyer_snapshot_index_bytes, "buyer_snapshot_index_bytes"),
    catalog_truth_export: bytes(bundle.catalog_truth_export_bytes, "catalog_truth_export_bytes"),
    buyer_snapshot_manifest: bytes(bundle.buyer_snapshot_manifest_bytes, "buyer_snapshot_manifest_bytes"),
    seller_item_payload: bytes(bundle.seller_item_payload_bytes, "seller_item_payload_bytes"),
    catalog_search_payload: bytes(bundle.catalog_search_payload_bytes, "catalog_search_payload_bytes"),
    buyer_pdp_payload: bytes(bundle.buyer_pdp_payload_bytes, "buyer_pdp_payload_bytes"),
    surface_snapshot: bytes(bundle.surface_snapshot_bytes, "surface_snapshot_bytes"),
    input: bytes(bundle.input_bytes, "input_bytes"),
    report: bytes(bundle.report_bytes, "report_bytes"),
  };
  if (!Array.isArray(bundle.execution_permit_bytes) || bundle.execution_permit_bytes.length < 1) {
    fail("execution_permit_bytes must be a non-empty exact array");
  }
  const permitBytes = bundle.execution_permit_bytes.map((row, index) => (
    bytes(row, `execution_permit_bytes[${index}]`)
  ));
  if (!Array.isArray(bundle.observation_batch_bytes)) {
    fail("observation_batch_bytes must be an array");
  }
  const observationBytes = bundle.observation_batch_bytes.map((row, index) => (
    bytes(row, `observation_batch_bytes[${index}]`)
  ));
  const terminalBytes = (bundle.observation_terminal_bytes ?? []).map((row, index) => (
    bytes(row, `observation_terminal_bytes[${index}]`)
  ));
  if (!(bundle.asset_bytes instanceof Map) || bundle.asset_bytes.size < 1) {
    fail("asset_bytes must be a non-empty Map");
  }
  const assetBytes = new Map<string, Uint8Array>();
  for (const [slot, value] of bundle.asset_bytes.entries()) {
    assetBytes.set(text(slot, `asset slot ${slot}`, 128), bytes(value, `asset_bytes.${slot}`, MAX_PAYLOAD_BYTES));
  }
  const parsed = {
    run_lock: parseJsonBytes(exact.run_lock, "run-lock"),
    code_bundle_manifest: parseJsonBytes(exact.code_bundle_manifest, "code bundle manifest"),
    preflight_certificate: parseJsonBytes(exact.preflight_certificate, "preflight certificate"),
    execution_permits: permitBytes.map((row, index) => parseJsonBytes(row, `execution permit ${index}`)),
    product_truth_snapshot: parseJsonBytes(exact.product_truth_snapshot, "Product Truth snapshot"),
    buyer_snapshot_index: parseJsonBytes(exact.buyer_snapshot_index, "buyer snapshot index"),
    catalog_truth_export: parseJsonBytes(exact.catalog_truth_export, "catalog truth export"),
    buyer_snapshot_manifest: parseJsonBytes(exact.buyer_snapshot_manifest, "buyer snapshot manifest"),
    seller_item_payload: parseJsonBytes(exact.seller_item_payload, "seller item payload"),
    catalog_search_payload: parseJsonBytes(exact.catalog_search_payload, "catalog search payload"),
    buyer_pdp_payload: parseJsonBytes(exact.buyer_pdp_payload, "buyer PDP payload"),
    surface_snapshot: parseJsonBytes(exact.surface_snapshot, "surface snapshot"),
    input: parseJsonBytes(exact.input, "listing integrity input") as WalmartListingIntegrityInput,
    report: parseJsonBytes(exact.report, "listing integrity report"),
    observation_batches: observationBytes.map((row, index) => parseJsonBytes(row, `observation batch ${index}`)),
    observation_terminals: terminalBytes.map((row, index) => parseJsonBytes(row, `observation terminal ${index}`)),
  };
  const rawArtifactRows: Array<readonly [string, Uint8Array]> = [
    ["run_lock", exact.run_lock],
    ["code_bundle_manifest", exact.code_bundle_manifest],
    ["preflight_certificate", exact.preflight_certificate],
    ["product_truth_snapshot", exact.product_truth_snapshot],
    ["buyer_snapshot_index", exact.buyer_snapshot_index],
    ["catalog_truth_export", exact.catalog_truth_export],
    ["buyer_snapshot_manifest", exact.buyer_snapshot_manifest],
    ["seller_item_payload", exact.seller_item_payload],
    ["catalog_search_payload", exact.catalog_search_payload],
    ["buyer_pdp_payload", exact.buyer_pdp_payload],
    ["surface_snapshot", exact.surface_snapshot],
    ["input", exact.input],
    ["report", exact.report],
    ...permitBytes.map((row, index) => [`execution_permit/${index}`, row] as const),
    ...observationBytes.map((row, index) => [`observation_batch/${index}`, row] as const),
    ...terminalBytes.map((row, index) => [`observation_terminal/${index}`, row] as const),
  ];
  const artifactRows = rawArtifactRows.map(([name, value]) => ({
    name,
    byte_length: value.byteLength,
    sha256: sha256(value),
  }));
  const artifactHashes = new Map(artifactRows.map((row) => [row.name, row.sha256]));
  const control = controlVerifier(
    parsed.run_lock,
    exact.run_lock,
    parsed.code_bundle_manifest,
    exact.code_bundle_manifest,
    parsed.preflight_certificate,
    exact.preflight_certificate,
    parsed.execution_permits,
    permitBytes,
    parsed.input.listing.listing_key,
    artifactHashes,
  );
  if (control.capture_authority_public_key_spki_sha256
      !== digest(expectedCaptureAuthorityFingerprint, "expected capture authority fingerprint")) {
    fail("source bundle capture authority differs from the owner-signed sequence");
  }
  const runLockCreatedAt = instant(control.run_lock.created_at, "run-lock created_at");
  if (Date.parse(runLockCreatedAt) < Date.parse(parsed.input.listing.captured_at)) {
    fail("frozen run-lock predates its buyer capture");
  }
  const sources: WalmartListingIntegritySourceArtifacts = {
    product_truth_snapshot: parsed.product_truth_snapshot,
    buyer_snapshot_index: parsed.buyer_snapshot_index,
    catalog_truth_export: parsed.catalog_truth_export,
    buyer_snapshot_manifest: parsed.buyer_snapshot_manifest,
    seller_item_payload: parsed.seller_item_payload,
    catalog_search_payload: parsed.catalog_search_payload,
    buyer_pdp_payload: parsed.buyer_pdp_payload,
    surface_snapshot: parsed.surface_snapshot,
    asset_bytes: assetBytes as WalmartListingIntegritySourceArtifacts["asset_bytes"],
    run_lock_sha256: control.run_lock_sha256,
    code_bundle_id: control.code_bundle_id,
    code_bundle_manifest_sha256: control.code_bundle_manifest_sha256,
    worker_receipt_key_id: control.worker_receipt_key_id,
    worker_receipt_public_key_sha256: control.worker_receipt_public_key_sha256,
    observation_batches: parsed.observation_batches,
    observation_terminal_artifacts: parsed.observation_terminals,
  };
  const report = await verifier(parsed.report, parsed.input, sources);
  if (!canonicalEqual(report, parsed.report)) {
    fail("source-aware verifier did not exactly reproduce report bytes");
  }
  const assets = [...assetBytes.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, value]) => ({ slot, byte_length: value.byteLength, sha256: sha256(value) }));
  const inventory = {
    artifacts: artifactRows,
    assets,
    capture_control: {
      run_id: control.run_lock.run_id,
      run_lock_sha256: control.run_lock_sha256,
      capture_authority_key_id: control.capture_authority_key_id,
      capture_authority_public_key_spki_sha256:
        control.capture_authority_public_key_spki_sha256,
      authenticated_capture_nonce_sha256: control.authenticated_capture_nonce_sha256,
    },
  };
  const inventorySha = walmartListingIntegritySha256(inventory);
  const captureExchangeSha = sha256(Buffer.concat([
    SOURCE_EXCHANGE_DOMAIN,
    Buffer.from(canonicalJson(inventory), "utf8"),
  ]));
  const binding: WalmartListingRepairSourceEvidenceBinding = {
    schema_version: WALMART_LISTING_REPAIR_SOURCE_EVIDENCE_SCHEMA,
    listing: listingIdentity(parsed.input),
    captured_at: parsed.input.listing.captured_at,
    run_id: safeId(control.run_lock.run_id, "run-lock run_id"),
    run_lock_sha256: control.run_lock_sha256,
    run_lock_created_at: runLockCreatedAt,
    capture_authority_public_key_spki_sha256:
      control.capture_authority_public_key_spki_sha256,
    authenticated_capture_nonce_sha256: control.authenticated_capture_nonce_sha256,
    frozen_code_bundle_id: control.code_bundle_id,
    code_bundle_manifest_sha256: control.code_bundle_manifest_sha256,
    product_truth_snapshot_file_sha256: sha256(exact.product_truth_snapshot),
    seller_item_payload_file_sha256: sha256(exact.seller_item_payload),
    catalog_search_payload_file_sha256: sha256(exact.catalog_search_payload),
    buyer_pdp_payload_file_sha256: sha256(exact.buyer_pdp_payload),
    surface_snapshot_file_sha256: sha256(exact.surface_snapshot),
    input_file_sha256: sha256(exact.input),
    report_file_sha256: sha256(exact.report),
    buyer_payload_canonical_sha256: parsed.input.source_bindings.buyer_payload_sha256,
    surface_payload_canonical_sha256: parsed.input.source_bindings.surface_payload_sha256,
    asset_population_sha256: walmartListingIntegritySha256(assets),
    artifact_inventory_sha256: inventorySha,
    capture_exchange_sha256: captureExchangeSha,
  };
  return { input: parsed.input, report, binding };
}

export async function verifyWalmartListingRepairSourceEvidence(
  bundle: WalmartListingRepairExactSourceBundle,
  expectedCaptureAuthorityFingerprint: string,
): Promise<VerifiedWalmartListingRepairSourceEvidence> {
  return verifySourceBundleInternal(
    bundle,
    expectedCaptureAuthorityFingerprint,
    verifyWalmartListingIntegrityReportAgainstSources,
    productionControlVerifier,
  );
}

/** Test-only source/control injection. */
export async function verifyWalmartListingRepairSourceEvidenceForTest(
  bundle: WalmartListingRepairExactSourceBundle,
  expectedCaptureAuthorityFingerprint: string,
  verifier: SourceVerifier,
  controlVerifier: ControlVerifier,
): Promise<VerifiedWalmartListingRepairSourceEvidence> {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("test source verifier injection is disabled");
  }
  return verifySourceBundleInternal(
    bundle,
    expectedCaptureAuthorityFingerprint,
    verifier,
    controlVerifier,
  );
}

function parseHttpReceipt(value: unknown, label: string): {
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
} {
  const raw = record(value, label);
  exactKeys(raw, [
    "schema_version", "operation", "method", "path", "query", "feed_id",
    "status", "content_type", "content_length",
    "request_correlation_id_sha256", "captured_at",
  ], label);
  const operation = raw.operation === "MAINTENANCE_POST"
    ? "MAINTENANCE_POST" as const : raw.operation === "FEED_STATUS_GET"
      ? "FEED_STATUS_GET" as const : fail(`${label}.operation is invalid`);
  const method = raw.method === "POST" ? "POST" as const : raw.method === "GET"
    ? "GET" as const : fail(`${label}.method is invalid`);
  if (raw.schema_version !== WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA
    || !Number.isSafeInteger(raw.status) || Number(raw.status) < 100 || Number(raw.status) > 599
    || !Number.isSafeInteger(raw.content_length) || Number(raw.content_length) < 0) {
    fail(`${label} schema/status/content_length is invalid`);
  }
  return {
    operation,
    method,
    path: text(raw.path, `${label}.path`, 2_048),
    query: record(raw.query, `${label}.query`),
    feed_id: raw.feed_id === null ? null : safeId(raw.feed_id, `${label}.feed_id`),
    status: Number(raw.status),
    content_type: text(raw.content_type, `${label}.content_type`, 256),
    content_length: Number(raw.content_length),
    request_correlation_id_sha256: digest(
      raw.request_correlation_id_sha256,
      `${label}.request_correlation_id_sha256`,
    ),
    captured_at: instant(raw.captured_at, `${label}.captured_at`),
  };
}

function parseLedgerEnvelope(value: unknown, schema: string, label: string): JsonRecord {
  const raw = record(value, label);
  exactKeys(raw, ["schema_version", "body", "body_sha256"], label);
  if (raw.schema_version !== schema) fail(`${label} schema is invalid`);
  const body = record(raw.body, `${label}.body`);
  if (digest(raw.body_sha256, `${label}.body_sha256`)
      !== walmartListingIntegritySha256(body)) {
    fail(`${label} body SHA mismatch`);
  }
  return body;
}

function exactLedgerBinding(
  value: unknown,
  expected: WalmartListingRepairConsumptionLedgerBinding,
  label: string,
): void {
  if (!canonicalEqual(value, expected)) fail(`${label} differs from signed permit ledger`);
}

function feedIdFromResponse(value: unknown): string {
  const raw = record(value, "Walmart feed response payload");
  return safeId(raw.feedId ?? raw.feed_id, "Walmart response feedId");
}

function successfulFeedRow(value: unknown, sku: string): { feed_id: string | null } {
  const raw = record(value, "Walmart feed-status payload");
  if (String(raw.feedStatus ?? "").toUpperCase() !== "PROCESSED") {
    fail("Walmart feed status is not PROCESSED");
  }
  const detailsEnvelope = record(raw.itemDetails, "Walmart feed itemDetails");
  const rows = Array.isArray(detailsEnvelope.itemIngestionStatus)
    ? detailsEnvelope.itemIngestionStatus
    : Array.isArray(detailsEnvelope.itemDetails) ? detailsEnvelope.itemDetails : null;
  if (!rows || rows.length !== 1) {
    fail("Walmart feed status must contain exactly one per-item row");
  }
  const item = record(rows[0], "Walmart per-item feed result");
  if (String(item.sku ?? "") !== sku
    || String(item.ingestionStatus ?? "").toUpperCase() !== "SUCCESS") {
    fail("Walmart per-item result is not SUCCESS for the exact raw SKU");
  }
  if (raw.itemsReceived !== undefined && Number(raw.itemsReceived) !== 1) {
    fail("Walmart feed itemsReceived is not exactly one");
  }
  if (raw.itemsSucceeded !== undefined && Number(raw.itemsSucceeded) !== 1) {
    fail("Walmart feed itemsSucceeded is not exactly one");
  }
  if (raw.itemsFailed !== undefined && Number(raw.itemsFailed) !== 0) {
    fail("Walmart feed itemsFailed is nonzero");
  }
  return { feed_id: raw.feedId === undefined ? null : safeId(raw.feedId, "feed status feedId") };
}

export function verifyWalmartListingRepairExactApplyEvidence(input: {
  bundle: WalmartListingRepairExactApplyBundle;
  sequence: WalmartListingRepairSequenceAuthorization;
  permit: WalmartListingRepairOneSkuPermit;
  plan: {
    plan_id: string;
    body_sha256: string;
    changed_fields: readonly string[];
    target: {
      target_sha256: string;
      surface: {
        title: string;
        description: string | null;
        bullets: string[];
        attribute_claims: Array<Record<string, unknown>>;
      };
      images: Array<{ slot: string; source_url: string; sha256: string }>;
    };
    baseline: { live_capture_exchange_sha256: string };
    product_truth: WalmartListingRepairOneSkuPermit["signed_body"]["product_truth"];
  };
}): VerifiedWalmartListingRepairApplyEvidence {
  const { bundle, sequence, permit, plan } = input;
  const exact = {
    identity: bytes(bundle.ledger_identity_bytes, "ledger_identity_bytes"),
    claim: bytes(bundle.ledger_claim_bytes, "ledger_claim_bytes"),
    requesting: bytes(bundle.ledger_requesting_bytes, "ledger_requesting_bytes"),
    terminal: bytes(bundle.ledger_terminal_bytes, "ledger_terminal_bytes"),
    manifest: bytes(bundle.request_manifest_bytes, "request_manifest_bytes"),
    request: bytes(bundle.request_payload_bytes, "request_payload_bytes", MAX_PAYLOAD_BYTES),
    responseHttp: bytes(bundle.response_http_receipt_bytes, "response_http_receipt_bytes"),
    response: bytes(bundle.response_payload_bytes, "response_payload_bytes", MAX_PAYLOAD_BYTES),
    statusHttp: bytes(bundle.feed_status_http_receipt_bytes, "feed_status_http_receipt_bytes"),
    status: bytes(bundle.feed_status_payload_bytes, "feed_status_payload_bytes", MAX_PAYLOAD_BYTES),
  };
  const manifest = record(parseJsonBytes(exact.manifest, "request manifest"), "request manifest");
  exactKeys(manifest, [
    "schema_version", "method", "path", "feed_type", "store_index",
    "seller_account_fingerprint_sha256", "listing", "plan_id", "plan_body_sha256",
    "permit_id", "apply_engine_release_sha256",
    "request_correlation_id_sha256", "request_payload_sha256", "created_at",
  ], "request manifest");
  if (manifest.schema_version !== WALMART_LISTING_REPAIR_REQUEST_MANIFEST_SCHEMA
    || manifest.method !== "POST" || manifest.path !== "/v3/feeds"
    || manifest.feed_type !== "MP_MAINTENANCE") {
    fail("request manifest route/feed contract is invalid");
  }
  const permitBody = permit.signed_body;
  const requestManifestSha = sha256(exact.manifest);
  const requestPayloadSha = sha256(exact.request);
  if (requestManifestSha !== permitBody.request_manifest_sha256
    || requestPayloadSha !== permitBody.request_payload_sha256
    || manifest.store_index !== permitBody.listing.store_index
    || manifest.seller_account_fingerprint_sha256
      !== sequence.signed_body.seller_account_fingerprint_sha256
    || !canonicalEqual(manifest.listing, permitBody.listing)
    || manifest.plan_id !== plan.plan_id || manifest.plan_body_sha256 !== plan.body_sha256
    || manifest.permit_id !== permitBody.permit_id
    || manifest.apply_engine_release_sha256 !== permitBody.apply_engine_release_sha256
    || manifest.request_payload_sha256 !== requestPayloadSha) {
    fail("raw request manifest/payload differs from the signed one-SKU permit");
  }
  const requestPayload = record(
    parseJsonBytes(exact.request, "MP_MAINTENANCE request payload"),
    "MP_MAINTENANCE request payload",
  );
  exactKeys(requestPayload, ["MPItem"], "MP_MAINTENANCE request payload");
  const mpItems = requestPayload.MPItem;
  if (!Array.isArray(mpItems) || mpItems.length !== 1) {
    fail("raw MP_MAINTENANCE payload must contain exactly one MPItem");
  }
  const mpItem = record(mpItems[0], "raw MPItem");
  exactKeys(mpItem, ["Orderable", "Visible"], "raw MPItem");
  const orderable = record(mpItem.Orderable, "raw MPItem.Orderable");
  exactKeys(orderable, ["sku"], "raw MPItem.Orderable");
  const visibleEnvelope = record(mpItem.Visible, "raw MPItem.Visible");
  const visibleTypes = Object.keys(visibleEnvelope);
  if (orderable.sku !== permitBody.listing.sku || visibleTypes.length !== 1
    || !SAFE_ID.test(visibleTypes[0] ?? "")) {
    fail("raw MP_MAINTENANCE payload is not the exact permitted SKU/product type");
  }
  const visible = record(visibleEnvelope[visibleTypes[0]!], "raw MPItem Visible product");
  const attributeProjection: JsonRecord = {};
  for (const claim of input.plan.target.surface.attribute_claims) {
    const fieldPath = safeId(claim.field_path, "target attribute field_path");
    if (fieldPath.includes("/")) {
      fail("nested target attribute paths require a separately frozen payload resolver");
    }
    if (Object.hasOwn(attributeProjection, fieldPath)) {
      fail(`target attribute projection repeats ${fieldPath}`);
    }
    if (typeof claim.text === "string") {
      attributeProjection[fieldPath] = text(claim.text, `target attribute ${fieldPath}.text`);
    } else if (typeof claim.value === "number" && Number.isFinite(claim.value)
      && typeof claim.unit === "string") {
      attributeProjection[fieldPath] = {
        value: claim.value,
        unit: text(claim.unit, `target attribute ${fieldPath}.unit`, 128),
      };
    } else {
      fail(`target attribute ${fieldPath} lacks an exact payload projection`);
    }
  }
  const expectedVisible: JsonRecord = {
    productName: input.plan.target.surface.title,
    shortDescription: input.plan.target.surface.description,
    keyFeatures: input.plan.target.surface.bullets,
    mainImageUrl: input.plan.target.images[0]?.source_url,
    productSecondaryImageURL: input.plan.target.images.slice(1).map((row) => row.source_url),
    ...attributeProjection,
  };
  exactKeys(visible, Object.keys(expectedVisible), "raw MPItem Visible product");
  if (!canonicalEqual(visible, expectedVisible)) {
    fail("raw MP_MAINTENANCE Visible content differs from exact repair target projection");
  }
  const requestCorrelationSha = digest(
    manifest.request_correlation_id_sha256,
    "request correlation SHA",
  );
  const appliedAt = instant(manifest.created_at, "request manifest created_at");
  if (Date.parse(appliedAt) < Date.parse(permitBody.issued_at)
    || Date.parse(appliedAt) >= Date.parse(permitBody.expires_at)) {
    fail("marketplace request occurred outside signed one-SKU permit window");
  }
  const responseHttp = parseHttpReceipt(
    parseJsonBytes(exact.responseHttp, "response HTTP receipt"),
    "response HTTP receipt",
  );
  const statusHttp = parseHttpReceipt(
    parseJsonBytes(exact.statusHttp, "feed-status HTTP receipt"),
    "feed-status HTTP receipt",
  );
  if (![200, 201, 202].includes(responseHttp.status)
    || statusHttp.status !== 200
    || responseHttp.operation !== "MAINTENANCE_POST"
    || responseHttp.method !== "POST"
    || responseHttp.path !== "/v3/feeds"
    || responseHttp.feed_id !== null
    || !canonicalEqual(responseHttp.query, { feedType: "MP_MAINTENANCE" })
    || statusHttp.operation !== "FEED_STATUS_GET"
    || statusHttp.method !== "GET"
    || responseHttp.content_length !== exact.response.byteLength
    || statusHttp.content_length !== exact.status.byteLength
    || responseHttp.request_correlation_id_sha256 !== requestCorrelationSha
    || Date.parse(responseHttp.captured_at) < Date.parse(appliedAt)
    || Date.parse(statusHttp.captured_at) < Date.parse(responseHttp.captured_at)) {
    fail("HTTP receipts do not atomically bind successful raw Walmart exchanges");
  }
  const responsePayload = parseJsonBytes(exact.response, "Walmart feed response payload");
  const statusPayload = parseJsonBytes(exact.status, "Walmart feed-status payload");
  const feedId = feedIdFromResponse(responsePayload);
  if (statusHttp.path !== `/v3/feeds/${encodeURIComponent(feedId)}`
    || statusHttp.feed_id !== feedId
    || !canonicalEqual(statusHttp.query, { includeDetails: "true" })) {
    fail("feed-status HTTP receipt does not bind the exact accepted feed GET");
  }
  const status = successfulFeedRow(statusPayload, permitBody.listing.sku);
  if (status.feed_id !== null && status.feed_id !== feedId) {
    fail("feed-status payload belongs to a different feedId");
  }
  const identity = parseLedgerEnvelope(
    parseJsonBytes(exact.identity, "ledger identity"),
    WALMART_LISTING_REPAIR_LEDGER_IDENTITY_SCHEMA,
    "ledger identity",
  );
  exactKeys(identity, [
    "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "created_at",
  ], "ledger identity body");
  if (identity.ledger_id !== permitBody.consumption_ledger.ledger_id
    || identity.ledger_epoch !== permitBody.consumption_ledger.ledger_epoch
    || identity.state_directory_path_sha256
      !== permitBody.consumption_ledger.state_directory_path_sha256
    || identity.directory_identity_sha256
      !== permitBody.consumption_ledger.directory_identity_sha256
    || sha256(exact.identity) !== permitBody.consumption_ledger.identity_artifact_sha256) {
    fail("ledger identity bytes differ from signed one-SKU permit");
  }
  const claim = parseLedgerEnvelope(
    parseJsonBytes(exact.claim, "ledger claim"),
    WALMART_LISTING_REPAIR_LEDGER_CLAIM_SCHEMA,
    "ledger claim",
  );
  exactKeys(claim, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "consumption_ledger",
  ], "ledger claim body");
  if (claim.authorization_sha256 !== permit.authorization_sha256 || claim.state !== "CLAIMED") {
    fail("ledger claim does not exclusively consume this exact permit");
  }
  exactLedgerBinding(claim.consumption_ledger, permitBody.consumption_ledger, "ledger claim binding");
  const requesting = parseLedgerEnvelope(
    parseJsonBytes(exact.requesting, "ledger requesting"),
    WALMART_LISTING_REPAIR_LEDGER_REQUESTING_SCHEMA,
    "ledger requesting",
  );
  exactKeys(requesting, [
    "authorization_sha256", "state", "claim_id", "claimed_at", "requesting_at",
    "claim_file_sha256", "request_manifest_sha256", "request_payload_sha256",
    "consumption_ledger",
  ], "ledger requesting body");
  if (requesting.authorization_sha256 !== permit.authorization_sha256
    || requesting.state !== "REQUESTING" || requesting.claim_id !== claim.claim_id
    || requesting.claimed_at !== claim.claimed_at
    || requesting.claim_file_sha256 !== sha256(exact.claim)
    || requesting.request_manifest_sha256 !== requestManifestSha
    || requesting.request_payload_sha256 !== requestPayloadSha) {
    fail("ledger REQUESTING artifact does not bind exact permit/request bytes");
  }
  exactLedgerBinding(
    requesting.consumption_ledger,
    permitBody.consumption_ledger,
    "ledger requesting binding",
  );
  const requestingAt = instant(requesting.requesting_at, "ledger requesting_at");
  if (Date.parse(requestingAt) > Date.parse(appliedAt)) {
    fail("durable REQUESTING state was not reached before marketplace write");
  }
  const terminal = parseLedgerEnvelope(
    parseJsonBytes(exact.terminal, "ledger terminal"),
    WALMART_LISTING_REPAIR_LEDGER_TERMINAL_SCHEMA,
    "ledger terminal",
  );
  exactKeys(terminal, [
    "authorization_sha256", "state", "consumption_id", "claim_id", "claimed_at",
    "requesting_at", "terminal_at", "requesting_file_sha256", "apply_id",
    "feed_id", "response_http_receipt_sha256", "response_payload_sha256",
    "feed_status_http_receipt_sha256", "feed_status_payload_sha256",
    "exact_listing_count", "marketplace_write_calls", "consumption_ledger",
  ], "ledger terminal body");
  const responseHttpSha = sha256(exact.responseHttp);
  const responseSha = sha256(exact.response);
  const statusHttpSha = sha256(exact.statusHttp);
  const statusSha = sha256(exact.status);
  if (terminal.authorization_sha256 !== permit.authorization_sha256
    || terminal.state !== "SUCCEEDED" || terminal.claim_id !== claim.claim_id
    || terminal.claimed_at !== claim.claimed_at || terminal.requesting_at !== requestingAt
    || terminal.requesting_file_sha256 !== sha256(exact.requesting)
    || terminal.feed_id !== feedId
    || terminal.response_http_receipt_sha256 !== responseHttpSha
    || terminal.response_payload_sha256 !== responseSha
    || terminal.feed_status_http_receipt_sha256 !== statusHttpSha
    || terminal.feed_status_payload_sha256 !== statusSha
    || terminal.exact_listing_count !== 1 || terminal.marketplace_write_calls !== 1) {
    fail("ledger terminal does not prove one successful exact raw Walmart exchange");
  }
  exactLedgerBinding(
    terminal.consumption_ledger,
    permitBody.consumption_ledger,
    "ledger terminal binding",
  );
  const feedConfirmedAt = instant(terminal.terminal_at, "ledger terminal_at");
  if (feedConfirmedAt !== statusHttp.captured_at) {
    fail("ledger terminal time differs from exact feed-status HTTP capture");
  }
  return {
    apply_id: safeId(terminal.apply_id, "ledger apply_id"),
    consumption_id: safeId(terminal.consumption_id, "ledger consumption_id"),
    permit_authorization_sha256: permit.authorization_sha256,
    applied_at: appliedAt,
    feed_confirmed_at: feedConfirmedAt,
    feed_id: feedId,
    apply_engine_release_sha256: permitBody.apply_engine_release_sha256,
    request_manifest_sha256: requestManifestSha,
    request_payload_sha256: requestPayloadSha,
    response_http_receipt_sha256: responseHttpSha,
    response_payload_sha256: responseSha,
    feed_status_http_receipt_sha256: statusHttpSha,
    feed_status_payload_sha256: statusSha,
    ledger_identity_sha256: sha256(exact.identity),
    ledger_claim_sha256: sha256(exact.claim),
    ledger_requesting_sha256: sha256(exact.requesting),
    ledger_terminal_sha256: sha256(exact.terminal),
    exact_listing_count: 1,
    marketplace_write_calls: 1,
  };
}

export function walmartListingRepairExactBytesSha256(value: Uint8Array): string {
  return sha256(bytes(value, "exact evidence bytes", MAX_PAYLOAD_BYTES));
}
