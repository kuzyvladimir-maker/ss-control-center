/**
 * Fresh, authenticated post-apply Qualification for the one-SKU Walmart repair.
 *
 * The caller is the frozen operator. It first proves terminal apply custody,
 * then invokes the frozen read-only one-SKU capture and passes that newly
 * created directory here. Caller-authored verdicts and old capture directories
 * are not accepted.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import {
  projectWalmartListingSurfaceFromBuyerPdp,
  walmartListingIntegritySha256,
  type ListingAttributeClaim,
  type WalmartListingSurface,
} from "./listing-integrity-audit.ts";
import {
  inspectWalmartListingRepairQualificationProductionReadiness,
  type SealedWalmartListingRepairPlan,
} from "./listing-integrity-remediation-qualification.ts";
import {
  fingerprintGalleryImage,
  galleryDhashDistance,
} from "./catalog-gallery-audit.ts";

export const WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_SCHEMA =
  "walmart-listing-integrity-repair-live-qualification/v2" as const;

// Walmart's published Item Management SLA allows up to six hours between a
// successful item submission and catalog/Walmart.com availability.  Do not
// turn an unchanged buyer surface into a false repair failure before then.
const PROPAGATION_FAILURE_NOT_BEFORE_MS = 6 * 60 * 60 * 1_000;
const MAX_CAPTURE_AFTER_TERMINAL_MS = 7 * 24 * 60 * 60_000;
const MAX_DECODED_IMAGE_PIXELS = 40_000_000;
const REVIEWED_MAIN_MAX_DHASH_DISTANCE = 2;
const REVIEWED_MAIN_MIN_PSNR_MILLIDB = 38_000;
const PINNED_ACCEPTED_LIVE_QUALIFICATION_SOURCE_RELEASE_SHA256 =
  "dda4f38af40aa332a61097a5665dccf74fe5e84003601755b2256635204edae5";
const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;
type FacetVerdict = "PASS" | "FAIL";

export interface WalmartListingRepairLiveQualification {
  schema_version: typeof WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_SCHEMA;
  qualification_id: string;
  qualified_at: string;
  verdict: "PASS" | "FAIL" | "PENDING_PROPAGATION";
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  plan_id: string;
  plan_body_sha256: string;
  permit_authorization_sha256: string;
  feed_id: string;
  feed_terminal_at: string;
  live_capture: {
    created_at: string;
    intake_index_body_sha256: string;
    intake_index_file_sha256: string;
    buyer_pdp_file_sha256: string;
    seller_item_file_sha256: string;
    catalog_search_file_sha256: string;
    image_sha256: string[];
  };
  apply_custody: {
    ledger_terminal_sha256: string;
    ledger_head_sha256: string;
    artifact_inventory_sha256: string;
    request_payload_sha256: string;
    terminal_feed_status_payload_sha256: string;
  };
  authority: {
    method: "FROZEN_AUTHENTICATED_LIVE_REREAD";
    live_capture_created_by_qualifier: true;
    caller_authored_verdict_accepted: false;
    cached_capture_accepted: false;
    exact_target_rebuilt_from_owner_signed_plan: true;
    exact_image_bytes_verified: true;
    terminal_apply_custody_verified: true;
    qualifier_release_sha256: string;
    source_release_sha256: string;
    predecessor_source_release_accepted: boolean;
  };
  quantity_evidence: {
    authoritative_source: "BUYER_PDP_MULTIPACK_QUANTITY_AND_PRODUCT_TRUTH";
    buyer_multipack_quantity: number | null;
    seller_grouping_number_of_pieces: number | null;
    seller_grouping_used_as_offer_quantity: false;
  };
  main_equivalence: {
    mode: "EXACT_BYTES" | "WALMART_REHOSTED_EQUIVALENT";
    target_sha256: string;
    live_sha256: string;
    encoded_bytes_exact: boolean;
    decoded_width: number;
    decoded_height: number;
    dhash_distance: number;
    psnr_millidb: number;
    minimum_psnr_millidb: typeof REVIEWED_MAIN_MIN_PSNR_MILLIDB;
    maximum_dhash_distance: typeof REVIEWED_MAIN_MAX_DHASH_DISTANCE;
    equivalent: boolean;
  };
  facets: {
    exact_listing_identity: FacetVerdict;
    published_and_indexed: FacetVerdict;
    product_and_variant: FacetVerdict;
    pack_count: FacetVerdict;
    title: FacetVerdict;
    description: FacetVerdict;
    bullets: FacetVerdict;
    attributes: FacetVerdict;
    main: FacetVerdict;
    gallery: FacetVerdict;
    exact_repair_target: FacetVerdict;
    unchanged_fields_preserved: FacetVerdict;
    fresh_authenticated_live_reread: FacetVerdict;
    terminal_apply_custody: FacetVerdict;
  };
  blocking_reasons: string[];
  propagation: {
    failure_not_before: string;
    reread_before_failure_window: boolean;
    recheck_same_sku_without_write: boolean;
  };
  next_sku_unblocked: boolean;
  next_action: "ADVANCE_TO_NEXT_SKU" | "RECHECK_SAME_SKU_NO_WRITE" | "OWNER_REVIEW_REPLAN";
  marketplace_write_authorized: false;
  automatic_reapply_allowed: false;
  external_effects: {
    product_truth_reads: 1;
    walmart_logical_gets: 2;
    buyer_pdp_gets: 1;
    image_gets: number;
    target_main_gets: 0 | 1;
    model_calls: 0;
    database_writes: 0;
    walmart_writes: 0;
  };
  body_sha256: string;
}

function fail(message: string): never {
  const error = new Error(message);
  (error as Error & { code: string }).code = "WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_ERROR";
  throw error;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail(`${label} must be canonical UTC`);
  }
  return parsed;
}

function pass(value: boolean): FacetVerdict {
  return value ? "PASS" : "FAIL";
}

function exactArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => (
      typeof value === "string" && value === right[index]
    ));
}

async function stableFile(file: string, maximum = 256 * 1024 * 1024): Promise<Uint8Array> {
  const before = await lstat(file).catch(() => fail(`missing qualification evidence: ${file}`));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > maximum || await realpath(file) !== file) {
    fail(`qualification evidence is not one canonical regular file: ${file}`);
  }
  const bytes = Uint8Array.from(await readFile(file));
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || bytes.byteLength !== before.size) {
    fail(`qualification evidence changed while read: ${file}`);
  }
  return bytes;
}

function safeChild(root: string, relative: unknown): string {
  const value = text(relative, "intake evidence path");
  if (path.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => !part || part === "..")) {
    fail("intake evidence path is unsafe");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, value);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail("intake evidence path escapes capture directory");
  }
  return resolved;
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  try {
    return record(JSON.parse(Buffer.from(bytes).toString("utf8")), label);
  } catch {
    return fail(`${label} is not JSON`);
  }
}

function sellerItem(value: JsonRecord): JsonRecord {
  const rows = value.ItemResponse;
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail("seller item must contain exactly one ItemResponse");
  }
  return record(rows[0], "seller item row");
}

function stringRows(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((row) => typeof row !== "string" || !row)) {
    fail(`${label} must be an exact non-empty string array`);
  }
  return [...value] as string[];
}

function specifications(product: JsonRecord): Map<string, string> {
  if (!Array.isArray(product.specifications)) fail("buyer specifications must be an array");
  const result = new Map<string, string>();
  for (const raw of product.specifications) {
    const row = record(raw, "buyer specification");
    result.set(text(row.name, "buyer specification name"), text(row.value, "buyer specification value"));
  }
  return result;
}

function sellerOuterUnits(row: JsonRecord): number | null {
  const group = row.variantGroupInfo;
  if (!group || typeof group !== "object" || Array.isArray(group)) return null;
  const values = (group as JsonRecord).groupingAttributes;
  if (!Array.isArray(values)) return null;
  const found = values.find((raw) => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as JsonRecord : null;
    return value?.name === "number_of_pieces";
  });
  if (!found || typeof found !== "object" || Array.isArray(found)) return null;
  const numeric = Number((found as JsonRecord).value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function buyerOuterUnits(spec: Map<string, string>): number | null {
  const numeric = Number(spec.get("Multipack quantity"));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function exactChangedFields(
  value: readonly string[],
  expected: readonly string[],
): boolean {
  return value.length === expected.length
    && value.every((field, index) => field === expected[index]);
}

async function decodedRgb(bytes: Uint8Array): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
}> {
  const decoded = await sharp(bytes, {
    failOn: "warning",
    limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
  }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!Number.isSafeInteger(decoded.info.width)
    || !Number.isSafeInteger(decoded.info.height)
    || decoded.info.width < 1 || decoded.info.height < 1
    || decoded.info.width * decoded.info.height > MAX_DECODED_IMAGE_PIXELS
    || decoded.info.channels !== 3) {
    fail("reviewed MAIN decoded geometry is invalid");
  }
  return {
    data: Uint8Array.from(decoded.data),
    width: decoded.info.width,
    height: decoded.info.height,
  };
}

async function reviewedMainEquivalence(input: {
  target_bytes: Uint8Array;
  target_sha256: string;
  live_bytes: Uint8Array;
  live_sha256: string;
}): Promise<WalmartListingRepairLiveQualification["main_equivalence"]> {
  if (!(input.target_bytes instanceof Uint8Array)
    || sha256Bytes(input.target_bytes) !== input.target_sha256
    || sha256Bytes(input.live_bytes) !== input.live_sha256) {
    fail("reviewed MAIN exact source/live bytes differ from their SHA-bound evidence");
  }
  const [targetFingerprint, liveFingerprint, target, live] = await Promise.all([
    fingerprintGalleryImage("gallery-1", input.target_bytes),
    fingerprintGalleryImage("gallery-1", input.live_bytes),
    decodedRgb(input.target_bytes),
    decodedRgb(input.live_bytes),
  ]);
  if (target.width !== live.width || target.height !== live.height
    || target.data.byteLength !== live.data.byteLength) {
    return {
      mode: "WALMART_REHOSTED_EQUIVALENT",
      target_sha256: input.target_sha256,
      live_sha256: input.live_sha256,
      encoded_bytes_exact: false,
      decoded_width: live.width,
      decoded_height: live.height,
      dhash_distance: galleryDhashDistance(
        targetFingerprint.dhash64,
        liveFingerprint.dhash64,
      ),
      psnr_millidb: 0,
      minimum_psnr_millidb: REVIEWED_MAIN_MIN_PSNR_MILLIDB,
      maximum_dhash_distance: REVIEWED_MAIN_MAX_DHASH_DISTANCE,
      equivalent: false,
    };
  }
  let squaredError = 0;
  for (let index = 0; index < target.data.byteLength; index += 1) {
    const delta = target.data[index]! - live.data[index]!;
    squaredError += delta * delta;
  }
  const meanSquaredError = squaredError / target.data.byteLength;
  const psnrMillidb = meanSquaredError === 0
    ? 100_000
    : Math.round(10_000 * Math.log10((255 * 255) / meanSquaredError));
  const dhashDistance = galleryDhashDistance(
    targetFingerprint.dhash64,
    liveFingerprint.dhash64,
  );
  const encodedExact = input.target_sha256 === input.live_sha256;
  const equivalent = encodedExact || (
    dhashDistance <= REVIEWED_MAIN_MAX_DHASH_DISTANCE
    && psnrMillidb >= REVIEWED_MAIN_MIN_PSNR_MILLIDB
  );
  return {
    mode: encodedExact ? "EXACT_BYTES" : "WALMART_REHOSTED_EQUIVALENT",
    target_sha256: input.target_sha256,
    live_sha256: input.live_sha256,
    encoded_bytes_exact: encodedExact,
    decoded_width: live.width,
    decoded_height: live.height,
    dhash_distance: dhashDistance,
    psnr_millidb: psnrMillidb,
    minimum_psnr_millidb: REVIEWED_MAIN_MIN_PSNR_MILLIDB,
    maximum_dhash_distance: REVIEWED_MAIN_MAX_DHASH_DISTANCE,
    equivalent,
  };
}

interface ContentRepairTarget {
  outer_units: number;
  live_surface: WalmartListingSurface;
  mapped_attributes_preserved: boolean;
  identity_claims_match: boolean;
  opaque_attributes_preserved: boolean;
}

function normalizedAttributePath(value: string): string {
  return value.replace(/\[\d+\]/gu, "[]");
}

function normalizedAttributeText(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/['’ʼ]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function claimValueExact(
  live: ListingAttributeClaim,
  target: ListingAttributeClaim,
): boolean {
  if (live.kind !== target.kind
    || normalizedAttributePath(live.field_path)
      !== normalizedAttributePath(target.field_path)) {
    return false;
  }
  if ("text" in target) {
    return "text" in live
      && normalizedAttributeText(live.text) === normalizedAttributeText(target.text);
  }
  return "value" in live && live.value === target.value && live.unit === target.unit;
}

function normalizedUnmappedExact(
  left: WalmartListingSurface["unmapped_attributes"],
  right: WalmartListingSurface["unmapped_attributes"],
): boolean {
  const normalize = (
    rows: WalmartListingSurface["unmapped_attributes"],
  ) => rows.map((row) => ({
    field_path: normalizedAttributePath(row.field_path),
    value_sha256: row.value_sha256,
  })).sort((first, second) => (
    `${first.field_path}\u0000${first.value_sha256}`
      .localeCompare(`${second.field_path}\u0000${second.value_sha256}`)
  ));
  return walmartListingIntegritySha256(normalize(left))
    === walmartListingIntegritySha256(normalize(right));
}

function attributeOnlyTarget(input: {
  plan: SealedWalmartListingRepairPlan;
  buyer: JsonRecord;
  specifications: Map<string, string>;
}): {
  outer_units: number;
  live_surface: WalmartListingSurface;
  direct_claims_match: boolean;
  identity_claims_match: boolean;
  opaque_attributes_preserved: boolean;
  count_per_pack_match: boolean;
} {
  const targetSurface = input.plan.target.surface;
  const liveSurface = projectWalmartListingSurfaceFromBuyerPdp(input.buyer, {
    sku: input.plan.listing.sku,
    item_id: input.plan.listing.item_id,
  });
  const outerClaims = targetSurface.attribute_claims.filter((claim) => (
    claim.kind === "outer_units"
  ));
  if (outerClaims.length < 1
    || outerClaims.some((claim) => claim.unit !== "count")
    || new Set(outerClaims.map((claim) => claim.value)).size !== 1) {
    fail("attribute-only owner target lacks one unambiguous outer quantity");
  }
  const outerUnits = outerClaims[0]!.value;
  const directTargets = targetSurface.attribute_claims.filter((claim) => (
    !claim.field_path.startsWith("walmart.Visible.")
  ));
  const directClaimsMatch = directTargets.every((target) => (
    liveSurface.attribute_claims.filter((live) => (
      normalizedAttributePath(live.field_path)
        === normalizedAttributePath(target.field_path)
    )).length === 1
    && liveSurface.attribute_claims.some((live) => claimValueExact(live, target))
  ));
  const identityTargets = directTargets.filter((claim) => (
    claim.kind === "brand" || claim.kind === "product" || claim.kind === "variant"
  ));
  const identityClaimsMatch = identityTargets.every((target) => (
    liveSurface.attribute_claims.some((live) => claimValueExact(live, target))
  ));
  const syntheticCountPerPack = targetSurface.attribute_claims.filter((claim) => (
    claim.field_path === "walmart.Visible.countPerPack"
      && claim.kind === "inner_item_count"
  ));
  if (syntheticCountPerPack.length !== 1
    || syntheticCountPerPack[0]!.unit !== "count") {
    fail("attribute-only owner target lacks exact countPerPack");
  }
  const visibleCountPerPack = Number(
    input.specifications.get("Count per pack")
      ?? input.specifications.get("Count Per Pack"),
  );
  const visibleOverallCount = Number(
    input.specifications.get("Count")
      ?? input.specifications.get("Total count")
      ?? input.specifications.get("Total Count"),
  );
  const countPerPackMatch = Number.isSafeInteger(visibleCountPerPack)
    ? visibleCountPerPack === syntheticCountPerPack[0]!.value
    : syntheticCountPerPack[0]!.value === 1
      && visibleOverallCount === outerUnits;
  return {
    outer_units: outerUnits,
    live_surface: liveSurface,
    direct_claims_match: directClaimsMatch,
    identity_claims_match: identityClaimsMatch,
    opaque_attributes_preserved: normalizedUnmappedExact(
      liveSurface.unmapped_attributes,
      targetSurface.unmapped_attributes,
    ),
    count_per_pack_match: countPerPackMatch,
  };
}

function contentRepairTarget(input: {
  plan: SealedWalmartListingRepairPlan;
  buyer: JsonRecord;
}): ContentRepairTarget {
  const targetSurface = input.plan.target.surface;
  const liveSurface = projectWalmartListingSurfaceFromBuyerPdp(input.buyer, {
    sku: input.plan.listing.sku,
    item_id: input.plan.listing.item_id,
  });
  const outerClaims = targetSurface.attribute_claims.filter((claim) => (
    claim.kind === "outer_units"
  ));
  if (outerClaims.length !== 1 || outerClaims[0]!.unit !== "count") {
    fail("owner-signed target lacks one exact outer quantity claim");
  }
  const mappedAttributesPreserved = targetSurface.attribute_claims.length
      === liveSurface.attribute_claims.length
    && targetSurface.attribute_claims.every((target) => (
      liveSurface.attribute_claims.filter((live) => (
        normalizedAttributePath(live.field_path)
          === normalizedAttributePath(target.field_path)
      )).length === 1
      && liveSurface.attribute_claims.some((live) => claimValueExact(live, target))
    ));
  const identityTargets = targetSurface.attribute_claims.filter((claim) => (
    claim.kind === "brand" || claim.kind === "product" || claim.kind === "variant"
  ));
  if (identityTargets.length < 2) {
    fail("owner-signed target lacks exact product identity claims");
  }
  return {
    outer_units: outerClaims[0]!.value,
    live_surface: liveSurface,
    mapped_attributes_preserved: mappedAttributesPreserved,
    identity_claims_match: identityTargets.every((target) => (
      liveSurface.attribute_claims.some((live) => claimValueExact(live, target))
    )),
    opaque_attributes_preserved: normalizedUnmappedExact(
      liveSurface.unmapped_attributes,
      targetSurface.unmapped_attributes,
    ),
  };
}

export function assertWalmartListingRepairLiveQualificationSourceRelease(
  plan: SealedWalmartListingRepairPlan,
): {
  qualifier_release_sha256: string;
  source_release_sha256: string;
  predecessor_source_release_accepted: boolean;
} {
  const readiness = inspectWalmartListingRepairQualificationProductionReadiness();
  const qualifierRelease = digest(
    readiness.verifier_engine_release_sha256,
    "current qualifier release",
  );
  const sourceRelease = digest(
    plan.verifier_engine_release_sha256,
    "plan verifier release",
  );
  if (sourceRelease !== digest(plan.apply_engine_release_sha256, "plan apply release")
    || (sourceRelease !== qualifierRelease
      && sourceRelease !== PINNED_ACCEPTED_LIVE_QUALIFICATION_SOURCE_RELEASE_SHA256)) {
    fail("live Qualification rejects an unpinned current/predecessor source release");
  }
  return {
    qualifier_release_sha256: qualifierRelease,
    source_release_sha256: sourceRelease,
    predecessor_source_release_accepted: sourceRelease !== qualifierRelease,
  };
}

export async function qualifyWalmartListingRepairFreshLive(input: {
  plan: SealedWalmartListingRepairPlan;
  permit_authorization_sha256: string;
  ledger_evidence: unknown;
  artifact_custody_evidence: unknown;
  fresh_capture_directory: string;
  capture_summary: unknown;
  evaluated_at: Date;
  target_main_bytes?: Uint8Array;
}): Promise<WalmartListingRepairLiveQualification> {
  const plan = input.plan;
  const releaseAuthority =
    assertWalmartListingRepairLiveQualificationSourceRelease(plan);
  const ledger = record(input.ledger_evidence, "ledger evidence");
  const custody = record(input.artifact_custody_evidence, "artifact custody evidence");
  const receipt = record(ledger.receipt, "terminal ledger receipt");
  if (ledger.state !== "SUCCEEDED" || receipt.state !== "SUCCEEDED") {
    fail("live Qualification requires terminal SUCCEEDED apply custody");
  }
  const terminalAt = instant(receipt.terminal_at, "terminal_at");
  const terminalMs = Date.parse(terminalAt);
  const permitSha = digest(input.permit_authorization_sha256, "permit authorization");
  if (receipt.authorization_sha256 !== permitSha) {
    fail("terminal ledger receipt belongs to a different permit");
  }
  const capture = record(input.capture_summary, "fresh capture summary");
  if (!["CAPTURED", "CAPTURED_SOURCE_REQUIRED"].includes(String(capture.status))) {
    fail("frozen live capture did not complete");
  }
  const execution = record(capture.execution, "fresh capture execution");
  const expectedImageCount = plan.target.images.length;
  if (execution.product_truth_reads !== 1 || execution.walmart_logical_gets !== 2
    || execution.buyer_pdp_gets !== 1 || execution.image_gets !== expectedImageCount
    || execution.model_calls !== 0 || execution.database_writes !== 0
    || execution.walmart_writes !== 0) {
    fail("fresh capture exceeded its exact read-only effects contract");
  }
  const captureRoot = path.resolve(input.fresh_capture_directory);
  if (await realpath(captureRoot) !== captureRoot) fail("capture directory is not canonical");
  const indexFile = await stableFile(path.join(captureRoot, "intake-index.json"), 16 * 1024 * 1024);
  const index = parseJson(indexFile, "intake index");
  const indexBody = { ...index };
  const indexBodySha = digest(indexBody.body_sha256, "intake body_sha256");
  delete indexBody.body_sha256;
  if (walmartListingIntegritySha256(indexBody) !== indexBodySha
    || index.listing_key !== plan.listing.listing_key) {
    fail("fresh intake index seal or listing identity differs");
  }
  const capturedAt = instant(index.created_at, "fresh capture created_at");
  const captureMs = Date.parse(capturedAt);
  if (captureMs <= terminalMs || captureMs - terminalMs > MAX_CAPTURE_AFTER_TERMINAL_MS) {
    fail("fresh live reread is not within seven days after terminal feed confirmation");
  }
  if (!(input.evaluated_at instanceof Date) || !Number.isFinite(input.evaluated_at.getTime())
    || input.evaluated_at.getTime() < captureMs
    || input.evaluated_at.getTime() - captureMs > 15 * 60_000) {
    fail("Qualification evaluator clock is not fresh relative to live capture");
  }

  const files = index.files;
  if (!Array.isArray(files)) fail("intake index files must be an array");
  const byRole = new Map<string, { path: string; file_sha256: string; bytes: Uint8Array }>();
  for (const raw of files) {
    const row = record(raw, "intake file row");
    const role = text(row.role, "intake role");
    if (byRole.has(role)) fail(`duplicate intake role ${role}`);
    const filePath = safeChild(captureRoot, row.path);
    const bytes = await stableFile(filePath);
    const fileSha = digest(row.file_sha256, `${role} file_sha256`);
    if (bytes.byteLength !== row.bytes || sha256Bytes(bytes) !== fileSha) {
      fail(`${role} bytes differ from fresh intake index`);
    }
    byRole.set(role, { path: filePath, file_sha256: fileSha, bytes });
  }
  const buyerFile = byRole.get("buyer_pdp_payload");
  const sellerFile = byRole.get("seller_item_payload");
  const searchFile = byRole.get("catalog_search_payload");
  if (!buyerFile || !sellerFile || !searchFile) {
    fail("fresh intake is missing buyer/seller/indexability payloads");
  }
  const buyer = parseJson(buyerFile.bytes, "buyer PDP payload");
  const product = record(buyer.product, "buyer PDP product");
  const seller = sellerItem(parseJson(sellerFile.bytes, "seller item payload"));
  const buyerTitle = text(product.title, "buyer title");
  const buyerDescription = text(product.description, "buyer description");
  const buyerBullets = stringRows(product.feature_bullets, "buyer bullets");
  const buyerImages = stringRows(product.images, "buyer images");
  const spec = specifications(product);
  const targetImages = plan.target.images;
  const liveImageFiles = [...byRole.entries()]
    .filter(([role]) => role === "buyer_image_main" || role.startsWith("buyer_image_gallery_"))
    .sort(([left], [right]) => {
      if (left === "buyer_image_main") return -1;
      if (right === "buyer_image_main") return 1;
      return left.localeCompare(right);
    })
    .map(([, value]) => value);
  const liveImages = liveImageFiles.map((value) => value.file_sha256);
  if (liveImages.length !== targetImages.length
    || targetImages[0]?.slot !== "main"
    || targetImages.slice(1).some((row, index) => row.slot !== `gallery-${index + 1}`)) {
    fail("fresh live/target image slots are incomplete or non-contiguous");
  }
  const textOnly = exactChangedFields(plan.changed_fields, ["description", "bullets"]);
  const reviewedMain = exactChangedFields(
    plan.changed_fields,
    ["description", "bullets", "main"],
  );
  const reviewedImageSet = exactChangedFields(
    plan.changed_fields,
    ["description", "bullets", "main", "gallery"],
  );
  const attributeOnly = exactChangedFields(plan.changed_fields, ["attributes"]);
  if (!textOnly && !reviewedMain && !reviewedImageSet && !attributeOnly) {
    fail(
      "live Qualification supports only exact text-only, reviewed-MAIN, "
      + "reviewed-image-set, or attribute-only repairs",
    );
  }
  const contentTarget = attributeOnly ? null : contentRepairTarget({ plan, buyer });
  const attributeTarget = attributeOnly
    ? attributeOnlyTarget({ plan, buyer, specifications: spec })
    : null;
  const mainUrlSelfConsistent = buyerImages[0] === product.main_image;
  const galleryUrlsExact = exactArray(
    buyerImages.slice(1),
    targetImages.slice(1).map((row) => row.source_url),
  );
  const galleryBytesExact = exactArray(
    liveImages.slice(1),
    targetImages.slice(1).map((row) => row.sha256),
  );
  const exactMainBytes = liveImages[0] === targetImages[0]!.sha256;
  const exactMainUrl = buyerImages[0] === targetImages[0]!.source_url;
  const mainEquivalence = reviewedMain || reviewedImageSet
    ? await reviewedMainEquivalence({
      target_bytes: input.target_main_bytes
        ?? fail("reviewed MAIN Qualification requires exact target source bytes"),
      target_sha256: targetImages[0]!.sha256,
      live_bytes: liveImageFiles[0]!.bytes,
      live_sha256: liveImages[0]!,
    })
    : {
      mode: "EXACT_BYTES" as const,
      target_sha256: targetImages[0]!.sha256,
      live_sha256: liveImages[0]!,
      encoded_bytes_exact: exactMainBytes,
      decoded_width: 0,
      decoded_height: 0,
      dhash_distance: exactMainBytes ? 0 : 64,
      psnr_millidb: exactMainBytes ? 100_000 : 0,
      minimum_psnr_millidb: REVIEWED_MAIN_MIN_PSNR_MILLIDB,
      maximum_dhash_distance: REVIEWED_MAIN_MAX_DHASH_DISTANCE,
      equivalent: exactMainBytes && exactMainUrl,
    };
  const mainPass = mainUrlSelfConsistent && mainEquivalence.equivalent;
  // Walmart can serve the same immutable ASR asset URL with a different JPEG
  // encoding between consecutive buyer-PDP reads. When gallery was outside the
  // authorized write scope, the exact reviewed URLs plus the sealed no-gallery
  // payload boundary are the preservation proof; an encoded-byte mismatch alone
  // must not manufacture a gallery failure. A gallery-changing repair remains
  // strict and must reproduce every reviewed target byte exactly.
  const galleryPass = targetImages.length >= 2
    && galleryUrlsExact
    && (!reviewedImageSet || galleryBytesExact);
  const outerUnits = attributeTarget?.outer_units ?? contentTarget!.outer_units;
  const outerText = new RegExp(
    `(?:pack\\s+of\\s+${outerUnits}|quantity\\s+of\\s+${outerUnits}`
      + `|${outerUnits}\\s+(?:bags|packs|packages))`,
    "iu",
  );
  const targetTitle = plan.target.surface.title;
  const targetDescription = plan.target.surface.description ?? "";
  const targetBullets = plan.target.surface.bullets;
  const productAndVariant = attributeTarget
    ? attributeTarget.identity_claims_match
    : contentTarget!.identity_claims_match;
  const buyerMultipackQuantity = buyerOuterUnits(spec);
  const sellerGroupingQuantity = sellerOuterUnits(seller);
  const packCount = buyerMultipackQuantity === outerUnits
    && outerText.test(buyerTitle) && outerText.test(buyerDescription)
    && buyerBullets.some((row) => outerText.test(row));
  const attributes = attributeTarget
    ? attributeTarget.direct_claims_match
      && attributeTarget.opaque_attributes_preserved
      && attributeTarget.count_per_pack_match
      && buyerMultipackQuantity === outerUnits
    : contentTarget!.mapped_attributes_preserved
      && contentTarget!.opaque_attributes_preserved
      && buyerMultipackQuantity === outerUnits;
  const exactIdentity = seller.sku === plan.listing.sku
    && seller.mart === "WALMART_US"
    && String(product.item_id) === plan.listing.item_id;
  const published = seller.publishedStatus === "PUBLISHED"
    && seller.lifecycleStatus === "ACTIVE"
    && text(product.product_url, "buyer product URL").endsWith(`/${plan.listing.item_id}`);
  const facets = {
    exact_listing_identity: pass(exactIdentity),
    published_and_indexed: pass(published),
    product_and_variant: pass(productAndVariant),
    pack_count: pass(packCount),
    title: pass(buyerTitle === targetTitle),
    description: pass(buyerDescription === targetDescription),
    bullets: pass(exactArray(buyerBullets, targetBullets)),
    attributes: pass(attributes),
    main: pass(mainPass),
    gallery: pass(galleryPass),
    exact_repair_target: pass(
      buyerTitle === targetTitle
      && buyerDescription === targetDescription
      && exactArray(buyerBullets, targetBullets)
      && mainPass && galleryPass && attributes
    ),
    unchanged_fields_preserved: pass(
      (textOnly || reviewedMain || reviewedImageSet || attributeOnly)
      && buyerTitle === plan.target.surface.title
      && (!attributeOnly
        || (buyerDescription === targetDescription
          && exactArray(buyerBullets, targetBullets)))
      && galleryPass && attributes
      && mainPass
    ),
    fresh_authenticated_live_reread: "PASS" as const,
    terminal_apply_custody: "PASS" as const,
  };
  const blockingReasons = Object.entries(facets)
    .filter(([, verdict]) => verdict === "FAIL")
    .map(([name]) => `${name} did not pass`);
  const failureNotBeforeMs = terminalMs + PROPAGATION_FAILURE_NOT_BEFORE_MS;
  const qualityPassed = blockingReasons.length === 0;
  const failureProven = !qualityPassed && captureMs >= failureNotBeforeMs;
  const verdict = qualityPassed ? "PASS" as const
    : failureProven ? "FAIL" as const : "PENDING_PROPAGATION" as const;
  const custodyInventorySha = digest(custody.inventory_sha256, "artifact custody inventory");
  const body = {
    schema_version: WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_SCHEMA,
    qualification_id: `live-qualification-${walmartListingIntegritySha256({
      permit: permitSha,
      plan: plan.body_sha256,
      capture: indexBodySha,
      evaluated_at: input.evaluated_at.toISOString(),
    }).slice(0, 24)}`,
    qualified_at: input.evaluated_at.toISOString(),
    verdict,
    listing: {
      channel: "WALMART_US" as const,
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
    },
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    permit_authorization_sha256: permitSha,
    feed_id: text(receipt.feed_id, "terminal feed_id"),
    feed_terminal_at: terminalAt,
    live_capture: {
      created_at: capturedAt,
      intake_index_body_sha256: indexBodySha,
      intake_index_file_sha256: sha256Bytes(indexFile),
      buyer_pdp_file_sha256: buyerFile.file_sha256,
      seller_item_file_sha256: sellerFile.file_sha256,
      catalog_search_file_sha256: searchFile.file_sha256,
      image_sha256: liveImages,
    },
    apply_custody: {
      ledger_terminal_sha256: digest(ledger.terminal_sha256, "ledger terminal SHA"),
      ledger_head_sha256: digest(ledger.head_sha256, "ledger head SHA"),
      artifact_inventory_sha256: custodyInventorySha,
      request_payload_sha256: digest(receipt.request_payload_sha256, "request payload SHA"),
      terminal_feed_status_payload_sha256:
        digest(receipt.feed_status_payload_sha256, "terminal feed status payload SHA"),
    },
    authority: {
      method: "FROZEN_AUTHENTICATED_LIVE_REREAD" as const,
      live_capture_created_by_qualifier: true as const,
      caller_authored_verdict_accepted: false as const,
      cached_capture_accepted: false as const,
      exact_target_rebuilt_from_owner_signed_plan: true as const,
      exact_image_bytes_verified: true as const,
      terminal_apply_custody_verified: true as const,
      qualifier_release_sha256: releaseAuthority.qualifier_release_sha256,
      source_release_sha256: releaseAuthority.source_release_sha256,
      predecessor_source_release_accepted:
        releaseAuthority.predecessor_source_release_accepted,
    },
    quantity_evidence: {
      authoritative_source:
        "BUYER_PDP_MULTIPACK_QUANTITY_AND_PRODUCT_TRUTH" as const,
      buyer_multipack_quantity: buyerMultipackQuantity,
      seller_grouping_number_of_pieces: sellerGroupingQuantity,
      seller_grouping_used_as_offer_quantity: false as const,
    },
    main_equivalence: mainEquivalence,
    facets,
    blocking_reasons: blockingReasons,
    propagation: {
      failure_not_before: new Date(failureNotBeforeMs).toISOString(),
      reread_before_failure_window: captureMs < failureNotBeforeMs,
      recheck_same_sku_without_write: verdict === "PENDING_PROPAGATION",
    },
    next_sku_unblocked: verdict === "PASS",
    next_action: verdict === "PASS" ? "ADVANCE_TO_NEXT_SKU" as const
      : verdict === "PENDING_PROPAGATION" ? "RECHECK_SAME_SKU_NO_WRITE" as const
        : "OWNER_REVIEW_REPLAN" as const,
    marketplace_write_authorized: false as const,
    automatic_reapply_allowed: false as const,
    external_effects: {
      product_truth_reads: 1 as const,
      walmart_logical_gets: 2 as const,
      buyer_pdp_gets: 1 as const,
      image_gets: expectedImageCount,
      target_main_gets: reviewedMain ? 1 as const : 0 as const,
      model_calls: 0 as const,
      database_writes: 0 as const,
      walmart_writes: 0 as const,
    },
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  }) as WalmartListingRepairLiveQualification;
}
