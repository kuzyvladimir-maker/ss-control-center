#!/usr/bin/env node

/**
 * Build one deterministic description/bullets-only owner-review proposal.
 *
 * Inputs are exact Product Truth and fresh buyer/diagnosis artifacts. The
 * command preserves title, attributes and every image byte. It performs no
 * network, model, database, R2 or Walmart mutation.
 */

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  precheckWalmartListingRepairTargetForReview,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";
import {
  walmartListingIntegritySha256,
  type WalmartListingIntegrityInput,
  type WalmartListingSurface,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import type { ProductTruthSnapshot } from "../src/lib/sourcing/product-truth-read-contract.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Walmart text-review candidate rejected input: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail(`${label} must be an exact non-empty string`);
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
    if (!match || flags.has(match[1]!)) {
      fail(`unsupported or duplicate argument: ${argument}`);
    }
    flags.set(match[1]!, match[2]!);
  }
  const expected = [
    "product-truth",
    "diagnosis",
    "buyer-snapshot",
    "buyer-pdp",
    "content-evidence",
    "output-dir",
  ] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    productTruth: exactPath(flags.get("product-truth"), "--product-truth"),
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
    buyerSnapshot: exactPath(flags.get("buyer-snapshot"), "--buyer-snapshot"),
    buyerPdp: exactPath(flags.get("buyer-pdp"), "--buyer-pdp"),
    contentEvidence: exactPath(flags.get("content-evidence"), "--content-evidence"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

async function readJson<T>(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: T;
}> {
  const bytes = await readFile(pathname);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) {
    fail(`${label} exceeds the byte bound`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
  } catch {
    return fail(`${label} is not JSON`);
  }
}

async function writeExclusive(pathname: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/gu, (letter) => letter.toUpperCase());
}

function numberWord(value: number): string {
  const words: Record<number, string> = {
    1: "one",
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
    11: "eleven",
    12: "twelve",
  };
  return words[value] ?? String(value);
}

function measuredTotal(size: string, quantity: number): string | null {
  const match = /^(\d+(?:\.\d+)?)\s*(fl oz|oz|lb|g|kg|ml|l)$/iu.exec(size.trim());
  if (!match) return null;
  const total = Number(match[1]) * quantity;
  return `${Number.isInteger(total) ? total : total.toFixed(2)} ${match[2]!.toLowerCase()}`;
}

function removeConflictingPackSentences(value: string, outerUnits: number): string {
  const explicit = /\b(?:pack|quantity)\s+of\s+(\d+)\b|\b(\d+)\s+(?:bags?|packs?|packages?)\b/iu;
  return value.split(/(?<=[.!?])\s+/u).filter((sentence) => {
    const match = explicit.exec(sentence);
    if (!match) return true;
    const count = Number(match[1] ?? match[2]);
    return count === outerUnits;
  }).join(" ").trim();
}

function exactStringRows(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1
    || value.some((row) => typeof row !== "string" || !row.trim())) {
    fail(`${label} must be a non-empty exact string array`);
  }
  return [...value] as string[];
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.outputDir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [truthFile, diagnosisFile, snapshotFile, buyerFile, evidenceFile] =
    await Promise.all([
      readJson<ProductTruthSnapshot>(args.productTruth, "Product Truth"),
      readJson<JsonRecord>(args.diagnosis, "diagnosis"),
      readJson<JsonRecord>(args.buyerSnapshot, "buyer snapshot"),
      readJson<JsonRecord>(args.buyerPdp, "buyer PDP"),
      readJson<JsonRecord>(args.contentEvidence, "exact content evidence"),
    ]);
  const truth = truthFile.value;
  const diagnosis = diagnosisFile.value;
  const outcome = record(diagnosis.outcome, "diagnosis.outcome");
  const detector = record(diagnosis.detector_input, "diagnosis.detector_input");
  const report = record(diagnosis.detector_report, "diagnosis.detector_report");
  const listing = record(detector.listing, "diagnosis.detector_input.listing");
  const expected = record(
    detector.expected,
    "diagnosis.detector_input.expected",
  ) as unknown as WalmartListingIntegrityInput["expected"];
  const surface = record(
    detector.surface,
    "diagnosis.detector_input.surface",
  ) as unknown as WalmartListingSurface;
  const components = truth.views?.listingImprovement?.components ?? [];
  if (!truth.views?.listingImprovement?.ready || components.length !== 1
    || truth.snapshot.listingKey !== diagnosis.listing_key
    || truth.snapshot.listingKey !== listing.listing_key
    || !["REVIEW", "BAD"].includes(String(outcome.status))
    || (report.blocking_reasons as unknown[])?.length !== 0) {
    fail("inputs are not one exact source-ready non-clean listing without hard failures");
  }
  const component = components[0]!;
  const content = component.content;
  if (!content || component.contentBlockers.length
    || content.canonicalVariantId !== component.targetCanonicalVariantId
    || !Number.isSafeInteger(component.qty) || component.qty < 2) {
    fail("Product Truth content/count is incomplete");
  }
  const main = record(report.main_decision, "detector_report.main_decision");
  const mainChecks = record(main.checks, "detector_report.main_decision.checks");
  const packageFacts = record(
    mainChecks.package_facts,
    "detector_report.main_decision.checks.package_facts",
  );
  if ((main.hard_failures as unknown[])?.length
    || mainChecks.external_quantity !== "MATCH"
    || mainChecks.single_package_per_cell !== "MATCH"
    || mainChecks.front !== "MATCH"
    || mainChecks.background !== "MATCH"
    || mainChecks.no_mixed_product !== "MATCH"
    || packageFacts.net_content !== "MATCH") {
    fail("current MAIN is not a proven exact quantity/product candidate");
  }
  const gallery = report.gallery_decisions;
  if (!Array.isArray(gallery) || gallery.length < 1 || gallery.some((row) => (
    !row || typeof row !== "object" || Array.isArray(row)
      || ((row as JsonRecord).hard_failures as unknown[])?.length
      || (row as JsonRecord).technical_error
      || (row as JsonRecord).missing_reason
  ))) {
    fail("current gallery has a hard failure or incomplete evidence");
  }
  const product = record(buyerFile.value.product, "buyer PDP.product");
  const snapshot = snapshotFile.value;
  const assets = snapshot.assets;
  if (!Array.isArray(assets) || assets.length < 2
    || snapshot.target === undefined
    || record(snapshot.target, "buyer snapshot.target").sku !== truth.snapshot.sku
    || product.item_id !== listing.item_id
    || product.title !== surface.title) {
    fail("buyer snapshot/PDP differs from the exact listing");
  }
  const evidence = evidenceFile.value;
  const retailerContent = record(evidence.retailerContent, "content evidence.retailerContent");
  if (evidence.donorProductId !== content.provenance.donorProductId
    || retailerContent.finalUrl !== content.provenance.sourceUrl) {
    fail("exact content evidence differs from Product Truth provenance");
  }
  const outerUnits = component.qty;
  const size = component.size;
  const packageForm = content.identity.form.toLowerCase() === "bag" ? "bags" : "packages";
  const total = measuredTotal(size, outerUnits);
  const exactListingTitle = text(surface.title, "live title");
  const productFirstTitle = exactListingTitle
    .replace(/\s*\(Pack of \d+\)\s*$/iu, "")
    .trim();
  const identity = productFirstTitle.split(",").map((part) => part.trim())
    .filter((part) => part
      && part.toLocaleLowerCase("en-US") !== size.toLocaleLowerCase("en-US")
      && part.toLocaleLowerCase("en-US") !== content.identity.form.toLocaleLowerCase("en-US"))
    .join(", ");
  const quantitySentence =
    `${exactListingTitle}. This listing includes ${numberWord(outerUnits)} `
    + `${size} ${packageForm}${total ? `, for ${total} total` : ""}.`;
  const liveDescription = removeConflictingPackSentences(
    text(surface.description, "live description"),
    outerUnits,
  );
  const afterDescription = `${quantitySentence} ${liveDescription}`.replace(/\s+/gu, " ").trim();
  const liveBullets = exactStringRows(surface.bullets, "live bullets");
  const packBullet =
    `PACK OF ${outerUnits}: Includes ${outerUnits} ${packageForm} of ${identity}; `
    + `each ${packageForm === "bags" ? "bag" : "package"} is ${size}`
    + `${total ? `, for ${total} total` : ""}`;
  const afterBullets = [packBullet, ...liveBullets]
    .filter((row, index, rows) => rows.indexOf(row) === index)
    .slice(0, 6);
  const targetSurface: WalmartListingSurface = {
    ...structuredClone(surface),
    description: afterDescription,
    bullets: afterBullets,
  };
  precheckWalmartListingRepairTargetForReview({
    surface: targetSurface,
    expected,
  });
  const normalizedGtin14 = text(
    retailerContent.normalizedGtin14,
    "content evidence normalizedGtin14",
  );
  const singleUnitUpc = normalizedGtin14.replace(/^0+(?=\d{12,13}$)/u, "");
  const servings = Number(
    record(
      (record(retailerContent.nutritionFacts, "nutritionFacts")
        .value_prepared_list as unknown[])[0],
      "nutritionFacts.value_prepared_list[0]",
    ).servings_per_container,
  );
  const innerCount = Number.isSafeInteger(servings) && servings > 0 ? servings : 1;
  const donorAudit = {
    schema_version: "walmart-listing-exact-donor-audit/v1",
    exact_content_candidate: {
      donor_product_id: content.provenance.donorProductId,
      upc: singleUnitUpc,
      size,
      inner_count: innerCount,
    },
    current_legacy_component: {
      donor_product_id: content.provenance.donorProductId,
      finding: "EXACT_PRODUCT_DONOR",
      canonical_use_allowed: true,
    },
    evidence: {
      content_observation_id: content.provenance.contentObservationId,
      content_hash: content.provenance.contentHash,
      source_url: content.provenance.sourceUrl,
      source_file_sha256: sha256(evidenceFile.bytes),
    },
  };
  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const donorAuditPath = path.join(args.outputDir, "donor-audit.json");
  await writeExclusive(donorAuditPath, donorAudit);
  const donorAuditBytes = await readFile(donorAuditPath);
  const imageRows = assets.map((raw, index) => {
    const asset = record(raw, `buyer snapshot.assets[${index}]`);
    return text(asset.sha256, `buyer snapshot.assets[${index}].sha256`);
  });
  const candidate = {
    donor_product_id: content.provenance.donorProductId,
    brand: titleCase(content.identity.brand),
    product: component.product,
    variant: component.flavor,
    single_unit_upc: singleUnitUpc,
    single_unit_size: size,
    single_unit_inner_count: innerCount,
    outer_units: outerUnits,
    expected,
  };
  const proposal = {
    schema_version: "walmart-listing-integrity-owner-repair-review/v1",
    status: "OWNER_REVIEW_REQUIRED",
    authority: {
      mode: "REVIEW_ONLY_NO_WALMART_WRITE",
      authorizes_product_truth_activation: false,
      authorizes_walmart_write: false,
    },
    listing: {
      listing_key: truth.snapshot.listingKey,
      store_index: truth.snapshot.storeIndex,
      sku: truth.snapshot.sku,
      item_id: listing.item_id,
      seller_upc: record(
        (await readJson<JsonRecord>(
          path.join(path.dirname(args.productTruth), "exact-resolution.json"),
          "exact resolution",
        )).value.seller,
        "exact resolution.seller",
      ).upc,
      published_status: listing.published_status,
      lifecycle_status: listing.lifecycle_status,
      title: surface.title,
    },
    exact_product_truth_candidate: candidate,
    fresh_live_evidence: {
      diagnosis_sha256: sha256(diagnosisFile.bytes),
      buyer_snapshot_sha256: sha256(snapshotFile.bytes),
      buyer_pdp_sha256: sha256(buyerFile.bytes),
      donor_audit_sha256: sha256(donorAuditBytes),
      main_image_sha256: imageRows[0],
      gallery_image_sha256: imageRows.slice(1),
    },
    proposed_repair: {
      changed_fields: ["description", "bullets"],
      before: {
        description: surface.description,
        bullets: surface.bullets,
      },
      after: {
        description: afterDescription,
        bullets: afterBullets,
      },
      unchanged_fields: [
        "title",
        "attributes",
        "main",
        "gallery",
        "price",
        "inventory",
        "published_status",
        "lifecycle_status",
        "identifiers",
      ],
      retries: 0,
    },
  };
  const proposalPath = path.join(args.outputDir, "review-proposal.json");
  await writeExclusive(proposalPath, proposal);
  process.stdout.write(`${JSON.stringify({
    status: "TEXT_REVIEW_CANDIDATE_READY",
    listing_key: truth.snapshot.listingKey,
    changed_fields: ["description", "bullets"],
    proposal_path: proposalPath,
    proposal_file_sha256: sha256(await readFile(proposalPath)),
    proposal_body_sha256: walmartListingIntegritySha256(proposal),
    donor_audit_path: donorAuditPath,
    donor_audit_file_sha256: sha256(donorAuditBytes),
    exact_images_unchanged: true,
    qualification_precheck: "PASS",
    safety: {
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    },
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
