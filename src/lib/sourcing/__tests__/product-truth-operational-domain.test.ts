import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { test } from "node:test";

import {
  assessProductTruthOperationalSnapshot,
  inspectProductTruthDonorContent,
  loadProductTruthDonorHarvestSnapshot,
  type ProductTruthDonorContentInspection,
} from "../product-truth-operational-domain";
import type { ProductTruthSourcePolicy } from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION,
  type ProductTruthSnapshot,
} from "../product-truth-read-contract";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";

const policy: ProductTruthSourcePolicy = {
  procurementZip: "33765",
  retailers: ["walmart", "target", "publix"],
  allowClubs: false,
  allowBjs: false,
  listingConcurrency: 1,
  componentConcurrency: 1,
  maxAttemptsPerListing: 1,
};

function snapshot(status: "FACT" | "ESTIMATE" | "UNSOURCEABLE"): ProductTruthSnapshot {
  const content = {
    canonicalVariantId: "variant-a",
    identity: {
      variantKey: "v", identityHash: "1".repeat(64), keyVersion: "v1",
      brand: "Acme", productLine: "Snack", flavor: "Original", modifiers: [],
      form: "box", sizeDimension: "COUNT" as const, sizeBaseAmount: 1,
      sizeBaseUnit: "count" as const, outerPackCount: 1, identity: {},
    },
    facts: {
      title: "Acme Snack", description: "Exact product", bullets: [], attributes: {},
      nutritionFacts: {}, ingredients: "Food", mainImageUrl: "https://example.com/1.jpg",
      imageUrls: Array.from({ length: 5 }, (_, index) => `https://example.com/${index}.jpg`),
    },
    provenance: {
      contentObservationId: "obs", observationKey: "2".repeat(64), donorProductId: "donor-a",
      variantDecisionId: "decision", matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      decisionEvidenceHash: "3".repeat(64),
      contentHash: "4".repeat(64), fieldHashes: {}, sourceUrl: "https://walmart.com/item/1",
      sourceApi: "unwrangle", observedAt: "2026-07-19T12:00:00.000Z",
      runId: "run", approvalId: "approval", meteredReceiptId: "receipt",
    },
  };
  const factualOptions = status === "UNSOURCEABLE" ? [] : [{ rank: 1 }] as never[];
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    snapshot: {
      sku: "SKU", channel: "amazon", storeIndex: 1, listingKey: "amazon:1:SKU",
      asOf: "2026-07-19T12:00:00.000Z", maxPriceAgeMs: 86_400_000, skuCostId: "cost",
    },
    recipe: {
      blockers: [],
      components: [{
        componentEvidenceId: "component", componentIndex: 0, product: "Acme Snack",
        flavor: "Original", size: "1 count", qty: 1, targetCanonicalVariantId: "variant-a",
        evidenceStatus: status === "FACT" ? "FACT" : status === "ESTIMATE" ? "ESTIMATE" : "REJECT",
        content, contentBlockers: [],
      }],
    },
    views: {
      bundleFactory: { consumer: "BUNDLE_FACTORY", ready: true, components: [], blockers: [] },
      listingImprovement: { consumer: "LISTING_IMPROVEMENT", ready: true, components: [], blockers: [] },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS", status, current: null, factualCost: null,
        estimatedCost: null, blockers: [],
      },
      procurement: {
        consumer: "PROCUREMENT", ready: status === "FACT", blockers: [],
        components: [{
          componentIndex: 0, product: "Acme Snack", requiredQuantity: 1,
          factualOptions, estimateOptions: status === "ESTIMATE" ? ([{ rank: 1 }] as never[]) : [],
          manualCost: null, blockers: [],
        }],
      },
    },
  };
}

function completeInspection(): ProductTruthDonorContentInspection {
  return {
    donorProductId: "donor-a",
    fullContentComplete: true,
    missingFields: [],
    plan: {
      donorProductId: "donor-a", disposition: "already_complete",
      completedFields: ["attributes", "bullets", "description", "gallery", "ingredients", "nutrition", "title", "upc"],
      requestedFields: [], source: null, retailer: null, retailerProductId: null,
      productUrl: null, targetOnly: false, terminalReason: null, maxAttempts: 1,
      estimatedCallsFirstAttempt: 0, estimatedUnitsFirstAttempt: 0,
      maximumCallsAtAttemptCap: 0, maximumUnitsAtAttemptCap: 0,
    },
  };
}

test("assessment requires full donor content and keeps estimate distinct from procurement fact", () => {
  const fact = assessProductTruthOperationalSnapshot({
    snapshot: snapshot("FACT"), donorInspections: [completeInspection()],
  });
  assert.equal(fact.complete, true);
  assert.deepEqual(fact.completedFields, ["identity", "offers", "content", "cogs"]);
  assert.equal(fact.outcome, "FACT");

  const estimate = assessProductTruthOperationalSnapshot({
    snapshot: snapshot("ESTIMATE"), donorInspections: [completeInspection()],
  });
  assert.equal(estimate.complete, true);
  assert.equal(estimate.outcome, "ESTIMATE");
  assert.equal(estimate.consumers.procurementReady, false);

  const missingContent = assessProductTruthOperationalSnapshot({
    snapshot: snapshot("FACT"),
    donorInspections: [{ ...completeInspection(), fullContentComplete: false, missingFields: ["nutrition"] }],
  });
  assert.equal(missingContent.complete, false);
  assert.deepEqual(missingContent.unavailableFields, ["content"]);
  assert.match(missingContent.blockers.join(" "), /MISSING_NUTRITION/);
});

test("donor harvest planning only admits explicit first-party offers from sealed retailers", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.executeMultiple(`
      CREATE TABLE DonorProduct (
        id TEXT PRIMARY KEY, identityStatus TEXT, title TEXT, description TEXT,
        bullets TEXT, attributes TEXT, nutritionFacts TEXT, ingredients TEXT,
        mainImageUrl TEXT, imageUrls TEXT, upc TEXT, gtin TEXT
      );
      CREATE TABLE DonorOffer (
        id TEXT PRIMARY KEY, donorProductId TEXT, retailer TEXT, retailerProductId TEXT,
        productUrl TEXT, via TEXT, isFirstParty INTEGER
      );
      INSERT INTO DonorProduct VALUES (
        'donor-a','exact_confirmed','Acme Snack',NULL,NULL,NULL,NULL,NULL,
        'https://example.com/1.jpg','["https://example.com/1.jpg"]',NULL,NULL
      );
      INSERT INTO DonorOffer VALUES
        ('w1','donor-a','walmart','w1','https://walmart.com/ip/w1','direct',1),
        ('t3p','donor-a','target','t3p','https://target.com/p/t3p','direct',0),
        ('bjs','donor-a','bjs','b1','https://bjs.com/b1','direct',1);
    `);
    const donor = await loadProductTruthDonorHarvestSnapshot(db, "donor-a", policy);
    assert.equal(donor.offers.length, 1);
    assert.equal(donor.offers[0]?.retailer, "walmart");
    const inspection = await inspectProductTruthDonorContent(db, {
      donorProductIds: ["donor-a"], sourcePolicy: policy, minGalleryImages: 5,
    });
    assert.equal(inspection[0]?.plan.source, "unwrangle:walmart");
    assert.equal(inspection[0]?.plan.maxAttempts, 1);
  } finally {
    await db.close();
  }
});
