import { createHash } from "node:crypto";

import type { Client, Row } from "@libsql/client";

export const PRODUCT_TRUTH_STANDING_WAVE_VERSION =
  "product-truth-standing-wave/1.0.0" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_RANKING_VERSION =
  "product-truth-standing-wave-ranking/1.0.0" as const;
export const PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS = 5 as const;
export const PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS = 100 as const;
export const PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS =
  24 * 60 * 60 * 1_000;

const ELIGIBLE_COST_OUTCOMES = ["MISSING", "UNSOURCEABLE"] as const;

export interface ProductTruthStandingWaveCandidate {
  donorProductId: string;
  canonicalVariantId: string;
  variantDecisionId: string;
  donorOfferId: string;
  retailerProductId: string;
  query: string;
  representative: {
    listingKey: string;
    sku: string;
    componentIndex: number;
  };
  linkedListingKeys: readonly string[];
  currentCostOutcomes: {
    missing: number;
    unsourceable: number;
  };
  impact: {
    convertibleListings: number;
    sales180: number;
    units180: number;
  };
  priorAttemptCount: 0;
}

export interface ProductTruthStandingWavePlan {
  schemaVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_VERSION;
  waveId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  authority: {
    mode: "PINNED_STANDING_POLICY";
    standingProviderPolicySha256: string;
    standingNoPaidPolicySha256: string;
    ownerActionRequired: false;
  };
  selection: {
    rankingVersion: typeof PRODUCT_TRUTH_STANDING_WAVE_RANKING_VERSION;
    maxTargets: number;
    eligibleCostOutcomes: readonly ["MISSING", "UNSOURCEABLE"];
    excludesPreviousAttempts: true;
    order: readonly [
      "CONVERTIBLE_LISTINGS_DESC",
      "SALES_180_DESC",
      "UNITS_180_DESC",
      "DONOR_PRODUCT_ID_ASC",
    ];
  };
  targets: readonly ProductTruthStandingWaveCandidate[];
  workflow: {
    targetConcurrency: 1;
    maxAttemptsPerTarget: 1;
    automaticRetry: false;
    stages: readonly [
      "DOCTOR",
      "PLAN",
      "BALANCE_PROBE",
      "AUTHORIZE",
      "EXECUTE",
      "COGS_PLAN",
      "COGS_PREFLIGHT",
      "COGS_APPLY",
      "READINESS",
    ];
    readinessMaxPriceAgeMs: 172800000;
    perTargetProviderCeiling: {
      balanceProbeUnits: 2.5;
      oxylabsQueryUnits: 1;
      unwrangleDetailUnits: 2.5;
      combinedUnits: 6;
      unwrangleReserveFloor: 15000;
    };
    maximumWaveProviderUnits: number;
  };
  claims: {
    authoritativePhase1Only: true;
    exactCurrentRecipeBinding: true;
    oneDonorPerTarget: true;
    noImplicitScope: true;
    noParallelCatalog: true;
    contentAndPriceAxesIndependent: true;
    ambiguousNeverReplay: true;
    noMarketplaceMutation: true;
    noPriceOrInventoryChange: true;
    noDelisting: true;
    noConsumerActivation: true;
    noProcurement: true;
    noClubs: true;
    noBjs: true;
  };
}

export interface SealedProductTruthStandingWavePlan {
  plan: ProductTruthStandingWavePlan;
  planSha256: string;
}

export class ProductTruthStandingWaveError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthStandingWaveError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthStandingWaveError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail("STANDING_WAVE_SHAPE_INVALID", `${label} has non-canonical keys`);
  }
}

function exactText(
  value: unknown,
  label: string,
  minimum = 1,
  maximum = 1_000,
): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("STANDING_WAVE_VALUE_INVALID", `${label} must be exact bounded text`);
  }
  return value;
}

function safeToken(value: unknown, label: string): string {
  const text = exactText(value, label, 1, 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(text)) {
    fail("STANDING_WAVE_VALUE_INVALID", `${label} must be a safe token`);
  }
  return text;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("STANDING_WAVE_VALUE_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 20, 30);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    fail("STANDING_WAVE_VALUE_INVALID", `${label} must be canonical UTC`);
  }
  return text;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    fail(
      "STANDING_WAVE_VALUE_INVALID",
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}

function finiteNumber(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
  ) {
    fail("STANDING_WAVE_VALUE_INVALID", `${label} must be a finite number`);
  }
  return value;
}

function sortedUniqueTokens(
  value: unknown,
  label: string,
  maximum = PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    fail(
      "STANDING_WAVE_VALUE_INVALID",
      `${label} must contain 1-${maximum} values`,
    );
  }
  const values = value.map((entry, index) =>
    safeToken(entry, `${label}[${index}]`),
  );
  const sorted = [...values].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  if (
    new Set(values).size !== values.length
    || values.some((entry, index) => entry !== sorted[index])
  ) {
    fail("STANDING_WAVE_VALUE_INVALID", `${label} must be unique and sorted`);
  }
  return values;
}

function parseCandidate(
  value: unknown,
  label: string,
): ProductTruthStandingWaveCandidate {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_SHAPE_INVALID", `${label} must be an object`);
  }
  exactKeys(
    value,
    [
      "donorProductId",
      "canonicalVariantId",
      "variantDecisionId",
      "donorOfferId",
      "retailerProductId",
      "query",
      "representative",
      "linkedListingKeys",
      "currentCostOutcomes",
      "impact",
      "priorAttemptCount",
    ],
    label,
  );
  if (
    !isRecord(value.representative)
    || !isRecord(value.currentCostOutcomes)
    || !isRecord(value.impact)
  ) {
    fail(
      "STANDING_WAVE_SHAPE_INVALID",
      `${label} nested values must be objects`,
    );
  }
  exactKeys(
    value.representative,
    ["listingKey", "sku", "componentIndex"],
    `${label}.representative`,
  );
  exactKeys(
    value.currentCostOutcomes,
    ["missing", "unsourceable"],
    `${label}.currentCostOutcomes`,
  );
  exactKeys(
    value.impact,
    ["convertibleListings", "sales180", "units180"],
    `${label}.impact`,
  );
  const linkedListingKeys = sortedUniqueTokens(
    value.linkedListingKeys,
    `${label}.linkedListingKeys`,
  );
  const representativeListingKey = safeToken(
    value.representative.listingKey,
    `${label}.representative.listingKey`,
  );
  if (!linkedListingKeys.includes(representativeListingKey)) {
    fail(
      "STANDING_WAVE_VALUE_INVALID",
      `${label} representative is outside linked listings`,
    );
  }
  const missing = integer(
    value.currentCostOutcomes.missing,
    `${label}.currentCostOutcomes.missing`,
    0,
    linkedListingKeys.length,
  );
  const unsourceable = integer(
    value.currentCostOutcomes.unsourceable,
    `${label}.currentCostOutcomes.unsourceable`,
    0,
    linkedListingKeys.length,
  );
  const convertibleListings = integer(
    value.impact.convertibleListings,
    `${label}.impact.convertibleListings`,
    1,
    linkedListingKeys.length,
  );
  if (
    missing + unsourceable !== linkedListingKeys.length
    || convertibleListings !== linkedListingKeys.length
    || value.priorAttemptCount !== 0
  ) {
    fail(
      "STANDING_WAVE_ELIGIBILITY_INVALID",
      `${label} outcome partition or prior-attempt proof is invalid`,
    );
  }
  return {
    donorProductId: safeToken(
      value.donorProductId,
      `${label}.donorProductId`,
    ),
    canonicalVariantId: safeToken(
      value.canonicalVariantId,
      `${label}.canonicalVariantId`,
    ),
    variantDecisionId: safeToken(
      value.variantDecisionId,
      `${label}.variantDecisionId`,
    ),
    donorOfferId: safeToken(value.donorOfferId, `${label}.donorOfferId`),
    retailerProductId: safeToken(
      value.retailerProductId,
      `${label}.retailerProductId`,
    ),
    query: exactText(value.query, `${label}.query`, 3, 500),
    representative: {
      listingKey: representativeListingKey,
      sku: safeToken(value.representative.sku, `${label}.representative.sku`),
      componentIndex: integer(
        value.representative.componentIndex,
        `${label}.representative.componentIndex`,
        0,
        100,
      ),
    },
    linkedListingKeys,
    currentCostOutcomes: { missing, unsourceable },
    impact: {
      convertibleListings,
      sales180: finiteNumber(
        value.impact.sales180,
        `${label}.impact.sales180`,
      ),
      units180: finiteNumber(
        value.impact.units180,
        `${label}.impact.units180`,
      ),
    },
    priorAttemptCount: 0,
  };
}

function compareCandidates(
  left: ProductTruthStandingWaveCandidate,
  right: ProductTruthStandingWaveCandidate,
): number {
  return (
    right.impact.convertibleListings - left.impact.convertibleListings
    || right.impact.sales180 - left.impact.sales180
    || right.impact.units180 - left.impact.units180
    || left.donorProductId.localeCompare(right.donorProductId, "en-US")
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseProductTruthStandingWavePlan(
  value: unknown,
): ProductTruthStandingWavePlan {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_SHAPE_INVALID", "plan must be an object");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "waveId",
      "createdAt",
      "expiresAt",
      "databaseTargetFingerprint",
      "manifestSha256",
      "authority",
      "selection",
      "targets",
      "workflow",
      "claims",
    ],
    "plan",
  );
  if (value.schemaVersion !== PRODUCT_TRUTH_STANDING_WAVE_VERSION) {
    fail("STANDING_WAVE_VERSION_INVALID", "plan version is unsupported");
  }
  const createdAt = canonicalInstant(value.createdAt, "plan.createdAt");
  const expiresAt = canonicalInstant(value.expiresAt, "plan.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > PRODUCT_TRUTH_STANDING_WAVE_MAX_LIFETIME_MS) {
    fail(
      "STANDING_WAVE_LIFETIME_INVALID",
      "plan lifetime must be positive and at most 24 hours",
    );
  }
  if (
    !isRecord(value.authority)
    || !isRecord(value.selection)
    || !isRecord(value.workflow)
    || !isRecord(value.claims)
  ) {
    fail("STANDING_WAVE_SHAPE_INVALID", "plan sections must be objects");
  }
  exactKeys(
    value.authority,
    [
      "mode",
      "standingProviderPolicySha256",
      "standingNoPaidPolicySha256",
      "ownerActionRequired",
    ],
    "plan.authority",
  );
  if (
    value.authority.mode !== "PINNED_STANDING_POLICY"
    || value.authority.ownerActionRequired !== false
  ) {
    fail(
      "STANDING_WAVE_AUTHORITY_INVALID",
      "plan must use pinned standing authority without an owner chat action",
    );
  }
  exactKeys(
    value.selection,
    [
      "rankingVersion",
      "maxTargets",
      "eligibleCostOutcomes",
      "excludesPreviousAttempts",
      "order",
    ],
    "plan.selection",
  );
  const maxTargets = integer(
    value.selection.maxTargets,
    "plan.selection.maxTargets",
    1,
    PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
  );
  if (
    value.selection.rankingVersion
      !== PRODUCT_TRUTH_STANDING_WAVE_RANKING_VERSION
    || JSON.stringify(value.selection.eligibleCostOutcomes)
      !== JSON.stringify(ELIGIBLE_COST_OUTCOMES)
    || value.selection.excludesPreviousAttempts !== true
    || JSON.stringify(value.selection.order)
      !== JSON.stringify([
        "CONVERTIBLE_LISTINGS_DESC",
        "SALES_180_DESC",
        "UNITS_180_DESC",
        "DONOR_PRODUCT_ID_ASC",
      ])
  ) {
    fail(
      "STANDING_WAVE_SELECTION_INVALID",
      "ranking or eligibility policy drifted",
    );
  }
  if (
    !Array.isArray(value.targets)
    || value.targets.length < 1
    || value.targets.length > maxTargets
  ) {
    fail(
      "STANDING_WAVE_TARGETS_INVALID",
      "plan must contain a bounded non-empty target set",
    );
  }
  const targets = value.targets.map((target, index) =>
    parseCandidate(target, `plan.targets[${index}]`),
  );
  const sortedTargets = [...targets].sort(compareCandidates);
  if (
    new Set(targets.map((target) => target.donorProductId)).size
      !== targets.length
    || targets.some(
      (target, index) =>
        target.donorProductId !== sortedTargets[index]?.donorProductId,
    )
  ) {
    fail(
      "STANDING_WAVE_TARGETS_INVALID",
      "targets must be unique and deterministically ranked",
    );
  }
  exactKeys(
    value.workflow,
    [
      "targetConcurrency",
      "maxAttemptsPerTarget",
      "automaticRetry",
      "stages",
      "readinessMaxPriceAgeMs",
      "perTargetProviderCeiling",
      "maximumWaveProviderUnits",
    ],
    "plan.workflow",
  );
  if (!isRecord(value.workflow.perTargetProviderCeiling)) {
    fail(
      "STANDING_WAVE_SHAPE_INVALID",
      "provider ceiling must be an object",
    );
  }
  exactKeys(
    value.workflow.perTargetProviderCeiling,
    [
      "balanceProbeUnits",
      "oxylabsQueryUnits",
      "unwrangleDetailUnits",
      "combinedUnits",
      "unwrangleReserveFloor",
    ],
    "plan.workflow.perTargetProviderCeiling",
  );
  const expectedStages = [
    "DOCTOR",
    "PLAN",
    "BALANCE_PROBE",
    "AUTHORIZE",
    "EXECUTE",
    "COGS_PLAN",
    "COGS_PREFLIGHT",
    "COGS_APPLY",
    "READINESS",
  ];
  if (
    value.workflow.targetConcurrency !== 1
    || value.workflow.maxAttemptsPerTarget !== 1
    || value.workflow.automaticRetry !== false
    || JSON.stringify(value.workflow.stages) !== JSON.stringify(expectedStages)
    || value.workflow.readinessMaxPriceAgeMs !== 172800000
    || value.workflow.perTargetProviderCeiling.balanceProbeUnits !== 2.5
    || value.workflow.perTargetProviderCeiling.oxylabsQueryUnits !== 1
    || value.workflow.perTargetProviderCeiling.unwrangleDetailUnits !== 2.5
    || value.workflow.perTargetProviderCeiling.combinedUnits !== 6
    || value.workflow.perTargetProviderCeiling.unwrangleReserveFloor !== 15000
    || value.workflow.maximumWaveProviderUnits !== targets.length * 6
  ) {
    fail(
      "STANDING_WAVE_WORKFLOW_INVALID",
      "sequential one-attempt workflow or provider ceilings drifted",
    );
  }
  const claimKeys = [
    "authoritativePhase1Only",
    "exactCurrentRecipeBinding",
    "oneDonorPerTarget",
    "noImplicitScope",
    "noParallelCatalog",
    "contentAndPriceAxesIndependent",
    "ambiguousNeverReplay",
    "noMarketplaceMutation",
    "noPriceOrInventoryChange",
    "noDelisting",
    "noConsumerActivation",
    "noProcurement",
    "noClubs",
    "noBjs",
  ] as const;
  const claims = value.claims;
  exactKeys(claims, claimKeys, "plan.claims");
  if (claimKeys.some((key) => claims[key] !== true)) {
    fail("STANDING_WAVE_CLAIMS_INVALID", "mandatory safety claims are absent");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_VERSION,
    waveId: safeToken(value.waveId, "plan.waveId"),
    createdAt,
    expiresAt,
    databaseTargetFingerprint: exactSha256(
      value.databaseTargetFingerprint,
      "plan.databaseTargetFingerprint",
    ),
    manifestSha256: exactSha256(
      value.manifestSha256,
      "plan.manifestSha256",
    ),
    authority: {
      mode: "PINNED_STANDING_POLICY",
      standingProviderPolicySha256: exactSha256(
        value.authority.standingProviderPolicySha256,
        "plan.authority.standingProviderPolicySha256",
      ),
      standingNoPaidPolicySha256: exactSha256(
        value.authority.standingNoPaidPolicySha256,
        "plan.authority.standingNoPaidPolicySha256",
      ),
      ownerActionRequired: false,
    },
    selection: {
      rankingVersion: PRODUCT_TRUTH_STANDING_WAVE_RANKING_VERSION,
      maxTargets,
      eligibleCostOutcomes: ELIGIBLE_COST_OUTCOMES,
      excludesPreviousAttempts: true,
      order: [
        "CONVERTIBLE_LISTINGS_DESC",
        "SALES_180_DESC",
        "UNITS_180_DESC",
        "DONOR_PRODUCT_ID_ASC",
      ],
    },
    targets,
    workflow: {
      targetConcurrency: 1,
      maxAttemptsPerTarget: 1,
      automaticRetry: false,
      stages: expectedStages as unknown as ProductTruthStandingWavePlan["workflow"]["stages"],
      readinessMaxPriceAgeMs: 172800000,
      perTargetProviderCeiling: {
        balanceProbeUnits: 2.5,
        oxylabsQueryUnits: 1,
        unwrangleDetailUnits: 2.5,
        combinedUnits: 6,
        unwrangleReserveFloor: 15000,
      },
      maximumWaveProviderUnits: targets.length * 6,
    },
    claims: Object.fromEntries(
      claimKeys.map((key) => [key, true]),
    ) as unknown as ProductTruthStandingWavePlan["claims"],
  };
}

export function renderProductTruthStandingWavePlan(value: unknown): string {
  return canonicalJson(parseProductTruthStandingWavePlan(value));
}

export function productTruthStandingWavePlanSha256(value: unknown): string {
  return sha256(renderProductTruthStandingWavePlan(value));
}

export function sealProductTruthStandingWavePlan(input: {
  waveId: string;
  createdAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  manifestSha256: string;
  standingProviderPolicySha256: string;
  standingNoPaidPolicySha256: string;
  maxTargets: number;
  candidates: readonly ProductTruthStandingWaveCandidate[];
}): SealedProductTruthStandingWavePlan {
  const targets = input.candidates
    .map((candidate, index) =>
      parseCandidate(candidate, `candidates[${index}]`),
    )
    .sort(compareCandidates)
    .slice(0, input.maxTargets);
  const plan = parseProductTruthStandingWavePlan({
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_VERSION,
    waveId: input.waveId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    manifestSha256: input.manifestSha256,
    authority: {
      mode: "PINNED_STANDING_POLICY",
      standingProviderPolicySha256: input.standingProviderPolicySha256,
      standingNoPaidPolicySha256: input.standingNoPaidPolicySha256,
      ownerActionRequired: false,
    },
    selection: {
      rankingVersion: PRODUCT_TRUTH_STANDING_WAVE_RANKING_VERSION,
      maxTargets: input.maxTargets,
      eligibleCostOutcomes: ELIGIBLE_COST_OUTCOMES,
      excludesPreviousAttempts: true,
      order: [
        "CONVERTIBLE_LISTINGS_DESC",
        "SALES_180_DESC",
        "UNITS_180_DESC",
        "DONOR_PRODUCT_ID_ASC",
      ],
    },
    targets,
    workflow: {
      targetConcurrency: 1,
      maxAttemptsPerTarget: 1,
      automaticRetry: false,
      stages: [
        "DOCTOR",
        "PLAN",
        "BALANCE_PROBE",
        "AUTHORIZE",
        "EXECUTE",
        "COGS_PLAN",
        "COGS_PREFLIGHT",
        "COGS_APPLY",
        "READINESS",
      ],
      readinessMaxPriceAgeMs: 172800000,
      perTargetProviderCeiling: {
        balanceProbeUnits: 2.5,
        oxylabsQueryUnits: 1,
        unwrangleDetailUnits: 2.5,
        combinedUnits: 6,
        unwrangleReserveFloor: 15000,
      },
      maximumWaveProviderUnits: targets.length * 6,
    },
    claims: {
      authoritativePhase1Only: true,
      exactCurrentRecipeBinding: true,
      oneDonorPerTarget: true,
      noImplicitScope: true,
      noParallelCatalog: true,
      contentAndPriceAxesIndependent: true,
      ambiguousNeverReplay: true,
      noMarketplaceMutation: true,
      noPriceOrInventoryChange: true,
      noDelisting: true,
      noConsumerActivation: true,
      noProcurement: true,
      noClubs: true,
      noBjs: true,
    },
  });
  return { plan, planSha256: productTruthStandingWavePlanSha256(plan) };
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    fail("STANDING_WAVE_DATABASE_INVALID", `${key} is missing`);
  }
  return value;
}

function rowInteger(row: Row, key: string): number {
  const value = Number(row[key] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("STANDING_WAVE_DATABASE_INVALID", `${key} is not an integer`);
  }
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = Number(row[key] ?? 0);
  if (!Number.isFinite(value) || value < 0) {
    fail("STANDING_WAVE_DATABASE_INVALID", `${key} is not finite`);
  }
  return value;
}

function attemptedDonorIds(planJsonRows: readonly Row[]): Set<string> {
  const attempted = new Set<string>();
  for (const row of planJsonRows) {
    const text = row.planJson;
    if (typeof text !== "string") continue;
    let plan: unknown;
    try {
      plan = JSON.parse(text);
    } catch {
      fail(
        "STANDING_WAVE_OPERATIONAL_HISTORY_INVALID",
        "operational planJson is not valid JSON",
      );
    }
    if (!isRecord(plan) || !Array.isArray(plan.targets)) continue;
    for (const target of plan.targets) {
      if (
        isRecord(target)
        && typeof target.donorProductId === "string"
        && target.donorProductId
      ) {
        attempted.add(target.donorProductId);
      }
    }
  }
  return attempted;
}

interface CandidateAccumulator {
  donorProductId: string;
  canonicalVariantIds: Set<string>;
  variantDecisionIds: Set<string>;
  offers: Map<
    string,
    { donorOfferId: string; retailerProductId: string }
  >;
  query: string;
  listings: Map<
    string,
    {
      listingKey: string;
      sku: string;
      componentIndex: number;
      currentCostOutcome: "MISSING" | "UNSOURCEABLE";
      sales180: number;
      units180: number;
    }
  >;
}

/**
 * Read-only deterministic ranking for Phase 1 targets that already have an
 * exact canonical recipe and one existing direct Walmart.com offer. The
 * function does not create a product identity, call a provider, or write a DB.
 */
export async function rankProductTruthStandingWaveCandidates(input: {
  db: Client;
  manifestSha256: string;
  limit?: number;
}): Promise<readonly ProductTruthStandingWaveCandidate[]> {
  const manifestSha256 = exactSha256(
    input.manifestSha256,
    "manifestSha256",
  );
  const limit = integer(
    input.limit ?? PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
    "limit",
    1,
    PRODUCT_TRUTH_STANDING_WAVE_MAX_TARGETS,
  );
  let historyRows: Row[];
  let rows: Row[];
  try {
    historyRows = (
      await input.db.execute(
        `SELECT planJson FROM ProductTruthOperationalRun ORDER BY runId`,
      )
    ).rows;
    rows = (
      await input.db.execute({
        sql: `WITH rankedRecipe AS (
                SELECT recipe.*,
                       ROW_NUMBER() OVER (
                         PARTITION BY recipe.listingKey
                         ORDER BY julianday(recipe.effectiveAt) DESC,
                                  recipe.effectiveAt DESC,
                                  julianday(recipe.createdAt) DESC,
                                  recipe.createdAt DESC,
                                  recipe.id DESC
                       ) AS currentRank
                FROM ProductTruthListingRecipe recipe
              ),
              rankedCost AS (
                SELECT costLink.listingKey,cost.evidenceOutcome,
                       ROW_NUMBER() OVER (
                         PARTITION BY costLink.listingKey
                         ORDER BY julianday(cost.effectiveDate) DESC,
                                  cost.effectiveDate DESC,
                                  julianday(cost.createdAt) DESC,
                                  cost.createdAt DESC,
                                  cost.id DESC
                       ) AS currentRank
                FROM SkuCostListingScopeLink costLink
                JOIN SkuCost cost ON cost.id=costLink.skuCostId
                WHERE cost.source='retail:batch'
              )
              SELECT
                scope.listingKey,scope.sku,
                component.componentIndex,component.donorProductId,
                component.targetCanonicalVariantId,component.variantDecisionId,
                donor.title AS donorTitle,
                offer.id AS donorOfferId,
                offer.retailerProductId,
                COALESCE(perf.sales180,0) AS sales180,
                COALESCE(perf.units180,0) AS units180,
                COALESCE(currentCost.evidenceOutcome,'MISSING')
                  AS currentCostOutcome
              FROM ProductTruthListingScope scope
              JOIN rankedRecipe recipe
                ON recipe.listingKey=scope.listingKey
               AND recipe.currentRank=1
              JOIN ProductTruthListingRecipeComponent component
                ON component.listingRecipeId=recipe.id
              JOIN DonorProduct donor ON donor.id=component.donorProductId
              JOIN DonorOffer offer
                ON offer.donorProductId=component.donorProductId
               AND offer.retailer='walmart'
               AND offer.via='direct'
               AND offer.isFirstParty=1
               AND offer.sellerName='Walmart.com'
               AND offer.packSizeSeen=1
              LEFT JOIN WalmartSkuPerf perf
                ON perf.sku=scope.sku AND perf.storeIndex=scope.storeIndex
              LEFT JOIN rankedCost currentCost
                ON currentCost.listingKey=scope.listingKey
               AND currentCost.currentRank=1
              WHERE scope.channel='walmart'
                AND scope.manifestSha256=?
                AND donor.title IS NOT NULL
                AND TRIM(donor.title)=donor.title
                AND LENGTH(donor.title)>=3
              ORDER BY component.donorProductId,scope.listingKey,
                       component.componentIndex,offer.id`,
        args: [manifestSha256],
      })
    ).rows;
  } catch (error) {
    fail(
      "STANDING_WAVE_DATABASE_READ_FAILED",
      "candidate ranking queries failed",
      error,
    );
  }
  const attempted = attemptedDonorIds(historyRows);
  const groups = new Map<string, CandidateAccumulator>();
  for (const row of rows) {
    const currentCostOutcome = rowText(row, "currentCostOutcome");
    if (
      currentCostOutcome !== "MISSING"
      && currentCostOutcome !== "UNSOURCEABLE"
    ) {
      continue;
    }
    const donorProductId = rowText(row, "donorProductId");
    if (attempted.has(donorProductId)) continue;
    let group = groups.get(donorProductId);
    if (!group) {
      group = {
        donorProductId,
        canonicalVariantIds: new Set(),
        variantDecisionIds: new Set(),
        offers: new Map(),
        query: rowText(row, "donorTitle"),
        listings: new Map(),
      };
      groups.set(donorProductId, group);
    }
    group.canonicalVariantIds.add(rowText(row, "targetCanonicalVariantId"));
    group.variantDecisionIds.add(rowText(row, "variantDecisionId"));
    const donorOfferId = rowText(row, "donorOfferId");
    group.offers.set(donorOfferId, {
      donorOfferId,
      retailerProductId: rowText(row, "retailerProductId"),
    });
    const listingKey = rowText(row, "listingKey");
    const existing = group.listings.get(listingKey);
    const candidateListing = {
      listingKey,
      sku: rowText(row, "sku"),
      componentIndex: rowInteger(row, "componentIndex"),
      currentCostOutcome,
      sales180: rowNumber(row, "sales180"),
      units180: rowNumber(row, "units180"),
    } as const;
    if (
      existing
      && (
        existing.componentIndex !== candidateListing.componentIndex
        || existing.currentCostOutcome !== candidateListing.currentCostOutcome
      )
    ) {
      group.canonicalVariantIds.add(
        `MULTI_COMPONENT_CONFLICT:${listingKey}`,
      );
    } else {
      group.listings.set(listingKey, candidateListing);
    }
  }
  const candidates: ProductTruthStandingWaveCandidate[] = [];
  for (const group of groups.values()) {
    if (
      group.canonicalVariantIds.size !== 1
      || group.variantDecisionIds.size !== 1
      || group.offers.size !== 1
      || group.listings.size < 1
      || group.listings.size > PRODUCT_TRUTH_STANDING_WAVE_MAX_LINKED_LISTINGS
    ) {
      continue;
    }
    const listings = [...group.listings.values()];
    const representative = [...listings].sort(
      (left, right) =>
        right.sales180 - left.sales180
        || right.units180 - left.units180
        || left.listingKey.localeCompare(right.listingKey, "en-US"),
    )[0];
    const offer = [...group.offers.values()][0];
    candidates.push(
      parseCandidate(
        {
          donorProductId: group.donorProductId,
          canonicalVariantId: [...group.canonicalVariantIds][0],
          variantDecisionId: [...group.variantDecisionIds][0],
          donorOfferId: offer.donorOfferId,
          retailerProductId: offer.retailerProductId,
          query: group.query,
          representative: {
            listingKey: representative.listingKey,
            sku: representative.sku,
            componentIndex: representative.componentIndex,
          },
          linkedListingKeys: listings
            .map((listing) => listing.listingKey)
            .sort((left, right) => left.localeCompare(right, "en-US")),
          currentCostOutcomes: {
            missing: listings.filter(
              (listing) => listing.currentCostOutcome === "MISSING",
            ).length,
            unsourceable: listings.filter(
              (listing) => listing.currentCostOutcome === "UNSOURCEABLE",
            ).length,
          },
          impact: {
            convertibleListings: listings.length,
            sales180: listings.reduce(
              (total, listing) => total + listing.sales180,
              0,
            ),
            units180: listings.reduce(
              (total, listing) => total + listing.units180,
              0,
            ),
          },
          priorAttemptCount: 0,
        },
        `candidate.${group.donorProductId}`,
      ),
    );
  }
  return candidates.sort(compareCandidates).slice(0, limit);
}

export function validateSealedProductTruthStandingWavePlan(
  value: unknown,
): SealedProductTruthStandingWavePlan {
  if (!isRecord(value)) {
    fail("STANDING_WAVE_SEAL_INVALID", "sealed plan must be an object");
  }
  exactKeys(value, ["plan", "planSha256"], "sealedPlan");
  const plan = parseProductTruthStandingWavePlan(value.plan);
  const planSha256 = exactSha256(value.planSha256, "sealedPlan.planSha256");
  if (productTruthStandingWavePlanSha256(plan) !== planSha256) {
    fail("STANDING_WAVE_SEAL_INVALID", "plan SHA-256 does not match its bytes");
  }
  return { plan, planSha256 };
}
