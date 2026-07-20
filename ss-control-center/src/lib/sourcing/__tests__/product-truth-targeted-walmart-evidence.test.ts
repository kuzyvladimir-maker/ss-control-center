import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildCanonicalProductVariantKey } from "../canonical-product-variant";
import { parseUnwrangleDetailPayload } from "../donor-catalog";
import type { ProductTruthOperationalMeteredReceipt } from "../product-truth-operational-ledger";
import {
  buildProductTruthTargetedWalmartEvidencePlan,
  buildProductTruthTargetedWalmartEvidenceRequest,
  buildProductTruthTargetedWalmartLegacySnapshot,
  canonicalIdentityFromTarget,
  parseProductTruthTargetedWalmartDonorSnapshot,
  type ProductTruthTargetedWalmartDonorSnapshot,
  type ProductTruthTargetedWalmartEvidenceTarget,
} from "../product-truth-targeted-walmart-evidence-contract";
import {
  decideProductTruthTargetedResume,
  selectExactTargetedWalmartOffer,
} from "../product-truth-targeted-walmart-evidence";
import type { RetailOffer } from "../retail-fetch";

const CREATED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-19T13:00:00.000Z";
const HASH = "a".repeat(64);

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
    donorProductId: "donor-1",
    donorOfferId: "offer-1",
    donorIdentityStatus: "exact_confirmed",
    variantDecisionId: "decision-1",
    canonicalVariantId: canonical.canonicalVariantId,
    decisionStatus: "exact_confirmed",
    matcherVersion: "canonical-product-match/1.2.0",
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
    brand: "legacy proposal only",
    title: "legacy proposal only",
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
  return parseProductTruthTargetedWalmartDonorSnapshot({
    identityMode: "OWNER_ATTESTED_BOOTSTRAP",
    donorProductId: "donor-1",
    donorOfferId: "offer-1",
    donorIdentityStatus: "legacy_unverified",
    variantDecisionId: null,
    canonicalVariantId: canonical.canonicalVariantId,
    decisionStatus: null,
    matcherVersion: "canonical-product-match/1.2.0",
    canonicalVariantKeyVersion: canonical.keyVersion,
    canonicalIdentityHash: canonical.identityHash,
    canonicalIdentityJson: canonical.identityJson,
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

test("existing and owner-attested bootstrap plans seal honest write claims", () => {
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
  assert.equal(bootstrap.claims.identityMode, "OWNER_ATTESTED_BOOTSTRAP");
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
