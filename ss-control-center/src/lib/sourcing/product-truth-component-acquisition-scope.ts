import { createHash } from "node:crypto";

import {
  buildCanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  normalizeIdentityTokens,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  EXACT_CONTENT_IDENTITY_POLICY_VERSION,
} from "./exact-content-identity-policy";
import {
  LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
  evaluateLegacyCatalogRecoveryIdentity,
  type LegacyCatalogRecoveryIdentityDecision,
} from "./legacy-catalog-recovery-identity";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeCanonicalDonorBindingRow,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
  renderProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScope,
  type ProductTruthRecipeRepairScopeEntry,
} from "./product-truth-recipe-repair-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION =
  "product-truth-component-acquisition-scope/1.4.0" as const;

export type ProductTruthComponentAcquisitionLane =
  | "EXISTING_CANONICAL_BINDING"
  | "EXISTING_CATALOG_EXACT_CANDIDATE"
  | "PROVIDER_IDENTITY_ACQUISITION"
  | "EXISTING_CATALOG_AMBIGUOUS"
  | "CANONICAL_DONOR_CONFLICT"
  | "TARGET_IDENTITY_RECOVERY_REQUIRED";

export interface ProductTruthComponentAcquisitionDependency {
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  componentIndex: number;
  quantity: number;
  repairLane: ProductTruthRecipeRepairScopeEntry["repairLane"];
  legacyComponentId: string | null;
  legacyDonorProductId: string | null;
  historicalEvidence: {
    status: string;
    rowSha256: string;
  } | null;
  priority: {
    gmv30d: number | null;
    orders30d: number | null;
    units30d: number | null;
    repairPriority: number | null;
  };
}

export interface ProductTruthComponentAcquisitionCandidate {
  donorProductId: string;
  title: string;
  brand: string;
  size: string | null;
  upc: string | null;
  gtin: string | null;
  ordinaryFirstPartyOffers: Array<{
    offerId: string;
    retailer: string;
    retailerProductId: string;
    productUrl: string;
  }>;
  canonicalBindings: ProductTruthLegacyBridgeCanonicalDonorBindingRow[];
  identityDecision: LegacyCatalogRecoveryIdentityDecision;
}

export interface ProductTruthComponentAcquisitionTarget {
  ordinal: number;
  acquisitionPriority: number;
  canonicalVariantId: string;
  canonicalIdentityHash: string;
  canonicalIdentityJson: string;
  targetIdentity: CanonicalProductIdentity;
  identityQuality: {
    status: "ACQUISITION_READY" | "IDENTITY_RECOVERY_REQUIRED";
    blockerCodes: string[];
  };
  acquisitionLane: ProductTruthComponentAcquisitionLane;
  exactCatalogCandidates: ProductTruthComponentAcquisitionCandidate[];
  impact: {
    componentUses: number;
    dependentListings: number;
    immediateClosableListings: number;
    amazonListings: number;
    walmartListings: number;
    knownGmv30d: number;
    knownOrders30d: number;
    knownUnits30d: number;
  };
  dependencies: ProductTruthComponentAcquisitionDependency[];
}

export interface ProductTruthComponentAcquisitionScope {
  schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION;
  generatedAt: string;
  source: {
    recipeRepairScope: {
      schemaVersion: typeof PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION;
      sha256: string;
      generatedAt: string;
      missingListings: number;
    };
    bridgeSnapshot: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
      sha256: string;
      capturedAt: string;
      targetFingerprint: string;
      donorCount: number;
      offerCount: number;
      canonicalBindingCount: number;
    };
  };
  matcher: {
    version: typeof CANONICAL_PRODUCT_MATCHER_VERSION;
    implementationSha256: typeof CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256;
    releaseSha256: typeof CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256;
  };
  selectionPolicy: {
    unitOfWork: "UNIQUE_CANONICAL_COMPONENT_VARIANT";
    catalogSearch:
      "ALL_EXISTING_DONORS_TARGET_BRAND_PHRASE_STRICT_RECOVERY_AND_EXACT_CONTENT_PACKAGE_MATCH";
    contentIdentityPolicyVersion:
      typeof EXACT_CONTENT_IDENTITY_POLICY_VERSION;
    legacyCatalogRecoveryIdentityPolicyVersion:
      typeof LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION;
    identityQuality:
      "REJECT_EXPLICIT_UNCERTAINTY_AMBIGUOUS_SIZE_AND_INDIVIDUAL_VARIETY_PLACEHOLDERS";
    ordinaryRetailersOnly: true;
    clubsExcluded: true;
    bjsExcluded: true;
    ranking: readonly [
      "IDENTITY_QUALITY_READY_FIRST",
      "IMMEDIATE_CLOSABLE_LISTINGS_DESC",
      "KNOWN_GMV_30D_DESC",
      "DEPENDENT_LISTINGS_DESC",
      "KNOWN_ORDERS_30D_DESC",
      "KNOWN_UNITS_30D_DESC",
      "EXISTING_EVIDENCE_LANE_ASC",
      "CANONICAL_VARIANT_ID_ASC",
    ];
  };
  counts: {
    denominatorListings: number;
    missingListings: number;
    missingListingsWithoutComponents: number;
    missingListingsWithInvalidComponentGraph: number;
    missingListingsWithAllCanonicalTargets: number;
    componentUses: number;
    canonicalComponentUses: number;
    invalidComponentUses: number;
    uniqueCanonicalTargets: number;
    acquisitionReadyTargets: number;
    identityRecoveryTargets: number;
    acquisitionLaneCounts: Array<{
      lane: ProductTruthComponentAcquisitionLane;
      count: number;
    }>;
  };
  projectedClosures: Array<{
    topTargets: number;
    fullyCoveredListings: number;
  }>;
  targets: ProductTruthComponentAcquisitionTarget[];
  invalidComponentDependencies: Array<{
    listingKey: string;
    componentIndex: number;
    blockerCodes: string[];
  }>;
  claims: {
    readOnlySources: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    createsAdditionalCatalog: false;
    existingCatalogScannedGlobally: true;
    legacyDonorLinkIsNotIdentityProof: true;
    oneResolvedComponentMayServeManyListings: true;
  };
}

export class ProductTruthComponentAcquisitionScopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthComponentAcquisitionScopeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthComponentAcquisitionScopeError(code, message);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (
    !value
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail("COMPONENT_ACQUISITION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function exactSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("COMPONENT_ACQUISITION_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function assertBoundCanonicalJson(input: {
  label: string;
  json: string;
  expectedSha256: string;
  canonicalJson: string;
}): void {
  const expected = exactSha256(
    input.expectedSha256,
    `${input.label}.sha256`,
  );
  const actual = sha256Text(input.json);
  if (actual !== expected) {
    fail(
      "COMPONENT_ACQUISITION_SOURCE_HASH_MISMATCH",
      `${input.label} ${actual} != ${expected}`,
    );
  }
  if (input.json !== input.canonicalJson) {
    fail(
      "COMPONENT_ACQUISITION_SOURCE_NOT_CANONICAL",
      `${input.label} bytes are not canonical`,
    );
  }
}

function uniqueMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      fail("COMPONENT_ACQUISITION_SOURCE_DUPLICATE", `${label} ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
}

function finiteOrZero(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function isOrdinaryRetailer(retailer: string): boolean {
  const normalized = normalizeIdentityTokens(retailer).join(" ");
  return ![
    "bjs",
    "bjs wholesale club",
    "costco",
    "sams",
    "sams club",
  ].includes(normalized);
}

function ordinaryOffers(
  donorProductId: string,
  offersByDonor: ReadonlyMap<string, ProductTruthLegacyBridgeOfferRow[]>,
): ProductTruthComponentAcquisitionCandidate["ordinaryFirstPartyOffers"] {
  return (offersByDonor.get(donorProductId) ?? [])
    .filter(
      (offer) =>
        offer.isFirstParty
        && offer.via === "direct"
        && Boolean(offer.productUrl)
        && isOrdinaryRetailer(offer.retailer),
    )
    .map((offer) => ({
      offerId: offer.id,
      retailer: offer.retailer,
      retailerProductId: offer.retailerProductId,
      productUrl: String(offer.productUrl),
    }))
    .sort(
      (left, right) =>
        left.retailer.localeCompare(right.retailer, "en-US")
        || left.retailerProductId.localeCompare(
          right.retailerProductId,
          "en-US",
        )
        || left.offerId.localeCompare(right.offerId, "en-US"),
    );
}

function catalogCandidate(input: {
  donor: ProductTruthLegacyBridgeDonorRow;
  identityDecision: LegacyCatalogRecoveryIdentityDecision;
  offersByDonor: ReadonlyMap<string, ProductTruthLegacyBridgeOfferRow[]>;
  bindingsByDonor: ReadonlyMap<
    string,
    ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >;
}): ProductTruthComponentAcquisitionCandidate {
  if (!input.donor.title || !input.donor.brand) {
    fail(
      "COMPONENT_ACQUISITION_SOURCE_CONTRADICTION",
      `matched donor ${input.donor.id} lacks title or brand`,
    );
  }
  return {
    donorProductId: input.donor.id,
    title: input.donor.title,
    brand: input.donor.brand,
    size: input.donor.size,
    upc: input.donor.upc,
    gtin: input.donor.gtin,
    ordinaryFirstPartyOffers: ordinaryOffers(
      input.donor.id,
      input.offersByDonor,
    ),
    canonicalBindings: [...(input.bindingsByDonor.get(input.donor.id) ?? [])]
      .sort((left, right) =>
        left.canonicalVariantId.localeCompare(
          right.canonicalVariantId,
          "en-US",
        )),
    identityDecision: input.identityDecision,
  };
}

function classifyAcquisitionLane(input: {
  canonicalVariantId: string;
  identityQualityBlockers: readonly string[];
  candidates: readonly ProductTruthComponentAcquisitionCandidate[];
  bindingsByVariant: ReadonlyMap<
    string,
    ProductTruthLegacyBridgeCanonicalDonorBindingRow[]
  >;
}): ProductTruthComponentAcquisitionLane {
  if (input.identityQualityBlockers.length > 0) {
    return "TARGET_IDENTITY_RECOVERY_REQUIRED";
  }
  const exactBindings =
    input.bindingsByVariant.get(input.canonicalVariantId) ?? [];
  if (exactBindings.length > 0) return "EXISTING_CANONICAL_BINDING";
  if (input.candidates.length === 0) return "PROVIDER_IDENTITY_ACQUISITION";
  if (input.candidates.length > 1) return "EXISTING_CATALOG_AMBIGUOUS";
  const candidate = input.candidates[0]!;
  if (
    candidate.canonicalBindings.some(
      (binding) =>
        binding.canonicalVariantId !== input.canonicalVariantId,
    )
  ) {
    return "CANONICAL_DONOR_CONFLICT";
  }
  return "EXISTING_CATALOG_EXACT_CANDIDATE";
}

const ACQUISITION_LANE_ORDER: Record<
  ProductTruthComponentAcquisitionLane,
  number
> = {
  EXISTING_CANONICAL_BINDING: 0,
  EXISTING_CATALOG_EXACT_CANDIDATE: 1,
  PROVIDER_IDENTITY_ACQUISITION: 2,
  EXISTING_CATALOG_AMBIGUOUS: 3,
  CANONICAL_DONOR_CONFLICT: 4,
  TARGET_IDENTITY_RECOVERY_REQUIRED: 5,
};

function identityQualityBlockers(
  identity: CanonicalProductIdentity,
): string[] {
  const blockers: string[] = [];
  const identityText = [
    identity.brand,
    identity.productLine,
    identity.flavor,
    identity.form,
  ].filter((value): value is string =>
    typeof value === "string" && Boolean(value.trim()))
    .join(" ")
    .toLowerCase();
  if (
    /\b(?:unknown|unspecified|not\s+determinable|not\s+confirmed|likely)\b/u
      .test(identityText)
  ) {
    blockers.push("TARGET_IDENTITY_EXPLICITLY_UNCERTAIN");
  }
  const size = String(identity.size ?? "").trim().toLowerCase();
  if (
    /[~≈]/u.test(size)
    || /\b(?:approx(?:imately)?|actual\s+weight|may\s+vary|per\s+(?:box|bag|can|bottle|cup|pack|packet|pouch|tray|unit))\b/u
      .test(size)
    || /\d(?:\.\d+)?\s*[–—-]\s*\d/u.test(size)
  ) {
    blockers.push("TARGET_SIZE_EXPLICITLY_AMBIGUOUS");
  }
  const flavorTokens = normalizeIdentityTokens(identity.flavor);
  const formTokens = normalizeIdentityTokens(identity.form);
  if (
    flavorTokens.includes("variety")
    && formTokens.some((token) =>
      ["bottle", "can", "cup", "jar", "loaf", "tray"].includes(token))
  ) {
    blockers.push("TARGET_VARIETY_PLACEHOLDER_IS_NOT_ONE_SELLABLE_VARIANT");
  }
  return uniqueSorted(blockers);
}

function compareTargetPriority(
  left: ProductTruthComponentAcquisitionTarget,
  right: ProductTruthComponentAcquisitionTarget,
): number {
  return (
    Number(right.identityQuality.status === "ACQUISITION_READY")
      - Number(left.identityQuality.status === "ACQUISITION_READY")
    || right.impact.immediateClosableListings
      - left.impact.immediateClosableListings
    || right.impact.knownGmv30d - left.impact.knownGmv30d
    || right.impact.dependentListings - left.impact.dependentListings
    || right.impact.knownOrders30d - left.impact.knownOrders30d
    || right.impact.knownUnits30d - left.impact.knownUnits30d
    || ACQUISITION_LANE_ORDER[left.acquisitionLane]
      - ACQUISITION_LANE_ORDER[right.acquisitionLane]
    || left.canonicalVariantId.localeCompare(
      right.canonicalVariantId,
      "en-US",
    )
  );
}

function dependencyKey(
  value: ProductTruthComponentAcquisitionDependency,
): string {
  return `${value.listingKey}:${String(value.componentIndex).padStart(6, "0")}`;
}

function assertCanonicalTargetIdentity(input: {
  listingKey: string;
  componentIndex: number;
  canonicalVariantId: string;
  targetIdentity: CanonicalProductIdentity;
}): ReturnType<typeof buildCanonicalProductVariantKey> {
  let canonical: ReturnType<typeof buildCanonicalProductVariantKey>;
  try {
    canonical = buildCanonicalProductVariantKey(input.targetIdentity);
  } catch (error) {
    fail(
      "COMPONENT_ACQUISITION_TARGET_IDENTITY_INVALID",
      `${input.listingKey}:${input.componentIndex} ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (canonical.canonicalVariantId !== input.canonicalVariantId) {
    fail(
      "COMPONENT_ACQUISITION_TARGET_VARIANT_DRIFT",
      `${input.listingKey}:${input.componentIndex} `
        + `${canonical.canonicalVariantId} != ${input.canonicalVariantId}`,
    );
  }
  return canonical;
}

export function compileProductTruthComponentAcquisitionScope(input: {
  generatedAt: string;
  recipeRepairScope: ProductTruthRecipeRepairScope;
  recipeRepairScopeJson: string;
  recipeRepairScopeSha256: string;
  bridgeSnapshot: ProductTruthLegacyBridgeSnapshot;
  bridgeSnapshotJson: string;
  bridgeSnapshotSha256: string;
}): ProductTruthComponentAcquisitionScope {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  if (
    input.recipeRepairScope.schemaVersion
      !== PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION
    || input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
  ) {
    fail(
      "COMPONENT_ACQUISITION_SOURCE_VERSION_MISMATCH",
      "recipe repair scope or bridge snapshot version changed",
    );
  }
  assertBoundCanonicalJson({
    label: "recipeRepairScope",
    json: input.recipeRepairScopeJson,
    expectedSha256: input.recipeRepairScopeSha256,
    canonicalJson: renderProductTruthRecipeRepairScope(
      input.recipeRepairScope,
    ),
  });
  assertBoundCanonicalJson({
    label: "bridgeSnapshot",
    json: input.bridgeSnapshotJson,
    expectedSha256: input.bridgeSnapshotSha256,
    canonicalJson: renderProductTruthLegacyBridgeSnapshot(
      input.bridgeSnapshot,
    ),
  });
  if (
    input.recipeRepairScope.source.bridgeSnapshot.sha256
      !== input.bridgeSnapshotSha256
    || input.recipeRepairScope.source.bridgeSnapshot.capturedAt
      !== input.bridgeSnapshot.capturedAt
    || input.recipeRepairScope.source.targetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
  ) {
    fail(
      "COMPONENT_ACQUISITION_SOURCE_BINDING_MISMATCH",
      "recipe repair scope does not bind the exact bridge snapshot",
    );
  }

  const donorById = uniqueMap(
    input.bridgeSnapshot.donors,
    (donor) => donor.id,
    "donor",
  );
  type CatalogIdentityDonor = ProductTruthLegacyBridgeDonorRow & {
    title: string;
    brand: string;
  };
  const donorTitleTokensById = new Map<string, Set<string>>();
  const donorsByTitleToken = new Map<string, CatalogIdentityDonor[]>();
  for (const donor of donorById.values()) {
    if (!donor.title || !donor.brand) continue;
    const identityDonor: CatalogIdentityDonor = {
      ...donor,
      title: donor.title,
      brand: donor.brand,
    };
    const titleTokens = new Set(normalizeIdentityTokens(identityDonor.title));
    donorTitleTokensById.set(identityDonor.id, titleTokens);
    for (const token of titleTokens) {
      const donors = donorsByTitleToken.get(token) ?? [];
      donors.push(identityDonor);
      donorsByTitleToken.set(token, donors);
    }
  }
  for (const donors of donorsByTitleToken.values()) {
    donors.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  }

  uniqueMap(
    input.bridgeSnapshot.offers,
    (offer) => offer.id,
    "offer",
  );
  const offersByDonor =
    new Map<string, ProductTruthLegacyBridgeOfferRow[]>();
  for (const offer of input.bridgeSnapshot.offers) {
    if (!donorById.has(offer.donorProductId)) {
      fail(
        "COMPONENT_ACQUISITION_SOURCE_CONTRADICTION",
        `offer ${offer.id} references missing donor ${offer.donorProductId}`,
      );
    }
    const offers = offersByDonor.get(offer.donorProductId) ?? [];
    offers.push(offer);
    offersByDonor.set(offer.donorProductId, offers);
  }

  const bindingsByDonor =
    new Map<string, ProductTruthLegacyBridgeCanonicalDonorBindingRow[]>();
  const bindingsByVariant =
    new Map<string, ProductTruthLegacyBridgeCanonicalDonorBindingRow[]>();
  const bindingIds = new Set<string>();
  for (const binding of input.bridgeSnapshot.canonicalDonorBindings) {
    if (
      !donorById.has(binding.donorProductId)
      || binding.decisionStatus !== "exact_confirmed"
      || bindingIds.has(binding.decisionId)
    ) {
      fail(
        "COMPONENT_ACQUISITION_SOURCE_CONTRADICTION",
        `canonical binding ${binding.decisionId} is invalid`,
      );
    }
    bindingIds.add(binding.decisionId);
    const donorBindings = bindingsByDonor.get(binding.donorProductId) ?? [];
    donorBindings.push(binding);
    bindingsByDonor.set(binding.donorProductId, donorBindings);
    const variantBindings =
      bindingsByVariant.get(binding.canonicalVariantId) ?? [];
    variantBindings.push(binding);
    bindingsByVariant.set(binding.canonicalVariantId, variantBindings);
  }

  const missingEntries = input.recipeRepairScope.entries.filter(
    (entry) => entry.recipeStatus === "MISSING",
  );
  const missingWithoutComponents = missingEntries.filter(
    (entry) => entry.components.length === 0,
  );
  const validListingTargetIds = new Map<string, Set<string>>();
  const invalidComponentDependencies: ProductTruthComponentAcquisitionScope[
    "invalidComponentDependencies"
  ] = [];
  const grouped = new Map<string, {
    targetIdentity: CanonicalProductIdentity;
    canonicalIdentityHash: string;
    canonicalIdentityJson: string;
    dependencies: ProductTruthComponentAcquisitionDependency[];
  }>();
  let componentUses = 0;
  let canonicalComponentUses = 0;

  for (const entry of missingEntries) {
    const componentIndexes = new Set<number>();
    let entryValid = entry.components.length > 0;
    const targetIds = new Set<string>();
    for (const component of entry.components) {
      componentUses += 1;
      if (componentIndexes.has(component.componentIndex)) {
        fail(
          "COMPONENT_ACQUISITION_COMPONENT_DUPLICATE",
          `${entry.listingKey}:${component.componentIndex}`,
        );
      }
      componentIndexes.add(component.componentIndex);
      if (
        !component.targetIdentity
        || !component.targetCanonicalVariantId
      ) {
        entryValid = false;
        invalidComponentDependencies.push({
          listingKey: entry.listingKey,
          componentIndex: component.componentIndex,
          blockerCodes: uniqueSorted(component.blockerCodes),
        });
        continue;
      }
      canonicalComponentUses += 1;
      const canonical = assertCanonicalTargetIdentity({
        listingKey: entry.listingKey,
        componentIndex: component.componentIndex,
        canonicalVariantId: component.targetCanonicalVariantId,
        targetIdentity: component.targetIdentity,
      });
      targetIds.add(component.targetCanonicalVariantId);
      const existing = grouped.get(component.targetCanonicalVariantId);
      if (
        existing
        && existing.canonicalIdentityJson !== canonical.identityJson
      ) {
        fail(
          "COMPONENT_ACQUISITION_TARGET_COLLISION",
          component.targetCanonicalVariantId,
        );
      }
      const dependency: ProductTruthComponentAcquisitionDependency = {
        listingKey: entry.listingKey,
        channel: entry.channel,
        storeIndex: entry.storeIndex,
        sku: entry.sku,
        componentIndex: component.componentIndex,
        quantity: component.quantity,
        repairLane: entry.repairLane,
        legacyComponentId: component.legacyComponentId,
        legacyDonorProductId: component.legacyDonorProductId,
        historicalEvidence: entry.historicalEvidence
          ? {
              status: entry.historicalEvidence.status,
              rowSha256: entry.historicalEvidence.rowSha256,
            }
          : null,
        priority: {
          gmv30d: entry.priorityGmv30d,
          orders30d: entry.priorityOrders30d,
          units30d: entry.priorityUnits30d,
          repairPriority: entry.repairPriority,
        },
      };
      const current = existing ?? {
        targetIdentity: component.targetIdentity,
        canonicalIdentityHash: canonical.identityHash,
        canonicalIdentityJson: canonical.identityJson,
        dependencies: [],
      };
      current.dependencies.push(dependency);
      grouped.set(component.targetCanonicalVariantId, current);
    }
    if (entryValid) validListingTargetIds.set(entry.listingKey, targetIds);
  }

  const targets: ProductTruthComponentAcquisitionTarget[] = [];
  for (const [canonicalVariantId, value] of grouped) {
    value.dependencies.sort((left, right) =>
      dependencyKey(left).localeCompare(dependencyKey(right), "en-US"),
    );
    const targetBrandTokens = normalizeIdentityTokens(
      value.targetIdentity.brand,
    );
    const titleIndexedDonors = targetBrandTokens.length
      ? [...targetBrandTokens]
        .map((token) => donorsByTitleToken.get(token) ?? [])
        .sort((left, right) => left.length - right.length)[0]!
        .filter((donor) => {
          const titleTokens = donorTitleTokensById.get(donor.id);
          return targetBrandTokens.every((token) => titleTokens?.has(token));
        })
      : [];
    const exactCatalogCandidates =
      titleIndexedDonors
        .map((donor) => ({
          donor,
          identityDecision: evaluateLegacyCatalogRecoveryIdentity({
            target: value.targetIdentity,
            donor,
          }),
        }))
        .filter(({ identityDecision }) => identityDecision.eligible)
        .map(({ donor, identityDecision }) =>
          catalogCandidate({
            donor,
            identityDecision,
            offersByDonor,
            bindingsByDonor,
          }))
        .sort((left, right) =>
          left.donorProductId.localeCompare(right.donorProductId, "en-US"));
    const qualityBlockers = identityQualityBlockers(value.targetIdentity);
    const dependentListingKeys =
      uniqueSorted(value.dependencies.map((entry) => entry.listingKey));
    const immediateClosableListings = dependentListingKeys.filter(
      (listingKey) => {
        const targetsForListing = validListingTargetIds.get(listingKey);
        return (
          targetsForListing?.size === 1
          && targetsForListing.has(canonicalVariantId)
        );
      },
    ).length;
    const knownListingPriority = new Map<string, {
      gmv: number;
      orders: number;
      units: number;
    }>();
    for (const dependency of value.dependencies) {
      if (!knownListingPriority.has(dependency.listingKey)) {
        knownListingPriority.set(dependency.listingKey, {
          gmv: finiteOrZero(dependency.priority.gmv30d),
          orders: finiteOrZero(dependency.priority.orders30d),
          units: finiteOrZero(dependency.priority.units30d),
        });
      }
    }
    const impact = [...knownListingPriority.values()].reduce(
      (result, priority) => ({
        gmv: result.gmv + priority.gmv,
        orders: result.orders + priority.orders,
        units: result.units + priority.units,
      }),
      { gmv: 0, orders: 0, units: 0 },
    );
    targets.push({
      ordinal: -1,
      acquisitionPriority: -1,
      canonicalVariantId,
      canonicalIdentityHash: value.canonicalIdentityHash,
      canonicalIdentityJson: value.canonicalIdentityJson,
      targetIdentity: value.targetIdentity,
      identityQuality: {
        status: qualityBlockers.length > 0
          ? "IDENTITY_RECOVERY_REQUIRED"
          : "ACQUISITION_READY",
        blockerCodes: qualityBlockers,
      },
      acquisitionLane: classifyAcquisitionLane({
        canonicalVariantId,
        identityQualityBlockers: qualityBlockers,
        candidates: exactCatalogCandidates,
        bindingsByVariant,
      }),
      exactCatalogCandidates,
      impact: {
        componentUses: value.dependencies.length,
        dependentListings: dependentListingKeys.length,
        immediateClosableListings,
        amazonListings: uniqueSorted(
          value.dependencies
            .filter((entry) => entry.channel === "amazon")
            .map((entry) => entry.listingKey),
        ).length,
        walmartListings: uniqueSorted(
          value.dependencies
            .filter((entry) => entry.channel === "walmart")
            .map((entry) => entry.listingKey),
        ).length,
        knownGmv30d: impact.gmv,
        knownOrders30d: impact.orders,
        knownUnits30d: impact.units,
      },
      dependencies: value.dependencies,
    });
  }

  // One DonorProduct may prove only one exact canonical variant. A per-target
  // scan can otherwise select the same legacy donor for two near-duplicate
  // target identities and defer the collision until the database unique index.
  // Classify the entire donor group as a conflict before any plan can be built.
  const proposedTargetsByDonor = new Map<
    string,
    ProductTruthComponentAcquisitionTarget[]
  >();
  for (const target of targets) {
    if (
      target.acquisitionLane !== "EXISTING_CATALOG_EXACT_CANDIDATE"
      || target.exactCatalogCandidates.length !== 1
    ) continue;
    const donorProductId =
      target.exactCatalogCandidates[0]!.donorProductId;
    const donorTargets = proposedTargetsByDonor.get(donorProductId) ?? [];
    donorTargets.push(target);
    proposedTargetsByDonor.set(donorProductId, donorTargets);
  }
  for (const donorTargets of proposedTargetsByDonor.values()) {
    if (
      new Set(donorTargets.map((target) => target.canonicalVariantId)).size
      <= 1
    ) continue;
    for (const target of donorTargets) {
      target.acquisitionLane = "CANONICAL_DONOR_CONFLICT";
    }
  }

  targets.sort(compareTargetPriority);
  targets.forEach((target, index) => {
    target.ordinal = index;
    target.acquisitionPriority = index + 1;
  });

  const acquisitionReadyTargets = targets.filter(
    (target) => target.identityQuality.status === "ACQUISITION_READY",
  );
  const milestones = uniqueSorted(
    [
      1,
      5,
      10,
      25,
      50,
      100,
      250,
      500,
      1_000,
      1_500,
      acquisitionReadyTargets.length,
    ]
      .filter((value) => value <= acquisitionReadyTargets.length)
      .map(String),
  ).map(Number).sort((left, right) => left - right);
  const projectedClosures = milestones.map((topTargets) => {
    const selected = new Set(
      acquisitionReadyTargets
        .slice(0, topTargets)
        .map((target) => target.canonicalVariantId),
    );
    return {
      topTargets,
      fullyCoveredListings: [...validListingTargetIds.values()].filter(
        (targetIds) => [...targetIds].every((id) => selected.has(id)),
      ).length,
    };
  });
  const acquisitionLanes: ProductTruthComponentAcquisitionLane[] = [
    "EXISTING_CANONICAL_BINDING",
    "EXISTING_CATALOG_EXACT_CANDIDATE",
    "PROVIDER_IDENTITY_ACQUISITION",
    "EXISTING_CATALOG_AMBIGUOUS",
    "CANONICAL_DONOR_CONFLICT",
    "TARGET_IDENTITY_RECOVERY_REQUIRED",
  ];
  invalidComponentDependencies.sort((left, right) =>
    `${left.listingKey}:${String(left.componentIndex).padStart(6, "0")}`
      .localeCompare(
        `${right.listingKey}:${String(right.componentIndex).padStart(6, "0")}`,
        "en-US",
      ));

  return {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
    generatedAt,
    source: {
      recipeRepairScope: {
        schemaVersion: input.recipeRepairScope.schemaVersion,
        sha256: input.recipeRepairScopeSha256,
        generatedAt: input.recipeRepairScope.generatedAt,
        missingListings: missingEntries.length,
      },
      bridgeSnapshot: {
        schemaVersion: input.bridgeSnapshot.schemaVersion,
        sha256: input.bridgeSnapshotSha256,
        capturedAt: input.bridgeSnapshot.capturedAt,
        targetFingerprint: input.bridgeSnapshot.targetFingerprint,
        donorCount: input.bridgeSnapshot.donors.length,
        offerCount: input.bridgeSnapshot.offers.length,
        canonicalBindingCount:
          input.bridgeSnapshot.canonicalDonorBindings.length,
      },
    },
    matcher: {
      version: CANONICAL_PRODUCT_MATCHER_VERSION,
      implementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      releaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    },
    selectionPolicy: {
      unitOfWork: "UNIQUE_CANONICAL_COMPONENT_VARIANT",
      catalogSearch:
        "ALL_EXISTING_DONORS_TARGET_BRAND_PHRASE_STRICT_RECOVERY_AND_EXACT_CONTENT_PACKAGE_MATCH",
      contentIdentityPolicyVersion:
        EXACT_CONTENT_IDENTITY_POLICY_VERSION,
      legacyCatalogRecoveryIdentityPolicyVersion:
        LEGACY_CATALOG_RECOVERY_IDENTITY_POLICY_VERSION,
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
      denominatorListings: input.recipeRepairScope.counts.denominator,
      missingListings: missingEntries.length,
      missingListingsWithoutComponents: missingWithoutComponents.length,
      missingListingsWithInvalidComponentGraph:
        missingEntries.length
        - missingWithoutComponents.length
        - validListingTargetIds.size,
      missingListingsWithAllCanonicalTargets: validListingTargetIds.size,
      componentUses,
      canonicalComponentUses,
      invalidComponentUses: componentUses - canonicalComponentUses,
      uniqueCanonicalTargets: targets.length,
      acquisitionReadyTargets: acquisitionReadyTargets.length,
      identityRecoveryTargets:
        targets.length - acquisitionReadyTargets.length,
      acquisitionLaneCounts: acquisitionLanes.map((lane) => ({
        lane,
        count: targets.filter((target) => target.acquisitionLane === lane)
          .length,
      })),
    },
    projectedClosures,
    targets,
    invalidComponentDependencies,
    claims: {
      readOnlySources: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      createsAdditionalCatalog: false,
      existingCatalogScannedGlobally: true,
      legacyDonorLinkIsNotIdentityProof: true,
      oneResolvedComponentMayServeManyListings: true,
    },
  };
}

export function renderProductTruthComponentAcquisitionScope(
  value: ProductTruthComponentAcquisitionScope,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthComponentAcquisitionScopeSha256(
  value: ProductTruthComponentAcquisitionScope,
): string {
  return productTruthOperationalSha256(value);
}
