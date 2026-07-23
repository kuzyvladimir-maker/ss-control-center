import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type {
  ListingIntegrityShadowCase,
  ListingIntegrityShadowData,
  ListingIntegrityShadowImage,
  ListingIntegrityProductTruthReadiness,
  ListingIntegrityCatalogOverview,
} from "./listing-integrity-shadow-contract";
import {
  verifyWalmartListingIntegrityCatalogArtifacts,
  type WalmartListingIntegrityCatalogCensus,
  type WalmartListingIntegrityScanPlan,
} from "./listing-integrity-catalog-orchestrator.ts";

type JsonRecord = Record<string, unknown>;

const DEFAULT_ROOT = path.join(
  process.cwd(),
  "data",
  "audits",
  "walmart-listing-integrity-fresh-controls",
);

const DEFAULT_CATALOG_ROOT = path.join(
  process.cwd(),
  "data",
  "audits",
  "walmart-listing-integrity-catalog",
);

const DEFAULT_CAPTURE_ROOT = path.join(
  process.cwd(),
  "data",
  "audits",
  "walmart-listing-integrity-captures",
);

const VERIFICATION_FILE = "_verification.json";
const VERIFICATION_SHA_FILE = "_verification.sha256";
const PRODUCT_TRUTH_READINESS_FILE = "_product-truth-readiness.json";
const PRODUCT_TRUTH_READINESS_SHA_FILE = "_product-truth-readiness.sha256";
const VISUAL_ATTESTATION_INDEX_FILE = "visual-attestation-index.json";
const VISUAL_ATTESTATION_INDEX_SHA_FILE = "visual-attestation-index.sha256";
const OWNER_VISUAL_REVIEW_INDEX_FILE = "owner-visual-review-index.json";
const OWNER_VISUAL_REVIEW_INDEX_SHA_FILE = "owner-visual-review-index.sha256";
const TRUSTED_VISION_KEY_ID = "walmart-listing-vision-aaf60dc3afc25bba";
const TRUSTED_VISION_KEY_SHA256 = "aaf60dc3afc25bba5bac48086524b813ad62b0103c290886769a1352eb4b8ea3";
const TRUSTED_VISION_WORKER_BUILD = "sha256:fed5fa5e49914c1df1ae2197c51be4d7c0342f2adad4d01819f792622614f0f9";

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has missing or extra fields`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON rejects undefined");
  return encoded;
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function exactImageUrl(value: unknown, label: string): string {
  const raw = text(value, label);
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

function sha256(value: unknown, label: string): string {
  const raw = text(value, label);
  if (!/^[a-f0-9]{64}$/u.test(raw)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return raw;
}

function digestSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function emptyCatalogOverview(): ListingIntegrityCatalogOverview {
  return {
    status: "NOT_CAPTURED",
    capturedAt: null,
    catalogSyncedAt: null,
    censusId: null,
    planId: null,
    snapshotVerified: false,
    evidencePath: null,
    censusFileSha256: null,
    planFileSha256: null,
    catalog: {
      total: 0,
      published: 0,
      active: 0,
      withItemId: 0,
      withTitle: 0,
      exactOnce: false,
      duplicateSkus: 0,
    },
    queues: {
      visualTriageReady: 0,
      sourceAcquisitionRequired: 0,
      statusReview: 0,
      blockedSource: 0,
      doNotTouch: 0,
      deterministicConflicts: 0,
    },
    visualScan: {
      listings: 0,
      tasks: 0,
      partitions: 0,
      estimatedModelCallsMax: 0,
      capturedPartitions: 0,
      capturedAssets: 0,
      captureTechnicalErrors: 0,
      modelCallsCompleted: 0,
      walmartWrites: 0,
    },
    policy: {
      mode: "READ_ONLY_TRIAGE",
      imagesPerCallMax: 6,
      callsPerPartitionMax: 6,
      buyerVerifiedPassAllowed: false,
      walmartWritesAllowed: false,
    },
  };
}

async function readShaBoundArtifact(
  pathname: string,
  sidecarPathname: string,
  label: string,
): Promise<{ bytes: Buffer; fileSha256: string; value: unknown }> {
  const [bytes, sidecarBytes] = await Promise.all([
    readFile(pathname),
    readFile(sidecarPathname),
  ]);
  if (bytes.byteLength < 2 || bytes.byteLength > 50_000_000) {
    throw new Error(`${label} has invalid byte size`);
  }
  const fileSha256 = sidecarBytes.toString("utf8").trim();
  if (!/^[a-f0-9]{64}$/u.test(fileSha256)
    || digestSha256(bytes) !== fileSha256) {
    throw new Error(`${label} exact-file SHA-256 mismatch`);
  }
  return { bytes, fileSha256, value: JSON.parse(bytes.toString("utf8")) };
}

async function loadCaptureProgress(input: {
  root: string | null;
  snapshotName: string;
  censusFileSha256: string;
  planFileSha256: string;
  plan: WalmartListingIntegrityScanPlan;
}): Promise<{
  capturedPartitions: number;
  capturedAssets: number;
  captureTechnicalErrors: number;
  modelCallsCompleted: number;
  walmartWrites: 0;
}> {
  const empty = {
    capturedPartitions: 0,
    capturedAssets: 0,
    captureTechnicalErrors: 0,
    modelCallsCompleted: 0,
    walmartWrites: 0 as const,
  };
  if (!input.root) return empty;
  const snapshotRoot = path.join(input.root, input.snapshotName);
  let entries: Dirent[];
  try {
    entries = await readdir(snapshotRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  const planned = new Map(input.plan.partitions.map((entry) => [entry.partition_id, entry]));
  const latestByPartition = new Map<string, {
    capturedAt: string;
    complete: boolean;
    captured: number;
    technicalErrors: number;
    modelCalls: number;
  }>();
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const directory = path.join(snapshotRoot, entry.name);
    const indexPath = path.join(directory, "capture-index.json");
    const shaPath = path.join(directory, "capture-index.sha256");
    let artifact: Awaited<ReturnType<typeof readShaBoundArtifact>>;
    try {
      artifact = await readShaBoundArtifact(indexPath, shaPath, "capture index");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const capture = record(artifact.value, "capture index");
    if (capture.schema_version !== "walmart-listing-integrity-image-capture/v1"
      || capture.census_file_sha256 !== input.censusFileSha256
      || capture.plan_file_sha256 !== input.planFileSha256) {
      throw new Error(`${indexPath}: capture source binding mismatch`);
    }
    const partitionId = text(capture.partition_id, "capture.partition_id", 200);
    const partition = planned.get(partitionId);
    if (!partition) throw new Error(`${indexPath}: capture partition is absent from plan`);
    const body = { ...capture };
    delete body.body_sha256;
    if (digestSha256(Buffer.from(JSON.stringify(body))) !== capture.body_sha256) {
      throw new Error(`${indexPath}: capture body seal mismatch`);
    }
    if (!Array.isArray(capture.results)
      || capture.results.length !== partition.tasks.length
      || capture.results.some((value, index) => (
        JSON.stringify(record(value, `capture.results[${index}]`).task)
          !== JSON.stringify(partition.tasks[index])
      ))) {
      throw new Error(`${indexPath}: capture task population/order mismatch`);
    }
    let captured = 0;
    let technicalErrors = 0;
    for (const [index, value] of capture.results.entries()) {
      const result = record(value, `capture.results[${index}]`);
      if (result.status === "TECH_ERROR") {
        technicalErrors += 1;
        continue;
      }
      if (result.status !== "CAPTURED") {
        throw new Error(`${indexPath}: unsupported capture result status`);
      }
      captured += 1;
      const asset = record(result.asset, `capture.results[${index}].asset`);
      const relative = text(asset.path, `capture.results[${index}].asset.path`, 500);
      const assetPath = path.resolve(directory, relative);
      const assetsRoot = path.resolve(directory, "assets");
      if (!assetPath.startsWith(`${assetsRoot}${path.sep}`)) {
        throw new Error(`${indexPath}: capture asset escapes its root`);
      }
      const info = await lstat(assetPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`${indexPath}: capture asset is not a regular file`);
      }
      const bytes = await readFile(assetPath);
      if (bytes.byteLength !== count(asset.bytes, "capture.asset.bytes")
        || digestSha256(bytes) !== sha256(asset.sha256, "capture.asset.sha256")) {
        throw new Error(`${indexPath}: capture asset integrity mismatch`);
      }
    }
    const execution = record(capture.execution, "capture.execution");
    zero(execution.database_writes, "capture.execution.database_writes");
    zero(execution.walmart_writes, "capture.execution.walmart_writes");
    const outcome = record(capture.outcome, "capture.outcome");
    const complete = outcome.complete === true
      && captured === partition.tasks.length
      && technicalErrors === 0;
    const candidate = {
      capturedAt: text(capture.captured_at, "capture.captured_at", 64),
      complete,
      captured,
      technicalErrors,
      modelCalls: count(execution.model_calls, "capture.execution.model_calls"),
    };
    const previous = latestByPartition.get(partitionId);
    if (!previous || candidate.capturedAt > previous.capturedAt) {
      latestByPartition.set(partitionId, candidate);
    }
  }
  const selected = [...latestByPartition.values()];
  return {
    capturedPartitions: selected.filter((entry) => entry.complete).length,
    capturedAssets: selected.reduce((sum, entry) => sum + entry.captured, 0),
    captureTechnicalErrors: selected.reduce((sum, entry) => sum + entry.technicalErrors, 0),
    modelCallsCompleted: selected.reduce((sum, entry) => sum + entry.modelCalls, 0),
    walmartWrites: 0,
  };
}

async function loadCatalogOverview(
  catalogRoot: string | null,
  captureRoot: string | null,
): Promise<ListingIntegrityCatalogOverview> {
  if (!catalogRoot) return emptyCatalogOverview();
  let entries: Dirent[];
  try {
    entries = await readdir(catalogRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalogOverview();
    throw error;
  }
  const snapshots = entries
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._-]+$/u.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name, "en"));
  if (!snapshots.length) return emptyCatalogOverview();
  const snapshotName = snapshots[0].name;
  const evidenceRoot = path.join(catalogRoot, snapshotName);
  const [censusArtifact, planArtifact] = await Promise.all([
    readShaBoundArtifact(
      path.join(evidenceRoot, "catalog-census.json"),
      path.join(evidenceRoot, "catalog-census.sha256"),
      "catalog census",
    ),
    readShaBoundArtifact(
      path.join(evidenceRoot, "scan-plan.json"),
      path.join(evidenceRoot, "scan-plan.sha256"),
      "catalog scan plan",
    ),
  ]);
  const census = censusArtifact.value as WalmartListingIntegrityCatalogCensus;
  const plan = planArtifact.value as WalmartListingIntegrityScanPlan;
  verifyWalmartListingIntegrityCatalogArtifacts({ census, plan });
  const progress = await loadCaptureProgress({
    root: captureRoot,
    snapshotName,
    censusFileSha256: censusArtifact.fileSha256,
    planFileSha256: planArtifact.fileSha256,
    plan,
  });
  return {
    status: progress.capturedPartitions > 0 ? "CAPTURE_TEST_READY" : "CATALOG_PLAN_READY",
    capturedAt: text(census.captured_at, "census.captured_at", 64),
    catalogSyncedAt: text(census.reconciliation.catalog_synced_at, "census.catalog_synced_at", 64),
    censusId: text(census.census_id, "census.census_id", 200),
    planId: text(plan.plan_id, "plan.plan_id", 200),
    snapshotVerified: true,
    evidencePath: path.relative(process.cwd(), evidenceRoot),
    censusFileSha256: censusArtifact.fileSha256,
    planFileSha256: planArtifact.fileSha256,
    catalog: {
      total: count(census.summary.total, "census.summary.total"),
      published: count(census.summary.published, "census.summary.published"),
      active: count(census.summary.active, "census.summary.active"),
      withItemId: count(census.summary.with_item_id, "census.summary.with_item_id"),
      withTitle: count(census.summary.with_title, "census.summary.with_title"),
      exactOnce: census.reconciliation.exact_once === true,
      duplicateSkus: count(census.reconciliation.duplicate_skus, "census.duplicate_skus"),
    },
    queues: {
      visualTriageReady: count(census.summary.disposition_counts.VISUAL_TRIAGE_READY, "queue.visual"),
      sourceAcquisitionRequired: count(census.summary.disposition_counts.SOURCE_ACQUISITION_REQUIRED, "queue.source"),
      statusReview: count(census.summary.disposition_counts.STATUS_REVIEW, "queue.status"),
      blockedSource: count(census.summary.disposition_counts.BLOCKED_SOURCE, "queue.blocked"),
      doNotTouch: count(census.summary.disposition_counts.DO_NOT_TOUCH, "queue.do_not_touch"),
      deterministicConflicts: count(census.summary.deterministic_conflicts, "queue.conflicts"),
    },
    visualScan: {
      listings: count(plan.coverage.listings_with_visual_tasks, "plan.coverage.listings"),
      tasks: count(plan.coverage.visual_tasks, "plan.coverage.tasks"),
      partitions: count(plan.coverage.partitions, "plan.coverage.partitions"),
      estimatedModelCallsMax: count(plan.coverage.estimated_model_calls_max, "plan.coverage.model_calls"),
      ...progress,
    },
    policy: {
      mode: "READ_ONLY_TRIAGE",
      imagesPerCallMax: count(plan.policy.images_per_call_max, "plan.policy.images_per_call_max"),
      callsPerPartitionMax: count(plan.policy.calls_per_partition_max, "plan.policy.calls_per_partition_max"),
      buyerVerifiedPassAllowed: false,
      walmartWritesAllowed: false,
    },
  };
}

function zero(value: unknown, label: string): void {
  if (count(value, label) !== 0) throw new Error(`${label} must remain zero in shadow mode`);
}

function exactTrue(value: unknown, label: string): void {
  if (value !== true) throw new Error(`${label} must be true`);
}

function exactFalse(value: unknown, label: string): void {
  if (value !== false) throw new Error(`${label} must be false`);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function resolveContainedPath(input: {
  base: string;
  containmentRoot: string;
  relativePath: unknown;
  label: string;
}): string {
  const relativePath = text(input.relativePath, input.label);
  if (path.isAbsolute(relativePath)) throw new Error(`${input.label} must be relative`);
  const root = path.resolve(input.containmentRoot);
  const resolved = path.resolve(input.base, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${input.label} escapes its evidence root`);
  }
  return resolved;
}

async function readExactShaFile(input: {
  pathname: string;
  expectedSha256: unknown;
  label: string;
  maxBytes: number;
}): Promise<Buffer> {
  const bytes = await readFile(input.pathname);
  if (bytes.byteLength < 1 || bytes.byteLength > input.maxBytes) {
    throw new Error(`${input.label} byte size is invalid`);
  }
  if (digestSha256(bytes) !== sha256(input.expectedSha256, `${input.label}.sha256`)) {
    throw new Error(`${input.label} SHA-256 mismatch`);
  }
  return bytes;
}

function verifySignedWorkerReceipt(value: unknown, label: string): JsonRecord {
  const receipt = record(value, label);
  exactKeys(receipt, [
    "schema_version", "key_id", "public_key_spki_der_base64",
    "public_key_spki_sha256", "body", "signature_base64",
  ], label);
  if (receipt.schema_version !== "vision-worker-receipt/v2"
    || text(receipt.key_id, `${label}.key_id`) !== TRUSTED_VISION_KEY_ID
    || sha256(receipt.public_key_spki_sha256, `${label}.public_key_spki_sha256`)
      !== TRUSTED_VISION_KEY_SHA256) {
    throw new Error(`${label} trust identity mismatch`);
  }
  const publicKeyBase64 = text(
    receipt.public_key_spki_der_base64,
    `${label}.public_key_spki_der_base64`,
  );
  const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
  if (!publicKeyBytes.byteLength
    || publicKeyBytes.toString("base64") !== publicKeyBase64
    || digestSha256(publicKeyBytes) !== TRUSTED_VISION_KEY_SHA256) {
    throw new Error(`${label} public key bytes mismatch`);
  }
  const signatureBase64 = text(receipt.signature_base64, `${label}.signature_base64`);
  const signature = Buffer.from(signatureBase64, "base64");
  if (!signature.byteLength || signature.toString("base64") !== signatureBase64
    || !verify(
      null,
      Buffer.from(canonicalJson(record(receipt.body, `${label}.body`)), "utf8"),
      createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" }),
      signature,
    )) {
    throw new Error(`${label} signature is invalid`);
  }
  return receipt;
}

async function readShaBoundJson(input: {
  jsonPath: string;
  shaPath: string;
  label: string;
  maxBytes: number;
}): Promise<{ bytes: Buffer; body: JsonRecord }> {
  const [bytes, expectedShaBytes] = await Promise.all([
    readFile(input.jsonPath),
    readFile(input.shaPath, "utf8"),
  ]);
  if (bytes.byteLength > input.maxBytes) {
    throw new Error(`${input.jsonPath}: ${input.label} exceeds byte limit`);
  }
  const expectedSha = expectedShaBytes.trim();
  if (!/^[a-f0-9]{64}$/u.test(expectedSha)) {
    throw new Error(`${input.shaPath}: invalid SHA-256 sidecar`);
  }
  if (digestSha256(bytes) !== expectedSha) {
    throw new Error(`${input.jsonPath}: ${input.label} SHA-256 mismatch`);
  }
  return {
    bytes,
    body: record(JSON.parse(bytes.toString("utf8")), input.label),
  };
}

function resolveAuditAsset(value: unknown, label: string): string {
  const raw = text(value, label);
  if (path.isAbsolute(raw)) throw new Error(`${label} must be workspace-relative`);
  const auditRoot = path.resolve(process.cwd(), "data", "audits");
  const resolved = path.resolve(process.cwd(), raw);
  if (resolved !== auditRoot && !resolved.startsWith(`${auditRoot}${path.sep}`)) {
    throw new Error(`${label} must remain inside data/audits`);
  }
  return resolved;
}

async function verifyAssetBytes(asset: JsonRecord, label: string): Promise<void> {
  const localPath = resolveAuditAsset(asset.local_path, `${label}.local_path`);
  const bytes = await readFile(localPath);
  if (bytes.byteLength !== count(asset.bytes, `${label}.bytes`)) {
    throw new Error(`${label}: asset byte count mismatch`);
  }
  if (digestSha256(bytes) !== sha256(asset.sha256, `${label}.sha256`)) {
    throw new Error(`${label}: asset SHA-256 mismatch`);
  }
}

function imageFromManifest(value: unknown, label: string): ListingIntegrityShadowImage {
  const image = record(value, label);
  const facts = record(image.manual_visual_facts, `${label}.manual_visual_facts`);
  return {
    slot: text(image.slot, `${label}.slot`),
    url: exactImageUrl(image.url, `${label}.url`),
    sha256: sha256(image.sha256, `${label}.sha256`),
    width: count(image.width, `${label}.width`),
    height: count(image.height, `${label}.height`),
    role: typeof facts.visual_role === "string" ? facts.visual_role : "product",
  };
}

async function loadVerification(root: string) {
  const verificationPath = path.join(root, VERIFICATION_FILE);
  const { body: verification } = await readShaBoundJson({
    jsonPath: verificationPath,
    shaPath: path.join(root, VERIFICATION_SHA_FILE),
    label: "shadow verification",
    maxBytes: 100_000,
  });
  if (verification.schema_version !== "walmart-listing-integrity-shadow-verification/v1") {
    throw new Error(`${verificationPath}: unsupported verification schema`);
  }
  const release = record(verification.release_certification, "verification.release_certification");
  const current = record(verification.current_verification, "verification.current_verification");
  const effects = record(verification.external_effects, "verification.external_effects");
  const failed = count(
    release.closed_loop_assertions_failed,
    "verification.release_certification.closed_loop_assertions_failed",
  );
  const walmartWrites = count(
    effects.walmart_listing_writes,
    "verification.external_effects.walmart_listing_writes",
  );
  if (failed !== 0 || walmartWrites !== 0) {
    throw new Error(`${verificationPath}: shadow verification is not clean/read-only`);
  }
  return {
    closedLoopTestsPassed: count(
      release.closed_loop_assertions_passed,
      "verification.release_certification.closed_loop_assertions_passed",
    ),
    focusedTestsPassed: count(
      current.fresh_detector_assertions_passed,
      "verification.current_verification.fresh_detector_assertions_passed",
    ),
    visualComparatorTestsPassed: count(
      current.visual_comparator_assertions_passed,
      "verification.current_verification.visual_comparator_assertions_passed",
    ),
    observationTestsPassed: count(
      current.observation_assertions_passed,
      "verification.current_verification.observation_assertions_passed",
    ),
    workerSecurityTestsPassed: count(
      current.worker_security_assertions_passed,
      "verification.current_verification.worker_security_assertions_passed",
    ),
    shadowTestsPassed: count(current.shadow_loader_assertions_passed, "verification.current_verification.shadow_loader_assertions_passed")
      + count(current.shadow_ui_assertions_passed, "verification.current_verification.shadow_ui_assertions_passed"),
    historicalCases: count(verification.historical_controls, "verification.historical_controls"),
    walmartWrites: 0 as const,
  };
}

async function loadProductTruthReadiness(
  root: string,
): Promise<ListingIntegrityProductTruthReadiness> {
  const readinessPath = path.join(root, PRODUCT_TRUTH_READINESS_FILE);
  const { bytes, body: readiness } = await readShaBoundJson({
    jsonPath: readinessPath,
    shaPath: path.join(root, PRODUCT_TRUTH_READINESS_SHA_FILE),
    label: "Product Truth readiness",
    maxBytes: 100_000,
  });
  exactKeys(readiness, [
    "schema_version", "captured_at", "status", "source_contract",
    "database_target_fingerprint_sha256", "schema_current_sha256",
    "migration_set_sha256", "activation_contract_sha256",
    "post_activation_plan", "migration_certification", "listing_truth_probe",
    "pending_migrations", "claims", "external_effects",
  ], "Product Truth readiness");
  if (readiness.schema_version !== "walmart-listing-integrity-product-truth-readiness/v2"
    || readiness.status !== "BLOCKED_SKU_TRUTH_NOT_READY"
    || readiness.source_contract !== "product-truth-read-contract/3.2.0") {
    throw new Error(`${readinessPath}: unsupported Product Truth readiness state`);
  }
  const capturedAt = text(readiness.captured_at, "Product Truth readiness.captured_at");
  if (new Date(capturedAt).toISOString() !== capturedAt) {
    throw new Error(`${readinessPath}: captured_at must be canonical UTC`);
  }
  const targetFingerprint = sha256(
    readiness.database_target_fingerprint_sha256,
    "Product Truth readiness.database_target_fingerprint_sha256",
  );
  const schemaCurrentSha256 = sha256(
    readiness.schema_current_sha256,
    "Product Truth readiness.schema_current_sha256",
  );
  const migrationSetSha256 = sha256(
    readiness.migration_set_sha256,
    "Product Truth readiness.migration_set_sha256",
  );
  sha256(
    readiness.activation_contract_sha256,
    "Product Truth readiness.activation_contract_sha256",
  );
  const plan = record(readiness.post_activation_plan, "Product Truth readiness.post_activation_plan");
  exactKeys(plan, [
    "path", "sha256", "can_apply", "blockers", "receipt_ledger",
    "prisma_ledger", "applied_tracked_migrations",
  ], "Product Truth readiness.post_activation_plan");
  if (plan.can_apply !== true
    || stringList(plan.blockers, "Product Truth readiness.post_activation_plan.blockers").length !== 0
    || plan.receipt_ledger !== "ready"
    || plan.prisma_ledger !== "ready"
    || count(
      plan.applied_tracked_migrations,
      "Product Truth readiness.post_activation_plan.applied_tracked_migrations",
    ) !== 8) {
    throw new Error(`${readinessPath}: post-activation plan is not clean and fully tracked`);
  }
  const planSha256 = sha256(plan.sha256, "Product Truth readiness.post_activation_plan.sha256");
  const planPath = resolveContainedPath({
    base: process.cwd(),
    containmentRoot: path.join(process.cwd(), "data"),
    relativePath: plan.path,
    label: "Product Truth readiness.post_activation_plan.path",
  });
  const planBytes = await readExactShaFile({
    pathname: planPath,
    expectedSha256: planSha256,
    label: "Product Truth post-activation plan",
    maxBytes: 2_000_000,
  });
  const planBody = record(
    JSON.parse(planBytes.toString("utf8")),
    "Product Truth post-activation plan",
  );
  const planDatabase = record(planBody.database, "Product Truth post-activation plan.database");
  const planSchema = record(planBody.schema, "Product Truth post-activation plan.schema");
  if (planBody.contractVersion !== "product-truth-migration-plan/2"
    || planBody.canApply !== true
    || stringList(planBody.blockers, "Product Truth post-activation plan.blockers").length !== 0
    || planBody.receiptLedger !== "ready"
    || planBody.prismaLedger !== "ready"
    || planDatabase.targetFingerprint !== targetFingerprint
    || planSchema.sha256 !== schemaCurrentSha256
    || planBody.migrationSetSha256 !== migrationSetSha256
    || !Array.isArray(planBody.migrations)
    || planBody.migrations.length !== 8
    || planBody.migrations.some((entry, index) => {
      const migration = record(entry, `Product Truth post-activation plan.migrations[${index}]`);
      return migration.state !== "applied"
        || migration.tracking !== "tracked"
        || stringList(
          migration.blockers,
          `Product Truth post-activation plan.migrations[${index}].blockers`,
        ).length !== 0;
    })) {
    throw new Error(`${planPath}: Product Truth post-activation proof is invalid`);
  }

  const certification = record(
    readiness.migration_certification,
    "Product Truth readiness.migration_certification",
  );
  exactKeys(certification, [
    "path", "sha256", "report_path", "report_sha256", "all_migrations_applied",
    "all_receipts_tracked", "receipt_ledger_ready",
  ], "Product Truth readiness.migration_certification");
  exactTrue(
    certification.all_migrations_applied,
    "Product Truth readiness.migration_certification.all_migrations_applied",
  );
  exactTrue(
    certification.all_receipts_tracked,
    "Product Truth readiness.migration_certification.all_receipts_tracked",
  );
  exactTrue(
    certification.receipt_ledger_ready,
    "Product Truth readiness.migration_certification.receipt_ledger_ready",
  );
  const certificationPath = resolveContainedPath({
    base: process.cwd(),
    containmentRoot: path.join(process.cwd(), "data"),
    relativePath: certification.path,
    label: "Product Truth readiness.migration_certification.path",
  });
  const certificationSha256 = sha256(
    certification.sha256,
    "Product Truth readiness.migration_certification.sha256",
  );
  const certificationBytes = await readExactShaFile({
    pathname: certificationPath,
    expectedSha256: certificationSha256,
    label: "Product Truth migration certification",
    maxBytes: 100_000,
  });
  const certificationBody = record(
    JSON.parse(certificationBytes.toString("utf8")),
    "Product Truth migration certification",
  );
  const reportPath = resolveContainedPath({
    base: process.cwd(),
    containmentRoot: path.join(process.cwd(), "data"),
    relativePath: certification.report_path,
    label: "Product Truth readiness.migration_certification.report_path",
  });
  const reportSha256 = sha256(
    certification.report_sha256,
    "Product Truth readiness.migration_certification.report_sha256",
  );
  await readExactShaFile({
    pathname: reportPath,
    expectedSha256: reportSha256,
    label: "Product Truth migration report",
    maxBytes: 2_000_000,
  });
  if (certificationBody.contractVersion !== "product-truth-migration-certification/1.0.0"
    || certificationBody.databaseTargetFingerprint !== targetFingerprint
    || certificationBody.schemaFingerprintSha256 !== schemaCurrentSha256
    || certificationBody.migrationSetSha256 !== migrationSetSha256
    || certificationBody.migrationReportSha256 !== reportSha256
    || certificationBody.allMigrationsApplied !== true
    || certificationBody.allReceiptsTracked !== true
    || certificationBody.receiptLedgerReady !== true) {
    throw new Error(`${certificationPath}: Product Truth migration certification is invalid`);
  }

  const probe = record(readiness.listing_truth_probe, "Product Truth readiness.listing_truth_probe");
  exactKeys(probe, [
    "listing_key", "sku", "channel", "store_index", "as_of",
    "recipe_component_count", "listing_improvement_ready", "blockers",
  ], "Product Truth readiness.listing_truth_probe");
  const sku = text(probe.sku, "Product Truth readiness.listing_truth_probe.sku");
  const channel = text(probe.channel, "Product Truth readiness.listing_truth_probe.channel");
  const storeIndex = count(probe.store_index, "Product Truth readiness.listing_truth_probe.store_index");
  const listingKey = text(
    probe.listing_key,
    "Product Truth readiness.listing_truth_probe.listing_key",
  );
  const probeAsOf = text(probe.as_of, "Product Truth readiness.listing_truth_probe.as_of");
  const blockers = stringList(probe.blockers, "Product Truth readiness.listing_truth_probe.blockers");
  if (listingKey !== `${channel}:${storeIndex}:${sku}`
    || channel !== "walmart"
    || storeIndex !== 1
    || new Date(probeAsOf).toISOString() !== probeAsOf
    || count(
      probe.recipe_component_count,
      "Product Truth readiness.listing_truth_probe.recipe_component_count",
    ) !== 0
    || probe.listing_improvement_ready !== false
    || !sameStringList(blockers, [
      "LISTING_SCOPE_NOT_REGISTERED",
      "CURRENT_SCOPED_SKU_COST_MISSING",
    ])) {
    throw new Error(`${readinessPath}: exact listing Product Truth probe is invalid`);
  }
  const pendingMigrations = count(
    readiness.pending_migrations,
    "Product Truth readiness.pending_migrations",
  );
  if (pendingMigrations !== 0) {
    throw new Error(`${readinessPath}: certified schema cannot have pending migrations`);
  }
  const claims = record(readiness.claims, "Product Truth readiness.claims");
  exactKeys(claims, [
    "shared_product_truth_required", "schema_ready", "competing_local_truth_allowed",
    "execution_package_ready", "walmart_write_authorized", "mass_run_authorized",
  ], "Product Truth readiness.claims");
  exactTrue(claims.shared_product_truth_required, "Product Truth readiness.shared_product_truth_required");
  exactTrue(claims.schema_ready, "Product Truth readiness.schema_ready");
  exactFalse(claims.competing_local_truth_allowed, "Product Truth readiness.competing_local_truth_allowed");
  exactFalse(claims.execution_package_ready, "Product Truth readiness.execution_package_ready");
  exactFalse(claims.walmart_write_authorized, "Product Truth readiness.walmart_write_authorized");
  exactFalse(claims.mass_run_authorized, "Product Truth readiness.mass_run_authorized");
  const effects = record(readiness.external_effects, "Product Truth readiness.external_effects");
  exactKeys(effects, [
    "schema_migration_transactions", "database_read_only_sessions_after_activation",
    "product_truth_business_data_writes", "model_calls", "walmart_writes",
  ], "Product Truth readiness.external_effects");
  if (count(
    effects.schema_migration_transactions,
    "Product Truth readiness.schema_migration_transactions",
  ) !== 1
    || count(
      effects.database_read_only_sessions_after_activation,
      "Product Truth readiness.database_read_only_sessions_after_activation",
    ) < 2) {
    throw new Error(`${readinessPath}: readiness needs exact activation and read-only verification`);
  }
  zero(
    effects.product_truth_business_data_writes,
    "Product Truth readiness.product_truth_business_data_writes",
  );
  zero(effects.model_calls, "Product Truth readiness.model_calls");
  zero(effects.walmart_writes, "Product Truth readiness.walmart_writes");
  return {
    status: "BLOCKED_SKU_TRUTH_NOT_READY",
    capturedAt,
    sourceContract: "product-truth-read-contract/3.2.0",
    schemaReady: true,
    pendingMigrations,
    listingKey,
    blockers,
    executionPackageReady: false,
    walmartWriteAuthorized: false,
    massRunAuthorized: false,
    sharedPlanPath: path.relative(process.cwd(), planPath),
    sharedPlanSha256: planSha256,
    evidencePath: path.relative(process.cwd(), readinessPath),
    evidenceSha256: digestSha256(bytes),
  };
}

async function verifyCanaryPreview(input: {
  caseRoot: string;
  manifest: JsonRecord;
  manifestBytes: Buffer;
}): Promise<{ canaryPreviewPath: string; byteCustodyStatus: "VERIFIED" }> {
  const previewPath = path.join(input.caseRoot, "canary-preview.json");
  const { body: preview } = await readShaBoundJson({
    jsonPath: previewPath,
    shaPath: path.join(input.caseRoot, "canary-preview.sha256"),
    label: "canary preview",
    maxBytes: 250_000,
  });
  if (preview.schema_version !== "walmart-listing-integrity-canary-preview/v1") {
    throw new Error(`${previewPath}: unsupported canary preview schema`);
  }
  if (preview.status !== "BYTE_CUSTODY_COMPLETE_VISUAL_ATTESTATION_PENDING") {
    throw new Error(`${previewPath}: unsupported canary preview status`);
  }
  const manifestScope = record(input.manifest.scope, "manifest.scope");
  const previewScope = record(preview.scope, "preview.scope");
  for (const key of ["sku", "item_id"] as const) {
    if (text(previewScope[key], `preview.scope.${key}`) !== text(manifestScope[key], `manifest.scope.${key}`)) {
      throw new Error(`${previewPath}: scope ${key} mismatch`);
    }
  }
  const productTruth = record(input.manifest.product_truth, "manifest.product_truth");
  if (
    count(previewScope.expected_outer_units, "preview.scope.expected_outer_units")
      !== count(productTruth.outer_units, "manifest.product_truth.outer_units")
  ) {
    throw new Error(`${previewPath}: expected outer units mismatch`);
  }
  const sourceManifest = record(preview.source_manifest, "preview.source_manifest");
  if (sha256(sourceManifest.sha256, "preview.source_manifest.sha256") !== digestSha256(input.manifestBytes)) {
    throw new Error(`${previewPath}: source manifest SHA-256 mismatch`);
  }

  if (!Array.isArray(input.manifest.current_images) || !Array.isArray(preview.before_assets)) {
    throw new Error(`${previewPath}: current/before image arrays are required`);
  }
  if (preview.before_assets.length !== input.manifest.current_images.length) {
    throw new Error(`${previewPath}: before asset coverage mismatch`);
  }
  const currentImages = new Map<string, JsonRecord>();
  for (const [index, value] of input.manifest.current_images.entries()) {
    const image = record(value, `manifest.current_images[${index}]`);
    const slot = text(image.slot, `manifest.current_images[${index}].slot`);
    if (currentImages.has(slot)) throw new Error(`${previewPath}: duplicate current image slot ${slot}`);
    currentImages.set(slot, image);
  }
  const seenSlots = new Set<string>();
  for (const [index, value] of preview.before_assets.entries()) {
    const asset = record(value, `preview.before_assets[${index}]`);
    const slot = text(asset.slot, `preview.before_assets[${index}].slot`);
    const current = currentImages.get(slot);
    if (!current || seenSlots.has(slot)) throw new Error(`${previewPath}: invalid before asset slot ${slot}`);
    seenSlots.add(slot);
    if (
      exactImageUrl(asset.source_url, `preview.before_assets[${index}].source_url`)
        !== exactImageUrl(current.url, `manifest.current_images[${index}].url`)
      || sha256(asset.sha256, `preview.before_assets[${index}].sha256`)
        !== sha256(current.sha256, `manifest.current_images[${index}].sha256`)
      || count(asset.width, `preview.before_assets[${index}].width`)
        !== count(current.width, `manifest.current_images[${index}].width`)
      || count(asset.height, `preview.before_assets[${index}].height`)
        !== count(current.height, `manifest.current_images[${index}].height`)
    ) {
      throw new Error(`${previewPath}: before asset ${slot} does not match manifest`);
    }
    await verifyAssetBytes(asset, `preview.before_assets[${index}]`);
  }

  const target = record(preview.selected_target, "preview.selected_target");
  const candidate = record(input.manifest.approved_repair_candidate, "manifest.approved_repair_candidate");
  const candidateFacts = record(
    candidate.manual_visual_facts,
    "manifest.approved_repair_candidate.manual_visual_facts",
  );
  if (
    text(target.slot, "preview.selected_target.slot") !== "MAIN"
    || exactImageUrl(target.asset_url, "preview.selected_target.asset_url")
      !== exactImageUrl(candidate.asset_url, "manifest.approved_repair_candidate.asset_url")
    || sha256(target.sha256, "preview.selected_target.sha256")
      !== sha256(candidate.sha256, "manifest.approved_repair_candidate.sha256")
    || count(target.width, "preview.selected_target.width")
      !== count(candidate.width, "manifest.approved_repair_candidate.width")
    || count(target.height, "preview.selected_target.height")
      !== count(candidate.height, "manifest.approved_repair_candidate.height")
    || count(target.represented_outer_units, "preview.selected_target.represented_outer_units")
      !== count(
        candidateFacts.visible_sellable_packages,
        "manifest.approved_repair_candidate.manual_visual_facts.visible_sellable_packages",
      )
  ) {
    throw new Error(`${previewPath}: target asset does not match manifest candidate`);
  }
  await verifyAssetBytes(target, "preview.selected_target");

  const exactDiff = record(preview.exact_diff, "preview.exact_diff");
  const changedFields = stringList(exactDiff.changed_fields, "preview.exact_diff.changed_fields");
  if (!sameStringList(changedFields, ["MAIN"])) {
    throw new Error(`${previewPath}: canary diff must remain MAIN-only`);
  }
  const currentMain = currentImages.get("MAIN");
  if (!currentMain) throw new Error(`${previewPath}: current MAIN is missing`);
  const currentMainFacts = record(currentMain.manual_visual_facts, "manifest current MAIN facts");
  const unchangedFields = stringList(
    exactDiff.unchanged_fields,
    "preview.exact_diff.unchanged_fields",
  );
  if (
    sha256(exactDiff.before_main_sha256, "preview.exact_diff.before_main_sha256")
      !== sha256(currentMain.sha256, "manifest current MAIN sha256")
    || sha256(exactDiff.target_main_sha256, "preview.exact_diff.target_main_sha256")
      !== sha256(target.sha256, "preview.selected_target.sha256")
    || count(exactDiff.before_visible_outer_units, "preview.exact_diff.before_visible_outer_units")
      !== count(currentMainFacts.visible_sellable_packages, "manifest current MAIN visible packages")
    || count(exactDiff.target_visible_outer_units, "preview.exact_diff.target_visible_outer_units")
      !== count(target.represented_outer_units, "preview target represented outer units")
    || !sameStringList(unchangedFields, [
      "title",
      "description",
      "bullet_points",
      "attributes",
      "price",
      "inventory",
      "gallery",
    ])
  ) {
    throw new Error(`${previewPath}: exact MAIN-only diff does not match source evidence`);
  }
  const effects = record(preview.external_effects, "preview.external_effects");
  zero(effects.walmart_listing_writes, "preview.external_effects.walmart_listing_writes");
  zero(effects.database_writes, "preview.external_effects.database_writes");
  zero(effects.model_calls, "preview.external_effects.model_calls");
  zero(effects.paid_api_calls, "preview.external_effects.paid_api_calls");
  return {
    canaryPreviewPath: path.relative(process.cwd(), previewPath),
    byteCustodyStatus: "VERIFIED",
  };
}

type VisualAttestationProjection = Pick<
  ListingIntegrityShadowCase,
  "visualAttestationStatus" | "visualAttestation"
>;

async function loadVisualAttestation(
  caseRoot: string,
  manifest: JsonRecord,
): Promise<VisualAttestationProjection> {
  const indexPath = path.join(caseRoot, VISUAL_ATTESTATION_INDEX_FILE);
  let indexArtifact: Awaited<ReturnType<typeof readShaBoundJson>>;
  try {
    indexArtifact = await readShaBoundJson({
      jsonPath: indexPath,
      shaPath: path.join(caseRoot, VISUAL_ATTESTATION_INDEX_SHA_FILE),
      label: "visual attestation index",
      maxBytes: 100_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { visualAttestationStatus: "PENDING" };
    }
    throw error;
  }
  const index = indexArtifact.body;
  exactKeys(index, [
    "schema_version", "selected_bundle_path", "selected_bundle_sha256",
    "status", "comparator_version", "owner_review", "authority",
  ], "visual attestation index");
  const status = text(index.status, "visual attestation index.status");
  if (index.schema_version !== "walmart-listing-integrity-visual-attestation-index/v1"
    || (status !== "SIGNED_TARGET_PASS_GALLERY_REVIEW_REQUIRED"
      && status !== "SIGNED_SHADOW_VISUAL_PASS")
    || index.comparator_version !== "walmart-visual-comparator/v5") {
    throw new Error(`${indexPath}: unsupported visual attestation selection`);
  }
  const bundlePath = resolveContainedPath({
    base: caseRoot,
    containmentRoot: caseRoot,
    relativePath: index.selected_bundle_path,
    label: "visual attestation index.selected_bundle_path",
  });
  if (path.basename(bundlePath) !== "bundle-manifest.json") {
    throw new Error(`${indexPath}: selected bundle must be bundle-manifest.json`);
  }
  const bundleArtifact = await readShaBoundJson({
    jsonPath: bundlePath,
    shaPath: path.join(path.dirname(bundlePath), "bundle-manifest.sha256"),
    label: "visual attestation bundle",
    maxBytes: 250_000,
  });
  if (digestSha256(bundleArtifact.bytes)
    !== sha256(index.selected_bundle_sha256, "visual attestation index.selected_bundle_sha256")) {
    throw new Error(`${bundlePath}: selected bundle SHA-256 mismatch`);
  }
  const bundle = bundleArtifact.body;
  exactKeys(bundle, [
    "schema_version", "created_at", "sku", "item_id", "partition_id",
    "status", "comparator_version", "files", "qualification", "external_effects",
  ], "visual attestation bundle");
  const manifestScope = record(manifest.scope, "manifest.scope");
  if (bundle.schema_version !== "walmart-listing-integrity-shadow-vision-evidence-bundle/v1"
    || bundle.status !== status
    || bundle.comparator_version !== index.comparator_version
    || bundle.sku !== manifestScope.sku
    || bundle.item_id !== manifestScope.item_id) {
    throw new Error(`${bundlePath}: visual attestation bundle scope mismatch`);
  }
  const files = record(bundle.files, "visual attestation bundle.files");
  exactKeys(files, [
    "authorization", "plan", "current_request", "current_response",
    "target_request", "target_response", "attestation",
  ], "visual attestation bundle.files");
  const bundleDir = path.dirname(bundlePath);
  const readBundleFile = async (key: string, maximum: number) => {
    const entry = record(files[key], `visual attestation bundle.files.${key}`);
    const pathname = resolveContainedPath({
      base: bundleDir,
      containmentRoot: caseRoot,
      relativePath: entry.path,
      label: `visual attestation bundle.files.${key}.path`,
    });
    const bytes = await readExactShaFile({
      pathname,
      expectedSha256: entry.sha256,
      label: `visual attestation bundle.files.${key}`,
      maxBytes: maximum,
    });
    return { entry, pathname, bytes };
  };
  const [authorization, plan, currentRequest, currentResponse, targetRequest, targetResponse, attestationFile] = await Promise.all([
    readBundleFile("authorization", 200_000),
    readBundleFile("plan", 2_000_000),
    readBundleFile("current_request", 24_000_000),
    readBundleFile("current_response", 5_000_000),
    readBundleFile("target_request", 24_000_000),
    readBundleFile("target_response", 5_000_000),
    readBundleFile("attestation", 5_000_000),
  ]);
  // Reading and hashing these exact bytes is deliberate: the UI must never
  // upgrade a status based only on an unbound summary file.
  void authorization;
  void plan;
  void currentRequest;
  void targetRequest;

  const attestation = record(
    JSON.parse(attestationFile.bytes.toString("utf8")),
    "visual attestation",
  );
  if (attestation.schema_version !== "walmart-listing-integrity-shadow-visual-attestation/v1"
    || attestation.status !== status
    || attestation.comparator_version !== index.comparator_version) {
    throw new Error(`${attestationFile.pathname}: visual attestation contract mismatch`);
  }
  const attestationEntryBodySha = sha256(
    attestationFile.entry.body_sha256,
    "visual attestation bundle.files.attestation.body_sha256",
  );
  const bodySha = sha256(attestation.body_sha256, "visual attestation.body_sha256");
  const artifactId = attestation.artifact_id;
  const attestationBody = { ...attestation };
  delete attestationBody.artifact_id;
  delete attestationBody.body_sha256;
  if (bodySha !== attestationEntryBodySha
    || digestSha256(Buffer.from(canonicalJson(attestationBody), "utf8")) !== bodySha
    || artifactId !== `walmart-shadow-visual-attestation-${bodySha.slice(0, 20)}`) {
    throw new Error(`${attestationFile.pathname}: visual attestation body seal mismatch`);
  }
  if (!Array.isArray(attestation.calls) || attestation.calls.length !== 2) {
    throw new Error(`${attestationFile.pathname}: visual attestation requires two calls`);
  }
  const calls = attestation.calls.map((value, indexNumber) => {
    const call = record(value, `visual attestation.calls[${indexNumber}]`);
    verifySignedWorkerReceipt(
      call.worker_receipt,
      `visual attestation.calls[${indexNumber}].worker_receipt`,
    );
    if (!Array.isArray(call.decisions)) {
      throw new Error(`visual attestation.calls[${indexNumber}].decisions must be an array`);
    }
    return {
      rawResponseSha256: sha256(
        call.raw_response_sha256,
        `visual attestation.calls[${indexNumber}].raw_response_sha256`,
      ),
      decisions: call.decisions.map((decision, decisionIndex) => (
        record(decision, `visual attestation.calls[${indexNumber}].decisions[${decisionIndex}]`)
      )),
    };
  });
  if (calls[0]!.rawResponseSha256 !== digestSha256(currentResponse.bytes)
    || calls[1]!.rawResponseSha256 !== digestSha256(targetResponse.bytes)) {
    throw new Error(`${attestationFile.pathname}: response byte binding mismatch`);
  }
  const currentMain = calls[0]!.decisions.filter((decision) => decision.slot === "main");
  const targetMain = calls[1]!.decisions.filter((decision) => decision.slot === "main");
  const gallery = calls[0]!.decisions.filter((decision) => decision.slot !== "main");
  const galleryBadCount = gallery.filter((decision) => decision.verdict === "BAD").length;
  const galleryReviewCount = gallery.filter((decision) => decision.verdict === "REVIEW").length;
  const qualification = record(attestation.qualification, "visual attestation.qualification");
  const ownerReview = record(index.owner_review, "visual attestation index.owner_review");
  const authority = record(index.authority, "visual attestation index.authority");
  if (currentMain.length !== 1 || currentMain[0]!.verdict !== "BAD"
    || targetMain.length !== 1 || targetMain[0]!.verdict !== "PASS"
    || galleryBadCount !== 0
    || qualification.current_main_defect_reproduced !== true
    || qualification.target_main_pass !== true
    || qualification.gallery_bad_count !== galleryBadCount
    || qualification.gallery_review_count !== galleryReviewCount
    || qualification.full_production_image_certificate !== false
    || qualification.live_canary_authorized !== false
    || ownerReview.current_main !== "BAD"
    || ownerReview.target_main !== "PASS"
    || ownerReview.gallery_bad_count !== galleryBadCount
    || ownerReview.gallery_review_count !== galleryReviewCount
    || ownerReview.gallery_review_required !== (galleryReviewCount > 0)
    || authority.live_canary_authorized !== false
    || authority.mass_run !== false) {
    throw new Error(`${attestationFile.pathname}: visual Qualification mismatch`);
  }
  const effects = record(attestation.external_effects, "visual attestation.external_effects");
  if (count(effects.claude_subscription_calls, "visual attestation calls") !== 2
    || count(effects.transport_attempts, "visual attestation attempts") !== 2) {
    throw new Error(`${attestationFile.pathname}: visual call accounting mismatch`);
  }
  for (const key of [
    "retries", "fallbacks", "paid_api_calls", "openai_model_calls",
    "walmart_reads", "walmart_writes", "database_writes",
  ]) zero(effects[key], `visual attestation.external_effects.${key}`);
  const worker = record(attestation.worker, "visual attestation.worker");
  if (worker.build !== TRUSTED_VISION_WORKER_BUILD
    || worker.key_id !== TRUSTED_VISION_KEY_ID
    || worker.public_key_spki_sha256 !== TRUSTED_VISION_KEY_SHA256) {
    throw new Error(`${attestationFile.pathname}: visual worker identity mismatch`);
  }
  return {
    visualAttestationStatus: status as ListingIntegrityShadowCase["visualAttestationStatus"],
    visualAttestation: {
      comparatorVersion: text(attestation.comparator_version, "visual attestation.comparator_version"),
      evidencePath: path.relative(process.cwd(), bundlePath),
      currentMainVerdict: "BAD",
      targetMainVerdict: "PASS",
      galleryBadCount: 0,
      galleryReviewCount,
      workerBuild: text(worker.build, "visual attestation.worker.build"),
      signedReceiptCount: calls.length,
    },
  };
}

type OwnerVisualReviewProjection = Pick<
  ListingIntegrityShadowCase,
  "ownerVisualReviewStatus" | "ownerVisualReview"
>;

async function loadOwnerVisualReview(
  caseRoot: string,
  manifest: JsonRecord,
): Promise<OwnerVisualReviewProjection> {
  const indexPath = path.join(caseRoot, OWNER_VISUAL_REVIEW_INDEX_FILE);
  let indexArtifact: Awaited<ReturnType<typeof readShaBoundJson>>;
  try {
    indexArtifact = await readShaBoundJson({
      jsonPath: indexPath,
      shaPath: path.join(caseRoot, OWNER_VISUAL_REVIEW_INDEX_SHA_FILE),
      label: "owner visual review index",
      maxBytes: 50_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ownerVisualReviewStatus: "PENDING" };
    }
    throw error;
  }
  const index = indexArtifact.body;
  exactKeys(index, ["schema_version", "selected_review"], "owner visual review index");
  if (index.schema_version !== "walmart-listing-integrity-owner-visual-review-index/v1") {
    throw new Error(`${indexPath}: unsupported owner visual review index`);
  }
  const selected = record(index.selected_review, "owner visual review index.selected_review");
  exactKeys(selected, ["path", "sha256"], "owner visual review index.selected_review");
  const reviewPath = resolveContainedPath({
    base: caseRoot,
    containmentRoot: caseRoot,
    relativePath: selected.path,
    label: "owner visual review index.selected_review.path",
  });
  const reviewBytes = await readExactShaFile({
    pathname: reviewPath,
    expectedSha256: selected.sha256,
    label: "owner visual review",
    maxBytes: 100_000,
  });
  const review = record(JSON.parse(reviewBytes.toString("utf8")), "owner visual review");
  exactKeys(review, [
    "schema_version", "recorded_at", "decision", "scope", "reviewed_artifacts",
    "owner_observation", "authority_boundary", "external_effects",
  ], "owner visual review");
  if (review.schema_version !== "walmart-listing-integrity-owner-visual-review/v1"
    || review.decision !== "APPROVED_FOR_EXACT_LIVE_CANARY_DIFF_PREPARATION") {
    throw new Error(`${reviewPath}: unsupported owner visual review decision`);
  }
  const manifestScope = record(manifest.scope, "manifest.scope");
  const scope = record(review.scope, "owner visual review.scope");
  exactKeys(scope, [
    "channel", "store_index", "sku", "item_id", "expected_outer_units",
  ], "owner visual review.scope");
  if (scope.channel !== "WALMART_US"
    || count(scope.store_index, "owner visual review.scope.store_index")
      !== count(manifestScope.store_index, "manifest.scope.store_index")
    || text(scope.sku, "owner visual review.scope.sku")
      !== text(manifestScope.sku, "manifest.scope.sku")
    || text(scope.item_id, "owner visual review.scope.item_id")
      !== text(manifestScope.item_id, "manifest.scope.item_id")
    || count(scope.expected_outer_units, "owner visual review.scope.expected_outer_units")
      !== count(record(manifest.product_truth, "manifest.product_truth").outer_units,
        "manifest.product_truth.outer_units")) {
    throw new Error(`${reviewPath}: owner visual review scope mismatch`);
  }
  const reviewed = record(review.reviewed_artifacts, "owner visual review.reviewed_artifacts");
  exactKeys(reviewed, [
    "canary_preview_path", "canary_preview_sha256", "owner_gallery_path",
    "owner_gallery_sha256",
  ], "owner visual review.reviewed_artifacts");
  const [previewBytes, galleryBytes] = await Promise.all([
    readFile(path.join(caseRoot, "canary-preview.json")),
    readFile(path.join(caseRoot, "owner-gallery.html")),
  ]);
  if (sha256(reviewed.canary_preview_sha256,
    "owner visual review.reviewed_artifacts.canary_preview_sha256")
      !== digestSha256(previewBytes)
    || sha256(reviewed.owner_gallery_sha256,
      "owner visual review.reviewed_artifacts.owner_gallery_sha256")
      !== digestSha256(galleryBytes)) {
    throw new Error(`${reviewPath}: reviewed artifact byte binding mismatch`);
  }
  text(reviewed.canary_preview_path,
    "owner visual review.reviewed_artifacts.canary_preview_path");
  text(reviewed.owner_gallery_path,
    "owner visual review.reviewed_artifacts.owner_gallery_path");
  const observation = record(review.owner_observation, "owner visual review.owner_observation");
  exactKeys(observation, [
    "current_main_is_one_package", "proposed_main_is_six_packages",
    "proposed_main_accepted", "existing_gallery_accepted", "owner_words",
  ], "owner visual review.owner_observation");
  exactTrue(observation.current_main_is_one_package,
    "owner visual review.owner_observation.current_main_is_one_package");
  exactTrue(observation.proposed_main_is_six_packages,
    "owner visual review.owner_observation.proposed_main_is_six_packages");
  exactTrue(observation.proposed_main_accepted,
    "owner visual review.owner_observation.proposed_main_accepted");
  exactTrue(observation.existing_gallery_accepted,
    "owner visual review.owner_observation.existing_gallery_accepted");
  text(observation.owner_words, "owner visual review.owner_observation.owner_words");
  const authority = record(review.authority_boundary, "owner visual review.authority_boundary");
  exactKeys(authority, [
    "exact_diff_preparation_authorized", "walmart_listing_write_authorized",
    "mass_run_authorized", "reprice_authorized", "inventory_change_authorized",
    "delist_authorized",
  ], "owner visual review.authority_boundary");
  exactTrue(authority.exact_diff_preparation_authorized,
    "owner visual review.authority_boundary.exact_diff_preparation_authorized");
  for (const field of [
    "walmart_listing_write_authorized", "mass_run_authorized", "reprice_authorized",
    "inventory_change_authorized", "delist_authorized",
  ]) exactFalse(authority[field], `owner visual review.authority_boundary.${field}`);
  const effects = record(review.external_effects, "owner visual review.external_effects");
  exactKeys(effects, [
    "walmart_listing_writes", "database_writes", "network_calls", "model_calls",
    "paid_api_calls",
  ], "owner visual review.external_effects");
  for (const [field, value] of Object.entries(effects)) {
    zero(value, `owner visual review.external_effects.${field}`);
  }
  return {
    ownerVisualReviewStatus: "APPROVED",
    ownerVisualReview: {
      reviewedAt: text(review.recorded_at, "owner visual review.recorded_at"),
      evidencePath: path.relative(process.cwd(), reviewPath),
      reviewSha256: sha256(selected.sha256, "owner visual review index.selected_review.sha256"),
      currentMainAcceptedAsOnePackage: true,
      proposedMainAcceptedAsSixPackages: true,
      galleryAccepted: true,
      walmartWriteAuthorized: false,
    },
  };
}

function projectCase(
  raw: unknown,
  evidencePath: string,
  custody: { canaryPreviewPath: string; byteCustodyStatus: "VERIFIED" },
  visual: VisualAttestationProjection,
  ownerReview: OwnerVisualReviewProjection,
): ListingIntegrityShadowCase {
  const manifest = record(raw, "fresh control manifest");
  if (manifest.schema_version !== "walmart-listing-integrity-fresh-control/v1") {
    throw new Error(`${evidencePath}: unsupported fresh control schema`);
  }
  const scope = record(manifest.scope, "manifest.scope");
  const source = record(manifest.marketplace_source, "manifest.marketplace_source");
  const buyer = record(manifest.buyer_source, "manifest.buyer_source");
  const truth = record(manifest.product_truth, "manifest.product_truth");
  const algorithm = record(manifest.algorithm_result, "manifest.algorithm_result");
  const before = record(algorithm.before, "manifest.algorithm_result.before");
  const proposed = record(
    algorithm.proposed_after_offline_component,
    "manifest.algorithm_result.proposed_after_offline_component",
  );
  const candidate = record(manifest.approved_repair_candidate, "manifest.approved_repair_candidate");
  const candidateFacts = record(candidate.manual_visual_facts, "candidate.manual_visual_facts");
  if (!Array.isArray(manifest.current_images) || manifest.current_images.length < 1) {
    throw new Error(`${evidencePath}: current_images must be non-empty`);
  }
  const currentImages = manifest.current_images;
  const images = currentImages.map((image, index) => (
    imageFromManifest(image, `manifest.current_images[${index}]`)
  ));
  const mainCandidates = currentImages.filter((image, index) => (
    record(image, `manifest.current_images[${index}]`).slot === "MAIN"
  ));
  if (mainCandidates.length !== 1) {
    throw new Error(`${evidencePath}: current_images must contain exactly one MAIN`);
  }
  const main = record(mainCandidates[0], "manifest.current_images[MAIN]");
  const mainFacts = record(main.manual_visual_facts, "MAIN.manual_visual_facts");
  const beforeVerdict = text(before.verdict, "algorithm.before.verdict");
  const proposedVerdict = text(proposed.main_verdict, "algorithm.proposed.main_verdict");
  if (!["BAD", "REVIEW", "PASS"].includes(beforeVerdict)
    || !["BAD", "REVIEW", "PASS"].includes(proposedVerdict)) {
    throw new Error(`${evidencePath}: unsupported integrity verdict`);
  }
  return {
    controlId: text(manifest.control_id, "manifest.control_id"),
    capturedAt: text(manifest.captured_at, "manifest.captured_at"),
    sku: text(scope.sku, "manifest.scope.sku"),
    itemId: text(scope.item_id, "manifest.scope.item_id"),
    title: text(buyer.title, "manifest.buyer_source.title"),
    publishedStatus: text(source.seller_published_status, "source.seller_published_status"),
    lifecycleStatus: text(source.seller_lifecycle_status, "source.seller_lifecycle_status"),
    expectedOuterUnits: count(truth.outer_units, "product_truth.outer_units"),
    observedMainUnits: count(mainFacts.visible_sellable_packages, "MAIN.visible_sellable_packages"),
    currentImages: images,
    proposedMain: {
      slot: "MAIN",
      url: exactImageUrl(candidate.asset_url, "candidate.asset_url"),
      sha256: sha256(candidate.sha256, "candidate.sha256"),
      width: count(candidate.width, "candidate.width"),
      height: count(candidate.height, "candidate.height"),
      role: "proposed_repair",
      representedOuterUnits: count(candidateFacts.visible_sellable_packages, "candidate.visible_sellable_packages"),
    },
    beforeVerdict: beforeVerdict as ListingIntegrityShadowCase["beforeVerdict"],
    beforeReason: text(before.blocking_reason, "algorithm.before.blocking_reason"),
    proposedMainVerdict: proposedVerdict as ListingIntegrityShadowCase["proposedMainVerdict"],
    qualification: text(algorithm.full_qualification, "algorithm.full_qualification"),
    changedFields: stringList(candidate.changed_fields, "candidate.changed_fields"),
    evidencePath,
    canaryPreviewPath: custody.canaryPreviewPath,
    byteCustodyStatus: custody.byteCustodyStatus,
    visualAttestationStatus: visual.visualAttestationStatus,
    ...(visual.visualAttestation ? { visualAttestation: visual.visualAttestation } : {}),
    ownerVisualReviewStatus: ownerReview.ownerVisualReviewStatus,
    ...(ownerReview.ownerVisualReview
      ? { ownerVisualReview: ownerReview.ownerVisualReview }
      : {}),
    limitations: [
      ...stringList(manifest.limitations, "manifest.limitations"),
      ...(visual.visualAttestation?.galleryReviewCount
        && ownerReview.ownerVisualReviewStatus !== "APPROVED"
        ? ["Signed vision found no BAD gallery image; lifestyle and Nutrition Facts still require owner visual review because they do not independently expose the full product identity."]
        : []),
    ],
  };
}

export async function loadListingIntegrityShadowData(
  root = DEFAULT_ROOT,
  catalogRoot: string | null = path.resolve(root) === path.resolve(DEFAULT_ROOT)
    ? DEFAULT_CATALOG_ROOT
    : null,
  captureRoot: string | null = path.resolve(root) === path.resolve(DEFAULT_ROOT)
    ? DEFAULT_CAPTURE_ROOT
    : null,
): Promise<ListingIntegrityShadowData> {
  let entries: Dirent[];
  let rootExists = true;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      entries = [];
      rootExists = false;
    }
    else throw error;
  }
  const engine = rootExists
    ? await loadVerification(root)
    : {
        closedLoopTestsPassed: 0,
        focusedTestsPassed: 0,
        visualComparatorTestsPassed: 0,
        observationTestsPassed: 0,
        workerSecurityTestsPassed: 0,
        shadowTestsPassed: 0,
        historicalCases: 0,
        walmartWrites: 0 as const,
      };
  const productTruth: ListingIntegrityProductTruthReadiness = rootExists
    ? await loadProductTruthReadiness(root)
    : {
        status: "UNVERIFIED",
        capturedAt: null,
        sourceContract: null,
        schemaReady: false,
        pendingMigrations: null,
        listingKey: null,
        blockers: [],
        executionPackageReady: false,
        walmartWriteAuthorized: false,
        massRunAuthorized: false,
        sharedPlanPath: null,
        sharedPlanSha256: null,
        evidencePath: null,
        evidenceSha256: null,
      };
  const cases: ListingIntegrityShadowCase[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/u.test(entry.name)) continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    const bytes = await readFile(manifestPath);
    if (bytes.byteLength > 1_000_000) {
      throw new Error(`${manifestPath}: manifest exceeds 1 MB`);
    }
    const manifest = record(JSON.parse(bytes.toString("utf8")), "fresh control manifest");
    const custody = await verifyCanaryPreview({
      caseRoot: path.join(root, entry.name),
      manifest,
      manifestBytes: bytes,
    });
    const visual = await loadVisualAttestation(path.join(root, entry.name), manifest);
    const ownerReview = await loadOwnerVisualReview(path.join(root, entry.name), manifest);
    cases.push(projectCase(
      manifest,
      path.relative(process.cwd(), manifestPath),
      custody,
      visual,
      ownerReview,
    ));
  }
  const catalog = await loadCatalogOverview(catalogRoot, captureRoot);
  return {
    mode: "SHADOW_READ_ONLY",
    catalog,
    productTruth,
    engine,
    cases,
    gates: {
      productTruth: productTruth.status,
      liveCanary: "LOCKED",
      massRun: "LOCKED",
      next: productTruth.status === "BLOCKED_SCHEMA_NOT_READY"
        ? `Canonical Product Truth schema is not ready; ${String(productTruth.pendingMigrations ?? "unknown")} migrations remain.`
        : productTruth.status === "BLOCKED_SKU_TRUTH_NOT_READY"
        ? `Canonical Product Truth schema is ready, but ${productTruth.listingKey ?? "the exact listing"} is blocked: ${productTruth.blockers.join(", ")}.`
        : productTruth.status === "UNVERIFIED"
        ? "Canonical Product Truth has not been verified; the exact execution package remains locked."
        : cases.length > 0 && cases.every((entry) => entry.ownerVisualReviewStatus === "APPROVED")
        ? "Owner visual review is complete. Build the exact one-SKU execution package; Walmart write remains separately locked."
        : "Owner reviews the signed current gallery and exact MAIN diff; live canary remains locked until separate approval.",
    },
  };
}
