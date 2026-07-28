/**
 * Pure pre-write target-image certificate for Walmart Listing Integrity repair.
 *
 * Every accepted target is rebuilt from exact local bytes. Product identity is
 * anchored through an owner-approved Product Truth snapshot and the exact
 * source payload SHA stored by that snapshot. Vision authority comes only from
 * the existing signed v2 worker receipt verifier plus explicit local trust
 * pins. This module performs no I/O, network, model, database, or marketplace
 * operation.
 */

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  decideBlind,
  type AuditCase,
  type AuditImageInput,
} from "./catalog-visual-audit.ts";
import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  catalogTruthCanonicalSha256,
  compileWalmartCatalogTruthExport,
  type ProductTruthWalmartAuditSnapshot,
} from "./catalog-truth-export.ts";
import {
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  verifyWalmartListingObservationBatch,
  type WalmartListingWorkerReservationLedgerContract,
} from "./listing-integrity-observation.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
} from "./listing-integrity-remediation-qualification.ts";
import { walmartListingIntegritySha256 } from "./listing-integrity-audit.ts";

export const WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA =
  "walmart-listing-repair-target-image-certificate/v1" as const;
export const PRODUCT_TRUTH_EXACT_VARIANT_IMAGE_OBSERVATION_SCHEMA =
  "product-truth-exact-variant-image-observation/v1" as const;
export const PRODUCT_TRUTH_IMAGE_RIGHTS_EVIDENCE_SCHEMA =
  "product-truth-image-rights-evidence/v1" as const;

export const WALMART_LISTING_REPAIR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WALMART_LISTING_REPAIR_IMAGE_MIN_DIMENSION = 1_500;
export const WALMART_LISTING_REPAIR_IMAGE_MAX_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export const WALMART_LISTING_REPAIR_VISION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const WALMART_LISTING_REPAIR_LINEAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const WALMART_LISTING_REPAIR_RIGHTS_MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;
type TargetSlot = "main" | `gallery-${number}`;
type RightsBasis = "OWNED" | "LICENSED" | "SOURCE_ALLOWED"
  | "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS";

export interface ExactImageCertificateArtifact {
  bytes: Uint8Array;
  sha256: string;
}

export interface WalmartListingRepairImageWorkerTrust {
  run_lock_sha256: string;
  key_id: string;
  public_key_spki_sha256: string;
  worker_build: `sha256:${string}`;
  reservation_ledger: WalmartListingWorkerReservationLedgerContract;
}

export interface WalmartListingRepairTargetImageCertificateInput {
  slot: TargetSlot;
  downloaded_bytes: Uint8Array;
  content_type: "image/jpeg" | "image/png";
  requested_url: string;
  final_url: string;
  redirect_chain: string[];
  downloaded_at: string;
  fresh_until: string;
  derivation: "DIRECT_EXACT_ASSET" | "AI_COMPOSITE";
  represented_outer_unit_count: number;
  represented_component_id: string;
  represented_canonical_variant_id: string;
  represented_content_observation_id: string;
  product_truth_source_ref_id: string;
  exact_variant_image_observation: ExactImageCertificateArtifact;
  rights_evidence: ExactImageCertificateArtifact;
  vision_observation_batch: ExactImageCertificateArtifact;
}

export interface WalmartListingRepairImageCertificateInput {
  now: Date | string;
  plan: ExactImageCertificateArtifact;
  listing_projection: ExactImageCertificateArtifact;
  product_truth_snapshot: ExactImageCertificateArtifact;
  worker_trust: WalmartListingRepairImageWorkerTrust;
  targets: WalmartListingRepairTargetImageCertificateInput[];
}

export interface SealedWalmartListingRepairImageCertificate extends JsonRecord {
  schema_version: typeof WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA;
  certificate_id: string;
  created_at: string;
  expires_at: string;
  plan: {
    plan_id: string;
    body_sha256: string;
    artifact_sha256: string;
    target_sha256: string;
  };
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
    projection_artifact_sha256: string;
  };
  product_truth: {
    snapshot_id: string;
    snapshot_body_sha256: string;
    snapshot_artifact_sha256: string;
    revision_id: string;
    revision_body_sha256: string;
    approval_sha256: string;
    recipe_id: string;
    composition: "same_product";
    outer_unit_count: number;
  };
  worker_trust: WalmartListingRepairImageWorkerTrust;
  targets: Array<{
    slot: TargetSlot;
    ordinal: number;
    url: string;
    asset_sha256: string;
    byte_size: number;
    content_type: "image/jpeg" | "image/png";
    width: number;
    height: number;
    downloaded_at: string;
    fresh_until: string;
    derivation: "DIRECT_EXACT_ASSET" | "AI_COMPOSITE";
    represented_outer_unit_count: number;
    represented_component_id: string;
    represented_canonical_variant_id: string;
    represented_content_observation_id: string;
    product_truth_source_ref_id: string;
    exact_variant_image_observation_sha256: string;
    exact_variant_image_observation_id: string;
    rights_evidence_sha256: string;
    rights_evidence_id: string;
    rights_basis: RightsBasis;
    vision_batch_artifact_sha256: string;
    vision_batch_body_sha256: string;
    vision_receipt_key_id: string;
    vision_receipt_public_key_spki_sha256: string;
    vision_worker_build: `sha256:${string}`;
    vision_reservation_ledger_id: `ledger-${string}`;
    vision_reservation_ledger_epoch: `epoch-${string}`;
    vision_issued_at: string;
    deterministic_visual_verdict: "PASS";
    deterministic_visual_decision_sha256: string;
  }>;
  policy: {
    exact_downloaded_bytes_verified: true;
    exact_variant_lineage_verified: true;
    rights_evidence_verified: true;
    signed_worker_v2_receipts_verified: true;
    query_free_urls_verified: true;
    redirects_absent_verified: true;
    slots_unique_and_contiguous: true;
    mixed_bundle_supported: false;
    authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY";
    owner_permit_must_bind_certificate_sha256: true;
  };
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart target-image certificate rejected: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has missing or extra fields`);
  }
}

function text(value: unknown, label: string, max = 1_000): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must be a non-empty exact string`);
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) fail(`${label} must be canonical UTC milliseconds`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactBytes(artifact: ExactImageCertificateArtifact, label: string, max = 256 * 1024 * 1024): Buffer {
  if (!(artifact?.bytes instanceof Uint8Array) || artifact.bytes.byteLength < 1
    || artifact.bytes.byteLength > max) fail(`${label}.bytes are missing or exceed the cap`);
  const expected = digest(artifact.sha256, `${label}.sha256`);
  const bytes = Buffer.from(artifact.bytes);
  if (sha256Bytes(bytes) !== expected) fail(`${label} exact byte SHA mismatch`);
  return bytes;
}

function parseJsonArtifact(artifact: ExactImageCertificateArtifact, label: string): {
  bytes: Buffer; value: JsonRecord; sha256: string;
} {
  const bytes = exactBytes(artifact, label);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} must be exact UTF-8 JSON bytes`);
  }
  return { bytes, value: record(value, label), sha256: artifact.sha256 };
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return walmartListingIntegritySha256(left) === walmartListingIntegritySha256(right);
}

function queryFreeHttps(value: unknown, label: string): string {
  const raw = text(value, label, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.toString() !== raw) fail(`${label} must be canonical query-free HTTPS without credentials or fragment`);
  return raw;
}

function verifyWindow(
  from: unknown,
  until: unknown,
  nowMs: number,
  maxWindowMs: number,
  label: string,
): { from: string; until: string } {
  const start = instant(from, `${label}.from`);
  const end = instant(until, `${label}.until`);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (endMs <= startMs || endMs - startMs > maxWindowMs || nowMs < startMs || nowMs >= endMs) {
    fail(`${label} is stale, future-dated, expired, or wider than policy`);
  }
  return { from: start, until: end };
}

function parseSealedBody(raw: JsonRecord, label: string): JsonRecord {
  const claimed = digest(raw.body_sha256, `${label}.body_sha256`);
  const body = { ...raw };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) fail(`${label} body SHA mismatch`);
  return body;
}

function validateProductTruthSnapshot(raw: JsonRecord): ProductTruthWalmartAuditSnapshot {
  if (raw.schema_version !== PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA) {
    fail("Product Truth snapshot schema is unsupported");
  }
  const capturedAt = text(raw.captured_at, "Product Truth snapshot captured_at", 100);
  const emptyIndexBody = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: capturedAt,
    entries: [],
  };
  const emptyIndexSha = catalogTruthCanonicalSha256(emptyIndexBody);
  try {
    compileWalmartCatalogTruthExport(raw, {
      ...emptyIndexBody,
      index_id: `walmart-buyer-index-${emptyIndexSha.slice(0, 16)}`,
      body_sha256: emptyIndexSha,
    });
  } catch (error) {
    fail(`Product Truth snapshot does not pass the canonical parser: ${error instanceof Error ? error.message : String(error)}`);
  }
  return raw as unknown as ProductTruthWalmartAuditSnapshot;
}

function parseRightsEvidence(raw: JsonRecord, nowMs: number) {
  exactKeys(raw, [
    "schema_version", "evidence_id", "basis", "canonical_variant_id",
    "content_observation_id", "scope", "issued_at", "expires_at", "grantor",
    "terms_reference", "body_sha256",
  ], "rights evidence");
  if (raw.schema_version !== PRODUCT_TRUTH_IMAGE_RIGHTS_EVIDENCE_SCHEMA
    || raw.scope !== "WALMART_US_LISTING") fail("rights evidence schema or scope is invalid");
  const basis = raw.basis;
  if (basis !== "OWNED" && basis !== "LICENSED" && basis !== "SOURCE_ALLOWED"
    && basis !== "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS") fail("rights evidence basis is invalid");
  parseSealedBody(raw, "rights evidence");
  const window = verifyWindow(
    raw.issued_at,
    raw.expires_at,
    nowMs,
    WALMART_LISTING_REPAIR_RIGHTS_MAX_WINDOW_MS,
    "rights evidence window",
  );
  return {
    evidence_id: text(raw.evidence_id, "rights evidence_id"),
    basis: basis as RightsBasis,
    canonical_variant_id: text(raw.canonical_variant_id, "rights canonical_variant_id"),
    content_observation_id: text(raw.content_observation_id, "rights content_observation_id"),
    grantor: text(raw.grantor, "rights grantor"),
    terms_reference: queryFreeHttps(raw.terms_reference, "rights terms_reference"),
    ...window,
  };
}

function parseExactVariantObservation(raw: JsonRecord, nowMs: number) {
  exactKeys(raw, [
    "schema_version", "observation_id", "immutable", "source_ref_id", "component_id",
    "canonical_variant_id", "content_observation_id", "captured_at", "fresh_until",
    "image", "rights", "body_sha256",
  ], "exact-variant image observation");
  if (raw.schema_version !== PRODUCT_TRUTH_EXACT_VARIANT_IMAGE_OBSERVATION_SCHEMA
    || raw.immutable !== true) fail("exact-variant image observation schema/immutability is invalid");
  parseSealedBody(raw, "exact-variant image observation");
  const freshness = verifyWindow(
    raw.captured_at,
    raw.fresh_until,
    nowMs,
    WALMART_LISTING_REPAIR_LINEAGE_MAX_AGE_MS,
    "exact-variant observation freshness",
  );
  const image = record(raw.image, "exact-variant observation.image");
  exactKeys(image, [
    "source_url", "final_url", "redirect_chain", "sha256", "byte_size", "content_type",
    "width", "height",
  ], "exact-variant observation.image");
  const sourceUrl = queryFreeHttps(image.source_url, "exact-variant observation source_url");
  const finalUrl = queryFreeHttps(image.final_url, "exact-variant observation final_url");
  if (sourceUrl !== finalUrl || !Array.isArray(image.redirect_chain) || image.redirect_chain.length !== 0) {
    fail("exact-variant observation has redirect ambiguity");
  }
  if (image.content_type !== "image/jpeg" && image.content_type !== "image/png") {
    fail("exact-variant observation content_type is unsupported");
  }
  const rights = record(raw.rights, "exact-variant observation.rights");
  exactKeys(rights, ["basis", "evidence_id", "evidence_artifact_sha256"], "exact-variant observation.rights");
  if (rights.basis !== "OWNED" && rights.basis !== "LICENSED" && rights.basis !== "SOURCE_ALLOWED"
    && rights.basis !== "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS") fail("observation rights basis is invalid");
  return {
    observation_id: text(raw.observation_id, "image observation_id"),
    source_ref_id: text(raw.source_ref_id, "image observation source_ref_id"),
    component_id: text(raw.component_id, "image observation component_id"),
    canonical_variant_id: text(raw.canonical_variant_id, "image observation canonical_variant_id"),
    content_observation_id: text(raw.content_observation_id, "image observation content_observation_id"),
    ...freshness,
    image: {
      source_url: sourceUrl,
      sha256: digest(image.sha256, "image observation SHA"),
      byte_size: positiveInteger(image.byte_size, "image observation byte_size"),
      content_type: image.content_type as "image/jpeg" | "image/png",
      width: positiveInteger(image.width, "image observation width"),
      height: positiveInteger(image.height, "image observation height"),
    },
    rights: {
      basis: rights.basis as RightsBasis,
      evidence_id: text(rights.evidence_id, "observation rights evidence_id"),
      evidence_artifact_sha256: digest(
        rights.evidence_artifact_sha256,
        "observation rights evidence artifact SHA",
      ),
    },
  };
}

async function inspectImage(bytes: Buffer, contentType: string) {
  let metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 }).metadata();
  } catch {
    return fail("downloaded target bytes are not a decodable image");
  }
  const expectedFormat = contentType === "image/png" ? "png" : "jpeg";
  if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) {
    fail("downloaded image format/content-type/dimensions mismatch");
  }
  if (metadata.width !== metadata.height
    || metadata.width < WALMART_LISTING_REPAIR_IMAGE_MIN_DIMENSION
    || metadata.height < WALMART_LISTING_REPAIR_IMAGE_MIN_DIMENSION) {
    fail("target image must be square and at least 1500x1500");
  }
  return { width: metadata.width, height: metadata.height };
}

function parsePlan(raw: JsonRecord, nowMs: number): SealedWalmartListingRepairPlan {
  if (raw.schema_version !== WALMART_LISTING_REPAIR_PLAN_SCHEMA) fail("repair plan schema is invalid");
  parseSealedBody(raw, "repair plan");
  const createdAt = instant(raw.created_at, "repair plan created_at");
  const expiresAt = instant(raw.expires_at, "repair plan expires_at");
  if (nowMs < Date.parse(createdAt) || nowMs >= Date.parse(expiresAt)) fail("repair plan is not currently valid");
  return raw as unknown as SealedWalmartListingRepairPlan;
}

function expectedSlots(length: number): TargetSlot[] {
  return Array.from(
    { length },
    (_, index): TargetSlot => (index === 0 ? "main" : `gallery-${index}`),
  );
}

function canonicalCertificateJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCertificateJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const raw = value as JsonRecord;
    return `{${Object.keys(raw).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalCertificateJson(raw[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("certificate canonical JSON rejects undefined");
  return encoded;
}

/**
 * Parse exact canonical certificate bytes and bind the sealed evidence-only
 * claim to the exact repair plan at the instant the surgical request was
 * prepared. This proves the certifier's sealed output, not its source evidence;
 * source evidence is verified only by certifyWalmartListingRepairTargetImages.
 */
export function verifyWalmartListingRepairTargetImageCertificateBytes(input: {
  certificate_bytes: Uint8Array;
  plan: SealedWalmartListingRepairPlan;
  at: Date | string;
}): SealedWalmartListingRepairImageCertificate {
  if (!(input.certificate_bytes instanceof Uint8Array)
    || input.certificate_bytes.byteLength < 1
    || input.certificate_bytes.byteLength > 64 * 1024 * 1024) {
    fail("certificate bytes are missing or exceed the 64 MiB cap");
  }
  const certificateBytes = Buffer.from(input.certificate_bytes);
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(certificateBytes);
    if (decoded.charCodeAt(0) === 0xfeff) fail("certificate bytes contain a UTF-8 BOM");
    parsed = JSON.parse(decoded);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Walmart target-image certificate rejected:")) {
      throw error;
    }
    return fail("certificate bytes must be exact UTF-8 JSON");
  }
  const raw = record(parsed, "certificate");
  if (decoded !== canonicalCertificateJson(raw)) {
    fail("certificate bytes must use exact canonical JSON without trailing bytes");
  }
  exactKeys(raw, [
    "schema_version", "certificate_id", "created_at", "expires_at", "plan", "listing",
    "product_truth", "worker_trust", "targets", "policy", "body_sha256",
  ], "certificate");
  if (raw.schema_version !== WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA) {
    fail("certificate schema is unsupported");
  }

  const bodySha = digest(raw.body_sha256, "certificate body_sha256");
  const body = { ...raw };
  delete body.certificate_id;
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== bodySha) fail("certificate body SHA mismatch");
  if (text(raw.certificate_id, "certificate_id", 128)
    !== `walmart-image-certificate-${bodySha.slice(0, 20)}`) {
    fail("certificate_id does not derive from body_sha256");
  }

  const at = input.at instanceof Date ? input.at.toISOString() : instant(input.at, "verification at");
  const atMs = Date.parse(at);
  const createdAt = instant(raw.created_at, "certificate created_at");
  const expiresAt = instant(raw.expires_at, "certificate expires_at");
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= createdMs || atMs < createdMs || atMs >= expiresMs) {
    fail("certificate was not fresh when the surgical request was prepared");
  }

  const planRaw = record(input.plan, "bound repair plan");
  if (planRaw.schema_version !== WALMART_LISTING_REPAIR_PLAN_SCHEMA) {
    fail("bound repair plan schema is invalid");
  }
  parseSealedBody(planRaw, "bound repair plan");
  const planCreatedAt = instant(planRaw.created_at, "bound repair plan created_at");
  const planExpiresAt = instant(planRaw.expires_at, "bound repair plan expires_at");
  if (createdMs < Date.parse(planCreatedAt) || expiresMs > Date.parse(planExpiresAt)) {
    fail("certificate freshness window escapes the bound repair plan");
  }
  if (walmartListingIntegritySha256({
    surface: input.plan.target.surface,
    images: input.plan.target.images,
  }) !== input.plan.target.target_sha256) {
    fail("bound repair plan target SHA does not rebuild");
  }

  const plan = record(raw.plan, "certificate.plan");
  exactKeys(plan, [
    "plan_id", "body_sha256", "artifact_sha256", "target_sha256",
  ], "certificate.plan");
  if (text(plan.plan_id, "certificate plan_id") !== input.plan.plan_id
    || digest(plan.body_sha256, "certificate plan body SHA") !== input.plan.body_sha256
    || digest(plan.target_sha256, "certificate target SHA")
      !== input.plan.target.target_sha256) {
    fail("certificate plan/target binding differs from the exact repair plan");
  }
  digest(plan.artifact_sha256, "certificate plan artifact SHA");

  const listing = record(raw.listing, "certificate.listing");
  exactKeys(listing, [
    "channel", "store_index", "sku", "listing_key", "item_id",
    "projection_artifact_sha256",
  ], "certificate.listing");
  if (listing.channel !== "WALMART_US"
    || nonNegativeInteger(listing.store_index, "certificate listing store_index")
      !== input.plan.listing.store_index
    || text(listing.sku, "certificate listing SKU") !== input.plan.listing.sku
    || text(listing.listing_key, "certificate listing_key") !== input.plan.listing.listing_key
    || text(listing.item_id, "certificate item_id") !== input.plan.listing.item_id) {
    fail("certificate listing binding differs from the exact repair plan");
  }
  digest(listing.projection_artifact_sha256, "certificate listing projection SHA");

  const productTruth = record(raw.product_truth, "certificate.product_truth");
  exactKeys(productTruth, [
    "snapshot_id", "snapshot_body_sha256", "snapshot_artifact_sha256", "revision_id",
    "revision_body_sha256", "approval_sha256", "recipe_id", "composition",
    "outer_unit_count",
  ], "certificate.product_truth");
  if (text(productTruth.snapshot_id, "certificate Product Truth snapshot_id")
      !== input.plan.product_truth.product_truth_snapshot_id
    || digest(productTruth.snapshot_body_sha256, "certificate Product Truth snapshot body SHA")
      !== input.plan.product_truth.product_truth_snapshot_body_sha256
    || digest(productTruth.snapshot_artifact_sha256, "certificate Product Truth snapshot artifact SHA")
      !== input.plan.product_truth.product_truth_snapshot_file_sha256
    || text(productTruth.revision_id, "certificate Product Truth revision_id")
      !== input.plan.product_truth.truth_revision_id
    || digest(productTruth.revision_body_sha256, "certificate Product Truth revision body SHA")
      !== input.plan.product_truth.truth_revision_body_sha256
    || digest(productTruth.approval_sha256, "certificate Product Truth approval SHA")
      !== input.plan.product_truth.truth_approval_sha256
    || productTruth.composition !== "same_product") {
    fail("certificate Product Truth binding differs from the exact repair plan");
  }
  text(productTruth.recipe_id, "certificate Product Truth recipe_id");
  const outerUnitCount = positiveInteger(
    productTruth.outer_unit_count,
    "certificate Product Truth outer_unit_count",
  );

  const workerTrust = record(raw.worker_trust, "certificate.worker_trust");
  exactKeys(workerTrust, [
    "run_lock_sha256", "key_id", "public_key_spki_sha256", "worker_build",
    "reservation_ledger",
  ], "certificate.worker_trust");
  digest(workerTrust.run_lock_sha256, "certificate worker run-lock SHA");
  text(workerTrust.key_id, "certificate worker key_id");
  const workerKeySha = digest(
    workerTrust.public_key_spki_sha256,
    "certificate worker public-key SHA",
  );
  const workerBuild = text(workerTrust.worker_build, "certificate worker build", 80);
  if (!/^sha256:[a-f0-9]{64}$/u.test(workerBuild)) fail("certificate worker build is invalid");
  const reservation = record(
    workerTrust.reservation_ledger,
    "certificate.worker_trust.reservation_ledger",
  );
  exactKeys(reservation, [
    "schema_version", "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "identity_artifact_sha256",
  ], "certificate.worker_trust.reservation_ledger");
  const ledgerId = text(reservation.ledger_id, "certificate reservation ledger_id");
  const ledgerEpoch = text(reservation.ledger_epoch, "certificate reservation ledger_epoch");
  if (reservation.schema_version !== WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA
    || !/^ledger-/u.test(ledgerId) || !/^epoch-/u.test(ledgerEpoch)) {
    fail("certificate reservation-ledger identity is invalid");
  }
  digest(reservation.state_directory_path_sha256, "certificate reservation path SHA");
  digest(reservation.directory_identity_sha256, "certificate reservation directory SHA");
  digest(reservation.identity_artifact_sha256, "certificate reservation identity SHA");

  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 20
    || raw.targets.length !== input.plan.target.images.length) {
    fail("certificate target population differs from the exact repair plan");
  }
  const targetSlots: TargetSlot[] = [];
  const targetUrls: string[] = [];
  for (const [index, value] of raw.targets.entries()) {
    const target = record(value, `certificate.targets[${index}]`);
    exactKeys(target, [
      "slot", "ordinal", "url", "asset_sha256", "byte_size", "content_type", "width",
      "height", "downloaded_at", "fresh_until", "derivation",
      "represented_outer_unit_count", "represented_component_id",
      "represented_canonical_variant_id", "represented_content_observation_id",
      "product_truth_source_ref_id", "exact_variant_image_observation_sha256",
      "exact_variant_image_observation_id", "rights_evidence_sha256", "rights_evidence_id",
      "rights_basis", "vision_batch_artifact_sha256", "vision_batch_body_sha256",
      "vision_receipt_key_id", "vision_receipt_public_key_spki_sha256",
      "vision_worker_build", "vision_reservation_ledger_id",
      "vision_reservation_ledger_epoch", "vision_issued_at",
      "deterministic_visual_verdict", "deterministic_visual_decision_sha256",
    ], `certificate.targets[${index}]`);
    const expected = input.plan.target.images[index]!;
    const slot = text(target.slot, `certificate target ${index} slot`) as TargetSlot;
    const url = queryFreeHttps(target.url, `certificate target ${index} URL`);
    if (slot !== expected.slot || url !== expected.source_url
      || digest(target.asset_sha256, `certificate target ${index} asset SHA`) !== expected.sha256
      || nonNegativeInteger(target.ordinal, `certificate target ${index} ordinal`) !== index) {
      fail(`certificate target ${index} differs from the exact repair-plan image`);
    }
    targetSlots.push(slot);
    targetUrls.push(url);
    const byteSize = positiveInteger(target.byte_size, `certificate target ${index} byte_size`);
    const width = positiveInteger(target.width, `certificate target ${index} width`);
    const height = positiveInteger(target.height, `certificate target ${index} height`);
    if (byteSize > WALMART_LISTING_REPAIR_IMAGE_MAX_BYTES
      || (target.content_type !== "image/jpeg" && target.content_type !== "image/png")
      || width !== height || width < WALMART_LISTING_REPAIR_IMAGE_MIN_DIMENSION) {
      fail(`certificate target ${index} media facts violate image policy`);
    }
    const downloadedAt = instant(target.downloaded_at, `certificate target ${index} downloaded_at`);
    const freshUntil = instant(target.fresh_until, `certificate target ${index} fresh_until`);
    if (createdMs < Date.parse(downloadedAt) || createdMs >= Date.parse(freshUntil)
      || Date.parse(freshUntil) - Date.parse(downloadedAt)
        > WALMART_LISTING_REPAIR_IMAGE_MAX_FRESHNESS_MS
      || expiresMs > Date.parse(freshUntil)) {
      fail(`certificate target ${index} image freshness is invalid`);
    }
    if (target.derivation !== "DIRECT_EXACT_ASSET" && target.derivation !== "AI_COMPOSITE") {
      fail(`certificate target ${index} derivation is invalid`);
    }
    if (positiveInteger(
      target.represented_outer_unit_count,
      `certificate target ${index} represented count`,
    ) !== outerUnitCount) {
      fail(`certificate target ${index} represented count differs from Product Truth`);
    }
    text(target.represented_component_id, `certificate target ${index} component_id`);
    text(target.represented_canonical_variant_id, `certificate target ${index} variant_id`);
    text(target.represented_content_observation_id, `certificate target ${index} content_id`);
    text(target.product_truth_source_ref_id, `certificate target ${index} source_ref_id`);
    digest(target.exact_variant_image_observation_sha256, `certificate target ${index} observation SHA`);
    text(target.exact_variant_image_observation_id, `certificate target ${index} observation_id`);
    digest(target.rights_evidence_sha256, `certificate target ${index} rights SHA`);
    text(target.rights_evidence_id, `certificate target ${index} rights_id`);
    if (target.rights_basis !== "OWNED" && target.rights_basis !== "LICENSED"
      && target.rights_basis !== "SOURCE_ALLOWED"
      && target.rights_basis !== "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS") {
      fail(`certificate target ${index} rights basis is invalid`);
    }
    digest(target.vision_batch_artifact_sha256, `certificate target ${index} vision artifact SHA`);
    digest(target.vision_batch_body_sha256, `certificate target ${index} vision body SHA`);
    if (text(target.vision_receipt_key_id, `certificate target ${index} vision key_id`)
        !== workerTrust.key_id
      || digest(
        target.vision_receipt_public_key_spki_sha256,
        `certificate target ${index} vision public-key SHA`,
      ) !== workerKeySha
      || text(target.vision_worker_build, `certificate target ${index} vision build`, 80)
        !== workerBuild
      || text(target.vision_reservation_ledger_id, `certificate target ${index} ledger_id`)
        !== ledgerId
      || text(target.vision_reservation_ledger_epoch, `certificate target ${index} ledger_epoch`)
        !== ledgerEpoch) {
      fail(`certificate target ${index} vision trust differs from certificate worker trust`);
    }
    const visionIssuedAt = instant(
      target.vision_issued_at,
      `certificate target ${index} vision issued_at`,
    );
    if (Date.parse(visionIssuedAt) > createdMs
      || createdMs - Date.parse(visionIssuedAt) > WALMART_LISTING_REPAIR_VISION_MAX_AGE_MS
      || target.deterministic_visual_verdict !== "PASS") {
      fail(`certificate target ${index} vision evidence is stale or not PASS`);
    }
    digest(
      target.deterministic_visual_decision_sha256,
      `certificate target ${index} visual decision SHA`,
    );
  }
  if (!exactJsonEqual(targetSlots, expectedSlots(raw.targets.length))
    || new Set(targetUrls).size !== targetUrls.length) {
    fail("certificate target slots/URLs are not unique and contiguous");
  }

  const policy = record(raw.policy, "certificate.policy");
  exactKeys(policy, [
    "exact_downloaded_bytes_verified", "exact_variant_lineage_verified",
    "rights_evidence_verified", "signed_worker_v2_receipts_verified",
    "query_free_urls_verified", "redirects_absent_verified",
    "slots_unique_and_contiguous", "mixed_bundle_supported", "authority",
    "owner_permit_must_bind_certificate_sha256",
  ], "certificate.policy");
  if (policy.exact_downloaded_bytes_verified !== true
    || policy.exact_variant_lineage_verified !== true
    || policy.rights_evidence_verified !== true
    || policy.signed_worker_v2_receipts_verified !== true
    || policy.query_free_urls_verified !== true
    || policy.redirects_absent_verified !== true
    || policy.slots_unique_and_contiguous !== true
    || policy.mixed_bundle_supported !== false
    || policy.authority !== "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY"
    || policy.owner_permit_must_bind_certificate_sha256 !== true) {
    fail("certificate policy is not the exact evidence-only claim");
  }

  return raw as unknown as SealedWalmartListingRepairImageCertificate;
}

/** Verify all exact evidence and return the deterministic sealed certificate. */
export async function certifyWalmartListingRepairTargetImages(
  input: WalmartListingRepairImageCertificateInput,
): Promise<SealedWalmartListingRepairImageCertificate> {
  const now = input.now instanceof Date ? input.now.toISOString() : instant(input.now, "now");
  const nowMs = Date.parse(now);
  const planArtifact = parseJsonArtifact(input.plan, "repair plan artifact");
  const plan = parsePlan(planArtifact.value, nowMs);
  const listingArtifact = parseJsonArtifact(input.listing_projection, "listing projection artifact");
  if (!exactJsonEqual(listingArtifact.value, plan.target.surface)) {
    fail("listing projection exact bytes do not parse to the plan target surface");
  }
  if (plan.target.target_sha256 !== walmartListingIntegritySha256({
    surface: plan.target.surface,
    images: plan.target.images,
  })) fail("repair plan target SHA does not rebuild");
  if (plan.listing.channel !== "WALMART_US" || plan.listing.composition !== "same_product") {
    fail("mixed bundle/variety is unsupported without component-aware signed vision facts");
  }

  const truthArtifact = parseJsonArtifact(input.product_truth_snapshot, "Product Truth snapshot artifact");
  if (truthArtifact.sha256 !== plan.product_truth.product_truth_snapshot_file_sha256) {
    fail("Product Truth snapshot file SHA differs from the plan");
  }
  const truth = validateProductTruthSnapshot(truthArtifact.value);
  if (truth.snapshot_id !== plan.product_truth.product_truth_snapshot_id
    || truth.body_sha256 !== plan.product_truth.product_truth_snapshot_body_sha256) {
    fail("Product Truth snapshot identity differs from the plan");
  }
  const truthRows = truth.rows.filter((row) => row.listing_key === plan.listing.listing_key);
  if (truthRows.length !== 1 || truthRows[0]!.sku !== plan.listing.sku
    || truthRows[0]!.store_index !== plan.listing.store_index
    || truthRows[0]!.item_id !== plan.listing.item_id) fail("exact Product Truth listing row is missing or ambiguous");
  const truthRow = truthRows[0]!;
  const revision = truthRow.revision;
  if (revision.revision_id !== plan.product_truth.truth_revision_id
    || revision.body_sha256 !== plan.product_truth.truth_revision_body_sha256
    || revision.approval?.approval_sha256 !== plan.product_truth.truth_approval_sha256
    || revision.superseded_by_revision_id !== null || revision.approval?.decision !== "approved") {
    fail("Product Truth revision/approval is not the exact current plan revision");
  }
  if (revision.recipe.composition !== "same_product" || revision.recipe.components.length !== 1
    || revision.structured_record.components.length !== 1) {
    fail("mixed bundle/variety lacks component-aware signed vision facts and must fail closed");
  }
  const component = revision.recipe.components[0]!;
  const outerUnits = revision.recipe.outer_units;
  if (outerUnits === null || outerUnits !== revision.structured_record.outer_units
    || component.quantity !== outerUnits
    || revision.structured_record.components[0]!.component_id !== component.component_id
    || revision.structured_record.components[0]!.quantity !== outerUnits
    || revision.proposed_truth.outer_units !== outerUnits
    || !revision.proposed_truth.identity || !revision.proposed_truth.package_facts) {
    fail("Product Truth component/count/identity/package facts are incomplete or disagree");
  }

  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 20
    || input.targets.length !== plan.target.images.length) fail("target image population differs from the plan");
  const slots = input.targets.map((target) => target.slot);
  if (!exactJsonEqual(slots, expectedSlots(input.targets.length)) || new Set(slots).size !== slots.length) {
    fail("target slots must be unique and ordered main, gallery-1..N");
  }
  if (new Set(input.targets.map((target) => target.requested_url)).size !== input.targets.length) {
    fail("target URLs must be unique");
  }

  const trust = input.worker_trust;
  const runLockSha = digest(trust.run_lock_sha256, "worker trust run-lock SHA");
  const trustedKeySha = digest(trust.public_key_spki_sha256, "worker trust public key SHA");
  if (!/^sha256:[a-f0-9]{64}$/u.test(trust.worker_build)) fail("worker trust build is invalid");
  const sourceEvidenceById = new Map(revision.source_evidence.map((row) => [row.source_ref_id, row]));
  const certifiedTargets: SealedWalmartListingRepairImageCertificate["targets"] = [];
  const expiryCandidates = [Date.parse(plan.expires_at)];

  for (const [index, target] of input.targets.entries()) {
    const label = `target ${target.slot}`;
    const planned = plan.target.images[index]!;
    if (planned.slot !== target.slot) fail(`${label} slot differs from plan`);
    const requestedUrl = queryFreeHttps(target.requested_url, `${label} requested_url`);
    const finalUrl = queryFreeHttps(target.final_url, `${label} final_url`);
    if (requestedUrl !== finalUrl || requestedUrl !== planned.source_url
      || !Array.isArray(target.redirect_chain) || target.redirect_chain.length !== 0) {
      fail(`${label} has query/redirect/final-URL ambiguity`);
    }
    const downloadWindow = verifyWindow(
      target.downloaded_at,
      target.fresh_until,
      nowMs,
      WALMART_LISTING_REPAIR_IMAGE_MAX_FRESHNESS_MS,
      `${label} download freshness`,
    );
    expiryCandidates.push(Date.parse(downloadWindow.until));
    if (target.content_type !== "image/jpeg" && target.content_type !== "image/png") {
      fail(`${label} content_type is unsupported`);
    }
    if (!(target.downloaded_bytes instanceof Uint8Array) || target.downloaded_bytes.byteLength < 1
      || target.downloaded_bytes.byteLength > WALMART_LISTING_REPAIR_IMAGE_MAX_BYTES) {
      fail(`${label} bytes are missing or exceed Walmart's 5 MB policy cap`);
    }
    const downloadedBytes = Buffer.from(target.downloaded_bytes);
    const assetSha = sha256Bytes(downloadedBytes);
    if (assetSha !== planned.sha256) fail(`${label} exact downloaded bytes differ from plan SHA`);
    const dimensions = await inspectImage(downloadedBytes, target.content_type);

    const observationArtifact = parseJsonArtifact(
      target.exact_variant_image_observation,
      `${label} exact-variant image observation`,
    );
    const source = sourceEvidenceById.get(target.product_truth_source_ref_id);
    if (!source || source.payload_sha256 !== observationArtifact.sha256
      || !source.supports.includes("component_truth")
      || !component.source_ref_ids.includes(source.source_ref_id)
      || source.source_kind === "donor_image") {
      fail(`${label} image observation is not SHA-anchored as authoritative component truth`);
    }
    const observation = parseExactVariantObservation(observationArtifact.value, nowMs);
    expiryCandidates.push(Date.parse(observation.until));
    if (observation.source_ref_id !== source.source_ref_id
      || observation.component_id !== component.component_id
      || observation.component_id !== target.represented_component_id
      || observation.canonical_variant_id !== target.represented_canonical_variant_id
      || observation.content_observation_id !== target.represented_content_observation_id
      || target.represented_outer_unit_count !== outerUnits) {
      fail(`${label} exact variant/component/content observation/count lineage differs from Product Truth`);
    }
    if (target.derivation === "DIRECT_EXACT_ASSET"
      && (observation.image.sha256 !== assetSha
        || observation.image.byte_size !== downloadedBytes.byteLength
        || observation.image.content_type !== target.content_type
        || observation.image.width !== dimensions.width
        || observation.image.height !== dimensions.height
        || observation.image.source_url !== requestedUrl)) {
      fail(`${label} direct asset differs from its immutable Product Truth image observation`);
    }
    if (target.derivation === "AI_COMPOSITE"
      && observation.rights.basis !== "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS") {
      fail(`${label} AI composite lacks AI-derived rights lineage`);
    }

    const rightsArtifact = parseJsonArtifact(target.rights_evidence, `${label} rights evidence`);
    if (rightsArtifact.sha256 !== observation.rights.evidence_artifact_sha256) {
      fail(`${label} rights bytes differ from Product Truth image observation`);
    }
    const rights = parseRightsEvidence(rightsArtifact.value, nowMs);
    expiryCandidates.push(Date.parse(rights.until));
    if (rights.evidence_id !== observation.rights.evidence_id
      || rights.basis !== observation.rights.basis
      || rights.canonical_variant_id !== observation.canonical_variant_id
      || rights.content_observation_id !== observation.content_observation_id) {
      fail(`${label} rights evidence does not cover the exact variant/content observation`);
    }

    const batchArtifact = parseJsonArtifact(
      target.vision_observation_batch,
      `${label} signed vision batch`,
    );
    let batch;
    try {
      batch = verifyWalmartListingObservationBatch(batchArtifact.value, runLockSha);
    } catch (error) {
      fail(`${label} signed vision-worker v2 artifact is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (batch.worker_receipt.key_id !== trust.key_id
      || batch.worker_receipt.public_key_spki_sha256 !== trustedKeySha
      || batch.worker_contract.worker_build !== trust.worker_build
      || !exactJsonEqual(batch.worker_contract.reservation_ledger, trust.reservation_ledger)) {
      fail(`${label} worker key/build/reservation-ledger identity or epoch differs from trust pins`);
    }
    const issuedAt = batch.worker_receipt.body.issued_at;
    if (Date.parse(issuedAt) > nowMs || nowMs - Date.parse(issuedAt) > WALMART_LISTING_REPAIR_VISION_MAX_AGE_MS
      || nowMs >= Date.parse(batch.execution_permit.body.expires_at)) {
      fail(`${label} signed vision receipt is stale or its execution permit expired`);
    }
    expiryCandidates.push(Date.parse(batch.execution_permit.body.expires_at));
    const bindings = batch.image_bindings.filter((binding) => (
      binding.listing_key === plan.listing.listing_key
      && binding.item_id === plan.listing.item_id
      && binding.slot === target.slot
    ));
    if (bindings.length !== 1 || bindings[0]!.asset_sha256 !== assetSha
      || bindings[0]!.model_view_sha256 !== assetSha) {
      fail(`${label} signed worker request did not inspect the exact downloaded bytes directly`);
    }
    const observationRows = batch.result.observations.filter(
      (row) => row.image_id === bindings[0]!.image_id,
    );
    const ocrRows = batch.local_ocr.filter((row) => row.image_id === bindings[0]!.image_id);
    if (observationRows.length !== 1 || ocrRows.length !== 1) {
      fail(`${label} signed vision result/OCR population is missing or ambiguous`);
    }
    const auditCase: AuditCase = {
      case_id: `certificate:${plan.plan_id}:${target.slot}`,
      sku: plan.listing.sku,
      expected: {
        title: plan.target.surface.title,
        outer_units: outerUnits,
        identity: revision.proposed_truth.identity,
        package_facts: revision.proposed_truth.package_facts,
        truth_source: revision.proposed_truth.truth_source,
      },
      images: [],
    };
    const auditImage: AuditImageInput = {
      slot: target.slot,
      url: requestedUrl,
      buyer_facing_verified: true,
      surface: "last_applied_artifact",
    };
    const decision = decideBlind(auditCase, auditImage, observationRows[0]!, ocrRows[0]!.auxiliary_ocr);
    if (decision.verdict !== "PASS") {
      fail(`${label} deterministic exact-product/count visual verdict is ${decision.verdict}: ${[
        ...decision.hard_failures, ...decision.unknowns,
      ].join("; ")}`);
    }

    certifiedTargets.push({
      slot: target.slot,
      ordinal: index,
      url: requestedUrl,
      asset_sha256: assetSha,
      byte_size: downloadedBytes.byteLength,
      content_type: target.content_type,
      width: dimensions.width,
      height: dimensions.height,
      downloaded_at: downloadWindow.from,
      fresh_until: downloadWindow.until,
      derivation: target.derivation,
      represented_outer_unit_count: outerUnits,
      represented_component_id: observation.component_id,
      represented_canonical_variant_id: observation.canonical_variant_id,
      represented_content_observation_id: observation.content_observation_id,
      product_truth_source_ref_id: source.source_ref_id,
      exact_variant_image_observation_sha256: observationArtifact.sha256,
      exact_variant_image_observation_id: observation.observation_id,
      rights_evidence_sha256: rightsArtifact.sha256,
      rights_evidence_id: rights.evidence_id,
      rights_basis: rights.basis,
      vision_batch_artifact_sha256: batchArtifact.sha256,
      vision_batch_body_sha256: batch.body_sha256,
      vision_receipt_key_id: batch.worker_receipt.key_id,
      vision_receipt_public_key_spki_sha256: batch.worker_receipt.public_key_spki_sha256,
      vision_worker_build: batch.worker_contract.worker_build,
      vision_reservation_ledger_id: batch.worker_contract.reservation_ledger.ledger_id,
      vision_reservation_ledger_epoch: batch.worker_contract.reservation_ledger.ledger_epoch,
      vision_issued_at: issuedAt,
      deterministic_visual_verdict: "PASS",
      deterministic_visual_decision_sha256: walmartListingIntegritySha256(decision),
    });
  }

  const expiresAt = new Date(Math.min(...expiryCandidates)).toISOString();
  if (Date.parse(expiresAt) <= nowMs) fail("certificate has no positive freshness window");
  const body = {
    schema_version: WALMART_LISTING_REPAIR_IMAGE_CERTIFICATE_SCHEMA,
    created_at: now,
    expires_at: expiresAt,
    plan: {
      plan_id: plan.plan_id,
      body_sha256: plan.body_sha256,
      artifact_sha256: planArtifact.sha256,
      target_sha256: plan.target.target_sha256,
    },
    listing: {
      channel: "WALMART_US" as const,
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
      projection_artifact_sha256: listingArtifact.sha256,
    },
    product_truth: {
      snapshot_id: truth.snapshot_id,
      snapshot_body_sha256: truth.body_sha256,
      snapshot_artifact_sha256: truthArtifact.sha256,
      revision_id: revision.revision_id,
      revision_body_sha256: revision.body_sha256,
      approval_sha256: revision.approval.approval_sha256,
      recipe_id: revision.recipe.recipe_id,
      composition: "same_product" as const,
      outer_unit_count: outerUnits,
    },
    worker_trust: {
      run_lock_sha256: runLockSha,
      key_id: text(trust.key_id, "worker trust key_id"),
      public_key_spki_sha256: trustedKeySha,
      worker_build: trust.worker_build,
      reservation_ledger: trust.reservation_ledger,
    },
    targets: certifiedTargets,
    policy: {
      exact_downloaded_bytes_verified: true as const,
      exact_variant_lineage_verified: true as const,
      rights_evidence_verified: true as const,
      signed_worker_v2_receipts_verified: true as const,
      query_free_urls_verified: true as const,
      redirects_absent_verified: true as const,
      slots_unique_and_contiguous: true as const,
      mixed_bundle_supported: false as const,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY" as const,
      owner_permit_must_bind_certificate_sha256: true as const,
    },
  };
  const bodySha = walmartListingIntegritySha256(body);
  return {
    ...body,
    certificate_id: `walmart-image-certificate-${bodySha.slice(0, 20)}`,
    body_sha256: bodySha,
  };
}
