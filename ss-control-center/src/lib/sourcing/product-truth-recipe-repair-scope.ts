import { createHash } from "node:crypto";

import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "./phase1-scope-manifest";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeComponentPlan,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  PRODUCT_TRUTH_CONSUMER_READINESS_VERSION,
  renderProductTruthConsumerReadinessJson,
  type ProductTruthConsumerReadinessEntry,
  type ProductTruthConsumerReadinessReport,
} from "./product-truth-consumer-readiness";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_QUARANTINE_LANES,
  classifyProductTruthQuarantineLane,
} from "./product-truth-quarantine-partition";

export const PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION =
  "product-truth-recipe-repair-scope/1.0.0" as const;

export const PRODUCT_TRUTH_HISTORICAL_IMAGE_STATE_STATUSES = [
  "GEN_OK",
  "TILE_FAIL",
  "VARIANT_MISMATCH",
  "DONOR_FAIL",
  "PUB_BLOCKED",
  "ERR",
] as const;

export type ProductTruthHistoricalImageStateStatus =
  (typeof PRODUCT_TRUTH_HISTORICAL_IMAGE_STATE_STATUSES)[number];

export const PRODUCT_TRUTH_RECIPE_REPAIR_LANES = [
  "CURRENT_RECIPE_PRESENT",
  "SAFE_LEGACY_MATERIALIZATION_CANDIDATE",
  ...PRODUCT_TRUTH_QUARANTINE_LANES,
] as const;

export type ProductTruthRecipeRepairLane =
  (typeof PRODUCT_TRUTH_RECIPE_REPAIR_LANES)[number];

type HistogramRow = {
  code: string;
  count: number;
};

type ChannelCount = {
  channel: "amazon" | "walmart";
  denominator: number;
  currentRecipePresent: number;
  currentRecipeMissing: number;
  historicalStateAvailable: number;
};

type HistoricalImageStateRow = {
  sku: string;
  status: ProductTruthHistoricalImageStateStatus;
  listing?: string;
  donorTitle?: string;
  front?: string;
  newUrl?: string;
  reason?: string;
  tileReason?: string;
  qty?: number;
  audit?: {
    brand?: boolean;
    variant?: boolean;
  };
  [key: string]: unknown;
};

export interface ProductTruthRecipeRepairHistoricalEvidence {
  status: ProductTruthHistoricalImageStateStatus;
  rowSha256: string;
  listingTitle: string | null;
  donorTitle: string | null;
  frontImageUrl: string | null;
  generatedImageUrl: string | null;
  quantity: number | null;
  auditBrand: boolean | null;
  auditVariant: boolean | null;
  reason: string | null;
  tileReason: string | null;
  identityProof: false;
}

export interface ProductTruthRecipeRepairCandidateDonor {
  donorProductId: string;
  title: string | null;
  brand: string | null;
  productLine: string | null;
  flavor: string | null;
  size: string | null;
  upc: string | null;
  gtin: string | null;
  firstPartyDirectOfferCount: number;
  firstPartyRetailers: string[];
}

export interface ProductTruthRecipeRepairComponent {
  componentIndex: number;
  quantity: number;
  disposition: ProductTruthLegacyBridgeComponentPlan["disposition"];
  identityProof: ProductTruthLegacyBridgeComponentPlan["identityProof"];
  targetIdentity: ProductTruthLegacyBridgeComponentPlan["targetIdentity"];
  targetCanonicalVariantId: string | null;
  legacyComponentId: string | null;
  legacyDonorProductId: string | null;
  candidateDonorProductId: string | null;
  matcherVerdict: ProductTruthLegacyBridgeComponentPlan["matcherVerdict"];
  matcherReasonCodes: string[];
  blockerCodes: string[];
  candidateDonor: ProductTruthRecipeRepairCandidateDonor | null;
}

export interface ProductTruthRecipeRepairScopeEntry {
  ordinal: number;
  repairPriority: number | null;
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  listingId: string;
  listingTitle: string;
  priorityGmv30d: number | null;
  priorityOrders30d: number | null;
  priorityUnits30d: number | null;
  recipeStatus: "PRESENT" | "MISSING";
  cogsOutcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "MISSING" | "INVALID";
  repairLane: ProductTruthRecipeRepairLane;
  bridgeDisposition: ProductTruthLegacyBridgePlan["scopes"][number]["disposition"];
  bridgeBlockerCodes: string[];
  matcherReasonCodes: string[];
  historicalEvidence: ProductTruthRecipeRepairHistoricalEvidence | null;
  components: ProductTruthRecipeRepairComponent[];
}

export interface ProductTruthRecipeRepairScope {
  schemaVersion: typeof PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION;
  generatedAt: string;
  source: {
    manifest: {
      schemaVersion: typeof PHASE1_SCOPE_MANIFEST_VERSION;
      sha256: string;
      asOf: string;
      listingCount: number;
    };
    legacyImageState: {
      sha256: string;
      entryCount: number;
    };
    bridgeSnapshot: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
      sha256: string;
      capturedAt: string;
    };
    bridgePlan: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION;
      sha256: string;
      generatedAt: string;
    };
    readiness: {
      schemaVersion: typeof PRODUCT_TRUTH_CONSUMER_READINESS_VERSION;
      sha256: string;
      payloadSha256: string;
      capturedAt: string;
      asOf: string;
    };
    targetFingerprint: string;
  };
  rankingPolicy:
    "GMV_ORDERS_UNITS_THEN_EXISTING_EVIDENCE_THEN_LISTING_KEY";
  counts: {
    denominator: number;
    currentRecipePresent: number;
    currentRecipeMissing: number;
    currentCogs: {
      fact: number;
      estimate: number;
      unsourceable: number;
      missing: number;
      invalid: number;
    };
    historicalState: {
      totalEntries: number;
      mappedToAuthoritativeWalmartScope: number;
      outsideAuthoritativeScope: number;
      ambiguousAuthoritativeMatches: number;
      currentRecipePresent: number;
      currentRecipeMissing: number;
    };
    currentRecipeMissingWithHistoricalState: number;
    currentRecipeMissingWithoutHistoricalState: number;
    currentRecipeMissingEvidenceProfile: {
      noComponents: number;
      withTargetIdentity: number;
      allComponentsHaveTargetIdentity: number;
      withCandidateDonor: number;
      allComponentsHaveCandidateDonor: number;
      withExactIdentityOnlyComponent: number;
      allComponentsExactIdentityOnly: number;
      withRejectedComponent: number;
    };
    channelCounts: ChannelCount[];
  };
  laneCounts: Array<{
    lane: ProductTruthRecipeRepairLane;
    count: number;
  }>;
  historicalStatusCounts: HistogramRow[];
  recipeMissingHistoricalStatusCounts: HistogramRow[];
  bridgeBlockerCounts: HistogramRow[];
  matcherReasonCounts: HistogramRow[];
  entries: ProductTruthRecipeRepairScopeEntry[];
  orphanedHistoricalState: Array<{
    sku: string;
    status: ProductTruthHistoricalImageStateStatus;
    rowSha256: string;
    reason: "OUTSIDE_AUTHORITATIVE_WALMART_SCOPE" | "AMBIGUOUS_AUTHORITATIVE_WALMART_SCOPE";
  }>;
  claims: {
    readOnlySources: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    historicalStateIsIdentityProof: false;
    historicalStatusAuthorizesRecipe: false;
    variantMismatchAutoPromoted: false;
    createsAdditionalCatalog: false;
    repairLaneIsPriorityNotTruthMutation: true;
  };
}

export class ProductTruthRecipeRepairScopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthRecipeRepairScopeError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthRecipeRepairScopeError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("RECIPE_REPAIR_SOURCE_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("RECIPE_REPAIR_SOURCE_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullablePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

function histogram(values: readonly string[]): HistogramRow[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) =>
      right.count - left.count
      || left.code.localeCompare(right.code, "en-US"));
}

function assertBoundCanonicalJson(input: {
  label: string;
  json: string;
  expectedSha256: string;
  canonicalJson: string;
}): string {
  const expectedSha256 = exactSha256(
    input.expectedSha256,
    `${input.label}.sha256`,
  );
  const actualSha256 = bytesSha256(input.json);
  if (actualSha256 !== expectedSha256) {
    fail(
      "RECIPE_REPAIR_SOURCE_HASH_MISMATCH",
      `${input.label} ${actualSha256} != ${expectedSha256}`,
    );
  }
  if (input.canonicalJson !== input.json) {
    fail(
      "RECIPE_REPAIR_SOURCE_NOT_CANONICAL",
      `${input.label} bytes differ from canonical rendering`,
    );
  }
  return actualSha256;
}

function parseHistoricalState(input: {
  value: unknown;
  json: string;
  expectedSha256: string;
}): {
  sha256: string;
  rows: Map<string, HistoricalImageStateRow>;
  rowSha256: Map<string, string>;
} {
  const expectedSha256 = exactSha256(
    input.expectedSha256,
    "legacyImageState.sha256",
  );
  const actualSha256 = bytesSha256(input.json);
  if (actualSha256 !== expectedSha256) {
    fail(
      "RECIPE_REPAIR_SOURCE_HASH_MISMATCH",
      `legacyImageState ${actualSha256} != ${expectedSha256}`,
    );
  }
  if (!isRecord(input.value)) {
    fail("RECIPE_REPAIR_HISTORICAL_STATE_INVALID", "root must be an object keyed by SKU");
  }
  const allowed = new Set<string>(PRODUCT_TRUTH_HISTORICAL_IMAGE_STATE_STATUSES);
  const rows = new Map<string, HistoricalImageStateRow>();
  const rowSha256 = new Map<string, string>();
  for (const sku of Object.keys(input.value).sort((left, right) =>
    left.localeCompare(right, "en-US"))) {
    const row = input.value[sku];
    if (
      !sku
      || !isRecord(row)
      || row.sku !== sku
      || typeof row.status !== "string"
      || !allowed.has(row.status)
    ) {
      fail(
        "RECIPE_REPAIR_HISTORICAL_STATE_INVALID",
        `${sku || "<empty>"} has invalid sku/status binding`,
      );
    }
    rows.set(sku, row as HistoricalImageStateRow);
    rowSha256.set(sku, productTruthOperationalSha256(row));
  }
  return { sha256: actualSha256, rows, rowSha256 };
}

function historicalEvidence(
  row: HistoricalImageStateRow,
  rowSha256: string,
): ProductTruthRecipeRepairHistoricalEvidence {
  return {
    status: row.status,
    rowSha256,
    listingTitle: nullableText(row.listing),
    donorTitle: nullableText(row.donorTitle),
    frontImageUrl: nullableText(row.front),
    generatedImageUrl: nullableText(row.newUrl),
    quantity: nullablePositiveInteger(row.qty),
    auditBrand: typeof row.audit?.brand === "boolean" ? row.audit.brand : null,
    auditVariant: typeof row.audit?.variant === "boolean" ? row.audit.variant : null,
    reason: nullableText(row.reason),
    tileReason: nullableText(row.tileReason),
    identityProof: false,
  };
}

function readinessPayloadSha256(report: ProductTruthConsumerReadinessReport): string {
  const payload: Partial<ProductTruthConsumerReadinessReport> = { ...report };
  delete payload.payloadSha256;
  return productTruthOperationalSha256(payload);
}

function recipeMissing(entry: ProductTruthConsumerReadinessEntry): boolean {
  const bundleMissing = entry.consumers.bundleFactory.blockers.includes(
    "CURRENT_LISTING_RECIPE_MISSING",
  );
  const listingMissing = entry.consumers.listingImprovement.blockers.includes(
    "CURRENT_LISTING_RECIPE_MISSING",
  );
  if (bundleMissing !== listingMissing) {
    fail(
      "RECIPE_REPAIR_READINESS_CONTRADICTION",
      `${entry.listingKey} consumers disagree about recipe presence`,
    );
  }
  return bundleMissing;
}

function repairLane(input: {
  recipeMissing: boolean;
  scope: ProductTruthLegacyBridgePlan["scopes"][number];
}): ProductTruthRecipeRepairLane {
  if (!input.recipeMissing) return "CURRENT_RECIPE_PRESENT";
  if (input.scope.disposition === "ALREADY_CANONICAL") {
    fail(
      "RECIPE_REPAIR_SOURCE_CONTRADICTION",
      `${input.scope.listingKey} is bridge-canonical but readiness says recipe missing`,
    );
  }
  if (input.scope.writeEligible) {
    if (
      input.scope.disposition === "EXACT_CANONICALIZATION_CANDIDATE"
      || input.scope.disposition === "CONTENT_ONLY_CANONICALIZATION_CANDIDATE"
      || input.scope.disposition === "IDENTITY_ONLY_CANONICALIZATION_CANDIDATE"
    ) {
      return "SAFE_LEGACY_MATERIALIZATION_CANDIDATE";
    }
    fail(
      "RECIPE_REPAIR_SOURCE_CONTRADICTION",
      `${input.scope.listingKey} is writeEligible with ${input.scope.disposition}`,
    );
  }
  if (input.scope.disposition !== "QUARANTINE") {
    fail(
      "RECIPE_REPAIR_SOURCE_CONTRADICTION",
      `${input.scope.listingKey} missing recipe has unsupported ${input.scope.disposition}`,
    );
  }
  return classifyProductTruthQuarantineLane(input.scope);
}

function candidateDonor(
  donor: ProductTruthLegacyBridgeDonorRow,
  snapshot: ProductTruthLegacyBridgeSnapshot,
): ProductTruthRecipeRepairCandidateDonor {
  const offers = snapshot.offers.filter(
    (offer) =>
      offer.donorProductId === donor.id
      && offer.isFirstParty
      && Boolean(offer.productUrl),
  );
  return {
    donorProductId: donor.id,
    title: donor.title,
    brand: donor.brand,
    productLine: donor.productLine,
    flavor: donor.flavor,
    size: donor.size,
    upc: donor.upc,
    gtin: donor.gtin,
    firstPartyDirectOfferCount: offers.length,
    firstPartyRetailers: uniqueSorted(offers.map((offer) => offer.retailer)),
  };
}

function componentProjection(input: {
  component: ProductTruthLegacyBridgeComponentPlan;
  donorById: ReadonlyMap<string, ProductTruthLegacyBridgeDonorRow>;
  snapshot: ProductTruthLegacyBridgeSnapshot;
  listingKey: string;
}): ProductTruthRecipeRepairComponent {
  const donorId = input.component.donorProductId;
  const donor = donorId ? input.donorById.get(donorId) : null;
  const donorExplicitlyOrphaned = input.component.blockers.some(
    (blocker) => blocker.code === "LEGACY_DONOR_ORPHANED",
  );
  if (donorId && !donor && !donorExplicitlyOrphaned) {
    fail(
      "RECIPE_REPAIR_SOURCE_CONTRADICTION",
      `${input.listingKey} references missing donor ${donorId}`,
    );
  }
  return {
    componentIndex: input.component.componentIndex,
    quantity: input.component.qty,
    disposition: input.component.disposition,
    identityProof: input.component.identityProof,
    targetIdentity: input.component.targetIdentity,
    targetCanonicalVariantId:
      input.component.targetVariant?.canonicalVariantId ?? null,
    legacyComponentId: input.component.legacyComponentId,
    legacyDonorProductId: input.component.legacyDonorProductId,
    candidateDonorProductId: donorId,
    matcherVerdict: input.component.matcherVerdict,
    matcherReasonCodes: uniqueSorted(input.component.matcherReasonCodes),
    blockerCodes: uniqueSorted(
      input.component.blockers.map((blocker) => blocker.code),
    ),
    candidateDonor: donor
      ? candidateDonor(donor, input.snapshot)
      : null,
  };
}

function compareNullableDescending(left: number | null, right: number | null): number {
  return (right ?? -1) - (left ?? -1);
}

function evidenceRank(entry: ProductTruthRecipeRepairScopeEntry): number {
  if (entry.repairLane === "SAFE_LEGACY_MATERIALIZATION_CANDIDATE") return 0;
  if (entry.historicalEvidence?.status === "GEN_OK") return 1;
  if (entry.historicalEvidence) return 2;
  if (entry.components.some((component) => component.targetIdentity)) return 3;
  return 4;
}

export function compileProductTruthRecipeRepairScope(input: {
  generatedAt: string;
  legacyImageState: unknown;
  legacyImageStateJson: string;
  legacyImageStateSha256: string;
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  manifestSha256: string;
  bridgeSnapshot: ProductTruthLegacyBridgeSnapshot;
  bridgeSnapshotJson: string;
  bridgeSnapshotSha256: string;
  bridgePlan: ProductTruthLegacyBridgePlan;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  readiness: ProductTruthConsumerReadinessReport;
  readinessJson: string;
  readinessSha256: string;
}): ProductTruthRecipeRepairScope {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  const manifestPolicyErrors = validatePhase1ScopeManifestV3Policy(input.manifest);
  if (
    input.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION
    || !input.manifest.authoritative
    || input.manifest.blockers.length
    || manifestPolicyErrors.length
  ) {
    fail(
      "RECIPE_REPAIR_MANIFEST_INVALID",
      manifestPolicyErrors.join("; ") || "manifest is not authoritative",
    );
  }
  const manifestSha256 = assertBoundCanonicalJson({
    label: "manifest",
    json: input.manifestJson,
    expectedSha256: input.manifestSha256,
    canonicalJson: renderPhase1ScopeManifestJson(input.manifest),
  });
  if (
    input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
  ) {
    fail("RECIPE_REPAIR_SOURCE_VERSION_INVALID", "bridgeSnapshot");
  }
  const bridgeSnapshotSha256 = assertBoundCanonicalJson({
    label: "bridgeSnapshot",
    json: input.bridgeSnapshotJson,
    expectedSha256: input.bridgeSnapshotSha256,
    canonicalJson: renderProductTruthLegacyBridgeSnapshot(input.bridgeSnapshot),
  });
  if (input.bridgePlan.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION) {
    fail("RECIPE_REPAIR_SOURCE_VERSION_INVALID", "bridgePlan");
  }
  const bridgePlanSha256 = assertBoundCanonicalJson({
    label: "bridgePlan",
    json: input.bridgePlanJson,
    expectedSha256: input.bridgePlanSha256,
    canonicalJson: renderProductTruthLegacyBridgePlan(input.bridgePlan),
  });
  if (input.readiness.schemaVersion !== PRODUCT_TRUTH_CONSUMER_READINESS_VERSION) {
    fail("RECIPE_REPAIR_SOURCE_VERSION_INVALID", "readiness");
  }
  const readinessSha256 = assertBoundCanonicalJson({
    label: "readiness",
    json: input.readinessJson,
    expectedSha256: input.readinessSha256,
    canonicalJson: renderProductTruthConsumerReadinessJson(input.readiness),
  });
  if (
    readinessPayloadSha256(input.readiness) !== input.readiness.payloadSha256
    || input.readiness.mode !== "READ_ONLY_NO_PAID_READINESS"
    || input.readiness.claims.databaseWrites
    || input.readiness.claims.providerCalls
    || input.readiness.claims.paidCalls
    || input.readiness.claims.marketplaceMutations
  ) {
    fail("RECIPE_REPAIR_READINESS_INVALID", "payload or no-mutation claims are invalid");
  }
  const historical = parseHistoricalState({
    value: input.legacyImageState,
    json: input.legacyImageStateJson,
    expectedSha256: input.legacyImageStateSha256,
  });

  const denominator = input.manifest.listings.length;
  if (
    input.manifest.counts.liveListings !== denominator
    || input.bridgeSnapshot.manifest.sha256 !== manifestSha256
    || input.bridgeSnapshot.manifest.listingCount !== denominator
    || input.bridgePlan.source.manifest.sha256 !== manifestSha256
    || input.bridgePlan.source.manifest.listingCount !== denominator
    || input.bridgePlan.source.snapshotSha256 !== bridgeSnapshotSha256
    || input.readiness.authoritativeManifest.sha256 !== manifestSha256
    || input.readiness.authoritativeManifest.liveListings !== denominator
    || input.readiness.counts.denominator !== denominator
    || input.readiness.counts.reconciled !== denominator
    || input.bridgePlan.scopes.length !== denominator
    || input.bridgeSnapshot.listings.length !== denominator
    || input.bridgePlan.source.targetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
    || input.readiness.databaseTargetFingerprint
      !== input.bridgeSnapshot.targetFingerprint
  ) {
    fail(
      "RECIPE_REPAIR_SOURCE_BINDING_MISMATCH",
      "manifest, snapshot, plan and readiness do not bind one denominator/target",
    );
  }

  const planByListingKey = new Map(
    input.bridgePlan.scopes.map((scope) => [scope.listingKey, scope]),
  );
  const snapshotListingByKey = new Map(
    input.bridgeSnapshot.listings.map((listing) => [listing.listingKey, listing]),
  );
  const readinessByListingKey = new Map(
    input.readiness.entries.map((entry) => [entry.listingKey, entry]),
  );
  if (
    planByListingKey.size !== denominator
    || snapshotListingByKey.size !== denominator
    || readinessByListingKey.size !== denominator
  ) {
    fail("RECIPE_REPAIR_SOURCE_SET_MISMATCH", "one or more listing sets contain duplicates");
  }
  const donorById = new Map(
    input.bridgeSnapshot.donors.map((donor) => [donor.id, donor]),
  );
  if (donorById.size !== input.bridgeSnapshot.donors.length) {
    fail("RECIPE_REPAIR_SOURCE_SET_MISMATCH", "snapshot donor IDs are not unique");
  }
  const walmartBySku = new Map<string, string[]>();
  for (const listing of input.manifest.listings) {
    if (listing.channel !== "walmart") continue;
    const keys = walmartBySku.get(listing.sku) ?? [];
    keys.push(listing.listingKey);
    walmartBySku.set(listing.sku, keys);
  }

  const historicalListingKey = new Map<string, string>();
  const orphanedHistoricalState: ProductTruthRecipeRepairScope["orphanedHistoricalState"] = [];
  let ambiguousHistoricalMatches = 0;
  for (const [sku, row] of historical.rows) {
    const listingKeys = walmartBySku.get(sku) ?? [];
    if (listingKeys.length === 1) {
      historicalListingKey.set(sku, listingKeys[0]!);
      continue;
    }
    const reason = listingKeys.length === 0
      ? "OUTSIDE_AUTHORITATIVE_WALMART_SCOPE" as const
      : "AMBIGUOUS_AUTHORITATIVE_WALMART_SCOPE" as const;
    if (listingKeys.length > 1) ambiguousHistoricalMatches += 1;
    orphanedHistoricalState.push({
      sku,
      status: row.status,
      rowSha256: historical.rowSha256.get(sku)!,
      reason,
    });
  }

  const entries: ProductTruthRecipeRepairScopeEntry[] =
    input.manifest.listings.map((listing, ordinal) => {
      const scope = planByListingKey.get(listing.listingKey);
      const sourceListing = snapshotListingByKey.get(listing.listingKey);
      const readiness = readinessByListingKey.get(listing.listingKey);
      if (
        !scope
        || !sourceListing
        || !readiness
        || readiness.ordinal !== ordinal
        || scope.channel !== listing.channel
        || scope.storeIndex !== listing.storeIndex
        || scope.sku !== listing.sku
        || sourceListing.channel !== listing.channel
        || sourceListing.storeIndex !== listing.storeIndex
        || sourceListing.sku !== listing.sku
        || readiness.channel !== listing.channel
        || readiness.storeIndex !== listing.storeIndex
        || readiness.sku !== listing.sku
      ) {
        fail(
          "RECIPE_REPAIR_SOURCE_SET_MISMATCH",
          `${listing.listingKey} is missing or contradicts source identity`,
        );
      }
      const missing = recipeMissing(readiness);
      const historicalRow = listing.channel === "walmart"
        && historicalListingKey.get(listing.sku) === listing.listingKey
        ? historical.rows.get(listing.sku) ?? null
        : null;
      const components = missing
        ? scope.components.map((component) =>
          componentProjection({
            component,
            donorById,
            snapshot: input.bridgeSnapshot,
            listingKey: listing.listingKey,
          }))
        : [];
      return {
        ordinal,
        repairPriority: null,
        listingKey: listing.listingKey,
        channel: listing.channel,
        storeIndex: listing.storeIndex,
        sku: listing.sku,
        listingId: listing.listingId,
        listingTitle: listing.title,
        priorityGmv30d: nullableFiniteNumber(sourceListing.priorityGmv30d),
        priorityOrders30d: nullableFiniteNumber(sourceListing.priorityOrders30d),
        priorityUnits30d: nullableFiniteNumber(sourceListing.priorityUnits30d),
        recipeStatus: missing ? "MISSING" : "PRESENT",
        cogsOutcome: readiness.consumers.unitEconomics.status,
        repairLane: repairLane({ recipeMissing: missing, scope }),
        bridgeDisposition: scope.disposition,
        bridgeBlockerCodes: missing
          ? uniqueSorted([
            ...scope.blockers.map((blocker) => blocker.code),
            ...scope.components.flatMap((component) =>
              component.blockers.map((blocker) => blocker.code)),
          ])
          : [],
        matcherReasonCodes: missing
          ? uniqueSorted(
            scope.components.flatMap((component) => component.matcherReasonCodes),
          )
          : [],
        historicalEvidence: historicalRow
          ? historicalEvidence(
            historicalRow,
            historical.rowSha256.get(listing.sku)!,
          )
          : null,
        components,
      };
    });

  const queue = entries
    .filter((entry) => entry.recipeStatus === "MISSING")
    .sort((left, right) =>
      compareNullableDescending(left.priorityGmv30d, right.priorityGmv30d)
      || compareNullableDescending(left.priorityOrders30d, right.priorityOrders30d)
      || compareNullableDescending(left.priorityUnits30d, right.priorityUnits30d)
      || evidenceRank(left) - evidenceRank(right)
      || left.listingKey.localeCompare(right.listingKey, "en-US"));
  queue.forEach((entry, index) => {
    entry.repairPriority = index + 1;
  });

  const currentRecipePresent = entries.filter(
    (entry) => entry.recipeStatus === "PRESENT",
  ).length;
  const currentRecipeMissing = denominator - currentRecipePresent;
  const mappedHistoricalEntries = entries.filter(
    (entry) => entry.historicalEvidence,
  );
  const missingEntries = entries.filter(
    (entry) => entry.recipeStatus === "MISSING",
  );
  const missingWithHistorical = mappedHistoricalEntries.filter(
    (entry) => entry.recipeStatus === "MISSING",
  ).length;
  const statuses = entries.map((entry) => entry.cogsOutcome);
  const channelCounts = (["amazon", "walmart"] as const).map(
    (channel): ChannelCount => {
      const scoped = entries.filter((entry) => entry.channel === channel);
      return {
        channel,
        denominator: scoped.length,
        currentRecipePresent: scoped.filter(
          (entry) => entry.recipeStatus === "PRESENT",
        ).length,
        currentRecipeMissing: scoped.filter(
          (entry) => entry.recipeStatus === "MISSING",
        ).length,
        historicalStateAvailable: scoped.filter(
          (entry) => entry.historicalEvidence,
        ).length,
      };
    },
  );
  const laneCounts = PRODUCT_TRUTH_RECIPE_REPAIR_LANES.map((lane) => ({
    lane,
    count: entries.filter((entry) => entry.repairLane === lane).length,
  }));
  if (
    laneCounts.reduce((sum, row) => sum + row.count, 0) !== denominator
    || mappedHistoricalEntries.length + orphanedHistoricalState.length
      !== historical.rows.size
  ) {
    fail("RECIPE_REPAIR_INTERNAL_INVALID", "lanes or historical rows do not reconcile");
  }

  return {
    schemaVersion: PRODUCT_TRUTH_RECIPE_REPAIR_SCOPE_VERSION,
    generatedAt,
    source: {
      manifest: {
        schemaVersion: input.manifest.schemaVersion,
        sha256: manifestSha256,
        asOf: input.manifest.asOf,
        listingCount: denominator,
      },
      legacyImageState: {
        sha256: historical.sha256,
        entryCount: historical.rows.size,
      },
      bridgeSnapshot: {
        schemaVersion: input.bridgeSnapshot.schemaVersion,
        sha256: bridgeSnapshotSha256,
        capturedAt: input.bridgeSnapshot.capturedAt,
      },
      bridgePlan: {
        schemaVersion: input.bridgePlan.schemaVersion,
        sha256: bridgePlanSha256,
        generatedAt: input.bridgePlan.generatedAt,
      },
      readiness: {
        schemaVersion: input.readiness.schemaVersion,
        sha256: readinessSha256,
        payloadSha256: input.readiness.payloadSha256,
        capturedAt: input.readiness.capturedAt,
        asOf: input.readiness.asOf,
      },
      targetFingerprint: input.bridgeSnapshot.targetFingerprint,
    },
    rankingPolicy:
      "GMV_ORDERS_UNITS_THEN_EXISTING_EVIDENCE_THEN_LISTING_KEY",
    counts: {
      denominator,
      currentRecipePresent,
      currentRecipeMissing,
      currentCogs: {
        fact: statuses.filter((status) => status === "FACT").length,
        estimate: statuses.filter((status) => status === "ESTIMATE").length,
        unsourceable: statuses.filter((status) => status === "UNSOURCEABLE").length,
        missing: statuses.filter((status) => status === "MISSING").length,
        invalid: statuses.filter((status) => status === "INVALID").length,
      },
      historicalState: {
        totalEntries: historical.rows.size,
        mappedToAuthoritativeWalmartScope: mappedHistoricalEntries.length,
        outsideAuthoritativeScope:
          orphanedHistoricalState.filter(
            (row) => row.reason === "OUTSIDE_AUTHORITATIVE_WALMART_SCOPE",
          ).length,
        ambiguousAuthoritativeMatches: ambiguousHistoricalMatches,
        currentRecipePresent: mappedHistoricalEntries.filter(
          (entry) => entry.recipeStatus === "PRESENT",
        ).length,
        currentRecipeMissing: missingWithHistorical,
      },
      currentRecipeMissingWithHistoricalState: missingWithHistorical,
      currentRecipeMissingWithoutHistoricalState:
        currentRecipeMissing - missingWithHistorical,
      currentRecipeMissingEvidenceProfile: {
        noComponents: missingEntries.filter(
          (entry) => entry.components.length === 0,
        ).length,
        withTargetIdentity: missingEntries.filter((entry) =>
          entry.components.some((component) => component.targetIdentity),
        ).length,
        allComponentsHaveTargetIdentity: missingEntries.filter(
          (entry) =>
            entry.components.length > 0
            && entry.components.every((component) => component.targetIdentity),
        ).length,
        withCandidateDonor: missingEntries.filter((entry) =>
          entry.components.some((component) => component.candidateDonor),
        ).length,
        allComponentsHaveCandidateDonor: missingEntries.filter(
          (entry) =>
            entry.components.length > 0
            && entry.components.every((component) => component.candidateDonor),
        ).length,
        withExactIdentityOnlyComponent: missingEntries.filter((entry) =>
          entry.components.some(
            (component) =>
              component.disposition === "EXACT_IDENTITY_ONLY_CANDIDATE",
          ),
        ).length,
        allComponentsExactIdentityOnly: missingEntries.filter(
          (entry) =>
            entry.components.length > 0
            && entry.components.every(
              (component) =>
                component.disposition === "EXACT_IDENTITY_ONLY_CANDIDATE",
            ),
        ).length,
        withRejectedComponent: missingEntries.filter((entry) =>
          entry.components.some(
            (component) => component.disposition === "QUARANTINE",
          ),
        ).length,
      },
      channelCounts,
    },
    laneCounts,
    historicalStatusCounts: histogram(
      [...historical.rows.values()].map((row) => row.status),
    ),
    recipeMissingHistoricalStatusCounts: histogram(
      entries
        .filter(
          (entry) =>
            entry.recipeStatus === "MISSING"
            && entry.historicalEvidence,
        )
        .map((entry) => entry.historicalEvidence!.status),
    ),
    bridgeBlockerCounts: histogram(
      entries
        .filter((entry) => entry.recipeStatus === "MISSING")
        .flatMap((entry) => entry.bridgeBlockerCodes),
    ),
    matcherReasonCounts: histogram(
      entries
        .filter((entry) => entry.recipeStatus === "MISSING")
        .flatMap((entry) => entry.matcherReasonCodes),
    ),
    entries,
    orphanedHistoricalState: orphanedHistoricalState.sort((left, right) =>
      left.sku.localeCompare(right.sku, "en-US")),
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
  };
}

export function renderProductTruthRecipeRepairScope(
  value: ProductTruthRecipeRepairScope,
): string {
  return renderProductTruthOperationalJson(value);
}
