/**
 * Append-only Product Truth materializer for an exact listing recipe whose
 * procurement price is an explicitly typed sibling-variant estimate.
 *
 * Identity and price remain separate: the listing recipe is bound to an exact
 * content donor/variant decision, while SkuComponentEvidence points at the
 * sibling price observation.  This module never upgrades a sibling proxy to a
 * FACT and never performs retailer/provider calls.
 */

import { createHash } from "node:crypto";

import type { Client, InStatement, Row } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
} from "./price-evidence-policy";
import {
  buildProductTruthListingRecipeMaterialization,
  materializeProductTruthListingRecipe,
  type ProductTruthListingRecipeMaterialization,
} from "./product-truth-listing-recipe";
import {
  SKU_COST_LISTING_SCOPE_LINK_VERSION,
} from "./product-truth-listing-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_SIBLING_ESTIMATE_VERSION =
  "product-truth-sibling-estimate/1.0.0" as const;

export interface ProductTruthSiblingEstimateInput {
  listingKey: string;
  manifestSha256: string;
  sku: string;
  quantity: number;
  product: string;
  flavor: string;
  size: string;
  targetCanonicalVariantId: string;
  contentDonorProductId: string;
  contentVariantDecisionId: string;
  contentObservationId: string;
  priceCanonicalVariantId: string;
  priceDonorProductId: string;
  priceVariantDecisionId: string;
  priceOfferId: string;
  priceObservationId: string;
  pricePerUnit: number;
  packagingCost: number;
  sourceArtifactSha256: string;
  evaluatedAt: string;
  createdAt: string;
  effectiveDate: string;
  runId: string;
  approvalId: string;
  sourceEvidence: unknown;
}

export interface ProductTruthSiblingEstimateCostRow {
  id: string;
  observationKey: string;
  sku: string;
  effectiveDate: string;
  productCost: number;
  packagingCost: number;
  totalCost: number;
  costPerUnit: number;
  packSize: number;
  includesPackaging: 0;
  currency: "USD";
  source: "retail:batch";
  confidence: number;
  needsReview: 1;
  notes: string;
  recipeHash: string;
  evidenceJson: string;
  evidenceOutcome: "ESTIMATE";
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  matcherImplementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
  matcherReleaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  pricePolicyVersion: typeof PRICE_EVIDENCE_POLICY_VERSION;
  runId: string;
  approvalId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTruthSiblingEstimateEvidenceRow {
  id: string;
  evidenceKey: string;
  skuCostId: string;
  componentIndex: 0;
  evidenceStatus: "ESTIMATE";
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string;
  priceCanonicalVariantId: string;
  contentObservationId: string;
  priceObservationId: string;
  matchTier: "SIBLING_ESTIMATE";
  matcherVersion: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
  matcherImplementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
  matcherReleaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  pricePolicyVersion: typeof PRICE_EVIDENCE_POLICY_VERSION;
  evidenceHash: string;
  evidenceJson: string;
  createdAt: string;
}

export interface ProductTruthSiblingEstimateMaterialization {
  recipe: ProductTruthListingRecipeMaterialization;
  cost: ProductTruthSiblingEstimateCostRow;
  componentEvidence: ProductTruthSiblingEstimateEvidenceRow;
  scopeLink: {
    skuCostId: string;
    listingKey: string;
    linkVersion: typeof SKU_COST_LISTING_SCOPE_LINK_VERSION;
    createdAt: string;
  };
}

export interface ProductTruthSiblingEstimateResult {
  status: "APPLIED" | "ALREADY_APPLIED";
  listingKey: string;
  sku: string;
  recipeHash: string;
  skuCostId: string;
  productCost: number;
  packagingCost: number;
  totalCost: number;
  costPerUnit: number;
  evidenceOutcome: "ESTIMATE";
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactText(value: unknown, label: string, maximum = 500): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
  ) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", label);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const result = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", label);
  }
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", label);
  }
  return Number(value);
}

function nonNegativeMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", label);
  }
  return Math.round(value * 100) / 100;
}

function positiveMoney(value: unknown, label: string): number {
  const result = nonNegativeMoney(value, label);
  if (result <= 0) fail("SIBLING_ESTIMATE_INPUT_INVALID", label);
  return result;
}

function exactInstant(value: unknown, label: string): string {
  const result = exactText(value, label, 80);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)
    || !Number.isFinite(Date.parse(result))
  ) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", label);
  }
  return result;
}

function exactDate(value: unknown): string {
  const result = exactText(value, "effectiveDate", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", "effectiveDate");
  }
  return result;
}

function scalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function assertEquivalent(
  actual: Row,
  expected: Record<string, unknown>,
  code: string,
): void {
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => !Object.is(scalar(actual[key]), scalar(value)))
    .map(([key]) => key);
  if (mismatches.length) fail(code, mismatches.join(","));
}

export function buildProductTruthSiblingEstimate(
  raw: ProductTruthSiblingEstimateInput,
): ProductTruthSiblingEstimateMaterialization {
  const listingKey = exactText(raw.listingKey, "listingKey");
  const manifestSha256 = exactSha(raw.manifestSha256, "manifestSha256");
  const sku = exactText(raw.sku, "sku");
  const expectedListingKey = `walmart:1:${sku}`;
  if (listingKey !== expectedListingKey) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", `listingKey must be ${expectedListingKey}`);
  }
  const quantity = positiveInteger(raw.quantity, "quantity");
  const product = exactText(raw.product, "product");
  const flavor = exactText(raw.flavor, "flavor");
  const size = exactText(raw.size, "size");
  const targetCanonicalVariantId = exactText(
    raw.targetCanonicalVariantId,
    "targetCanonicalVariantId",
  );
  const contentDonorProductId = exactText(
    raw.contentDonorProductId,
    "contentDonorProductId",
  );
  const contentVariantDecisionId = exactText(
    raw.contentVariantDecisionId,
    "contentVariantDecisionId",
  );
  const contentObservationId = exactText(
    raw.contentObservationId,
    "contentObservationId",
  );
  const priceCanonicalVariantId = exactText(
    raw.priceCanonicalVariantId,
    "priceCanonicalVariantId",
  );
  if (priceCanonicalVariantId === targetCanonicalVariantId) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", "price variant must be a sibling");
  }
  const priceDonorProductId = exactText(
    raw.priceDonorProductId,
    "priceDonorProductId",
  );
  const priceVariantDecisionId = exactText(
    raw.priceVariantDecisionId,
    "priceVariantDecisionId",
  );
  const priceOfferId = exactText(raw.priceOfferId, "priceOfferId");
  const priceObservationId = exactText(
    raw.priceObservationId,
    "priceObservationId",
  );
  const pricePerUnit = positiveMoney(raw.pricePerUnit, "pricePerUnit");
  const packagingCost = nonNegativeMoney(raw.packagingCost, "packagingCost");
  const sourceArtifactSha256 = exactSha(
    raw.sourceArtifactSha256,
    "sourceArtifactSha256",
  );
  const evaluatedAt = exactInstant(raw.evaluatedAt, "evaluatedAt");
  const createdAt = exactInstant(raw.createdAt, "createdAt");
  if (Date.parse(evaluatedAt) > Date.parse(createdAt)) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", "evaluatedAt exceeds createdAt");
  }
  const effectiveDate = exactDate(raw.effectiveDate);
  const runId = exactText(raw.runId, "runId");
  const approvalId = exactText(raw.approvalId, "approvalId");
  if (raw.sourceEvidence === undefined) {
    fail("SIBLING_ESTIMATE_INPUT_INVALID", "sourceEvidence");
  }

  const recipe = buildProductTruthListingRecipeMaterialization({
    listingKey,
    manifestSha256,
    sourceKind: "TARGETED_WALMART_EVIDENCE",
    sourceArtifactSha256,
    effectiveAt: evaluatedAt,
    createdAt,
    runId,
    approvalId,
    components: [{
      componentIndex: 0,
      quantity,
      product,
      flavor,
      size,
      targetCanonicalVariantId,
      donorProductId: contentDonorProductId,
      variantDecisionId: contentVariantDecisionId,
      sourceComponentId: null,
      sourceEvidence: raw.sourceEvidence,
    }],
  });

  const component = {
    idx: 0,
    product,
    flavor,
    size,
    qty: quantity,
    perUnit: pricePerUnit,
    method: "owner_approved_walmart_sibling_price_proxy",
    targetCanonicalVariantId,
    contentCanonicalVariantId: targetCanonicalVariantId,
    priceCanonicalVariantId,
    contentObservationId,
    priceEvidenceObservationId: priceObservationId,
    contentDonorProductId,
    priceEvidenceDonorProductId: priceDonorProductId,
    priceEvidenceOfferId: priceOfferId,
    priceVariantDecisionId,
    priceEvidenceStatus: "ESTIMATE",
    matchTier: "SIBLING_ESTIMATE",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
  } as const;
  const productCost = Math.round(pricePerUnit * quantity * 100) / 100;
  const totalCost = Math.round((productCost + packagingCost) * 100) / 100;
  const costPerUnit = Number((totalCost / quantity).toFixed(6));
  const evidence = {
    schemaVersion: "product-truth-sku-cost-evidence/1.0.0",
    materializerVersion: PRODUCT_TRUTH_SIBLING_ESTIMATE_VERSION,
    channel: "walmart",
    storeIndex: 1,
    listingKey,
    listingKeyVersion: "product-truth-listing-key/1.0.0",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    evaluatedAt,
    procurementZip: "33765",
    sourcePolicy: {
      policyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      classification: "SIBLING_ESTIMATE",
      ownerApproved: true,
      sourceArtifactSha256,
    },
    outcome: "ESTIMATE",
    recipeHash: recipe.recipe.recipeHash,
    total: totalCost,
    productCost,
    packagingCost,
    costPerUnit,
    packSize: quantity,
    runId,
    approvalId,
    components: [component],
  };
  const evidenceJson = renderProductTruthOperationalJson(evidence);
  const observationKey = productTruthOperationalSha256({
    version: PRODUCT_TRUTH_SIBLING_ESTIMATE_VERSION,
    listingKey,
    recipeHash: recipe.recipe.recipeHash,
    priceObservationId,
    pricePerUnit,
    packagingCost,
    evaluatedAt,
    runId,
    approvalId,
  });
  const skuCostId = `retail:${sku}:sibling:${observationKey.slice(0, 24)}`;
  const componentEvidencePayload = {
    schemaVersion: "product-truth-sku-component-evidence/1.0.0",
    materializerVersion: PRODUCT_TRUTH_SIBLING_ESTIMATE_VERSION,
    evidenceStatus: "ESTIMATE",
    targetCanonicalVariantId,
    contentCanonicalVariantId: targetCanonicalVariantId,
    priceCanonicalVariantId,
    contentObservationId,
    priceObservationId,
    product,
    flavor,
    size,
    qty: quantity,
    perUnit: pricePerUnit,
    method: component.method,
    targetComparableUnitPrice: pricePerUnit,
    matchTier: "SIBLING_ESTIMATE",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    sourceArtifactSha256,
  };
  const componentEvidenceJson = renderProductTruthOperationalJson(
    componentEvidencePayload,
  );
  const componentEvidenceHash = sha256(componentEvidenceJson);
  const evidenceKey = productTruthOperationalSha256({
    skuCostId,
    componentIndex: 0,
    evidenceHash: componentEvidenceHash,
  });

  return {
    recipe,
    cost: {
      id: skuCostId,
      observationKey,
      sku,
      effectiveDate,
      productCost,
      packagingCost,
      totalCost,
      costPerUnit,
      packSize: quantity,
      includesPackaging: 0,
      currency: "USD",
      source: "retail:batch",
      confidence: 0.85,
      needsReview: 1,
      notes: "ESTIMATE: exact Roast Chicken identity; $0.64 Walmart Chicken sibling proxy; dry packaging $1.50",
      recipeHash: recipe.recipe.recipeHash,
      evidenceJson,
      evidenceOutcome: "ESTIMATE",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      runId,
      approvalId,
      createdAt,
      updatedAt: createdAt,
    },
    componentEvidence: {
      id: `sce:${evidenceKey}`,
      evidenceKey,
      skuCostId,
      componentIndex: 0,
      evidenceStatus: "ESTIMATE",
      targetCanonicalVariantId,
      contentCanonicalVariantId: targetCanonicalVariantId,
      priceCanonicalVariantId,
      contentObservationId,
      priceObservationId,
      matchTier: "SIBLING_ESTIMATE",
      matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
      evidenceHash: componentEvidenceHash,
      evidenceJson: componentEvidenceJson,
      createdAt,
    },
    scopeLink: {
      skuCostId,
      listingKey,
      linkVersion: SKU_COST_LISTING_SCOPE_LINK_VERSION,
      createdAt,
    },
  };
}

function scopeLinkInsert(
  row: ProductTruthSiblingEstimateMaterialization["scopeLink"],
): InStatement {
  return {
    sql: `INSERT INTO SkuCostListingScopeLink
      (skuCostId,listingKey,linkVersion,createdAt) VALUES (?,?,?,?)`,
    args: [row.skuCostId, row.listingKey, row.linkVersion, row.createdAt],
  };
}

function evidenceInsert(row: ProductTruthSiblingEstimateEvidenceRow): InStatement {
  return {
    sql: `INSERT INTO SkuComponentEvidence (
      id,evidenceKey,skuCostId,componentIndex,evidenceStatus,
      targetCanonicalVariantId,contentCanonicalVariantId,priceCanonicalVariantId,
      contentObservationId,priceObservationId,matchTier,matcherVersion,
      matcherImplementationSha256,matcherReleaseSha256,pricePolicyVersion,
      evidenceHash,evidenceJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id, row.evidenceKey, row.skuCostId, row.componentIndex,
      row.evidenceStatus, row.targetCanonicalVariantId,
      row.contentCanonicalVariantId, row.priceCanonicalVariantId,
      row.contentObservationId, row.priceObservationId, row.matchTier,
      row.matcherVersion, row.matcherImplementationSha256,
      row.matcherReleaseSha256, row.pricePolicyVersion, row.evidenceHash,
      row.evidenceJson, row.createdAt,
    ],
  };
}

function costInsert(row: ProductTruthSiblingEstimateCostRow): InStatement {
  return {
    sql: `INSERT INTO SkuCost (
      id,observationKey,sku,asin,effectiveDate,productCost,packagingCost,iceCost,
      totalCost,costPerUnit,packSize,includesPackaging,currency,source,confidence,
      needsReview,notes,recipeHash,evidenceJson,evidenceOutcome,matcherVersion,
      matcherImplementationSha256,matcherReleaseSha256,pricePolicyVersion,
      runId,approvalId,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id, row.observationKey, row.sku, null, row.effectiveDate,
      row.productCost, row.packagingCost, null, row.totalCost, row.costPerUnit,
      row.packSize, row.includesPackaging, row.currency, row.source,
      row.confidence, row.needsReview, row.notes, row.recipeHash,
      row.evidenceJson, row.evidenceOutcome, row.matcherVersion,
      row.matcherImplementationSha256, row.matcherReleaseSha256,
      row.pricePolicyVersion, row.runId, row.approvalId, row.createdAt,
      row.updatedAt,
    ],
  };
}

async function exactExisting(
  db: Client,
  materialization: ProductTruthSiblingEstimateMaterialization,
): Promise<boolean> {
  const costs = (await db.execute({
    sql: "SELECT * FROM SkuCost WHERE id=? OR observationKey=?",
    args: [
      materialization.cost.id,
      materialization.cost.observationKey,
    ],
  })).rows;
  if (!costs.length) return false;
  if (costs.length !== 1) fail("SIBLING_ESTIMATE_IDEMPOTENCY_CONFLICT", "cost");
  assertEquivalent(
    costs[0],
    {
      ...materialization.cost,
      asin: null,
      iceCost: null,
    },
    "SIBLING_ESTIMATE_IDEMPOTENCY_CONFLICT",
  );
  const evidence = (await db.execute({
    sql: "SELECT * FROM SkuComponentEvidence WHERE skuCostId=?",
    args: [materialization.cost.id],
  })).rows;
  if (evidence.length !== 1) {
    fail("SIBLING_ESTIMATE_IDEMPOTENCY_CONFLICT", "componentEvidence");
  }
  assertEquivalent(
    evidence[0],
    materialization.componentEvidence as unknown as Record<string, unknown>,
    "SIBLING_ESTIMATE_IDEMPOTENCY_CONFLICT",
  );
  const link = (await db.execute({
    sql: "SELECT * FROM SkuCostListingScopeLink WHERE skuCostId=?",
    args: [materialization.cost.id],
  })).rows;
  if (link.length !== 1) {
    fail("SIBLING_ESTIMATE_IDEMPOTENCY_CONFLICT", "scopeLink");
  }
  assertEquivalent(
    link[0],
    materialization.scopeLink as unknown as Record<string, unknown>,
    "SIBLING_ESTIMATE_IDEMPOTENCY_CONFLICT",
  );
  return true;
}

export async function materializeProductTruthSiblingEstimate(
  db: Client,
  input: ProductTruthSiblingEstimateInput,
): Promise<ProductTruthSiblingEstimateResult> {
  await assertProductTruthEvidenceSchema(db);
  await assertProductTruthListingScopeSchema(db);
  const materialization = buildProductTruthSiblingEstimate(input);
  await materializeProductTruthListingRecipe(db, {
    listingKey: input.listingKey,
    manifestSha256: input.manifestSha256,
    sourceKind: "TARGETED_WALMART_EVIDENCE",
    sourceArtifactSha256: input.sourceArtifactSha256,
    effectiveAt: input.evaluatedAt,
    createdAt: input.createdAt,
    runId: input.runId,
    approvalId: input.approvalId,
    components: [{
      componentIndex: 0,
      quantity: input.quantity,
      product: input.product,
      flavor: input.flavor,
      size: input.size,
      targetCanonicalVariantId: input.targetCanonicalVariantId,
      donorProductId: input.contentDonorProductId,
      variantDecisionId: input.contentVariantDecisionId,
      sourceComponentId: null,
      sourceEvidence: input.sourceEvidence,
    }],
  });
  const existed = await exactExisting(db, materialization);
  if (!existed) {
    const orphanEvidence = (await db.execute({
      sql: `SELECT 1 FROM SkuComponentEvidence
            WHERE id=? OR evidenceKey=? OR (skuCostId=? AND componentIndex=0)
            LIMIT 1`,
      args: [
        materialization.componentEvidence.id,
        materialization.componentEvidence.evidenceKey,
        materialization.cost.id,
      ],
    })).rows;
    const orphanLink = (await db.execute({
      sql: "SELECT 1 FROM SkuCostListingScopeLink WHERE skuCostId=? LIMIT 1",
      args: [materialization.cost.id],
    })).rows;
    if (orphanEvidence.length || orphanLink.length) {
      fail("SIBLING_ESTIMATE_ORPHAN_CONFLICT", input.listingKey);
    }
    await db.batch([
      scopeLinkInsert(materialization.scopeLink),
      evidenceInsert(materialization.componentEvidence),
      costInsert(materialization.cost),
    ], "write");
    if (!(await exactExisting(db, materialization))) {
      fail("SIBLING_ESTIMATE_POSTCONDITION_FAILED", input.listingKey);
    }
  }
  return {
    status: existed ? "ALREADY_APPLIED" : "APPLIED",
    listingKey: input.listingKey,
    sku: input.sku,
    recipeHash: materialization.cost.recipeHash,
    skuCostId: materialization.cost.id,
    productCost: materialization.cost.productCost,
    packagingCost: materialization.cost.packagingCost,
    totalCost: materialization.cost.totalCost,
    costPerUnit: materialization.cost.costPerUnit,
    evidenceOutcome: "ESTIMATE",
  };
}
