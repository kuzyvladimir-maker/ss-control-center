import type { CanonicalMatchVerdict } from "./canonical-product-match";

/**
 * Pure eligibility policy for procurement price evidence.
 *
 * The policy deliberately knows nothing about databases, APIs, environment
 * variables, or current wall-clock time. Callers must pass an explicit `now`
 * and freshness limit so the same observation always produces the same result.
 */
export const PRICE_EVIDENCE_POLICY_VERSION = "price-evidence-eligibility/1.0.0" as const;
export const PRODUCT_TRUTH_PROCUREMENT_ZIP = "33765" as const;

export type PriceEvidenceEligibility = "FACT" | "ESTIMATE" | "REJECT";
export type PriceEvidenceVia = "direct" | "instacart";
export type RetailerLocality = "LOCAL" | "NATIONAL" | "UNKNOWN";
export type PriceEvidenceLocalityEvidence =
  | "zip_scoped"
  | "store_scoped"
  | "national_unscoped";

export type PriceEvidenceReasonCode =
  | "POLICY_NOW_INVALID"
  | "POLICY_MAX_AGE_INVALID"
  | "PRICE_MISSING"
  | "PRICE_NOT_FINITE"
  | "PRICE_NOT_POSITIVE"
  | "RETAILER_MISSING"
  | "RETAILER_UNRECOGNIZED"
  | "VIA_MISSING"
  | "VIA_UNSUPPORTED"
  | "FIRST_PARTY_UNPROVEN"
  | "FIRST_PARTY_FALSE"
  | "OUT_OF_STOCK"
  | "STOCK_UNKNOWN"
  | "FETCHED_AT_MISSING"
  | "FETCHED_AT_INVALID"
  | "FETCHED_AT_IN_FUTURE"
  | "EVIDENCE_STALE"
  | "LOCAL_ZIP_MISSING"
  | "LOCAL_ZIP_INVALID"
  | "LOCAL_ZIP_MISMATCH"
  | "LOCALITY_SCOPE_UNPROVEN"
  | "LOCALITY_EVIDENCE_UNSUPPORTED"
  | "LOCALITY_SCOPE_MISMATCH"
  | "MATCH_REJECTED"
  | "MATCH_VERDICT_UNSUPPORTED"
  | "EXACT_IDENTITY_DIRECT_FACT"
  | "CROSS_SIZE_ESTIMATE"
  | "SIBLING_ESTIMATE"
  | "SIZE_UNKNOWN_ESTIMATE"
  | "INSTACART_ESTIMATE";

export interface PriceEvidenceCandidate {
  retailer: string | null | undefined;
  via: PriceEvidenceVia | string | null | undefined;
  price: number | null | undefined;
  isFirstParty: boolean | null | undefined;
  inStock: boolean | null | undefined;
  zip: string | null | undefined;
  /** How the source proved that price and stock apply to this locality. */
  localityEvidence: PriceEvidenceLocalityEvidence | string | null | undefined;
  fetchedAt: string | Date | null | undefined;
  matchVerdict: CanonicalMatchVerdict | string | null | undefined;
}

export interface PriceEvidencePolicyOptions {
  /** Explicit evaluation time. Zoned ISO timestamp or valid Date only. */
  now: string | Date;
  /** Maximum observation age; the boundary itself remains fresh. */
  maxAgeMs: number;
}

export interface PriceEvidenceDecision {
  eligibility: PriceEvidenceEligibility;
  policyVersion: typeof PRICE_EVIDENCE_POLICY_VERSION;
  reasonCodes: PriceEvidenceReasonCode[];
  retailerKey: string | null;
  retailerLocality: RetailerLocality;
  localityEvidence: PriceEvidenceLocalityEvidence | null;
  normalizedZip: string | null;
  requiredZip: typeof PRODUCT_TRUTH_PROCUREMENT_ZIP | null;
  /** Null when either timestamp is invalid or missing. */
  ageMs: number | null;
  maxAgeMs: number;
  matchVerdict: string | null;
}

type RetailerClassification = {
  key: string | null;
  locality: RetailerLocality;
};

/**
 * Every physical retailer currently used by Product Truth is local for
 * procurement purposes. An offer from one of these chains is not eligible
 * without proof that its price and stock refer to Clearwater ZIP 33765.
 *
 * Unknown retailers are intentionally not assumed to be national. Adding a new
 * source requires a reviewed, versioned policy change instead of silently
 * bypassing locality proof.
 */
const LOCAL_RETAILER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  walmart: "walmart",
  walmartcom: "walmart",
  target: "target",
  targetcom: "target",
  sams: "samsclub",
  samsclub: "samsclub",
  samsclubcom: "samsclub",
  costco: "costco",
  costcocom: "costco",
  bjs: "bjs",
  bjswholesaleclub: "bjs",
  bjscom: "bjs",
  publix: "publix",
  publixsupermarket: "publix",
  publixsupermarkets: "publix",
  aldi: "aldi",
  aldius: "aldi",
  winndixie: "winndixie",
  bravo: "bravo",
  bravosupermarket: "bravo",
  bravosupermarkets: "bravo",
  restaurantdepot: "restaurantdepot",
  wholefoods: "wholefoods",
  wholefoodsmarket: "wholefoods",
  traderjoes: "traderjoes",
  thefreshmarket: "freshmarket",
  freshmarket: "freshmarket",
  sprouts: "sprouts",
  sproutsfarmersmarket: "sprouts",
});

const NATIONAL_RETAILER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  amazon: "amazon",
  amazoncom: "amazon",
});

const SUPPORTED_MATCH_VERDICTS = new Set<CanonicalMatchVerdict>([
  "EXACT_IDENTITY",
  "CROSS_SIZE_ESTIMATE",
  "SIBLING_ESTIMATE",
  "SIZE_UNKNOWN_ESTIMATE",
  "REJECT",
]);

const SUPPORTED_LOCALITY_EVIDENCE = new Set<PriceEvidenceLocalityEvidence>([
  "zip_scoped",
  "store_scoped",
  "national_unscoped",
]);

function normalizeRetailerAlias(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function classifyPriceEvidenceRetailer(
  retailer: string | null | undefined,
): RetailerClassification {
  if (typeof retailer !== "string" || !retailer.trim()) {
    return { key: null, locality: "UNKNOWN" };
  }

  const alias = normalizeRetailerAlias(retailer);
  const localKey = LOCAL_RETAILER_ALIASES[alias];
  if (localKey) return { key: localKey, locality: "LOCAL" };

  const nationalKey = NATIONAL_RETAILER_ALIASES[alias];
  if (nationalKey) return { key: nationalKey, locality: "NATIONAL" };

  return { key: null, locality: "UNKNOWN" };
}

function parseZonedInstant(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;

  // A timezone is mandatory. Parsing a local timestamp would make this pure
  // decision depend on the server's timezone.
  const normalized = value.trim();
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(normalized)) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizeZip(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match = /^(\d{5})(?:-\d{4})?$/.exec(normalized);
  return match?.[1] ?? null;
}

function addReason(
  reasons: PriceEvidenceReasonCode[],
  reason: PriceEvidenceReasonCode,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Classifies one observed retailer price as factual cost evidence, typed
 * estimate, or unusable evidence.
 *
 * FACT requires all of the following: exact identity, direct observation,
 * explicit first-party proof, explicit in-stock proof, a positive price,
 * fresh timestamp, and correct locality. Estimates must pass the same evidence
 * quality gates; only matcher tier or Instacart prevents them from being facts.
 */
export function evaluatePriceEvidenceEligibility(
  candidate: PriceEvidenceCandidate,
  options: PriceEvidencePolicyOptions,
): PriceEvidenceDecision {
  const reasons: PriceEvidenceReasonCode[] = [];
  const retailer = classifyPriceEvidenceRetailer(candidate.retailer);
  const normalizedZip = normalizeZip(candidate.zip);
  const nowMs = parseZonedInstant(options.now);
  const fetchedAtMs = parseZonedInstant(candidate.fetchedAt);
  const maxAgeValid = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0;
  const rawMatchVerdict =
    typeof candidate.matchVerdict === "string" ? candidate.matchVerdict : null;
  const via =
    typeof candidate.via === "string" ? candidate.via.trim().toLowerCase() : "";
  const rawLocalityEvidence =
    typeof candidate.localityEvidence === "string"
      ? candidate.localityEvidence.trim().toLowerCase()
      : "";
  const localityEvidence = SUPPORTED_LOCALITY_EVIDENCE.has(
    rawLocalityEvidence as PriceEvidenceLocalityEvidence,
  )
    ? (rawLocalityEvidence as PriceEvidenceLocalityEvidence)
    : null;

  if (nowMs === null) addReason(reasons, "POLICY_NOW_INVALID");
  if (!maxAgeValid) addReason(reasons, "POLICY_MAX_AGE_INVALID");

  if (candidate.price === null || candidate.price === undefined) {
    addReason(reasons, "PRICE_MISSING");
  } else if (typeof candidate.price !== "number" || !Number.isFinite(candidate.price)) {
    addReason(reasons, "PRICE_NOT_FINITE");
  } else if (candidate.price <= 0) {
    addReason(reasons, "PRICE_NOT_POSITIVE");
  }

  if (typeof candidate.retailer !== "string" || !candidate.retailer.trim()) {
    addReason(reasons, "RETAILER_MISSING");
  } else if (retailer.locality === "UNKNOWN") {
    addReason(reasons, "RETAILER_UNRECOGNIZED");
  }

  if (!via) {
    addReason(reasons, "VIA_MISSING");
  } else if (via !== "direct" && via !== "instacart") {
    addReason(reasons, "VIA_UNSUPPORTED");
  }

  if (candidate.isFirstParty === false) {
    addReason(reasons, "FIRST_PARTY_FALSE");
  } else if (candidate.isFirstParty !== true) {
    addReason(reasons, "FIRST_PARTY_UNPROVEN");
  }

  if (candidate.inStock === false) {
    addReason(reasons, "OUT_OF_STOCK");
  } else if (candidate.inStock !== true) {
    addReason(reasons, "STOCK_UNKNOWN");
  }

  if (candidate.fetchedAt === null || candidate.fetchedAt === undefined || candidate.fetchedAt === "") {
    addReason(reasons, "FETCHED_AT_MISSING");
  } else if (fetchedAtMs === null) {
    addReason(reasons, "FETCHED_AT_INVALID");
  }

  let ageMs: number | null = null;
  if (nowMs !== null && fetchedAtMs !== null) {
    ageMs = nowMs - fetchedAtMs;
    if (ageMs < 0) {
      addReason(reasons, "FETCHED_AT_IN_FUTURE");
    } else if (maxAgeValid && ageMs > options.maxAgeMs) {
      addReason(reasons, "EVIDENCE_STALE");
    }
  }

  if (retailer.locality === "LOCAL") {
    if (candidate.zip === null || candidate.zip === undefined || candidate.zip === "") {
      addReason(reasons, "LOCAL_ZIP_MISSING");
    } else if (normalizedZip === null) {
      addReason(reasons, "LOCAL_ZIP_INVALID");
    } else if (normalizedZip !== PRODUCT_TRUTH_PROCUREMENT_ZIP) {
      addReason(reasons, "LOCAL_ZIP_MISMATCH");
    }
  }

  // A ZIP value copied into a row is not proof that the observed price/stock was
  // actually scoped to that ZIP or one of its stores. Scope provenance is a
  // separate mandatory signal for both local and national observations.
  if (!rawLocalityEvidence) {
    addReason(reasons, "LOCALITY_SCOPE_UNPROVEN");
  } else if (localityEvidence === null) {
    addReason(reasons, "LOCALITY_EVIDENCE_UNSUPPORTED");
  } else if (
    retailer.locality === "LOCAL" &&
    localityEvidence !== "zip_scoped" &&
    localityEvidence !== "store_scoped"
  ) {
    addReason(reasons, "LOCALITY_SCOPE_MISMATCH");
  } else if (
    retailer.locality === "NATIONAL" &&
    localityEvidence !== "national_unscoped"
  ) {
    addReason(reasons, "LOCALITY_SCOPE_MISMATCH");
  }

  if (!rawMatchVerdict || !SUPPORTED_MATCH_VERDICTS.has(rawMatchVerdict as CanonicalMatchVerdict)) {
    addReason(reasons, "MATCH_VERDICT_UNSUPPORTED");
  } else if (rawMatchVerdict === "REJECT") {
    addReason(reasons, "MATCH_REJECTED");
  }

  if (reasons.length > 0) {
    return {
      eligibility: "REJECT",
      policyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      reasonCodes: reasons,
      retailerKey: retailer.key,
      retailerLocality: retailer.locality,
      localityEvidence,
      normalizedZip,
      requiredZip: retailer.locality === "LOCAL" ? PRODUCT_TRUTH_PROCUREMENT_ZIP : null,
      ageMs,
      maxAgeMs: options.maxAgeMs,
      matchVerdict: rawMatchVerdict,
    };
  }

  const estimateReasons: PriceEvidenceReasonCode[] = [];
  if (rawMatchVerdict === "CROSS_SIZE_ESTIMATE") {
    addReason(estimateReasons, "CROSS_SIZE_ESTIMATE");
  } else if (rawMatchVerdict === "SIBLING_ESTIMATE") {
    addReason(estimateReasons, "SIBLING_ESTIMATE");
  } else if (rawMatchVerdict === "SIZE_UNKNOWN_ESTIMATE") {
    addReason(estimateReasons, "SIZE_UNKNOWN_ESTIMATE");
  }
  if (via === "instacart") addReason(estimateReasons, "INSTACART_ESTIMATE");

  const eligibility: PriceEvidenceEligibility = estimateReasons.length ? "ESTIMATE" : "FACT";
  const reasonCodes = estimateReasons.length
    ? estimateReasons
    : (["EXACT_IDENTITY_DIRECT_FACT"] as PriceEvidenceReasonCode[]);

  return {
    eligibility,
    policyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    reasonCodes,
    retailerKey: retailer.key,
    retailerLocality: retailer.locality,
    localityEvidence,
    normalizedZip,
    requiredZip: retailer.locality === "LOCAL" ? PRODUCT_TRUTH_PROCUREMENT_ZIP : null,
    ageMs,
    maxAgeMs: options.maxAgeMs,
    matchVerdict: rawMatchVerdict,
  };
}
