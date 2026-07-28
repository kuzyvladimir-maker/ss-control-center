/**
 * Pure, fail-closed product identity matcher.
 *
 * This module deliberately has no database, network, model, or environment
 * dependencies. Callers must first provide structured identity fields; `title`
 * is supporting evidence (token-boundary checks and hazardous modifier
 * detection), not a substitute for an explicitly identified flavor/product
 * line/form.
 */

import { CANONICAL_PRODUCT_MATCHER_VERSION } from "./canonical-product-match-provenance";

export { CANONICAL_PRODUCT_MATCHER_VERSION };

export type CanonicalMatchVerdict =
  | "EXACT_IDENTITY"
  | "CROSS_SIZE_ESTIMATE"
  | "SIBLING_ESTIMATE"
  | "SIZE_UNKNOWN_ESTIMATE"
  | "REJECT";

export type SizeDimension = "MASS" | "VOLUME" | "COUNT";
export type SizeParseStatus = "PARSED" | "MISSING" | "UNPARSEABLE" | "AMBIGUOUS";
export type OuterPackCountStatus = "PARSED" | "MISSING" | "INVALID" | "AMBIGUOUS" | "CONTRADICTORY";

export type CanonicalMatchReasonCode =
  | "IDENTITY_EXACT"
  | "IDENTITY_SIBLING_FLAVOR"
  | "TARGET_BRAND_MISSING"
  | "CANDIDATE_BRAND_MISSING"
  | "BRAND_MISMATCH"
  | "TARGET_TITLE_BRAND_CONTRADICTION"
  | "CANDIDATE_TITLE_BRAND_CONTRADICTION"
  | "PRODUCT_LINE_UNPROVEN"
  | "PRODUCT_LINE_MISMATCH"
  | "FLAVOR_UNPROVEN"
  | "FORM_UNPROVEN"
  | "FORM_MISMATCH"
  | "MODIFIER_MISMATCH"
  | "INSUFFICIENT_IDENTITY"
  | "SIZE_EXACT"
  | "SIZE_EQUIVALENT_CONVERSION"
  | "SIZE_DIFFERENT_COMPATIBLE_DIMENSION"
  | "TARGET_SIZE_MISSING"
  | "CANDIDATE_SIZE_MISSING"
  | "TARGET_SIZE_UNPARSEABLE"
  | "CANDIDATE_SIZE_UNPARSEABLE"
  | "TARGET_SIZE_AMBIGUOUS"
  | "CANDIDATE_SIZE_AMBIGUOUS"
  | "SIZE_DIMENSION_MISMATCH"
  | "SIZE_RATIO_OUT_OF_RANGE"
  | "SIBLING_SIZE_NOT_EXACT"
  | "SIBLING_SIZE_UNPROVEN"
  | "CANDIDATE_TITLE_MISSING"
  | "TITLE_BRAND_NOT_FOUND"
  | "TITLE_PREFIX_NOT_ALLOWED"
  | "TITLE_IDENTITY_EVIDENCE_INSUFFICIENT"
  | "TITLE_TARGET_TOKEN_MISSING"
  | "TITLE_UNEXPLAINED_CANDIDATE_TOKEN"
  | "TITLE_FALLBACK_IDENTITY_PROVEN"
  | "TITLE_SIBLING_INFERENCE_FORBIDDEN"
  | "TARGET_OUTER_PACK_COUNT_INVALID"
  | "CANDIDATE_OUTER_PACK_COUNT_INVALID"
  | "OUTER_PACK_COUNT_UNPROVEN"
  | "OUTER_PACK_COUNT_MISMATCH"
  | "TITLE_OUTER_PACK_COUNT_AMBIGUOUS";

export interface CanonicalProductIdentity {
  brand?: string | null;
  productLine?: string | null;
  flavor?: string | null;
  /** Arbitrary identity modifiers, e.g. "Zero Sugar" or ["Organic", "Unsalted"]. */
  modifiers?: string | readonly string[] | null;
  /** Physical/product form, e.g. "ice cream", "pods", "powder", "sandwich". */
  form?: string | null;
  /** Number of retail packages in the outer offer. One ordinary package = 1. */
  outerPackCount?: number | null;
  size?: string | null;
  /** Optional evidence. It is never substring-matched. */
  title?: string | null;
}

export interface CanonicalProductTitleCandidate {
  title?: string | null;
  /** Optional retailer-provided brand field. When present it must equal target.brand. */
  brand?: string | null;
}

export interface NormalizedCanonicalSize {
  dimension: SizeDimension;
  /** Amount as printed in `raw`, before conversion. */
  amount: number;
  unit: "oz" | "lb" | "g" | "kg" | "fl oz" | "ml" | "l" | "count";
  /** Grams for MASS, milliliters for VOLUME, units for COUNT. */
  baseAmount: number;
  baseUnit: "g" | "ml" | "count";
  raw: string;
}

export interface NormalizedCanonicalProduct {
  brandTokens: string[];
  productLineTokens: string[];
  flavorTokens: string[];
  modifierKeys: string[];
  formTokens: string[];
  titleTokens: string[];
  outerPackCount: number | null;
  outerPackCountSource: "explicit" | "title" | null;
  outerPackCountStatus: OuterPackCountStatus;
  size: NormalizedCanonicalSize | null;
  sizeStatus: SizeParseStatus;
  sizeSource: "size" | "title" | null;
}

export interface CanonicalProductMatchResult {
  verdict: CanonicalMatchVerdict;
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  reasonCodes: CanonicalMatchReasonCode[];
  normalized: {
    target: NormalizedCanonicalProduct;
    candidate: NormalizedCanonicalProduct;
  };
  /** Candidate base amount / target base amount when both sizes are comparable. */
  sizeRatioCandidateToTarget: number | null;
  /** Populated only by matchCanonicalProductTitle for explainable audits. */
  titleEvidence?: CanonicalTitleMatchEvidence;
}

export interface CanonicalTitleMatchEvidence {
  brandStartIndex: number | null;
  prefixTokens: string[];
  requiredTargetTokens: string[];
  missingTargetTokens: string[];
  unexplainedCandidateTokens: string[];
  targetOuterPackCount: number;
  candidateOuterPackCount: number | null;
}

const MASS_TO_GRAMS: Record<"oz" | "lb" | "g" | "kg", number> = {
  oz: 28.349523125,
  lb: 453.59237,
  g: 1,
  kg: 1000,
};

const VOLUME_TO_ML: Record<"fl oz" | "ml" | "l", number> = {
  "fl oz": 29.5735295625,
  ml: 1,
  l: 1000,
};

const MIN_CROSS_SIZE_RATIO = 0.25;
const MAX_CROSS_SIZE_RATIO = 4;
// Retail labels commonly round 1 lb to 454 g and 1 L to 33.8 fl oz. One percent
// admits those label conversions without reviving the old ±10% "exact" band.
const EQUIVALENT_SIZE_RELATIVE_TOLERANCE = 0.01;

/**
 * Words allowed to remain after target identity and size evidence are removed
 * from an unstructured retailer title. This list is intentionally short:
 * expanding it can turn a real adjacent variant into a false exact match.
 */
export const CANONICAL_TITLE_NEUTRAL_TOKENS = [
  "a", "an", "and", "by", "each", "fl", "flavor", "flavored", "fluid", "for",
  "g", "gram", "grams", "grocery", "kg", "kgs", "kilogram", "kilograms", "l",
  "lb", "lbs", "liter", "liters", "litre", "litres", "may", "ml", "net", "new",
  "of", "ounce", "ounces", "oz", "pack", "package", "packaging", "packs", "per",
  "pk", "product", "size", "the", "vary", "weight", "with", "wt", "count", "counts",
  "ct", "cts", "pc", "pcs", "piece", "pieces",
] as const;

/** Prefix grammar vocabulary; detected outer quantities must still equal the target. */
export const CANONICAL_TITLE_PREFIX_TOKENS = [
  "case", "cases", "count", "ct", "cts", "fl", "g", "gram", "grams", "kg", "kgs",
  "l", "lb", "lbs", "lot", "lots", "ml", "of", "ounce", "ounces", "oz", "pack",
  "packs", "pc", "pcs", "pk", "set", "sets", "unit", "units", "x",
] as const;

const TITLE_NEUTRAL = new Set<string>(CANONICAL_TITLE_NEUTRAL_TOKENS);

type KnownModifier = {
  key: string;
  aliases: readonly (readonly string[])[];
};

/**
 * Modifiers whose presence/absence changes the sellable variant, rather than
 * merely decorating copy. Aliases are intentionally narrow and auditable.
 */
const KNOWN_MODIFIERS: readonly KnownModifier[] = [
  { key: "zero_sugar", aliases: [["zero", "sugar"], ["sugar", "free"], ["no", "sugar"]] },
  { key: "extra", aliases: [["extra"], ["xxtra"]] },
  { key: "original", aliases: [["original"]] },
  { key: "classic", aliases: [["classic"]] },
  { key: "diet", aliases: [["diet"]] },
  { key: "light", aliases: [["light"], ["lite"]] },
  { key: "reduced_sodium", aliases: [["reduced", "sodium"]] },
  { key: "low_sodium", aliases: [["low", "sodium"]] },
  { key: "unsalted", aliases: [["unsalted"]] },
  { key: "no_salt_added", aliases: [["no", "salt", "added"]] },
  { key: "gluten_free", aliases: [["gluten", "free"]] },
  { key: "whole_wheat", aliases: [["whole", "wheat"]] },
  { key: "multigrain", aliases: [["multigrain"], ["multi", "grain"]] },
  { key: "decaf", aliases: [["decaf"], ["decaffeinated"]] },
  { key: "caffeine_free", aliases: [["caffeine", "free"]] },
] as const;

function foldedText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Possessive punctuation is not identity: Smucker's and Smuckers are equal.
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Exact normalized word tokens. No stemming and no substring matching. */
export function normalizeIdentityTokens(value: string | null | undefined): string[] {
  const text = foldedText(value);
  if (!text) return [];
  return [...new Set(text.split(/\s+/).filter(Boolean))].sort();
}

function orderedTokens(value: string | null | undefined): string[] {
  const text = foldedText(value);
  return text ? text.split(/\s+/).filter(Boolean) : [];
}

function sameTokenSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function containsAllTokens(haystack: readonly string[], needles: readonly string[]): boolean {
  if (!needles.length) return true;
  const tokens = new Set(haystack);
  return needles.every((token) => tokens.has(token));
}

function containsPhrase(tokens: readonly string[], phrase: readonly string[]): number[] | null {
  if (!phrase.length || phrase.length > tokens.length) return null;
  for (let start = 0; start <= tokens.length - phrase.length; start++) {
    if (phrase.every((token, offset) => tokens[start + offset] === token)) {
      return phrase.map((_, offset) => start + offset);
    }
  }
  return null;
}

function removeFirstPhrase(tokens: readonly string[], phrase: readonly string[]): string[] {
  const positions = containsPhrase(tokens, phrase);
  if (!positions) return [...tokens];
  const removed = new Set(positions);
  return tokens.filter((_, index) => !removed.has(index));
}

function knownModifierKeysAndConsumed(tokens: readonly string[]): { keys: string[]; consumed: Set<number> } {
  const keys = new Set<string>();
  const consumed = new Set<number>();
  for (const definition of KNOWN_MODIFIERS) {
    for (const alias of definition.aliases) {
      const positions = containsPhrase(tokens, alias);
      if (!positions) continue;
      keys.add(definition.key);
      positions.forEach((position) => consumed.add(position));
      break;
    }
  }
  return { keys: [...keys], consumed };
}

function normalizeModifierKeys(identity: CanonicalProductIdentity): string[] {
  const keys = new Set<string>();
  const structuredFlavorTokens = orderedTokens(identity.flavor);
  const originalIsStructuredFlavor = structuredFlavorTokens.includes("original");
  const titleWithoutBrand = removeFirstPhrase(
    orderedTokens(identity.title),
    orderedTokens(identity.brand),
  );
  const evidence = [
    { field: "productLine", tokens: orderedTokens(identity.productLine) },
    { field: "flavor", tokens: structuredFlavorTokens },
    { field: "form", tokens: orderedTokens(identity.form) },
    { field: "title", tokens: titleWithoutBrand },
  ] as const;
  for (const { field, tokens } of evidence) {
    const detected = knownModifierKeysAndConsumed(tokens);
    detected.keys.forEach((key) => {
      // `Original` is commonly the actual named flavor/variant. When a caller has
      // already classified it into the structured flavor field, flavor comparison
      // must decide sibling identity instead of duplicating it as a modifier. The
      // exception is deliberately limited to this field and this key. The same
      // word in a title is also flavor evidence when it repeats an already
      // structured Original flavor; otherwise title/productLine/form occurrences
      // remain identity-bearing. Explicit modifiers are processed below and always
      // remain identity-bearing. Zero Sugar/decaf/etc. retain their existing gates.
      if (
        key === "original" &&
        (field === "flavor" || (field === "title" && originalIsStructuredFlavor))
      ) return;
      keys.add(key);
    });
  }

  const explicit = Array.isArray(identity.modifiers)
    ? identity.modifiers
    : identity.modifiers
      ? [identity.modifiers]
      : [];
  for (const value of explicit) {
    const tokens = orderedTokens(value);
    const detected = knownModifierKeysAndConsumed(tokens);
    detected.keys.forEach((key) => keys.add(key));
    // Unknown explicit modifiers remain identity-bearing instead of being dropped.
    tokens.forEach((token, index) => {
      if (!detected.consumed.has(index)) keys.add(`token:${token}`);
    });
  }
  return [...keys].sort();
}

type OuterPackEvidence = {
  status: "NONE" | "PARSED" | "INVALID" | "AMBIGUOUS";
  count: number | null;
  consumed: Set<number>;
};

const OUTER_PACK_NOUNS = new Set(["pack", "packs", "pk", "case", "cases", "set", "sets", "lot", "lots"]);

function detectOuterPackEvidence(tokens: readonly string[]): OuterPackEvidence {
  const findings: { count: number; positions: number[] }[] = [];
  let invalid = false;
  const add = (count: number, positions: number[]) => {
    if (!Number.isInteger(count) || count < 1 || count > 999) invalid = true;
    else findings.push({ count, positions });
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const compact = token.match(/^(\d+)(pack|packs|pk|case|cases|x)$/);
    if (compact) {
      add(Number(compact[1]), [index]);
      continue;
    }
    if (/^\d+$/.test(token) && (OUTER_PACK_NOUNS.has(tokens[index + 1]) || tokens[index + 1] === "x")) {
      add(Number(token), [index, index + 1]);
      continue;
    }
    if (OUTER_PACK_NOUNS.has(token) && tokens[index + 1] === "of" && /^\d+$/.test(tokens[index + 2] || "")) {
      add(Number(tokens[index + 2]), [index, index + 1, index + 2]);
    }
  }

  const consumed = new Set(findings.flatMap((finding) => finding.positions));
  if (invalid) return { status: "INVALID", count: null, consumed };
  if (!findings.length) return { status: "NONE", count: null, consumed };
  const counts = [...new Set(findings.map((finding) => finding.count))];
  if (counts.length !== 1) return { status: "AMBIGUOUS", count: null, consumed };
  return { status: "PARSED", count: counts[0], consumed };
}

/** Parse an explicit outer multipack/case marker. No marker returns null. */
export function parseOuterPackCount(value: string | null | undefined): number | null {
  const evidence = detectOuterPackEvidence(orderedTokens(value));
  return evidence.status === "PARSED" ? evidence.count : null;
}

type ParsedUnit = NormalizedCanonicalSize["unit"];

function canonicalUnit(rawUnit: string): ParsedUnit | null {
  const unit = rawUnit.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (/^(?:fl oz|floz|fluid oz|fluid ounce|fluid ounces)$/.test(unit)) return "fl oz";
  if (/^(?:oz|ounce|ounces)$/.test(unit)) return "oz";
  if (/^(?:lb|lbs|pound|pounds)$/.test(unit)) return "lb";
  if (/^(?:g|gram|grams)$/.test(unit)) return "g";
  if (/^(?:kg|kgs|kilogram|kilograms)$/.test(unit)) return "kg";
  if (/^(?:ml|milliliter|milliliters|millilitre|millilitres)$/.test(unit)) return "ml";
  if (/^(?:l|liter|liters|litre|litres)$/.test(unit)) return "l";
  if (/^(?:ct|cts|count|counts|pc|pcs|piece|pieces)$/.test(unit)) return "count";
  return null;
}

function normalizedSize(raw: string, amount: number, unit: ParsedUnit): NormalizedCanonicalSize {
  if (unit === "count") {
    return { dimension: "COUNT", amount, unit, baseAmount: amount, baseUnit: "count", raw };
  }
  if (unit === "fl oz" || unit === "ml" || unit === "l") {
    return {
      dimension: "VOLUME",
      amount,
      unit,
      baseAmount: amount * VOLUME_TO_ML[unit],
      baseUnit: "ml",
      raw,
    };
  }
  return {
    dimension: "MASS",
    amount,
    unit,
    baseAmount: amount * MASS_TO_GRAMS[unit],
    baseUnit: "g",
    raw,
  };
}

function sizesEquivalent(a: NormalizedCanonicalSize, b: NormalizedCanonicalSize): boolean {
  if (a.dimension !== b.dimension) return false;
  const denominator = Math.max(Math.abs(a.baseAmount), Math.abs(b.baseAmount), Number.EPSILON);
  return Math.abs(a.baseAmount - b.baseAmount) / denominator <= EQUIVALENT_SIZE_RELATIVE_TOLERANCE;
}

type SizeEvidence = {
  status: SizeParseStatus;
  size: NormalizedCanonicalSize | null;
};

function parseSizeEvidence(value: string | null | undefined): SizeEvidence {
  const raw = String(value ?? "").trim();
  if (!raw) return { status: "MISSING", size: null };

  const matches: NormalizedCanonicalSize[] = [];
  // Longer alternatives come first so "fl oz" can never collapse to mass "oz".
  const pattern = /(?:^|\b)(\d+(?:\.\d+)?|\.\d+)\s*(fl\.?\s*oz\.?|floz|fluid\s*oz|fluid\s*ounces?|kilograms?|kgs?|kg|grams?|g|pounds?|lbs?|lb|ounces?|oz|milliliters?|millilitres?|ml|liters?|litres?|l|counts?|cts?|pieces?|pcs?)\b/gi;
  for (const match of raw.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = canonicalUnit(match[2]);
    if (!unit || !Number.isFinite(amount) || amount <= 0) continue;
    matches.push(normalizedSize(raw, amount, unit));
  }
  if (!matches.length) return { status: "UNPARSEABLE", size: null };

  const first = matches[0];
  // "16 oz (1 lb)" is redundant but unambiguous. "8 oz / 4 ct" or two
  // genuinely different amounts is not: callers must canonicalize it first.
  if (matches.slice(1).some((candidate) => !sizesEquivalent(first, candidate))) {
    return { status: "AMBIGUOUS", size: null };
  }
  return { status: "PARSED", size: first };
}

/** Parse one unambiguous package size into a canonical measurement dimension. */
export function parseCanonicalSize(value: string | null | undefined): NormalizedCanonicalSize | null {
  const evidence = parseSizeEvidence(value);
  return evidence.status === "PARSED" ? evidence.size : null;
}

function normalizeProduct(identity: CanonicalProductIdentity): NormalizedCanonicalProduct {
  const explicitSize = String(identity.size ?? "").trim();
  const title = String(identity.title ?? "").trim();
  const sizeSource: "size" | "title" | null = explicitSize ? "size" : title ? "title" : null;
  const evidence = parseSizeEvidence(explicitSize || title);
  const hasExplicitOuterPack = identity.outerPackCount != null;
  const explicitOuterPackValid =
    hasExplicitOuterPack &&
    Number.isInteger(identity.outerPackCount) &&
    Number(identity.outerPackCount) >= 1 &&
    Number(identity.outerPackCount) <= 999;
  const titleOuterPack = detectOuterPackEvidence(orderedTokens(title));
  const outerPackContradictory =
    explicitOuterPackValid &&
    titleOuterPack.status === "PARSED" &&
    titleOuterPack.count !== Number(identity.outerPackCount);
  const outerPackCount = hasExplicitOuterPack
    ? explicitOuterPackValid ? Number(identity.outerPackCount) : null
    : titleOuterPack.status === "PARSED" ? titleOuterPack.count : null;
  const outerPackCountStatus: OuterPackCountStatus = hasExplicitOuterPack
    ? !explicitOuterPackValid
      ? "INVALID"
      : titleOuterPack.status === "INVALID" || titleOuterPack.status === "AMBIGUOUS"
        ? titleOuterPack.status
        : outerPackContradictory
          ? "CONTRADICTORY"
          : "PARSED"
    : titleOuterPack.status === "NONE"
      ? "MISSING"
      : titleOuterPack.status;
  return {
    brandTokens: normalizeIdentityTokens(identity.brand),
    productLineTokens: normalizeIdentityTokens(identity.productLine),
    flavorTokens: normalizeIdentityTokens(identity.flavor),
    modifierKeys: normalizeModifierKeys(identity),
    formTokens: normalizeIdentityTokens(identity.form),
    titleTokens: normalizeIdentityTokens(identity.title),
    outerPackCount,
    outerPackCountSource: hasExplicitOuterPack ? "explicit" : titleOuterPack.status === "NONE" ? null : "title",
    outerPackCountStatus,
    size: evidence.size,
    sizeStatus: evidence.status,
    sizeSource,
  };
}

function sizeReason(prefix: "TARGET" | "CANDIDATE", status: SizeParseStatus): CanonicalMatchReasonCode | null {
  if (status === "MISSING") return `${prefix}_SIZE_MISSING` as CanonicalMatchReasonCode;
  if (status === "UNPARSEABLE") return `${prefix}_SIZE_UNPARSEABLE` as CanonicalMatchReasonCode;
  if (status === "AMBIGUOUS") return `${prefix}_SIZE_AMBIGUOUS` as CanonicalMatchReasonCode;
  return null;
}

function result(
  verdict: CanonicalMatchVerdict,
  reasonCodes: CanonicalMatchReasonCode[],
  target: NormalizedCanonicalProduct,
  candidate: NormalizedCanonicalProduct,
  sizeRatioCandidateToTarget: number | null = null,
): CanonicalProductMatchResult {
  return {
    verdict,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    reasonCodes: [...new Set(reasonCodes)],
    normalized: { target, candidate },
    sizeRatioCandidateToTarget,
  };
}

/**
 * Match an identified target to a candidate donor.
 *
 * Verdict semantics:
 * - EXACT_IDENTITY: exact structured identity and equivalent known package size.
 * - CROSS_SIZE_ESTIMATE: exact identity, compatible dimension, different size.
 * - SIBLING_ESTIMATE: only flavor differs and both package sizes are equivalent.
 * - SIZE_UNKNOWN_ESTIMATE: exact identity, but at least one size is unproven.
 * - REJECT: identity conflict, incompatible size, or compounded uncertainty.
 */
export function matchCanonicalProduct(
  targetInput: CanonicalProductIdentity,
  candidateInput: CanonicalProductIdentity,
): CanonicalProductMatchResult {
  const target = normalizeProduct(targetInput);
  const candidate = normalizeProduct(candidateInput);
  const reject = (codes: CanonicalMatchReasonCode[]) => result("REJECT", codes, target, candidate);

  if (!target.brandTokens.length) return reject(["TARGET_BRAND_MISSING"]);
  if (!candidate.brandTokens.length) return reject(["CANDIDATE_BRAND_MISSING"]);
  if (!sameTokenSet(target.brandTokens, candidate.brandTokens)) return reject(["BRAND_MISMATCH"]);

  // When a title is supplied it must support, not contradict, the declared brand.
  // This also makes Dove vs Dover fail: token equality, never String.includes().
  if (target.titleTokens.length && !containsAllTokens(target.titleTokens, target.brandTokens)) {
    return reject(["TARGET_TITLE_BRAND_CONTRADICTION"]);
  }
  if (candidate.titleTokens.length && !containsAllTokens(candidate.titleTokens, candidate.brandTokens)) {
    return reject(["CANDIDATE_TITLE_BRAND_CONTRADICTION"]);
  }

  if (["INVALID", "AMBIGUOUS", "CONTRADICTORY"].includes(target.outerPackCountStatus)) {
    return reject(["TARGET_OUTER_PACK_COUNT_INVALID"]);
  }
  if (["INVALID", "AMBIGUOUS", "CONTRADICTORY"].includes(candidate.outerPackCountStatus)) {
    return reject(["CANDIDATE_OUTER_PACK_COUNT_INVALID"]);
  }
  if ((target.outerPackCount == null) !== (candidate.outerPackCount == null)) {
    return reject(["OUTER_PACK_COUNT_UNPROVEN"]);
  }
  if (
    target.outerPackCount != null &&
    candidate.outerPackCount != null &&
    target.outerPackCount !== candidate.outerPackCount
  ) {
    return reject(["OUTER_PACK_COUNT_MISMATCH"]);
  }

  const compareSymmetricField = (
    a: readonly string[],
    b: readonly string[],
    unproven: CanonicalMatchReasonCode,
    mismatch: CanonicalMatchReasonCode,
  ): CanonicalMatchReasonCode | null => {
    if (!a.length && !b.length) return null;
    if (!a.length || !b.length) return unproven;
    return sameTokenSet(a, b) ? null : mismatch;
  };

  const lineProblem = compareSymmetricField(
    target.productLineTokens,
    candidate.productLineTokens,
    "PRODUCT_LINE_UNPROVEN",
    "PRODUCT_LINE_MISMATCH",
  );
  if (lineProblem) return reject([lineProblem]);

  const formProblem = compareSymmetricField(
    target.formTokens,
    candidate.formTokens,
    "FORM_UNPROVEN",
    "FORM_MISMATCH",
  );
  if (formProblem) return reject([formProblem]);

  // Extra/missing modifiers are identity conflicts, not harmless flavor siblings.
  // This keeps normal ↔ Zero Sugar and Original ↔ Extra out of estimate tiers.
  if (!sameTokenSet(target.modifierKeys, candidate.modifierKeys)) {
    return reject(["MODIFIER_MISMATCH"]);
  }

  let siblingFlavor = false;
  if (!target.flavorTokens.length && !candidate.flavorTokens.length) {
    siblingFlavor = false;
  } else if (!target.flavorTokens.length || !candidate.flavorTokens.length) {
    return reject(["FLAVOR_UNPROVEN"]);
  } else {
    siblingFlavor = !sameTokenSet(target.flavorTokens, candidate.flavorTokens);
  }

  const hasDiscriminator =
    target.productLineTokens.length > 0 ||
    target.flavorTokens.length > 0 ||
    target.formTokens.length > 0;
  if (!hasDiscriminator) return reject(["INSUFFICIENT_IDENTITY"]);

  const targetSizeReason = sizeReason("TARGET", target.sizeStatus);
  const candidateSizeReason = sizeReason("CANDIDATE", candidate.sizeStatus);
  const sizeUnknownReasons = [targetSizeReason, candidateSizeReason].filter(
    (code): code is CanonicalMatchReasonCode => code != null,
  );

  if (!target.size || !candidate.size) {
    if (siblingFlavor) {
      return reject(["SIBLING_SIZE_UNPROVEN", ...sizeUnknownReasons]);
    }
    return result(
      "SIZE_UNKNOWN_ESTIMATE",
      ["IDENTITY_EXACT", ...sizeUnknownReasons],
      target,
      candidate,
    );
  }

  if (target.size.dimension !== candidate.size.dimension) {
    return reject(["SIZE_DIMENSION_MISMATCH"]);
  }

  const ratio = candidate.size.baseAmount / target.size.baseAmount;
  const equivalent = sizesEquivalent(target.size, candidate.size);

  if (siblingFlavor) {
    if (!equivalent) return reject(["SIBLING_SIZE_NOT_EXACT"]);
    return result(
      "SIBLING_ESTIMATE",
      ["IDENTITY_SIBLING_FLAVOR", target.size.unit === candidate.size.unit ? "SIZE_EXACT" : "SIZE_EQUIVALENT_CONVERSION"],
      target,
      candidate,
      ratio,
    );
  }

  if (equivalent) {
    return result(
      "EXACT_IDENTITY",
      ["IDENTITY_EXACT", target.size.unit === candidate.size.unit ? "SIZE_EXACT" : "SIZE_EQUIVALENT_CONVERSION"],
      target,
      candidate,
      ratio,
    );
  }

  if (ratio < MIN_CROSS_SIZE_RATIO || ratio > MAX_CROSS_SIZE_RATIO) {
    return reject(["SIZE_RATIO_OUT_OF_RANGE"]);
  }
  return result(
    "CROSS_SIZE_ESTIMATE",
    ["IDENTITY_EXACT", "SIZE_DIFFERENT_COMPATIBLE_DIMENSION"],
    target,
    candidate,
    ratio,
  );
}

function isQuantityOrMeasurementToken(token: string): boolean {
  return (
    /^\d+$/.test(token) ||
    /^\d+(?:case|cases|count|ct|cts|fl|g|kg|l|lb|lbs|ml|oz|pack|packs|pc|pcs|pk|unit|units|x)$/.test(token)
  );
}

const MEASUREMENT_PREFIX_UNITS = new Set([
  "count", "ct", "cts", "fl", "g", "gram", "grams", "kg", "kgs", "l", "lb", "lbs",
  "ml", "ounce", "ounces", "oz", "pc", "pcs",
]);

function measurementBrandPrefix(tokens: readonly string[]): boolean {
  if (!tokens.length) return false;
  const hasUnit = tokens.some((token) =>
    MEASUREMENT_PREFIX_UNITS.has(token) ||
    /^\d+(?:count|ct|cts|fl|g|kg|l|lb|lbs|ml|ounce|ounces|oz|pc|pcs)$/.test(token),
  );
  return hasUnit && tokens.every((token) =>
    /^\d+$/.test(token) ||
    MEASUREMENT_PREFIX_UNITS.has(token) ||
    /^\d+(?:count|ct|cts|fl|g|kg|l|lb|lbs|ml|ounce|ounces|oz|pc|pcs)$/.test(token),
  );
}

function validBrandPrefix(tokens: readonly string[]): boolean {
  if (!tokens.length) return true;
  const outer = detectOuterPackEvidence(tokens);
  if (outer.status === "INVALID" || outer.status === "AMBIGUOUS") return false;
  const remainder = tokens.filter((_, index) => !outer.consumed.has(index));
  if (!remainder.length) return outer.status === "PARSED";
  return measurementBrandPrefix(remainder);
}

function explicitModifierTokens(identity: CanonicalProductIdentity): string[] {
  const values = Array.isArray(identity.modifiers)
    ? identity.modifiers
    : identity.modifiers
      ? [identity.modifiers]
      : [];
  return values.flatMap((value) => orderedTokens(value));
}

function titleBridgeEvidence(): CanonicalTitleMatchEvidence {
  return {
    brandStartIndex: null,
    prefixTokens: [],
    requiredTargetTokens: [],
    missingTargetTokens: [],
    unexplainedCandidateTokens: [],
    targetOuterPackCount: 1,
    candidateOuterPackCount: null,
  };
}

/**
 * Fail-closed bridge for a target with structured identity and a retailer/donor
 * candidate that has only a raw title.
 *
 * The bridge proves that the title is brand-led, contains every meaningful
 * target identity token, and contains no unexplained meaningful token. Only
 * after those checks does it delegate size classification to the canonical
 * matcher. It can therefore return exact/cross-size/size-unknown, but never a
 * sibling estimate: a different flavor cannot be safely inferred from a title.
 */
export function matchCanonicalProductTitle(
  targetInput: CanonicalProductIdentity,
  candidateInput: CanonicalProductTitleCandidate,
): CanonicalProductMatchResult {
  const title = String(candidateInput.title ?? "").trim();
  const titleTokens = orderedTokens(title);
  const titleOuterPack = detectOuterPackEvidence(titleTokens);
  const targetOuterPackValid =
    targetInput.outerPackCount == null ||
    (Number.isInteger(targetInput.outerPackCount) && Number(targetInput.outerPackCount) >= 1 && Number(targetInput.outerPackCount) <= 999);
  const targetOuterPackCount = targetInput.outerPackCount == null ? 1 : Number(targetInput.outerPackCount);
  const candidateOuterPackCount = titleOuterPack.status === "NONE"
    ? 1
    : titleOuterPack.status === "PARSED"
      ? titleOuterPack.count
      : null;
  const effectiveTargetInput: CanonicalProductIdentity = {
    ...targetInput,
    outerPackCount: targetOuterPackValid ? targetOuterPackCount : targetInput.outerPackCount,
  };
  const candidateBrand = candidateInput.brand || targetInput.brand || null;
  const rawCandidate: CanonicalProductIdentity = {
    brand: candidateBrand,
    title,
    ...(candidateOuterPackCount != null ? { outerPackCount: candidateOuterPackCount } : {}),
  };
  const normalizedTarget = normalizeProduct(effectiveTargetInput);
  const normalizedRawCandidate = normalizeProduct(rawCandidate);
  const evidence = titleBridgeEvidence();
  evidence.targetOuterPackCount = targetOuterPackCount;
  evidence.candidateOuterPackCount = candidateOuterPackCount;
  const rejectTitle = (codes: CanonicalMatchReasonCode[]): CanonicalProductMatchResult => ({
    ...result("REJECT", codes, normalizedTarget, normalizedRawCandidate),
    titleEvidence: evidence,
  });

  if (!title) return rejectTitle(["CANDIDATE_TITLE_MISSING"]);
  if (!targetOuterPackValid) return rejectTitle(["TARGET_OUTER_PACK_COUNT_INVALID"]);
  if (titleOuterPack.status === "INVALID") return rejectTitle(["CANDIDATE_OUTER_PACK_COUNT_INVALID"]);
  if (titleOuterPack.status === "AMBIGUOUS") return rejectTitle(["TITLE_OUTER_PACK_COUNT_AMBIGUOUS"]);
  if (!normalizedTarget.brandTokens.length) return rejectTitle(["TARGET_BRAND_MISSING"]);

  if (candidateInput.brand) {
    const providedBrand = normalizeIdentityTokens(candidateInput.brand);
    if (!sameTokenSet(normalizedTarget.brandTokens, providedBrand)) {
      return rejectTitle(["BRAND_MISMATCH"]);
    }
  }

  const brandTokens = orderedTokens(targetInput.brand);
  const brandPositions = containsPhrase(titleTokens, brandTokens);
  if (!brandPositions) return rejectTitle(["TITLE_BRAND_NOT_FOUND"]);

  const brandStart = brandPositions[0];
  const prefix = titleTokens.slice(0, brandStart);
  evidence.brandStartIndex = brandStart;
  evidence.prefixTokens = [...prefix];
  if (!validBrandPrefix(prefix)) return rejectTitle(["TITLE_PREFIX_NOT_ALLOWED"]);
  if (candidateOuterPackCount !== targetOuterPackCount) {
    return rejectTitle(["OUTER_PACK_COUNT_MISMATCH"]);
  }

  const afterBrand = titleTokens.slice(brandStart + brandTokens.length);
  const targetIdentityTokens = [
    ...orderedTokens(targetInput.productLine),
    ...orderedTokens(targetInput.flavor),
    ...orderedTokens(targetInput.form),
    ...explicitModifierTokens(targetInput),
  ];
  const requiredTargetTokens = [...new Set(targetIdentityTokens.filter((token) =>
    !TITLE_NEUTRAL.has(token) &&
    !isQuantityOrMeasurementToken(token),
  ))].sort();
  evidence.requiredTargetTokens = requiredTargetTokens;
  if (!requiredTargetTokens.length) {
    return rejectTitle(["TITLE_IDENTITY_EVIDENCE_INSUFFICIENT"]);
  }

  // Modifier detection runs on the post-brand title so brands such as "Bud
  // Light" cannot accidentally turn `light` into a product modifier.
  const candidateModifierEvidence = knownModifierKeysAndConsumed(afterBrand);
  const knownModifierKeys = new Set(KNOWN_MODIFIERS.map((definition) => definition.key));
  const targetKnownModifiers = normalizedTarget.modifierKeys.filter((key) => knownModifierKeys.has(key));
  const originalIsRequiredFlavor = orderedTokens(targetInput.flavor).includes("original");
  const candidateKnownModifiers = candidateModifierEvidence.keys
    .filter((key) => !(key === "original" && originalIsRequiredFlavor))
    .sort();
  if (!sameTokenSet([...targetKnownModifiers].sort(), candidateKnownModifiers)) {
    return rejectTitle(["MODIFIER_MISMATCH"]);
  }

  const afterBrandSet = new Set(afterBrand);
  evidence.missingTargetTokens = requiredTargetTokens.filter((token) => !afterBrandSet.has(token));
  if (evidence.missingTargetTokens.length) {
    return rejectTitle(["TITLE_TARGET_TOKEN_MISSING"]);
  }

  const expected = new Set(requiredTargetTokens);
  evidence.unexplainedCandidateTokens = [...new Set(afterBrand.filter((token, index) =>
    !expected.has(token) &&
    !TITLE_NEUTRAL.has(token) &&
    !isQuantityOrMeasurementToken(token) &&
    !candidateModifierEvidence.consumed.has(index) &&
    !titleOuterPack.consumed.has(brandStart + brandTokens.length + index),
  ))].sort();
  if (evidence.unexplainedCandidateTokens.length) {
    return rejectTitle(["TITLE_UNEXPLAINED_CANDIDATE_TOKEN"]);
  }

  // All copied structured fields have just been proven by exact whole-word
  // evidence above. `size` remains absent so normalizeProduct derives it from
  // the raw candidate title rather than trusting the target size.
  const provenCandidate: CanonicalProductIdentity = {
    brand: candidateBrand,
    productLine: targetInput.productLine,
    flavor: targetInput.flavor,
    modifiers: targetInput.modifiers,
    form: targetInput.form,
    outerPackCount: candidateOuterPackCount,
    size: null,
    title,
  };
  const matched = matchCanonicalProduct(effectiveTargetInput, provenCandidate);
  if (matched.verdict === "SIBLING_ESTIMATE") {
    return {
      ...matched,
      verdict: "REJECT",
      reasonCodes: [...new Set([...matched.reasonCodes, "TITLE_SIBLING_INFERENCE_FORBIDDEN" as const])],
      titleEvidence: evidence,
    };
  }
  return {
    ...matched,
    reasonCodes: matched.verdict === "REJECT"
      ? matched.reasonCodes
      : [...new Set([...matched.reasonCodes, "TITLE_FALLBACK_IDENTITY_PROVEN" as const])],
    titleEvidence: evidence,
  };
}
