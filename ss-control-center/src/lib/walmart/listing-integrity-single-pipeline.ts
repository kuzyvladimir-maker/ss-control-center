/**
 * One-SKU bridge from the canonical Product Truth read contract to the
 * Walmart Listing Integrity detector.
 *
 * This module performs no I/O and creates no second catalog. It either returns
 * one exact expected truth for a same-product listing or a SOURCE_REQUIRED
 * result with explicit blockers. In particular, recipe quantity is the
 * listing's OUTER package count; a content donor whose own outerPackCount is
 * not one is rejected so a multipack can never silently become a
 * multipack-of-multipacks.
 */

import { createHash } from "node:crypto";

import {
  BLIND_OBSERVATION_SCHEMA,
  parseBlindResponse,
  type AuditExpectedTruth,
  type BlindObservation,
  type ExpectedPackageFact,
  type ImageSlot,
} from "./catalog-visual-audit.ts";
import { fingerprintGalleryImage } from "./catalog-gallery-audit.ts";
import type { SealedWalmartBuyerSnapshot } from "./buyer-facing-snapshot.ts";
import {
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  compileWalmartListingIntegrityReport,
  projectWalmartListingSurfaceFromBuyerPdp,
  walmartListingIntegrityImageId,
  walmartListingIntegritySha256,
  type SealedWalmartListingIntegrityReport,
  type WalmartListingIntegrityInput,
} from "./listing-integrity-audit.ts";
import type {
  ProductTruthRecipeComponent,
  ProductTruthSnapshot,
} from "../sourcing/product-truth-read-contract.ts";

export const WALMART_LISTING_SINGLE_PIPELINE_TRUTH_ADAPTER_VERSION =
  "walmart-listing-single-pipeline-truth-adapter/v9" as const;
export const WALMART_LISTING_SINGLE_DIAGNOSIS_FILENAME = "diagnosis-v9.json" as const;

export type WalmartListingSingleTruthProjection =
  | {
      status: "READY";
      adapter_version: typeof WALMART_LISTING_SINGLE_PIPELINE_TRUTH_ADAPTER_VERSION;
      listing_key: string;
      expected: AuditExpectedTruth;
      component_evidence_id: string;
      canonical_variant_id: string;
      blockers: [];
    }
  | {
      status: "SOURCE_REQUIRED";
      adapter_version: typeof WALMART_LISTING_SINGLE_PIPELINE_TRUTH_ADAPTER_VERSION;
      listing_key: string;
      expected: null;
      component_evidence_id: null;
      canonical_variant_id: null;
      blockers: string[];
    };

export interface WalmartListingSingleDiagnosticInput {
  product_truth: ProductTruthSnapshot;
  buyer_snapshot: SealedWalmartBuyerSnapshot;
  buyer_pdp_payload: unknown;
  image_bytes_by_sha256: ReadonlyMap<string, Uint8Array>;
  blind_observations: readonly BlindObservation[];
}

export type WalmartListingSingleDiagnosticResult =
  | {
      status: "SOURCE_REQUIRED";
      truth: Extract<WalmartListingSingleTruthProjection, { status: "SOURCE_REQUIRED" }>;
      detector_input: null;
      report: null;
    }
  | {
      status: "DIAGNOSED";
      truth: Extract<WalmartListingSingleTruthProjection, { status: "READY" }>;
      detector_input: WalmartListingIntegrityInput;
      report: SealedWalmartListingIntegrityReport;
    };

export type WalmartListingSingleProcessOutcome =
  | {
      status: "SOURCE_REQUIRED";
      blockers: string[];
      report: null;
      next_step: "ENRICH_EXACT_PRODUCT_TRUTH";
    }
  | {
      status: "BAD";
      blockers: string[];
      report: SealedWalmartListingIntegrityReport;
      next_step: "BUILD_REPAIR_PREVIEW";
    }
  | {
      status: "REVIEW";
      blockers: string[];
      report: SealedWalmartListingIntegrityReport;
      next_step: "MANUAL_OR_ADDITIONAL_EVIDENCE_REVIEW";
    }
  | {
      status: "CLEAN_CANDIDATE";
      blockers: [];
      report: SealedWalmartListingIntegrityReport;
      next_step: "RUN_SOURCE_AWARE_QUALIFICATION";
    };

function exactText(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

function uniqueTexts(values: readonly unknown[]): string[] {
  return [...new Set(values.map(exactText).filter((value): value is string => value !== null))];
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/['’ʼ]/gu, "")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function uniqueNormalizedTexts(values: readonly unknown[]): string[] {
  const byNormalized = new Map<string, string>();
  for (const value of uniqueTexts(values)) {
    const normalized = normalizeIdentityText(value);
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, value);
  }
  return [...byNormalized.values()];
}

function exactIdentitySpanInTitle(value: string, title: string | null): boolean {
  if (!title) return false;
  const normalizedValue = normalizeIdentityText(value);
  const normalizedTitle = normalizeIdentityText(title);
  return normalizedValue.length > 0
    && ` ${normalizedTitle} `.includes(` ${normalizedValue} `);
}

/**
 * Canonical variant keys intentionally sort identity tokens. Recover a
 * buyer-readable brand order only when the exact same token multiset appears
 * as one contiguous span in the exact content-donor title.
 */
function recoverOrderedIdentityAlias(
  canonicalValue: string,
  exactContentTitle: string | null,
): string | null {
  if (!exactContentTitle) return null;
  const canonicalTokens = normalizeIdentityText(canonicalValue).split(" ").filter(Boolean);
  const titleDisplayTokens = exactContentTitle
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const titleTokens = titleDisplayTokens.map(normalizeIdentityText);
  if (canonicalTokens.length < 2 || titleTokens.length < canonicalTokens.length) return null;
  const expected = [...canonicalTokens].sort().join("\0");
  for (let index = 0; index <= titleTokens.length - canonicalTokens.length; index += 1) {
    const candidate = titleTokens.slice(index, index + canonicalTokens.length);
    if ([...candidate].sort().join("\0") === expected) {
      return titleDisplayTokens.slice(index, index + canonicalTokens.length).join(" ");
    }
  }
  return null;
}

function displayModifier(value: unknown): string | null {
  const text = exactText(value);
  if (!text) return null;
  const stripped = text.replace(/^token:/u, "");
  return stripped || null;
}

function exactContentAttribute(value: unknown, expectedName: string): string | null {
  if (!Array.isArray(value)) return null;
  const expected = normalizeIdentityText(expectedName);
  const matches = value.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    const name = exactText(record.name) ?? exactText(record.label);
    const attributeValue = exactText(record.value);
    return name && attributeValue && normalizeIdentityText(name) === expected
      ? [attributeValue]
      : [];
  });
  const unique = uniqueNormalizedTexts(matches);
  return unique.length === 1 ? unique[0]! : null;
}

function packageFact(component: ProductTruthRecipeComponent): ExpectedPackageFact | null {
  const identity = component.content?.identity;
  if (!identity || !Number.isFinite(identity.sizeBaseAmount) || identity.sizeBaseAmount <= 0) {
    return null;
  }
  if (identity.sizeDimension === "MASS" && identity.sizeBaseUnit === "g") {
    return {
      kind: "net_content",
      requirement: "required",
      value: identity.sizeBaseAmount,
      unit: "g",
    };
  }
  if (identity.sizeDimension === "VOLUME" && identity.sizeBaseUnit === "ml") {
    return {
      kind: "net_content",
      requirement: "required",
      value: identity.sizeBaseAmount,
      unit: "ml",
    };
  }
  if (identity.sizeDimension === "COUNT" && identity.sizeBaseUnit === "count") {
    return {
      kind: "inner_item_count",
      requirement: "required",
      value: identity.sizeBaseAmount,
      unit: "count",
    };
  }
  return null;
}

/**
 * Fail closed when an upstream canonical MASS identity appears to have parsed
 * a nutrition claim as the package size. A title such as `20g Protein` does
 * not establish a 20 g net weight; using it as `net_content` can make correct
 * 2.5 oz / 71 g package images look like the wrong product.
 */
function canonicalSizeLooksLikeNutrientClaim(
  component: ProductTruthRecipeComponent,
  contentTitle: string | null,
): boolean {
  const identity = component.content?.identity;
  if (!identity || !contentTitle || identity.sizeDimension !== "MASS") return false;
  if (identity.sizeBaseUnit !== "g" || !Number.isFinite(identity.sizeBaseAmount)) return false;

  const nutrientClaim = /(protein|fiber|sugar|carbohydrate|carbs|fat)\b/iu;
  const massClaims = contentTitle.matchAll(/(\d+(?:\.\d+)?)\s*(?:g|gram|grams)\b/giu);
  let matchedCanonicalAmount = false;
  for (const match of massClaims) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || Math.abs(amount - identity.sizeBaseAmount) > 1e-9) continue;
    matchedCanonicalAmount = true;
    const suffix = contentTitle.slice((match.index ?? 0) + match[0].length).trimStart();
    if (!nutrientClaim.test(suffix)) return false;
  }
  return matchedCanonicalAmount;
}

function sourceRequired(
  listingKey: string,
  blockers: readonly string[],
): WalmartListingSingleTruthProjection {
  return {
    status: "SOURCE_REQUIRED",
    adapter_version: WALMART_LISTING_SINGLE_PIPELINE_TRUTH_ADAPTER_VERSION,
    listing_key: listingKey,
    expected: null,
    component_evidence_id: null,
    canonical_variant_id: null,
    blockers: [...new Set(blockers)].sort(),
  };
}

/**
 * Content facts that are mandatory for a complete catalog record but do not
 * participate in a visual identity/quantity audit. Keeping this exception
 * here (instead of weakening Product Truth readiness) preserves the missing
 * enrichment task while allowing a proven wrong-product image to be repaired.
 */
const WALMART_LISTING_INTEGRITY_NON_BLOCKING_CONTENT_CODES = new Set([
  "CONTENT_STORAGE_MISSING",
]);

export function walmartListingIntegrityBlockingContentCodes(
  codes: readonly string[],
): string[] {
  return codes.filter((code) => (
    !WALMART_LISTING_INTEGRITY_NON_BLOCKING_CONTENT_CODES.has(code)
  ));
}

export function productTruthSupportsWalmartListingIntegrityAudit(
  snapshot: ProductTruthSnapshot,
): boolean {
  const view = snapshot?.views?.listingImprovement;
  if (!view) return false;
  if (view.ready) return true;
  if (view.components.length !== 1) return false;
  const component = view.components[0]!;
  if (!component.content
    || walmartListingIntegrityBlockingContentCodes(component.contentBlockers).length) {
    return false;
  }
  const allowedViewBlockers = new Set(component.contentBlockers.map((code) => (
    `COMPONENT_${component.componentIndex}:${code}`
  )));
  return view.blockers.every((code) => allowedViewBlockers.has(code));
}

/**
 * Project one canonical listing-improvement snapshot into detector truth.
 * Unsupported/missing evidence never falls back to title inference.
 */
export function projectProductTruthForWalmartSingleListing(
  snapshot: ProductTruthSnapshot,
): WalmartListingSingleTruthProjection {
  const listingKey = exactText(snapshot?.snapshot?.listingKey) ?? "UNKNOWN_LISTING";
  const blockers: string[] = [];
  const components = snapshot?.views?.listingImprovement?.components ?? [];
  const fieldScopedReady = productTruthSupportsWalmartListingIntegrityAudit(snapshot);
  if (snapshot?.snapshot?.channel.toLowerCase() !== "walmart") {
    blockers.push("CHANNEL_NOT_WALMART");
  }
  if (!fieldScopedReady) {
    blockers.push("LISTING_IMPROVEMENT_NOT_READY");
    blockers.push(...(snapshot?.views?.listingImprovement?.blockers ?? []).map((value) => (
      `PRODUCT_TRUTH:${value}`
    )));
  }
  if (components.length !== 1) {
    blockers.push(`SAME_PRODUCT_PIPELINE_REQUIRES_ONE_COMPONENT:FOUND_${components.length}`);
    return sourceRequired(listingKey, blockers);
  }

  const component = components[0]!;
  if (!Number.isSafeInteger(component.qty) || component.qty < 1) {
    blockers.push("LISTING_OUTER_QUANTITY_INVALID");
  }
  // `evidenceStatus` belongs to the independent price/COGS axis. Listing
  // Improvement is allowed to consume exact canonical content even when the
  // component has no current factual buy price. The shared read contract
  // already fail-closes this content axis through `listingImprovement.ready`,
  // `contentBlockers`, canonical-variant equality, and donor outer-pack checks.
  blockers.push(...walmartListingIntegrityBlockingContentCodes(
    component.contentBlockers,
  ).map((value) => `CONTENT:${value}`));
  if (!component.content) {
    blockers.push("EXACT_CONTENT_MISSING");
    return sourceRequired(listingKey, blockers);
  }
  if (component.content.canonicalVariantId !== component.targetCanonicalVariantId) {
    blockers.push("CONTENT_VARIANT_DIFFERS_FROM_RECIPE_VARIANT");
  }
  if (component.content.identity.outerPackCount !== 1) {
    blockers.push(
      `CONTENT_DONOR_IS_NOT_ONE_OUTER_PACKAGE:${component.content.identity.outerPackCount}`,
    );
  }

  const canonicalBrand = component.content.identity.brand;
  const contentTitle = exactText(component.content.facts.title);
  const brandAliases = uniqueNormalizedTexts([
    recoverOrderedIdentityAlias(canonicalBrand, contentTitle),
    canonicalBrand,
  ]);
  const exactAttributeBrand = exactContentAttribute(
    component.content.facts.attributes,
    "Brand",
  );
  const exactSubBrand = exactAttributeBrand
    && !brandAliases.some((value) => normalizeIdentityText(value)
      === normalizeIdentityText(exactAttributeBrand))
    && exactIdentitySpanInTitle(exactAttributeBrand, contentTitle)
    ? exactAttributeBrand
    : null;
  const exactAttributeProductLine = exactContentAttribute(
    component.content.facts.attributes,
    "Product line",
  );
  const exactProductLine = exactAttributeProductLine
    && exactIdentitySpanInTitle(exactAttributeProductLine, contentTitle)
    ? exactAttributeProductLine
    : null;
  const productAliases = uniqueNormalizedTexts([
    component.content.identity.productLine,
    component.product,
    exactSubBrand,
    exactProductLine,
  ]);
  const structuredFlavors = uniqueNormalizedTexts([
    component.content.identity.flavor,
    component.flavor,
  ]);
  const exactAttributeFlavor = structuredFlavors.length === 0
    ? exactContentAttribute(component.content.facts.attributes, "Flavor")
    : null;
  const variantGroups = [
    ...uniqueNormalizedTexts([...structuredFlavors, exactAttributeFlavor])
      .map((value) => [value]),
    ...(Array.isArray(component.content.identity.modifiers)
      ? component.content.identity.modifiers
        .map(displayModifier)
        .filter((value): value is string => value !== null)
        .filter((value, index, values) => (
          values.findIndex((candidate) =>
            normalizeIdentityText(candidate) === normalizeIdentityText(value)
          ) === index
        ))
        .map((value) => [value])
      : []),
  ];
  if (!brandAliases.length) blockers.push("BRAND_IDENTITY_MISSING");
  if (!productAliases.length) blockers.push("PRODUCT_IDENTITY_MISSING");
  if (canonicalSizeLooksLikeNutrientClaim(component, contentTitle)) {
    blockers.push("CANONICAL_SIZE_LOOKS_LIKE_NUTRIENT_CLAIM");
  }

  const fact = packageFact(component);
  if (!fact) blockers.push("EXACT_ONE_PACKAGE_SIZE_OR_INNER_COUNT_MISSING");
  if (blockers.length) return sourceRequired(listingKey, blockers);

  const title = exactText(component.content.facts.title)
    ?? `${brandAliases[0]} ${productAliases[0]}`;
  return {
    status: "READY",
    adapter_version: WALMART_LISTING_SINGLE_PIPELINE_TRUTH_ADAPTER_VERSION,
    listing_key: listingKey,
    expected: {
      title,
      outer_units: component.qty,
      identity: {
        brand_aliases: brandAliases,
        product_marker_groups: [productAliases],
        variant_marker_groups: variantGroups,
        forbidden_markers: [],
      },
      package_facts: [fact!],
      truth_source: "recipe",
    },
    component_evidence_id: component.componentEvidenceId,
    canonical_variant_id: component.targetCanonicalVariantId,
    blockers: [],
  };
}

function detectorSlot(slot: SealedWalmartBuyerSnapshot["assets"][number]["slot"]): ImageSlot {
  return slot === "MAIN"
    ? "main"
    : `gallery-${Number(slot.slice("GALLERY_".length))}`;
}

/**
 * Run the existing deterministic detector for one exact captured SKU.
 *
 * This is intentionally diagnostic (`input_only`): it can prove BAD from a
 * contradiction but can never issue PASS or authorize a repair. A later
 * source-aware replay of the same evidence is required before apply.
 */
export async function diagnoseWalmartSingleListing(
  input: WalmartListingSingleDiagnosticInput,
): Promise<WalmartListingSingleDiagnosticResult> {
  const truth = projectProductTruthForWalmartSingleListing(input.product_truth);
  if (truth.status !== "READY") {
    return { status: "SOURCE_REQUIRED", truth, detector_input: null, report: null };
  }
  const buyer = input.buyer_snapshot;
  const listingKey = input.product_truth.snapshot.listingKey;
  if (buyer.target.sku !== input.product_truth.snapshot.sku
    || buyer.identity.buyer.item_id !== buyer.target.item_id
    || buyer.identity.exact_sku_match !== true
    || buyer.identity.exact_item_id_match !== true
    || buyer.identity.buyer_facing_verified !== true
    || buyer.identity.seller.published_status !== "PUBLISHED"
    || buyer.identity.seller.lifecycle_status !== "ACTIVE") {
    throw new Error("buyer snapshot does not prove the exact active published listing");
  }
  const surface = projectWalmartListingSurfaceFromBuyerPdp(
    input.buyer_pdp_payload,
    buyer.target,
  );
  const assets = [];
  for (const [index, asset] of buyer.assets.entries()) {
    const slot = detectorSlot(asset.slot);
    if (slot !== (index === 0 ? "main" : `gallery-${index}`)) {
      throw new Error("buyer snapshot assets are not MAIN then contiguous gallery slots");
    }
    const bytes = input.image_bytes_by_sha256.get(asset.sha256);
    if (!bytes || bytes.byteLength !== asset.bytes
      || walmartListingIntegritySha256Bytes(bytes) !== asset.sha256) {
      throw new Error(`${slot} exact image bytes are missing or changed`);
    }
    const fingerprint = await fingerprintGalleryImage("gallery-1", bytes);
    if (fingerprint.width !== asset.decoded_width
      || fingerprint.height !== asset.decoded_height) {
      throw new Error(`${slot} decoded dimensions differ from buyer snapshot`);
    }
    assets.push({
      slot,
      source_url: asset.source_url,
      sha256: asset.sha256,
      byte_length: asset.bytes,
      decoded_width: asset.decoded_width,
      decoded_height: asset.decoded_height,
      dhash64: fingerprint.dhash64,
      buyer_facing_verified: true as const,
      surface: "buyer_pdp" as const,
    });
  }
  const imageIds = assets.map((asset) => (
    walmartListingIntegrityImageId(asset.sha256, asset.slot, listingKey)
  ));
  const observations = parseBlindResponse({
    schema_version: BLIND_OBSERVATION_SCHEMA,
    observations: [...input.blind_observations],
  }, imageIds);
  const truthSha = walmartListingIntegritySha256(input.product_truth);
  const buyerSha = buyer.body_sha256;
  const surfaceSha = walmartListingIntegritySha256(surface);
  // AuditExpectedTruth.title is the source-bound current buyer-facing title,
  // while its identity/quantity/package facts come from Product Truth. Keeping
  // these roles separate lets the detector audit a wrong live title instead of
  // requiring the live title to equal the donor title before comparison.
  const detectorExpected: AuditExpectedTruth = {
    ...truth.expected,
    title: surface.title,
  };
  const detectorInput: WalmartListingIntegrityInput = {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      channel: "WALMART_US",
      store_index: input.product_truth.snapshot.storeIndex,
      sku: input.product_truth.snapshot.sku,
      listing_key: listingKey,
      item_id: buyer.target.item_id,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      captured_at: buyer.captured_at,
      composition: "same_product",
    },
    source_bindings: {
      product_truth_snapshot_id:
        `${input.product_truth.contractVersion}:${listingKey}`,
      product_truth_snapshot_body_sha256: truthSha,
      catalog_truth_export_id: `single-diagnostic:${listingKey}`,
      catalog_truth_export_body_sha256: truthSha,
      catalog_truth_case_id: `single-diagnostic-case:${listingKey}`,
      catalog_truth_preflight_sha256: walmartListingIntegritySha256(detectorExpected),
      truth_revision_id: truth.component_evidence_id,
      truth_revision_body_sha256: truthSha,
      truth_approval_sha256: walmartListingIntegritySha256({
        component_evidence_id: truth.component_evidence_id,
        canonical_variant_id: truth.canonical_variant_id,
      }),
      buyer_index_id: `single-buyer-index:${listingKey}`,
      buyer_index_body_sha256: buyerSha,
      buyer_snapshot_id: buyer.snapshot_id,
      buyer_snapshot_body_sha256: buyerSha,
      buyer_payload_sha256: buyer.payload_hashes.buyer_payload_canonical_sha256,
      surface_snapshot_id: `single-surface:${listingKey}`,
      surface_snapshot_body_sha256: surfaceSha,
      surface_payload_sha256: buyer.payload_hashes.buyer_payload_canonical_sha256,
    },
    expected: detectorExpected,
    surface,
    images: {
      assets,
      evidence: assets.map((asset, index) => ({
        slot: asset.slot,
        asset_sha256: asset.sha256,
        state: "observed" as const,
        observation: observations[index]!,
        auxiliary_ocr: { ocr_texts: [] },
        local_ocr_truncated: false,
      })),
      duplicate_summary: null,
    },
  };
  return {
    status: "DIAGNOSED",
    truth,
    detector_input: detectorInput,
    report: compileWalmartListingIntegrityReport(detectorInput),
  };
}

/**
 * Convert the input-only detector result into the operational state used by a
 * sequential one-SKU queue. CLEAN_CANDIDATE is deliberately not PASS: only
 * the existing source-aware verifier may promote it after rebuilding all
 * source artifacts and exact image bytes.
 */
export function classifyWalmartSingleDiagnostic(
  result: WalmartListingSingleDiagnosticResult,
): WalmartListingSingleProcessOutcome {
  if (result.status === "SOURCE_REQUIRED") {
    return {
      status: "SOURCE_REQUIRED",
      blockers: [...result.truth.blockers],
      report: null,
      next_step: "ENRICH_EXACT_PRODUCT_TRUTH",
    };
  }
  if (result.report.overall_verdict === "BAD") {
    return {
      status: "BAD",
      blockers: [...result.report.blocking_reasons],
      report: result.report,
      next_step: "BUILD_REPAIR_PREVIEW",
    };
  }
  const allComponentChecksPass = result.report.text_decision.verdict === "PASS"
    && result.report.main_decision.verdict === "PASS"
    && result.report.gallery_decisions.every((decision) => decision.verdict === "PASS")
    && result.report.blocking_reasons.length === 0
    && result.report.review_reasons.every((reason) => (
      reason === "source artifacts, surface snapshot, and image bytes were not independently verified"
      || reason === "blind observation and local OCR artifacts were not independently verified"
    ));
  if (allComponentChecksPass) {
    return {
      status: "CLEAN_CANDIDATE",
      blockers: [],
      report: result.report,
      next_step: "RUN_SOURCE_AWARE_QUALIFICATION",
    };
  }
  return {
    status: "REVIEW",
    blockers: [...new Set([
      ...result.report.blocking_reasons,
      ...result.report.review_reasons,
    ])],
    report: result.report,
    next_step: "MANUAL_OR_ADDITIONAL_EVIDENCE_REVIEW",
  };
}

function walmartListingIntegritySha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
