import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  compileProductTruthBundleFactorySeed,
  compileProductTruthListingImprovementSeed,
  compileProductTruthProcurementPlan,
  compileProductTruthUnitEconomicsBasis,
  ProductTruthConsumerAdapterError,
} from "../product-truth-consumer-adapters";
import {
  PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION,
  type ProductTruthConsumerGatewayReport,
} from "../product-truth-consumer-gateway";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "../product-truth-read-contract-version";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
} from "../price-evidence-policy";
import type {
  ProductTruthPriceOption,
  ProductTruthRecipeComponent,
} from "../product-truth-read-contract";

const MANIFEST = "a".repeat(64);
const TARGET = "b".repeat(64);
const ACTIVATION = "c".repeat(64);
const READ_AT = "2026-07-25T16:00:00.000Z";
const LISTING_KEY = "amazon:1:SKU-1";
const VARIANT = `cpv1:${"d".repeat(64)}`;

const MATCHER = {
  matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
  matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
};

function recipeComponent(): ProductTruthRecipeComponent {
  return {
    componentEvidenceId: "component-evidence-1",
    componentIndex: 0,
    product: "Acme Crunch",
    flavor: "Original",
    size: "8 oz",
    qty: 2,
    targetCanonicalVariantId: VARIANT,
    evidenceStatus: "FACT",
    content: {
      canonicalVariantId: VARIANT,
      identity: {
        variantKey: VARIANT,
        identityHash: "e".repeat(64),
        keyVersion: "canonical-product-variant-key/1.0.0",
        brand: "Acme",
        productLine: "Crunch",
        flavor: "Original",
        modifiers: [],
        form: "bag",
        sizeDimension: "MASS",
        sizeBaseAmount: 226.796,
        sizeBaseUnit: "g",
        outerPackCount: 1,
        identity: {
          brand: "Acme",
          productLine: "Crunch",
          flavor: "Original",
          size: "8 oz",
        },
      },
      facts: {
        title: "Acme Crunch Original 8 oz",
        description: "Exact source-backed description.",
        bullets: ["Exact source-backed bullet"],
        attributes: { form: "bag" },
        nutritionFacts: { calories: 150 },
        ingredients: "Potatoes, oil, salt",
        mainImageUrl: "https://walmart.example/item/main.jpg",
        imageUrls: [
          "https://walmart.example/item/main.jpg",
          "https://walmart.example/item/nutrition.jpg",
        ],
      },
      provenance: {
        ...MATCHER,
        contentObservationId: "content-1",
        observationKey: "f".repeat(64),
        donorProductId: "donor-1",
        variantDecisionId: "decision-1",
        decisionEvidenceHash: "1".repeat(64),
        contentHash: "2".repeat(64),
        fieldHashes: { title: "3".repeat(64) },
        sourceUrl: "https://walmart.example/item",
        sourceApi: "walmart-first-party",
        observedAt: READ_AT,
        runId: "run-1",
        approvalId: "approval-1",
        meteredReceiptId: "receipt-1",
      },
    },
    contentBlockers: [],
  };
}

function priceOption(input: {
  id: string;
  retailer: string;
  packagePrice: number;
  packSizeSeen: number;
  eligibility?: "FACT" | "ESTIMATE";
  variantId?: string;
}): ProductTruthPriceOption {
  const eligibility = input.eligibility ?? "FACT";
  return {
    ...MATCHER,
    rank: 1,
    eligibility,
    observationId: input.id,
    observationKey: `${input.id.charCodeAt(0).toString(16)}`.repeat(64).slice(0, 64),
    donorOfferId: `offer-${input.id}`,
    donorProductId: `donor-${input.id}`,
    canonicalVariantId: input.variantId ?? VARIANT,
    variantDecisionId: `decision-${input.id}`,
    matchTier: eligibility === "FACT"
      ? "EXACT_IDENTITY"
      : "CROSS_SIZE_ESTIMATE",
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    packagePrice: input.packagePrice,
    packSizeSeen: input.packSizeSeen,
    observedUnitPrice: input.packagePrice / input.packSizeSeen,
    targetComparableUnitPrice: input.packagePrice / input.packSizeSeen,
    currency: "USD",
    retailer: input.retailer,
    retailerProductId: `retailer-${input.id}`,
    via: "direct",
    productUrl: `https://${input.retailer.toLowerCase()}.example/${input.id}`,
    sellerName: input.retailer,
    sourceApi: `${input.retailer.toLowerCase()}-first-party`,
    locality: { zip: "33765", evidence: "zip_scoped" },
    freshness: {
      observedAt: READ_AT,
      ageMs: 0,
      maxAgeMs: 86_400_000,
    },
    sourceRun: {
      runId: "run-1",
      approvalId: "approval-1",
      meteredReceiptId: `receipt-${input.id}`,
    },
    policyReasonCodes: eligibility === "FACT"
      ? ["EXACT_IDENTITY_DIRECT_FACT"]
      : ["CROSS_SIZE_ESTIMATE"],
  };
}

function report(
  consumer: ProductTruthConsumerGatewayReport["consumer"],
  view: ProductTruthConsumerGatewayReport["entries"][number]["view"],
  input?: {
    disposition?: "READY" | "UNSOURCEABLE" | "BLOCKED";
    ready?: boolean;
    blockers?: string[];
  },
): ProductTruthConsumerGatewayReport {
  const disposition = input?.disposition ?? "READY";
  const ready = input?.ready ?? disposition === "READY";
  const blockers = input?.blockers ?? [];
  return {
    schemaVersion: PRODUCT_TRUTH_CONSUMER_GATEWAY_VERSION,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    activationSha256: ACTIVATION,
    ownerApprovalId: "owner-shadow-1",
    mode: "SHADOW",
    outputUse: "COMPARE_ONLY",
    consumer,
    authoritativeManifestSha256: MANIFEST,
    databaseTargetFingerprint: TARGET,
    readAt: READ_AT,
    asOf: READ_AT,
    maxPriceAgeMs: 86_400_000,
    counts: {
      total: 1,
      ready: ready ? 1 : 0,
      unsourceable: disposition === "UNSOURCEABLE" ? 1 : 0,
      blocked: disposition === "BLOCKED" ? 1 : 0,
      fact: 0,
      estimate: 0,
      missing: 0,
      invalid: 0,
    },
    entries: [{
      listingKey: LISTING_KEY,
      channel: "amazon",
      storeIndex: 1,
      sku: "SKU-1",
      recipe: {
        components: [{
          componentEvidenceId: "component-evidence-1",
          componentIndex: 0,
          targetCanonicalVariantId: VARIANT,
          quantity: 1,
          evidenceStatus: "FACT",
        }],
        blockers: [],
      },
      disposition,
      ready,
      blockers,
      view,
    }],
    claims: {
      readOnly: true,
      legacyFallback: false,
      providerCalls: false,
      marketplaceMutations: false,
      procurementMutations: false,
    },
  };
}

test("Bundle Factory and Listing Improvement seeds preserve exact content provenance without acting", () => {
  const component = recipeComponent();
  const bundle = compileProductTruthBundleFactorySeed({
    report: report("BUNDLE_FACTORY", {
      consumer: "BUNDLE_FACTORY",
      ready: true,
      components: [component],
      blockers: [],
    }),
    listingKey: LISTING_KEY,
  });
  const listing = compileProductTruthListingImprovementSeed({
    report: report("LISTING_IMPROVEMENT", {
      consumer: "LISTING_IMPROVEMENT",
      ready: true,
      components: [component],
      blockers: [],
    }),
    listingKey: LISTING_KEY,
  });

  assert.equal(bundle.ready, true);
  assert.equal(bundle.components[0].content?.contentObservationId, "content-1");
  assert.equal(bundle.components[0].content?.sourceUrl, "https://walmart.example/item");
  assert.equal(bundle.claims.generatedContentCreated, false);
  assert.equal(bundle.claims.marketplaceMutations, false);
  assert.equal(listing.readyForPreview, true);
  assert.equal(listing.claims.diffGenerated, false);
  assert.equal(listing.claims.applyAuthorized, false);
  assert.match(bundle.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    bundle.artifactSha256,
    compileProductTruthBundleFactorySeed({
      report: report("BUNDLE_FACTORY", {
        consumer: "BUNDLE_FACTORY",
        ready: true,
        components: [component],
        blockers: [],
      }),
      listingKey: LISTING_KEY,
    }).artifactSha256,
  );
});

test("content adapters fail closed when exact component content is missing", () => {
  const component = recipeComponent();
  component.content = null;
  component.contentBlockers = ["EXACT_CONTENT_MISSING"];
  const seed = compileProductTruthBundleFactorySeed({
    report: report("BUNDLE_FACTORY", {
      consumer: "BUNDLE_FACTORY",
      ready: false,
      components: [component],
      blockers: ["CONTENT_BLOCKED"],
    }, {
      disposition: "BLOCKED",
      ready: false,
      blockers: ["CONTENT_BLOCKED"],
    }),
    listingKey: LISTING_KEY,
  });
  assert.equal(seed.ready, false);
  assert.ok(seed.blockers.includes("COMPONENT_0_EXACT_CONTENT_MISSING"));
});

test("Unit Economics keeps typed estimates and blocks UNSOURCEABLE without a numeric fallback", () => {
  const estimate = {
    ...MATCHER,
    id: "cost-estimate",
    observationKey: "4".repeat(64),
    recipeHash: "5".repeat(64),
    sku: "SKU-1",
    effectiveDate: READ_AT,
    createdAt: READ_AT,
    source: "retail:estimate",
    productCost: 4.25,
    packagingCost: 0.5,
    iceCost: null,
    totalCost: 4.75,
    costPerUnit: 4.25,
    packSize: 1,
    currency: "USD",
    needsReview: true,
    pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
    evidenceOutcome: "ESTIMATE" as const,
    evidence: {},
    runId: "run-1",
    approvalId: "approval-1",
    componentProvenance: [],
  };
  const typed = compileProductTruthUnitEconomicsBasis({
    report: report("UNIT_ECONOMICS", {
      consumer: "UNIT_ECONOMICS",
      status: "ESTIMATE",
      current: estimate,
      factualCost: null,
      estimatedCost: estimate,
      blockers: [],
    }),
    listingKey: LISTING_KEY,
  });
  assert.equal(typed.ready, true);
  assert.equal(typed.basis?.kind, "ESTIMATE");
  assert.equal(typed.basis?.productAcquisitionCost, 4.25);
  assert.equal(typed.claims.oneDollarFloorFallback, false);

  const blocked = compileProductTruthUnitEconomicsBasis({
    report: report("UNIT_ECONOMICS", {
      consumer: "UNIT_ECONOMICS",
      status: "UNSOURCEABLE",
      current: null,
      factualCost: null,
      estimatedCost: null,
      blockers: [],
    }, {
      disposition: "UNSOURCEABLE",
      ready: false,
    }),
    listingKey: LISTING_KEY,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.basis, null);
  assert.ok(blocked.blockers.includes("UNIT_ECONOMICS_UNSOURCEABLE"));
  assert.equal(blocked.claims.zeroCostFallback, false);
});

test("Procurement blocks unknown inventory and selects the cheapest factual pack only for review", () => {
  const single = priceOption({
    id: "w",
    retailer: "Walmart",
    packagePrice: 4,
    packSizeSeen: 1,
  });
  const double = priceOption({
    id: "t",
    retailer: "Target",
    packagePrice: 6,
    packSizeSeen: 2,
  });
  const estimate = priceOption({
    id: "e",
    retailer: "Publix",
    packagePrice: 2,
    packSizeSeen: 1,
    eligibility: "ESTIMATE",
  });
  const procurementView = {
    consumer: "PROCUREMENT" as const,
    ready: true,
    components: [{
      componentIndex: 0,
      product: "Acme Crunch",
      requiredQuantity: 1,
      factualOptions: [single, double],
      estimateOptions: [estimate],
      manualCost: {
        kind: "MANUAL" as const,
        amount: 1,
        currency: "USD",
        effectiveAt: READ_AT,
        source: "accounting",
        approvalRef: "owner-manual-1",
        policyVersion: PRICE_EVIDENCE_POLICY_VERSION,
        evidenceHash: "6".repeat(64),
      },
      blockers: [],
    }],
    blockers: [],
  };
  const gateway = report("PROCUREMENT", procurementView);
  const unknown = compileProductTruthProcurementPlan({
    report: gateway,
    listingKey: LISTING_KEY,
    orderQuantity: 2,
  });
  assert.equal(unknown.readyForReview, false);
  assert.equal(unknown.components[0].shortageQuantity, null);
  assert.ok(unknown.blockers.includes("COMPONENT_0_INVENTORY_UNKNOWN"));

  const known = compileProductTruthProcurementPlan({
    report: gateway,
    listingKey: LISTING_KEY,
    orderQuantity: 2,
    inventoryByCanonicalVariantId: {
      [VARIANT]: {
        status: "KNOWN",
        availableQuantity: 0,
        evidenceId: "inventory-1",
        observedAt: READ_AT,
      },
    },
  });
  assert.equal(known.readyForReview, true);
  assert.equal(known.components[0].requiredQuantity, 2);
  assert.equal(known.components[0].shortageQuantity, 2);
  assert.equal(known.components[0].selectedForReview?.retailer, "Target");
  assert.equal(known.components[0].selectedForReview?.packages, 1);
  assert.equal(known.components[0].selectedForReview?.projectedSubtotal, 6);
  assert.equal(known.components[0].estimateOptions[0].eligibleForPurchase, false);
  assert.equal(known.components[0].manualCost?.eligibleForPurchase, false);
  assert.equal(known.claims.purchaseAuthorized, false);
  assert.equal(known.claims.procurementMutations, false);
});

test("exact recipe variant lets inventory cover demand even when no retailer offer exists", () => {
  const plan = compileProductTruthProcurementPlan({
    report: report("PROCUREMENT", {
      consumer: "PROCUREMENT",
      ready: false,
      components: [{
        componentIndex: 0,
        product: "Acme Crunch",
        requiredQuantity: 1,
        factualOptions: [],
        estimateOptions: [],
        manualCost: null,
        blockers: ["NO_CURRENT_ELIGIBLE_LOCAL_PRICE"],
      }],
      blockers: ["COMPONENT_0:NO_CURRENT_ELIGIBLE_LOCAL_PRICE"],
    }, {
      disposition: "BLOCKED",
      ready: false,
      blockers: ["COMPONENT_0:NO_CURRENT_ELIGIBLE_LOCAL_PRICE"],
    }),
    listingKey: LISTING_KEY,
    orderQuantity: 2,
    inventoryByCanonicalVariantId: {
      [VARIANT]: {
        status: "KNOWN",
        availableQuantity: 2,
        evidenceId: "inventory-exact-2",
        observedAt: READ_AT,
      },
    },
  });
  assert.equal(plan.readyForReview, true);
  assert.equal(plan.components[0].factualCanonicalVariantId, VARIANT);
  assert.equal(plan.components[0].shortageQuantity, 0);
  assert.equal(plan.components[0].selectedForReview, null);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.claims.purchaseAuthorized, false);
});

test("consumer/scope drift and cross-variant factual procurement offers fail closed", () => {
  assert.throws(
    () => compileProductTruthBundleFactorySeed({
      report: report("LISTING_IMPROVEMENT", {
        consumer: "LISTING_IMPROVEMENT",
        ready: true,
        components: [recipeComponent()],
        blockers: [],
      }),
      listingKey: LISTING_KEY,
    }),
    (error) =>
      error instanceof ProductTruthConsumerAdapterError
      && error.code === "CONSUMER_ADAPTER_CONSUMER_MISMATCH",
  );
  const first = priceOption({
    id: "a",
    retailer: "Walmart",
    packagePrice: 3,
    packSizeSeen: 1,
  });
  const second = priceOption({
    id: "b",
    retailer: "Target",
    packagePrice: 3,
    packSizeSeen: 1,
    variantId: `cpv1:${"9".repeat(64)}`,
  });
  assert.throws(
    () => compileProductTruthProcurementPlan({
      report: report("PROCUREMENT", {
        consumer: "PROCUREMENT",
        ready: true,
        components: [{
          componentIndex: 0,
          product: "Acme Crunch",
          requiredQuantity: 1,
          factualOptions: [first, second],
          estimateOptions: [],
          manualCost: null,
          blockers: [],
        }],
        blockers: [],
      }),
      listingKey: LISTING_KEY,
      orderQuantity: 1,
    }),
    (error) =>
      error instanceof ProductTruthConsumerAdapterError
      && error.code === "CONSUMER_ADAPTER_PROCUREMENT_INVALID",
  );
});

test("consumer adapters are pure and contain no DB, process, provider or network surface", async () => {
  const source = await readFile(
    new URL("../product-truth-consumer-adapters.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /@libsql|prisma|process\.env|child_process|spawn\s*\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bexecute\s*\(|\btransaction\s*\(/);
  assert.doesNotMatch(source, /openai|anthropic|unwrangle|oxylabs/i);
});
