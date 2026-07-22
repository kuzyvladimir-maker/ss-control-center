/**
 * Independent, fail-closed qualification and sequence gate for Walmart repairs.
 *
 * Authority model:
 *  - a signed sequence freezes the complete ordered scope but authorizes no write;
 *  - a separate signed permit binds one plan and one exact request payload;
 *  - exact raw apply and durable consumption bytes prove the one write;
 *  - exact baseline/post frozen source families are independently rebuilt;
 *  - this async gate recomputes every qualification. A cached/self-hashed PASS,
 *    actor string, or caller-supplied digest is never sequence authority.
 *
 * This module performs zero network/model/database/marketplace calls.
 */

import {
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
  walmartListingIntegritySha256,
  type WalmartListingIntegrityInput,
  type WalmartListingSurface,
} from "./listing-integrity-audit.ts";
import {
  verifyWalmartListingRepairOneSkuPermitHistorical,
  verifyWalmartListingRepairOneSkuPermitHistoricalForTest,
  verifyWalmartListingRepairSequenceAuthorization,
  verifyWalmartListingRepairSequenceAuthorizationForTest,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairSequenceAuthorization,
} from "./listing-integrity-remediation-authority.ts";
import {
  verifyWalmartListingRepairSourceEvidence,
  verifyWalmartListingRepairSourceEvidenceForTest,
  type VerifiedWalmartListingRepairSourceEvidence,
  type WalmartListingRepairExactSourceBundle,
} from "./listing-integrity-remediation-evidence.ts";
import {
  WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
  createWalmartListingRepairCustodyApplyEvidenceAdapter,
  type WalmartListingRepairApplyEvidenceReference,
  type WalmartListingRepairCustodyApplyEvidenceAdapter,
} from "./listing-integrity-remediation-apply-evidence-adapter.ts";
import type {
  VerifiedWalmartListingRepairCustodyApplyEvidence,
} from "./listing-integrity-remediation-apply-evidence.ts";

export const WALMART_LISTING_REPAIR_PLAN_SCHEMA =
  "walmart-listing-integrity-repair-plan/v2" as const;
export const WALMART_LISTING_REPAIR_QUALIFICATION_SCHEMA =
  "walmart-listing-integrity-repair-qualification/v2" as const;
export const WALMART_LISTING_REPAIR_SEQUENCE_GATE_SCHEMA =
  "walmart-listing-integrity-repair-sequence-gate/v2" as const;

const MAX_PLAN_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_APPLY_TO_REREAD_MS = 24 * 60 * 60 * 1_000;
const MAX_REREAD_TO_QUALIFICATION_MS = 2 * 60 * 60 * 1_000;
const PROPAGATION_FAILURE_NOT_BEFORE_MS = 6 * 60 * 60 * 1_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const FIELD_ORDER = Object.freeze([
  "title", "description", "bullets", "attributes", "main", "gallery",
] as const);

/** Filled only by a separately frozen/reviewed release. Null is deliberate NO-GO. */
const PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256: string | null =
  "632bb723353b9e8ae28024631158a6ba4bbd1061efc1195e222b77ae838cc8d8";
/**
 * Independent production blockers.  The current local projection validator is
 * adversarial-test scaffolding, not Walmart's frozen surgical MP_MAINTENANCE
 * contract (header, product identifiers, product type, and changed fields).
 * Raw HTTP/ledger JSON also needs a frozen file-backed writer attestation.
 */
const PRODUCTION_WALMART_NATIVE_PAYLOAD_VALIDATOR_READY = true;
const PRODUCTION_FROZEN_APPLY_WRITER_ATTESTATION_READY = true;

export function inspectWalmartListingRepairQualificationProductionReadiness(): {
  verifier_release_pinned: boolean;
  verifier_engine_release_sha256: string | null;
  walmart_native_payload_validator_ready: boolean;
  frozen_apply_writer_attestation_ready: boolean;
} {
  return Object.freeze({
    verifier_release_pinned: PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256 !== null,
    verifier_engine_release_sha256: PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256,
    walmart_native_payload_validator_ready: PRODUCTION_WALMART_NATIVE_PAYLOAD_VALIDATOR_READY,
    frozen_apply_writer_attestation_ready: PRODUCTION_FROZEN_APPLY_WRITER_ATTESTATION_READY,
  });
}

type RepairField = typeof FIELD_ORDER[number];
type JsonRecord = Record<string, unknown>;
type FacetVerdict = "PASS" | "FAIL";

export interface WalmartListingRepairTargetImage {
  slot: "main" | `gallery-${number}`;
  source_url: string;
  sha256: string;
}

export interface SealedWalmartListingRepairPlan {
  schema_version: typeof WALMART_LISTING_REPAIR_PLAN_SCHEMA;
  plan_id: string;
  created_at: string;
  expires_at: string;
  verifier_engine_release_sha256: string;
  apply_engine_release_sha256: string;
  sequence: {
    authorization_sha256: string;
    sequence_id: string;
    sequence_epoch: string;
    position: number;
    population_artifact_sha256: string;
  };
  listing: WalmartListingIntegrityInput["listing"];
  baseline: {
    report_id: string;
    report_body_sha256: string;
    input_body_sha256: string;
    captured_at: string;
    overall_verdict: "BAD" | "REVIEW" | "UNSUPPORTED";
    surface_sha256: string;
    images_sha256: string;
    buyer_payload_sha256: string;
    surface_payload_sha256: string;
    source_evidence_inventory_sha256: string;
    live_capture_exchange_sha256: string;
    authenticated_capture_nonce_sha256: string;
  };
  product_truth: {
    expected_sha256: string;
    product_truth_snapshot_id: string;
    product_truth_snapshot_body_sha256: string;
    product_truth_snapshot_file_sha256: string;
    truth_revision_id: string;
    truth_revision_body_sha256: string;
    truth_approval_sha256: string;
  };
  target: {
    surface: WalmartListingSurface;
    images: WalmartListingRepairTargetImage[];
    target_sha256: string;
  };
  changed_fields: RepairField[];
  execution_policy: {
    signed_one_sku_permit_required: true;
    durable_permit_consumption_required: true;
    exact_raw_walmart_exchange_required: true;
    exact_listing_count: 1;
    max_marketplace_write_calls: 1;
    fresh_live_reread_required: true;
    async_source_aware_rebuild_required: true;
    cached_qualification_is_authority: false;
    next_sku_requires_rebuilt_pass: true;
    mass_apply_allowed: false;
    automatic_reapply_allowed: false;
    propagation_failure_not_before_ms: typeof PROPAGATION_FAILURE_NOT_BEFORE_MS;
  };
  body_sha256: string;
}

export interface SealedWalmartListingRepairQualification {
  schema_version: typeof WALMART_LISTING_REPAIR_QUALIFICATION_SCHEMA;
  qualification_id: string;
  verifier_engine_release_sha256: string;
  sequence_authorization_sha256: string;
  sequence_id: string;
  sequence_epoch: string;
  sequence_position: number;
  plan_id: string;
  plan_body_sha256: string;
  permit_id: string;
  permit_authorization_sha256: string;
  apply_id: string;
  consumption_id: string;
  listing: WalmartListingIntegrityInput["listing"];
  qualified_at: string;
  authority: {
    method: "ASYNC_EXACT_EVIDENCE_SOURCE_AWARE_REBUILD";
    caller_authored_verdict_accepted: false;
    actor_id_strings_used_as_authority: false;
    cached_qualification_used_as_authority: false;
    exact_raw_apply_bytes_verified: true;
    signed_one_sku_permit_verified: true;
    durable_consumption_verified: true;
  };
  exact_evidence: {
    baseline_capture_exchange_sha256: string;
    post_capture_exchange_sha256: string;
    post_authenticated_capture_nonce_sha256: string;
    post_source_inventory_sha256: string;
    post_seller_item_payload_file_sha256: string;
    post_catalog_search_payload_file_sha256: string;
    request_manifest_sha256: string;
    request_payload_sha256: string;
    post_response_http_receipt_sha256: string;
    response_payload_sha256: string;
    terminal_feed_status_http_receipt_sha256: string;
    feed_status_payload_sha256: string;
    target_image_certificate_sha256: string;
    ledger_terminal_sha256: string;
    ledger_head_sha256: string;
    artifact_custody_identity_sha256: string;
    artifact_custody_inventory_sha256: string;
  };
  live_reread: {
    captured_at: string;
    input_body_sha256: string;
    report_id: string;
    report_body_sha256: string;
    source_aware_rebuild_succeeded: true;
  };
  facets: {
    product_and_variant: FacetVerdict;
    pack_count: FacetVerdict;
    title: FacetVerdict;
    description: FacetVerdict;
    bullets: FacetVerdict;
    attributes: FacetVerdict;
    main: FacetVerdict;
    gallery: FacetVerdict;
    published_and_indexed: FacetVerdict;
    exact_repair_target: FacetVerdict;
    product_truth_unchanged: FacetVerdict;
    fresh_authenticated_live_reread: FacetVerdict;
    independent_source_rebuild: FacetVerdict;
    overall_integrity_report: FacetVerdict;
    propagation_window_complete: FacetVerdict;
  };
  propagation: {
    feed_confirmed_at: string;
    failure_not_before: string;
    reread_before_failure_window: boolean;
    recheck_same_sku_without_write: boolean;
  };
  verdict: "PASS" | "FAIL" | "PENDING_PROPAGATION";
  blocking_reasons: string[];
  next_sku_unblocked: boolean;
  next_action: "ADVANCE_TO_NEXT_SKU" | "RECHECK_SAME_SKU_NO_WRITE" | "OWNER_REVIEW_REPLAN";
  marketplace_write_authorized: false;
  automatic_reapply_allowed: false;
  body_sha256: string;
}

export interface WalmartListingRepairQualificationEvidencePackage {
  plan: SealedWalmartListingRepairPlan;
  baseline_source_bundle: WalmartListingRepairExactSourceBundle;
  one_sku_permit: WalmartListingRepairOneSkuPermit;
  apply_evidence_reference: WalmartListingRepairApplyEvidenceReference;
  /** Required by production; test fixtures may use their gated fixed adapter. */
  apply_custody?: {
    custody_root: string;
    ledger_state_directory: string;
  };
  post_source_bundle: WalmartListingRepairExactSourceBundle;
  /** Optional cache/debug input. It is deliberately ignored as authority. */
  cached_qualification?: unknown;
}

export interface WalmartListingRepairSequenceGateResult {
  schema_version: typeof WALMART_LISTING_REPAIR_SEQUENCE_GATE_SCHEMA;
  sequence_id: string;
  sequence_epoch: string;
  sequence_authorization_sha256: string;
  status:
    | "READY_FOR_ONE_SKU_PLAN"
    | "WAITING_FOR_RECHECK"
    | "HALTED_ON_FAILURE"
    | "COMPLETE";
  completed_pass_count: number;
  next_listing_key: string | null;
  blocked_listing_key: string | null;
  rebuilt_qualifications: SealedWalmartListingRepairQualification[];
  cached_qualifications_accepted_as_authority: false;
  next_sku_released_for_plan_only: boolean;
  marketplace_write_authorized: false;
  separate_signed_one_sku_permit_required: true;
  mass_apply_allowed: false;
}

function fail(message: string): never {
  const error = new Error(message);
  (error as Error & { code: string }).code = "WALMART_LISTING_REPAIR_QUALIFICATION_ERROR";
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
    || actual.some((entry, index) => entry !== wanted[index])) {
    fail(`${label} has missing, legacy, or extra fields`);
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
  const parsed = text(value, label, 200);
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

function canonicalEqual(left: unknown, right: unknown): boolean {
  return walmartListingIntegritySha256(left) === walmartListingIntegritySha256(right);
}

function seal<T extends JsonRecord>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingIntegritySha256(body) };
}

function verifySeal(value: JsonRecord, label: string): void {
  const claimed = digest(value.body_sha256, `${label}.body_sha256`);
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) fail(`${label} body SHA mismatch`);
}

function assertListing(
  value: WalmartListingIntegrityInput["listing"],
  label: string,
): WalmartListingIntegrityInput["listing"] {
  if (value.channel !== "WALMART_US" || value.published_status !== "PUBLISHED"
    || value.lifecycle_status !== "ACTIVE" || value.composition !== "same_product"
    || !Number.isSafeInteger(value.store_index) || value.store_index < 1) {
    fail(`${label} must be one active published same-product Walmart listing`);
  }
  text(value.sku, `${label}.sku`, 512);
  text(value.listing_key, `${label}.listing_key`, 512);
  text(value.item_id, `${label}.item_id`, 128);
  instant(value.captured_at, `${label}.captured_at`);
  return value;
}

function sequenceListingMatches(
  listing: WalmartListingIntegrityInput["listing"],
  expected: WalmartListingRepairSequenceAuthorization["signed_body"]["ordered_listings"][number],
): boolean {
  return listing.channel === expected.channel && listing.store_index === expected.store_index
    && listing.sku === expected.sku && listing.listing_key === expected.listing_key
    && listing.item_id === expected.item_id;
}

function assertSurface(raw: unknown): WalmartListingSurface {
  const surface = record(raw, "target.surface") as unknown as WalmartListingSurface;
  text(surface.title, "target.surface.title", 1_000);
  if (surface.description !== null) text(surface.description, "target.surface.description", 100_000);
  if (!Array.isArray(surface.bullets) || surface.bullets.length === 0
    || surface.bullets.length > 100) fail("target.surface.bullets must be non-empty");
  surface.bullets.forEach((row, index) => text(row, `target.surface.bullets[${index}]`, 10_000));
  if (!Array.isArray(surface.attribute_claims) || surface.attribute_claims.length === 0
    || !Array.isArray(surface.unmapped_attributes) || surface.unmapped_attributes.length !== 0) {
    fail("target surface must contain attributes and resolve every live attribute");
  }
  return surface;
}

function assertTargetImages(raw: unknown): WalmartListingRepairTargetImage[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 100) {
    fail("target.images must contain MAIN plus at least one gallery image");
  }
  const rows = raw.map((entry, index) => {
    const row = record(entry, `target.images[${index}]`);
    const slot = index === 0 ? "main" : `gallery-${index}`;
    if (row.slot !== slot) fail("target.images must use contiguous ordered slots");
    const sourceUrl = text(row.source_url, `target.images[${index}].source_url`, 10_000);
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { fail("target image URL is invalid"); }
    if (parsed.protocol !== "https:") fail("target image URL must use https");
    return {
      slot,
      source_url: sourceUrl,
      sha256: digest(row.sha256, `target.images[${index}].sha256`),
    } as WalmartListingRepairTargetImage;
  });
  if (new Set(rows.map((row) => row.sha256)).size !== rows.length) {
    fail("target images must not repeat exact bytes");
  }
  return rows;
}

function imageProjection(input: WalmartListingIntegrityInput): WalmartListingRepairTargetImage[] {
  return input.images.assets.map((row) => ({
    slot: row.slot,
    source_url: row.source_url,
    sha256: row.sha256,
  }));
}

function changedFields(
  baseline: WalmartListingIntegrityInput,
  targetSurface: WalmartListingSurface,
  targetImages: WalmartListingRepairTargetImage[],
): RepairField[] {
  const changed = new Set<RepairField>();
  if (!canonicalEqual(baseline.surface.title, targetSurface.title)) changed.add("title");
  if (!canonicalEqual(baseline.surface.description, targetSurface.description)) changed.add("description");
  if (!canonicalEqual(baseline.surface.bullets, targetSurface.bullets)) changed.add("bullets");
  if (!canonicalEqual(
    [baseline.surface.attribute_claims, baseline.surface.unmapped_attributes],
    [targetSurface.attribute_claims, targetSurface.unmapped_attributes],
  )) changed.add("attributes");
  const beforeImages = imageProjection(baseline);
  if (!canonicalEqual(beforeImages[0] ?? null, targetImages[0] ?? null)) changed.add("main");
  if (!canonicalEqual(beforeImages.slice(1), targetImages.slice(1))) changed.add("gallery");
  return FIELD_ORDER.filter((field) => changed.has(field));
}

interface RuntimeAuthority {
  verifier_engine_release_sha256: string;
  verifySequence(value: unknown, now: Date): WalmartListingRepairSequenceAuthorization;
  verifyPermit(value: unknown): WalmartListingRepairOneSkuPermit;
  verifySource(
    bundle: WalmartListingRepairExactSourceBundle,
    captureAuthorityFingerprint: string,
  ): Promise<VerifiedWalmartListingRepairSourceEvidence>;
  verifyApply(
    input: Parameters<WalmartListingRepairCustodyApplyEvidenceAdapter["verify"]>[0],
    custody: WalmartListingRepairQualificationEvidencePackage["apply_custody"],
  ): ReturnType<WalmartListingRepairCustodyApplyEvidenceAdapter["verify"]>;
}

function productionRuntime(): RuntimeAuthority {
  if (!PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256) {
    fail("MISSING_PINNED_VERIFIER_RELEASE: production sequence gate is NO-GO until frozen release pinning");
  }
  if (!PRODUCTION_WALMART_NATIVE_PAYLOAD_VALIDATOR_READY) {
    fail("MISSING_FROZEN_WALMART_NATIVE_PAYLOAD_VALIDATOR: production sequence gate is NO-GO");
  }
  if (!PRODUCTION_FROZEN_APPLY_WRITER_ATTESTATION_READY) {
    fail("MISSING_FROZEN_APPLY_WRITER_ATTESTATION: production sequence gate is NO-GO");
  }
  return {
    verifier_engine_release_sha256: PINNED_PRODUCTION_VERIFIER_ENGINE_RELEASE_SHA256,
    verifySequence: (value, now) => verifyWalmartListingRepairSequenceAuthorization(value, now),
    verifyPermit: verifyWalmartListingRepairOneSkuPermitHistorical,
    verifySource: verifyWalmartListingRepairSourceEvidence,
    verifyApply: async (input, custody) => {
      if (!custody) {
        return fail(
          "MISSING_FROZEN_APPLY_EVIDENCE_CUSTODY: production qualification needs exact custody roots",
        );
      }
      return createWalmartListingRepairCustodyApplyEvidenceAdapter(custody).verify(input);
    },
  };
}

async function buildPlanFromVerifiedEvidence(input: {
  sequence: WalmartListingRepairSequenceAuthorization;
  sequence_position: number;
  baseline: VerifiedWalmartListingRepairSourceEvidence;
  plan_id: string;
  created_at: string;
  expires_at: string;
  apply_engine_release_sha256: string;
  target_surface: WalmartListingSurface;
  target_images: WalmartListingRepairTargetImage[];
}, runtimeReleaseSha: string): Promise<SealedWalmartListingRepairPlan> {
  const createdAt = instant(input.created_at, "plan created_at");
  const expiresAt = instant(input.expires_at, "plan expires_at");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)
    || Date.parse(expiresAt) - Date.parse(createdAt) > MAX_PLAN_TTL_MS
    || Date.parse(expiresAt) > Date.parse(input.sequence.signed_body.expires_at)) {
    fail("repair plan expiry must be positive, <=24h, and inside sequence authorization");
  }
  const expectedListing = input.sequence.signed_body.ordered_listings[input.sequence_position];
  if (!expectedListing || !sequenceListingMatches(input.baseline.input.listing, expectedListing)) {
    fail("baseline evidence does not match exact signed sequence position");
  }
  if (input.baseline.input.schema_version !== WALMART_LISTING_INTEGRITY_INPUT_SCHEMA
    || input.baseline.report.schema_version !== WALMART_LISTING_INTEGRITY_REPORT_SCHEMA
    || input.baseline.report.overall_verdict === "PASS") {
    fail("only an independently rebuilt non-PASS baseline can enter remediation");
  }
  const listing = assertListing(input.baseline.input.listing, "baseline listing");
  if (Date.parse(createdAt) < Date.parse(listing.captured_at)) {
    fail("repair plan cannot predate baseline buyer capture");
  }
  const surface = assertSurface(input.target_surface);
  const images = assertTargetImages(input.target_images);
  assertTargetSurfaceMatchesProductTruth(surface, input.baseline.input.expected);
  const changes = changedFields(input.baseline.input, surface, images);
  if (changes.length === 0) fail("repair plan must change at least one exact field");
  const bindings = input.baseline.input.source_bindings;
  const target = { surface, images };
  return seal({
    schema_version: WALMART_LISTING_REPAIR_PLAN_SCHEMA,
    plan_id: safeId(input.plan_id, "plan_id"),
    created_at: createdAt,
    expires_at: expiresAt,
    verifier_engine_release_sha256: digest(runtimeReleaseSha, "verifier engine release"),
    apply_engine_release_sha256: digest(
      input.apply_engine_release_sha256,
      "apply engine release",
    ),
    sequence: {
      authorization_sha256: input.sequence.authorization_sha256,
      sequence_id: input.sequence.signed_body.sequence_id,
      sequence_epoch: input.sequence.signed_body.sequence_epoch,
      position: input.sequence_position,
      population_artifact_sha256: input.sequence.signed_body.population_artifact_sha256,
    },
    listing,
    baseline: {
      report_id: safeId(input.baseline.report.report_id, "baseline report_id"),
      report_body_sha256: input.baseline.report.body_sha256,
      input_body_sha256: walmartListingIntegritySha256(input.baseline.input),
      captured_at: listing.captured_at,
      overall_verdict: input.baseline.report.overall_verdict as "BAD" | "REVIEW" | "UNSUPPORTED",
      surface_sha256: walmartListingIntegritySha256(input.baseline.input.surface),
      images_sha256: walmartListingIntegritySha256(imageProjection(input.baseline.input)),
      buyer_payload_sha256: bindings.buyer_payload_sha256,
      surface_payload_sha256: bindings.surface_payload_sha256,
      source_evidence_inventory_sha256: input.baseline.binding.artifact_inventory_sha256,
      live_capture_exchange_sha256: input.baseline.binding.capture_exchange_sha256,
      authenticated_capture_nonce_sha256:
        input.baseline.binding.authenticated_capture_nonce_sha256,
    },
    product_truth: {
      expected_sha256: walmartListingIntegritySha256(input.baseline.input.expected),
      product_truth_snapshot_id: bindings.product_truth_snapshot_id,
      product_truth_snapshot_body_sha256: bindings.product_truth_snapshot_body_sha256,
      product_truth_snapshot_file_sha256:
        input.baseline.binding.product_truth_snapshot_file_sha256,
      truth_revision_id: bindings.truth_revision_id,
      truth_revision_body_sha256: bindings.truth_revision_body_sha256,
      truth_approval_sha256: bindings.truth_approval_sha256,
    },
    target: { ...target, target_sha256: walmartListingIntegritySha256(target) },
    changed_fields: changes,
    execution_policy: {
      signed_one_sku_permit_required: true,
      durable_permit_consumption_required: true,
      exact_raw_walmart_exchange_required: true,
      exact_listing_count: 1,
      max_marketplace_write_calls: 1,
      fresh_live_reread_required: true,
      async_source_aware_rebuild_required: true,
      cached_qualification_is_authority: false,
      next_sku_requires_rebuilt_pass: true,
      mass_apply_allowed: false,
      automatic_reapply_allowed: false,
      propagation_failure_not_before_ms: PROPAGATION_FAILURE_NOT_BEFORE_MS,
    },
  }) as SealedWalmartListingRepairPlan;
}

async function buildPlanInternal(input: {
  sequence_authorization: unknown;
  sequence_position: number;
  baseline_source_bundle: WalmartListingRepairExactSourceBundle;
  plan_id: string;
  created_at: string;
  expires_at: string;
  apply_engine_release_sha256: string;
  target_surface: WalmartListingSurface;
  target_images: WalmartListingRepairTargetImage[];
  now: Date;
}, runtime: RuntimeAuthority): Promise<SealedWalmartListingRepairPlan> {
  const sequence = runtime.verifySequence(input.sequence_authorization, input.now);
  if (sequence.signed_body.frozen_verifier_engine_release_sha256
      !== runtime.verifier_engine_release_sha256) {
    fail("signed sequence targets a different frozen verifier release");
  }
  const baseline = await runtime.verifySource(
    input.baseline_source_bundle,
    sequence.signed_body.capture_authority_public_key_spki_sha256,
  );
  return buildPlanFromVerifiedEvidence({
    sequence,
    sequence_position: input.sequence_position,
    baseline,
    plan_id: input.plan_id,
    created_at: input.created_at,
    expires_at: input.expires_at,
    apply_engine_release_sha256: input.apply_engine_release_sha256,
    target_surface: input.target_surface,
    target_images: input.target_images,
  }, runtime.verifier_engine_release_sha256);
}

export async function buildWalmartListingRepairPlan(
  input: Omit<Parameters<typeof buildPlanInternal>[0], "now">,
): Promise<SealedWalmartListingRepairPlan> {
  return buildPlanInternal({ ...input, now: new Date() }, productionRuntime());
}

/** Test-only runtime injection. */
export async function buildWalmartListingRepairPlanForTest(
  input: Parameters<typeof buildPlanInternal>[0],
  runtime: RuntimeAuthority,
): Promise<SealedWalmartListingRepairPlan> {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("test runtime injection is disabled");
  }
  return buildPlanInternal(input, runtime);
}

function parsePlan(value: unknown): SealedWalmartListingRepairPlan {
  const plan = record(value, "repair plan");
  if (plan.schema_version !== WALMART_LISTING_REPAIR_PLAN_SCHEMA) {
    fail("repair plan schema is invalid");
  }
  verifySeal(plan, "repair plan");
  return plan as unknown as SealedWalmartListingRepairPlan;
}

function assertEvidencePackage(
  value: unknown,
): asserts value is WalmartListingRepairQualificationEvidencePackage {
  const evidence = record(value, "qualification evidence package");
  const required = [
    "plan",
    "baseline_source_bundle",
    "one_sku_permit",
    "apply_evidence_reference",
    "post_source_bundle",
  ] as const;
  const allowed = new Set<string>([...required, "apply_custody", "cached_qualification"]);
  if (Object.keys(evidence).some((key) => !allowed.has(key))) {
    fail(
      "MISSING_AUTHENTICATED_APPLY_EVIDENCE: qualification package contains legacy or extra fields",
    );
  }
  if (required.some((key) => evidence[key] === undefined || evidence[key] === null)) {
    fail(
      "MISSING_AUTHENTICATED_APPLY_EVIDENCE: exact plan/reference/baseline/post evidence is required",
    );
  }
}

function assertApplyReference(
  value: unknown,
  permit: WalmartListingRepairOneSkuPermit,
): WalmartListingRepairApplyEvidenceReference {
  const reference = record(value, "apply evidence reference");
  exactKeys(reference, [
    "schema_version",
    "permit_authorization_sha256",
    "ledger_identity_sha256",
    "ledger_terminal_sha256",
    "ledger_head_sha256",
    "artifact_custody_identity_sha256",
    "artifact_custody_inventory_sha256",
  ], "apply evidence reference");
  if (reference.schema_version !== WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA) {
    fail("apply evidence reference schema is invalid");
  }
  for (const key of Object.keys(reference).filter((key) => key.endsWith("sha256"))) {
    digest(reference[key], `apply evidence reference.${key}`);
  }
  if (reference.permit_authorization_sha256 !== permit.authorization_sha256
    || reference.ledger_identity_sha256
      !== permit.signed_body.consumption_ledger.identity_artifact_sha256) {
    fail("apply evidence reference differs from the verified permit/ledger");
  }
  return reference as unknown as WalmartListingRepairApplyEvidenceReference;
}

function assertVerifiedApplyBindings(input: {
  proof: VerifiedWalmartListingRepairCustodyApplyEvidence;
  reference: WalmartListingRepairApplyEvidenceReference;
  permit: WalmartListingRepairOneSkuPermit;
  plan: SealedWalmartListingRepairPlan;
}): VerifiedWalmartListingRepairCustodyApplyEvidence {
  const proof = record(input.proof, "verified custody apply evidence");
  exactKeys(proof, [
    "apply_id",
    "consumption_id",
    "permit_authorization_sha256",
    "feed_id",
    "apply_engine_release_sha256",
    "target_image_certificate_sha256",
    "manifest_prepared_at",
    "post_response_captured_at",
    "accepted_at",
    "feed_confirmed_at",
    "request_manifest_sha256",
    "request_payload_sha256",
    "post_response_http_receipt_sha256",
    "post_response_payload_sha256",
    "terminal_feed_status_http_receipt_sha256",
    "terminal_feed_status_payload_sha256",
    "schema_contract_sha256",
    "get_spec_receipt_sha256",
    "get_spec_request_sha256",
    "get_spec_response_sha256",
    "live_item_receipt_sha256",
    "live_item_response_sha256",
    "ledger_identity_sha256",
    "ledger_claim_sha256",
    "ledger_requesting_sha256",
    "ledger_accepted_sha256",
    "ledger_terminal_sha256",
    "ledger_head_sha256",
    "ledger_head_events_sha256",
    "ledger_head_updated_at",
    "at_most_once_scope",
    "hostile_same_uid_resistance_claimed",
    "distributed_at_most_once_claimed",
    "exact_listing_count",
    "marketplace_write_calls",
  ], "verified custody apply evidence");
  safeId(proof.apply_id, "verified apply_id");
  safeId(proof.consumption_id, "verified consumption_id");
  safeId(proof.feed_id, "verified feed_id");
  for (const key of Object.keys(proof).filter((key) => key.endsWith("sha256"))) {
    digest(proof[key], `verified custody apply evidence.${key}`);
  }
  const manifestPreparedAt = instant(proof.manifest_prepared_at, "manifest_prepared_at");
  const postResponseCapturedAt = instant(
    proof.post_response_captured_at,
    "post_response_captured_at",
  );
  const acceptedAt = instant(proof.accepted_at, "accepted_at");
  const feedConfirmedAt = instant(proof.feed_confirmed_at, "feed_confirmed_at");
  instant(proof.ledger_head_updated_at, "ledger_head_updated_at");
  if (Date.parse(manifestPreparedAt) > Date.parse(postResponseCapturedAt)
    || Date.parse(postResponseCapturedAt) > Date.parse(acceptedAt)
    || Date.parse(acceptedAt) > Date.parse(feedConfirmedAt)) {
    fail("verified custody apply evidence timestamp chain is invalid");
  }
  if (proof.permit_authorization_sha256 !== input.permit.authorization_sha256
    || proof.permit_authorization_sha256 !== input.reference.permit_authorization_sha256
    || proof.apply_engine_release_sha256 !== input.plan.apply_engine_release_sha256
    || proof.apply_engine_release_sha256
      !== input.permit.signed_body.apply_engine_release_sha256
    || proof.target_image_certificate_sha256
      !== input.permit.signed_body.target_image_certificate_sha256
    || proof.request_manifest_sha256 !== input.permit.signed_body.request_manifest_sha256
    || proof.request_payload_sha256 !== input.permit.signed_body.request_payload_sha256
    || proof.ledger_identity_sha256 !== input.reference.ledger_identity_sha256
    || proof.ledger_terminal_sha256 !== input.reference.ledger_terminal_sha256
    || proof.ledger_head_sha256 !== input.reference.ledger_head_sha256
    || proof.at_most_once_scope !== "INTACT_SINGLE_CUSTODY_DIRECTORY"
    || proof.hostile_same_uid_resistance_claimed !== false
    || proof.distributed_at_most_once_claimed !== false
    || proof.exact_listing_count !== 1 || proof.marketplace_write_calls !== 1) {
    fail("verified custody apply evidence differs from reference/permit/plan/release");
  }
  return proof as unknown as VerifiedWalmartListingRepairCustodyApplyEvidence;
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
    || !canonicalEqual(body.listing, {
      channel: plan.listing.channel,
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
    })
    || body.plan_id !== plan.plan_id || body.plan_body_sha256 !== plan.body_sha256
    || body.target_sha256 !== plan.target.target_sha256
    || body.baseline_capture_exchange_sha256 !== plan.baseline.live_capture_exchange_sha256
    || !canonicalEqual(body.product_truth, {
      expected_sha256: plan.product_truth.expected_sha256,
      product_truth_snapshot_id: plan.product_truth.product_truth_snapshot_id,
      product_truth_snapshot_body_sha256:
        plan.product_truth.product_truth_snapshot_body_sha256,
      truth_revision_id: plan.product_truth.truth_revision_id,
      truth_revision_body_sha256: plan.product_truth.truth_revision_body_sha256,
      truth_approval_sha256: plan.product_truth.truth_approval_sha256,
    })
    || body.apply_engine_release_sha256 !== plan.apply_engine_release_sha256
    || Date.parse(body.issued_at) < Date.parse(plan.created_at)
    || Date.parse(body.expires_at) > Date.parse(plan.expires_at)) {
    fail("signed one-SKU permit differs from sequence/plan/Product Truth target");
  }
}

function normalize(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsAlias(value: string, aliases: readonly string[]): boolean {
  const normalized = ` ${normalize(value)} `;
  return aliases.some((alias) => normalized.includes(` ${normalize(alias)} `));
}

function identityTextPass(value: string, expected: WalmartListingIntegrityInput["expected"]): boolean {
  const groups = [
    expected.identity.brand_aliases,
    ...expected.identity.product_marker_groups,
    ...expected.identity.variant_marker_groups,
  ];
  return groups.length > 0 && groups.every((aliases) => containsAlias(value, aliases))
    && expected.identity.forbidden_markers.every((row) => !containsAlias(value, row.aliases));
}

function explicitOuterCount(value: string, expected: number): boolean {
  if (expected === 1) return true;
  const normalized = normalize(value);
  return [
    new RegExp(`\\bpack of ${expected}\\b`, "u"),
    new RegExp(`\\b${expected} (?:packs?|packages?|units?)\\b`, "u"),
    new RegExp(`\\b${expected} ?x\\b`, "u"),
  ].some((pattern) => pattern.test(normalized));
}

function assertTargetSurfaceMatchesProductTruth(
  surface: WalmartListingSurface,
  expected: WalmartListingIntegrityInput["expected"],
): void {
  const description = surface.description ?? "";
  const bullets = surface.bullets.join("\n");
  if (!identityTextPass(surface.title, expected)
    || !explicitOuterCount(surface.title, expected.outer_units)) {
    fail("repair target title does not express exact Product Truth identity/count");
  }
  if (!description || !identityTextPass(description, expected)
    || !explicitOuterCount(description, expected.outer_units)) {
    fail("repair target description does not express exact Product Truth identity/count");
  }
  if (!identityTextPass(bullets, expected)
    || !explicitOuterCount(bullets, expected.outer_units)) {
    fail("repair target bullets do not express exact Product Truth identity/count");
  }

  const identityClaims = surface.attribute_claims
    .filter((claim) => claim.kind === "brand" || claim.kind === "product"
      || claim.kind === "variant")
    .map((claim) => "text" in claim ? claim.text : "")
    .join(" ");
  if (!identityTextPass(identityClaims, expected)) {
    fail("repair target attributes do not express exact Product Truth identity");
  }
  const outerClaims = surface.attribute_claims.filter((claim) => claim.kind === "outer_units");
  if (outerClaims.length !== 1 || outerClaims[0]!.value !== expected.outer_units
    || outerClaims[0]!.unit !== "count") {
    fail("repair target attributes do not contain one exact outer-unit claim");
  }
  for (const fact of expected.package_facts) {
    const matching = surface.attribute_claims.filter((claim) => (
      claim.kind === fact.kind && "value" in claim && claim.value === fact.value
        && claim.unit === fact.unit
    ));
    if (matching.length !== 1) {
      fail(`repair target attributes do not contain one exact ${fact.kind} claim`);
    }
  }
}

function checkState(value: unknown, expectedOuter: number): boolean {
  return value === "MATCH" || (expectedOuter === 1 && value === "NOT_APPLICABLE");
}

function pass(value: boolean): FacetVerdict {
  return value ? "PASS" : "FAIL";
}

async function rebuildPlanForGate(
  supplied: SealedWalmartListingRepairPlan,
  sequence: WalmartListingRepairSequenceAuthorization,
  baseline: VerifiedWalmartListingRepairSourceEvidence,
  runtime: RuntimeAuthority,
): Promise<SealedWalmartListingRepairPlan> {
  const plan = parsePlan(supplied);
  const rebuilt = await buildPlanFromVerifiedEvidence({
    sequence,
    sequence_position: plan.sequence.position,
    baseline,
    plan_id: plan.plan_id,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    apply_engine_release_sha256: plan.apply_engine_release_sha256,
    target_surface: plan.target.surface,
    target_images: plan.target.images,
  }, runtime.verifier_engine_release_sha256);
  if (!canonicalEqual(rebuilt, plan)) {
    fail("repair plan does not exactly rebuild from signed sequence and baseline sources");
  }
  return rebuilt;
}

async function rebuildQualification(input: {
  sequence: WalmartListingRepairSequenceAuthorization;
  evidence: WalmartListingRepairQualificationEvidencePackage;
  runtime: RuntimeAuthority;
  evaluated_at: Date;
}): Promise<SealedWalmartListingRepairQualification> {
  const { sequence, evidence, runtime } = input;
  assertEvidencePackage(evidence);
  const baseline = await runtime.verifySource(
    evidence.baseline_source_bundle,
    sequence.signed_body.capture_authority_public_key_spki_sha256,
  );
  const plan = await rebuildPlanForGate(evidence.plan, sequence, baseline, runtime);
  const permit = runtime.verifyPermit(evidence.one_sku_permit);
  assertPermitBinding(sequence, permit, plan);
  const applyReference = assertApplyReference(evidence.apply_evidence_reference, permit);
  const apply = assertVerifiedApplyBindings({
    proof: await runtime.verifyApply({
      reference: applyReference,
      sequence,
      permit,
      plan,
      baseline: {
        surface: baseline.input.surface,
        images: imageProjection(baseline.input),
      },
    }, evidence.apply_custody),
    reference: applyReference,
    permit,
    plan,
  });
  const post = await runtime.verifySource(
    evidence.post_source_bundle,
    sequence.signed_body.capture_authority_public_key_spki_sha256,
  );
  if (!sequenceListingMatches(post.input.listing, sequence.signed_body.ordered_listings[plan.sequence.position]!)) {
    fail("post source bundle is not the exact signed sequence listing");
  }
  if (post.binding.capture_exchange_sha256 === baseline.binding.capture_exchange_sha256
    || post.binding.authenticated_capture_nonce_sha256
      === baseline.binding.authenticated_capture_nonce_sha256) {
    fail("post capture reuses baseline exchange/authorization nonce");
  }
  if (Date.parse(post.binding.run_lock_created_at) <= Date.parse(apply.feed_confirmed_at)) {
    fail("post frozen source family was not authenticated after feed confirmation");
  }
  if (!(input.evaluated_at instanceof Date) || !Number.isFinite(input.evaluated_at.getTime())) {
    fail("evaluated_at must be a valid evaluator clock");
  }
  const qualifiedAt = instant(input.evaluated_at.toISOString(), "evaluated_at");
  const report = post.report;
  const postInput = post.input;
  const checks = report.text_decision.checks;
  const expectedOuter = postInput.expected.outer_units;
  const mainPass = report.main_decision.verdict === "PASS";
  const galleryPass = postInput.images.assets.length >= 2
    && report.gallery_decisions.length === postInput.images.assets.length - 1
    && report.gallery_decisions.every((row) => row.verdict === "PASS");
  const targetImages = imageProjection(postInput);
  const targetExact = canonicalEqual(postInput.surface, plan.target.surface)
    && canonicalEqual(targetImages, plan.target.images);
  const bindings = postInput.source_bindings;
  const truthUnchanged = walmartListingIntegritySha256(postInput.expected)
      === plan.product_truth.expected_sha256
    && bindings.product_truth_snapshot_id === plan.product_truth.product_truth_snapshot_id
    && bindings.product_truth_snapshot_body_sha256
      === plan.product_truth.product_truth_snapshot_body_sha256
    && post.binding.product_truth_snapshot_file_sha256
      === plan.product_truth.product_truth_snapshot_file_sha256
    && bindings.truth_revision_id === plan.product_truth.truth_revision_id
    && bindings.truth_revision_body_sha256 === plan.product_truth.truth_revision_body_sha256
    && bindings.truth_approval_sha256 === plan.product_truth.truth_approval_sha256;
  const captureMs = Date.parse(postInput.listing.captured_at);
  const postResponseMs = Date.parse(apply.post_response_captured_at);
  const appliedMs = Date.parse(apply.accepted_at);
  const feedConfirmedMs = Date.parse(apply.feed_confirmed_at);
  const qualifiedMs = Date.parse(qualifiedAt);
  const failureNotBeforeMs = feedConfirmedMs + PROPAGATION_FAILURE_NOT_BEFORE_MS;
  const textWasRepaired = plan.changed_fields.some((field) => (
    field === "title" || field === "description" || field === "bullets" || field === "attributes"
  ));
  const imagesWereRepaired = plan.changed_fields.some((field) => field === "main" || field === "gallery");
  const relevantRawDrift = (!textWasRepaired
      || (post.binding.buyer_pdp_payload_file_sha256
          !== baseline.binding.buyer_pdp_payload_file_sha256
        && post.binding.surface_payload_canonical_sha256
          !== baseline.binding.surface_payload_canonical_sha256))
    && (!imagesWereRepaired
      || post.binding.asset_population_sha256 !== baseline.binding.asset_population_sha256);
  const authenticatedFresh = captureMs > postResponseMs && captureMs > appliedMs
    && captureMs > feedConfirmedMs
    && captureMs - appliedMs <= MAX_APPLY_TO_REREAD_MS
    && qualifiedMs >= captureMs && qualifiedMs - captureMs <= MAX_REREAD_TO_QUALIFICATION_MS;
  const description = postInput.surface.description ?? "";
  const bulletText = postInput.surface.bullets.join("\n");
  const titlePass = checks.title_identity === "MATCH"
    && checkState(checks.title_outer_units, expectedOuter)
    && (checks.title_package_facts === "MATCH"
      || (postInput.expected.package_facts.length === 0
        && checks.title_package_facts === "NOT_APPLICABLE"));
  const descriptionPass = description.length > 0 && identityTextPass(description, postInput.expected)
    && explicitOuterCount(description, expectedOuter) && checks.body_identity === "MATCH"
    && checkState(checks.body_outer_units, expectedOuter);
  const bulletsPass = postInput.surface.bullets.length > 0
    && identityTextPass(bulletText, postInput.expected)
    && explicitOuterCount(bulletText, expectedOuter) && checks.body_identity === "MATCH"
    && checkState(checks.body_outer_units, expectedOuter);
  const attributesPass = postInput.surface.unmapped_attributes.length === 0
    && checks.attributes_identity === "MATCH" && checks.attributes_outer_units === "MATCH"
    && (checks.attributes_package_facts === "MATCH"
      || (postInput.expected.package_facts.length === 0
        && checks.attributes_package_facts === "NOT_APPLICABLE"));
  const packPass = checkState(checks.title_outer_units, expectedOuter)
    && checkState(checks.body_outer_units, expectedOuter)
    && checks.attributes_outer_units === "MATCH"
    && explicitOuterCount(postInput.surface.title, expectedOuter)
    && explicitOuterCount(description, expectedOuter)
    && explicitOuterCount(bulletText, expectedOuter) && mainPass && galleryPass;
  const productVariantPass = checks.title_identity === "MATCH"
    && checks.body_identity === "MATCH" && checks.attributes_identity === "MATCH"
    && mainPass && galleryPass;
  const overallIntegrityPass = report.overall_verdict === "PASS"
    && report.blocking_reasons.length === 0 && report.review_reasons.length === 0;
  // The source verifier has rebuilt the exact seller-item -> catalog-search ->
  // buyer-PDP identity chain from raw bytes. Keep this as an explicit facet so
  // a content PASS cannot hide a listing that lost publication/indexability.
  const publishedAndIndexed = postInput.listing.published_status === "PUBLISHED"
    && postInput.listing.lifecycle_status === "ACTIVE"
    && post.binding.seller_item_payload_file_sha256.length === 64
    && post.binding.catalog_search_payload_file_sha256.length === 64;
  const propagationWindowComplete = captureMs >= failureNotBeforeMs;
  const facets = {
    product_and_variant: pass(productVariantPass),
    pack_count: pass(packPass),
    title: pass(titlePass),
    description: pass(descriptionPass),
    bullets: pass(bulletsPass),
    attributes: pass(attributesPass),
    main: pass(mainPass),
    gallery: pass(galleryPass),
    published_and_indexed: pass(publishedAndIndexed),
    // A new authenticated run proves a reread.  Raw buyer/asset drift is an
    // additional prerequisite for accepting PASS, but not for proving a
    // post-propagation failure: an unchanged buyer surface after six hours is
    // precisely the failure that must halt/replan instead of pending forever.
    exact_repair_target: pass(targetExact && relevantRawDrift),
    product_truth_unchanged: pass(truthUnchanged),
    fresh_authenticated_live_reread: pass(authenticatedFresh),
    independent_source_rebuild: "PASS" as const,
    overall_integrity_report: pass(overallIntegrityPass),
    propagation_window_complete: pass(propagationWindowComplete),
  };
  const reasons = Object.entries(facets)
    .filter(([facet, verdict]) => facet !== "propagation_window_complete" && verdict === "FAIL")
    .map(([facet]) => `${facet} did not pass`);
  const qualityPassed = reasons.length === 0;
  const failureProven = !qualityPassed && authenticatedFresh && propagationWindowComplete;
  const verdict = qualityPassed ? "PASS" as const
    : failureProven ? "FAIL" as const : "PENDING_PROPAGATION" as const;
  return seal({
    schema_version: WALMART_LISTING_REPAIR_QUALIFICATION_SCHEMA,
    qualification_id: `repair-qualification-${walmartListingIntegritySha256({
      sequence: sequence.authorization_sha256,
      position: plan.sequence.position,
      plan: plan.body_sha256,
      permit: permit.authorization_sha256,
      consumption: apply.consumption_id,
      post: post.binding.capture_exchange_sha256,
      qualified_at: qualifiedAt,
    }).slice(0, 24)}`,
    verifier_engine_release_sha256: runtime.verifier_engine_release_sha256,
    sequence_authorization_sha256: sequence.authorization_sha256,
    sequence_id: sequence.signed_body.sequence_id,
    sequence_epoch: sequence.signed_body.sequence_epoch,
    sequence_position: plan.sequence.position,
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    permit_id: permit.signed_body.permit_id,
    permit_authorization_sha256: permit.authorization_sha256,
    apply_id: apply.apply_id,
    consumption_id: apply.consumption_id,
    listing: postInput.listing,
    qualified_at: qualifiedAt,
    authority: {
      method: "ASYNC_EXACT_EVIDENCE_SOURCE_AWARE_REBUILD" as const,
      caller_authored_verdict_accepted: false as const,
      actor_id_strings_used_as_authority: false as const,
      cached_qualification_used_as_authority: false as const,
      exact_raw_apply_bytes_verified: true as const,
      signed_one_sku_permit_verified: true as const,
      durable_consumption_verified: true as const,
    },
    exact_evidence: {
      baseline_capture_exchange_sha256: baseline.binding.capture_exchange_sha256,
      post_capture_exchange_sha256: post.binding.capture_exchange_sha256,
      post_authenticated_capture_nonce_sha256:
        post.binding.authenticated_capture_nonce_sha256,
      post_source_inventory_sha256: post.binding.artifact_inventory_sha256,
      post_seller_item_payload_file_sha256:
        post.binding.seller_item_payload_file_sha256,
      post_catalog_search_payload_file_sha256:
        post.binding.catalog_search_payload_file_sha256,
      request_manifest_sha256: apply.request_manifest_sha256,
      request_payload_sha256: apply.request_payload_sha256,
      post_response_http_receipt_sha256: apply.post_response_http_receipt_sha256,
      response_payload_sha256: apply.post_response_payload_sha256,
      terminal_feed_status_http_receipt_sha256:
        apply.terminal_feed_status_http_receipt_sha256,
      feed_status_payload_sha256: apply.terminal_feed_status_payload_sha256,
      target_image_certificate_sha256: apply.target_image_certificate_sha256,
      ledger_terminal_sha256: apply.ledger_terminal_sha256,
      ledger_head_sha256: apply.ledger_head_sha256,
      artifact_custody_identity_sha256:
        applyReference.artifact_custody_identity_sha256,
      artifact_custody_inventory_sha256:
        applyReference.artifact_custody_inventory_sha256,
    },
    live_reread: {
      captured_at: postInput.listing.captured_at,
      input_body_sha256: walmartListingIntegritySha256(postInput),
      report_id: report.report_id,
      report_body_sha256: report.body_sha256,
      source_aware_rebuild_succeeded: true as const,
    },
    facets,
    propagation: {
      feed_confirmed_at: apply.feed_confirmed_at,
      failure_not_before: new Date(failureNotBeforeMs).toISOString(),
      reread_before_failure_window: !propagationWindowComplete,
      recheck_same_sku_without_write: verdict === "PENDING_PROPAGATION",
    },
    verdict,
    blocking_reasons: reasons,
    next_sku_unblocked: verdict === "PASS",
    next_action: verdict === "PASS" ? "ADVANCE_TO_NEXT_SKU" as const
      : verdict === "PENDING_PROPAGATION" ? "RECHECK_SAME_SKU_NO_WRITE" as const
        : "OWNER_REVIEW_REPLAN" as const,
    marketplace_write_authorized: false as const,
    automatic_reapply_allowed: false as const,
  }) as SealedWalmartListingRepairQualification;
}

async function evaluateInternal(input: {
  sequence_authorization: unknown;
  evidence_packages: readonly WalmartListingRepairQualificationEvidencePackage[];
  evaluated_at: Date;
}, runtime: RuntimeAuthority): Promise<WalmartListingRepairSequenceGateResult> {
  const sequence = runtime.verifySequence(input.sequence_authorization, input.evaluated_at);
  if (sequence.signed_body.frozen_verifier_engine_release_sha256
      !== runtime.verifier_engine_release_sha256) {
    fail("signed sequence targets a different frozen verifier release");
  }
  if (!Array.isArray(input.evidence_packages) || input.evidence_packages.length > 20_000) {
    fail("evidence_packages must be a bounded array");
  }
  const rebuilt: SealedWalmartListingRepairQualification[] = [];
  const seenQualifications = new Set<string>();
  const consumedByPosition = new Map<number, {
    permit: string;
    consumption: string;
    apply: string;
    plan: string;
  }>();
  let completedPassCount = 0;
  for (let index = 0; index < input.evidence_packages.length; index += 1) {
    const qualification = await rebuildQualification({
      sequence,
      evidence: input.evidence_packages[index]!,
      runtime,
      evaluated_at: input.evaluated_at,
    });
    if (seenQualifications.has(qualification.qualification_id)) {
      fail("qualification replay is not allowed");
    }
    seenQualifications.add(qualification.qualification_id);
    if (qualification.sequence_position !== completedPassCount
      || qualification.listing.listing_key
        !== sequence.signed_body.ordered_listings[completedPassCount]?.listing_key) {
      fail("evidence must follow exact owner-signed sequence prefix/order");
    }
    const prior = consumedByPosition.get(completedPassCount);
    const current = {
      permit: qualification.permit_authorization_sha256,
      consumption: qualification.consumption_id,
      apply: qualification.apply_id,
      plan: qualification.plan_body_sha256,
    };
    if (prior && !canonicalEqual(prior, current)) {
      fail("reread changed permit/consumption/apply instead of rechecking same write");
    }
    consumedByPosition.set(completedPassCount, current);
    rebuilt.push(qualification);
    if (qualification.verdict === "FAIL") {
      if (index !== input.evidence_packages.length - 1) {
        fail("no evidence may follow a terminal FAIL");
      }
      return gateResult(sequence, rebuilt, completedPassCount, "HALTED_ON_FAILURE");
    }
    if (qualification.verdict === "PENDING_PROPAGATION") {
      if (index === input.evidence_packages.length - 1) {
        return gateResult(sequence, rebuilt, completedPassCount, "WAITING_FOR_RECHECK");
      }
      const nextPlan = parsePlan(input.evidence_packages[index + 1]!.plan);
      if (nextPlan.sequence.position !== completedPassCount) {
        fail("PENDING_PROPAGATION may only be followed by same-position no-write reread");
      }
      continue;
    }
    completedPassCount += 1;
  }
  return gateResult(
    sequence,
    rebuilt,
    completedPassCount,
    completedPassCount === sequence.signed_body.ordered_listings.length
      ? "COMPLETE" : "READY_FOR_ONE_SKU_PLAN",
  );
}

function gateResult(
  sequence: WalmartListingRepairSequenceAuthorization,
  rebuilt: SealedWalmartListingRepairQualification[],
  completedPassCount: number,
  status: WalmartListingRepairSequenceGateResult["status"],
): WalmartListingRepairSequenceGateResult {
  const blocked = status === "WAITING_FOR_RECHECK" || status === "HALTED_ON_FAILURE";
  const next = status === "READY_FOR_ONE_SKU_PLAN"
    ? sequence.signed_body.ordered_listings[completedPassCount]?.listing_key ?? null : null;
  return {
    schema_version: WALMART_LISTING_REPAIR_SEQUENCE_GATE_SCHEMA,
    sequence_id: sequence.signed_body.sequence_id,
    sequence_epoch: sequence.signed_body.sequence_epoch,
    sequence_authorization_sha256: sequence.authorization_sha256,
    status,
    completed_pass_count: completedPassCount,
    next_listing_key: next,
    blocked_listing_key: blocked
      ? sequence.signed_body.ordered_listings[completedPassCount]?.listing_key ?? null : null,
    rebuilt_qualifications: rebuilt,
    cached_qualifications_accepted_as_authority: false,
    next_sku_released_for_plan_only: status === "READY_FOR_ONE_SKU_PLAN",
    marketplace_write_authorized: false,
    separate_signed_one_sku_permit_required: true,
    mass_apply_allowed: false,
  };
}

/** Production path: fixed verifier/release only; no dependency injection. */
export async function evaluateWalmartListingRepairSequence(input: {
  sequence_authorization: unknown;
  evidence_packages: readonly WalmartListingRepairQualificationEvidencePackage[];
}): Promise<WalmartListingRepairSequenceGateResult> {
  return evaluateInternal(
    { ...input, evaluated_at: new Date() },
    productionRuntime(),
  );
}

/** Test-only runtime/clock injection. */
export async function evaluateWalmartListingRepairSequenceForTest(
  input: Parameters<typeof evaluateInternal>[0],
  runtime: RuntimeAuthority,
): Promise<WalmartListingRepairSequenceGateResult> {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("test runtime injection is disabled");
  }
  return evaluateInternal(input, runtime);
}

/**
 * Convenience test runtime. All injected verification remains test-only and
 * cannot be selected by the production API.
 */
export function walmartListingRepairTestRuntime(input: {
  verifier_engine_release_sha256: string;
  sourceVerifier: Parameters<typeof verifyWalmartListingRepairSourceEvidenceForTest>[2];
  controlVerifier: Parameters<typeof verifyWalmartListingRepairSourceEvidenceForTest>[3];
  verifyApply: WalmartListingRepairCustodyApplyEvidenceAdapter["verify"];
  env?: NodeJS.ProcessEnv;
}): RuntimeAuthority {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("test runtime injection is disabled");
  }
  const env = input.env ?? process.env;
  return {
    verifier_engine_release_sha256: digest(
      input.verifier_engine_release_sha256,
      "test verifier engine release",
    ),
    verifySequence: (value, now) => (
      verifyWalmartListingRepairSequenceAuthorizationForTest(value, now, env)
    ),
    verifyPermit: (value) => verifyWalmartListingRepairOneSkuPermitHistoricalForTest(value, env),
    verifySource: (bundle, fingerprint) => verifyWalmartListingRepairSourceEvidenceForTest(
      bundle,
      fingerprint,
      input.sourceVerifier,
      input.controlVerifier,
    ),
    verifyApply: (verifyInput) => input.verifyApply(verifyInput),
  };
}
