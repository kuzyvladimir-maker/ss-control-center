import { createHash } from "node:crypto";

import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionDependency,
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
} from "./product-truth-component-acquisition-scope";
import {
  PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION,
  parseProductTruthOperationalPlanRequest,
  type ProductTruthOperationalPlanRequest,
} from "./product-truth-operational-plan-request";
import {
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  calibratedProductTruthProviderQuery,
  PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION,
  validateBoundProductTruthSearchQueryCalibration,
  type ProductTruthSearchQueryCalibration,
} from "./product-truth-search-query-calibration";
import {
  PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
  renderProductTruthSourceDetailAdmission,
  type ProductTruthSourceDetailAdmission,
  type ProductTruthSourceDetailAdmissionCandidate,
} from "./product-truth-source-detail-admission";

export const PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION =
  "product-truth-provider-attempt-capture/1.0.0" as const;
export const PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_VERSION =
  "product-truth-provider-target-wave/1.3.0" as const;
export const PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS = 16;

const TERMINAL_ITEM_STATUSES = [
  "done",
  "terminal_gap",
  "blocked",
  "ambiguous",
  "failed",
] as const;

export type ProductTruthProviderTerminalItemStatus =
  (typeof TERMINAL_ITEM_STATUSES)[number];

export interface ProductTruthProviderAttemptCaptureRow {
  runId: string;
  planSha256: string;
  listingKey: string;
  itemStatus: ProductTruthProviderTerminalItemStatus;
  stage: string;
  finishedAt: string;
  providerCalls: number;
  providerUnits: number;
  targetCanonicalVariantIds: string[];
}

export interface ProductTruthProviderAttemptCapture {
  schemaVersion: typeof PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION;
  capturedAt: string;
  databaseTargetFingerprint: string;
  attempts: ProductTruthProviderAttemptCaptureRow[];
  claims: {
    readOnlyDatabase: true;
    databaseWrites: 0;
    providerCalls: 0;
    marketplaceMutations: 0;
  };
}

export interface ProductTruthProviderTargetWaveTarget {
  ordinal: number;
  acquisitionPriority: number;
  canonicalVariantId: string;
  canonicalIdentityHash: string;
  queryVersion:
    ProductTruthSearchQueryCalibration["queryContracts"]["candidate"];
  query: string;
  sourceDetailCandidate: ProductTruthSourceDetailAdmissionCandidate;
  targetIdentity: ProductTruthComponentAcquisitionTarget["targetIdentity"];
  representative: {
    listingKey: string;
    channel: "amazon" | "walmart";
    storeIndex: number;
    sku: string;
    componentIndex: number;
    quantity: number;
    priority: ProductTruthComponentAcquisitionDependency["priority"];
  };
  impact: ProductTruthComponentAcquisitionTarget["impact"];
  dependentListingKeys: string[];
}

export interface ProductTruthProviderTargetWave {
  schemaVersion: typeof PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_VERSION;
  waveId: string;
  generatedAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  authoritativeManifestSha256: string;
  source: {
    componentAcquisitionScope: {
      schemaVersion:
        typeof PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION;
      sha256: string;
      generatedAt: string;
    };
    searchQueryCalibration: {
      schemaVersion:
        typeof PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION;
      sha256: string;
      generatedAt: string;
      admittedForms: string[];
      admittedProviderTargets: number;
    };
    sourceDetailAdmission: {
      schemaVersion:
        typeof PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION;
      sha256: string;
      generatedAt: string;
      admittedTargets: number;
    };
    terminalAttemptCapture: {
      schemaVersion:
        typeof PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION;
      sha256: string;
      capturedAt: string;
      attemptCount: number;
    };
  };
  selectionPolicy: {
    unitOfWork: "UNIQUE_CANONICAL_COMPONENT_TARGET";
    representative:
      "ONE_VALID_SINGLE_TARGET_LISTING_HIGHEST_SALES_THEN_WALMART_THEN_REPAIR_PRIORITY";
    terminalAttemptPolicy:
      "EXCLUDE_EXPLICIT_TARGET_OR_SINGLE_TARGET_LISTING_AFTER_METERED_TERMINAL_ATTEMPT";
    queryAdmission:
      "EXACT_TARGET_AND_QUERY_MUST_BE_ADMITTED_BY_BOUND_NONREGRESSING_CALIBRATION";
    sourceDetailAdmission:
      "EXACT_TARGET_AND_RETAILER_ITEM_MUST_BE_ADMITTED_BY_BOUND_FAIL_CLOSED_ARTIFACT";
    retailers: readonly ["walmart", "target"];
    procurementZip: "33765";
    maximumTargets: number;
    exactCanonicalVariantIds: string[];
    maximumProviderUnits: number;
    retryAllowed: false;
    clubsAllowed: false;
    bjsAllowed: false;
  };
  counts: {
    providerTargets: number;
    calibrationAdmittedProviderTargets: number;
    calibrationExcludedProviderTargets: number;
    sourceDetailAdmittedProviderTargets: number;
    sourceDetailExcludedCalibratedTargets: number;
    terminalAttemptTargets: number;
    noSingleTargetRepresentative: number;
    eligibleTargets: number;
    selectedTargets: number;
    selectedDependentListings: number;
    selectedImmediateClosures: number;
  };
  terminalAttemptTargets: Array<{
    canonicalVariantId: string;
    attempts: Array<{
      runId: string;
      planSha256: string;
      listingKey: string;
      itemStatus: ProductTruthProviderTerminalItemStatus;
      finishedAt: string;
      providerCalls: number;
      providerUnits: number;
    }>;
  }>;
  targetsWithoutSingleTargetRepresentative: Array<{
    canonicalVariantId: string;
    acquisitionPriority: number;
    dependentListingKeys: string[];
  }>;
  targets: ProductTruthProviderTargetWaveTarget[];
  operationalRequest: ProductTruthOperationalPlanRequest;
  claims: {
    createsParallelCatalog: false;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    marketplaceMutations: 0;
    procurementMutations: 0;
    consumerActivation: false;
    authorizesExecution: false;
  };
}

export class ProductTruthProviderTargetWaveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthProviderTargetWaveError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthProviderTargetWaveError(code, message);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum = 500): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_INPUT_INVALID",
      `${label} must be 1-${maximum} exact characters`,
    );
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 100);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return text;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", `${label} must be a non-negative integer`);
  }
  return Number(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", `${label} must be a non-negative number`);
  }
  return value;
}

function canonicalVariantId(value: unknown, label: string): string {
  const text = exactText(value, label, 100);
  if (!/^cpv1:[a-f0-9]{64}$/.test(text)) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", `${label} is not a canonical variant ID`);
  }
  return text;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function validateAttemptCapture(
  value: ProductTruthProviderAttemptCapture,
  json: string,
  expectedSha256: string,
): ProductTruthProviderAttemptCapture {
  if (sha256Text(json) !== exactSha(expectedSha256, "attempt capture SHA-256")) {
    fail("PROVIDER_TARGET_WAVE_SOURCE_SHA_MISMATCH", "attempt capture bytes changed");
  }
  if (value.schemaVersion !== PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", "attempt capture schema is unsupported");
  }
  const capturedAt = canonicalInstant(value.capturedAt, "attempt capture capturedAt");
  const databaseTargetFingerprint = exactSha(
    value.databaseTargetFingerprint,
    "attempt capture database fingerprint",
  );
  if (!Array.isArray(value.attempts)) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", "attempt capture attempts must be an array");
  }
  const attempts = value.attempts.map((attempt, index) => {
    const providerCalls = nonNegativeInteger(
      attempt.providerCalls,
      `attempts[${index}].providerCalls`,
    );
    if (providerCalls < 1) {
      fail(
        "PROVIDER_TARGET_WAVE_INPUT_INVALID",
        `attempts[${index}] is not a metered attempt`,
      );
    }
    if (!(TERMINAL_ITEM_STATUSES as readonly string[]).includes(attempt.itemStatus)) {
      fail(
        "PROVIDER_TARGET_WAVE_INPUT_INVALID",
        `attempts[${index}] is not terminal`,
      );
    }
    const targetCanonicalVariantIds = stableUnique(
      attempt.targetCanonicalVariantIds.map((target, targetIndex) =>
        canonicalVariantId(
          target,
          `attempts[${index}].targetCanonicalVariantIds[${targetIndex}]`,
        )),
    );
    return {
      runId: exactText(attempt.runId, `attempts[${index}].runId`, 200),
      planSha256: exactSha(
        attempt.planSha256,
        `attempts[${index}].planSha256`,
      ),
      listingKey: exactText(
        attempt.listingKey,
        `attempts[${index}].listingKey`,
        500,
      ),
      itemStatus: attempt.itemStatus,
      stage: exactText(attempt.stage, `attempts[${index}].stage`, 200),
      finishedAt: canonicalInstant(
        attempt.finishedAt,
        `attempts[${index}].finishedAt`,
      ),
      providerCalls,
      providerUnits: nonNegativeNumber(
        attempt.providerUnits,
        `attempts[${index}].providerUnits`,
      ),
      targetCanonicalVariantIds,
    };
  }).sort((left, right) =>
    left.finishedAt.localeCompare(right.finishedAt)
    || left.runId.localeCompare(right.runId, "en-US")
    || left.listingKey.localeCompare(right.listingKey, "en-US"));
  const parsed: ProductTruthProviderAttemptCapture = {
    schemaVersion: PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION,
    capturedAt,
    databaseTargetFingerprint,
    attempts,
    claims: {
      readOnlyDatabase: true,
      databaseWrites: 0,
      providerCalls: 0,
      marketplaceMutations: 0,
    },
  };
  if (renderProductTruthProviderAttemptCapture(parsed) !== json) {
    fail("PROVIDER_TARGET_WAVE_SOURCE_NOT_CANONICAL", "attempt capture is not canonical JSON");
  }
  return parsed;
}

function representativeCompare(
  left: ProductTruthComponentAcquisitionDependency,
  right: ProductTruthComponentAcquisitionDependency,
): number {
  const descending = (
    leftValue: number | null,
    rightValue: number | null,
  ): number => (rightValue ?? -1) - (leftValue ?? -1);
  return descending(left.priority.orders30d, right.priority.orders30d)
    || descending(left.priority.units30d, right.priority.units30d)
    || descending(left.priority.gmv30d, right.priority.gmv30d)
    || (left.channel === right.channel ? 0 : left.channel === "walmart" ? -1 : 1)
    || (left.priority.repairPriority ?? Number.MAX_SAFE_INTEGER)
      - (right.priority.repairPriority ?? Number.MAX_SAFE_INTEGER)
    || left.listingKey.localeCompare(right.listingKey, "en-US")
    || left.componentIndex - right.componentIndex;
}

function targetCompare(
  left: ProductTruthComponentAcquisitionTarget,
  right: ProductTruthComponentAcquisitionTarget,
): number {
  return left.acquisitionPriority - right.acquisitionPriority
    || left.canonicalVariantId.localeCompare(
      right.canonicalVariantId,
      "en-US",
    );
}

export function compileProductTruthProviderTargetWave(input: {
  waveId: string;
  generatedAt: string;
  expiresAt: string;
  databaseTargetFingerprint: string;
  authoritativeManifestSha256: string;
  componentScope: ProductTruthComponentAcquisitionScope;
  componentScopeJson: string;
  componentScopeSha256: string;
  searchQueryCalibration: ProductTruthSearchQueryCalibration;
  searchQueryCalibrationJson: string;
  searchQueryCalibrationSha256: string;
  sourceDetailAdmission: ProductTruthSourceDetailAdmission;
  sourceDetailAdmissionJson: string;
  sourceDetailAdmissionSha256: string;
  attemptCapture: ProductTruthProviderAttemptCapture;
  attemptCaptureJson: string;
  attemptCaptureSha256: string;
  maximumTargets: number;
  exactCanonicalVariantIds?: readonly string[];
}): ProductTruthProviderTargetWave {
  const waveId = exactText(input.waveId, "waveId", 200);
  const generatedAt = canonicalInstant(input.generatedAt, "generatedAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (
    Date.parse(expiresAt) <= Date.parse(generatedAt)
    || Date.parse(expiresAt) - Date.parse(generatedAt) > 24 * 60 * 60 * 1_000
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_INPUT_INVALID",
      "wave lifetime must be positive and at most 24 hours",
    );
  }
  const requestedExactTargetIds = (input.exactCanonicalVariantIds ?? [])
    .map((value, index) =>
      canonicalVariantId(value, `exactCanonicalVariantIds[${index}]`));
  if (
    new Set(requestedExactTargetIds).size !== requestedExactTargetIds.length
    || requestedExactTargetIds.length > input.maximumTargets
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_INPUT_INVALID",
      "exact target selectors must be unique and fit maximumTargets",
    );
  }
  const databaseTargetFingerprint = exactSha(
    input.databaseTargetFingerprint,
    "databaseTargetFingerprint",
  );
  const authoritativeManifestSha256 = exactSha(
    input.authoritativeManifestSha256,
    "authoritativeManifestSha256",
  );
  if (
    !Number.isSafeInteger(input.maximumTargets)
    || input.maximumTargets < 1
    || input.maximumTargets > PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_INPUT_INVALID",
      `maximumTargets must be 1-${PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_MAX_TARGETS}`,
    );
  }
  if (
    input.componentScope.schemaVersion
    !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
  ) {
    fail("PROVIDER_TARGET_WAVE_INPUT_INVALID", "component scope schema is unsupported");
  }
  const componentScopeSha256 = exactSha(
    input.componentScopeSha256,
    "component scope SHA-256",
  );
  if (
    sha256Text(input.componentScopeJson) !== componentScopeSha256
    || renderProductTruthComponentAcquisitionScope(input.componentScope)
      !== input.componentScopeJson
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_SOURCE_SHA_MISMATCH",
      "component scope bytes changed or are not canonical",
    );
  }
  if (
    input.componentScope.source.bridgeSnapshot.targetFingerprint
    !== databaseTargetFingerprint
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_DATABASE_MISMATCH",
      "component scope belongs to another database target",
    );
  }
  const searchQueryCalibration =
    validateBoundProductTruthSearchQueryCalibration({
      calibration: input.searchQueryCalibration,
      json: input.searchQueryCalibrationJson,
      sha256: input.searchQueryCalibrationSha256,
    });
  if (
    searchQueryCalibration.source.componentScope.sha256
      !== componentScopeSha256
    || searchQueryCalibration.source.componentScope.schemaVersion
      !== PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION
    || searchQueryCalibration.paidWaveAdmission
      !== "CALIBRATED_FORM_QUERY_TARGETS_AVAILABLE"
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_CALIBRATION_MISMATCH",
      "search calibration is not admitted for this exact component scope",
    );
  }
  const calibratedTargetById = new Map(
    searchQueryCalibration.admittedProviderTargets.map(
      (target) => [target.canonicalVariantId, target],
    ),
  );
  const sourceDetailAdmissionSha256 = exactSha(
    input.sourceDetailAdmissionSha256,
    "source detail admission SHA-256",
  );
  if (
    input.sourceDetailAdmission.schemaVersion
      !== PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION
    || sha256Text(input.sourceDetailAdmissionJson)
      !== sourceDetailAdmissionSha256
    || renderProductTruthSourceDetailAdmission(
      input.sourceDetailAdmission,
    ) !== input.sourceDetailAdmissionJson
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_SOURCE_DETAIL_ADMISSION_MISMATCH",
      "source detail admission bytes changed or are not canonical",
    );
  }
  if (
    input.sourceDetailAdmission.databaseTargetFingerprint
      !== databaseTargetFingerprint
    || input.sourceDetailAdmission.source.componentAcquisitionScope.sha256
      !== componentScopeSha256
    || input.sourceDetailAdmission.source.searchQueryCalibration.sha256
      !== input.searchQueryCalibrationSha256
    || input.sourceDetailAdmission.claims.authorizesExecution !== false
    || input.sourceDetailAdmission.claims.providerCalls !== 0
    || input.sourceDetailAdmission.claims.paidCalls !== 0
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_SOURCE_DETAIL_ADMISSION_MISMATCH",
      "source detail admission is not bound to this exact target/calibration/database set",
    );
  }
  const sourceDetailAdmissionByTarget = new Map(
    input.sourceDetailAdmission.targets.map(
      (target) => [target.canonicalVariantId, target],
    ),
  );
  const attemptCapture = validateAttemptCapture(
    input.attemptCapture,
    input.attemptCaptureJson,
    input.attemptCaptureSha256,
  );
  if (attemptCapture.databaseTargetFingerprint !== databaseTargetFingerprint) {
    fail(
      "PROVIDER_TARGET_WAVE_DATABASE_MISMATCH",
      "attempt capture belongs to another database target",
    );
  }

  const allProviderTargets = input.componentScope.targets
    .filter((target) =>
      target.acquisitionLane === "PROVIDER_IDENTITY_ACQUISITION")
    .sort(targetCompare);
  const calibratedProviderTargets = allProviderTargets.filter((target) => {
    const calibrated = calibratedTargetById.get(target.canonicalVariantId);
    if (
      !calibrated
      || calibrated.canonicalIdentityHash !== target.canonicalIdentityHash
    ) {
      return false;
    }
    const compiledQuery = calibratedProductTruthProviderQuery({
      identity: target.targetIdentity,
      admittedForms: searchQueryCalibration.admittedForms,
    });
    return compiledQuery.calibrated
      && compiledQuery.queryVersion
        === searchQueryCalibration.queryContracts.candidate
      && compiledQuery.query === calibrated.calibratedQuery
      && calibrated.currentQuery !== calibrated.calibratedQuery;
  });
  const providerTargets = calibratedProviderTargets
    .filter((target) => {
      const admitted = sourceDetailAdmissionByTarget.get(
        target.canonicalVariantId,
      );
      return admitted?.canonicalIdentityHash
        === target.canonicalIdentityHash;
    })
    .sort((left, right) => (
      sourceDetailAdmissionByTarget.get(left.canonicalVariantId)!.ordinal
      - sourceDetailAdmissionByTarget.get(right.canonicalVariantId)!.ordinal
    ));
  const listingTargetIds = new Map<string, Set<string>>();
  for (const target of input.componentScope.targets) {
    for (const dependency of target.dependencies) {
      const targets = listingTargetIds.get(dependency.listingKey)
        ?? new Set<string>();
      targets.add(target.canonicalVariantId);
      listingTargetIds.set(dependency.listingKey, targets);
    }
  }
  const invalidListings = new Set(
    input.componentScope.invalidComponentDependencies.map(
      (dependency) => dependency.listingKey,
    ),
  );

  const terminalByTarget = new Map<
    string,
    ProductTruthProviderAttemptCaptureRow[]
  >();
  for (const attempt of attemptCapture.attempts) {
    const explicit = attempt.targetCanonicalVariantIds;
    const inferred = listingTargetIds.get(attempt.listingKey);
    const targetIds = explicit.length
      ? explicit
      : inferred?.size === 1 ? [...inferred] : [];
    for (const targetId of targetIds) {
      const rows = terminalByTarget.get(targetId) ?? [];
      rows.push(attempt);
      terminalByTarget.set(targetId, rows);
    }
  }

  const targetsWithoutSingleTargetRepresentative: ProductTruthProviderTargetWave[
    "targetsWithoutSingleTargetRepresentative"
  ] = [];
  const eligible: Array<{
    target: ProductTruthComponentAcquisitionTarget;
    representative: ProductTruthComponentAcquisitionDependency;
  }> = [];
  for (const target of providerTargets) {
    if (terminalByTarget.has(target.canonicalVariantId)) continue;
    const candidates = target.dependencies.filter((dependency) => (
      !invalidListings.has(dependency.listingKey)
      && listingTargetIds.get(dependency.listingKey)?.size === 1
    )).sort(representativeCompare);
    if (!candidates.length) {
      targetsWithoutSingleTargetRepresentative.push({
        canonicalVariantId: target.canonicalVariantId,
        acquisitionPriority: target.acquisitionPriority,
        dependentListingKeys: stableUnique(
          target.dependencies.map((dependency) => dependency.listingKey),
        ),
      });
      continue;
    }
    eligible.push({ target, representative: candidates[0]! });
  }
  const selected = requestedExactTargetIds.length
    ? eligible.filter(({ target }) =>
      requestedExactTargetIds.includes(target.canonicalVariantId))
    : eligible.slice(0, input.maximumTargets);
  if (
    requestedExactTargetIds.length
    && (
      selected.length !== requestedExactTargetIds.length
      || requestedExactTargetIds.some((targetId) =>
        !selected.some(({ target }) =>
          target.canonicalVariantId === targetId))
    )
  ) {
    fail(
      "PROVIDER_TARGET_WAVE_EXACT_TARGET_UNAVAILABLE",
      "an exact selected target is absent, terminal, inadmissible, or has no representative",
    );
  }
  if (!selected.length) {
    fail(
      "PROVIDER_TARGET_WAVE_EMPTY",
      "no unattempted provider target has a valid single-target representative",
    );
  }

  const targets: ProductTruthProviderTargetWaveTarget[] = selected.map(
    ({ target, representative }, ordinal) => ({
      ordinal,
      acquisitionPriority: target.acquisitionPriority,
      canonicalVariantId: target.canonicalVariantId,
      canonicalIdentityHash: target.canonicalIdentityHash,
      queryVersion: searchQueryCalibration.queryContracts.candidate,
      query: calibratedTargetById.get(target.canonicalVariantId)!
        .calibratedQuery,
      sourceDetailCandidate:
        sourceDetailAdmissionByTarget.get(target.canonicalVariantId)!
          .candidate,
      targetIdentity: target.targetIdentity,
      representative: {
        listingKey: representative.listingKey,
        channel: representative.channel,
        storeIndex: representative.storeIndex,
        sku: representative.sku,
        componentIndex: representative.componentIndex,
        quantity: representative.quantity,
        priority: representative.priority,
      },
      impact: target.impact,
      dependentListingKeys: stableUnique(
        target.dependencies.map((dependency) => dependency.listingKey),
      ),
    }),
  );
  const maximumProviderUnits = targets.length * 6;
  const operationalRequest = parseProductTruthOperationalPlanRequest({
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION,
    runId: waveId,
    mode: "WAVE",
    createdAt: generatedAt,
    expiresAt,
    listingKeys: targets.map(
      (target) => target.representative.listingKey,
    ),
    providerAcquisitionTargets: targets.map((target) => ({
      listingKey: target.representative.listingKey,
      canonicalVariantId: target.canonicalVariantId,
      canonicalIdentityHash: target.canonicalIdentityHash,
      queryVersion: target.queryVersion,
      query: target.query,
      sourceDetailAdmissionSha256:
        sourceDetailAdmissionSha256,
      sourceDetailCandidate: {
        retailer: target.sourceDetailCandidate.retailer,
        retailerProductId:
          target.sourceDetailCandidate.retailerProductId,
        productUrl: target.sourceDetailCandidate.productUrl,
      },
    })),
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart", "target"],
      allowClubs: false,
      allowBjs: false,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttemptsPerListing: 1,
    },
    providerCeilings: [
      {
        provider: "oxylabs",
        operations: ["query"],
        maxCalls: targets.length,
        maxUnits: targets.length,
        reserveFloor: null,
      },
      {
        provider: "unwrangle",
        operations: ["detail", "search"],
        maxCalls: targets.length * 2,
        maxUnits: targets.length * 5,
        reserveFloor: 15000,
      },
    ],
    verificationPolicy: {
      maxPriceAgeMs: 172800000,
      minGalleryImages: 5,
    },
    maxWallClockMs: targets.length * 360000,
  });
  const terminalAttemptTargets = [...terminalByTarget.entries()]
    .filter(([targetId]) =>
      providerTargets.some((target) => target.canonicalVariantId === targetId))
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([targetId, attempts]) => ({
      canonicalVariantId: targetId,
      attempts: attempts
        .slice()
        .sort((left, right) =>
          left.finishedAt.localeCompare(right.finishedAt)
          || left.runId.localeCompare(right.runId, "en-US"))
        .map((attempt) => ({
          runId: attempt.runId,
          planSha256: attempt.planSha256,
          listingKey: attempt.listingKey,
          itemStatus: attempt.itemStatus,
          finishedAt: attempt.finishedAt,
          providerCalls: attempt.providerCalls,
          providerUnits: attempt.providerUnits,
        })),
    }));
  return {
    schemaVersion: PRODUCT_TRUTH_PROVIDER_TARGET_WAVE_VERSION,
    waveId,
    generatedAt,
    expiresAt,
    databaseTargetFingerprint,
    authoritativeManifestSha256,
    source: {
      componentAcquisitionScope: {
        schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
        sha256: componentScopeSha256,
        generatedAt: input.componentScope.generatedAt,
      },
      searchQueryCalibration: {
        schemaVersion: PRODUCT_TRUTH_SEARCH_QUERY_CALIBRATION_VERSION,
        sha256: exactSha(
          input.searchQueryCalibrationSha256,
          "search calibration SHA-256",
        ),
        generatedAt: searchQueryCalibration.generatedAt,
        admittedForms: searchQueryCalibration.admittedForms,
        admittedProviderTargets:
          searchQueryCalibration.counts.admittedProviderTargets,
      },
      sourceDetailAdmission: {
        schemaVersion: PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
        sha256: sourceDetailAdmissionSha256,
        generatedAt: input.sourceDetailAdmission.generatedAt,
        admittedTargets:
          input.sourceDetailAdmission.counts.admittedTargets,
      },
      terminalAttemptCapture: {
        schemaVersion: PRODUCT_TRUTH_PROVIDER_ATTEMPT_CAPTURE_VERSION,
        sha256: exactSha(
          input.attemptCaptureSha256,
          "attempt capture SHA-256",
        ),
        capturedAt: attemptCapture.capturedAt,
        attemptCount: attemptCapture.attempts.length,
      },
    },
    selectionPolicy: {
      unitOfWork: "UNIQUE_CANONICAL_COMPONENT_TARGET",
      representative:
        "ONE_VALID_SINGLE_TARGET_LISTING_HIGHEST_SALES_THEN_WALMART_THEN_REPAIR_PRIORITY",
      terminalAttemptPolicy:
        "EXCLUDE_EXPLICIT_TARGET_OR_SINGLE_TARGET_LISTING_AFTER_METERED_TERMINAL_ATTEMPT",
      queryAdmission:
        "EXACT_TARGET_AND_QUERY_MUST_BE_ADMITTED_BY_BOUND_NONREGRESSING_CALIBRATION",
      sourceDetailAdmission:
        "EXACT_TARGET_AND_RETAILER_ITEM_MUST_BE_ADMITTED_BY_BOUND_FAIL_CLOSED_ARTIFACT",
      retailers: ["walmart", "target"],
      procurementZip: "33765",
      maximumTargets: input.maximumTargets,
      exactCanonicalVariantIds: [...requestedExactTargetIds],
      maximumProviderUnits,
      retryAllowed: false,
      clubsAllowed: false,
      bjsAllowed: false,
    },
    counts: {
      providerTargets: allProviderTargets.length,
      calibrationAdmittedProviderTargets:
        calibratedProviderTargets.length,
      calibrationExcludedProviderTargets:
        allProviderTargets.length - calibratedProviderTargets.length,
      sourceDetailAdmittedProviderTargets: providerTargets.length,
      sourceDetailExcludedCalibratedTargets:
        calibratedProviderTargets.length - providerTargets.length,
      terminalAttemptTargets: terminalAttemptTargets.length,
      noSingleTargetRepresentative:
        targetsWithoutSingleTargetRepresentative.length,
      eligibleTargets: eligible.length,
      selectedTargets: targets.length,
      selectedDependentListings: new Set(
        targets.flatMap((target) => target.dependentListingKeys),
      ).size,
      selectedImmediateClosures: targets.reduce(
        (sum, target) => sum + target.impact.immediateClosableListings,
        0,
      ),
    },
    terminalAttemptTargets,
    targetsWithoutSingleTargetRepresentative,
    targets,
    operationalRequest,
    claims: {
      createsParallelCatalog: false,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      procurementMutations: 0,
      consumerActivation: false,
      authorizesExecution: false,
    },
  };
}

export function renderProductTruthProviderAttemptCapture(
  value: ProductTruthProviderAttemptCapture,
): string {
  return renderProductTruthOperationalJson(value);
}

export function renderProductTruthProviderTargetWave(
  value: ProductTruthProviderTargetWave,
): string {
  return renderProductTruthOperationalJson(value);
}

export function productTruthProviderTargetWaveSha256(
  value: ProductTruthProviderTargetWave,
): string {
  return sha256Text(renderProductTruthProviderTargetWave(value));
}
