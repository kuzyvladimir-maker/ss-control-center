import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type {
  ListingIntegrityShadowCase,
  ListingIntegrityShadowData,
  ListingIntegrityShadowImage,
} from "./listing-integrity-shadow-contract";

type JsonRecord = Record<string, unknown>;

const DEFAULT_ROOT = path.join(
  process.cwd(),
  "data",
  "audits",
  "walmart-listing-integrity-fresh-controls",
);

const VERIFICATION_FILE = "_verification.json";
const VERIFICATION_SHA_FILE = "_verification.sha256";

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10_000) {
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

function zero(value: unknown, label: string): void {
  if (count(value, label) !== 0) throw new Error(`${label} must remain zero in shadow mode`);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
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
    shadowTestsPassed: count(current.shadow_loader_assertions_passed, "verification.current_verification.shadow_loader_assertions_passed")
      + count(current.shadow_ui_assertions_passed, "verification.current_verification.shadow_ui_assertions_passed"),
    historicalCases: count(verification.historical_controls, "verification.historical_controls"),
    walmartWrites: 0 as const,
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

function projectCase(
  raw: unknown,
  evidencePath: string,
  custody: { canaryPreviewPath: string; byteCustodyStatus: "VERIFIED" },
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
    visualAttestationStatus: "PENDING",
    limitations: stringList(manifest.limitations, "manifest.limitations"),
  };
}

export async function loadListingIntegrityShadowData(
  root = DEFAULT_ROOT,
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
        shadowTestsPassed: 0,
        historicalCases: 0,
        walmartWrites: 0 as const,
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
    cases.push(projectCase(
      manifest,
      path.relative(process.cwd(), manifestPath),
      custody,
    ));
  }
  return {
    mode: "SHADOW_READ_ONLY",
    engine,
    cases,
    gates: {
      liveCanary: "LOCKED",
      massRun: "LOCKED",
      next: "Seal current MAIN + gallery visual evidence before one-SKU canary approval.",
    },
  };
}
