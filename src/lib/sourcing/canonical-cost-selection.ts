import {
  matchCanonicalProduct,
  matchCanonicalProductTitle,
  normalizeIdentityTokens,
  type CanonicalProductIdentity,
  type CanonicalProductMatchResult,
} from "./canonical-product-match";
import {
  evaluatePriceEvidenceEligibility,
  type PriceEvidenceDecision,
  type PriceEvidenceLocalityEvidence,
  type PriceEvidencePolicyOptions,
  type PriceEvidenceVia,
} from "./price-evidence-policy";

/**
 * Pure composition contract for choosing one procurement-price observation.
 *
 * The selector deliberately accepts the complete candidate set. It performs
 * identity matching and evidence-policy evaluation for every row before it
 * ranks anything, so an upstream SQL `LIMIT` cannot turn five cheap false
 * matches into the result while hiding a valid later candidate.
 */
export const CANONICAL_COST_SELECTOR_VERSION = "canonical-cost-selection/1.0.0" as const;

export type CanonicalCostMatchMode = "STRUCTURED" | "TITLE_BRIDGE";
export type CanonicalCostSelectionOutcome = "FACT" | "ESTIMATE" | "UNSOURCEABLE";
export type CanonicalCostSelectorEligibility = "FACT" | "ESTIMATE" | "REJECT";

export type CanonicalCostSelectorReasonCode =
  | "ELIGIBLE_FOR_RANKING"
  | "MATCH_REJECTED"
  | "PRICE_EVIDENCE_REJECTED"
  | "CROSS_SIZE_CONVERSION_UNAVAILABLE"
  | "CANONICAL_VARIANT_UNPROVEN"
  | "CANONICAL_VARIANT_MISMATCH";

export interface CanonicalCostCandidate {
  /** Stable identifiers are returned as provenance; neither is inferred. */
  donorOfferObservationId: string | null;
  donorOfferId: string | null;
  donorProductId: string | null;
  /** Immutable source identity attached by an exact alias decision. */
  canonicalVariantId?: string | null;
  variantDecisionId?: string | null;
  retailerProductId?: string | null;
  productUrl?: string | null;
  observedPrice?: number | null;
  packSizeSeen?: number | null;
  sellerName?: string | null;
  sourceApi?: string | null;
  /**
   * Structured donor identity. It is used only when it contains every
   * identity discriminator required by the target; otherwise the raw-title
   * bridge must independently prove the match.
   */
  donorIdentity?: CanonicalProductIdentity | null;
  rawTitle: string | null | undefined;
  rawBrand: string | null | undefined;
  retailer: string | null | undefined;
  via: PriceEvidenceVia | string | null | undefined;
  price: number | null | undefined;
  isFirstParty: boolean | null | undefined;
  inStock: boolean | null | undefined;
  zip: string | null | undefined;
  localityEvidence: PriceEvidenceLocalityEvidence | string | null | undefined;
  fetchedAt: string | Date | null | undefined;
}

export interface CanonicalCostConversion {
  kind: "NONE" | "CROSS_SIZE";
  observedPrice: number;
  /** Price normalized to one target purchase unit, before recipe quantity. */
  targetComparablePrice: number;
  /** target base amount / candidate base amount. */
  multiplier: number;
  targetBaseAmount: number | null;
  candidateBaseAmount: number | null;
  baseUnit: "g" | "ml" | "count" | null;
}

export interface CanonicalCostCandidateEvaluation {
  candidateIndex: number;
  candidate: CanonicalCostCandidate;
  selectorVersion: typeof CANONICAL_COST_SELECTOR_VERSION;
  matchMode: CanonicalCostMatchMode;
  /** Complete, versioned matcher provenance. */
  match: CanonicalProductMatchResult;
  /** Complete, versioned price-policy provenance. */
  priceEvidence: PriceEvidenceDecision;
  selectorEligibility: CanonicalCostSelectorEligibility;
  selectorReasonCodes: CanonicalCostSelectorReasonCode[];
  conversion: CanonicalCostConversion | null;
  /** Exact content truth is available only from a selected factual identity. */
  contentDonorProductId: string | null;
  /** FACT and typed ESTIMATE rows may both provide price evidence. */
  priceEvidenceDonorProductId: string | null;
}

export interface CanonicalCostSelection {
  selectorVersion: typeof CANONICAL_COST_SELECTOR_VERSION;
  outcome: CanonicalCostSelectionOutcome;
  selected: CanonicalCostCandidateEvaluation | null;
  targetComparablePrice: number | null;
  contentDonorProductId: string | null;
  priceEvidenceDonorProductId: string | null;
  evaluatedCandidateCount: number;
  eligibleFactCount: number;
  eligibleEstimateCount: number;
  /** Every input row, in input order, with semantic and policy provenance. */
  evaluations: CanonicalCostCandidateEvaluation[];
}

export interface CanonicalCostVariantContract {
  /**
   * When supplied, every usable price observation must have an immutable source
   * variant. A factual exact match must be the target variant; typed estimates
   * may intentionally price a different, explicitly identified variant.
   */
  targetCanonicalVariantId: string;
}

function nonEmptyText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExplicitModifiers(value: CanonicalProductIdentity["modifiers"]): boolean {
  if (Array.isArray(value)) return value.some((entry) => nonEmptyText(entry));
  return nonEmptyText(value as string | null | undefined);
}

function sameBrandEvidence(
  structuredBrand: string | null | undefined,
  rawBrand: string | null | undefined,
): boolean {
  if (!nonEmptyText(rawBrand)) return true;
  if (!nonEmptyText(structuredBrand)) return false;
  const structured = normalizeIdentityTokens(structuredBrand);
  const raw = normalizeIdentityTokens(rawBrand);
  return structured.length === raw.length && structured.every((token, index) => token === raw[index]);
}

/**
 * A partial structured object must never be completed by copying target fields.
 * If a target discriminator is asserted, the donor must assert it too. Missing
 * package size remains allowed because the canonical matcher has an explicit
 * SIZE_UNKNOWN estimate tier.
 */
function hasRequiredStructuredIdentity(
  target: CanonicalProductIdentity,
  candidate: CanonicalCostCandidate,
): candidate is CanonicalCostCandidate & { donorIdentity: CanonicalProductIdentity } {
  const identity = candidate.donorIdentity;
  if (!identity || !nonEmptyText(identity.brand)) return false;
  if (!sameBrandEvidence(identity.brand, candidate.rawBrand)) return false;

  const requiredFields: Array<keyof Pick<CanonicalProductIdentity, "productLine" | "flavor" | "form">> = [
    "productLine",
    "flavor",
    "form",
  ];
  for (const field of requiredFields) {
    if (nonEmptyText(target[field]) && !nonEmptyText(identity[field])) return false;
  }
  if (hasExplicitModifiers(target.modifiers) && !hasExplicitModifiers(identity.modifiers)) return false;

  // The matcher itself will reject an insufficient target. This gate only
  // determines whether candidate identity is structured enough to trust.
  return true;
}

function matchCandidate(
  target: CanonicalProductIdentity,
  candidate: CanonicalCostCandidate,
): { mode: CanonicalCostMatchMode; match: CanonicalProductMatchResult } {
  if (hasRequiredStructuredIdentity(target, candidate)) {
    return {
      mode: "STRUCTURED",
      match: matchCanonicalProduct(target, {
        ...candidate.donorIdentity,
        title: candidate.rawTitle ?? candidate.donorIdentity.title,
      }),
    };
  }

  return {
    mode: "TITLE_BRIDGE",
    match: matchCanonicalProductTitle(target, {
      title: candidate.rawTitle ?? candidate.donorIdentity?.title,
      brand: candidate.rawBrand ?? candidate.donorIdentity?.brand,
    }),
  };
}

function convertToTargetPrice(
  price: number | null | undefined,
  match: CanonicalProductMatchResult,
): CanonicalCostConversion | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;

  if (match.verdict !== "CROSS_SIZE_ESTIMATE") {
    return {
      kind: "NONE",
      observedPrice: price,
      targetComparablePrice: price,
      multiplier: 1,
      targetBaseAmount: match.normalized.target.size?.baseAmount ?? null,
      candidateBaseAmount: match.normalized.candidate.size?.baseAmount ?? null,
      baseUnit: match.normalized.target.size?.baseUnit ?? null,
    };
  }

  const targetSize = match.normalized.target.size;
  const candidateSize = match.normalized.candidate.size;
  if (
    !targetSize ||
    !candidateSize ||
    targetSize.dimension !== candidateSize.dimension ||
    targetSize.baseUnit !== candidateSize.baseUnit ||
    !Number.isFinite(targetSize.baseAmount) ||
    !Number.isFinite(candidateSize.baseAmount) ||
    targetSize.baseAmount <= 0 ||
    candidateSize.baseAmount <= 0
  ) {
    return null;
  }

  const multiplier = targetSize.baseAmount / candidateSize.baseAmount;
  const targetComparablePrice = price * multiplier;
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isFinite(targetComparablePrice)) {
    return null;
  }

  return {
    kind: "CROSS_SIZE",
    observedPrice: price,
    targetComparablePrice,
    multiplier,
    targetBaseAmount: targetSize.baseAmount,
    candidateBaseAmount: candidateSize.baseAmount,
    baseUnit: targetSize.baseUnit,
  };
}

function evaluateCandidate(
  target: CanonicalProductIdentity,
  candidate: CanonicalCostCandidate,
  candidateIndex: number,
  policy: PriceEvidencePolicyOptions,
  variantContract?: CanonicalCostVariantContract,
): CanonicalCostCandidateEvaluation {
  const matched = matchCandidate(target, candidate);
  const priceEvidence = evaluatePriceEvidenceEligibility({
    retailer: candidate.retailer,
    via: candidate.via,
    price: candidate.price,
    isFirstParty: candidate.isFirstParty,
    inStock: candidate.inStock,
    zip: candidate.zip,
    localityEvidence: candidate.localityEvidence,
    fetchedAt: candidate.fetchedAt,
    matchVerdict: matched.match.verdict,
  }, policy);

  const conversion = priceEvidence.eligibility === "REJECT"
    ? null
    : convertToTargetPrice(candidate.price, matched.match);
  const selectorReasonCodes: CanonicalCostSelectorReasonCode[] = [];
  let selectorEligibility: CanonicalCostSelectorEligibility = priceEvidence.eligibility;

  if (matched.match.verdict === "REJECT") selectorReasonCodes.push("MATCH_REJECTED");
  if (priceEvidence.eligibility === "REJECT") selectorReasonCodes.push("PRICE_EVIDENCE_REJECTED");
  if (priceEvidence.eligibility !== "REJECT" && !conversion) {
    selectorEligibility = "REJECT";
    selectorReasonCodes.push("CROSS_SIZE_CONVERSION_UNAVAILABLE");
  }
  if (variantContract && selectorEligibility !== "REJECT") {
    if (!nonEmptyText(candidate.canonicalVariantId) || !nonEmptyText(candidate.variantDecisionId)) {
      selectorEligibility = "REJECT";
      selectorReasonCodes.push("CANONICAL_VARIANT_UNPROVEN");
    } else if (
      selectorEligibility === "FACT"
      && candidate.canonicalVariantId !== variantContract.targetCanonicalVariantId
    ) {
      selectorEligibility = "REJECT";
      selectorReasonCodes.push("CANONICAL_VARIANT_MISMATCH");
    }
  }
  if (selectorEligibility !== "REJECT") selectorReasonCodes.push("ELIGIBLE_FOR_RANKING");

  // Content is deliberately stricter than identity alone: Instacart exact
  // observations are typed estimates by the price policy and cannot create a
  // content link. Cross-size, sibling, and size-unknown estimates are likewise
  // price-only evidence.
  const contentDonorProductId =
    selectorEligibility === "FACT" &&
    matched.match.verdict === "EXACT_IDENTITY"
      ? candidate.donorProductId
      : null;
  const priceEvidenceDonorProductId = selectorEligibility !== "REJECT"
    ? candidate.donorProductId
    : null;

  return {
    candidateIndex,
    candidate,
    selectorVersion: CANONICAL_COST_SELECTOR_VERSION,
    matchMode: matched.mode,
    match: matched.match,
    priceEvidence,
    selectorEligibility,
    selectorReasonCodes,
    conversion,
    contentDonorProductId,
    priceEvidenceDonorProductId,
  };
}

function stableEvidenceCompare(
  left: CanonicalCostCandidateEvaluation,
  right: CanonicalCostCandidateEvaluation,
): number {
  const leftPrice = left.conversion?.targetComparablePrice ?? Number.POSITIVE_INFINITY;
  const rightPrice = right.conversion?.targetComparablePrice ?? Number.POSITIVE_INFINITY;
  if (leftPrice !== rightPrice) return leftPrice - rightPrice;

  // At the same price, prefer the fresher observation, then stable source IDs.
  const leftAge = left.priceEvidence.ageMs ?? Number.POSITIVE_INFINITY;
  const rightAge = right.priceEvidence.ageMs ?? Number.POSITIVE_INFINITY;
  if (leftAge !== rightAge) return leftAge - rightAge;
  const offerOrder = String(left.candidate.donorOfferId ?? "").localeCompare(
    String(right.candidate.donorOfferId ?? ""),
  );
  if (offerOrder !== 0) return offerOrder;
  const productOrder = String(left.candidate.donorProductId ?? "").localeCompare(
    String(right.candidate.donorProductId ?? ""),
  );
  return productOrder || left.candidateIndex - right.candidateIndex;
}

/**
 * Select the cheapest eligible factual price. Only when no FACT exists may a
 * typed estimate win. Every candidate is evaluated before these arrays are
 * filtered or sorted.
 */
export function selectCanonicalCostEvidence(
  target: CanonicalProductIdentity,
  candidates: readonly CanonicalCostCandidate[],
  policy: PriceEvidencePolicyOptions,
  variantContract?: CanonicalCostVariantContract,
): CanonicalCostSelection {
  const evaluations = candidates.map((candidate, index) =>
    evaluateCandidate(target, candidate, index, policy, variantContract));
  const facts = evaluations
    .filter((evaluation) => evaluation.selectorEligibility === "FACT")
    .sort(stableEvidenceCompare);
  const estimates = evaluations
    .filter((evaluation) => evaluation.selectorEligibility === "ESTIMATE")
    .sort(stableEvidenceCompare);
  const selected = facts[0] ?? estimates[0] ?? null;
  const outcome: CanonicalCostSelectionOutcome = facts.length
    ? "FACT"
    : estimates.length
      ? "ESTIMATE"
      : "UNSOURCEABLE";

  return {
    selectorVersion: CANONICAL_COST_SELECTOR_VERSION,
    outcome,
    selected,
    targetComparablePrice: selected?.conversion?.targetComparablePrice ?? null,
    contentDonorProductId: selected?.contentDonorProductId ?? null,
    priceEvidenceDonorProductId: selected?.priceEvidenceDonorProductId ?? null,
    evaluatedCandidateCount: evaluations.length,
    eligibleFactCount: facts.length,
    eligibleEstimateCount: estimates.length,
    evaluations,
  };
}
