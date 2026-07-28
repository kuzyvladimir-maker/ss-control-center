#!/usr/bin/env node

/**
 * Compile one immutable owner-review request for an exact
 * description+bullets+MAIN repair. Local/read-only only.
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
  WALMART_LISTING_REPAIR_MAIN_COMPILATION_REQUEST_SCHEMA,
} from "../src/lib/walmart/listing-integrity-remediation-owner-compiler.ts";
import {
  precheckWalmartListingRepairTargetForReview,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const OWNER_CONFIRMATION =
  "В продолжании останавливайся. Я все подтверждаю и разрешаю полностью продолжить. Без дополнительных моих разрешений.";

function fail(message: string): never {
  throw new Error(`Walmart MAIN compilation request rejected input: ${message}`);
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
    "candidate-dir",
    "qualification-dir",
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args["output-dir"]);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const candidateManifestPath = path.join(args["candidate-dir"], "manifest.json");
  const qualificationPath = path.join(args["qualification-dir"], "qualification.json");
  const observerPlanPath = path.join(args["qualification-dir"], "observer-plan.json");
  const observerRequestPath = path.join(args["qualification-dir"], "call-00-request.json");
  const observerResponsePath = path.join(args["qualification-dir"], "call-00-response.json");
  const candidateAssetPath = path.join(args["candidate-dir"], "proposed-main-pack.png");
  const singleUnitSourcePath = path.join(
    args["candidate-dir"],
    "exact-single-unit-source.bin",
  );
  const [
    previewArtifact,
    diagnosisArtifact,
    buyerSnapshotArtifact,
    buyerPdpArtifact,
    sellerItemArtifact,
    productTruthArtifact,
    candidateManifestArtifact,
    qualificationArtifact,
    r2StagingArtifact,
  ] = await Promise.all([
    readJson(args.preview, "preview"),
    readJson(args.diagnosis, "diagnosis"),
    readJson(args["buyer-snapshot"], "buyer snapshot"),
    readJson(args["buyer-pdp"], "buyer PDP"),
    readJson(args["seller-item"], "seller item"),
    readJson(args["product-truth"], "Product Truth"),
    readJson(candidateManifestPath, "candidate manifest"),
    readJson(qualificationPath, "candidate qualification"),
    readJson(args["r2-staging"], "R2 staging"),
  ]);
  const preview = previewArtifact.value;
  const diagnosis = diagnosisArtifact.value;
  const detector = record(diagnosis.detector_input, "diagnosis.detector_input");
  const listing = record(detector.listing, "diagnosis listing");
  const expected = detector.expected as unknown as WalmartListingIntegrityInput["expected"];
  const previewAfter = record(preview.after, "preview.after");
  const previewAfterText = record(previewAfter.text, "preview.after.text");
  const previewAfterImages = record(previewAfter.images, "preview.after.images");
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
  precheckWalmartListingRepairTargetForReview({
    surface: targetSurface,
    expected,
  });
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
  const r2 = record(r2StagingArtifact.value.r2, "R2 staging.r2");
  const targetImages = [
    {
      slot: "main",
      source_url: String(r2.public_url),
      sha256: String(previewAfterImages.main_sha256),
    },
    ...baselineImages.slice(1),
  ];
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
  const candidateManifestBodySha = sealedBodySha(
    candidateManifestArtifact.value,
    "candidate manifest",
  );
  const qualificationBodySha = sealedBodySha(
    qualificationArtifact.value,
    "candidate qualification",
  );
  const r2BodySha = sealedBodySha(r2StagingArtifact.value, "R2 staging");
  const previewBodySha = sealedBodySha(preview, "preview");
  const requestBody = {
    schema_version: WALMART_LISTING_REPAIR_MAIN_COMPILATION_REQUEST_SCHEMA,
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
      certification_file_sha256: sha256(qualificationArtifact.bytes),
      certification_body_sha256: qualificationBodySha,
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
      single_unit_upc: "014100070931",
      outer_units: Number(component.qty),
      expected,
    },
    repair: {
      baseline_surface: surface,
      target_surface: targetSurface,
      baseline_images: baselineImages,
      target_images: targetImages,
      changed_fields: ["description", "bullets", "main"] as const,
      unchanged_image_bytes: false as const,
      changed_main_evidence: {
        product_truth: await artifact(args["product-truth"], "Product Truth"),
        candidate_manifest: await artifact(candidateManifestPath, "candidate manifest"),
        single_unit_source: await artifact(
          singleUnitSourcePath,
          "single-unit source asset",
        ),
        candidate_asset: await artifact(candidateAssetPath, "candidate asset"),
        qualification: await artifact(qualificationPath, "candidate qualification"),
        observer_plan: await artifact(observerPlanPath, "observer plan"),
        observer_request: await artifact(observerRequestPath, "observer request"),
        observer_response: await artifact(observerResponsePath, "observer response"),
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
    compilation_request_path: outputPath,
    compilation_request_body_sha256: request.body_sha256,
    exact_owner_confirmation: OWNER_CONFIRMATION,
    evidence: {
      candidate_manifest_body_sha256: candidateManifestBodySha,
      qualification_body_sha256: qualificationBodySha,
      r2_staging_body_sha256: r2BodySha,
    },
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
