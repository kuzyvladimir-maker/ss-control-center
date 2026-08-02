import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PHASE1_SCOPE_DISPOSITION_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  type Phase1ScopeDispositionEntry,
} from "../phase1-scope-manifest";
import {
  PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION,
  compileProductTruthAmazonCatalogCapturePlan,
  compileProductTruthAmazonCatalogListingEvidence,
  renderProductTruthAmazonCatalogCapture,
  renderProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogCapture,
  type ProductTruthAmazonCatalogCapturePlan,
} from "../product-truth-amazon-catalog-evidence";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScope,
} from "../product-truth-recipe-repair-scope";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";

const AS_OF = "2026-08-01T15:00:00.000Z";
const GENERATED_AT = "2026-08-01T15:01:00.000Z";
const AMAZON_REPORT = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Ready Set Gourmet Mott's Applesauce Pack of 12\tAMZ-1\tB09QT2N7ZR\tActive\tDEFAULT",
].join("\n");
const WALMART_REPORT = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  "WM-1,10001,Acme Existing Product,Published,Active",
].join("\n");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function disposition(
  channel: "amazon" | "walmart",
): Phase1ScopeDispositionEntry {
  const content = channel === "amazon" ? AMAZON_REPORT : WALMART_REPORT;
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
      decisionId: `${channel}-owner-decision-1`,
      decidedBy: "Vladimir",
      decidedAt: "2026-08-01T14:55:00.000Z",
      reason: "Amazon Catalog evidence fixture",
    },
    report: {
      reportType: channel === "amazon"
        ? "GET_MERCHANT_LISTINGS_ALL_DATA"
        : "ITEM_CATALOG",
      reportId: `${channel}-report-1`,
      capturedAt: "2026-08-01T14:58:00.000Z",
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
  };
}

function sources() {
  const manifest = buildPhase1ScopeManifest({
    asOf: AS_OF,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: AS_OF,
      capturedAt: "2026-08-01T14:57:00.000Z",
      attestedAt: "2026-08-01T14:59:00.000Z",
      identityStyle: "index",
      amazonConnected: [1],
      walmartConnected: [1],
      walmartSupported: [1],
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [disposition("amazon"), disposition("walmart")],
    },
    reports: [
      {
        channel: "amazon",
        scopeKey: "store1",
        sourceName: "amazon.tsv",
        content: AMAZON_REPORT,
      },
      {
        channel: "walmart",
        scopeKey: "store1",
        sourceName: "walmart.csv",
        content: WALMART_REPORT,
      },
    ],
  });
  assert.equal(manifest.authoritative, true, JSON.stringify(manifest.blockers));
  assert.equal(manifest.blockers.length, 0);
  const manifestJson = renderPhase1ScopeManifestJson(manifest);
  const manifestSha256 = sha256(manifestJson);
  const listing = manifest.listings.find((row) => row.channel === "amazon")!;
  const walmartListing = manifest.listings.find((row) => row.channel === "walmart")!;
  const recipeScope = {
    schemaVersion: PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
    generatedAt: GENERATED_AT,
    source: {
      manifest: {
        schemaVersion: manifest.schemaVersion,
        sha256: manifestSha256,
        asOf: manifest.asOf,
        listingCount: 2,
      },
      legacyImageState: { sha256: "1".repeat(64), entryCount: 0 },
      bridgeSnapshot: {
        schemaVersion: "product-truth-legacy-bridge-snapshot/1.2.0",
        sha256: "2".repeat(64),
        capturedAt: GENERATED_AT,
      },
      bridgePlan: {
        schemaVersion: "product-truth-legacy-bridge-plan/1.3.0",
        sha256: "3".repeat(64),
        generatedAt: GENERATED_AT,
      },
      readiness: {
        schemaVersion: "product-truth-consumer-readiness/1.2.0",
        sha256: "4".repeat(64),
        payloadSha256: "5".repeat(64),
        capturedAt: GENERATED_AT,
        asOf: GENERATED_AT,
      },
      targetFingerprint: "6".repeat(64),
    },
    rankingPolicy: "GMV_ORDERS_UNITS_THEN_EXISTING_EVIDENCE_THEN_LISTING_KEY",
    counts: {
      denominator: 2,
      currentRecipePresent: 1,
      currentRecipeMissing: 1,
    },
    laneCounts: [
      { lane: "LISTING_IDENTITY_RECOVERY", count: 1 },
      { lane: "CURRENT_RECIPE_PRESENT", count: 1 },
    ],
    entries: [
      {
        ordinal: 1,
        repairPriority: 1,
        listingKey: listing.listingKey,
        channel: "amazon",
        storeIndex: listing.storeIndex,
        sku: listing.sku,
        listingId: listing.listingId,
        listingTitle: listing.title,
        priorityGmv30d: null,
        priorityOrders30d: null,
        priorityUnits30d: null,
        recipeStatus: "MISSING",
        cogsOutcome: "MISSING",
        repairLane: "LISTING_IDENTITY_RECOVERY",
        bridgeDisposition: "QUARANTINE",
        bridgeBlockerCodes: ["LISTING_IDENTITY_UNRESOLVED"],
        matcherReasonCodes: [],
        historicalEvidence: null,
        components: [],
      },
      {
        ordinal: 2,
        repairPriority: null,
        listingKey: walmartListing.listingKey,
        channel: "walmart",
        storeIndex: walmartListing.storeIndex,
        sku: walmartListing.sku,
        listingId: walmartListing.listingId,
        listingTitle: walmartListing.title,
        priorityGmv30d: null,
        priorityOrders30d: null,
        priorityUnits30d: null,
        recipeStatus: "PRESENT",
        cogsOutcome: "UNSOURCEABLE",
        repairLane: "CURRENT_RECIPE_PRESENT",
        bridgeDisposition: "ALREADY_CANONICAL",
        bridgeBlockerCodes: [],
        matcherReasonCodes: [],
        historicalEvidence: null,
        components: [],
      },
    ],
    orphanedHistoricalState: [],
    claims: {
      readOnlySources: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      historicalStateIsIdentityProof: false,
      historicalStatusAuthorizesRecipe: false,
      variantMismatchAutoPromoted: false,
      createsAdditionalCatalog: false,
      repairLaneIsPriorityNotTruthMutation: true,
    },
  } as unknown as ProductTruthRecipeRepairScope;
  const recipeScopeJson = renderProductTruthRecipeRepairScope(recipeScope);
  return {
    manifest,
    manifestJson,
    manifestSha256,
    recipeScope,
    recipeScopeJson,
    recipeScopeSha256: sha256(recipeScopeJson),
    listing,
  };
}

function plan(): ProductTruthAmazonCatalogCapturePlan {
  const source = sources();
  return compileProductTruthAmazonCatalogCapturePlan({
    generatedAt: GENERATED_AT,
    listingKeys: [source.listing.listingKey],
    manifest: source.manifest,
    manifestJson: source.manifestJson,
    manifestSha256: source.manifestSha256,
    recipeRepairScope: source.recipeScope,
    recipeRepairScopeJson: source.recipeScopeJson,
    recipeRepairScopeSha256: source.recipeScopeSha256,
  });
}

function captureFixture(inputPlan: ProductTruthAmazonCatalogCapturePlan) {
  const rawValue = {
    asin: inputPlan.targets[0]!.asin,
    attributes: {
      brand: [{ value: "Mott's" }],
      unit_count: [{ value: 12, unit: "count" }],
    },
    identifiers: [{
      marketplaceId: "ATVPDKIKX0DER",
      identifiers: [{ identifierType: "UPC", identifier: "810099020278" }],
    }],
    images: [{ marketplaceId: "ATVPDKIKX0DER", images: [{ link: "https://example.test/1.jpg" }] }],
    productTypes: [{ marketplaceId: "ATVPDKIKX0DER", productType: "FRUIT_SNACK" }],
    relationships: [],
    summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: "Mott's Applesauce" }],
  };
  const rawJson = renderProductTruthOperationalJson(rawValue);
  const planJson = renderProductTruthAmazonCatalogCapturePlan(inputPlan);
  const capture: ProductTruthAmazonCatalogCapture = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_VERSION,
    capturedAt: GENERATED_AT,
    plan: {
      sha256: sha256(planJson),
      targetSetSha256: inputPlan.targetSetSha256,
      targetCount: 1,
    },
    requestContract: inputPlan.requestContract,
    entries: [{
      ordinal: 1,
      listingKey: inputPlan.targets[0]!.listingKey,
      storeIndex: 1,
      asin: inputPlan.targets[0]!.asin,
      capturedAt: GENERATED_AT,
      rawFile: "0001-B09QT2N7ZR.json",
      rawSha256: sha256(rawJson),
      rawByteLength: Buffer.byteLength(rawJson, "utf8"),
    }],
    counts: { planned: 1, attempted: 1, captured: 1, failed: 0 },
    claims: {
      amazonGetCalls: 1,
      retries: 0,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
    },
  };
  const captureJson = renderProductTruthAmazonCatalogCapture(capture);
  return { rawValue, rawJson, planJson, capture, captureJson };
}

test("builds one explicit manifest-bound GET-only capture plan", () => {
  const result = plan();
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]!.asin, "B09QT2N7ZR");
  assert.equal(result.requestContract.attemptsPerTarget, 1);
  assert.equal(result.claims.marketplaceMutations, 0);
  assert.equal(result.claims.authorizesCanonicalMaterialization, false);
  assert.match(result.targets[0]!.manifestRowSha256, /^[a-f0-9]{64}$/u);
});

test("classifies Amazon Catalog identifiers as outer marketplace evidence only", () => {
  const inputPlan = plan();
  const fixture = captureFixture(inputPlan);
  const evidence = compileProductTruthAmazonCatalogListingEvidence({
    compiledAt: GENERATED_AT,
    plan: inputPlan,
    planJson: fixture.planJson,
    planSha256: sha256(fixture.planJson),
    capture: fixture.capture,
    captureJson: fixture.captureJson,
    captureSha256: sha256(fixture.captureJson),
    rawResponses: new Map([[
      "0001-B09QT2N7ZR.json",
      { json: fixture.rawJson, value: fixture.rawValue },
    ]]),
  });
  assert.deepEqual(evidence.entries[0]!.catalog.identifiers, [{
    marketplaceId: "ATVPDKIKX0DER",
    identifierType: "UPC",
    identifier: "810099020278",
    classification: "OUTER_MARKETPLACE_CATALOG_IDENTIFIER",
    baseUnitIdentityProof: false,
  }]);
  assert.equal(evidence.claims.identifiersAreBaseUnitProof, false);
  assert.equal(evidence.claims.titleOnlyIdentityProof, false);
  assert.equal(evidence.claims.authorizesCanonicalMaterialization, false);
});

test("fails closed on implicit/duplicate scope and raw response tampering", () => {
  const source = sources();
  assert.throws(() => compileProductTruthAmazonCatalogCapturePlan({
    generatedAt: GENERATED_AT,
    listingKeys: [source.listing.listingKey, source.listing.listingKey],
    manifest: source.manifest,
    manifestJson: source.manifestJson,
    manifestSha256: source.manifestSha256,
    recipeRepairScope: source.recipeScope,
    recipeRepairScopeJson: source.recipeScopeJson,
    recipeRepairScopeSha256: source.recipeScopeSha256,
  }), /AMAZON_CATALOG_EXPLICIT_SCOPE_INVALID/u);

  const inputPlan = plan();
  const fixture = captureFixture(inputPlan);
  assert.throws(() => compileProductTruthAmazonCatalogListingEvidence({
    compiledAt: GENERATED_AT,
    plan: inputPlan,
    planJson: fixture.planJson,
    planSha256: sha256(fixture.planJson),
    capture: fixture.capture,
    captureJson: fixture.captureJson,
    captureSha256: sha256(fixture.captureJson),
    rawResponses: new Map([[
      "0001-B09QT2N7ZR.json",
      { json: `${fixture.rawJson} `, value: fixture.rawValue },
    ]]),
  }), /AMAZON_CATALOG_RAW_BINDING_MISMATCH/u);
});
