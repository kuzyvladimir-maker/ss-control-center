import assert from "node:assert/strict";
import test from "node:test";

import {
  projectProductTruthForWalmartSingleListing,
} from "../listing-integrity-single-pipeline.ts";
import type { ProductTruthSnapshot } from "../../sourcing/product-truth-read-contract.ts";

function snapshot(overrides: {
  qty?: number;
  donorOuter?: number;
  ready?: boolean;
  content?: boolean;
  componentCount?: number;
} = {}): ProductTruthSnapshot {
  const component = {
    componentEvidenceId: "evidence-1",
    componentIndex: 0,
    product: "Farmhouse Homestyle Oat Bread",
    flavor: "Homestyle Oat",
    size: "24 oz",
    qty: overrides.qty ?? 6,
    targetCanonicalVariantId: "variant-oat-24oz",
    evidenceStatus: "FACT" as const,
    content: overrides.content === false ? null : {
      canonicalVariantId: "variant-oat-24oz",
      identity: {
        variantKey: "pepperidge-farm|farmhouse|homestyle-oat|680.388g",
        identityHash: "a".repeat(64),
        keyVersion: "v1",
        brand: "Pepperidge Farm",
        productLine: "Farmhouse Bread",
        flavor: "Homestyle Oat",
        modifiers: [],
        form: "Loaf",
        sizeDimension: "MASS" as const,
        sizeBaseAmount: 680.388,
        sizeBaseUnit: "g" as const,
        outerPackCount: overrides.donorOuter ?? 1,
        identity: {},
      },
      facts: {
        title: "Pepperidge Farm Farmhouse Homestyle Oat Bread, 24 oz",
        description: "Exact donor description",
        bullets: [],
        attributes: {},
        nutritionFacts: {},
        ingredients: "Wheat",
        mainImageUrl: "https://i5.walmartimages.com/example.jpeg",
        imageUrls: ["https://i5.walmartimages.com/example.jpeg"],
      },
      provenance: {
        matcherVersion: "canonical-product-match/1.2.0",
        matcherImplementationSha256: "b".repeat(64),
        matcherReleaseSha256: "c".repeat(64),
        contentObservationId: "content-1",
        observationKey: "observation-1",
        donorProductId: "donor-1",
        variantDecisionId: "decision-1",
        decisionEvidenceHash: "d".repeat(64),
        contentHash: "e".repeat(64),
        fieldHashes: {},
        sourceUrl: "https://www.walmart.com/ip/1",
        sourceApi: "walmart",
        observedAt: "2026-07-23T01:00:00.000Z",
        runId: null,
        approvalId: "approval-1",
        meteredReceiptId: null,
      },
    },
    contentBlockers: [],
  };
  const components = Array.from(
    { length: overrides.componentCount ?? 1 },
    (_value, index) => ({ ...component, componentIndex: index }),
  );
  return {
    contractVersion: "product-truth-read-contract/3.2.0",
    snapshot: {
      sku: "SKU-6",
      channel: "walmart",
      storeIndex: 1,
      listingKey: "walmart:1:SKU-6",
      asOf: "2026-07-23T02:00:00.000Z",
      maxPriceAgeMs: 86_400_000,
      skuCostId: "cost-1",
    },
    recipe: { components, blockers: [] },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY",
        ready: true,
        components,
        blockers: [],
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT",
        ready: overrides.ready ?? true,
        components,
        blockers: overrides.ready === false ? ["CONTENT_MISSING"] : [],
      },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS",
        status: "FACT",
        current: null,
        factualCost: null,
        estimatedCost: null,
        blockers: [],
      },
      procurement: {
        consumer: "PROCUREMENT",
        ready: false,
        components: [],
        blockers: [],
      },
    },
  };
}

test("one canonical component becomes exact one-SKU detector truth", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot());
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.expected.outer_units, 6);
  assert.deepEqual(result.expected.identity.brand_aliases, ["Pepperidge Farm"]);
  assert.deepEqual(
    result.expected.identity.product_marker_groups,
    [["Farmhouse Bread", "Farmhouse Homestyle Oat Bread"]],
  );
  assert.deepEqual(result.expected.package_facts, [{
    kind: "net_content",
    requirement: "required",
    value: 680.388,
    unit: "g",
  }]);
});

test("a multipack donor is rejected instead of becoming a multipack-of-multipacks", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot({ donorOuter: 2 }));
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.equal(
    result.blockers.includes("CONTENT_DONOR_IS_NOT_ONE_OUTER_PACKAGE:2"),
    true,
  );
});

test("missing canonical content never falls back to the Walmart title", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot({ content: false }));
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.equal(result.blockers.includes("EXACT_CONTENT_MISSING"), true);
});

test("mixed or multi-component recipes do not enter the same-product repair lane", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot({ componentCount: 2 }));
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.equal(
    result.blockers.includes("SAME_PRODUCT_PIPELINE_REQUIRES_ONE_COMPONENT:FOUND_2"),
    true,
  );
});
