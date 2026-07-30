import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionDependency,
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
} from "../product-truth-component-acquisition-scope";
import {
  compileProductTruthProviderTargetWave,
  PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION,
  ProductTruthProviderTargetWaveError,
  renderProductTruthProviderAttemptCapture,
  renderProductTruthProviderTargetWave,
  type ProductTruthProviderAttemptCapture,
} from "../product-truth-provider-target-wave";

const FINGERPRINT = "f".repeat(64);
const MANIFEST_SHA = "e".repeat(64);
const GENERATED_AT = "2026-07-30T05:00:00.000Z";
const EXPIRES_AT = "2026-07-30T06:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function variant(character: string): string {
  return `cpv1:${character.repeat(64)}`;
}

function dependency(
  listingKey: string,
  componentIndex: number,
  input: {
    orders?: number | null;
    units?: number | null;
    gmv?: number | null;
    repairPriority?: number | null;
  } = {},
): ProductTruthComponentAcquisitionDependency {
  const [channel, storeText, sku] = listingKey.split(":");
  return {
    listingKey,
    channel: channel as "amazon" | "walmart",
    storeIndex: Number(storeText),
    sku: sku!,
    componentIndex,
    quantity: 1,
    repairLane: "RETAILER_IDENTITY_RESEARCH",
    legacyComponentId: `component:${listingKey}:${componentIndex}`,
    legacyDonorProductId: null,
    historicalEvidence: null,
    priority: {
      gmv30d: input.gmv ?? null,
      orders30d: input.orders ?? null,
      units30d: input.units ?? null,
      repairPriority: input.repairPriority ?? null,
    },
  };
}

function target(input: {
  character: string;
  priority: number;
  brand: string;
  productLine: string;
  flavor?: string | null;
  size: string;
  dependencies: ProductTruthComponentAcquisitionDependency[];
}): ProductTruthComponentAcquisitionTarget {
  const canonicalVariantId = variant(input.character);
  return {
    ordinal: input.priority - 1,
    acquisitionPriority: input.priority,
    canonicalVariantId,
    canonicalIdentityHash: input.character.repeat(64),
    canonicalIdentityJson: JSON.stringify({
      brand: input.brand.toLowerCase(),
      productLine: input.productLine.toLowerCase(),
    }),
    targetIdentity: {
      brand: input.brand,
      productLine: input.productLine,
      flavor: input.flavor ?? null,
      modifiers: [],
      form: "box",
      size: input.size,
      outerPackCount: 1,
    },
    identityQuality: {
      status: "ACQUISITION_READY",
      blockerCodes: [],
    },
    acquisitionLane: "PROVIDER_IDENTITY_ACQUISITION",
    exactCatalogCandidates: [],
    impact: {
      componentUses: input.dependencies.length,
      dependentListings: new Set(
        input.dependencies.map((item) => item.listingKey),
      ).size,
      immediateClosableListings: input.dependencies.length,
      amazonListings: new Set(
        input.dependencies
          .filter((item) => item.channel === "amazon")
          .map((item) => item.listingKey),
      ).size,
      walmartListings: new Set(
        input.dependencies
          .filter((item) => item.channel === "walmart")
          .map((item) => item.listingKey),
      ).size,
      knownGmv30d: input.dependencies.reduce(
        (sum, item) => sum + (item.priority.gmv30d ?? 0),
        0,
      ),
      knownOrders30d: input.dependencies.reduce(
        (sum, item) => sum + (item.priority.orders30d ?? 0),
        0,
      ),
      knownUnits30d: input.dependencies.reduce(
        (sum, item) => sum + (item.priority.units30d ?? 0),
        0,
      ),
    },
    dependencies: input.dependencies,
  };
}

function scope(): ProductTruthComponentAcquisitionScope {
  const targets = [
    target({
      character: "a",
      priority: 1,
      brand: "Already",
      productLine: "Attempted",
      size: "10 oz",
      dependencies: [
        dependency("walmart:1:A1", 0, {
          orders: 4,
          repairPriority: 1,
        }),
        dependency("walmart:1:A2", 0),
      ],
    }),
    target({
      character: "b",
      priority: 2,
      brand: "Selected",
      productLine: "First",
      flavor: "Original",
      size: "12 oz",
      dependencies: [
        dependency("walmart:1:B2", 0, {
          orders: 1,
          repairPriority: 10,
        }),
        dependency("walmart:1:B1", 0, {
          orders: 2,
          repairPriority: 20,
        }),
      ],
    }),
    target({
      character: "c",
      priority: 3,
      brand: "Shared",
      productLine: "Component C",
      size: "1 count",
      dependencies: [dependency("walmart:1:CD", 0)],
    }),
    target({
      character: "d",
      priority: 4,
      brand: "Shared",
      productLine: "Component D",
      size: "1 count",
      dependencies: [dependency("walmart:1:CD", 1)],
    }),
    target({
      character: "e",
      priority: 5,
      brand: "Selected",
      productLine: "Second",
      size: "16 oz",
      dependencies: [dependency("amazon:1:E1", 0)],
    }),
  ];
  return {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
    generatedAt: "2026-07-30T04:30:00.000Z",
    source: {
      recipeRepairScope: {
        schemaVersion: "product-truth-recipe-repair-scope/1.2.0",
        sha256: "1".repeat(64),
        generatedAt: "2026-07-30T04:20:00.000Z",
        missingListings: 7,
      },
      bridgeSnapshot: {
        schemaVersion: "product-truth-legacy-bridge-snapshot/1.2.0",
        sha256: "2".repeat(64),
        capturedAt: "2026-07-30T04:25:00.000Z",
        targetFingerprint: FINGERPRINT,
        donorCount: 0,
        offerCount: 0,
        canonicalBindingCount: 0,
      },
    },
    matcher: {
      version: "1.2.1",
      implementationSha256: "3".repeat(64),
      releaseSha256: "4".repeat(64),
    },
    selectionPolicy: {
      unitOfWork: "UNIQUE_CANONICAL_COMPONENT_VARIANT",
      catalogSearch:
        "ALL_EXISTING_DONORS_SAME_EXACT_NORMALIZED_BRAND_STRICT_TITLE_AND_EXACT_CONTENT_PACKAGE_MATCH",
      contentIdentityPolicyVersion:
        "product-truth-exact-content-identity-policy/1.0.0",
      identityQuality:
        "REJECT_EXPLICIT_UNCERTAINTY_AMBIGUOUS_SIZE_AND_INDIVIDUAL_VARIETY_PLACEHOLDERS",
      ordinaryRetailersOnly: true,
      clubsExcluded: true,
      bjsExcluded: true,
      ranking: [
        "IDENTITY_QUALITY_READY_FIRST",
        "IMMEDIATE_CLOSABLE_LISTINGS_DESC",
        "KNOWN_GMV_30D_DESC",
        "DEPENDENT_LISTINGS_DESC",
        "KNOWN_ORDERS_30D_DESC",
        "KNOWN_UNITS_30D_DESC",
        "EXISTING_EVIDENCE_LANE_ASC",
        "CANONICAL_VARIANT_ID_ASC",
      ],
    },
    counts: {
      denominatorListings: 7,
      missingListings: 7,
      missingListingsWithoutComponents: 0,
      missingListingsWithInvalidComponentGraph: 0,
      missingListingsWithAllCanonicalTargets: 7,
      componentUses: 7,
      canonicalComponentUses: 7,
      invalidComponentUses: 0,
      uniqueCanonicalTargets: targets.length,
      acquisitionReadyTargets: targets.length,
      identityRecoveryTargets: 0,
      acquisitionLaneCounts: [{
        lane: "PROVIDER_IDENTITY_ACQUISITION",
        count: targets.length,
      }],
    },
    projectedClosures: [],
    targets,
    invalidComponentDependencies: [],
    claims: {
      readOnlySources: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      existingCatalogScannedGlobally: true,
      legacyDonorLinkIsNotIdentityProof: true,
      oneResolvedComponentMayServeManyListings: true,
      createsAdditionalCatalog: false,
      authorizesExecution: false,
    },
  };
}

function capture(): ProductTruthProviderAttemptCapture {
  return {
    schemaVersion: PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION,
    capturedAt: "2026-07-30T04:55:00.000Z",
    databaseTargetFingerprint: FINGERPRINT,
    attempts: [
      {
        runId: "ptca-attempted-a",
        planSha256: "5".repeat(64),
        listingKey: "walmart:1:A1",
        itemStatus: "failed",
        stage: "EXECUTION_FAILED",
        finishedAt: "2026-07-30T04:40:00.000Z",
        providerCalls: 2,
        providerUnits: 3.5,
        targetCanonicalVariantIds: [],
      },
      {
        runId: "ptca-multi-target",
        planSha256: "6".repeat(64),
        listingKey: "walmart:1:CD",
        itemStatus: "terminal_gap",
        stage: "PRODUCT_TRUTH_TERMINAL_GAP",
        finishedAt: "2026-07-30T04:45:00.000Z",
        providerCalls: 1,
        providerUnits: 1,
        targetCanonicalVariantIds: [],
      },
    ],
    claims: {
      readOnlyDatabase: true,
      databaseWrites: 0,
      providerCalls: 0,
      marketplaceMutations: 0,
    },
  };
}

function compile() {
  const componentScope = scope();
  const componentScopeJson =
    renderProductTruthComponentAcquisitionScope(componentScope);
  const attemptCapture = capture();
  const attemptCaptureJson =
    renderProductTruthProviderAttemptCapture(attemptCapture);
  return compileProductTruthProviderTargetWave({
    waveId: "ptcw-20260730t050000z",
    generatedAt: GENERATED_AT,
    expiresAt: EXPIRES_AT,
    databaseTargetFingerprint: FINGERPRINT,
    authoritativeManifestSha256: MANIFEST_SHA,
    componentScope,
    componentScopeJson,
    componentScopeSha256: sha256(componentScopeJson),
    attemptCapture,
    attemptCaptureJson,
    attemptCaptureSha256: sha256(attemptCaptureJson),
    maximumTargets: 2,
  });
}

test("compiler selects one listing per unique target and excludes metered terminal attempts", () => {
  const wave = compile();
  assert.equal(wave.counts.providerTargets, 5);
  assert.equal(wave.counts.terminalAttemptTargets, 1);
  assert.equal(wave.counts.noSingleTargetRepresentative, 2);
  assert.equal(wave.counts.eligibleTargets, 2);
  assert.equal(wave.counts.selectedTargets, 2);
  assert.deepEqual(
    wave.targets.map((item) => item.canonicalVariantId),
    [variant("b"), variant("e")],
  );
  assert.equal(wave.targets[0]?.representative.listingKey, "walmart:1:B1");
  assert.equal(
    wave.targets[0]?.query,
    "Selected First Original 12 oz",
  );
  assert.deepEqual(
    wave.operationalRequest.listingKeys,
    ["walmart:1:B1", "amazon:1:E1"],
  );
  assert.deepEqual(
    wave.operationalRequest.sourcePolicy.retailers,
    ["walmart", "target", "publix"],
  );
  assert.deepEqual(wave.operationalRequest.providerCeilings, [
    {
      provider: "oxylabs",
      operations: ["query"],
      maxCalls: 2,
      maxUnits: 2,
      reserveFloor: null,
    },
    {
      provider: "unwrangle",
      operations: ["detail", "search"],
      maxCalls: 4,
      maxUnits: 10,
      reserveFloor: 15000,
    },
  ]);
  assert.equal(wave.operationalRequest.maxWallClockMs, 720000);
  assert.equal(wave.claims.authorizesExecution, false);
  assert.equal(wave.claims.providerCalls, 0);
});

test("multi-target listing attempts are not guessed onto either component", () => {
  const wave = compile();
  assert.deepEqual(
    wave.terminalAttemptTargets.map((item) => item.canonicalVariantId),
    [variant("a")],
  );
  assert.deepEqual(
    wave.targetsWithoutSingleTargetRepresentative.map(
      (item) => item.canonicalVariantId,
    ),
    [variant("c"), variant("d")],
  );
});

test("wave and request bytes are deterministic and fail closed on source drift", () => {
  const first = compile();
  const second = compile();
  assert.equal(
    renderProductTruthProviderTargetWave(first),
    renderProductTruthProviderTargetWave(second),
  );

  const componentScope = scope();
  const componentScopeJson =
    renderProductTruthComponentAcquisitionScope(componentScope);
  const attemptCapture = capture();
  const attemptCaptureJson =
    renderProductTruthProviderAttemptCapture(attemptCapture);
  assert.throws(
    () => compileProductTruthProviderTargetWave({
      waveId: "ptcw-20260730t050000z",
      generatedAt: GENERATED_AT,
      expiresAt: EXPIRES_AT,
      databaseTargetFingerprint: FINGERPRINT,
      authoritativeManifestSha256: MANIFEST_SHA,
      componentScope,
      componentScopeJson,
      componentScopeSha256: sha256(componentScopeJson),
      attemptCapture,
      attemptCaptureJson,
      attemptCaptureSha256: "0".repeat(64),
      maximumTargets: 2,
    }),
    (error: unknown) => (
      error instanceof ProductTruthProviderTargetWaveError
      && error.code === "PROVIDER_TARGET_WAVE_SOURCE_SHA_MISMATCH"
    ),
  );
});
