/**
 * Read-only, deterministic gallery-image audit primitives.
 *
 * The caller must pass `expected` from a manifest accepted by
 * `validateAuditManifest`. Gallery checks deliberately do not inherit main
 * image rules: outer count, grid composition, front orientation, and white
 * background are ignored here.
 */

import { createHash } from "node:crypto";

import sharp from "sharp";

import type {
  AuditAuxiliaryEvidence,
  AuditExpectedTruth,
  AuditIdentityTruth,
  BlindObservation,
  ExpectedPackageFact,
  ExpectedSize,
  IdentityRole,
  PackageFactKind,
} from "./catalog-visual-audit";

export const WALMART_GALLERY_AUDIT_VERSION = "walmart-gallery-audit/v1" as const;
export const WALMART_GALLERY_DUPLICATE_REPORT_SCHEMA = "walmart-gallery-duplicates/v1" as const;
export const DEFAULT_GALLERY_DHASH_DISTANCE = 5 as const;
export const WALMART_GALLERY_AUXILIARY_OCR_MIN_CONFIDENCE = 0.95 as const;
export const WALMART_GALLERY_MAX_INPUT_PIXELS = 40_000_000 as const;

export type GallerySlot = `gallery-${number}`;
export type GalleryAuditVerdict =
  | "PASS"
  | "BAD"
  | "REVIEW"
  | "UNSUPPORTED"
  | "MISSING"
  | "TECH_ERROR";

export type GalleryIdentityCheck = "MATCH" | "MISMATCH" | "UNKNOWN";
export type GalleryPackageFactCheck =
  | "MATCH"
  | "MISMATCH"
  | "UNKNOWN"
  | "NOT_VISIBLE"
  | "NOT_APPLICABLE";

export interface GalleryComponentIdentity {
  component_id: string;
  identity: AuditIdentityTruth;
}

export type GalleryComposition =
  | { kind: "same_product" }
  | { kind: "mixed_component_bundle"; component_identities?: GalleryComponentIdentity[] };

export type GalleryObservationSource =
  | {
      state: "observed";
      observation: BlindObservation;
      auxiliary_ocr?: AuditAuxiliaryEvidence;
    }
  | { state: "missing"; reason: string }
  | { state: "technical_error"; error: string };

export interface GalleryAuditInput {
  slot: GallerySlot;
  expected: AuditExpectedTruth;
  source: GalleryObservationSource;
  /** Defaults to same_product. */
  composition?: GalleryComposition;
}

export interface GalleryAuditDecision {
  schema_version: typeof WALMART_GALLERY_AUDIT_VERSION;
  slot: GallerySlot;
  verdict: GalleryAuditVerdict;
  matched_component_id: string | null;
  checks: {
    identity: GalleryIdentityCheck;
    package_facts: Record<PackageFactKind, GalleryPackageFactCheck>;
  };
  hard_failures: string[];
  review_reasons: string[];
  missing_reason: string | null;
  technical_error: string | null;
}

interface IdentityAssessment {
  status: GalleryIdentityCheck;
  hard: string[];
  review: string[];
}

interface PackageAssessment {
  checks: Record<PackageFactKind, GalleryPackageFactCheck>;
  hard: string[];
  review: string[];
}

const EMPTY_PACKAGE_CHECKS: Record<PackageFactKind, GalleryPackageFactCheck> = {
  net_content: "NOT_APPLICABLE",
  inner_item_count: "NOT_APPLICABLE",
};

function normalizeGalleryText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseGallerySizeTexts(value: string | null): ExpectedSize[] {
  if (!value) return [];
  const text = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/,/g, " ")
    .replace(/\bfl\.?\s*0z\b/g, "fl oz")
    .replace(/\bfl\.\s*oz\b/g, "fl oz")
    .replace(/\b(\d+)\.0z\b/g, "$1 oz ")
    .replace(/(\d)0z(?=\d|\b)/g, "$1 oz ")
    .replace(/\s+/g, " ")
    .replace(/\b(\d+(?:\.\d+)?)\s*lbs?\s*(\d+(?:\.\d+)?)\s*(?:ounces?|oz)\b/gi,
      (_all, pounds, ounces) => `${Number(pounds) * 16 + Number(ounces)} oz`);
  const pattern = /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(fl\s*oz|fluid\s*ounces?|ounces?|oz|counts?|ct|tea\s*bags?|buns?|muffins?|cookies?|bars?|pieces?|shells?|cans?|bottles?|lbs?|pounds?|kg|grams?|g|ml|milliliters?|liters?|litres?|l)\b/gi;
  const parsed: ExpectedSize[] = [];
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const rawUnit = match[2].replace(/\s+/g, " ").toLowerCase();
    let unit: ExpectedSize["unit"];
    if (/^fl oz|^fluid/.test(rawUnit)) unit = "fl_oz";
    else if (/^oz|^ounce/.test(rawUnit)) unit = "oz";
    else if (/^count|^ct$|^tea bag|^bun|^muffin|^cookie|^bar|^piece|^shell|^can|^bottle/.test(rawUnit)) unit = "count";
    else if (/^lb|^pound/.test(rawUnit)) unit = "lb";
    else if (rawUnit === "kg") unit = "kg";
    else if (/^g$|^gram/.test(rawUnit)) unit = "g";
    else if (/^ml$|^milliliter/.test(rawUnit)) unit = "ml";
    else unit = "l";
    parsed.push({ value: amount, unit });
  }
  return dedupeSizes(parsed);
}

function assertGallerySlot(slot: string): asserts slot is GallerySlot {
  if (!/^gallery-[1-9]\d*$/.test(slot)) {
    throw new Error(`gallery slot must match gallery-[1-9]\\d*: ${slot}`);
  }
}

function hasSpecificText(value: string | null): boolean {
  return normalizeGalleryText(value ?? "").split(" ").some((token) => token.length >= 2);
}

function containsAlias(value: string | null, aliases: readonly string[]): boolean {
  const haystack = ` ${normalizeGalleryText(value ?? "")} `;
  return aliases.some((alias) => {
    const needle = normalizeGalleryText(alias);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

function ocrContainsAlias(values: readonly string[], aliases: readonly string[]): boolean {
  // OCR rows are independent literal lines. Never build a token bag across
  // lines: unrelated brand/product words elsewhere in a panel must not
  // combine into a synthetic identity match.
  return values.some((value) => containsAlias(value, aliases));
}

function roleText(observation: BlindObservation, role: IdentityRole): string | null {
  if (role === "brand") return observation.visible_brand_text;
  if (role === "product") return observation.visible_product_text;
  return observation.visible_variant_text;
}

function trustedOcrTexts(auxiliary: AuditAuxiliaryEvidence | undefined): string[] {
  if (!auxiliary) return [];
  if (!Array.isArray(auxiliary.ocr_texts) || auxiliary.ocr_texts.length > 100) {
    throw new Error("auxiliary_ocr.ocr_texts must contain at most 100 rows");
  }
  return auxiliary.ocr_texts.flatMap((row, index) => {
    if (!row || typeof row !== "object") {
      throw new Error(`auxiliary_ocr.ocr_texts[${index}] must be an object`);
    }
    const keys = Object.keys(row).sort();
    const compact = keys.join(",") === "confidence,text";
    const spatial = keys.join(",")
      === "bounding_box,confidence,text,view_role,view_sha256";
    if (!compact && !spatial) {
      throw new Error(`auxiliary_ocr.ocr_texts[${index}] has unsupported fields`);
    }
    if (typeof row.text !== "string" || !row.text.trim()) {
      throw new Error(`auxiliary_ocr.ocr_texts[${index}].text must be non-empty`);
    }
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)
      || row.confidence < 0 || row.confidence > 1) {
      throw new Error(`auxiliary_ocr.ocr_texts[${index}].confidence must be in 0..1`);
    }
    if (spatial) {
      if (row.view_role !== "full" && row.view_role !== "tile_front"
        && row.view_role !== "bottom_label" && row.view_role !== "top_left_badge") {
        throw new Error(`auxiliary_ocr.ocr_texts[${index}].view_role is unsupported`);
      }
      if (typeof row.view_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.view_sha256)) {
        throw new Error(`auxiliary_ocr.ocr_texts[${index}].view_sha256 must be SHA-256`);
      }
      if (!row.bounding_box || typeof row.bounding_box !== "object"
        || Array.isArray(row.bounding_box)) {
        throw new Error(`auxiliary_ocr.ocr_texts[${index}].bounding_box must be an object`);
      }
      const boxKeys = Object.keys(row.bounding_box).sort();
      if (boxKeys.join(",") !== "height,width,x,y") {
        throw new Error(`auxiliary_ocr.ocr_texts[${index}].bounding_box has unsupported fields`);
      }
      const box = row.bounding_box as Record<string, unknown>;
      for (const key of ["x", "y", "width", "height"] as const) {
        if (typeof box[key] !== "number" || !Number.isFinite(box[key])
          || box[key] < 0 || box[key] > 1) {
          throw new Error(`auxiliary_ocr.ocr_texts[${index}].bounding_box.${key} must be in 0..1`);
        }
      }
      const x = box.x as number;
      const y = box.y as number;
      const width = box.width as number;
      const height = box.height as number;
      if (width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
        throw new Error(`auxiliary_ocr.ocr_texts[${index}].bounding_box is invalid`);
      }
    }
    return row.confidence >= WALMART_GALLERY_AUXILIARY_OCR_MIN_CONFIDENCE
      ? [row.text.trim()]
      : [];
  });
}

function assessIdentity(
  expected: AuditIdentityTruth,
  observation: BlindObservation,
  ocrTexts: readonly string[],
): IdentityAssessment {
  const hard: string[] = [];
  const review: string[] = [];

  const blindForbidden = expected.forbidden_markers.filter((marker) =>
    containsAlias(roleText(observation, marker.role), marker.aliases));
  const ocrOnlyForbidden = expected.forbidden_markers.filter((marker) =>
    !containsAlias(roleText(observation, marker.role), marker.aliases)
      && ocrContainsAlias(ocrTexts, marker.aliases));
  if (blindForbidden.length > 0) {
    hard.push(`role-scoped forbidden marker visible: ${blindForbidden
      .map((marker) => `${marker.role}:${marker.aliases.join("|")}`).join(", ")}`);
  }
  if (ocrOnlyForbidden.length > 0) {
    review.push(`OCR-only forbidden marker: ${ocrOnlyForbidden
      .map((marker) => `${marker.role}:${marker.aliases.join("|")}`).join(", ")}`);
  }

  const roleAssessments: Array<{
    role: IdentityRole;
    blind: string | null;
    groups: readonly string[][];
  }> = [
    { role: "brand", blind: observation.visible_brand_text, groups: [expected.brand_aliases] },
    { role: "product", blind: observation.visible_product_text, groups: expected.product_marker_groups },
    { role: "variant", blind: observation.visible_variant_text, groups: expected.variant_marker_groups },
  ];

  let everyRequiredGroupMatches = true;
  let ocrSuppliedEvidence = false;
  let blindSuppliedEvidence = false;
  for (const role of roleAssessments) {
    if (role.groups.length === 0) continue;
    const blindGroupMatches = role.groups.map((aliases) => containsAlias(role.blind, aliases));
    if (blindGroupMatches.some(Boolean)) blindSuppliedEvidence = true;
    const supportedGroupMatches = role.groups.map((aliases, index) => {
      const ocrMatch = ocrContainsAlias(ocrTexts, aliases);
      if (!blindGroupMatches[index] && ocrMatch) ocrSuppliedEvidence = true;
      return blindGroupMatches[index] || ocrMatch;
    });
    const blindMatchesAny = blindGroupMatches.some(Boolean);
    const supportedMatchesAll = supportedGroupMatches.every(Boolean);
    everyRequiredGroupMatches = everyRequiredGroupMatches && supportedMatchesAll;

    // Back/nutrition panels often expose generic headings. A role mismatch is
    // hard evidence only when the blind observer says identity is clear;
    // partial/none remains REVIEW rather than turning panel text into a false
    // foreign-product finding.
    const explicitBlindMismatch = observation.readable_identity === "clear"
      && hasSpecificText(role.blind) && !blindMatchesAny;
    const ocrResolvesMismatch = supportedGroupMatches.some(Boolean);
    if (explicitBlindMismatch && !ocrResolvesMismatch) {
      hard.push(`visible ${role.role} is not allowed: ${role.blind}`);
      continue;
    }
    if (explicitBlindMismatch && ocrResolvesMismatch) {
      review.push(`blind vision and OCR conflict for ${role.role}`);
      continue;
    }
    if (!supportedMatchesAll) {
      const missing = role.groups
        .filter((_aliases, index) => !supportedGroupMatches[index])
        .map((aliases) => aliases.join("|"));
      review.push(`required ${role.role} evidence missing: ${missing.join(", ")}`);
    }
  }

  if (hard.length > 0) return { status: "MISMATCH", hard, review };
  if (review.length > 0 || !everyRequiredGroupMatches || !blindSuppliedEvidence
    || (observation.readable_identity !== "clear" && !ocrSuppliedEvidence)) {
    if (!blindSuppliedEvidence) {
      review.push("OCR cannot be the sole source of gallery identity");
    }
    if (observation.readable_identity !== "clear" && !ocrSuppliedEvidence) {
      review.push(`identity readability is ${observation.readable_identity}`);
    }
    return { status: "UNKNOWN", hard: [], review: [...new Set(review)] };
  }
  return { status: "MATCH", hard: [], review: [] };
}

type Dimension = "mass" | "volume" | "count";

function normalizedSize(value: ExpectedSize): { dimension: Dimension; value: number } {
  if (value.unit === "count") return { dimension: "count", value: value.value };
  if (value.unit === "oz") return { dimension: "mass", value: value.value * 28.349523125 };
  if (value.unit === "lb") return { dimension: "mass", value: value.value * 453.59237 };
  if (value.unit === "g") return { dimension: "mass", value: value.value };
  if (value.unit === "kg") return { dimension: "mass", value: value.value * 1000 };
  if (value.unit === "fl_oz") return { dimension: "volume", value: value.value * 29.5735295625 };
  if (value.unit === "l") return { dimension: "volume", value: value.value * 1000 };
  return { dimension: "volume", value: value.value };
}

function sizeEquals(expected: ExpectedSize, observed: ExpectedSize): boolean {
  if (expected.unit === observed.unit) return expected.value === observed.value;
  const left = normalizedSize(expected);
  const right = normalizedSize(observed);
  if (left.dimension !== right.dimension || left.dimension === "count") return false;
  return Math.abs(left.value - right.value) / left.value <= 0.005;
}

function sizeEquivalent(left: ExpectedSize, right: ExpectedSize): boolean {
  return sizeEquals(left, right) || sizeEquals(right, left);
}

function dedupeSizes(values: readonly ExpectedSize[]): ExpectedSize[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.unit}:${value.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNutrientLiteral(value: string): boolean {
  return /\b(protein|fiber|whole grain|sugar|sugars|sodium|carb|carbs|carbohydrate|fat|calorie|calories|per serving|serving size|servings per|vitamin|calcium|iron)\b/i.test(value);
}

function bareCount(value: string): ExpectedSize | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const count = Number(normalized);
  return count > 0 ? { value: count, unit: "count" } : null;
}

function packageSizesFromBlind(observation: BlindObservation): Record<PackageFactKind, ExpectedSize[]> {
  const panelRequiresExplicitNetLabel = observation.visual_role === "back"
    || observation.visual_role === "nutrition"
    || observation.visual_role === "ingredients";
  const visibleLiterals = observation.visible_size_texts
    .filter((literal) => !isNutrientLiteral(literal))
    .map((literal) => ({ literal, sizes: parseGallerySizeTexts(literal) }));
  const visible = dedupeSizes(visibleLiterals.flatMap((row) => row.sizes));
  const netVisible = dedupeSizes(visibleLiterals.flatMap((row) => {
    if (panelRequiresExplicitNetLabel
      && !/\bnet\s*(?:wt|weight|contents?)\b/i.test(row.literal)) return [];
    return row.sizes.filter((size) => size.unit !== "count");
  }));
  const inner = dedupeSizes(observation.inner_contents_claims.flatMap((literal) => {
    const count = bareCount(literal);
    return [...parseGallerySizeTexts(literal), ...(count ? [count] : [])];
  }));
  return {
    net_content: netVisible,
    inner_item_count: dedupeSizes([...visible, ...inner]).filter((size) => size.unit === "count"),
  };
}

function packageSizesFromOcr(ocrTexts: readonly string[]): Record<PackageFactKind, ExpectedSize[]> {
  const values = dedupeSizes(ocrTexts.flatMap((value) => parseGallerySizeTexts(value)))
    .filter((size) => size.unit !== "g" || size.value >= 50);
  return {
    net_content: values.filter((size) => size.unit !== "count"),
    inner_item_count: values.filter((size) => size.unit === "count"),
  };
}

type SourceStatus = "ABSENT" | "MATCH" | "MISMATCH" | "CONFLICT";

function sourceStatus(expected: ExpectedPackageFact, values: readonly ExpectedSize[]): SourceStatus {
  const dimension = normalizedSize(expected).dimension;
  const comparable = values.filter((value) => normalizedSize(value).dimension === dimension);
  if (comparable.length === 0) return "ABSENT";
  const matching = comparable.filter((value) => sizeEquals(expected, value));
  if (matching.length === comparable.length) return "MATCH";
  if (matching.length > 0) return "CONFLICT";
  if (comparable.some((value) => !sizeEquivalent(comparable[0], value))) return "CONFLICT";
  return "MISMATCH";
}

function formatSizes(values: readonly ExpectedSize[]): string {
  return values.map((value) => `${value.value} ${value.unit}`).join(", ");
}

function assessPackageFacts(
  facts: readonly ExpectedPackageFact[],
  observation: BlindObservation,
  ocrTexts: readonly string[],
): PackageAssessment {
  const checks = { ...EMPTY_PACKAGE_CHECKS };
  const hard: string[] = [];
  const review: string[] = [];
  const blindSizes = packageSizesFromBlind(observation);
  const ocrSizes = packageSizesFromOcr(ocrTexts);

  for (const fact of facts) {
    const blind = sourceStatus(fact, blindSizes[fact.kind]);
    const ocr = sourceStatus(fact, ocrSizes[fact.kind]);
    if (blind === "CONFLICT") {
      checks[fact.kind] = "UNKNOWN";
      review.push(`conflicting blind ${fact.kind} values`);
    } else if (blind === "MISMATCH") {
      if (ocr === "MATCH" || ocr === "CONFLICT") {
        checks[fact.kind] = "UNKNOWN";
        review.push(`blind vision and OCR conflict for ${fact.kind}`);
      } else {
        checks[fact.kind] = "MISMATCH";
        hard.push(`blind package fact contradicts ${fact.kind}: ${formatSizes(blindSizes[fact.kind])} != ${fact.value} ${fact.unit}`);
      }
    } else if (blind === "MATCH") {
      if (ocr === "MISMATCH" || ocr === "CONFLICT") {
        checks[fact.kind] = "UNKNOWN";
        review.push(`blind vision and OCR conflict for ${fact.kind}`);
      } else {
        checks[fact.kind] = "MATCH";
      }
    } else if (ocr === "MATCH") {
      checks[fact.kind] = "MATCH";
    } else if (ocr === "MISMATCH" || ocr === "CONFLICT") {
      checks[fact.kind] = "UNKNOWN";
      review.push(`OCR-only mismatch or conflict for ${fact.kind}`);
    } else {
      checks[fact.kind] = "NOT_VISIBLE";
    }
  }
  return { checks, hard, review };
}

function emptyDecision(
  slot: GallerySlot,
  verdict: GalleryAuditVerdict,
  extras: Partial<Pick<GalleryAuditDecision,
    "review_reasons" | "missing_reason" | "technical_error">> = {},
): GalleryAuditDecision {
  return {
    schema_version: WALMART_GALLERY_AUDIT_VERSION,
    slot,
    verdict,
    matched_component_id: null,
    checks: { identity: "UNKNOWN", package_facts: { ...EMPTY_PACKAGE_CHECKS } },
    hard_failures: [],
    review_reasons: extras.review_reasons ?? [],
    missing_reason: extras.missing_reason ?? null,
    technical_error: extras.technical_error ?? null,
  };
}

/** Audit one gallery slot without applying any main-image presentation rule. */
export function auditGallerySlot(input: GalleryAuditInput): GalleryAuditDecision {
  assertGallerySlot(input.slot);
  if (input.source.state === "missing") {
    if (!input.source.reason.trim()) throw new Error("missing reason must be non-empty");
    return emptyDecision(input.slot, "MISSING", { missing_reason: input.source.reason.trim() });
  }
  if (input.source.state === "technical_error") {
    if (!input.source.error.trim()) throw new Error("technical error must be non-empty");
    return emptyDecision(input.slot, "TECH_ERROR", { technical_error: input.source.error.trim() });
  }

  const composition = input.composition ?? { kind: "same_product" };
  if (composition.kind === "mixed_component_bundle"
    && (!composition.component_identities || composition.component_identities.length === 0)) {
    return emptyDecision(input.slot, "UNSUPPORTED", {
      review_reasons: ["mixed-component bundle has no explicit component identities"],
    });
  }

  const observedSource = input.source;
  const ocrTexts = trustedOcrTexts(observedSource.auxiliary_ocr);
  const identities: Array<{ component_id: string | null; identity: AuditIdentityTruth }> =
    composition.kind === "same_product"
      ? [{ component_id: null, identity: input.expected.identity }]
      : composition.component_identities!.map((component) => ({
          component_id: component.component_id,
          identity: component.identity,
        }));
  if (identities.some((entry) => entry.component_id !== null && !entry.component_id.trim())) {
    throw new Error("component_id must be non-empty");
  }
  if (new Set(identities.map((entry) => entry.component_id).filter(Boolean)).size !== identities.length
    && composition.kind === "mixed_component_bundle") {
    throw new Error("component_id values must be unique");
  }

  const identityResults = identities.map((entry) => ({
    ...entry,
    result: assessIdentity(entry.identity, observedSource.observation, ocrTexts),
  }));
  const matched = identityResults.find((entry) => entry.result.status === "MATCH");
  let identity: IdentityAssessment;
  if (matched) {
    identity = matched.result;
  } else if (identityResults.every((entry) => entry.result.status === "MISMATCH")) {
    identity = {
      status: "MISMATCH",
      hard: composition.kind === "same_product"
        ? identityResults[0].result.hard
        : ["visible identity matches no explicit bundle component"],
      review: [],
    };
  } else {
    identity = {
      status: "UNKNOWN",
      hard: [],
      review: [...new Set(identityResults.flatMap((entry) => entry.result.review))],
    };
  }

  const packages = composition.kind === "same_product"
    ? assessPackageFacts(input.expected.package_facts, observedSource.observation, ocrTexts)
    : { checks: { ...EMPTY_PACKAGE_CHECKS }, hard: [], review: [] };
  const hard = [...identity.hard, ...packages.hard];
  const review = [...identity.review, ...packages.review];
  if (observedSource.observation.multiple_distinct_products === "yes") {
    if (composition.kind === "same_product") {
      hard.push("multiple distinct products are visible in a same-product gallery");
    } else {
      review.push("multiple distinct products are visible but not enumerated by the blind observation");
    }
  }

  const verdict: GalleryAuditVerdict = hard.length > 0
    ? "BAD"
    : identity.status !== "MATCH" || review.length > 0
      ? "REVIEW"
      : "PASS";
  return {
    schema_version: WALMART_GALLERY_AUDIT_VERSION,
    slot: input.slot,
    verdict,
    matched_component_id: matched?.component_id ?? null,
    checks: { identity: identity.status, package_facts: packages.checks },
    hard_failures: hard,
    review_reasons: [...new Set(review)],
    missing_reason: null,
    technical_error: null,
  };
}

export type GalleryImageAsset =
  | { slot: GallerySlot; state: "available"; bytes: Uint8Array }
  | { slot: GallerySlot; state: "missing"; reason: string }
  | { slot: GallerySlot; state: "technical_error"; error: string };

export interface GalleryImageFingerprint {
  slot: GallerySlot;
  sha256: string;
  dhash64: string;
  width: number;
  height: number;
}

export interface GalleryExactDuplicateGroup {
  sha256: string;
  slots: GallerySlot[];
}

export interface GalleryNearDuplicatePair {
  left_slot: GallerySlot;
  right_slot: GallerySlot;
  hamming_distance: number;
}

export interface GalleryDuplicateReport {
  schema_version: typeof WALMART_GALLERY_DUPLICATE_REPORT_SCHEMA;
  dhash_distance_threshold: number;
  fingerprints: GalleryImageFingerprint[];
  exact_duplicates: GalleryExactDuplicateGroup[];
  near_duplicates: GalleryNearDuplicatePair[];
  missing: Array<{ slot: GallerySlot; reason: string }>;
  technical_errors: Array<{
    slot: GallerySlot;
    stage: "input" | "decode";
    error: string;
    sha256: string | null;
  }>;
}

function slotNumber(slot: GallerySlot): number {
  return Number(slot.slice("gallery-".length));
}

function compareSlots(left: GallerySlot, right: GallerySlot): number {
  return slotNumber(left) - slotNumber(right);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Compute a raw-byte SHA-256 and an orientation-normalized 64-bit dHash. */
export async function fingerprintGalleryImage(
  slot: GallerySlot,
  bytes: Uint8Array,
): Promise<GalleryImageFingerprint> {
  assertGallerySlot(slot);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("gallery image bytes must be non-empty");
  }
  const input = Buffer.from(bytes);
  const sharpOptions = {
    limitInputPixels: WALMART_GALLERY_MAX_INPUT_PIXELS,
    sequentialRead: true,
  } as const;
  const metadata = await sharp(input, sharpOptions).metadata();
  if (!metadata.width || !metadata.height) throw new Error("image dimensions are unavailable");
  const resized = await sharp(input, sharpOptions)
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer();
  if (resized.length !== 72) throw new Error(`unexpected dHash raster length ${resized.length}`);
  const bits = new Uint8Array(8);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (resized[row * 9 + column] > resized[row * 9 + column + 1]) {
        bits[row] |= 1 << (7 - column);
      }
    }
  }
  return {
    slot,
    sha256: sha256(bytes),
    dhash64: bytesToHex(bits),
    width: metadata.width,
    height: metadata.height,
  };
}

export function galleryDhashDistance(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) {
    throw new Error("dHash values must be exactly 16 hexadecimal characters");
  }
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  const zero = BigInt(0);
  const one = BigInt(1);
  while (difference > zero) {
    count += Number(difference & one);
    difference >>= one;
  }
  return count;
}

/**
 * Produce a stable duplicate report. Exact byte duplicates and perceptual
 * near-duplicates are separate; missing and decode failures never become
 * visual verdicts.
 */
export async function detectGalleryDuplicates(
  assets: readonly GalleryImageAsset[],
  dhashDistanceThreshold = DEFAULT_GALLERY_DHASH_DISTANCE,
): Promise<GalleryDuplicateReport> {
  if (!Number.isInteger(dhashDistanceThreshold)
    || dhashDistanceThreshold < 0 || dhashDistanceThreshold > 64) {
    throw new Error("dHash distance threshold must be an integer in 0..64");
  }
  const sorted = [...assets].sort((left, right) => compareSlots(left.slot, right.slot));
  for (const asset of sorted) assertGallerySlot(asset.slot);
  if (new Set(sorted.map((asset) => asset.slot)).size !== sorted.length) {
    throw new Error("gallery assets must have unique slots");
  }

  const fingerprints: GalleryImageFingerprint[] = [];
  const availableHashes: Array<{ slot: GallerySlot; sha256: string }> = [];
  const missing: GalleryDuplicateReport["missing"] = [];
  const technicalErrors: GalleryDuplicateReport["technical_errors"] = [];
  for (const asset of sorted) {
    if (asset.state === "missing") {
      missing.push({ slot: asset.slot, reason: asset.reason });
      continue;
    }
    if (asset.state === "technical_error") {
      technicalErrors.push({
        slot: asset.slot,
        stage: "input",
        error: asset.error,
        sha256: null,
      });
      continue;
    }
    const digest = sha256(asset.bytes);
    availableHashes.push({ slot: asset.slot, sha256: digest });
    try {
      fingerprints.push(await fingerprintGalleryImage(asset.slot, asset.bytes));
    } catch (error) {
      technicalErrors.push({
        slot: asset.slot,
        stage: "decode",
        error: error instanceof Error ? error.message : String(error),
        sha256: digest,
      });
    }
  }

  const bySha = new Map<string, GallerySlot[]>();
  for (const row of availableHashes) {
    const slots = bySha.get(row.sha256) ?? [];
    slots.push(row.slot);
    bySha.set(row.sha256, slots);
  }
  const exactDuplicates = [...bySha.entries()]
    .filter(([, slots]) => slots.length > 1)
    .map(([digest, slots]) => ({ sha256: digest, slots: slots.sort(compareSlots) }))
    .sort((left, right) => compareSlots(left.slots[0], right.slots[0]));

  const nearDuplicates: GalleryNearDuplicatePair[] = [];
  for (let left = 0; left < fingerprints.length; left += 1) {
    for (let right = left + 1; right < fingerprints.length; right += 1) {
      if (fingerprints[left].sha256 === fingerprints[right].sha256) continue;
      const distance = galleryDhashDistance(fingerprints[left].dhash64, fingerprints[right].dhash64);
      if (distance <= dhashDistanceThreshold) {
        nearDuplicates.push({
          left_slot: fingerprints[left].slot,
          right_slot: fingerprints[right].slot,
          hamming_distance: distance,
        });
      }
    }
  }

  return {
    schema_version: WALMART_GALLERY_DUPLICATE_REPORT_SCHEMA,
    dhash_distance_threshold: dhashDistanceThreshold,
    fingerprints,
    exact_duplicates: exactDuplicates,
    near_duplicates: nearDuplicates,
    missing,
    technical_errors: technicalErrors,
  };
}
