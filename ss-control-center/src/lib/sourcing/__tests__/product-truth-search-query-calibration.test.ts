import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
} from "../product-truth-component-acquisition-scope";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  calibratedProductTruthProviderQuery,
  compileProductTruthSearchQueryCalibration,
} from "../product-truth-search-query-calibration";

const GENERATED_AT = "2026-07-30T06:00:00.000Z";
const TARGET_FINGERPRINT = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(count = 10) {
  const donors: Array<Record<string, unknown>> = [];
  const bindings: Array<Record<string, unknown>> = [];
  const scopes: Array<Record<string, unknown>> = [];
  const targets: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const canonicalVariantId = `cpv1:${String(index).padStart(64, "0")}`;
    const donorProductId = `z-positive-${String(index).padStart(2, "0")}`;
    const identity = {
      brand: `Brand${index}`,
      productLine: "Soup",
      flavor: null,
      form: "can",
      size: "10 oz",
      outerPackCount: 1,
    };
    donors.push({
      id: `a-distractor-${String(index).padStart(2, "0")}`,
      title: `Brand${index} Soup Box 10 oz`,
    });
    donors.push({
      id: donorProductId,
      title: `Brand${index} Soup Can 10 oz`,
    });
    bindings.push({
      canonicalVariantId,
      canonicalIdentityJson: JSON.stringify(identity),
      decisionId: `decision-${index}`,
      decisionStatus: "exact_confirmed",
      decidedAt: GENERATED_AT,
      donorProductId,
    });
    scopes.push({
      listingKey: `walmart:1:sku-${index}`,
      channel: "walmart",
      storeIndex: 1,
      sku: `sku-${index}`,
      disposition: "ALREADY_CANONICAL",
      writeEligible: false,
      supersedesInvalidCanonicalCostIds: [],
      blockers: [],
      components: [{
        componentIndex: 0,
        targetIdentity: identity,
        targetVariant: { canonicalVariantId },
      }],
    });
    targets.push({
      ordinal: index,
      acquisitionPriority: index + 1,
      canonicalVariantId,
      canonicalIdentityHash: String(index).padStart(64, "0"),
      canonicalIdentityJson: JSON.stringify(identity),
      targetIdentity: identity,
      identityQuality: {
        status: "ACQUISITION_READY",
        blockerCodes: [],
      },
      acquisitionLane: "PROVIDER_IDENTITY_ACQUISITION",
      exactCatalogCandidates: [],
      impact: {
        componentUses: 1,
        dependentListings: 1,
        immediateClosableListings: 1,
        amazonListings: 0,
        walmartListings: 1,
        knownGmv30d: 0,
        knownOrders30d: 0,
        knownUnits30d: 0,
      },
      dependencies: [],
    });
  }
  const snapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: GENERATED_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: { sha256: MANIFEST_SHA },
    listings: [],
    components: [],
    donors,
    offers: [],
    canonicalDonorBindings: bindings,
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [],
    bundleFactoryRecipeEvidence: [],
  } as unknown as ProductTruthLegacyBridgeSnapshot;
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = sha256(snapshotJson);
  const bridgePlan = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
    policyVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_POLICY_VERSION,
    generatedAt: GENERATED_AT,
    source: {
      snapshotSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
      snapshotSha256,
      targetFingerprint: TARGET_FINGERPRINT,
      manifest: { sha256: MANIFEST_SHA },
    },
    matcher: {},
    pricePolicy: {},
    safety: {},
    counts: {},
    scopes,
  } as unknown as ProductTruthLegacyBridgePlan;
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  const componentScope = {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
    generatedAt: GENERATED_AT,
    source: {
      recipeRepairScope: {
        schemaVersion: "product-truth-recipe-repair-scope/1.0.0",
        sha256: "c".repeat(64),
        generatedAt: GENERATED_AT,
        missingListings: count,
      },
      bridgeSnapshot: {
        schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
        sha256: snapshotSha256,
        capturedAt: GENERATED_AT,
        targetFingerprint: TARGET_FINGERPRINT,
        donorCount: donors.length,
        offerCount: 0,
        canonicalBindingCount: bindings.length,
      },
    },
    selectionPolicy: {},
    matcher: {},
    counts: {},
    projectedClosures: [],
    invalidComponentDependencies: [],
    targets,
    claims: {},
  } as unknown as ProductTruthComponentAcquisitionScope;
  const componentScopeJson =
    renderProductTruthComponentAcquisitionScope(componentScope);
  return {
    snapshot,
    snapshotJson,
    snapshotSha256,
    bridgePlan,
    bridgePlanJson,
    bridgePlanSha256: sha256(bridgePlanJson),
    componentScope,
    componentScopeJson,
    componentScopeSha256: sha256(componentScopeJson),
  };
}

function compile(count = 10) {
  const value = fixture(count);
  return compileProductTruthSearchQueryCalibration({
    generatedAt: GENERATED_AT,
    bridgeSnapshot: value.snapshot,
    bridgeSnapshotJson: value.snapshotJson,
    bridgeSnapshotSha256: value.snapshotSha256,
    bridgePlan: value.bridgePlan,
    bridgePlanJson: value.bridgePlanJson,
    bridgePlanSha256: value.bridgePlanSha256,
    componentScope: value.componentScope,
    componentScopeJson: value.componentScopeJson,
    componentScopeSha256: value.componentScopeSha256,
  });
}

test("calibration admits a form only after a complete non-degrading positive denominator", () => {
  const report = compile();
  assert.deepEqual(report.admittedForms, ["can"]);
  assert.equal(report.currentMetrics.top1, 0);
  assert.equal(report.calibratedMetrics.top1, 10);
  assert.equal(report.comparison.improvedCases, 10);
  assert.equal(report.comparison.degradedCases, 0);
  assert.equal(report.counts.admittedProviderTargets, 10);
  assert.equal(
    report.paidWaveAdmission,
    "CALIBRATED_FORM_QUERY_TARGETS_AVAILABLE",
  );
  assert.equal(report.claims.providerCalls, 0);
  assert.equal(report.claims.authorizesExecution, false);
});

test("undersized evidence remains blocked instead of generalizing a query rule", () => {
  const report = compile(9);
  assert.deepEqual(report.admittedForms, []);
  assert.equal(report.counts.admittedProviderTargets, 0);
  assert.equal(
    report.formGroups[0]?.blockers.includes("POSITIVE_DENOMINATOR_TOO_SMALL"),
    true,
  );
  assert.equal(
    report.paidWaveAdmission,
    "BLOCKED_NO_DEMONSTRATED_QUERY_IMPROVEMENT",
  );
});

test("calibrated query changes only admitted forms and exact source drift fails closed", () => {
  const report = compile();
  assert.deepEqual(
    calibratedProductTruthProviderQuery({
      identity: {
        brand: "Brand",
        productLine: "Soup",
        form: "can",
        size: "10 oz",
      },
      admittedForms: report.admittedForms,
    }),
    {
      queryVersion: "product-truth-provider-query/form-augmented-v1",
      query: "Brand Soup can 10 oz",
      form: "can",
      calibrated: true,
    },
  );
  const value = fixture();
  assert.throws(
    () => compileProductTruthSearchQueryCalibration({
      generatedAt: GENERATED_AT,
      bridgeSnapshot: value.snapshot,
      bridgeSnapshotJson: `${value.snapshotJson} `,
      bridgeSnapshotSha256: value.snapshotSha256,
      bridgePlan: value.bridgePlan,
      bridgePlanJson: value.bridgePlanJson,
      bridgePlanSha256: value.bridgePlanSha256,
      componentScope: value.componentScope,
      componentScopeJson: value.componentScopeJson,
      componentScopeSha256: value.componentScopeSha256,
    }),
    /SEARCH_QUERY_CALIBRATION_SOURCE_SHA_MISMATCH/,
  );
});

test("calibration CLI has no database, provider or marketplace execution surface", async () => {
  const source = await readFile(
    new URL(
      "../../../../scripts/build-product-truth-search-query-calibration.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\bcreateClient\b|\bfetch\s*\(|\bwithMeteredProviderCall\b|\bcostOneSku\b|\benrichTarget\b|node:child_process|\bspawn\s*\(|(?<![.\w])exec(?:File|Sync)?\s*\(|\b(?:INSERT|UPDATE|DELETE)\b\s/i,
  );
});
