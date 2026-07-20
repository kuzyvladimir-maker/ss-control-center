import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";

import {
  costOneSku,
  type CostResult,
  type CostSourcePolicy,
} from "./cogs-engine";
import {
  executeProductTruthDonorHarvests,
  inspectProductTruthDonorContent,
  productTruthDonorIds,
  assessProductTruthOperationalSnapshot,
  type ProductTruthDonorContentInspection,
  type ProductTruthDonorHarvestOutcome,
  type ProductTruthOperationalTruthAssessment,
} from "./product-truth-operational-domain";
import {
  assertProductTruthOperationalLedgerBinding,
  assertProductTruthOperationalLedgerSettled,
  productTruthOperationalLedgerDelta,
  readProductTruthOperationalLedger,
  ProductTruthOperationalLedgerError,
  type ProductTruthOperationalLedgerSnapshot,
} from "./product-truth-operational-ledger";
import {
  ensureProductTruthOperationalQueueJob,
} from "./product-truth-operational-queue";
import {
  PRODUCT_TRUTH_OPERATIONAL_RESULT_VERSION,
  parseProductTruthOperationalPlan,
  productTruthOperationalSha256,
  validateProductTruthOperationalApproval,
  type ProductTruthOperationalPlan,
  type ProductTruthOperationalTarget,
  type ValidatedProductTruthOperationalApproval,
} from "./product-truth-operational-run-contract";
import {
  acquireProductTruthOperationalRunLease,
  bindProductTruthOperationalQueueJob,
  claimNextProductTruthOperationalItem,
  finishProductTruthOperationalRun,
  getProductTruthOperationalRun,
  heartbeatProductTruthOperationalItemLease,
  heartbeatProductTruthOperationalRunLease,
  listProductTruthOperationalRunItems,
  productTruthOperationalRunSummary,
  reapExpiredProductTruthOperationalEnvironmentRun,
  reapExpiredProductTruthOperationalRun,
  seedProductTruthOperationalRun,
  startProductTruthOperationalAttempt,
  terminalizeProductTruthOperationalPreAttempt,
  terminalizeProductTruthOperationalAttempt,
  transitionProductTruthOperationalItem,
  type ProductTruthOperationalEnvironment,
  type ProductTruthOperationalRunStatus,
  type StoredProductTruthOperationalRun,
  type StoredProductTruthOperationalRunItem,
} from "./product-truth-operational-run-store";
import { readProductTruthSnapshot, type ProductTruthSnapshot } from "./product-truth-read-contract";
import { ensureMeteredProviderBudget } from "./metered-budget-store";
import {
  isMeteredProviderControlError,
  MeteredProviderReplayError,
  MeteredProviderSettlementFailureError,
} from "./metered-provider-call";

export const PRODUCT_TRUTH_OPERATIONAL_RUNNER_VERSION =
  "product-truth-operational-runner/1.0.0" as const;
export const PRODUCT_TRUTH_OPERATIONAL_REPORT_VERSION =
  "product-truth-operational-report/1.0.0" as const;

const LEASE_DURATION_MS = 4 * 60 * 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1_000;

export type ProductTruthOperationalCommand = "execute" | "resume";

export interface ProductTruthOperationalExecutionAdapter {
  cost(
    db: Client,
    input: { target: ProductTruthOperationalTarget; plan: ProductTruthOperationalPlan },
  ): Promise<CostResult>;
  readSnapshot(
    db: Client,
    input: {
      target: ProductTruthOperationalTarget;
      plan: ProductTruthOperationalPlan;
      asOf: string;
    },
  ): Promise<ProductTruthSnapshot>;
  inspectDonors(
    db: Client,
    input: {
      snapshot: ProductTruthSnapshot;
      cost: CostResult | null;
      plan: ProductTruthOperationalPlan;
    },
  ): Promise<ProductTruthDonorContentInspection[]>;
  harvestDonors(
    db: Client,
    input: {
      inspections: readonly ProductTruthDonorContentInspection[];
      runId: string;
      approvalId: string;
      leaseOwner: string;
      now: () => string;
    },
  ): Promise<ProductTruthDonorHarvestOutcome[]>;
}

export interface ProductTruthOperationalItemResult {
  schemaVersion: "product-truth-operational-item-result/1.0.0";
  listingKey: string;
  target: {
    channel: "amazon" | "walmart";
    storeIndex: number;
    sku: string;
  };
  outcome: ProductTruthOperationalTruthAssessment["outcome"] | "BLOCKED" | "AMBIGUOUS" | "FAILED";
  reused: boolean;
  cost: {
    status: CostResult["status"] | null;
    total: number | null;
    perUnit: number | null;
    packSize: number | null;
    needsReview: boolean | null;
    methods: string[];
    error: string | null;
  };
  completedFields: string[];
  unavailableFields: string[];
  consumers: ProductTruthOperationalTruthAssessment["consumers"] | null;
  blockers: string[];
  donors: Array<{
    donorProductId: string;
    disposition: string;
    source: string | null;
    stateStatus: string | null;
    reason: string;
  }>;
  metered: ProductTruthOperationalLedgerSnapshot;
}

export interface ProductTruthOperationalReport {
  schemaVersion: typeof PRODUCT_TRUTH_OPERATIONAL_REPORT_VERSION;
  runnerVersion: typeof PRODUCT_TRUTH_OPERATIONAL_RUNNER_VERSION;
  resultContractVersion: typeof PRODUCT_TRUTH_OPERATIONAL_RESULT_VERSION;
  runId: string;
  approvalId: string;
  planSha256: string;
  manifestSha256: string;
  targetSetSha256: string;
  mode: ProductTruthOperationalPlan["mode"];
  environment: ProductTruthOperationalEnvironment;
  outcome: "COMPLETED" | "COMPLETED_WITH_GAPS" | "INTERRUPTED" | "BLOCKED" | "AMBIGUOUS" | "FAILED";
  generatedAt: string;
  claims: ProductTruthOperationalPlan["claims"];
  counts: Record<string, number>;
  items: Array<{
    ordinal: number;
    listingKey: string;
    status: StoredProductTruthOperationalRunItem["status"];
    stage: string;
    attempts: number;
    queueJobId: string | null;
    resultSha256: string | null;
    lastError: string | null;
    finishedAt: string | null;
  }>;
  ledger: ProductTruthOperationalLedgerSnapshot;
}

export interface ProductTruthOperationalArtifactHashes {
  reportSha256: string;
  artifactIndexSha256: string;
}

export interface ExecuteProductTruthOperationalRunInput {
  plan: ProductTruthOperationalPlan;
  validatedApproval: ValidatedProductTruthOperationalApproval;
  environment: ProductTruthOperationalEnvironment;
  command: ProductTruthOperationalCommand;
  leaseOwner: string;
  /** Exact DB target reused by the independently created metered-ledger clients. */
  meteredDatabase: {
    url: string;
    authToken?: string;
    targetFingerprint: string;
  };
  artifactWriter: (
    report: ProductTruthOperationalReport,
  ) => Promise<ProductTruthOperationalArtifactHashes>;
  /** Test seam. Production callers must leave this unset. */
  adapter?: ProductTruthOperationalExecutionAdapter;
  /** Test seam. Production callers must leave this unset. */
  now?: () => string;
  /** Test seam. Production callers must leave this unset. */
  heartbeatIntervalMs?: number;
}

export interface ProductTruthOperationalExecutionResult {
  runId: string;
  status: ProductTruthOperationalRunStatus;
  report: ProductTruthOperationalReport;
  reportSha256: string;
  artifactIndexSha256: string;
}

export class ProductTruthOperationalRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthOperationalRunnerError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthOperationalRunnerError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function canonicalNow(now: () => string): string {
  const value = now();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("OPERATIONAL_CLOCK_INVALID", "clock returned an invalid timestamp");
  return new Date(timestamp).toISOString();
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function safeCostResult(cost: CostResult | null): ProductTruthOperationalItemResult["cost"] {
  return {
    status: cost?.status ?? null,
    total: typeof cost?.total === "number" && Number.isFinite(cost.total) ? cost.total : null,
    perUnit: typeof cost?.perUnit === "number" && Number.isFinite(cost.perUnit) ? cost.perUnit : null,
    packSize: typeof cost?.packSize === "number" && Number.isFinite(cost.packSize) ? cost.packSize : null,
    needsReview: typeof cost?.needsReview === "boolean" ? cost.needsReview : null,
    methods: Array.isArray(cost?.methods) ? [...new Set(cost.methods.filter((item) => typeof item === "string"))].sort() : [],
    error: typeof cost?.error === "string" ? cost.error.slice(0, 500) : null,
  };
}

function donorResults(
  outcomes: readonly ProductTruthDonorHarvestOutcome[],
): ProductTruthOperationalItemResult["donors"] {
  return outcomes.map((outcome) => ({
    donorProductId: outcome.donorProductId,
    disposition: outcome.disposition,
    source: outcome.source,
    stateStatus: outcome.stateStatus,
    reason: outcome.reason,
  }));
}

function buildItemResult(input: {
  target: ProductTruthOperationalTarget;
  assessment?: ProductTruthOperationalTruthAssessment | null;
  cost?: CostResult | null;
  harvestOutcomes?: readonly ProductTruthDonorHarvestOutcome[];
  ledger: ProductTruthOperationalLedgerSnapshot;
  reused: boolean;
  forcedOutcome?: ProductTruthOperationalItemResult["outcome"];
  extraBlockers?: readonly string[];
}): ProductTruthOperationalItemResult {
  const assessment = input.assessment ?? null;
  return {
    schemaVersion: "product-truth-operational-item-result/1.0.0",
    listingKey: input.target.listingKey,
    target: {
      channel: input.target.channel,
      storeIndex: input.target.storeIndex,
      sku: input.target.sku,
    },
    outcome: input.forcedOutcome ?? assessment?.outcome ?? "FAILED",
    reused: input.reused,
    cost: safeCostResult(input.cost ?? null),
    completedFields: [...(assessment?.completedFields ?? [])].sort(),
    unavailableFields: [...(assessment?.unavailableFields ?? input.target.requestedFields)].sort(),
    consumers: assessment?.consumers ?? null,
    blockers: [...new Set([
      ...(assessment?.blockers ?? []),
      ...(input.extraBlockers ?? []),
    ].filter(Boolean))].sort(),
    donors: donorResults(input.harvestOutcomes ?? []),
    metered: input.ledger,
  };
}

function resultCheckpoint(input: {
  stage: string;
  cost: CostResult | null;
  assessment: ProductTruthOperationalTruthAssessment | null;
  ledger: ProductTruthOperationalLedgerSnapshot;
}): Record<string, unknown> {
  return {
    schemaVersion: "product-truth-operational-checkpoint/1.0.0",
    stage: input.stage,
    costStatus: input.cost?.status ?? null,
    completedFields: input.assessment?.completedFields ?? [],
    unavailableFields: input.assessment?.unavailableFields ?? [],
    meteredReceiptIds: input.ledger.receipts.map((receipt) => receipt.receiptId),
  };
}

function sourcePolicy(plan: ProductTruthOperationalPlan): CostSourcePolicy {
  return {
    retailerAllowlist: [...plan.sourcePolicy.retailers],
    allowClubRetailers: plan.sourcePolicy.allowClubs,
  } as CostSourcePolicy;
}

export const PRODUCT_TRUTH_OPERATIONAL_PRODUCTION_ADAPTER: ProductTruthOperationalExecutionAdapter = {
  async cost(db, { target, plan }) {
    return costOneSku(db, {
      sku: target.sku,
      channel: target.channel,
      storeIndex: target.storeIndex,
      sourcePolicy: sourcePolicy(plan),
      dry: false,
    });
  },
  async readSnapshot(db, { target, plan, asOf }) {
    return readProductTruthSnapshot(db, {
      sku: target.sku,
      channel: target.channel,
      storeIndex: target.storeIndex,
      expectedManifestSha256: plan.manifest.sha256,
      asOf,
      maxPriceAgeMs: plan.verificationPolicy.maxPriceAgeMs,
    });
  },
  async inspectDonors(db, { snapshot, cost, plan }) {
    return inspectProductTruthDonorContent(db, {
      donorProductIds: productTruthDonorIds(snapshot, cost),
      sourcePolicy: plan.sourcePolicy,
      minGalleryImages: plan.verificationPolicy.minGalleryImages,
    });
  },
  async harvestDonors(db, input) {
    return executeProductTruthDonorHarvests(db, input);
  },
};

function leaseExpiry(now: string, currentExpiry?: string | null): string {
  const current = currentExpiry ? Date.parse(currentExpiry) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(Date.parse(now) + LEASE_DURATION_MS, current + 1_000)).toISOString();
}

function estimatedSpendUnits(plan: ProductTruthOperationalPlan): number {
  const total = plan.providerCeilings.reduce(
    (sum, ceiling) => sum + (ceiling.maxUnits ?? ceiling.maxCalls),
    0,
  );
  return total / plan.targets.length;
}

function targetForItem(
  plan: ProductTruthOperationalPlan,
  item: StoredProductTruthOperationalRunItem,
): ProductTruthOperationalTarget {
  const target = plan.targets[item.ordinal];
  if (!target || target.listingKey !== item.listingKey) {
    fail("OPERATIONAL_ITEM_SCOPE_MISMATCH", `item ${item.id} differs from sealed target ordinal`);
  }
  return target;
}

let runtimeEnvironmentOwner: string | null = null;

async function withOperationalRuntimeEnvironment<T>(
  input: {
    runId: string;
    approval: ValidatedProductTruthOperationalApproval;
    database: ExecuteProductTruthOperationalRunInput["meteredDatabase"];
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (runtimeEnvironmentOwner !== null) {
    fail("OPERATIONAL_PROCESS_LOCK_HELD", `process runtime is already owned by ${runtimeEnvironmentOwner}`);
  }
  runtimeEnvironmentOwner = input.runId;
  const keys = [
    "SS_METERED_RUN_PERMIT",
    "SS_METERED_RUN_CONFIRM",
    "SS_VISION_FREE_ONLY",
    "SS_VISION_PROVIDER",
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "DATABASE_URL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SS_METERED_RUN_PERMIT = input.approval.encodedPermit;
  process.env.SS_METERED_RUN_CONFIRM = input.approval.meteredConfirmation;
  process.env.SS_VISION_FREE_ONLY = "1";
  process.env.SS_VISION_PROVIDER = "auto";
  process.env.TURSO_DATABASE_URL = input.database.url;
  process.env.DATABASE_URL = input.database.url;
  if (input.database.authToken) process.env.TURSO_AUTH_TOKEN = input.database.authToken;
  else delete process.env.TURSO_AUTH_TOKEN;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    runtimeEnvironmentOwner = null;
  }
}

type HeartbeatState = {
  item: StoredProductTruthOperationalRunItem;
  run: StoredProductTruthOperationalRun;
};

class OperationalHeartbeat {
  private state: HeartbeatState;
  private readonly db: Client;
  private readonly runLeaseToken: string;
  private readonly itemLeaseToken: string;
  private readonly queueLeaseToken: string | null;
  private readonly now: () => string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private failure: unknown = null;

  constructor(input: {
    db: Client;
    state: HeartbeatState;
    runLeaseToken: string;
    itemLeaseToken: string;
    queueLeaseToken: string | null;
    now: () => string;
    intervalMs: number;
  }) {
    this.db = input.db;
    this.state = input.state;
    this.runLeaseToken = input.runLeaseToken;
    this.itemLeaseToken = input.itemLeaseToken;
    this.queueLeaseToken = input.queueLeaseToken;
    this.now = input.now;
    this.intervalMs = input.intervalMs;
  }

  private async pulse(): Promise<void> {
    const at = canonicalNow(this.now);
    const heartbeat = await heartbeatProductTruthOperationalItemLease(this.db, {
      runId: this.state.run.runId,
      runLeaseToken: this.runLeaseToken,
      itemId: this.state.item.id,
      itemLeaseToken: this.itemLeaseToken,
      queueLeaseToken: this.queueLeaseToken,
      at,
      leaseExpiresAt: leaseExpiry(at, this.state.run.leaseExpiresAt),
    });
    this.state = heartbeat;
  }

  private schedulePulse(): void {
    if (this.inFlight || this.failure) return;
    this.inFlight = this.pulse()
      .catch((error: unknown) => {
        this.failure = error;
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  async start(): Promise<void> {
    await this.pulse();
    this.timer = setInterval(() => this.schedulePulse(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<HeartbeatState> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
    if (this.failure) {
      throw new ProductTruthOperationalRunnerError(
        "OPERATIONAL_HEARTBEAT_LOST",
        "atomic run/item/queue heartbeat failed",
        { cause: this.failure },
      );
    }
    return this.state;
  }
}

async function inspectAssessment(
  adapter: ProductTruthOperationalExecutionAdapter,
  db: Client,
  input: {
    target: ProductTruthOperationalTarget;
    plan: ProductTruthOperationalPlan;
    asOf: string;
    cost: CostResult | null;
  },
): Promise<{
  snapshot: ProductTruthSnapshot;
  inspections: ProductTruthDonorContentInspection[];
  assessment: ProductTruthOperationalTruthAssessment;
}> {
  const snapshot = await adapter.readSnapshot(db, input);
  const inspections = await adapter.inspectDonors(db, {
    snapshot,
    cost: input.cost,
    plan: input.plan,
  });
  return {
    snapshot,
    inspections,
    assessment: assessProductTruthOperationalSnapshot({
      snapshot,
      donorInspections: inspections,
      cost: input.cost,
    }),
  };
}

function classifyAttemptError(
  error: unknown,
  ledger: ProductTruthOperationalLedgerSnapshot,
): "blocked" | "ambiguous" | "failed" {
  if (ledger.receipts.some((receipt) => receipt.status === "pending" || receipt.status === "reserved")) {
    return "ambiguous";
  }
  if (
    error instanceof MeteredProviderReplayError
    || error instanceof MeteredProviderSettlementFailureError
    || (
      error instanceof ProductTruthOperationalLedgerError
      && error.code === "OPERATIONAL_LEDGER_OUTCOME_AMBIGUOUS"
    )
  ) return "ambiguous";
  if (isMeteredProviderControlError(error)) return "blocked";
  return "failed";
}

function queueTerminalForAssessment(
  assessment: ProductTruthOperationalTruthAssessment,
  cost: CostResult,
): "done" | "partial" | "source_unavailable" {
  if (assessment.complete) return "done";
  if (cost.status === "no-input" || assessment.outcome === "UNSOURCEABLE") {
    return "source_unavailable";
  }
  return "partial";
}

async function executeAttemptedItem(input: {
  db: Client;
  plan: ProductTruthOperationalPlan;
  approval: ValidatedProductTruthOperationalApproval;
  adapter: ProductTruthOperationalExecutionAdapter;
  run: StoredProductTruthOperationalRun;
  item: StoredProductTruthOperationalRunItem;
  target: ProductTruthOperationalTarget;
  runLeaseToken: string;
  itemLeaseToken: string;
  queueLeaseToken: string;
  leaseOwner: string;
  now: () => string;
  heartbeatIntervalMs: number;
  ledgerBefore: ProductTruthOperationalLedgerSnapshot;
}): Promise<{
  item: StoredProductTruthOperationalRunItem;
  run: StoredProductTruthOperationalRun;
  stopRun: boolean;
}> {
  let { item, run } = input;
  let cost: CostResult | null = null;
  let assessment: ProductTruthOperationalTruthAssessment | null = null;
  let harvestOutcomes: ProductTruthDonorHarvestOutcome[] = [];
  let heartbeat: OperationalHeartbeat | null = new OperationalHeartbeat({
    db: input.db,
    state: { run, item },
    runLeaseToken: input.runLeaseToken,
    itemLeaseToken: input.itemLeaseToken,
    queueLeaseToken: input.queueLeaseToken,
    now: input.now,
    intervalMs: input.heartbeatIntervalMs,
  });

  try {
    await heartbeat.start();
    cost = await input.adapter.cost(input.db, { target: input.target, plan: input.plan });
    ({ run, item } = await heartbeat.stop());
    heartbeat = null;

    if (cost.status === "no-input") {
      const ledgerAfter = await readProductTruthOperationalLedger(input.db, input.plan.runId);
      await assertProductTruthOperationalLedgerBinding(input.db, {
        plan: input.plan,
        approvalId: input.approval.approval.approvalId,
      });
      const ledger = productTruthOperationalLedgerDelta(input.ledgerBefore, ledgerAfter);
      assertProductTruthOperationalLedgerSettled(ledger);
      const result = buildItemResult({
        target: input.target,
        cost,
        ledger,
        reused: false,
        forcedOutcome: "UNSOURCEABLE",
        extraBlockers: ["AUTHORITATIVE_LISTING_INPUT_UNAVAILABLE"],
      });
      const terminal = await terminalizeProductTruthOperationalAttempt(input.db, {
        item,
        runLeaseToken: input.runLeaseToken,
        itemLeaseToken: input.itemLeaseToken,
        queueLeaseToken: input.queueLeaseToken,
        queueStatus: "source_unavailable",
        itemStatus: "terminal_gap",
        stage: "LISTING_INPUT_SOURCE_UNAVAILABLE",
        at: canonicalNow(input.now),
        completedFields: [],
        unavailableFields: input.target.requestedFields,
        actualSpendUnits: ledger.totals.units,
        result,
        checkpoint: resultCheckpoint({
          stage: "NO_LISTING_INPUT",
          cost,
          assessment: null,
          ledger,
        }),
        terminalReason: "PRODUCT_TRUTH_SOURCE_UNAVAILABLE",
      });
      return { item: terminal.item, run, stopRun: false };
    }

    if (cost.status === "error" || cost.status === "dry") {
      throw new Error(cost.error || `COGS_ENGINE_${cost.status.toUpperCase()}`);
    }

    item = await transitionProductTruthOperationalItem(input.db, {
      item,
      runLeaseToken: input.runLeaseToken,
      leaseToken: input.itemLeaseToken,
      nextStatus: "harvesting",
      stage: "HARVESTING_CONTENT",
      at: canonicalNow(input.now),
      checkpoint: {
        schemaVersion: "product-truth-operational-checkpoint/1.0.0",
        stage: "COST_COMPLETE",
        costStatus: cost.status,
      },
    });

    heartbeat = new OperationalHeartbeat({
      db: input.db,
      state: { run, item },
      runLeaseToken: input.runLeaseToken,
      itemLeaseToken: input.itemLeaseToken,
      queueLeaseToken: input.queueLeaseToken,
      now: input.now,
      intervalMs: input.heartbeatIntervalMs,
    });
    await heartbeat.start();
    const afterCost = await inspectAssessment(input.adapter, input.db, {
      target: input.target,
      plan: input.plan,
      asOf: canonicalNow(input.now),
      cost,
    });
    harvestOutcomes = await input.adapter.harvestDonors(input.db, {
      inspections: afterCost.inspections,
      runId: input.plan.runId,
      approvalId: input.approval.approval.approvalId,
      leaseOwner: input.leaseOwner,
      now: input.now,
    });
    ({ run, item } = await heartbeat.stop());
    heartbeat = null;

    item = await transitionProductTruthOperationalItem(input.db, {
      item,
      runLeaseToken: input.runLeaseToken,
      leaseToken: input.itemLeaseToken,
      nextStatus: "verifying",
      stage: "VERIFYING_PRODUCT_TRUTH",
      at: canonicalNow(input.now),
      checkpoint: {
        schemaVersion: "product-truth-operational-checkpoint/1.0.0",
        stage: "HARVEST_COMPLETE",
        costStatus: cost.status,
        donorOutcomes: donorResults(harvestOutcomes),
      },
    });

    const verified = await inspectAssessment(input.adapter, input.db, {
      target: input.target,
      plan: input.plan,
      asOf: canonicalNow(input.now),
      cost,
    });
    assessment = verified.assessment;
    const ledgerAfter = await readProductTruthOperationalLedger(input.db, input.plan.runId);
    await assertProductTruthOperationalLedgerBinding(input.db, {
      plan: input.plan,
      approvalId: input.approval.approval.approvalId,
    });
    const ledger = productTruthOperationalLedgerDelta(input.ledgerBefore, ledgerAfter);
    assertProductTruthOperationalLedgerSettled(ledger);
    const result = buildItemResult({
      target: input.target,
      assessment,
      cost,
      harvestOutcomes,
      ledger,
      reused: false,
    });
    const queueStatus = queueTerminalForAssessment(assessment, cost);
    const terminal = await terminalizeProductTruthOperationalAttempt(input.db, {
      item,
      runLeaseToken: input.runLeaseToken,
      itemLeaseToken: input.itemLeaseToken,
      queueLeaseToken: input.queueLeaseToken,
      queueStatus,
      itemStatus: assessment.complete ? "done" : "terminal_gap",
      stage: assessment.complete ? "PRODUCT_TRUTH_COMPLETE" : "PRODUCT_TRUTH_TERMINAL_GAP",
      at: canonicalNow(input.now),
      completedFields: result.completedFields,
      unavailableFields: result.unavailableFields,
      actualSpendUnits: ledger.totals.units,
      result,
      checkpoint: resultCheckpoint({
        stage: "VERIFIED",
        cost,
        assessment,
        ledger,
      }),
      terminalReason: assessment.complete
        ? null
        : queueStatus === "source_unavailable"
          ? "PRODUCT_TRUTH_SOURCE_UNAVAILABLE"
          : "PRODUCT_TRUTH_FIELDS_UNAVAILABLE",
    });
    return { item: terminal.item, run, stopRun: false };
  } catch (error) {
    if (heartbeat) {
      try {
        ({ run, item } = await heartbeat.stop());
      } catch (heartbeatError) {
        error = new ProductTruthOperationalRunnerError(
          "OPERATIONAL_HEARTBEAT_LOST",
          "work outcome became ambiguous after heartbeat loss",
          { cause: heartbeatError },
        );
      }
    }
    let ledgerAfter: ProductTruthOperationalLedgerSnapshot;
    try {
      ledgerAfter = await readProductTruthOperationalLedger(input.db, input.plan.runId);
    } catch (ledgerError) {
      throw new ProductTruthOperationalRunnerError(
        "OPERATIONAL_RECOVERY_REQUIRED",
        "attempt failed and its durable ledger cannot be read",
        { cause: ledgerError },
      );
    }
    const ledger = productTruthOperationalLedgerDelta(input.ledgerBefore, ledgerAfter);
    const disposition = classifyAttemptError(error, ledger);
    const forcedOutcome = disposition === "blocked"
      ? "BLOCKED"
      : disposition === "ambiguous"
        ? "AMBIGUOUS"
        : "FAILED";
    const result = buildItemResult({
      target: input.target,
      assessment,
      cost,
      harvestOutcomes,
      ledger,
      reused: false,
      forcedOutcome,
      extraBlockers: [errorText(error)],
    });
    try {
      const terminal = await terminalizeProductTruthOperationalAttempt(input.db, {
        item,
        runLeaseToken: input.runLeaseToken,
        itemLeaseToken: input.itemLeaseToken,
        queueLeaseToken: input.queueLeaseToken,
        queueStatus: "error",
        itemStatus: disposition,
        stage: disposition === "blocked"
          ? "EXECUTION_BLOCKED"
          : disposition === "ambiguous"
            ? "EXECUTION_AMBIGUOUS"
            : "EXECUTION_FAILED",
        at: canonicalNow(input.now),
        completedFields: result.completedFields,
        unavailableFields: result.unavailableFields,
        actualSpendUnits: ledger.totals.units,
        result,
        checkpoint: resultCheckpoint({
          stage: forcedOutcome,
          cost,
          assessment,
          ledger,
        }),
        terminalReason: disposition === "blocked"
          ? "METERED_OR_POLICY_CONTROL_BLOCKED"
          : disposition === "ambiguous"
            ? "METERED_ATTEMPT_OUTCOME_AMBIGUOUS"
            : "EXECUTION_FAILED",
        error: errorText(error),
      });
      return { item: terminal.item, run, stopRun: true };
    } catch (terminalError) {
      throw new ProductTruthOperationalRunnerError(
        "OPERATIONAL_RECOVERY_REQUIRED",
        "attempt could not be closed under its exact live leases; wait for reaper before resume",
        { cause: terminalError },
      );
    }
  }
}

function reportOutcome(
  finalStatus: Exclude<ProductTruthOperationalRunStatus, "prepared" | "running">,
  items: readonly StoredProductTruthOperationalRunItem[],
): ProductTruthOperationalReport["outcome"] {
  if (finalStatus === "interrupted") return "INTERRUPTED";
  if (finalStatus === "blocked") return "BLOCKED";
  if (finalStatus === "ambiguous") return "AMBIGUOUS";
  if (finalStatus === "failed") return "FAILED";
  return items.some((item) => item.status === "terminal_gap")
    ? "COMPLETED_WITH_GAPS"
    : "COMPLETED";
}

async function buildReport(
  db: Client,
  input: {
    plan: ProductTruthOperationalPlan;
    environment: ProductTruthOperationalEnvironment;
    finalStatus: Exclude<ProductTruthOperationalRunStatus, "prepared" | "running">;
  },
): Promise<ProductTruthOperationalReport> {
  const summary = await productTruthOperationalRunSummary(db, input.plan.runId);
  const ledger = await readProductTruthOperationalLedger(db, input.plan.runId);
  const generatedAt = summary.items
    .map((item) => item.finishedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? summary.run.updatedAt;
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_REPORT_VERSION,
    runnerVersion: PRODUCT_TRUTH_OPERATIONAL_RUNNER_VERSION,
    resultContractVersion: PRODUCT_TRUTH_OPERATIONAL_RESULT_VERSION,
    runId: input.plan.runId,
    approvalId: summary.run.approvalId,
    planSha256: summary.run.planSha256,
    manifestSha256: summary.run.manifestSha256,
    targetSetSha256: summary.run.targetSetSha256,
    mode: input.plan.mode,
    environment: input.environment,
    outcome: reportOutcome(input.finalStatus, summary.items),
    generatedAt,
    claims: input.plan.claims,
    counts: summary.counts,
    items: summary.items.map((item) => ({
      ordinal: item.ordinal,
      listingKey: item.listingKey,
      status: item.status,
      stage: item.stage,
      attempts: item.attempts,
      queueJobId: item.queueJobId,
      resultSha256: item.resultSha256,
      lastError: item.lastError,
      finishedAt: item.finishedAt,
    })),
    ledger,
  };
}

function chooseFinalStatus(
  items: readonly StoredProductTruthOperationalRunItem[],
  interrupted: boolean,
): Exclude<ProductTruthOperationalRunStatus, "prepared" | "running"> {
  if (items.some((item) => item.status === "ambiguous")) return "ambiguous";
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (interrupted || items.some((item) => item.status === "pending")) return "interrupted";
  if (items.every((item) => item.status === "done" || item.status === "terminal_gap")) {
    return "completed";
  }
  return "failed";
}

async function seedAndAcquire(input: {
  db: Client;
  plan: ProductTruthOperationalPlan;
  approval: ValidatedProductTruthOperationalApproval;
  environment: ProductTruthOperationalEnvironment;
  command: ProductTruthOperationalCommand;
  leaseOwner: string;
  now: () => string;
  runLeaseToken: string;
}): Promise<StoredProductTruthOperationalRun> {
  const at = canonicalNow(input.now);
  const environmentLease = await reapExpiredProductTruthOperationalEnvironmentRun(input.db, {
    environment: input.environment,
    at,
  });
  if (
    environmentLease.status === "not_expired"
    && environmentLease.run
    && environmentLease.run.runId !== input.plan.runId
  ) {
    fail(
      "OPERATIONAL_RUN_LOCK_HELD",
      `environment is owned by active run ${environmentLease.run.runId}`,
    );
  }
  let existing = await getProductTruthOperationalRun(input.db, input.plan.runId);
  if (existing?.status === "running") {
    const reaped = await reapExpiredProductTruthOperationalRun(input.db, {
      runId: input.plan.runId,
      at,
    });
    existing = reaped.run;
  }
  if (input.command === "execute" && existing && existing.status !== "prepared") {
    fail(
      "OPERATIONAL_EXECUTE_STATE_INVALID",
      `run is ${existing.status}; execute only starts prepared work and resume is explicit`,
    );
  }
  if (input.command === "resume" && (!existing || existing.status !== "interrupted")) {
    fail(
      "OPERATIONAL_RESUME_STATE_INVALID",
      `resume requires the exact interrupted run, got ${existing?.status ?? "missing"}`,
    );
  }
  const seeded = await seedProductTruthOperationalRun(input.db, {
    plan: input.plan,
    approvalId: input.approval.approval.approvalId,
    environment: input.environment,
    at,
  });
  if (input.command === "resume" && seeded.created) {
    fail("OPERATIONAL_RESUME_STATE_INVALID", "resume cannot create a run");
  }
  return acquireProductTruthOperationalRunLease(input.db, {
    runId: input.plan.runId,
    leaseOwner: input.leaseOwner,
    leaseToken: input.runLeaseToken,
    at,
    leaseExpiresAt: leaseExpiry(at),
  });
}

/**
 * Execute one sealed Product Truth run. This is the only orchestration entrypoint
 * Claude Code should call: it cannot infer scope, budget, retries, or providers.
 */
export async function executeProductTruthOperationalRun(
  db: Client,
  rawInput: ExecuteProductTruthOperationalRunInput,
): Promise<ProductTruthOperationalExecutionResult> {
  const plan = parseProductTruthOperationalPlan(rawInput.plan);
  const now = rawInput.now ?? (() => new Date().toISOString());
  const approval = validateProductTruthOperationalApproval({
    plan,
    planSha256: productTruthOperationalSha256(plan),
    approval: rawInput.validatedApproval.approval,
    executionConfirmation: rawInput.validatedApproval.executionConfirmation,
    now: canonicalNow(now),
  });
  if (
    approval.encodedPermit !== rawInput.validatedApproval.encodedPermit
    || approval.meteredConfirmation !== rawInput.validatedApproval.meteredConfirmation
  ) {
    fail("OPERATIONAL_APPROVAL_REVALIDATION_FAILED", "validated approval projection differs");
  }
  if (rawInput.environment !== "production" && rawInput.environment !== "local-test") {
    fail("OPERATIONAL_ENVIRONMENT_INVALID", "environment must be production or local-test");
  }
  if (rawInput.command !== "execute" && rawInput.command !== "resume") {
    fail("OPERATIONAL_COMMAND_INVALID", "command must be execute or resume");
  }
  if (!rawInput.leaseOwner || rawInput.leaseOwner !== rawInput.leaseOwner.trim()) {
    fail("OPERATIONAL_LEASE_OWNER_INVALID", "leaseOwner must be exact non-empty text");
  }
  if (typeof rawInput.artifactWriter !== "function") {
    fail("OPERATIONAL_ARTIFACT_WRITER_REQUIRED", "durable artifact writer is required");
  }
  if (
    !rawInput.meteredDatabase
    || typeof rawInput.meteredDatabase.url !== "string"
    || !rawInput.meteredDatabase.url.trim()
    || rawInput.meteredDatabase.url !== rawInput.meteredDatabase.url.trim()
    || rawInput.meteredDatabase.targetFingerprint !== plan.targetFingerprint
  ) {
    fail(
      "OPERATIONAL_METERED_DATABASE_MISMATCH",
      "metered ledger target must exactly match the database fingerprint sealed in the plan",
    );
  }
  const heartbeatIntervalMs = rawInput.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (
    !Number.isFinite(heartbeatIntervalMs)
    || heartbeatIntervalMs < 10
    || heartbeatIntervalMs > 60_000
  ) {
    fail(
      "OPERATIONAL_HEARTBEAT_INTERVAL_INVALID",
      "heartbeat interval must be between 10ms and 60s",
    );
  }

  const adapter = rawInput.adapter ?? PRODUCT_TRUTH_OPERATIONAL_PRODUCTION_ADAPTER;
  const runLeaseToken = `ptr_${randomUUID()}`;
  return withOperationalRuntimeEnvironment({
    runId: plan.runId,
    approval,
    database: rawInput.meteredDatabase,
  }, async () => {
    let run = await seedAndAcquire({
      db,
      plan,
      approval,
      environment: rawInput.environment,
      command: rawInput.command,
      leaseOwner: rawInput.leaseOwner,
      now,
      runLeaseToken,
    });
    const invocationStartedAt = Date.parse(canonicalNow(now));
    let interrupted = false;
    let forcedFinalStatus: "blocked" | "ambiguous" | "failed" | null = null;

    try {
      const priorItems = await listProductTruthOperationalRunItems(db, plan.runId);
      if (priorItems.some((item) => item.status === "ambiguous")) {
        // A crash may leave the run row recoverable even though an item already
        // recorded ambiguity. Finalize that exact truth without touching pending work.
        forcedFinalStatus = "ambiguous";
      } else if (priorItems.some((item) => item.status === "blocked")) {
        forcedFinalStatus = "blocked";
      } else if (priorItems.some((item) => item.status === "failed")) {
        forcedFinalStatus = "failed";
      }

      if (!forcedFinalStatus) {
        for (const ceiling of plan.providerCeilings) {
          await ensureMeteredProviderBudget(db, {
            permit: approval.permit,
            confirmation: approval.meteredConfirmation,
            provider: ceiling.provider,
          });
        }
        await assertProductTruthOperationalLedgerBinding(db, {
          plan,
          approvalId: approval.approval.approvalId,
        });

        while (true) {
        const at = canonicalNow(now);
        if (Date.parse(at) - invocationStartedAt >= plan.maxWallClockMs) {
          interrupted = true;
          break;
        }
        if (
          Date.parse(at) >= Date.parse(plan.expiresAt)
          || Date.parse(at) >= Date.parse(approval.approval.expiresAt)
        ) {
          forcedFinalStatus = "blocked";
          break;
        }
        const runHeartbeat = await heartbeatProductTruthOperationalRunLease(db, {
          runId: plan.runId,
          runLeaseToken,
          at,
          leaseExpiresAt: leaseExpiry(at, run.leaseExpiresAt),
          activeItem: null,
        });
        run = runHeartbeat.run;
        const itemLeaseToken = `pti_${randomUUID()}`;
        let item = await claimNextProductTruthOperationalItem(db, {
          runId: plan.runId,
          runLeaseToken,
          itemLeaseToken,
          at: canonicalNow(now),
          leaseExpiresAt: run.leaseExpiresAt as string,
        });
        if (!item) break;
        const target = targetForItem(plan, item);
        try {
        item = await transitionProductTruthOperationalItem(db, {
          item,
          runLeaseToken,
          leaseToken: itemLeaseToken,
          nextStatus: "reuse_checked",
          stage: "CHECKING_REUSABLE_TRUTH",
          at: canonicalNow(now),
        });
        const reusable = await inspectAssessment(adapter, db, {
          target,
          plan,
          asOf: canonicalNow(now),
          cost: null,
        });
        if (reusable.assessment.complete) {
          item = await transitionProductTruthOperationalItem(db, {
            item,
            runLeaseToken,
            leaseToken: itemLeaseToken,
            nextStatus: "verifying",
            stage: "VERIFYING_REUSED_PRODUCT_TRUTH",
            at: canonicalNow(now),
            checkpoint: {
              schemaVersion: "product-truth-operational-checkpoint/1.0.0",
              stage: "REUSE_COMPLETE",
            },
          });
          const emptyLedger = productTruthOperationalLedgerDelta(
            await readProductTruthOperationalLedger(db, plan.runId),
            await readProductTruthOperationalLedger(db, plan.runId),
          );
          const result = buildItemResult({
            target,
            assessment: reusable.assessment,
            cost: null,
            ledger: emptyLedger,
            reused: true,
          });
          item = await transitionProductTruthOperationalItem(db, {
            item,
            runLeaseToken,
            leaseToken: itemLeaseToken,
            nextStatus: "done",
            stage: "PRODUCT_TRUTH_REUSED",
            at: canonicalNow(now),
            checkpoint: resultCheckpoint({
              stage: "REUSED",
              cost: null,
              assessment: reusable.assessment,
              ledger: emptyLedger,
            }),
            result,
          });
          continue;
        }

        const queue = await ensureProductTruthOperationalQueueJob(db, {
          target,
          runId: plan.runId,
          approvalId: approval.approval.approvalId,
          estimatedSpendUnits: estimatedSpendUnits(plan),
          existingQueueJobId: item.queueJobId,
        });
        item = await bindProductTruthOperationalQueueJob(db, {
          item,
          queueJobId: queue.id,
          runLeaseToken,
          itemLeaseToken,
          at: canonicalNow(now),
        });
        const queueLeaseToken = `ptq_${randomUUID()}`;
        const attempt = await startProductTruthOperationalAttempt(db, {
          item,
          runLeaseToken,
          itemLeaseToken,
          queueLeaseOwner: rawInput.leaseOwner,
          queueLeaseToken,
          at: canonicalNow(now),
          checkpoint: {
            schemaVersion: "product-truth-operational-checkpoint/1.0.0",
            stage: "REUSE_INCOMPLETE",
            completedFields: reusable.assessment.completedFields,
            unavailableFields: reusable.assessment.unavailableFields,
          },
        });
        item = attempt.item;
        const ledgerBefore = await readProductTruthOperationalLedger(db, plan.runId);
        const attempted = await executeAttemptedItem({
          db,
          plan,
          approval,
          adapter,
          run,
          item,
          target,
          runLeaseToken,
          itemLeaseToken,
          queueLeaseToken,
          leaseOwner: rawInput.leaseOwner,
          now,
          heartbeatIntervalMs,
          ledgerBefore,
        });
        item = attempted.item;
        run = attempted.run;
        if (attempted.stopRun) break;
        } catch (error) {
          if (item.attempts > 0) throw error;
          const ledger = await readProductTruthOperationalLedger(db, plan.runId);
          const disposition = isMeteredProviderControlError(error) ? "blocked" : "failed";
          const terminalError = errorText(error);
          try {
            const terminalized = await terminalizeProductTruthOperationalPreAttempt(db, {
              item,
              runLeaseToken,
              itemLeaseToken,
              itemStatus: disposition,
              stage: disposition === "blocked" ? "PRE_ATTEMPT_BLOCKED" : "PRE_ATTEMPT_FAILED",
              at: canonicalNow(now),
              error: terminalError,
              checkpoint: {
                schemaVersion: "product-truth-operational-checkpoint/1.0.0",
                stage: "PRE_ATTEMPT_TERMINAL",
                meteredReceiptIds: ledger.receipts.map((receipt) => receipt.receiptId),
              },
              result: buildItemResult({
                target,
                ledger: productTruthOperationalLedgerDelta(ledger, ledger),
                reused: false,
                forcedOutcome: disposition === "blocked" ? "BLOCKED" : "FAILED",
                extraBlockers: [terminalError],
              }),
            });
            item = terminalized.item;
          } catch (terminalizationError) {
            throw new ProductTruthOperationalRunnerError(
              "OPERATIONAL_RECOVERY_REQUIRED",
              "pre-attempt item and queue could not be terminalized atomically",
              { cause: terminalizationError },
            );
          }
          break;
        }
        }
      }
    } catch (error) {
      const currentItems = await listProductTruthOperationalRunItems(db, plan.runId);
      const activeStatuses = new Set([
        "claimed", "reuse_checked", "costing", "harvesting", "verifying",
      ]);
      const active = currentItems.find((item) => activeStatuses.has(item.status));
      if (active) {
        throw new ProductTruthOperationalRunnerError(
          "OPERATIONAL_RECOVERY_REQUIRED",
          `active item ${active.id} could not be terminalized; automatic replay is forbidden`,
          { cause: error },
        );
      }
      // A terminalization transaction may have committed even when its response
      // was lost. Durable item state outranks the thrown client-side outcome.
      if (currentItems.some((item) => item.status === "ambiguous")) {
        forcedFinalStatus = "ambiguous";
      } else if (currentItems.some((item) => item.status === "blocked")) {
        forcedFinalStatus = "blocked";
      } else if (currentItems.some((item) => item.status === "failed")) {
        forcedFinalStatus = "failed";
      } else if (currentItems.some((item) => (
        item.status === "done" || item.status === "terminal_gap"
      ))) {
        interrupted = currentItems.some((item) => item.status === "pending");
      } else {
        forcedFinalStatus = isMeteredProviderControlError(error) ? "blocked" : "failed";
      }
    }

    const items = await listProductTruthOperationalRunItems(db, plan.runId);
    const finalStatus = forcedFinalStatus ?? chooseFinalStatus(items, interrupted);
    const durableRun = await getProductTruthOperationalRun(db, plan.runId);
    if (
      !durableRun
      || durableRun.status !== "running"
      || durableRun.leaseToken !== runLeaseToken
    ) {
      fail(
        "OPERATIONAL_RECOVERY_REQUIRED",
        "exact run lease was lost before final artifact persistence",
      );
    }
    run = durableRun;
    const preArtifactAt = canonicalNow(now);
    run = (await heartbeatProductTruthOperationalRunLease(db, {
      runId: plan.runId,
      runLeaseToken,
      at: preArtifactAt,
      leaseExpiresAt: leaseExpiry(preArtifactAt, run.leaseExpiresAt),
      activeItem: null,
    })).run;
    const report = await buildReport(db, {
      plan,
      environment: rawInput.environment,
      finalStatus,
    });
    const artifacts = await rawInput.artifactWriter(report);
    if (
      artifacts.reportSha256 !== productTruthOperationalSha256(report)
      || !/^[a-f0-9]{64}$/.test(artifacts.artifactIndexSha256)
    ) {
      fail("OPERATIONAL_ARTIFACT_HASH_INVALID", "artifact writer returned hashes that do not bind the report");
    }
    const postArtifactAt = canonicalNow(now);
    run = (await heartbeatProductTruthOperationalRunLease(db, {
      runId: plan.runId,
      runLeaseToken,
      at: postArtifactAt,
      leaseExpiresAt: leaseExpiry(postArtifactAt, run.leaseExpiresAt),
      activeItem: null,
    })).run;
    const finished = await finishProductTruthOperationalRun(db, {
      runId: plan.runId,
      leaseToken: runLeaseToken,
      status: finalStatus,
      at: canonicalNow(now),
      reportSha256: artifacts.reportSha256,
      artifactIndexSha256: artifacts.artifactIndexSha256,
    });
    return {
      runId: plan.runId,
      status: finished.status,
      report,
      reportSha256: artifacts.reportSha256,
      artifactIndexSha256: artifacts.artifactIndexSha256,
    };
  });
}
