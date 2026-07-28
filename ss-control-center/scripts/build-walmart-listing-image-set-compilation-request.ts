#!/usr/bin/env node

/**
 * Compile one immutable owner-review request for an exact
 * description+bullets+MAIN+gallery repair. Local/read-only only.
 */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  projectWalmartListingSurfaceFromBuyerPdp,
  walmartListingIntegritySha256,
  type WalmartListingIntegrityInput,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import {
  WALMART_LISTING_REPAIR_IMAGE_SET_COMPILATION_REQUEST_SCHEMA,
} from "../src/lib/walmart/listing-integrity-remediation-owner-compiler.ts";
import {
  precheckWalmartListingRepairTargetForReview,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const OWNER_CONFIRMATION =
  "В продолжании останавливайся. Я все подтверждаю и разрешаю полностью продолжить. Без дополнительных моих разрешений.";

function fail(message: string): never {
  throw new Error(`Walmart image-set compilation request rejected input: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactPath(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    fail(`${label} must be an explicit path`);
  }
  return path.resolve(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

async function readJson(pathname: string, label: string): Promise<{
  path: string;
  bytes: Buffer;
  value: JsonRecord;
}> {
  const exact = exactPath(pathname, label);
  const bytes = await readFile(exact);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds its byte cap`);
  try {
    return {
      path: exact,
      bytes,
      value: record(JSON.parse(bytes.toString("utf8")), label),
    };
  } catch {
    return fail(`${label} is not UTF-8 JSON`);
  }
}

async function artifact(pathname: string, label: string) {
  const exact = exactPath(pathname, label);
  const bytes = await readFile(exact);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds its byte cap`);
  return {
    absolute_path: exact,
    file_sha256: sha256(bytes),
  };
}

async function writeExclusive(pathname: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1]!, match[2]!);
  }
  const exact = [
    "preview",
    "diagnosis",
    "buyer-snapshot",
    "buyer-pdp",
    "seller-item",
    "product-truth",
    "main-candidate-dir",
    "source-candidate-dir",
    "qualification-dir",
    "curated-dir",
    "r2-staging",
    "output-dir",
  ] as const;
  if (flags.size !== exact.length || exact.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${exact.map((key) => `--${key}=...`).join(" ")}`);
  }
  return Object.fromEntries(exact.map((key) => [
    key,
    exactPath(flags.get(key), `--${key}`),
  ])) as Record<(typeof exact)[number], string>;
}

function sealedBodySha(value: JsonRecord, label: string): string {
  const claimed = value.body_sha256;
  if (typeof claimed !== "string" || !/^[a-f0-9]{64}$/u.test(claimed)) {
    fail(`${label}.body_sha256 is invalid`);
  }
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) fail(`${label} body SHA mismatch`);
  return claimed;
}

function exactTarget(
  value: unknown,
  index: number,
  label: string,
): JsonRecord {
  const row = record(value, `${label}[${index}]`);
  const slot = index === 0 ? "main" : `gallery-${index}`;
  if (row.slot !== slot || typeof row.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.sha256)
    || typeof row.file !== "string") {
    fail(`${label}[${index}] is not the exact contiguous target slot`);
  }
  return row;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args["output-dir"]);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const mainManifestPath = path.join(args["main-candidate-dir"], "manifest.json");
  const singleUnitSourcePath = path.join(
    args["main-candidate-dir"],
    "exact-single-unit-source.bin",
  );
  const sourceManifestPath = path.join(args["source-candidate-dir"], "manifest.json");
  const qualificationPath = path.join(args["qualification-dir"], "qualification.json");
  const observerPlanPath = path.join(args["qualification-dir"], "observer-plan.json");
  const curatedManifestPath = path.join(args["curated-dir"], "manifest.json");
  const [
    previewArtifact,
    diagnosisArtifact,
    buyerSnapshotArtifact,
    buyerPdpArtifact,
    sellerItemArtifact,
    productTruthArtifact,
    mainManifestArtifact,
    sourceManifestArtifact,
    qualificationArtifact,
    observerPlanArtifact,
    curatedManifestArtifact,
    r2StagingArtifact,
  ] = await Promise.all([
    readJson(args.preview, "preview"),
    readJson(args.diagnosis, "diagnosis"),
    readJson(args["buyer-snapshot"], "buyer snapshot"),
    readJson(args["buyer-pdp"], "buyer PDP"),
    readJson(args["seller-item"], "seller item"),
    readJson(args["product-truth"], "Product Truth"),
    readJson(mainManifestPath, "MAIN candidate manifest"),
    readJson(sourceManifestPath, "source image-set manifest"),
    readJson(qualificationPath, "source image-set qualification"),
    readJson(observerPlanPath, "observer plan"),
    readJson(curatedManifestPath, "curated image-set manifest"),
    readJson(args["r2-staging"], "R2 staging"),
  ]);
  const preview = previewArtifact.value;
  const diagnosis = diagnosisArtifact.value;
  const detector = record(diagnosis.detector_input, "diagnosis.detector_input");
  const listing = record(detector.listing, "diagnosis listing");
  const expected = detector.expected as unknown as WalmartListingIntegrityInput["expected"];
  const previewAfter = record(preview.after, "preview.after");
  const previewAfterText = record(previewAfter.text, "preview.after.text");
  const surface = projectWalmartListingSurfaceFromBuyerPdp(
    buyerPdpArtifact.value,
    {
      sku: String(listing.sku),
      item_id: String(listing.item_id),
    },
  );
  const targetSurface = {
    ...surface,
    description: String(previewAfterText.description),
    bullets: previewAfterText.bullets as string[],
  };
  precheckWalmartListingRepairTargetForReview({ surface: targetSurface, expected });

  const detectorImages = record(detector.images, "diagnosis images");
  if (!Array.isArray(detectorImages.assets) || detectorImages.assets.length < 2) {
    fail("diagnosis must contain MAIN and at least one gallery image");
  }
  const baselineImages = detectorImages.assets.map((asset, index) => {
    const row = record(asset, `diagnosis image ${index}`);
    return {
      slot: index === 0 ? "main" : `gallery-${index}`,
      source_url: String(row.source_url),
      sha256: String(row.sha256),
    };
  });

  const sourceTargets = sourceManifestArtifact.value.targets;
  const curatedTargets = curatedManifestArtifact.value.targets;
  if (!Array.isArray(sourceTargets) || sourceTargets.length < 2
    || !Array.isArray(curatedTargets) || curatedTargets.length < 2) {
    fail("source/curated target populations are incomplete");
  }
  const exactSourceTargets = sourceTargets.map((entry, index) =>
    exactTarget(entry, index, "source targets"));
  const exactCuratedTargets = curatedTargets.map((entry, index) =>
    exactTarget(entry, index, "curated targets"));
  const r2 = record(r2StagingArtifact.value.r2, "R2 staging.r2");
  const targetImages = exactCuratedTargets.map((target, index) => ({
    slot: index === 0 ? "main" : `gallery-${index}`,
    source_url: index === 0 ? String(r2.public_url) : String(target.source_url),
    sha256: String(target.sha256),
  }));

  if (walmartListingIntegritySha256(baselineImages[0])
      === walmartListingIntegritySha256(targetImages[0])
    || walmartListingIntegritySha256(baselineImages.slice(1))
      === walmartListingIntegritySha256(targetImages.slice(1))) {
    fail("preview does not change both MAIN and gallery");
  }
  const sellerRows = sellerItemArtifact.value.ItemResponse;
  if (!Array.isArray(sellerRows) || sellerRows.length !== 1) {
    fail("seller item must contain one exact row");
  }
  const seller = record(sellerRows[0], "seller item row");
  if (seller.sku !== listing.sku || seller.publishedStatus !== "PUBLISHED"
    || seller.lifecycleStatus !== "ACTIVE") {
    fail("seller item is not the same active published SKU");
  }
  const truthViews = record(productTruthArtifact.value.views, "Product Truth views");
  const improvement = record(truthViews.listingImprovement, "Listing Improvement view");
  if (improvement.ready !== true || !Array.isArray(improvement.components)
    || improvement.components.length !== 1) {
    fail("Product Truth is not one exact ready component");
  }
  const component = record(improvement.components[0], "Product Truth component");
  const content = record(component.content, "Product Truth content");
  const provenance = record(content.provenance, "Product Truth provenance");

  const previewBodySha = sealedBodySha(preview, "preview");
  const curatedBodySha = sealedBodySha(curatedManifestArtifact.value, "curated manifest");
  sealedBodySha(mainManifestArtifact.value, "MAIN candidate manifest");
  sealedBodySha(sourceManifestArtifact.value, "source candidate manifest");
  sealedBodySha(qualificationArtifact.value, "source qualification");
  sealedBodySha(observerPlanArtifact.value, "observer plan");
  sealedBodySha(r2StagingArtifact.value, "R2 staging");
  if (curatedManifestArtifact.value.status !== "PASS"
    || curatedManifestArtifact.value.listing_key !== listing.listing_key
    || curatedManifestArtifact.value.product_truth_file_sha256
      !== sha256(productTruthArtifact.bytes)
    || sourceManifestArtifact.value.listing_key !== listing.listing_key
    || qualificationArtifact.value.listing_key !== listing.listing_key) {
    fail("curated/source/qualification artifacts do not bind the exact listing/Product Truth");
  }

  const qualificationCalls = qualificationArtifact.value.calls;
  if (!Array.isArray(qualificationCalls) || qualificationCalls.length < 1) {
    fail("qualification call population is empty");
  }
  const observerRequests = await Promise.all(qualificationCalls.map((entry, index) => {
    const call = record(entry, `qualification.calls[${index}]`);
    if (call.call_index !== index || typeof call.request_file !== "string") {
      fail(`qualification call ${index} request reference is invalid`);
    }
    return artifact(
      path.join(args["qualification-dir"], call.request_file),
      `observer request ${index}`,
    );
  }));
  const observerResponses = await Promise.all(qualificationCalls.map((entry, index) => {
    const call = record(entry, `qualification.calls[${index}]`);
    if (call.call_index !== index || typeof call.response_file !== "string") {
      fail(`qualification call ${index} response reference is invalid`);
    }
    return artifact(
      path.join(args["qualification-dir"], call.response_file),
      `observer response ${index}`,
    );
  }));
  const sourceCandidateAssets = await Promise.all(exactSourceTargets.map((target, index) =>
    artifact(
      path.join(args["source-candidate-dir"], String(target.file)),
      `source candidate asset ${index}`,
    )));
  const curatedTargetAssets = await Promise.all(exactCuratedTargets.map((target, index) =>
    artifact(
      path.join(args["curated-dir"], String(target.file)),
      `curated target asset ${index}`,
    )));

  const requestBody = {
    schema_version: WALMART_LISTING_REPAIR_IMAGE_SET_COMPILATION_REQUEST_SCHEMA,
    created_at: new Date().toISOString(),
    status: "READY_FOR_CONNECTED_MATERIALS" as const,
    listing: {
      channel: "WALMART_US" as const,
      store_index: Number(listing.store_index),
      sku: String(listing.sku),
      listing_key: String(listing.listing_key),
      item_id: String(listing.item_id),
      seller_upc: String(seller.upc),
      captured_at: String(listing.captured_at),
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      composition: "same_product" as const,
    },
    frozen_review: {
      proposal_file_sha256: sha256(previewArtifact.bytes),
      proposal_body_sha256: previewBodySha,
      certification_file_sha256: sha256(curatedManifestArtifact.bytes),
      certification_body_sha256: curatedBodySha,
      diagnosis_file_sha256: sha256(diagnosisArtifact.bytes),
      buyer_snapshot_file_sha256: sha256(buyerSnapshotArtifact.bytes),
      buyer_pdp_file_sha256: sha256(buyerPdpArtifact.bytes),
      donor_audit_file_sha256: sha256(productTruthArtifact.bytes),
    },
    product_truth_candidate: {
      candidate_sha256: walmartListingIntegritySha256({
        canonical_variant_id: component.targetCanonicalVariantId,
        content_observation_id: provenance.contentObservationId,
        content_hash: provenance.contentHash,
      }),
      expected_sha256: walmartListingIntegritySha256(expected),
      donor_product_id: String(provenance.donorProductId),
      single_unit_upc: null,
      outer_units: Number(component.qty),
      expected,
    },
    repair: {
      baseline_surface: surface,
      target_surface: targetSurface,
      baseline_images: baselineImages,
      target_images: targetImages,
      changed_fields: ["description", "bullets", "main", "gallery"] as const,
      unchanged_image_bytes: false as const,
      changed_image_set_evidence: {
        product_truth: await artifact(args["product-truth"], "Product Truth"),
        main_candidate_manifest: await artifact(
          mainManifestPath,
          "MAIN candidate manifest",
        ),
        single_unit_source: await artifact(
          singleUnitSourcePath,
          "single-unit source asset",
        ),
        source_candidate_manifest: await artifact(
          sourceManifestPath,
          "source candidate manifest",
        ),
        source_candidate_assets: sourceCandidateAssets,
        source_qualification: await artifact(
          qualificationPath,
          "source qualification",
        ),
        observer_plan: await artifact(observerPlanPath, "observer plan"),
        observer_requests: observerRequests,
        observer_responses: observerResponses,
        curated_manifest: await artifact(curatedManifestPath, "curated manifest"),
        curated_target_assets: curatedTargetAssets,
        r2_staging: await artifact(args["r2-staging"], "R2 staging"),
      },
    },
    owner_gate: {
      exact_confirmation: OWNER_CONFIRMATION,
      confirms_only_reviewed_diff: true as const,
      confirmation_would_authorize_product_truth_activation: true as const,
      confirmation_would_authorize_one_sku_package_compilation: true as const,
      current_walmart_write_authorized: false as const,
      current_mass_run_authorized: false as const,
    },
    assurance: {
      network_calls: 0 as const,
      model_calls: 0 as const,
      database_reads: 0 as const,
      database_writes: 0 as const,
      walmart_reads: 0 as const,
      walmart_writes: 0 as const,
    },
    next_required_inputs: [
      "fresh owner-package doctor",
      "one OAuth token call",
      "one exact Walmart item GET",
      "one Get Spec POST",
      "one Ed25519 one-SKU execution permit",
    ],
  };
  const request = {
    ...requestBody,
    body_sha256: walmartListingIntegritySha256(requestBody),
  };
  await mkdir(args["output-dir"], { recursive: false, mode: 0o700 });
  const outputPath = path.join(args["output-dir"], "compilation-request.json");
  await writeExclusive(
    outputPath,
    Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8"),
  );
  await chmod(args["output-dir"], 0o500);
  process.stdout.write(`${JSON.stringify({
    status: request.status,
    listing_key: request.listing.listing_key,
    changed_fields: request.repair.changed_fields,
    target_image_count: request.repair.target_images.length,
    compilation_request_path: outputPath,
    compilation_request_body_sha256: request.body_sha256,
    exact_owner_confirmation: OWNER_CONFIRMATION,
    safety: request.assurance,
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
