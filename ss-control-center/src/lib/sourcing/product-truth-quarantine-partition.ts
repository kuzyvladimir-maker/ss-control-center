import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  productTruthLegacyBridgeBytesSha256,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeScopePlan,
} from "./product-truth-legacy-bridge";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_QUARANTINE_PARTITION_VERSION =
  "product-truth-quarantine-partition/1.0.0" as const;

export const PRODUCT_TRUTH_QUARANTINE_LANES = [
  "CANONICAL_INTEGRITY_CONFLICT",
  "LISTING_IDENTITY_RECOVERY",
  "COMPONENT_GRAPH_RECOVERY",
  "DONOR_LINK_RECOVERY",
  "EXACT_DONOR_OFFER_ENRICHMENT",
  "PRICE_ONLY_PROXY_RESEARCH",
  "RETAILER_IDENTITY_RESEARCH",
  "OTHER_QUARANTINE",
] as const;

export type ProductTruthQuarantineLane =
  (typeof PRODUCT_TRUTH_QUARANTINE_LANES)[number];

type HistogramRow = {
  code: string;
  count: number;
};

type ChannelStoreRow = {
  channel: string;
  storeIndex: number;
  alreadyCanonical: number;
  quarantined: number;
};

type LaneRow = {
  lane: ProductTruthQuarantineLane;
  count: number;
  listingKeys: string[];
};

export interface ProductTruthQuarantinePartition {
  schemaVersion: typeof PRODUCT_TRUTH_QUARANTINE_PARTITION_VERSION;
  generatedAt: string;
  source: {
    bridgePlanSchemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION;
    bridgePlanSha256: string;
    bridgePlanGeneratedAt: string;
    manifestSha256: string;
    targetFingerprint: string;
  };
  counts: {
    denominator: number;
    alreadyCanonical: number;
    quarantined: number;
    automaticWriteCandidates: number;
    channelStores: ChannelStoreRow[];
    overlaps: {
      noComponents: number;
      withExactIdentityOnlyComponent: number;
      fullyExactIdentityOnly: number;
      withPriceOnlyEstimateComponent: number;
      fullyPriceOnlyEstimate: number;
    };
  };
  scopeBlockers: HistogramRow[];
  componentBlockers: HistogramRow[];
  matcherReasons: HistogramRow[];
  lanes: LaneRow[];
  claims: {
    readOnlySource: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    primaryLaneIsPriorityNotTruthMutation: true;
  };
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function canonicalInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail("QUARANTINE_PARTITION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("QUARANTINE_PARTITION_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
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
      right.count - left.count || left.code.localeCompare(right.code, "en-US"));
}

function blockerCodes(scope: ProductTruthLegacyBridgeScopePlan): Set<string> {
  return new Set([
    ...scope.blockers.map((blocker) => blocker.code),
    ...scope.components.flatMap((component) =>
      component.blockers.map((blocker) => blocker.code)),
  ]);
}

function matcherCodes(scope: ProductTruthLegacyBridgeScopePlan): Set<string> {
  return new Set(
    scope.components.flatMap((component) => component.matcherReasonCodes),
  );
}

function primaryLane(
  scope: ProductTruthLegacyBridgeScopePlan,
): ProductTruthQuarantineLane {
  const blockers = blockerCodes(scope);
  const matcher = matcherCodes(scope);
  const dispositions = new Set(
    scope.components.map((component) => component.disposition),
  );
  if (
    blockers.has("CANONICAL_LISTING_STATE_INVALID")
    || blockers.has("CANONICAL_DONOR_VARIANT_CONFLICT")
  ) {
    return "CANONICAL_INTEGRITY_CONFLICT";
  }
  if (
    scope.components.length === 0
    || blockers.has("PRODUCT_IDENTITY_MISSING")
    || blockers.has("PRODUCT_IDENTITY_INVALID")
  ) {
    return "LISTING_IDENTITY_RECOVERY";
  }
  if (
    blockers.has("LEGACY_COMPONENT_COUNT_MISMATCH")
    || blockers.has("LEGACY_COMPONENT_MISSING")
    || blockers.has("BUNDLE_COMPONENT_BRAND_UNPROVEN")
    || blockers.has("TARGET_VARIANT_INVALID")
  ) {
    return "COMPONENT_GRAPH_RECOVERY";
  }
  if (
    blockers.has("LEGACY_DONOR_LINK_MISSING")
    || blockers.has("LEGACY_DONOR_ORPHANED")
  ) {
    return "DONOR_LINK_RECOVERY";
  }
  if (
    blockers.has("FIRST_PARTY_DIRECT_OFFER_MISSING")
    || dispositions.has("EXACT_IDENTITY_ONLY_CANDIDATE")
  ) {
    return "EXACT_DONOR_OFFER_ENRICHMENT";
  }
  if (
    blockers.has("DONOR_TITLE_MATCH_ESTIMATE_ONLY")
    || dispositions.has("PRICE_ONLY_ESTIMATE")
  ) {
    return "PRICE_ONLY_PROXY_RESEARCH";
  }
  if (
    blockers.has("DONOR_TITLE_MATCH_REJECTED")
    || matcher.size > 0
  ) {
    return "RETAILER_IDENTITY_RESEARCH";
  }
  return "OTHER_QUARANTINE";
}

function channelStores(
  scopes: readonly ProductTruthLegacyBridgeScopePlan[],
): ChannelStoreRow[] {
  const rows = new Map<string, ChannelStoreRow>();
  for (const scope of scopes) {
    const key = `${scope.channel}:${scope.storeIndex}`;
    const row = rows.get(key) ?? {
      channel: scope.channel,
      storeIndex: scope.storeIndex,
      alreadyCanonical: 0,
      quarantined: 0,
    };
    if (scope.disposition === "ALREADY_CANONICAL") row.alreadyCanonical += 1;
    if (scope.disposition === "QUARANTINE") row.quarantined += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((left, right) =>
    left.channel.localeCompare(right.channel, "en-US")
    || left.storeIndex - right.storeIndex);
}

export function buildProductTruthQuarantinePartition(input: {
  bridgePlan: ProductTruthLegacyBridgePlan;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  generatedAt: string;
}): ProductTruthQuarantinePartition {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  const expectedSha256 = exactSha(
    input.bridgePlanSha256,
    "bridgePlanSha256",
  );
  const actualSha256 = productTruthLegacyBridgeBytesSha256(
    input.bridgePlanJson,
  );
  if (actualSha256 !== expectedSha256) {
    fail(
      "QUARANTINE_PARTITION_SOURCE_HASH_MISMATCH",
      `${actualSha256} != ${expectedSha256}`,
    );
  }
  if (
    input.bridgePlan.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION
  ) {
    fail(
      "QUARANTINE_PARTITION_SOURCE_VERSION_INVALID",
      String(input.bridgePlan.schemaVersion),
    );
  }
  if (!Array.isArray(input.bridgePlan.scopes)) {
    fail("QUARANTINE_PARTITION_SOURCE_INVALID", "scopes are missing");
  }
  const listingKeys = input.bridgePlan.scopes.map((scope) => scope.listingKey);
  if (
    new Set(listingKeys).size !== listingKeys.length
    || listingKeys.some((listingKey) => !listingKey)
  ) {
    fail(
      "QUARANTINE_PARTITION_SOURCE_INVALID",
      "listing keys must be unique and non-empty",
    );
  }
  const quarantined = input.bridgePlan.scopes
    .filter((scope) => scope.disposition === "QUARANTINE")
    .sort((left, right) => left.listingKey.localeCompare(right.listingKey, "en-US"));
  const alreadyCanonical = input.bridgePlan.scopes.filter(
    (scope) => scope.disposition === "ALREADY_CANONICAL",
  ).length;
  if (
    input.bridgePlan.counts.listingsTotal !== input.bridgePlan.scopes.length
    || input.bridgePlan.counts.alreadyCanonicalListings !== alreadyCanonical
    || input.bridgePlan.counts.quarantinedListings !== quarantined.length
  ) {
    fail(
      "QUARANTINE_PARTITION_SOURCE_INVALID",
      "plan counts do not match exact scope rows",
    );
  }

  const laneMap = new Map<ProductTruthQuarantineLane, string[]>(
    PRODUCT_TRUTH_QUARANTINE_LANES.map((lane) => [lane, []]),
  );
  for (const scope of quarantined) {
    laneMap.get(primaryLane(scope))!.push(scope.listingKey);
  }
  const lanes = PRODUCT_TRUTH_QUARANTINE_LANES.map((lane): LaneRow => ({
    lane,
    count: laneMap.get(lane)!.length,
    listingKeys: laneMap.get(lane)!,
  }));
  if (lanes.reduce((sum, lane) => sum + lane.count, 0) !== quarantined.length) {
    fail(
      "QUARANTINE_PARTITION_INTERNAL_INVALID",
      "primary lanes do not partition quarantine",
    );
  }

  const exactCandidateCount =
    input.bridgePlan.counts.exactCanonicalizationCandidates
    + input.bridgePlan.counts.contentOnlyCanonicalizationCandidates
    + input.bridgePlan.counts.identityOnlyCanonicalizationCandidates;
  return {
    schemaVersion: PRODUCT_TRUTH_QUARANTINE_PARTITION_VERSION,
    generatedAt,
    source: {
      bridgePlanSchemaVersion: input.bridgePlan.schemaVersion,
      bridgePlanSha256: expectedSha256,
      bridgePlanGeneratedAt: input.bridgePlan.generatedAt,
      manifestSha256: input.bridgePlan.source.manifest.sha256,
      targetFingerprint: input.bridgePlan.source.targetFingerprint,
    },
    counts: {
      denominator: input.bridgePlan.scopes.length,
      alreadyCanonical,
      quarantined: quarantined.length,
      automaticWriteCandidates: exactCandidateCount,
      channelStores: channelStores(input.bridgePlan.scopes),
      overlaps: {
        noComponents: quarantined.filter(
          (scope) => scope.components.length === 0,
        ).length,
        withExactIdentityOnlyComponent: quarantined.filter((scope) =>
          scope.components.some(
            (component) =>
              component.disposition === "EXACT_IDENTITY_ONLY_CANDIDATE",
          )).length,
        fullyExactIdentityOnly: quarantined.filter(
          (scope) =>
            scope.components.length > 0
            && scope.components.every(
              (component) =>
                component.disposition === "EXACT_IDENTITY_ONLY_CANDIDATE",
            ),
        ).length,
        withPriceOnlyEstimateComponent: quarantined.filter((scope) =>
          scope.components.some(
            (component) => component.disposition === "PRICE_ONLY_ESTIMATE",
          )).length,
        fullyPriceOnlyEstimate: quarantined.filter(
          (scope) =>
            scope.components.length > 0
            && scope.components.every(
              (component) => component.disposition === "PRICE_ONLY_ESTIMATE",
            ),
        ).length,
      },
    },
    scopeBlockers: histogram(
      quarantined.flatMap((scope) =>
        scope.blockers.map((blocker) => blocker.code)),
    ),
    componentBlockers: histogram(
      quarantined.flatMap((scope) =>
        scope.components.flatMap((component) =>
          component.blockers.map((blocker) => blocker.code))),
    ),
    matcherReasons: histogram(
      quarantined.flatMap((scope) =>
        scope.components.flatMap((component) => component.matcherReasonCodes)),
    ),
    lanes,
    claims: {
      readOnlySource: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      primaryLaneIsPriorityNotTruthMutation: true,
    },
  };
}

export function renderProductTruthQuarantinePartition(
  value: ProductTruthQuarantinePartition,
): string {
  return renderProductTruthOperationalJson(value);
}
