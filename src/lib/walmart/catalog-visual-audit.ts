/**
 * Pure, fail-closed primitives for the Walmart catalog visual audit.
 *
 * Vision is allowed to transcribe only what is visible. It never receives the
 * SKU, title, donor, expected quantity, or expected product. This module then
 * compares that blind observation to immutable manifest truth without another
 * model call. No database or marketplace client belongs in this file.
 */

export const WALMART_VISUAL_AUDIT_SCHEMA = "walmart-visual-audit/v3" as const;
export const WALMART_VISUAL_COMPARATOR_VERSION = "walmart-visual-comparator/v5" as const;
export const WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE = 0.95 as const;
export const BLIND_OBSERVATION_SCHEMA = "wm_visual_observation_batch/v3" as const;
export const BLIND_PROMPT_VERSION = "walmart-visual-blind/v4" as const;

export type AuditVerdict = "PASS" | "BAD" | "REVIEW";
export type ImageSlot = "main" | `gallery-${number}`;
export type SizeUnit = "oz" | "fl_oz" | "count" | "lb" | "g" | "kg" | "ml" | "l";

export interface ExpectedSize {
  value: number;
  unit: SizeUnit;
}

export type IdentityRole = "brand" | "product" | "variant";
export type PackageFactKind = "net_content" | "inner_item_count";
export type PackageFactRequirement = "required" | "if_visible";

export interface ForbiddenIdentityMarker {
  role: IdentityRole;
  aliases: string[];
}

export interface AuditIdentityTruth {
  /** Full wordmarks/brand names only. Logo glyphs belong in observed evidence, not aliases. */
  brand_aliases: string[];
  /** Explicitly empty only when product identity is fully represented by the brand. */
  product_marker_groups: string[][];
  /** Variant groups may be empty only when the catalog truth has no distinct variant. */
  variant_marker_groups: string[][];
  /** Explicit disqualifiers are matched only against their declared observation field. */
  forbidden_markers: ForbiddenIdentityMarker[];
}

export interface ExpectedPackageFact extends ExpectedSize {
  kind: PackageFactKind;
  requirement: PackageFactRequirement;
}

export interface AuditExpectedTruth {
  /** Current buyer-facing title, or an explicitly identified historical title. */
  title: string;
  /** Number of OUTER sellable packages represented by the listing. */
  outer_units: number;
  identity: AuditIdentityTruth;
  /** Independent per-outer-package truths; net content and inner count are never conflated. */
  package_facts: ExpectedPackageFact[];
  truth_source: "recipe" | "live_title" | "historical_title" | "manual_verified";
}

export interface AuditImageInput {
  slot: ImageSlot;
  url: string;
  /** True only when the URL was independently confirmed as buyer-facing. */
  buyer_facing_verified: boolean;
  surface: "buyer_pdp" | "last_applied_artifact" | "sent_gallery" | "unknown";
}

export interface AuditGroundTruth {
  verdict: "PASS" | "BAD";
  defect_types: string[];
  basis: string;
}

export interface AuditCase {
  case_id: string;
  sku: string;
  expected: AuditExpectedTruth;
  images: AuditImageInput[];
  ground_truth?: AuditGroundTruth;
}

export interface AuditLayout {
  name: string;
  batch_size: number;
  shuffle_seed: number | null;
}

export interface AuditManifest {
  schema_version: typeof WALMART_VISUAL_AUDIT_SCHEMA;
  manifest_id: string;
  purpose: "golden-pilot" | "shadow-pilot" | "catalog-audit";
  cases: AuditCase[];
  layouts: AuditLayout[];
}

export type BlindVisualRole =
  | "tiled_main"
  | "single_product_front"
  | "back"
  | "nutrition"
  | "ingredients"
  | "lifestyle"
  | "infographic"
  | "mixed_products"
  | "other";

export interface ExternalPackageCount {
  mode: "exact" | "range" | "unknown";
  value: number | null;
  min: number | null;
  max: number | null;
}

export interface BlindObservation {
  image_id: string;
  visual_role: BlindVisualRole;
  visible_brand_text: string | null;
  visible_product_text: string | null;
  visible_variant_text: string | null;
  /** All literal per-package size texts, parsed by deterministic code later. */
  visible_size_texts: string[];
  external_package_count: ExternalPackageCount;
  outer_package_claims: string[];
  inner_contents_claims: string[];
  case_package_claims: string[];
  unclear_quantity_claims: string[];
  grid_cell_kind:
    | "single_sellable_package"
    | "multi_package_case"
    | "multiple_loose_products"
    | "not_a_grid"
    | "unknown";
  front_visibility: "all" | "some" | "none" | "not_applicable" | "unknown";
  background: "white" | "near_white" | "colored" | "lifestyle" | "mixed" | "unknown";
  multiple_distinct_products: "yes" | "no" | "unknown";
  readable_identity: "clear" | "partial" | "none";
  evidence: string[];
  flags: string[];
}

export interface AuxiliaryOcrText {
  text: string;
  /** Normalized OCR confidence in the inclusive range 0..1. */
  confidence: number;
  /**
   * Optional sealed spatial provenance. Cross-line OCR support is disabled
   * unless all three provenance fields are present and valid.
   */
  view_role?: "full" | "tile_front" | "bottom_label" | "top_left_badge";
  view_sha256?: string;
  bounding_box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AuditAuxiliaryEvidence {
  ocr_texts: AuxiliaryOcrText[];
}

export interface AuditDecision {
  verdict: AuditVerdict;
  checks: {
    identity: "MATCH" | "MISMATCH" | "UNKNOWN";
    package_facts: Record<PackageFactKind, "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE">;
    external_quantity: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    single_package_per_cell: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    front: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    background: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_APPLICABLE";
    no_mixed_product: "MATCH" | "MISMATCH" | "UNKNOWN";
  };
  hard_failures: string[];
  unknowns: string[];
}

const SIZE_UNITS = new Set<SizeUnit>([
  "oz", "fl_oz", "count", "lb", "g", "kg", "ml", "l",
]);
const VISUAL_ROLES = new Set<BlindVisualRole>([
  "tiled_main", "single_product_front", "back", "nutrition", "ingredients",
  "lifestyle", "infographic", "mixed_products", "other",
]);
const GRID_KINDS = new Set<BlindObservation["grid_cell_kind"]>([
  "single_sellable_package", "multi_package_case", "multiple_loose_products",
  "not_a_grid", "unknown",
]);
const FRONT_VALUES = new Set<BlindObservation["front_visibility"]>([
  "all", "some", "none", "not_applicable", "unknown",
]);
const BACKGROUND_VALUES = new Set<BlindObservation["background"]>([
  "white", "near_white", "colored", "lifestyle", "mixed", "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allow = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allow.has(key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function requiredInteger(value: unknown, path: string, min = 0): number {
  if (!Number.isInteger(value) || Number(value) < min) throw new Error(`${path} must be an integer >= ${min}`);
  return Number(value);
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${path} must be string or null`);
  const out = value.trim();
  return out ? out.slice(0, 300) : null;
}

function stringArray(value: unknown, path: string, max = 12): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${path} must be an array with at most ${max} items`);
  return value.map((item, index) => requiredString(item, `${path}[${index}]`).slice(0, 300));
}

function markerGroups(value: unknown, path: string, allowEmpty: boolean): string[][] {
  if (!Array.isArray(value) || value.length > 12 || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must ${allowEmpty ? "be an array" : "not be empty"}`);
  }
  return value.map((group, gi) => {
    if (!Array.isArray(group) || group.length === 0 || group.length > 12) {
      throw new Error(`${path}[${gi}] must contain 1-12 aliases`);
    }
    const aliases = group.map((marker, mi) => requiredString(marker, `${path}[${gi}][${mi}]`));
    if (new Set(aliases.map(normalizeVisibleText)).size !== aliases.length) {
      throw new Error(`${path}[${gi}] contains duplicate normalized aliases`);
    }
    return aliases;
  });
}

function parseSizeParts(amount: unknown, unit: unknown, path: string): ExpectedSize {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${path}.value must be a positive number`);
  }
  if (typeof unit !== "string" || !SIZE_UNITS.has(unit as SizeUnit)) {
    throw new Error(`${path}.unit is unsupported`);
  }
  return { value: amount, unit: unit as SizeUnit };
}

function parseIdentityTruth(value: unknown, path: string): AuditIdentityTruth {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "brand_aliases", "product_marker_groups", "variant_marker_groups", "forbidden_markers",
  ], path);
  const brandAliases = stringArray(value.brand_aliases, `${path}.brand_aliases`, 12);
  if (brandAliases.length === 0) throw new Error(`${path}.brand_aliases must not be empty`);
  if (brandAliases.some((alias) => !hasLexicallySpecificText(alias))) {
    throw new Error(`${path}.brand_aliases must contain full lexical brand names, not logo-only glyphs`);
  }
  if (new Set(brandAliases.map(normalizeVisibleText)).size !== brandAliases.length) {
    throw new Error(`${path}.brand_aliases contains duplicate normalized aliases`);
  }
  const productGroups = markerGroups(value.product_marker_groups, `${path}.product_marker_groups`, true);
  const variantGroups = markerGroups(value.variant_marker_groups, `${path}.variant_marker_groups`, true);
  if (!Array.isArray(value.forbidden_markers) || value.forbidden_markers.length > 24) {
    throw new Error(`${path}.forbidden_markers must be an array with at most 24 items`);
  }
  const forbiddenMarkers = value.forbidden_markers.map((marker, index) => {
    const markerPath = `${path}.forbidden_markers[${index}]`;
    if (!isRecord(marker)) throw new Error(`${markerPath} must be an object`);
    assertExactKeys(marker, ["role", "aliases"], markerPath);
    const roleValue = marker.role;
    if (roleValue !== "brand" && roleValue !== "product" && roleValue !== "variant") {
      throw new Error(`${markerPath}.role is unsupported`);
    }
    const role: IdentityRole = roleValue;
    const aliases = stringArray(marker.aliases, `${markerPath}.aliases`, 12);
    if (aliases.length === 0) throw new Error(`${markerPath}.aliases must not be empty`);
    if (new Set(aliases.map(normalizeVisibleText)).size !== aliases.length) {
      throw new Error(`${markerPath}.aliases contains duplicate normalized aliases`);
    }
    return { role, aliases };
  });
  return {
    brand_aliases: brandAliases,
    product_marker_groups: productGroups,
    variant_marker_groups: variantGroups,
    forbidden_markers: forbiddenMarkers,
  };
}

function parsePackageFacts(value: unknown, path: string): ExpectedPackageFact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error(`${path} must contain 1-2 typed package facts`);
  }
  const kinds = new Set<PackageFactKind>();
  return value.map((fact, index) => {
    const factPath = `${path}[${index}]`;
    if (!isRecord(fact)) throw new Error(`${factPath} must be an object`);
    assertExactKeys(fact, ["kind", "value", "unit", "requirement"], factPath);
    if (fact.kind !== "net_content" && fact.kind !== "inner_item_count") {
      throw new Error(`${factPath}.kind is unsupported`);
    }
    if (kinds.has(fact.kind)) throw new Error(`${path} contains duplicate kind ${fact.kind}`);
    kinds.add(fact.kind);
    if (fact.requirement !== "required" && fact.requirement !== "if_visible") {
      throw new Error(`${factPath}.requirement is unsupported`);
    }
    const size = parseSizeParts(fact.value, fact.unit, factPath);
    if (fact.kind === "net_content" && size.unit === "count") {
      throw new Error(`${factPath} net_content cannot use count`);
    }
    if (fact.kind === "inner_item_count" && (size.unit !== "count" || !Number.isInteger(size.value))) {
      throw new Error(`${factPath} inner_item_count must be a positive integer count`);
    }
    return {
      kind: fact.kind,
      value: size.value,
      unit: size.unit,
      requirement: fact.requirement,
    };
  });
}

function validateHttpsUrl(value: unknown, path: string): string {
  const text = requiredString(value, path);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error(`${path} must be a valid URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${path} must use https`);
  return text;
}

export function validateAuditManifest(raw: unknown): AuditManifest {
  if (!isRecord(raw)) throw new Error("manifest must be an object");
  assertExactKeys(raw, ["schema_version", "manifest_id", "purpose", "cases", "layouts"], "manifest");
  if (raw.schema_version !== WALMART_VISUAL_AUDIT_SCHEMA) {
    throw new Error(`manifest.schema_version must be ${WALMART_VISUAL_AUDIT_SCHEMA}`);
  }
  const purpose = raw.purpose;
  if (purpose !== "golden-pilot" && purpose !== "shadow-pilot" && purpose !== "catalog-audit") {
    throw new Error("manifest.purpose is unsupported");
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error("manifest.cases must not be empty");
  if (!Array.isArray(raw.layouts) || raw.layouts.length === 0) throw new Error("manifest.layouts must not be empty");

  const caseIds = new Set<string>();
  const cases: AuditCase[] = raw.cases.map((value, index) => {
    const path = `manifest.cases[${index}]`;
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    assertExactKeys(value, ["case_id", "sku", "expected", "images", "ground_truth"], path);
    const caseId = requiredString(value.case_id, `${path}.case_id`);
    if (caseIds.has(caseId)) throw new Error(`duplicate case_id ${caseId}`);
    caseIds.add(caseId);
    if (!isRecord(value.expected)) throw new Error(`${path}.expected must be an object`);
    const expected = value.expected;
    assertExactKeys(expected, [
      "title", "outer_units", "identity", "package_facts", "truth_source",
    ], `${path}.expected`);
    const identity = parseIdentityTruth(expected.identity, `${path}.expected.identity`);
    const packageFacts = parsePackageFacts(expected.package_facts, `${path}.expected.package_facts`);
    const truthSource = expected.truth_source;
    if (truthSource !== "recipe" && truthSource !== "live_title" && truthSource !== "historical_title" && truthSource !== "manual_verified") {
      throw new Error(`${path}.expected.truth_source is unsupported`);
    }
    if (!Array.isArray(value.images) || value.images.length === 0) throw new Error(`${path}.images must not be empty`);
    const slots = new Set<string>();
    const images: AuditImageInput[] = value.images.map((image, ii) => {
      const ip = `${path}.images[${ii}]`;
      if (!isRecord(image)) throw new Error(`${ip} must be an object`);
      assertExactKeys(image, ["slot", "url", "buyer_facing_verified", "surface"], ip);
      const slot = requiredString(image.slot, `${ip}.slot`);
      if (slot !== "main" && !/^gallery-[1-9]\d*$/.test(slot)) throw new Error(`${ip}.slot is unsupported`);
      if (slots.has(slot)) throw new Error(`${path} has duplicate image slot ${slot}`);
      slots.add(slot);
      if (typeof image.buyer_facing_verified !== "boolean") throw new Error(`${ip}.buyer_facing_verified must be boolean`);
      const surface = image.surface;
      if (surface !== "buyer_pdp" && surface !== "last_applied_artifact" && surface !== "sent_gallery" && surface !== "unknown") {
        throw new Error(`${ip}.surface is unsupported`);
      }
      return {
        slot: slot as ImageSlot,
        url: validateHttpsUrl(image.url, `${ip}.url`),
        buyer_facing_verified: image.buyer_facing_verified,
        surface,
      };
    });
    let groundTruth: AuditGroundTruth | undefined;
    if (value.ground_truth !== undefined) {
      if (!isRecord(value.ground_truth)) throw new Error(`${path}.ground_truth must be an object`);
      assertExactKeys(value.ground_truth, ["verdict", "defect_types", "basis"], `${path}.ground_truth`);
      const verdict = value.ground_truth.verdict;
      if (verdict !== "PASS" && verdict !== "BAD") throw new Error(`${path}.ground_truth.verdict is unsupported`);
      groundTruth = {
        verdict,
        defect_types: stringArray(value.ground_truth.defect_types, `${path}.ground_truth.defect_types`),
        basis: requiredString(value.ground_truth.basis, `${path}.ground_truth.basis`),
      };
    }
    return {
      case_id: caseId,
      sku: requiredString(value.sku, `${path}.sku`),
      expected: {
        title: requiredString(expected.title, `${path}.expected.title`),
        outer_units: requiredInteger(expected.outer_units, `${path}.expected.outer_units`, 1),
        identity,
        package_facts: packageFacts,
        truth_source: truthSource,
      },
      images,
      ...(groundTruth ? { ground_truth: groundTruth } : {}),
    };
  });

  const layoutNames = new Set<string>();
  const layouts: AuditLayout[] = raw.layouts.map((value, index) => {
    const path = `manifest.layouts[${index}]`;
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    assertExactKeys(value, ["name", "batch_size", "shuffle_seed"], path);
    const name = requiredString(value.name, `${path}.name`);
    if (layoutNames.has(name)) throw new Error(`duplicate layout name ${name}`);
    layoutNames.add(name);
    const shuffleSeed = value.shuffle_seed;
    if (shuffleSeed !== null && !Number.isInteger(shuffleSeed)) throw new Error(`${path}.shuffle_seed must be integer or null`);
    return {
      name,
      batch_size: requiredInteger(value.batch_size, `${path}.batch_size`, 1),
      shuffle_seed: shuffleSeed === null ? null : Number(shuffleSeed),
    };
  });

  return {
    schema_version: WALMART_VISUAL_AUDIT_SCHEMA,
    manifest_id: requiredString(raw.manifest_id, "manifest.manifest_id"),
    purpose,
    cases,
    layouts,
  };
}

function parseExternalCount(value: unknown, path: string): ExternalPackageCount {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, ["mode", "value", "min", "max"], path);
  const mode = value.mode;
  if (mode !== "exact" && mode !== "range" && mode !== "unknown") throw new Error(`${path}.mode is unsupported`);
  const nullableInt = (v: unknown, key: string): number | null => v === null ? null : requiredInteger(v, `${path}.${key}`, 1);
  const count = nullableInt(value.value, "value");
  const min = nullableInt(value.min, "min");
  const max = nullableInt(value.max, "max");
  if (mode === "exact" && (count === null || min !== null || max !== null)) throw new Error(`${path} exact invariant failed`);
  if (mode === "range" && (count !== null || min === null || max === null || min > max)) throw new Error(`${path} range invariant failed`);
  if (mode === "unknown" && (count !== null || min !== null || max !== null)) throw new Error(`${path} unknown invariant failed`);
  return { mode, value: count, min, max };
}

export function parseBlindResponse(raw: unknown, expectedImageIds: readonly string[]): BlindObservation[] {
  if (!isRecord(raw)) throw new Error("vision response must be an object");
  assertExactKeys(raw, ["schema_version", "observations"], "vision response");
  if (raw.schema_version !== BLIND_OBSERVATION_SCHEMA) throw new Error(`vision schema_version must be ${BLIND_OBSERVATION_SCHEMA}`);
  if (!Array.isArray(raw.observations) || raw.observations.length !== expectedImageIds.length) {
    throw new Error(`observations length must be exactly ${expectedImageIds.length}`);
  }
  const rows: BlindObservation[] = raw.observations.map((value, index) => {
    const path = `observations[${index}]`;
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    assertExactKeys(value, [
      "image_id", "visual_role", "visible_brand_text", "visible_product_text",
      "visible_variant_text", "visible_size_texts", "external_package_count",
      "outer_package_claims", "inner_contents_claims", "case_package_claims",
      "unclear_quantity_claims", "grid_cell_kind", "front_visibility", "background",
      "multiple_distinct_products", "readable_identity", "evidence", "flags",
    ], path);
    const role = value.visual_role;
    if (typeof role !== "string" || !VISUAL_ROLES.has(role as BlindVisualRole)) throw new Error(`${path}.visual_role is unsupported`);
    const grid = value.grid_cell_kind;
    if (typeof grid !== "string" || !GRID_KINDS.has(grid as BlindObservation["grid_cell_kind"])) throw new Error(`${path}.grid_cell_kind is unsupported`);
    const front = value.front_visibility;
    if (typeof front !== "string" || !FRONT_VALUES.has(front as BlindObservation["front_visibility"])) throw new Error(`${path}.front_visibility is unsupported`);
    const background = value.background;
    if (typeof background !== "string" || !BACKGROUND_VALUES.has(background as BlindObservation["background"])) throw new Error(`${path}.background is unsupported`);
    const multi = value.multiple_distinct_products;
    if (multi !== "yes" && multi !== "no" && multi !== "unknown") throw new Error(`${path}.multiple_distinct_products is unsupported`);
    const readable = value.readable_identity;
    if (readable !== "clear" && readable !== "partial" && readable !== "none") throw new Error(`${path}.readable_identity is unsupported`);
    return {
      image_id: requiredString(value.image_id, `${path}.image_id`),
      visual_role: role as BlindVisualRole,
      visible_brand_text: nullableText(value.visible_brand_text, `${path}.visible_brand_text`),
      visible_product_text: nullableText(value.visible_product_text, `${path}.visible_product_text`),
      visible_variant_text: nullableText(value.visible_variant_text, `${path}.visible_variant_text`),
      visible_size_texts: stringArray(value.visible_size_texts, `${path}.visible_size_texts`, 8),
      external_package_count: parseExternalCount(value.external_package_count, `${path}.external_package_count`),
      outer_package_claims: stringArray(value.outer_package_claims, `${path}.outer_package_claims`, 12),
      inner_contents_claims: stringArray(value.inner_contents_claims, `${path}.inner_contents_claims`, 12),
      case_package_claims: stringArray(value.case_package_claims, `${path}.case_package_claims`, 12),
      unclear_quantity_claims: stringArray(value.unclear_quantity_claims, `${path}.unclear_quantity_claims`, 12),
      grid_cell_kind: grid as BlindObservation["grid_cell_kind"],
      front_visibility: front as BlindObservation["front_visibility"],
      background: background as BlindObservation["background"],
      multiple_distinct_products: multi,
      readable_identity: readable,
      evidence: stringArray(value.evidence, `${path}.evidence`, 8),
      flags: stringArray(value.flags, `${path}.flags`, 12),
    };
  });
  const expected = [...expectedImageIds].sort();
  const actual = rows.map((row) => row.image_id).sort();
  if (actual.length !== new Set(actual).size || actual.some((id, index) => id !== expected[index])) {
    throw new Error("observations must return every supplied image_id exactly once, with no extras");
  }
  const byId = new Map(rows.map((row) => [row.image_id, row]));
  return expectedImageIds.map((id) => byId.get(id)!);
}

export function normalizeVisibleText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The only model prompt used by the pilot. It contains no listing truth. */
export function buildBlindObservationPrompt(imageIds: readonly string[]): string {
  if (imageIds.length === 0) throw new Error("at least one image_id is required");
  if (imageIds.length !== new Set(imageIds).size) throw new Error("image_ids must be unique");
  const mapping = imageIds.map((id, index) => `attached image ${index + 1} -> ${id}`).join("\n");
  return [
    `Prompt version: ${BLIND_PROMPT_VERSION}.`,
    "You are a literal visual transcriber for marketplace product images.",
    "You are NOT deciding whether an image matches a listing. No listing title, SKU, donor, or expected count is provided. Read only the attached pixels; do not use filenames or guess missing words from product familiarity.",
    "Image mapping (attachment order is authoritative):",
    mapping,
    "For a tiled image, external_package_count means how many repeated OUTER packages are visibly shown in the whole image.",
    "A sealed retail bag/box that naturally contains loose pieces is ONE sellable package: a 20-teabag box, an 8-bun bag, a cookie bag, or a 6-English-muffin tray is not automatically a case. Put that literal count text in inner_contents_claims.",
    "A shipping/display case, shrink-wrap, caddy, tray, or offer graphic that contains several separately packaged cans/bottles/boxes/bags is multi_package_case. Put a literal claim such as '24 cans' or '12 pack' in case_package_claims when the pixels show a case of separate packages.",
    "visible_size_texts is an array of every literal readable size/count for ONE repeated outer package (examples: ['48 fl oz', '2 qt', '1.89 L'] or ['20 tea bags', '0.91 oz']). Use [] when none is readable. Do not convert sizes into objects.",
    "Evidence must be short text actually visible in the image. Do not copy or invent an expected title.",
    "Hard array limits: visible_size_texts and evidence contain at most 8 strings each; outer_package_claims, inner_contents_claims, case_package_claims, unclear_quantity_claims, and flags contain at most 12 strings each. Keep only the strongest literal evidence when more text is visible.",
    "Allowed enums: visual_role=tiled_main|single_product_front|back|nutrition|ingredients|lifestyle|infographic|mixed_products|other; grid_cell_kind=single_sellable_package|multi_package_case|multiple_loose_products|not_a_grid|unknown; front_visibility=all|some|none|not_applicable|unknown; background=white|near_white|colored|lifestyle|mixed|unknown; multiple_distinct_products=yes|no|unknown; readable_identity=clear|partial|none.",
    `Return exactly this valid JSON shape with one observation for every supplied image_id and no other fields (replace the placeholder values with observations):\n${JSON.stringify({
      schema_version: BLIND_OBSERVATION_SCHEMA,
      observations: imageIds.map((image_id) => ({
        image_id,
        visual_role: "other",
        visible_brand_text: null,
        visible_product_text: null,
        visible_variant_text: null,
        visible_size_texts: [],
        external_package_count: { mode: "unknown", value: null, min: null, max: null },
        outer_package_claims: [],
        inner_contents_claims: [],
        case_package_claims: [],
        unclear_quantity_claims: [],
        grid_cell_kind: "unknown",
        front_visibility: "unknown",
        background: "unknown",
        multiple_distinct_products: "unknown",
        readable_identity: "none",
        evidence: [],
        flags: [],
      })),
    }, null, 2)}`,
    "visible_size_texts and all four quantity-claim fields are arrays of literal strings, never arrays of objects. JSON invariants: exact => integer value and null min/max; range => null value and integer min/max; unknown => value/min/max all null. Use real JSON numbers and nulls, never strings such as 'null'.",
  ].join("\n\n");
}

function normalizedSize(size: ExpectedSize): { dimension: "mass" | "volume" | "count"; value: number } {
  if (size.unit === "count") return { dimension: "count", value: size.value };
  if (size.unit === "oz") return { dimension: "mass", value: size.value * 28.349523125 };
  if (size.unit === "lb") return { dimension: "mass", value: size.value * 453.59237 };
  if (size.unit === "kg") return { dimension: "mass", value: size.value * 1000 };
  if (size.unit === "g") return { dimension: "mass", value: size.value };
  if (size.unit === "fl_oz") return { dimension: "volume", value: size.value * 29.5735295625 };
  if (size.unit === "l") return { dimension: "volume", value: size.value * 1000 };
  return { dimension: "volume", value: size.value };
}

function sizeEquals(expected: ExpectedSize, observed: ExpectedSize): boolean {
  if (expected.unit === observed.unit) return expected.value === observed.value;
  const a = normalizedSize(expected);
  const b = normalizedSize(observed);
  if (a.dimension !== b.dimension) return false;
  if (a.dimension === "count") return false;
  return Math.abs(a.value - b.value) / a.value <= 0.005;
}

function isNutrientClaim(value: string): boolean {
  const text = normalizeVisibleText(value);
  return /\b(protein|fiber|whole grain|whole grains|sugar|sugars|sodium|carb|carbs|carbohydrate|fat|calorie|calories|per serving|per slice|vitamin|calcium|iron)\b/.test(text);
}

function parseBareInnerCount(value: string): ExpectedSize | null {
  const text = value.trim();
  const bare = /^(\d+)$/u.exec(text);
  // This field is already dedicated to inner contents. Accept a leading count
  // only when the same exact literal terminates in a concrete countable retail
  // noun. This covers label text such as "8 Top Sliced Butter Hot Dog Buns"
  // without interpreting serving-size or nutrition prose as package truth.
  const labeled = /^(\d+)(?:\s+[\p{L}][\p{L}'’-]*){0,8}\s+(?:tea\s+bags?|buns?|muffins?|cookies?|bars?|pieces?|shells?|cans?|bottles?)\.?$/iu.exec(text);
  const count = Number((bare ?? labeled)?.[1]);
  return Number.isInteger(count) && count > 0 ? { value: count, unit: "count" } : null;
}

/** Parse only the dedicated literal size field; never scrape arbitrary evidence. */
export function parseVisibleSizeTexts(value: string | null): ExpectedSize[] {
  if (!value) return [];
  const text = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/,/g, " ")
    // Literal OCR frequently confuses the letter O with zero in OZ. These
    // rewrites are syntax-only and happen before any comparison with truth.
    .replace(/\bfl\.?\s*0z\b/g, "fl oz")
    .replace(/\bfl\.\s*oz\b/g, "fl oz")
    .replace(/\b(\d+)\.0z\b/g, "$1 oz ")
    // A single digit followed by "0z" is ambiguous (for example 10z could
    // be either a corrupted 1 OZ or unrelated text). Only repair the common
    // compact multi-digit form such as 240Z11 -> 24 OZ 11.
    .replace(/\b(\d{2,})0z(?=\d|\b)/g, "$1 oz ")
    .replace(/\s+/g, " ")
    .replace(/\b(\d+(?:\.\d+)?)\s*lbs?\s*(\d+(?:\.\d+)?)\s*(?:ounces?|oz)\b/gi, (_all, pounds, ounces) => {
      return `${Number(pounds) * 16 + Number(ounces)} oz`;
    });
  const pattern = /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(fl\s*oz|fluid\s*ounces?|ounces?|oz|counts?|ct|tea\s*bags?|buns?|muffins?|cookies?|bars?|pieces?|shells?|cans?|bottles?|lbs?|pounds?|kg|grams?|g|ml|milliliters?|liters?|litres?|l)\b/gi;
  const parsed: ExpectedSize[] = [];
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const rawUnit = match[2].replace(/\s+/g, " ").toLowerCase();
    let unit: SizeUnit;
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

/** Backward-compatible convenience for callers that need only the first literal. */
export function parseVisibleSizeText(value: string | null): ExpectedSize | null {
  return parseVisibleSizeTexts(value)[0] ?? null;
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

function textContainsAliases(value: string | null, aliases: readonly string[]): boolean {
  const haystack = ` ${normalizeVisibleText(value ?? "")} `;
  return aliases.some((alias) => {
    const needle = normalizeVisibleText(alias);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

function missingRoleMarkerGroups(value: string | null, groups: readonly string[][]): string[] {
  return groups.filter((aliases) => !textContainsAliases(value, aliases)).map((aliases) => aliases.join("|"));
}

function hasLexicallySpecificText(value: string | null): boolean {
  return normalizeVisibleText(value ?? "").split(" ").some((token) => token.length >= 2);
}

function presentForbiddenMarkers(expected: AuditIdentityTruth, observed: BlindObservation): ForbiddenIdentityMarker[] {
  const allBlindIdentity = [
    observed.visible_brand_text,
    observed.visible_product_text,
    observed.visible_variant_text,
  ].filter((value): value is string => value !== null).join(" ");
  return expected.forbidden_markers
    // Vision role assignment is not authoritative: a wrong variant word can
    // be transcribed into product_text. A literal forbidden identity marker
    // anywhere in blind structured identity is still hard evidence.
    .filter((marker) => textContainsAliases(allBlindIdentity, marker.aliases));
}

function observedPackageSizes(observed: BlindObservation): Record<PackageFactKind, ExpectedSize[]> {
  const visibleSizes = dedupeSizes(observed.visible_size_texts
    .filter((literal) => !isNutrientClaim(literal))
    .flatMap((literal) => parseVisibleSizeTexts(literal)));
  const innerClaimSizes = dedupeSizes(observed.inner_contents_claims.flatMap((literal) => {
    const parsed = parseVisibleSizeTexts(literal);
    const bare = parseBareInnerCount(literal);
    return bare ? [...parsed, bare] : parsed;
  }));
  return {
    net_content: visibleSizes.filter((size) => size.unit !== "count"),
    inner_item_count: dedupeSizes([...visibleSizes, ...innerClaimSizes]).filter((size) => size.unit === "count"),
  };
}

interface TrustedOcrText extends AuxiliaryOcrText {
  text: string;
  confidence: number;
}

function finiteUnitCoordinate(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${path} must be a finite number from 0 to 1`);
  }
  return value;
}

function trustedAuxiliaryOcrTexts(auxiliary: AuditAuxiliaryEvidence | undefined): TrustedOcrText[] {
  if (!auxiliary) return [];
  if (!isRecord(auxiliary) || !Array.isArray(auxiliary.ocr_texts) || auxiliary.ocr_texts.length > 100) {
    throw new Error("auxiliary.ocr_texts must be an array with at most 100 items");
  }
  assertExactKeys(auxiliary, ["ocr_texts"], "auxiliary");
  const trustedTexts = auxiliary.ocr_texts.flatMap((item, index) => {
    const path = `auxiliary.ocr_texts[${index}]`;
    if (!isRecord(item)) throw new Error(`${path} must be an object`);
    assertExactKeys(item, ["text", "confidence", "view_role", "view_sha256", "bounding_box"], path);
    const text = requiredString(item.text, `${path}.text`);
    if (typeof item.confidence !== "number"
      || !Number.isFinite(item.confidence)
      || item.confidence < 0
      || item.confidence > 1) {
      throw new Error(`${path}.confidence must be a number from 0 to 1`);
    }
    const provenanceFields = [item.view_role, item.view_sha256, item.bounding_box]
      .filter((value) => value !== undefined).length;
    if (provenanceFields !== 0 && provenanceFields !== 3) {
      throw new Error(`${path} spatial provenance must be supplied completely or omitted`);
    }
    let spatial: Pick<TrustedOcrText, "view_role" | "view_sha256" | "bounding_box"> = {};
    if (provenanceFields === 3) {
      if (item.view_role !== "full"
        && item.view_role !== "tile_front"
        && item.view_role !== "bottom_label"
        && item.view_role !== "top_left_badge") {
        throw new Error(`${path}.view_role is unsupported`);
      }
      if (typeof item.view_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.view_sha256)) {
        throw new Error(`${path}.view_sha256 must be a lowercase SHA-256 hex digest`);
      }
      if (!isRecord(item.bounding_box)) throw new Error(`${path}.bounding_box must be an object`);
      assertExactKeys(item.bounding_box, ["x", "y", "width", "height"], `${path}.bounding_box`);
      const box = {
        x: finiteUnitCoordinate(item.bounding_box.x, `${path}.bounding_box.x`),
        y: finiteUnitCoordinate(item.bounding_box.y, `${path}.bounding_box.y`),
        width: finiteUnitCoordinate(item.bounding_box.width, `${path}.bounding_box.width`),
        height: finiteUnitCoordinate(item.bounding_box.height, `${path}.bounding_box.height`),
      };
      if (box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1) {
        throw new Error(`${path}.bounding_box must have positive dimensions within image bounds`);
      }
      spatial = {
        view_role: item.view_role,
        view_sha256: item.view_sha256,
        bounding_box: box,
      };
    }
    return item.confidence >= WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE
      ? [{ text, confidence: item.confidence, ...spatial }]
      : [];
  });
  return trustedTexts;
}

function spatiallyAdjacent(left: TrustedOcrText, right: TrustedOcrText): boolean {
  if (!left.bounding_box || !right.bounding_box
    || left.view_sha256 !== right.view_sha256
    || left.view_role !== right.view_role) return false;
  const a = left.bounding_box;
  const b = right.bounding_box;
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const narrowWidth = Math.min(a.width, b.width);
  const horizontalAlignment = narrowWidth > 0 && overlapX / narrowWidth >= 0.5;
  const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  const verticalScale = Math.max(a.height, b.height);
  return horizontalAlignment && gapY <= Math.max(0.02, verticalScale * 0.5);
}

/**
 * OCR rows remain independent literals. The only synthetic literals allowed
 * are two geometrically adjacent rows from the exact same sealed view. This
 * supports a stacked badge such as FAMILY / SIZE without combining unrelated
 * words from elsewhere in the image or from another crop.
 */
function auxiliaryOcrPhrases(rows: readonly TrustedOcrText[]): string[] {
  const phrases = rows.map((row) => row.text);
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex];
      const right = rows[rightIndex];
      if (!spatiallyAdjacent(left, right)) continue;
      phrases.push(`${left.text} ${right.text}`, `${right.text} ${left.text}`);
    }
  }
  return [...new Set(phrases.map((text) => text.trim()).filter(Boolean))];
}

interface AuxiliaryOcrPhraseRecord {
  text: string;
  view_sha256: string | null;
}

function auxiliaryOcrPhraseRecords(rows: readonly TrustedOcrText[]): AuxiliaryOcrPhraseRecord[] {
  const phrases: AuxiliaryOcrPhraseRecord[] = rows.map((row) => ({
    text: row.text,
    view_sha256: row.view_sha256 ?? null,
  }));
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex];
      const right = rows[rightIndex];
      if (!spatiallyAdjacent(left, right)) continue;
      phrases.push(
        { text: `${left.text} ${right.text}`, view_sha256: left.view_sha256 ?? null },
        { text: `${right.text} ${left.text}`, view_sha256: left.view_sha256 ?? null },
      );
    }
  }
  const seen = new Set<string>();
  return phrases.filter((phrase) => {
    const key = `${phrase.view_sha256 ?? "unsealed"}|${phrase.text.trim()}`;
    if (!phrase.text.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ocrContainsAliases(rows: readonly TrustedOcrText[], aliases: readonly string[]): boolean {
  return auxiliaryOcrPhrases(rows).some((value) => textContainsAliases(value, aliases));
}

function hasExplicitNetContentContext(literal: string, sizes: readonly ExpectedSize[]): boolean {
  const text = normalizeVisibleText(literal);
  if (/\b(?:net wt|net weight|net contents?|wt)\b/.test(text)) return true;
  const nonCount = sizes.filter((size) => size.unit !== "count");
  return nonCount.some((left, leftIndex) => nonCount.some((right, rightIndex) =>
    leftIndex !== rightIndex && left.unit !== right.unit && sizesEquivalent(left, right)));
}

function auxiliaryPackageSizes(trustedRows: readonly TrustedOcrText[]): Record<PackageFactKind, ExpectedSize[]> {
  const parsedLiterals = auxiliaryOcrPhrases(trustedRows)
    .filter((literal) => !isNutrientClaim(literal))
    .map((literal) => ({ literal, sizes: parseVisibleSizeTexts(literal) }));
  const safeNetSizes = parsedLiterals
    .filter(({ literal, sizes }) => hasExplicitNetContentContext(literal, sizes))
    .flatMap(({ sizes }) => sizes)
    // Apple Vision may split a nutrition line into a bare "6g" token and its
    // label. Bare small gram values are not safe package-size evidence. Real
    // package metric weights are normally printed alongside oz/lb or are at
    // least 50 g; ignoring smaller standalone grams can only create REVIEW,
    // never a false PASS/BAD.
    .filter((size) => size.unit !== "g" || size.value >= 50);
  const countSizes = parsedLiterals.flatMap(({ sizes }) => sizes)
    .filter((size) => size.unit === "count");
  return {
    net_content: dedupeSizes(safeNetSizes.filter((size) => size.unit !== "count")),
    inner_item_count: dedupeSizes(countSizes),
  };
}

function ocrPackageMatchIsCorroborated(
  expected: ExpectedPackageFact,
  trustedRows: readonly TrustedOcrText[],
): boolean {
  const matchingViewShas = new Set<string>();
  for (const phrase of auxiliaryOcrPhraseRecords(trustedRows)) {
    if (isNutrientClaim(phrase.text)) continue;
    const parsed = parseVisibleSizeTexts(phrase.text)
      .filter((size) => size.unit !== "g" || size.value >= 50);
    const candidates = expected.kind === "net_content"
      ? (hasExplicitNetContentContext(phrase.text, parsed)
        ? parsed.filter((size) => size.unit !== "count")
        : [])
      : parsed.filter((size) => size.unit === "count");
    const expectedMatches = candidates.filter((size) => sizeEquals(expected, size));
    if (expectedMatches.length === 0) continue;
    const selfCorroborated = expectedMatches.some((match) => candidates.some((other) =>
      other !== match && other.unit !== match.unit && sizesEquivalent(match, other)));
    if (selfCorroborated) return true;
    if (phrase.view_sha256) matchingViewShas.add(phrase.view_sha256);
  }
  return matchingViewShas.size >= 2;
}

type PackageSourceStatus = "ABSENT" | "MATCH" | "MISMATCH" | "CONFLICT";

function sizesEquivalent(left: ExpectedSize, right: ExpectedSize): boolean {
  return sizeEquals(left, right) || sizeEquals(right, left);
}

function packageSourceStatus(expected: ExpectedPackageFact, values: readonly ExpectedSize[]): PackageSourceStatus {
  if (values.length === 0) return "ABSENT";
  if (values.some((value) => !sizesEquivalent(values[0], value))) return "CONFLICT";
  return values.every((value) => sizeEquals(expected, value)) ? "MATCH" : "MISMATCH";
}

function ocrPackageSourceStatus(expected: ExpectedPackageFact, values: readonly ExpectedSize[]): PackageSourceStatus {
  if (values.length === 0) return "ABSENT";
  // OCR is auxiliary: an expected value mixed with any conflicting comparable
  // package value is CONFLICT/REVIEW, never a selectively chosen MATCH.
  if (values.some((value) => sizeEquals(expected, value))) {
    return values.every((value) => sizeEquals(expected, value)) ? "MATCH" : "CONFLICT";
  }
  if (values.every((value) => sizesEquivalent(values[0], value))) return "MISMATCH";
  return "CONFLICT";
}

function packageSourcesAgree(blind: readonly ExpectedSize[], ocr: readonly ExpectedSize[]): boolean {
  return blind.every((left) => ocr.some((right) => sizesEquivalent(left, right)))
    && ocr.every((right) => blind.some((left) => sizesEquivalent(left, right)));
}

/** Deterministic comparison of a title-blind observation to manifest truth. */
export function decideBlind(
  caseInput: AuditCase,
  image: AuditImageInput,
  observed: BlindObservation,
  auxiliary?: AuditAuxiliaryEvidence,
): AuditDecision {
  const hard: string[] = [];
  const unknown: string[] = [];
  const checks: AuditDecision["checks"] = {
    identity: "UNKNOWN",
    package_facts: {
      net_content: "NOT_APPLICABLE",
      inner_item_count: "NOT_APPLICABLE",
    },
    external_quantity: image.slot === "main" ? "UNKNOWN" : "NOT_APPLICABLE",
    single_package_per_cell: image.slot === "main" ? "UNKNOWN" : "NOT_APPLICABLE",
    front: image.slot === "main" ? "UNKNOWN" : "NOT_APPLICABLE",
    background: image.slot === "main" ? "UNKNOWN" : "NOT_APPLICABLE",
    no_mixed_product: "UNKNOWN",
  };

  const trustedOcrTexts = trustedAuxiliaryOcrTexts(auxiliary);
  const identity = caseInput.expected.identity;
  const forbiddenMarkers = presentForbiddenMarkers(identity, observed);
  const ocrForbiddenMarkers = identity.forbidden_markers
    .filter((marker) => ocrContainsAliases(trustedOcrTexts, marker.aliases));
  const blindBrandMatches = textContainsAliases(observed.visible_brand_text, identity.brand_aliases);
  const rawOcrBrandMatches = ocrContainsAliases(trustedOcrTexts, identity.brand_aliases);
  const explicitWrongBrand = hasLexicallySpecificText(observed.visible_brand_text) && !blindBrandMatches;
  // Product-vs-variant placement is an observer annotation, not product truth.
  // Require every exact marker, but accept it anywhere in the two non-brand
  // identity fields. Forbidden markers already follow this same fail-closed
  // role-drift rule.
  const blindNonBrandIdentity = [
    observed.visible_product_text,
    observed.visible_variant_text,
  ].filter((value): value is string => value !== null).join(" ");
  const blindMissingProductMarkers = missingRoleMarkerGroups(
    blindNonBrandIdentity,
    identity.product_marker_groups,
  );
  const blindMissingVariantMarkers = missingRoleMarkerGroups(
    blindNonBrandIdentity,
    identity.variant_marker_groups,
  );
  const blindAllProductMarkersMatch = blindMissingProductMarkers.length === 0;
  const blindAllVariantMarkersMatch = blindMissingVariantMarkers.length === 0;
  const hasRequiredNonBrandMarkers = identity.product_marker_groups.length
    + identity.variant_marker_groups.length > 0;
  // OCR may recover a logo wordmark only when every required product and
  // variant group is already present in blind structured evidence. OCR may
  // recover product/variant text only when the blind observer already read the
  // expected full brand. Thus OCR can supplement identity, never establish it
  // on its own.
  const ocrBrandMatches = rawOcrBrandMatches
    && hasRequiredNonBrandMarkers
    && blindAllProductMarkersMatch
    && blindAllVariantMarkersMatch;
  const brandMatches = blindBrandMatches || ocrBrandMatches;
  const missingProductMarkers = identity.product_marker_groups
    .filter((aliases) => !textContainsAliases(blindNonBrandIdentity, aliases)
      && !(blindBrandMatches && ocrContainsAliases(trustedOcrTexts, aliases)))
    .map((aliases) => aliases.join("|"));
  const missingVariantMarkers = identity.variant_marker_groups
    .filter((aliases) => !textContainsAliases(blindNonBrandIdentity, aliases)
      && !(blindBrandMatches && ocrContainsAliases(trustedOcrTexts, aliases)))
    .map((aliases) => aliases.join("|"));
  const ocrSuppliedIdentity = (!blindBrandMatches && ocrBrandMatches)
    || blindMissingProductMarkers.length > missingProductMarkers.length
    || blindMissingVariantMarkers.length > missingVariantMarkers.length;
  const wrongBrandOcrConflict = explicitWrongBrand && rawOcrBrandMatches;
  const identityConflict = wrongBrandOcrConflict;
  // An allowed generic marker and a forbidden specific marker can both be
  // literally present (for example "Golden Sandwich Cookies" and "Double
  // Stuf"). OCR support for the generic expected family must never erase the
  // blind observer's positive forbidden-marker evidence.
  if (forbiddenMarkers.length > 0) {
    checks.identity = "MISMATCH";
    hard.push(`forbidden identity markers visible: ${forbiddenMarkers.map((marker) => `${marker.role}:${marker.aliases.join("|")}`).join(", ")}`);
  } else if (explicitWrongBrand && !wrongBrandOcrConflict) {
    checks.identity = "MISMATCH";
    hard.push(`visible brand is not an allowed alias: ${observed.visible_brand_text}`);
  } else if (ocrForbiddenMarkers.length > 0) {
    unknown.push(`OCR-only forbidden identity markers: ${ocrForbiddenMarkers
      .map((marker) => `${marker.role}:${marker.aliases.join("|")}`).join(", ")}`);
  } else if (!identityConflict
    && brandMatches
    && missingProductMarkers.length === 0
    && missingVariantMarkers.length === 0
    && (observed.readable_identity === "clear" || ocrSuppliedIdentity)) {
    checks.identity = "MATCH";
  } else {
    if (identityConflict) unknown.push("blind vision and OCR conflict for identity");
    if (!brandMatches) unknown.push("brand is absent or logo-only");
    if (missingProductMarkers.length > 0) {
      unknown.push(`required product markers missing: ${missingProductMarkers.join(", ")}`);
    }
    if (missingVariantMarkers.length > 0) {
      unknown.push(`required variant markers missing: ${missingVariantMarkers.join(", ")}`);
    }
    if (observed.readable_identity !== "clear") {
      unknown.push(`identity readability is ${observed.readable_identity}`);
    }
  }

  if (observed.multiple_distinct_products === "no") checks.no_mixed_product = "MATCH";
  else if (observed.multiple_distinct_products === "yes") {
    checks.no_mixed_product = "MISMATCH";
    hard.push("multiple distinct products visible");
  } else unknown.push("mixed-product status unclear");

  const packageSizes = observedPackageSizes(observed);
  const ocrPackageSizes = auxiliaryPackageSizes(trustedOcrTexts);
  for (const fact of caseInput.expected.package_facts) {
    // A Nutrition Facts panel describes a serving, not necessarily the whole
    // sellable package. Values such as "Serving Size 1 Bun (50g)" therefore
    // cannot contradict an 8-count / 14-oz package. A main image whose visual
    // role is nutrition still fails independently below as the wrong role.
    if (observed.visual_role === "nutrition") {
      checks.package_facts[fact.kind] = "NOT_APPLICABLE";
      continue;
    }
    const expectedDimension = normalizedSize(fact).dimension;
    const blindSizes = packageSizes[fact.kind].filter(
      (value) => normalizedSize(value).dimension === expectedDimension,
    );
    const ocrSizes = ocrPackageSizes[fact.kind].filter(
      (value) => normalizedSize(value).dimension === expectedDimension,
    );
    const blindStatus = packageSourceStatus(fact, blindSizes);
    const ocrStatus = ocrPackageSourceStatus(fact, ocrSizes);
    if (blindStatus === "CONFLICT") {
      checks.package_facts[fact.kind] = "UNKNOWN";
      unknown.push(`conflicting ${fact.kind} values in blind vision`);
      continue;
    }
    if (blindStatus === "MISMATCH") {
      if (ocrStatus === "MATCH") {
        checks.package_facts[fact.kind] = "UNKNOWN";
        unknown.push(`blind vision and OCR conflict for ${fact.kind}`);
      } else {
        checks.package_facts[fact.kind] = "MISMATCH";
        hard.push(`blind vision contradicts ${fact.kind}: ${blindSizes.map((value) => `${value.value} ${value.unit}`).join(", ")} != ${fact.value} ${fact.unit}`);
      }
      continue;
    }
    if (blindStatus === "MATCH") {
      if (ocrStatus === "MISMATCH" && !packageSourcesAgree(blindSizes, ocrSizes)) {
        checks.package_facts[fact.kind] = "UNKNOWN";
        unknown.push(`blind vision and OCR conflict for ${fact.kind}`);
      } else {
        checks.package_facts[fact.kind] = "MATCH";
      }
      continue;
    }
    if (ocrStatus === "CONFLICT") {
      checks.package_facts[fact.kind] = "UNKNOWN";
      unknown.push(`conflicting OCR values for ${fact.kind}`);
      continue;
    }
    if (ocrStatus === "ABSENT") {
      if (fact.requirement === "required") {
        checks.package_facts[fact.kind] = "UNKNOWN";
        unknown.push(`required package fact ${fact.kind} is not visible`);
      }
      continue;
    }
    if (ocrStatus === "MATCH") {
      if (ocrPackageMatchIsCorroborated(fact, trustedOcrTexts)) {
        checks.package_facts[fact.kind] = "MATCH";
      } else {
        checks.package_facts[fact.kind] = "UNKNOWN";
        unknown.push(`OCR-only match for ${fact.kind} lacks independent spatial or dual-unit corroboration`);
      }
    } else {
      checks.package_facts[fact.kind] = "UNKNOWN";
      unknown.push(`OCR-only mismatch for ${fact.kind}: ${ocrSizes.map((value) => `${value.value} ${value.unit}`).join(", ")}`);
    }
  }

  if (image.slot === "main") {
    const count = observed.external_package_count;
    if (count.mode === "exact") {
      if (count.value === caseInput.expected.outer_units) checks.external_quantity = "MATCH";
      else {
        checks.external_quantity = "MISMATCH";
        hard.push(`outer count ${count.value} != ${caseInput.expected.outer_units}`);
      }
    } else if (count.mode === "range" && count.min !== null && count.max !== null) {
      if (caseInput.expected.outer_units < count.min || caseInput.expected.outer_units > count.max) {
        checks.external_quantity = "MISMATCH";
        hard.push(`outer count range ${count.min}-${count.max} excludes ${caseInput.expected.outer_units}`);
      } else unknown.push("outer package count is only a range");
    } else unknown.push("outer package count unreadable");

    if (observed.grid_cell_kind === "single_sellable_package") checks.single_package_per_cell = "MATCH";
    else if (observed.grid_cell_kind === "multi_package_case" || observed.grid_cell_kind === "multiple_loose_products") {
      checks.single_package_per_cell = "MISMATCH";
      hard.push(`grid cell kind is ${observed.grid_cell_kind}`);
    } else unknown.push("sellable-package structure unclear");

    if (observed.front_visibility === "all") checks.front = "MATCH";
    else if (observed.front_visibility === "some" || observed.front_visibility === "none") {
      checks.front = "MISMATCH";
      hard.push(`front visibility is ${observed.front_visibility}`);
    } else unknown.push("front orientation unclear");

    if (observed.background === "white" || observed.background === "near_white") checks.background = "MATCH";
    else if (observed.background === "unknown") unknown.push("background unclear");
    else {
      checks.background = "MISMATCH";
      hard.push(`background is ${observed.background}`);
    }

    if (observed.visual_role !== "tiled_main" && observed.visual_role !== "single_product_front") {
      hard.push(`main visual role is ${observed.visual_role}`);
    }
  } else if (observed.visual_role === "mixed_products") {
    hard.push("gallery image contains mixed products");
  }

  if (hard.length > 0) return { verdict: "BAD", checks, hard_failures: hard, unknowns: unknown };
  const hasUnknownCheck = checks.identity === "UNKNOWN"
    || Object.values(checks.package_facts).some((value) => value === "UNKNOWN")
    || checks.external_quantity === "UNKNOWN"
    || checks.single_package_per_cell === "UNKNOWN"
    || checks.front === "UNKNOWN"
    || checks.background === "UNKNOWN"
    || checks.no_mixed_product === "UNKNOWN";
  if (unknown.length > 0 || hasUnknownCheck) {
    return { verdict: "REVIEW", checks, hard_failures: [], unknowns: unknown.length ? unknown : ["one or more checks are unknown"] };
  }
  return { verdict: "PASS", checks, hard_failures: [], unknowns: [] };
}

/** Stable PRNG used only to make shuffled pilot layouts reproducible. */
export function shuffledWithSeed<T>(values: readonly T[], seed: number): T[] {
  const out = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
