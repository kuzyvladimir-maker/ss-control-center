/**
 * Read-only, deterministic truth gate for the Walmart visual audit.
 *
 * This module deliberately runs before any image is sent to vision. It does
 * not fetch data, inspect donor pixels, or mutate marketplace/local state. A
 * case is AUDITABLE only when the listing identity, packaging semantics,
 * recipe, structured record, current title, and immutable evidence agree.
 */

import { createHash } from "node:crypto";

import type {
  AuditExpectedTruth,
  AuditIdentityTruth,
  ExpectedPackageFact,
  IdentityRole,
  PackageFactKind,
  PackageFactRequirement,
  SizeUnit,
} from "./catalog-visual-audit";

export const WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA =
  "walmart-visual-truth-preflight-input/v1" as const;
export const WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA =
  "walmart-visual-truth-preflight-result/v1" as const;
export const WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA =
  "walmart-visual-truth-preflight-coverage/v1" as const;

export type TruthPreflightStatus = "AUDITABLE" | "TRUTH_REVIEW" | "UNSUPPORTED";
export type ListingKind = "single" | "multipack" | "bundle" | "variety";
export type RecipeComposition = "same_product" | "mixed_bundle" | "variety_pack";
export type TruthSourceKind =
  | "seller_catalog"
  | "buyer_pdp"
  | "recipe_record"
  | "sku_reference_catalog"
  | "manufacturer_page"
  | "retailer_page"
  | "manual_verification"
  | "donor_image";
export type TruthEvidenceScope =
  | "current_title"
  | "outer_units"
  | "identity"
  | "package_facts"
  | "component_truth";

export type TruthPreflightReasonCode =
  | "OUTER_COUNT_MISSING"
  | "OUTER_COUNT_DISAGREEMENT"
  | "TITLE_OUTER_COUNT_AMBIGUOUS"
  | "LISTING_KIND_OUTER_COUNT_CONTRADICTION"
  | "STRUCTURED_COMPONENT_DISAGREEMENT"
  | "IDENTITY_TRUTH_MISSING"
  | "IDENTITY_TRUTH_INCOMPLETE"
  | "PACKAGE_FACTS_MISSING"
  | "NET_CONTENT_INNER_COUNT_AMBIGUITY"
  | "MISSING_COMPONENT_TRUTH"
  | "COMPONENT_TRUTH_CONTRADICTION"
  | "MIXED_BUNDLE_UNSUPPORTED"
  | "MIXED_BUNDLE_AMBIGUOUS"
  | "TITLE_IDENTITY_CONTRADICTION"
  | "MISSING_SOURCE_EVIDENCE"
  | "UNKNOWN_SOURCE_REFERENCE"
  | "MISSING_SOURCE_SHA256"
  | "INVALID_SOURCE_SHA256"
  | "INVALID_SOURCE_CAPTURED_AT"
  | "SOURCE_SCOPE_MISSING"
  | "SOURCE_KIND_NOT_AUTHORITATIVE"
  | "DONOR_IMAGE_NOT_AUTHORITATIVE";

export interface TruthSourceEvidence {
  source_ref_id: string;
  source_kind: TruthSourceKind;
  locator: string;
  captured_at: string;
  /** Explicit null represents known-missing evidence and blocks vision. */
  payload_sha256: string | null;
  supports: TruthEvidenceScope[];
}

export interface RecipeComponentTruth {
  component_id: string;
  quantity: number;
  identity: AuditIdentityTruth | null;
  package_facts: ExpectedPackageFact[] | null;
  source_ref_ids: string[];
}

export interface StructuredRecipe {
  recipe_id: string;
  composition: RecipeComposition;
  outer_units: number | null;
  components: RecipeComponentTruth[];
  source_ref_ids: string[];
}

export interface StructuredCatalogComponent {
  component_id: string;
  quantity: number;
}

export interface StructuredCatalogRecord {
  outer_units: number | null;
  components: StructuredCatalogComponent[];
  source_ref_ids: string[];
}

export interface ProposedAuditTruth {
  outer_units: number | null;
  identity: AuditIdentityTruth | null;
  package_facts: ExpectedPackageFact[] | null;
  truth_source: "recipe" | "manual_verified";
  source_ref_ids: string[];
}

export interface TruthPreflightInput {
  schema_version: typeof WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA;
  sku: string;
  item_id: string;
  listing_kind: ListingKind;
  current_title: string;
  current_title_source_ref_ids: string[];
  recipe: StructuredRecipe;
  structured_record: StructuredCatalogRecord;
  proposed_truth: ProposedAuditTruth;
  source_evidence: TruthSourceEvidence[];
}

export interface TruthPreflightReason {
  code: TruthPreflightReasonCode;
  path: string;
  message: string;
}

export interface TruthEvidenceBinding {
  source_ref_id: string;
  source_kind: TruthSourceKind;
  locator: string;
  captured_at: string;
  payload_sha256: string | null;
  supports: TruthEvidenceScope[];
}

export interface TruthPreflightResult {
  schema_version: typeof WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA;
  status: TruthPreflightStatus;
  sku: string;
  item_id: string;
  input_sha256: string;
  expected: AuditExpectedTruth | null;
  evidence_bindings: TruthEvidenceBinding[];
  reasons: TruthPreflightReason[];
}

export interface TitleOuterCountClaim {
  value: number;
  phrase: string;
  syntax: "pack_of" | "number_pack" | "quantity_of";
}

export interface TitleOuterCountEvidence {
  status: "NONE" | "EXACT" | "AMBIGUOUS";
  value: number | null;
  claims: TitleOuterCountClaim[];
}

export interface TruthPreflightCoverage {
  schema_version: typeof WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA;
  total_cases: number;
  auditable_cases: number;
  truth_review_cases: number;
  unsupported_cases: number;
  vision_eligible_cases: number;
  vision_blocked_cases: number;
  reason_counts: Partial<Record<TruthPreflightReasonCode, number>>;
}

const SIZE_UNITS = new Set<SizeUnit>([
  "oz", "fl_oz", "count", "lb", "g", "kg", "ml", "l",
]);
const SOURCE_KINDS = new Set<TruthSourceKind>([
  "seller_catalog", "buyer_pdp", "recipe_record", "sku_reference_catalog",
  "manufacturer_page", "retailer_page", "manual_verification", "donor_image",
]);
const EVIDENCE_SCOPES = new Set<TruthEvidenceScope>([
  "current_title", "outer_units", "identity", "package_facts", "component_truth",
]);

/**
 * A source may declare a scope only when that source kind is independent and
 * competent for the fact. The live seller catalog and buyer PDP describe the
 * current marketplace surface, so they may prove the current title but may
 * never bootstrap the product truth used to audit that same surface. Donor
 * imagery is observation material only and is authoritative for no truth
 * scope.
 */
export const WALMART_TRUTH_SOURCE_AUTHORITY = {
  seller_catalog: ["current_title"],
  buyer_pdp: ["current_title"],
  recipe_record: ["outer_units", "identity", "package_facts", "component_truth"],
  sku_reference_catalog: ["outer_units", "identity", "package_facts", "component_truth"],
  manufacturer_page: ["identity", "package_facts", "component_truth"],
  retailer_page: ["identity", "package_facts", "component_truth"],
  manual_verification: ["current_title", "outer_units", "identity", "package_facts", "component_truth"],
  donor_image: [],
} as const satisfies Record<TruthSourceKind, readonly TruthEvidenceScope[]>;

function sourceKindCanEstablish(
  sourceKind: TruthSourceKind,
  scope: TruthEvidenceScope,
): boolean {
  const allowed = WALMART_TRUTH_SOURCE_AUTHORITY[sourceKind] as readonly TruthEvidenceScope[];
  return allowed.includes(scope);
}

const IDENTITY_ROLES = new Set<IdentityRole>(["brand", "product", "variant"]);
const PACKAGE_KINDS = new Set<PackageFactKind>(["net_content", "inner_item_count"]);
const PACKAGE_REQUIREMENTS = new Set<PackageFactRequirement>(["required", "if_visible"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
): void {
  const allowed = new Set(required);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, path: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${path} must be an array with at most ${max} items`);
  }
  const parsed = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} contains duplicates`);
  return parsed;
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${path} must be a positive integer or null`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nullablePositiveInteger(value, path);
  if (parsed === null) throw new Error(`${path} must be a positive integer`);
  return parsed;
}

function parseMarkerGroups(value: unknown, path: string): string[][] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error(`${path} must be an array with at most 12 groups`);
  }
  return value.map((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0 || group.length > 12) {
      throw new Error(`${path}[${groupIndex}] must contain 1-12 aliases`);
    }
    return stringArray(group, `${path}[${groupIndex}]`, 12);
  });
}

function parseIdentity(value: unknown, path: string): AuditIdentityTruth | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${path} must be an object or null`);
  assertExactKeys(value, [
    "brand_aliases", "product_marker_groups", "variant_marker_groups", "forbidden_markers",
  ], path);
  const brandAliases = stringArray(value.brand_aliases, `${path}.brand_aliases`, 12);
  const productGroups = parseMarkerGroups(value.product_marker_groups, `${path}.product_marker_groups`);
  const variantGroups = parseMarkerGroups(value.variant_marker_groups, `${path}.variant_marker_groups`);
  if (!Array.isArray(value.forbidden_markers) || value.forbidden_markers.length > 24) {
    throw new Error(`${path}.forbidden_markers must be an array with at most 24 items`);
  }
  const forbidden = value.forbidden_markers.map((raw, index) => {
    const markerPath = `${path}.forbidden_markers[${index}]`;
    if (!isRecord(raw)) throw new Error(`${markerPath} must be an object`);
    assertExactKeys(raw, ["role", "aliases"], markerPath);
    if (typeof raw.role !== "string" || !IDENTITY_ROLES.has(raw.role as IdentityRole)) {
      throw new Error(`${markerPath}.role is unsupported`);
    }
    const aliases = stringArray(raw.aliases, `${markerPath}.aliases`, 12);
    if (aliases.length === 0) throw new Error(`${markerPath}.aliases must not be empty`);
    return { role: raw.role as IdentityRole, aliases };
  });
  return {
    brand_aliases: brandAliases,
    product_marker_groups: productGroups,
    variant_marker_groups: variantGroups,
    forbidden_markers: forbidden,
  };
}

function parsePackageFacts(value: unknown, path: string): ExpectedPackageFact[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error(`${path} must be an array with at most 4 facts, or null`);
  }
  return value.map((raw, index) => {
    const factPath = `${path}[${index}]`;
    if (!isRecord(raw)) throw new Error(`${factPath} must be an object`);
    assertExactKeys(raw, ["kind", "value", "unit", "requirement"], factPath);
    if (typeof raw.kind !== "string" || !PACKAGE_KINDS.has(raw.kind as PackageFactKind)) {
      throw new Error(`${factPath}.kind is unsupported`);
    }
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value) || raw.value <= 0) {
      throw new Error(`${factPath}.value must be a positive number`);
    }
    if (typeof raw.unit !== "string" || !SIZE_UNITS.has(raw.unit as SizeUnit)) {
      throw new Error(`${factPath}.unit is unsupported`);
    }
    if (typeof raw.requirement !== "string"
      || !PACKAGE_REQUIREMENTS.has(raw.requirement as PackageFactRequirement)) {
      throw new Error(`${factPath}.requirement is unsupported`);
    }
    return {
      kind: raw.kind as PackageFactKind,
      value: raw.value,
      unit: raw.unit as SizeUnit,
      requirement: raw.requirement as PackageFactRequirement,
    };
  });
}

function parseRecipeComponent(value: unknown, path: string): RecipeComponentTruth {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "component_id", "quantity", "identity", "package_facts", "source_ref_ids",
  ], path);
  return {
    component_id: requiredString(value.component_id, `${path}.component_id`),
    quantity: positiveInteger(value.quantity, `${path}.quantity`),
    identity: parseIdentity(value.identity, `${path}.identity`),
    package_facts: parsePackageFacts(value.package_facts, `${path}.package_facts`),
    source_ref_ids: stringArray(value.source_ref_ids, `${path}.source_ref_ids`),
  };
}

function parseRecipe(value: unknown, path: string): StructuredRecipe {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "recipe_id", "composition", "outer_units", "components", "source_ref_ids",
  ], path);
  if (value.composition !== "same_product"
    && value.composition !== "mixed_bundle"
    && value.composition !== "variety_pack") {
    throw new Error(`${path}.composition is unsupported`);
  }
  if (!Array.isArray(value.components) || value.components.length > 100) {
    throw new Error(`${path}.components must be an array with at most 100 items`);
  }
  const components = value.components.map((component, index) => (
    parseRecipeComponent(component, `${path}.components[${index}]`)
  ));
  const ids = components.map((component) => component.component_id);
  if (new Set(ids).size !== ids.length) throw new Error(`${path}.components has duplicate component_id`);
  return {
    recipe_id: requiredString(value.recipe_id, `${path}.recipe_id`),
    composition: value.composition,
    outer_units: nullablePositiveInteger(value.outer_units, `${path}.outer_units`),
    components,
    source_ref_ids: stringArray(value.source_ref_ids, `${path}.source_ref_ids`),
  };
}

function parseStructuredRecord(value: unknown, path: string): StructuredCatalogRecord {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, ["outer_units", "components", "source_ref_ids"], path);
  if (!Array.isArray(value.components) || value.components.length > 100) {
    throw new Error(`${path}.components must be an array with at most 100 items`);
  }
  const components = value.components.map((raw, index) => {
    const componentPath = `${path}.components[${index}]`;
    if (!isRecord(raw)) throw new Error(`${componentPath} must be an object`);
    assertExactKeys(raw, ["component_id", "quantity"], componentPath);
    return {
      component_id: requiredString(raw.component_id, `${componentPath}.component_id`),
      quantity: positiveInteger(raw.quantity, `${componentPath}.quantity`),
    };
  });
  const ids = components.map((component) => component.component_id);
  if (new Set(ids).size !== ids.length) throw new Error(`${path}.components has duplicate component_id`);
  return {
    outer_units: nullablePositiveInteger(value.outer_units, `${path}.outer_units`),
    components,
    source_ref_ids: stringArray(value.source_ref_ids, `${path}.source_ref_ids`),
  };
}

function parseProposedTruth(value: unknown, path: string): ProposedAuditTruth {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "outer_units", "identity", "package_facts", "truth_source", "source_ref_ids",
  ], path);
  if (value.truth_source !== "recipe" && value.truth_source !== "manual_verified") {
    throw new Error(`${path}.truth_source must be recipe or manual_verified`);
  }
  return {
    outer_units: nullablePositiveInteger(value.outer_units, `${path}.outer_units`),
    identity: parseIdentity(value.identity, `${path}.identity`),
    package_facts: parsePackageFacts(value.package_facts, `${path}.package_facts`),
    truth_source: value.truth_source,
    source_ref_ids: stringArray(value.source_ref_ids, `${path}.source_ref_ids`),
  };
}

function parseSourceEvidence(value: unknown, path: string): TruthSourceEvidence {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    "source_ref_id", "source_kind", "locator", "captured_at", "payload_sha256", "supports",
  ], path);
  if (typeof value.source_kind !== "string"
    || !SOURCE_KINDS.has(value.source_kind as TruthSourceKind)) {
    throw new Error(`${path}.source_kind is unsupported`);
  }
  if (value.payload_sha256 !== null && typeof value.payload_sha256 !== "string") {
    throw new Error(`${path}.payload_sha256 must be a string or null`);
  }
  if (!Array.isArray(value.supports) || value.supports.length > EVIDENCE_SCOPES.size) {
    throw new Error(`${path}.supports must be an array with at most ${EVIDENCE_SCOPES.size} items`);
  }
  const supports = value.supports.map((scope, index) => {
    if (typeof scope !== "string" || !EVIDENCE_SCOPES.has(scope as TruthEvidenceScope)) {
      throw new Error(`${path}.supports[${index}] is unsupported`);
    }
    return scope as TruthEvidenceScope;
  });
  if (new Set(supports).size !== supports.length) throw new Error(`${path}.supports contains duplicates`);
  return {
    source_ref_id: requiredString(value.source_ref_id, `${path}.source_ref_id`),
    source_kind: value.source_kind as TruthSourceKind,
    locator: requiredString(value.locator, `${path}.locator`),
    captured_at: typeof value.captured_at === "string" ? value.captured_at.trim() : "",
    payload_sha256: value.payload_sha256 === null ? null : value.payload_sha256.trim(),
    supports,
  };
}

/** Parse an untrusted preflight record without translating any legacy fields. */
export function parseTruthPreflightInput(raw: unknown): TruthPreflightInput {
  if (!isRecord(raw)) throw new Error("truth preflight input must be an object");
  assertExactKeys(raw, [
    "schema_version", "sku", "item_id", "listing_kind", "current_title",
    "current_title_source_ref_ids", "recipe", "structured_record", "proposed_truth",
    "source_evidence",
  ], "truth preflight input");
  if (raw.schema_version !== WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA) {
    throw new Error(`truth preflight input.schema_version must be ${WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA}`);
  }
  if (raw.listing_kind !== "single" && raw.listing_kind !== "multipack"
    && raw.listing_kind !== "bundle" && raw.listing_kind !== "variety") {
    throw new Error("truth preflight input.listing_kind is unsupported");
  }
  const itemId = requiredString(raw.item_id, "truth preflight input.item_id");
  if (!/^\d+$/.test(itemId)) throw new Error("truth preflight input.item_id must contain digits only");
  if (!Array.isArray(raw.source_evidence) || raw.source_evidence.length > 500) {
    throw new Error("truth preflight input.source_evidence must be an array with at most 500 items");
  }
  const evidence = raw.source_evidence.map((source, index) => (
    parseSourceEvidence(source, `truth preflight input.source_evidence[${index}]`)
  ));
  const ids = evidence.map((source) => source.source_ref_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("truth preflight input.source_evidence has duplicate source_ref_id");
  }
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
    sku: requiredString(raw.sku, "truth preflight input.sku"),
    item_id: itemId,
    listing_kind: raw.listing_kind,
    current_title: requiredString(raw.current_title, "truth preflight input.current_title"),
    current_title_source_ref_ids: stringArray(
      raw.current_title_source_ref_ids,
      "truth preflight input.current_title_source_ref_ids",
    ),
    recipe: parseRecipe(raw.recipe, "truth preflight input.recipe"),
    structured_record: parseStructuredRecord(
      raw.structured_record,
      "truth preflight input.structured_record",
    ),
    proposed_truth: parseProposedTruth(raw.proposed_truth, "truth preflight input.proposed_truth"),
    source_evidence: evidence,
  };
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsAlias(haystack: string, aliases: readonly string[]): boolean {
  const padded = ` ${normalizeText(haystack)} `;
  return aliases.some((alias) => {
    const needle = normalizeText(alias);
    return needle.length > 0 && padded.includes(` ${needle} `);
  });
}

/** Extract only explicit pack/set/bundle/case syntax; bare "8 count" is never outer quantity. */
export function extractTitleOuterCountEvidence(title: string): TitleOuterCountEvidence {
  const claims: Array<TitleOuterCountClaim & { index: number }> = [];
  const patterns: Array<{
    syntax: TitleOuterCountClaim["syntax"];
    pattern: RegExp;
    valueGroup: number;
  }> = [
    {
      syntax: "pack_of",
      pattern: /\b(?:pack|set|bundle|case|multipack)\s+of\s+(\d{1,4})\b/gi,
      valueGroup: 1,
    },
    {
      syntax: "number_pack",
      pattern: /\b(\d{1,4})\s*(?:-\s*)?(?:pack|pk)\b/gi,
      valueGroup: 1,
    },
    {
      syntax: "quantity_of",
      pattern: /\b(?:quantity|qty)\s+of\s+(\d{1,4})\b/gi,
      valueGroup: 1,
    },
  ];
  for (const entry of patterns) {
    for (const match of title.matchAll(entry.pattern)) {
      const value = Number(match[entry.valueGroup]);
      if (!Number.isInteger(value) || value < 1) continue;
      claims.push({
        value,
        phrase: match[0],
        syntax: entry.syntax,
        index: match.index ?? 0,
      });
    }
  }
  claims.sort((left, right) => left.index - right.index || left.phrase.localeCompare(right.phrase));
  const deduped = claims.filter((claim, index) => !claims.slice(0, index).some((earlier) => (
    earlier.index === claim.index && earlier.phrase.toLowerCase() === claim.phrase.toLowerCase()
  ))).map((claim) => ({
    value: claim.value,
    phrase: claim.phrase,
    syntax: claim.syntax,
  }));
  const uniqueCounts = [...new Set(deduped.map((claim) => claim.value))];
  if (uniqueCounts.length === 0) return { status: "NONE", value: null, claims: [] };
  if (uniqueCounts.length === 1) {
    return { status: "EXACT", value: uniqueCounts[0], claims: deduped };
  }
  return { status: "AMBIGUOUS", value: null, claims: deduped };
}

function canonicalIdentity(identity: AuditIdentityTruth): string {
  const groups = (value: readonly string[][]) => value
    .map((group) => group.map(normalizeText).sort())
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));
  return JSON.stringify({
    brand_aliases: identity.brand_aliases.map(normalizeText).sort(),
    product_marker_groups: groups(identity.product_marker_groups),
    variant_marker_groups: groups(identity.variant_marker_groups),
    forbidden_markers: identity.forbidden_markers.map((marker) => ({
      role: marker.role,
      aliases: marker.aliases.map(normalizeText).sort(),
    })).sort((left, right) => (
      `${left.role}:${left.aliases.join("|")}`.localeCompare(`${right.role}:${right.aliases.join("|")}`)
    )),
  });
}

function canonicalPackageFacts(facts: readonly ExpectedPackageFact[]): string {
  return JSON.stringify([...facts].map((fact) => ({
    kind: fact.kind,
    value: fact.value,
    unit: fact.unit,
    requirement: fact.requirement,
  })).sort((left, right) => left.kind.localeCompare(right.kind)));
}

function isValidCapturedAt(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Return an immutable v3 expected truth only when every gate is satisfied.
 * A malformed envelope throws; a well-formed but unsafe truth record returns a
 * review/unsupported result with deterministic reasons and makes no calls.
 */
export function preflightWalmartAuditTruth(raw: unknown): TruthPreflightResult {
  const input = parseTruthPreflightInput(raw);
  const reasons: TruthPreflightReason[] = [];
  const reasonKeys = new Set<string>();
  const addReason = (code: TruthPreflightReasonCode, path: string, message: string): void => {
    const key = `${code}\u0000${path}\u0000${message}`;
    if (reasonKeys.has(key)) return;
    reasonKeys.add(key);
    reasons.push({ code, path, message });
  };

  const evidenceById = new Map(input.source_evidence.map((source) => [source.source_ref_id, source]));
  for (const [index, source] of input.source_evidence.entries()) {
    const path = `source_evidence[${index}]`;
    if (source.payload_sha256 === null || source.payload_sha256 === "") {
      addReason("MISSING_SOURCE_SHA256", `${path}.payload_sha256`, `Source ${source.source_ref_id} has no immutable payload hash`);
    } else if (!/^[a-f0-9]{64}$/i.test(source.payload_sha256)) {
      addReason("INVALID_SOURCE_SHA256", `${path}.payload_sha256`, `Source ${source.source_ref_id} is not bound to a SHA-256 digest`);
    }
    if (!isValidCapturedAt(source.captured_at)) {
      addReason("INVALID_SOURCE_CAPTURED_AT", `${path}.captured_at`, `Source ${source.source_ref_id} has no valid immutable capture timestamp`);
    }
  }

  const validateRefs = (
    refs: readonly string[],
    path: string,
    requiredScopes: readonly TruthEvidenceScope[],
  ): void => {
    if (refs.length === 0) {
      addReason("MISSING_SOURCE_EVIDENCE", path, "No immutable source evidence is referenced");
      return;
    }
    const resolved = refs.flatMap((ref) => {
      const source = evidenceById.get(ref);
      if (!source) {
        addReason("UNKNOWN_SOURCE_REFERENCE", path, `Unknown source reference ${ref}`);
        return [];
      }
      if (source.source_kind === "donor_image") {
        addReason("DONOR_IMAGE_NOT_AUTHORITATIVE", path, `Donor image ${ref} cannot establish catalog truth`);
      }
      return [source];
    });
    for (const scope of requiredScopes) {
      const declaredForScope = resolved.filter((source) => source.supports.includes(scope));
      for (const source of declaredForScope) {
        if (!sourceKindCanEstablish(source.source_kind, scope)) {
          addReason(
            "SOURCE_KIND_NOT_AUTHORITATIVE",
            path,
            `Source ${source.source_ref_id} of kind ${source.source_kind} cannot establish ${scope}`,
          );
        }
      }
      if (!declaredForScope.some((source) => sourceKindCanEstablish(source.source_kind, scope))) {
        addReason("SOURCE_SCOPE_MISSING", path, `Referenced evidence does not support ${scope}`);
      }
    }
  };

  validateRefs(input.current_title_source_ref_ids, "current_title_source_ref_ids", ["current_title"]);
  validateRefs(input.recipe.source_ref_ids, "recipe.source_ref_ids", ["outer_units", "component_truth"]);
  validateRefs(input.structured_record.source_ref_ids, "structured_record.source_ref_ids", ["outer_units", "component_truth"]);
  validateRefs(input.proposed_truth.source_ref_ids, "proposed_truth.source_ref_ids", [
    "outer_units", "identity", "package_facts",
  ]);

  const proposedIdentity = input.proposed_truth.identity;
  if (!proposedIdentity) {
    addReason("IDENTITY_TRUTH_MISSING", "proposed_truth.identity", "No v3 identity truth is available");
  } else {
    if (proposedIdentity.brand_aliases.length === 0
      || proposedIdentity.brand_aliases.some((alias) => normalizeText(alias).length < 2)) {
      addReason("IDENTITY_TRUTH_INCOMPLETE", "proposed_truth.identity", "Brand identity must contain explicit lexical v3 truth");
    }
    const missing: string[] = [];
    if (!containsAlias(input.current_title, proposedIdentity.brand_aliases)) missing.push("brand");
    for (const [index, group] of proposedIdentity.product_marker_groups.entries()) {
      if (!containsAlias(input.current_title, group)) missing.push(`product group ${index + 1}`);
    }
    for (const [index, group] of proposedIdentity.variant_marker_groups.entries()) {
      if (!containsAlias(input.current_title, group)) missing.push(`variant group ${index + 1}`);
    }
    const forbidden = proposedIdentity.forbidden_markers.filter((marker) => (
      containsAlias(input.current_title, marker.aliases)
    ));
    if (missing.length || forbidden.length) {
      const details = [
        ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
        ...(forbidden.length ? [`contains forbidden ${forbidden.map((marker) => `${marker.role}:${marker.aliases.join("|")}`).join(", ")}`] : []),
      ];
      addReason("TITLE_IDENTITY_CONTRADICTION", "current_title", `Current title contradicts proposed identity: ${details.join("; ")}`);
    }
  }

  const validateFacts = (facts: ExpectedPackageFact[] | null, path: string): void => {
    if (!facts || facts.length === 0) {
      addReason("PACKAGE_FACTS_MISSING", path, "No typed per-outer-package facts are available");
      return;
    }
    const kinds = facts.map((fact) => fact.kind);
    const ambiguous = new Set(kinds).size !== kinds.length
      || facts.length > 2
      || facts.some((fact) => fact.kind === "net_content" && fact.unit === "count")
      || facts.some((fact) => fact.kind === "inner_item_count"
        && (fact.unit !== "count" || !Number.isInteger(fact.value)));
    if (ambiguous) {
      addReason("NET_CONTENT_INNER_COUNT_AMBIGUITY", path, "Net content and inner item count are not independently typed v3 facts");
    }
  };
  validateFacts(input.proposed_truth.package_facts, "proposed_truth.package_facts");

  if (input.recipe.components.length === 0) {
    addReason("MISSING_COMPONENT_TRUTH", "recipe.components", "Recipe has no explicit components");
  }
  for (const [index, component] of input.recipe.components.entries()) {
    const path = `recipe.components[${index}]`;
    if (!component.identity || !component.package_facts || component.package_facts.length === 0) {
      addReason("MISSING_COMPONENT_TRUTH", path, `Component ${component.component_id} lacks identity or package truth`);
    }
    validateFacts(component.package_facts, `${path}.package_facts`);
    validateRefs(component.source_ref_ids, `${path}.source_ref_ids`, ["component_truth"]);
    if (component.identity && proposedIdentity
      && canonicalIdentity(component.identity) !== canonicalIdentity(proposedIdentity)) {
      addReason("COMPONENT_TRUTH_CONTRADICTION", `${path}.identity`, `Component ${component.component_id} identity differs from proposed listing truth`);
    }
    if (component.package_facts && input.proposed_truth.package_facts
      && canonicalPackageFacts(component.package_facts) !== canonicalPackageFacts(input.proposed_truth.package_facts)) {
      addReason("COMPONENT_TRUTH_CONTRADICTION", `${path}.package_facts`, `Component ${component.component_id} package facts differ from proposed listing truth`);
    }
  }

  if (input.recipe.composition === "mixed_bundle" || input.recipe.composition === "variety_pack") {
    addReason("MIXED_BUNDLE_UNSUPPORTED", "recipe.composition", "The v3 single-product comparator does not represent mixed or variety component truth");
  } else {
    const componentIdentitySet = new Set(input.recipe.components.flatMap((component) => (
      component.identity ? [canonicalIdentity(component.identity)] : []
    )));
    const componentFactSet = new Set(input.recipe.components.flatMap((component) => (
      component.package_facts ? [canonicalPackageFacts(component.package_facts)] : []
    )));
    if (input.listing_kind === "bundle" || input.listing_kind === "variety"
      || componentIdentitySet.size > 1 || componentFactSet.size > 1) {
      addReason("MIXED_BUNDLE_AMBIGUOUS", "recipe", "Listing/recipe signals disagree on whether all outer units are the same product");
    }
  }

  const titleCount = extractTitleOuterCountEvidence(input.current_title);
  if (titleCount.status === "AMBIGUOUS") {
    addReason("TITLE_OUTER_COUNT_AMBIGUOUS", "current_title", `Title contains conflicting explicit pack claims: ${titleCount.claims.map((claim) => `${claim.phrase}=${claim.value}`).join(", ")}`);
  }
  const outerCounts: Array<{ source: string; value: number | null }> = [
    { source: "recipe.outer_units", value: input.recipe.outer_units },
    { source: "structured_record.outer_units", value: input.structured_record.outer_units },
    { source: "proposed_truth.outer_units", value: input.proposed_truth.outer_units },
    ...(titleCount.status === "EXACT" ? [{ source: "current_title", value: titleCount.value }] : []),
  ];
  for (const count of outerCounts.slice(0, 3)) {
    if (count.value === null) addReason("OUTER_COUNT_MISSING", count.source, `${count.source} has no outer sellable-unit count`);
  }
  const availableOuterCounts = outerCounts.filter((count): count is { source: string; value: number } => (
    count.value !== null
  ));
  if (new Set(availableOuterCounts.map((count) => count.value)).size > 1) {
    addReason("OUTER_COUNT_DISAGREEMENT", "outer_units", `Outer count disagreement: ${availableOuterCounts.map((count) => `${count.source}=${count.value}`).join(", ")}`);
  }
  const recipeQuantity = input.recipe.components.reduce((sum, component) => sum + component.quantity, 0);
  if (input.recipe.outer_units !== null && recipeQuantity !== input.recipe.outer_units) {
    addReason("OUTER_COUNT_DISAGREEMENT", "recipe.components", `Recipe component quantity ${recipeQuantity} differs from recipe outer_units ${input.recipe.outer_units}`);
  }
  const structuredQuantity = input.structured_record.components.reduce((sum, component) => sum + component.quantity, 0);
  if (input.structured_record.outer_units !== null
    && structuredQuantity !== input.structured_record.outer_units) {
    addReason("OUTER_COUNT_DISAGREEMENT", "structured_record.components", `Structured component quantity ${structuredQuantity} differs from structured outer_units ${input.structured_record.outer_units}`);
  }
  const recipeComponentMap = [...input.recipe.components]
    .map((component) => `${component.component_id}:${component.quantity}`).sort();
  const structuredComponentMap = [...input.structured_record.components]
    .map((component) => `${component.component_id}:${component.quantity}`).sort();
  if (JSON.stringify(recipeComponentMap) !== JSON.stringify(structuredComponentMap)) {
    addReason("STRUCTURED_COMPONENT_DISAGREEMENT", "structured_record.components", "Structured record components do not exactly match the recipe");
  }
  const agreedOuterUnits = input.proposed_truth.outer_units;
  if ((input.listing_kind === "single" && agreedOuterUnits !== null && agreedOuterUnits !== 1)
    || (input.listing_kind === "multipack" && agreedOuterUnits === 1)) {
    addReason("LISTING_KIND_OUTER_COUNT_CONTRADICTION", "listing_kind", `listing_kind=${input.listing_kind} contradicts outer_units=${agreedOuterUnits}`);
  }

  reasons.sort((left, right) => (
    left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message)
  ));
  const unsupported = reasons.some((reason) => reason.code === "MIXED_BUNDLE_UNSUPPORTED");
  const status: TruthPreflightStatus = unsupported
    ? "UNSUPPORTED"
    : reasons.length > 0 ? "TRUTH_REVIEW" : "AUDITABLE";
  const expected: AuditExpectedTruth | null = status === "AUDITABLE"
    && proposedIdentity
    && input.proposed_truth.package_facts
    && agreedOuterUnits !== null
    ? {
        title: input.current_title,
        outer_units: agreedOuterUnits,
        identity: proposedIdentity,
        package_facts: input.proposed_truth.package_facts,
        truth_source: input.proposed_truth.truth_source,
      }
    : null;
  const referencedIds = new Set([
    ...input.current_title_source_ref_ids,
    ...input.recipe.source_ref_ids,
    ...input.structured_record.source_ref_ids,
    ...input.proposed_truth.source_ref_ids,
    ...input.recipe.components.flatMap((component) => component.source_ref_ids),
  ]);
  const evidenceBindings = input.source_evidence.filter((source) => referencedIds.has(source.source_ref_id))
    .map((source) => ({
      ...source,
      payload_sha256: source.payload_sha256 && /^[a-f0-9]{64}$/i.test(source.payload_sha256)
        ? source.payload_sha256.toLowerCase()
        : source.payload_sha256,
    })).sort((left, right) => left.source_ref_id.localeCompare(right.source_ref_id));
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA,
    status,
    sku: input.sku,
    item_id: input.item_id,
    input_sha256: stableHash(input),
    expected,
    evidence_bindings: evidenceBindings,
    reasons,
  };
}

/** Aggregate preflight coverage without treating blocked cases as vision work. */
export function summarizeTruthPreflightCoverage(
  results: readonly TruthPreflightResult[],
): TruthPreflightCoverage {
  const identities = new Set<string>();
  const reasonCounts = new Map<TruthPreflightReasonCode, number>();
  let auditable = 0;
  let review = 0;
  let unsupported = 0;
  for (const [index, result] of results.entries()) {
    if (result.schema_version !== WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA) {
      throw new Error(`results[${index}].schema_version is unsupported`);
    }
    const identity = `${result.sku}\u0000${result.item_id}`;
    if (identities.has(identity)) throw new Error(`duplicate preflight result for ${result.sku}/${result.item_id}`);
    identities.add(identity);
    if (result.status === "AUDITABLE") auditable += 1;
    else if (result.status === "TRUTH_REVIEW") review += 1;
    else if (result.status === "UNSUPPORTED") unsupported += 1;
    else throw new Error(`results[${index}].status is unsupported`);
    for (const code of new Set(result.reasons.map((reason) => reason.code))) {
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
  }
  const sortedReasonCounts = Object.fromEntries(
    [...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ) as Partial<Record<TruthPreflightReasonCode, number>>;
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA,
    total_cases: results.length,
    auditable_cases: auditable,
    truth_review_cases: review,
    unsupported_cases: unsupported,
    vision_eligible_cases: auditable,
    vision_blocked_cases: review + unsupported,
    reason_counts: sortedReasonCounts,
  };
}
