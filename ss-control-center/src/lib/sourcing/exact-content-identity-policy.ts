import {
  matchCanonicalProductTitle,
  type CanonicalProductIdentity,
  type CanonicalProductMatchResult,
  type CanonicalProductTitleCandidate,
} from "./canonical-product-match";

export const EXACT_CONTENT_IDENTITY_POLICY_VERSION =
  "exact-content-identity-policy/1.0.0" as const;

export type ExactContentIdentityBlocker =
  | "MATCH_NOT_EXACT"
  | "PACKAGE_SIZE_UNPROVEN"
  | "SAME_UNIT_PRINTED_AMOUNT_MISMATCH"
  | "UNIT_CONVERSION_NOT_EQUIVALENT";

export interface ExactContentTitleIdentityDecision {
  policyVersion: typeof EXACT_CONTENT_IDENTITY_POLICY_VERSION;
  eligible: boolean;
  blockers: ExactContentIdentityBlocker[];
  match: CanonicalProductMatchResult;
}

/**
 * Exact content identity is intentionally stricter than price comparability.
 * Same-unit printed amounts must be equal; conversion tolerance is reserved
 * for labels such as 1 lb and 454 g that describe one physical package.
 */
export function evaluateExactContentTitleIdentity(input: {
  target: CanonicalProductIdentity;
  candidate: CanonicalProductTitleCandidate;
}): ExactContentTitleIdentityDecision {
  const match = matchCanonicalProductTitle(input.target, input.candidate);
  const blockers: ExactContentIdentityBlocker[] = [];
  if (match.verdict !== "EXACT_IDENTITY") {
    blockers.push("MATCH_NOT_EXACT");
  }
  const targetSize = match.normalized.target.size;
  const candidateSize = match.normalized.candidate.size;
  if (!targetSize || !candidateSize) {
    blockers.push("PACKAGE_SIZE_UNPROVEN");
  } else if (
    targetSize.unit === candidateSize.unit
    && targetSize.amount !== candidateSize.amount
  ) {
    blockers.push("SAME_UNIT_PRINTED_AMOUNT_MISMATCH");
  } else if (
    targetSize.unit !== candidateSize.unit
    && !match.reasonCodes.includes("SIZE_EQUIVALENT_CONVERSION")
  ) {
    blockers.push("UNIT_CONVERSION_NOT_EQUIVALENT");
  }
  return {
    policyVersion: EXACT_CONTENT_IDENTITY_POLICY_VERSION,
    eligible: blockers.length === 0,
    blockers,
    match,
  };
}
