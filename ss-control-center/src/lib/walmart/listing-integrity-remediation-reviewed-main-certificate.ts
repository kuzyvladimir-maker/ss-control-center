/**
 * Owner-compiler certificate for one reviewed MAIN replacement.
 *
 * The compiler rebuilds the exact Product Truth -> deterministic composite ->
 * signed blind observation -> public content-addressed URL chain. The sealed
 * certificate is evidence only; the separate Ed25519 one-SKU permit remains
 * the sole marketplace write authority.
 */

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  type ProductTruthSnapshot,
} from "../sourcing/product-truth-read-contract.ts";

import {
  decideBlind,
  type AuditExpectedTruth,
  type AuditImageInput,
} from "./catalog-visual-audit.ts";
import { preprocessCatalogVisual } from "./catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_SINGLE_OBSERVER_CODEX_WORKER_CONTRACT,
  WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  verifyWalmartListingSingleWorkerResponse,
  type WalmartListingSingleObserverPlan,
} from "./listing-integrity-single-observer.ts";
import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";
import {
  canonicalWalmartListingSurgicalJson,
} from "./listing-integrity-remediation-payload.ts";
import {
  productTruthSupportsWalmartListingIntegrityAudit,
  walmartListingIntegrityBlockingContentCodes,
} from "./listing-integrity-single-pipeline.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
  type WalmartListingRepairTargetImage,
} from "./listing-integrity-remediation-qualification.ts";
import { composeTiledMainImage } from "./multipack/composite.ts";

export const WALMART_LISTING_REPAIR_REVIEWED_MAIN_CERTIFICATE_SCHEMA =
  "walmart-listing-repair-reviewed-main-certificate/v1" as const;

type JsonRecord = Record<string, unknown>;

export interface ExactReviewedMainArtifact {
  bytes: Uint8Array;
  sha256: string;
}

export interface WalmartListingRepairReviewedMainEvidence {
  product_truth: ExactReviewedMainArtifact;
  candidate_manifest: ExactReviewedMainArtifact;
  single_unit_source: ExactReviewedMainArtifact;
  candidate_asset: ExactReviewedMainArtifact;
  qualification: ExactReviewedMainArtifact;
  observer_plan: ExactReviewedMainArtifact;
  observer_request: ExactReviewedMainArtifact;
  observer_response: ExactReviewedMainArtifact;
  r2_staging: ExactReviewedMainArtifact;
}

export interface SealedWalmartListingRepairReviewedMainCertificate
  extends JsonRecord {
  schema_version: typeof WALMART_LISTING_REPAIR_REVIEWED_MAIN_CERTIFICATE_SCHEMA;
  certificate_id: string;
  created_at: string;
  expires_at: string;
  plan: {
    plan_id: string;
    body_sha256: string;
    target_sha256: string;
  };
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  product_truth: {
    artifact_sha256: string;
    expected_sha256: string;
    canonical_variant_id: string;
    content_observation_id: string;
    outer_units: number;
  };
  changed_main: {
    source_url: string;
    asset_sha256: string;
    byte_size: number;
    width: number;
    height: number;
    content_type: "image/png";
    derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE";
    single_unit_source_artifact_sha256: string;
    single_unit_source_sha256: string;
    candidate_manifest_artifact_sha256: string;
    candidate_manifest_body_sha256: string;
    qualification_artifact_sha256: string;
    qualification_body_sha256: string;
    observer_plan_artifact_sha256: string;
    observer_plan_body_sha256: string;
    observer_request_artifact_sha256: string;
    observer_response_artifact_sha256: string;
    worker_receipt_key_id: string;
    worker_receipt_public_key_spki_sha256: string;
    worker_build: `sha256:${string}`;
    blind_decision_sha256: string;
    r2_staging_artifact_sha256: string;
    r2_staging_body_sha256: string;
  };
  unchanged_gallery: {
    exact_projection_sha256: string;
    slot_count: number;
  };
  owner_review: {
    compilation_request_file_sha256: string;
    compilation_request_body_sha256: string;
    exact_confirmation_sha256: string;
  };
  policy: {
    changed_fields_exactly_description_bullets_main: true;
    exact_product_truth_verified: true;
    deterministic_candidate_bytes_verified: true;
    signed_blind_worker_receipt_verified: true;
    blind_visual_decision_passed: true;
    content_addressed_public_bytes_verified: true;
    gallery_preserved_exactly: true;
    authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY";
    owner_permit_must_bind_certificate_sha256: true;
  };
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart reviewed-MAIN certificate rejected: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])) {
    fail(`${label} fields are not exact`);
  }
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactBytes(
  artifact: ExactReviewedMainArtifact,
  label: string,
  maximum = 100 * 1024 * 1024,
): Buffer {
  if (!(artifact?.bytes instanceof Uint8Array) || artifact.bytes.byteLength < 1
    || artifact.bytes.byteLength > maximum) {
    fail(`${label} exact bytes are missing or exceed the cap`);
  }
  const bytes = Buffer.from(artifact.bytes);
  if (sha256(bytes) !== digest(artifact.sha256, `${label}.sha256`)) {
    fail(`${label} exact file SHA mismatch`);
  }
  return bytes;
}

function jsonArtifact(
  artifact: ExactReviewedMainArtifact,
  label: string,
): { bytes: Buffer; value: JsonRecord; sha256: string } {
  const bytes = artifactBytes(artifact, label);
  try {
    return {
      bytes,
      value: record(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), label),
      sha256: artifact.sha256,
    };
  } catch {
    return fail(`${label} must be UTF-8 JSON`);
  }
}

function verifiedBody(value: JsonRecord, label: string): {
  body: JsonRecord;
  body_sha256: string;
} {
  const claimed = digest(value.body_sha256, `${label}.body_sha256`);
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) {
    fail(`${label} body SHA mismatch`);
  }
  return { body, body_sha256: claimed };
}

function exactEqual(left: unknown, right: unknown): boolean {
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
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.toString() !== raw) {
    fail(`${label} must be canonical query-free HTTPS`);
  }
  return raw;
}

function parsePlan(
  value: SealedWalmartListingRepairPlan,
  nowMs: number,
): SealedWalmartListingRepairPlan {
  const raw = record(value, "repair plan");
  if (raw.schema_version !== WALMART_LISTING_REPAIR_PLAN_SCHEMA) {
    fail("repair plan schema is unsupported");
  }
  verifiedBody(raw, "repair plan");
  if (!exactEqual(raw.changed_fields, ["description", "bullets", "main"])) {
    fail("repair plan must change exactly description, bullets, and MAIN");
  }
  const created = Date.parse(instant(raw.created_at, "repair plan created_at"));
  const expires = Date.parse(instant(raw.expires_at, "repair plan expires_at"));
  if (nowMs < created || nowMs >= expires) fail("repair plan is not currently valid");
  return value;
}

function parseObserverPlan(raw: JsonRecord): WalmartListingSingleObserverPlan {
  const verified = verifiedBody(raw, "observer plan");
  if (raw.schema_version !== "walmart-listing-single-observer-plan/v1"
    || (!exactEqual(raw.worker_contract, WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT)
      && !exactEqual(
        raw.worker_contract,
        WALMART_LISTING_SINGLE_OBSERVER_CODEX_WORKER_CONTRACT,
      ))
    || !Array.isArray(raw.assets) || raw.assets.length !== 1
    || !Array.isArray(raw.calls) || raw.calls.length !== 1) {
    fail("observer plan is not the exact pinned one-MAIN contract");
  }
  if (verified.body_sha256 !== raw.body_sha256) fail("observer plan seal did not rebuild");
  return raw as unknown as WalmartListingSingleObserverPlan;
}

export async function certifyWalmartListingRepairReviewedMain(input: {
  now: Date | string;
  expires_at: string;
  plan: SealedWalmartListingRepairPlan;
  expected: AuditExpectedTruth;
  baseline_images: WalmartListingRepairTargetImage[];
  compilation_request_file_sha256: string;
  compilation_request_body_sha256: string;
  owner_confirmation: string;
  evidence: WalmartListingRepairReviewedMainEvidence;
}): Promise<SealedWalmartListingRepairReviewedMainCertificate> {
  const now = input.now instanceof Date ? input.now.toISOString() : instant(input.now, "now");
  const nowMs = Date.parse(now);
  const expiresAt = instant(input.expires_at, "expires_at");
  const plan = parsePlan(input.plan, nowMs);
  if (Date.parse(expiresAt) <= nowMs || Date.parse(expiresAt) > Date.parse(plan.expires_at)) {
    fail("certificate expiry must be after creation and within the repair plan");
  }
  if (walmartListingIntegritySha256(input.expected)
      !== plan.product_truth.expected_sha256) {
    fail("exact Product Truth expected facts differ from repair plan");
  }

  const truthArtifact = jsonArtifact(input.evidence.product_truth, "Product Truth");
  const truth = truthArtifact.value;
  const snapshot = record(truth.snapshot, "Product Truth.snapshot");
  const views = record(truth.views, "Product Truth.views");
  const listingImprovement = record(
    views.listingImprovement,
    "Product Truth.views.listingImprovement",
  );
  if (truth.contractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION
    || snapshot.channel !== "walmart"
    || snapshot.storeIndex !== plan.listing.store_index
    || snapshot.sku !== plan.listing.sku
    || snapshot.listingKey !== plan.listing.listing_key
    || !productTruthSupportsWalmartListingIntegrityAudit(
      truth as unknown as ProductTruthSnapshot,
    )
    || !Array.isArray(listingImprovement.components)
    || listingImprovement.components.length !== 1) {
    fail("Product Truth is not one exact Listing Improvement component for this listing");
  }
  const component = record(listingImprovement.components[0], "Product Truth component");
  const content = record(component.content, "Product Truth component.content");
  const provenance = record(content.provenance, "Product Truth content.provenance");
  const outerUnits = positiveInteger(component.qty, "Product Truth component.qty");
  const canonicalVariantId = text(
    component.targetCanonicalVariantId,
    "Product Truth canonical variant",
    512,
  );
  const contentObservationId = text(
    provenance.contentObservationId,
    "Product Truth content observation",
    512,
  );
  if (outerUnits !== input.expected.outer_units
    || content.canonicalVariantId !== canonicalVariantId
    || !Array.isArray(component.contentBlockers)
    || walmartListingIntegrityBlockingContentCodes(
      component.contentBlockers as string[],
    ).length !== 0) {
    fail("Product Truth component/count/content is incomplete or contradictory");
  }

  const candidateManifestArtifact = jsonArtifact(
    input.evidence.candidate_manifest,
    "candidate manifest",
  );
  const candidateManifest = candidateManifestArtifact.value;
  const candidateManifestSeal = verifiedBody(candidateManifest, "candidate manifest");
  const candidate = record(candidateManifest.candidate, "candidate manifest.candidate");
  const source = record(candidateManifest.source, "candidate manifest.source");
  const candidateSha = digest(candidate.sha256, "candidate asset SHA");
  const sourceSha = digest(source.sha256, "single-unit source SHA");
  if (candidateManifest.schema_version !== "walmart-listing-main-candidate/v1"
    || candidateManifest.listing_key !== plan.listing.listing_key
    || candidateManifest.sku !== plan.listing.sku
    || candidateManifest.canonical_variant_id !== canonicalVariantId
    || candidateManifest.represented_outer_units !== outerUnits
    || candidate.derivation !== "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE"
    || source.product_truth_file_sha256 !== truthArtifact.sha256
    || source.content_observation_id !== contentObservationId) {
    fail("candidate manifest differs from exact Product Truth/listing/count");
  }
  const sourceBytes = artifactBytes(
    input.evidence.single_unit_source,
    "single-unit source asset",
    20 * 1024 * 1024,
  );
  if (sourceSha !== input.evidence.single_unit_source.sha256
    || Number(source.bytes) !== sourceBytes.length) {
    fail("single-unit source bytes differ from candidate manifest");
  }
  const candidateBytes = artifactBytes(
    input.evidence.candidate_asset,
    "candidate asset",
    5 * 1024 * 1024,
  );
  if (candidateSha !== input.evidence.candidate_asset.sha256
    || Number(candidate.bytes) !== candidateBytes.length) {
    fail("candidate asset bytes differ from candidate manifest");
  }
  let rebuiltCandidate: Buffer;
  try {
    rebuiltCandidate = await composeTiledMainImage(sourceBytes, outerUnits);
  } catch {
    return fail("candidate cannot be rebuilt from the exact single-unit source");
  }
  if (sha256(rebuiltCandidate) !== candidateSha
    || !rebuiltCandidate.equals(candidateBytes)) {
    fail("candidate bytes do not deterministically rebuild from the exact single-unit source");
  }
  let metadata;
  try {
    metadata = await sharp(candidateBytes, {
      failOn: "error",
      limitInputPixels: 100_000_000,
    }).metadata();
  } catch {
    return fail("candidate asset is not a decodable image");
  }
  if (metadata.format !== "png" || !metadata.width || !metadata.height
    || metadata.width !== metadata.height || metadata.width < 1_500
    || metadata.width !== candidate.width || metadata.height !== candidate.height) {
    fail("candidate asset format/dimensions differ from manifest or Walmart policy");
  }

  const observerPlanArtifact = jsonArtifact(
    input.evidence.observer_plan,
    "observer plan",
  );
  const observerPlan = parseObserverPlan(observerPlanArtifact.value);
  const observerAsset = observerPlan.assets[0]!;
  if (observerPlan.listing_key !== plan.listing.listing_key
    || observerPlan.item_id !== plan.listing.item_id
    || observerPlan.intake_index_file_sha256 !== candidateManifestArtifact.sha256
    || observerPlan.intake_index_body_sha256 !== candidateManifestSeal.body_sha256
    || observerAsset.slot !== "main"
    || observerAsset.source_asset_sha256 !== candidateSha) {
    fail("observer plan differs from exact candidate/listing");
  }
  const preprocessed = await preprocessCatalogVisual(candidateBytes, {
    full_max_edge: 1600,
    crop_max_edge: 1800,
    analysis_max_edge: 512,
    max_crop_upscale: 2,
    limit_input_pixels: 40_000_000,
  });
  const full = preprocessed.views.find((view) => view.role === "full");
  if (!full || full.media_type !== "image/jpeg"
    || full.sha256 !== observerAsset.model_asset.sha256
    || full.width !== observerAsset.model_asset.width
    || full.height !== observerAsset.model_asset.height) {
    fail("observer model view does not deterministically rebuild from candidate bytes");
  }

  const observerRequestArtifact = jsonArtifact(
    input.evidence.observer_request,
    "observer request",
  );
  const observerRequest = observerRequestArtifact.value;
  if (observerRequest.prompt !== observerPlan.calls[0]!.prompt
    || !Array.isArray(observerRequest.images)
    || observerRequest.images.length !== 1
    || sha256(Buffer.from(
      text(observerRequest.images[0], "observer request image", 10_000_000),
      "base64",
    ))
      !== full.sha256) {
    fail("observer request pixels/prompt do not rebuild from candidate and plan");
  }
  const observerResponseArtifact = jsonArtifact(
    input.evidence.observer_response,
    "observer response",
  );
  const verifiedWorker = verifyWalmartListingSingleWorkerResponse({
    plan: observerPlan,
    call_index: 0,
    request: observerRequest as unknown as Parameters<
      typeof verifyWalmartListingSingleWorkerResponse
    >[0]["request"],
    http_status: 200,
    response: observerResponseArtifact.value,
  });

  const qualificationArtifact = jsonArtifact(
    input.evidence.qualification,
    "candidate qualification",
  );
  const qualification = qualificationArtifact.value;
  const qualificationSeal = verifiedBody(qualification, "candidate qualification");
  const observation = verifiedWorker.observations[0]!;
  const auditImage: AuditImageInput = {
    slot: "main",
    url: `https://candidate.invalid/${candidateSha}.png`,
    buyer_facing_verified: false,
    surface: "last_applied_artifact",
  };
  const decision = decideBlind({
    case_id: `candidate:${candidateSha}`,
    sku: plan.listing.sku,
    expected: input.expected,
    images: [auditImage],
  }, auditImage, observation, { ocr_texts: [] });
  if (qualification.schema_version !== "walmart-listing-main-candidate-qualification/v1"
    || qualification.status !== "PASS"
    || qualification.listing_key !== plan.listing.listing_key
    || qualification.candidate_sha256 !== candidateSha
    || qualification.candidate_manifest_file_sha256 !== candidateManifestArtifact.sha256
    || qualification.candidate_manifest_body_sha256 !== candidateManifestSeal.body_sha256
    || qualification.observer_plan_body_sha256 !== observerPlan.body_sha256
    || !exactEqual(qualification.observation, observation)
    || !exactEqual(qualification.worker_receipt, verifiedWorker.worker_receipt)
    || !exactEqual(qualification.decision, decision)
    || decision.verdict !== "PASS") {
    fail("candidate qualification does not independently rebuild to PASS");
  }

  const r2Artifact = jsonArtifact(input.evidence.r2_staging, "R2 staging");
  const r2Staging = r2Artifact.value;
  const r2Seal = verifiedBody(r2Staging, "R2 staging");
  const r2 = record(r2Staging.r2, "R2 staging.r2");
  const stagedCandidate = record(r2Staging.candidate, "R2 staging.candidate");
  const publicUrl = queryFreeHttps(r2.public_url, "R2 public_url");
  if (r2Staging.schema_version !== "walmart-listing-main-r2-staging/v1"
    || r2Staging.status !== "R2_VERIFIED_NOT_WALMART_PUBLISHED"
    || r2Staging.listing_key !== plan.listing.listing_key
    || stagedCandidate.sha256 !== candidateSha
    || r2.custody_read_sha256 !== candidateSha
    || r2.public_read_sha256 !== candidateSha) {
    fail("R2 staging does not bind the exact candidate and verified public bytes");
  }
  const targetMain = plan.target.images[0];
  if (!targetMain || targetMain.slot !== "main"
    || targetMain.sha256 !== candidateSha || targetMain.source_url !== publicUrl) {
    fail("repair plan MAIN differs from qualified content-addressed candidate");
  }
  if (!Array.isArray(input.baseline_images) || input.baseline_images.length < 2
    || !exactEqual(input.baseline_images.slice(1), plan.target.images.slice(1))) {
    fail("gallery is not preserved exactly outside the reviewed MAIN diff");
  }

  const receipt = record(verifiedWorker.worker_receipt, "verified worker receipt");
  const receiptBody = record(receipt.body, "verified worker receipt.body");
  const workerContract = record(receiptBody.worker_contract, "verified worker contract");
  const body = {
    schema_version: WALMART_LISTING_REPAIR_REVIEWED_MAIN_CERTIFICATE_SCHEMA,
    created_at: now,
    expires_at: expiresAt,
    plan: {
      plan_id: plan.plan_id,
      body_sha256: plan.body_sha256,
      target_sha256: plan.target.target_sha256,
    },
    listing: {
      channel: plan.listing.channel,
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
    },
    product_truth: {
      artifact_sha256: truthArtifact.sha256,
      expected_sha256: plan.product_truth.expected_sha256,
      canonical_variant_id: canonicalVariantId,
      content_observation_id: contentObservationId,
      outer_units: outerUnits,
    },
    changed_main: {
      source_url: publicUrl,
      asset_sha256: candidateSha,
      byte_size: candidateBytes.length,
      width: metadata.width,
      height: metadata.height,
      content_type: "image/png" as const,
      derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE" as const,
      single_unit_source_artifact_sha256:
        input.evidence.single_unit_source.sha256,
      single_unit_source_sha256: sourceSha,
      candidate_manifest_artifact_sha256: candidateManifestArtifact.sha256,
      candidate_manifest_body_sha256: candidateManifestSeal.body_sha256,
      qualification_artifact_sha256: qualificationArtifact.sha256,
      qualification_body_sha256: qualificationSeal.body_sha256,
      observer_plan_artifact_sha256: observerPlanArtifact.sha256,
      observer_plan_body_sha256: observerPlan.body_sha256,
      observer_request_artifact_sha256: observerRequestArtifact.sha256,
      observer_response_artifact_sha256: observerResponseArtifact.sha256,
      worker_receipt_key_id: text(receipt.key_id, "worker receipt key_id", 512),
      worker_receipt_public_key_spki_sha256: digest(
        receipt.public_key_spki_sha256,
        "worker receipt public key SHA",
      ),
      worker_build: text(
        workerContract.worker_build,
        "worker build",
        80,
      ) as `sha256:${string}`,
      blind_decision_sha256: walmartListingIntegritySha256(decision),
      r2_staging_artifact_sha256: r2Artifact.sha256,
      r2_staging_body_sha256: r2Seal.body_sha256,
    },
    unchanged_gallery: {
      exact_projection_sha256: walmartListingIntegritySha256(
        input.baseline_images.slice(1),
      ),
      slot_count: input.baseline_images.length - 1,
    },
    owner_review: {
      compilation_request_file_sha256: digest(
        input.compilation_request_file_sha256,
        "compilation request file SHA",
      ),
      compilation_request_body_sha256: digest(
        input.compilation_request_body_sha256,
        "compilation request body SHA",
      ),
      exact_confirmation_sha256: walmartListingIntegritySha256(
        text(input.owner_confirmation, "owner confirmation", 20_000),
      ),
    },
    policy: {
      changed_fields_exactly_description_bullets_main: true as const,
      exact_product_truth_verified: true as const,
      deterministic_candidate_bytes_verified: true as const,
      signed_blind_worker_receipt_verified: true as const,
      blind_visual_decision_passed: true as const,
      content_addressed_public_bytes_verified: true as const,
      gallery_preserved_exactly: true as const,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY" as const,
      owner_permit_must_bind_certificate_sha256: true as const,
    },
  };
  const bodySha = walmartListingIntegritySha256(body);
  return {
    ...body,
    certificate_id: `walmart-reviewed-main-${bodySha.slice(0, 24)}`,
    body_sha256: bodySha,
  };
}

export function verifyWalmartListingRepairReviewedMainCertificateBytes(input: {
  certificate_bytes: Uint8Array;
  plan: SealedWalmartListingRepairPlan;
  at: Date | string;
}): SealedWalmartListingRepairReviewedMainCertificate {
  if (!(input.certificate_bytes instanceof Uint8Array)
    || input.certificate_bytes.byteLength < 1
    || input.certificate_bytes.byteLength > 16 * 1024 * 1024) {
    fail("certificate bytes are missing or exceed the cap");
  }
  const decoded = new TextDecoder("utf8", { fatal: true }).decode(input.certificate_bytes);
  let raw: JsonRecord;
  try {
    raw = record(JSON.parse(decoded), "certificate");
  } catch {
    return fail("certificate bytes must be UTF-8 JSON");
  }
  if (decoded !== canonicalWalmartListingSurgicalJson(raw)
    || raw.schema_version !== WALMART_LISTING_REPAIR_REVIEWED_MAIN_CERTIFICATE_SCHEMA) {
    fail("certificate bytes/schema are not exact canonical reviewed-MAIN evidence");
  }
  exactKeys(raw, [
    "body_sha256",
    "certificate_id",
    "changed_main",
    "created_at",
    "expires_at",
    "listing",
    "owner_review",
    "plan",
    "policy",
    "product_truth",
    "schema_version",
    "unchanged_gallery",
  ], "certificate");
  const claimed = digest(raw.body_sha256, "certificate body_sha256");
  const body = { ...raw };
  delete body.certificate_id;
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed
    || raw.certificate_id !== `walmart-reviewed-main-${claimed.slice(0, 24)}`) {
    fail("certificate seal/id mismatch");
  }
  const at = input.at instanceof Date ? input.at.toISOString() : instant(input.at, "verification at");
  const createdAt = instant(raw.created_at, "certificate created_at");
  const expiresAt = instant(raw.expires_at, "certificate expires_at");
  if (Date.parse(at) < Date.parse(createdAt) || Date.parse(at) >= Date.parse(expiresAt)) {
    fail("certificate is not fresh");
  }
  const plan = record(raw.plan, "certificate.plan");
  const listing = record(raw.listing, "certificate.listing");
  const productTruth = record(raw.product_truth, "certificate.product_truth");
  const changedMain = record(raw.changed_main, "certificate.changed_main");
  const unchangedGallery = record(raw.unchanged_gallery, "certificate.unchanged_gallery");
  const ownerReview = record(raw.owner_review, "certificate.owner_review");
  const policy = record(raw.policy, "certificate.policy");
  exactKeys(plan, ["body_sha256", "plan_id", "target_sha256"], "certificate.plan");
  exactKeys(listing, [
    "channel",
    "item_id",
    "listing_key",
    "sku",
    "store_index",
  ], "certificate.listing");
  exactKeys(productTruth, [
    "artifact_sha256",
    "canonical_variant_id",
    "content_observation_id",
    "expected_sha256",
    "outer_units",
  ], "certificate.product_truth");
  exactKeys(changedMain, [
    "asset_sha256",
    "blind_decision_sha256",
    "byte_size",
    "candidate_manifest_artifact_sha256",
    "candidate_manifest_body_sha256",
    "content_type",
    "derivation",
    "height",
    "observer_plan_artifact_sha256",
    "observer_plan_body_sha256",
    "observer_request_artifact_sha256",
    "observer_response_artifact_sha256",
    "qualification_artifact_sha256",
    "qualification_body_sha256",
    "r2_staging_artifact_sha256",
    "r2_staging_body_sha256",
    "single_unit_source_artifact_sha256",
    "single_unit_source_sha256",
    "source_url",
    "width",
    "worker_build",
    "worker_receipt_key_id",
    "worker_receipt_public_key_spki_sha256",
  ], "certificate.changed_main");
  exactKeys(unchangedGallery, [
    "exact_projection_sha256",
    "slot_count",
  ], "certificate.unchanged_gallery");
  exactKeys(ownerReview, [
    "compilation_request_body_sha256",
    "compilation_request_file_sha256",
    "exact_confirmation_sha256",
  ], "certificate.owner_review");
  exactKeys(policy, [
    "authority",
    "blind_visual_decision_passed",
    "changed_fields_exactly_description_bullets_main",
    "content_addressed_public_bytes_verified",
    "deterministic_candidate_bytes_verified",
    "exact_product_truth_verified",
    "gallery_preserved_exactly",
    "owner_permit_must_bind_certificate_sha256",
    "signed_blind_worker_receipt_verified",
  ], "certificate.policy");
  for (const [label, value] of [
    ["certificate.plan.body_sha256", plan.body_sha256],
    ["certificate.plan.target_sha256", plan.target_sha256],
    ["certificate.product_truth.artifact_sha256", productTruth.artifact_sha256],
    ["certificate.product_truth.expected_sha256", productTruth.expected_sha256],
    ["certificate.changed_main.asset_sha256", changedMain.asset_sha256],
    [
      "certificate.changed_main.single_unit_source_artifact_sha256",
      changedMain.single_unit_source_artifact_sha256,
    ],
    [
      "certificate.changed_main.single_unit_source_sha256",
      changedMain.single_unit_source_sha256,
    ],
    [
      "certificate.changed_main.candidate_manifest_artifact_sha256",
      changedMain.candidate_manifest_artifact_sha256,
    ],
    [
      "certificate.changed_main.candidate_manifest_body_sha256",
      changedMain.candidate_manifest_body_sha256,
    ],
    [
      "certificate.changed_main.qualification_artifact_sha256",
      changedMain.qualification_artifact_sha256,
    ],
    [
      "certificate.changed_main.qualification_body_sha256",
      changedMain.qualification_body_sha256,
    ],
    [
      "certificate.changed_main.observer_plan_artifact_sha256",
      changedMain.observer_plan_artifact_sha256,
    ],
    [
      "certificate.changed_main.observer_plan_body_sha256",
      changedMain.observer_plan_body_sha256,
    ],
    [
      "certificate.changed_main.observer_request_artifact_sha256",
      changedMain.observer_request_artifact_sha256,
    ],
    [
      "certificate.changed_main.observer_response_artifact_sha256",
      changedMain.observer_response_artifact_sha256,
    ],
    [
      "certificate.changed_main.worker_receipt_public_key_spki_sha256",
      changedMain.worker_receipt_public_key_spki_sha256,
    ],
    [
      "certificate.changed_main.blind_decision_sha256",
      changedMain.blind_decision_sha256,
    ],
    [
      "certificate.changed_main.r2_staging_artifact_sha256",
      changedMain.r2_staging_artifact_sha256,
    ],
    [
      "certificate.changed_main.r2_staging_body_sha256",
      changedMain.r2_staging_body_sha256,
    ],
    [
      "certificate.unchanged_gallery.exact_projection_sha256",
      unchangedGallery.exact_projection_sha256,
    ],
    [
      "certificate.owner_review.compilation_request_file_sha256",
      ownerReview.compilation_request_file_sha256,
    ],
    [
      "certificate.owner_review.compilation_request_body_sha256",
      ownerReview.compilation_request_body_sha256,
    ],
    [
      "certificate.owner_review.exact_confirmation_sha256",
      ownerReview.exact_confirmation_sha256,
    ],
  ] as const) {
    digest(value, label);
  }
  text(plan.plan_id, "certificate.plan.plan_id", 512);
  text(productTruth.canonical_variant_id, "certificate canonical variant", 512);
  text(productTruth.content_observation_id, "certificate content observation", 512);
  positiveInteger(productTruth.outer_units, "certificate product truth outer units");
  queryFreeHttps(changedMain.source_url, "certificate changed MAIN source URL");
  positiveInteger(changedMain.byte_size, "certificate changed MAIN byte size");
  positiveInteger(changedMain.width, "certificate changed MAIN width");
  positiveInteger(changedMain.height, "certificate changed MAIN height");
  text(changedMain.worker_receipt_key_id, "certificate worker receipt key", 512);
  const workerBuild = text(changedMain.worker_build, "certificate worker build", 80);
  if (!/^sha256:[a-f0-9]{64}$/u.test(workerBuild)
    || changedMain.content_type !== "image/png"
    || changedMain.derivation !== "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE"
    || !Number.isSafeInteger(unchangedGallery.slot_count)
    || Number(unchangedGallery.slot_count) < 1) {
    fail("certificate changed MAIN technical contract is invalid");
  }
  if (plan.plan_id !== input.plan.plan_id
    || plan.body_sha256 !== input.plan.body_sha256
    || plan.target_sha256 !== input.plan.target.target_sha256
    || productTruth.expected_sha256 !== input.plan.product_truth.expected_sha256
    || !exactEqual(listing, {
      channel: input.plan.listing.channel,
      store_index: input.plan.listing.store_index,
      sku: input.plan.listing.sku,
      listing_key: input.plan.listing.listing_key,
      item_id: input.plan.listing.item_id,
    })
    || changedMain.source_url !== input.plan.target.images[0]?.source_url
    || changedMain.asset_sha256 !== input.plan.target.images[0]?.sha256
    || unchangedGallery.exact_projection_sha256
      !== walmartListingIntegritySha256(input.plan.target.images.slice(1))
    || unchangedGallery.slot_count !== input.plan.target.images.length - 1
    || !exactEqual(input.plan.changed_fields, ["description", "bullets", "main"])
    || policy.changed_fields_exactly_description_bullets_main !== true
    || policy.exact_product_truth_verified !== true
    || policy.deterministic_candidate_bytes_verified !== true
    || policy.signed_blind_worker_receipt_verified !== true
    || policy.blind_visual_decision_passed !== true
    || policy.content_addressed_public_bytes_verified !== true
    || policy.gallery_preserved_exactly !== true
    || policy.authority !== "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY"
    || policy.owner_permit_must_bind_certificate_sha256 !== true) {
    fail("certificate does not bind the exact reviewed plan/listing/MAIN/gallery policy");
  }
  return raw as unknown as SealedWalmartListingRepairReviewedMainCertificate;
}
