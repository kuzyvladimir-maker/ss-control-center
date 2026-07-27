import { createHash, randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";

import {
  CANONICAL_TITLE_NEUTRAL_TOKENS,
  CANONICAL_PRODUCT_MATCHER_VERSION,
  matchCanonicalProductTitle,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import {
  harvestDonorDetail,
  parseSize,
  persistScoredDonorOffer,
  scoredDonorOfferCanonicalVariantId,
  type PersistScoredDonorOfferExactScope,
  type PersistScoredDonorOfferResult,
} from "./donor-catalog";
import { executeDonorHarvestCandidate } from "./donor-harvest-executor";
import { DONOR_HARVEST_BOOTSTRAP_FIELDS } from "./donor-harvest-seed-plan";
import {
  donorHarvestStateId,
  getDonorHarvestState,
  persistDonorHarvestTransition,
  seedDonorHarvestState,
  type StoredDonorHarvestState,
} from "./donor-harvest-store";
import { normalizeEnrichmentTarget } from "./enrichment-queue";
import { ensureMeteredProviderBudget } from "./metered-budget-store";
import {
  readProductTruthOperationalLedger,
  type ProductTruthOperationalLedgerSnapshot,
  type ProductTruthOperationalMeteredReceipt,
} from "./product-truth-operational-ledger";
import {
  acquireProductTruthOperationalRunLease,
  finishProductTruthOperationalRun,
  getProductTruthOperationalRun,
  listProductTruthOperationalEvents,
  reapExpiredProductTruthTargetedEvidenceRun,
  seedProductTruthTargetedEvidenceControlRun,
  type ProductTruthOperationalEnvironment,
} from "./product-truth-operational-run-store";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
  type ValidatedProductTruthOperationalApproval,
} from "./product-truth-operational-run-contract";
import { readWalmartPilotCandidate } from "./product-truth-new-sku-view";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "./product-truth-read-contract-version";
import {
  CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
  buildCanonicalProductVariantKey,
  type CanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION,
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION,
  PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_RESULT_VERSION,
  buildProductTruthTargetedWalmartLegacySnapshot,
  canonicalIdentityFromTarget,
  normalizeExactWalmartProductUrl,
  parseProductTruthTargetedWalmartDonorSnapshot,
  parseProductTruthTargetedWalmartEvidencePlan,
  targetedWalmartDonorSnapshotSha256,
  type ProductTruthTargetedWalmartDonorSnapshot,
  type ProductTruthTargetedWalmartEvidencePlan,
  type ProductTruthTargetedWalmartEvidenceTarget,
} from "./product-truth-targeted-walmart-evidence-contract";
import { oxylabsWalmartSearch } from "./oxylabs-fetch";
import {
  scoreOffer,
  type CanonicalProduct,
  type RetailOffer,
  type ScoredOffer,
} from "./retail-fetch";

export const PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REPORT_VERSION =
  "product-truth-targeted-walmart-evidence-report/1.0.0" as const;

const LEASE_MS = 4 * 60 * 1_000;
const JOB_SOURCE_PREFIX = "product-truth-targeted-walmart-evidence";
const REQUESTED_FIELDS = ["content", "offers"] as const;

export interface ProductTruthTargetedEvidenceRuntimeProbe {
  targetFingerprint: string;
  engineReleaseSha256: string;
  schemaFingerprintSha256: string;
  migrationSetSha256: string;
  canonicalMigrationsApplied: boolean;
}

export interface ProductTruthTargetedWalmartSearchResult {
  offers: RetailOffer[];
  localityProven: boolean;
  responseZip: string | null;
  trialExhausted: boolean;
}

export interface ProductTruthTargetedWalmartEvidenceAdapter {
  probeRuntime(): Promise<ProductTruthTargetedEvidenceRuntimeProbe>;
  search(query: string): Promise<ProductTruthTargetedWalmartSearchResult>;
  persistOffer(
    db: Client,
    offer: ScoredOffer,
    target: CanonicalProduct,
    processingNow: string,
    options: { exactScope: PersistScoredDonorOfferExactScope },
  ): Promise<PersistScoredDonorOfferResult>;
  harvest(
    db: Client,
    input: Parameters<typeof executeDonorHarvestCandidate>[0],
  ): ReturnType<typeof executeDonorHarvestCandidate>;
  readCandidate(
    db: Client,
    input: Parameters<typeof readWalmartPilotCandidate>[1],
  ): ReturnType<typeof readWalmartPilotCandidate>;
}

export interface ProductTruthTargetedWalmartEvidenceReport {
  schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REPORT_VERSION;
  resultContractVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_RESULT_VERSION;
  runId: string;
  approvalId: string;
  planSha256: string;
  targetFingerprint: string;
  donorProductId: string;
  donorOfferId: string;
  canonicalVariantId: string;
  retailerProductId: string;
  outcome: "COMPLETED" | "BLOCKED" | "AMBIGUOUS" | "FAILED" | "INTERRUPTED";
  reason: string;
  generatedAt: string;
  candidate: null | {
    contentObservationId: string;
    priceObservationId: string;
    imageCount: number;
    observedPrice: number;
  };
  job: ProductTruthTargetedEvidenceJobInspection | null;
  ledger: ProductTruthOperationalLedgerSnapshot;
  claims: ProductTruthTargetedWalmartEvidencePlan["claims"];
  next_command: null;
}

export interface ProductTruthTargetedEvidenceJobInspection {
  id: string;
  status: string;
  attempts: number;
  runId: string | null;
  approvalId: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  terminalReason: string | null;
  checkpoint: unknown;
  result: unknown;
  error: string | null;
}

export interface ExecuteProductTruthTargetedWalmartEvidenceInput {
  plan: ProductTruthTargetedWalmartEvidencePlan;
  planSha256: string;
  validatedApproval: ValidatedProductTruthOperationalApproval;
  environment: ProductTruthOperationalEnvironment;
  command: "execute" | "resume";
  leaseOwner: string;
  meteredDatabase: { url: string; authToken?: string; targetFingerprint: string };
  artifactWriter: (
    report: ProductTruthTargetedWalmartEvidenceReport,
  ) => Promise<{ reportSha256: string; artifactIndexSha256: string }>;
  adapter: ProductTruthTargetedWalmartEvidenceAdapter;
  now?: () => string;
  monotonicNow?: () => number;
}

export interface ProductTruthTargetedWalmartEvidenceExecutionResult {
  schemaVersion: typeof PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_RESULT_VERSION;
  runId: string;
  status: "completed" | "blocked" | "ambiguous" | "failed" | "interrupted";
  outcome: ProductTruthTargetedWalmartEvidenceReport["outcome"];
  reason: string;
  reportSha256: string;
  artifactIndexSha256: string;
  next_command: null;
}

export class ProductTruthTargetedWalmartEvidenceError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthTargetedWalmartEvidenceError";
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthTargetedWalmartEvidenceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function canonicalNow(now: () => string): string {
  const value = now();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("TARGETED_EVIDENCE_CLOCK_INVALID", "clock returned an invalid timestamp");
  return new Date(milliseconds).toISOString();
}

function assertBeforeDeadline(at: string, deadlineAt: string, boundary: string): void {
  if (Date.parse(at) >= Date.parse(deadlineAt)) {
    fail(
      "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED",
      `${boundary} reached sealed deadline ${deadlineAt}`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function exactDonorSnapshotFromTarget(
  target: ProductTruthTargetedWalmartEvidenceTarget,
): ProductTruthTargetedWalmartDonorSnapshot {
  return parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: target.identityMode,
    identityDerivationVersion: target.identityDerivationVersion,
    donorProductId: target.donorProductId,
    donorOfferId: target.donorOfferId,
    donorIdentityStatus: target.donorIdentityStatus,
    variantDecisionId: target.variantDecisionId,
    canonicalVariantId: target.canonicalVariantId,
    decisionStatus: target.decisionStatus,
    matcherVersion: target.matcherVersion,
    matcherImplementationSha256: target.matcherImplementationSha256,
    matcherReleaseSha256: target.matcherReleaseSha256,
    decisionEvidenceHash: target.decisionEvidenceHash,
    decisionEvidenceJson: target.decisionEvidenceJson,
    canonicalVariantKeyVersion: target.canonicalVariantKeyVersion,
    canonicalIdentityHash: target.canonicalIdentityHash,
    canonicalIdentityJson: target.canonicalIdentityJson,
    retailer: target.retailer,
    retailerProductId: target.retailerProductId,
    normalizedProductUrl: target.normalizedProductUrl,
    via: target.via,
    isFirstParty: target.isFirstParty,
    legacySnapshot: target.legacySnapshot,
  });
}

function parseJsonOrNull(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function canonicalProductFromTarget(target: ProductTruthTargetedWalmartEvidenceTarget): CanonicalProduct {
  const identity = canonicalIdentityFromTarget(target);
  return {
    brand: identity.brand ?? undefined,
    product_line: identity.productLine ?? undefined,
    flavor: identity.flavor ?? undefined,
    modifiers: identity.modifiers ?? undefined,
    container_type: identity.form ?? undefined,
    base_unit: identity.form ?? undefined,
    size: identity.size ?? undefined,
    outer_pack_count: identity.outerPackCount ?? undefined,
    retail_search_query: target.query,
  };
}

/** Filter all provider rows before the one permitted catalog write. */
export function selectExactTargetedWalmartOffer(input: {
  result: ProductTruthTargetedWalmartSearchResult;
  target: ProductTruthTargetedWalmartEvidenceTarget;
}): ScoredOffer {
  if (
    input.result.trialExhausted
    || !input.result.localityProven
    || input.result.responseZip !== "33765"
  ) {
    fail("TARGETED_WALMART_LOCALITY_UNPROVEN", "Oxylabs did not prove Walmart ZIP 33765");
  }
  const canonicalIdentity: CanonicalProductIdentity = canonicalIdentityFromTarget(input.target);
  const canonicalProduct = canonicalProductFromTarget(input.target);
  const matches: ScoredOffer[] = [];
  for (const offer of input.result.offers) {
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeExactWalmartProductUrl(
        offer.productUrl,
        input.target.retailerProductId,
      );
    } catch {
      continue;
    }
    const titleMatch = matchCanonicalProductTitle(canonicalIdentity, {
      title: offer.title,
    });
    const scored = scoreOffer(offer, canonicalProduct);
    if (
      offer.retailer === "walmart"
      && offer.retailerProductId === input.target.retailerProductId
      && normalizedUrl === input.target.normalizedProductUrl
      && offer.sourceApi === "oxylabs"
      && (offer.via ?? "direct") === "direct"
      && offer.sellerName === "Walmart.com"
      && offer.isMarketplaceItem === false
      && offer.zip === "33765"
      && offer.localityEvidence === "zip_scoped"
      && offer.inStock === true
      && offer.packSizeSeen === 1
      && typeof offer.price === "number"
      && Number.isFinite(offer.price)
      && offer.price > 0
      && offer.currency === "USD"
      && titleMatch.verdict === "EXACT_IDENTITY"
      && scored.accepted
      && scored.isBaseUnit
      && scored.identityMatch?.verdict === "EXACT_IDENTITY"
      && scoredDonorOfferCanonicalVariantId(scored) === input.target.canonicalVariantId
      && Boolean(scored.meteredReceiptId && scored.meteredRunId && scored.meteredApprovalId)
    ) {
      matches.push(scored);
    }
  }
  if (matches.length !== 1) {
    fail(
      matches.length === 0
        ? "TARGETED_WALMART_EXACT_OFFER_MISSING"
        : "TARGETED_WALMART_EXACT_OFFER_AMBIGUOUS",
      `expected exactly one exact Walmart item; found ${matches.length}`,
    );
  }
  return matches[0]!;
}

export async function readTargetedWalmartDonorSnapshot(
  db: Client,
  donorProductId: string,
): Promise<ProductTruthTargetedWalmartDonorSnapshot> {
  const result = await db.execute({
    sql: `SELECT product.id AS donorProductId,
                 product.identityStatus AS donorIdentityStatus,
                 decision.id AS variantDecisionId,
                 decision.canonicalVariantId,
                 decision.decisionStatus,
                 decision.matcherVersion,
                 decision.matcherImplementationSha256,
                 decision.matcherReleaseSha256,
                 decision.evidenceHash AS decisionEvidenceHash,
                 decision.evidenceJson AS decisionEvidenceJson,
                 variant.keyVersion AS canonicalVariantKeyVersion,
                 variant.identityHash AS canonicalIdentityHash,
                 variant.identityJson AS canonicalIdentityJson,
                 offer.id AS donorOfferId,
                 offer.retailer,
                 offer.retailerProductId,
                 offer.productUrl,
                 offer.via,
                 offer.isFirstParty
          FROM "DonorProduct" product
          JOIN "DonorProductVariantDecision" decision
            ON decision.donorProductId=product.id
           AND decision.decisionStatus='exact_confirmed'
          JOIN "CanonicalProductVariant" variant
            ON variant.id=decision.canonicalVariantId
          JOIN "DonorOffer" offer
            ON offer.donorProductId=product.id
           AND offer.retailer='walmart'
           AND offer.via='direct'
           AND offer.isFirstParty=1
           AND offer.sellerName='Walmart.com'
           AND offer.packSizeSeen=1
          WHERE product.id=?
          ORDER BY decision.id,offer.id`,
    args: [donorProductId],
  });
  if (result.rows.length !== 1) {
    fail("TARGETED_EVIDENCE_DONOR_GRAPH_AMBIGUOUS", `expected one exact donor/decision/Walmart offer row; found ${result.rows.length}`);
  }
  const row = result.rows[0]!;
  return parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "EXISTING_EXACT",
    identityDerivationVersion: null,
    donorProductId: String(row.donorProductId),
    donorOfferId: String(row.donorOfferId),
    donorIdentityStatus: row.donorIdentityStatus,
    variantDecisionId: String(row.variantDecisionId),
    canonicalVariantId: String(row.canonicalVariantId),
    decisionStatus: row.decisionStatus,
    matcherVersion: row.matcherVersion,
    matcherImplementationSha256: row.matcherImplementationSha256,
    matcherReleaseSha256: row.matcherReleaseSha256,
    decisionEvidenceHash: row.decisionEvidenceHash,
    decisionEvidenceJson: row.decisionEvidenceJson,
    canonicalVariantKeyVersion: String(row.canonicalVariantKeyVersion),
    canonicalIdentityHash: String(row.canonicalIdentityHash),
    canonicalIdentityJson: String(row.canonicalIdentityJson),
    retailer: row.retailer,
    retailerProductId: String(row.retailerProductId),
    normalizedProductUrl: normalizeExactWalmartProductUrl(
      row.productUrl,
      String(row.retailerProductId),
    ),
    via: row.via,
    isFirstParty: Number(row.isFirstParty) === 1,
    legacySnapshot: null,
  });
}

function canonicalDbRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === "bigint") {
      const number = Number(value);
      return [key, Number.isSafeInteger(number) ? number : value.toString()];
    }
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) return [key, value];
    fail("TARGETED_EVIDENCE_LEGACY_ROW_TYPE_INVALID", `${key} has unsupported DB type`);
  }));
}

function exactTrimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed === value ? trimmed : null;
}

function orderedIdentityTokens(value: string): string[] {
  return value
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

const LEGACY_TITLE_MEASURE =
  /\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ounce|ounces|lb|lbs|pound|pounds|kg|kgs|g|gram|grams|ml|l|liter|liters|litre|litres|ct|count|counts)\b/gi;
const LEGACY_NEUTRAL_TOKENS = new Set<string>(CANONICAL_TITLE_NEUTRAL_TOKENS);

/**
 * Deterministically derives a conservative identity proposal from the sealed
 * legacy donor row. The complete post-brand title signature is kept as the
 * product-line discriminator, so uncertainty produces a false reject rather
 * than silently collapsing adjacent flavors/forms. A fresh exact Walmart
 * search must still prove this identity before any canonical row is written.
 */
export function deriveTargetedWalmartLegacyCanonicalIdentity(input: {
  donorProductRow: Record<string, unknown>;
  donorOfferRow: Record<string, unknown>;
}): CanonicalProductVariantKey {
  const brand = exactTrimmedText(input.donorProductRow.brand);
  const title = exactTrimmedText(input.donorProductRow.title);
  const explicitSize = exactTrimmedText(input.donorProductRow.size);
  const parsedSize = parseSize(title).size;
  const size = explicitSize ?? parsedSize;
  if (!brand || !title || !size) {
    fail(
      "TARGETED_EVIDENCE_MACHINE_IDENTITY_INCOMPLETE",
      "legacy donor must contain exact brand, title and parseable size",
    );
  }
  if (
    input.donorOfferRow.retailer !== "walmart"
    || input.donorOfferRow.via !== "direct"
    || Number(input.donorOfferRow.isFirstParty) !== 1
    || input.donorOfferRow.sellerName !== "Walmart.com"
    || Number(input.donorOfferRow.packSizeSeen) !== 1
  ) {
    fail(
      "TARGETED_EVIDENCE_MACHINE_IDENTITY_SOURCE_INVALID",
      "identity derivation requires one direct base-unit Walmart.com offer",
    );
  }

  const brandTokens = orderedIdentityTokens(brand);
  const withoutMeasure = title.replace(LEGACY_TITLE_MEASURE, " ");
  const titleTokens = orderedIdentityTokens(withoutMeasure);
  if (
    brandTokens.length === 0
    || titleTokens.length <= brandTokens.length
    || brandTokens.some((token, index) => titleTokens[index] !== token)
  ) {
    fail(
      "TARGETED_EVIDENCE_MACHINE_IDENTITY_BRAND_MISMATCH",
      "legacy title must start with the exact donor brand",
    );
  }
  const discriminatorTokens = titleTokens
    .slice(brandTokens.length)
    .filter((token) => !LEGACY_NEUTRAL_TOKENS.has(token) && !/^\d+$/.test(token));
  if (discriminatorTokens.length === 0) {
    fail(
      "TARGETED_EVIDENCE_MACHINE_IDENTITY_DISCRIMINATOR_MISSING",
      "legacy title has no conservative post-brand identity signature",
    );
  }

  let canonical: CanonicalProductVariantKey;
  try {
    canonical = buildCanonicalProductVariantKey({
      brand,
      productLine: discriminatorTokens.join(" "),
      flavor: null,
      modifiers: [],
      form: null,
      size,
      outerPackCount: 1,
    });
  } catch (error) {
    fail(
      "TARGETED_EVIDENCE_MACHINE_IDENTITY_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  const exactTitleProof = matchCanonicalProductTitle(
    {
      brand: canonical.normalized.brand,
      productLine: canonical.normalized.productLine,
      flavor: canonical.normalized.flavor,
      modifiers: canonical.normalized.modifiers,
      form: canonical.normalized.form,
      size: `${canonical.normalized.size.baseAmount} ${canonical.normalized.size.baseUnit}`,
      outerPackCount: 1,
    },
    { title },
  );
  if (exactTitleProof.verdict !== "EXACT_IDENTITY") {
    fail(
      "TARGETED_EVIDENCE_MACHINE_IDENTITY_TITLE_NOT_EXACT",
      exactTitleProof.reasonCodes.join(",") || exactTitleProof.verdict,
    );
  }
  return canonical;
}

/** Read-only evidence-verified bootstrap capture. No canonical row is created here. */
export async function readTargetedWalmartLegacyDonorSnapshot(
  db: Client,
  donorProductId: string,
): Promise<ProductTruthTargetedWalmartDonorSnapshot> {
  const products = await db.execute({
    sql: `SELECT * FROM "DonorProduct" WHERE id=?`,
    args: [donorProductId],
  });
  if (products.rows.length !== 1) {
    fail("TARGETED_EVIDENCE_LEGACY_DONOR_MISSING", `expected one legacy donor row; found ${products.rows.length}`);
  }
  const offers = await db.execute({
    sql: `SELECT * FROM "DonorOffer"
          WHERE donorProductId=? AND retailer='walmart' AND via='direct' AND isFirstParty=1
          ORDER BY id`,
    args: [donorProductId],
  });
  if (offers.rows.length !== 1) {
    fail(
      "TARGETED_EVIDENCE_LEGACY_WALMART_OFFER_AMBIGUOUS",
      `expected one direct first-party Walmart offer; found ${offers.rows.length}`,
    );
  }
  const decisions = await db.execute({
    sql: `SELECT id FROM "DonorProductVariantDecision" WHERE donorProductId=?`,
    args: [donorProductId],
  });
  if (decisions.rows.length !== 0) {
    fail("TARGETED_EVIDENCE_BOOTSTRAP_DECISION_NOT_ABSENT", "bootstrap donor already owns a canonical decision");
  }
  const product = canonicalDbRow(products.rows[0] as Record<string, unknown>);
  const offer = canonicalDbRow(offers.rows[0] as Record<string, unknown>);
  const derivedIdentity = deriveTargetedWalmartLegacyCanonicalIdentity({
    donorProductRow: product,
    donorOfferRow: offer,
  });
  const canonicalIdentityJson = derivedIdentity.identityJson;
  const identityHash = derivedIdentity.identityHash;
  const canonicalVariantId = derivedIdentity.canonicalVariantId;
  const variants = await db.execute({
    sql: `SELECT id FROM "CanonicalProductVariant"
          WHERE id=? OR variantKey=? OR identityHash=?`,
    args: [canonicalVariantId, canonicalVariantId, identityHash],
  });
  if (variants.rows.length !== 0) {
    fail(
      "TARGETED_EVIDENCE_BOOTSTRAP_VARIANT_NOT_ABSENT",
      "evidence-verified bootstrap requires its expected canonical variant to be absent",
    );
  }
  const retailerProductId = String(offer.retailerProductId ?? "");
  return parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "EVIDENCE_VERIFIED_BOOTSTRAP",
    identityDerivationVersion:
      PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION,
    donorProductId,
    donorOfferId: String(offer.id ?? ""),
    donorIdentityStatus: product.identityStatus,
    variantDecisionId: null,
    canonicalVariantId,
    decisionStatus: null,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    decisionEvidenceHash: null,
    decisionEvidenceJson: null,
    canonicalVariantKeyVersion: CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
    canonicalIdentityHash: identityHash,
    canonicalIdentityJson,
    retailer: "walmart",
    retailerProductId,
    normalizedProductUrl: normalizeExactWalmartProductUrl(
      offer.productUrl,
      retailerProductId,
    ),
    via: "direct",
    isFirstParty: true,
    legacySnapshot: buildProductTruthTargetedWalmartLegacySnapshot({
      donorProductRow: product,
      donorOfferRow: offer,
    }),
  });
}

async function assertRuntimeBindings(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  adapter: ProductTruthTargetedWalmartEvidenceAdapter;
  phase?: "PRE_PROMOTION" | "POST_PROMOTION";
  approvalId?: string;
}): Promise<void> {
  const target = input.plan.targets[0];
  if (target.identityMode === "EXISTING_EXACT") {
    const stored = await readTargetedWalmartDonorSnapshot(input.db, target.donorProductId);
    if (
      targetedWalmartDonorSnapshotSha256(stored) !== target.donorSnapshotSha256
      || renderProductTruthOperationalJson(stored)
        !== renderProductTruthOperationalJson(exactDonorSnapshotFromTarget(target))
    ) {
      fail("TARGETED_EVIDENCE_DONOR_DRIFT", "donor/offer/decision graph differs from sealed plan");
    }
  } else if ((input.phase ?? "PRE_PROMOTION") === "PRE_PROMOTION") {
    const stored = await readTargetedWalmartLegacyDonorSnapshot(
      input.db,
      target.donorProductId,
    );
    if (
      targetedWalmartDonorSnapshotSha256(stored) !== target.donorSnapshotSha256
      || renderProductTruthOperationalJson(stored)
        !== renderProductTruthOperationalJson(exactDonorSnapshotFromTarget(target))
    ) {
      fail(
        "TARGETED_EVIDENCE_LEGACY_SNAPSHOT_DRIFT",
        "legacy donor/offer full-row bytes or canonical absence differ from sealed plan",
      );
    }
  } else {
    if (!input.approvalId) {
      fail("TARGETED_EVIDENCE_APPROVAL_REQUIRED", "post-promotion binding requires approvalId");
    }
    const stored = await readTargetedWalmartDonorSnapshot(input.db, target.donorProductId);
    const decisions = await input.db.execute({
      sql: `SELECT id,canonicalVariantId,decisionStatus,matcherVersion,
                   matcherImplementationSha256,matcherReleaseSha256,
                   evidenceHash,evidenceJson,runId,approvalId
            FROM "DonorProductVariantDecision" WHERE donorProductId=? ORDER BY id`,
      args: [target.donorProductId],
    });
    const decision = decisions.rows[0];
    if (
      decisions.rows.length !== 1
      || !decision
      || String(decision.id) !== stored.variantDecisionId
      || String(decision.canonicalVariantId) !== target.canonicalVariantId
      || decision.decisionStatus !== "exact_confirmed"
      || decision.matcherVersion !== target.matcherVersion
      || decision.matcherImplementationSha256 !== target.matcherImplementationSha256
      || decision.matcherReleaseSha256 !== target.matcherReleaseSha256
      || decision.evidenceHash !== stored.decisionEvidenceHash
      || decision.evidenceJson !== stored.decisionEvidenceJson
      || decision.runId !== input.plan.runId
      || decision.approvalId !== input.approvalId
      || stored.donorProductId !== target.donorProductId
      || stored.donorOfferId !== target.donorOfferId
      || stored.canonicalVariantId !== target.canonicalVariantId
      || stored.canonicalIdentityHash !== target.canonicalIdentityHash
      || stored.canonicalIdentityJson !== target.canonicalIdentityJson
      || stored.canonicalVariantKeyVersion !== target.canonicalVariantKeyVersion
      || stored.retailerProductId !== target.retailerProductId
      || stored.normalizedProductUrl !== target.normalizedProductUrl
      || stored.via !== "direct"
      || stored.isFirstParty !== true
    ) {
      fail(
        "TARGETED_EVIDENCE_BOOTSTRAP_PROMOTION_DRIFT",
        "promoted exact alias differs from the owner-bound canonical target",
      );
    }
  }

  // Validate the immutable donor/decision bytes before crossing any adapter or
  // provider boundary. A forged evidence hash must consume zero external work.
  const probe = await input.adapter.probeRuntime();
  if (
    probe.targetFingerprint !== input.plan.targetFingerprint
    || probe.engineReleaseSha256 !== input.plan.engineReleaseSha256
    || probe.schemaFingerprintSha256 !== input.plan.schemaFingerprintSha256
    || probe.migrationSetSha256 !== input.plan.migrationSetSha256
    || probe.canonicalMigrationsApplied !== true
  ) {
    fail("TARGETED_EVIDENCE_RUNTIME_DRIFT", "DB/schema/migration/source release differs from sealed plan");
  }
}

async function runtimeVariantDecisionId(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  approvalId: string;
}): Promise<string | null> {
  const target = input.plan.targets[0];
  if (target.identityMode === "EXISTING_EXACT") return target.variantDecisionId;
  const rows = await input.db.execute({
    sql: `SELECT id,canonicalVariantId,decisionStatus,matcherVersion,
                 matcherImplementationSha256,matcherReleaseSha256,runId,approvalId
          FROM "DonorProductVariantDecision" WHERE donorProductId=? ORDER BY id`,
    args: [target.donorProductId],
  });
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0];
  if (
    rows.rows.length !== 1
    || row?.canonicalVariantId !== target.canonicalVariantId
    || row?.decisionStatus !== "exact_confirmed"
    || row?.matcherVersion !== target.matcherVersion
    || row?.matcherImplementationSha256 !== target.matcherImplementationSha256
    || row?.matcherReleaseSha256 !== target.matcherReleaseSha256
    || row?.runId !== input.plan.runId
    || row?.approvalId !== input.approvalId
  ) {
    fail("TARGETED_EVIDENCE_BOOTSTRAP_DECISION_DRIFT", "bootstrap decision provenance differs from sealed run");
  }
  return String(row.id);
}

function targetedJobId(planSha256: string): string {
  return `ptej_${sha256(`targeted-walmart-evidence-job/1\n${planSha256}`)}`;
}

function targetedJobSource(planSha256: string): string {
  return `${JOB_SOURCE_PREFIX}:${planSha256}`;
}

function targetedJobIdempotencyKey(planSha256: string): string {
  return sha256(`targeted-walmart-evidence-job-idempotency/1\n${planSha256}`);
}

async function ensureTargetedJob(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  planSha256: string;
  approvalId: string;
  at: string;
}): Promise<ProductTruthTargetedEvidenceJobInspection> {
  const target = input.plan.targets[0].donorProductId;
  const normalizedTarget = normalizeEnrichmentTarget("product", target);
  const id = targetedJobId(input.planSha256);
  const idempotencyKey = targetedJobIdempotencyKey(input.planSha256);
  const requestedFields = JSON.stringify([...REQUESTED_FIELDS]);
  await input.db.execute({
    sql: `INSERT OR IGNORE INTO "EnrichmentJob"
          (id,targetType,target,normalizedTarget,listingKey,idempotencyKey,requestedFields,
           status,source,priority,requestedBy,attempts,runId,approvalId,
           estimatedSpendUnits,actualSpendUnits,nextEligibleAt,queuedAt,createdAt,updatedAt)
          VALUES (?,?,?,?,NULL,?,?,'queued',?,100,'owner-approved-targeted-evidence',0,?,?,3.5,0,?,?,?,?)`,
    args: [
      id, "product", target, normalizedTarget, idempotencyKey, requestedFields,
      targetedJobSource(input.planSha256), input.plan.runId, input.approvalId,
      input.at, input.at, input.at, input.at,
    ],
  });
  const owned = await input.db.execute({
    sql: `SELECT id,targetType,target,normalizedTarget,listingKey,idempotencyKey,
                 requestedFields,status,source,attempts,runId,approvalId,
                 leaseOwner,leaseToken,leaseExpiresAt,terminalReason,checkpoint,result,error
          FROM "EnrichmentJob" WHERE runId=? AND approvalId=? ORDER BY id`,
    args: [input.plan.runId, input.approvalId],
  });
  const row = owned.rows[0];
  if (
    owned.rows.length !== 1
    || !row
    || row.id !== id
    || row.targetType !== "product"
    || row.target !== target
    || row.normalizedTarget !== normalizedTarget
    || row.listingKey !== null
    || row.idempotencyKey !== idempotencyKey
    || row.requestedFields !== requestedFields
    || row.source !== targetedJobSource(input.planSha256)
    || row.runId !== input.plan.runId
    || row.approvalId !== input.approvalId
  ) {
    fail("TARGETED_EVIDENCE_JOB_CONFLICT", "durable product queue row differs from sealed plan");
  }
  return {
    id,
    status: String(row.status),
    attempts: Number(row.attempts),
    runId: row.runId == null ? null : String(row.runId),
    approvalId: row.approvalId == null ? null : String(row.approvalId),
    leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
    leaseToken: row.leaseToken == null ? null : String(row.leaseToken),
    leaseExpiresAt: row.leaseExpiresAt == null ? null : String(row.leaseExpiresAt),
    terminalReason: row.terminalReason == null ? null : String(row.terminalReason),
    checkpoint: parseJsonOrNull(row.checkpoint),
    result: parseJsonOrNull(row.result),
    error: row.error == null ? null : String(row.error),
  };
}

async function claimTargetedJob(input: {
  db: Client;
  job: ProductTruthTargetedEvidenceJobInspection;
  runId: string;
  approvalId: string;
  leaseOwner: string;
  at: string;
}): Promise<string> {
  const leaseToken = `pteq_${randomUUID()}`;
  const expiresAt = new Date(Date.parse(input.at) + LEASE_MS).toISOString();
  const resumingReleasedJob = input.job.status === "running" && input.job.attempts === 1;
  if (resumingReleasedJob && (
    input.job.leaseOwner !== null
    || input.job.leaseToken !== null
    || input.job.leaseExpiresAt !== null
  )) {
    fail("TARGETED_EVIDENCE_JOB_LEASE_CONFLICT", "running product job still owns another lease");
  }
  const updated = await input.db.execute(resumingReleasedJob ? {
    sql: `UPDATE "EnrichmentJob"
          SET leaseOwner=?,leaseToken=?,leaseExpiresAt=?,heartbeatAt=?,updatedAt=?
          WHERE id=? AND runId=? AND approvalId=? AND status='running' AND attempts=1
            AND leaseOwner IS NULL AND leaseToken IS NULL AND leaseExpiresAt IS NULL`,
    args: [
      input.leaseOwner, leaseToken, expiresAt, input.at, input.at,
      input.job.id, input.runId, input.approvalId,
    ],
  } : {
    sql: `UPDATE "EnrichmentJob"
          SET status='running',attempts=1,leaseOwner=?,leaseToken=?,leaseExpiresAt=?,
              heartbeatAt=?,startedAt=COALESCE(startedAt,?),updatedAt=?
          WHERE id=? AND runId=? AND approvalId=?
            AND status IN ('queued','retry_wait') AND attempts=0
            AND leaseOwner IS NULL AND leaseToken IS NULL`,
    args: [
      input.leaseOwner, leaseToken, expiresAt, input.at, input.at, input.at,
      input.job.id, input.runId, input.approvalId,
    ],
  });
  if (updated.rowsAffected !== 1) {
    fail("TARGETED_EVIDENCE_JOB_CAS_LOST", "could not claim exact product queue row");
  }
  return leaseToken;
}

async function writeJobCheckpoint(input: {
  db: Client;
  jobId: string;
  runId: string;
  approvalId: string;
  leaseToken: string;
  at: string;
  checkpoint: unknown;
}): Promise<void> {
  const updated = await input.db.execute({
    sql: `UPDATE "EnrichmentJob" SET checkpoint=?,heartbeatAt=?,updatedAt=?
          WHERE id=? AND runId=? AND approvalId=? AND status='running' AND attempts=1
            AND leaseToken=? AND julianday(leaseExpiresAt)>julianday(?)`,
    args: [
      renderProductTruthOperationalJson(input.checkpoint), input.at, input.at,
      input.jobId, input.runId, input.approvalId, input.leaseToken, input.at,
    ],
  });
  if (updated.rowsAffected !== 1) {
    fail("TARGETED_EVIDENCE_CHECKPOINT_WRITE_LOST", "exact queue checkpoint CAS was lost");
  }
}

async function releaseJobForInterruption(input: {
  db: Client;
  jobId: string;
  runId: string;
  approvalId: string;
  leaseToken: string;
  at: string;
}): Promise<void> {
  const updated = await input.db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET leaseOwner=NULL,leaseToken=NULL,leaseExpiresAt=NULL,heartbeatAt=?,updatedAt=?
          WHERE id=? AND runId=? AND approvalId=? AND status='running'
            AND attempts=1 AND leaseToken=?`,
    args: [
      input.at, input.at, input.jobId, input.runId, input.approvalId,
      input.leaseToken,
    ],
  });
  if (updated.rowsAffected !== 1) {
    fail("TARGETED_EVIDENCE_JOB_RELEASE_LOST", "product job lease changed during interruption");
  }
}

function targetedHarvestIdentity(plan: ProductTruthTargetedWalmartEvidencePlan) {
  return {
    donorProductId: plan.targets[0].donorProductId,
    source: "unwrangle:walmart",
    retailerProductId: plan.targets[0].retailerProductId,
  };
}

async function readTargetedHarvestState(
  db: Client,
  plan: ProductTruthTargetedWalmartEvidencePlan,
): Promise<StoredDonorHarvestState | null> {
  return getDonorHarvestState(db, donorHarvestStateId(targetedHarvestIdentity(plan)));
}

function assertTargetedHarvestStateCanCall(input: {
  state: StoredDonorHarvestState;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  approvalId: string;
}): void {
  const expectedFields = JSON.stringify([...DONOR_HARVEST_BOOTSTRAP_FIELDS]);
  const runOwned = input.state.runId === null || (
    input.state.runId === input.plan.runId
    && input.state.approvalId === input.approvalId
  );
  if (
    !runOwned
    || input.state.createdAt < input.plan.createdAt
    || input.state.attempts !== 0
    || input.state.maxAttempts !== 1
    || !["pending", "retry_wait"].includes(input.state.status)
    || JSON.stringify(input.state.requestedFields) !== expectedFields
  ) {
    fail(
      "TARGETED_EVIDENCE_HARVEST_REPLAY_FORBIDDEN",
      "detail lifecycle is not the exact fresh zero-attempt state owned by this plan",
    );
  }
}

async function terminalizeJob(input: {
  db: Client;
  jobId: string;
  runId: string;
  approvalId: string;
  leaseToken: string;
  at: string;
  status: "done" | "error";
  terminalReason: string;
  result: unknown;
  error?: string | null;
  ledger: ProductTruthOperationalLedgerSnapshot;
}): Promise<void> {
  const updated = await input.db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET status=?,terminalReason=?,result=?,error=?,actualSpendUnits=?,
              completedFields=?,unavailableFields=?,finishedAt=?,nextEligibleAt=NULL,
              leaseOwner=NULL,leaseToken=NULL,leaseExpiresAt=NULL,heartbeatAt=?,updatedAt=?
          WHERE id=? AND runId=? AND approvalId=?
            AND status='running' AND attempts=1 AND leaseToken=?
            AND julianday(leaseExpiresAt)>julianday(?)`,
    args: [
      input.status, input.terminalReason,
      renderProductTruthOperationalJson(input.result), input.error ?? null,
      input.ledger.totals.units,
      input.status === "done" ? JSON.stringify([...REQUESTED_FIELDS]) : "[]",
      input.status === "done" ? "[]" : JSON.stringify([...REQUESTED_FIELDS]),
      input.at, input.at, input.at, input.jobId, input.runId, input.approvalId,
      input.leaseToken, input.at,
    ],
  });
  if (updated.rowsAffected !== 1) {
    fail("TARGETED_EVIDENCE_TERMINAL_WRITE_LOST", "exact queue terminal CAS was lost");
  }
}

async function inspectTargetedJob(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  planSha256: string;
  approvalId: string;
}): Promise<ProductTruthTargetedEvidenceJobInspection | null> {
  const target = input.plan.targets[0].donorProductId;
  const normalizedTarget = normalizeEnrichmentTarget("product", target);
  const result = await input.db.execute({
    sql: `SELECT id,targetType,target,normalizedTarget,listingKey,idempotencyKey,requestedFields,
                 status,source,attempts,runId,approvalId,leaseOwner,leaseToken,leaseExpiresAt,
                 terminalReason,checkpoint,result,error
          FROM "EnrichmentJob"
          WHERE runId=? ORDER BY createdAt,id`,
    args: [input.plan.runId],
  });
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) fail("TARGETED_EVIDENCE_JOB_AMBIGUOUS", "run owns more than one targeted evidence job");
  const row = result.rows[0]!;
  if (
    row.id !== targetedJobId(input.planSha256)
    || row.targetType !== "product"
    || row.target !== target
    || row.normalizedTarget !== normalizedTarget
    || row.listingKey !== null
    || row.idempotencyKey !== targetedJobIdempotencyKey(input.planSha256)
    || row.requestedFields !== JSON.stringify([...REQUESTED_FIELDS])
    || row.source !== targetedJobSource(input.planSha256)
    || row.runId !== input.plan.runId
    || row.approvalId !== input.approvalId
  ) {
    fail(
      "TARGETED_EVIDENCE_JOB_AMBIGUOUS",
      "run-owned queue row is not the deterministic sealed-plan job",
    );
  }
  return {
    id: String(row.id), status: String(row.status), attempts: Number(row.attempts),
    runId: row.runId == null ? null : String(row.runId),
    approvalId: row.approvalId == null ? null : String(row.approvalId),
    leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
    leaseToken: row.leaseToken == null ? null : String(row.leaseToken),
    leaseExpiresAt: row.leaseExpiresAt == null ? null : String(row.leaseExpiresAt),
    terminalReason: row.terminalReason == null ? null : String(row.terminalReason),
    checkpoint: parseJsonOrNull(row.checkpoint), result: parseJsonOrNull(row.result),
    error: row.error == null ? null : String(row.error),
  };
}

async function matchingSearchObservations(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  approvalId: string;
  variantDecisionId: string;
  receiptId: string;
  asOf: string;
}): Promise<Array<{ id: string; meteredReceiptId: string }>> {
  const target = input.plan.targets[0];
  const result = await input.db.execute({
    sql: `SELECT id,meteredReceiptId,productUrl,observedAt,createdAt
          FROM "DonorOfferObservation"
          WHERE donorOfferId=? AND donorProductId=?
            AND canonicalVariantId=? AND variantDecisionId=?
            AND retailer='walmart' AND retailerProductId=? AND via='direct'
            AND isFirstParty=1 AND zip='33765' AND localityEvidence='zip_scoped'
            AND inStock=1 AND packSizeSeen=1 AND price>0 AND productUrl IS NOT NULL
            AND sellerName='Walmart.com' AND sourceApi='oxylabs' AND currency='USD'
            AND julianday(observedAt)>=julianday(?) AND julianday(observedAt)<=julianday(?)
            AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<=julianday(?)
            AND runId=? AND approvalId=? AND meteredReceiptId=?`,
    args: [
      target.donorOfferId, target.donorProductId, target.canonicalVariantId,
      input.variantDecisionId, target.retailerProductId,
      input.plan.createdAt, input.asOf, input.plan.createdAt, input.asOf,
      input.plan.runId, input.approvalId, input.receiptId,
    ],
  });
  return result.rows.flatMap((row) => {
    try {
      if (normalizeExactWalmartProductUrl(row.productUrl, target.retailerProductId) !== target.normalizedProductUrl) return [];
      return [{ id: String(row.id), meteredReceiptId: String(row.meteredReceiptId) }];
    } catch { return []; }
  });
}

function exactCompleteContentRow(row: Record<string, unknown>): boolean {
  if (typeof row.contentJson !== "string" || typeof row.fieldHashesJson !== "string") return false;
  if (typeof row.contentHash !== "string" || sha256(row.contentJson) !== row.contentHash) return false;
  let content: unknown;
  let fieldHashes: unknown;
  try {
    content = JSON.parse(row.contentJson) as unknown;
    fieldHashes = JSON.parse(row.fieldHashesJson) as unknown;
  } catch {
    return false;
  }
  if (
    !content
    || typeof content !== "object"
    || Array.isArray(content)
    || !fieldHashes
    || typeof fieldHashes !== "object"
    || Array.isArray(fieldHashes)
    || stableJson(content) !== row.contentJson
    || stableJson(fieldHashes) !== row.fieldHashesJson
    || (content as Record<string, unknown>)._capture !== "exact_complete_v1"
  ) return false;
  const factual = Object.entries(content as Record<string, unknown>)
    .filter(([key]) => !key.startsWith("_"))
    .sort(([left], [right]) => left.localeCompare(right, "en-US"));
  const hashes = fieldHashes as Record<string, unknown>;
  return Object.keys(hashes).length === factual.length
    && factual.every(([key, value]) => (
      typeof hashes[key] === "string"
      && /^[a-f0-9]{64}$/.test(hashes[key])
      && hashes[key] === sha256(stableJson(value))
    ));
}

function exactCompleteContentImageCount(row: Record<string, unknown>): number {
  if (!exactCompleteContentRow(row) || typeof row.contentJson !== "string") return 0;
  const content = JSON.parse(row.contentJson) as Record<string, unknown>;
  if (!Array.isArray(content.imageUrls)) return 0;
  return new Set(content.imageUrls.filter((value): value is string => (
    typeof value === "string" && value.trim().length > 0
  ))).size;
}

async function matchingContentObservations(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  approvalId: string;
  variantDecisionId: string;
  receiptId: string;
  asOf: string;
}): Promise<string[]> {
  const target = input.plan.targets[0];
  const result = await input.db.execute({
    sql: `SELECT id,sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,
                 observedAt,createdAt
          FROM "ProductContentObservation"
          WHERE donorProductId=? AND canonicalVariantId=? AND variantDecisionId=?
            AND sourceApi='unwrangle'
            AND julianday(observedAt)>=julianday(?) AND julianday(observedAt)<=julianday(?)
            AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<=julianday(?)
            AND runId=? AND approvalId=? AND meteredReceiptId=?`,
    args: [
      target.donorProductId, target.canonicalVariantId, input.variantDecisionId,
      input.plan.createdAt, input.asOf, input.plan.createdAt, input.asOf,
      input.plan.runId, input.approvalId, input.receiptId,
    ],
  });
  return result.rows.flatMap((row) => {
    try {
      if (
        normalizeExactWalmartProductUrl(row.sourceUrl, target.retailerProductId)
          !== target.normalizedProductUrl
        || !exactCompleteContentRow(row as Record<string, unknown>)
      ) return [];
      return [String(row.id)];
    } catch {
      return [];
    }
  });
}

/**
 * Existing exact content can satisfy this price-refresh lane without another
 * paid detail call. The observation itself is append-only, predates the sealed
 * plan, belongs to the exact donor/variant/source URL and must still be selected
 * by the current Product Truth read contract. It is never considered after a
 * detail receipt exists.
 */
async function matchingPreexistingContentObservations(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
}): Promise<string[]> {
  const target = input.plan.targets[0];
  if (target.identityMode !== "EXISTING_EXACT") return [];
  const result = await input.db.execute({
    sql: `SELECT id,sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,
                 observedAt,createdAt
          FROM "ProductContentObservation"
          WHERE donorProductId=? AND canonicalVariantId=? AND variantDecisionId=?
            AND sourceApi='unwrangle'
            AND julianday(observedAt)<=julianday(?)
            AND julianday(createdAt)<julianday(?)
          ORDER BY julianday(observedAt) DESC,observedAt DESC,
                   julianday(createdAt) DESC,createdAt DESC,id DESC`,
    args: [
      target.donorProductId, target.canonicalVariantId, target.variantDecisionId,
      input.plan.createdAt, input.plan.createdAt,
    ],
  });
  return result.rows.flatMap((row) => {
    try {
      if (
        normalizeExactWalmartProductUrl(row.sourceUrl, target.retailerProductId)
          !== target.normalizedProductUrl
        || exactCompleteContentImageCount(row as Record<string, unknown>)
          < input.plan.verificationPolicy.minGalleryImages
      ) return [];
      return [String(row.id)];
    } catch {
      return [];
    }
  });
}

export type ProductTruthTargetedResumeDecision =
  | { action: "CALL_OXYLABS" }
  | { action: "CALL_UNWRANGLE"; searchReceiptId: string }
  | {
      action: "RECOVER_COMPLETE";
      searchReceiptId: string;
      detailReceiptId: string | null;
      contentPath: "CURRENT_DETAIL" | "PREEXISTING_EXACT_COMPLETE";
    }
  | { action: "AMBIGUOUS"; reason: string };

/** Pure crash-boundary decision; no receipt can ever authorize replay. */
export function decideProductTruthTargetedResume(input: {
  receipts: readonly ProductTruthOperationalMeteredReceipt[];
  matchingSearchObservationReceiptIds: readonly string[];
  matchingContentObservationReceiptIds: readonly string[];
  candidateReady: boolean;
  preexistingCandidateReady?: boolean;
}): ProductTruthTargetedResumeDecision {
  const oxylabs = input.receipts.filter((row) => row.provider === "oxylabs" && row.operation === "query");
  const unwrangle = input.receipts.filter((row) => row.provider === "unwrangle" && row.operation === "detail");
  const unexpected = input.receipts.filter((row) => !(
    (row.provider === "oxylabs" && row.operation === "query")
    || (row.provider === "unwrangle" && row.operation === "detail")
  ));
  if (unexpected.length || oxylabs.length > 1 || unwrangle.length > 1) {
    return { action: "AMBIGUOUS", reason: "RECEIPT_SET_OUTSIDE_SEALED_CEILINGS" };
  }
  if (oxylabs.length === 0) {
    if (unwrangle.length) return { action: "AMBIGUOUS", reason: "DETAIL_RECEIPT_WITHOUT_SEARCH" };
    return { action: "CALL_OXYLABS" };
  }
  const search = oxylabs[0]!;
  if (search.status !== "succeeded") {
    return { action: "AMBIGUOUS", reason: "OXYLABS_OUTCOME_NOT_PROVEN_SUCCESS" };
  }
  const searchMatches = input.matchingSearchObservationReceiptIds.filter((id) => id === search.receiptId);
  if (searchMatches.length !== 1) {
    return { action: "AMBIGUOUS", reason: "OXYLABS_RECEIPT_WITHOUT_EXACT_ONE_PERSISTED_OBSERVATION" };
  }
  if (unwrangle.length === 0) {
    if (input.preexistingCandidateReady === true) {
      return {
        action: "RECOVER_COMPLETE",
        searchReceiptId: search.receiptId,
        detailReceiptId: null,
        contentPath: "PREEXISTING_EXACT_COMPLETE",
      };
    }
    return { action: "CALL_UNWRANGLE", searchReceiptId: search.receiptId };
  }
  const detail = unwrangle[0]!;
  if (detail.status !== "succeeded") {
    return { action: "AMBIGUOUS", reason: "UNWRANGLE_OUTCOME_NOT_PROVEN_SUCCESS" };
  }
  const contentMatches = input.matchingContentObservationReceiptIds.filter((id) => id === detail.receiptId);
  if (contentMatches.length === 1 && input.candidateReady) {
    return {
      action: "RECOVER_COMPLETE",
      searchReceiptId: search.receiptId,
      detailReceiptId: detail.receiptId,
      contentPath: "CURRENT_DETAIL",
    };
  }
  return { action: "AMBIGUOUS", reason: "UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE" };
}

async function candidateOrNull(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  adapter: ProductTruthTargetedWalmartEvidenceAdapter;
  asOf: string;
  exactPriceObservationIds: readonly string[];
  exactContentObservationIds: readonly string[];
  requireExactOneContent?: boolean;
}): Promise<Awaited<ReturnType<typeof readWalmartPilotCandidate>> | null> {
  if (
    input.exactPriceObservationIds.length !== 1
    || input.exactContentObservationIds.length < 1
    || (input.requireExactOneContent !== false && input.exactContentObservationIds.length !== 1)
  ) return null;
  try {
    const result = await input.adapter.readCandidate(input.db, {
      donorProductId: input.plan.targets[0].donorProductId,
      qty: 2,
      asOf: input.asOf,
      maxPriceAgeMs: input.plan.verificationPolicy.maxPriceAgeMs,
      zip: "33765",
      requireIngredients: true,
      requireNutrition: true,
      requireAllergens: true,
    });
    const candidate = result.candidate;
    if (
      result.contractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION
      || candidate.donor_product_id !== input.plan.targets[0].donorProductId
      || candidate.canonical_variant_id !== input.plan.targets[0].canonicalVariantId
      || candidate.image_count < input.plan.verificationPolicy.minGalleryImages
      || candidate.price_observation_id !== input.exactPriceObservationIds[0]
      || !input.exactContentObservationIds.includes(candidate.content_observation_id)
    ) return null;
    return result;
  } catch {
    return null;
  }
}

async function reconciliationState(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  approvalId: string;
  adapter: ProductTruthTargetedWalmartEvidenceAdapter;
  asOf: string;
}): Promise<{
  ledger: ProductTruthOperationalLedgerSnapshot;
  decision: ProductTruthTargetedResumeDecision;
  candidate: Awaited<ReturnType<typeof readWalmartPilotCandidate>> | null;
  variantDecisionId: string | null;
  priceObservationIds: readonly string[];
  contentObservationIds: readonly string[];
}> {
  const ledger = await readProductTruthOperationalLedger(input.db, input.plan.runId);
  const search = ledger.receipts.filter((row) => row.provider === "oxylabs" && row.operation === "query");
  const detail = ledger.receipts.filter((row) => row.provider === "unwrangle" && row.operation === "detail");
  const matchingSearchReceiptIds: string[] = [];
  const matchingSearchObservationIds: string[] = [];
  const variantDecisionId = await runtimeVariantDecisionId({
    db: input.db,
    plan: input.plan,
    approvalId: input.approvalId,
  });
  for (const receipt of variantDecisionId ? search : []) {
    const rows = await matchingSearchObservations({
      db: input.db, plan: input.plan, approvalId: input.approvalId,
      variantDecisionId: variantDecisionId!, receiptId: receipt.receiptId, asOf: input.asOf,
    });
    rows.forEach((row) => {
      matchingSearchReceiptIds.push(receipt.receiptId);
      matchingSearchObservationIds.push(row.id);
    });
  }
  const matchingContentReceiptIds: string[] = [];
  const matchingContentObservationIds: string[] = [];
  for (const receipt of variantDecisionId ? detail : []) {
    const rows = await matchingContentObservations({
      db: input.db, plan: input.plan, approvalId: input.approvalId,
      variantDecisionId: variantDecisionId!, receiptId: receipt.receiptId, asOf: input.asOf,
    });
    rows.forEach((id) => {
      matchingContentReceiptIds.push(receipt.receiptId);
      matchingContentObservationIds.push(id);
    });
  }
  const currentDetailCandidate = await candidateOrNull({
    db: input.db,
    plan: input.plan,
    adapter: input.adapter,
    asOf: input.asOf,
    exactPriceObservationIds: matchingSearchObservationIds,
    exactContentObservationIds: matchingContentObservationIds,
  });
  const preexistingContentObservationIds = detail.length === 0
    ? await matchingPreexistingContentObservations({ db: input.db, plan: input.plan })
    : [];
  const preexistingCandidate = detail.length === 0
    ? await candidateOrNull({
        db: input.db,
        plan: input.plan,
        adapter: input.adapter,
        asOf: input.asOf,
        exactPriceObservationIds: matchingSearchObservationIds,
        exactContentObservationIds: preexistingContentObservationIds,
        requireExactOneContent: false,
      })
    : null;
  const decision = decideProductTruthTargetedResume({
    receipts: ledger.receipts,
    matchingSearchObservationReceiptIds: matchingSearchReceiptIds,
    matchingContentObservationReceiptIds: matchingContentReceiptIds,
    candidateReady: currentDetailCandidate !== null,
    preexistingCandidateReady: preexistingCandidate !== null,
  });
  return {
    ledger,
    candidate: decision.action === "RECOVER_COMPLETE"
      ? decision.contentPath === "CURRENT_DETAIL"
        ? currentDetailCandidate
        : preexistingCandidate
      : null,
    decision,
    variantDecisionId,
    priceObservationIds: matchingSearchObservationIds,
    contentObservationIds: decision.action === "RECOVER_COMPLETE"
      && decision.contentPath === "PREEXISTING_EXACT_COMPLETE"
      ? preexistingContentObservationIds
      : matchingContentObservationIds,
  };
}

async function reapExpiredTargetedRunFromEvidence(input: {
  db: Client;
  plan: ProductTruthTargetedWalmartEvidencePlan;
  approvalId: string;
  adapter: ProductTruthTargetedWalmartEvidenceAdapter;
  at: string;
}): Promise<Awaited<ReturnType<typeof reapExpiredProductTruthTargetedEvidenceRun>>> {
  const reconciliation = await reconciliationState({
    db: input.db,
    plan: input.plan,
    approvalId: input.approvalId,
    adapter: input.adapter,
    asOf: input.at,
  });
  let harvestState = await readTargetedHarvestState(input.db, input.plan);
  if (
    harvestState?.status === "running"
    && harvestState.leaseExpiresAt
    && Date.parse(harvestState.leaseExpiresAt) <= Date.parse(input.at)
  ) {
    const hasDetailBoundary = reconciliation.ledger.receipts.some((receipt) => (
      receipt.provider === "unwrangle" && receipt.operation === "detail"
    ));
    const observedOrUnknown = hasDetailBoundary
      || harvestState.attempts > 0
      || harvestState.sourceAttemptStartedAt !== null;
    const saved = await persistDonorHarvestTransition(input.db, harvestState, {
      type: "lease_expired",
      at: input.at,
      meteredBoundary: observedOrUnknown ? "observed_or_unknown" : "not_observed",
      nextEligibleAt: observedOrUnknown
        ? null
        : new Date(Date.parse(input.at) + 1).toISOString(),
      error: observedOrUnknown
        ? "Targeted run expired at or after the detail reservation boundary"
        : "Targeted run expired before any durable detail reservation",
    });
    if (!saved) {
      fail("TARGETED_EVIDENCE_HARVEST_REAP_CAS_LOST", "detail lifecycle changed during recovery");
    }
    harvestState = saved;
  }
  let disposition: "interrupted" | "ambiguous";
  let reason: string;
  if (reconciliation.decision.action === "AMBIGUOUS") {
    disposition = "ambiguous";
    reason = reconciliation.decision.reason;
  } else if (
    reconciliation.decision.action === "CALL_OXYLABS"
    && harvestState !== null
  ) {
    disposition = "ambiguous";
    reason = "HARVEST_STATE_WITHOUT_SEARCH_RECEIPT";
  } else if (
    reconciliation.decision.action === "CALL_UNWRANGLE"
    && harvestState !== null
    && !(
      harvestState.attempts === 0
      && ["pending", "retry_wait"].includes(harvestState.status)
      && harvestState.createdAt >= input.plan.createdAt
    )
  ) {
    disposition = "ambiguous";
    reason = "DETAIL_STATE_NOT_SAFE_FOR_DISTINCT_FIRST_CALL";
  } else {
    disposition = "interrupted";
    reason = reconciliation.decision.action === "RECOVER_COMPLETE"
      ? "EXACT_COMPLETE_EVIDENCE_CAN_BE_RECONCILED_WITHOUT_NETWORK"
      : reconciliation.decision.action === "CALL_UNWRANGLE"
        ? "EXACT_SEARCH_EVIDENCE_ALLOWS_ONLY_DISTINCT_DETAIL_CALL"
        : "NO_PROVIDER_BOUNDARY_CROSSED";
  }
  return reapExpiredProductTruthTargetedEvidenceRun(input.db, {
    runId: input.plan.runId,
    at: input.at,
    disposition,
    reason,
  });
}

let environmentOwner: string | null = null;
async function withMeteredRuntime<T>(input: {
  runId: string;
  approval: ValidatedProductTruthOperationalApproval;
  database: ExecuteProductTruthTargetedWalmartEvidenceInput["meteredDatabase"];
}, fn: () => Promise<T>): Promise<T> {
  if (environmentOwner) fail("TARGETED_EVIDENCE_PROCESS_LOCK_HELD", `metered runtime is owned by ${environmentOwner}`);
  environmentOwner = input.runId;
  const keys = [
    "SS_METERED_RUN_PERMIT", "SS_METERED_RUN_CONFIRM",
    "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DATABASE_URL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SS_METERED_RUN_PERMIT = input.approval.encodedPermit;
  process.env.SS_METERED_RUN_CONFIRM = input.approval.meteredConfirmation;
  process.env.TURSO_DATABASE_URL = input.database.url;
  process.env.DATABASE_URL = input.database.url;
  if (input.database.authToken) process.env.TURSO_AUTH_TOKEN = input.database.authToken;
  else delete process.env.TURSO_AUTH_TOKEN;
  try { return await fn(); } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    environmentOwner = null;
  }
}

export const PRODUCT_TRUTH_TARGETED_WALMART_PRODUCTION_ADAPTER = (
  probeRuntime: ProductTruthTargetedWalmartEvidenceAdapter["probeRuntime"],
): ProductTruthTargetedWalmartEvidenceAdapter => ({
  probeRuntime,
  search: (query) => oxylabsWalmartSearch(query),
  persistOffer: persistScoredDonorOffer,
  harvest: (db, input) => executeDonorHarvestCandidate({
    ...input,
    db,
    allowOpenFoodFactsSupplement: false,
    upcConflictPolicy: "block",
    harvestDetail: input.harvestDetail ?? harvestDonorDetail,
  }),
  readCandidate: readWalmartPilotCandidate,
});

export async function inspectProductTruthTargetedWalmartEvidenceRun(
  db: Client,
  runId: string,
): Promise<{
  plan: ProductTruthTargetedWalmartEvidencePlan;
  run: Awaited<ReturnType<typeof getProductTruthOperationalRun>>;
  job: ProductTruthTargetedEvidenceJobInspection | null;
  ledger: ProductTruthOperationalLedgerSnapshot;
  events: Awaited<ReturnType<typeof listProductTruthOperationalEvents>>;
}> {
  const run = await getProductTruthOperationalRun(db, runId);
  if (!run || run.planSchemaVersion !== PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_PLAN_VERSION) {
    fail("TARGETED_EVIDENCE_RUN_MISSING", `run ${runId} is not a targeted Walmart evidence run`);
  }
  const plan = parseProductTruthTargetedWalmartEvidencePlan(JSON.parse(run.planJson));
  return {
    plan,
    run,
    job: await inspectTargetedJob({
      db,
      plan,
      planSha256: run.planSha256,
      approvalId: run.approvalId,
    }),
    ledger: await readProductTruthOperationalLedger(db, runId),
    events: await listProductTruthOperationalEvents(db, runId),
  };
}

export async function executeProductTruthTargetedWalmartEvidence(
  db: Client,
  raw: ExecuteProductTruthTargetedWalmartEvidenceInput,
): Promise<ProductTruthTargetedWalmartEvidenceExecutionResult> {
  const plan = parseProductTruthTargetedWalmartEvidencePlan(raw.plan);
  const planSha256 = raw.planSha256;
  if (productTruthOperationalSha256(plan) !== planSha256) {
    fail("TARGETED_EVIDENCE_PLAN_HASH_MISMATCH", "plan content differs from plan SHA");
  }
  if (raw.meteredDatabase.targetFingerprint !== plan.targetFingerprint) {
    fail("TARGETED_EVIDENCE_TARGET_MISMATCH", "metered DB target differs from plan");
  }
  const rawWallNow = raw.now ?? (() => new Date().toISOString());
  let lastWallMilliseconds: number | null = null;
  let lastWallAt: string | null = null;
  const now = (): string => {
    const value = canonicalNow(rawWallNow);
    const milliseconds = Date.parse(value);
    if (lastWallMilliseconds !== null && milliseconds < lastWallMilliseconds) {
      fail(
        "TARGETED_EVIDENCE_WALL_CLOCK_ROLLBACK",
        `wall clock moved backward from ${lastWallAt} to ${value}`,
      );
    }
    lastWallMilliseconds = milliseconds;
    lastWallAt = value;
    return value;
  };
  const rawMonotonicNow = raw.monotonicNow ?? (() => performance.now());
  let lastMonotonicValue: number | null = null;
  const monotonicNow = (): number => {
    const value = rawMonotonicNow();
    if (!Number.isFinite(value)) {
      fail("TARGETED_EVIDENCE_MONOTONIC_CLOCK_INVALID", "monotonic clock returned a non-finite value");
    }
    if (lastMonotonicValue !== null && value < lastMonotonicValue) {
      fail("TARGETED_EVIDENCE_MONOTONIC_CLOCK_ROLLBACK", "monotonic clock moved backward");
    }
    lastMonotonicValue = value;
    return value;
  };
  const monotonicStartedAt = monotonicNow();
  const initialAt = canonicalNow(now);
  if (Date.parse(initialAt) < Date.parse(plan.createdAt) || Date.parse(initialAt) >= Date.parse(plan.expiresAt)) {
    fail("TARGETED_EVIDENCE_PLAN_NOT_CURRENT", "sealed plan is not current");
  }
  const effectiveWallBudgetMs = Math.min(
    plan.maxWallClockMs,
    Date.parse(plan.expiresAt) - Date.parse(initialAt),
  );
  const deadlineAt = new Date(Date.parse(initialAt) + effectiveWallBudgetMs).toISOString();
  const assertExecutionDeadline = (boundary: string): string => {
    const at = canonicalNow(now);
    assertBeforeDeadline(at, deadlineAt, boundary);
    const elapsed = monotonicNow() - monotonicStartedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= effectiveWallBudgetMs) {
      fail(
        "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED",
        `${boundary} reached sealed monotonic ${effectiveWallBudgetMs}ms limit`,
      );
    }
    return at;
  };
  assertExecutionDeadline("execution start");
  // All immutable code/DB/donor checks happen before the run or any network call.
  // A bootstrap resume may already own the exact run/approval-bound promotion;
  // validate that durable state instead of trying to reinterpret it as legacy.
  const initialVariantDecisionId = await runtimeVariantDecisionId({
    db,
    plan,
    approvalId: raw.validatedApproval.approval.approvalId,
  });
  if (
    raw.command === "execute"
    && plan.targets[0].identityMode === "EVIDENCE_VERIFIED_BOOTSTRAP"
    && initialVariantDecisionId !== null
  ) {
    fail("TARGETED_EVIDENCE_BOOTSTRAP_REPLAY_FORBIDDEN", "execute cannot adopt an already promoted bootstrap donor");
  }
  await assertRuntimeBindings({
    db,
    plan,
    adapter: raw.adapter,
    phase: initialVariantDecisionId === null ? "PRE_PROMOTION" : "POST_PROMOTION",
    approvalId: raw.validatedApproval.approval.approvalId,
  });
  assertExecutionDeadline("initial runtime binding");
  if (raw.command === "execute" && await readTargetedHarvestState(db, plan) !== null) {
    fail(
      "TARGETED_EVIDENCE_PRIOR_HARVEST_STATE_FORBIDDEN",
      "detail lifecycle appeared after planning; exact first attempt is no longer proven",
    );
  }

  return withMeteredRuntime({
    runId: plan.runId,
    approval: raw.validatedApproval,
    database: raw.meteredDatabase,
  }, async () => {
  const seeded = await seedProductTruthTargetedEvidenceControlRun(db, {
    plan,
    planSha256,
    approvalId: raw.validatedApproval.approval.approvalId,
    environment: raw.environment,
    at: initialAt,
  });
  let stored = seeded.run;
  if (raw.command === "execute" && (!seeded.created || stored.status !== "prepared")) {
    fail("TARGETED_EVIDENCE_EXECUTE_REPLAY_FORBIDDEN", "execute cannot replay an existing targeted run");
  }
  if (raw.command === "resume") {
    if (seeded.created) fail("TARGETED_EVIDENCE_RESUME_RUN_MISSING", "resume requires an existing exact run");
    if (stored.status === "running" && stored.leaseExpiresAt && Date.parse(stored.leaseExpiresAt) <= Date.parse(initialAt)) {
      stored = (await reapExpiredTargetedRunFromEvidence({
        db,
        plan,
        approvalId: raw.validatedApproval.approval.approvalId,
        adapter: raw.adapter,
        at: initialAt,
      })).run;
    }
    if (stored.status === "prepared") {
      const [ledger, preparedJob, preparedHarvest] = await Promise.all([
        readProductTruthOperationalLedger(db, plan.runId),
        inspectTargetedJob({
          db,
          plan,
          planSha256,
          approvalId: raw.validatedApproval.approval.approvalId,
        }),
        readTargetedHarvestState(db, plan),
      ]);
      if (
        ledger.receipts.length !== 0
        || preparedJob !== null
        || preparedHarvest !== null
        || initialVariantDecisionId !== (
          plan.targets[0].identityMode === "EXISTING_EXACT"
            ? plan.targets[0].variantDecisionId
            : null
        )
      ) {
        fail(
          "TARGETED_EVIDENCE_PREPARED_RECOVERY_UNSAFE",
          "prepared run is reusable only before every job, receipt, harvest, and bootstrap boundary",
        );
      }
    } else if (stored.status !== "interrupted") {
      fail("TARGETED_EVIDENCE_RESUME_FORBIDDEN", `resume requires prepared or interrupted; found ${stored.status}`);
    }
  }

    // Hold the process-wide metered-environment lock before acquiring a DB
    // lease. A competing in-process invocation can therefore never strand a
    // durable running lease merely because the environment lock was occupied.
    const runLeaseToken = `pter_${randomUUID()}`;
    await acquireProductTruthOperationalRunLease(db, {
      runId: plan.runId,
      leaseOwner: raw.leaseOwner,
      leaseToken: runLeaseToken,
      at: initialAt,
      leaseExpiresAt: new Date(Date.parse(initialAt) + LEASE_MS).toISOString(),
    });
    let finalStatus: ProductTruthTargetedWalmartEvidenceExecutionResult["status"] = "failed";
    let finalOutcome: ProductTruthTargetedWalmartEvidenceReport["outcome"] = "FAILED";
    let finalReason = "TARGETED_EVIDENCE_FAILED";
    let candidate: Awaited<ReturnType<typeof readWalmartPilotCandidate>> | null = null;
    let job: ProductTruthTargetedEvidenceJobInspection | null = null;
    let jobLeaseToken: string | null = null;
    try {
      assertExecutionDeadline("budget preflight");
      for (const ceiling of plan.providerCeilings) {
        await ensureMeteredProviderBudget(db, {
          permit: raw.validatedApproval.permit,
          confirmation: raw.validatedApproval.meteredConfirmation,
          provider: ceiling.provider,
        });
      }
      job = await ensureTargetedJob({
        db, plan, planSha256,
        approvalId: raw.validatedApproval.approval.approvalId,
        at: canonicalNow(now),
      });
      if (["queued", "retry_wait", "running"].includes(job.status)) {
        jobLeaseToken = await claimTargetedJob({
          db, job, runId: plan.runId,
          approvalId: raw.validatedApproval.approval.approvalId,
          leaseOwner: raw.leaseOwner, at: canonicalNow(now),
        });
      } else if (job.status !== "done") {
        fail("TARGETED_EVIDENCE_JOB_TERMINAL", `product job is already ${job.status}`);
      }

      let state = await reconciliationState({
        db, plan, approvalId: raw.validatedApproval.approval.approvalId,
        adapter: raw.adapter, asOf: canonicalNow(now),
      });
      if (state.decision.action === "CALL_OXYLABS") {
        if (!jobLeaseToken) fail("TARGETED_EVIDENCE_JOB_LEASE_REQUIRED", "search requires the exact product job lease");
        assertExecutionDeadline("before Oxylabs query");
        const searchResult = await raw.adapter.search(plan.targets[0].query);
        assertExecutionDeadline("after Oxylabs query");
        const exactOffer = selectExactTargetedWalmartOffer({ result: searchResult, target: plan.targets[0] });
        if (
          exactOffer.meteredRunId !== plan.runId
          || exactOffer.meteredApprovalId !== raw.validatedApproval.approval.approvalId
        ) {
          fail("TARGETED_EVIDENCE_SEARCH_PROVENANCE_MISMATCH", "Oxylabs result belongs to another run/approval");
        }
        // Recheck every immutable binding after the paid response and before catalog write.
        await assertRuntimeBindings({ db, plan, adapter: raw.adapter });
        assertExecutionDeadline("before price observation write");
        const persisted = await raw.adapter.persistOffer(
          db,
          exactOffer,
          canonicalProductFromTarget(plan.targets[0]),
          canonicalNow(now),
          {
            exactScope: {
              donorProductId: plan.targets[0].donorProductId,
              donorOfferId: plan.targets[0].donorOfferId,
              retailer: "walmart",
              retailerProductId: plan.targets[0].retailerProductId,
              canonicalVariantId: plan.targets[0].canonicalVariantId,
              variantDecisionId: plan.targets[0].variantDecisionId,
              canonicalVariantMustBeAbsent:
                plan.targets[0].identityMode === "EVIDENCE_VERIFIED_BOOTSTRAP",
              normalizedProductUrl: plan.targets[0].normalizedProductUrl,
              expectedLegacyRows: plan.targets[0].legacySnapshot === null
                ? null
                : {
                    donorProductRowJson: plan.targets[0].legacySnapshot.donorProductRowJson,
                    donorOfferRowJson: plan.targets[0].legacySnapshot.donorOfferRowJson,
                  },
            },
          },
        );
        assertExecutionDeadline("after price observation write");
        if (
          persisted.donorProductId !== plan.targets[0].donorProductId
          || persisted.donorOfferId !== plan.targets[0].donorOfferId
          || persisted.canonicalVariantId !== plan.targets[0].canonicalVariantId
          || !persisted.variantDecisionId
          || (
            plan.targets[0].variantDecisionId !== null
            && persisted.variantDecisionId !== plan.targets[0].variantDecisionId
          )
          || persisted.aliasConflict
          || persisted.productCreated
        ) {
          fail("TARGETED_EVIDENCE_PERSIST_SCOPE_DRIFT", "price writer changed or resolved outside the sealed donor/offer alias");
        }
        await assertRuntimeBindings({
          db,
          plan,
          adapter: raw.adapter,
          phase: "POST_PROMOTION",
          approvalId: raw.validatedApproval.approval.approvalId,
        });
        state = await reconciliationState({
          db, plan, approvalId: raw.validatedApproval.approval.approvalId,
          adapter: raw.adapter, asOf: canonicalNow(now),
        });
        if (
          state.decision.action !== "CALL_UNWRANGLE"
          && !(
            state.decision.action === "RECOVER_COMPLETE"
            && state.decision.contentPath === "PREEXISTING_EXACT_COMPLETE"
          )
        ) {
          fail(
            "TARGETED_EVIDENCE_SEARCH_RECONCILIATION_FAILED",
            "search receipt did not reconcile to exact one current observation",
          );
        }
      }

      state = await reconciliationState({
        db, plan, approvalId: raw.validatedApproval.approval.approvalId,
        adapter: raw.adapter, asOf: canonicalNow(now),
      });
      if (
        jobLeaseToken
        && (state.decision.action === "CALL_UNWRANGLE"
          || state.decision.action === "RECOVER_COMPLETE")
        && state.variantDecisionId
        && state.priceObservationIds.length === 1
      ) {
        await writeJobCheckpoint({
          db, jobId: job.id, runId: plan.runId,
          approvalId: raw.validatedApproval.approval.approvalId,
          leaseToken: jobLeaseToken,
          at: canonicalNow(now),
          checkpoint: {
            schemaVersion: "product-truth-targeted-evidence-checkpoint/1.0.0",
            stage: state.decision.action === "RECOVER_COMPLETE"
              ? "EXACT_CANDIDATE_RECONCILED"
              : "SEARCH_PERSISTED",
            planSha256,
            identityMode: plan.targets[0].identityMode,
            variantDecisionId: state.variantDecisionId,
            priceObservationId: state.priceObservationIds[0],
            contentObservationId: state.candidate?.candidate.content_observation_id ?? null,
            searchReceiptId: state.decision.searchReceiptId,
            detailReceiptId: state.decision.action === "RECOVER_COMPLETE"
              ? state.decision.detailReceiptId
              : null,
          },
        });
      }
      if (state.decision.action === "AMBIGUOUS") {
        finalStatus = "ambiguous";
        finalOutcome = "AMBIGUOUS";
        finalReason = state.decision.reason;
      } else if (state.decision.action === "RECOVER_COMPLETE") {
        candidate = state.candidate;
        finalStatus = "completed";
        finalOutcome = "COMPLETED";
        finalReason = state.decision.contentPath === "PREEXISTING_EXACT_COMPLETE"
          ? "FRESH_PRICE_REUSED_PREEXISTING_EXACT_COMPLETE_CONTENT"
          : "EXACT_CANDIDATE_RECOVERED_FROM_DURABLE_EVIDENCE";
      } else if (state.decision.action === "CALL_UNWRANGLE") {
        // Recovered search observation is sufficient to skip Oxylabs; only the
        // distinct approved detail call may still occur.
        if (!jobLeaseToken) fail("TARGETED_EVIDENCE_JOB_LEASE_REQUIRED", "detail requires the exact product job lease");
        assertExecutionDeadline("before detail runtime binding");
        await assertRuntimeBindings({
          db,
          plan,
          adapter: raw.adapter,
          phase: "POST_PROMOTION",
          approvalId: raw.validatedApproval.approval.approvalId,
        });
        assertExecutionDeadline("before Unwrangle detail");
        const priorHarvest = await readTargetedHarvestState(db, plan);
        if (priorHarvest) {
          assertTargetedHarvestStateCanCall({
            state: priorHarvest,
            plan,
            approvalId: raw.validatedApproval.approval.approvalId,
          });
        }
        const seededHarvest = await seedDonorHarvestState(db, {
          donorProductId: plan.targets[0].donorProductId,
          source: "unwrangle:walmart",
          retailerProductId: plan.targets[0].retailerProductId,
          requestedFields: DONOR_HARVEST_BOOTSTRAP_FIELDS,
          maxAttempts: 1,
          now: canonicalNow(now),
        });
        assertTargetedHarvestStateCanCall({
          state: seededHarvest.state,
          plan,
          approvalId: raw.validatedApproval.approval.approvalId,
        });
        const harvestResult = await raw.adapter.harvest(db, {
          db,
          candidate: seededHarvest.state,
          runId: plan.runId,
          approvalId: raw.validatedApproval.approval.approvalId,
          leaseOwner: raw.leaseOwner,
          now,
          allowOpenFoodFactsSupplement: false,
          requireBaseUnit: true,
          upcConflictPolicy: "block",
          beforeCatalogWrite: async () => {
            assertExecutionDeadline("after Unwrangle detail");
            await assertRuntimeBindings({
              db,
              plan,
              adapter: raw.adapter,
              phase: "POST_PROMOTION",
              approvalId: raw.validatedApproval.approval.approvalId,
            });
            return assertExecutionDeadline("before content observation write");
          },
        });
        assertExecutionDeadline("after detail writer");
        state = await reconciliationState({
          db, plan, approvalId: raw.validatedApproval.approval.approvalId,
          adapter: raw.adapter, asOf: canonicalNow(now),
        });
        if (
          state.decision.action === "RECOVER_COMPLETE"
          && state.candidate
          && state.variantDecisionId
          && state.priceObservationIds.length === 1
          && jobLeaseToken
        ) {
          await writeJobCheckpoint({
            db, jobId: job.id, runId: plan.runId,
            approvalId: raw.validatedApproval.approval.approvalId,
            leaseToken: jobLeaseToken,
            at: canonicalNow(now),
            checkpoint: {
              schemaVersion: "product-truth-targeted-evidence-checkpoint/1.0.0",
              stage: "EXACT_CANDIDATE_RECONCILED",
              planSha256,
              identityMode: plan.targets[0].identityMode,
              variantDecisionId: state.variantDecisionId,
              priceObservationId: state.priceObservationIds[0],
              contentObservationId: state.candidate.candidate.content_observation_id,
              searchReceiptId: state.decision.searchReceiptId,
              detailReceiptId: state.decision.detailReceiptId,
            },
          });
        }
        if (state.decision.action === "RECOVER_COMPLETE" && state.candidate) {
          candidate = state.candidate;
          finalStatus = "completed";
          finalOutcome = "COMPLETED";
          finalReason = "EXACT_PRICE_CONTENT_AND_WALMART_CANDIDATE_VERIFIED";
        } else if (
          state.decision.action === "CALL_UNWRANGLE"
          && harvestResult.disposition === "blocked"
        ) {
          finalStatus = "interrupted";
          finalOutcome = "INTERRUPTED";
          finalReason = harvestResult.reason;
        } else if (
          state.decision.action === "CALL_UNWRANGLE"
          && harvestResult.disposition === "terminal"
        ) {
          finalStatus = "blocked";
          finalOutcome = "BLOCKED";
          finalReason = harvestResult.reason;
        } else {
          finalStatus = "ambiguous";
          finalOutcome = "AMBIGUOUS";
          finalReason = state.decision.action === "AMBIGUOUS"
            ? state.decision.reason
            : "DETAIL_DID_NOT_PRODUCE_EXACT_COMPLETE_CANDIDATE";
        }
      } else {
        finalStatus = "ambiguous";
        finalOutcome = "AMBIGUOUS";
        finalReason = "TARGETED_EVIDENCE_RECONCILIATION_STATE_INVALID";
      }
    } catch (error) {
      const ledger = await readProductTruthOperationalLedger(db, plan.runId).catch(() => null);
      const crossed = Boolean(ledger?.receipts.some((receipt) => (
        receipt.status === "reserved" || receipt.status === "succeeded" || receipt.status === "failed"
      )));
      const checkpointLost = error instanceof ProductTruthTargetedWalmartEvidenceError
        && error.code === "TARGETED_EVIDENCE_CHECKPOINT_WRITE_LOST";
      const deadlineReached = error instanceof ProductTruthTargetedWalmartEvidenceError
        && error.code === "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED";
      if (deadlineReached) {
        const recovered = await reconciliationState({
          db,
          plan,
          approvalId: raw.validatedApproval.approval.approvalId,
          adapter: raw.adapter,
          asOf: canonicalNow(now),
        }).catch(() => null);
        if (recovered?.decision.action === "RECOVER_COMPLETE" && recovered.candidate) {
          candidate = recovered.candidate;
          finalStatus = "completed";
          finalOutcome = "COMPLETED";
          finalReason = "DEADLINE_REACHED_AFTER_EXACT_EVIDENCE_DURABLY_COMPLETED";
        } else if (recovered && recovered.decision.action !== "AMBIGUOUS") {
          finalStatus = "interrupted";
          finalOutcome = "INTERRUPTED";
          finalReason = "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED_SAFE_TO_RESUME";
        } else {
          finalStatus = "ambiguous";
          finalOutcome = "AMBIGUOUS";
          finalReason = recovered?.decision.action === "AMBIGUOUS"
            ? recovered.decision.reason
            : "TARGETED_EVIDENCE_WALL_CLOCK_EXHAUSTED_RECONCILIATION_FAILED";
        }
      } else {
        finalStatus = checkpointLost ? "interrupted" : crossed ? "ambiguous" : "blocked";
        finalOutcome = checkpointLost ? "INTERRUPTED" : crossed ? "AMBIGUOUS" : "BLOCKED";
        finalReason = error instanceof Error
          ? error.message.slice(0, 500)
          : "TARGETED_EVIDENCE_UNKNOWN_FAILURE";
      }
    }

    // Terminal bookkeeping never consults an untrusted clock again. Reuse the
    // last checked nondecreasing timestamp so a rollback/timeout cannot strand
    // either the queue lease or the operational run lease.
    const generatedAt = lastWallAt ?? initialAt;
    // Deadline fences paid provider calls and catalog writes. Terminal durable
    // reconciliation is deliberately allowed after it, so leases cannot be
    // stranded by the very timeout that is meant to stop more work.
    const ledger = await readProductTruthOperationalLedger(db, plan.runId);
    const ownedJob = job;
    try {
      job = await inspectTargetedJob({
        db,
        plan,
        planSha256,
        approvalId: raw.validatedApproval.approval.approvalId,
      });
    } catch (error) {
      job = null;
      const paidBoundaryCrossed = ledger.receipts.length > 0;
      finalStatus = paidBoundaryCrossed ? "ambiguous" : "blocked";
      finalOutcome = paidBoundaryCrossed ? "AMBIGUOUS" : "BLOCKED";
      finalReason = error instanceof Error
        ? error.message.slice(0, 500)
        : "TARGETED_EVIDENCE_JOB_INSPECTION_FAILED";
    }
    const terminalJob = job ?? ownedJob;
    if (terminalJob && jobLeaseToken && finalStatus === "interrupted") {
      await releaseJobForInterruption({
        db,
        jobId: terminalJob.id,
        runId: plan.runId,
        approvalId: raw.validatedApproval.approval.approvalId,
        leaseToken: jobLeaseToken,
        at: generatedAt,
      });
    } else if (terminalJob && jobLeaseToken) {
      try {
        await terminalizeJob({
          db, jobId: terminalJob.id, runId: plan.runId,
          approvalId: raw.validatedApproval.approval.approvalId,
          leaseToken: jobLeaseToken,
          at: generatedAt,
          status: finalStatus === "completed" ? "done" : "error",
          terminalReason: finalReason,
          result: { outcome: finalOutcome, reason: finalReason },
          error: finalStatus === "completed" ? null : finalReason,
          ledger,
        });
      } catch (error) {
        finalStatus = "ambiguous";
        finalOutcome = "AMBIGUOUS";
        finalReason = error instanceof Error ? error.message : "TARGETED_EVIDENCE_TERMINAL_WRITE_LOST";
      }
    }
    try {
      job = await inspectTargetedJob({
        db,
        plan,
        planSha256,
        approvalId: raw.validatedApproval.approval.approvalId,
      });
    } catch (error) {
      job = null;
      finalStatus = ledger.receipts.length > 0 ? "ambiguous" : "blocked";
      finalOutcome = ledger.receipts.length > 0 ? "AMBIGUOUS" : "BLOCKED";
      finalReason = error instanceof Error
        ? error.message.slice(0, 500)
        : "TARGETED_EVIDENCE_JOB_INSPECTION_FAILED";
    }
    const report: ProductTruthTargetedWalmartEvidenceReport = {
      schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_REPORT_VERSION,
      resultContractVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_RESULT_VERSION,
      runId: plan.runId,
      approvalId: raw.validatedApproval.approval.approvalId,
      planSha256,
      targetFingerprint: plan.targetFingerprint,
      donorProductId: plan.targets[0].donorProductId,
      donorOfferId: plan.targets[0].donorOfferId,
      canonicalVariantId: plan.targets[0].canonicalVariantId,
      retailerProductId: plan.targets[0].retailerProductId,
      outcome: finalOutcome,
      reason: finalReason,
      generatedAt,
      candidate: candidate ? {
        contentObservationId: candidate.candidate.content_observation_id,
        priceObservationId: candidate.candidate.price_observation_id,
        imageCount: candidate.candidate.image_count,
        observedPrice: candidate.candidate.observed_price,
      } : null,
      job,
      ledger,
      claims: plan.claims,
      next_command: null,
    };
    const artifact = await raw.artifactWriter(report);
    await finishProductTruthOperationalRun(db, {
      runId: plan.runId,
      leaseToken: runLeaseToken,
      status: finalStatus,
      at: generatedAt,
      reportSha256: artifact.reportSha256,
      artifactIndexSha256: artifact.artifactIndexSha256,
    });
    return {
      schemaVersion: PRODUCT_TRUTH_TARGETED_WALMART_EVIDENCE_RESULT_VERSION,
      runId: plan.runId,
      status: finalStatus,
      outcome: finalOutcome,
      reason: finalReason,
      reportSha256: artifact.reportSha256,
      artifactIndexSha256: artifact.artifactIndexSha256,
      next_command: null,
    };
  });
}
