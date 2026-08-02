import { createHash } from "node:crypto";

import {
  productTruthOperationalSha256,
} from "./product-truth-operational-run-contract";
import {
  TARGETED_WALMART_MAX_WALL_CLOCK_MS,
  parseProductTruthTargetedWalmartEvidencePlan,
  type ProductTruthTargetedWalmartEvidencePlan,
} from "./product-truth-targeted-walmart-evidence-contract";
import {
  parseProductTruthWalmartCollectionJob,
  type ProductTruthWalmartCollectionJob,
} from "./product-truth-walmart-collection-contract";

export const PRODUCT_TRUTH_WALMART_ENRICHMENT_QUOTE_VERSION =
  "product-truth-walmart-enrichment-quote/1.0.0" as const;
export const PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS = 2.5 as const;
export const PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS = 3.5 as const;

export interface ProductTruthWalmartEnrichmentQuote {
  schemaVersion: typeof PRODUCT_TRUTH_WALMART_ENRICHMENT_QUOTE_VERSION;
  quoteId: string;
  batchId: string;
  requestedByUserId: string;
  createdAt: string;
  expiresAt: string;
  costUnit: {
    kind: "PREPAID_PROVIDER_CREDITS";
    usdEquivalent: null;
  };
  actions: {
    balanceProbe: {
      provider: "unwrangle";
      operation: "balance_probe";
      maxCalls: 1;
      maximumProviderUnits: typeof PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS;
      purpose: "FRESH_RESERVE_FLOOR_EVIDENCE";
    };
    jobs: readonly {
      ordinal: number;
      runId: string;
      planSha256: string;
      donorProductId: string;
      canonicalVariantId: string;
      title: string;
      missingFields: readonly string[];
      oxylabs: {
        operation: "query";
        maxCalls: 1;
        maximumProviderUnits: 1;
      };
      unwrangle: {
        operation: "detail";
        maxCalls: 1;
        maximumProviderUnits: 2.5;
      };
      maximumProviderUnits: typeof PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS;
      maxWallClockMs: typeof TARGETED_WALMART_MAX_WALL_CLOCK_MS;
    }[];
  };
  totals: {
    jobs: number;
    balanceProbeMaximumUnits: typeof PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS;
    oxylabsMaximumUnits: number;
    unwrangleDetailMaximumUnits: number;
    maximumProviderUnits: number;
  };
  decision: {
    eachExactTargetApprovedSeparately: true;
    oneOwnerClickMayApproveAllDisplayedTargets: true;
    declineLeavesCatalogUnchanged: true;
    approvalDoesNotPublishListings: true;
  };
  claims: {
    oneInitialBalanceProbeMaximum: true;
    nextJobUsesPriorDetailBalanceEvidence: true;
    missingOrStaleBalanceStopsWithoutExtraSpend: true;
    concurrency: 1;
    maxAttemptsPerJob: 1;
    automaticReplay: false;
    marketplaceMutations: 0;
    clubsForbidden: true;
    bjsForbidden: true;
  };
}

export class ProductTruthWalmartEnrichmentQuoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthWalmartEnrichmentQuoteError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthWalmartEnrichmentQuoteError(code, message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("ENRICHMENT_QUOTE_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function safeToken(value: string, label: string): string {
  if (
    value.length < 1
    || value.length > 200
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", `${label} must be a safe token`);
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", `${label} keys/order are not canonical`);
  }
}

export function productTruthWalmartEnrichmentQuoteSha256(
  quote: ProductTruthWalmartEnrichmentQuote,
): string {
  return sha256(canonicalBytes(quote));
}

export function renderProductTruthWalmartEnrichmentQuote(
  quote: ProductTruthWalmartEnrichmentQuote,
): string {
  return canonicalBytes(quote).toString("utf8");
}

export function parseProductTruthWalmartEnrichmentQuote(
  value: unknown,
): ProductTruthWalmartEnrichmentQuote {
  if (!isRecord(value)) {
    fail("ENRICHMENT_QUOTE_INVALID", "quote must be an object");
  }
  exactKeys(value, [
    "schemaVersion",
    "quoteId",
    "batchId",
    "requestedByUserId",
    "createdAt",
    "expiresAt",
    "costUnit",
    "actions",
    "totals",
    "decision",
    "claims",
  ], "quote");
  if (
    value.schemaVersion !== PRODUCT_TRUTH_WALMART_ENRICHMENT_QUOTE_VERSION
    || typeof value.quoteId !== "string"
    || !/^ptq-[a-f0-9]{32}$/u.test(value.quoteId)
    || typeof value.batchId !== "string"
    || typeof value.requestedByUserId !== "string"
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", "quote identity is invalid");
  }
  const batchId = safeToken(value.batchId, "batchId");
  const requestedByUserId = safeToken(value.requestedByUserId, "requestedByUserId");
  const createdAt = exactInstant(String(value.createdAt), "createdAt");
  const expiresAt = exactInstant(String(value.expiresAt), "expiresAt");
  if (Date.parse(createdAt) >= Date.parse(expiresAt)) {
    fail("ENRICHMENT_QUOTE_EXPIRED", "quote window is invalid");
  }
  if (!isRecord(value.costUnit)) {
    fail("ENRICHMENT_QUOTE_INVALID", "costUnit must be an object");
  }
  exactKeys(value.costUnit, ["kind", "usdEquivalent"], "costUnit");
  if (
    value.costUnit.kind !== "PREPAID_PROVIDER_CREDITS"
    || value.costUnit.usdEquivalent !== null
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", "cost unit is not canonical");
  }
  if (!isRecord(value.actions) || !isRecord(value.actions.balanceProbe)) {
    fail("ENRICHMENT_QUOTE_INVALID", "actions are invalid");
  }
  exactKeys(value.actions, ["balanceProbe", "jobs"], "actions");
  exactKeys(
    value.actions.balanceProbe,
    ["provider", "operation", "maxCalls", "maximumProviderUnits", "purpose"],
    "actions.balanceProbe",
  );
  if (
    value.actions.balanceProbe.provider !== "unwrangle"
    || value.actions.balanceProbe.operation !== "balance_probe"
    || value.actions.balanceProbe.maxCalls !== 1
    || value.actions.balanceProbe.maximumProviderUnits
      !== PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS
    || value.actions.balanceProbe.purpose !== "FRESH_RESERVE_FLOOR_EVIDENCE"
    || !Array.isArray(value.actions.jobs)
    || value.actions.jobs.length < 1
    || value.actions.jobs.length > 5
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", "quoted actions are outside the sealed lane");
  }
  const jobs = value.actions.jobs.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.oxylabs) || !isRecord(entry.unwrangle)) {
      fail("ENRICHMENT_QUOTE_INVALID", `actions.jobs[${index}] is invalid`);
    }
    exactKeys(entry, [
      "ordinal",
      "runId",
      "planSha256",
      "donorProductId",
      "canonicalVariantId",
      "title",
      "missingFields",
      "oxylabs",
      "unwrangle",
      "maximumProviderUnits",
      "maxWallClockMs",
    ], `actions.jobs[${index}]`);
    exactKeys(
      entry.oxylabs,
      ["operation", "maxCalls", "maximumProviderUnits"],
      `actions.jobs[${index}].oxylabs`,
    );
    exactKeys(
      entry.unwrangle,
      ["operation", "maxCalls", "maximumProviderUnits"],
      `actions.jobs[${index}].unwrangle`,
    );
    if (
      entry.ordinal !== index + 1
      || typeof entry.runId !== "string"
      || typeof entry.planSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.planSha256)
      || typeof entry.donorProductId !== "string"
      || typeof entry.canonicalVariantId !== "string"
      || typeof entry.title !== "string"
      || entry.title.length < 1
      || entry.title.length > 500
      || !Array.isArray(entry.missingFields)
      || entry.missingFields.length < 1
      || !entry.missingFields.every((field) =>
        typeof field === "string" && /^[A-Z][A-Z0-9_]*$/u.test(field))
      || entry.oxylabs.operation !== "query"
      || entry.oxylabs.maxCalls !== 1
      || entry.oxylabs.maximumProviderUnits !== 1
      || entry.unwrangle.operation !== "detail"
      || entry.unwrangle.maxCalls !== 1
      || entry.unwrangle.maximumProviderUnits !== 2.5
      || entry.maximumProviderUnits !== PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS
      || entry.maxWallClockMs !== TARGETED_WALMART_MAX_WALL_CLOCK_MS
    ) {
      fail("ENRICHMENT_QUOTE_INVALID", `actions.jobs[${index}] drifted`);
    }
    return {
      ordinal: index + 1,
      runId: safeToken(entry.runId, `actions.jobs[${index}].runId`),
      planSha256: entry.planSha256,
      donorProductId: safeToken(
        entry.donorProductId,
        `actions.jobs[${index}].donorProductId`,
      ),
      canonicalVariantId: safeToken(
        entry.canonicalVariantId,
        `actions.jobs[${index}].canonicalVariantId`,
      ),
      title: entry.title,
      missingFields: [...entry.missingFields] as string[],
      oxylabs: {
        operation: "query" as const,
        maxCalls: 1 as const,
        maximumProviderUnits: 1 as const,
      },
      unwrangle: {
        operation: "detail" as const,
        maxCalls: 1 as const,
        maximumProviderUnits: 2.5 as const,
      },
      maximumProviderUnits: PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS,
      maxWallClockMs: TARGETED_WALMART_MAX_WALL_CLOCK_MS,
    };
  });
  if (!isRecord(value.totals)) {
    fail("ENRICHMENT_QUOTE_INVALID", "totals are invalid");
  }
  exactKeys(value.totals, [
    "jobs",
    "balanceProbeMaximumUnits",
    "oxylabsMaximumUnits",
    "unwrangleDetailMaximumUnits",
    "maximumProviderUnits",
  ], "totals");
  const expectedMaximum =
    PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS
    + jobs.length * PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS;
  if (
    value.totals.jobs !== jobs.length
    || value.totals.balanceProbeMaximumUnits
      !== PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS
    || value.totals.oxylabsMaximumUnits !== jobs.length
    || value.totals.unwrangleDetailMaximumUnits !== jobs.length * 2.5
    || value.totals.maximumProviderUnits !== expectedMaximum
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", "quoted totals do not add up");
  }
  if (!isRecord(value.decision) || !isRecord(value.claims)) {
    fail("ENRICHMENT_QUOTE_INVALID", "decision or claims are invalid");
  }
  exactKeys(value.decision, [
    "eachExactTargetApprovedSeparately",
    "oneOwnerClickMayApproveAllDisplayedTargets",
    "declineLeavesCatalogUnchanged",
    "approvalDoesNotPublishListings",
  ], "decision");
  exactKeys(value.claims, [
    "oneInitialBalanceProbeMaximum",
    "nextJobUsesPriorDetailBalanceEvidence",
    "missingOrStaleBalanceStopsWithoutExtraSpend",
    "concurrency",
    "maxAttemptsPerJob",
    "automaticReplay",
    "marketplaceMutations",
    "clubsForbidden",
    "bjsForbidden",
  ], "claims");
  if (
    Object.values(value.decision).some((entry) => entry !== true)
    || value.claims.oneInitialBalanceProbeMaximum !== true
    || value.claims.nextJobUsesPriorDetailBalanceEvidence !== true
    || value.claims.missingOrStaleBalanceStopsWithoutExtraSpend !== true
    || value.claims.concurrency !== 1
    || value.claims.maxAttemptsPerJob !== 1
    || value.claims.automaticReplay !== false
    || value.claims.marketplaceMutations !== 0
    || value.claims.clubsForbidden !== true
    || value.claims.bjsForbidden !== true
  ) {
    fail("ENRICHMENT_QUOTE_INVALID", "quote safety claims drifted");
  }
  const quote: ProductTruthWalmartEnrichmentQuote = {
    schemaVersion: PRODUCT_TRUTH_WALMART_ENRICHMENT_QUOTE_VERSION,
    quoteId: value.quoteId,
    batchId,
    requestedByUserId,
    createdAt,
    expiresAt,
    costUnit: {
      kind: "PREPAID_PROVIDER_CREDITS",
      usdEquivalent: null,
    },
    actions: {
      balanceProbe: {
        provider: "unwrangle",
        operation: "balance_probe",
        maxCalls: 1,
        maximumProviderUnits: PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS,
        purpose: "FRESH_RESERVE_FLOOR_EVIDENCE",
      },
      jobs,
    },
    totals: {
      jobs: jobs.length,
      balanceProbeMaximumUnits: PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS,
      oxylabsMaximumUnits: jobs.length,
      unwrangleDetailMaximumUnits: jobs.length * 2.5,
      maximumProviderUnits: expectedMaximum,
    },
    decision: {
      eachExactTargetApprovedSeparately: true,
      oneOwnerClickMayApproveAllDisplayedTargets: true,
      declineLeavesCatalogUnchanged: true,
      approvalDoesNotPublishListings: true,
    },
    claims: {
      oneInitialBalanceProbeMaximum: true,
      nextJobUsesPriorDetailBalanceEvidence: true,
      missingOrStaleBalanceStopsWithoutExtraSpend: true,
      concurrency: 1,
      maxAttemptsPerJob: 1,
      automaticReplay: false,
      marketplaceMutations: 0,
      clubsForbidden: true,
      bjsForbidden: true,
    },
  };
  const { quoteId: ignoredQuoteId, ...unsigned } = quote;
  void ignoredQuoteId;
  const expectedQuoteId = `ptq-${sha256(canonicalBytes(unsigned)).slice(0, 32)}`;
  if (quote.quoteId !== expectedQuoteId) {
    fail("ENRICHMENT_QUOTE_INVALID", "quoteId does not bind the exact quote");
  }
  return quote;
}

function assertPlanCeilings(
  plan: ProductTruthTargetedWalmartEvidencePlan,
): void {
  const ceilings = [...plan.providerCeilings].sort((left, right) =>
    left.provider.localeCompare(right.provider, "en-US"),
  );
  if (
    ceilings.length !== 2
    || ceilings[0]?.provider !== "oxylabs"
    || JSON.stringify(ceilings[0]?.operations) !== '["query"]'
    || ceilings[0]?.maxCalls !== 1
    || ceilings[0]?.maxUnits !== 1
    || ceilings[1]?.provider !== "unwrangle"
    || JSON.stringify(ceilings[1]?.operations) !== '["detail"]'
    || ceilings[1]?.maxCalls !== 1
    || ceilings[1]?.maxUnits !== 2.5
    || plan.maxWallClockMs !== TARGETED_WALMART_MAX_WALL_CLOCK_MS
  ) {
    fail(
      "ENRICHMENT_QUOTE_PLAN_DRIFT",
      "targeted plan differs from the exact 1 + 2.5 credit lane",
    );
  }
}

export function buildProductTruthWalmartEnrichmentQuote(input: {
  batchId: string;
  requestedByUserId: string;
  createdAt: string;
  entries: readonly {
    job: ProductTruthWalmartCollectionJob;
    plan: ProductTruthTargetedWalmartEvidencePlan;
  }[];
}): ProductTruthWalmartEnrichmentQuote {
  const batchId = safeToken(input.batchId, "batchId");
  const requestedByUserId = safeToken(
    input.requestedByUserId,
    "requestedByUserId",
  );
  const createdAt = exactInstant(input.createdAt, "createdAt");
  if (input.entries.length < 1 || input.entries.length > 5) {
    fail("ENRICHMENT_QUOTE_INVALID", "quote must contain one to five exact jobs");
  }
  const entries = input.entries.map((raw, index) => {
    const job = parseProductTruthWalmartCollectionJob(raw.job);
    const plan = parseProductTruthTargetedWalmartEvidencePlan(raw.plan);
    assertPlanCeilings(plan);
    if (
      job.batchId !== batchId
      || job.ordinal !== index
      || job.runId !== plan.runId
      || job.target.donorProductId !== plan.targets[0].donorProductId
      || job.target.canonicalVariantId !== plan.targets[0].canonicalVariantId
    ) {
      fail(
        "ENRICHMENT_QUOTE_SCOPE_MISMATCH",
        `job ${index + 1} differs from its exact sealed plan`,
      );
    }
    return { job, plan };
  });
  const expiresAt = exactInstant(
    entries
      .map(({ plan }) => plan.expiresAt)
      .sort()[0]!,
    "expiresAt",
  );
  if (Date.parse(createdAt) >= Date.parse(expiresAt)) {
    fail("ENRICHMENT_QUOTE_EXPIRED", "all plans must outlive the quote");
  }
  const actions = {
    balanceProbe: {
      provider: "unwrangle" as const,
      operation: "balance_probe" as const,
      maxCalls: 1 as const,
      maximumProviderUnits: PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS,
      purpose: "FRESH_RESERVE_FLOOR_EVIDENCE" as const,
    },
    jobs: entries.map(({ job, plan }) => ({
      ordinal: job.ordinal + 1,
      runId: plan.runId,
      planSha256: productTruthOperationalSha256(plan),
      donorProductId: plan.targets[0].donorProductId,
      canonicalVariantId: plan.targets[0].canonicalVariantId,
      title: job.target.title,
      missingFields: job.target.missingFields,
      oxylabs: {
        operation: "query" as const,
        maxCalls: 1 as const,
        maximumProviderUnits: 1 as const,
      },
      unwrangle: {
        operation: "detail" as const,
        maxCalls: 1 as const,
        maximumProviderUnits: 2.5 as const,
      },
      maximumProviderUnits: PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS,
      maxWallClockMs: TARGETED_WALMART_MAX_WALL_CLOCK_MS,
    })),
  };
  const unsigned = {
    schemaVersion: PRODUCT_TRUTH_WALMART_ENRICHMENT_QUOTE_VERSION,
    batchId,
    requestedByUserId,
    createdAt,
    expiresAt,
    costUnit: {
      kind: "PREPAID_PROVIDER_CREDITS" as const,
      usdEquivalent: null,
    },
    actions,
    totals: {
      jobs: actions.jobs.length,
      balanceProbeMaximumUnits:
        PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS,
      oxylabsMaximumUnits: actions.jobs.length,
      unwrangleDetailMaximumUnits: actions.jobs.length * 2.5,
      maximumProviderUnits:
        PRODUCT_TRUTH_WALMART_BALANCE_PROBE_UNITS
        + actions.jobs.length * PRODUCT_TRUTH_WALMART_JOB_MAXIMUM_UNITS,
    },
    decision: {
      eachExactTargetApprovedSeparately: true as const,
      oneOwnerClickMayApproveAllDisplayedTargets: true as const,
      declineLeavesCatalogUnchanged: true as const,
      approvalDoesNotPublishListings: true as const,
    },
    claims: {
      oneInitialBalanceProbeMaximum: true as const,
      nextJobUsesPriorDetailBalanceEvidence: true as const,
      missingOrStaleBalanceStopsWithoutExtraSpend: true as const,
      concurrency: 1 as const,
      maxAttemptsPerJob: 1 as const,
      automaticReplay: false as const,
      marketplaceMutations: 0 as const,
      clubsForbidden: true as const,
      bjsForbidden: true as const,
    },
  };
  const quoteSeed = sha256(canonicalBytes(unsigned));
  const {
    schemaVersion,
    batchId: sealedBatchId,
    requestedByUserId: sealedRequestedBy,
    ...remainder
  } = unsigned;
  return {
    schemaVersion,
    quoteId: `ptq-${quoteSeed.slice(0, 32)}`,
    batchId: sealedBatchId,
    requestedByUserId: sealedRequestedBy,
    ...remainder,
  };
}
