import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeScopePlan,
} from "../product-truth-legacy-bridge";
import {
  buildProductTruthQuarantinePartition,
  renderProductTruthQuarantinePartition,
} from "../product-truth-quarantine-partition";

const generatedAt = "2026-07-29T10:00:00.000Z";

function scope(
  listingKey: string,
  blockers: string[],
  componentBlockers: string[] = [],
  disposition: ProductTruthLegacyBridgeScopePlan["disposition"] = "QUARANTINE",
): ProductTruthLegacyBridgeScopePlan {
  return {
    listingKey,
    channel: listingKey.startsWith("amazon") ? "amazon" : "walmart",
    storeIndex: 1,
    sku: listingKey.split(":").at(-1)!,
    disposition,
    writeEligible: false,
    supersedesInvalidCanonicalCostIds: [],
    blockers: blockers.map((code) => ({ code: code as never, message: code })),
    components: disposition === "ALREADY_CANONICAL" ? [{
      componentIndex: 0,
      legacyComponentId: "component-canonical",
      legacyDonorProductId: "donor-canonical",
      targetIdentity: null,
      targetVariant: null,
      donorProductId: "donor-canonical",
      donorOfferId: null,
      contentSourceOfferId: null,
      contentAssessment: null,
      qty: 1,
      matcherVerdict: null,
      matcherReasonCodes: [],
      identityProof: "NONE",
      disposition: "ALREADY_CANONICAL",
      blockers: [],
    }] : blockers.includes("PRODUCT_IDENTITY_MISSING") ? [] : [{
      componentIndex: 0,
      legacyComponentId: `component-${listingKey}`,
      legacyDonorProductId: "donor-1",
      targetIdentity: null,
      targetVariant: null,
      donorProductId: "donor-1",
      donorOfferId: null,
      contentSourceOfferId: null,
      contentAssessment: null,
      qty: 1,
      matcherVerdict: null,
      matcherReasonCodes: componentBlockers.includes("DONOR_TITLE_MATCH_REJECTED")
        ? ["TITLE_TARGET_TOKEN_MISSING"]
        : [],
      identityProof: "NONE",
      disposition: componentBlockers.includes("FIRST_PARTY_DIRECT_OFFER_MISSING")
        ? "EXACT_IDENTITY_ONLY_CANDIDATE"
        : componentBlockers.includes("DONOR_TITLE_MATCH_ESTIMATE_ONLY")
          ? "PRICE_ONLY_ESTIMATE"
          : "QUARANTINE",
      blockers: componentBlockers.map((code) => ({
        code: code as never,
        message: code,
      })),
    }],
  };
}

function plan(): ProductTruthLegacyBridgePlan {
  const scopes = [
    scope("amazon:1:identity", ["PRODUCT_IDENTITY_MISSING"]),
    scope("walmart:1:integrity", [], ["CANONICAL_DONOR_VARIANT_CONFLICT"]),
    scope("walmart:1:component", ["LEGACY_COMPONENT_COUNT_MISMATCH"]),
    scope("walmart:1:donor", [], ["LEGACY_DONOR_LINK_MISSING"]),
    scope("walmart:1:offer", [], ["FIRST_PARTY_DIRECT_OFFER_MISSING"]),
    scope("walmart:1:estimate", [], ["DONOR_TITLE_MATCH_ESTIMATE_ONLY"]),
    scope("walmart:1:research", [], ["DONOR_TITLE_MATCH_REJECTED"]),
    scope("walmart:1:canonical", [], [], "ALREADY_CANONICAL"),
  ];
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
    policyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
    generatedAt,
    source: {
      snapshotSchemaVersion: "product-truth-legacy-bridge-snapshot/1.6.0",
      snapshotSha256: "1".repeat(64),
      targetFingerprint: "2".repeat(64),
      manifest: {
        schemaVersion: "phase1-authoritative-scope-manifest/v3",
        sha256: "3".repeat(64),
        asOf: generatedAt,
        listingCount: scopes.length,
      },
    },
    matcher: {
      version: "canonical-product-match/1.2.1",
      implementationSha256: "4".repeat(64),
      releaseSha256: "5".repeat(64),
    },
    pricePolicy: {
      version: "price-evidence-eligibility/1.0.0",
      evaluatedAt: generatedAt,
      maxAgeMs: 1,
    },
    safety: {
      readOnly: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      mutatesLegacyCatalog: false,
      createsAdditionalCatalog: false,
      historicalExactFlagsAreIdentityProof: false,
      priceProxyMayProvideContent: false,
    },
    counts: {
      listingsTotal: scopes.length,
      alreadyCanonicalListings: 1,
      exactCanonicalizationCandidates: 0,
      contentOnlyCanonicalizationCandidates: 0,
      identityOnlyCanonicalizationCandidates: 0,
      quarantinedListings: 7,
      componentsTotal: 7,
      alreadyCanonicalComponents: 1,
      exactContentAndPriceCandidates: 0,
      exactContentOnlyCandidates: 0,
      exactIdentityOnlyCandidates: 1,
      priceOnlyEstimates: 1,
      quarantinedComponents: 4,
    },
    scopes,
  };
}

test("partition is exhaustive, deterministic and keeps integrity conflicts first", () => {
  const bridgePlan = plan();
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  const report = buildProductTruthQuarantinePartition({
    bridgePlan,
    bridgePlanJson,
    bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
    generatedAt,
  });
  assert.equal(report.counts.denominator, 8);
  assert.equal(report.counts.alreadyCanonical, 1);
  assert.equal(report.counts.quarantined, 7);
  assert.equal(report.counts.automaticWriteCandidates, 0);
  assert.deepEqual(
    Object.fromEntries(report.lanes.map((lane) => [lane.lane, lane.count])),
    {
      CANONICAL_INTEGRITY_CONFLICT: 1,
      LISTING_IDENTITY_RECOVERY: 1,
      COMPONENT_GRAPH_RECOVERY: 1,
      DONOR_LINK_RECOVERY: 1,
      EXACT_DONOR_OFFER_ENRICHMENT: 1,
      PRICE_ONLY_PROXY_RESEARCH: 1,
      RETAILER_IDENTITY_RESEARCH: 1,
      OTHER_QUARANTINE: 0,
    },
  );
  assert.equal(report.counts.overlaps.noComponents, 1);
  assert.equal(report.counts.overlaps.withExactIdentityOnlyComponent, 1);
  assert.equal(report.counts.overlaps.withPriceOnlyEstimateComponent, 1);
  assert.equal(
    renderProductTruthQuarantinePartition(report),
    renderProductTruthQuarantinePartition(
      buildProductTruthQuarantinePartition({
        bridgePlan,
        bridgePlanJson,
        bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
        generatedAt,
      }),
    ),
  );
});

test("partition rejects source bytes that do not match the independent SHA", () => {
  const bridgePlan = plan();
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  assert.throws(
    () => buildProductTruthQuarantinePartition({
      bridgePlan,
      bridgePlanJson,
      bridgePlanSha256: "0".repeat(64),
      generatedAt,
    }),
    /QUARANTINE_PARTITION_SOURCE_HASH_MISMATCH/,
  );
});
