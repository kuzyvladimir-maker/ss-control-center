import { createHash } from "node:crypto";

import type { Client, Row, Transaction } from "@libsql/client";

import { CANONICAL_PRODUCT_MATCHER_VERSION } from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "./canonical-product-match-provenance";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
  evaluatePriceEvidenceEligibility,
  type PriceEvidenceDecision,
  type PriceEvidenceEligibility,
} from "./price-evidence-policy";
import { assertProductTruthEvidenceSchema } from "./product-truth-schema-gate";
import { assertProductTruthListingScopeSchema } from "./product-truth-schema-gate";
import { buildProductTruthListingScope } from "./product-truth-listing-scope";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "./product-truth-read-contract-version";

export { PRODUCT_TRUTH_READ_CONTRACT_VERSION };

export type ProductTruthCostStatus =
  | "FACT"
  | "ESTIMATE"
  | "UNSOURCEABLE"
  | "INVALID"
  | "MISSING";

export interface ProductTruthReadScope {
  sku: string;
  /** Exact marketplace listing scope. There is no raw-SKU fallback. */
  channel: string;
  storeIndex: number;
}

export interface ProductTruthReadOptions extends ProductTruthReadScope {
  /**
   * Optional only for low-level diagnostics and historical tests. Strategic
   * consumers and the operational runner must pin the exact authoritative
   * Phase 1 manifest so a stale registered scope cannot be accepted silently.
   */
  expectedManifestSha256?: string;
  /** Zoned, explicit evaluation instant. The contract never reads wall time. */
  asOf: string | Date;
  maxPriceAgeMs: number;
}

export interface ProductTruthBatchReadOptions {
  /** One authoritative manifest and one evaluation boundary per batch. */
  scopes: readonly ProductTruthReadScope[];
  expectedManifestSha256: string;
  /** Zoned, explicit evaluation instant shared by every exact scope. */
  asOf: string | Date;
  maxPriceAgeMs: number;
}

export const PRODUCT_TRUTH_MAX_BATCH_SCOPES = 100;

export interface ProductTruthMatcherProvenance {
  matcherVersion: string;
  matcherImplementationSha256: string;
  matcherReleaseSha256: string;
}

export interface ProductTruthContentFacts {
  canonicalVariantId: string;
  identity: {
    variantKey: string;
    identityHash: string;
    keyVersion: string;
    brand: string;
    productLine: string | null;
    flavor: string | null;
    modifiers: unknown[];
    form: string | null;
    sizeDimension: "MASS" | "VOLUME" | "COUNT";
    sizeBaseAmount: number;
    sizeBaseUnit: "g" | "ml" | "count";
    outerPackCount: number;
    identity: unknown;
  };
  facts: {
    title: string | null;
    description: string | null;
    bullets: unknown;
    attributes: unknown;
    nutritionFacts: unknown;
    ingredients: string | null;
    mainImageUrl: string | null;
    imageUrls: string[];
  };
  provenance: ProductTruthMatcherProvenance & {
    contentObservationId: string;
    observationKey: string;
    donorProductId: string;
    variantDecisionId: string;
    decisionEvidenceHash: string;
    contentHash: string;
    fieldHashes: unknown;
    sourceUrl: string;
    sourceApi: string;
    observedAt: string;
    runId: string | null;
    approvalId: string | null;
    meteredReceiptId: string | null;
  };
}

export interface ProductTruthRecipeComponent {
  componentEvidenceId: string;
  componentIndex: number;
  product: string;
  flavor: string | null;
  size: string | null;
  qty: number;
  targetCanonicalVariantId: string;
  evidenceStatus: "FACT" | "MANUAL_FACT" | "ESTIMATE" | "REJECT";
  content: ProductTruthContentFacts | null;
  contentBlockers: string[];
}

export interface ProductTruthManualCost {
  kind: "MANUAL";
  amount: number;
  currency: string;
  effectiveAt: string;
  source: string;
  approvalRef: string;
  policyVersion: string;
  evidenceHash: string;
}

export interface ProductTruthPriceOption extends ProductTruthMatcherProvenance {
  rank: number;
  eligibility: Exclude<PriceEvidenceEligibility, "REJECT">;
  observationId: string;
  observationKey: string;
  donorOfferId: string;
  donorProductId: string;
  canonicalVariantId: string;
  variantDecisionId: string;
  matchTier:
    | "EXACT_IDENTITY"
    | "CROSS_SIZE_ESTIMATE"
    | "SIBLING_ESTIMATE"
    | "SIZE_UNKNOWN_ESTIMATE";
  pricePolicyVersion: string;
  packagePrice: number | null;
  packSizeSeen: number | null;
  observedUnitPrice: number;
  targetComparableUnitPrice: number;
  currency: string;
  retailer: string;
  retailerProductId: string;
  via: string;
  productUrl: string;
  sellerName: string | null;
  sourceApi: string | null;
  locality: { zip: string | null; evidence: string };
  freshness: { observedAt: string; ageMs: number; maxAgeMs: number };
  sourceRun: {
    runId: string | null;
    approvalId: string | null;
    meteredReceiptId: string | null;
  };
  policyReasonCodes: readonly string[];
}

export interface ProductTruthProcurementComponent {
  componentIndex: number;
  product: string;
  requiredQuantity: number;
  factualOptions: ProductTruthPriceOption[];
  estimateOptions: ProductTruthPriceOption[];
  /** Accounting provenance only. Never a retailer buy option. */
  manualCost: ProductTruthManualCost | null;
  blockers: string[];
}

export interface ProductTruthCostRecord extends ProductTruthMatcherProvenance {
  id: string;
  observationKey: string;
  recipeHash: string;
  sku: string;
  effectiveDate: string;
  createdAt: string;
  source: string;
  productCost: number | null;
  packagingCost: number | null;
  iceCost: number | null;
  totalCost: number | null;
  costPerUnit: number | null;
  packSize: number | null;
  currency: string;
  needsReview: boolean;
  pricePolicyVersion: string;
  evidenceOutcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE";
  evidence: unknown;
  runId: string | null;
  approvalId: string | null;
  componentProvenance: Array<{
    componentIndex: number;
    kind: "RETAILER" | "MANUAL" | "ESTIMATE" | "REJECT";
    matcher: ProductTruthMatcherProvenance;
    manualCost: ProductTruthManualCost | null;
  }>;
}

export interface ProductTruthSnapshot {
  contractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  snapshot: {
    sku: string;
    channel: string;
    storeIndex: number;
    listingKey: string;
    asOf: string;
    maxPriceAgeMs: number;
    skuCostId: string | null;
  };
  recipe: { components: ProductTruthRecipeComponent[]; blockers: string[] };
  views: {
    bundleFactory: {
      consumer: "BUNDLE_FACTORY";
      ready: boolean;
      components: ProductTruthRecipeComponent[];
      blockers: string[];
    };
    listingImprovement: {
      consumer: "LISTING_IMPROVEMENT";
      ready: boolean;
      components: ProductTruthRecipeComponent[];
      blockers: string[];
    };
    unitEconomics: {
      consumer: "UNIT_ECONOMICS";
      status: ProductTruthCostStatus;
      current: ProductTruthCostRecord | null;
      factualCost: ProductTruthCostRecord | null;
      estimatedCost: ProductTruthCostRecord | null;
      blockers: string[];
    };
    procurement: {
      consumer: "PROCUREMENT";
      ready: boolean;
      components: ProductTruthProcurementComponent[];
      blockers: string[];
    };
  };
}

export class ProductTruthReadInputError extends Error {
  readonly code = "PRODUCT_TRUTH_READ_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProductTruthReadInputError";
  }
}

type JsonResult = { ok: true; value: unknown } | { ok: false; value: null };

function parseJson(value: unknown): JsonResult {
  if (typeof value !== "string" || !value.trim()) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed.ok && parsed.value !== null &&
      typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? parsed.value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerValue(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || (typeof value === "bigint" && Number(value) === 1)) return true;
  if (value === false || value === 0 || (typeof value === "bigint" && Number(value) === 0)) return false;
  return null;
}

function timeMs(value: unknown): number | null {
  const text = textValue(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeInstant(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new ProductTruthReadInputError("asOf must be a valid instant");
    }
    return value.toISOString();
  }
  const candidate = value.trim();
  if (!candidate || !/(?:z|[+-]\d{2}:\d{2})$/i.test(candidate)) {
    throw new ProductTruthReadInputError("asOf must include a timezone");
  }
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds)) {
    throw new ProductTruthReadInputError("asOf must be a valid instant");
  }
  return new Date(milliseconds).toISOString();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isCurrentMatcher(value: unknown): value is string {
  return value === CANONICAL_PRODUCT_MATCHER_VERSION;
}

function isCurrentMatcherProvenance(input: {
  matcherVersion: unknown;
  matcherImplementationSha256: unknown;
  matcherReleaseSha256: unknown;
}): boolean {
  return isCurrentMatcher(input.matcherVersion) &&
    input.matcherImplementationSha256 === CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256 &&
    input.matcherReleaseSha256 === CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
}

function isCurrentPricePolicy(value: unknown): value is string {
  return value === PRICE_EVIDENCE_POLICY_VERSION;
}

function isEvidenceStatus(
  value: unknown,
): value is "FACT" | "MANUAL_FACT" | "ESTIMATE" | "REJECT" {
  return value === "FACT" || value === "MANUAL_FACT" ||
    value === "ESTIMATE" || value === "REJECT";
}

function isMatchTier(value: unknown): value is ProductTruthPriceOption["matchTier"] {
  return value === "EXACT_IDENTITY" || value === "CROSS_SIZE_ESTIMATE" ||
    value === "SIBLING_ESTIMATE" || value === "SIZE_UNKNOWN_ESTIMATE";
}

type ExactProductTruthReadScope = ReturnType<typeof buildProductTruthListingScope>;

const PRODUCT_TRUTH_SQL_IN_CHUNK_SIZE = 200;

function chunks<T>(values: readonly T[], size = PRODUCT_TRUTH_SQL_IN_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function requestedScopeValues(scopes: readonly ExactProductTruthReadScope[]): {
  sql: string;
  args: Array<string | number>;
} {
  return {
    sql: scopes.map(() => "(?,?,?,?,?)").join(","),
    args: scopes.flatMap((scope, ordinal) => [
      ordinal, scope.listingKey, scope.channel, scope.storeIndex, scope.sku,
    ]),
  };
}

async function readListingScopeRows(
  tx: Transaction,
  scopes: readonly ExactProductTruthReadScope[],
): Promise<Row[]> {
  const requested = requestedScopeValues(scopes);
  return (await tx.execute({
    sql: `WITH requested(ordinal,listingKey,channel,storeIndex,sku) AS (
      VALUES ${requested.sql}
    )
    SELECT scope.*
    FROM requested
    JOIN ProductTruthListingScope scope
      ON scope.listingKey=requested.listingKey
     AND scope.channel=requested.channel
     AND scope.storeIndex=requested.storeIndex
     AND scope.sku=requested.sku
    ORDER BY requested.ordinal ASC`,
    args: requested.args,
  })).rows;
}

async function readCurrentCostRows(
  tx: Transaction,
  scopes: readonly ExactProductTruthReadScope[],
  asOf: string,
): Promise<Row[]> {
  const requested = requestedScopeValues(scopes);
  return (await tx.execute({
    // NULL/UNSOURCEABLE rows are ranked, never filtered, so an older positive
    // number cannot silently become current again.
    sql: `WITH requested(ordinal,listingKey,channel,storeIndex,sku) AS (
      VALUES ${requested.sql}
    )
    SELECT cost.*, requested.listingKey AS scopedListingKey
    FROM requested
    JOIN ProductTruthListingScope scope
      ON scope.listingKey=requested.listingKey
     AND scope.channel=requested.channel
     AND scope.storeIndex=requested.storeIndex
     AND scope.sku=requested.sku
    JOIN SkuCostListingScopeLink link ON link.listingKey=scope.listingKey
    JOIN SkuCost cost ON cost.id=link.skuCostId
    WHERE cost.id=(
      SELECT latest.id
      FROM SkuCost latest
      JOIN SkuCostListingScopeLink latestLink ON latestLink.skuCostId=latest.id
      WHERE latestLink.listingKey=requested.listingKey
        AND latest.sku=scope.sku
        AND latest.source='retail:batch'
        AND latest.effectiveDate IS NOT NULL
        AND julianday(latest.effectiveDate)<=julianday(?)
        AND julianday(latest.createdAt)<=julianday(?)
      ORDER BY julianday(latest.effectiveDate) DESC, latest.effectiveDate DESC,
        julianday(latest.createdAt) DESC, latest.createdAt DESC, latest.id DESC
      LIMIT 1
    )
    ORDER BY requested.ordinal ASC`,
    args: [...requested.args, asOf, asOf],
  })).rows;
}

async function readComponentEvidenceRows(
  tx: Transaction,
  skuCostIds: readonly string[],
): Promise<Row[]> {
  if (!skuCostIds.length) return [];
  const placeholders = skuCostIds.map(() => "?").join(",");
  return (await tx.execute({
    sql: `SELECT
      evidence.id AS componentEvidenceId, evidence.evidenceKey,
      evidence.skuCostId, evidence.componentIndex, evidence.evidenceStatus,
      evidence.targetCanonicalVariantId, evidence.contentCanonicalVariantId,
      evidence.priceCanonicalVariantId, evidence.contentObservationId,
      evidence.priceObservationId, evidence.matchTier, evidence.matcherVersion,
      evidence.matcherImplementationSha256, evidence.matcherReleaseSha256,
      evidence.pricePolicyVersion, evidence.evidenceHash,
      evidence.evidenceJson AS componentEvidenceJson,
      evidence.createdAt AS componentEvidenceCreatedAt,
      variant.variantKey, variant.identityHash, variant.keyVersion,
      variant.normalizedBrand, variant.normalizedProductLine,
      variant.normalizedFlavor, variant.normalizedModifiersJson,
      variant.normalizedForm, variant.sizeDimension, variant.sizeBaseAmount,
      variant.sizeBaseUnit, variant.outerPackCount,
      variant.identityJson AS variantIdentityJson, variant.createdAt AS variantCreatedAt,
      linkedContent.canonicalVariantId AS linkedContentVariantId,
      linkedPrice.canonicalVariantId AS linkedPriceVariantId
    FROM SkuComponentEvidence evidence
    JOIN CanonicalProductVariant variant
      ON variant.id=evidence.targetCanonicalVariantId
    LEFT JOIN ProductContentObservation linkedContent
      ON linkedContent.id=evidence.contentObservationId
    LEFT JOIN DonorOfferObservation linkedPrice
      ON linkedPrice.id=evidence.priceObservationId
    WHERE evidence.skuCostId IN (${placeholders})
    ORDER BY evidence.skuCostId ASC, evidence.componentIndex ASC, evidence.id ASC`,
    args: [...skuCostIds],
  })).rows;
}

async function readCurrentContentRows(
  tx: Transaction,
  variantIds: readonly string[],
  asOf: string,
): Promise<Row[]> {
  if (!variantIds.length) return [];
  const rows: Row[] = [];
  for (const variantChunk of chunks(unique(variantIds))) {
    const placeholders = variantChunk.map(() => "?").join(",");
    rows.push(...(await tx.execute({
      sql: `SELECT
        content.*, decision.decisionStatus, decision.matcherVersion AS decisionMatcherVersion,
        decision.matcherImplementationSha256 AS decisionMatcherImplementationSha256,
        decision.matcherReleaseSha256 AS decisionMatcherReleaseSha256,
        decision.evidenceHash AS decisionEvidenceHash,
        decision.evidenceJson AS decisionEvidenceJson,
        decision.donorProductId AS decisionDonorProductId,
        decision.canonicalVariantId AS decisionCanonicalVariantId
      FROM ProductContentObservation content
      JOIN DonorProductVariantDecision decision ON decision.id=content.variantDecisionId
      WHERE content.canonicalVariantId IN (${placeholders})
        AND julianday(content.observedAt)<=julianday(?)
        AND julianday(content.createdAt)<=julianday(?)
        AND content.id=(
          SELECT latest.id FROM ProductContentObservation latest
          WHERE latest.canonicalVariantId=content.canonicalVariantId
            AND julianday(latest.observedAt)<=julianday(?)
            AND julianday(latest.createdAt)<=julianday(?)
          ORDER BY julianday(latest.observedAt) DESC, latest.observedAt DESC,
            julianday(latest.createdAt) DESC, latest.createdAt DESC, latest.id DESC
          LIMIT 1
        )
      ORDER BY content.canonicalVariantId ASC`,
      args: [...variantChunk, asOf, asOf, asOf, asOf],
    })).rows);
  }
  return rows.sort((left, right) =>
    String(left.canonicalVariantId).localeCompare(String(right.canonicalVariantId)));
}

type ObservationContext = { row: Row; isLatest: boolean };

async function readRelevantPriceRows(
  tx: Transaction,
  variantIds: readonly string[],
  selectedObservationIds: readonly string[],
  asOf: string,
): Promise<ObservationContext[]> {
  if (!variantIds.length) return [];
  const allowedVariants = new Set(unique(variantIds));
  const byId = new Map<string, ObservationContext>();
  for (const variantChunk of chunks([...allowedVariants])) {
    const placeholders = variantChunk.map(() => "?").join(",");
    const result = await tx.execute({
      sql: `SELECT observation.*,
        decision.decisionStatus,
        decision.matcherVersion AS decisionMatcherVersion,
        decision.matcherImplementationSha256 AS decisionMatcherImplementationSha256,
        decision.matcherReleaseSha256 AS decisionMatcherReleaseSha256,
        decision.evidenceHash AS decisionEvidenceHash,
        decision.evidenceJson AS decisionEvidenceJson,
        decision.donorProductId AS decisionDonorProductId,
        decision.canonicalVariantId AS decisionCanonicalVariantId
      FROM DonorOfferObservation observation
      JOIN DonorProductVariantDecision decision ON decision.id=observation.variantDecisionId
      WHERE observation.canonicalVariantId IN (${placeholders})
        AND julianday(observation.observedAt)<=julianday(?)
        AND julianday(observation.createdAt)<=julianday(?)
        AND observation.id=(
          SELECT latest.id FROM DonorOfferObservation latest
          WHERE latest.donorOfferId=observation.donorOfferId
            AND latest.canonicalVariantId=observation.canonicalVariantId
            AND julianday(latest.observedAt)<=julianday(?)
            AND julianday(latest.createdAt)<=julianday(?)
          ORDER BY julianday(latest.observedAt) DESC, latest.observedAt DESC,
            julianday(latest.createdAt) DESC, latest.createdAt DESC, latest.id DESC
          LIMIT 1
        )`,
      args: [...variantChunk, asOf, asOf, asOf, asOf],
    });
    for (const row of result.rows) {
      byId.set(String(row.id), { row, isLatest: true });
    }
  }
  for (const selectedChunk of chunks(unique(selectedObservationIds))) {
    const placeholders = selectedChunk.map(() => "?").join(",");
    const result = await tx.execute({
      sql: `SELECT observation.*,
        decision.decisionStatus,
        decision.matcherVersion AS decisionMatcherVersion,
        decision.matcherImplementationSha256 AS decisionMatcherImplementationSha256,
        decision.matcherReleaseSha256 AS decisionMatcherReleaseSha256,
        decision.evidenceHash AS decisionEvidenceHash,
        decision.evidenceJson AS decisionEvidenceJson,
        decision.donorProductId AS decisionDonorProductId,
        decision.canonicalVariantId AS decisionCanonicalVariantId
      FROM DonorOfferObservation observation
      JOIN DonorProductVariantDecision decision ON decision.id=observation.variantDecisionId
      WHERE observation.id IN (${placeholders})
        AND julianday(observation.observedAt)<=julianday(?)
        AND julianday(observation.createdAt)<=julianday(?)`,
      args: [...selectedChunk, asOf, asOf],
    });
    for (const row of result.rows) {
      if (!allowedVariants.has(String(row.canonicalVariantId))) continue;
      const id = String(row.id);
      if (!byId.has(id)) byId.set(id, { row, isLatest: false });
    }
  }
  return [...byId.values()].sort((left, right) => {
    const timeDifference = (timeMs(right.row.observedAt) ?? -Infinity)
      - (timeMs(left.row.observedAt) ?? -Infinity);
    return timeDifference || String(left.row.id).localeCompare(String(right.row.id));
  });
}

type ComponentContext = {
  row: Row;
  evidence: Record<string, unknown> | null;
  recipe: ProductTruthRecipeComponent;
  coreBlockers: string[];
  priceBlockers: string[];
  contentLinkBlockers: string[];
};

function canonicalIdentityFromRow(row: Row): ProductTruthContentFacts["identity"] | null {
  const identity = parseJson(row.variantIdentityJson);
  const modifiers = parseJson(row.normalizedModifiersJson);
  const dimension = row.sizeDimension;
  const baseUnit = row.sizeBaseUnit;
  const sizeAmount = numberValue(row.sizeBaseAmount);
  const outerPackCount = integerValue(row.outerPackCount);
  if (
    !textValue(row.variantKey) || !textValue(row.identityHash) || !textValue(row.keyVersion) ||
    row.variantKey !== row.targetCanonicalVariantId ||
    row.variantKey !== `cpv1:${String(row.identityHash)}` ||
    row.keyVersion !== "canonical-product-variant-key/1.0.0" ||
    !textValue(row.normalizedBrand) || !identity.ok || !modifiers.ok ||
    !Array.isArray(modifiers.value) ||
    (dimension !== "MASS" && dimension !== "VOLUME" && dimension !== "COUNT") ||
    (baseUnit !== "g" && baseUnit !== "ml" && baseUnit !== "count") ||
    sizeAmount === null || sizeAmount <= 0 || outerPackCount === null || outerPackCount <= 0
  ) return null;
  return {
    variantKey: String(row.variantKey),
    identityHash: String(row.identityHash),
    keyVersion: String(row.keyVersion),
    brand: String(row.normalizedBrand),
    productLine: textValue(row.normalizedProductLine),
    flavor: textValue(row.normalizedFlavor),
    modifiers: modifiers.value,
    form: textValue(row.normalizedForm),
    sizeDimension: dimension,
    sizeBaseAmount: sizeAmount,
    sizeBaseUnit: baseUnit,
    outerPackCount,
    identity: identity.value,
  };
}

function componentMetadata(
  row: Row,
  evidence: Record<string, unknown> | null,
): { product: string; flavor: string | null; size: string | null; qty: number; blockers: string[] } {
  const blockers: string[] = [];
  const qty = integerValue(evidence?.qty);
  if (qty === null || qty <= 0) blockers.push("COMPONENT_QUANTITY_UNPROVEN");
  const product = textValue(evidence?.product) ?? [
    textValue(row.normalizedBrand), textValue(row.normalizedProductLine),
  ].filter(Boolean).join(" ");
  if (!product) blockers.push("COMPONENT_PRODUCT_LABEL_UNPROVEN");
  const derivedSize =
    `${numberValue(row.sizeBaseAmount) ?? ""} ${textValue(row.sizeBaseUnit) ?? ""}`.trim();
  const size = textValue(evidence?.size) ?? (derivedSize || null);
  return {
    product: product || "Unresolved canonical variant",
    flavor: textValue(evidence?.flavor) ?? textValue(row.normalizedFlavor),
    size,
    qty: qty ?? 0,
    blockers,
  };
}

function validateComponentRelations(
  row: Row,
  asOfMs: number,
): { coreBlockers: string[]; priceBlockers: string[]; contentLinkBlockers: string[] } {
  const coreBlockers: string[] = [];
  const priceBlockers: string[] = [];
  const contentLinkBlockers: string[] = [];
  const status = row.evidenceStatus;
  const target = textValue(row.targetCanonicalVariantId);
  const contentVariant = textValue(row.contentCanonicalVariantId);
  const priceVariant = textValue(row.priceCanonicalVariantId);
  const contentObservation = textValue(row.contentObservationId);
  const priceObservation = textValue(row.priceObservationId);
  if (!isEvidenceStatus(status)) coreBlockers.push("COMPONENT_EVIDENCE_STATUS_INVALID");
  if (!target) coreBlockers.push("TARGET_CANONICAL_VARIANT_MISSING");
  if (!isCurrentMatcher(row.matcherVersion)) {
    coreBlockers.push("COMPONENT_MATCHER_VERSION_NOT_CURRENT");
  }
  if (row.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256) {
    coreBlockers.push("COMPONENT_MATCHER_IMPLEMENTATION_NOT_CURRENT");
  }
  if (row.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256) {
    coreBlockers.push("COMPONENT_MATCHER_RELEASE_NOT_CURRENT");
  }
  if (status === "MANUAL_FACT") {
    if (!textValue(row.pricePolicyVersion)) priceBlockers.push("MANUAL_FACT_POLICY_MISSING");
  } else if (!isCurrentPricePolicy(row.pricePolicyVersion)) {
    priceBlockers.push("COMPONENT_PRICE_POLICY_NOT_CURRENT");
  }
  const componentEvidenceRaw = textValue(row.componentEvidenceJson);
  const componentEvidence = jsonObject(componentEvidenceRaw);
  if (!componentEvidence ||
      !componentEvidenceRaw || row.evidenceHash !== sha256Text(componentEvidenceRaw)) {
    coreBlockers.push("COMPONENT_EVIDENCE_PROVENANCE_INVALID");
  }
  if (componentEvidence && !isCurrentMatcherProvenance({
    matcherVersion: componentEvidence.matcherVersion,
    matcherImplementationSha256: componentEvidence.matcherImplementationSha256,
    matcherReleaseSha256: componentEvidence.matcherReleaseSha256,
  })) {
    coreBlockers.push("COMPONENT_EVIDENCE_MATCHER_PROVENANCE_NOT_CURRENT");
  }
  if ((timeMs(row.componentEvidenceCreatedAt) ?? Infinity) > asOfMs) {
    coreBlockers.push("COMPONENT_EVIDENCE_NOT_AVAILABLE_AT_SNAPSHOT");
  }
  if ((timeMs(row.variantCreatedAt) ?? Infinity) > asOfMs || !canonicalIdentityFromRow(row)) {
    coreBlockers.push("CANONICAL_VARIANT_INVALID_AT_SNAPSHOT");
  }

  // The stored content pair attests which exact content was available when the
  // cost row was written. It is optional and orthogonal to the price outcome.
  if ((contentVariant === null) !== (contentObservation === null)) {
    contentLinkBlockers.push("CONTENT_EVIDENCE_PAIR_INCOMPLETE");
  } else if (contentVariant && contentObservation &&
      (target !== contentVariant || row.linkedContentVariantId !== contentVariant)) {
    contentLinkBlockers.push("CONTENT_EVIDENCE_NOT_EXACT_TARGET");
  }

  if (status === "FACT") {
    if (!priceVariant || target !== priceVariant) {
      priceBlockers.push("FACT_PRICE_CANONICAL_VARIANT_NOT_EXACT");
    }
    if (!priceObservation || row.linkedPriceVariantId !== priceVariant) {
      priceBlockers.push("FACT_PRICE_OBSERVATION_INVALID");
    }
    if (row.matchTier !== "EXACT_IDENTITY") priceBlockers.push("FACT_MATCH_TIER_NOT_EXACT");
  } else if (status === "MANUAL_FACT") {
    const manualCost = manualCostFromEvidence(
      row,
      jsonObject(row.componentEvidenceJson),
      asOfMs,
    );
    if (priceVariant || priceObservation) {
      priceBlockers.push("MANUAL_FACT_RETAILER_PRICE_LINK_FORBIDDEN");
    }
    if (!manualCost) priceBlockers.push("MANUAL_FACT_PROVENANCE_INVALID");
  } else if (status === "ESTIMATE") {
    if (!priceVariant || !priceObservation || row.linkedPriceVariantId !== priceVariant) {
      priceBlockers.push("ESTIMATE_PRICE_OBSERVATION_INVALID");
    }
    // Match identity and price eligibility are independent axes. An exact
    // product observed through a typed estimate source (for example Instacart)
    // remains ESTIMATE even though the identity tier is EXACT_IDENTITY.
    if (!isMatchTier(row.matchTier)) priceBlockers.push("ESTIMATE_MATCH_TIER_INVALID");
  } else if (status === "REJECT") {
    if (priceVariant || priceObservation) {
      priceBlockers.push("REJECT_ACCEPTED_PRICE_LINK_FORBIDDEN");
    }
  }
  return {
    coreBlockers: unique(coreBlockers),
    priceBlockers: unique(priceBlockers),
    contentLinkBlockers: unique(contentLinkBlockers),
  };
}

function manualCostFromEvidence(
  row: Row,
  evidence: Record<string, unknown> | null,
  asOfMs?: number,
): ProductTruthManualCost | null {
  const raw = evidence?.manualCost;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const manual = raw as Record<string, unknown>;
  const amount = numberValue(manual.amount);
  const currency = textValue(manual.currency);
  const effectiveAt = textValue(manual.effectiveAt);
  const source = textValue(manual.source);
  const approvalRef = textValue(manual.approvalRef);
  const policyVersion = textValue(manual.policyVersion);
  if (amount === null || amount <= 0 || !currency || !effectiveAt ||
      timeMs(effectiveAt) === null ||
      (asOfMs !== undefined && (timeMs(effectiveAt) ?? Infinity) > asOfMs) ||
      !source || !approvalRef || !policyVersion ||
      policyVersion !== row.pricePolicyVersion || textValue(row.evidenceHash)?.length !== 64) {
    return null;
  }
  return {
    kind: "MANUAL", amount, currency, effectiveAt, source, approvalRef,
    policyVersion, evidenceHash: String(row.evidenceHash),
  };
}

function contentForComponent(
  context: ComponentContext,
  currentContent: Row | undefined,
  asOfMs: number,
): { content: ProductTruthContentFacts | null; blockers: string[] } {
  const row = context.row;
  const blockers: string[] = [
    ...context.coreBlockers,
    ...context.contentLinkBlockers,
  ];
  if (!currentContent) blockers.push("CURRENT_CONTENT_OBSERVATION_MISSING");
  const identity = canonicalIdentityFromRow(row);
  if (!identity) blockers.push("CANONICAL_IDENTITY_INVALID");
  const content = currentContent ? jsonObject(currentContent.contentJson) : null;
  const fieldHashes = currentContent ? jsonObject(currentContent.fieldHashesJson) : null;
  if (!content || !fieldHashes) blockers.push("CONTENT_PAYLOAD_INVALID");
  if (currentContent) {
    if (currentContent.canonicalVariantId !== row.targetCanonicalVariantId ||
        currentContent.decisionCanonicalVariantId !== row.targetCanonicalVariantId ||
        currentContent.donorProductId !== currentContent.decisionDonorProductId ||
        currentContent.decisionStatus !== "exact_confirmed") {
      blockers.push("CONTENT_EXACT_ALIAS_INVALID");
    }
    if (!isCurrentMatcherProvenance({
      matcherVersion: currentContent.decisionMatcherVersion,
      matcherImplementationSha256: currentContent.decisionMatcherImplementationSha256,
      matcherReleaseSha256: currentContent.decisionMatcherReleaseSha256,
    })) {
      blockers.push("CONTENT_DECISION_MATCHER_NOT_CURRENT");
    }
    if ((timeMs(currentContent.observedAt) ?? Infinity) > asOfMs ||
        (timeMs(currentContent.createdAt) ?? Infinity) > asOfMs) {
      blockers.push("CONTENT_NOT_AVAILABLE_AT_SNAPSHOT");
    }
    if (textValue(currentContent.contentHash)?.length !== 64 ||
        textValue(currentContent.decisionEvidenceHash)?.length !== 64 ||
        !textValue(currentContent.sourceUrl) || !textValue(currentContent.sourceApi)) {
      blockers.push("CONTENT_PROVENANCE_INCOMPLETE");
    }
    const contentJsonRaw = textValue(currentContent.contentJson);
    const decisionJsonRaw = textValue(currentContent.decisionEvidenceJson);
    const decisionEvidence = jsonObject(decisionJsonRaw);
    if (!contentJsonRaw || currentContent.contentHash !== sha256Text(contentJsonRaw) ||
        !decisionJsonRaw || currentContent.decisionEvidenceHash !== sha256Text(decisionJsonRaw)) {
      blockers.push("CONTENT_PROVENANCE_HASH_MISMATCH");
    }
    if (!decisionEvidence || !isCurrentMatcherProvenance({
      matcherVersion: decisionEvidence.matcherVersion,
      matcherImplementationSha256: decisionEvidence.matcherImplementationSha256,
      matcherReleaseSha256: decisionEvidence.matcherReleaseSha256,
    })) {
      blockers.push("CONTENT_DECISION_MATCHER_PROVENANCE_INVALID");
    }
  }
  if (blockers.length || !currentContent || !content || !fieldHashes || !identity) {
    return { content: null, blockers: unique(blockers) };
  }
  return {
    blockers: [],
    content: {
      canonicalVariantId: String(row.targetCanonicalVariantId),
      identity,
      facts: {
        title: textValue(content.title),
        description: textValue(content.description),
        bullets: content.bullets ?? null,
        attributes: content.attributes ?? null,
        nutritionFacts: content.nutritionFacts ?? null,
        ingredients: textValue(content.ingredients),
        mainImageUrl: textValue(content.mainImageUrl),
        imageUrls: stringArray(content.imageUrls),
      },
      provenance: {
        contentObservationId: String(currentContent.id),
        observationKey: String(currentContent.observationKey),
        donorProductId: String(currentContent.donorProductId),
        variantDecisionId: String(currentContent.variantDecisionId),
        matcherVersion: String(currentContent.decisionMatcherVersion),
        matcherImplementationSha256: String(
          currentContent.decisionMatcherImplementationSha256,
        ),
        matcherReleaseSha256: String(currentContent.decisionMatcherReleaseSha256),
        decisionEvidenceHash: String(currentContent.decisionEvidenceHash),
        contentHash: String(currentContent.contentHash),
        fieldHashes,
        sourceUrl: String(currentContent.sourceUrl),
        sourceApi: String(currentContent.sourceApi),
        observedAt: String(currentContent.observedAt),
        runId: textValue(currentContent.runId),
        approvalId: textValue(currentContent.approvalId),
        meteredReceiptId: textValue(currentContent.meteredReceiptId),
      },
    },
  };
}

function validatePriceRelation(
  context: ComponentContext,
  selected: ObservationContext | undefined,
): string[] {
  const row = context.row;
  const blockers = [...context.coreBlockers, ...context.priceBlockers];
  if (row.evidenceStatus !== "FACT" && row.evidenceStatus !== "ESTIMATE") {
    blockers.push("PRICE_EVIDENCE_NOT_ACCEPTED");
  }
  if (!selected) blockers.push("SELECTED_IMMUTABLE_PRICE_OBSERVATION_MISSING");
  if (selected) {
    if (selected.row.id !== row.priceObservationId ||
        selected.row.canonicalVariantId !== row.priceCanonicalVariantId) {
      blockers.push("SELECTED_PRICE_OBSERVATION_VARIANT_MISMATCH");
    }
    if (selected.row.decisionStatus !== "exact_confirmed" ||
        selected.row.donorProductId !== selected.row.decisionDonorProductId ||
        selected.row.canonicalVariantId !== selected.row.decisionCanonicalVariantId ||
        !isCurrentMatcherProvenance({
          matcherVersion: selected.row.decisionMatcherVersion,
          matcherImplementationSha256:
            selected.row.decisionMatcherImplementationSha256,
          matcherReleaseSha256: selected.row.decisionMatcherReleaseSha256,
        })) {
      blockers.push("SELECTED_PRICE_SOURCE_ALIAS_INVALID");
    }
  }
  return unique(blockers);
}

function targetComparableEstimate(context: ComponentContext): number | null {
  const direct = numberValue(context.evidence?.targetComparableUnitPrice);
  if (direct !== null && direct > 0) return direct;
  const conversion = context.evidence?.conversion;
  if (conversion && typeof conversion === "object" && !Array.isArray(conversion)) {
    const nested = numberValue((conversion as Record<string, unknown>).targetComparablePrice);
    if (nested !== null && nested > 0) return nested;
  }
  return null;
}

function optionFromObservation(
  context: ComponentContext,
  observation: ObservationContext,
  asOf: string,
  maxPriceAgeMs: number,
): { option: Omit<ProductTruthPriceOption, "rank"> | null; decision: PriceEvidenceDecision } {
  const row = observation.row;
  const matchTier = context.row.matchTier;
  const observedUnitPrice = numberValue(row.pricePerUnit);
  const decision = evaluatePriceEvidenceEligibility({
    retailer: textValue(row.retailer), via: textValue(row.via), price: observedUnitPrice,
    isFirstParty: booleanValue(row.isFirstParty), inStock: booleanValue(row.inStock),
    zip: textValue(row.zip), localityEvidence: textValue(row.localityEvidence),
    fetchedAt: textValue(row.observedAt), matchVerdict: textValue(matchTier),
  }, { now: asOf, maxAgeMs: maxPriceAgeMs });

  const decisionEvidenceRaw = textValue(row.decisionEvidenceJson);
  const decisionEvidence = jsonObject(decisionEvidenceRaw);

  const exactAlias = row.decisionStatus === "exact_confirmed" &&
    row.donorProductId === row.decisionDonorProductId &&
    row.canonicalVariantId === row.decisionCanonicalVariantId &&
    isCurrentMatcherProvenance({
      matcherVersion: row.decisionMatcherVersion,
      matcherImplementationSha256: row.decisionMatcherImplementationSha256,
      matcherReleaseSha256: row.decisionMatcherReleaseSha256,
    }) &&
    decisionEvidenceRaw !== null &&
    row.decisionEvidenceHash === sha256Text(decisionEvidenceRaw) &&
    decisionEvidence !== null &&
    isCurrentMatcherProvenance({
      matcherVersion: decisionEvidence.matcherVersion,
      matcherImplementationSha256: decisionEvidence.matcherImplementationSha256,
      matcherReleaseSha256: decisionEvidence.matcherReleaseSha256,
    });
  const productUrl = textValue(row.productUrl);
  const localityEvidence = textValue(row.localityEvidence);
  const observedAt = textValue(row.observedAt);
  if (decision.eligibility === "REJECT" || !exactAlias || !isMatchTier(matchTier) ||
      observedUnitPrice === null || decision.ageMs === null || !productUrl ||
      !localityEvidence || !observedAt || !textValue(row.canonicalVariantId) ||
      textValue(row.observationKey)?.length === 0) {
    return { option: null, decision };
  }
  const targetComparableUnitPrice = matchTier === "EXACT_IDENTITY"
    ? observedUnitPrice
    : row.id === context.row.priceObservationId
      ? targetComparableEstimate(context)
      : null;
  if (targetComparableUnitPrice === null) return { option: null, decision };

  return {
    decision,
    option: {
      eligibility: decision.eligibility,
      observationId: String(row.id), observationKey: String(row.observationKey),
      donorOfferId: String(row.donorOfferId), donorProductId: String(row.donorProductId),
      canonicalVariantId: String(row.canonicalVariantId),
      variantDecisionId: String(row.variantDecisionId),
      matchTier, matcherVersion: String(context.row.matcherVersion),
      matcherImplementationSha256: String(context.row.matcherImplementationSha256),
      matcherReleaseSha256: String(context.row.matcherReleaseSha256),
      pricePolicyVersion: decision.policyVersion,
      packagePrice: numberValue(row.price), packSizeSeen: integerValue(row.packSizeSeen),
      observedUnitPrice, targetComparableUnitPrice,
      currency: textValue(row.currency) ?? "USD", retailer: String(row.retailer),
      retailerProductId: String(row.retailerProductId), via: String(row.via),
      productUrl, sellerName: textValue(row.sellerName), sourceApi: textValue(row.sourceApi),
      locality: { zip: textValue(row.zip), evidence: localityEvidence },
      freshness: { observedAt, ageMs: decision.ageMs, maxAgeMs: decision.maxAgeMs },
      sourceRun: {
        runId: textValue(row.runId), approvalId: textValue(row.approvalId),
        meteredReceiptId: textValue(row.meteredReceiptId),
      },
      policyReasonCodes: decision.reasonCodes,
    },
  };
}

function rankOptions(options: Array<Omit<ProductTruthPriceOption, "rank">>): ProductTruthPriceOption[] {
  return options.sort((left, right) => {
    if (left.targetComparableUnitPrice !== right.targetComparableUnitPrice) {
      return left.targetComparableUnitPrice - right.targetComparableUnitPrice;
    }
    if (left.freshness.observedAt !== right.freshness.observedAt) {
      return right.freshness.observedAt.localeCompare(left.freshness.observedAt);
    }
    return left.retailer.localeCompare(right.retailer) ||
      left.observationId.localeCompare(right.observationId);
  }).map((option, index) => ({ ...option, rank: index + 1 }));
}

function currentCostView(
  row: Row | null,
  contexts: readonly ComponentContext[],
  scope: { channel: string; storeIndex: number; listingKey: string },
  asOfMs: number,
  scopeBlockers: readonly string[],
): ProductTruthSnapshot["views"]["unitEconomics"] {
  if (!row) return {
    consumer: "UNIT_ECONOMICS", status: "MISSING", current: null,
    factualCost: null, estimatedCost: null,
    blockers: unique([...scopeBlockers, "CURRENT_SCOPED_SKU_COST_MISSING"]),
  };
  const blockers: string[] = [...scopeBlockers];
  const evidence = jsonObject(row.evidenceJson);
  const outcome = textValue(row.evidenceOutcome);
  const observationKey = textValue(row.observationKey);
  const recipeHash = textValue(row.recipeHash);
  const effectiveDate = textValue(row.effectiveDate);
  const createdAt = textValue(row.createdAt);
  if (row.source !== "retail:batch") blockers.push("CURRENT_COST_NOT_CANONICAL_RETAIL_BATCH");
  if (observationKey?.length !== 64) blockers.push("COST_OBSERVATION_KEY_INVALID");
  if (recipeHash?.length !== 64) blockers.push("COST_RECIPE_HASH_INVALID");
  if (!evidence || evidence.outcome !== outcome || evidence.recipeHash !== recipeHash) {
    blockers.push("COST_EVIDENCE_INVALID");
  }
  if (textValue(evidence?.channel) !== scope.channel) {
    blockers.push("COST_CHANNEL_SCOPE_UNPROVEN");
  }
  if (integerValue(evidence?.storeIndex) !== scope.storeIndex) {
    blockers.push("COST_STORE_SCOPE_UNPROVEN");
  }
  if (textValue(evidence?.listingKey) !== scope.listingKey) {
    blockers.push("COST_LISTING_KEY_SCOPE_UNPROVEN");
  }
  if (!isCurrentMatcher(row.matcherVersion)) blockers.push("COST_MATCHER_VERSION_NOT_CURRENT");
  if (row.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256) {
    blockers.push("COST_MATCHER_IMPLEMENTATION_NOT_CURRENT");
  }
  if (row.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256) {
    blockers.push("COST_MATCHER_RELEASE_NOT_CURRENT");
  }
  if (evidence && !isCurrentMatcherProvenance({
    matcherVersion: evidence.matcherVersion,
    matcherImplementationSha256: evidence.matcherImplementationSha256,
    matcherReleaseSha256: evidence.matcherReleaseSha256,
  })) {
    blockers.push("COST_EVIDENCE_MATCHER_PROVENANCE_NOT_CURRENT");
  }
  const hasRetailerComponent = contexts.some((context) =>
    context.row.evidenceStatus === "FACT" || context.row.evidenceStatus === "ESTIMATE");
  if (hasRetailerComponent && !isCurrentPricePolicy(row.pricePolicyVersion)) {
    blockers.push("COST_PRICE_POLICY_NOT_CURRENT");
  } else if (!hasRetailerComponent && !textValue(row.pricePolicyVersion)) {
    blockers.push("COST_PRICE_POLICY_MISSING");
  }
  if (!contexts.length) blockers.push("COST_COMPONENT_EVIDENCE_MISSING");
  if (contexts.some((context) =>
    context.coreBlockers.length || context.priceBlockers.length)) {
    blockers.push("COST_COMPONENT_EVIDENCE_INVALID");
  }
  if (!effectiveDate || !createdAt || (timeMs(effectiveDate) ?? Infinity) > asOfMs ||
      (timeMs(createdAt) ?? Infinity) > asOfMs) blockers.push("COST_TIME_PROVENANCE_INVALID");
  const newestComponentEvidence = contexts.length
    ? Math.max(...contexts.map((context) => timeMs(context.row.componentEvidenceCreatedAt) ?? Infinity))
    : Infinity;
  if (!createdAt || newestComponentEvidence > (timeMs(createdAt) ?? -Infinity)) {
    blockers.push("COST_PREDATES_COMPONENT_EVIDENCE");
  }
  const statuses = contexts.map((context) => context.row.evidenceStatus);
  if (outcome === "FACT" && statuses.some((status) => status !== "FACT" && status !== "MANUAL_FACT")) {
    blockers.push("FACT_COST_COMPONENT_STATUS_INVALID");
  } else if (outcome === "ESTIMATE" &&
      (!statuses.includes("ESTIMATE") || statuses.includes("REJECT"))) {
    blockers.push("ESTIMATE_COST_COMPONENT_STATUS_INVALID");
  } else if (outcome === "UNSOURCEABLE" && !statuses.includes("REJECT")) {
    blockers.push("UNSOURCEABLE_COST_COMPONENT_STATUS_INVALID");
  } else if (outcome !== "FACT" && outcome !== "ESTIMATE" && outcome !== "UNSOURCEABLE") {
    blockers.push("COST_OUTCOME_INVALID");
  }
  if (outcome === "FACT" && (numberValue(row.totalCost) === null || booleanValue(row.needsReview) === true)) {
    blockers.push("FACT_COST_VALUE_INVALID");
  }
  if (outcome === "ESTIMATE" && numberValue(row.totalCost) === null) {
    blockers.push("ESTIMATE_COST_VALUE_INVALID");
  }
  if (outcome === "UNSOURCEABLE" && numberValue(row.totalCost) !== null) {
    blockers.push("UNSOURCEABLE_COST_MUST_NOT_HAVE_VALUE");
  }
  const valid = blockers.length === 0 && observationKey && recipeHash && effectiveDate && createdAt && evidence;
  const status: ProductTruthCostStatus = valid
    ? outcome as "FACT" | "ESTIMATE" | "UNSOURCEABLE"
    : "INVALID";
  const current: ProductTruthCostRecord | null = valid ? {
    id: String(row.id), observationKey, recipeHash, sku: String(row.sku),
    effectiveDate, createdAt, source: String(row.source),
    productCost: numberValue(row.productCost), packagingCost: numberValue(row.packagingCost),
    iceCost: numberValue(row.iceCost), totalCost: numberValue(row.totalCost),
    costPerUnit: numberValue(row.costPerUnit), packSize: integerValue(row.packSize),
    currency: textValue(row.currency) ?? "USD", needsReview: booleanValue(row.needsReview) === true,
    matcherVersion: String(row.matcherVersion),
    matcherImplementationSha256: String(row.matcherImplementationSha256),
    matcherReleaseSha256: String(row.matcherReleaseSha256),
    pricePolicyVersion: String(row.pricePolicyVersion),
    evidenceOutcome: outcome as "FACT" | "ESTIMATE" | "UNSOURCEABLE", evidence,
    runId: textValue(row.runId), approvalId: textValue(row.approvalId),
    componentProvenance: contexts.map((context) => ({
      componentIndex: integerValue(context.row.componentIndex) ?? -1,
      kind: context.row.evidenceStatus === "MANUAL_FACT" ? "MANUAL"
        : context.row.evidenceStatus === "FACT" ? "RETAILER"
          : context.row.evidenceStatus === "ESTIMATE" ? "ESTIMATE" : "REJECT",
      matcher: {
        matcherVersion: String(context.row.matcherVersion),
        matcherImplementationSha256: String(context.row.matcherImplementationSha256),
        matcherReleaseSha256: String(context.row.matcherReleaseSha256),
      },
      manualCost: context.row.evidenceStatus === "MANUAL_FACT"
        ? manualCostFromEvidence(context.row, context.evidence, asOfMs) : null,
    })),
  } : null;
  return {
    consumer: "UNIT_ECONOMICS", status, current,
    factualCost: status === "FACT" ? current : null,
    estimatedCost: status === "ESTIMATE" ? current : null,
    blockers: unique(blockers),
  };
}

interface NormalizedProductTruthBatchRead {
  scopes: ExactProductTruthReadScope[];
  expectedManifestSha256: string | null;
  asOf: string;
  asOfMs: number;
  maxPriceAgeMs: number;
}

function normalizeExpectedManifestSha256(
  value: unknown,
  required: boolean,
): string | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value.trim().toLowerCase())) {
    throw new ProductTruthReadInputError(
      "expectedManifestSha256 must be a SHA-256 digest when supplied",
    );
  }
  return value.trim().toLowerCase();
}

function normalizeProductTruthBatchRead(input: {
  scopes: readonly ProductTruthReadScope[];
  expectedManifestSha256: unknown;
  requireManifest: boolean;
  asOf: string | Date;
  maxPriceAgeMs: number;
}): NormalizedProductTruthBatchRead {
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 ||
      input.scopes.length > PRODUCT_TRUTH_MAX_BATCH_SCOPES) {
    throw new ProductTruthReadInputError(
      `scopes must contain 1-${PRODUCT_TRUTH_MAX_BATCH_SCOPES} exact listing scopes`,
    );
  }
  if (!Number.isFinite(input.maxPriceAgeMs) || input.maxPriceAgeMs < 0) {
    throw new ProductTruthReadInputError("maxPriceAgeMs must be a non-negative finite number");
  }
  const scopes = input.scopes.map((scope, index) => {
    try {
      return buildProductTruthListingScope(scope);
    } catch (error) {
      throw new ProductTruthReadInputError(
        `scopes[${index}]: ${error instanceof Error ? error.message : "listing scope is invalid"}`,
      );
    }
  });
  const listingKeys = new Set<string>();
  for (const scope of scopes) {
    if (listingKeys.has(scope.listingKey)) {
      throw new ProductTruthReadInputError(
        `duplicate exact listing scope ${scope.listingKey}`,
      );
    }
    listingKeys.add(scope.listingKey);
  }
  const asOf = normalizeInstant(input.asOf);
  return {
    scopes,
    expectedManifestSha256: normalizeExpectedManifestSha256(
      input.expectedManifestSha256,
      input.requireManifest,
    ),
    asOf,
    asOfMs: Date.parse(asOf),
    maxPriceAgeMs: input.maxPriceAgeMs,
  };
}

function assembleProductTruthSnapshot(input: {
  exactScope: ExactProductTruthReadScope;
  expectedManifestSha256: string | null;
  asOf: string;
  asOfMs: number;
  maxPriceAgeMs: number;
  scopeRow: Row | null;
  currentCost: Row | null;
  componentRows: Row[];
  currentContentByVariant: ReadonlyMap<string, Row>;
  priceRows: readonly ObservationContext[];
  priceById: ReadonlyMap<string, ObservationContext>;
}): ProductTruthSnapshot {
  const { sku, channel, storeIndex, listingKey } = input.exactScope;
  const scopeBlockers: string[] = [];
  if (!input.scopeRow) {
    scopeBlockers.push("LISTING_SCOPE_NOT_REGISTERED");
  } else if (
    input.scopeRow.keyVersion !== input.exactScope.keyVersion ||
    input.scopeRow.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST" ||
    textValue(input.scopeRow.manifestSha256)?.length !== 64 ||
    textValue(input.scopeRow.sourceContentSha256)?.length !== 64 ||
    !textValue(input.scopeRow.sourceReportId) || !textValue(input.scopeRow.ownerDecisionId)
  ) {
    scopeBlockers.push("LISTING_SCOPE_PROVENANCE_INVALID");
  }
  if (
    input.scopeRow && input.expectedManifestSha256 !== null &&
    textValue(input.scopeRow.manifestSha256)?.toLowerCase() !== input.expectedManifestSha256
  ) {
    scopeBlockers.push("LISTING_SCOPE_MANIFEST_MISMATCH");
  }
  const costId = input.currentCost ? String(input.currentCost.id) : null;
  const preliminary = input.componentRows.map((row) => {
    const evidence = jsonObject(row.componentEvidenceJson);
    return { row, evidence, ...validateComponentRelations(row, input.asOfMs) };
  });
  const recipeBlockers: string[] = [...scopeBlockers];
  if (!input.currentCost) recipeBlockers.push("CURRENT_SCOPED_SKU_COST_MISSING");
  if (input.currentCost && !input.componentRows.length) {
    recipeBlockers.push("CURRENT_COMPONENT_EVIDENCE_MISSING");
  }
  const contexts: ComponentContext[] = preliminary.map((pre) => {
    const metadata = componentMetadata(pre.row, pre.evidence);
    const contentResult = contentForComponent(
      { ...pre, recipe: undefined as never },
      input.currentContentByVariant.get(String(pre.row.targetCanonicalVariantId)),
      input.asOfMs,
    );
    const status = isEvidenceStatus(pre.row.evidenceStatus) ? pre.row.evidenceStatus : "REJECT";
    const recipe: ProductTruthRecipeComponent = {
      componentEvidenceId: String(pre.row.componentEvidenceId),
      componentIndex: integerValue(pre.row.componentIndex) ?? -1,
      product: metadata.product, flavor: metadata.flavor, size: metadata.size,
      qty: metadata.qty, targetCanonicalVariantId: String(pre.row.targetCanonicalVariantId),
      evidenceStatus: status, content: contentResult.content,
      contentBlockers: unique(contentResult.blockers),
    };
    recipeBlockers.push(...metadata.blockers.map((blocker) =>
      `COMPONENT_${recipe.componentIndex}:${blocker}`));
    if (pre.coreBlockers.length) recipeBlockers.push(...pre.coreBlockers.map((blocker) =>
      `COMPONENT_${recipe.componentIndex}:${blocker}`));
    return { ...pre, recipe };
  });

  const procurementComponents: ProductTruthProcurementComponent[] = contexts.map((context) => {
    const manualCost = context.row.evidenceStatus === "MANUAL_FACT"
      ? manualCostFromEvidence(context.row, context.evidence, input.asOfMs) : null;
    const selected = textValue(context.row.priceObservationId)
      ? input.priceById.get(String(context.row.priceObservationId)) : undefined;
    const blockers = context.row.evidenceStatus === "MANUAL_FACT"
      ? [...context.coreBlockers, ...context.priceBlockers]
      : validatePriceRelation(context, selected);
    if (manualCost) blockers.push("MANUAL_COST_NOT_RETAILER_BUY_OPTION");
    const candidates = blockers.length || !textValue(context.row.priceCanonicalVariantId)
      ? []
      : input.priceRows.filter((observation) => {
          if (observation.row.canonicalVariantId !== context.row.priceCanonicalVariantId) return false;
          if (context.row.evidenceStatus === "FACT") return observation.isLatest;
          return context.row.evidenceStatus === "ESTIMATE" && observation.isLatest &&
            observation.row.id === context.row.priceObservationId;
        });
    const facts: Array<Omit<ProductTruthPriceOption, "rank">> = [];
    const estimates: Array<Omit<ProductTruthPriceOption, "rank">> = [];
    for (const observation of candidates) {
      const evaluated = optionFromObservation(
        context, observation, input.asOf, input.maxPriceAgeMs,
      );
      if (!evaluated.option) continue;
      if (evaluated.option.eligibility === "FACT") facts.push(evaluated.option);
      else estimates.push(evaluated.option);
    }
    const factualOptions = rankOptions(facts);
    const estimateOptions = rankOptions(estimates);
    if (!manualCost && !factualOptions.length && !estimateOptions.length) {
      blockers.push("NO_CURRENT_ELIGIBLE_LOCAL_PRICE");
    }
    return {
      componentIndex: context.recipe.componentIndex, product: context.recipe.product,
      requiredQuantity: context.recipe.qty, factualOptions, estimateOptions, manualCost,
      blockers: unique(blockers),
    };
  });

  const components = contexts.map((context) => context.recipe);
  const contentBlockers = unique([
    ...recipeBlockers,
    ...components.flatMap((component) => component.contentBlockers.map((blocker) =>
      `COMPONENT_${component.componentIndex}:${blocker}`)),
  ]);
  const procurementBlockers = unique([
    ...recipeBlockers,
    ...procurementComponents.flatMap((component) => component.blockers.map((blocker) =>
      `COMPONENT_${component.componentIndex}:${blocker}`)),
  ]);
  const unitEconomics = currentCostView(
    input.currentCost,
    contexts,
    { channel, storeIndex, listingKey },
    input.asOfMs,
    scopeBlockers,
  );
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    snapshot: {
      sku, channel, storeIndex, listingKey, asOf: input.asOf,
      maxPriceAgeMs: input.maxPriceAgeMs, skuCostId: costId,
    },
    recipe: { components, blockers: unique(recipeBlockers) },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY", ready: components.length > 0 && contentBlockers.length === 0,
        components, blockers: contentBlockers,
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT", ready: components.length > 0 && contentBlockers.length === 0,
        components, blockers: contentBlockers,
      },
      unitEconomics,
      procurement: {
        consumer: "PROCUREMENT",
        ready: procurementComponents.length > 0 && procurementBlockers.length === 0 &&
          procurementComponents.every((component) => component.factualOptions.length > 0),
        components: procurementComponents, blockers: procurementBlockers,
      },
    },
  };
}

async function readNormalizedProductTruthSnapshotsFromTransaction(
  tx: Transaction,
  normalized: NormalizedProductTruthBatchRead,
): Promise<ProductTruthSnapshot[]> {
  const scopeRows = await readListingScopeRows(tx, normalized.scopes);
  const currentCostRows = await readCurrentCostRows(tx, normalized.scopes, normalized.asOf);
  const scopeByListingKey = new Map(
    scopeRows.map((row) => [String(row.listingKey), row]),
  );
  const costByListingKey = new Map(
    currentCostRows.map((row) => [String(row.scopedListingKey), row]),
  );
  const costIds = unique(currentCostRows.map((row) => String(row.id)));
  const componentRows = await readComponentEvidenceRows(tx, costIds);
  const componentsByCostId = new Map<string, Row[]>();
  for (const row of componentRows) {
    const costId = String(row.skuCostId);
    const rows = componentsByCostId.get(costId) ?? [];
    rows.push(row);
    componentsByCostId.set(costId, rows);
  }
  const contentVariantIds = unique(componentRows.flatMap((row) =>
    textValue(row.targetCanonicalVariantId)
      ? [String(row.targetCanonicalVariantId)] : []));
  const priceVariantIds = unique(componentRows.flatMap((row) =>
    textValue(row.priceCanonicalVariantId) ? [String(row.priceCanonicalVariantId)] : []));
  const selectedPriceIds = unique(componentRows.flatMap((row) =>
    textValue(row.priceObservationId) ? [String(row.priceObservationId)] : []));
  const currentContentRows = await readCurrentContentRows(
    tx, contentVariantIds, normalized.asOf,
  );
  const currentContentByVariant = new Map(
    currentContentRows.map((row) => [String(row.canonicalVariantId), row]),
  );
  const priceRows = await readRelevantPriceRows(
    tx, priceVariantIds, selectedPriceIds, normalized.asOf,
  );
  const priceById = new Map(
    priceRows.map((observation) => [String(observation.row.id), observation]),
  );
  return normalized.scopes.map((exactScope) => {
    const currentCost = costByListingKey.get(exactScope.listingKey) ?? null;
    return assembleProductTruthSnapshot({
      exactScope,
      expectedManifestSha256: normalized.expectedManifestSha256,
      asOf: normalized.asOf,
      asOfMs: normalized.asOfMs,
      maxPriceAgeMs: normalized.maxPriceAgeMs,
      scopeRow: scopeByListingKey.get(exactScope.listingKey) ?? null,
      currentCost,
      componentRows: currentCost
        ? componentsByCostId.get(String(currentCost.id)) ?? []
        : [],
      currentContentByVariant,
      priceRows,
      priceById,
    });
  });
}

async function readNormalizedProductTruthSnapshots(
  db: Client,
  normalized: NormalizedProductTruthBatchRead,
): Promise<ProductTruthSnapshot[]> {
  // One logical schema gate per batch. It is intentionally outside the data
  // transaction so a missing migration fails before any snapshot work begins.
  await assertProductTruthEvidenceSchema(db);
  await assertProductTruthListingScopeSchema(db);

  const tx = await db.transaction("read");
  try {
    return await readNormalizedProductTruthSnapshotsFromTransaction(tx, normalized);
  } finally {
    tx.close();
  }
}

/**
 * Returns four consumer projections for up to 100 exact listing scopes from
 * one read-only transaction and one manifest/as-of/freshness boundary.
 */
export async function readProductTruthSnapshots(
  db: Client,
  rawOptions: ProductTruthBatchReadOptions,
): Promise<ProductTruthSnapshot[]> {
  return readNormalizedProductTruthSnapshots(db, normalizeProductTruthBatchRead({
    scopes: rawOptions.scopes,
    expectedManifestSha256: rawOptions.expectedManifestSha256,
    requireManifest: true,
    asOf: rawOptions.asOf,
    maxPriceAgeMs: rawOptions.maxPriceAgeMs,
  }));
}

/**
 * Same canonical projection inside a caller-owned read transaction. The caller
 * must run both Product Truth schema gates before opening the transaction.
 */
export async function readProductTruthSnapshotsInTransaction(
  tx: Transaction,
  rawOptions: ProductTruthBatchReadOptions,
): Promise<ProductTruthSnapshot[]> {
  return readNormalizedProductTruthSnapshotsFromTransaction(
    tx,
    normalizeProductTruthBatchRead({
      scopes: rawOptions.scopes,
      expectedManifestSha256: rawOptions.expectedManifestSha256,
      requireManifest: true,
      asOf: rawOptions.asOf,
      maxPriceAgeMs: rawOptions.maxPriceAgeMs,
    }),
  );
}

/**
 * Point-read compatibility API. It delegates to the exact same batch
 * normalization, SQL loading, and snapshot assembler used by canonical
 * multi-listing consumers, so the two paths cannot acquire semantic drift.
 */
export async function readProductTruthSnapshot(
  db: Client,
  rawOptions: ProductTruthReadOptions,
): Promise<ProductTruthSnapshot> {
  const snapshots = await readNormalizedProductTruthSnapshots(
    db,
    normalizeProductTruthBatchRead({
      scopes: [{
        sku: rawOptions.sku,
        channel: rawOptions.channel,
        storeIndex: rawOptions.storeIndex,
      }],
      expectedManifestSha256: rawOptions.expectedManifestSha256,
      requireManifest: false,
      asOf: rawOptions.asOf,
      maxPriceAgeMs: rawOptions.maxPriceAgeMs,
    }),
  );
  return snapshots[0];
}

// Canonical catalog-first read view for creating a new SKU before a channel
// listing scope exists. SQL stays sourcing-internal; consumers enter through
// this versioned Product Truth boundary.
export {
  DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS,
  DEFAULT_WALMART_PILOT_ZIP,
  ProductTruthRecipeInputError as ProductTruthNewSkuReadError,
  buildWalmartPilotCandidateFromNewSkuView as buildProductTruthWalmartPilotCandidate,
  buildProductTruthRecipeComponentFromRows as buildProductTruthNewSkuRecipeComponentFromRows,
  listWalmartPilotCandidates as listProductTruthWalmartPilotCandidates,
  readProductTruthRecipeInput as readProductTruthNewSkuView,
  readWalmartPilotCandidate as readProductTruthWalmartPilotCandidate,
} from "./product-truth-new-sku-view";

export type {
  ProductTruthNewSkuPriceEvidence,
  ProductTruthNewSkuRecipeComponentEvidence,
  ProductTruthNewSkuCanonicalIdentity,
  ProductTruthNewSkuContentProvenance,
  ProductTruthRecipeInput as ProductTruthNewSkuView,
  ProductTruthRecipeReadOptions as ProductTruthNewSkuReadOptions,
  ProductTruthRecipeRequest as ProductTruthNewSkuRecipeRequest,
  ProductTruthWalmartPilotCandidateRead,
  ProductTruthWalmartPilotCandidateReadOptions,
  WalmartPilotCandidate as ProductTruthWalmartPilotCandidate,
} from "./product-truth-new-sku-view";
