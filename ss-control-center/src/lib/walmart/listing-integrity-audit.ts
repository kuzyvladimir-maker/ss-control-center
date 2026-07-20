/**
 * Pure listing-level Walmart integrity audit.
 *
 * This is the deterministic boundary between an untrusted executor (which may
 * capture text and return blind image observations) and an audit verdict.  It
 * performs no I/O and never accepts a caller-authored image verdict.
 */

import { createHash } from "node:crypto";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  WALMART_VISUAL_AUDIT_SCHEMA,
  WALMART_VISUAL_COMPARATOR_VERSION,
  decideBlind,
  parseBlindResponse,
  parseVisibleSizeTexts,
  validateAuditManifest,
  type AuditAuxiliaryEvidence,
  type AuditDecision,
  type AuditExpectedTruth,
  type AuditImageInput,
  type BlindObservation,
  type ExpectedSize,
  type ImageSlot,
  type SizeUnit,
} from "./catalog-visual-audit.ts";
import {
  DEFAULT_GALLERY_DHASH_DISTANCE,
  WALMART_GALLERY_AUDIT_VERSION,
  auditGallerySlot,
  fingerprintGalleryImage,
  galleryDhashDistance,
  type GalleryAuditDecision,
} from "./catalog-gallery-audit.ts";
import { extractTitleOuterCountEvidence } from "./catalog-visual-truth-preflight.ts";
import {
  verifyWalmartCatalogTruthAuditExportAgainstSources,
  type ProductTruthWalmartAuditSnapshot,
  type WalmartBuyerSnapshotIndex,
  type WalmartCatalogTruthAuditExport,
} from "./catalog-truth-export.ts";
import {
  resolveExactBuyerPdp,
  type SealedWalmartBuyerSnapshot,
} from "./buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "./exact-item-resolution.ts";
import { preprocessCatalogVisual } from "./catalog-visual-preprocess.ts";
import {
  verifyWalmartListingObservationBatch,
  verifyWalmartListingObservationTechnicalErrorTerminal,
  walmartListingObservationImageId,
  type SealedWalmartListingObservationBatch,
  type SealedWalmartListingObservationTechnicalErrorTerminal,
} from "./listing-integrity-observation.ts";

export const WALMART_LISTING_INTEGRITY_INPUT_SCHEMA =
  "walmart-listing-integrity-input/v1" as const;
export const WALMART_LISTING_INTEGRITY_REPORT_SCHEMA =
  "walmart-listing-integrity-report/v1" as const;
export const WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA =
  "walmart-listing-surface-snapshot/v1" as const;
export const WALMART_LISTING_INTEGRITY_ENGINE_VERSION =
  "walmart-listing-integrity-engine/v1" as const;

export type ListingIntegrityVerdict = "PASS" | "BAD" | "REVIEW" | "UNSUPPORTED";

type JsonRecord = Record<string, unknown>;
type IdentityClaimKind = "brand" | "product" | "variant";
type AttributeClaimKind = IdentityClaimKind | "outer_units" | "net_content" | "inner_item_count";

export type ListingAttributeClaim =
  | { field_path: string; kind: IdentityClaimKind; text: string }
  | { field_path: string; kind: "outer_units"; value: number; unit: "count" }
  | { field_path: string; kind: "inner_item_count"; value: number; unit: "count" }
  | { field_path: string; kind: "net_content"; value: number; unit: Exclude<SizeUnit, "count"> };

export interface WalmartListingSurface {
  title: string;
  description: string | null;
  bullets: string[];
  attribute_claims: ListingAttributeClaim[];
  unmapped_attributes: Array<{ field_path: string; value_sha256: string }>;
}

export interface ListingIntegritySourceBindings {
  product_truth_snapshot_id: string;
  product_truth_snapshot_body_sha256: string;
  catalog_truth_export_id: string;
  catalog_truth_export_body_sha256: string;
  catalog_truth_case_id: string;
  catalog_truth_preflight_sha256: string;
  truth_revision_id: string;
  truth_revision_body_sha256: string;
  truth_approval_sha256: string;
  buyer_index_id: string;
  buyer_index_body_sha256: string;
  buyer_snapshot_id: string;
  buyer_snapshot_body_sha256: string;
  buyer_payload_sha256: string;
  surface_snapshot_id: string;
  surface_snapshot_body_sha256: string;
  surface_payload_sha256: string;
}

export interface ListingIntegrityImageAsset {
  slot: ImageSlot;
  source_url: string;
  sha256: string;
  byte_length: number;
  decoded_width: number;
  decoded_height: number;
  /** Orientation-normalized 64-bit dHash, recomputed from bytes by the CLI. */
  dhash64: string;
  buyer_facing_verified: true;
  surface: "buyer_pdp";
}

export type ListingIntegrityImageEvidence =
  | {
      slot: ImageSlot;
      asset_sha256: string;
      state: "observed";
      observation: BlindObservation;
      auxiliary_ocr: AuditAuxiliaryEvidence;
      local_ocr_truncated: boolean;
    }
  | {
      slot: ImageSlot;
      asset_sha256: string;
      state: "missing";
      reason: string;
    }
  | {
      slot: ImageSlot;
      asset_sha256: string;
      state: "technical_error";
      error: string;
    };

export interface ListingIntegrityDuplicateSummary {
  source_binding_sha256: string;
  dhash_distance_threshold: typeof DEFAULT_GALLERY_DHASH_DISTANCE;
  exact_duplicate_groups: number;
  near_duplicate_pairs: number;
  missing_assets: number;
  technical_errors: number;
}

export interface WalmartListingIntegrityInput {
  schema_version: typeof WALMART_LISTING_INTEGRITY_INPUT_SCHEMA;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
    published_status: "PUBLISHED";
    lifecycle_status: "ACTIVE";
    captured_at: string;
    composition: "same_product" | "mixed_bundle" | "variety_pack";
  };
  source_bindings: ListingIntegritySourceBindings;
  expected: AuditExpectedTruth;
  surface: WalmartListingSurface;
  images: {
    assets: ListingIntegrityImageAsset[];
    evidence: ListingIntegrityImageEvidence[];
    duplicate_summary: ListingIntegrityDuplicateSummary | null;
  };
}

export interface ListingTextAuditDecision {
  verdict: "PASS" | "BAD" | "REVIEW";
  checks: {
    title_identity: "MATCH" | "MISMATCH" | "UNKNOWN";
    title_outer_units: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    title_package_facts: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    body_identity: "MATCH" | "MISMATCH" | "UNKNOWN";
    body_outer_units: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    body_package_facts: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    attributes_identity: "MATCH" | "MISMATCH" | "UNKNOWN";
    attributes_outer_units: "MATCH" | "MISMATCH" | "UNKNOWN";
    attributes_package_facts: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
  };
  hard_failures: string[];
  review_reasons: string[];
}

export interface WalmartListingIntegrityReportBody {
  schema_version: typeof WALMART_LISTING_INTEGRITY_REPORT_SCHEMA;
  input_body_sha256: string;
  listing: WalmartListingIntegrityInput["listing"];
  source_bindings: ListingIntegritySourceBindings;
  text_decision: ListingTextAuditDecision;
  main_decision: AuditDecision | { verdict: "REVIEW"; reason: string };
  gallery_decisions: GalleryAuditDecision[];
  duplicate_summary: ListingIntegrityDuplicateSummary | null;
  engine_versions: {
    listing_engine: typeof WALMART_LISTING_INTEGRITY_ENGINE_VERSION;
    blind_prompt: typeof BLIND_PROMPT_VERSION;
    main_comparator: typeof WALMART_VISUAL_COMPARATOR_VERSION;
    gallery_comparator: typeof WALMART_GALLERY_AUDIT_VERSION;
  };
  overall_verdict: ListingIntegrityVerdict;
  blocking_reasons: string[];
  review_reasons: string[];
  provenance: null | {
    run_lock_sha256: string;
    code_bundle_id: string;
    code_bundle_manifest_sha256: string;
    worker_receipt_key_id: string;
    worker_receipt_public_key_sha256: string;
    observation_artifacts: Array<{
      artifact_id: string;
      body_sha256: string;
      call_key: string;
      shard_id: string;
      call_index: number;
    }>;
  };
  assurance: {
    compilation_mode: "input_only" | "source_aware";
    source_artifacts_verified: boolean;
    surface_snapshot_verified: boolean;
    asset_bytes_verified: boolean;
    observation_artifacts_verified: boolean;
    caller_verdicts_accepted: false;
    image_decisions_recomputed: true;
    unknown_promoted_to_pass: false;
    network_calls: 0;
    model_calls: 0;
    marketplace_writes: 0;
    database_writes: 0;
  };
}

export interface SealedWalmartListingIntegrityReport extends WalmartListingIntegrityReportBody {
  report_id: string;
  body_sha256: string;
}

export interface WalmartListingSurfaceSnapshotBody {
  schema_version: typeof WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA;
  captured_at: string;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
    published_status: "PUBLISHED";
    lifecycle_status: "ACTIVE";
  };
  buyer_source: {
    contract: "walmart_buyer_pdp_exact_item_get";
    buyer_snapshot_id: string;
    buyer_snapshot_body_sha256: string;
    buyer_payload_sha256: string;
    exact_item_id_echo: true;
    complete_attribute_inventory: true;
  };
  surface: WalmartListingSurface;
}

export interface SealedWalmartListingSurfaceSnapshot extends WalmartListingSurfaceSnapshotBody {
  snapshot_id: string;
  body_sha256: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[], path: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${path} keys must be exactly ${expected.join(",")}`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`${path} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  const parsed = stringValue(value, path);
  if (parsed.length > maximum) throw new Error(`${path} must contain <=${maximum} characters`);
  return parsed;
}

function sha(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error(`${path} must be lowercase SHA-256`);
  return parsed;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function timestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${path} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON rejects undefined");
  return encoded;
}

export function walmartListingIntegritySha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function buyerSurfaceRoot(payload: unknown): JsonRecord {
  if (!isRecord(payload)) throw new Error("buyer PDP response must be an object");
  if (isRecord(payload.product)) return payload.product;
  if (isRecord(payload.data) && isRecord(payload.data.product)) return payload.data.product;
  if (typeof payload.main_image === "string" || typeof payload.mainImage === "string") {
    return payload;
  }
  throw new Error("buyer PDP response has no recognized product object");
}

function compactBuyerText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const compact = value.trim().replace(/\s+/gu, " ");
  if (!compact) throw new Error(`${path} must be non-empty`);
  return compact;
}

function buyerHtmlToText(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${path} must be a string or null`);
  const decoded = value
    .replace(/<\s*li(?:\s[^>]*)?>/giu, " ")
    .replace(/<\s*br\s*\/?>/giu, " ")
    .replace(/<\/\s*(?:li|p|div|ul|ol|h[1-6])\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;|&#38;/giu, "&")
    .replace(/&quot;|&#34;/giu, "\"")
    .replace(/&apos;|&#39;|&rsquo;/giu, "'")
    .replace(/&lt;|&#60;/giu, "<")
    .replace(/&gt;|&#62;/giu, ">")
    .trim()
    .replace(/\s+/gu, " ");
  return decoded || null;
}

function exactPositiveInteger(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function structuredNetContent(value: unknown): { value: number; unit: Exclude<SizeUnit, "count"> } | null {
  let rawValue: unknown;
  let rawUnit: unknown;
  if (isRecord(value)) {
    rawValue = value.value;
    rawUnit = value.unit;
  } else if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|lb|lbs|g|kg|ml|l)$/iu);
    if (!match) return null;
    rawValue = Number(match[1]);
    rawUnit = match[2];
  } else {
    return null;
  }
  const numeric = typeof rawValue === "number" ? rawValue
    : typeof rawValue === "string" && /^\d+(?:\.\d+)?$/u.test(rawValue.trim())
      ? Number(rawValue.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || typeof rawUnit !== "string") return null;
  const normalized = rawUnit.toLowerCase().replace(/[.\s]+/gu, "_").replace(/lbs?$/u, "lb");
  const unit = normalized === "fl_oz" ? "fl_oz" : normalized;
  if (!new Set(["oz", "fl_oz", "lb", "g", "kg", "ml", "l"]).has(unit)) return null;
  return { value: numeric, unit: unit as Exclude<SizeUnit, "count"> };
}

const BUYER_SURFACE_CONSUMED_KEYS = new Set([
  "item_id", "itemId", "us_item_id", "usItemId", "walmart_item_id", "walmartItemId",
  "product_url", "productUrl", "link", "url", "title", "productName",
  "main_image", "mainImage", "images", "image_urls", "imageUrls",
  "description", "feature_bullets",
]);

const ATTRIBUTE_CONTAINER_KEYS = new Set([
  "attributes", "specifications", "specification_highlights", "specificationHighlights",
]);

function normalizedAttributeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function projectAttribute(
  fieldPath: string,
  rawName: string,
  value: unknown,
): ListingAttributeClaim | null {
  const name = normalizedAttributeName(rawName);
  if (name === "brand" && typeof value === "string" && value.trim()) {
    return { field_path: fieldPath, kind: "brand", text: compactBuyerText(value, fieldPath) };
  }
  if ((name === "product type" || name === "product category")
    && typeof value === "string" && value.trim()) {
    return { field_path: fieldPath, kind: "product", text: compactBuyerText(value, fieldPath) };
  }
  if ((name === "variant" || name === "flavor")
    && typeof value === "string" && value.trim()) {
    return { field_path: fieldPath, kind: "variant", text: compactBuyerText(value, fieldPath) };
  }
  if (name === "multipack quantity" || name === "number of packs" || name === "pack quantity") {
    const count = exactPositiveInteger(value);
    return count === null ? null
      : { field_path: fieldPath, kind: "outer_units", value: count, unit: "count" };
  }
  if (name === "inner item count") {
    const count = exactPositiveInteger(value);
    return count === null ? null
      : { field_path: fieldPath, kind: "inner_item_count", value: count, unit: "count" };
  }
  if (name === "net content" || name === "net weight" || name === "net volume") {
    const parsed = structuredNetContent(value);
    return parsed === null ? null
      : { field_path: fieldPath, kind: "net_content", ...parsed };
  }
  return null;
}

function inventoryAttributeContainer(
  containerKey: string,
  value: unknown,
): Array<{ field_path: string; name: string; value: unknown; hash_value: unknown }> {
  const base = `product.${containerKey}`;
  if (isRecord(value)) {
    return Object.keys(value).sort().map((key) => ({
      field_path: `${base}.${key}`,
      name: key,
      value: value[key],
      hash_value: value[key],
    }));
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (isRecord(entry)) {
        const name = typeof entry.name === "string" ? entry.name
          : typeof entry.key === "string" ? entry.key : null;
        const keys = Object.keys(entry).sort();
        if (name && Object.prototype.hasOwnProperty.call(entry, "value")
          && keys.every((key) => key === "name" || key === "key" || key === "value")) {
          return {
            field_path: `${base}[${index}].${name}`,
            name,
            value: entry.value,
            hash_value: entry.value,
          };
        }
      }
      return {
        field_path: `${base}[${index}]`,
        name: "",
        value: entry,
        hash_value: entry,
      };
    });
  }
  return [{ field_path: base, name: "", value, hash_value: value }];
}

/**
 * Deterministically rebuild every represented buyer-visible text field from
 * the exact raw buyer-PDP payload. Unknown fields are never discarded: they
 * become hashed `unmapped_attributes`, which forces REVIEW instead of PASS.
 */
export function projectWalmartListingSurfaceFromBuyerPdp(
  payload: unknown,
  target: { sku: string; item_id: string },
): WalmartListingSurface {
  const product = buyerSurfaceRoot(payload);
  const resolved = resolveExactBuyerPdp(payload, target);
  const description = buyerHtmlToText(product.description, "product.description");
  const bulletValue = product.feature_bullets;
  if (bulletValue !== undefined && !Array.isArray(bulletValue)) {
    throw new Error("product.feature_bullets must be an array when present");
  }
  const bullets = (bulletValue ?? []).map((value, index) => (
    compactBuyerText(value, `product.feature_bullets[${index}]`)
  ));
  if (new Set(bullets).size !== bullets.length) {
    throw new Error("product.feature_bullets contains duplicates");
  }

  const attributeClaims: ListingAttributeClaim[] = [];
  const unmappedAttributes: Array<{ field_path: string; value_sha256: string }> = [];
  const containerKeys = Object.keys(product).filter((key) => ATTRIBUTE_CONTAINER_KEYS.has(key));
  if (containerKeys.length > 1) {
    throw new Error("buyer PDP exposes multiple competing attribute containers");
  }
  for (const key of Object.keys(product).sort()) {
    if (BUYER_SURFACE_CONSUMED_KEYS.has(key)) continue;
    if (ATTRIBUTE_CONTAINER_KEYS.has(key)) {
      for (const entry of inventoryAttributeContainer(key, product[key])) {
        const claim = entry.name
          ? projectAttribute(entry.field_path, entry.name, entry.value)
          : null;
        if (claim) attributeClaims.push(claim);
        else unmappedAttributes.push({
          field_path: entry.field_path,
          value_sha256: walmartListingIntegritySha256(entry.hash_value),
        });
      }
      continue;
    }
    const claim = projectAttribute(`product.${key}`, key, product[key]);
    if (claim) attributeClaims.push(claim);
    else unmappedAttributes.push({
      field_path: `product.${key}`,
      value_sha256: walmartListingIntegritySha256(product[key]),
    });
  }
  return parseSurface({
    title: resolved.title,
    description,
    bullets,
    attribute_claims: attributeClaims,
    unmapped_attributes: unmappedAttributes,
  });
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsAlias(value: string, aliases: readonly string[]): boolean {
  const haystack = ` ${normalize(value)} `;
  return aliases.some((alias) => {
    const needle = normalize(alias);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

function parseBindings(value: unknown): ListingIntegritySourceBindings {
  if (!isRecord(value)) throw new Error("source_bindings must be an object");
  const keys = [
    "product_truth_snapshot_id", "product_truth_snapshot_body_sha256",
    "catalog_truth_export_id", "catalog_truth_export_body_sha256", "catalog_truth_case_id",
    "catalog_truth_preflight_sha256", "truth_revision_id", "truth_revision_body_sha256",
    "truth_approval_sha256", "buyer_index_id", "buyer_index_body_sha256",
    "buyer_snapshot_id", "buyer_snapshot_body_sha256", "buyer_payload_sha256",
    "surface_snapshot_id", "surface_snapshot_body_sha256", "surface_payload_sha256",
  ] as const;
  exactKeys(value, keys, "source_bindings");
  const parsed = {} as Record<(typeof keys)[number], string>;
  for (const key of keys) {
    parsed[key] = key.endsWith("sha256") ? sha(value[key], `source_bindings.${key}`)
      : stringValue(value[key], `source_bindings.${key}`);
  }
  return parsed as ListingIntegritySourceBindings;
}

function parseClaims(value: unknown): ListingAttributeClaim[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("surface.attribute_claims must contain <=500 rows");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = `surface.attribute_claims[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    const field = stringValue(entry.field_path, `${path}.field_path`);
    const kind = entry.kind as AttributeClaimKind;
    if (seen.has(`${field}\u0000${String(kind)}`)) throw new Error(`${path} duplicates field/kind`);
    seen.add(`${field}\u0000${String(kind)}`);
    if (kind === "brand" || kind === "product" || kind === "variant") {
      exactKeys(entry, ["field_path", "kind", "text"], path);
      return { field_path: field, kind, text: stringValue(entry.text, `${path}.text`) };
    }
    if (kind === "outer_units" || kind === "inner_item_count") {
      exactKeys(entry, ["field_path", "kind", "value", "unit"], path);
      if (entry.unit !== "count") throw new Error(`${path}.unit must be count`);
      return { field_path: field, kind, value: integer(entry.value, `${path}.value`, 1), unit: "count" };
    }
    if (kind === "net_content") {
      exactKeys(entry, ["field_path", "kind", "value", "unit"], path);
      if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || entry.value <= 0) {
        throw new Error(`${path}.value must be positive`);
      }
      const units = new Set<SizeUnit>(["oz", "fl_oz", "lb", "g", "kg", "ml", "l"]);
      if (!units.has(entry.unit as SizeUnit)) throw new Error(`${path}.unit is invalid`);
      return { field_path: field, kind, value: entry.value, unit: entry.unit as Exclude<SizeUnit, "count"> };
    }
    throw new Error(`${path}.kind is unsupported`);
  });
}

function parseSurface(value: unknown): WalmartListingSurface {
  if (!isRecord(value)) throw new Error("surface must be an object");
  exactKeys(value, [
    "title", "description", "bullets", "attribute_claims", "unmapped_attributes",
  ], "surface");
  const title = boundedString(value.title, "surface.title", 1_000);
  const description = value.description === null
    ? null : boundedString(value.description, "surface.description", 100_000);
  if (!Array.isArray(value.bullets) || value.bullets.length > 100) {
    throw new Error("surface.bullets is invalid");
  }
  const bullets = value.bullets.map((entry, index) => boundedString(entry, `surface.bullets[${index}]`, 10_000));
  if (new Set(bullets).size !== bullets.length) throw new Error("surface.bullets contains duplicates");
  if (!Array.isArray(value.unmapped_attributes) || value.unmapped_attributes.length > 10_000) {
    throw new Error("surface.unmapped_attributes must contain <=10000 rows");
  }
  const unmappedAttributes = value.unmapped_attributes.map((entry, index) => {
    const path = `surface.unmapped_attributes[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    exactKeys(entry, ["field_path", "value_sha256"], path);
    return {
      field_path: stringValue(entry.field_path, `${path}.field_path`),
      value_sha256: sha(entry.value_sha256, `${path}.value_sha256`),
    };
  });
  if (new Set(unmappedAttributes.map((row) => row.field_path)).size !== unmappedAttributes.length) {
    throw new Error("surface.unmapped_attributes contains duplicate field_path values");
  }
  return {
    title, description, bullets, attribute_claims: parseClaims(value.attribute_claims),
    unmapped_attributes: unmappedAttributes,
  };
}

function parseSurfaceSnapshot(raw: unknown): SealedWalmartListingSurfaceSnapshot {
  if (!isRecord(raw)) throw new Error("surface snapshot must be an object");
  exactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "listing", "buyer_source", "surface",
  ], "surface_snapshot");
  if (raw.schema_version !== WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA) {
    throw new Error("unsupported surface snapshot schema");
  }
  if (!isRecord(raw.listing)) throw new Error("surface_snapshot.listing must be an object");
  exactKeys(raw.listing, [
    "channel", "store_index", "sku", "listing_key", "item_id", "published_status", "lifecycle_status",
  ], "surface_snapshot.listing");
  const storeIndex = integer(raw.listing.store_index, "surface_snapshot.listing.store_index", 1);
  const sku = stringValue(raw.listing.sku, "surface_snapshot.listing.sku");
  const listingKey = stringValue(raw.listing.listing_key, "surface_snapshot.listing.listing_key");
  const itemId = stringValue(raw.listing.item_id, "surface_snapshot.listing.item_id");
  if (raw.listing.channel !== "WALMART_US" || raw.listing.published_status !== "PUBLISHED"
    || raw.listing.lifecycle_status !== "ACTIVE" || listingKey !== `walmart:${storeIndex}:${sku}`
    || !/^\d+$/u.test(itemId)) throw new Error("surface_snapshot.listing binding is invalid");
  if (!isRecord(raw.buyer_source)) throw new Error("surface_snapshot.buyer_source must be an object");
  exactKeys(raw.buyer_source, [
    "contract", "buyer_snapshot_id", "buyer_snapshot_body_sha256", "buyer_payload_sha256",
    "exact_item_id_echo", "complete_attribute_inventory",
  ], "surface_snapshot.buyer_source");
  if (raw.buyer_source.contract !== "walmart_buyer_pdp_exact_item_get"
    || raw.buyer_source.exact_item_id_echo !== true
    || raw.buyer_source.complete_attribute_inventory !== true) {
    throw new Error("surface_snapshot.buyer_source contract is not complete and exact");
  }
  const body: WalmartListingSurfaceSnapshotBody = {
    schema_version: WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
    captured_at: timestamp(raw.captured_at, "surface_snapshot.captured_at"),
    listing: {
      channel: "WALMART_US", store_index: storeIndex, sku, listing_key: listingKey, item_id: itemId,
      published_status: "PUBLISHED", lifecycle_status: "ACTIVE",
    },
    buyer_source: {
      contract: "walmart_buyer_pdp_exact_item_get",
      buyer_snapshot_id: stringValue(raw.buyer_source.buyer_snapshot_id, "surface_snapshot.buyer_source.buyer_snapshot_id"),
      buyer_snapshot_body_sha256: sha(raw.buyer_source.buyer_snapshot_body_sha256, "surface_snapshot.buyer_source.buyer_snapshot_body_sha256"),
      buyer_payload_sha256: sha(raw.buyer_source.buyer_payload_sha256, "surface_snapshot.buyer_source.buyer_payload_sha256"),
      exact_item_id_echo: true,
      complete_attribute_inventory: true,
    },
    surface: parseSurface(raw.surface),
  };
  const bodySha = sha(raw.body_sha256, "surface_snapshot.body_sha256");
  if (walmartListingIntegritySha256(body) !== bodySha) throw new Error("surface snapshot body_sha256 mismatch");
  const snapshotId = stringValue(raw.snapshot_id, "surface_snapshot.snapshot_id");
  if (snapshotId !== `walmart-surface-${storeIndex}-${bodySha.slice(0, 16)}`) {
    throw new Error("surface snapshot_id is not derived from its body");
  }
  return { ...body, snapshot_id: snapshotId, body_sha256: bodySha };
}

export function sealWalmartListingSurfaceSnapshot(
  rawBody: WalmartListingSurfaceSnapshotBody,
): SealedWalmartListingSurfaceSnapshot {
  const draft = {
    ...rawBody,
    snapshot_id: `walmart-surface-${rawBody.listing.store_index}-${"0".repeat(16)}`,
    body_sha256: "0".repeat(64),
  };
  // Reuse the strict surface/listing parser before calculating the real seal.
  const provisionalBody = { ...draft } as JsonRecord;
  delete provisionalBody.snapshot_id;
  delete provisionalBody.body_sha256;
  const digest = walmartListingIntegritySha256(provisionalBody);
  return parseSurfaceSnapshot({
    ...provisionalBody,
    snapshot_id: `walmart-surface-${rawBody.listing.store_index}-${digest.slice(0, 16)}`,
    body_sha256: digest,
  });
}

export function walmartListingIntegrityImageId(
  assetSha: string,
  slot: ImageSlot,
  listingKey: string,
): string {
  return walmartListingObservationImageId(assetSha, slot, listingKey);
}

function parseInput(raw: unknown): WalmartListingIntegrityInput {
  if (!isRecord(raw)) throw new Error("integrity input must be an object");
  exactKeys(raw, ["schema_version", "listing", "source_bindings", "expected", "surface", "images"], "input");
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_INPUT_SCHEMA) throw new Error("unsupported integrity input schema");
  if (!isRecord(raw.listing)) throw new Error("listing must be an object");
  exactKeys(raw.listing, [
    "channel", "store_index", "sku", "listing_key", "item_id", "published_status",
    "lifecycle_status", "captured_at", "composition",
  ], "listing");
  if (raw.listing.channel !== "WALMART_US" || raw.listing.published_status !== "PUBLISHED"
    || raw.listing.lifecycle_status !== "ACTIVE") throw new Error("listing must be WALMART_US PUBLISHED ACTIVE");
  const storeIndex = integer(raw.listing.store_index, "listing.store_index", 1);
  const sku = stringValue(raw.listing.sku, "listing.sku");
  const itemId = stringValue(raw.listing.item_id, "listing.item_id");
  if (!/^\d+$/u.test(itemId)) throw new Error("listing.item_id must be numeric");
  const listingKey = stringValue(raw.listing.listing_key, "listing.listing_key");
  if (listingKey !== `walmart:${storeIndex}:${sku}`) throw new Error("listing.listing_key mismatch");
  const composition = raw.listing.composition;
  if (composition !== "same_product" && composition !== "mixed_bundle" && composition !== "variety_pack") {
    throw new Error("listing.composition is unsupported");
  }
  const surface = parseSurface(raw.surface);

  if (!isRecord(raw.images)) throw new Error("images must be an object");
  exactKeys(raw.images, ["assets", "evidence", "duplicate_summary"], "images");
  if (!Array.isArray(raw.images.assets) || raw.images.assets.length < 1 || raw.images.assets.length > 100) {
    throw new Error("images.assets must contain 1..100 assets");
  }
  const assetRows = raw.images.assets.map((entry, index) => {
    const path = `images.assets[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    exactKeys(entry, [
      "slot", "source_url", "sha256", "byte_length", "decoded_width", "decoded_height",
      "dhash64", "buyer_facing_verified", "surface",
    ], path);
    if (entry.buyer_facing_verified !== true || entry.surface !== "buyer_pdp") throw new Error(`${path} is not buyer-facing`);
    const dhash64 = stringValue(entry.dhash64, `${path}.dhash64`).toLowerCase();
    if (!/^[a-f0-9]{16}$/u.test(dhash64)) throw new Error(`${path}.dhash64 must be 16 lowercase hex characters`);
    return {
      slot: stringValue(entry.slot, `${path}.slot`) as ImageSlot,
      source_url: stringValue(entry.source_url, `${path}.source_url`),
      sha256: sha(entry.sha256, `${path}.sha256`),
      byte_length: integer(entry.byte_length, `${path}.byte_length`, 1),
      decoded_width: integer(entry.decoded_width, `${path}.decoded_width`, 1),
      decoded_height: integer(entry.decoded_height, `${path}.decoded_height`, 1),
      dhash64,
      buyer_facing_verified: true as const,
      surface: "buyer_pdp" as const,
    };
  });
  const validated = validateAuditManifest({
    schema_version: WALMART_VISUAL_AUDIT_SCHEMA,
    manifest_id: `integrity-${listingKey}`,
    purpose: "catalog-audit",
    cases: [{
      case_id: `integrity-${listingKey}`,
      sku,
      expected: raw.expected,
      images: assetRows.map((asset) => ({
        slot: asset.slot, url: asset.source_url, buyer_facing_verified: true, surface: "buyer_pdp",
      })),
      ground_truth: undefined,
    }],
    layouts: [{ name: "offline", batch_size: 1, shuffle_seed: null }],
  });
  const assets = assetRows.map((asset, index) => ({ ...asset, slot: validated.cases[0]!.images[index]!.slot }));
  if (assets[0]?.slot !== "main" || assets.some((asset, index) => (
    asset.slot !== (index === 0 ? "main" : `gallery-${index}`)
  ))) throw new Error("images.assets must be ordered main then contiguous gallery slots");
  if (!Array.isArray(raw.images.evidence) || raw.images.evidence.length !== assets.length) {
    throw new Error("images.evidence must contain exactly one row per asset");
  }
  const assetBySlot = new Map(assets.map((asset) => [asset.slot, asset]));
  const evidence = raw.images.evidence.map((entry, index): ListingIntegrityImageEvidence => {
    const path = `images.evidence[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    const slot = stringValue(entry.slot, `${path}.slot`) as ImageSlot;
    const asset = assetBySlot.get(slot);
    if (!asset) throw new Error(`${path}.slot has no asset`);
    const assetSha = sha(entry.asset_sha256, `${path}.asset_sha256`);
    if (assetSha !== asset.sha256) throw new Error(`${path}.asset_sha256 mismatch`);
    if (entry.state === "observed") {
      exactKeys(entry, [
        "slot", "asset_sha256", "state", "observation", "auxiliary_ocr", "local_ocr_truncated",
      ], path);
      if (typeof entry.local_ocr_truncated !== "boolean") {
        throw new Error(`${path}.local_ocr_truncated must be boolean`);
      }
      const observation = parseBlindResponse({
        schema_version: BLIND_OBSERVATION_SCHEMA,
        observations: [entry.observation],
      }, [walmartListingIntegrityImageId(asset.sha256, asset.slot, listingKey)])[0]!;
      return {
        slot, asset_sha256: assetSha, state: "observed", observation,
        auxiliary_ocr: entry.auxiliary_ocr as AuditAuxiliaryEvidence,
        local_ocr_truncated: entry.local_ocr_truncated,
      };
    }
    if (entry.state === "missing") {
      exactKeys(entry, ["slot", "asset_sha256", "state", "reason"], path);
      return { slot, asset_sha256: assetSha, state: "missing", reason: stringValue(entry.reason, `${path}.reason`) };
    }
    if (entry.state === "technical_error") {
      exactKeys(entry, ["slot", "asset_sha256", "state", "error"], path);
      return { slot, asset_sha256: assetSha, state: "technical_error", error: stringValue(entry.error, `${path}.error`) };
    }
    throw new Error(`${path}.state is unsupported`);
  });
  if (new Set(evidence.map((row) => row.slot)).size !== assets.length) throw new Error("images.evidence contains duplicate slots");

  if (raw.images.duplicate_summary !== null) {
    throw new Error("images.duplicate_summary must be null; the engine recomputes it from byte-verified fingerprints");
  }

  const expected = validated.cases[0]!.expected;
  if (surface.title !== expected.title) throw new Error("surface.title must equal source-bound expected.title");
  return {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      channel: "WALMART_US", store_index: storeIndex, sku, listing_key: listingKey, item_id: itemId,
      published_status: "PUBLISHED", lifecycle_status: "ACTIVE",
      captured_at: timestamp(raw.listing.captured_at, "listing.captured_at"), composition,
    },
    source_bindings: parseBindings(raw.source_bindings),
    expected,
    surface,
    images: { assets, evidence, duplicate_summary: null },
  };
}

function identityGroups(expected: AuditExpectedTruth): Array<{ role: IdentityClaimKind; groups: string[][] }> {
  return [
    { role: "brand", groups: [expected.identity.brand_aliases] },
    { role: "product", groups: expected.identity.product_marker_groups },
    { role: "variant", groups: expected.identity.variant_marker_groups },
  ];
}

function sizeBase(value: ExpectedSize): { dimension: "mass" | "volume" | "count"; value: number } {
  const factors: Record<SizeUnit, ["mass" | "volume" | "count", number]> = {
    oz: ["mass", 28.349523125], lb: ["mass", 453.59237], g: ["mass", 1], kg: ["mass", 1000],
    fl_oz: ["volume", 29.5735295625], ml: ["volume", 1], l: ["volume", 1000], count: ["count", 1],
  };
  const [dimension, factor] = factors[value.unit];
  return { dimension, value: value.value * factor };
}

function equivalent(left: ExpectedSize, right: ExpectedSize): boolean {
  const a = sizeBase(left); const b = sizeBase(right);
  if (a.dimension !== b.dimension) return false;
  if (a.dimension === "count") return a.value === b.value;
  return Math.abs(a.value - b.value) <= Math.max(a.value, b.value) * 0.005;
}

function claimCounts(text: string, roleScoped = false): { counts: number[]; ambiguous: boolean } {
  const parsed = extractTitleOuterCountEvidence(text);
  const direct = roleScoped
    ? [...normalize(text).matchAll(/\b(\d+)\s*(?:outer\s+)?(?:packages?|packs?|units?)\b/gu)]
      .map((match) => Number(match[1])).filter((value) => Number.isSafeInteger(value) && value > 0)
    : [];
  const counts = [...new Set([...(parsed.value === null ? [] : [parsed.value]), ...direct])];
  return { counts, ambiguous: parsed.status === "AMBIGUOUS" || counts.length > 1 };
}

/**
 * Parse package facts from free-form body text only when the surrounding words
 * make the semantic role explicit. Nutrient and serving values are otherwise
 * ignored so they cannot create either a false PASS or a false BAD.
 */
function bodyPackageEvidence(text: string): { classified: ExpectedSize[]; unresolved: ExpectedSize[] } {
  const clauses = text.split(/[\n.!?;]+/u).map((value) => value.trim()).filter(Boolean);
  const classified: ExpectedSize[] = [];
  const unresolved: ExpectedSize[] = [];
  for (const clause of clauses) {
    const normalized = normalize(clause);
    if (/\b(?:calories?|cholesterol|daily value|dietary fiber|nutrition facts?|protein|saturated fat|serving size|sodium|sugars?|total carbohydrate|trans fat|vitamin)\b/u.test(normalized)) continue;
    const netContext = /\b(?:net wt|net weight|net contents?|weighs?|weight|each (?:bag|bottle|box|can|carton|container|loaf|outer|pack|package|pouch|unit)|per (?:bag|bottle|box|can|carton|container|loaf|outer|pack|package|pouch|unit))\b/u.test(normalized);
    const countContext = /\b(?:\d+\s*(?:count|ct)|(?:contains?|includes?)\s+\d+\s+(?:bags?|bottles?|buns?|cans?|items?|loaves?|packs?|packages?|pieces?|pouches?|rolls?|slices?|units?))\b/u.test(normalized);
    for (const value of parseVisibleSizeTexts(clause)) {
      if (value.unit === "count" ? countContext : netContext) classified.push(value);
      else unresolved.push(value);
    }
  }
  return { classified, unresolved };
}

function auditText(input: WalmartListingIntegrityInput): ListingTextAuditDecision {
  const hard: string[] = [];
  const review: string[] = [];
  const checks: ListingTextAuditDecision["checks"] = {
    title_identity: "UNKNOWN", title_outer_units: "UNKNOWN", title_package_facts: "NOT_APPLICABLE",
    body_identity: "UNKNOWN", body_outer_units: "NOT_APPLICABLE", body_package_facts: "NOT_APPLICABLE",
    attributes_identity: "UNKNOWN",
    attributes_outer_units: "UNKNOWN", attributes_package_facts: "NOT_APPLICABLE",
  };
  const { expected, surface } = input;
  if (!expected.identity.product_marker_groups.length) {
    review.push("Product Truth has no discriminating product marker; brand-only identity cannot PASS");
  }
  if (!expected.identity.variant_marker_groups.length) {
    review.push("Product Truth has no discriminating variant marker or typed not-applicable proof");
  }
  const groups = identityGroups(expected);
  const titleMissing = groups.flatMap(({ role, groups: required }) => required
    .filter((aliases) => !containsAlias(surface.title, aliases)).map(() => role));
  const forbiddenText = [surface.title, surface.description ?? "", ...surface.bullets].join("\n");
  const forbidden = expected.identity.forbidden_markers.filter((marker) => containsAlias(forbiddenText, marker.aliases));
  if (forbidden.length) hard.push(`text contains forbidden identity: ${forbidden.map((row) => row.aliases.join("|")).join(",")}`);
  if (titleMissing.length) {
    hard.push(`title is missing required identity roles: ${[...new Set(titleMissing)].join(",")}`);
    checks.title_identity = "MISMATCH";
  } else checks.title_identity = "MATCH";

  const titleOuter = claimCounts(surface.title);
  if (titleOuter.ambiguous || titleOuter.counts.some((value) => value !== expected.outer_units)) {
    checks.title_outer_units = "MISMATCH";
    hard.push(`title outer quantity contradicts ${expected.outer_units}`);
  } else if (titleOuter.counts.includes(expected.outer_units)) checks.title_outer_units = "MATCH";
  else if (expected.outer_units === 1) checks.title_outer_units = "NOT_APPLICABLE";
  else review.push("multipack title has no explicit outer quantity");

  if (expected.package_facts.length) {
    const titleSizes = parseVisibleSizeTexts(surface.title);
    let unknown = false;
    for (const fact of expected.package_facts) {
      const dimension = sizeBase(fact).dimension;
      const candidates = titleSizes.filter((value) => sizeBase(value).dimension === dimension);
      if (!candidates.length) {
        if (fact.requirement === "required") unknown = true;
        continue;
      }
      const perUnit = candidates.some((value) => equivalent(fact, value));
      const total: ExpectedSize = { value: fact.value * expected.outer_units, unit: fact.unit };
      const totalOnly = !perUnit && expected.outer_units > 1 && candidates.some((value) => equivalent(total, value));
      const invalid = candidates.some((value) => !equivalent(fact, value)
        && !(expected.outer_units > 1 && equivalent(total, value)));
      if (invalid || (!perUnit && !totalOnly)) {
        hard.push(`title package fact contradicts ${fact.kind}=${fact.value} ${fact.unit}`);
      }
      if (totalOnly) unknown = true;
    }
    checks.title_package_facts = hard.some((value) => value.startsWith("title package")) ? "MISMATCH" : unknown ? "UNKNOWN" : "MATCH";
    if (unknown) review.push("title package fact is missing or only total-pack value is visible");
  }

  const body = [surface.description ?? "", ...surface.bullets].join("\n");
  if (!surface.description) review.push("description is missing");
  if (!surface.bullets.length) review.push("bullets are missing");
  const bodyMatches = groups.every(({ groups: required }) => required.every((aliases) => containsAlias(body, aliases)));
  checks.body_identity = bodyMatches ? "MATCH" : "UNKNOWN";
  if (!bodyMatches) review.push("description/bullets contain no expected identity evidence");
  const bodyClaims = [surface.description ?? "", ...surface.bullets].map((value) => claimCounts(value));
  const explicitBody = bodyClaims.flatMap((row) => row.counts);
  if (bodyClaims.some((row) => row.ambiguous) || explicitBody.some((value) => value !== expected.outer_units)) {
    checks.body_outer_units = "MISMATCH";
    hard.push(`description/bullets outer quantity contradicts ${expected.outer_units}`);
  } else if (explicitBody.length) checks.body_outer_units = "MATCH";

  if (expected.package_facts.length) {
    const bodyEvidence = bodyPackageEvidence(body);
    const bodySizes = bodyEvidence.classified;
    let bodyMismatch = false;
    let bodyKnown = false;
    for (const fact of expected.package_facts) {
      const dimension = sizeBase(fact).dimension;
      const candidates = bodySizes.filter((value) => sizeBase(value).dimension === dimension);
      if (!candidates.length) continue;
      bodyKnown = true;
      const total: ExpectedSize = { value: fact.value * expected.outer_units, unit: fact.unit };
      if (candidates.some((value) => !equivalent(fact, value)
        && !(expected.outer_units > 1 && equivalent(total, value)))) bodyMismatch = true;
    }
    checks.body_package_facts = bodyMismatch ? "MISMATCH" : bodyKnown ? "MATCH" : "NOT_APPLICABLE";
    if (bodyMismatch) hard.push("description/bullets package facts contradict Product Truth");
    if (bodyEvidence.unresolved.length) {
      checks.body_package_facts = checks.body_package_facts === "MISMATCH" ? "MISMATCH" : "UNKNOWN";
      review.push("description/bullets contain unclassified size or count claims");
    }
  }

  const identityClaims = surface.attribute_claims.filter((claim): claim is Extract<ListingAttributeClaim, { text: string }> => "text" in claim);
  const forbiddenAttributeClaims = identityClaims.flatMap((claim) => expected.identity.forbidden_markers
    .filter((marker) => marker.role === claim.kind && containsAlias(claim.text, marker.aliases))
    .map((marker) => `${claim.field_path}:${marker.role}:${marker.aliases.join("|")}`));
  if (forbiddenAttributeClaims.length) {
    hard.push(`typed identity attributes contain forbidden markers: ${forbiddenAttributeClaims.join(",")}`);
  }
  let identityUnknown = false;
  for (const { role, groups: required } of groups) {
    if (!required.length) continue;
    const claims = identityClaims.filter((claim) => claim.kind === role);
    if (!claims.length) { identityUnknown = true; continue; }
    const roleMatches = claims.every((claim) => required.some((aliases) => containsAlias(claim.text, aliases)));
    if (!roleMatches) {
      hard.push(`typed ${role} attribute contradicts expected ${role}`);
      checks.attributes_identity = "MISMATCH";
    } else if (required.some((aliases) => !claims.some((claim) => containsAlias(claim.text, aliases)))) {
      identityUnknown = true;
    }
  }
  if (checks.attributes_identity !== "MISMATCH") checks.attributes_identity = identityUnknown ? "UNKNOWN" : "MATCH";
  if (identityUnknown) review.push("typed identity attributes are incomplete or non-matching");

  const outerClaims = surface.attribute_claims.filter((claim) => claim.kind === "outer_units");
  if (!outerClaims.length) review.push("typed outer_units attribute is missing");
  else if (outerClaims.some((claim) => claim.value !== expected.outer_units)) {
    checks.attributes_outer_units = "MISMATCH";
    hard.push(`typed outer_units attribute contradicts ${expected.outer_units}`);
  } else checks.attributes_outer_units = "MATCH";

  if (expected.package_facts.length) {
    let unknown = false;
    let mismatch = false;
    for (const fact of expected.package_facts) {
      const claims = fact.kind === "net_content"
        ? surface.attribute_claims.filter((claim) => claim.kind === "net_content")
          .map((claim) => ({ value: claim.value, unit: claim.unit as SizeUnit }))
        : surface.attribute_claims.filter((claim) => claim.kind === "inner_item_count")
          .map((claim) => ({ value: claim.value, unit: claim.unit as SizeUnit }));
      if (!claims.length) { if (fact.requirement === "required") unknown = true; continue; }
      if (claims.some((claim) => !equivalent(fact, claim))) mismatch = true;
    }
    checks.attributes_package_facts = mismatch ? "MISMATCH" : unknown ? "UNKNOWN" : "MATCH";
    if (mismatch) hard.push("typed package attributes contradict Product Truth");
    if (unknown) review.push("required typed package attributes are missing");
  }
  if (surface.unmapped_attributes.length) {
    review.push(`${surface.unmapped_attributes.length} source attributes are not covered by the deterministic mapper`);
  }
  return hard.length ? { verdict: "BAD", checks, hard_failures: [...new Set(hard)], review_reasons: [...new Set(review)] }
    : review.length ? { verdict: "REVIEW", checks, hard_failures: [], review_reasons: [...new Set(review)] }
      : { verdict: "PASS", checks, hard_failures: [], review_reasons: [] };
}

function imageInput(asset: ListingIntegrityImageAsset): AuditImageInput {
  return { slot: asset.slot, url: asset.source_url, buyer_facing_verified: true, surface: "buyer_pdp" };
}

function mainQuantityClaimReview(observation: BlindObservation, expectedOuter: number): { hard: string[]; review: string[] } {
  const hard: string[] = []; const review: string[] = [];
  const claims = observation.outer_package_claims.map((value) => claimCounts(value, true));
  const values = claims.flatMap((row) => row.counts);
  if (claims.some((row) => row.ambiguous) || values.some((value) => value !== expectedOuter)) {
    hard.push(`MAIN outer-package text contradicts ${expectedOuter}`);
  }
  if (observation.outer_package_claims.length && values.length === 0) {
    review.push("MAIN contains an unparsed outer-package claim");
  }
  if (observation.unclear_quantity_claims.length) review.push("MAIN contains unresolved quantity claims");
  const caseClaims = observation.case_package_claims.map((value) => claimCounts(value, true));
  const caseValues = caseClaims.flatMap((row) => row.counts);
  if (caseClaims.some((row) => row.ambiguous) || caseValues.some((value) => value !== expectedOuter)) {
    hard.push(`MAIN case-package text contradicts ${expectedOuter}`);
  } else if (observation.case_package_claims.length) {
    review.push("MAIN contains a case-package claim requiring human confirmation");
  }
  return { hard, review };
}

function galleryQuantityClaimReview(
  slot: ImageSlot,
  observation: BlindObservation,
  expectedOuter: number,
): { hard: string[]; review: string[] } {
  const hard: string[] = [];
  const review: string[] = [];
  const outerClaims = observation.outer_package_claims.map((value) => claimCounts(value, true));
  const outerValues = outerClaims.flatMap((row) => row.counts);
  if (outerClaims.some((row) => row.ambiguous) || outerValues.some((value) => value !== expectedOuter)) {
    hard.push(`${slot} outer-package text contradicts ${expectedOuter}`);
  }
  if (observation.outer_package_claims.length && outerValues.length === 0) {
    review.push(`${slot} contains an unparsed outer-package claim`);
  }
  const caseClaims = observation.case_package_claims.map((value) => claimCounts(value, true));
  const caseValues = caseClaims.flatMap((row) => row.counts);
  if (caseClaims.some((row) => row.ambiguous) || caseValues.some((value) => value !== expectedOuter)) {
    hard.push(`${slot} case-package text contradicts ${expectedOuter}`);
  } else if (observation.case_package_claims.length) {
    review.push(`${slot} contains a case-package claim requiring human confirmation`);
  }
  if (observation.unclear_quantity_claims.length) {
    review.push(`${slot} contains unresolved quantity claims`);
  }
  return { hard, review };
}

function auxiliaryOuterQuantityReview(
  label: string,
  auxiliary: AuditAuxiliaryEvidence,
  expectedOuter: number,
): string[] {
  const reviews: string[] = [];
  const candidates = auxiliary.ocr_texts
    .map((row) => row.text)
    .filter((value) => /\b(?:pack(?:s)?\s+of|case(?:s)?\s+of|set\s+of|bundle\s+of|lot\s+of|multi[ -]?pack)\b|\b\d+\s*[x×]\b/iu.test(value));
  for (const value of candidates) {
    const parsed = claimCounts(value, true);
    if (parsed.ambiguous || parsed.counts.length === 0
      || parsed.counts.some((count) => count !== expectedOuter)) {
      reviews.push(`${label} local OCR contains an unresolved or contradictory outer-package claim: ${value}`);
    }
  }
  return reviews;
}

function recomputeDuplicateSummary(input: WalmartListingIntegrityInput): ListingIntegrityDuplicateSummary | null {
  const galleryAssets = input.images.assets.slice(1);
  if (!galleryAssets.length) return null;
  const galleryEvidence = new Map(input.images.evidence.slice(1).map((row) => [row.slot, row]));
  const bySha = new Map<string, number>();
  for (const asset of galleryAssets) bySha.set(asset.sha256, (bySha.get(asset.sha256) ?? 0) + 1);
  let nearDuplicatePairs = 0;
  for (let left = 0; left < galleryAssets.length; left += 1) {
    for (let right = left + 1; right < galleryAssets.length; right += 1) {
      if (galleryAssets[left]!.sha256 === galleryAssets[right]!.sha256) continue;
      if (galleryDhashDistance(galleryAssets[left]!.dhash64, galleryAssets[right]!.dhash64)
        <= DEFAULT_GALLERY_DHASH_DISTANCE) nearDuplicatePairs += 1;
    }
  }
  return {
    source_binding_sha256: walmartListingIntegritySha256(galleryAssets.map((asset) => ({
      slot: asset.slot, sha256: asset.sha256, byte_length: asset.byte_length,
      decoded_width: asset.decoded_width, decoded_height: asset.decoded_height, dhash64: asset.dhash64,
    }))),
    dhash_distance_threshold: DEFAULT_GALLERY_DHASH_DISTANCE,
    exact_duplicate_groups: [...bySha.values()].filter((count) => count > 1).length,
    near_duplicate_pairs: nearDuplicatePairs,
    missing_assets: [...galleryEvidence.values()].filter((row) => row.state === "missing").length,
    technical_errors: [...galleryEvidence.values()].filter((row) => row.state === "technical_error").length,
  };
}

function compileWalmartListingIntegrityReportInternal(
  rawInput: unknown,
  sourceAware: boolean,
  observationArtifactsVerified = false,
  provenance: WalmartListingIntegrityReportBody["provenance"] = null,
): SealedWalmartListingIntegrityReport {
  const input = parseInput(rawInput);
  const textDecision = auditText(input);
  const caseInput = {
    case_id: input.source_bindings.catalog_truth_case_id,
    sku: input.listing.sku,
    expected: input.expected,
    images: input.images.assets.map(imageInput),
  };
  const bySlot = new Map(input.images.evidence.map((entry) => [entry.slot, entry]));
  const mainAsset = input.images.assets[0]!;
  const mainEvidence = bySlot.get("main")!;
  let mainDecision: WalmartListingIntegrityReportBody["main_decision"];
  const extraMainHard: string[] = [];
  const extraMainReview: string[] = [];
  if (mainEvidence.state !== "observed") {
    mainDecision = { verdict: "REVIEW", reason: mainEvidence.state === "missing" ? mainEvidence.reason : mainEvidence.error };
  } else {
    mainDecision = decideBlind(caseInput, imageInput(mainAsset), mainEvidence.observation, mainEvidence.auxiliary_ocr);
    const quantity = mainQuantityClaimReview(mainEvidence.observation, input.expected.outer_units);
    extraMainHard.push(...quantity.hard); extraMainReview.push(...quantity.review);
    extraMainReview.push(...auxiliaryOuterQuantityReview(
      "MAIN",
      mainEvidence.auxiliary_ocr,
      input.expected.outer_units,
    ));
    if (mainEvidence.observation.flags.length) {
      extraMainReview.push(`MAIN observer flags require review: ${mainEvidence.observation.flags.join("|")}`);
    }
    if (mainEvidence.local_ocr_truncated) extraMainReview.push("MAIN local OCR evidence was truncated");
  }
  const galleryDecisions = input.images.assets.slice(1).map((asset) => {
    const evidence = bySlot.get(asset.slot)!;
    const source = evidence.state === "observed"
      ? { state: "observed" as const, observation: evidence.observation, auxiliary_ocr: evidence.auxiliary_ocr }
      : evidence.state === "missing"
        ? { state: "missing" as const, reason: evidence.reason }
        : { state: "technical_error" as const, error: evidence.error };
    return auditGallerySlot({ slot: asset.slot as `gallery-${number}`, expected: input.expected, source });
  });
  const blocking: string[] = [...textDecision.hard_failures, ...extraMainHard];
  const reviews: string[] = [...textDecision.review_reasons, ...extraMainReview];
  if (!sourceAware) reviews.push("source artifacts, surface snapshot, and image bytes were not independently verified");
  if (!observationArtifactsVerified) reviews.push("blind observation and local OCR artifacts were not independently verified");
  if ("hard_failures" in mainDecision) blocking.push(...mainDecision.hard_failures.map((value) => `MAIN: ${value}`));
  else reviews.push(`MAIN: ${mainDecision.reason}`);
  for (const decision of galleryDecisions) {
    if (decision.verdict === "BAD" || decision.verdict === "MISSING") {
      blocking.push(`${decision.slot}: ${decision.hard_failures.join("; ") || decision.missing_reason}`);
    } else if (decision.verdict !== "PASS") {
      reviews.push(`${decision.slot}: ${decision.review_reasons.join("; ") || decision.technical_error || decision.verdict}`);
    }
    const evidence = bySlot.get(decision.slot);
    if (evidence?.state === "observed") {
      const quantity = galleryQuantityClaimReview(decision.slot, evidence.observation, input.expected.outer_units);
      blocking.push(...quantity.hard);
      reviews.push(...quantity.review);
      reviews.push(...auxiliaryOuterQuantityReview(
        decision.slot,
        evidence.auxiliary_ocr,
        input.expected.outer_units,
      ));
      const external = evidence.observation.external_package_count;
      if ((external.mode === "exact" && external.value !== input.expected.outer_units)
        || (external.mode === "range" && (external.min! > input.expected.outer_units
          || external.max! < input.expected.outer_units))) {
        reviews.push(`${decision.slot}: visible package count differs from offer quantity`);
      }
      if (evidence.observation.grid_cell_kind === "multi_package_case"
        && external.mode === "unknown") {
        reviews.push(`${decision.slot}: case-style gallery quantity is unresolved`);
      }
      if (evidence.observation.flags.length) {
        reviews.push(`${decision.slot}: observer flags require review: ${evidence.observation.flags.join("|")}`);
      }
      if (evidence.local_ocr_truncated) reviews.push(`${decision.slot}: local OCR evidence was truncated`);
    }
  }
  const duplicate = recomputeDuplicateSummary(input);
  if (duplicate) {
    if (duplicate.missing_assets) blocking.push(`gallery duplicate scan has ${duplicate.missing_assets} missing assets`);
    if (duplicate.technical_errors) reviews.push(`gallery duplicate scan has ${duplicate.technical_errors} technical errors`);
    if (duplicate.exact_duplicate_groups) reviews.push(`gallery has ${duplicate.exact_duplicate_groups} exact duplicate groups`);
    if (duplicate.near_duplicate_pairs) reviews.push(`gallery has ${duplicate.near_duplicate_pairs} near-duplicate pairs`);
  }
  let overall: ListingIntegrityVerdict;
  if (input.listing.composition !== "same_product") overall = "UNSUPPORTED";
  else if (blocking.length) overall = "BAD";
  else if (reviews.length || textDecision.verdict !== "PASS"
    || mainDecision.verdict !== "PASS" || galleryDecisions.some((row) => row.verdict !== "PASS")) overall = "REVIEW";
  else overall = "PASS";
  const body: WalmartListingIntegrityReportBody = {
    schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
    input_body_sha256: walmartListingIntegritySha256(input),
    listing: input.listing,
    source_bindings: input.source_bindings,
    text_decision: textDecision,
    main_decision: mainDecision,
    gallery_decisions: galleryDecisions,
    duplicate_summary: duplicate,
    engine_versions: {
      listing_engine: WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
      blind_prompt: BLIND_PROMPT_VERSION,
      main_comparator: WALMART_VISUAL_COMPARATOR_VERSION,
      gallery_comparator: WALMART_GALLERY_AUDIT_VERSION,
    },
    overall_verdict: overall,
    blocking_reasons: [...new Set(blocking)],
    review_reasons: [...new Set(reviews)],
    provenance,
    assurance: {
      compilation_mode: sourceAware ? "source_aware" : "input_only",
      source_artifacts_verified: sourceAware,
      surface_snapshot_verified: sourceAware,
      asset_bytes_verified: sourceAware,
      observation_artifacts_verified: observationArtifactsVerified,
      caller_verdicts_accepted: false, image_decisions_recomputed: true,
      unknown_promoted_to_pass: false, network_calls: 0, model_calls: 0,
      marketplace_writes: 0, database_writes: 0,
    },
  };
  const digest = walmartListingIntegritySha256(body);
  return { ...body, report_id: `walmart-integrity-${input.listing.store_index}-${digest.slice(0, 16)}`, body_sha256: digest };
}

/** Input-only compilation is diagnostic and can never issue PASS. */
export function compileWalmartListingIntegrityReport(rawInput: unknown): SealedWalmartListingIntegrityReport {
  return compileWalmartListingIntegrityReportInternal(rawInput, false);
}

export function verifyWalmartListingIntegrityReportAgainstInput(
  rawReport: unknown,
  rawInput: unknown,
): SealedWalmartListingIntegrityReport {
  if (!isRecord(rawReport)) throw new Error("integrity report must be an object");
  const rebuilt = compileWalmartListingIntegrityReport(rawInput);
  if (canonicalJson(rawReport) !== canonicalJson(rebuilt)) {
    throw new Error("integrity report does not exactly rebuild from source-bound input");
  }
  return rebuilt;
}

export interface WalmartListingIntegritySourceArtifacts {
  product_truth_snapshot: unknown;
  buyer_snapshot_index: unknown;
  catalog_truth_export: unknown;
  buyer_snapshot_manifest: unknown;
  seller_item_payload: unknown;
  catalog_search_payload: unknown;
  buyer_pdp_payload: unknown;
  surface_snapshot: unknown;
  /** Exact locally frozen bytes, keyed by normalized `main|gallery-N` slot. */
  asset_bytes: ReadonlyMap<ImageSlot, Uint8Array>;
  run_lock_sha256: string;
  code_bundle_id: string;
  code_bundle_manifest_sha256: string;
  worker_receipt_key_id: string;
  worker_receipt_public_key_sha256: string;
  observation_batches: readonly unknown[];
  observation_terminal_artifacts?: readonly unknown[];
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sourceMismatch(message: string): never {
  throw new Error(`source-aware verification failed: ${message}`);
}

/**
 * The only entry point allowed to issue PASS. It rebuilds catalog truth from
 * its trusted sources, binds the exact buyer/surface snapshots, and recomputes
 * every image SHA/dimension/dHash from local bytes before compiling a verdict.
 */
export async function compileWalmartListingIntegrityReportAgainstSources(
  rawInput: unknown,
  sources: WalmartListingIntegritySourceArtifacts,
): Promise<SealedWalmartListingIntegrityReport> {
  const input = parseInput(rawInput);
  const verifiedExport: WalmartCatalogTruthAuditExport =
    verifyWalmartCatalogTruthAuditExportAgainstSources(
      sources.catalog_truth_export,
      sources.product_truth_snapshot,
      sources.buyer_snapshot_index,
    );
  const truthSnapshot = sources.product_truth_snapshot as ProductTruthWalmartAuditSnapshot;
  const buyerIndex = sources.buyer_snapshot_index as WalmartBuyerSnapshotIndex;
  const auditCase = verifiedExport.cases.find((row) => row.listing_key === input.listing.listing_key);
  if (!auditCase || auditCase.item_id !== input.listing.item_id) sourceMismatch("catalog truth case is missing or itemId differs");
  if (auditCase.disposition !== "auditable" || !auditCase.preflight
    || auditCase.preflight.status !== "AUDITABLE" || !auditCase.preflight_sha256
    || !auditCase.buyer_snapshot || !auditCase.truth_revision.approval_sha256) {
    sourceMismatch("catalog truth case is not fully approved and auditable");
  }
  if (auditCase.store_index !== input.listing.store_index || auditCase.sku !== input.listing.sku
    || auditCase.published_status !== "PUBLISHED" || auditCase.lifecycle_status !== "ACTIVE"
    || auditCase.recipe_composition !== input.listing.composition) {
    sourceMismatch("listing identity/status/composition differs from catalog truth case");
  }
  if (!canonicalEqual(input.expected, auditCase.preflight.expected)) {
    sourceMismatch("expected Product Truth differs from the verified preflight");
  }
  const buyerEntry = buyerIndex.entries.find((row) => row.listing_key === input.listing.listing_key);
  if (!buyerEntry || buyerEntry.item_id !== input.listing.item_id) sourceMismatch("buyer index entry is missing or differs");
  const buyerSnapshot = buyerEntry.snapshot;
  const suppliedBuyerSnapshot = sources.buyer_snapshot_manifest as SealedWalmartBuyerSnapshot;
  if (!canonicalEqual(suppliedBuyerSnapshot, buyerSnapshot)) sourceMismatch("buyer snapshot manifest differs from verified buyer index");
  if (buyerSnapshot.target.sku !== input.listing.sku
    || buyerSnapshot.target.item_id !== input.listing.item_id) {
    sourceMismatch("buyer snapshot target differs from the exact listing scope");
  }
  let rebuiltResolution: ReturnType<typeof resolveExactWalmartItemCandidate>;
  let rebuiltBuyer: ReturnType<typeof resolveExactBuyerPdp>;
  try {
    rebuiltResolution = resolveExactWalmartItemCandidate(
      input.listing.sku,
      sources.seller_item_payload,
      sources.catalog_search_payload,
    );
    rebuiltBuyer = resolveExactBuyerPdp(sources.buyer_pdp_payload, buyerSnapshot.target);
  } catch (error) {
    sourceMismatch(`raw seller/catalog/buyer payload rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (walmartListingIntegritySha256(sources.seller_item_payload)
      !== buyerSnapshot.payload_hashes.seller_payload_canonical_sha256
    || walmartListingIntegritySha256(sources.catalog_search_payload)
      !== buyerSnapshot.payload_hashes.catalog_search_payload_canonical_sha256
    || walmartListingIntegritySha256(rebuiltResolution)
      !== buyerSnapshot.payload_hashes.resolution_canonical_sha256
    || walmartListingIntegritySha256(sources.buyer_pdp_payload)
      !== buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256) {
    sourceMismatch("raw seller/catalog/buyer payload hashes differ from the buyer snapshot");
  }
  if (!canonicalEqual(rebuiltResolution.seller, buyerSnapshot.identity.seller)
    || !canonicalEqual(
      rebuiltResolution.catalog_search_candidate,
      buyerSnapshot.identity.catalog_search_candidate,
    )
    || !canonicalEqual(rebuiltResolution.identity_evidence, buyerSnapshot.identity.chain_evidence.seller_to_catalog)
    || rebuiltBuyer.item_id !== buyerSnapshot.identity.buyer.item_id
    || rebuiltBuyer.title !== buyerSnapshot.identity.buyer.title
    || !canonicalEqual(rebuiltBuyer.identity_evidence, buyerSnapshot.identity.buyer.identity_evidence)
    || !canonicalEqual(rebuiltBuyer.identity_evidence, buyerSnapshot.identity.chain_evidence.catalog_to_buyer_pdp)) {
    sourceMismatch("buyer snapshot identity chain does not rebuild from exact raw payloads");
  }
  const rawBuyerImageUrls = [rebuiltBuyer.main_image_url, ...rebuiltBuyer.gallery_image_urls];
  if (rawBuyerImageUrls.length !== buyerSnapshot.assets.length
    || rawBuyerImageUrls.some((url, index) => buyerSnapshot.assets[index]?.source_url !== url)) {
    sourceMismatch("buyer snapshot image population does not rebuild from raw buyer PDP");
  }
  if (buyerSnapshot.identity.buyer.item_id !== input.listing.item_id
    || buyerSnapshot.identity.buyer.title !== input.surface.title
    || buyerSnapshot.identity.seller.published_status !== "PUBLISHED"
    || buyerSnapshot.identity.seller.lifecycle_status !== "ACTIVE") {
    sourceMismatch("buyer snapshot identity/title/status differs from listing input");
  }
  const surfaceSnapshot = parseSurfaceSnapshot(sources.surface_snapshot);
  let rebuiltSurface: WalmartListingSurface;
  try {
    rebuiltSurface = projectWalmartListingSurfaceFromBuyerPdp(
      sources.buyer_pdp_payload,
      buyerSnapshot.target,
    );
  } catch (error) {
    sourceMismatch(`raw buyer surface rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (surfaceSnapshot.listing.listing_key !== input.listing.listing_key
    || surfaceSnapshot.listing.item_id !== input.listing.item_id
    || surfaceSnapshot.captured_at !== buyerSnapshot.captured_at
    || input.listing.captured_at !== buyerSnapshot.captured_at
    || !canonicalEqual(surfaceSnapshot.surface, input.surface)
    || !canonicalEqual(surfaceSnapshot.surface, rebuiltSurface)) {
    sourceMismatch("surface snapshot does not exactly bind listing, capture, and surface fields");
  }
  if (surfaceSnapshot.buyer_source.buyer_snapshot_id !== buyerSnapshot.snapshot_id
    || surfaceSnapshot.buyer_source.buyer_snapshot_body_sha256 !== buyerSnapshot.body_sha256
    || surfaceSnapshot.buyer_source.buyer_payload_sha256 !== buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256) {
    sourceMismatch("surface snapshot is not bound to the exact buyer payload");
  }
  const expectedBindings: ListingIntegritySourceBindings = {
    product_truth_snapshot_id: truthSnapshot.snapshot_id,
    product_truth_snapshot_body_sha256: truthSnapshot.body_sha256,
    catalog_truth_export_id: verifiedExport.export_id,
    catalog_truth_export_body_sha256: verifiedExport.body_sha256,
    catalog_truth_case_id: auditCase.case_id,
    catalog_truth_preflight_sha256: auditCase.preflight_sha256,
    truth_revision_id: auditCase.truth_revision.revision_id,
    truth_revision_body_sha256: auditCase.truth_revision.body_sha256,
    truth_approval_sha256: auditCase.truth_revision.approval_sha256,
    buyer_index_id: buyerIndex.index_id,
    buyer_index_body_sha256: buyerIndex.body_sha256,
    buyer_snapshot_id: buyerSnapshot.snapshot_id,
    buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
    buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
    surface_snapshot_id: surfaceSnapshot.snapshot_id,
    surface_snapshot_body_sha256: surfaceSnapshot.body_sha256,
    surface_payload_sha256: surfaceSnapshot.buyer_source.buyer_payload_sha256,
  };
  if (!canonicalEqual(input.source_bindings, expectedBindings)) sourceMismatch("source_bindings differ from verified source artifacts");

  const normalizedBuyerAssets = buyerSnapshot.assets.map((asset, index) => ({
    slot: (index === 0 ? "main" : `gallery-${index}`) as ImageSlot,
    asset,
  }));
  if (normalizedBuyerAssets.length !== input.images.assets.length
    || sources.asset_bytes.size !== input.images.assets.length) {
    sourceMismatch("asset population does not exactly match buyer snapshot");
  }
  const fullViewBySlot = new Map<ImageSlot, string>();
  const derivedViewsBySlot = new Map<ImageSlot, Map<string, { role: string; width: number; height: number }>>();
  for (let index = 0; index < input.images.assets.length; index += 1) {
    const inputAsset = input.images.assets[index]!;
    const buyerAssetRow = normalizedBuyerAssets[index]!;
    const buyerAsset = buyerAssetRow.asset;
    if (inputAsset.slot !== buyerAssetRow.slot
      || inputAsset.source_url !== buyerAsset.final_url
      || inputAsset.sha256 !== buyerAsset.sha256
      || inputAsset.byte_length !== buyerAsset.bytes
      || inputAsset.decoded_width !== buyerAsset.decoded_width
      || inputAsset.decoded_height !== buyerAsset.decoded_height) {
      sourceMismatch(`${inputAsset.slot}: asset metadata differs from buyer snapshot`);
    }
    const bytes = sources.asset_bytes.get(inputAsset.slot);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) sourceMismatch(`${inputAsset.slot}: frozen bytes are missing`);
    const fingerprint = await fingerprintGalleryImage("gallery-1", bytes);
    if (fingerprint.sha256 !== inputAsset.sha256 || bytes.byteLength !== inputAsset.byte_length
      || fingerprint.width !== inputAsset.decoded_width || fingerprint.height !== inputAsset.decoded_height
      || fingerprint.dhash64 !== inputAsset.dhash64) {
      sourceMismatch(`${inputAsset.slot}: SHA/dimensions/dHash do not rebuild from frozen bytes`);
    }
    const preprocessed = await preprocessCatalogVisual(Buffer.from(bytes));
    if (preprocessed.source.sha256 !== inputAsset.sha256) {
      sourceMismatch(`${inputAsset.slot}: visual preprocessor source SHA mismatch`);
    }
    const fullViews = preprocessed.views.filter((view) => view.role === "full");
    if (fullViews.length !== 1) sourceMismatch(`${inputAsset.slot}: preprocessor did not emit exactly one full view`);
    fullViewBySlot.set(inputAsset.slot, fullViews[0]!.sha256);
    const viewBySha = new Map<string, { role: string; width: number; height: number }>();
    for (const view of preprocessed.views) {
      const prior = viewBySha.get(view.sha256);
      if (prior && prior.role !== view.role) {
        sourceMismatch(`${inputAsset.slot}: two derived view roles share the same SHA`);
      }
      viewBySha.set(view.sha256, { role: view.role, width: view.width, height: view.height });
    }
    derivedViewsBySlot.set(inputAsset.slot, viewBySha);
  }

  const runLockSha = sha(sources.run_lock_sha256, "sources.run_lock_sha256");
  const codeBundleId = stringValue(sources.code_bundle_id, "sources.code_bundle_id");
  if (!/^sha256:[a-f0-9]{64}$/u.test(codeBundleId)) {
    sourceMismatch("code_bundle_id must be a content-addressed SHA-256 identifier");
  }
  const codeBundleManifestSha = sha(
    sources.code_bundle_manifest_sha256,
    "sources.code_bundle_manifest_sha256",
  );
  const workerReceiptKeyId = stringValue(
    sources.worker_receipt_key_id,
    "sources.worker_receipt_key_id",
  );
  const workerReceiptPublicKeySha = sha(
    sources.worker_receipt_public_key_sha256,
    "sources.worker_receipt_public_key_sha256",
  );
  if (!Array.isArray(sources.observation_batches)) sourceMismatch("observation_batches must be an array");
  const batches: SealedWalmartListingObservationBatch[] = sources.observation_batches
    .map((batch) => verifyWalmartListingObservationBatch(batch));
  const rawTerminals = sources.observation_terminal_artifacts ?? [];
  if (!Array.isArray(rawTerminals)) {
    sourceMismatch("observation_terminal_artifacts must be an array");
  }
  const terminals: SealedWalmartListingObservationTechnicalErrorTerminal[] = rawTerminals
    .map((terminal) => verifyWalmartListingObservationTechnicalErrorTerminal(terminal));
  const artifacts = [...batches, ...terminals];
  if (new Set(artifacts.map((artifact) => artifact.artifact_id)).size !== artifacts.length) {
    sourceMismatch("observation artifacts contain duplicate artifact IDs");
  }
  const observedBySlot = new Map<ImageSlot, {
    kind: "observed";
    binding: SealedWalmartListingObservationBatch["image_bindings"][number];
    observation: BlindObservation;
    local_ocr: SealedWalmartListingObservationBatch["local_ocr"][number];
  } | {
    kind: "technical_error_terminal";
    binding: SealedWalmartListingObservationTechnicalErrorTerminal["image_bindings"][number];
    terminal: SealedWalmartListingObservationTechnicalErrorTerminal;
  }>();
  for (const batch of batches) {
    if (batch.run_lock_sha256 !== runLockSha) sourceMismatch(`${batch.artifact_id}: run-lock SHA mismatch`);
    if (batch.worker_receipt.key_id !== workerReceiptKeyId
      || batch.worker_receipt.public_key_spki_sha256 !== workerReceiptPublicKeySha) {
      sourceMismatch(`${batch.artifact_id}: signed worker receipt key differs from the run-lock`);
    }
    for (const binding of batch.image_bindings) {
      if (binding.listing_key !== input.listing.listing_key) continue;
      if (binding.item_id !== input.listing.item_id) sourceMismatch(`${binding.slot}: observation itemId mismatch`);
      if (observedBySlot.has(binding.slot)) sourceMismatch(`${binding.slot}: duplicate observation binding`);
      const observation = batch.result.observations.find((row) => row.image_id === binding.image_id);
      const localOcr = batch.local_ocr.find((row) => row.image_id === binding.image_id);
      if (!observation || !localOcr) sourceMismatch(`${binding.slot}: observation/OCR row is missing`);
      observedBySlot.set(binding.slot, {
        kind: "observed",
        binding,
        observation,
        local_ocr: localOcr,
      });
    }
  }
  for (const terminal of terminals) {
    if (terminal.run_lock_sha256 !== runLockSha) {
      sourceMismatch(`${terminal.artifact_id}: run-lock SHA mismatch`);
    }
    if (terminal.execution.pass_eligible !== false) {
      sourceMismatch(`${terminal.artifact_id}: technical-error terminal is PASS-eligible`);
    }
    for (const binding of terminal.image_bindings) {
      if (binding.listing_key !== input.listing.listing_key) continue;
      if (binding.item_id !== input.listing.item_id) {
        sourceMismatch(`${binding.slot}: terminal itemId mismatch`);
      }
      if (observedBySlot.has(binding.slot)) {
        sourceMismatch(`${binding.slot}: duplicate observation/terminal binding`);
      }
      observedBySlot.set(binding.slot, {
        kind: "technical_error_terminal",
        binding,
        terminal,
      });
    }
  }
  const evidenceBySlot = new Map(input.images.evidence.map((row) => [row.slot, row]));
  let everyObservationVerified = true;
  for (const asset of input.images.assets) {
    const evidence = evidenceBySlot.get(asset.slot)!;
    const observed = observedBySlot.get(asset.slot);
    if (observed?.kind === "technical_error_terminal") {
      everyObservationVerified = false;
      const terminal = observed.terminal;
      const expectedError = `immutable terminal ${terminal.artifact_id}/${terminal.body_sha256}; ambiguous attempt ${terminal.attempt_body_sha256}; model result unavailable and retry forbidden`;
      if (evidence.state !== "technical_error"
        || evidence.asset_sha256 !== asset.sha256
        || evidence.error !== expectedError
        || observed.binding.asset_sha256 !== asset.sha256
        || observed.binding.model_view_sha256 !== fullViewBySlot.get(asset.slot)
        || observed.binding.image_id !== walmartListingIntegrityImageId(
          asset.sha256,
          asset.slot,
          input.listing.listing_key,
        )) {
        sourceMismatch(`${asset.slot}: input TECH_ERROR differs from its sealed terminal artifact`);
      }
      continue;
    }
    if (evidence.state !== "observed") {
      everyObservationVerified = false;
      if (observed) sourceMismatch(`${asset.slot}: artifact exists but input declares non-observed evidence`);
      continue;
    }
    if (!observed) sourceMismatch(`${asset.slot}: source-verified observation artifact is missing`);
    if (observed.binding.asset_sha256 !== asset.sha256
      || observed.binding.model_view_sha256 !== fullViewBySlot.get(asset.slot)
      || observed.binding.image_id !== walmartListingIntegrityImageId(asset.sha256, asset.slot, input.listing.listing_key)
      || !canonicalEqual(observed.observation, evidence.observation)
      || !canonicalEqual(observed.local_ocr.auxiliary_ocr, evidence.auxiliary_ocr)
      || observed.local_ocr.truncated !== evidence.local_ocr_truncated) {
      sourceMismatch(`${asset.slot}: input observation/OCR differs from its sealed Claude artifact`);
    }
    const allowedViews = derivedViewsBySlot.get(asset.slot)!;
    if (observed.local_ocr.auxiliary_ocr.ocr_texts.some((row) => (
      !row.view_sha256 || !row.view_role
      || allowedViews.get(row.view_sha256)?.role !== row.view_role
    ))) sourceMismatch(`${asset.slot}: local OCR references a view not rebuilt from source bytes`);
    if (observed.local_ocr.ocr_output.views.some((view) => {
      const rebuilt = allowedViews.get(view.view_sha256);
      return !rebuilt || rebuilt.role !== view.view_role
        || rebuilt.width !== view.width || rebuilt.height !== view.height;
    })) sourceMismatch(`${asset.slot}: local OCR output does not bind exact rebuilt views`);
  }
  for (const slot of observedBySlot.keys()) {
    if (!input.images.assets.some((asset) => asset.slot === slot)) {
      sourceMismatch(`${slot}: observation artifact has no buyer asset`);
    }
  }
  return compileWalmartListingIntegrityReportInternal(
    input,
    true,
    everyObservationVerified,
    {
      run_lock_sha256: runLockSha,
      code_bundle_id: codeBundleId,
      code_bundle_manifest_sha256: codeBundleManifestSha,
      worker_receipt_key_id: workerReceiptKeyId,
      worker_receipt_public_key_sha256: workerReceiptPublicKeySha,
      observation_artifacts: artifacts.map((artifact) => ({
        artifact_id: artifact.artifact_id,
        body_sha256: artifact.body_sha256,
        call_key: artifact.call_key,
        shard_id: artifact.shard_id,
        call_index: artifact.call_index,
      })),
    },
  );
}

export async function verifyWalmartListingIntegrityReportAgainstSources(
  rawReport: unknown,
  rawInput: unknown,
  sources: WalmartListingIntegritySourceArtifacts,
): Promise<SealedWalmartListingIntegrityReport> {
  const rebuilt = await compileWalmartListingIntegrityReportAgainstSources(rawInput, sources);
  if (!canonicalEqual(rawReport, rebuilt)) {
    throw new Error("integrity report does not exactly rebuild from independently verified sources and bytes");
  }
  return rebuilt;
}
