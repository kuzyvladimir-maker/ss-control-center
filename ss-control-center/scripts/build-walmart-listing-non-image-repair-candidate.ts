#!/usr/bin/env node

/**
 * Build one exact title/description/bullets/attributes repair package input.
 *
 * The command is deliberately local-only. It consumes a sealed diagnosis,
 * exact Product Truth and the buyer snapshot already captured for one SKU.
 * Images and opaque attributes are byte/value-hash preserved. It performs no
 * network, model, database or Walmart call.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  precheckWalmartListingRepairTargetForReview,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";
import {
  walmartListingIntegritySha256,
  type ListingAttributeClaim,
  type WalmartListingIntegrityInput,
  type WalmartListingSurface,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import type { ProductTruthSnapshot } from
  "../src/lib/sourcing/product-truth-read-contract.ts";

type JsonRecord = Record<string, unknown>;
const MAX_JSON_BYTES = 100 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Walmart non-image candidate rejected input: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string, maximum = 20_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
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
    if (!match || flags.has(match[1]!)) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1]!, match[2]!);
  }
  const required = [
    "product-truth", "diagnosis", "buyer-snapshot", "buyer-pdp", "output-dir",
  ] as const;
  if (flags.size !== required.length || required.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${required.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    productTruth: exactPath(flags.get("product-truth"), "--product-truth"),
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
    buyerSnapshot: exactPath(flags.get("buyer-snapshot"), "--buyer-snapshot"),
    buyerPdp: exactPath(flags.get("buyer-pdp"), "--buyer-pdp"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

async function readJson<T>(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: T;
}> {
  const bytes = await readFile(pathname);
  if (bytes.length < 2 || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds byte bounds`);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
  } catch {
    return fail(`${label} is not JSON`);
  }
}

async function writeExclusive(pathname: string, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return bytes;
}

function seal<T extends JsonRecord>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingIntegritySha256(body) };
}

function needsRepair(value: unknown, outerUnits: number): boolean {
  return value !== "MATCH" && !(outerUnits === 1 && value === "NOT_APPLICABLE");
}

function numberWord(value: number): string {
  const words: Record<number, string> = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
    7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve",
  };
  return words[value] ?? String(value);
}

function pluralForm(form: string | null | undefined): string {
  const normalized = String(form ?? "package").trim().toLowerCase();
  if (!normalized) return "packages";
  if (normalized.endsWith("s")) return normalized;
  if (normalized.endsWith("x") || normalized.endsWith("ch")
    || normalized.endsWith("sh")) return `${normalized}es`;
  return `${normalized}s`;
}

function normalizedFieldPath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function replaceOrAddClaim(input: {
  claims: ListingAttributeClaim[];
  matches: (claim: ListingAttributeClaim) => boolean;
  replacement: ListingAttributeClaim;
}): void {
  const index = input.claims.findIndex(input.matches);
  if (index >= 0) input.claims[index] = input.replacement;
  else input.claims.push(input.replacement);
}

function exactImages(snapshot: JsonRecord) {
  const assets = snapshot.assets;
  if (!Array.isArray(assets) || assets.length < 2) fail("buyer snapshot needs MAIN plus gallery");
  return assets.map((raw, index) => {
    const asset = record(raw, `buyer snapshot.assets[${index}]`);
    return {
      slot: index === 0 ? "main" as const : `gallery-${index}` as const,
      source_url: text(asset.source_url, `buyer snapshot.assets[${index}].source_url`),
      sha256: text(asset.sha256, `buyer snapshot.assets[${index}].sha256`, 64),
    };
  });
}

function exactStringRows(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1) fail(`${label} must be non-empty`);
  return value.map((row, index) => text(row, `${label}[${index}]`));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.outputDir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [truthFile, diagnosisFile, snapshotFile, buyerFile, resolutionFile] =
    await Promise.all([
      readJson<ProductTruthSnapshot>(args.productTruth, "Product Truth"),
      readJson<JsonRecord>(args.diagnosis, "diagnosis"),
      readJson<JsonRecord>(args.buyerSnapshot, "buyer snapshot"),
      readJson<JsonRecord>(args.buyerPdp, "buyer PDP"),
      readJson<JsonRecord>(
        path.join(path.dirname(args.productTruth), "exact-resolution.json"),
        "exact resolution",
      ),
    ]);
  const truth = truthFile.value;
  const diagnosis = diagnosisFile.value;
  const diagnosisBody = { ...diagnosis };
  delete diagnosisBody.body_sha256;
  if (diagnosis.schema_version !== "walmart-listing-single-process-report/v1"
    || diagnosis.body_sha256 !== walmartListingIntegritySha256(diagnosisBody)) {
    fail("diagnosis seal or schema differs");
  }
  const outcome = record(diagnosis.outcome, "diagnosis.outcome");
  if (outcome.status !== "BAD" && outcome.status !== "REVIEW") {
    fail("diagnosis is not a repairable BAD/REVIEW outcome");
  }
  const detector = record(diagnosis.detector_input, "diagnosis.detector_input");
  const report = record(diagnosis.detector_report, "diagnosis.detector_report");
  const listing = record(detector.listing, "diagnosis listing");
  const expected = record(
    detector.expected,
    "diagnosis expected",
  ) as unknown as WalmartListingIntegrityInput["expected"];
  const surface = structuredClone(
    record(detector.surface, "diagnosis surface"),
  ) as unknown as WalmartListingSurface;
  const components = truth.views?.listingImprovement?.components ?? [];
  if (!truth.views?.listingImprovement?.ready || components.length !== 1
    || truth.snapshot.listingKey !== diagnosis.listing_key
    || truth.snapshot.listingKey !== listing.listing_key) {
    fail("Product Truth/listing identity is not exact and ready");
  }
  const component = components[0]!;
  const content = component.content;
  if (!content || component.contentBlockers.length
    || content.canonicalVariantId !== component.targetCanonicalVariantId
    || !Number.isSafeInteger(component.qty) || component.qty < 1) {
    fail("Product Truth content/count is incomplete");
  }
  const outerUnits = component.qty;
  if (expected.outer_units !== outerUnits) fail("diagnosis count differs from Product Truth");

  const main = record(report.main_decision, "main decision");
  if (main.verdict !== "PASS" || !Array.isArray(main.hard_failures)
    || main.hard_failures.length > 0) {
    fail("non-image route requires current MAIN PASS");
  }
  const gallery = report.gallery_decisions;
  if (!Array.isArray(gallery) || gallery.length < 1 || gallery.some((raw) => {
    const row = record(raw, "gallery decision");
    return row.verdict === "BAD" || !Array.isArray(row.hard_failures)
      || row.hard_failures.length > 0 || Boolean(row.technical_error) || Boolean(row.missing_reason);
  })) {
    fail("non-image route requires hard-failure-free gallery evidence");
  }
  const textDecision = record(report.text_decision, "text decision");
  const checks = record(textDecision.checks, "text decision checks");
  const changedFields: Array<"title" | "description" | "bullets" | "attributes"> = [];
  const titleNeedsRepair = [
    checks.title_identity, checks.title_outer_units, checks.title_package_facts,
  ].some((value) => needsRepair(value, outerUnits));
  const bodyNeedsRepair = [
    checks.body_identity, checks.body_outer_units, checks.body_package_facts,
  ].some((value) => needsRepair(value, outerUnits));
  const attributesNeedRepair = checks.attributes_identity === "MISMATCH"
    || needsRepair(checks.attributes_outer_units, outerUnits);
  if (checks.attributes_package_facts === "MISMATCH") {
    fail("typed package-fact mismatch has no approved surgical mapping");
  }
  const target = structuredClone(surface);
  const facts = content.facts;
  if (titleNeedsRepair) {
    const donorTitle = text(facts.title, "Product Truth title", 500)
      .replace(/\s*\((?:pack|quantity)\s+of\s+\d+\)\s*$/iu, "")
      .trim();
    target.title = outerUnits > 1 ? `${donorTitle} (Pack of ${outerUnits})` : donorTitle;
    changedFields.push("title");
  }
  if (bodyNeedsRepair) {
    const forms = pluralForm(content.identity.form);
    const quantity = outerUnits > 1
      ? `This listing includes ${numberWord(outerUnits)} ${component.size} ${forms} `
        + `(Pack of ${outerUnits}).`
      : `This listing includes one ${component.size} ${forms.replace(/s$/u, "")}.`;
    target.description = `${target.title}. ${quantity} ${text(
      facts.description,
      "Product Truth description",
      50_000,
    )}`.replace(/\s+/gu, " ").trim();
    const donorBullets = exactStringRows(facts.bullets, "Product Truth bullets");
    const packBullet = outerUnits > 1
      ? `PACK OF ${outerUnits}: Includes ${outerUnits} ${component.size} ${forms} of ${component.product}`
      : `ONE PACKAGE: Includes one ${component.size} ${forms.replace(/s$/u, "")} of ${component.product}`;
    target.bullets = [packBullet, ...donorBullets]
      .filter((row, index, rows) => rows.indexOf(row) === index)
      .slice(0, 6);
    changedFields.push("description", "bullets");
  }
  if (attributesNeedRepair) {
    const claims = structuredClone(surface.attribute_claims);
    if (checks.attributes_identity === "MISMATCH") {
      const flavor = component.flavor ?? content.identity.flavor;
      if (!flavor) fail("variant mismatch has no exact Product Truth flavor mapping");
      replaceOrAddClaim({
        claims,
        matches: (claim) => claim.kind === "variant",
        replacement: {
          field_path: "walmart.Visible.flavor",
          kind: "variant",
          text: flavor,
        },
      });
    }
    replaceOrAddClaim({
      claims,
      matches: (claim) => claim.kind === "inner_item_count"
        && normalizedFieldPath(claim.field_path).endsWith("count")
        && !normalizedFieldPath(claim.field_path).endsWith("countperpack"),
      replacement: {
        field_path: "walmart.Visible.count",
        kind: "inner_item_count",
        value: outerUnits,
        unit: "count",
      },
    });
    replaceOrAddClaim({
      claims,
      matches: (claim) => normalizedFieldPath(claim.field_path).endsWith("countperpack"),
      replacement: {
        field_path: "walmart.Visible.countPerPack",
        kind: "inner_item_count",
        value: 1,
        unit: "count",
      },
    });
    replaceOrAddClaim({
      claims,
      matches: (claim) => claim.kind === "outer_units",
      replacement: {
        field_path: "walmart.Visible.multipackQuantity",
        kind: "outer_units",
        value: outerUnits,
        unit: "count",
      },
    });
    target.attribute_claims = claims;
    changedFields.push("attributes");
  }
  if (changedFields.length < 1) fail("diagnosis contains no supported non-image diff");
  precheckWalmartListingRepairTargetForReview({ surface: target, expected });
  const actualFields = (["title", "description", "bullets", "attributes"] as const)
    .filter((field) => {
      const before = field === "attributes"
        ? [surface.attribute_claims, surface.unmapped_attributes] : surface[field];
      const after = field === "attributes"
        ? [target.attribute_claims, target.unmapped_attributes] : target[field];
      return walmartListingIntegritySha256(before) !== walmartListingIntegritySha256(after);
    });
  if (walmartListingIntegritySha256(actualFields)
    !== walmartListingIntegritySha256(changedFields)) {
    fail("computed non-image diff differs from requested canonical fields");
  }

  const snapshot = snapshotFile.value;
  const snapshotTarget = record(snapshot.target, "buyer snapshot.target");
  const buyerProduct = record(buyerFile.value.product, "buyer PDP.product");
  if (snapshotTarget.sku !== truth.snapshot.sku
    || snapshotTarget.item_id !== listing.item_id
    || buyerProduct.item_id !== listing.item_id
    || buyerProduct.title !== surface.title) {
    fail("buyer snapshot/PDP differs from diagnosis identity");
  }
  const images = exactImages(snapshot);
  const normalizedGtin14 = text(content.facts.normalizedGtin14, "normalized GTIN", 14);
  const singleUnitUpc = normalizedGtin14.replace(/^0+(?=\d{12,13}$)/u, "");
  const seller = record(resolutionFile.value.seller, "exact resolution seller");
  const donorAudit = seal({
    schema_version: "walmart-listing-exact-donor-audit/v2",
    listing_key: truth.snapshot.listingKey,
    donor_product_id: content.provenance.donorProductId,
    canonical_variant_id: content.canonicalVariantId,
    content_observation_id: content.provenance.contentObservationId,
    content_hash: content.provenance.contentHash,
    source_url: content.provenance.sourceUrl,
    normalized_gtin14: normalizedGtin14,
    changed_fields: changedFields,
    authority: {
      exact_variant_only: true,
      price_evidence_used_as_content_truth: false,
      walmart_write_authorized: false,
    },
  });
  const proposal = seal({
    schema_version: "walmart-listing-integrity-non-image-review/v1",
    status: "REVIEW_ONLY",
    listing: {
      listing_key: truth.snapshot.listingKey,
      store_index: truth.snapshot.storeIndex,
      sku: truth.snapshot.sku,
      item_id: text(listing.item_id, "listing item_id", 100),
      seller_upc: text(seller.upc, "seller UPC", 64),
    },
    changed_fields: changedFields,
    before: surface,
    after: target,
    images_unchanged: true,
    opaque_attributes_unchanged: true,
    authority: {
      authorizes_walmart_write: false,
      mass_run_authorized: false,
    },
  });
  const certification = seal({
    schema_version: "walmart-listing-integrity-non-image-review-certification/v1",
    status: "PASS",
    listing_key: truth.snapshot.listingKey,
    changed_fields: changedFields,
    proposal_body_sha256: proposal.body_sha256,
    diagnosis_file_sha256: sha256(diagnosisFile.bytes),
    product_truth_file_sha256: sha256(truthFile.bytes),
    buyer_snapshot_file_sha256: sha256(snapshotFile.bytes),
    buyer_pdp_file_sha256: sha256(buyerFile.bytes),
    target_precheck: "PASS",
    exact_images_unchanged: true,
    price_inventory_repricing_delist_unchanged: true,
    walmart_write_authorized: false,
  });

  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const donorAuditBytes = await writeExclusive(path.join(args.outputDir, "donor-audit.json"), donorAudit);
  const proposalBytes = await writeExclusive(path.join(args.outputDir, "review-proposal.json"), proposal);
  const certificationBytes = await writeExclusive(
    path.join(args.outputDir, "review-certification.json"),
    certification,
  );
  const candidate = {
    donor_product_id: content.provenance.donorProductId,
    canonical_variant_id: content.canonicalVariantId,
    content_observation_id: content.provenance.contentObservationId,
    expected,
    changed_fields: changedFields,
  };
  const confirmationFields = changedFields.join(", ");
  const requestBody = {
    schema_version: "walmart-listing-single-repair-compilation-request/v6",
    created_at: new Date().toISOString(),
    status: "READY_FOR_CONNECTED_MATERIALS",
    listing: {
      channel: "WALMART_US",
      store_index: truth.snapshot.storeIndex,
      sku: truth.snapshot.sku,
      listing_key: truth.snapshot.listingKey,
      item_id: text(listing.item_id, "listing item_id", 100),
      seller_upc: text(seller.upc, "seller UPC", 64),
      captured_at: text(snapshot.captured_at, "buyer snapshot captured_at", 100),
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      composition: "same_product",
    },
    frozen_review: {
      proposal_file_sha256: sha256(proposalBytes),
      proposal_body_sha256: proposal.body_sha256,
      certification_file_sha256: sha256(certificationBytes),
      certification_body_sha256: certification.body_sha256,
      diagnosis_file_sha256: sha256(diagnosisFile.bytes),
      buyer_snapshot_file_sha256: sha256(snapshotFile.bytes),
      buyer_pdp_file_sha256: sha256(buyerFile.bytes),
      donor_audit_file_sha256: sha256(donorAuditBytes),
    },
    product_truth_candidate: {
      candidate_sha256: walmartListingIntegritySha256(candidate),
      expected_sha256: walmartListingIntegritySha256(expected),
      donor_product_id: content.provenance.donorProductId,
      single_unit_upc: singleUnitUpc,
      outer_units: outerUnits,
      expected,
    },
    repair: {
      baseline_surface: surface,
      target_surface: target,
      baseline_images: images,
      target_images: structuredClone(images),
      changed_fields: changedFields,
      unchanged_image_bytes: true,
    },
    owner_gate: {
      exact_confirmation:
        `Owner policy confirms ${truth.snapshot.sku}: change only ${confirmationFields}.`,
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
    next_required_inputs: [
      "ACTIVE_SHARED_PRODUCT_TRUTH_BINDING",
      "FRESH_WALMART_MP_MAINTENANCE_SPEC",
      "FRESH_WALMART_LIVE_ITEM_RECEIPT",
      "FRESH_ONE_SKU_OWNER_PERMIT",
    ],
  };
  const request = seal(requestBody);
  const requestBytes = await writeExclusive(
    path.join(args.outputDir, "compilation-request.json"),
    request,
  );
  process.stdout.write(`${JSON.stringify({
    status: "NON_IMAGE_REPAIR_CANDIDATE_READY",
    listing_key: truth.snapshot.listingKey,
    changed_fields: changedFields,
    compilation_request_file_sha256: sha256(requestBytes),
    compilation_request_body_sha256: request.body_sha256,
    qualification_precheck: "PASS",
    images_unchanged: true,
    walmart_writes: 0,
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
