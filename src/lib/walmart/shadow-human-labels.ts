/**
 * Pure, offline contract for independently adjudicated Shadow-50 labels.
 *
 * Labels are visual-audit evidence, not a parallel product-truth catalog. Each
 * decision is bound to the frozen shared Product Truth snapshot, exact recipe
 * approval, buyer snapshot, and local MAIN bytes that the model will later see.
 */

import { createHash } from "node:crypto";

import type { SealedWalmartBuyerSnapshot } from "./buyer-facing-snapshot.ts";
import type {
  WalmartCatalogTruthAuditCase,
  WalmartCatalogTruthAuditExport,
} from "./catalog-truth-export.ts";
import {
  verifyWalmartCatalogTruthAuditExport,
  walmartListingKey,
} from "./catalog-truth-export.ts";
import type { WalmartShadow50Case, WalmartShadow50Manifest } from "./shadow-50.ts";
import { verifyWalmartShadow50Manifest } from "./shadow-50.ts";

export const WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA =
  "walmart-shadow-human-label-input/v2" as const;
export const WALMART_SHADOW_HUMAN_LABEL_SET_SCHEMA =
  "walmart-shadow-human-label-set/v2" as const;
export const WALMART_SHADOW_REVIEWER_REGISTRY_SCHEMA =
  "walmart-shadow-reviewer-registry/v1" as const;
export const WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA =
  "walmart-shadow-human-trusted-context/v1" as const;
export const WALMART_SHADOW_HUMAN_EXECUTION_EVIDENCE_SCHEMA =
  "walmart-shadow-human-execution-evidence/v1" as const;
export const WALMART_SHADOW_HUMAN_BLINDED_ASSIGNMENT_SCHEMA =
  "walmart-shadow-human-blinded-assignment/v1" as const;

export type ShadowHumanVerdict = "PASS" | "BAD" | "UNRESOLVED";
export type ShadowFinalHumanVerdict = Exclude<ShadowHumanVerdict, "UNRESOLVED">;

export interface ShadowHumanCaseBinding {
  case_id: string;
  sku: string;
  item_id: string;
  shadow_manifest_body_sha256: string;
  catalog_truth_export_body_sha256: string;
  preflight_input_sha256: string;
  preflight_result_sha256: string;
  product_truth_snapshot_body_sha256: string;
  recipe_revision_subject_sha256: string;
  recipe_approval_sha256: string;
  buyer_snapshot_body_sha256: string;
  main_asset_sha256: string;
  blinded_assignment_sha256: string;
}

export interface ShadowReviewerLabelInput {
  case_id: string;
  case_binding_sha256: string;
  reviewer_id: string;
  reviewer_subject_sha256: string;
  verdict: ShadowHumanVerdict;
  defect_codes: string[];
  rationale: string;
  labeled_at: string;
}

export interface ShadowAdjudicationInput {
  case_id: string;
  case_binding_sha256: string;
  adjudicator_id: string;
  adjudicator_subject_sha256: string;
  reviewer_label_sha256s: [string, string];
  final_verdict: ShadowFinalHumanVerdict;
  defect_codes: string[];
  rationale: string;
  adjudicated_at: string;
}

export interface ShadowHumanLabelBuildInput {
  schema_version: typeof WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA;
  trusted_context_body_sha256: string;
  finalized_at: string;
  reviewer_labels: ShadowReviewerLabelInput[];
  adjudications: ShadowAdjudicationInput[];
}

export interface ShadowTrustedReviewer {
  reviewer_id: string;
  subject_sha256: string;
}

export interface WalmartShadowReviewerRegistry {
  schema_version: typeof WALMART_SHADOW_REVIEWER_REGISTRY_SCHEMA;
  registry_id: string;
  body_sha256: string;
  captured_at: string;
  reviewers: ShadowTrustedReviewer[];
}

export interface WalmartShadowHumanTrustedContext {
  schema_version: typeof WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA;
  context_id: string;
  body_sha256: string;
  shadow_manifest_body_sha256: string;
  catalog_truth_export_body_sha256: string;
  reviewer_registry: WalmartShadowReviewerRegistry;
  cases: ShadowHumanCaseBinding[];
}

/**
 * Runtime-only source bundle. `main_bytes` are intentionally never serialized
 * into the trusted context; the context retains their content SHA through each
 * case binding. The sealed snapshot manifest supplies the expected byte length,
 * raster format, and decoded dimensions.
 */
export interface WalmartShadowLocalMainByteEvidence {
  case_id: string;
  snapshot: SealedWalmartBuyerSnapshot;
  main_bytes: Uint8Array;
}

export interface WalmartShadowHumanTrustedContextSources {
  shadow_manifest: WalmartShadow50Manifest;
  catalog_truth_export: WalmartCatalogTruthAuditExport;
  reviewer_registry: WalmartShadowReviewerRegistry;
  local_main_assets: WalmartShadowLocalMainByteEvidence[];
}

export interface WalmartShadowHumanExecutionEvidence {
  schema_version: typeof WALMART_SHADOW_HUMAN_EXECUTION_EVIDENCE_SCHEMA;
  evidence_id: string;
  body_sha256: string;
  human_label_set_body_sha256: string;
  shadow_manifest_body_sha256: string;
  first_primary_call_at: string;
}

export interface SealedShadowReviewerLabel extends ShadowReviewerLabelInput {
  label_sha256: string;
}

export interface SealedShadowAdjudication extends ShadowAdjudicationInput {
  adjudication_sha256: string;
}

export interface FinalShadowHumanCase {
  binding: ShadowHumanCaseBinding;
  case_binding_sha256: string;
  reviewer_labels: [SealedShadowReviewerLabel, SealedShadowReviewerLabel];
  adjudication: SealedShadowAdjudication | null;
  final_verdict: ShadowFinalHumanVerdict;
  final_label_basis: "reviewer_agreement" | "third_party_adjudication";
}

export interface WalmartShadowHumanLabelSet {
  schema_version: typeof WALMART_SHADOW_HUMAN_LABEL_SET_SCHEMA;
  trusted_context_body_sha256: string;
  shadow_manifest_body_sha256: string;
  catalog_truth_export_body_sha256: string;
  reviewer_registry_body_sha256: string;
  finalized_at: string;
  execution_proof_status: "PENDING";
  cases: FinalShadowHumanCase[];
  summary: {
    total_cases: 50;
    reviewer_labels: 100;
    adjudicated_cases: number;
    pass_cases: number;
    bad_cases: number;
    unresolved_final_cases: 0;
  };
  body_sha256: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA =
  "walmart-buyer-facing-snapshot/v3" as const;

interface RasterHeader {
  format: "jpeg" | "png" | "webp";
  width: number;
  height: number;
}

interface ParsedManifestCaseSource {
  case_id: string;
  source_truth_case_id: string;
  channel: "WALMART_US";
  store_index: number;
  sku: string;
  listing_key: string;
  item_id: string;
  published_status: "PUBLISHED";
  lifecycle_status: "ACTIVE";
  category: string;
  listing_kind: WalmartShadow50Case["listing_kind"];
  expected: WalmartShadow50Case["expected"];
  bindings: WalmartShadow50Case["bindings"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const expected = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !expected.has(key));
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function assertAllowedAndRequiredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
  ).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function requiredSha(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!SHA256_RE.test(parsed)) throw new Error(`${path} must be a lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!ISO_INSTANT_RE.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${path} must be a canonical millisecond ISO-8601 UTC instant`);
  }
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function readUint16BE(bytes: Uint8Array, offset: number, path: string): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error(`${path} is truncated`);
  }
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number, path: string): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error(`${path} is truncated`);
  }
  return bytes[offset]! + bytes[offset + 1]! * 0x100;
}

function readUint24LE(bytes: Uint8Array, offset: number, path: string): number {
  if (offset < 0 || offset + 3 > bytes.length) {
    throw new Error(`${path} is truncated`);
  }
  return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000;
}

function readUint32BE(bytes: Uint8Array, offset: number, path: string): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`${path} is truncated`);
  }
  return (bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number, path: string): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`${path} is truncated`);
  }
  return (bytes[offset]!
    + bytes[offset + 1]! * 0x100
    + bytes[offset + 2]! * 0x10000
    + bytes[offset + 3]! * 0x1000000) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function inspectPngHeader(bytes: Uint8Array, path: string): RasterHeader | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length
    || !signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes.length < 33
    || readUint32BE(bytes, 8, path) !== 13
    || ascii(bytes, 12, 4) !== "IHDR") {
    throw new Error(`${path} has an invalid or truncated PNG IHDR`);
  }
  return {
    format: "png",
    width: positiveInteger(readUint32BE(bytes, 16, path), `${path} PNG width`),
    height: positiveInteger(readUint32BE(bytes, 20, path), `${path} PNG height`),
  };
}

function inspectJpegHeader(bytes: Uint8Array, path: string): RasterHeader | null {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++]!;
    if (marker === 0x00) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = readUint16BE(bytes, offset, path);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new Error(`${path} has a truncated JPEG segment`);
    }
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) throw new Error(`${path} has an invalid JPEG SOF segment`);
      return {
        format: "jpeg",
        height: positiveInteger(readUint16BE(bytes, offset + 3, path), `${path} JPEG height`),
        width: positiveInteger(readUint16BE(bytes, offset + 5, path), `${path} JPEG width`),
      };
    }
    offset += segmentLength;
  }
  throw new Error(`${path} has no decodable JPEG dimensions`);
}

function inspectWebpHeader(bytes: Uint8Array, path: string): RasterHeader | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  if (bytes.length < 20) throw new Error(`${path} has a truncated WebP container`);
  const riffBytes = readUint32LE(bytes, 4, path) + 8;
  if (riffBytes !== bytes.length) {
    throw new Error(`${path} WebP RIFF byte length does not match actual bytes`);
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = ascii(bytes, offset, 4);
    const chunkLength = readUint32LE(bytes, offset + 4, path);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkLength + (chunkLength % 2);
    if (nextOffset > bytes.length) throw new Error(`${path} has a truncated WebP chunk`);
    if (chunk === "VP8X") {
      if (chunkLength < 10) throw new Error(`${path} has a truncated WebP VP8X header`);
      return {
        format: "webp",
        width: readUint24LE(bytes, dataOffset + 4, path) + 1,
        height: readUint24LE(bytes, dataOffset + 7, path) + 1,
      };
    }
    if (chunk === "VP8L") {
      if (chunkLength < 5 || bytes[dataOffset] !== 0x2f) {
        throw new Error(`${path} has an invalid WebP VP8L header`);
      }
      const b0 = bytes[dataOffset + 1]!;
      const b1 = bytes[dataOffset + 2]!;
      const b2 = bytes[dataOffset + 3]!;
      const b3 = bytes[dataOffset + 4]!;
      return {
        format: "webp",
        width: 1 + b0 + ((b1 & 0x3f) << 8),
        height: 1 + ((b1 & 0xc0) >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
      };
    }
    if (chunk === "VP8 ") {
      if (chunkLength < 10
        || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01
        || bytes[dataOffset + 5] !== 0x2a) {
        throw new Error(`${path} has an invalid WebP VP8 frame header`);
      }
      return {
        format: "webp",
        width: readUint16LE(bytes, dataOffset + 6, path) & 0x3fff,
        height: readUint16LE(bytes, dataOffset + 8, path) & 0x3fff,
      };
    }
    offset = nextOffset;
  }
  throw new Error(`${path} has no supported WebP image header`);
}

function inspectRasterHeader(bytes: Uint8Array, path: string): RasterHeader {
  const result = inspectPngHeader(bytes, path)
    ?? inspectJpegHeader(bytes, path)
    ?? inspectWebpHeader(bytes, path);
  if (!result) throw new Error(`${path} is not a supported PNG, JPEG, or WebP raster`);
  if (result.width <= 0 || result.height <= 0) {
    throw new Error(`${path} has invalid raster dimensions`);
  }
  return result;
}

function parseDefectCodes(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 24) {
    throw new Error(`${path} must be an array with at most 24 items`);
  }
  const parsed = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} contains duplicates`);
  return parsed;
}

function assertVerdictDefects(
  verdict: ShadowHumanVerdict | ShadowFinalHumanVerdict,
  defects: readonly string[],
  path: string,
): void {
  if (verdict === "PASS" && defects.length !== 0) {
    throw new Error(`${path}: PASS must not carry defect codes`);
  }
  if (verdict === "BAD" && defects.length === 0) {
    throw new Error(`${path}: BAD must carry at least one defect code`);
  }
}

function parseCaseBinding(raw: unknown, path: string): ShadowHumanCaseBinding {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "case_id", "sku", "item_id", "shadow_manifest_body_sha256",
    "catalog_truth_export_body_sha256", "preflight_input_sha256", "preflight_result_sha256",
    "product_truth_snapshot_body_sha256", "recipe_revision_subject_sha256",
    "recipe_approval_sha256", "buyer_snapshot_body_sha256", "main_asset_sha256",
    "blinded_assignment_sha256",
  ], path);
  const itemId = requiredString(raw.item_id, `${path}.item_id`);
  if (!/^\d+$/.test(itemId)) throw new Error(`${path}.item_id must be numeric`);
  return {
    case_id: requiredString(raw.case_id, `${path}.case_id`),
    sku: requiredString(raw.sku, `${path}.sku`),
    item_id: itemId,
    shadow_manifest_body_sha256: requiredSha(
      raw.shadow_manifest_body_sha256,
      `${path}.shadow_manifest_body_sha256`,
    ),
    catalog_truth_export_body_sha256: requiredSha(
      raw.catalog_truth_export_body_sha256,
      `${path}.catalog_truth_export_body_sha256`,
    ),
    preflight_input_sha256: requiredSha(raw.preflight_input_sha256, `${path}.preflight_input_sha256`),
    preflight_result_sha256: requiredSha(raw.preflight_result_sha256, `${path}.preflight_result_sha256`),
    product_truth_snapshot_body_sha256: requiredSha(
      raw.product_truth_snapshot_body_sha256,
      `${path}.product_truth_snapshot_body_sha256`,
    ),
    recipe_revision_subject_sha256: requiredSha(
      raw.recipe_revision_subject_sha256,
      `${path}.recipe_revision_subject_sha256`,
    ),
    recipe_approval_sha256: requiredSha(raw.recipe_approval_sha256, `${path}.recipe_approval_sha256`),
    buyer_snapshot_body_sha256: requiredSha(
      raw.buyer_snapshot_body_sha256,
      `${path}.buyer_snapshot_body_sha256`,
    ),
    main_asset_sha256: requiredSha(raw.main_asset_sha256, `${path}.main_asset_sha256`),
    blinded_assignment_sha256: requiredSha(
      raw.blinded_assignment_sha256,
      `${path}.blinded_assignment_sha256`,
    ),
  };
}

function caseBindingSha(binding: ShadowHumanCaseBinding): string {
  return sha256(binding);
}

function parseReviewerLabel(raw: unknown, path: string): ShadowReviewerLabelInput {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "case_id", "case_binding_sha256", "reviewer_id", "reviewer_subject_sha256",
    "verdict", "defect_codes", "rationale", "labeled_at",
  ], path);
  if (raw.verdict !== "PASS" && raw.verdict !== "BAD" && raw.verdict !== "UNRESOLVED") {
    throw new Error(`${path}.verdict is unsupported`);
  }
  const defects = parseDefectCodes(raw.defect_codes, `${path}.defect_codes`);
  assertVerdictDefects(raw.verdict, defects, path);
  return {
    case_id: requiredString(raw.case_id, `${path}.case_id`),
    case_binding_sha256: requiredSha(raw.case_binding_sha256, `${path}.case_binding_sha256`),
    reviewer_id: requiredString(raw.reviewer_id, `${path}.reviewer_id`),
    reviewer_subject_sha256: requiredSha(
      raw.reviewer_subject_sha256,
      `${path}.reviewer_subject_sha256`,
    ),
    verdict: raw.verdict,
    defect_codes: defects,
    rationale: requiredString(raw.rationale, `${path}.rationale`),
    labeled_at: instant(raw.labeled_at, `${path}.labeled_at`),
  };
}

function sealReviewerLabel(label: ShadowReviewerLabelInput): SealedShadowReviewerLabel {
  return { ...label, label_sha256: sha256(label) };
}

function parseAdjudication(raw: unknown, path: string): ShadowAdjudicationInput {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "case_id", "case_binding_sha256", "adjudicator_id", "adjudicator_subject_sha256",
    "reviewer_label_sha256s", "final_verdict", "defect_codes", "rationale",
    "adjudicated_at",
  ], path);
  if (raw.final_verdict !== "PASS" && raw.final_verdict !== "BAD") {
    throw new Error(`${path}.final_verdict must be PASS or BAD`);
  }
  if (!Array.isArray(raw.reviewer_label_sha256s) || raw.reviewer_label_sha256s.length !== 2) {
    throw new Error(`${path}.reviewer_label_sha256s must contain exactly two hashes`);
  }
  const reviewerHashes = raw.reviewer_label_sha256s.map((value, index) => (
    requiredSha(value, `${path}.reviewer_label_sha256s[${index}]`)
  )) as [string, string];
  if (reviewerHashes[0] === reviewerHashes[1]) {
    throw new Error(`${path}.reviewer_label_sha256s must be distinct`);
  }
  const defects = parseDefectCodes(raw.defect_codes, `${path}.defect_codes`);
  assertVerdictDefects(raw.final_verdict, defects, path);
  return {
    case_id: requiredString(raw.case_id, `${path}.case_id`),
    case_binding_sha256: requiredSha(raw.case_binding_sha256, `${path}.case_binding_sha256`),
    adjudicator_id: requiredString(raw.adjudicator_id, `${path}.adjudicator_id`),
    adjudicator_subject_sha256: requiredSha(
      raw.adjudicator_subject_sha256,
      `${path}.adjudicator_subject_sha256`,
    ),
    reviewer_label_sha256s: reviewerHashes,
    final_verdict: raw.final_verdict,
    defect_codes: defects,
    rationale: requiredString(raw.rationale, `${path}.rationale`),
    adjudicated_at: instant(raw.adjudicated_at, `${path}.adjudicated_at`),
  };
}

function sealAdjudication(value: ShadowAdjudicationInput): SealedShadowAdjudication {
  return { ...value, adjudication_sha256: sha256(value) };
}

function parseReviewerRegistry(raw: unknown, path: string): WalmartShadowReviewerRegistry {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "registry_id", "body_sha256", "captured_at", "reviewers",
  ], path);
  if (raw.schema_version !== WALMART_SHADOW_REVIEWER_REGISTRY_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  if (!Array.isArray(raw.reviewers) || raw.reviewers.length < 3 || raw.reviewers.length > 100) {
    throw new Error(`${path}.reviewers must contain 3-100 trusted subjects`);
  }
  const declaredBodySha = requiredSha(raw.body_sha256, `${path}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    reviewers: raw.reviewers,
  };
  if (sha256(body) !== declaredBodySha) throw new Error(`${path} body SHA mismatch`);
  const registryId = requiredString(raw.registry_id, `${path}.registry_id`);
  if (registryId !== `walmart-shadow-reviewers-${declaredBodySha.slice(0, 16)}`) {
    throw new Error(`${path}.registry_id is not derived from body_sha256`);
  }
  const reviewers = raw.reviewers.map((value, index): ShadowTrustedReviewer => {
    const reviewerPath = `${path}.reviewers[${index}]`;
    if (!isRecord(value)) throw new Error(`${reviewerPath} must be an object`);
    assertExactKeys(value, ["reviewer_id", "subject_sha256"], reviewerPath);
    return {
      reviewer_id: requiredString(value.reviewer_id, `${reviewerPath}.reviewer_id`),
      subject_sha256: requiredSha(value.subject_sha256, `${reviewerPath}.subject_sha256`),
    };
  });
  assertUnique(reviewers.map((value) => value.reviewer_id), `${path} reviewer_id`);
  assertUnique(reviewers.map((value) => value.subject_sha256), `${path} reviewer subject`);
  const sortedReviewerIds = [...reviewers]
    .sort((left, right) => left.reviewer_id.localeCompare(right.reviewer_id))
    .map((value) => value.reviewer_id);
  if (canonicalJson(reviewers.map((value) => value.reviewer_id))
    !== canonicalJson(sortedReviewerIds)) {
    throw new Error(`${path}.reviewers must be in canonical reviewer_id order`);
  }
  return {
    schema_version: WALMART_SHADOW_REVIEWER_REGISTRY_SCHEMA,
    registry_id: registryId,
    body_sha256: declaredBodySha,
    captured_at: instant(raw.captured_at, `${path}.captured_at`),
    reviewers,
  };
}

function parseManifestSourceCase(raw: unknown, index: number): ParsedManifestCaseSource {
  const path = `shadow manifest.cases[${index}]`;
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "case_id", "source_truth_case_id", "channel", "store_index", "sku", "listing_key",
    "item_id", "published_status", "lifecycle_status",
    "category", "sales_tier", "listing_kind", "primary_stratum", "stratum_rank",
    "risk", "expected", "bindings",
  ], path);
  if (raw.channel !== "WALMART_US") throw new Error(`${path}.channel must be WALMART_US`);
  const storeIndex = positiveInteger(raw.store_index, `${path}.store_index`);
  const sku = requiredString(raw.sku, `${path}.sku`);
  if (raw.sku !== sku) throw new Error(`${path}.sku must be an exact already-trimmed SKU`);
  const listingKey = requiredString(raw.listing_key, `${path}.listing_key`);
  if (listingKey !== walmartListingKey(storeIndex, sku)) {
    throw new Error(`${path}.listing_key does not match store_index and exact SKU`);
  }
  const itemId = requiredString(raw.item_id, `${path}.item_id`);
  if (!/^\d+$/.test(itemId)) throw new Error(`${path}.item_id must be numeric`);
  if (raw.published_status !== "PUBLISHED") {
    throw new Error(`${path}.published_status must be PUBLISHED`);
  }
  if (raw.lifecycle_status !== "ACTIVE") {
    throw new Error(`${path}.lifecycle_status must be ACTIVE`);
  }
  if (raw.listing_kind !== "single" && raw.listing_kind !== "multipack") {
    throw new Error(`${path}.listing_kind must be single or multipack`);
  }
  if (!isRecord(raw.expected)) throw new Error(`${path}.expected must be an object`);
  if (!isRecord(raw.bindings)) throw new Error(`${path}.bindings must be an object`);
  assertExactKeys(raw.bindings, [
    "source_truth_case_canonical_sha256", "selection_row_canonical_sha256",
    "preflight_input_sha256", "preflight_result_canonical_sha256",
    "evidence_payload_sha256s", "truth_revision_id", "truth_revision_body_sha256",
    "truth_approval_sha256", "buyer_snapshot_id", "buyer_snapshot_body_sha256",
    "buyer_main_asset_sha256",
  ], `${path}.bindings`);
  if (!Array.isArray(raw.bindings.evidence_payload_sha256s)
    || raw.bindings.evidence_payload_sha256s.length < 1) {
    throw new Error(`${path}.bindings.evidence_payload_sha256s must be a non-empty array`);
  }
  const evidencePayloadShas = raw.bindings.evidence_payload_sha256s.map((value, evidenceIndex) => (
    requiredSha(value, `${path}.bindings.evidence_payload_sha256s[${evidenceIndex}]`)
  ));
  assertUnique(evidencePayloadShas, `${path} evidence payload SHA`);
  const sortedEvidencePayloadShas = [...evidencePayloadShas].sort();
  if (canonicalJson(evidencePayloadShas) !== canonicalJson(sortedEvidencePayloadShas)) {
    throw new Error(`${path}.bindings.evidence_payload_sha256s must be in canonical order`);
  }
  return {
    case_id: requiredString(raw.case_id, `${path}.case_id`),
    source_truth_case_id: requiredString(
      raw.source_truth_case_id,
      `${path}.source_truth_case_id`,
    ),
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: listingKey,
    item_id: itemId,
    published_status: "PUBLISHED",
    lifecycle_status: "ACTIVE",
    category: requiredString(raw.category, `${path}.category`),
    listing_kind: raw.listing_kind,
    expected: raw.expected as unknown as WalmartShadow50Case["expected"],
    bindings: {
      source_truth_case_canonical_sha256: requiredSha(
        raw.bindings.source_truth_case_canonical_sha256,
        `${path}.bindings.source_truth_case_canonical_sha256`,
      ),
      selection_row_canonical_sha256: requiredSha(
        raw.bindings.selection_row_canonical_sha256,
        `${path}.bindings.selection_row_canonical_sha256`,
      ),
      preflight_input_sha256: requiredSha(
        raw.bindings.preflight_input_sha256,
        `${path}.bindings.preflight_input_sha256`,
      ),
      preflight_result_canonical_sha256: requiredSha(
        raw.bindings.preflight_result_canonical_sha256,
        `${path}.bindings.preflight_result_canonical_sha256`,
      ),
      evidence_payload_sha256s: sortedEvidencePayloadShas,
      truth_revision_id: requiredString(
        raw.bindings.truth_revision_id,
        `${path}.bindings.truth_revision_id`,
      ),
      truth_revision_body_sha256: requiredSha(
        raw.bindings.truth_revision_body_sha256,
        `${path}.bindings.truth_revision_body_sha256`,
      ),
      truth_approval_sha256: requiredSha(
        raw.bindings.truth_approval_sha256,
        `${path}.bindings.truth_approval_sha256`,
      ),
      buyer_snapshot_id: requiredString(
        raw.bindings.buyer_snapshot_id,
        `${path}.bindings.buyer_snapshot_id`,
      ),
      buyer_snapshot_body_sha256: requiredSha(
        raw.bindings.buyer_snapshot_body_sha256,
        `${path}.bindings.buyer_snapshot_body_sha256`,
      ),
      buyer_main_asset_sha256: requiredSha(
        raw.bindings.buyer_main_asset_sha256,
        `${path}.bindings.buyer_main_asset_sha256`,
      ),
    },
  };
}

function safeSnapshotStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function validateSealedBuyerSnapshot(
  raw: unknown,
  path: string,
): { snapshot: SealedWalmartBuyerSnapshot; mainAsset: SealedWalmartBuyerSnapshot["assets"][number] } {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "target",
    "identity", "source_contract", "payload_hashes", "assets",
  ], path);
  if (raw.schema_version !== SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  const capturedAt = instant(raw.captured_at, `${path}.captured_at`);
  if (!isRecord(raw.target)) throw new Error(`${path}.target must be an object`);
  assertAllowedAndRequiredKeys(
    raw.target,
    ["sku", "item_id", "expected_title", "stratum"],
    ["sku", "item_id"],
    `${path}.target`,
  );
  requiredString(raw.target.sku, `${path}.target.sku`);
  const targetItemId = requiredString(raw.target.item_id, `${path}.target.item_id`);
  if (!/^\d+$/.test(targetItemId)) throw new Error(`${path}.target.item_id must be numeric`);
  if (!isRecord(raw.identity)) throw new Error(`${path}.identity must be an object`);
  if (!isRecord(raw.source_contract)) throw new Error(`${path}.source_contract must be an object`);
  if (!isRecord(raw.payload_hashes)) throw new Error(`${path}.payload_hashes must be an object`);
  if (!Array.isArray(raw.assets) || raw.assets.length < 1 || raw.assets.length > 100) {
    throw new Error(`${path}.assets must contain 1-100 entries`);
  }
  const mainAssets = raw.assets.filter((asset) => isRecord(asset) && asset.slot === "MAIN");
  if (mainAssets.length !== 1 || raw.assets[0] !== mainAssets[0]) {
    throw new Error(`${path}.assets must contain exactly one first-position MAIN`);
  }
  const mainAsset = mainAssets[0]!;
  assertExactKeys(mainAsset, [
    "slot", "source_url", "final_url", "sha256", "bytes", "media_type", "extension",
    "decoded_format", "decoded_width", "decoded_height", "local_path",
  ], `${path}.assets[0]`);
  const mainSha = requiredSha(mainAsset.sha256, `${path}.assets[0].sha256`);
  positiveInteger(mainAsset.bytes, `${path}.assets[0].bytes`);
  positiveInteger(mainAsset.decoded_width, `${path}.assets[0].decoded_width`);
  positiveInteger(mainAsset.decoded_height, `${path}.assets[0].decoded_height`);
  if (mainAsset.media_type !== "image/jpeg"
    && mainAsset.media_type !== "image/png"
    && mainAsset.media_type !== "image/webp") {
    throw new Error(`${path}.assets[0].media_type is unsupported`);
  }
  if (mainAsset.extension !== "jpg"
    && mainAsset.extension !== "png"
    && mainAsset.extension !== "webp") {
    throw new Error(`${path}.assets[0].extension is unsupported`);
  }
  const expectedFormat = mainAsset.extension === "jpg" ? "jpeg" : mainAsset.extension;
  if (mainAsset.decoded_format !== expectedFormat
    || mainAsset.media_type !== `image/${expectedFormat}`) {
    throw new Error(`${path}.assets[0] format fields disagree`);
  }
  if (mainAsset.local_path !== `assets/${mainSha}.${mainAsset.extension}`) {
    throw new Error(`${path}.assets[0].local_path is not content-addressed`);
  }

  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    target: raw.target,
    identity: raw.identity,
    source_contract: raw.source_contract,
    payload_hashes: raw.payload_hashes,
    assets: raw.assets,
  };
  const bodySha = requiredSha(raw.body_sha256, `${path}.body_sha256`);
  if (sha256(body) !== bodySha) throw new Error(`${path} body SHA mismatch`);
  const snapshotId = requiredString(raw.snapshot_id, `${path}.snapshot_id`);
  if (snapshotId !== `walmart-buyer-${safeSnapshotStamp(capturedAt)}-${bodySha.slice(0, 12)}`) {
    throw new Error(`${path}.snapshot_id is not derived from its sealed body`);
  }
  return {
    snapshot: raw as unknown as SealedWalmartBuyerSnapshot,
    mainAsset: mainAsset as unknown as SealedWalmartBuyerSnapshot["assets"][number],
  };
}

function assertManifestCatalogExportBinding(
  manifest: WalmartShadow50Manifest,
  catalogTruth: WalmartCatalogTruthAuditExport,
): void {
  const sourceBindings = manifest.source_bindings;
  if (!isRecord(sourceBindings)) throw new Error("shadow manifest.source_bindings must be an object");
  const rawBinding = sourceBindings.catalog_truth_export;
  if (!isRecord(rawBinding)) {
    throw new Error("shadow manifest catalog truth binding must be an object");
  }
  assertExactKeys(rawBinding, [
    "schema_version", "export_id", "body_sha256", "source_recompile_verified",
    "product_truth_snapshot_id", "product_truth_snapshot_body_sha256", "buyer_index_id",
    "buyer_index_body_sha256",
  ], "shadow manifest catalog truth binding");
  if (rawBinding.source_recompile_verified !== true) {
    throw new Error("shadow manifest does not attest source-recompiled catalog truth");
  }
  if (rawBinding.schema_version !== catalogTruth.schema_version
    || rawBinding.export_id !== catalogTruth.export_id
    || rawBinding.body_sha256 !== catalogTruth.body_sha256
    || rawBinding.product_truth_snapshot_id !== catalogTruth.product_truth_snapshot.snapshot_id
    || rawBinding.product_truth_snapshot_body_sha256
      !== catalogTruth.product_truth_snapshot.body_sha256
    || rawBinding.buyer_index_id !== catalogTruth.buyer_index.index_id
    || rawBinding.buyer_index_body_sha256 !== catalogTruth.buyer_index.body_sha256) {
    throw new Error("shadow manifest is detached from the exact catalog truth export");
  }
}

function assertManifestCaseMatchesCatalogTruth(
  manifestCase: ParsedManifestCaseSource,
  truthCase: WalmartCatalogTruthAuditCase,
): void {
  const path = manifestCase.case_id;
  if (truthCase.case_id !== manifestCase.source_truth_case_id
    || truthCase.channel !== manifestCase.channel
    || truthCase.store_index !== manifestCase.store_index
    || truthCase.sku !== manifestCase.sku
    || truthCase.listing_key !== manifestCase.listing_key
    || truthCase.item_id !== manifestCase.item_id
    || truthCase.published_status !== manifestCase.published_status
    || truthCase.lifecycle_status !== manifestCase.lifecycle_status
    || truthCase.category !== manifestCase.category
    || truthCase.listing_kind !== manifestCase.listing_kind) {
    throw new Error(`${path}: manifest identity is detached from its catalog truth case`);
  }
  if (truthCase.disposition !== "auditable"
    || truthCase.preflight?.status !== "AUDITABLE"
    || !truthCase.preflight_sha256
    || !truthCase.truth_revision.approval_sha256
    || !truthCase.buyer_snapshot) {
    throw new Error(`${path}: catalog truth case is not fully AUDITABLE`);
  }
  if (sha256(truthCase) !== manifestCase.bindings.source_truth_case_canonical_sha256) {
    throw new Error(`${path}: source truth case canonical SHA mismatch`);
  }
  if (canonicalJson(manifestCase.expected) !== canonicalJson(truthCase.preflight.expected)) {
    throw new Error(`${path}: expected truth differs from catalog preflight`);
  }
  const evidencePayloadShas = [...new Set(truthCase.preflight.evidence_bindings.map((binding) => {
    if (!binding.payload_sha256) {
      throw new Error(`${path}: preflight evidence lacks a payload SHA`);
    }
    return binding.payload_sha256;
  }))].sort();
  const bindings = manifestCase.bindings;
  if (bindings.preflight_input_sha256 !== truthCase.preflight.input_sha256
    || bindings.preflight_result_canonical_sha256 !== truthCase.preflight_sha256
    || canonicalJson(bindings.evidence_payload_sha256s) !== canonicalJson(evidencePayloadShas)
    || bindings.truth_revision_id !== truthCase.truth_revision.revision_id
    || bindings.truth_revision_body_sha256 !== truthCase.truth_revision.body_sha256
    || bindings.truth_approval_sha256 !== truthCase.truth_revision.approval_sha256
    || bindings.buyer_snapshot_id !== truthCase.buyer_snapshot.snapshot_id
    || bindings.buyer_snapshot_body_sha256 !== truthCase.buyer_snapshot.body_sha256
    || bindings.buyer_main_asset_sha256 !== truthCase.buyer_snapshot.main_asset_sha256) {
    throw new Error(`${path}: manifest truth/preflight/buyer bindings differ from catalog export`);
  }
}

function verifyLocalMainBytes(
  raw: unknown,
  manifestCase: ParsedManifestCaseSource,
  path: string,
): void {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, ["case_id", "snapshot", "main_bytes"], path);
  const caseId = requiredString(raw.case_id, `${path}.case_id`);
  if (caseId !== manifestCase.case_id) {
    throw new Error(`${path} case/order differs from the exact Shadow manifest`);
  }
  if (!(raw.main_bytes instanceof Uint8Array)) {
    throw new Error(`${path}.main_bytes must be a Uint8Array`);
  }
  const { snapshot, mainAsset } = validateSealedBuyerSnapshot(raw.snapshot, `${path}.snapshot`);
  if (snapshot.target.sku !== manifestCase.sku
    || snapshot.target.item_id !== manifestCase.item_id) {
    throw new Error(`${caseId}: local MAIN snapshot identity differs from the Shadow case`);
  }
  const bindings = manifestCase.bindings;
  if (snapshot.snapshot_id !== bindings.buyer_snapshot_id
    || snapshot.body_sha256 !== bindings.buyer_snapshot_body_sha256
    || mainAsset.sha256 !== bindings.buyer_main_asset_sha256) {
    throw new Error(`${caseId}: local MAIN snapshot is detached from manifest buyer bindings`);
  }
  if (raw.main_bytes.byteLength !== mainAsset.bytes) {
    throw new Error(`${caseId}: actual MAIN byte length differs from sealed asset manifest`);
  }
  if (sha256Bytes(raw.main_bytes) !== mainAsset.sha256) {
    throw new Error(`${caseId}: actual MAIN byte SHA-256 differs from sealed asset manifest`);
  }
  const raster = inspectRasterHeader(raw.main_bytes, `${caseId} MAIN bytes`);
  if (raster.format !== mainAsset.decoded_format
    || raster.width !== mainAsset.decoded_width
    || raster.height !== mainAsset.decoded_height) {
    throw new Error(
      `${caseId}: actual MAIN raster ${raster.format} ${raster.width}x${raster.height}`
      + ` differs from sealed asset manifest ${mainAsset.decoded_format}`
      + ` ${mainAsset.decoded_width}x${mainAsset.decoded_height}`,
    );
  }
}

function deriveBlindedAssignmentSha(
  manifestCase: ParsedManifestCaseSource,
): string {
  return sha256({
    schema_version: WALMART_SHADOW_HUMAN_BLINDED_ASSIGNMENT_SCHEMA,
    case_id: manifestCase.case_id,
    sku: manifestCase.sku,
    item_id: manifestCase.item_id,
    expected_truth_sha256: sha256(manifestCase.expected),
    main_asset_sha256: manifestCase.bindings.buyer_main_asset_sha256,
    visible_inputs: ["sealed_expected_truth", "sealed_original_main"],
  });
}

function parseTrustedContextSources(raw: unknown): {
  manifest: WalmartShadow50Manifest;
  catalogTruth: WalmartCatalogTruthAuditExport;
  registry: WalmartShadowReviewerRegistry;
  localMainAssets: unknown[];
} {
  const path = "human trusted context sources";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "shadow_manifest", "catalog_truth_export", "reviewer_registry", "local_main_assets",
  ], path);
  if (!verifyWalmartShadow50Manifest(raw.shadow_manifest)) {
    throw new Error("shadow manifest full body/selection seal verification failed");
  }
  const manifest = raw.shadow_manifest;
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 50) {
    throw new Error("shadow manifest must contain exactly 50 cases");
  }
  const catalogTruth = verifyWalmartCatalogTruthAuditExport(raw.catalog_truth_export);
  const registry = parseReviewerRegistry(raw.reviewer_registry, `${path}.reviewer_registry`);
  if (!Array.isArray(raw.local_main_assets) || raw.local_main_assets.length !== 50) {
    throw new Error(`${path}.local_main_assets must contain exactly 50 ordered entries`);
  }
  return {
    manifest,
    catalogTruth,
    registry,
    localMainAssets: raw.local_main_assets,
  };
}

/**
 * Build the only execution-eligible trusted context from frozen upstream
 * artifacts. This verifies the full Shadow manifest seal, the complete catalog
 * export seal and each selected truth/preflight/buyer binding, then hashes and
 * header-preflights the exact local MAIN bytes in manifest case order.
 */
export function buildWalmartShadowHumanTrustedContext(
  rawSources: unknown,
): WalmartShadowHumanTrustedContext {
  const { manifest, catalogTruth, registry, localMainAssets } = parseTrustedContextSources(
    rawSources,
  );
  assertManifestCatalogExportBinding(manifest, catalogTruth);
  const manifestCases = manifest.cases.map((value, index) => parseManifestSourceCase(value, index));
  assertUnique(manifestCases.map((value) => value.case_id), "shadow manifest case_id");
  assertUnique(manifestCases.map((value) => value.sku), "shadow manifest case SKU");
  assertUnique(manifestCases.map((value) => value.item_id), "shadow manifest case item_id");
  assertUnique(
    manifestCases.map((value) => value.source_truth_case_id),
    "shadow manifest source truth case_id",
  );
  const truthCaseById = new Map(catalogTruth.cases.map((value) => [value.case_id, value]));
  const cases = manifestCases.map((manifestCase, index): ShadowHumanCaseBinding => {
    const truthCase = truthCaseById.get(manifestCase.source_truth_case_id);
    if (!truthCase) {
      throw new Error(`${manifestCase.case_id}: source truth case is absent from catalog export`);
    }
    assertManifestCaseMatchesCatalogTruth(manifestCase, truthCase);
    verifyLocalMainBytes(
      localMainAssets[index],
      manifestCase,
      `human trusted context sources.local_main_assets[${index}]`,
    );
    return {
      case_id: manifestCase.case_id,
      sku: manifestCase.sku,
      item_id: manifestCase.item_id,
      shadow_manifest_body_sha256: manifest.body_sha256,
      catalog_truth_export_body_sha256: catalogTruth.body_sha256,
      preflight_input_sha256: manifestCase.bindings.preflight_input_sha256,
      preflight_result_sha256: manifestCase.bindings.preflight_result_canonical_sha256,
      product_truth_snapshot_body_sha256:
        catalogTruth.product_truth_snapshot.body_sha256,
      recipe_revision_subject_sha256: manifestCase.bindings.truth_revision_body_sha256,
      recipe_approval_sha256: manifestCase.bindings.truth_approval_sha256,
      buyer_snapshot_body_sha256: manifestCase.bindings.buyer_snapshot_body_sha256,
      main_asset_sha256: manifestCase.bindings.buyer_main_asset_sha256,
      blinded_assignment_sha256: deriveBlindedAssignmentSha(manifestCase),
    };
  });
  const body = {
    schema_version: WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA,
    shadow_manifest_body_sha256: manifest.body_sha256,
    catalog_truth_export_body_sha256: catalogTruth.body_sha256,
    reviewer_registry: registry,
    cases,
  };
  const bodySha = sha256(body);
  return {
    ...body,
    context_id: `walmart-shadow-human-context-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

/**
 * Source-aware verifier. Rebuilding from unchanged sources makes a fully
 * re-sealed forged context, case reordering, or detached MAIN file fail even
 * when every attacker-controlled context SHA is internally consistent.
 */
export function verifyWalmartShadowHumanTrustedContextAgainstSources(
  rawContext: unknown,
  rawSources: unknown,
): WalmartShadowHumanTrustedContext {
  const context = validateWalmartShadowHumanTrustedContext(rawContext);
  const rebuilt = buildWalmartShadowHumanTrustedContext(rawSources);
  if (canonicalJson(context) !== canonicalJson(rebuilt)) {
    throw new Error("human trusted context does not exactly match source-derived context");
  }
  return rebuilt;
}

/**
 * Structural/self-seal validation only. This is useful while parsing label
 * artifacts, but is not sufficient to authorize execution. Call
 * verifyWalmartShadowHumanTrustedContextAgainstSources first at every trust
 * boundary; a SHA seal alone does not prove who authored a context.
 */
export function validateWalmartShadowHumanTrustedContext(
  raw: unknown,
): WalmartShadowHumanTrustedContext {
  const path = "human label trusted context";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "context_id", "body_sha256", "shadow_manifest_body_sha256",
    "catalog_truth_export_body_sha256", "reviewer_registry", "cases",
  ], path);
  if (raw.schema_version !== WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length !== 50) {
    throw new Error(`${path}.cases must contain exactly 50 source-derived bindings`);
  }
  const declaredBodySha = requiredSha(raw.body_sha256, `${path}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    shadow_manifest_body_sha256: raw.shadow_manifest_body_sha256,
    catalog_truth_export_body_sha256: raw.catalog_truth_export_body_sha256,
    reviewer_registry: raw.reviewer_registry,
    cases: raw.cases,
  };
  if (sha256(body) !== declaredBodySha) throw new Error(`${path} body SHA mismatch`);
  const contextId = requiredString(raw.context_id, `${path}.context_id`);
  if (contextId !== `walmart-shadow-human-context-${declaredBodySha.slice(0, 16)}`) {
    throw new Error(`${path}.context_id is not derived from body_sha256`);
  }
  const manifestSha = requiredSha(
    raw.shadow_manifest_body_sha256,
    `${path}.shadow_manifest_body_sha256`,
  );
  const exportSha = requiredSha(
    raw.catalog_truth_export_body_sha256,
    `${path}.catalog_truth_export_body_sha256`,
  );
  const registry = parseReviewerRegistry(raw.reviewer_registry, `${path}.reviewer_registry`);
  const cases = raw.cases.map((value, index) => parseCaseBinding(value, `${path}.cases[${index}]`));
  assertUnique(cases.map((value) => value.case_id), `${path} case_id`);
  assertUnique(cases.map((value) => value.sku), `${path} case SKU`);
  assertUnique(cases.map((value) => value.item_id), `${path} case item_id`);
  for (const binding of cases) {
    if (binding.shadow_manifest_body_sha256 !== manifestSha) {
      throw new Error(`${binding.case_id}: trusted case is detached from the Shadow manifest`);
    }
    if (binding.catalog_truth_export_body_sha256 !== exportSha) {
      throw new Error(`${binding.case_id}: trusted case is detached from the catalog truth export`);
    }
  }
  return {
    schema_version: WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA,
    context_id: contextId,
    body_sha256: declaredBodySha,
    shadow_manifest_body_sha256: manifestSha,
    catalog_truth_export_body_sha256: exportSha,
    reviewer_registry: registry,
    cases,
  };
}

function parseBuildInput(raw: unknown): ShadowHumanLabelBuildInput {
  if (!isRecord(raw)) throw new Error("human label input must be an object");
  assertExactKeys(raw, [
    "schema_version", "trusted_context_body_sha256", "finalized_at", "reviewer_labels",
    "adjudications",
  ], "human label input");
  if (raw.schema_version !== WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA) {
    throw new Error("unsupported human label input schema");
  }
  if (!Array.isArray(raw.reviewer_labels) || raw.reviewer_labels.length !== 100) {
    throw new Error("human label input must contain exactly 100 reviewer labels");
  }
  if (!Array.isArray(raw.adjudications)) {
    throw new Error("human label input adjudications must be an array");
  }
  return {
    schema_version: WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA,
    trusted_context_body_sha256: requiredSha(
      raw.trusted_context_body_sha256,
      "human label input.trusted_context_body_sha256",
    ),
    finalized_at: instant(raw.finalized_at, "human label input.finalized_at"),
    reviewer_labels: raw.reviewer_labels.map((value, index) => (
      parseReviewerLabel(value, `reviewer_labels[${index}]`)
    )),
    adjudications: raw.adjudications.map((value, index) => (
      parseAdjudication(value, `adjudications[${index}]`)
    )),
  };
}

function compareTimestamp(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

/**
 * Low-level build from an already source-verified context. Operational callers
 * must prefer buildWalmartShadowHumanLabelSetAgainstSources below; this function
 * intentionally retains structural-only behavior for deterministic artifact
 * replay after the trust boundary has already been checked.
 */
export function buildWalmartShadowHumanLabelSet(
  raw: unknown,
  rawTrustedContext: unknown,
): WalmartShadowHumanLabelSet {
  const input = parseBuildInput(raw);
  const trustedContext = validateWalmartShadowHumanTrustedContext(rawTrustedContext);
  if (input.trusted_context_body_sha256 !== trustedContext.body_sha256) {
    throw new Error("human label input is detached from the trusted source-derived context");
  }
  if (compareTimestamp(input.finalized_at, trustedContext.reviewer_registry.captured_at) <= 0) {
    throw new Error("human labels cannot be finalized before the trusted reviewer registry exists");
  }

  const caseById = new Map(trustedContext.cases.map((value) => [value.case_id, value]));
  const trustedSubjectByReviewer = new Map(
    trustedContext.reviewer_registry.reviewers.map((value) => [value.reviewer_id, value.subject_sha256]),
  );
  const labelsByCase = new Map<string, SealedShadowReviewerLabel[]>();
  for (const label of input.reviewer_labels) {
    const binding = caseById.get(label.case_id);
    if (!binding) throw new Error(`reviewer label references unknown case ${label.case_id}`);
    const bindingSha = caseBindingSha(binding);
    if (label.case_binding_sha256 !== bindingSha) {
      throw new Error(`${label.case_id}: reviewer label case binding SHA mismatch`);
    }
    const trustedSubject = trustedSubjectByReviewer.get(label.reviewer_id);
    if (!trustedSubject || trustedSubject !== label.reviewer_subject_sha256) {
      throw new Error(`${label.case_id}: reviewer identity is not bound to the trusted registry`);
    }
    if (compareTimestamp(label.labeled_at, trustedContext.reviewer_registry.captured_at) <= 0) {
      throw new Error(`${label.case_id}: reviewer label predates the trusted reviewer registry`);
    }
    if (compareTimestamp(label.labeled_at, input.finalized_at) >= 0) {
      throw new Error(`${label.case_id}: reviewer label must strictly predate finalization`);
    }
    const list = labelsByCase.get(label.case_id) ?? [];
    if (list.some((value) => value.reviewer_id === label.reviewer_id
      || value.reviewer_subject_sha256 === label.reviewer_subject_sha256)) {
      throw new Error(`${label.case_id}: reviewer labels must come from distinct trusted subjects`);
    }
    list.push(sealReviewerLabel(label));
    labelsByCase.set(label.case_id, list);
  }

  const adjudicationByCase = new Map<string, ShadowAdjudicationInput>();
  for (const adjudication of input.adjudications) {
    const binding = caseById.get(adjudication.case_id);
    if (!binding) throw new Error(`adjudication references unknown case ${adjudication.case_id}`);
    if (adjudicationByCase.has(adjudication.case_id)) {
      throw new Error(`${adjudication.case_id}: duplicate adjudication`);
    }
    if (adjudication.case_binding_sha256 !== caseBindingSha(binding)) {
      throw new Error(`${adjudication.case_id}: adjudication case binding SHA mismatch`);
    }
    const trustedSubject = trustedSubjectByReviewer.get(adjudication.adjudicator_id);
    if (!trustedSubject || trustedSubject !== adjudication.adjudicator_subject_sha256) {
      throw new Error(`${adjudication.case_id}: adjudicator identity is not bound to the trusted registry`);
    }
    if (compareTimestamp(
      adjudication.adjudicated_at,
      trustedContext.reviewer_registry.captured_at,
    ) <= 0) {
      throw new Error(`${adjudication.case_id}: adjudication predates the trusted reviewer registry`);
    }
    if (compareTimestamp(adjudication.adjudicated_at, input.finalized_at) >= 0) {
      throw new Error(`${adjudication.case_id}: adjudication must strictly predate finalization`);
    }
    adjudicationByCase.set(adjudication.case_id, adjudication);
  }

  const finalCases = trustedContext.cases.map((binding): FinalShadowHumanCase => {
    const labels = labelsByCase.get(binding.case_id) ?? [];
    if (labels.length !== 2) {
      throw new Error(`${binding.case_id}: exactly two independent reviewer labels are required`);
    }
    labels.sort((left, right) => left.reviewer_id.localeCompare(right.reviewer_id));
    const pair = labels as [SealedShadowReviewerLabel, SealedShadowReviewerLabel];
    const requiresAdjudication = pair[0].verdict === "UNRESOLVED"
      || pair[1].verdict === "UNRESOLVED"
      || pair[0].verdict !== pair[1].verdict;
    const adjudicationInput = adjudicationByCase.get(binding.case_id) ?? null;
    if (requiresAdjudication && !adjudicationInput) {
      throw new Error(`${binding.case_id}: disagreement or UNRESOLVED requires adjudication`);
    }
    if (!requiresAdjudication && adjudicationInput) {
      throw new Error(`${binding.case_id}: agreeing decisive reviewers must not be overridden`);
    }

    let adjudication: SealedShadowAdjudication | null = null;
    let finalVerdict: ShadowFinalHumanVerdict;
    let finalBasis: FinalShadowHumanCase["final_label_basis"];
    if (adjudicationInput) {
      if (pair.some((label) => label.reviewer_id === adjudicationInput.adjudicator_id
        || label.reviewer_subject_sha256 === adjudicationInput.adjudicator_subject_sha256)) {
        throw new Error(`${binding.case_id}: adjudicator must be a distinct third trusted subject`);
      }
      const actualHashes = pair.map((label) => label.label_sha256).sort();
      const declaredHashes = [...adjudicationInput.reviewer_label_sha256s].sort();
      if (actualHashes[0] !== declaredHashes[0] || actualHashes[1] !== declaredHashes[1]) {
        throw new Error(`${binding.case_id}: adjudication is not bound to the two reviewer labels`);
      }
      const lastReviewerTimestamp = pair.reduce((latest, label) => (
        compareTimestamp(label.labeled_at, latest) > 0 ? label.labeled_at : latest
      ), pair[0].labeled_at);
      if (compareTimestamp(adjudicationInput.adjudicated_at, lastReviewerTimestamp) <= 0) {
        throw new Error(`${binding.case_id}: adjudication must strictly follow both reviewer labels`);
      }
      adjudication = sealAdjudication({
        ...adjudicationInput,
        reviewer_label_sha256s: declaredHashes as [string, string],
      });
      finalVerdict = adjudication.final_verdict;
      finalBasis = "third_party_adjudication";
    } else {
      finalVerdict = pair[0].verdict as ShadowFinalHumanVerdict;
      finalBasis = "reviewer_agreement";
    }

    return {
      binding,
      case_binding_sha256: caseBindingSha(binding),
      reviewer_labels: pair,
      adjudication,
      final_verdict: finalVerdict,
      final_label_basis: finalBasis,
    };
  });

  if (adjudicationByCase.size !== finalCases.filter((value) => value.adjudication).length) {
    throw new Error("unconsumed adjudication records remain");
  }
  const passCases = finalCases.filter((value) => value.final_verdict === "PASS").length;
  const body = {
    schema_version: WALMART_SHADOW_HUMAN_LABEL_SET_SCHEMA,
    trusted_context_body_sha256: trustedContext.body_sha256,
    shadow_manifest_body_sha256: trustedContext.shadow_manifest_body_sha256,
    catalog_truth_export_body_sha256: trustedContext.catalog_truth_export_body_sha256,
    reviewer_registry_body_sha256: trustedContext.reviewer_registry.body_sha256,
    finalized_at: input.finalized_at,
    execution_proof_status: "PENDING" as const,
    cases: finalCases,
    summary: {
      total_cases: 50 as const,
      reviewer_labels: 100 as const,
      adjudicated_cases: finalCases.filter((value) => value.adjudication).length,
      pass_cases: passCases,
      bad_cases: finalCases.length - passCases,
      unresolved_final_cases: 0 as const,
    },
  };
  return { ...body, body_sha256: sha256(body) };
}

/** Build a label set only after recomputing the trusted context from exact sources. */
export function buildWalmartShadowHumanLabelSetAgainstSources(
  raw: unknown,
  rawTrustedContext: unknown,
  rawSources: unknown,
): WalmartShadowHumanLabelSet {
  const trustedContext = verifyWalmartShadowHumanTrustedContextAgainstSources(
    rawTrustedContext,
    rawSources,
  );
  return buildWalmartShadowHumanLabelSet(raw, trustedContext);
}

/**
 * Revalidate a serialized label set without trusting its declared seal. The
 * embedded source records are reconstructed into the original build input so
 * every individual binding, decision, adjudication, summary, and body hash is
 * recomputed.
 */
export function validateWalmartShadowHumanLabelSet(
  raw: unknown,
  rawTrustedContext: unknown,
): WalmartShadowHumanLabelSet {
  const trustedContext = validateWalmartShadowHumanTrustedContext(rawTrustedContext);
  if (!isRecord(raw)) throw new Error("human label set must be an object");
  assertExactKeys(raw, [
    "schema_version", "trusted_context_body_sha256", "shadow_manifest_body_sha256",
    "catalog_truth_export_body_sha256", "reviewer_registry_body_sha256", "finalized_at",
    "execution_proof_status", "cases", "summary", "body_sha256",
  ], "human label set");
  if (raw.schema_version !== WALMART_SHADOW_HUMAN_LABEL_SET_SCHEMA) {
    throw new Error("unsupported human label set schema");
  }
  const declaredBodySha = requiredSha(raw.body_sha256, "human label set.body_sha256");
  const body = { ...raw };
  delete body.body_sha256;
  if (sha256(body) !== declaredBodySha) throw new Error("human label set body SHA mismatch");
  if (!Array.isArray(raw.cases) || raw.cases.length !== 50) {
    throw new Error("human label set must contain exactly 50 final cases");
  }
  if (raw.trusted_context_body_sha256 !== trustedContext.body_sha256
    || raw.shadow_manifest_body_sha256 !== trustedContext.shadow_manifest_body_sha256
    || raw.catalog_truth_export_body_sha256 !== trustedContext.catalog_truth_export_body_sha256
    || raw.reviewer_registry_body_sha256 !== trustedContext.reviewer_registry.body_sha256) {
    throw new Error("human label set is detached from the trusted source-derived context");
  }
  if (raw.execution_proof_status !== "PENDING") {
    throw new Error("pre-execution human label set execution_proof_status must be PENDING");
  }

  const reviewerLabels: ShadowReviewerLabelInput[] = [];
  const adjudications: ShadowAdjudicationInput[] = [];
  for (const [index, value] of raw.cases.entries()) {
    if (!isRecord(value)) throw new Error(`human label set.cases[${index}] must be an object`);
    assertExactKeys(value, [
      "binding", "case_binding_sha256", "reviewer_labels", "adjudication",
      "final_verdict", "final_label_basis",
    ], `human label set.cases[${index}]`);
    const binding = parseCaseBinding(value.binding, `human label set.cases[${index}].binding`);
    if (canonicalJson(binding) !== canonicalJson(trustedContext.cases[index])) {
      throw new Error(`${binding.case_id}: final case binding/order differs from trusted context`);
    }
    if (requiredSha(value.case_binding_sha256, `human label set.cases[${index}].case_binding_sha256`)
      !== caseBindingSha(binding)) {
      throw new Error(`${binding.case_id}: final case binding SHA mismatch`);
    }
    if (!Array.isArray(value.reviewer_labels) || value.reviewer_labels.length !== 2) {
      throw new Error(`${binding.case_id}: final case must contain two reviewer labels`);
    }
    for (const [labelIndex, labelRaw] of value.reviewer_labels.entries()) {
      if (!isRecord(labelRaw)) throw new Error(`${binding.case_id}: reviewer label must be an object`);
      const { label_sha256: labelShaRaw, ...labelBody } = labelRaw;
      assertExactKeys(labelRaw, [
        "case_id", "case_binding_sha256", "reviewer_id", "reviewer_subject_sha256",
        "verdict", "defect_codes", "rationale", "labeled_at", "label_sha256",
      ], `${binding.case_id}.reviewer_labels[${labelIndex}]`);
      const parsed = parseReviewerLabel(labelBody, `${binding.case_id}.reviewer_labels[${labelIndex}]`);
      if (requiredSha(labelShaRaw, `${binding.case_id}.reviewer_labels[${labelIndex}].label_sha256`)
        !== sha256(parsed)) {
        throw new Error(`${binding.case_id}: reviewer label SHA mismatch`);
      }
      reviewerLabels.push(parsed);
    }
    if (value.adjudication !== null) {
      if (!isRecord(value.adjudication)) throw new Error(`${binding.case_id}: adjudication must be an object or null`);
      const { adjudication_sha256: adjudicationShaRaw, ...adjudicationBody } = value.adjudication;
      assertExactKeys(value.adjudication, [
        "case_id", "case_binding_sha256", "adjudicator_id", "adjudicator_subject_sha256",
        "reviewer_label_sha256s", "final_verdict", "defect_codes", "rationale",
        "adjudicated_at", "adjudication_sha256",
      ], `${binding.case_id}.adjudication`);
      const parsed = parseAdjudication(adjudicationBody, `${binding.case_id}.adjudication`);
      if (requiredSha(adjudicationShaRaw, `${binding.case_id}.adjudication.adjudication_sha256`)
        !== sha256(parsed)) {
        throw new Error(`${binding.case_id}: adjudication SHA mismatch`);
      }
      adjudications.push(parsed);
    }
  }

  const rebuilt = buildWalmartShadowHumanLabelSet({
    schema_version: WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA,
    trusted_context_body_sha256: raw.trusted_context_body_sha256,
    finalized_at: raw.finalized_at,
    reviewer_labels: reviewerLabels,
    adjudications,
  }, trustedContext);
  if (canonicalJson(rebuilt) !== canonicalJson(raw)) {
    throw new Error("human label set derived content mismatch");
  }
  return rebuilt;
}

/** Revalidate a serialized label set through the same source-aware trust boundary. */
export function validateWalmartShadowHumanLabelSetAgainstSources(
  raw: unknown,
  rawTrustedContext: unknown,
  rawSources: unknown,
): WalmartShadowHumanLabelSet {
  const trustedContext = verifyWalmartShadowHumanTrustedContextAgainstSources(
    rawTrustedContext,
    rawSources,
  );
  return validateWalmartShadowHumanLabelSet(raw, trustedContext);
}

export function validateWalmartShadowHumanExecutionEvidence(
  raw: unknown,
): WalmartShadowHumanExecutionEvidence {
  const path = "human label execution evidence";
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  assertExactKeys(raw, [
    "schema_version", "evidence_id", "body_sha256", "human_label_set_body_sha256",
    "shadow_manifest_body_sha256", "first_primary_call_at",
  ], path);
  if (raw.schema_version !== WALMART_SHADOW_HUMAN_EXECUTION_EVIDENCE_SCHEMA) {
    throw new Error(`${path}.schema_version is unsupported`);
  }
  const bodySha = requiredSha(raw.body_sha256, `${path}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    human_label_set_body_sha256: raw.human_label_set_body_sha256,
    shadow_manifest_body_sha256: raw.shadow_manifest_body_sha256,
    first_primary_call_at: raw.first_primary_call_at,
  };
  if (sha256(body) !== bodySha) throw new Error(`${path} body SHA mismatch`);
  const evidenceId = requiredString(raw.evidence_id, `${path}.evidence_id`);
  if (evidenceId !== `walmart-shadow-human-execution-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path}.evidence_id is not derived from body_sha256`);
  }
  return {
    schema_version: WALMART_SHADOW_HUMAN_EXECUTION_EVIDENCE_SCHEMA,
    evidence_id: evidenceId,
    body_sha256: bodySha,
    human_label_set_body_sha256: requiredSha(
      raw.human_label_set_body_sha256,
      `${path}.human_label_set_body_sha256`,
    ),
    shadow_manifest_body_sha256: requiredSha(
      raw.shadow_manifest_body_sha256,
      `${path}.shadow_manifest_body_sha256`,
    ),
    first_primary_call_at: instant(
      raw.first_primary_call_at,
      `${path}.first_primary_call_at`,
    ),
  };
}

/**
 * Verify the pre-run label set against trusted execution evidence containing
 * the actual first primary-call timestamp. The evidence SHA is an integrity
 * binding, not timestamp authentication; callers must obtain this object from
 * the trusted execution/session attestation path.
 */
export function validateWalmartShadowHumanLabelSetAgainstExecutionEvidence(
  rawLabelSet: unknown,
  rawTrustedContext: unknown,
  rawExecutionEvidence: unknown,
): WalmartShadowHumanLabelSet {
  const labelSet = validateWalmartShadowHumanLabelSet(rawLabelSet, rawTrustedContext);
  const evidence = validateWalmartShadowHumanExecutionEvidence(rawExecutionEvidence);
  if (evidence.human_label_set_body_sha256 !== labelSet.body_sha256) {
    throw new Error("execution evidence is detached from the exact human label set");
  }
  if (evidence.shadow_manifest_body_sha256 !== labelSet.shadow_manifest_body_sha256) {
    throw new Error("execution evidence is detached from the Shadow manifest");
  }
  if (compareTimestamp(labelSet.finalized_at, evidence.first_primary_call_at) >= 0) {
    throw new Error("human label set was not finalized before the first primary model call");
  }
  for (const humanCase of labelSet.cases) {
    for (const label of humanCase.reviewer_labels) {
      if (compareTimestamp(label.labeled_at, evidence.first_primary_call_at) >= 0) {
        throw new Error(`${humanCase.binding.case_id}: reviewer label was not created before the first primary call`);
      }
    }
    if (humanCase.adjudication
      && compareTimestamp(
        humanCase.adjudication.adjudicated_at,
        evidence.first_primary_call_at,
      ) >= 0) {
      throw new Error(`${humanCase.binding.case_id}: adjudication was not created before the first primary call`);
    }
  }
  return labelSet;
}

/**
 * Operational execution-proof verifier: source-rebuild the trusted context
 * before applying the unchanged first-primary-call temporal contract.
 */
export function validateWalmartShadowHumanLabelSetAgainstSourcesAndExecutionEvidence(
  rawLabelSet: unknown,
  rawTrustedContext: unknown,
  rawSources: unknown,
  rawExecutionEvidence: unknown,
): WalmartShadowHumanLabelSet {
  const trustedContext = verifyWalmartShadowHumanTrustedContextAgainstSources(
    rawTrustedContext,
    rawSources,
  );
  return validateWalmartShadowHumanLabelSetAgainstExecutionEvidence(
    rawLabelSet,
    trustedContext,
    rawExecutionEvidence,
  );
}

/** Public helper used by the offline labeling UI/exporter. */
export function walmartShadowHumanCaseBindingSha256(binding: ShadowHumanCaseBinding): string {
  return caseBindingSha(parseCaseBinding(binding, "case binding"));
}
