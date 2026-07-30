import {
  normalizeIdentityTokens,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  evaluateExactContentTitleIdentity,
  type ExactContentTitleIdentityDecision,
} from "./exact-content-identity-policy";

export const LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION =
  "legacy-catalog-recovery-identity/1.0.0" as const;

export type LegacyCatalogRecoveryIdentityMethod =
  | "STRICT_SOURCE_BRAND"
  | "TARGET_BRAND_PROVEN_IN_TITLE"
  | "CONTROLLED_PRESENTATION_TOKENS"
  | "TARGET_BRAND_AND_CONTROLLED_PRESENTATION_TOKENS"
  | "REJECT";

export interface LegacyCatalogRecoveryIdentityDecision {
  policyVersion: typeof LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION;
  eligible: boolean;
  method: LegacyCatalogRecoveryIdentityMethod;
  sourceBrand: string;
  evaluatedBrand: string;
  sourceBrandMatchesTarget: boolean;
  controlledPresentationTokens: string[];
  blockers: string[];
  sourceBrandDecision: ExactContentTitleIdentityDecision;
  contentIdentityDecision: ExactContentTitleIdentityDecision;
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((token, index) => token === right[index]);
}

function orderedTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function containsPhrase(
  tokens: readonly string[],
  phrase: readonly string[],
): boolean {
  if (!phrase.length || phrase.length > tokens.length) return false;
  for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
    if (phrase.every((token, offset) => tokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

function controlledPresentationTokens(input: {
  target: CanonicalProductIdentity;
  title: string;
  decision: ExactContentTitleIdentityDecision;
}): string[] | null {
  const { match } = input.decision;
  if (
    input.decision.blockers.length !== 1
    || input.decision.blockers[0] !== "MATCH_NOT_EXACT"
    || match.verdict !== "REJECT"
    || match.reasonCodes.length !== 1
    || match.reasonCodes[0] !== "TITLE_UNEXPLAINED_CANDIDATE_TOKEN"
    || (match.titleEvidence?.missingTargetTokens.length ?? 0) !== 0
  ) {
    return null;
  }
  const unexplained = match.titleEvidence?.unexplainedCandidateTokens ?? [];
  if (!unexplained.length) return null;

  const titleTokens = orderedTokens(input.title);
  const targetForm = new Set(normalizeIdentityTokens(input.target.form));
  const allowed = new Set<string>();

  // Morphological packaging descriptor. The exact target still has to prove
  // the explicit `can` form and the same printed package size.
  if (targetForm.has("can")) allowed.add("canned");

  // These are presentation/storage/marketing claims, not flavor or formula.
  // They are admitted only as complete phrases present in the source title.
  if (containsPhrase(titleTokens, ["shelf", "stable"])) {
    allowed.add("shelf");
    allowed.add("stable");
  }
  if (containsPhrase(titleTokens, ["non", "gmo"])) {
    allowed.add("non");
    allowed.add("gmo");
  }
  if (containsPhrase(titleTokens, ["keto", "friendly"])) {
    allowed.add("keto");
    allowed.add("friendly");
  }

  // Retailer bread titles often repeat the category around an already exact
  // loaf identity. This rule never applies to buns, rolls, bags or boxes.
  if (targetForm.has("loaf")) allowed.add("bread");

  return unexplained.every((token) => allowed.has(token))
    ? [...unexplained].sort()
    : null;
}

/**
 * Conservative recovery for source-specific legacy catalog metadata.
 *
 * The canonical matcher is not weakened. A bad `DonorProduct.brand` may be
 * bypassed only when the unchanged title itself proves the exact target brand
 * phrase and all remaining strict identity/pack/size gates pass. The only
 * additional automatic allowance is a closed list of presentation tokens
 * after the strict matcher has already proved every target token, modifier,
 * outer pack and exact content package size.
 */
export function evaluateLegacyCatalogRecoveryIdentity(input: {
  target: CanonicalProductIdentity;
  donor: {
    title: string;
    brand: string;
  };
}): LegacyCatalogRecoveryIdentityDecision {
  const sourceBrand = String(input.donor.brand ?? "").trim();
  const targetBrand = String(input.target.brand ?? "").trim();
  const sourceBrandDecision = evaluateExactContentTitleIdentity({
    target: input.target,
    candidate: {
      title: input.donor.title,
      brand: sourceBrand,
    },
  });
  const sourceBrandMatchesTarget = sameTokens(
    normalizeIdentityTokens(sourceBrand),
    normalizeIdentityTokens(targetBrand),
  );
  const contentIdentityDecision = sourceBrandMatchesTarget
    ? sourceBrandDecision
    : evaluateExactContentTitleIdentity({
      target: input.target,
      candidate: {
        title: input.donor.title,
        // This does not trust or rewrite the source field. The title bridge
        // must independently find the exact target brand phrase in the title.
        brand: targetBrand,
      },
    });

  if (contentIdentityDecision.eligible) {
    return {
      policyVersion: LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
      eligible: true,
      method: sourceBrandMatchesTarget
        ? "STRICT_SOURCE_BRAND"
        : "TARGET_BRAND_PROVEN_IN_TITLE",
      sourceBrand,
      evaluatedBrand: sourceBrandMatchesTarget ? sourceBrand : targetBrand,
      sourceBrandMatchesTarget,
      controlledPresentationTokens: [],
      blockers: [],
      sourceBrandDecision,
      contentIdentityDecision,
    };
  }

  const presentationTokens = controlledPresentationTokens({
    target: input.target,
    title: input.donor.title,
    decision: contentIdentityDecision,
  });
  if (presentationTokens) {
    return {
      policyVersion: LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
      eligible: true,
      method: sourceBrandMatchesTarget
        ? "CONTROLLED_PRESENTATION_TOKENS"
        : "TARGET_BRAND_AND_CONTROLLED_PRESENTATION_TOKENS",
      sourceBrand,
      evaluatedBrand: sourceBrandMatchesTarget ? sourceBrand : targetBrand,
      sourceBrandMatchesTarget,
      controlledPresentationTokens: presentationTokens,
      blockers: [],
      sourceBrandDecision,
      contentIdentityDecision,
    };
  }

  return {
    policyVersion: LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
    eligible: false,
    method: "REJECT",
    sourceBrand,
    evaluatedBrand: sourceBrandMatchesTarget ? sourceBrand : targetBrand,
    sourceBrandMatchesTarget,
    controlledPresentationTokens: [],
    blockers: [
      ...contentIdentityDecision.blockers,
      ...contentIdentityDecision.match.reasonCodes,
    ],
    sourceBrandDecision,
    contentIdentityDecision,
  };
}
