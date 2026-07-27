/**
 * Owner-side compilation primitives for one reviewed Walmart repair.
 *
 * This module performs local deterministic compilation only. It never opens a
 * database, contacts Walmart, reads a private key, signs an owner permit, or
 * submits a feed.  The caller must independently verify the signed sequence and
 * permit before passing them here.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import {
  walmartListingIntegritySha256,
  type ListingAttributeClaim,
  type WalmartListingSurface,
} from "./listing-integrity-audit.ts";
import type { AuditExpectedTruth } from "./catalog-visual-audit.ts";
import type {
  WalmartListingRepairConsumptionLedgerBinding,
  WalmartListingRepairEnvironment,
  WalmartListingRepairListingIdentity,
  WalmartListingRepairOneSkuPermit,
  WalmartListingRepairOneSkuPermitSignedBody,
  WalmartListingRepairSequenceAuthorization,
  WalmartListingRepairSequenceSignedBody,
} from "./listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
  WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
} from "./listing-integrity-remediation-authority.ts";
import {
  parseWalmartListingRepairExecutionPackageBytes,
  renderWalmartListingRepairExecutionPackage,
  sealWalmartListingRepairExecutionPackage,
  type SealedWalmartListingRepairExecutionPackage,
} from "./listing-integrity-remediation-execution-package.ts";
import {
  canonicalWalmartListingSurgicalJson,
  buildWalmartListingSurgicalRequest,
  WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
  WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA,
  WALMART_LISTING_SURGICAL_MAX_SPEC_AGE_MS,
  WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
  walmartListingSurgicalSha256,
  type BuiltWalmartListingSurgicalRequest,
  type WalmartListingSurgicalGetSpecReceipt,
  type WalmartListingSurgicalLiveItemReceipt,
  type WalmartListingSurgicalAttributeMapping,
  type WalmartListingSurgicalProductIdentifier,
  type WalmartListingSurgicalSchemaContract,
} from "./listing-integrity-remediation-payload.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
  type WalmartListingRepairTargetImage,
} from "./listing-integrity-remediation-qualification.ts";
import {
  certifyWalmartListingRepairUnchangedImages,
  verifyWalmartListingRepairUnchangedImageCertificateBytes,
  type SealedWalmartListingRepairUnchangedImageCertificate,
} from "./listing-integrity-remediation-unchanged-image-certificate.ts";
import {
  verifyWalmartListingRepairReviewedMainCertificateBytes,
  type SealedWalmartListingRepairReviewedMainCertificate,
} from "./listing-integrity-remediation-reviewed-main-certificate.ts";
import type {
  WalmartListingRepairProductionExecutionInput,
  WalmartListingRepairProductTruthBinding,
} from "./listing-integrity-remediation-writer.ts";

export const WALMART_LISTING_REPAIR_COMPILATION_REQUEST_SCHEMA =
  "walmart-listing-single-repair-compilation-request/v1" as const;
export const WALMART_LISTING_REPAIR_MAIN_COMPILATION_REQUEST_SCHEMA =
  "walmart-listing-single-repair-compilation-request/v2" as const;
export const WALMART_LISTING_REPAIR_ATTRIBUTE_COMPILATION_REQUEST_SCHEMA =
  "walmart-listing-single-repair-compilation-request/v3" as const;
export const WALMART_LISTING_REPAIR_REVIEWED_TRUTH_SCHEMA =
  "walmart-listing-repair-reviewed-one-sku-truth/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PLAN_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ONE_SKU_PERMIT_TTL_MS = 30 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

export interface VerifiedWalmartListingRepairCompilationRequest {
  schema_version:
    | typeof WALMART_LISTING_REPAIR_COMPILATION_REQUEST_SCHEMA
    | typeof WALMART_LISTING_REPAIR_MAIN_COMPILATION_REQUEST_SCHEMA
    | typeof WALMART_LISTING_REPAIR_ATTRIBUTE_COMPILATION_REQUEST_SCHEMA;
  created_at: string;
  status: "READY_FOR_CONNECTED_MATERIALS";
  listing: WalmartListingRepairListingIdentity & {
    seller_upc: string;
    captured_at: string;
    published_status: "PUBLISHED";
    lifecycle_status: "ACTIVE";
    composition: "same_product";
  };
  frozen_review: {
    proposal_file_sha256: string;
    proposal_body_sha256: string;
    certification_file_sha256: string;
    certification_body_sha256: string;
    diagnosis_file_sha256: string;
    buyer_snapshot_file_sha256: string;
    buyer_pdp_file_sha256: string;
    donor_audit_file_sha256: string;
  };
  product_truth_candidate: {
    candidate_sha256: string;
    expected_sha256: string;
    donor_product_id: string;
    single_unit_upc: string;
    outer_units: number;
    expected?: AuditExpectedTruth;
  };
  repair: {
    baseline_surface: WalmartListingSurface;
    target_surface: WalmartListingSurface;
    baseline_images: WalmartListingRepairTargetImage[];
    target_images: WalmartListingRepairTargetImage[];
    changed_fields:
      | ["description", "bullets"]
      | ["description", "bullets", "main"]
      | ["attributes"];
    unchanged_image_bytes: boolean;
    changed_main_evidence?: {
      product_truth: ImmutableCompilationArtifactReference;
      candidate_manifest: ImmutableCompilationArtifactReference;
      single_unit_source: ImmutableCompilationArtifactReference;
      candidate_asset: ImmutableCompilationArtifactReference;
      qualification: ImmutableCompilationArtifactReference;
      observer_plan: ImmutableCompilationArtifactReference;
      observer_request: ImmutableCompilationArtifactReference;
      observer_response: ImmutableCompilationArtifactReference;
      r2_staging: ImmutableCompilationArtifactReference;
    };
  };
  owner_gate: {
    exact_confirmation: string;
    confirms_only_reviewed_diff: true;
    confirmation_would_authorize_product_truth_activation: true;
    confirmation_would_authorize_one_sku_package_compilation: true;
    current_walmart_write_authorized: false;
    current_mass_run_authorized: false;
  };
  assurance: {
    network_calls: 0;
    model_calls: 0;
    database_reads: 0;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
  };
  next_required_inputs: readonly string[];
  body_sha256: string;
}

export interface ImmutableCompilationArtifactReference {
  absolute_path: string;
  file_sha256: string;
}

export interface ReviewedWalmartListingRepairProductTruthArtifact {
  schema_version: typeof WALMART_LISTING_REPAIR_REVIEWED_TRUTH_SCHEMA;
  created_at: string;
  status: "ACTIVE_FOR_EXACT_ONE_SKU_PACKAGE_ONLY";
  snapshot: {
    snapshot_id: string;
    body_sha256: string;
    compilation_request_file_sha256: string;
    compilation_request_body_sha256: string;
    listing: WalmartListingRepairListingIdentity;
    frozen_review: VerifiedWalmartListingRepairCompilationRequest["frozen_review"];
    product_truth_candidate:
      VerifiedWalmartListingRepairCompilationRequest["product_truth_candidate"];
  };
  revision: {
    revision_id: string;
    body_sha256: string;
    expected_sha256: string;
    candidate_sha256: string;
    target_surface_sha256: string;
    target_images_sha256: string;
  };
  approval: {
    decision: "APPROVED_FOR_EXACT_ONE_SKU_PACKAGE_ONLY";
    approved_by: string;
    exact_confirmation_sha256: string;
    compilation_request_file_sha256: string;
    compilation_request_body_sha256: string;
    truth_revision_body_sha256: string;
    approval_sha256: string;
    authentication:
      "BOUND_INTO_OWNER_ED25519_SEQUENCE_AND_ONE_SKU_PERMIT";
  };
  binding: WalmartListingRepairProductTruthBinding;
  constraints: {
    exact_listing_count: 1;
    walmart_content_write_authorized: false;
    mass_apply_allowed: false;
    price_required_for_content_truth: false;
    database_activation_required_for_this_canary_package: false;
    reusable_as_shared_catalog_activation: false;
  };
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart owner compiler rejected input: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 100_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function bytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 2
    || value.byteLength > 64 * 1024 * 1024) {
    fail(`${label} must be bounded exact bytes`);
  }
  return Uint8Array.from(value);
}

function jsonBytes(value: Uint8Array, label: string): JsonRecord {
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)),
      label,
    );
  } catch {
    return fail(`${label} must be exact UTF-8 JSON`);
  }
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) {
    fail(`${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function exactImages(value: unknown, label: string): WalmartListingRepairTargetImage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    fail(`${label} must contain 1..20 images`);
  }
  return value.map((entry, index) => {
    const raw = record(entry, `${label}[${index}]`);
    const expectedSlot = index === 0 ? "main" : `gallery-${index}`;
    if (raw.slot !== expectedSlot) fail(`${label} slots are not ordered`);
    const sourceUrl = text(raw.source_url, `${label}[${index}].source_url`, 4_096);
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return fail(`${label}[${index}].source_url must be absolute`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.toString() !== sourceUrl) {
      fail(`${label}[${index}].source_url must be canonical query-free HTTPS`);
    }
    return {
      slot: expectedSlot as WalmartListingRepairTargetImage["slot"],
      source_url: sourceUrl,
      sha256: digest(raw.sha256, `${label}[${index}].sha256`),
    };
  });
}

function immutableArtifactReference(
  value: unknown,
  label: string,
): ImmutableCompilationArtifactReference {
  const raw = record(value, label);
  if (Object.keys(raw).sort().join(",") !== "absolute_path,file_sha256") {
    fail(`${label} fields must be exactly absolute_path and file_sha256`);
  }
  const absolutePath = text(raw.absolute_path, `${label}.absolute_path`, 4_096);
  if (!path.isAbsolute(absolutePath) || path.normalize(absolutePath) !== absolutePath) {
    fail(`${label}.absolute_path must be exact normalized absolute path`);
  }
  return {
    absolute_path: absolutePath,
    file_sha256: digest(raw.file_sha256, `${label}.file_sha256`),
  };
}

function exactExpected(
  value: unknown,
  label: string,
  expectedSha256: string,
  outerUnits: number,
): AuditExpectedTruth {
  const raw = record(value, label);
  record(raw.identity, `${label}.identity`);
  if (walmartListingIntegritySha256(raw) !== expectedSha256
    || raw.outer_units !== outerUnits
    || !Array.isArray(raw.package_facts)) {
    fail(`${label} does not rebuild the exact Product Truth expected facts`);
  }
  return structuredClone(raw) as unknown as AuditExpectedTruth;
}

function exactSurface(value: unknown, label: string): WalmartListingSurface {
  const raw = record(value, label);
  const title = text(raw.title, `${label}.title`, 2_000);
  const description = raw.description === null
    ? null
    : text(raw.description, `${label}.description`, 200_000);
  if (!Array.isArray(raw.bullets) || raw.bullets.length < 1
    || raw.bullets.length > 100) {
    fail(`${label}.bullets must be a bounded non-empty array`);
  }
  if (!Array.isArray(raw.attribute_claims) || !Array.isArray(raw.unmapped_attributes)) {
    fail(`${label} attributes must be explicit arrays`);
  }
  return structuredClone({
    title,
    description,
    bullets: raw.bullets.map((entry, index) =>
      text(entry, `${label}.bullets[${index}]`, 20_000)),
    attribute_claims: raw.attribute_claims,
    unmapped_attributes: raw.unmapped_attributes,
  }) as WalmartListingSurface;
}

export function verifyWalmartListingRepairCompilationRequest(
  value: unknown,
): VerifiedWalmartListingRepairCompilationRequest {
  const raw = record(value, "compilation request");
  const exactTopLevelFields = [
    "assurance",
    "body_sha256",
    "created_at",
    "frozen_review",
    "listing",
    "next_required_inputs",
    "owner_gate",
    "product_truth_candidate",
    "repair",
    "schema_version",
    "status",
  ];
  if (walmartListingIntegritySha256(Object.keys(raw).sort())
    !== walmartListingIntegritySha256(exactTopLevelFields)) {
    fail("compilation request fields are not the exact supported schema");
  }
  const requestSchema = raw.schema_version;
  if ((requestSchema !== WALMART_LISTING_REPAIR_COMPILATION_REQUEST_SCHEMA
      && requestSchema !== WALMART_LISTING_REPAIR_MAIN_COMPILATION_REQUEST_SCHEMA
      && requestSchema !== WALMART_LISTING_REPAIR_ATTRIBUTE_COMPILATION_REQUEST_SCHEMA)
    || raw.status !== "READY_FOR_CONNECTED_MATERIALS") {
    fail("compilation request schema/status is unsupported");
  }
  const claimedBodySha = digest(raw.body_sha256, "compilation request body_sha256");
  const body = { ...raw };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimedBodySha) {
    fail("compilation request body SHA mismatch");
  }
  const listing = record(raw.listing, "compilation request listing");
  const storeIndex = positiveInteger(listing.store_index, "listing.store_index");
  const sku = text(listing.sku, "listing.sku", 512);
  const listingKey = text(listing.listing_key, "listing.listing_key", 1_024);
  if (listing.channel !== "WALMART_US"
    || listingKey !== `walmart:${storeIndex}:${sku}`
    || listing.published_status !== "PUBLISHED"
    || listing.lifecycle_status !== "ACTIVE"
    || listing.composition !== "same_product") {
    fail("listing is not one exact active Walmart same-product SKU");
  }
  const frozen = record(raw.frozen_review, "frozen_review");
  for (const field of [
    "proposal_file_sha256",
    "proposal_body_sha256",
    "certification_file_sha256",
    "certification_body_sha256",
    "diagnosis_file_sha256",
    "buyer_snapshot_file_sha256",
    "buyer_pdp_file_sha256",
    "donor_audit_file_sha256",
  ]) {
    digest(frozen[field], `frozen_review.${field}`);
  }
  const truth = record(raw.product_truth_candidate, "product_truth_candidate");
  const repair = record(raw.repair, "repair");
  const baselineSurface = exactSurface(repair.baseline_surface, "repair.baseline_surface");
  const targetSurface = exactSurface(repair.target_surface, "repair.target_surface");
  const baselineImages = exactImages(repair.baseline_images, "repair.baseline_images");
  const targetImages = exactImages(repair.target_images, "repair.target_images");
  const textOnlySurfaceMatches = walmartListingIntegritySha256({
    ...baselineSurface,
    description: targetSurface.description,
    bullets: targetSurface.bullets,
  }) === walmartListingIntegritySha256(targetSurface);
  const textOnly = requestSchema === WALMART_LISTING_REPAIR_COMPILATION_REQUEST_SCHEMA;
  const mainRepair =
    requestSchema === WALMART_LISTING_REPAIR_MAIN_COMPILATION_REQUEST_SCHEMA;
  const attributeOnly =
    requestSchema === WALMART_LISTING_REPAIR_ATTRIBUTE_COMPILATION_REQUEST_SCHEMA;
  const attributeOnlySurfaceMatches = walmartListingIntegritySha256({
    ...baselineSurface,
    attribute_claims: targetSurface.attribute_claims,
    unmapped_attributes: targetSurface.unmapped_attributes,
  }) === walmartListingIntegritySha256(targetSurface);
  let changedMainEvidence:
    VerifiedWalmartListingRepairCompilationRequest["repair"]["changed_main_evidence"];
  if (textOnly) {
    if (!textOnlySurfaceMatches) {
      fail("v1 repair changes a field outside description and bullets");
    }
    if (walmartListingIntegritySha256(baselineImages)
        !== walmartListingIntegritySha256(targetImages)
      || walmartListingIntegritySha256(repair.changed_fields)
        !== walmartListingIntegritySha256(["description", "bullets"])
      || repair.unchanged_image_bytes !== true
      || Object.hasOwn(repair, "changed_main_evidence")) {
      fail("v1 repair is not an exact description/bullets-only diff");
    }
  } else if (mainRepair) {
    if (!textOnlySurfaceMatches) {
      fail("v2 repair changes a text/attribute field outside description and bullets");
    }
    if (baselineImages.length !== targetImages.length
      || walmartListingIntegritySha256(baselineImages.slice(1))
        !== walmartListingIntegritySha256(targetImages.slice(1))
      || walmartListingIntegritySha256(baselineImages[0])
        === walmartListingIntegritySha256(targetImages[0])
      || walmartListingIntegritySha256(repair.changed_fields)
        !== walmartListingIntegritySha256(["description", "bullets", "main"])
      || repair.unchanged_image_bytes !== false) {
      fail("v2 repair is not an exact description/bullets/MAIN diff with unchanged gallery");
    }
    const evidence = record(repair.changed_main_evidence, "repair.changed_main_evidence");
    const exactEvidenceKeys = [
      "candidate_asset",
      "candidate_manifest",
      "observer_plan",
      "observer_request",
      "observer_response",
      "product_truth",
      "qualification",
      "r2_staging",
      "single_unit_source",
    ];
    if (walmartListingIntegritySha256(Object.keys(evidence).sort())
      !== walmartListingIntegritySha256(exactEvidenceKeys)) {
      fail("repair.changed_main_evidence fields are not exact");
    }
    changedMainEvidence = {
      product_truth: immutableArtifactReference(
        evidence.product_truth,
        "repair.changed_main_evidence.product_truth",
      ),
      candidate_manifest: immutableArtifactReference(
        evidence.candidate_manifest,
        "repair.changed_main_evidence.candidate_manifest",
      ),
      single_unit_source: immutableArtifactReference(
        evidence.single_unit_source,
        "repair.changed_main_evidence.single_unit_source",
      ),
      candidate_asset: immutableArtifactReference(
        evidence.candidate_asset,
        "repair.changed_main_evidence.candidate_asset",
      ),
      qualification: immutableArtifactReference(
        evidence.qualification,
        "repair.changed_main_evidence.qualification",
      ),
      observer_plan: immutableArtifactReference(
        evidence.observer_plan,
        "repair.changed_main_evidence.observer_plan",
      ),
      observer_request: immutableArtifactReference(
        evidence.observer_request,
        "repair.changed_main_evidence.observer_request",
      ),
      observer_response: immutableArtifactReference(
        evidence.observer_response,
        "repair.changed_main_evidence.observer_response",
      ),
      r2_staging: immutableArtifactReference(
        evidence.r2_staging,
        "repair.changed_main_evidence.r2_staging",
      ),
    };
  } else if (attributeOnly) {
    if (!attributeOnlySurfaceMatches
      || walmartListingIntegritySha256(baselineSurface.attribute_claims)
        === walmartListingIntegritySha256(targetSurface.attribute_claims)
      || walmartListingIntegritySha256(baselineSurface.unmapped_attributes)
        !== walmartListingIntegritySha256(targetSurface.unmapped_attributes)
      || walmartListingIntegritySha256(baselineImages)
        !== walmartListingIntegritySha256(targetImages)
      || walmartListingIntegritySha256(repair.changed_fields)
        !== walmartListingIntegritySha256(["attributes"])
      || repair.unchanged_image_bytes !== true
      || Object.hasOwn(repair, "changed_main_evidence")) {
      fail("v3 repair is not an exact attributes-only diff with opaque fields/images preserved");
    }
  } else {
    fail("compilation request schema branch is unsupported");
  }
  const gate = record(raw.owner_gate, "owner_gate");
  if (gate.confirms_only_reviewed_diff !== true
    || gate.confirmation_would_authorize_product_truth_activation !== true
    || gate.confirmation_would_authorize_one_sku_package_compilation !== true
    || gate.current_walmart_write_authorized !== false
    || gate.current_mass_run_authorized !== false) {
    fail("owner gate boundary is invalid");
  }
  const assurance = record(raw.assurance, "assurance");
  const exactAssuranceFields = [
    "database_reads",
    "database_writes",
    "model_calls",
    "network_calls",
    "walmart_reads",
    "walmart_writes",
  ];
  if (walmartListingIntegritySha256(Object.keys(assurance).sort())
      !== walmartListingIntegritySha256(exactAssuranceFields)
    || exactAssuranceFields.some((field) => assurance[field] !== 0)) {
    fail("compilation request assurance must prove exact zero effects");
  }
  const candidateSha = digest(truth.candidate_sha256, "candidate_sha256");
  const expectedSha = digest(truth.expected_sha256, "expected_sha256");
  const outerUnits = positiveInteger(truth.outer_units, "outer_units");
  const expected = textOnly
    ? undefined
    : exactExpected(
      truth.expected,
      "product_truth_candidate.expected",
      expectedSha,
      outerUnits,
    );
  return {
    schema_version: requestSchema,
    created_at: instant(raw.created_at, "created_at"),
    status: "READY_FOR_CONNECTED_MATERIALS",
    listing: {
      channel: "WALMART_US",
      store_index: storeIndex,
      sku,
      listing_key: listingKey,
      item_id: text(listing.item_id, "listing.item_id", 64),
      seller_upc: text(listing.seller_upc, "listing.seller_upc", 64),
      captured_at: instant(listing.captured_at, "listing.captured_at"),
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      composition: "same_product",
    },
    frozen_review: frozen as unknown as VerifiedWalmartListingRepairCompilationRequest[
      "frozen_review"
    ],
    product_truth_candidate: {
      candidate_sha256: candidateSha,
      expected_sha256: expectedSha,
      donor_product_id: text(truth.donor_product_id, "donor_product_id", 512),
      single_unit_upc: text(truth.single_unit_upc, "single_unit_upc", 64),
      outer_units: outerUnits,
      ...(expected ? { expected } : {}),
    },
    repair: {
      baseline_surface: baselineSurface,
      target_surface: targetSurface,
      baseline_images: baselineImages,
      target_images: targetImages,
      changed_fields: textOnly
        ? ["description", "bullets"]
        : mainRepair
          ? ["description", "bullets", "main"]
          : ["attributes"],
      unchanged_image_bytes: !mainRepair,
      ...(changedMainEvidence ? { changed_main_evidence: changedMainEvidence } : {}),
    },
    owner_gate: {
      exact_confirmation: text(gate.exact_confirmation, "owner_gate.exact_confirmation"),
      confirms_only_reviewed_diff: true,
      confirmation_would_authorize_product_truth_activation: true,
      confirmation_would_authorize_one_sku_package_compilation: true,
      current_walmart_write_authorized: false,
      current_mass_run_authorized: false,
    },
    assurance: {
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
    next_required_inputs: Array.isArray(raw.next_required_inputs)
      ? raw.next_required_inputs.map((entry, index) =>
        text(entry, `next_required_inputs[${index}]`, 256))
      : fail("next_required_inputs must be an array"),
    body_sha256: claimedBodySha,
  };
}

/**
 * Build the exact one-SKU Product Truth binding used by the canary package.
 *
 * The binding is derived only from a byte-identified, already certified review
 * plus the exact owner confirmation. It is not a second catalog, cannot be
 * reused as a shared Product Truth activation, and does not authorize a Walmart
 * write. The package command subsequently binds its approval hash into both
 * owner Ed25519 signatures.
 */
export function buildReviewedWalmartListingRepairProductTruthArtifact(input: {
  compilation_request: unknown;
  compilation_request_file_sha256: string;
  owner_confirmation: string;
  approved_by: string;
  created_at: string;
}): ReviewedWalmartListingRepairProductTruthArtifact {
  const request = verifyWalmartListingRepairCompilationRequest(
    input.compilation_request,
  );
  const requestFileSha = digest(
    input.compilation_request_file_sha256,
    "compilation_request_file_sha256",
  );
  if (input.owner_confirmation !== request.owner_gate.exact_confirmation) {
    fail("owner confirmation does not match the exact frozen review");
  }
  const createdAt = instant(input.created_at, "reviewed truth created_at");
  if (Date.parse(createdAt) < Date.parse(request.created_at)) {
    fail("reviewed truth cannot predate its compilation request");
  }
  const approvedBy = text(input.approved_by, "approved_by", 256);
  const listing = listingIdentity(request);
  const snapshotBody = {
    schema_version: "walmart-listing-repair-reviewed-truth-snapshot/v1" as const,
    created_at: createdAt,
    compilation_request_file_sha256: requestFileSha,
    compilation_request_body_sha256: request.body_sha256,
    listing,
    frozen_review: request.frozen_review,
    product_truth_candidate: request.product_truth_candidate,
  };
  const snapshotBodySha = walmartListingIntegritySha256(snapshotBody);
  const snapshotId = `reviewed-one-sku-truth-${snapshotBodySha.slice(0, 24)}`;
  const revisionBody = {
    schema_version: "walmart-listing-repair-reviewed-truth-revision/v1" as const,
    snapshot_id: snapshotId,
    snapshot_body_sha256: snapshotBodySha,
    listing,
    expected_sha256: request.product_truth_candidate.expected_sha256,
    candidate_sha256: request.product_truth_candidate.candidate_sha256,
    target_surface_sha256: walmartListingIntegritySha256(
      request.repair.target_surface,
    ),
    target_images_sha256: walmartListingIntegritySha256(
      request.repair.target_images,
    ),
    changed_fields: request.repair.changed_fields,
  };
  const revisionBodySha = walmartListingIntegritySha256(revisionBody);
  const revisionId = `reviewed-truth-revision-${revisionBodySha.slice(0, 24)}`;
  const approvalBody = {
    schema_version: "walmart-listing-repair-reviewed-truth-approval/v1" as const,
    decision: "APPROVED_FOR_EXACT_ONE_SKU_PACKAGE_ONLY" as const,
    approved_by: approvedBy,
    exact_confirmation_sha256: walmartListingIntegritySha256(
      input.owner_confirmation,
    ),
    compilation_request_file_sha256: requestFileSha,
    compilation_request_body_sha256: request.body_sha256,
    truth_revision_body_sha256: revisionBodySha,
    authentication:
      "BOUND_INTO_OWNER_ED25519_SEQUENCE_AND_ONE_SKU_PERMIT" as const,
  };
  const approvalSha = walmartListingIntegritySha256(approvalBody);
  const binding: WalmartListingRepairProductTruthBinding = {
    expected_sha256: request.product_truth_candidate.expected_sha256,
    product_truth_snapshot_id: snapshotId,
    product_truth_snapshot_body_sha256: snapshotBodySha,
    truth_revision_id: revisionId,
    truth_revision_body_sha256: revisionBodySha,
    truth_approval_sha256: approvalSha,
  };
  const body = {
    schema_version: WALMART_LISTING_REPAIR_REVIEWED_TRUTH_SCHEMA,
    created_at: createdAt,
    status: "ACTIVE_FOR_EXACT_ONE_SKU_PACKAGE_ONLY" as const,
    snapshot: {
      snapshot_id: snapshotId,
      body_sha256: snapshotBodySha,
      compilation_request_file_sha256: requestFileSha,
      compilation_request_body_sha256: request.body_sha256,
      listing,
      frozen_review: request.frozen_review,
      product_truth_candidate: request.product_truth_candidate,
    },
    revision: {
      revision_id: revisionId,
      body_sha256: revisionBodySha,
      expected_sha256: request.product_truth_candidate.expected_sha256,
      candidate_sha256: request.product_truth_candidate.candidate_sha256,
      target_surface_sha256: revisionBody.target_surface_sha256,
      target_images_sha256: revisionBody.target_images_sha256,
    },
    approval: {
      ...approvalBody,
      approval_sha256: approvalSha,
    },
    binding,
    constraints: {
      exact_listing_count: 1 as const,
      walmart_content_write_authorized: false as const,
      mass_apply_allowed: false as const,
      price_required_for_content_truth: false as const,
      database_activation_required_for_this_canary_package: false as const,
      reusable_as_shared_catalog_activation: false as const,
    },
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
}

function listingIdentity(
  request: VerifiedWalmartListingRepairCompilationRequest,
): WalmartListingRepairListingIdentity {
  return {
    channel: "WALMART_US",
    store_index: request.listing.store_index,
    sku: request.listing.sku,
    listing_key: request.listing.listing_key,
    item_id: request.listing.item_id,
  };
}

export function buildWalmartListingRepairPlanFromCompilationRequest(input: {
  compilation_request: unknown;
  compilation_request_file_sha256: string;
  owner_confirmation: string;
  sequence_authorization: WalmartListingRepairSequenceAuthorization;
  product_truth_binding: WalmartListingRepairProductTruthBinding;
  plan_id: string;
  created_at: string;
  expires_at: string;
  verifier_engine_release_sha256: string;
  apply_engine_release_sha256: string;
  expected_environment?: WalmartListingRepairEnvironment;
}): SealedWalmartListingRepairPlan {
  const request = verifyWalmartListingRepairCompilationRequest(
    input.compilation_request,
  );
  const requestFileSha = digest(
    input.compilation_request_file_sha256,
    "compilation_request_file_sha256",
  );
  if (input.owner_confirmation !== request.owner_gate.exact_confirmation) {
    fail("owner confirmation does not match the exact frozen review");
  }
  const truth = input.product_truth_binding;
  if (truth.expected_sha256 !== request.product_truth_candidate.expected_sha256) {
    fail("active Product Truth differs from the reviewed exact truth");
  }
  for (const [field, value] of Object.entries(truth)) {
    if (field === "product_truth_snapshot_id" || field === "truth_revision_id") {
      text(value, `product_truth_binding.${field}`, 512);
    } else {
      digest(value, `product_truth_binding.${field}`);
    }
  }
  const listing = listingIdentity(request);
  const sequence = input.sequence_authorization;
  const expectedEnvironment = input.expected_environment ?? "PRODUCTION";
  if (sequence.signed_body.environment !== expectedEnvironment
    || sequence.signed_body.ordered_listings.length !== 1
    || walmartListingIntegritySha256(sequence.signed_body.ordered_listings)
      !== walmartListingIntegritySha256([listing])
    || sequence.signed_body.seller_account_fingerprint_sha256.length !== 64
    || sequence.signed_body.frozen_verifier_engine_release_sha256
      !== digest(
        input.verifier_engine_release_sha256,
        "verifier_engine_release_sha256",
      )) {
    fail("signed sequence is not bound to this one reviewed production SKU");
  }
  const createdAt = instant(input.created_at, "plan created_at");
  const expiresAt = instant(input.expires_at, "plan expires_at");
  if (Date.parse(createdAt) < Date.parse(request.listing.captured_at)
    || Date.parse(expiresAt) <= Date.parse(createdAt)
    || Date.parse(expiresAt) - Date.parse(createdAt) > MAX_PLAN_TTL_MS
    || Date.parse(expiresAt) > Date.parse(sequence.signed_body.expires_at)) {
    fail("plan window is invalid or outside the review/sequence");
  }
  const sourceInventory = {
    compilation_request_file_sha256: requestFileSha,
    compilation_request_body_sha256: request.body_sha256,
    ...request.frozen_review,
  };
  const target = {
    surface: request.repair.target_surface,
    images: request.repair.target_images,
    target_sha256: walmartListingIntegritySha256({
      surface: request.repair.target_surface,
      images: request.repair.target_images,
    }),
  };
  const body = {
    schema_version: WALMART_LISTING_REPAIR_PLAN_SCHEMA,
    plan_id: text(input.plan_id, "plan_id", 512),
    created_at: createdAt,
    expires_at: expiresAt,
    verifier_engine_release_sha256:
      sequence.signed_body.frozen_verifier_engine_release_sha256,
    apply_engine_release_sha256: digest(
      input.apply_engine_release_sha256,
      "apply_engine_release_sha256",
    ),
    sequence: {
      authorization_sha256: sequence.authorization_sha256,
      sequence_id: sequence.signed_body.sequence_id,
      sequence_epoch: sequence.signed_body.sequence_epoch,
      position: 0,
      population_artifact_sha256:
        sequence.signed_body.population_artifact_sha256,
    },
    listing: {
      ...listing,
      captured_at: request.listing.captured_at,
      published_status: request.listing.published_status,
      lifecycle_status: request.listing.lifecycle_status,
      composition: request.listing.composition,
    },
    baseline: {
      report_id: `owner-review-${request.frozen_review.diagnosis_file_sha256.slice(0, 16)}`,
      report_body_sha256: request.frozen_review.diagnosis_file_sha256,
      input_body_sha256: request.frozen_review.proposal_body_sha256,
      captured_at: request.listing.captured_at,
      overall_verdict: "BAD" as const,
      surface_sha256: walmartListingIntegritySha256(
        request.repair.baseline_surface,
      ),
      images_sha256: walmartListingIntegritySha256(
        request.repair.baseline_images,
      ),
      buyer_payload_sha256: request.frozen_review.buyer_pdp_file_sha256,
      surface_payload_sha256: walmartListingIntegritySha256(
        request.repair.baseline_surface,
      ),
      source_evidence_inventory_sha256:
        walmartListingIntegritySha256(sourceInventory),
      live_capture_exchange_sha256: walmartListingIntegritySha256({
        listing,
        captured_at: request.listing.captured_at,
        buyer_snapshot_file_sha256:
          request.frozen_review.buyer_snapshot_file_sha256,
        buyer_pdp_file_sha256: request.frozen_review.buyer_pdp_file_sha256,
      }),
      authenticated_capture_nonce_sha256: walmartListingIntegritySha256({
        compilation_request_file_sha256: requestFileSha,
        owner_confirmation: input.owner_confirmation,
        sequence_authorization_sha256: sequence.authorization_sha256,
      }),
    },
    product_truth: {
      ...truth,
      product_truth_snapshot_file_sha256:
        truth.product_truth_snapshot_body_sha256,
    },
    target,
    changed_fields: request.repair.changed_fields,
    execution_policy: {
      signed_one_sku_permit_required: true as const,
      durable_permit_consumption_required: true as const,
      exact_raw_walmart_exchange_required: true as const,
      exact_listing_count: 1 as const,
      max_marketplace_write_calls: 1 as const,
      fresh_live_reread_required: true as const,
      async_source_aware_rebuild_required: true as const,
      cached_qualification_is_authority: false as const,
      next_sku_requires_rebuilt_pass: true as const,
      mass_apply_allowed: false as const,
      automatic_reapply_allowed: false as const,
      propagation_failure_not_before_ms: 7_200_000 as const,
    },
  };
  return {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  } as SealedWalmartListingRepairPlan;
}

export interface WalmartListingRepairOwnerCompilerTiming {
  sequence_issued_at: string;
  sequence_expires_at: string;
  plan_created_at: string;
  plan_expires_at: string;
  certificate_created_at: string;
  certificate_expires_at: string;
  request_prepared_at: string;
  permit_issued_at: string;
  permit_expires_at: string;
  package_created_at: string;
}

export interface WalmartListingRepairOwnerCompilerMaterials {
  seller_account_fingerprint_sha256: string;
  capture_authority_public_key_spki_sha256: string;
  get_spec_receipt: WalmartListingSurgicalGetSpecReceipt;
  live_item_receipt: WalmartListingSurgicalLiveItemReceipt;
  get_spec_request_bytes: Uint8Array;
  get_spec_response_bytes: Uint8Array;
  live_item_response_bytes: Uint8Array;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
  ledger_state_directory: string;
  artifact_custody_root: string;
}

export interface WalmartListingRepairOwnerCompilerIds {
  sequence_id: string;
  sequence_epoch: string;
  plan_id: string;
  contract_id: string;
  permit_id: string;
  request_correlation_id: string;
  approved_by: string;
  decision_ref: string;
}

export interface WalmartListingRepairOwnerCompilerDraft {
  compilation_request: VerifiedWalmartListingRepairCompilationRequest;
  sequence_authorization: WalmartListingRepairSequenceAuthorization;
  plan: SealedWalmartListingRepairPlan;
  target_image_certificate:
    | SealedWalmartListingRepairUnchangedImageCertificate
    | SealedWalmartListingRepairReviewedMainCertificate;
  target_image_certificate_bytes: Uint8Array;
  target_image_certificate_kind: "UNCHANGED_IMAGES" | "REVIEWED_CHANGED_MAIN";
  schema_contract: WalmartListingSurgicalSchemaContract;
  built_request: BuiltWalmartListingSurgicalRequest;
  permit_signed_body: WalmartListingRepairOneSkuPermitSignedBody;
  execution_without_permit: {
    payload_context: JsonRecord;
    request_correlation_id: string;
    package_created_at: string;
    production_context: {
      ledger_state_directory: string;
      artifact_custody_root: string;
      sequence_evidence_packages: readonly unknown[];
      product_truth_binding: WalmartListingRepairProductTruthBinding;
    };
  };
  assurance: {
    exact_listing_count: 1;
    changed_fields:
      | ["description", "bullets"]
      | ["description", "bullets", "main"];
    current_walmart_write_authorized: false;
    mass_apply_allowed: false;
    network_calls: 0;
    model_calls: 0;
    database_reads: 0;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
  };
}

export interface WalmartListingRepairOwnerCompilerResult {
  draft: WalmartListingRepairOwnerCompilerDraft;
  one_sku_permit: WalmartListingRepairOneSkuPermit;
  execution: WalmartListingRepairProductionExecutionInput;
  execution_package: SealedWalmartListingRepairExecutionPackage;
  execution_package_bytes: Uint8Array;
  execution_package_sha256: string;
  assurance: WalmartListingRepairOwnerCompilerDraft["assurance"];
}

function exactEnvironment(
  value: unknown,
): WalmartListingRepairEnvironment {
  if (value !== "PRODUCTION" && value !== "TEST_FIXTURE_ONLY") {
    fail("environment must be PRODUCTION or TEST_FIXTURE_ONLY");
  }
  return value;
}

function exactListingFromRequest(
  request: VerifiedWalmartListingRepairCompilationRequest,
): WalmartListingRepairListingIdentity {
  return {
    channel: "WALMART_US",
    store_index: request.listing.store_index,
    sku: request.listing.sku,
    listing_key: request.listing.listing_key,
    item_id: request.listing.item_id,
  };
}

export function buildWalmartListingRepairSequenceBodyFromCompilationRequest(
  input: {
    compilation_request: unknown;
    compilation_request_file_sha256: string;
    environment?: WalmartListingRepairEnvironment;
    sequence_id: string;
    sequence_epoch: string;
    issued_at: string;
    expires_at: string;
    approved_by: string;
    decision_ref: string;
    seller_account_fingerprint_sha256: string;
    verifier_engine_release_sha256: string;
    capture_authority_public_key_spki_sha256: string;
  },
): WalmartListingRepairSequenceSignedBody {
  const request = verifyWalmartListingRepairCompilationRequest(
    input.compilation_request,
  );
  const environment = exactEnvironment(input.environment ?? "PRODUCTION");
  const issuedAt = instant(input.issued_at, "sequence issued_at");
  const expiresAt = instant(input.expires_at, "sequence expires_at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt) > 7 * 24 * 60 * 60 * 1_000) {
    fail("sequence window must be positive and at most seven days");
  }
  return {
    action: WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
    environment,
    sequence_id: text(input.sequence_id, "sequence_id", 200),
    sequence_epoch: text(input.sequence_epoch, "sequence_epoch", 200),
    issued_at: issuedAt,
    expires_at: expiresAt,
    approved_by: text(input.approved_by, "approved_by", 256),
    decision_ref: text(input.decision_ref, "decision_ref", 2_048),
    seller_account_fingerprint_sha256: digest(
      input.seller_account_fingerprint_sha256,
      "seller_account_fingerprint_sha256",
    ),
    population_artifact_sha256: digest(
      input.compilation_request_file_sha256,
      "compilation_request_file_sha256",
    ),
    frozen_verifier_engine_release_sha256: digest(
      input.verifier_engine_release_sha256,
      "verifier_engine_release_sha256",
    ),
    capture_authority_public_key_spki_sha256: digest(
      input.capture_authority_public_key_spki_sha256,
      "capture_authority_public_key_spki_sha256",
    ),
    ordered_listings: [exactListingFromRequest(request)],
    claims: {
      exact_ordered_population: true,
      source_aware_rebuild_required: true,
      next_sku_requires_rebuilt_pass: true,
      marketplace_writes_authorized: false,
      sequence_is_not_a_write_permit: true,
      mass_apply_allowed: false,
    },
  };
}

function schemaContract(input: {
  request: VerifiedWalmartListingRepairCompilationRequest;
  plan: SealedWalmartListingRepairPlan;
  contract_id: string;
  materials: WalmartListingRepairOwnerCompilerMaterials;
}): WalmartListingSurgicalSchemaContract {
  const getSpecRequestBytes = exactBytes(
    input.materials.get_spec_request_bytes,
    "Get Spec request bytes",
  );
  const getSpecResponseBytes = exactBytes(
    input.materials.get_spec_response_bytes,
    "Get Spec response bytes",
  );
  const liveItemResponseBytes = exactBytes(
    input.materials.live_item_response_bytes,
    "live item response bytes",
  );
  const getSpecRequest = jsonBytes(getSpecRequestBytes, "Get Spec request");
  const getSpecResponse = jsonBytes(getSpecResponseBytes, "Get Spec response");
  const liveItemResponse = jsonBytes(liveItemResponseBytes, "live item response");
  if (getSpecRequest.feedType !== "MP_MAINTENANCE"
    || getSpecRequest.version !== WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION
    || !Array.isArray(getSpecRequest.productTypes)
    || getSpecRequest.productTypes.length !== 1
    || typeof getSpecRequest.productTypes[0] !== "string") {
    fail("Get Spec request does not contain one current MP_MAINTENANCE product type");
  }
  const productType = text(
    getSpecRequest.productTypes[0],
    "Get Spec product type",
    512,
  );
  if (!Array.isArray(liveItemResponse.ItemResponse)
    || liveItemResponse.ItemResponse.length !== 1) {
    fail("live item response must contain one ItemResponse row");
  }
  const liveRow = record(liveItemResponse.ItemResponse[0], "live ItemResponse[0]");
  if (liveRow.productType !== productType) {
    fail("live item product type differs from Get Spec product type");
  }
  const schemaValue = Object.hasOwn(getSpecResponse, "schema")
    ? getSpecResponse.schema
    : getSpecResponse;
  let schema: JsonRecord;
  if (typeof schemaValue === "string") {
    try {
      schema = record(JSON.parse(schemaValue), "Get Spec schema");
    } catch {
      return fail("Get Spec schema string is invalid JSON");
    }
  } else {
    schema = record(schemaValue, "Get Spec schema");
  }
  const fetchedAt = instant(
    input.materials.get_spec_receipt.fetched_at,
    "Get Spec fetched_at",
  );
  const validUntil = new Date(
    Date.parse(fetchedAt) + WALMART_LISTING_SURGICAL_MAX_SPEC_AGE_MS,
  ).toISOString();
  const productIdentifier: WalmartListingSurgicalProductIdentifier = {
    productIdType: "UPC",
    productId: input.request.listing.seller_upc,
  };
  const claimKey = (claim: ListingAttributeClaim) => (
    `${claim.field_path}\u0000${claim.kind}`
  );
  const baselineClaims = new Map(
    input.request.repair.baseline_surface.attribute_claims.map((claim) => [
      claimKey(claim),
      claim,
    ]),
  );
  const mappings: WalmartListingSurgicalAttributeMapping[] =
    input.request.repair.changed_fields.includes("attributes")
      ? input.request.repair.target_surface.attribute_claims
        .filter((claim) => {
          const baseline = baselineClaims.get(claimKey(claim));
          return !baseline
            || walmartListingIntegritySha256(baseline)
              !== walmartListingIntegritySha256(claim);
        })
        .map((claim): WalmartListingSurgicalAttributeMapping => {
          const normalizedPath = claim.field_path.toLowerCase()
            .replace(/[^a-z0-9]/gu, "");
          let walmartVisibleField: string;
          if (claim.kind === "variant" && normalizedPath.endsWith("flavor")) {
            walmartVisibleField = "flavor";
          } else if (claim.kind === "outer_units"
            && normalizedPath.endsWith("multipackquantity")) {
            walmartVisibleField = "multipackQuantity";
          } else if (claim.kind === "inner_item_count"
            && normalizedPath.endsWith("countperpack")) {
            walmartVisibleField = "countPerPack";
          } else if (claim.kind === "inner_item_count"
            && normalizedPath.endsWith("count")) {
            walmartVisibleField = "count";
          } else {
            return fail(
              `attribute-only compiler has no approved Walmart mapping for `
              + `${claim.field_path}/${claim.kind}`,
            );
          }
          const walmartValue = "text" in claim ? claim.text : claim.value;
          return {
            source_field_path: claim.field_path,
            source_kind: claim.kind,
            source_claim_sha256: walmartListingIntegritySha256(claim),
            walmart_visible_field: walmartVisibleField,
            walmart_value: walmartValue,
            walmart_value_sha256: walmartListingSurgicalSha256(walmartValue),
          };
        })
        .sort((left, right) => (
          left.walmart_visible_field < right.walmart_visible_field ? -1
            : left.walmart_visible_field > right.walmart_visible_field ? 1 : 0
        ))
      : [];
  if (input.request.repair.changed_fields.includes("attributes")) {
    const targetKeys = new Set(
      input.request.repair.target_surface.attribute_claims.map(claimKey),
    );
    if (input.request.repair.baseline_surface.attribute_claims.some((claim) => (
      !targetKeys.has(claimKey(claim))
    ))) {
      fail("attribute-only compiler cannot clear an existing typed attribute");
    }
    if (mappings.length < 1) {
      fail("attribute-only compiler found no changed attribute claims");
    }
  }
  const mappingApprovalSha = walmartListingIntegritySha256({
    authority: mappings.length
      ? "OWNER_REVIEWED_EXACT_ATTRIBUTE_FIELDS"
      : "OWNER_REVIEWED_CORE_FIELDS_ONLY",
    compilation_request_body_sha256: input.request.body_sha256,
    plan_body_sha256: input.plan.body_sha256,
    changed_fields: input.plan.changed_fields,
    attribute_mappings: mappings,
  });
  const body = {
    schema_version: WALMART_LISTING_SURGICAL_SCHEMA_CONTRACT_SCHEMA,
    contract_id: text(input.contract_id, "contract_id", 200),
    plan_id: input.plan.plan_id,
    plan_body_sha256: input.plan.body_sha256,
    target_sha256: input.plan.target.target_sha256,
    listing: {
      channel: "WALMART_US" as const,
      store_index: input.request.listing.store_index,
      sku: input.request.listing.sku,
      listing_key: input.request.listing.listing_key,
      item_id: input.request.listing.item_id,
      product_identifier: productIdentifier,
      product_type: productType,
      live_item_capture_sha256: bytesDigest(liveItemResponseBytes),
      live_item_receipt_body_sha256:
        input.materials.live_item_receipt.body_sha256,
      live_item_captured_at: input.materials.live_item_receipt.captured_at,
    },
    spec: {
      feed_type: "MP_MAINTENANCE" as const,
      business_unit: "WALMART_US" as const,
      locale: "en" as const,
      version: WALMART_LISTING_SURGICAL_CURRENT_SPEC_VERSION,
      product_type: productType,
      request_payload_sha256: bytesDigest(getSpecRequestBytes),
      response_payload_sha256: bytesDigest(getSpecResponseBytes),
      schema_sha256: walmartListingSurgicalSha256(schema),
      get_spec_receipt_body_sha256:
        input.materials.get_spec_receipt.body_sha256,
      valid_until: validUntil,
    },
    schema_mapping_approval_sha256: mappingApprovalSha,
    attribute_mappings: mappings,
    claims: {
      exact_one_sku: true as const,
      changed_fields_only: true as const,
      full_target_is_qa_reference_only: true as const,
      audit_claims_are_not_write_schema: true as const,
      blank_or_null_clear_forbidden: true as const,
      preserve_unapproved_fields_by_omission: true as const,
      retries: 0 as const,
      redirects: 0 as const,
    },
  };
  return {
    ...body,
    body_sha256: walmartListingSurgicalSha256(body),
  };
}

function assertReceiptSchemas(
  materials: WalmartListingRepairOwnerCompilerMaterials,
): void {
  if (materials.get_spec_receipt.schema_version
      !== WALMART_LISTING_SURGICAL_GET_SPEC_RECEIPT_SCHEMA
    || materials.live_item_receipt.schema_version
      !== WALMART_LISTING_SURGICAL_LIVE_ITEM_RECEIPT_SCHEMA) {
    fail("Walmart material receipt schema is unsupported");
  }
  const sellerFingerprint = digest(
    materials.seller_account_fingerprint_sha256,
    "seller_account_fingerprint_sha256",
  );
  if (materials.get_spec_receipt.seller_account_fingerprint_sha256
      !== sellerFingerprint
    || materials.live_item_receipt.seller_account_fingerprint_sha256
      !== sellerFingerprint) {
    fail("Walmart material receipts are from another seller account");
  }
  digest(
    materials.capture_authority_public_key_spki_sha256,
    "capture_authority_public_key_spki_sha256",
  );
}

function assertCompilerTiming(
  timing: WalmartListingRepairOwnerCompilerTiming,
): void {
  const parsed = {
    sequenceIssued: Date.parse(instant(
      timing.sequence_issued_at,
      "sequence issued_at",
    )),
    sequenceExpires: Date.parse(instant(
      timing.sequence_expires_at,
      "sequence expires_at",
    )),
    planCreated: Date.parse(instant(timing.plan_created_at, "plan created_at")),
    planExpires: Date.parse(instant(timing.plan_expires_at, "plan expires_at")),
    certificateCreated: Date.parse(instant(
      timing.certificate_created_at,
      "certificate created_at",
    )),
    certificateExpires: Date.parse(instant(
      timing.certificate_expires_at,
      "certificate expires_at",
    )),
    requestPrepared: Date.parse(instant(
      timing.request_prepared_at,
      "request prepared_at",
    )),
    permitIssued: Date.parse(instant(timing.permit_issued_at, "permit issued_at")),
    permitExpires: Date.parse(instant(
      timing.permit_expires_at,
      "permit expires_at",
    )),
    packageCreated: Date.parse(instant(
      timing.package_created_at,
      "package created_at",
    )),
  };
  if (parsed.sequenceIssued > parsed.planCreated
    || parsed.planCreated > parsed.certificateCreated
    || parsed.certificateCreated > parsed.requestPrepared
    || parsed.requestPrepared > parsed.permitIssued
    || parsed.permitIssued > parsed.packageCreated
    || parsed.packageCreated >= parsed.permitExpires
    || parsed.permitExpires > parsed.certificateExpires
    || parsed.certificateExpires > parsed.planExpires
    || parsed.planExpires > parsed.sequenceExpires) {
    fail("compiler timestamps are not one bounded sequence→plan→request→permit window");
  }
}

function permitBody(input: {
  environment: WalmartListingRepairEnvironment;
  draftPlan: SealedWalmartListingRepairPlan;
  sequence: WalmartListingRepairSequenceAuthorization;
  certificateSha256: string;
  built: BuiltWalmartListingSurgicalRequest;
  truth: WalmartListingRepairProductTruthBinding;
  ledger: WalmartListingRepairConsumptionLedgerBinding;
  ids: WalmartListingRepairOwnerCompilerIds;
  timing: WalmartListingRepairOwnerCompilerTiming;
}): WalmartListingRepairOneSkuPermitSignedBody {
  const issuedAt = instant(input.timing.permit_issued_at, "permit issued_at");
  const expiresAt = instant(input.timing.permit_expires_at, "permit expires_at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt)
      > MAX_ONE_SKU_PERMIT_TTL_MS) {
    fail("permit window must be positive and at most 30 minutes");
  }
  return {
    action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
    environment: input.environment,
    permit_id: text(input.ids.permit_id, "permit_id", 200),
    issued_at: issuedAt,
    expires_at: expiresAt,
    approved_by: text(input.ids.approved_by, "approved_by", 256),
    decision_ref: text(input.ids.decision_ref, "decision_ref", 2_048),
    sequence_authorization_sha256: input.sequence.authorization_sha256,
    sequence_id: input.sequence.signed_body.sequence_id,
    sequence_epoch: input.sequence.signed_body.sequence_epoch,
    sequence_position: 0,
    listing: {
      channel: input.draftPlan.listing.channel,
      store_index: input.draftPlan.listing.store_index,
      sku: input.draftPlan.listing.sku,
      listing_key: input.draftPlan.listing.listing_key,
      item_id: input.draftPlan.listing.item_id,
    },
    plan_id: input.draftPlan.plan_id,
    plan_body_sha256: input.draftPlan.body_sha256,
    target_sha256: input.draftPlan.target.target_sha256,
    target_image_certificate_sha256: input.certificateSha256,
    baseline_capture_exchange_sha256:
      input.draftPlan.baseline.live_capture_exchange_sha256,
    product_truth: structuredClone(input.truth),
    apply_engine_release_sha256:
      input.draftPlan.apply_engine_release_sha256,
    request_manifest_sha256: input.built.request_manifest_sha256,
    request_payload_sha256: input.built.payload_sha256,
    consumption_ledger: structuredClone(input.ledger),
    claims: {
      exact_listing_count: 1,
      marketplace_write_calls: 1,
      retry_allowed: false,
      automatic_reapply_allowed: false,
      mass_apply_allowed: false,
      delist: false,
      reprice: false,
      purchase: false,
      schedule: false,
    },
  };
}

export function compileWalmartListingRepairOwnerDraft(input: {
  environment?: WalmartListingRepairEnvironment;
  compilation_request: unknown;
  compilation_request_file_sha256: string;
  owner_confirmation: string;
  sequence_authorization: WalmartListingRepairSequenceAuthorization;
  product_truth_binding: WalmartListingRepairProductTruthBinding;
  verifier_engine_release_sha256: string;
  apply_engine_release_sha256: string;
  ids: WalmartListingRepairOwnerCompilerIds;
  timing: WalmartListingRepairOwnerCompilerTiming;
  materials: WalmartListingRepairOwnerCompilerMaterials;
  reviewed_main_certificate_bytes?: Uint8Array;
}): WalmartListingRepairOwnerCompilerDraft {
  const environment = exactEnvironment(input.environment ?? "PRODUCTION");
  assertReceiptSchemas(input.materials);
  assertCompilerTiming(input.timing);
  const request = verifyWalmartListingRepairCompilationRequest(
    input.compilation_request,
  );
  const expectedSequenceBody =
    buildWalmartListingRepairSequenceBodyFromCompilationRequest({
      compilation_request: request,
      compilation_request_file_sha256:
        input.compilation_request_file_sha256,
      environment,
      sequence_id: input.ids.sequence_id,
      sequence_epoch: input.ids.sequence_epoch,
      issued_at: input.timing.sequence_issued_at,
      expires_at: input.timing.sequence_expires_at,
      approved_by: input.ids.approved_by,
      decision_ref: input.ids.decision_ref,
      seller_account_fingerprint_sha256:
        input.materials.seller_account_fingerprint_sha256,
      verifier_engine_release_sha256:
        input.verifier_engine_release_sha256,
      capture_authority_public_key_spki_sha256:
        input.materials.capture_authority_public_key_spki_sha256,
    });
  if (walmartListingIntegritySha256(
    input.sequence_authorization.signed_body,
  ) !== walmartListingIntegritySha256(expectedSequenceBody)) {
    fail("verified sequence differs from the exact compiler request/materials");
  }
  const plan = buildWalmartListingRepairPlanFromCompilationRequest({
    compilation_request: request,
    compilation_request_file_sha256:
      input.compilation_request_file_sha256,
    owner_confirmation: input.owner_confirmation,
    sequence_authorization: input.sequence_authorization,
    product_truth_binding: input.product_truth_binding,
    plan_id: input.ids.plan_id,
    created_at: input.timing.plan_created_at,
    expires_at: input.timing.plan_expires_at,
    verifier_engine_release_sha256:
      input.verifier_engine_release_sha256,
    apply_engine_release_sha256: input.apply_engine_release_sha256,
    expected_environment: environment,
  });
  const imagesChanged = request.repair.changed_fields.includes("main");
  let certificate:
    | SealedWalmartListingRepairUnchangedImageCertificate
    | SealedWalmartListingRepairReviewedMainCertificate;
  let certificateBytes: Uint8Array;
  let certificateKind: "UNCHANGED_IMAGES" | "REVIEWED_CHANGED_MAIN";
  if (imagesChanged) {
    certificateBytes = exactBytes(
      input.reviewed_main_certificate_bytes,
      "reviewed MAIN certificate bytes",
    );
    certificate = verifyWalmartListingRepairReviewedMainCertificateBytes({
      certificate_bytes: certificateBytes,
      plan,
      at: new Date(input.timing.request_prepared_at),
    });
    certificateKind = "REVIEWED_CHANGED_MAIN";
  } else {
    certificate = certifyWalmartListingRepairUnchangedImages({
      plan,
      created_at: input.timing.certificate_created_at,
      expires_at: input.timing.certificate_expires_at,
      compilation_request_file_sha256:
        input.compilation_request_file_sha256,
      compilation_request_body_sha256: request.body_sha256,
      proposal_file_sha256: request.frozen_review.proposal_file_sha256,
      review_certification_file_sha256:
        request.frozen_review.certification_file_sha256,
      baseline_images: request.repair.baseline_images,
    });
    certificateBytes = Buffer.from(
      canonicalWalmartListingSurgicalJson(certificate),
      "utf8",
    );
    verifyWalmartListingRepairUnchangedImageCertificateBytes({
      certificate_bytes: certificateBytes,
      plan,
      at: new Date(input.timing.request_prepared_at),
    });
    certificateKind = "UNCHANGED_IMAGES";
  }
  const contract = schemaContract({
    request,
    plan,
    contract_id: input.ids.contract_id,
    materials: input.materials,
  });
  const requestCorrelationSha = bytesDigest(
    Buffer.from(input.ids.request_correlation_id, "utf8"),
  );
  const payloadContext = {
    baseline: {
      surface: request.repair.baseline_surface,
      images: request.repair.baseline_images,
    },
    schema_contract: contract,
    get_spec_receipt: input.materials.get_spec_receipt,
    live_item_receipt: input.materials.live_item_receipt,
    target_image_certificate_bytes: certificateBytes,
    get_spec_request_bytes: exactBytes(
      input.materials.get_spec_request_bytes,
      "Get Spec request bytes",
    ),
    get_spec_response_bytes: exactBytes(
      input.materials.get_spec_response_bytes,
      "Get Spec response bytes",
    ),
    live_item_response_bytes: exactBytes(
      input.materials.live_item_response_bytes,
      "live item response bytes",
    ),
    request: {
      permit_id: input.ids.permit_id,
      target_image_certificate_sha256: bytesDigest(certificateBytes),
      seller_account_fingerprint_sha256:
        input.materials.seller_account_fingerprint_sha256,
      request_correlation_id_sha256: requestCorrelationSha,
      prepared_at: instant(
        input.timing.request_prepared_at,
        "request prepared_at",
      ),
    },
  };
  const built = buildWalmartListingSurgicalRequest({
    plan,
    ...payloadContext,
  });
  const signedPermitBody = permitBody({
    environment,
    draftPlan: plan,
    sequence: input.sequence_authorization,
    certificateSha256: bytesDigest(certificateBytes),
    built,
    truth: input.product_truth_binding,
    ledger: input.materials.consumption_ledger,
    ids: input.ids,
    timing: input.timing,
  });
  return {
    compilation_request: request,
    sequence_authorization: structuredClone(input.sequence_authorization),
    plan,
    target_image_certificate: certificate,
    target_image_certificate_bytes: certificateBytes,
    target_image_certificate_kind: certificateKind,
    schema_contract: contract,
    built_request: built,
    permit_signed_body: signedPermitBody,
    execution_without_permit: {
      payload_context: payloadContext,
      request_correlation_id: input.ids.request_correlation_id,
      package_created_at: instant(
        input.timing.package_created_at,
        "package created_at",
      ),
      production_context: {
        ledger_state_directory: text(
          input.materials.ledger_state_directory,
          "ledger_state_directory",
          4_096,
        ),
        artifact_custody_root: text(
          input.materials.artifact_custody_root,
          "artifact_custody_root",
          4_096,
        ),
        sequence_evidence_packages: [],
        product_truth_binding: structuredClone(
          input.product_truth_binding,
        ),
      },
    },
    assurance: {
      exact_listing_count: 1,
      changed_fields: request.repair.changed_fields,
      current_walmart_write_authorized: false,
      mass_apply_allowed: false,
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
  };
}

function assertPermitMatchesDraft(input: {
  draft: WalmartListingRepairOwnerCompilerDraft;
  permit: WalmartListingRepairOneSkuPermit;
}): void {
  if (walmartListingIntegritySha256(input.permit.signed_body)
      !== walmartListingIntegritySha256(input.draft.permit_signed_body)
    || input.permit.signed_body.plan_body_sha256
      !== input.draft.plan.body_sha256
    || input.permit.signed_body.request_manifest_sha256
      !== input.draft.built_request.request_manifest_sha256
    || input.permit.signed_body.request_payload_sha256
      !== input.draft.built_request.payload_sha256) {
    fail("verified one-SKU permit differs from the compiled exact draft");
  }
}

export function finalizeWalmartListingRepairExecutionPackage(input: {
  draft: WalmartListingRepairOwnerCompilerDraft;
  verified_one_sku_permit: WalmartListingRepairOneSkuPermit;
}): WalmartListingRepairOwnerCompilerResult {
  assertPermitMatchesDraft({
    draft: input.draft,
    permit: input.verified_one_sku_permit,
  });
  const execution: WalmartListingRepairProductionExecutionInput = {
    writer_input: {
      sequence_authorization: structuredClone(
        input.draft.sequence_authorization,
      ),
      one_sku_permit: structuredClone(input.verified_one_sku_permit),
      plan: input.draft.plan,
      payload_context: structuredClone(
        input.draft.execution_without_permit.payload_context,
      ),
      target_image_certificate_context: {},
      request_correlation_id:
        input.draft.execution_without_permit.request_correlation_id,
      poll_policy: {
        max_attempts: 20,
        delay_ms: 60_000,
      },
    },
    production_context: structuredClone(
      input.draft.execution_without_permit.production_context,
    ),
  };
  const sealed = sealWalmartListingRepairExecutionPackage({
    created_at: instant(
      input.draft.execution_without_permit.package_created_at,
      "package created_at",
    ),
    execution,
  });
  const bytes = Buffer.from(
    renderWalmartListingRepairExecutionPackage(sealed),
    "utf8",
  );
  const artifactSha = bytesDigest(bytes);
  const parsed = parseWalmartListingRepairExecutionPackageBytes({
    artifact_bytes: bytes,
    expected_artifact_sha256: artifactSha,
  });
  if (parsed.execution.writer_input.plan.body_sha256
      !== input.draft.plan.body_sha256) {
    fail("execution package reread differs from compiled plan");
  }
  return {
    draft: input.draft,
    one_sku_permit: structuredClone(input.verified_one_sku_permit),
    execution,
    execution_package: sealed,
    execution_package_bytes: bytes,
    execution_package_sha256: artifactSha,
    assurance: input.draft.assurance,
  };
}
