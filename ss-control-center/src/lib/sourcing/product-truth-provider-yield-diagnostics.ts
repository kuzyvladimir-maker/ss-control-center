import {
  type CanonicalProduct,
  isFirstParty,
  type ScoredOffer,
} from "./retail-fetch";
import type { CanonicalProductMatchResult } from "./canonical-product-match";
import {
  evaluatePriceEvidenceEligibility,
  type PriceEvidenceDecision,
} from "./price-evidence-policy";
import { productTruthOperationalSha256 } from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_VERSION =
  "product-truth-provider-yield-diagnostics/1.0.0" as const;

export const PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY = Object.freeze({
  maxSources: 8,
  maxCandidatesPerSource: 20,
  maxCandidatesTotal: 60,
  maxSerializedBytes: 256_000,
  maxQueryChars: 500,
  maxTitleChars: 500,
  maxUrlChars: 1_500,
  maxDetailChars: 240,
} as const);

export type ProductTruthProviderAdmissionReason =
  | "ADMITTED"
  | "SCORE_REJECTED"
  | "RETAILER_PRODUCT_ID_MISSING"
  | "SOURCE_UNAVAILABLE"
  | "NON_BASE_UNIT_NON_CLUB"
  | "NON_GROCERY_DETERMINISTIC"
  | "NON_GROCERY_CLASSIFIER";

export interface ProductTruthProviderAdmissionDecision {
  verdict: "ADMIT" | "REJECT";
  reasonCode: ProductTruthProviderAdmissionReason;
}

export interface ProductTruthProviderYieldSourceInput {
  source: string;
  status: "completed" | "content_only" | "unavailable" | "failed";
  detail?: string;
  candidates: readonly {
    offer: ScoredOffer;
    admission: ProductTruthProviderAdmissionDecision;
  }[];
}

type DiagnosticIdentityMatch = {
  verdict: string;
  matcherVersion: string;
  reasonCodes: string[];
  normalized: CanonicalProductMatchResult["normalized"];
  sizeRatioCandidateToTarget: number | null;
  titleEvidence: {
    brandStartIndex: number | null;
    prefixTokens: string[];
    requiredTargetTokens: string[];
    missingTargetTokens: string[];
    unexplainedCandidateTokens: string[];
    targetOuterPackCount: number;
    candidateOuterPackCount: number | null;
  } | null;
};

export interface ProductTruthProviderYieldCandidateDiagnostic {
  providerOrdinal: number;
  retailer: string;
  retailerProductId: string | null;
  sourceApi: string;
  via: "direct" | "instacart";
  title: string | null;
  brand: string | null;
  identityEvidenceTitle: string | null;
  identityEvidenceNormalization: string | null;
  price: number | null;
  currency: string;
  inStock: boolean | null;
  productUrl: string | null;
  zip: string | null;
  localityEvidence: string | null;
  observedAt: string;
  sellerName: string | null;
  isMarketplaceItem: boolean | null;
  packSizeSeen: number | null;
  meteredReceiptId: string | null;
  meteredRunId: string | null;
  meteredApprovalId: string | null;
  score: {
    accepted: boolean;
    rejectReason: string | null;
    isBaseUnit: boolean;
  };
  identityMatch: DiagnosticIdentityMatch | null;
  priceEvidence: PriceEvidenceDecision;
  admission: ProductTruthProviderAdmissionDecision;
}

export interface ProductTruthProviderYieldDiagnostics {
  schemaVersion: typeof PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_VERSION;
  policy: typeof PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY;
  query: string;
  evaluatedAt: string;
  target: {
    brand: string | null;
    productLine: string | null;
    flavor: string | null;
    modifiers: string[];
    form: string | null;
    size: string | null;
    outerPackCount: number | null;
  };
  totals: {
    sourcesObserved: number;
    sourcesRecorded: number;
    parsedCandidates: number;
    recordedCandidates: number;
    truncatedCandidates: number;
  };
  sources: Array<{
    sourceOrdinal: number;
    source: string;
    status: ProductTruthProviderYieldSourceInput["status"];
    detail: string | null;
    parsedCandidateCount: number;
    recordedCandidateCount: number;
    truncatedCandidateCount: number;
    candidates: ProductTruthProviderYieldCandidateDiagnostic[];
  }>;
  diagnosticsSha256: string;
}

export class ProductTruthProviderYieldPersistenceError extends Error {
  readonly diagnostics: ProductTruthProviderYieldDiagnostics;

  constructor(
    message: string,
    diagnostics: ProductTruthProviderYieldDiagnostics,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "ProductTruthProviderYieldPersistenceError";
    this.diagnostics = diagnostics;
  }
}

export function providerYieldDiagnosticsFromError(
  value: unknown,
): ProductTruthProviderYieldDiagnostics | null {
  return value instanceof ProductTruthProviderYieldPersistenceError
    ? value.diagnostics
    : null;
}

function clipped(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxChars);
}

function secretSafeDetail(value: unknown): string | null {
  const raw = clipped(value, PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxDetailChars);
  if (!raw) return null;
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[-_ ]?key|authorization|auth[-_ ]?token|access[-_ ]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
}

function safeUrl(value: unknown): string | null {
  const raw = clipped(value, PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxUrlChars);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api.?key|auth|token|password|secret|signature)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString().slice(0, PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxUrlChars);
  } catch {
    return null;
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalModifiers(value: CanonicalProduct["modifiers"]): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((item) => clipped(item, 120))
    .filter((item): item is string => item !== null)
    .slice(0, 20);
}

function identityMatch(
  value: ScoredOffer["identityMatch"],
): DiagnosticIdentityMatch | null {
  if (!value) return null;
  return {
    verdict: value.verdict,
    matcherVersion: value.matcherVersion,
    reasonCodes: [...value.reasonCodes],
    normalized: value.normalized,
    sizeRatioCandidateToTarget: finiteOrNull(value.sizeRatioCandidateToTarget),
    titleEvidence: value.titleEvidence ? {
      brandStartIndex: finiteOrNull(value.titleEvidence.brandStartIndex),
      prefixTokens: [...value.titleEvidence.prefixTokens],
      requiredTargetTokens: [...value.titleEvidence.requiredTargetTokens],
      missingTargetTokens: [...value.titleEvidence.missingTargetTokens],
      unexplainedCandidateTokens: [...value.titleEvidence.unexplainedCandidateTokens],
      targetOuterPackCount: value.titleEvidence.targetOuterPackCount,
      candidateOuterPackCount: finiteOrNull(value.titleEvidence.candidateOuterPackCount),
    } : null,
  };
}

function candidateDiagnostic(
  offer: ScoredOffer,
  admission: ProductTruthProviderAdmissionDecision,
  providerOrdinal: number,
  evaluatedAt: string,
): ProductTruthProviderYieldCandidateDiagnostic {
  return {
    providerOrdinal,
    retailer: clipped(offer.retailer, 120) ?? "",
    retailerProductId: clipped(offer.retailerProductId, 240),
    sourceApi: clipped(offer.sourceApi, 120) ?? "",
    via: offer.via === "instacart" ? "instacart" : "direct",
    title: clipped(
      offer.title,
      PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxTitleChars,
    ),
    brand: clipped(offer.brand, 240),
    identityEvidenceTitle: clipped(
      offer.identityEvidenceTitle,
      PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxTitleChars,
    ),
    identityEvidenceNormalization: clipped(offer.identityEvidenceNormalization, 160),
    price: finiteOrNull(offer.price),
    currency: clipped(offer.currency, 16) ?? "",
    inStock: typeof offer.inStock === "boolean" ? offer.inStock : null,
    productUrl: safeUrl(offer.productUrl),
    zip: clipped(offer.zip, 20),
    localityEvidence: clipped(offer.localityEvidence, 80),
    observedAt: clipped(offer.observedAt, 80) ?? "",
    sellerName: clipped(offer.sellerName, 240),
    isMarketplaceItem:
      typeof offer.isMarketplaceItem === "boolean" ? offer.isMarketplaceItem : null,
    packSizeSeen: finiteOrNull(offer.packSizeSeen),
    meteredReceiptId: clipped(offer.meteredReceiptId, 240),
    meteredRunId: clipped(offer.meteredRunId, 240),
    meteredApprovalId: clipped(offer.meteredApprovalId, 240),
    score: {
      accepted: offer.accepted,
      rejectReason: clipped(offer.rejectReason, 500),
      isBaseUnit: offer.isBaseUnit,
    },
    identityMatch: identityMatch(offer.identityMatch),
    priceEvidence: evaluatePriceEvidenceEligibility({
      retailer: offer.retailer,
      via: offer.via ?? "direct",
      price: offer.price,
      isFirstParty: isFirstParty(offer),
      inStock: offer.inStock,
      zip: offer.zip,
      localityEvidence: offer.localityEvidence,
      fetchedAt: offer.observedAt,
      matchVerdict: offer.identityMatch?.verdict ?? null,
    }, {
      now: evaluatedAt,
      maxAgeMs: 48 * 60 * 60 * 1000,
    }),
    admission,
  };
}

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function buildProductTruthProviderYieldDiagnostics(input: {
  query: string;
  evaluatedAt: string;
  target: CanonicalProduct;
  sources: readonly ProductTruthProviderYieldSourceInput[];
}): ProductTruthProviderYieldDiagnostics {
  const observedSources = input.sources.slice(
    0,
    PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxSources,
  );
  let remainingCandidates = PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxCandidatesTotal;
  const sources = observedSources.map((source, sourceOrdinal) => {
    const take = Math.min(
      source.candidates.length,
      PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxCandidatesPerSource,
      remainingCandidates,
    );
    remainingCandidates -= take;
    return {
      sourceOrdinal,
      source: clipped(source.source, 160) ?? "",
      status: source.status,
      detail: secretSafeDetail(source.detail),
      parsedCandidateCount: source.candidates.length,
      recordedCandidateCount: take,
      truncatedCandidateCount: source.candidates.length - take,
      candidates: source.candidates
        .slice(0, take)
        .map((candidate, providerOrdinal) => candidateDiagnostic(
          candidate.offer,
          candidate.admission,
          providerOrdinal,
          input.evaluatedAt,
        )),
    };
  });
  const parsedCandidates = input.sources.reduce(
    (sum, source) => sum + source.candidates.length,
    0,
  );
  const base = {
    schemaVersion: PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_VERSION,
    policy: PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY,
    query: clipped(
      input.query,
      PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxQueryChars,
    ) ?? "",
    evaluatedAt: clipped(input.evaluatedAt, 80) ?? "",
    target: {
      brand: clipped(input.target.brand, 240),
      productLine: clipped(input.target.product_line, 300),
      flavor: clipped(input.target.flavor, 240),
      modifiers: canonicalModifiers(input.target.modifiers),
      form: clipped(input.target.container_type ?? input.target.base_unit, 160),
      size: clipped(input.target.size, 120),
      outerPackCount: finiteOrNull(input.target.outer_pack_count),
    },
    totals: {
      sourcesObserved: input.sources.length,
      sourcesRecorded: sources.length,
      parsedCandidates,
      recordedCandidates: sources.reduce(
        (sum, source) => sum + source.recordedCandidateCount,
        0,
      ),
      truncatedCandidates:
        parsedCandidates - sources.reduce(
          (sum, source) => sum + source.recordedCandidateCount,
          0,
        ),
    },
    sources,
  };

  while (
    payloadBytes(base) + 100
      > PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_POLICY.maxSerializedBytes
  ) {
    const source = [...base.sources].reverse().find((item) => item.candidates.length > 0);
    if (!source) break;
    source.candidates.pop();
    source.recordedCandidateCount--;
    source.truncatedCandidateCount++;
    base.totals.recordedCandidates--;
    base.totals.truncatedCandidates++;
  }

  return {
    ...base,
    diagnosticsSha256: productTruthOperationalSha256(base),
  };
}

export function assertProductTruthProviderYieldDiagnostics(
  value: ProductTruthProviderYieldDiagnostics,
): ProductTruthProviderYieldDiagnostics {
  if (value.schemaVersion !== PRODUCT_TRUTH_PROVIDER_YIELD_DIAGNOSTICS_VERSION) {
    throw new Error("PROVIDER_YIELD_DIAGNOSTICS_VERSION_INVALID");
  }
  const { diagnosticsSha256, ...payload } = value;
  if (productTruthOperationalSha256(payload) !== diagnosticsSha256) {
    throw new Error("PROVIDER_YIELD_DIAGNOSTICS_HASH_MISMATCH");
  }
  return value;
}
