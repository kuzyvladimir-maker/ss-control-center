/**
 * Owner-compiler certificate for one reviewed MAIN + gallery replacement.
 *
 * The compiler rebuilds the Product Truth, deterministic multipack MAIN,
 * signed blind observation population, deterministic curation, and public
 * content-addressed MAIN chain. The certificate is evidence only; the separate
 * Ed25519 one-SKU permit remains the sole marketplace write authority.
 */

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  decideBlind,
  type AuditExpectedTruth,
  type AuditImageInput,
  type BlindObservation,
} from "./catalog-visual-audit.ts";
import { auditGallerySlot } from "./catalog-gallery-audit.ts";
import { preprocessCatalogVisual } from "./catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  verifyWalmartListingSingleWorkerResponse,
  type WalmartListingSingleObserverPlan,
} from "./listing-integrity-single-observer.ts";
import { walmartListingIntegritySha256 } from "./listing-integrity-audit.ts";
import { canonicalWalmartListingSurgicalJson } from "./listing-integrity-remediation-payload.ts";
import {
  WALMART_LISTING_REPAIR_PLAN_SCHEMA,
  type SealedWalmartListingRepairPlan,
  type WalmartListingRepairTargetImage,
} from "./listing-integrity-remediation-qualification.ts";
import { composeTiledMainImage } from "./multipack/composite.ts";

export const WALMART_LISTING_REPAIR_REVIEWED_IMAGE_SET_CERTIFICATE_SCHEMA =
  "walmart-listing-repair-reviewed-image-set-certificate/v1" as const;

type JsonRecord = Record<string, unknown>;

export interface ExactReviewedImageSetArtifact {
  bytes: Uint8Array;
  sha256: string;
}

export interface WalmartListingRepairReviewedImageSetEvidence {
  product_truth: ExactReviewedImageSetArtifact;
  main_candidate_manifest: ExactReviewedImageSetArtifact;
  single_unit_source: ExactReviewedImageSetArtifact;
  source_candidate_manifest: ExactReviewedImageSetArtifact;
  source_candidate_assets: ExactReviewedImageSetArtifact[];
  source_qualification: ExactReviewedImageSetArtifact;
  observer_plan: ExactReviewedImageSetArtifact;
  observer_requests: ExactReviewedImageSetArtifact[];
  observer_responses: ExactReviewedImageSetArtifact[];
  curated_manifest: ExactReviewedImageSetArtifact;
  curated_target_assets: ExactReviewedImageSetArtifact[];
  r2_staging: ExactReviewedImageSetArtifact;
}

export interface SealedWalmartListingRepairReviewedImageSetCertificate
  extends JsonRecord {
  schema_version:
    typeof WALMART_LISTING_REPAIR_REVIEWED_IMAGE_SET_CERTIFICATE_SCHEMA;
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
  target_image_set: {
    exact_projection_sha256: string;
    slot_count: number;
    main_source_url: string;
    main_asset_sha256: string;
    main_derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE";
    source_candidate_manifest_artifact_sha256: string;
    source_candidate_manifest_body_sha256: string;
    source_qualification_artifact_sha256: string;
    source_qualification_body_sha256: string;
    observer_plan_artifact_sha256: string;
    observer_plan_body_sha256: string;
    observer_request_artifact_sha256: string[];
    observer_response_artifact_sha256: string[];
    worker_receipt_sha256: string[];
    curated_manifest_artifact_sha256: string;
    curated_manifest_body_sha256: string;
    r2_staging_artifact_sha256: string;
    r2_staging_body_sha256: string;
  };
  owner_review: {
    compilation_request_file_sha256: string;
    compilation_request_body_sha256: string;
    exact_confirmation_sha256: string;
  };
  policy: {
    changed_fields_exactly_description_bullets_main_gallery: true;
    exact_product_truth_verified: true;
    deterministic_main_bytes_verified: true;
    signed_blind_worker_receipts_verified: true;
    every_published_target_passed: true;
    content_addressed_public_main_verified: true;
    authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY";
    owner_permit_must_bind_certificate_sha256: true;
  };
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart reviewed-image-set certificate rejected: ${message}`);
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
  artifact: ExactReviewedImageSetArtifact,
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
  artifact: ExactReviewedImageSetArtifact,
  label: string,
): { bytes: Buffer; value: JsonRecord; sha256: string } {
  const bytes = artifactBytes(artifact, label);
  try {
    return {
      bytes,
      value: record(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
        label,
      ),
      sha256: artifact.sha256,
    };
  } catch {
    return fail(`${label} must be UTF-8 JSON`);
  }
}

function verifiedBody(value: JsonRecord, label: string): string {
  const claimed = digest(value.body_sha256, `${label}.body_sha256`);
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) {
    fail(`${label} body SHA mismatch`);
  }
  return claimed;
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
  if (!exactEqual(
    raw.changed_fields,
    ["description", "bullets", "main", "gallery"],
  )) {
    fail("repair plan must change exactly description, bullets, MAIN, and gallery");
  }
  const created = Date.parse(instant(raw.created_at, "repair plan created_at"));
  const expires = Date.parse(instant(raw.expires_at, "repair plan expires_at"));
  if (nowMs < created || nowMs >= expires) fail("repair plan is not currently valid");
  return value;
}

function targetRecord(value: unknown, index: number, label: string): JsonRecord {
  const target = record(value, `${label}[${index}]`);
  const slot = index === 0 ? "main" : `gallery-${index}`;
  if (target.slot !== slot || typeof target.file !== "string"
    || digest(target.sha256, `${label}[${index}].sha256`) !== target.sha256) {
    fail(`${label}[${index}] is not the exact contiguous target`);
  }
  return target;
}

export async function certifyWalmartListingRepairReviewedImageSet(input: {
  now: Date | string;
  expires_at: string;
  plan: SealedWalmartListingRepairPlan;
  expected: AuditExpectedTruth;
  compilation_request_file_sha256: string;
  compilation_request_body_sha256: string;
  owner_confirmation: string;
  evidence: WalmartListingRepairReviewedImageSetEvidence;
}): Promise<SealedWalmartListingRepairReviewedImageSetCertificate> {
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
  const improvement = record(views.listingImprovement, "Product Truth Listing Improvement");
  if (truth.contractVersion !== "product-truth-read-contract/3.2.0"
    || snapshot.channel !== "walmart"
    || snapshot.storeIndex !== plan.listing.store_index
    || snapshot.sku !== plan.listing.sku
    || snapshot.listingKey !== plan.listing.listing_key
    || improvement.ready !== true
    || !Array.isArray(improvement.components)
    || improvement.components.length !== 1) {
    fail("Product Truth is not one exact ready component for this listing");
  }
  const component = record(improvement.components[0], "Product Truth component");
  const content = record(component.content, "Product Truth content");
  const provenance = record(content.provenance, "Product Truth provenance");
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
    || component.contentBlockers.length !== 0) {
    fail("Product Truth component/count/content is incomplete or contradictory");
  }

  const mainManifestArtifact = jsonArtifact(
    input.evidence.main_candidate_manifest,
    "MAIN candidate manifest",
  );
  const mainManifest = mainManifestArtifact.value;
  verifiedBody(mainManifest, "MAIN candidate manifest");
  const mainCandidate = record(mainManifest.candidate, "MAIN candidate");
  const mainSource = record(mainManifest.source, "MAIN source");
  const mainSha = digest(mainCandidate.sha256, "MAIN candidate SHA");
  const sourceSha = digest(mainSource.sha256, "single-unit source SHA");
  if (mainManifest.schema_version !== "walmart-listing-main-candidate/v1"
    || mainManifest.listing_key !== plan.listing.listing_key
    || mainManifest.canonical_variant_id !== canonicalVariantId
    || mainManifest.represented_outer_units !== outerUnits
    || mainCandidate.derivation !== "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE"
    || mainSource.product_truth_file_sha256 !== truthArtifact.sha256
    || mainSource.content_observation_id !== contentObservationId) {
    fail("MAIN candidate manifest differs from exact Product Truth/listing/count");
  }
  const singleUnitBytes = artifactBytes(
    input.evidence.single_unit_source,
    "single-unit source",
    20 * 1024 * 1024,
  );
  if (sourceSha !== input.evidence.single_unit_source.sha256
    || mainSource.bytes !== singleUnitBytes.length) {
    fail("single-unit source bytes differ from MAIN manifest");
  }
  let rebuiltMain: Buffer;
  try {
    rebuiltMain = await composeTiledMainImage(singleUnitBytes, outerUnits);
  } catch {
    return fail("MAIN cannot be rebuilt from exact single-unit source");
  }
  if (sha256(rebuiltMain) !== mainSha) {
    fail("MAIN bytes do not deterministically rebuild");
  }

  const sourceManifestArtifact = jsonArtifact(
    input.evidence.source_candidate_manifest,
    "source candidate manifest",
  );
  const sourceManifest = sourceManifestArtifact.value;
  const sourceManifestBodySha = verifiedBody(
    sourceManifest,
    "source candidate manifest",
  );
  const sourceTargetsRaw = sourceManifest.targets;
  if (sourceManifest.schema_version !== "walmart-listing-image-set-candidate/v1"
    || sourceManifest.listing_key !== plan.listing.listing_key
    || sourceManifest.canonical_variant_id !== canonicalVariantId
    || sourceManifest.content_observation_id !== contentObservationId
    || sourceManifest.represented_outer_units !== outerUnits
    || sourceManifest.product_truth_file_sha256 !== truthArtifact.sha256
    || !Array.isArray(sourceTargetsRaw)
    || sourceTargetsRaw.length !== input.evidence.source_candidate_assets.length
    || sourceTargetsRaw.length < 2) {
    fail("source image-set manifest population/binding is invalid");
  }
  const sourceTargets = sourceTargetsRaw.map((entry, index) =>
    targetRecord(entry, index, "source targets"));
  const sourceBytes = input.evidence.source_candidate_assets.map((artifact, index) => {
    const bytes = artifactBytes(artifact, `source target asset ${index}`, 10 * 1024 * 1024);
    const target = sourceTargets[index]!;
    if (artifact.sha256 !== target.sha256 || bytes.length !== target.bytes) {
      fail(`source target asset ${index} differs from manifest`);
    }
    return bytes;
  });
  if (sourceBytes[0]!.length !== rebuiltMain.length
    || !sourceBytes[0]!.equals(rebuiltMain)) {
    fail("source image-set MAIN differs from deterministic MAIN");
  }

  const observerPlanArtifact = jsonArtifact(
    input.evidence.observer_plan,
    "observer plan",
  );
  const observerPlanRaw = observerPlanArtifact.value;
  const observerPlanBodySha = verifiedBody(observerPlanRaw, "observer plan");
  if (observerPlanRaw.schema_version !== "walmart-listing-single-observer-plan/v1"
    || !exactEqual(
      observerPlanRaw.worker_contract,
      WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
    )
    || observerPlanRaw.listing_key !== plan.listing.listing_key
    || observerPlanRaw.item_id !== plan.listing.item_id
    || observerPlanRaw.intake_index_file_sha256 !== sourceManifestArtifact.sha256
    || observerPlanRaw.intake_index_body_sha256 !== sourceManifestBodySha
    || !Array.isArray(observerPlanRaw.assets)
    || observerPlanRaw.assets.length !== sourceTargets.length
    || !Array.isArray(observerPlanRaw.calls)
    || observerPlanRaw.calls.length !== input.evidence.observer_requests.length
    || observerPlanRaw.calls.length !== input.evidence.observer_responses.length) {
    fail("observer plan differs from exact source image set");
  }
  const observerPlan =
    observerPlanRaw as unknown as WalmartListingSingleObserverPlan;
  for (const [index, asset] of observerPlan.assets.entries()) {
    const target = sourceTargets[index]!;
    const preprocessed = await preprocessCatalogVisual(sourceBytes[index]!, {
      full_max_edge: 1600,
      crop_max_edge: 1800,
      analysis_max_edge: 512,
      max_crop_upscale: 2,
      limit_input_pixels: 40_000_000,
    });
    const full = preprocessed.views.find((view) => view.role === "full");
    if (!full || full.media_type !== "image/jpeg"
      || asset.slot !== target.slot
      || asset.source_asset_sha256 !== target.sha256
      || asset.model_asset.sha256 !== full.sha256
      || asset.model_asset.bytes !== full.bytes.length
      || asset.model_asset.width !== full.width
      || asset.model_asset.height !== full.height) {
      fail(`observer model view ${index} does not rebuild from source bytes`);
    }
  }

  const observations: BlindObservation[] = [];
  const workerReceipts: unknown[] = [];
  const requestArtifactShas: string[] = [];
  const responseArtifactShas: string[] = [];
  for (const call of observerPlan.calls) {
    const requestArtifact = jsonArtifact(
      input.evidence.observer_requests[call.call_index]!,
      `observer request ${call.call_index}`,
    );
    const responseArtifact = jsonArtifact(
      input.evidence.observer_responses[call.call_index]!,
      `observer response ${call.call_index}`,
    );
    const verified = verifyWalmartListingSingleWorkerResponse({
      plan: observerPlan,
      call_index: call.call_index,
      request: requestArtifact.value as unknown as Parameters<
        typeof verifyWalmartListingSingleWorkerResponse
      >[0]["request"],
      http_status: 200,
      response: responseArtifact.value,
    });
    observations.push(...verified.observations);
    workerReceipts.push(verified.worker_receipt);
    requestArtifactShas.push(requestArtifact.sha256);
    responseArtifactShas.push(responseArtifact.sha256);
  }
  if (observations.length !== sourceTargets.length) {
    fail("verified observation population differs from source image population");
  }

  const qualificationArtifact = jsonArtifact(
    input.evidence.source_qualification,
    "source qualification",
  );
  const qualification = qualificationArtifact.value;
  const qualificationBodySha = verifiedBody(
    qualification,
    "source qualification",
  );
  if (qualification.schema_version
      !== "walmart-listing-image-set-candidate-qualification/v1"
    || qualification.listing_key !== plan.listing.listing_key
    || qualification.candidate_manifest_file_sha256 !== sourceManifestArtifact.sha256
    || qualification.candidate_manifest_body_sha256 !== sourceManifestBodySha
    || qualification.observer_plan_file_sha256 !== observerPlanArtifact.sha256
    || qualification.observer_plan_body_sha256 !== observerPlanBodySha
    || !Array.isArray(qualification.calls)
    || qualification.calls.length !== observerPlan.calls.length
    || !Array.isArray(qualification.targets)
    || qualification.targets.length !== observations.length
    || !exactEqual(qualification.worker_receipts, workerReceipts)) {
    fail("source qualification does not bind the verified signed observations");
  }
  for (const [index, callValue] of qualification.calls.entries()) {
    const call = record(callValue, `qualification call ${index}`);
    if (call.call_index !== index
      || call.request_sha256 !== requestArtifactShas[index]
      || call.response_sha256 !== responseArtifactShas[index]) {
      fail(`qualification call ${index} artifact hashes differ`);
    }
  }
  for (const [index, targetValue] of qualification.targets.entries()) {
    const target = record(targetValue, `qualified target ${index}`);
    if (target.slot !== sourceTargets[index]!.slot
      || target.asset_sha256 !== sourceTargets[index]!.sha256
      || target.source_bytes_sha256 !== sourceTargets[index]!.sha256
      || !exactEqual(target.observation, observations[index])) {
      fail(`qualified target ${index} differs from verified observation/source`);
    }
  }

  const mainImage: AuditImageInput = {
    slot: "main",
    url: `https://candidate.invalid/${mainSha}.png`,
    buyer_facing_verified: false,
    surface: "last_applied_artifact",
  };
  const mainDecision = decideBlind({
    case_id: `certified-image-set:${qualificationBodySha}`,
    sku: plan.listing.sku,
    expected: input.expected,
    images: [mainImage],
  }, mainImage, observations[0]!, { ocr_texts: [] });
  if (mainDecision.verdict !== "PASS") {
    fail(`MAIN does not recompute to PASS: ${mainDecision.hard_failures.join("; ")}`);
  }
  const galleryDecisions = observations.slice(1).map((observation, index) =>
    auditGallerySlot({
      slot: `gallery-${index + 1}`,
      expected: input.expected,
      source: {
        state: "observed",
        observation,
        auxiliary_ocr: { ocr_texts: [] },
      },
    }));
  const passSourceIndexes = galleryDecisions.flatMap((decision, index) =>
    decision.verdict === "PASS" ? [index + 1] : []);
  if (passSourceIndexes.length < 1) fail("no gallery target recomputes to PASS");

  const curatedArtifact = jsonArtifact(
    input.evidence.curated_manifest,
    "curated manifest",
  );
  const curated = curatedArtifact.value;
  const curatedBodySha = verifiedBody(curated, "curated manifest");
  const curatedTargetsRaw = curated.targets;
  const curatedSelectionsRaw = curated.selections;
  if (curated.schema_version !== "walmart-listing-image-set-curated/v1"
    || curated.status !== "PASS"
    || curated.listing_key !== plan.listing.listing_key
    || curated.canonical_variant_id !== canonicalVariantId
    || curated.content_observation_id !== contentObservationId
    || curated.represented_outer_units !== outerUnits
    || curated.product_truth_file_sha256 !== truthArtifact.sha256
    || curated.source_candidate_manifest_file_sha256 !== sourceManifestArtifact.sha256
    || curated.source_candidate_manifest_body_sha256 !== sourceManifestBodySha
    || curated.source_qualification_file_sha256 !== qualificationArtifact.sha256
    || curated.source_qualification_body_sha256 !== qualificationBodySha
    || !Array.isArray(curatedTargetsRaw)
    || !Array.isArray(curatedSelectionsRaw)
    || curatedTargetsRaw.length !== passSourceIndexes.length + 1
    || curatedSelectionsRaw.length !== curatedTargetsRaw.length
    || curatedTargetsRaw.length !== input.evidence.curated_target_assets.length) {
    fail("curated manifest does not bind the exact deterministic PASS population");
  }
  const curatedTargets = curatedTargetsRaw.map((entry, index) =>
    targetRecord(entry, index, "curated targets"));
  const selectedSourceIndexes = [0, ...passSourceIndexes];
  for (const [index, sourceIndex] of selectedSourceIndexes.entries()) {
    const sourceTarget = sourceTargets[sourceIndex]!;
    const target = curatedTargets[index]!;
    const selection = record(curatedSelectionsRaw[index], `curated selection ${index}`);
    const bytes = artifactBytes(
      input.evidence.curated_target_assets[index]!,
      `curated target asset ${index}`,
      10 * 1024 * 1024,
    );
    if (target.source_slot !== sourceTarget.slot
      || target.sha256 !== sourceTarget.sha256
      || input.evidence.curated_target_assets[index]!.sha256 !== target.sha256
      || !bytes.equals(sourceBytes[sourceIndex]!)
      || selection.target_slot !== target.slot
      || selection.source_slot !== sourceTarget.slot
      || selection.asset_sha256 !== sourceTarget.sha256
      || !exactEqual(selection.observation, observations[sourceIndex])
      || !exactEqual(
        selection.decision,
        sourceIndex === 0 ? mainDecision : galleryDecisions[sourceIndex - 1],
      )) {
      fail(`curated target ${index} is not the exact recomputed PASS selection`);
    }
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: 100_000_000,
    }).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 1_500
      || metadata.height < 1_500) {
      fail(`curated target ${index} violates the minimum image dimensions`);
    }
  }

  const r2Artifact = jsonArtifact(input.evidence.r2_staging, "R2 staging");
  const r2 = r2Artifact.value;
  const r2BodySha = verifiedBody(r2, "R2 staging");
  const r2Candidate = record(r2.candidate, "R2 candidate");
  const r2Route = record(r2.r2, "R2 route");
  const publicMain = queryFreeHttps(r2Route.public_url, "R2 public URL");
  if (r2.schema_version !== "walmart-listing-main-r2-staging/v2"
    || r2.status !== "R2_VERIFIED_NOT_WALMART_PUBLISHED"
    || r2.listing_key !== plan.listing.listing_key
    || r2Candidate.sha256 !== mainSha
    || r2Candidate.candidate_manifest_file_sha256 !== curatedArtifact.sha256
    || r2Candidate.candidate_manifest_body_sha256 !== curatedBodySha
    || r2Candidate.qualification_file_sha256 !== qualificationArtifact.sha256
    || r2Candidate.qualification_body_sha256 !== qualificationBodySha
    || r2Route.custody_read_sha256 !== mainSha
    || r2Route.public_read_sha256 !== mainSha) {
    fail("R2 staging does not bind the curated MAIN and exact public bytes");
  }
  const expectedTargetImages: WalmartListingRepairTargetImage[] =
    curatedTargets.map((target, index) => ({
      slot: index === 0 ? "main" : `gallery-${index}`,
      source_url: index === 0
        ? publicMain
        : queryFreeHttps(target.source_url, `curated gallery ${index} URL`),
      sha256: digest(target.sha256, `curated target ${index} SHA`),
    }));
  if (!exactEqual(plan.target.images, expectedTargetImages)) {
    fail("repair plan target image set differs from exact curated PASS set");
  }

  const receiptShas = workerReceipts.map((receipt) =>
    walmartListingIntegritySha256(receipt));
  const body = {
    schema_version: WALMART_LISTING_REPAIR_REVIEWED_IMAGE_SET_CERTIFICATE_SCHEMA,
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
    target_image_set: {
      exact_projection_sha256: walmartListingIntegritySha256(plan.target.images),
      slot_count: plan.target.images.length,
      main_source_url: publicMain,
      main_asset_sha256: mainSha,
      main_derivation: "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE" as const,
      source_candidate_manifest_artifact_sha256: sourceManifestArtifact.sha256,
      source_candidate_manifest_body_sha256: sourceManifestBodySha,
      source_qualification_artifact_sha256: qualificationArtifact.sha256,
      source_qualification_body_sha256: qualificationBodySha,
      observer_plan_artifact_sha256: observerPlanArtifact.sha256,
      observer_plan_body_sha256: observerPlanBodySha,
      observer_request_artifact_sha256: requestArtifactShas,
      observer_response_artifact_sha256: responseArtifactShas,
      worker_receipt_sha256: receiptShas,
      curated_manifest_artifact_sha256: curatedArtifact.sha256,
      curated_manifest_body_sha256: curatedBodySha,
      r2_staging_artifact_sha256: r2Artifact.sha256,
      r2_staging_body_sha256: r2BodySha,
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
      changed_fields_exactly_description_bullets_main_gallery: true as const,
      exact_product_truth_verified: true as const,
      deterministic_main_bytes_verified: true as const,
      signed_blind_worker_receipts_verified: true as const,
      every_published_target_passed: true as const,
      content_addressed_public_main_verified: true as const,
      authority: "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY" as const,
      owner_permit_must_bind_certificate_sha256: true as const,
    },
  };
  const bodySha = walmartListingIntegritySha256(body);
  return {
    ...body,
    certificate_id: `walmart-reviewed-image-set-${bodySha.slice(0, 24)}`,
    body_sha256: bodySha,
  };
}

export function verifyWalmartListingRepairReviewedImageSetCertificateBytes(input: {
  certificate_bytes: Uint8Array;
  plan: SealedWalmartListingRepairPlan;
  at: Date | string;
}): SealedWalmartListingRepairReviewedImageSetCertificate {
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
    || raw.schema_version
      !== WALMART_LISTING_REPAIR_REVIEWED_IMAGE_SET_CERTIFICATE_SCHEMA) {
    fail("certificate bytes/schema are not exact canonical reviewed image-set evidence");
  }
  exactKeys(raw, [
    "body_sha256",
    "certificate_id",
    "created_at",
    "expires_at",
    "listing",
    "owner_review",
    "plan",
    "policy",
    "product_truth",
    "schema_version",
    "target_image_set",
  ], "certificate");
  const claimed = digest(raw.body_sha256, "certificate body_sha256");
  const body = { ...raw };
  delete body.certificate_id;
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed
    || raw.certificate_id
      !== `walmart-reviewed-image-set-${claimed.slice(0, 24)}`) {
    fail("certificate seal/id mismatch");
  }
  const at = input.at instanceof Date
    ? input.at.toISOString()
    : instant(input.at, "verification at");
  const createdAt = instant(raw.created_at, "certificate created_at");
  const expiresAt = instant(raw.expires_at, "certificate expires_at");
  if (Date.parse(at) < Date.parse(createdAt) || Date.parse(at) >= Date.parse(expiresAt)) {
    fail("certificate is not fresh");
  }
  const plan = record(raw.plan, "certificate.plan");
  const listing = record(raw.listing, "certificate.listing");
  const truth = record(raw.product_truth, "certificate.product_truth");
  const imageSet = record(raw.target_image_set, "certificate.target_image_set");
  const ownerReview = record(raw.owner_review, "certificate.owner_review");
  const policy = record(raw.policy, "certificate.policy");
  exactKeys(plan, ["body_sha256", "plan_id", "target_sha256"], "certificate.plan");
  exactKeys(listing, [
    "channel", "item_id", "listing_key", "sku", "store_index",
  ], "certificate.listing");
  exactKeys(truth, [
    "artifact_sha256", "canonical_variant_id", "content_observation_id",
    "expected_sha256", "outer_units",
  ], "certificate.product_truth");
  exactKeys(imageSet, [
    "curated_manifest_artifact_sha256",
    "curated_manifest_body_sha256",
    "exact_projection_sha256",
    "main_asset_sha256",
    "main_derivation",
    "main_source_url",
    "observer_plan_artifact_sha256",
    "observer_plan_body_sha256",
    "observer_request_artifact_sha256",
    "observer_response_artifact_sha256",
    "r2_staging_artifact_sha256",
    "r2_staging_body_sha256",
    "slot_count",
    "source_candidate_manifest_artifact_sha256",
    "source_candidate_manifest_body_sha256",
    "source_qualification_artifact_sha256",
    "source_qualification_body_sha256",
    "worker_receipt_sha256",
  ], "certificate.target_image_set");
  exactKeys(ownerReview, [
    "compilation_request_body_sha256",
    "compilation_request_file_sha256",
    "exact_confirmation_sha256",
  ], "certificate.owner_review");
  exactKeys(policy, [
    "authority",
    "changed_fields_exactly_description_bullets_main_gallery",
    "content_addressed_public_main_verified",
    "deterministic_main_bytes_verified",
    "every_published_target_passed",
    "exact_product_truth_verified",
    "owner_permit_must_bind_certificate_sha256",
    "signed_blind_worker_receipts_verified",
  ], "certificate.policy");
  for (const [label, value] of [
    ["certificate.plan.body_sha256", plan.body_sha256],
    ["certificate.plan.target_sha256", plan.target_sha256],
    ["certificate.product_truth.artifact_sha256", truth.artifact_sha256],
    ["certificate.product_truth.expected_sha256", truth.expected_sha256],
    ["certificate.target_image_set.exact_projection_sha256", imageSet.exact_projection_sha256],
    ["certificate.target_image_set.main_asset_sha256", imageSet.main_asset_sha256],
    ["certificate.owner_review.compilation_request_file_sha256",
      ownerReview.compilation_request_file_sha256],
    ["certificate.owner_review.compilation_request_body_sha256",
      ownerReview.compilation_request_body_sha256],
    ["certificate.owner_review.exact_confirmation_sha256",
      ownerReview.exact_confirmation_sha256],
  ] as const) digest(value, label);
  for (const field of [
    "source_candidate_manifest_artifact_sha256",
    "source_candidate_manifest_body_sha256",
    "source_qualification_artifact_sha256",
    "source_qualification_body_sha256",
    "observer_plan_artifact_sha256",
    "observer_plan_body_sha256",
    "curated_manifest_artifact_sha256",
    "curated_manifest_body_sha256",
    "r2_staging_artifact_sha256",
    "r2_staging_body_sha256",
  ]) digest(imageSet[field], `certificate.target_image_set.${field}`);
  for (const field of [
    "observer_request_artifact_sha256",
    "observer_response_artifact_sha256",
    "worker_receipt_sha256",
  ]) {
    const values = imageSet[field];
    if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
      fail(`certificate.target_image_set.${field} population is invalid`);
    }
    values.forEach((value, index) =>
      digest(value, `certificate.target_image_set.${field}[${index}]`));
  }
  queryFreeHttps(imageSet.main_source_url, "certificate MAIN source URL");
  positiveInteger(imageSet.slot_count, "certificate target slot count");
  positiveInteger(truth.outer_units, "certificate Product Truth outer units");
  text(truth.canonical_variant_id, "certificate canonical variant", 512);
  text(truth.content_observation_id, "certificate content observation", 512);
  if (plan.plan_id !== input.plan.plan_id
    || plan.body_sha256 !== input.plan.body_sha256
    || plan.target_sha256 !== input.plan.target.target_sha256
    || truth.expected_sha256 !== input.plan.product_truth.expected_sha256
    || !exactEqual(listing, {
      channel: input.plan.listing.channel,
      store_index: input.plan.listing.store_index,
      sku: input.plan.listing.sku,
      listing_key: input.plan.listing.listing_key,
      item_id: input.plan.listing.item_id,
    })
    || imageSet.exact_projection_sha256
      !== walmartListingIntegritySha256(input.plan.target.images)
    || imageSet.slot_count !== input.plan.target.images.length
    || imageSet.main_source_url !== input.plan.target.images[0]?.source_url
    || imageSet.main_asset_sha256 !== input.plan.target.images[0]?.sha256
    || imageSet.main_derivation !== "DETERMINISTIC_EXACT_SINGLE_UNIT_TILE"
    || !exactEqual(
      input.plan.changed_fields,
      ["description", "bullets", "main", "gallery"],
    )
    || policy.changed_fields_exactly_description_bullets_main_gallery !== true
    || policy.exact_product_truth_verified !== true
    || policy.deterministic_main_bytes_verified !== true
    || policy.signed_blind_worker_receipts_verified !== true
    || policy.every_published_target_passed !== true
    || policy.content_addressed_public_main_verified !== true
    || policy.authority !== "EVIDENCE_ONLY_NOT_WRITE_AUTHORITY"
    || policy.owner_permit_must_bind_certificate_sha256 !== true) {
    fail("certificate does not bind the exact reviewed plan/image-set policy");
  }
  return raw as unknown as SealedWalmartListingRepairReviewedImageSetCertificate;
}
