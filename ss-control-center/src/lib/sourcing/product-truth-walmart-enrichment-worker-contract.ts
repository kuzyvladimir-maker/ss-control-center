import { createHash } from "node:crypto";

import {
  parseProductTruthWalmartEnrichmentQuote,
  productTruthWalmartEnrichmentQuoteSha256,
} from "./product-truth-walmart-enrichment-quote";

export const PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION =
  "product-truth-walmart-enrichment-result/1.0.0" as const;
export const PRODUCT_TRUTH_WALMART_ENRICHMENT_PROGRESS_VERSION =
  "product-truth-walmart-enrichment-progress/1.0.0" as const;

export const PRODUCT_TRUTH_WALMART_ENRICHMENT_STAGES = [
  "BALANCE_CHECK",
  "ITEM_START",
  "EXACT_WALMART_SEARCH",
  "EXACT_PRODUCT_DETAIL",
  "CATALOG_RECONCILIATION",
  "ITEM_COMPLETE",
  "BATCH_COMPLETE",
  "STOPPED",
] as const;

export type ProductTruthWalmartEnrichmentStage =
  (typeof PRODUCT_TRUTH_WALMART_ENRICHMENT_STAGES)[number];

export interface ProductTruthWalmartEnrichmentProgress {
  schemaVersion: typeof PRODUCT_TRUTH_WALMART_ENRICHMENT_PROGRESS_VERSION;
  batchId: string;
  totalJobs: number;
  currentOrdinal: number | null;
  currentRunId: string | null;
  currentTitle: string | null;
  stage: ProductTruthWalmartEnrichmentStage;
  completedJobs: number;
  stoppedJobs: number;
  providerCalls: number;
  providerUnits: number;
  messageCode: string;
  observedAt: string;
}

export interface ProductTruthWalmartEnrichmentResult {
  schemaVersion: typeof PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION;
  commandId: string;
  batchId: string;
  quoteSha256: string;
  status: "COMPLETED" | "BLOCKED" | "AMBIGUOUS" | "FAILED";
  reason: string;
  generatedAt: string;
  providerCalls: number;
  providerUnits: number;
  marketplaceMutations: 0;
  initialBalanceEvidence: {
    provider: "unwrangle";
    observedAt: string;
    balanceUnits: number;
    reserveFloor: number;
    evidenceSha256: string;
  } | null;
  jobs: readonly {
    ordinal: number;
    runId: string;
    planSha256: string;
    status: "COMPLETED" | "BLOCKED" | "AMBIGUOUS" | "FAILED" | "NOT_STARTED";
    reason: string;
    providerCalls: number;
    providerUnits: number;
    reportSha256: string | null;
    nextBalanceEvidence: {
      provider: "unwrangle";
      observedAt: string;
      balanceUnits: number;
      reserveFloor: number;
      evidenceSha256: string;
    } | null;
  }[];
  claims: {
    concurrency: 1;
    maxAttemptsPerJob: 1;
    automaticReplay: false;
    oneInitialBalanceProbeMaximum: true;
    marketplaceMutations: 0;
  };
}

export class ProductTruthWalmartEnrichmentResultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthWalmartEnrichmentResultError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthWalmartEnrichmentResultError(code, message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseProductTruthWalmartEnrichmentProgress(
  value: unknown,
): ProductTruthWalmartEnrichmentProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ENRICHMENT_PROGRESS_INVALID", "progress must be an object");
  }
  const progress = value as ProductTruthWalmartEnrichmentProgress;
  const keys = Object.keys(progress).sort();
  const expectedKeys = [
    "batchId",
    "completedJobs",
    "currentOrdinal",
    "currentRunId",
    "currentTitle",
    "messageCode",
    "observedAt",
    "providerCalls",
    "providerUnits",
    "schemaVersion",
    "stage",
    "stoppedJobs",
    "totalJobs",
  ].sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || progress.schemaVersion
      !== PRODUCT_TRUTH_WALMART_ENRICHMENT_PROGRESS_VERSION
    || !/^ptbfw-[a-f0-9]{24}$/u.test(progress.batchId)
    || !Number.isInteger(progress.totalJobs)
    || progress.totalJobs < 1
    || progress.totalJobs > 500
    || !PRODUCT_TRUTH_WALMART_ENRICHMENT_STAGES.includes(progress.stage)
    || !Number.isInteger(progress.completedJobs)
    || progress.completedJobs < 0
    || progress.completedJobs > progress.totalJobs
    || !Number.isInteger(progress.stoppedJobs)
    || progress.stoppedJobs < 0
    || progress.completedJobs + progress.stoppedJobs > progress.totalJobs
    || !Number.isInteger(progress.providerCalls)
    || progress.providerCalls < 0
    || progress.providerCalls > 1 + progress.totalJobs * 2
    || !Number.isFinite(progress.providerUnits)
    || progress.providerUnits < 0
    || progress.providerUnits > 2.5 + progress.totalJobs * 3.5
    || typeof progress.messageCode !== "string"
    || !/^[A-Z0-9_]{1,120}$/u.test(progress.messageCode)
    || !isCanonicalInstant(progress.observedAt)
  ) {
    fail("ENRICHMENT_PROGRESS_INVALID", "progress identity or counters drifted");
  }
  const hasCurrent = progress.currentOrdinal !== null;
  if (
    hasCurrent !== (progress.currentRunId !== null)
    || hasCurrent !== (progress.currentTitle !== null)
    || (progress.currentOrdinal !== null
      && (!Number.isInteger(progress.currentOrdinal)
        || progress.currentOrdinal < 1
        || progress.currentOrdinal > progress.totalJobs))
    || (progress.currentRunId !== null
      && !progress.currentRunId.startsWith(`${progress.batchId}-`))
    || (progress.currentTitle !== null
      && (progress.currentTitle.length < 1 || progress.currentTitle.length > 500))
    || (["BALANCE_CHECK", "BATCH_COMPLETE"].includes(progress.stage)
      && hasCurrent)
    || ([
      "ITEM_START",
      "EXACT_WALMART_SEARCH",
      "EXACT_PRODUCT_DETAIL",
      "CATALOG_RECONCILIATION",
      "ITEM_COMPLETE",
    ].includes(progress.stage) && !hasCurrent)
  ) {
    fail("ENRICHMENT_PROGRESS_INVALID", "progress current-item binding drifted");
  }
  return progress;
}

function isBalanceEvidence(
  value: ProductTruthWalmartEnrichmentResult["initialBalanceEvidence"],
): boolean {
  return value !== null
    && value.provider === "unwrangle"
    && isCanonicalInstant(value.observedAt)
    && Number.isFinite(value.balanceUnits)
    && value.balanceUnits >= 0
    && Number.isFinite(value.reserveFloor)
    && value.reserveFloor >= 0
    && /^[a-f0-9]{64}$/u.test(value.evidenceSha256);
}

export function renderProductTruthWalmartEnrichmentResult(
  result: ProductTruthWalmartEnrichmentResult,
): string {
  return `${JSON.stringify(result)}\n`;
}

export function productTruthWalmartEnrichmentResultSha256(
  result: ProductTruthWalmartEnrichmentResult,
): string {
  return sha256(renderProductTruthWalmartEnrichmentResult(result));
}

export function assertProductTruthWalmartEnrichmentResult(input: {
  result: ProductTruthWalmartEnrichmentResult;
  quote: unknown;
  commandId: string;
}): ProductTruthWalmartEnrichmentResult {
  const quote = parseProductTruthWalmartEnrichmentQuote(input.quote);
  const result = input.result;
  if (
    result.schemaVersion !== PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION
    || result.commandId !== input.commandId
    || result.batchId !== quote.batchId
    || result.quoteSha256
      !== productTruthWalmartEnrichmentQuoteSha256(quote)
    || !["COMPLETED", "BLOCKED", "AMBIGUOUS", "FAILED"].includes(result.status)
    || typeof result.reason !== "string"
    || result.reason.length < 1
    || result.reason.length > 500
    || !isCanonicalInstant(result.generatedAt)
    || !Number.isInteger(result.providerCalls)
    || result.providerCalls < 0
    || result.providerCalls > 1 + quote.actions.jobs.length * 2
    || !Number.isFinite(result.providerUnits)
    || result.providerUnits < 0
    || result.providerUnits > quote.totals.maximumProviderUnits
    || result.marketplaceMutations !== 0
    || !Array.isArray(result.jobs)
    || result.jobs.length !== quote.actions.jobs.length
    || result.claims?.concurrency !== 1
    || result.claims?.maxAttemptsPerJob !== 1
    || result.claims?.automaticReplay !== false
    || result.claims?.oneInitialBalanceProbeMaximum !== true
    || result.claims?.marketplaceMutations !== 0
  ) {
    fail("ENRICHMENT_RESULT_INVALID", "batch result identity or safety claims drifted");
  }
  for (const [index, job] of result.jobs.entries()) {
    const expected = quote.actions.jobs[index]!;
    if (
      job.ordinal !== expected.ordinal
      || job.runId !== expected.runId
      || job.planSha256 !== expected.planSha256
      || !["COMPLETED", "BLOCKED", "AMBIGUOUS", "FAILED", "NOT_STARTED"]
        .includes(job.status)
      || typeof job.reason !== "string"
      || job.reason.length < 1
      || job.reason.length > 500
      || !Number.isInteger(job.providerCalls)
      || job.providerCalls < 0
      || job.providerCalls > 2
      || !Number.isFinite(job.providerUnits)
      || job.providerUnits < 0
      || job.providerUnits > 3.5
      || (job.reportSha256 !== null
        && !/^[a-f0-9]{64}$/u.test(job.reportSha256))
      || (job.status === "COMPLETED" && job.reportSha256 === null)
      || (job.status !== "COMPLETED" && job.nextBalanceEvidence !== null)
      || (job.nextBalanceEvidence !== null
        && !isBalanceEvidence(job.nextBalanceEvidence))
    ) {
      fail("ENRICHMENT_RESULT_INVALID", `job ${index + 1} result drifted`);
    }
  }
  const jobCalls = result.jobs.reduce(
    (sum, job) => sum + job.providerCalls,
    0,
  );
  const jobUnits = result.jobs.reduce(
    (sum, job) => sum + job.providerUnits,
    0,
  );
  const balanceProbeCalls = result.providerCalls - jobCalls;
  const balanceProbeUnits = result.providerUnits - jobUnits;
  if (
    ![0, 1].includes(balanceProbeCalls)
    || ![0, 2.5].some((value) =>
      Math.abs(balanceProbeUnits - value) <= 0.000001)
    || (result.initialBalanceEvidence !== null
      && (!isBalanceEvidence(result.initialBalanceEvidence)
        || balanceProbeCalls !== 1
        || Math.abs(balanceProbeUnits - 2.5) > 0.000001))
    || (result.status === "COMPLETED"
      && (result.initialBalanceEvidence === null
        || result.jobs.some((job) => job.status !== "COMPLETED")))
  ) {
    fail("ENRICHMENT_RESULT_INVALID", "batch totals or terminal outcome drifted");
  }
  const firstUnfinished = result.jobs.findIndex(
    (job) => job.status !== "COMPLETED",
  );
  if (
    firstUnfinished >= 0
    && result.jobs.slice(firstUnfinished + 1).some(
      (job) => job.status !== "NOT_STARTED",
    )
  ) {
    fail(
      "ENRICHMENT_RESULT_INVALID",
      "jobs after the first non-completed outcome must remain not started",
    );
  }
  return result;
}
