import { createHash } from "node:crypto";

export const PRODUCT_TRUTH_WALMART_COLLECTION_BATCH_VERSION =
  "product-truth-walmart-collection-batch/1.0.0" as const;
export const PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION =
  "product-truth-walmart-collection-job/1.0.0" as const;
export const PRODUCT_TRUTH_WALMART_COLLECTION_MAX_JOBS = 5 as const;
export const PRODUCT_TRUTH_WALMART_COLLECTION_ZIP = "33765" as const;
export const PRODUCT_TRUTH_WALMART_COLLECTION_JOB_TTL_MS =
  24 * 60 * 60 * 1_000;

export interface ProductTruthWalmartCollectionCandidate {
  donorProductId: string;
  canonicalVariantId: string;
  title: string;
  query: string;
  missingFields: readonly string[];
}

export interface ProductTruthWalmartCollectionJob {
  schemaVersion: typeof PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION;
  batchId: string;
  runId: string;
  ordinal: number;
  requestedAt: string;
  expiresAt: string;
  target: {
    donorProductId: string;
    canonicalVariantId: string;
    title: string;
    query: string;
    missingFields: readonly string[];
  };
  noSpendSequence: readonly ["DOCTOR", "RUN_PLAN"];
  meteredStep: {
    commandKind: "EXECUTE";
    status: "REQUIRES_EXACT_OWNER_AUTHORITY";
    maximumProviderUnits: 3.5;
    oxylabs: { operation: "query"; maxCalls: 1; maxUnits: 1 };
    unwrangle: {
      operation: "detail";
      maxCalls: 1;
      maxUnits: 2.5;
      reserveFloor: number;
    };
  };
  policy: {
    retailer: "walmart";
    procurementZip: typeof PRODUCT_TRUTH_WALMART_COLLECTION_ZIP;
    listingConcurrency: 1;
    componentConcurrency: 1;
    maxAttempts: 1;
  };
  claims: {
    exactOneDonor: true;
    noImplicitScope: true;
    noParallelCatalog: true;
    noMarketplaceMutation: true;
    noAutomaticReplay: true;
    noAutomaticPaidExecution: true;
    clubsForbidden: true;
    bjsForbidden: true;
  };
}

export interface ProductTruthWalmartCollectionBatch {
  schemaVersion: typeof PRODUCT_TRUTH_WALMART_COLLECTION_BATCH_VERSION;
  batchId: string;
  idempotencyKey: string;
  requestedByUserId: string;
  requestedAt: string;
  request: {
    prompt: string;
    listingCount: number;
    packCount: number;
  };
  jobs: readonly ProductTruthWalmartCollectionJob[];
  claims: {
    uiGroupingOnly: true;
    eachJobIsIndependent: true;
    noMultiTargetProviderRun: true;
    readinessRecheckRequired: true;
    automaticGenerateRequiresNoCapabilityGaps: true;
  };
}

export class ProductTruthWalmartCollectionContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthWalmartCollectionContractError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthWalmartCollectionContractError(code, message);
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
    fail("COLLECTION_SHAPE_INVALID", `${label} has non-canonical keys`);
  }
}

function exactText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("COLLECTION_INPUT_INVALID", `${label} must be exact bounded text`);
  }
  return value;
}

function safeToken(value: unknown, label: string): string {
  const text = exactText(value, label, 1, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(text)) {
    fail("COLLECTION_INPUT_INVALID", `${label} is not a safe token`);
  }
  return text;
}

function exactInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 20, 30);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    fail("COLLECTION_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(
      "COLLECTION_INPUT_INVALID",
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parseMissingFields(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail("COLLECTION_INPUT_INVALID", `${label} must contain 1-32 gaps`);
  }
  const fields = value.map((entry, index) => {
    const field = safeToken(entry, `${label}[${index}]`);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(field)) {
      fail("COLLECTION_INPUT_INVALID", `${label}[${index}] is not a gap token`);
    }
    return field;
  });
  const sorted = [...fields].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  if (
    new Set(fields).size !== fields.length
    || fields.some((field, index) => field !== sorted[index])
  ) {
    fail("COLLECTION_INPUT_INVALID", `${label} must be unique and sorted`);
  }
  return fields;
}

function parseTarget(
  value: unknown,
  label: string,
): ProductTruthWalmartCollectionJob["target"] {
  if (!isRecord(value)) {
    fail("COLLECTION_SHAPE_INVALID", `${label} must be an object`);
  }
  exactKeys(
    value,
    ["donorProductId", "canonicalVariantId", "title", "query", "missingFields"],
    label,
  );
  return {
    donorProductId: safeToken(value.donorProductId, `${label}.donorProductId`),
    canonicalVariantId: safeToken(
      value.canonicalVariantId,
      `${label}.canonicalVariantId`,
    ),
    title: exactText(value.title, `${label}.title`, 1, 500),
    query: exactText(value.query, `${label}.query`, 3, 300),
    missingFields: parseMissingFields(
      value.missingFields,
      `${label}.missingFields`,
    ),
  };
}

export function parseProductTruthWalmartCollectionJob(
  value: unknown,
): ProductTruthWalmartCollectionJob {
  if (!isRecord(value)) {
    fail("COLLECTION_SHAPE_INVALID", "job must be an object");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "batchId",
      "runId",
      "ordinal",
      "requestedAt",
      "expiresAt",
      "target",
      "noSpendSequence",
      "meteredStep",
      "policy",
      "claims",
    ],
    "job",
  );
  if (value.schemaVersion !== PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION) {
    fail("COLLECTION_VERSION_INVALID", "job schema version is unsupported");
  }
  const requestedAt = exactInstant(value.requestedAt, "job.requestedAt");
  const expiresAt = exactInstant(value.expiresAt, "job.expiresAt");
  if (
    Date.parse(expiresAt) - Date.parse(requestedAt)
      !== PRODUCT_TRUTH_WALMART_COLLECTION_JOB_TTL_MS
  ) {
    fail("COLLECTION_INPUT_INVALID", "job lifetime must be exactly 24 hours");
  }
  if (
    !Array.isArray(value.noSpendSequence)
    || JSON.stringify(value.noSpendSequence) !== '["DOCTOR","RUN_PLAN"]'
  ) {
    fail("COLLECTION_POLICY_INVALID", "no-spend sequence is not canonical");
  }
  if (!isRecord(value.meteredStep)) {
    fail("COLLECTION_SHAPE_INVALID", "meteredStep must be an object");
  }
  exactKeys(
    value.meteredStep,
    [
      "commandKind",
      "status",
      "maximumProviderUnits",
      "oxylabs",
      "unwrangle",
    ],
    "meteredStep",
  );
  if (!isRecord(value.meteredStep.oxylabs) || !isRecord(value.meteredStep.unwrangle)) {
    fail("COLLECTION_SHAPE_INVALID", "provider ceilings must be objects");
  }
  exactKeys(
    value.meteredStep.oxylabs,
    ["operation", "maxCalls", "maxUnits"],
    "meteredStep.oxylabs",
  );
  exactKeys(
    value.meteredStep.unwrangle,
    ["operation", "maxCalls", "maxUnits", "reserveFloor"],
    "meteredStep.unwrangle",
  );
  if (
    value.meteredStep.commandKind !== "EXECUTE"
    || value.meteredStep.status !== "REQUIRES_EXACT_OWNER_AUTHORITY"
    || value.meteredStep.maximumProviderUnits !== 3.5
    || value.meteredStep.oxylabs.operation !== "query"
    || value.meteredStep.oxylabs.maxCalls !== 1
    || value.meteredStep.oxylabs.maxUnits !== 1
    || value.meteredStep.unwrangle.operation !== "detail"
    || value.meteredStep.unwrangle.maxCalls !== 1
    || value.meteredStep.unwrangle.maxUnits !== 2.5
    || typeof value.meteredStep.unwrangle.reserveFloor !== "number"
    || !Number.isFinite(value.meteredStep.unwrangle.reserveFloor)
    || value.meteredStep.unwrangle.reserveFloor < 0
  ) {
    fail("COLLECTION_POLICY_INVALID", "provider ceilings are not canonical");
  }
  if (!isRecord(value.policy)) {
    fail("COLLECTION_SHAPE_INVALID", "policy must be an object");
  }
  exactKeys(
    value.policy,
    [
      "retailer",
      "procurementZip",
      "listingConcurrency",
      "componentConcurrency",
      "maxAttempts",
    ],
    "policy",
  );
  if (
    value.policy.retailer !== "walmart"
    || value.policy.procurementZip !== PRODUCT_TRUTH_WALMART_COLLECTION_ZIP
    || value.policy.listingConcurrency !== 1
    || value.policy.componentConcurrency !== 1
    || value.policy.maxAttempts !== 1
  ) {
    fail("COLLECTION_POLICY_INVALID", "one-donor execution policy drifted");
  }
  if (!isRecord(value.claims)) {
    fail("COLLECTION_SHAPE_INVALID", "claims must be an object");
  }
  const claims = value.claims;
  const claimKeys = [
    "exactOneDonor",
    "noImplicitScope",
    "noParallelCatalog",
    "noMarketplaceMutation",
    "noAutomaticReplay",
    "noAutomaticPaidExecution",
    "clubsForbidden",
    "bjsForbidden",
  ] as const;
  exactKeys(claims, claimKeys, "claims");
  if (claimKeys.some((key) => claims[key] !== true)) {
    fail("COLLECTION_POLICY_INVALID", "mandatory job claims are absent");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION,
    batchId: safeToken(value.batchId, "job.batchId"),
    runId: safeToken(value.runId, "job.runId"),
    ordinal: boundedInteger(
      value.ordinal,
      "job.ordinal",
      0,
      PRODUCT_TRUTH_WALMART_COLLECTION_MAX_JOBS - 1,
    ),
    requestedAt,
    expiresAt,
    target: parseTarget(value.target, "job.target"),
    noSpendSequence: ["DOCTOR", "RUN_PLAN"],
    meteredStep: {
      commandKind: "EXECUTE",
      status: "REQUIRES_EXACT_OWNER_AUTHORITY",
      maximumProviderUnits: 3.5,
      oxylabs: { operation: "query", maxCalls: 1, maxUnits: 1 },
      unwrangle: {
        operation: "detail",
        maxCalls: 1,
        maxUnits: 2.5,
        reserveFloor: value.meteredStep.unwrangle.reserveFloor,
      },
    },
    policy: {
      retailer: "walmart",
      procurementZip: PRODUCT_TRUTH_WALMART_COLLECTION_ZIP,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttempts: 1,
    },
    claims: {
      exactOneDonor: true,
      noImplicitScope: true,
      noParallelCatalog: true,
      noMarketplaceMutation: true,
      noAutomaticReplay: true,
      noAutomaticPaidExecution: true,
      clubsForbidden: true,
      bjsForbidden: true,
    },
  };
}

export function parseProductTruthWalmartCollectionBatch(
  value: unknown,
): ProductTruthWalmartCollectionBatch {
  if (!isRecord(value)) {
    fail("COLLECTION_SHAPE_INVALID", "batch must be an object");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "batchId",
      "idempotencyKey",
      "requestedByUserId",
      "requestedAt",
      "request",
      "jobs",
      "claims",
    ],
    "batch",
  );
  if (value.schemaVersion !== PRODUCT_TRUTH_WALMART_COLLECTION_BATCH_VERSION) {
    fail("COLLECTION_VERSION_INVALID", "batch schema version is unsupported");
  }
  if (!isRecord(value.request)) {
    fail("COLLECTION_SHAPE_INVALID", "request must be an object");
  }
  exactKeys(
    value.request,
    ["prompt", "listingCount", "packCount"],
    "request",
  );
  if (
    !Array.isArray(value.jobs)
    || value.jobs.length < 1
    || value.jobs.length > PRODUCT_TRUTH_WALMART_COLLECTION_MAX_JOBS
  ) {
    fail("COLLECTION_INPUT_INVALID", "batch must contain 1-5 independent jobs");
  }
  const jobs = value.jobs.map(parseProductTruthWalmartCollectionJob);
  const batchId = safeToken(value.batchId, "batch.batchId");
  const requestedAt = exactInstant(value.requestedAt, "batch.requestedAt");
  if (
    jobs.some(
      (job, index) =>
        job.batchId !== batchId
        || job.ordinal !== index
        || job.requestedAt !== requestedAt,
    )
  ) {
    fail("COLLECTION_INPUT_INVALID", "job order or batch binding drifted");
  }
  if (
    new Set(jobs.map((job) => job.runId)).size !== jobs.length
    || new Set(jobs.map((job) => job.target.donorProductId)).size !== jobs.length
    || new Set(jobs.map((job) => job.target.canonicalVariantId)).size !== jobs.length
  ) {
    fail("COLLECTION_INPUT_INVALID", "jobs must target unique exact variants");
  }
  if (!isRecord(value.claims)) {
    fail("COLLECTION_SHAPE_INVALID", "batch claims must be an object");
  }
  const claims = value.claims;
  const claimKeys = [
    "uiGroupingOnly",
    "eachJobIsIndependent",
    "noMultiTargetProviderRun",
    "readinessRecheckRequired",
    "automaticGenerateRequiresNoCapabilityGaps",
  ] as const;
  exactKeys(claims, claimKeys, "batch.claims");
  if (claimKeys.some((key) => claims[key] !== true)) {
    fail("COLLECTION_POLICY_INVALID", "mandatory batch claims are absent");
  }
  const idempotencyKey = exactText(
    value.idempotencyKey,
    "batch.idempotencyKey",
    64,
    200,
  );
  if (!/^bf-walmart-collection:[a-f0-9]{64}$/u.test(idempotencyKey)) {
    fail("COLLECTION_INPUT_INVALID", "idempotency key is not canonical");
  }
  return {
    schemaVersion: PRODUCT_TRUTH_WALMART_COLLECTION_BATCH_VERSION,
    batchId,
    idempotencyKey,
    requestedByUserId: safeToken(
      value.requestedByUserId,
      "batch.requestedByUserId",
    ),
    requestedAt,
    request: {
      prompt: exactText(value.request.prompt, "request.prompt", 3, 1_000),
      listingCount: boundedInteger(
        value.request.listingCount,
        "request.listingCount",
        1,
        500,
      ),
      packCount: boundedInteger(
        value.request.packCount,
        "request.packCount",
        1,
        500,
      ),
    },
    jobs,
    claims: {
      uiGroupingOnly: true,
      eachJobIsIndependent: true,
      noMultiTargetProviderRun: true,
      readinessRecheckRequired: true,
      automaticGenerateRequiresNoCapabilityGaps: true,
    },
  };
}

export function buildProductTruthWalmartCollectionBatch(input: {
  requestedByUserId: string;
  requestedAt: string;
  prompt: string;
  listingCount: number;
  packCount: number;
  unwrangleReserveFloor: number;
  candidates: readonly ProductTruthWalmartCollectionCandidate[];
  /**
   * Ordinal of the collection attempt inside one durable owner request.
   *
   * A paid lifecycle is bound once and forever to a runId: metered budgets,
   * reservation receipts, and harvest state are all immutable per
   * (runId, provider). A legitimate NEW owner-approved attempt for the same
   * logical request therefore needs a fresh batch identity — reusing the old
   * one collides with the previous attempt's immutable budget rows
   * (`METERED_BUDGET_PERMIT_CONFLICT`, observed in production 2026-08-02) and
   * would let a new approval inherit the previous attempt's authority.
   * Attempt 1 keeps the historical identity so existing batches stay stable.
   */
  attempt?: number;
}): ProductTruthWalmartCollectionBatch {
  const requestedByUserId = safeToken(
    input.requestedByUserId,
    "requestedByUserId",
  );
  const requestedAt = exactInstant(input.requestedAt, "requestedAt");
  const prompt = exactText(input.prompt, "prompt", 3, 1_000);
  const listingCount = boundedInteger(
    input.listingCount,
    "listingCount",
    1,
    500,
  );
  const packCount = boundedInteger(input.packCount, "packCount", 1, 500);
  if (
    typeof input.unwrangleReserveFloor !== "number"
    || !Number.isFinite(input.unwrangleReserveFloor)
    || input.unwrangleReserveFloor < 0
  ) {
    fail(
      "COLLECTION_INPUT_INVALID",
      "unwrangleReserveFloor must be finite and non-negative",
    );
  }
  if (
    input.candidates.length < 1
    || input.candidates.length > PRODUCT_TRUTH_WALMART_COLLECTION_MAX_JOBS
  ) {
    fail("COLLECTION_INPUT_INVALID", "candidates must contain 1-5 exact targets");
  }
  const targets = input.candidates.map((candidate, index) =>
    parseTarget(
      {
        donorProductId: candidate.donorProductId,
        canonicalVariantId: candidate.canonicalVariantId,
        title: candidate.title,
        query: candidate.query,
        missingFields: [...candidate.missingFields].sort((left, right) =>
          left.localeCompare(right, "en-US"),
        ),
      },
      `candidates[${index}]`,
    ),
  );
  const attempt = input.attempt === undefined
    ? 1
    : boundedInteger(input.attempt, "attempt", 1, 5);
  const identityBytes = canonicalJson({
    requestedByUserId,
    request: { prompt, listingCount, packCount },
    targets,
    unwrangleReserveFloor: input.unwrangleReserveFloor,
    // Included only from the second attempt on, so every batch admitted
    // before this field existed keeps its exact historical identity.
    ...(attempt > 1 ? { attempt } : {}),
  });
  const identitySha256 = sha256(identityBytes);
  const batchId = `ptbfw-${identitySha256.slice(0, 24)}`;
  const expiresAt = new Date(
    Date.parse(requestedAt) + PRODUCT_TRUTH_WALMART_COLLECTION_JOB_TTL_MS,
  ).toISOString();
  const jobs = targets.map((target, ordinal) =>
    parseProductTruthWalmartCollectionJob({
      schemaVersion: PRODUCT_TRUTH_WALMART_COLLECTION_JOB_VERSION,
      batchId,
      runId: `${batchId}-${String(ordinal + 1).padStart(2, "0")}`,
      ordinal,
      requestedAt,
      expiresAt,
      target,
      noSpendSequence: ["DOCTOR", "RUN_PLAN"],
      meteredStep: {
        commandKind: "EXECUTE",
        status: "REQUIRES_EXACT_OWNER_AUTHORITY",
        maximumProviderUnits: 3.5,
        oxylabs: { operation: "query", maxCalls: 1, maxUnits: 1 },
        unwrangle: {
          operation: "detail",
          maxCalls: 1,
          maxUnits: 2.5,
          reserveFloor: input.unwrangleReserveFloor,
        },
      },
      policy: {
        retailer: "walmart",
        procurementZip: PRODUCT_TRUTH_WALMART_COLLECTION_ZIP,
        listingConcurrency: 1,
        componentConcurrency: 1,
        maxAttempts: 1,
      },
      claims: {
        exactOneDonor: true,
        noImplicitScope: true,
        noParallelCatalog: true,
        noMarketplaceMutation: true,
        noAutomaticReplay: true,
        noAutomaticPaidExecution: true,
        clubsForbidden: true,
        bjsForbidden: true,
      },
    }),
  );
  return parseProductTruthWalmartCollectionBatch({
    schemaVersion: PRODUCT_TRUTH_WALMART_COLLECTION_BATCH_VERSION,
    batchId,
    idempotencyKey: `bf-walmart-collection:${identitySha256}`,
    requestedByUserId,
    requestedAt,
    request: { prompt, listingCount, packCount },
    jobs,
    claims: {
      uiGroupingOnly: true,
      eachJobIsIndependent: true,
      noMultiTargetProviderRun: true,
      readinessRecheckRequired: true,
      automaticGenerateRequiresNoCapabilityGaps: true,
    },
  });
}

export function renderProductTruthWalmartCollectionBatch(
  value: unknown,
): string {
  return canonicalJson(parseProductTruthWalmartCollectionBatch(value));
}

export function productTruthWalmartCollectionBatchSha256(
  value: unknown,
): string {
  return sha256(renderProductTruthWalmartCollectionBatch(value));
}
