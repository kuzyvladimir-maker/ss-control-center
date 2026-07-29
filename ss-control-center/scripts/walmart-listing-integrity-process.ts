#!/usr/bin/env node

/**
 * One-SKU Walmart Listing Integrity process.
 *
 * This first operational command consumes an already captured exact evidence
 * set and performs no network, model, database, or Walmart calls. It turns the
 * evidence into one deterministic queue state:
 * SOURCE_REQUIRED, BAD, REVIEW, or CLEAN_CANDIDATE.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyWalmartSingleDiagnostic,
  diagnoseWalmartSingleListing,
  type WalmartListingSingleProcessOutcome,
} from "../src/lib/walmart/listing-integrity-single-pipeline.ts";
import {
  walmartListingIntegritySha256,
  type WalmartListingSurface,
  type WalmartListingIntegrityInput,
  type SealedWalmartListingIntegrityReport,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import {
  precheckWalmartListingRepairTargetForReview,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";
import type { BlindObservation } from "../src/lib/walmart/catalog-visual-audit.ts";
import type { SealedWalmartBuyerSnapshot } from "../src/lib/walmart/buyer-facing-snapshot.ts";
import type { ProductTruthSnapshot } from "../src/lib/sourcing/product-truth-read-contract.ts";
import {
  captureWalmartListingSingleIntake,
  writeWalmartListingSingleIntake,
  type SealedWalmartListingSingleIntakeIndex,
} from "../src/lib/walmart/listing-integrity-single-intake.ts";
import { preprocessCatalogVisual } from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  buildWalmartListingSingleObserverPlan,
  buildWalmartListingSingleObserverRequest,
  verifyWalmartListingSingleWorkerHealth,
  verifyWalmartListingSingleWorkerResponse,
} from "../src/lib/walmart/listing-integrity-single-observer.ts";
import {
  compileWalmartListingDeclaredConsistency,
  type SealedWalmartListingDeclaredConsistency,
} from "../src/lib/walmart/listing-integrity-declared-consistency.ts";

export const WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA =
  "walmart-listing-single-process-report/v1" as const;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 250 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface WalmartListingSingleProcessArgs {
  command:
    | "doctor"
    | "capture"
    | "inspect"
    | "observe"
    | "diagnose"
    | "review"
    | "prepare-repair";
  sku?: string;
  store_index?: number;
  output_dir?: string;
  intake_dir?: string;
  product_truth?: string;
  buyer_snapshot?: string;
  buyer_pdp?: string;
  buyer_pdp_html?: string;
  observations?: string;
  proposal?: string;
  diagnosis?: string;
  donor_audit?: string;
  certification?: string;
  asset_root?: string;
  output?: string;
}

export interface WalmartListingSingleProcessReportBody {
  schema_version: typeof WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA;
  created_at: string;
  listing_key: string;
  inputs: {
    product_truth_file_sha256: string;
    buyer_snapshot_file_sha256: string;
    buyer_pdp_file_sha256: string;
    observations_file_sha256: string;
    image_assets: Array<{
      slot: string;
      sha256: string;
      bytes: number;
    }>;
  };
  outcome: {
    status:
      | WalmartListingSingleProcessOutcome["status"]
      | "SOURCE_REQUIRED_WITH_CONTRADICTIONS";
    blockers: string[];
    next_step: WalmartListingSingleProcessOutcome["next_step"];
  };
  declared_consistency: SealedWalmartListingDeclaredConsistency;
  detector_input: WalmartListingIntegrityInput | null;
  detector_report: SealedWalmartListingIntegrityReport | null;
  assurance: {
    input_files_read_once: true;
    image_sha256_verified: true;
    walmart_reads: 0;
    walmart_writes: 0;
    database_reads: 0;
    database_writes: 0;
    model_calls: 0;
    network_calls: 0;
  };
}

export interface SealedWalmartListingSingleProcessReport
  extends WalmartListingSingleProcessReportBody {
  body_sha256: string;
}

export interface WalmartListingSingleLiveCaptureSummary {
  schema_version: typeof WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA;
  status:
    | "SOURCE_REQUIRED"
    | "BUYER_CAPTURE_REQUIRED"
    | "CAPTURED"
    | "CAPTURED_SOURCE_REQUIRED";
  listing_key: string;
  blockers: string[];
  execution: {
    product_truth_reads: 1;
    walmart_logical_gets: 0 | 2;
    buyer_pdp_gets: 0 | 1;
    image_gets: number;
    model_calls: 0;
    database_writes: 0;
    walmart_writes: 0;
  };
  directory: string;
  index_path: string;
  index_body_sha256: string;
  next_step:
    | "ENRICH_EXACT_PRODUCT_TRUTH"
    | "CAPTURE_EXACT_BUYER_PDP"
    | "RUN_SIGNED_BLIND_OBSERVER";
}

export interface WalmartListingSingleObservationSummary {
  schema_version: typeof WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA;
  status: "OBSERVED";
  listing_key: string;
  output_dir: string;
  observations_path: string;
  observer_plan_body_sha256: string;
  execution_index_body_sha256: string;
  execution: {
    subscription_calls_consumed: number;
    transport_attempts: number;
    retries: 0;
    fallbacks: 0;
    paid_api_calls: 0;
    database_reads: 0;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
  };
  next_step: "DIAGNOSE";
}

export interface WalmartListingSingleObservationUnknownSummary {
  schema_version: typeof WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA;
  status: "OBSERVATION_UNKNOWN_OUTCOME";
  listing_key: string;
  output_dir: string;
  unknown_outcome_path: string;
  observer_plan_body_sha256: string;
  execution_index_body_sha256: string;
  unknown_call: {
    call_index: number;
    call_key: string;
  };
  execution: {
    subscription_calls_confirmed_consumed: number;
    subscription_calls_unknown: 1;
    transport_attempts: number;
    retries: 0;
    fallbacks: 0;
    paid_api_calls: 0;
    database_reads: 0;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
  };
  next_step: "DO_NOT_RETRY_RECONCILE_EXACT_CALL_KEY";
}

export interface WalmartListingSingleReviewCertification {
  schema_version: "walmart-listing-single-review-certification/v1";
  status: "OWNER_REVIEW_REQUIRED";
  listing_key: string;
  proposal_sha256: string;
  diagnosis_sha256: string;
  buyer_snapshot_sha256: string;
  buyer_pdp_sha256: string;
  donor_audit_sha256: string;
  changed_fields: ["description", "bullets"];
  qualification_precheck: "PASS";
  exact_image_bytes_verified: true;
  marketplace_write_authorized: false;
  database_write_authorized: false;
  assurance: {
    network_calls: 0;
    model_calls: 0;
    database_writes: 0;
    walmart_writes: 0;
  };
  body_sha256: string;
}

export interface WalmartListingSingleRepairCompilationRequest {
  schema_version: "walmart-listing-single-repair-compilation-request/v1";
  created_at: string;
  status: "READY_FOR_CONNECTED_MATERIALS";
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
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
  };
  repair: {
    baseline_surface: WalmartListingSurface;
    target_surface: WalmartListingSurface;
    baseline_images: Array<{
      slot: "main" | `gallery-${number}`;
      source_url: string;
      sha256: string;
    }>;
    target_images: Array<{
      slot: "main" | `gallery-${number}`;
      source_url: string;
      sha256: string;
    }>;
    changed_fields: ["description", "bullets"];
    unchanged_image_bytes: true;
  };
  owner_gate: {
    exact_confirmation: string;
    confirms_only_reviewed_diff: true;
    confirmation_would_authorize_product_truth_activation: true;
    confirmation_would_authorize_one_sku_package_compilation: true;
    current_walmart_write_authorized: false;
    current_mass_run_authorized: false;
  };
  next_required_inputs: [
    "ACTIVE_SHARED_PRODUCT_TRUTH_BINDING",
    "FRESH_WALMART_MP_MAINTENANCE_SPEC",
    "FRESH_WALMART_LIVE_ITEM_RECEIPT",
    "FRESH_ONE_SKU_OWNER_PERMIT",
  ];
  assurance: {
    network_calls: 0;
    model_calls: 0;
    database_reads: 0;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
  };
  body_sha256: string;
}

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function exactPath(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be an explicit non-empty path`);
  }
  return path.resolve(value);
}

export function parseWalmartListingSingleProcessArgs(
  argv: readonly string[],
): WalmartListingSingleProcessArgs {
  const command = argv[0];
  if (command === "doctor") {
    if (argv.length !== 1) throw new Error("doctor accepts no arguments");
    return { command };
  }
  if (command === "capture" || command === "inspect") {
    const flags = new Map<string, string>();
    for (const argument of argv.slice(1)) {
      const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
      if (!match || flags.has(match[1]!)) {
        throw new Error(`unsupported or duplicate argument: ${argument}`);
      }
      flags.set(match[1]!, match[2]!);
    }
    const required = ["sku", "store-index", "output-dir"] as const;
    const allowed = command === "inspect"
      ? new Set<string>([...required, "buyer-pdp-html"])
      : new Set<string>(required);
    if (required.some((key) => !flags.has(key))
      || [...flags.keys()].some((key) => !allowed.has(key))) {
      throw new Error(
        `${command} arguments must include: ${required.map((key) => `--${key}=...`).join(" ")}`
          + (command === "inspect" ? " [--buyer-pdp-html=...]" : ""),
      );
    }
    const sku = flags.get("sku")!;
    if (!sku || sku !== sku.trim() || sku.length > 200 || /[\u0000-\u001f\u007f]/u.test(sku)) {
      throw new Error("--sku must be explicit, trimmed, and contain no control characters");
    }
    const rawStoreIndex = flags.get("store-index")!;
    if (!/^\d+$/u.test(rawStoreIndex)) {
      throw new Error("--store-index must be an integer from 1 to 10");
    }
    const storeIndex = Number(rawStoreIndex);
    if (!Number.isSafeInteger(storeIndex) || storeIndex < 1 || storeIndex > 10) {
      throw new Error("--store-index must be an integer from 1 to 10");
    }
    return {
      command,
      sku,
      store_index: storeIndex,
      output_dir: exactPath(flags.get("output-dir"), "--output-dir"),
      buyer_pdp_html: flags.has("buyer-pdp-html")
        ? exactPath(flags.get("buyer-pdp-html"), "--buyer-pdp-html")
        : undefined,
    };
  }
  if (command === "observe") {
    const flags = new Map<string, string>();
    for (const argument of argv.slice(1)) {
      const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
      if (!match || flags.has(match[1]!)) {
        throw new Error(`unsupported or duplicate argument: ${argument}`);
      }
      flags.set(match[1]!, match[2]!);
    }
    const expected = ["intake-dir", "output-dir"] as const;
    if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
      throw new Error(
        `observe arguments must be exactly: ${expected.map((key) => `--${key}=...`).join(" ")}`,
      );
    }
    return {
      command,
      intake_dir: exactPath(flags.get("intake-dir"), "--intake-dir"),
      output_dir: exactPath(flags.get("output-dir"), "--output-dir"),
    };
  }
  if (command === "review" || command === "prepare-repair") {
    const flags = new Map<string, string>();
    for (const argument of argv.slice(1)) {
      const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
      if (!match || flags.has(match[1]!)) {
        throw new Error(`unsupported or duplicate argument: ${argument}`);
      }
      flags.set(match[1]!, match[2]!);
    }
    const common = [
      "proposal",
      "diagnosis",
      "buyer-snapshot",
      "buyer-pdp",
      "donor-audit",
      "asset-root",
    ] as const;
    const expected = command === "prepare-repair"
      ? [...common, "certification", "output"] as const
      : [...common, "output"] as const;
    if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
      throw new Error(
        `review arguments must be exactly: ${expected.map((key) => `--${key}=...`).join(" ")}`,
      );
    }
    return {
      command,
      proposal: exactPath(flags.get("proposal"), "--proposal"),
      diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
      buyer_snapshot: exactPath(flags.get("buyer-snapshot"), "--buyer-snapshot"),
      buyer_pdp: exactPath(flags.get("buyer-pdp"), "--buyer-pdp"),
      donor_audit: exactPath(flags.get("donor-audit"), "--donor-audit"),
      certification: command === "prepare-repair"
        ? exactPath(flags.get("certification"), "--certification")
        : undefined,
      asset_root: exactPath(flags.get("asset-root"), "--asset-root"),
      output: exactPath(flags.get("output"), "--output"),
    };
  }
  if (command !== "diagnose") {
    throw new Error(
      "first argument must be doctor, capture, inspect, observe, diagnose, review, "
        + "or prepare-repair",
    );
  }
  const flags = new Map<string, string>();
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) {
      throw new Error(`unsupported or duplicate argument: ${argument}`);
    }
    flags.set(match[1]!, match[2]!);
  }
  const expected = [
    "product-truth",
    "buyer-snapshot",
    "buyer-pdp",
    "observations",
    "asset-root",
    "output",
  ] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    throw new Error(
      `diagnose arguments must be exactly: ${expected.map((key) => `--${key}=...`).join(" ")}`,
    );
  }
  return {
    command,
    product_truth: exactPath(flags.get("product-truth"), "--product-truth"),
    buyer_snapshot: exactPath(flags.get("buyer-snapshot"), "--buyer-snapshot"),
    buyer_pdp: exactPath(flags.get("buyer-pdp"), "--buyer-pdp"),
    observations: exactPath(flags.get("observations"), "--observations"),
    asset_root: exactPath(flags.get("asset-root"), "--asset-root"),
    output: exactPath(flags.get("output"), "--output"),
  };
}

async function readJsonOnce<T>(
  pathname: string,
  label: string,
): Promise<{ value: T; file_sha256: string }> {
  const bytes = await readFile(pathname);
  if (bytes.length < 2 || bytes.length > MAX_JSON_BYTES) {
    throw new Error(`${label} size is outside the allowed range`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  record(value, label);
  return {
    value: value as T,
    file_sha256: walmartListingIntegritySha256Bytes(bytes),
  };
}

function resolveAssetPath(assetRoot: string, localPath: string): string {
  if (!localPath || localPath !== localPath.trim() || path.isAbsolute(localPath)) {
    throw new Error("buyer snapshot asset local_path must be a relative path");
  }
  const root = path.resolve(assetRoot);
  const resolved = path.resolve(root, localPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("buyer snapshot asset local_path escapes --asset-root");
  }
  return resolved;
}

function observationsFrom(value: unknown): BlindObservation[] {
  const raw = record(value, "observations");
  if (!Array.isArray(raw.observations)) {
    throw new Error("observations.observations must be an array");
  }
  return raw.observations as BlindObservation[];
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function verifyWalmartListingSingleSeal(value: JsonObject, label: string): void {
  const claimed = requiredText(value.body_sha256, `${label}.body_sha256`);
  if (!/^[a-f0-9]{64}$/u.test(claimed)) {
    throw new Error(`${label}.body_sha256 must be lowercase SHA-256`);
  }
  const body = { ...value };
  delete body.body_sha256;
  if (walmartListingIntegritySha256(body) !== claimed) {
    throw new Error(`${label} body SHA mismatch`);
  }
}

function verifyWalmartBuyerSnapshotSeal(value: JsonObject): void {
  const claimed = requiredText(value.body_sha256, "buyer snapshot.body_sha256");
  const snapshotId = requiredText(value.snapshot_id, "buyer snapshot.snapshot_id");
  if (!/^[a-f0-9]{64}$/u.test(claimed)
    || !snapshotId.endsWith(`-${claimed.slice(0, 12)}`)) {
    throw new Error("buyer snapshot identity/body SHA is invalid");
  }
  const body = { ...value };
  delete body.body_sha256;
  delete body.snapshot_id;
  if (walmartListingIntegritySha256(body) !== claimed) {
    throw new Error("buyer snapshot body SHA mismatch");
  }
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`));
}

function buildWalmartListingReviewSurface(input: {
  diagnosis: JsonObject;
  expected: WalmartListingIntegrityInput["expected"];
  title: string;
  description: unknown;
  bullets: unknown;
}): WalmartListingSurface {
  const detectorInput = record(
    input.diagnosis.detector_input,
    "one-SKU diagnosis.detector_input",
  );
  const detectorExpected = record(
    detectorInput.expected,
    "one-SKU diagnosis.detector_input.expected",
  );
  if (detectorExpected.title !== input.expected.title
    || detectorExpected.outer_units !== input.expected.outer_units) {
    throw new Error(
      "repair review title/count differs from the exact live diagnosis",
    );
  }
  const liveSurface = record(
    detectorInput.surface,
    "one-SKU diagnosis.detector_input.surface",
  );
  if (liveSurface.title !== input.title
    || !Array.isArray(liveSurface.attribute_claims)
    || !Array.isArray(liveSurface.unmapped_attributes)) {
    throw new Error("repair review surface differs from the exact live diagnosis");
  }
  return {
    title: input.title,
    description: requiredText(input.description, "review surface description"),
    bullets: exactStringArray(input.bullets, "review surface bullets"),
    attribute_claims: structuredClone(
      liveSurface.attribute_claims,
    ) as WalmartListingSurface["attribute_claims"],
    unmapped_attributes: structuredClone(
      liveSurface.unmapped_attributes,
    ) as WalmartListingSurface["unmapped_attributes"],
  };
}

async function executeWalmartListingSingleReview(
  args: WalmartListingSingleProcessArgs,
  options: { verify_existing?: boolean } = {},
): Promise<WalmartListingSingleReviewCertification> {
  const proposalPath = exactPath(args.proposal, "--proposal");
  const diagnosisPath = exactPath(args.diagnosis, "--diagnosis");
  const buyerSnapshotPath = exactPath(args.buyer_snapshot, "--buyer-snapshot");
  const buyerPdpPath = exactPath(args.buyer_pdp, "--buyer-pdp");
  const donorAuditPath = exactPath(args.donor_audit, "--donor-audit");
  const assetRoot = exactPath(args.asset_root, "--asset-root");
  const outputPath = exactPath(args.output, "--output");
  if ([
    proposalPath,
    diagnosisPath,
    buyerSnapshotPath,
    buyerPdpPath,
    donorAuditPath,
  ].includes(outputPath)) {
    throw new Error("--output must not overwrite a review input artifact");
  }

  const [proposalFile, diagnosisFile, buyerSnapshotFile, buyerPdpFile, donorAuditFile] =
    await Promise.all([
      readJsonOnce<unknown>(proposalPath, "repair review proposal"),
      readJsonOnce<SealedWalmartListingSingleProcessReport>(
        diagnosisPath,
        "one-SKU diagnosis",
      ),
      readJsonOnce<SealedWalmartBuyerSnapshot>(buyerSnapshotPath, "buyer snapshot"),
      readJsonOnce<unknown>(buyerPdpPath, "buyer PDP payload"),
      readJsonOnce<unknown>(donorAuditPath, "Product Truth donor audit"),
    ]);

  const proposal = record(proposalFile.value, "repair review proposal");
  const diagnosis = record(diagnosisFile.value, "one-SKU diagnosis");
  const buyerSnapshot = record(buyerSnapshotFile.value, "buyer snapshot");
  const buyerPdp = record(buyerPdpFile.value, "buyer PDP payload");
  const donorAudit = record(donorAuditFile.value, "Product Truth donor audit");
  if (proposal.schema_version !== "walmart-listing-integrity-owner-repair-review/v1"
    || proposal.status !== "OWNER_REVIEW_REQUIRED") {
    throw new Error("repair review proposal schema/status is unsupported");
  }
  verifyWalmartListingSingleSeal(diagnosis, "one-SKU diagnosis");
  verifyWalmartBuyerSnapshotSeal(buyerSnapshot);

  const authority = record(proposal.authority, "repair review proposal.authority");
  if (authority.mode !== "REVIEW_ONLY_NO_WALMART_WRITE"
    || authority.authorizes_product_truth_activation !== false
    || authority.authorizes_walmart_write !== false) {
    throw new Error("repair review proposal must not authorize Product Truth or Walmart writes");
  }
  const listing = record(proposal.listing, "repair review proposal.listing");
  const listingKey = requiredText(listing.listing_key, "repair review listing_key");
  const sku = requiredText(listing.sku, "repair review sku");
  const itemId = requiredText(listing.item_id, "repair review item_id");
  const title = requiredText(listing.title, "repair review title");
  if (diagnosis.listing_key !== listingKey) {
    throw new Error("repair review listing differs from the diagnosis");
  }
  const target = record(buyerSnapshot.target, "buyer snapshot.target");
  if (target.sku !== sku || target.item_id !== itemId) {
    throw new Error("repair review listing differs from the exact buyer snapshot");
  }
  const product = record(buyerPdp.product, "buyer PDP product");
  if (product.item_id !== itemId || product.title !== title) {
    throw new Error("repair review listing differs from the exact buyer PDP");
  }

  const fresh = record(proposal.fresh_live_evidence, "fresh_live_evidence");
  const fileBindings = [
    ["diagnosis_sha256", diagnosisFile.file_sha256],
    ["buyer_snapshot_sha256", buyerSnapshotFile.file_sha256],
    ["buyer_pdp_sha256", buyerPdpFile.file_sha256],
    ["donor_audit_sha256", donorAuditFile.file_sha256],
  ] as const;
  for (const [field, actual] of fileBindings) {
    if (fresh[field] !== actual) {
      throw new Error(`fresh_live_evidence.${field} differs from exact file bytes`);
    }
  }

  const assets = Array.isArray(buyerSnapshot.assets) ? buyerSnapshot.assets : [];
  if (assets.length < 2) throw new Error("buyer snapshot must contain MAIN plus gallery");
  let totalAssetBytes = 0;
  for (const [index, rawAsset] of assets.entries()) {
    const asset = record(rawAsset, `buyer snapshot assets[${index}]`);
    const localPath = requiredText(asset.local_path, `buyer snapshot assets[${index}].local_path`);
    const bytes = await readFile(resolveAssetPath(assetRoot, localPath));
    totalAssetBytes += bytes.length;
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES
      || totalAssetBytes > MAX_TOTAL_ASSET_BYTES
      || asset.bytes !== bytes.length
      || asset.sha256 !== walmartListingIntegritySha256Bytes(bytes)) {
      throw new Error(`buyer snapshot assets[${index}] exact bytes differ`);
    }
  }
  const mainSha = requiredText(
    record(assets[0], "buyer snapshot MAIN").sha256,
    "buyer snapshot MAIN.sha256",
  );
  const gallerySha = assets.slice(1).map((asset, index) => requiredText(
    record(asset, `buyer snapshot gallery[${index}]`).sha256,
    `buyer snapshot gallery[${index}].sha256`,
  ));
  if (fresh.main_image_sha256 !== mainSha
    || walmartListingIntegritySha256(fresh.gallery_image_sha256)
      !== walmartListingIntegritySha256(gallerySha)) {
    throw new Error("repair review image bindings differ from exact buyer snapshot");
  }

  const candidate = record(
    proposal.exact_product_truth_candidate,
    "exact_product_truth_candidate",
  );
  const donorCandidate = record(
    donorAudit.exact_content_candidate,
    "donor audit exact_content_candidate",
  );
  const candidateBindings = [
    ["donor_product_id", "donor_product_id"],
    ["single_unit_upc", "upc"],
    ["single_unit_size", "size"],
    ["single_unit_inner_count", "inner_count"],
  ] as const;
  for (const [proposalField, donorField] of candidateBindings) {
    if (candidate[proposalField] !== donorCandidate[donorField]) {
      throw new Error(`Product Truth candidate ${proposalField} differs from donor audit`);
    }
  }
  const legacy = record(donorAudit.current_legacy_component, "current_legacy_component");
  if (candidate.legacy_wrong_donor_forbidden === undefined) {
    if (candidate.donor_product_id !== legacy.donor_product_id
      || legacy.finding !== "EXACT_PRODUCT_DONOR"
      || legacy.canonical_use_allowed !== true) {
      throw new Error("active exact Product Truth donor is not independently proven");
    }
  } else {
    const wrongDonor = record(
      candidate.legacy_wrong_donor_forbidden,
      "legacy_wrong_donor_forbidden",
    );
    if (wrongDonor.donor_product_id !== legacy.donor_product_id
      || legacy.finding !== "WRONG_PRODUCT_DONOR"
      || legacy.canonical_use_allowed !== false) {
      throw new Error("legacy wrong-product donor is not proven forbidden");
    }
  }

  const repair = record(proposal.proposed_repair, "proposed_repair");
  if (walmartListingIntegritySha256(repair.changed_fields)
      !== walmartListingIntegritySha256(["description", "bullets"])) {
    throw new Error("review command permits exactly description and bullets");
  }
  const before = record(repair.before, "proposed_repair.before");
  const after = record(repair.after, "proposed_repair.after");
  const liveDescription = requiredText(product.description, "buyer PDP description");
  const liveBullets = exactStringArray(product.feature_bullets, "buyer PDP feature_bullets");
  if (before.description !== liveDescription
    || walmartListingIntegritySha256(before.bullets)
      !== walmartListingIntegritySha256(liveBullets)) {
    throw new Error("repair review before-text differs from the fresh buyer PDP");
  }

  const expected = record(
    candidate.expected,
    "exact_product_truth_candidate.expected",
  ) as unknown as WalmartListingIntegrityInput["expected"];
  if (expected.title !== title
    || expected.outer_units !== requiredPositiveInteger(candidate.outer_units, "outer_units")) {
    throw new Error("Product Truth expected title/count differs from the review listing");
  }
  const targetSurface = buildWalmartListingReviewSurface({
    diagnosis,
    expected,
    title,
    description: after.description,
    bullets: after.bullets,
  });
  precheckWalmartListingRepairTargetForReview({
    surface: targetSurface,
    expected,
  });

  const body = {
    schema_version: "walmart-listing-single-review-certification/v1" as const,
    status: "OWNER_REVIEW_REQUIRED" as const,
    listing_key: listingKey,
    proposal_sha256: proposalFile.file_sha256,
    diagnosis_sha256: diagnosisFile.file_sha256,
    buyer_snapshot_sha256: buyerSnapshotFile.file_sha256,
    buyer_pdp_sha256: buyerPdpFile.file_sha256,
    donor_audit_sha256: donorAuditFile.file_sha256,
    changed_fields: ["description", "bullets"] as ["description", "bullets"],
    qualification_precheck: "PASS" as const,
    exact_image_bytes_verified: true as const,
    marketplace_write_authorized: false as const,
    database_write_authorized: false as const,
    assurance: {
      network_calls: 0 as const,
      model_calls: 0 as const,
      database_writes: 0 as const,
      walmart_writes: 0 as const,
    },
  };
  const certification: WalmartListingSingleReviewCertification = {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
  if (options.verify_existing) {
    const existing = await readJsonOnce<WalmartListingSingleReviewCertification>(
      outputPath,
      "existing review certification",
    );
    if (walmartListingIntegritySha256(existing.value)
      !== walmartListingIntegritySha256(certification)) {
      throw new Error("existing review certification differs from rebuilt exact review");
    }
  } else {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(certification, null, 2)}\n`, {
      flag: "wx",
      mode: 0o400,
    });
  }
  return certification;
}

async function executeWalmartListingSingleRepairPreparation(
  args: WalmartListingSingleProcessArgs,
): Promise<WalmartListingSingleRepairCompilationRequest> {
  const certificationPath = exactPath(args.certification, "--certification");
  const outputPath = exactPath(args.output, "--output");
  const inputPaths = [
    exactPath(args.proposal, "--proposal"),
    exactPath(args.diagnosis, "--diagnosis"),
    exactPath(args.buyer_snapshot, "--buyer-snapshot"),
    exactPath(args.buyer_pdp, "--buyer-pdp"),
    exactPath(args.donor_audit, "--donor-audit"),
    certificationPath,
  ];
  if (inputPaths.includes(outputPath)) {
    throw new Error("--output must not overwrite a repair preparation input");
  }

  const certification = await executeWalmartListingSingleReview({
    ...args,
    command: "review",
    output: certificationPath,
  }, { verify_existing: true });
  const [
    proposalFile,
    diagnosisFile,
    buyerSnapshotFile,
    buyerPdpFile,
    donorAuditFile,
    certificationFile,
  ] = await Promise.all([
    readJsonOnce<unknown>(inputPaths[0]!, "repair review proposal"),
    readJsonOnce<SealedWalmartListingSingleProcessReport>(
      inputPaths[1]!,
      "one-SKU diagnosis",
    ),
    readJsonOnce<SealedWalmartBuyerSnapshot>(
      inputPaths[2]!,
      "buyer snapshot",
    ),
    readJsonOnce<unknown>(inputPaths[3]!, "buyer PDP payload"),
    readJsonOnce<unknown>(inputPaths[4]!, "Product Truth donor audit"),
    readJsonOnce<WalmartListingSingleReviewCertification>(
      certificationPath,
      "review certification",
    ),
  ]);
  if (certificationFile.value.body_sha256 !== certification.body_sha256
    || certificationFile.file_sha256
      !== walmartListingIntegritySha256Bytes(await readFile(certificationPath))) {
    throw new Error("review certification changed during repair preparation");
  }

  const proposal = record(proposalFile.value, "repair review proposal");
  const listing = record(proposal.listing, "repair review proposal.listing");
  const candidate = record(
    proposal.exact_product_truth_candidate,
    "exact_product_truth_candidate",
  );
  const expected = record(
    candidate.expected,
    "exact_product_truth_candidate.expected",
  ) as unknown as WalmartListingIntegrityInput["expected"];
  const repair = record(proposal.proposed_repair, "proposed_repair");
  const before = record(repair.before, "proposed_repair.before");
  const after = record(repair.after, "proposed_repair.after");
  const title = requiredText(listing.title, "repair review title");
  const baselineSurface = buildWalmartListingReviewSurface({
    diagnosis: diagnosisFile.value as unknown as JsonObject,
    expected,
    title,
    description: before.description,
    bullets: before.bullets,
  });
  const targetSurface = buildWalmartListingReviewSurface({
    diagnosis: diagnosisFile.value as unknown as JsonObject,
    expected,
    title,
    description: after.description,
    bullets: after.bullets,
  });
  precheckWalmartListingRepairTargetForReview({
    surface: targetSurface,
    expected,
  });
  if (walmartListingIntegritySha256({
    ...baselineSurface,
    description: targetSurface.description,
    bullets: targetSurface.bullets,
  }) !== walmartListingIntegritySha256(targetSurface)) {
    throw new Error("repair preparation changes fields outside description and bullets");
  }

  const buyerSnapshot = record(buyerSnapshotFile.value, "buyer snapshot");
  const rawAssets = Array.isArray(buyerSnapshot.assets) ? buyerSnapshot.assets : [];
  if (rawAssets.length < 2) {
    throw new Error("repair preparation requires exact MAIN plus complete gallery");
  }
  const images = rawAssets.map((rawAsset, index) => {
    const asset = record(rawAsset, `buyer snapshot assets[${index}]`);
    const slot = index === 0 ? "main" as const : `gallery-${index}` as const;
    return {
      slot,
      source_url: requiredText(
        asset.source_url,
        `buyer snapshot assets[${index}].source_url`,
      ),
      sha256: requiredText(
        asset.sha256,
        `buyer snapshot assets[${index}].sha256`,
      ),
    };
  });
  const listingKey = requiredText(listing.listing_key, "repair review listing_key");
  const storeIndexFromKey = Number(listingKey.split(":")[1]);
  const storeIndex = listing.store_index === undefined
    ? storeIndexFromKey
    : requiredPositiveInteger(listing.store_index, "repair review store_index");
  if (!Number.isSafeInteger(storeIndex) || storeIndex < 1
    || listingKey !== `walmart:${storeIndex}:${requiredText(listing.sku, "repair review sku")}`) {
    throw new Error("repair review listing key/store/SKU are inconsistent");
  }

  const proposalCanonicalSha = walmartListingIntegritySha256(proposal);
  const proposalDisplaySha =
    `${proposalFile.file_sha256.slice(0, 8)}…${proposalFile.file_sha256.slice(-5)}`;
  const body = {
    schema_version: "walmart-listing-single-repair-compilation-request/v1" as const,
    created_at: new Date().toISOString(),
    status: "READY_FOR_CONNECTED_MATERIALS" as const,
    listing: {
      channel: "WALMART_US" as const,
      store_index: storeIndex,
      sku: requiredText(listing.sku, "repair review sku"),
      listing_key: listingKey,
      item_id: requiredText(listing.item_id, "repair review item_id"),
      seller_upc: requiredText(listing.seller_upc, "repair review seller_upc"),
      captured_at: requiredText(buyerSnapshot.captured_at, "buyer snapshot captured_at"),
      published_status: "PUBLISHED" as const,
      lifecycle_status: "ACTIVE" as const,
      composition: "same_product" as const,
    },
    frozen_review: {
      proposal_file_sha256: proposalFile.file_sha256,
      proposal_body_sha256: proposalCanonicalSha,
      certification_file_sha256: certificationFile.file_sha256,
      certification_body_sha256: certification.body_sha256,
      diagnosis_file_sha256: diagnosisFile.file_sha256,
      buyer_snapshot_file_sha256: buyerSnapshotFile.file_sha256,
      buyer_pdp_file_sha256: buyerPdpFile.file_sha256,
      donor_audit_file_sha256: donorAuditFile.file_sha256,
    },
    product_truth_candidate: {
      candidate_sha256: walmartListingIntegritySha256(candidate),
      expected_sha256: walmartListingIntegritySha256(expected),
      donor_product_id: requiredText(
        candidate.donor_product_id,
        "Product Truth donor_product_id",
      ),
      single_unit_upc: requiredText(
        candidate.single_unit_upc,
        "Product Truth single_unit_upc",
      ),
      outer_units: requiredPositiveInteger(candidate.outer_units, "outer_units"),
    },
    repair: {
      baseline_surface: baselineSurface,
      target_surface: targetSurface,
      baseline_images: images,
      target_images: structuredClone(images),
      changed_fields: ["description", "bullets"] as ["description", "bullets"],
      unchanged_image_bytes: true as const,
    },
    owner_gate: {
      exact_confirmation:
        `Подтверждаю ${requiredText(listing.sku, "repair review sku")} и diff `
          + `${proposalDisplaySha}. Изменить только description и bullets.`,
      confirms_only_reviewed_diff: true as const,
      confirmation_would_authorize_product_truth_activation: true as const,
      confirmation_would_authorize_one_sku_package_compilation: true as const,
      current_walmart_write_authorized: false as const,
      current_mass_run_authorized: false as const,
    },
    next_required_inputs: [
      "ACTIVE_SHARED_PRODUCT_TRUTH_BINDING",
      "FRESH_WALMART_MP_MAINTENANCE_SPEC",
      "FRESH_WALMART_LIVE_ITEM_RECEIPT",
      "FRESH_ONE_SKU_OWNER_PERMIT",
    ] as WalmartListingSingleRepairCompilationRequest["next_required_inputs"],
    assurance: {
      network_calls: 0 as const,
      model_calls: 0 as const,
      database_reads: 0 as const,
      database_writes: 0 as const,
      walmart_reads: 0 as const,
      walmart_writes: 0 as const,
    },
  };
  const request: WalmartListingSingleRepairCompilationRequest = {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(request, null, 2)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  return request;
}

export async function executeWalmartListingSingleProcess(
  args: WalmartListingSingleProcessArgs,
): Promise<SealedWalmartListingSingleProcessReport | {
  schema_version: typeof WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA;
  status: "READY";
  capabilities: string[];
  prohibited_side_effects: string[];
} | WalmartListingSingleLiveCaptureSummary
  | WalmartListingSingleObservationSummary
  | WalmartListingSingleObservationUnknownSummary
  | WalmartListingSingleReviewCertification
  | WalmartListingSingleRepairCompilationRequest> {
  if (args.command === "doctor") {
    return {
      schema_version: WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA,
      status: "READY",
      capabilities: [
        "fresh read-only exact-SKU intake",
        "source-blocked live self-consistency intake",
        "bounded signed blind observation",
        "exact Product Truth projection",
        "exact buyer snapshot and image-byte verification",
        "full title, description, bullet, attribute, MAIN, and gallery diagnosis",
        "SOURCE_REQUIRED/BAD/REVIEW/CLEAN_CANDIDATE classification",
        "source-backed proposal verification and Qualification precheck",
        "SHA-sealed owner repair compilation request with unchanged-image binding",
      ],
      prohibited_side_effects: [
        "network",
        "model",
        "database write",
        "Walmart write",
      ],
    };
  }
  if (args.command === "capture") {
    return executeLiveWalmartListingSingleCapture(args);
  }
  if (args.command === "inspect") {
    return executeLiveWalmartListingSingleCapture(args, true);
  }
  if (args.command === "observe") {
    return executeLiveWalmartListingSingleObservation(args);
  }
  if (args.command === "review") {
    return executeWalmartListingSingleReview(args);
  }
  if (args.command === "prepare-repair") {
    return executeWalmartListingSingleRepairPreparation(args);
  }

  const productTruthPath = exactPath(args.product_truth, "--product-truth");
  const buyerSnapshotPath = exactPath(args.buyer_snapshot, "--buyer-snapshot");
  const buyerPdpPath = exactPath(args.buyer_pdp, "--buyer-pdp");
  const observationsPath = exactPath(args.observations, "--observations");
  const assetRoot = exactPath(args.asset_root, "--asset-root");
  const outputPath = exactPath(args.output, "--output");
  const inputPaths = [
    productTruthPath,
    buyerSnapshotPath,
    buyerPdpPath,
    observationsPath,
  ];
  if (inputPaths.includes(outputPath)) {
    throw new Error("--output must not overwrite an input artifact");
  }

  const [productTruth, buyerSnapshot, buyerPdp, observations] = await Promise.all([
    readJsonOnce<ProductTruthSnapshot>(productTruthPath, "Product Truth snapshot"),
    readJsonOnce<SealedWalmartBuyerSnapshot>(buyerSnapshotPath, "buyer snapshot"),
    readJsonOnce<unknown>(buyerPdpPath, "buyer PDP payload"),
    readJsonOnce<unknown>(observationsPath, "blind observations"),
  ]);

  const imageBytes = new Map<string, Uint8Array>();
  let totalAssetBytes = 0;
  for (const asset of buyerSnapshot.value.assets ?? []) {
    const bytes = await readFile(resolveAssetPath(assetRoot, asset.local_path));
    totalAssetBytes += bytes.length;
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES
      || totalAssetBytes > MAX_TOTAL_ASSET_BYTES
      || bytes.length !== asset.bytes
      || walmartListingIntegritySha256Bytes(bytes) !== asset.sha256) {
      throw new Error(`${asset.slot}: image bytes exceed the allowed bounds`);
    }
    imageBytes.set(asset.sha256, new Uint8Array(bytes));
  }

  const blindObservations = observationsFrom(observations.value);
  const declaredConsistency = compileWalmartListingDeclaredConsistency({
    listing_key: productTruth.value.snapshot.listingKey,
    buyer_snapshot: buyerSnapshot.value,
    buyer_pdp_payload: buyerPdp.value,
    blind_observations: blindObservations,
  });
  const diagnostic = await diagnoseWalmartSingleListing({
    product_truth: productTruth.value,
    buyer_snapshot: buyerSnapshot.value,
    buyer_pdp_payload: buyerPdp.value,
    image_bytes_by_sha256: imageBytes,
    blind_observations: blindObservations,
  });
  const outcome = classifyWalmartSingleDiagnostic(diagnostic);
  const outcomeStatus = outcome.status === "SOURCE_REQUIRED"
      && declaredConsistency.verdict === "CONTRADICTION"
    ? "SOURCE_REQUIRED_WITH_CONTRADICTIONS"
    : outcome.status;
  const declaredBlockers = outcome.status === "SOURCE_REQUIRED"
    ? declaredConsistency.findings.map((finding) =>
      `DECLARED_${finding.severity}:${finding.code}${finding.slot ? `:${finding.slot}` : ""}`
    )
    : [];
  const body: WalmartListingSingleProcessReportBody = {
    schema_version: WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA,
    created_at: new Date().toISOString(),
    listing_key: productTruth.value.snapshot.listingKey,
    inputs: {
      product_truth_file_sha256: productTruth.file_sha256,
      buyer_snapshot_file_sha256: buyerSnapshot.file_sha256,
      buyer_pdp_file_sha256: buyerPdp.file_sha256,
      observations_file_sha256: observations.file_sha256,
      image_assets: (buyerSnapshot.value.assets ?? []).map((asset) => ({
        slot: asset.slot,
        sha256: asset.sha256,
        bytes: asset.bytes,
      })),
    },
    outcome: {
      status: outcomeStatus,
      blockers: [...outcome.blockers, ...declaredBlockers],
      next_step: outcome.next_step,
    },
    declared_consistency: declaredConsistency,
    detector_input: diagnostic.detector_input,
    detector_report: diagnostic.report,
    assurance: {
      input_files_read_once: true,
      image_sha256_verified: true,
      walmart_reads: 0,
      walmart_writes: 0,
      database_reads: 0,
      database_writes: 0,
      model_calls: 0,
      network_calls: 0,
    },
  };
  const report = {
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  return report;
}

function cleanEnvironment(value: string | undefined): string | null {
  const cleaned = String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
  return cleaned || null;
}

async function boundedGet(
  url: string,
  maximumBytes: number,
  accept: string,
): Promise<{ bytes: Uint8Array; status: number; final_url: string; content_type: string | null }> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
    headers: {
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; SSCommandCenter-ListingIntegrity/1.0)",
    },
  });
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error(`GET ${url} Content-Length exceeds ${maximumBytes} bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || !bytes.length || bytes.length > maximumBytes) {
    throw new Error(`GET ${url} failed or exceeded bounds (HTTP ${response.status})`);
  }
  return {
    bytes,
    status: response.status,
    final_url: response.url,
    content_type: response.headers.get("content-type"),
  };
}

async function executeLiveWalmartListingSingleCapture(
  args: WalmartListingSingleProcessArgs,
  continueWhenSourceRequired = false,
): Promise<WalmartListingSingleLiveCaptureSummary> {
  const sku = args.sku!;
  const storeIndex = args.store_index!;
  const outputDir = exactPath(args.output_dir, "--output-dir");
  const importedBuyerHtmlPath = args.buyer_pdp_html
    ? exactPath(args.buyer_pdp_html, "--buyer-pdp-html")
    : null;
  let importedBuyerHtml: string | null = null;
  if (importedBuyerHtmlPath) {
    const bytes = await readFile(importedBuyerHtmlPath);
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
      throw new Error("--buyer-pdp-html must be a non-empty HTML file up to 5 MiB");
    }
    importedBuyerHtml = bytes.toString("utf8");
  }
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
  const databaseUrl = cleanEnvironment(process.env.TURSO_DATABASE_URL)
    ?? cleanEnvironment(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("TURSO_DATABASE_URL or DATABASE_URL is required for Product Truth read");
  }
  const authToken = cleanEnvironment(process.env.TURSO_AUTH_TOKEN) ?? undefined;
  if (databaseUrl.startsWith("libsql://") && !authToken) {
    throw new Error("TURSO_AUTH_TOKEN is required for remote Product Truth read");
  }
  const [{ createClient }, { readProductTruthSnapshot }, { getWalmartClient }] =
    await Promise.all([
      import("@libsql/client"),
      import("../src/lib/sourcing/product-truth-read-contract.ts"),
      import("../src/lib/walmart/client.ts"),
    ]);
  const db = createClient({ url: databaseUrl, authToken });
  const client = getWalmartClient(storeIndex);
  const capturedAt = new Date();
  try {
    const intake = await captureWalmartListingSingleIntake({
      sku,
      store_index: storeIndex,
    }, {
      async readProductTruth() {
        return readProductTruthSnapshot(db, {
          sku,
          channel: "walmart",
          storeIndex,
          asOf: capturedAt,
          maxPriceAgeMs: 30 * 24 * 60 * 60 * 1_000,
        });
      },
      async getExactSellerItem(exactSku) {
        const response = await client.requestRaw(
          "GET",
          `/items/${encodeURIComponent(exactSku)}`,
          { noRetryOn429: true },
        );
        if (!response.ok) {
          throw new Error(`${exactSku}: exact seller GET failed with HTTP ${response.status}`);
        }
        return response.body;
      },
      async getCatalogSearchByUpc(upc) {
        const response = await client.requestRaw(
          "GET",
          "/items/walmart/search",
          { params: { upc }, noRetryOn429: true },
        );
        if (!response.ok) {
          throw new Error(`${sku}: exact catalog GET failed with HTTP ${response.status}`);
        }
        return response.body;
      },
      async getBuyerPdpHtml(itemId) {
        if (importedBuyerHtml !== null) return importedBuyerHtml;
        const response = await boundedGet(
          `https://www.walmart.com/ip/${encodeURIComponent(itemId)}`,
          5 * 1024 * 1024,
          "text/html,application/xhtml+xml",
        );
        return Buffer.from(response.bytes).toString("utf8");
      },
      async getImage(url) {
        const response = await boundedGet(url, 15 * 1024 * 1024, "image/*");
        return response;
      },
    }, capturedAt, {
      continue_when_source_required: continueWhenSourceRequired,
      buyer_pdp_gets: importedBuyerHtml === null ? 1 : 0,
    });
    const written = await writeWalmartListingSingleIntake(outputDir, intake);
    return {
      schema_version: WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA,
      status: intake.status,
      listing_key: intake.product_truth.snapshot.listingKey,
      blockers: intake.truth.status === "SOURCE_REQUIRED" ? intake.truth.blockers : [],
      execution: intake.execution,
      directory: written.directory,
      index_path: written.index_path,
      index_body_sha256: written.index.body_sha256,
      next_step: intake.status === "SOURCE_REQUIRED"
        ? "ENRICH_EXACT_PRODUCT_TRUTH"
        : intake.status === "BUYER_CAPTURE_REQUIRED"
          ? "CAPTURE_EXACT_BUYER_PDP"
          : "RUN_SIGNED_BLIND_OBSERVER",
    };
  } finally {
    db.close();
  }
}

const WORKER_RESPONSE_MAX_BYTES = 3_000_000;
const SSH_WORKER_HOST = "openclaw";
const SSH_WORKER_HELPER = "/root/codex-image-worker/post-local-request.js";

export interface WorkerJsonResponse {
  status: number;
  bytes: Buffer;
  value: unknown;
  sha256: string;
}

export interface WalmartListingSingleWorkerConnection {
  health(): Promise<WorkerJsonResponse>;
  analyze(body: string, timeoutMs: number): Promise<WorkerJsonResponse>;
}

async function fetchWorkerJson(
  url: URL,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<WorkerJsonResponse> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > WORKER_RESPONSE_MAX_BYTES) {
    throw new Error("worker response is empty or exceeds the response bound");
  }
  return {
    status: response.status,
    bytes,
    value: JSON.parse(bytes.toString("utf8")),
    sha256: walmartListingIntegritySha256Bytes(bytes),
  };
}

export async function sshWorkerJson(
  action: "health" | "analyze",
  body: string,
  timeoutMs: number,
): Promise<WorkerJsonResponse> {
  const child = spawn(
    "ssh",
    [SSH_WORKER_HOST, "node", SSH_WORKER_HELPER, action],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= WORKER_RESPONSE_MAX_BYTES * 2) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 20_000) stderr.push(chunk);
  });
  child.stdin.end(action === "analyze" ? body : "");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SSH worker ${action} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (exitCode !== 0 || stdoutBytes > WORKER_RESPONSE_MAX_BYTES * 2) {
    throw new Error(
      `SSH worker ${action} failed: ${Buffer.concat(stderr).toString("utf8").slice(-1500)}`,
    );
  }
  const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
    status?: unknown;
    body_base64?: unknown;
  };
  if (!Number.isSafeInteger(envelope.status) || typeof envelope.body_base64 !== "string") {
    throw new Error("SSH worker response envelope is invalid");
  }
  const bytes = Buffer.from(envelope.body_base64, "base64");
  if (!bytes.length || bytes.length > WORKER_RESPONSE_MAX_BYTES
    || bytes.toString("base64") !== envelope.body_base64) {
    throw new Error("SSH worker response bytes are invalid");
  }
  return {
    status: Number(envelope.status),
    bytes,
    value: JSON.parse(bytes.toString("utf8")),
    sha256: walmartListingIntegritySha256Bytes(bytes),
  };
}

async function workerConnection() {
  const useSsh = process.env.WALMART_LISTING_TRIAGE_TRANSPORT === "ssh-openclaw";
  if (useSsh) {
    return {
      health: () => sshWorkerJson("health", "", 30_000),
      analyze: (body: string, timeoutMs: number) => (
        sshWorkerJson("analyze", body, timeoutMs)
      ),
    };
  }
  const rawUrl = cleanEnvironment(process.env.CODEX_IMAGE_WORKER_URL);
  const token = cleanEnvironment(process.env.CODEX_IMAGE_WORKER_TOKEN);
  if (!rawUrl || !token) {
    throw new Error(
      "CODEX_IMAGE_WORKER_URL and CODEX_IMAGE_WORKER_TOKEN are required for observe",
    );
  }
  const analyzeUrl = new URL(rawUrl);
  const loopback = analyzeUrl.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(analyzeUrl.hostname);
  if ((analyzeUrl.protocol !== "https:" && !loopback)
    || !analyzeUrl.pathname.endsWith("/analyze-claude")
    || analyzeUrl.username
    || analyzeUrl.password
    || analyzeUrl.search
    || analyzeUrl.hash) {
    throw new Error("CODEX_IMAGE_WORKER_URL is not a trusted analyze-claude endpoint");
  }
  const healthUrl = new URL(analyzeUrl.toString());
  healthUrl.pathname = healthUrl.pathname.replace(/\/analyze-claude$/u, "/health");
  const headers = { authorization: `Bearer ${token}` };
  return {
    health: () => fetchWorkerJson(
      healthUrl,
      { method: "GET", headers },
      30_000,
    ),
    analyze: (body: string, timeoutMs: number) => fetchWorkerJson(
      analyzeUrl,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      },
      timeoutMs,
    ),
  };
}

function safeEvidencePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).some((part) => !part || part === "..")) {
    throw new Error("evidence path is not a safe relative path");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("evidence path escapes its root");
  }
  return resolved;
}

async function writeObserverArtifact(pathname: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function executeLiveWalmartListingSingleObservation(
  args: WalmartListingSingleProcessArgs,
  injected: {
    connection?: WalmartListingSingleWorkerConnection;
    trust?: { key_id: string; public_key_spki_sha256: string };
  } = {},
): Promise<
  WalmartListingSingleObservationSummary
  | WalmartListingSingleObservationUnknownSummary
> {
  const intakeDir = exactPath(args.intake_dir, "--intake-dir");
  const outputDir = exactPath(args.output_dir, "--output-dir");
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
  const indexPath = path.join(intakeDir, "intake-index.json");
  const indexBytes = await readFile(indexPath);
  const indexFileSha = walmartListingIntegritySha256Bytes(indexBytes);
  const index = JSON.parse(
    indexBytes.toString("utf8"),
  ) as SealedWalmartListingSingleIntakeIndex;
  const { body_sha256: indexBodySha, ...indexBody } = index;
  if (!["CAPTURED", "CAPTURED_SOURCE_REQUIRED"].includes(index.status)
    || indexBodySha !== walmartListingIntegritySha256(indexBody)
    || !index.buyer_snapshot_id
    || !index.buyer_snapshot_body_sha256) {
    throw new Error("observe requires an exact sealed CAPTURED intake index");
  }
  const fileByRole = new Map(index.files.map((file) => [file.role, file]));
  const snapshotRef = fileByRole.get("buyer_snapshot_manifest");
  if (!snapshotRef) throw new Error("intake index has no buyer snapshot manifest");
  for (const file of index.files) {
    const pathname = safeEvidencePath(intakeDir, file.path);
    const bytes = await readFile(pathname);
    if (bytes.length !== file.bytes
      || walmartListingIntegritySha256Bytes(bytes) !== file.file_sha256) {
      throw new Error(`${file.role}: intake evidence bytes changed`);
    }
  }
  const snapshot = JSON.parse(
    (await readFile(safeEvidencePath(intakeDir, snapshotRef.path))).toString("utf8"),
  ) as SealedWalmartBuyerSnapshot;
  if (snapshot.body_sha256 !== index.buyer_snapshot_body_sha256
    || snapshot.snapshot_id !== index.buyer_snapshot_id
    || snapshot.target.sku !== index.listing_key.split(":").slice(2).join(":")) {
    throw new Error("buyer snapshot identity differs from the intake index");
  }
  try {
    await lstat(outputDir);
    throw new Error("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  /*
   * Remote health is a pre-call prerequisite, not part of an execution
   * directory. A connection/auth/contract failure must leave no partial output
   * that looks resumable or consumes a new execution identity.
   */
  const connection = injected.connection ?? await workerConnection();
  const health = await connection.health();
  if (health.status !== 200) {
    throw new Error(`authenticated worker health returned HTTP ${health.status}`);
  }
  verifyWalmartListingSingleWorkerHealth(
    health.value,
    WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
    injected.trust,
  );
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const modelRoot = path.join(outputDir, "model-assets");
  await mkdir(modelRoot, { recursive: false, mode: 0o700 });
  const prepared = [];
  const modelBytesByPath = new Map<string, Buffer>();
  for (const [assetIndex, asset] of snapshot.assets.entries()) {
    const slot = assetIndex === 0 ? "main" as const : `gallery-${assetIndex}` as const;
    const relativeSource = path.join(path.dirname(snapshotRef.path), asset.local_path);
    const sourceBytes = await readFile(safeEvidencePath(intakeDir, relativeSource));
    if (sourceBytes.length !== asset.bytes
      || walmartListingIntegritySha256Bytes(sourceBytes) !== asset.sha256) {
      throw new Error(`${asset.slot}: buyer image changed before observation`);
    }
    const preprocessed = await preprocessCatalogVisual(sourceBytes, {
      full_max_edge: 1600,
      crop_max_edge: 1800,
      analysis_max_edge: 512,
      max_crop_upscale: 2,
      limit_input_pixels: 40_000_000,
    });
    const full = preprocessed.views.find((view) => view.role === "full");
    if (!full || full.media_type !== "image/jpeg") {
      throw new Error(`${asset.slot}: deterministic full JPEG view is missing`);
    }
    const relativeModel = `model-assets/${String(assetIndex).padStart(2, "0")}-${asset.sha256.slice(0, 16)}.jpeg`;
    await writeObserverArtifact(path.join(outputDir, relativeModel), full.bytes);
    modelBytesByPath.set(relativeModel, Buffer.from(full.bytes));
    prepared.push({
      slot,
      source_asset_sha256: asset.sha256,
      model_asset: {
        path: relativeModel,
        sha256: full.sha256,
        bytes: full.bytes.length,
        media_type: "image/jpeg" as const,
        width: full.width,
        height: full.height,
      },
    });
  }
  const plan = buildWalmartListingSingleObserverPlan({
    created_at: new Date().toISOString(),
    listing_key: index.listing_key,
    item_id: snapshot.target.item_id,
    intake_index_file_sha256: indexFileSha,
    intake_index_body_sha256: index.body_sha256,
    prepared_assets: prepared,
  });
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeObserverArtifact(path.join(outputDir, "observer-plan.json"), planBytes);
  // Rebind the already verified health bytes to the exact plan contract.
  verifyWalmartListingSingleWorkerHealth(
    health.value,
    plan.worker_contract,
    injected.trust,
  );
  await writeObserverArtifact(path.join(outputDir, "worker-health.json"), health.bytes);

  const observations = [];
  const calls = [];
  for (const call of plan.calls) {
    const modelBytes = call.model_asset_paths.map((pathname) => {
      const bytes = modelBytesByPath.get(pathname);
      if (!bytes) throw new Error(`observer model asset ${pathname} is missing`);
      return bytes;
    });
    const request = buildWalmartListingSingleObserverRequest(
      plan,
      call.call_index,
      modelBytes,
    );
    const prefix = `call-${String(call.call_index).padStart(2, "0")}`;
    const requestBytes = Buffer.from(request.body, "utf8");
    await writeObserverArtifact(
      path.join(outputDir, `${prefix}-request.json`),
      requestBytes,
    );
    let response: WorkerJsonResponse;
    try {
      response = await connection.analyze(
        request.body,
        plan.worker_contract.vision_timeout_ms + 60_000,
      );
    } catch (error) {
      /*
       * Once analyze() has been invoked, the caller cannot prove whether the
       * remote worker reserved/consumed the exact call before the transport
       * failed. Seal that ambiguity and stop. The call key is stable for the
       * immutable intake, so the worker ledger also prevents a disguised retry
       * under a new local output directory.
       */
      const errorIdentity = error instanceof Error
        ? `${error.name}:${error.message}`
        : String(error);
      const unknownBody = {
        schema_version: "walmart-listing-single-observer-unknown-outcome/v1",
        created_at: new Date().toISOString(),
        listing_key: index.listing_key,
        observer_plan_body_sha256: plan.body_sha256,
        worker_health_file_sha256: health.sha256,
        call_index: call.call_index,
        call_key: call.call_key,
        request_file_sha256: walmartListingIntegritySha256Bytes(requestBytes),
        transport: {
          attempts: 1 as const,
          response_received: false as const,
          subscription_call_consumption: "UNKNOWN" as const,
          error_fingerprint_sha256:
            walmartListingIntegritySha256Bytes(Buffer.from(errorIdentity, "utf8")),
        },
        disposition: {
          retries: 0 as const,
          automatic_replay_allowed: false as const,
          required_action: "RECONCILE_EXACT_CALL_KEY" as const,
        },
      };
      const unknownOutcome = {
        ...unknownBody,
        body_sha256: walmartListingIntegritySha256(unknownBody),
      };
      const unknownOutcomePath = path.join(outputDir, `${prefix}-unknown-outcome.json`);
      await writeObserverArtifact(
        unknownOutcomePath,
        Buffer.from(`${JSON.stringify(unknownOutcome, null, 2)}\n`, "utf8"),
      );
      const partialObservations = {
        schema_version: "wm_visual_observation_batch/v3",
        observations,
      };
      const partialBytes = Buffer.from(
        `${JSON.stringify(partialObservations, null, 2)}\n`,
        "utf8",
      );
      await writeObserverArtifact(
        path.join(outputDir, "observations-partial.json"),
        partialBytes,
      );
      const unknownCalls = [
        ...calls,
        {
          call_index: call.call_index,
          call_key: call.call_key,
          request_file_sha256: walmartListingIntegritySha256Bytes(requestBytes),
          response_file_sha256: null,
          observations: 0,
          subscription_calls_consumed: "UNKNOWN" as const,
          transport_attempts: 1,
          retries: 0,
          status: "UNKNOWN_OUTCOME" as const,
        },
      ];
      const unknownExecution = {
        subscription_calls_confirmed_consumed: calls.length,
        subscription_calls_unknown: 1 as const,
        transport_attempts: calls.length + 1,
        retries: 0 as const,
        fallbacks: 0 as const,
        paid_api_calls: 0 as const,
        database_reads: 0 as const,
        database_writes: 0 as const,
        walmart_reads: 0 as const,
        walmart_writes: 0 as const,
      };
      const unknownExecutionBody = {
        schema_version: "walmart-listing-single-observer-execution/v1",
        status: "UNKNOWN_OUTCOME" as const,
        listing_key: index.listing_key,
        observer_plan_file_sha256: walmartListingIntegritySha256Bytes(planBytes),
        observer_plan_body_sha256: plan.body_sha256,
        worker_health_file_sha256: health.sha256,
        observations_partial_file_sha256:
          walmartListingIntegritySha256Bytes(partialBytes),
        unknown_outcome_body_sha256: unknownOutcome.body_sha256,
        calls: unknownCalls,
        execution: unknownExecution,
      };
      const unknownExecutionIndex = {
        ...unknownExecutionBody,
        body_sha256: walmartListingIntegritySha256(unknownExecutionBody),
      };
      await writeObserverArtifact(
        path.join(outputDir, "execution-index.json"),
        Buffer.from(`${JSON.stringify(unknownExecutionIndex, null, 2)}\n`, "utf8"),
      );
      await chmod(modelRoot, 0o500);
      await chmod(outputDir, 0o500);
      return {
        schema_version: WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA,
        status: "OBSERVATION_UNKNOWN_OUTCOME",
        listing_key: index.listing_key,
        output_dir: outputDir,
        unknown_outcome_path: unknownOutcomePath,
        observer_plan_body_sha256: plan.body_sha256,
        execution_index_body_sha256: unknownExecutionIndex.body_sha256,
        unknown_call: {
          call_index: call.call_index,
          call_key: call.call_key,
        },
        execution: unknownExecution,
        next_step: "DO_NOT_RETRY_RECONCILE_EXACT_CALL_KEY",
      };
    }
    await writeObserverArtifact(
      path.join(outputDir, `${prefix}-response.json`),
      response.bytes,
    );
    const verified = verifyWalmartListingSingleWorkerResponse({
      plan,
      call_index: call.call_index,
      request: request.value,
      http_status: response.status,
      response: response.value,
      trust: injected.trust,
    });
    observations.push(...verified.observations);
    calls.push({
      call_index: call.call_index,
      call_key: call.call_key,
      request_file_sha256: walmartListingIntegritySha256Bytes(requestBytes),
      response_file_sha256: response.sha256,
      observations: verified.observations.length,
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
    });
  }
  const observationsArtifact = {
    schema_version: "wm_visual_observation_batch/v3",
    observations,
  };
  const observationsBytes = Buffer.from(
    `${JSON.stringify(observationsArtifact, null, 2)}\n`,
    "utf8",
  );
  await writeObserverArtifact(
    path.join(outputDir, "observations.json"),
    observationsBytes,
  );
  const executionBody = {
    schema_version: "walmart-listing-single-observer-execution/v1",
    listing_key: index.listing_key,
    observer_plan_file_sha256: walmartListingIntegritySha256Bytes(planBytes),
    observer_plan_body_sha256: plan.body_sha256,
    worker_health_file_sha256: health.sha256,
    observations_file_sha256:
      walmartListingIntegritySha256Bytes(observationsBytes),
    calls,
    execution: {
      subscription_calls_consumed: calls.length,
      transport_attempts: calls.length,
      retries: 0 as const,
      fallbacks: 0 as const,
      paid_api_calls: 0 as const,
      database_reads: 0 as const,
      database_writes: 0 as const,
      walmart_reads: 0 as const,
      walmart_writes: 0 as const,
    },
  };
  const executionIndex = {
    ...executionBody,
    body_sha256: walmartListingIntegritySha256(executionBody),
  };
  await writeObserverArtifact(
    path.join(outputDir, "execution-index.json"),
    Buffer.from(`${JSON.stringify(executionIndex, null, 2)}\n`, "utf8"),
  );
  await chmod(modelRoot, 0o500);
  await chmod(outputDir, 0o500);
  return {
    schema_version: WALMART_LISTING_SINGLE_PROCESS_REPORT_SCHEMA,
    status: "OBSERVED" as const,
    listing_key: index.listing_key,
    output_dir: outputDir,
    observations_path: path.join(outputDir, "observations.json"),
    observer_plan_body_sha256: plan.body_sha256,
    execution_index_body_sha256: executionIndex.body_sha256,
    execution: executionBody.execution,
    next_step: "DIAGNOSE" as const,
  };
}

function walmartListingIntegritySha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseWalmartListingSingleProcessArgs(argv);
  const result = await executeWalmartListingSingleProcess(args);
  console.log(JSON.stringify(result, null, 2));
  if ("status" in result && result.status === "OBSERVATION_UNKNOWN_OUTCOME") {
    process.exitCode = 2;
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
