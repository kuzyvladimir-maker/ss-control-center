import { createHash } from "node:crypto";

import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
} from "./product-truth-component-acquisition-scope";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgePlan,
  type ProductTruthLegacyBridgeSnapshot,
} from "./product-truth-legacy-bridge";
import {
  normalizeIdentityTokens,
  type CanonicalProductIdentity,
} from "./canonical-product-match";
import { renderProductTruthOperationalJson } from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION =
  "product-truth-search-query-calibration/1.0.0" as const;
export const PRODUCT_TRUTH_PROVIDER_QUERY_CURRENT_VERSION =
  "product-truth-provider-query/current-v1" as const;
export const PRODUCT_TRUTH_PROVIDER_QUERY_FORM_AUGMENTED_VERSION =
  "product-truth-provider-query/form-augmented-v1" as const;

export const PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_POLICY = Object.freeze({
  minimumPositiveCasesPerForm: 10,
  maximumPositiveRank: 10,
  rankTieBreak: "DONOR_PRODUCT_ID_ASC" as const,
  lexicalScoring: "BINARY_TITLE_TOKEN_IDF_WITH_QUERY_TERM_FREQUENCY" as const,
  formAdmission:
    "ZERO_RANK_DEGRADATIONS_AND_NONDECREASING_TOP5_TOP10_AND_IMPROVED_MRR" as const,
});

type QueryMetrics = {
  denominator: number;
  top1: number;
  top5: number;
  top10: number;
  meanReciprocalRank: number;
};

type RankedPositiveCase = {
  querySurfaceHash: string;
  canonicalVariantId: string;
  donorProductId: string;
  form: string | null;
  currentQuery: string;
  formAugmentedQuery: string;
  currentRank: number;
  formAugmentedRank: number;
};

export interface ProductTruthSearchQueryCalibration {
  schemaVersion: typeof PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION;
  generatedAt: string;
  source: {
    bridgeSnapshot: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION;
      sha256: string;
      capturedAt: string;
      donors: number;
      canonicalBindings: number;
    };
    bridgePlan: {
      schemaVersion: typeof PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION;
      sha256: string;
      generatedAt: string;
      listingScopes: number;
    };
    componentScope: {
      schemaVersion: typeof PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION;
      sha256: string;
      generatedAt: string;
      providerTargets: number;
    };
  };
  policy: typeof PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_POLICY;
  queryContracts: {
    current: typeof PRODUCT_TRUTH_PROVIDER_QUERY_CURRENT_VERSION;
    candidate: typeof PRODUCT_TRUTH_PROVIDER_QUERY_FORM_AUGMENTED_VERSION;
  };
  positiveDenominator: {
    canonicalBindingsInSnapshot: number;
    canonicalVariantsRepresented: number;
    distinctKnownPositiveQuerySurfaces: number;
    lexicalCorpusDonors: number;
  };
  currentMetrics: QueryMetrics;
  calibratedMetrics: QueryMetrics;
  comparison: {
    improvedCases: number;
    unchangedCases: number;
    degradedCases: number;
  };
  formGroups: Array<{
    form: string;
    admitted: boolean;
    blockers: string[];
    currentMetrics: QueryMetrics;
    formAugmentedMetrics: QueryMetrics;
    improvedCases: number;
    unchangedCases: number;
    degradedCases: number;
  }>;
  admittedForms: string[];
  positiveCases: RankedPositiveCase[];
  admittedProviderTargets: Array<{
    acquisitionPriority: number;
    canonicalVariantId: string;
    canonicalIdentityHash: string;
    form: string;
    currentQuery: string;
    calibratedQuery: string;
    dependentListings: number;
    immediateClosableListings: number;
  }>;
  counts: {
    providerTargets: number;
    admittedProviderTargets: number;
    admittedDependentListings: number;
    admittedImmediateClosures: number;
  };
  paidWaveAdmission:
    | "CALIBRATED_FORM_QUERY_TARGETS_AVAILABLE"
    | "BLOCKED_NO_DEMONSTRATED_QUERY_IMPROVEMENT";
  claims: {
    readOnlyInputs: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    predictsProviderResults: false;
  };
}

export class ProductTruthSearchQueryCalibrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthSearchQueryCalibrationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthSearchQueryCalibrationError(code, message);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("SEARCH_QUERY_CALIBRATION_INPUT_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("SEARCH_QUERY_CALIBRATION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("SEARCH_QUERY_CALIBRATION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function queryParts(identity: CanonicalProductIdentity): string[] {
  return [
    identity.brand,
    identity.productLine,
    identity.flavor,
    identity.size,
  ].flatMap((value) => (
    typeof value === "string" && value.trim() ? [value.trim()] : []
  ));
}

export function currentProductTruthProviderQuery(
  identity: CanonicalProductIdentity,
): string {
  return [...new Set(queryParts(identity))].join(" ");
}

function normalizedForm(identity: CanonicalProductIdentity): string | null {
  const tokens = normalizeIdentityTokens(identity.form);
  return tokens.length === 1 ? tokens[0]! : null;
}

export function formAugmentedProductTruthProviderQuery(
  identity: CanonicalProductIdentity,
): string {
  const form = typeof identity.form === "string" ? identity.form.trim() : "";
  const values = [
    identity.brand,
    identity.productLine,
    identity.flavor,
    form || null,
    identity.size,
  ].flatMap((value) => (
    typeof value === "string" && value.trim() ? [value.trim()] : []
  ));
  return [...new Set(values)].join(" ");
}

export function calibratedProductTruthProviderQuery(input: {
  identity: CanonicalProductIdentity;
  admittedForms: readonly string[];
}): {
  queryVersion:
    | typeof PRODUCT_TRUTH_PROVIDER_QUERY_CURRENT_VERSION
    | typeof PRODUCT_TRUTH_PROVIDER_QUERY_FORM_AUGMENTED_VERSION;
  query: string;
  form: string | null;
  calibrated: boolean;
} {
  const form = normalizedForm(input.identity);
  if (form && input.admittedForms.includes(form)) {
    return {
      queryVersion: PRODUCT_TRUTH_PROVIDER_QUERY_FORM_AUGMENTED_VERSION,
      query: formAugmentedProductTruthProviderQuery(input.identity),
      form,
      calibrated: true,
    };
  }
  return {
    queryVersion: PRODUCT_TRUTH_PROVIDER_QUERY_CURRENT_VERSION,
    query: currentProductTruthProviderQuery(input.identity),
    form,
    calibrated: false,
  };
}

function lexicalTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12));
}

function metrics(ranks: readonly number[]): QueryMetrics {
  return {
    denominator: ranks.length,
    top1: ranks.filter((rank) => rank <= 1).length,
    top5: ranks.filter((rank) => rank <= 5).length,
    top10: ranks.filter((rank) => rank <= 10).length,
    meanReciprocalRank: roundMetric(
      ranks.reduce((sum, rank) => sum + 1 / rank, 0) / Math.max(1, ranks.length),
    ),
  };
}

function comparison(cases: readonly RankedPositiveCase[]): {
  improvedCases: number;
  unchangedCases: number;
  degradedCases: number;
} {
  return {
    improvedCases: cases.filter(
      (entry) => entry.formAugmentedRank < entry.currentRank,
    ).length,
    unchangedCases: cases.filter(
      (entry) => entry.formAugmentedRank === entry.currentRank,
    ).length,
    degradedCases: cases.filter(
      (entry) => entry.formAugmentedRank > entry.currentRank,
    ).length,
  };
}

function validateBoundSource(input: {
  json: string;
  sha256: string;
  rendered: string;
  label: string;
}): string {
  const sha256 = exactSha(input.sha256, `${input.label} SHA-256`);
  if (sha256Text(input.json) !== sha256) {
    fail("SEARCH_QUERY_CALIBRATION_SOURCE_SHA_MISMATCH", input.label);
  }
  if (input.rendered !== input.json) {
    fail("SEARCH_QUERY_CALIBRATION_SOURCE_NOT_CANONICAL", input.label);
  }
  return sha256;
}

type LexicalDonor = {
  id: string;
  title: string;
  tokens: Set<string>;
};

function lexicalRank(input: {
  donorId: string;
  query: string;
  donors: readonly LexicalDonor[];
  inverseDocumentFrequency: ReadonlyMap<string, number>;
}): number {
  const queryFrequency = new Map<string, number>();
  for (const token of lexicalTokens(input.query)) {
    queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);
  }
  if (!queryFrequency.size) {
    fail("SEARCH_QUERY_CALIBRATION_QUERY_EMPTY", input.donorId);
  }
  const score = (donor: LexicalDonor): number => {
    let total = 0;
    for (const [token, frequency] of queryFrequency) {
      if (donor.tokens.has(token)) {
        total += (input.inverseDocumentFrequency.get(token) ?? 0) * frequency;
      }
    }
    return total;
  };
  const positive = input.donors.find((donor) => donor.id === input.donorId);
  if (!positive) fail("SEARCH_QUERY_CALIBRATION_DONOR_MISSING", input.donorId);
  const positiveScore = score(positive);
  const epsilon = 1e-12;
  return 1 + input.donors.filter((donor) => {
    const donorScore = score(donor);
    return donorScore > positiveScore + epsilon
      || (
        Math.abs(donorScore - positiveScore) <= epsilon
        && donor.id.localeCompare(input.donorId, "en-US") < 0
      );
  }).length;
}

export function compileProductTruthSearchQueryCalibration(input: {
  generatedAt: string;
  bridgeSnapshot: ProductTruthLegacyBridgeSnapshot;
  bridgeSnapshotJson: string;
  bridgeSnapshotSha256: string;
  bridgePlan: ProductTruthLegacyBridgePlan;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  componentScope: ProductTruthComponentAcquisitionScope;
  componentScopeJson: string;
  componentScopeSha256: string;
}): ProductTruthSearchQueryCalibration {
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  if (
    input.bridgeSnapshot.schemaVersion
      !== PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION
    || input.bridgePlan.schemaVersion !== PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION
    || input.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
  ) {
    fail("SEARCH_QUERY_CALIBRATION_SOURCE_VERSION_INVALID", "unsupported source schema");
  }
  const bridgeSnapshotSha256 = validateBoundSource({
    json: input.bridgeSnapshotJson,
    sha256: input.bridgeSnapshotSha256,
    rendered: renderProductTruthLegacyBridgeSnapshot(input.bridgeSnapshot),
    label: "bridge snapshot",
  });
  const bridgePlanSha256 = validateBoundSource({
    json: input.bridgePlanJson,
    sha256: input.bridgePlanSha256,
    rendered: renderProductTruthLegacyBridgePlan(input.bridgePlan),
    label: "bridge plan",
  });
  const componentScopeSha256 = validateBoundSource({
    json: input.componentScopeJson,
    sha256: input.componentScopeSha256,
    rendered: renderProductTruthComponentAcquisitionScope(input.componentScope),
    label: "component scope",
  });
  if (
    input.bridgePlan.source.snapshotSha256 !== bridgeSnapshotSha256
    || input.componentScope.source.bridgeSnapshot.sha256 !== bridgeSnapshotSha256
    || input.bridgePlan.source.targetFingerprint
      !== input.componentScope.source.bridgeSnapshot.targetFingerprint
  ) {
    fail(
      "SEARCH_QUERY_CALIBRATION_SOURCE_BINDING_MISMATCH",
      "snapshot, bridge plan and component scope are not one exact source chain",
    );
  }

  const donorById = new Map<string, ProductTruthLegacyBridgeSnapshot["donors"][number]>();
  const lexicalDonors: LexicalDonor[] = [];
  for (const donor of input.bridgeSnapshot.donors) {
    if (donorById.has(donor.id)) {
      fail("SEARCH_QUERY_CALIBRATION_DONOR_DUPLICATE", donor.id);
    }
    donorById.set(donor.id, donor);
    const title = donor.title?.trim();
    if (title) {
      lexicalDonors.push({
        id: donor.id,
        title,
        tokens: new Set(lexicalTokens(title)),
      });
    }
  }
  lexicalDonors.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  const documentFrequency = new Map<string, number>();
  for (const donor of lexicalDonors) {
    for (const token of donor.tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const inverseDocumentFrequency = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    inverseDocumentFrequency.set(
      token,
      Math.log(
        1 + (lexicalDonors.length - frequency + 0.5) / (frequency + 0.5),
      ),
    );
  }

  const bindingByVariant = new Map(
    input.bridgeSnapshot.canonicalDonorBindings
      .filter((binding) => binding.decisionStatus === "exact_confirmed")
      .map((binding) => [binding.canonicalVariantId, binding]),
  );
  const positiveBySurface = new Map<string, {
    querySurfaceHash: string;
    canonicalVariantId: string;
    donorProductId: string;
    form: string | null;
    currentQuery: string;
    formAugmentedQuery: string;
  }>();
  for (const scope of input.bridgePlan.scopes) {
    for (const component of scope.components) {
      const canonicalVariantId = component.targetVariant?.canonicalVariantId;
      if (!canonicalVariantId || !component.targetIdentity) continue;
      const binding = bindingByVariant.get(canonicalVariantId);
      if (!binding || !donorById.get(binding.donorProductId)?.title?.trim()) continue;
      const currentQuery =
        currentProductTruthProviderQuery(component.targetIdentity);
      const formAugmentedQuery =
        formAugmentedProductTruthProviderQuery(component.targetIdentity);
      const form = normalizedForm(component.targetIdentity);
      const querySurfaceHash = sha256Text(renderProductTruthOperationalJson({
        canonicalVariantId,
        donorProductId: binding.donorProductId,
        form,
        currentTokens: lexicalTokens(currentQuery),
        formAugmentedTokens: lexicalTokens(formAugmentedQuery),
      }));
      const candidate = {
        querySurfaceHash,
        canonicalVariantId,
        donorProductId: binding.donorProductId,
        form,
        currentQuery,
        formAugmentedQuery,
      };
      const existing = positiveBySurface.get(querySurfaceHash);
      if (
        !existing
        || renderProductTruthOperationalJson(candidate)
          < renderProductTruthOperationalJson(existing)
      ) {
        positiveBySurface.set(querySurfaceHash, candidate);
      }
    }
  }
  if (!positiveBySurface.size) {
    fail("SEARCH_QUERY_CALIBRATION_POSITIVE_EMPTY", "no exact positive cases");
  }

  const positiveCases: RankedPositiveCase[] = [...positiveBySurface.values()]
    .map((positive) => {
      return {
        querySurfaceHash: positive.querySurfaceHash,
        canonicalVariantId: positive.canonicalVariantId,
        donorProductId: positive.donorProductId,
        form: positive.form,
        currentQuery: positive.currentQuery,
        formAugmentedQuery: positive.formAugmentedQuery,
        currentRank: lexicalRank({
          donorId: positive.donorProductId,
          query: positive.currentQuery,
          donors: lexicalDonors,
          inverseDocumentFrequency,
        }),
        formAugmentedRank: lexicalRank({
          donorId: positive.donorProductId,
          query: positive.formAugmentedQuery,
          donors: lexicalDonors,
          inverseDocumentFrequency,
        }),
      };
    })
    .sort((left, right) =>
      left.canonicalVariantId.localeCompare(right.canonicalVariantId, "en-US")
      || left.querySurfaceHash.localeCompare(right.querySurfaceHash, "en-US"));

  const casesByForm = new Map<string, RankedPositiveCase[]>();
  for (const entry of positiveCases) {
    if (!entry.form) continue;
    const rows = casesByForm.get(entry.form) ?? [];
    rows.push(entry);
    casesByForm.set(entry.form, rows);
  }
  const formGroups: ProductTruthSearchQueryCalibration["formGroups"] =
    [...casesByForm]
      .map(([form, cases]) => {
        const currentMetrics = metrics(cases.map((entry) => entry.currentRank));
        const formAugmentedMetrics = metrics(
          cases.map((entry) => entry.formAugmentedRank),
        );
        const compared = comparison(cases);
        const blockers: string[] = [];
        if (
          cases.length
          < PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_POLICY.minimumPositiveCasesPerForm
        ) {
          blockers.push("POSITIVE_DENOMINATOR_TOO_SMALL");
        }
        if (compared.improvedCases === 0) blockers.push("NO_RANK_IMPROVEMENT");
        if (compared.degradedCases > 0) blockers.push("POSITIVE_RANK_DEGRADATION");
        if (formAugmentedMetrics.top5 < currentMetrics.top5) {
          blockers.push("TOP5_RECALL_DECREASED");
        }
        if (formAugmentedMetrics.top10 < currentMetrics.top10) {
          blockers.push("TOP10_RECALL_DECREASED");
        }
        if (
          formAugmentedMetrics.meanReciprocalRank
          <= currentMetrics.meanReciprocalRank
        ) {
          blockers.push("MEAN_RECIPROCAL_RANK_NOT_IMPROVED");
        }
        return {
          form,
          admitted: blockers.length === 0,
          blockers,
          currentMetrics,
          formAugmentedMetrics,
          ...compared,
        };
      })
      .sort((left, right) => left.form.localeCompare(right.form, "en-US"));
  const admittedForms = formGroups
    .filter((group) => group.admitted)
    .map((group) => group.form);
  const calibratedCases = positiveCases.map((entry) => (
    entry.form && admittedForms.includes(entry.form)
      ? entry
      : {
          ...entry,
          formAugmentedQuery: entry.currentQuery,
          formAugmentedRank: entry.currentRank,
        }
  ));
  const compared = comparison(calibratedCases);
  const currentMetrics = metrics(
    positiveCases.map((entry) => entry.currentRank),
  );
  const calibratedMetrics = metrics(
    calibratedCases.map((entry) => entry.formAugmentedRank),
  );
  if (
    admittedForms.length > 0
    && (
      compared.degradedCases > 0
      || calibratedMetrics.top5 < currentMetrics.top5
      || calibratedMetrics.top10 < currentMetrics.top10
      || calibratedMetrics.meanReciprocalRank
        <= currentMetrics.meanReciprocalRank
    )
  ) {
    fail(
      "SEARCH_QUERY_CALIBRATION_GLOBAL_REGRESSION",
      "admitted form groups do not improve the complete positive denominator",
    );
  }

  const providerTargets = input.componentScope.targets.filter(
    (target) => target.acquisitionLane === "PROVIDER_IDENTITY_ACQUISITION",
  );
  const admittedProviderTargets = providerTargets
    .flatMap((target) => {
      const calibrated = calibratedProductTruthProviderQuery({
        identity: target.targetIdentity,
        admittedForms,
      });
      if (!calibrated.calibrated || !calibrated.form) return [];
      return [{
        acquisitionPriority: target.acquisitionPriority,
        canonicalVariantId: target.canonicalVariantId,
        canonicalIdentityHash: target.canonicalIdentityHash,
        form: calibrated.form,
        currentQuery: currentProductTruthProviderQuery(target.targetIdentity),
        calibratedQuery: calibrated.query,
        dependentListings: target.impact.dependentListings,
        immediateClosableListings: target.impact.immediateClosableListings,
      }];
    })
    .sort((left, right) =>
      left.acquisitionPriority - right.acquisitionPriority
      || left.canonicalVariantId.localeCompare(
        right.canonicalVariantId,
        "en-US",
      ));

  return {
    schemaVersion: PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION,
    generatedAt,
    source: {
      bridgeSnapshot: {
        schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
        sha256: bridgeSnapshotSha256,
        capturedAt: input.bridgeSnapshot.capturedAt,
        donors: input.bridgeSnapshot.donors.length,
        canonicalBindings:
          input.bridgeSnapshot.canonicalDonorBindings.length,
      },
      bridgePlan: {
        schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
        sha256: bridgePlanSha256,
        generatedAt: input.bridgePlan.generatedAt,
        listingScopes: input.bridgePlan.scopes.length,
      },
      componentScope: {
        schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
        sha256: componentScopeSha256,
        generatedAt: input.componentScope.generatedAt,
        providerTargets: providerTargets.length,
      },
    },
    policy: PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_POLICY,
    queryContracts: {
      current: PRODUCT_TRUTH_PROVIDER_QUERY_CURRENT_VERSION,
      candidate: PRODUCT_TRUTH_PROVIDER_QUERY_FORM_AUGMENTED_VERSION,
    },
    positiveDenominator: {
      canonicalBindingsInSnapshot:
        input.bridgeSnapshot.canonicalDonorBindings.length,
      canonicalVariantsRepresented: new Set(
        positiveCases.map((entry) => entry.canonicalVariantId),
      ).size,
      distinctKnownPositiveQuerySurfaces: positiveCases.length,
      lexicalCorpusDonors: lexicalDonors.length,
    },
    currentMetrics,
    calibratedMetrics,
    comparison: compared,
    formGroups,
    admittedForms,
    positiveCases,
    admittedProviderTargets,
    counts: {
      providerTargets: providerTargets.length,
      admittedProviderTargets: admittedProviderTargets.length,
      admittedDependentListings: admittedProviderTargets.reduce(
        (sum, target) => sum + target.dependentListings,
        0,
      ),
      admittedImmediateClosures: admittedProviderTargets.reduce(
        (sum, target) => sum + target.immediateClosableListings,
        0,
      ),
    },
    paidWaveAdmission: admittedProviderTargets.length
      ? "CALIBRATED_FORM_QUERY_TARGETS_AVAILABLE"
      : "BLOCKED_NO_DEMONSTRATED_QUERY_IMPROVEMENT",
    claims: {
      readOnlyInputs: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      predictsProviderResults: false,
    },
  };
}

export function renderProductTruthSearchQueryCalibration(
  value: ProductTruthSearchQueryCalibration,
): string {
  return renderProductTruthOperationalJson(value);
}

export function parseProductTruthSearchQueryCalibration(
  value: unknown,
): ProductTruthSearchQueryCalibration {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (value as { schemaVersion?: unknown }).schemaVersion
      !== PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION
  ) {
    fail("SEARCH_QUERY_CALIBRATION_INVALID", "unsupported calibration artifact");
  }
  const calibration = value as ProductTruthSearchQueryCalibration;
  const admittedForms = Array.isArray(calibration.admittedForms)
    ? calibration.admittedForms
    : [];
  const formGroups = Array.isArray(calibration.formGroups)
    ? calibration.formGroups
    : [];
  const admittedFromGroups = formGroups
    .filter((group) => group.admitted === true && group.blockers.length === 0)
    .map((group) => group.form);
  if (
    renderProductTruthOperationalJson(calibration.policy)
      !== renderProductTruthOperationalJson(
        PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_POLICY,
      )
    || calibration.queryContracts?.current
      !== PRODUCT_TRUTH_PROVIDER_QUERY_CURRENT_VERSION
    || calibration.queryContracts?.candidate
      !== PRODUCT_TRUTH_PROVIDER_QUERY_FORM_AUGMENTED_VERSION
    || renderProductTruthOperationalJson(admittedForms)
      !== renderProductTruthOperationalJson(
        [...new Set(admittedForms)].sort((left, right) =>
          left.localeCompare(right, "en-US")),
      )
    || renderProductTruthOperationalJson(admittedForms)
      !== renderProductTruthOperationalJson(admittedFromGroups)
    || calibration.comparison?.degradedCases !== 0
    || calibration.calibratedMetrics?.top5
      < calibration.currentMetrics?.top5
    || calibration.calibratedMetrics?.top10
      < calibration.currentMetrics?.top10
    || (
      admittedForms.length > 0
      && calibration.calibratedMetrics?.meanReciprocalRank
        <= calibration.currentMetrics?.meanReciprocalRank
    )
    || calibration.positiveDenominator?.distinctKnownPositiveQuerySurfaces
      !== calibration.positiveCases?.length
    || calibration.counts?.admittedProviderTargets
      !== calibration.admittedProviderTargets?.length
    || calibration.counts?.providerTargets
      !== calibration.source?.componentScope?.providerTargets
    || calibration.paidWaveAdmission
      !== (
        calibration.admittedProviderTargets?.length
          ? "CALIBRATED_FORM_QUERY_TARGETS_AVAILABLE"
          : "BLOCKED_NO_DEMONSTRATED_QUERY_IMPROVEMENT"
      )
    || renderProductTruthOperationalJson(calibration.claims)
      !== renderProductTruthOperationalJson({
        readOnlyInputs: true,
        databaseWrites: 0,
        providerCalls: 0,
        paidCalls: 0,
        retailerFetches: 0,
        marketplaceMutations: 0,
        authorizesExecution: false,
        predictsProviderResults: false,
      })
  ) {
    fail(
      "SEARCH_QUERY_CALIBRATION_INVALID",
      "calibration invariants are inconsistent",
    );
  }
  const admittedTargetIds = new Set<string>();
  for (const target of calibration.admittedProviderTargets) {
    if (
      admittedTargetIds.has(target.canonicalVariantId)
      || !admittedForms.includes(target.form)
      || !target.currentQuery
      || !target.calibratedQuery
      || target.currentQuery === target.calibratedQuery
    ) {
      fail(
        "SEARCH_QUERY_CALIBRATION_INVALID",
        "admitted target set is inconsistent",
      );
    }
    admittedTargetIds.add(target.canonicalVariantId);
  }
  if (
    renderProductTruthSearchQueryCalibration(calibration)
    !== renderProductTruthOperationalJson(value)
  ) {
    fail("SEARCH_QUERY_CALIBRATION_INVALID", "artifact is not canonical");
  }
  return calibration;
}

export function validateBoundProductTruthSearchQueryCalibration(input: {
  calibration: unknown;
  json: string;
  sha256: string;
}): ProductTruthSearchQueryCalibration {
  const sha256 = exactSha(input.sha256, "search calibration SHA-256");
  if (sha256Text(input.json) !== sha256) {
    fail(
      "SEARCH_QUERY_CALIBRATION_SOURCE_SHA_MISMATCH",
      "search calibration bytes changed",
    );
  }
  let parsedBytes: unknown;
  try {
    parsedBytes = JSON.parse(input.json);
  } catch {
    fail("SEARCH_QUERY_CALIBRATION_INVALID", "calibration JSON is invalid");
  }
  if (
    renderProductTruthOperationalJson(parsedBytes)
      !== renderProductTruthOperationalJson(input.calibration)
  ) {
    fail(
      "SEARCH_QUERY_CALIBRATION_SOURCE_NOT_CANONICAL",
      "parsed calibration and supplied value differ",
    );
  }
  const calibration = parseProductTruthSearchQueryCalibration(parsedBytes);
  if (renderProductTruthSearchQueryCalibration(calibration) !== input.json) {
    fail(
      "SEARCH_QUERY_CALIBRATION_SOURCE_NOT_CANONICAL",
      "search calibration is not canonical JSON",
    );
  }
  return calibration;
}

export function targetHasAdmittedCalibratedQuery(input: {
  target: ProductTruthComponentAcquisitionTarget;
  calibration: ProductTruthSearchQueryCalibration;
}): boolean {
  const form = normalizedForm(input.target.targetIdentity);
  return !!form && input.calibration.admittedForms.includes(form);
}
