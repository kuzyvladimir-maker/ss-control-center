import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildCanonicalProductVariantKey } from "../canonical-product-variant";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import { parseUnwrangleDetailPayload } from "../donor-catalog";
import type { ProductTruthOperationalMeteredReceipt } from "../product-truth-operational-ledger";
import {
  buildProductTruthTargetedWalmartEvidencePlan,
  buildProductTruthTargetedWalmartEvidenceRequest,
  buildProductTruthTargetedWalmartLegacySnapshot,
  canonicalIdentityFromTarget,
  parseProductTruthTargetedWalmartDonorSnapshot,
  PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION,
  targetedWalmartDonorSnapshotSha256,
  type ProductTruthTargetedWalmartDonorSnapshot,
  type ProductTruthTargetedWalmartEvidenceTarget,
} from "../product-truth-targeted-walmart-evidence-contract";
import {
  deriveTargetedWalmartLegacyCanonicalIdentity,
  decideProductTruthTargetedResume,
  selectExactTargetedWalmartOffer,
} from "../product-truth-targeted-walmart-evidence";
import type { RetailOffer } from "../retail-fetch";

const CREATED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-19T13:00:00.000Z";
const HASH = "a".repeat(64);
const DECISION_EVIDENCE_JSON = JSON.stringify({
  matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
  schemaVersion: "donor-source-identity-evidence/1.1.0",
});
const DECISION_EVIDENCE_HASH = createHash("sha256")
  .update(DECISION_EVIDENCE_JSON)
  .digest("hex");

const canonical = buildCanonicalProductVariantKey({
  brand: "Acme",
  productLine: "Potato Chips",
  flavor: "Original",
  modifiers: [],
  form: "Bag",
  size: "8 oz",
  outerPackCount: 1,
});

function exactSnapshot(): ProductTruthTargetedWalmartDonorSnapshot {
  return parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "EXISTING_EXACT",
    identityDerivationVersion: null,
    donorProductId: "donor-1",
    donorOfferId: "offer-1",
    donorIdentityStatus: "exact_confirmed",
    variantDecisionId: "decision-1",
    canonicalVariantId: canonical.canonicalVariantId,
    decisionStatus: "exact_confirmed",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    decisionEvidenceHash: DECISION_EVIDENCE_HASH,
    decisionEvidenceJson: DECISION_EVIDENCE_JSON,
    canonicalVariantKeyVersion: canonical.keyVersion,
    canonicalIdentityHash: canonical.identityHash,
    canonicalIdentityJson: canonical.identityJson,
    retailer: "walmart",
    retailerProductId: "123456789",
    normalizedProductUrl: "https://www.walmart.com/ip/123456789",
    via: "direct",
    isFirstParty: true,
    legacySnapshot: null,
  });
}

function bootstrapSnapshot(): ProductTruthTargetedWalmartDonorSnapshot {
  const product = {
    id: "donor-1",
    identityStatus: "legacy_unverified",
    brand: "Acme",
    size: "8 oz",
    title: "Acme Potato Chips Original Bag 8 oz",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const offer = {
    id: "offer-1",
    donorProductId: "donor-1",
    retailer: "walmart",
    retailerProductId: "123456789",
    via: "direct",
    isFirstParty: 1,
    packSizeSeen: 1,
    sellerName: "Walmart.com",
    productUrl: "https://www.walmart.com/ip/legacy-name/123456789?athbdg=L1100",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const machineCanonical = deriveTargetedWalmartLegacyCanonicalIdentity({
    donorProductRow: product,
    donorOfferRow: offer,
  });
  return parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "EVIDENCE_VERIFIED_BOOTSTRAP",
    identityDerivationVersion:
      PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION,
    donorProductId: "donor-1",
    donorOfferId: "offer-1",
    donorIdentityStatus: "legacy_unverified",
    variantDecisionId: null,
    canonicalVariantId: machineCanonical.canonicalVariantId,
    decisionStatus: null,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    decisionEvidenceHash: null,
    decisionEvidenceJson: null,
    canonicalVariantKeyVersion: canonical.keyVersion,
    canonicalIdentityHash: machineCanonical.identityHash,
    canonicalIdentityJson: machineCanonical.identityJson,
    retailer: "walmart",
    retailerProductId: "123456789",
    normalizedProductUrl: "https://www.walmart.com/ip/123456789",
    via: "direct",
    isFirstParty: true,
    legacySnapshot: buildProductTruthTargetedWalmartLegacySnapshot({
      donorProductRow: product,
      donorOfferRow: offer,
    }),
  });
}

function planFor(snapshot: ProductTruthTargetedWalmartDonorSnapshot) {
  const request = buildProductTruthTargetedWalmartEvidenceRequest({
    runId: "targeted-run-1",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    targetFingerprint: HASH,
    engineReleaseSha256: "b".repeat(64),
    schemaFingerprintSha256: "c".repeat(64),
    migrationSetSha256: "d".repeat(64),
    query: "Acme Potato Chips Original 8 oz",
    donorSnapshot: snapshot,
    unwrangleReserveFloor: 100,
  });
  return buildProductTruthTargetedWalmartEvidencePlan({
    request,
    actualTargetFingerprint: HASH,
    actualEngineReleaseSha256: "b".repeat(64),
    actualSchemaFingerprintSha256: "c".repeat(64),
    actualMigrationSetSha256: "d".repeat(64),
    actualDonorSnapshot: snapshot,
    actualDetailHarvestStateAbsent: true,
  });
}

test("targeted donor snapshots reject matcher implementation or release drift", () => {
  const snapshot = exactSnapshot();
  assert.throws(
    () => parseProductTruthTargetedWalmartDonorSnapshot({
      ...snapshot,
      matcherImplementationSha256: "0".repeat(64),
    }),
    /TARGETED_EVIDENCE_IDENTITY_NOT_EXACT/,
  );
  assert.throws(
    () => parseProductTruthTargetedWalmartDonorSnapshot({
      ...snapshot,
      matcherReleaseSha256: "0".repeat(64),
    }),
    /TARGETED_EVIDENCE_IDENTITY_NOT_EXACT/,
  );
});

test("existing exact snapshots bind decision evidence bytes and reject forged provenance", () => {
  const snapshot = exactSnapshot();
  assert.equal(snapshot.decisionEvidenceHash, DECISION_EVIDENCE_HASH);
  assert.equal(snapshot.decisionEvidenceJson, DECISION_EVIDENCE_JSON);

  assert.throws(
    () => parseProductTruthTargetedWalmartDonorSnapshot({
      ...snapshot,
      decisionEvidenceHash: "0".repeat(64),
    }),
    /TARGETED_EVIDENCE_DECISION_EVIDENCE_HASH_MISMATCH/,
  );

  const staleEvidenceJson = JSON.stringify({
    ...JSON.parse(DECISION_EVIDENCE_JSON) as Record<string, unknown>,
    matcherReleaseSha256: "0".repeat(64),
  });
  assert.throws(
    () => parseProductTruthTargetedWalmartDonorSnapshot({
      ...snapshot,
      decisionEvidenceHash: createHash("sha256").update(staleEvidenceJson).digest("hex"),
      decisionEvidenceJson: staleEvidenceJson,
    }),
    /TARGETED_EVIDENCE_DECISION_EVIDENCE_MATCHER_MISMATCH/,
  );

  const plan = planFor(snapshot);
  assert.equal(plan.targets[0].decisionEvidenceHash, DECISION_EVIDENCE_HASH);
  assert.equal(plan.targets[0].decisionEvidenceJson, DECISION_EVIDENCE_JSON);

  const changedEvidenceJson = JSON.stringify({
    ...JSON.parse(DECISION_EVIDENCE_JSON) as Record<string, unknown>,
    sourceObservationId: "immutable-observation-2",
  });
  const changedSnapshot = parseProductTruthTargetedWalmartDonorSnapshot({
    ...snapshot,
    decisionEvidenceHash: createHash("sha256").update(changedEvidenceJson).digest("hex"),
    decisionEvidenceJson: changedEvidenceJson,
  });
  const changedPlan = planFor(changedSnapshot);
  assert.notEqual(
    targetedWalmartDonorSnapshotSha256(snapshot),
    targetedWalmartDonorSnapshotSha256(changedSnapshot),
  );
  assert.notEqual(plan.manifest.sha256, changedPlan.manifest.sha256);
  assert.notEqual(plan.targetSetSha256, changedPlan.targetSetSha256);
});

test("existing and evidence-verified bootstrap plans seal honest write claims", () => {
  const existing = planFor(exactSnapshot());
  assert.equal(existing.claims.identityMode, "EXISTING_EXACT");
  assert.equal(existing.claims.canonicalVariantWritesMax, 0);
  assert.equal(existing.claims.variantDecisionWritesMax, 0);
  assert.equal(existing.claims.targetProductProjectionMayChange, false);
  assert.deepEqual(existing.providerCeilings.map((row) => [row.provider, row.maxCalls, row.maxUnits]), [
    ["oxylabs", 1, 1],
    ["unwrangle", 1, 2.5],
  ]);
  assert.equal(existing.sourcePolicy.allowOpenFoodFactsSupplement, false);
  assert.equal(existing.sourcePolicy.allowClubs, false);
  assert.equal(existing.sourcePolicy.allowBjs, false);

  const bootstrap = planFor(bootstrapSnapshot());
  assert.equal(bootstrap.claims.identityMode, "EVIDENCE_VERIFIED_BOOTSTRAP");
  assert.equal(bootstrap.claims.canonicalVariantWritesMax, 1);
  assert.equal(bootstrap.claims.variantDecisionWritesMax, 1);
  assert.equal(bootstrap.claims.targetProductProjectionMayChange, true);
  assert.ok(bootstrap.targets[0].legacySnapshot?.sha256);
});

test("bootstrap identity must round-trip through the canonical builder", () => {
  const valid = bootstrapSnapshot();
  const malformed = JSON.parse(valid.canonicalIdentityJson) as Record<string, unknown>;
  malformed.brand = "ACME";
  const malformedJson = JSON.stringify(malformed);
  assert.throws(() => parseProductTruthTargetedWalmartDonorSnapshot({
    ...valid,
    canonicalIdentityJson: malformedJson,
    canonicalIdentityHash: createHash("sha256").update(malformedJson).digest("hex"),
    canonicalVariantId: `cpv1:${createHash("sha256").update(malformedJson).digest("hex")}`,
  }), /TARGETED_EVIDENCE_IDENTITY_(?:NOT_CANONICAL|HASH_MISMATCH)/);

  const modifierCanonical = buildCanonicalProductVariantKey({
    brand: "Acme", productLine: "Potato Chips", flavor: "Original",
    modifiers: ["sun ripened"], form: "Bag", size: "8 oz", outerPackCount: 1,
  });
  const target = {
    ...planFor(valid).targets[0],
    canonicalVariantId: modifierCanonical.canonicalVariantId,
    canonicalIdentityHash: modifierCanonical.identityHash,
    canonicalIdentityJson: modifierCanonical.identityJson,
  } as ProductTruthTargetedWalmartEvidenceTarget;
  const rebuilt = buildCanonicalProductVariantKey(canonicalIdentityFromTarget(target));
  assert.equal(rebuilt.identityJson, modifierCanonical.identityJson);
  assert.equal(rebuilt.canonicalVariantId, modifierCanonical.canonicalVariantId);
  assert.ok(modifierCanonical.normalized.modifiers.some((modifier) => modifier.startsWith("token:")));

  const multipack = buildCanonicalProductVariantKey({
    brand: "Acme", productLine: "Potato Chips", flavor: "Original",
    modifiers: [], form: "Bag", size: "8 oz", outerPackCount: 2,
  });
  assert.throws(() => parseProductTruthTargetedWalmartDonorSnapshot({
    ...valid,
    canonicalVariantId: multipack.canonicalVariantId,
    canonicalIdentityHash: multipack.identityHash,
    canonicalIdentityJson: multipack.identityJson,
  }), /TARGETED_EVIDENCE_IDENTITY_NOT_CANONICAL/);
});

test("legacy seal binds Walmart item URL and Walmart.com seller", () => {
  const valid = bootstrapSnapshot();
  const legacy = valid.legacySnapshot!;
  const badOffer = JSON.parse(legacy.donorOfferRowJson) as Record<string, unknown>;
  badOffer.productUrl = "https://www.walmart.com/ip/987654321";
  const badLegacy = buildProductTruthTargetedWalmartLegacySnapshot({
    donorProductRow: JSON.parse(legacy.donorProductRowJson),
    donorOfferRow: badOffer,
  });
  assert.throws(() => parseProductTruthTargetedWalmartDonorSnapshot({
    ...valid,
    legacySnapshot: badLegacy,
  }), /WALMART_ITEM_URL_MISMATCH|TARGETED_EVIDENCE_LEGACY_SNAPSHOT_INVALID/);
});

test("RITZ legacy bytes derive a conservative identity and fresh search rejects sibling flavor", () => {
  const product = {
    id: "75422f18-e3d2-4c62-ae62-7287aaa75119",
    identityStatus: "legacy_unverified",
    brand: "Ritz",
    size: "8.8 oz",
    title: "RITZ Bits Cheese Sandwich Crackers Lunch Snacks - 8.8oz",
  };
  const legacyOffer = {
    id: "do:walmart:34312392",
    donorProductId: product.id,
    retailer: "walmart",
    retailerProductId: "34312392",
    via: "direct",
    isFirstParty: 1,
    packSizeSeen: 1,
    sellerName: "Walmart.com",
    productUrl: "https://www.walmart.com/ip/34312392",
  };
  const derived = deriveTargetedWalmartLegacyCanonicalIdentity({
    donorProductRow: product,
    donorOfferRow: legacyOffer,
  });
  assert.equal(derived.normalized.brand, "ritz");
  assert.equal(
    derived.normalized.productLine,
    "bits cheese crackers lunch sandwich snacks",
  );
  assert.equal(derived.normalized.flavor, null);
  assert.equal(derived.normalized.size.dimension, "MASS");
  assert.equal(derived.normalized.size.baseUnit, "g");

  const snapshot = parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "EVIDENCE_VERIFIED_BOOTSTRAP",
    identityDerivationVersion:
      PRODUCT_TRUTH_TARGETED_WALMART_IDENTITY_DERIVATION_VERSION,
    donorProductId: product.id,
    donorOfferId: legacyOffer.id,
    donorIdentityStatus: "legacy_unverified",
    variantDecisionId: null,
    canonicalVariantId: derived.canonicalVariantId,
    decisionStatus: null,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    decisionEvidenceHash: null,
    decisionEvidenceJson: null,
    canonicalVariantKeyVersion: derived.keyVersion,
    canonicalIdentityHash: derived.identityHash,
    canonicalIdentityJson: derived.identityJson,
    retailer: "walmart",
    retailerProductId: "34312392",
    normalizedProductUrl: "https://www.walmart.com/ip/34312392",
    via: "direct",
    isFirstParty: true,
    legacySnapshot: buildProductTruthTargetedWalmartLegacySnapshot({
      donorProductRow: product,
      donorOfferRow: legacyOffer,
    }),
  });
  const target = planFor(snapshot).targets[0];
  const exactOffer: RetailOffer = {
    retailer: "walmart",
    retailerProductId: "34312392",
    title: product.title,
    description: null,
    keyFeatures: [],
    imageUrls: [],
    price: 3.97,
    currency: "USD",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/34312392",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-19T12:01:00.000Z",
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct",
    meteredReceiptId: "receipt-ritz",
    meteredRunId: "targeted-run-1",
    meteredApprovalId: "approval-1",
  };
  assert.equal(selectExactTargetedWalmartOffer({
    target,
    result: {
      offers: [exactOffer],
      localityProven: true,
      responseZip: "33765",
      trialExhausted: false,
    },
  }).retailerProductId, "34312392");
  assert.throws(() => selectExactTargetedWalmartOffer({
    target,
    result: {
      offers: [{
        ...exactOffer,
        title: "RITZ Bits Peanut Butter Sandwich Crackers Lunch Snacks - 8.8oz",
      }],
      localityProven: true,
      responseZip: "33765",
      trialExhausted: false,
    },
  }), /TARGETED_WALMART_EXACT_OFFER_MISSING/);
});

test("Unwrangle detail preserves independent identity and excludes generated copy", () => {
  const parsed = parseUnwrangleDetailPayload({
    success: true,
    detail: {
      name: "Other Brand Tortilla Chips 12 oz",
      id: "999999999",
      url: "https://www.walmart.com/ip/999999999",
      main_image: "https://images.example.test/other.jpg",
      upc: "012345678905",
      gen_ai_description: "Provider-generated marketing copy must never become Product Truth.",
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.title, "Other Brand Tortilla Chips 12 oz");
  assert.equal(parsed.retailerProductId, "999999999");
  assert.equal(parsed.productUrl, "https://www.walmart.com/ip/999999999");
  assert.equal(parsed.description, null);

  const scalarSentinels = parseUnwrangleDetailPayload({
    success: true,
    detail: {
      name: "Acme Potato Chips Original Bag, 8 oz",
      id: "123456789",
      url: "https://www.walmart.com/ip/123456789",
      upc: "012345678905",
      nutrition_facts: false,
      allergens: false,
    },
  });
  assert.ok(scalarSentinels);
  assert.equal(scalarSentinels.nutritionFacts, false);
  assert.equal(scalarSentinels.allergens, false);

  const numericNutritionSentinel = parseUnwrangleDetailPayload({
    success: true,
    detail: {
      name: "Acme Potato Chips Original Bag, 8 oz",
      id: "123456789",
      url: "https://www.walmart.com/ip/123456789",
      upc: "012345678905",
      nutrition_facts: 0,
      allergens: [],
    },
  });
  assert.ok(numericNutritionSentinel);
  assert.equal(numericNutritionSentinel.nutritionFacts, 0);
  assert.deepEqual(numericNutritionSentinel.allergens, []);
});

function receipt(
  receiptId: string,
  provider: "oxylabs" | "unwrangle",
  operation: "query" | "detail",
  status: ProductTruthOperationalMeteredReceipt["status"] = "succeeded",
): ProductTruthOperationalMeteredReceipt {
  return {
    receiptId,
    budgetId: `budget-${provider}`,
    provider,
    operation,
    reservationKey: `reservation-${receiptId}`,
    unitsMicros: provider === "oxylabs" ? 1_000_000 : 2_500_000,
    units: provider === "oxylabs" ? 1 : 2.5,
    status,
    failureCode: null,
    createdAt: CREATED_AT,
    reservedAt: CREATED_AT,
    settledAt: status === "reserved" ? null : CREATED_AT,
  };
}

test("old exact content skips detail only before any detail receipt", () => {
  const search = receipt("search-1", "oxylabs", "query");
  assert.deepEqual(decideProductTruthTargetedResume({
    receipts: [search],
    matchingSearchObservationReceiptIds: ["search-1"],
    matchingContentObservationReceiptIds: [],
    candidateReady: false,
    preexistingCandidateReady: true,
  }), {
    action: "RECOVER_COMPLETE",
    searchReceiptId: "search-1",
    detailReceiptId: null,
    contentPath: "PREEXISTING_EXACT_COMPLETE",
  });

  for (const status of ["reserved", "failed"] as const) {
    const decision = decideProductTruthTargetedResume({
      receipts: [search, receipt("detail-1", "unwrangle", "detail", status)],
      matchingSearchObservationReceiptIds: ["search-1"],
      matchingContentObservationReceiptIds: [],
      candidateReady: false,
      preexistingCandidateReady: true,
    });
    assert.deepEqual(decision, {
      action: "AMBIGUOUS",
      reason: "UNWRANGLE_OUTCOME_NOT_PROVEN_SUCCESS",
    });
  }
  assert.deepEqual(decideProductTruthTargetedResume({
    receipts: [search, receipt("detail-1", "unwrangle", "detail")],
    matchingSearchObservationReceiptIds: ["search-1"],
    matchingContentObservationReceiptIds: [],
    candidateReady: false,
    preexistingCandidateReady: true,
  }), {
    action: "AMBIGUOUS",
    reason: "UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE",
  });
});

test("exact-one Walmart filter rejects fanout and accepts one local 1P row", () => {
  const target = planFor(exactSnapshot()).targets[0];
  const offer: RetailOffer = {
    retailer: "walmart",
    retailerProductId: target.retailerProductId,
    title: "Acme Potato Chips Original Bag 8 oz",
    description: null,
    keyFeatures: [],
    imageUrls: [],
    price: 4.99,
    currency: "USD",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/acme/123456789",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-19T12:01:00.000Z",
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct",
    meteredReceiptId: "receipt-1",
    meteredRunId: "targeted-run-1",
    meteredApprovalId: "approval-1",
  };
  const selected = selectExactTargetedWalmartOffer({
    target,
    result: { offers: [offer], localityProven: true, responseZip: "33765", trialExhausted: false },
  });
  assert.equal(selected.retailerProductId, "123456789");
  assert.throws(() => selectExactTargetedWalmartOffer({
    target,
    result: { offers: [offer, offer], localityProven: true, responseZip: "33765", trialExhausted: false },
  }), /TARGETED_WALMART_EXACT_OFFER_AMBIGUOUS/);
  assert.throws(() => selectExactTargetedWalmartOffer({
    target,
    result: {
      offers: [{ ...offer, packSizeSeen: 2 }],
      localityProven: true,
      responseZip: "33765",
      trialExhausted: false,
    },
  }), /TARGETED_WALMART_EXACT_OFFER_MISSING/);
});

test("Walmart exact selector preserves known and token modifiers into source variant ID", () => {
  const modified = buildCanonicalProductVariantKey({
    brand: "Acme",
    productLine: "Cola",
    flavor: "Original",
    modifiers: ["Zero Sugar", "Sun Ripened"],
    form: "Bottle",
    size: "12 fl oz",
    outerPackCount: 1,
  });
  const snapshot = parseProductTruthTargetedWalmartDonorSnapshot({
    ...exactSnapshot(),
    canonicalVariantId: modified.canonicalVariantId,
    canonicalIdentityHash: modified.identityHash,
    canonicalIdentityJson: modified.identityJson,
  });
  const target = planFor(snapshot).targets[0];
  const offer: RetailOffer = {
    retailer: "walmart",
    retailerProductId: target.retailerProductId,
    title: "Acme Cola Original Zero Sugar Sun Ripened Bottle 12 fl oz",
    description: null,
    keyFeatures: [],
    imageUrls: [],
    price: 3.99,
    currency: "USD",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/acme/123456789",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-19T12:01:00.000Z",
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct",
    meteredReceiptId: "receipt-modifier-1",
    meteredRunId: "targeted-run-1",
    meteredApprovalId: "approval-1",
  };
  const selected = selectExactTargetedWalmartOffer({
    target,
    result: { offers: [offer], localityProven: true, responseZip: "33765", trialExhausted: false },
  });
  assert.equal(selected.identityMatch?.verdict, "EXACT_IDENTITY");
});
