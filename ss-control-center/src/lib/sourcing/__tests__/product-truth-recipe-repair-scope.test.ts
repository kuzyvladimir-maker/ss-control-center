import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
} from "../canonical-product-match-provenance";
import {
  PHASE1_SCOPE_DISPOSITION_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  type Phase1Channel,
  type Phase1ScopeDispositionEntry,
} from "../phase1-scope-manifest";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
} from "../price-evidence-policy";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeScopePlan,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  PRODUCT_TRUTH_CONSUMER_READINESS_VERSION,
  renderProductTruthConsumerReadinessJson,
  type ProductTruthConsumerReadinessEntry,
  type ProductTruthConsumerReadinessReport,
} from "../product-truth-consumer-readiness";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "../product-truth-read-contract-version";
import {
  ProductTruthRecipeRepairScopeError,
  compileProductTruthRecipeRepairScope,
  renderProductTruthRecipeRepairScope,
} from "../product-truth-recipe-repair-scope";
import {
  productTruthOperationalSha256,
} from "../product-truth-operational-run-contract";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";

const AS_OF = "2026-07-19T12:00:00.000Z";
const CAPTURED_AT = "2026-07-19T12:05:00.000Z";
const GENERATED_AT = "2026-07-19T12:10:00.000Z";
const TARGET = "a".repeat(64);

const amazonReport = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Acme Amazon Item\tAMZ-1\tB000000001\tActive\tDEFAULT",
].join("\n");
const walmartReport = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  "WM-1,10001,Acme Crunch Barbecue 8 oz Pack of 2,Published,Active",
  "WM-2,10002,Acme Crunch Ranch 8 oz Pack of 3,Published,Active",
].join("\n");

function disposition(
  channel: Phase1Channel,
  content: string,
): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey: "store1",
    storeIndex: 1,
    accountId: `${channel}-account-1`,
    storeId: `${channel}-store-1`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "IN_SCOPE",
    decision: {
      authority: "OWNER",
      decisionId: `${channel}-decision-1`,
      decidedBy: "Vladimir",
      decidedAt: "2026-07-19T11:00:00.000Z",
      reason: "Recipe repair scope fixture",
    },
    report: {
      reportType: channel === "amazon"
        ? "GET_MERCHANT_LISTINGS_ALL_DATA"
        : "ITEM_CATALOG",
      reportId: `${channel}-report-1`,
      capturedAt: "2026-07-19T11:30:00.000Z",
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
  };
}

function manifest() {
  const value = buildPhase1ScopeManifest({
    asOf: AS_OF,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: AS_OF,
      identityStyle: "index",
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        disposition("amazon", amazonReport),
        disposition("walmart", walmartReport),
      ],
    },
    reports: [
      {
        channel: "amazon",
        scopeKey: "store1",
        sourceName: "amazon.tsv",
        content: amazonReport,
      },
      {
        channel: "walmart",
        scopeKey: "store1",
        sourceName: "walmart.csv",
        content: walmartReport,
      },
    ],
  });
  assert.equal(value.authoritative, true, JSON.stringify(value.blockers));
  return value;
}

function canonicalComponent(): ProductTruthLegacyBridgeScopePlan["components"][number] {
  return {
    componentIndex: 0,
    qty: 2,
    legacyComponentId: "component-WM-1",
    donorProductId: "donor-1",
    legacyDonorProductId: "donor-1",
    donorOfferId: "offer-1",
    contentSourceOfferId: "offer-1",
    identityProof: "STRICT_TITLE_MATCH",
    contentAssessment: null,
    targetIdentity: {
      brand: "Acme",
      productLine: "Crunch",
      flavor: "Barbecue",
      size: "8 oz",
      form: "bag",
      outerPackCount: 1,
    },
    targetVariant: null,
    matcherVerdict: "FACT",
    matcherReasonCodes: ["IDENTITY_EXACT"],
    disposition: "ALREADY_CANONICAL",
    blockers: [],
  };
}

function bridgeScope(
  listingKey: string,
): ProductTruthLegacyBridgeScopePlan {
  const sku = listingKey.split(":").at(-1)!;
  if (sku === "WM-1") {
    return {
      listingKey,
      channel: "walmart",
      storeIndex: 1,
      sku,
      disposition: "ALREADY_CANONICAL",
      writeEligible: false,
      supersedesInvalidCanonicalCostIds: [],
      blockers: [],
      components: [canonicalComponent()],
    };
  }
  if (sku === "WM-2") {
    return {
      listingKey,
      channel: "walmart",
      storeIndex: 1,
      sku,
      disposition: "QUARANTINE",
      writeEligible: false,
      supersedesInvalidCanonicalCostIds: [],
      blockers: [],
      components: [{
        ...canonicalComponent(),
        qty: 3,
        legacyComponentId: "component-WM-2",
        matcherVerdict: "REJECT",
        matcherReasonCodes: ["MODIFIER_MISMATCH"],
        disposition: "QUARANTINE",
        blockers: [{
          code: "DONOR_TITLE_MATCH_REJECTED",
          message: "strict matcher rejected donor title",
        }],
      }],
    };
  }
  return {
    listingKey,
    channel: "amazon",
    storeIndex: 1,
    sku,
    disposition: "QUARANTINE",
    writeEligible: false,
    supersedesInvalidCanonicalCostIds: [],
    blockers: [{
      code: "PRODUCT_IDENTITY_MISSING",
      message: "product identity is missing",
    }],
    components: [],
  };
}

function snapshot(
  scope: ReturnType<typeof manifest>,
  manifestSha256: string,
): ProductTruthLegacyBridgeSnapshot {
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: TARGET,
    manifest: {
      schemaVersion: scope.schemaVersion,
      sha256: manifestSha256,
      asOf: scope.asOf,
      listingCount: scope.listings.length,
    },
    listings: scope.listings.map((listing) => ({
      listingKey: listing.listingKey,
      channel: listing.channel,
      storeIndex: listing.storeIndex,
      sku: listing.sku,
      listingUpc: null,
      listingUpcSource: null,
      priorityGmv30d: listing.sku === "WM-2" ? 100 : null,
      priorityOrders30d: null,
      priorityUnits30d: null,
      priorityObservedAt: null,
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    })),
    components: [],
    donors: [{
      id: "donor-1",
      brand: "Acme",
      productLine: "Crunch",
      flavor: "Barbecue",
      containerType: "bag",
      size: "8 oz",
      category: "snacks",
      upc: "012345678905",
      gtin: "00012345678905",
      title: "Acme Crunch Barbecue 8 oz",
      description: null,
      bullets: null,
      attributes: null,
      nutritionFacts: null,
      ingredients: null,
      mainImageUrl: null,
      imageUrls: null,
      identityKey: "donor-identity-1",
      identityStatus: "VERIFIED",
      createdAt: AS_OF,
      updatedAt: AS_OF,
    }],
    offers: [{
      id: "offer-1",
      donorProductId: "donor-1",
      retailer: "walmart",
      retailerProductId: "retailer-1",
      via: "fixture",
      price: 4.99,
      packSizeSeen: 1,
      pricePerUnit: 4.99,
      currency: "USD",
      zip: "33765",
      localityEvidence: null,
      inStock: true,
      productUrl: "https://www.walmart.com/ip/retailer-1",
      isFirstParty: true,
      sourceApi: "fixture",
      fetchedAt: AS_OF,
    }],
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [],
    bundleFactoryRecipeEvidence: [],
  };
}

function bridgePlan(
  scope: ReturnType<typeof manifest>,
  manifestSha256: string,
  snapshotSha256: string,
): ProductTruthLegacyBridgePlan {
  const scopes = scope.listings.map((listing) =>
    bridgeScope(listing.listingKey));
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
    policyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
    generatedAt: CAPTURED_AT,
    source: {
      snapshotSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
      snapshotSha256,
      targetFingerprint: TARGET,
      manifest: {
        schemaVersion: scope.schemaVersion,
        sha256: manifestSha256,
        asOf: scope.asOf,
        listingCount: scope.listings.length,
      },
    },
    matcher: {
      version: CANONICAL_PRODUCT_MATCHER_VERSION,
      implementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      releaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    },
    pricePolicy: {
      version: PRICE_EVIDENCE_POLICY_VERSION,
      evaluatedAt: CAPTURED_AT,
      maxAgeMs: PRODUCT_TRUTH_LEGACY_BRIDGE_PRICE_MAX_AGE_MS,
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
      listingsTotal: 3,
      alreadyCanonicalListings: 1,
      exactCanonicalizationCandidates: 0,
      contentOnlyCanonicalizationCandidates: 0,
      identityOnlyCanonicalizationCandidates: 0,
      quarantinedListings: 2,
      componentsTotal: 2,
      alreadyCanonicalComponents: 1,
      exactContentAndPriceCandidates: 0,
      exactContentOnlyCandidates: 0,
      exactIdentityOnlyCandidates: 0,
      priceOnlyEstimates: 0,
      quarantinedComponents: 1,
    },
    scopes,
  };
}

function readinessEntry(
  listing: ReturnType<typeof manifest>["listings"][number],
  ordinal: number,
): ProductTruthConsumerReadinessEntry {
  const present = listing.sku === "WM-1";
  const recipeBlockers = present ? [] : ["CURRENT_LISTING_RECIPE_MISSING"];
  return {
    ordinal,
    listingKey: listing.listingKey,
    channel: listing.channel,
    storeIndex: listing.storeIndex,
    sku: listing.sku,
    consumers: {
      bundleFactory: {
        status: present ? "READY" : "BLOCKED",
        blockers: recipeBlockers,
        viewSha256: productTruthOperationalSha256(`bf:${listing.listingKey}`),
      },
      listingImprovement: {
        status: present ? "READY" : "BLOCKED",
        blockers: recipeBlockers,
        viewSha256: productTruthOperationalSha256(`li:${listing.listingKey}`),
      },
      unitEconomics: {
        status: present ? "FACT" : "MISSING",
        blockers: present ? [] : ["CURRENT_SCOPED_SKU_COST_MISSING"],
        skuCostId: present ? "cost-WM-1" : null,
        viewSha256: productTruthOperationalSha256(`ue:${listing.listingKey}`),
      },
      procurement: {
        status: present ? "READY" : "BLOCKED",
        blockers: present
          ? []
          : [...recipeBlockers, "CURRENT_SCOPED_SKU_COST_MISSING"],
        viewSha256: productTruthOperationalSha256(`p:${listing.listingKey}`),
      },
    },
  };
}

function readiness(
  scope: ReturnType<typeof manifest>,
  manifestSha256: string,
): ProductTruthConsumerReadinessReport {
  const payload = {
    schemaVersion: PRODUCT_TRUTH_CONSUMER_READINESS_VERSION,
    mode: "READ_ONLY_NO_PAID_READINESS" as const,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    capturedAt: CAPTURED_AT,
    asOf: AS_OF,
    maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    databaseTargetFingerprint: TARGET,
    authoritativeManifest: {
      schemaVersion: scope.schemaVersion,
      sha256: manifestSha256,
      asOf: scope.asOf,
      liveListings: scope.listings.length,
    },
    counts: {
      denominator: 3,
      reconciled: 3,
      bundleFactory: { ready: 1, blocked: 2 },
      listingImprovement: { ready: 1, blocked: 2 },
      unitEconomics: {
        ready: 1,
        blocked: 2,
        fact: 1,
        estimate: 0,
        unsourceable: 0,
        missing: 2,
        invalid: 0,
      },
      procurement: { ready: 1, blocked: 2 },
    },
    dataReadyConsumers: [],
    entries: scope.listings.map(readinessEntry),
    claims: {
      databaseWrites: false as const,
      providerCalls: false as const,
      paidCalls: false as const,
      enrichmentMutations: false as const,
      marketplaceMutations: false as const,
      procurementMutations: false as const,
      ownerActivationGranted: false as const,
      consumerCutoverClaimed: false as const,
    },
  };
  return {
    ...payload,
    payloadSha256: productTruthOperationalSha256(payload),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const scope = manifest();
  const manifestJson = renderPhase1ScopeManifestJson(scope);
  const manifestSha256 = sha256(manifestJson);
  const sourceSnapshot = snapshot(scope, manifestSha256);
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(sourceSnapshot);
  const snapshotSha256 = sha256(snapshotJson);
  const plan = bridgePlan(scope, manifestSha256, snapshotSha256);
  const planJson = renderProductTruthLegacyBridgePlan(plan);
  const consumerReadiness = readiness(scope, manifestSha256);
  const readinessJson =
    renderProductTruthConsumerReadinessJson(consumerReadiness);
  const legacyState = {
    "WM-1": {
      sku: "WM-1",
      status: "GEN_OK",
      donorTitle: "Acme Crunch Barbecue 8 oz",
      qty: 2,
      audit: { brand: true, variant: true },
    },
    "WM-2": {
      sku: "WM-2",
      status: "VARIANT_MISMATCH",
      donorTitle: "Acme Crunch Barbecue 8 oz",
      listing: "Acme Crunch Ranch 8 oz Pack of 3",
      reason: "donor differs on ranch",
    },
    "OLD-OUT": {
      sku: "OLD-OUT",
      status: "DONOR_FAIL",
      reason: "not found",
    },
  };
  const legacyStateJson = `${JSON.stringify(legacyState, null, 2)}\n`;
  return {
    generatedAt: GENERATED_AT,
    legacyImageState: legacyState,
    legacyImageStateJson: legacyStateJson,
    legacyImageStateSha256: sha256(legacyStateJson),
    manifest: scope,
    manifestJson,
    manifestSha256,
    bridgeSnapshot: sourceSnapshot,
    bridgeSnapshotJson: snapshotJson,
    bridgeSnapshotSha256: snapshotSha256,
    bridgePlan: plan,
    bridgePlanJson: planJson,
    bridgePlanSha256: sha256(planJson),
    readiness: consumerReadiness,
    readinessJson,
    readinessSha256: sha256(readinessJson),
  };
}

test("builds one immutable full-denominator recipe repair scope without promoting old status", () => {
  const report = compileProductTruthRecipeRepairScope(fixture());
  assert.deepEqual(report.counts, {
    denominator: 3,
    currentRecipePresent: 1,
    currentRecipeMissing: 2,
    currentCogs: {
      fact: 1,
      estimate: 0,
      unsourceable: 0,
      missing: 2,
      invalid: 0,
    },
    historicalState: {
      totalEntries: 3,
      mappedToAuthoritativeWalmartScope: 2,
      outsideAuthoritativeScope: 1,
      ambiguousAuthoritativeMatches: 0,
      currentRecipePresent: 1,
      currentRecipeMissing: 1,
    },
    currentRecipeMissingWithHistoricalState: 1,
    currentRecipeMissingWithoutHistoricalState: 1,
    currentRecipeMissingEvidenceProfile: {
      noComponents: 1,
      withTargetIdentity: 1,
      allComponentsHaveTargetIdentity: 1,
      withCandidateDonor: 1,
      allComponentsHaveCandidateDonor: 1,
      withExactIdentityOnlyComponent: 0,
      allComponentsExactIdentityOnly: 0,
      withRejectedComponent: 1,
    },
    channelCounts: [
      {
        channel: "amazon",
        denominator: 1,
        currentRecipePresent: 0,
        currentRecipeMissing: 1,
        historicalStateAvailable: 0,
      },
      {
        channel: "walmart",
        denominator: 2,
        currentRecipePresent: 1,
        currentRecipeMissing: 1,
        historicalStateAvailable: 2,
      },
    ],
  });
  assert.equal(
    report.entries.find((entry) => entry.sku === "WM-1")?.repairLane,
    "CURRENT_RECIPE_PRESENT",
  );
  const mismatch = report.entries.find((entry) => entry.sku === "WM-2")!;
  assert.equal(mismatch.repairLane, "RETAILER_IDENTITY_RESEARCH");
  assert.equal(mismatch.historicalEvidence?.status, "VARIANT_MISMATCH");
  assert.equal(mismatch.historicalEvidence?.identityProof, false);
  assert.equal(mismatch.components[0]?.candidateDonor?.firstPartyDirectOfferCount, 1);
  assert.equal(
    report.entries.find((entry) => entry.sku === "AMZ-1")?.repairLane,
    "LISTING_IDENTITY_RECOVERY",
  );
  assert.deepEqual(report.orphanedHistoricalState.map((row) => row.sku), ["OLD-OUT"]);
  assert.equal(report.claims.authorizesExecution, false);
  assert.equal(report.claims.variantMismatchAutoPromoted, false);
  assert.equal(report.claims.repairLaneIsPriorityNotTruthMutation, true);
  assert.equal(
    renderProductTruthRecipeRepairScope(report),
    renderProductTruthRecipeRepairScope(
      compileProductTruthRecipeRepairScope(fixture()),
    ),
  );
});

test("fails closed on source-byte tampering and cross-source recipe contradictions", () => {
  const tampered = fixture();
  tampered.legacyImageStateJson += " ";
  assert.throws(
    () => compileProductTruthRecipeRepairScope(tampered),
    (error: unknown) =>
      error instanceof ProductTruthRecipeRepairScopeError
      && error.code === "RECIPE_REPAIR_SOURCE_HASH_MISMATCH",
  );

  const contradiction = fixture();
  const amazon = contradiction.bridgePlan.scopes.find(
    (scope) => scope.sku === "AMZ-1",
  )!;
  amazon.disposition = "ALREADY_CANONICAL";
  amazon.blockers = [];
  const planJson = renderProductTruthLegacyBridgePlan(
    contradiction.bridgePlan,
  );
  contradiction.bridgePlanJson = planJson;
  contradiction.bridgePlanSha256 = sha256(planJson);
  assert.throws(
    () => compileProductTruthRecipeRepairScope(contradiction),
    (error: unknown) =>
      error instanceof ProductTruthRecipeRepairScopeError
      && error.code === "RECIPE_REPAIR_SOURCE_CONTRADICTION",
  );
});

test("preserves an explicitly orphaned legacy donor as a blocker, not a candidate", () => {
  const orphaned = fixture();
  const component = orphaned.bridgePlan.scopes.find(
    (scope) => scope.sku === "WM-2",
  )!.components[0]!;
  component.donorProductId = "orphaned-donor";
  component.legacyDonorProductId = "orphaned-donor";
  component.matcherVerdict = null;
  component.matcherReasonCodes = [];
  component.blockers = [{
    code: "LEGACY_DONOR_ORPHANED",
    message: "legacy donor no longer exists",
  }];
  const planJson = renderProductTruthLegacyBridgePlan(orphaned.bridgePlan);
  orphaned.bridgePlanJson = planJson;
  orphaned.bridgePlanSha256 = sha256(planJson);
  const report = compileProductTruthRecipeRepairScope(orphaned);
  const entry = report.entries.find((row) => row.sku === "WM-2")!;
  assert.equal(entry.repairLane, "DONOR_LINK_RECOVERY");
  assert.equal(entry.components[0]?.candidateDonorProductId, "orphaned-donor");
  assert.equal(entry.components[0]?.candidateDonor, null);
});
