#!/usr/bin/env node

/**
 * Build one immutable owner-review preview and v3 attributes-only compilation
 * request from exact Product Truth, buyer PDP, seller item, and frozen
 * diagnosis bytes. Local/read-only only; this script performs no network,
 * database, model, or Walmart write calls.
 */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  projectWalmartListingSurfaceFromBuyerPdp,
  walmartListingIntegritySha256,
  type ListingAttributeClaim,
  type WalmartListingIntegrityInput,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import {
  WALMART_LISTING_REPAIR_ATTRIBUTE_COMPILATION_REQUEST_SCHEMA,
  verifyWalmartListingRepairCompilationRequest,
} from "../src/lib/walmart/listing-integrity-remediation-owner-compiler.ts";
import {
  precheckWalmartListingRepairTargetForReview,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const OWNER_CONFIRMATION =
  "В продолжании останавливайся. Я все подтверждаю и разрешаю полностью продолжить. Без дополнительных моих разрешений.";

function fail(message: string): never {
  throw new Error(`Walmart attribute compilation request rejected input: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
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

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) {
      fail(`unsupported or duplicate argument: ${argument}`);
    }
    flags.set(match[1]!, match[2]!);
  }
  const pathFlags = [
    "diagnosis",
    "buyer-snapshot",
    "buyer-pdp",
    "seller-item",
    "product-truth",
    "output-dir",
  ] as const;
  const exactFlags = [...pathFlags, "single-unit-upc"] as const;
  if (flags.size !== exactFlags.length
    || exactFlags.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${exactFlags.map((key) => `--${key}=...`).join(" ")}`);
  }
  const singleUnitUpc = flags.get("single-unit-upc")!;
  if (!/^\d{12,14}$/u.test(singleUnitUpc)) {
    fail("--single-unit-upc must be a 12..14 digit exact base-unit identifier");
  }
  return {
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
    buyerSnapshot: exactPath(flags.get("buyer-snapshot"), "--buyer-snapshot"),
    buyerPdp: exactPath(flags.get("buyer-pdp"), "--buyer-pdp"),
    sellerItem: exactPath(flags.get("seller-item"), "--seller-item"),
    productTruth: exactPath(flags.get("product-truth"), "--product-truth"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
    singleUnitUpc,
  };
}

async function readJson(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: JsonRecord;
}> {
  const bytes = await readFile(pathname);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) {
    fail(`${label} exceeds its byte cap`);
  }
  try {
    return {
      bytes,
      value: record(JSON.parse(bytes.toString("utf8")), label),
    };
  } catch {
    return fail(`${label} is not UTF-8 JSON`);
  }
}

function sealedBody(value: JsonRecord, label: string): string {
  if (typeof value.body_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.body_sha256)) {
    fail(`${label}.body_sha256 is invalid`);
  }
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== value.body_sha256) {
    fail(`${label} body SHA mismatch`);
  }
  return value.body_sha256;
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

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seal<T extends JsonRecord>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingIntegritySha256(body) };
}

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderGallery(input: {
  sku: string;
  itemId: string;
  title: string;
  mainUrl: string;
  before: ListingAttributeClaim[];
  after: ListingAttributeClaim[];
}): string {
  const rows = (claims: ListingAttributeClaim[]) => claims.map((claim) => (
    `<tr><td>${htmlEscape(claim.field_path)}</td><td>${htmlEscape(claim.kind)}</td>`
    + `<td>${htmlEscape("text" in claim ? claim.text : `${claim.value} ${claim.unit}`)}</td></tr>`
  )).join("");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${htmlEscape(input.sku)} — attributes</title>
<style>
body{font-family:system-ui,sans-serif;margin:32px;background:#f6f7f9;color:#17202a}
.wrap{max-width:1200px;margin:auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.card{background:white;border:1px solid #d9dee6;border-radius:14px;padding:20px}
.before{border-top:6px solid #c0392b}.after{border-top:6px solid #1e8449}
img{width:100%;height:300px;object-fit:contain;background:white}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left}
.note{padding:14px;background:#eafaf1;border-radius:10px;margin:18px 0}
</style></head><body><div class="wrap">
<h1>${htmlEscape(input.sku)} · Walmart item ${htmlEscape(input.itemId)}</h1>
<p>${htmlEscape(input.title)}</p>
<img src="${htmlEscape(input.mainUrl)}" alt="Unchanged Walmart MAIN">
<div class="note">Изображения, title, description и bullets не меняются. Исправляются только четыре структурированных атрибута.</div>
<div class="grid">
<section class="card before"><h2>ДО — live buyer surface</h2><table><tr><th>Источник</th><th>Тип</th><th>Значение</th></tr>${rows(input.before)}</table></section>
<section class="card after"><h2>ПОСЛЕ — exact preview</h2><table><tr><th>Источник</th><th>Тип</th><th>Значение</th></tr>${rows(input.after)}</table></section>
</div></div></body></html>`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.outputDir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const [diagnosisArtifact, snapshotArtifact, buyerPdpArtifact,
    sellerArtifact, truthArtifact] = await Promise.all([
    readJson(args.diagnosis, "diagnosis"),
    readJson(args.buyerSnapshot, "buyer snapshot"),
    readJson(args.buyerPdp, "buyer PDP"),
    readJson(args.sellerItem, "seller item"),
    readJson(args.productTruth, "Product Truth"),
  ]);
  sealedBody(diagnosisArtifact.value, "diagnosis");
  const detector = record(diagnosisArtifact.value.detector_input, "diagnosis.detector_input");
  const listing = record(detector.listing, "diagnosis listing");
  const expected = detector.expected as unknown as WalmartListingIntegrityInput["expected"];
  const surface = projectWalmartListingSurfaceFromBuyerPdp(
    buyerPdpArtifact.value,
    { sku: String(listing.sku), item_id: String(listing.item_id) },
  );
  const sellerRows = sellerArtifact.value.ItemResponse;
  if (!Array.isArray(sellerRows) || sellerRows.length !== 1) {
    fail("seller item must contain one exact row");
  }
  const seller = record(sellerRows[0], "seller item row");
  if (seller.sku !== listing.sku || seller.publishedStatus !== "PUBLISHED"
    || seller.lifecycleStatus !== "ACTIVE") {
    fail("seller item is not the exact active published SKU");
  }
  const views = record(truthArtifact.value.views, "Product Truth views");
  const improvement = record(views.listingImprovement, "Listing Improvement view");
  if (improvement.ready !== true || !Array.isArray(improvement.components)
    || improvement.components.length !== 1) {
    fail("Product Truth is not one exact repair-ready component");
  }
  const component = record(improvement.components[0], "Product Truth component");
  const content = record(component.content, "Product Truth content");
  const provenance = record(content.provenance, "Product Truth provenance");
  const flavor = String(component.flavor);
  const outerUnits = Number(component.qty);
  if (!flavor || !Number.isInteger(outerUnits) || outerUnits < 2
    || outerUnits !== expected.outer_units) {
    fail("Product Truth flavor/outer quantity is invalid or disagrees with diagnosis");
  }

  let flavorChanges = 0;
  let countChanges = 0;
  let beforeFlavor = "";
  let beforeCount = 0;
  const targetClaims = surface.attribute_claims.map((claim): ListingAttributeClaim => {
    if (claim.kind === "variant" && /flavor$/iu.test(claim.field_path)) {
      flavorChanges += 1;
      beforeFlavor = claim.text;
      return { ...claim, text: flavor };
    }
    if (claim.kind === "inner_item_count" && /\.count$/iu.test(claim.field_path)) {
      countChanges += 1;
      beforeCount = claim.value;
      return { ...claim, value: outerUnits };
    }
    return structuredClone(claim);
  });
  if (flavorChanges !== 1 || countChanges !== 1) {
    fail("buyer surface must expose exactly one Flavor and one Count claim");
  }
  targetClaims.push(
    {
      field_path: "walmart.Visible.countPerPack",
      kind: "inner_item_count",
      value: 1,
      unit: "count",
    },
    {
      field_path: "walmart.Visible.multipackQuantity",
      kind: "outer_units",
      value: outerUnits,
      unit: "count",
    },
  );
  const targetSurface = {
    ...surface,
    attribute_claims: targetClaims,
    unmapped_attributes: structuredClone(surface.unmapped_attributes),
  };
  precheckWalmartListingRepairTargetForReview({ surface: targetSurface, expected });

  const detectorImages = record(detector.images, "diagnosis images");
  if (!Array.isArray(detectorImages.assets) || detectorImages.assets.length < 1) {
    fail("diagnosis has no exact buyer image inventory");
  }
  const images = detectorImages.assets.map((asset, index) => {
    const row = record(asset, `diagnosis image ${index}`);
    return {
      slot: index === 0 ? "main" : `gallery-${index}`,
      source_url: String(row.source_url),
      sha256: String(row.sha256),
    };
  });

  const createdAt = new Date().toISOString();
  const preview = seal({
    schema_version: "walmart-listing-attribute-repair-preview/v1",
    created_at: createdAt,
    status: "READY_FOR_CONNECTED_MATERIALS",
    listing_key: String(listing.listing_key),
    changed_fields: ["attributes"],
    exact_diff: {
      flavor: { before: beforeFlavor, after: flavor },
      count: { before: beforeCount, after: outerUnits },
      countPerPack: { before: null, after: 1 },
      multipackQuantity: { before: null, after: outerUnits },
    },
    unchanged: {
      title: true,
      description: true,
      bullets: true,
      main: true,
      gallery: true,
      opaque_attributes_preserved_by_omission: true,
      price: true,
      inventory: true,
      published_status: true,
    },
  });
  const qualification = seal({
    schema_version: "walmart-listing-attribute-repair-preview-qualification/v1",
    created_at: createdAt,
    listing_key: String(listing.listing_key),
    verdict: "PASS",
    checks: {
      product_truth_exact: true,
      target_precheck_passed: true,
      only_attribute_claims_changed: true,
      unmapped_attributes_exactly_preserved: true,
      all_images_exactly_preserved: true,
      core_text_exactly_preserved: true,
    },
  });
  const previewBytes = jsonBytes(preview);
  const qualificationBytes = jsonBytes(qualification);
  const requestBody = {
    schema_version: WALMART_LISTING_REPAIR_ATTRIBUTE_COMPILATION_REQUEST_SCHEMA,
    created_at: createdAt,
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
      proposal_file_sha256: sha256(previewBytes),
      proposal_body_sha256: preview.body_sha256,
      certification_file_sha256: sha256(qualificationBytes),
      certification_body_sha256: qualification.body_sha256,
      diagnosis_file_sha256: sha256(diagnosisArtifact.bytes),
      buyer_snapshot_file_sha256: sha256(snapshotArtifact.bytes),
      buyer_pdp_file_sha256: sha256(buyerPdpArtifact.bytes),
      donor_audit_file_sha256: sha256(truthArtifact.bytes),
    },
    product_truth_candidate: {
      candidate_sha256: walmartListingIntegritySha256({
        canonical_variant_id: component.targetCanonicalVariantId,
        content_observation_id: provenance.contentObservationId,
        content_hash: provenance.contentHash,
      }),
      expected_sha256: walmartListingIntegritySha256(expected),
      donor_product_id: String(provenance.donorProductId),
      single_unit_upc: args.singleUnitUpc,
      outer_units: outerUnits,
      expected,
    },
    repair: {
      baseline_surface: surface,
      target_surface: targetSurface,
      baseline_images: images,
      target_images: images,
      changed_fields: ["attributes"] as const,
      unchanged_image_bytes: true as const,
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
  const request = seal(requestBody);
  verifyWalmartListingRepairCompilationRequest(request);
  const requestBytes = jsonBytes(request);
  const gallery = renderGallery({
    sku: String(listing.sku),
    itemId: String(listing.item_id),
    title: surface.title,
    mainUrl: images[0]!.source_url,
    before: surface.attribute_claims,
    after: targetClaims,
  });

  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeExclusive(path.join(args.outputDir, "preview.json"), previewBytes),
    writeExclusive(path.join(args.outputDir, "preview-qualification.json"), qualificationBytes),
    writeExclusive(path.join(args.outputDir, "compilation-request.json"), requestBytes),
    writeExclusive(path.join(args.outputDir, "gallery.html"), Buffer.from(gallery, "utf8")),
  ]);
  await chmod(args.outputDir, 0o500);
  process.stdout.write(`${JSON.stringify({
    status: request.status,
    listing_key: request.listing.listing_key,
    changed_fields: request.repair.changed_fields,
    compilation_request_path: path.join(args.outputDir, "compilation-request.json"),
    compilation_request_body_sha256: request.body_sha256,
    preview_path: path.join(args.outputDir, "preview.json"),
    gallery_path: path.join(args.outputDir, "gallery.html"),
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
