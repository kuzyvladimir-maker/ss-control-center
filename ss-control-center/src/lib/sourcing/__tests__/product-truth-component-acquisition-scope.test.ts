import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildCanonicalProductVariantKey,
} from "../canonical-product-variant";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  ProductTruthComponentAcquisitionScopeError,
  compileProductTruthComponentAcquisitionScope,
  renderProductTruthComponentAcquisitionScope,
} from "../product-truth-component-acquisition-scope";
import {
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScopeEntry,
} from "../product-truth-recipe-repair-scope";

const GENERATED_AT = "2026-07-30T03:00:00.000Z";
const CAPTURED_AT = "2026-07-30T02:00:00.000Z";
const TARGET_FINGERPRINT = "a".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function target(flavor: string) {
  const identity = {
    brand: "Acme",
    productLine: "Crunch",
    flavor,
    form: "bag",
    size: "8 oz",
    outerPackCount: 1,
  };
  const canonical = buildCanonicalProductVariantKey(identity);
  return {
    identity,
    canonicalVariantId: canonical.canonicalVariantId,
  };
}

const barbecue = target("Barbecue");
const ranch = target("Ranch");
const seaSalt = target("Sea Salt");
const cheddar = target("Cheddar");
const lime = target("Lime");
const uncertain = target("Unknown (not determinable)");
const conflictingVariant = target("Jalapeno");

function entry(input: {
  sku: string;
  target?: ReturnType<typeof target>;
  gmv?: number | null;
}): ProductTruthRecipeRepairScopeEntry {
  const listingKey = `walmart:1:${input.sku}`;
  return {
    ordinal: 0,
    repairPriority: 1,
    listingKey,
    channel: "walmart",
    storeIndex: 1,
    sku: input.sku,
    listingId: `item-${input.sku}`,
    listingTitle: `Listing ${input.sku}`,
    priorityGmv30d: input.gmv ?? null,
    priorityOrders30d: null,
    priorityUnits30d: null,
    recipeStatus: "MISSING",
    cogsOutcome: "MISSING",
    repairLane: input.target
      ? "RETAILER_IDENTITY_RESEARCH"
      : "COMPONENT_GRAPH_RECOVERY",
    bridgeDisposition: "QUARANTINE",
    bridgeBlockerCodes: input.target
      ? ["DONOR_TITLE_MATCH_REJECTED"]
      : ["TARGET_VARIANT_INVALID"],
    matcherReasonCodes: [],
    historicalEvidence: null,
    components: [{
      componentIndex: 0,
      quantity: 2,
      disposition: "QUARANTINE",
      identityProof: "NONE",
      targetIdentity: input.target?.identity ?? null,
      targetCanonicalVariantId: input.target?.canonicalVariantId ?? null,
      legacyComponentId: `component-${input.sku}`,
      legacyDonorProductId: null,
      candidateDonorProductId: null,
      matcherVerdict: null,
      matcherReasonCodes: [],
      blockerCodes: input.target
        ? ["DONOR_TITLE_MATCH_REJECTED"]
        : ["TARGET_VARIANT_INVALID"],
      candidateDonor: null,
    }],
  };
}

function noComponentEntry(): ProductTruthRecipeRepairScopeEntry {
  return {
    ...entry({ sku: "NO-COMPONENT" }),
    repairLane: "LISTING_IDENTITY_RECOVERY",
    bridgeBlockerCodes: ["PRODUCT_IDENTITY_MISSING"],
    components: [],
  };
}

function donor(
  id: string,
  flavor: string,
): ProductTruthLegacyBridgeDonorRow {
  return {
    id,
    brand: "Acme",
    productLine: null,
    flavor: null,
    containerType: "bag",
    size: "8 oz",
    category: "snacks",
    upc: null,
    gtin: null,
    title: `Acme Crunch ${flavor} 8 oz bag`,
    description: null,
    bullets: null,
    attributes: null,
    nutritionFacts: null,
    ingredients: null,
    mainImageUrl: null,
    imageUrls: null,
    identityKey: id,
    identityStatus: "legacy_unverified",
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  };
}

function offer(input: {
  id: string;
  donorProductId: string;
  retailer?: string;
}): ProductTruthLegacyBridgeOfferRow {
  const retailer = input.retailer ?? "walmart";
  return {
    id: input.id,
    donorProductId: input.donorProductId,
    retailer,
    retailerProductId: `${retailer}-${input.donorProductId}`,
    via: "direct",
    price: 3.99,
    packSizeSeen: 1,
    pricePerUnit: 3.99,
    currency: "USD",
    zip: "33765",
    localityEvidence: "zip_scoped",
    inStock: true,
    productUrl:
      `https://www.example.test/${retailer}/${input.donorProductId}`,
    isFirstParty: true,
    sourceApi: "fixture",
    fetchedAt: CAPTURED_AT,
  };
}

function fixture() {
  const entries = [
    entry({ sku: "BBQ-1", target: barbecue }),
    entry({ sku: "BBQ-2", target: barbecue }),
    entry({ sku: "RANCH", target: ranch, gmv: 100 }),
    entry({ sku: "SEA-SALT", target: seaSalt }),
    entry({ sku: "CHEDDAR", target: cheddar }),
    entry({ sku: "LIME", target: lime }),
    entry({ sku: "UNCERTAIN", target: uncertain }),
    noComponentEntry(),
    entry({ sku: "INVALID" }),
  ];
  const snapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: "b".repeat(64),
      asOf: CAPTURED_AT,
      listingCount: entries.length,
    },
    listings: [],
    components: [],
    donors: [
      donor("donor-barbecue", "Barbecue"),
      donor("donor-ranch", "Ranch"),
      donor("donor-cheddar-a", "Cheddar"),
      donor("donor-cheddar-b", "Cheddar"),
      donor("donor-lime", "Lime"),
    ],
    offers: [
      offer({ id: "offer-barbecue", donorProductId: "donor-barbecue" }),
      offer({
        id: "offer-barbecue-club",
        donorProductId: "donor-barbecue",
        retailer: "bjs",
      }),
    ],
    canonicalDonorBindings: [
      {
        donorProductId: "donor-ranch",
        canonicalVariantId: ranch.canonicalVariantId,
        canonicalIdentityJson: buildCanonicalProductVariantKey(
          ranch.identity,
        ).identityJson,
        decisionId: "decision-ranch",
        decisionStatus: "exact_confirmed",
        decidedAt: CAPTURED_AT,
      },
      {
        donorProductId: "donor-lime",
        canonicalVariantId: conflictingVariant.canonicalVariantId,
        canonicalIdentityJson: buildCanonicalProductVariantKey(
          conflictingVariant.identity,
        ).identityJson,
        decisionId: "decision-lime-conflict",
        decisionStatus: "exact_confirmed",
        decidedAt: CAPTURED_AT,
      },
    ],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [],
    bundleFactoryRecipeEvidence: [],
  } satisfies ProductTruthLegacyBridgeSnapshot;
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = sha256(snapshotJson);
  const scope = {
    schemaVersion: PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
    generatedAt: CAPTURED_AT,
    source: {
      manifest: {
        schemaVersion: "phase1-authoritative-scope-manifest/v3",
        sha256: "b".repeat(64),
        asOf: CAPTURED_AT,
        listingCount: entries.length,
      },
      legacyImageState: {
        sha256: "c".repeat(64),
        entryCount: 0,
      },
      bridgeSnapshot: {
        schemaVersion: snapshot.schemaVersion,
        sha256: snapshotSha256,
        capturedAt: snapshot.capturedAt,
      },
      bridgePlan: {
        schemaVersion: "product-truth-legacy-bridge-plan/1.9.0",
        sha256: "d".repeat(64),
        generatedAt: CAPTURED_AT,
      },
      readiness: {
        schemaVersion: "product-truth-consumer-readiness/1.0.0",
        sha256: "e".repeat(64),
        asOf: CAPTURED_AT,
      },
      targetFingerprint: TARGET_FINGERPRINT,
    },
    counts: {
      denominator: entries.length,
    },
    entries,
  } as unknown as ProductTruthRecipeRepairScope;
  const scopeJson = renderProductTruthRecipeRepairScope(scope);
  return {
    scope,
    scopeJson,
    scopeSha256: sha256(scopeJson),
    snapshot,
    snapshotJson,
    snapshotSha256,
  };
}

function rebindFixtureSources(input: ReturnType<typeof fixture>) {
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(input.snapshot);
  const snapshotSha256 = sha256(snapshotJson);
  const scope = {
    ...input.scope,
    source: {
      ...input.scope.source,
      bridgeSnapshot: {
        ...input.scope.source.bridgeSnapshot,
        sha256: snapshotSha256,
      },
    },
  };
  const scopeJson = renderProductTruthRecipeRepairScope(scope);
  return {
    ...input,
    scope,
    scopeJson,
    scopeSha256: sha256(scopeJson),
    snapshotJson,
    snapshotSha256,
  };
}

function compileFixture(input: ReturnType<typeof fixture>) {
  return compileProductTruthComponentAcquisitionScope({
    generatedAt: GENERATED_AT,
    recipeRepairScope: input.scope,
    recipeRepairScopeJson: input.scopeJson,
    recipeRepairScopeSha256: input.scopeSha256,
    bridgeSnapshot: input.snapshot,
    bridgeSnapshotJson: input.snapshotJson,
    bridgeSnapshotSha256: input.snapshotSha256,
  });
}

test("component acquisition scope deduplicates variants and ranks downstream closure", () => {
  const input = fixture();
  const report = compileFixture(input);
  assert.equal(report.counts.denominatorListings, 9);
  assert.equal(report.counts.missingListings, 9);
  assert.equal(report.counts.missingListingsWithoutComponents, 1);
  assert.equal(report.counts.missingListingsWithInvalidComponentGraph, 1);
  assert.equal(report.counts.missingListingsWithAllCanonicalTargets, 7);
  assert.equal(report.counts.componentUses, 8);
  assert.equal(report.counts.canonicalComponentUses, 7);
  assert.equal(report.counts.invalidComponentUses, 1);
  assert.equal(report.counts.uniqueCanonicalTargets, 6);
  assert.equal(report.counts.acquisitionReadyTargets, 5);
  assert.equal(report.counts.identityRecoveryTargets, 1);
  assert.deepEqual(
    Object.fromEntries(
      report.counts.acquisitionLaneCounts.map((entry) => [
        entry.lane,
        entry.count,
      ]),
    ),
    {
      EXISTING_CANONICAL_BINDING: 1,
      EXISTING_CATALOG_EXACT_CANDIDATE: 1,
      PROVIDER_IDENTITY_ACQUISITION: 1,
      EXISTING_CATALOG_AMBIGUOUS: 1,
      CANONICAL_DONOR_CONFLICT: 1,
      TARGET_IDENTITY_RECOVERY_REQUIRED: 1,
    },
  );
  assert.equal(report.targets[0]?.canonicalVariantId, barbecue.canonicalVariantId);
  assert.equal(report.targets[0]?.impact.immediateClosableListings, 2);
  assert.equal(report.targets[0]?.impact.dependentListings, 2);
  assert.equal(
    report.targets[0]?.exactCatalogCandidates[0]
      ?.ordinaryFirstPartyOffers.length,
    1,
  );
  assert.equal(
    report.targets.find(
      (value) => value.canonicalVariantId === seaSalt.canonicalVariantId,
    )?.acquisitionLane,
    "PROVIDER_IDENTITY_ACQUISITION",
  );
  assert.equal(
    report.targets.find(
      (value) => value.canonicalVariantId === uncertain.canonicalVariantId,
    )?.identityQuality.status,
    "IDENTITY_RECOVERY_REQUIRED",
  );
  assert.equal(report.projectedClosures.at(-1)?.fullyCoveredListings, 6);
  assert.equal(
    renderProductTruthComponentAcquisitionScope(report),
    renderProductTruthComponentAcquisitionScope(report),
  );
});

test("same-unit package-size drift cannot become an exact content donor", () => {
  const raw = fixture();
  raw.snapshot.donors[0] = {
    ...raw.snapshot.donors[0]!,
    size: "8.05 oz",
    title: "Acme Crunch Barbecue 8.05 oz bag",
  };
  const input = rebindFixtureSources(raw);
  const report = compileFixture(input);
  assert.equal(
    report.targets.find(
      (value) => value.canonicalVariantId === barbecue.canonicalVariantId,
    )?.acquisitionLane,
    "PROVIDER_IDENTITY_ACQUISITION",
  );
});

test("one legacy donor proposed for two canonical variants is quarantined before planning", () => {
  const raw = fixture();
  const aliasIdentity = {
    ...barbecue.identity,
    productLine: "Crunch Barbecue",
  };
  const aliasVariant =
    buildCanonicalProductVariantKey(aliasIdentity).canonicalVariantId;
  raw.scope.entries.push({
    ...entry({
      sku: "BBQ-ALIAS",
      target: {
        identity: aliasIdentity,
        canonicalVariantId: aliasVariant,
      },
    }),
    ordinal: raw.scope.entries.length,
  });
  raw.scope.counts.denominator += 1;
  const input = rebindFixtureSources(raw);
  const report = compileFixture(input);
  assert.equal(
    report.targets.find(
      (value) => value.canonicalVariantId === barbecue.canonicalVariantId,
    )?.acquisitionLane,
    "CANONICAL_DONOR_CONFLICT",
  );
  assert.equal(
    report.targets.find(
      (value) => value.canonicalVariantId === aliasVariant,
    )?.acquisitionLane,
    "CANONICAL_DONOR_CONFLICT",
  );
});

test("component acquisition scope rejects source-byte drift", () => {
  const input = fixture();
  assert.throws(
    () =>
      compileProductTruthComponentAcquisitionScope({
        generatedAt: GENERATED_AT,
        recipeRepairScope: input.scope,
        recipeRepairScopeJson: `${input.scopeJson}\n`,
        recipeRepairScopeSha256: input.scopeSha256,
        bridgeSnapshot: input.snapshot,
        bridgeSnapshotJson: input.snapshotJson,
        bridgeSnapshotSha256: input.snapshotSha256,
      }),
    (error: unknown) =>
      error instanceof ProductTruthComponentAcquisitionScopeError
      && error.code === "COMPONENT_ACQUISITION_SOURCE_HASH_MISMATCH",
  );
});
