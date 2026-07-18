/**
 * Pure coordination primitives for the Uncrustables OFFER two-phase rollout.
 *
 * Phase 1 submits each selected OFFER at most once and leaves the immutable
 * SUBMISSION_ARMED/SUBMITTED evidence open. Phase 2 is deliberately modelled
 * without a PATCH capability: it can only observe an already-pending action,
 * append local evidence, and close that exact submission after stable DESIRED
 * reads. BEFORE and NON_DESIRED observations never authorize a second write.
 *
 * This module intentionally does not import the surgical executor. Keeping the
 * scheduler dependency-free prevents an accidental circular dependency when
 * the executor wires these primitives into its Amazon-specific adapters.
 */

export const OFFER_ONLY_EXECUTION_PROFILE = "OFFER_ONLY_V1" as const;

export type OfferExecutionPhase =
  | "SUBMIT_AND_SETTLE"
  | "SUBMIT_ONLY"
  | "SETTLE_ONLY";

export interface OfferPlanLike {
  entries: ReadonlyArray<{
    sku: string;
    actions: ReadonlyArray<{
      action_id: string;
      kind: string;
    }>;
  }>;
}

export interface OfferExecutionSelectionLike {
  sha256: string;
  profile: string;
  requested_action_kinds: readonly string[] | null;
  selected_action_ids: readonly string[];
  selected_actions: number;
}

export interface ValidatedOfferSelectionAction {
  action_id: string;
  sku: string;
}

/**
 * Secondary, OFFER-specific boundary check. The caller must first validate the
 * selection's SHA/signature against its source plan with the canonical repair
 * selection verifier. This check then proves that the sealed positive set has
 * no non-OFFER action hidden inside it.
 */
export function assertOfferOnlyExecutionSelection(input: {
  plan: OfferPlanLike;
  selection: OfferExecutionSelectionLike;
}): ValidatedOfferSelectionAction[] {
  const { plan, selection } = input;
  if (!/^[a-f0-9]{64}$/.test(selection.sha256)) {
    throw new Error("OFFER execution selection has no valid SHA-256.");
  }
  if (
    selection.profile !== OFFER_ONLY_EXECUTION_PROFILE &&
    selection.profile !== "EXACT_ACTION_SUBSET_V1"
  ) {
    throw new Error(
      `OFFER execution selection has incompatible profile ${selection.profile}.`,
    );
  }
  if (
    selection.requested_action_kinds == null ||
    selection.requested_action_kinds.length !== 1 ||
    selection.requested_action_kinds[0] !== "OFFER"
  ) {
    throw new Error(
      "OFFER execution selection must explicitly request only the OFFER action kind.",
    );
  }
  if (
    selection.selected_action_ids.length === 0 ||
    selection.selected_actions !== selection.selected_action_ids.length ||
    new Set(selection.selected_action_ids).size !==
      selection.selected_action_ids.length
  ) {
    throw new Error(
      "OFFER execution selection has an empty, duplicate, or inconsistent action set.",
    );
  }

  const planned = new Map<string, ValidatedOfferSelectionAction & { kind: string }>();
  for (const entry of plan.entries) {
    for (const action of entry.actions) {
      if (planned.has(action.action_id)) {
        throw new Error(`Repair plan repeats action ${action.action_id}.`);
      }
      planned.set(action.action_id, {
        action_id: action.action_id,
        sku: entry.sku,
        kind: action.kind,
      });
    }
  }

  return selection.selected_action_ids.map((actionId) => {
    const action = planned.get(actionId);
    if (!action) {
      throw new Error(
        `OFFER execution selection action ${actionId} is absent from its source plan.`,
      );
    }
    if (action.kind !== "OFFER") {
      throw new Error(
        `OFFER execution selection action ${actionId} has kind ${action.kind}.`,
      );
    }
    return { action_id: action.action_id, sku: action.sku };
  });
}

/**
 * Fail closed before a submit-only invocation performs any marketplace read or
 * write. A new OFFER batch cannot start while any same-plan submission remains
 * armed/submitted, and a terminal action cannot be selected for resubmission.
 */
export function assertOfferSubmitOnlyMayStart(input: {
  plan: OfferPlanLike;
  selection: OfferExecutionSelectionLike;
  pendingActionIds: Iterable<string>;
  terminalActionIds?: Iterable<string>;
}): ValidatedOfferSelectionAction[] {
  const selected = assertOfferOnlyExecutionSelection(input);
  const pending = [...new Set(input.pendingActionIds)].sort();
  if (pending.length > 0) {
    throw new Error(
      `Submit-only OFFER execution is blocked by persistent pending action(s): ${pending.join(", ")}. Run read-only settlement first; no PATCH is authorized.`,
    );
  }
  const terminal = new Set(input.terminalActionIds ?? []);
  const repeated = selected
    .map((action) => action.action_id)
    .filter((actionId) => terminal.has(actionId));
  if (repeated.length > 0) {
    throw new Error(
      `Submit-only OFFER execution includes terminal action(s): ${repeated.join(", ")}. Build a new exact selection; no PATCH is authorized.`,
    );
  }
  return selected;
}

export interface OfferRolloutCandidate {
  action_id: string;
  sku: string;
  asin: string;
  consumer_price: number;
  product_type: string;
}

export interface OfferRolloutScope {
  label: string;
  candidates: OfferRolloutCandidate[];
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Produce an exact, non-overlapping rollout partition. Canary actions retain
 * the operator-reviewed order. Remaining actions are ordered round-robin by
 * ascending price tier and SKU so early batches exercise every price band
 * instead of taking an alphabetic cluster of identical $76.99 offers.
 */
export function partitionOfferRolloutCandidates(input: {
  candidates: readonly OfferRolloutCandidate[];
  completedActionIds: Iterable<string>;
  canaryActionIds: readonly string[];
  batchSizes: readonly number[];
}): OfferRolloutScope[] {
  const byActionId = new Map<string, OfferRolloutCandidate>();
  const seenSkus = new Set<string>();
  for (const candidate of input.candidates) {
    if (
      !candidate.action_id ||
      !candidate.sku ||
      !candidate.asin ||
      !candidate.product_type ||
      !Number.isFinite(candidate.consumer_price) ||
      candidate.consumer_price <= 0
    ) {
      throw new Error("OFFER rollout candidate is incomplete.");
    }
    if (byActionId.has(candidate.action_id) || seenSkus.has(candidate.sku)) {
      throw new Error(
        `OFFER rollout repeats action or SKU ${candidate.action_id}/${candidate.sku}.`,
      );
    }
    byActionId.set(candidate.action_id, { ...candidate });
    seenSkus.add(candidate.sku);
  }
  const completed = new Set(input.completedActionIds);
  const eligible = new Map(
    [...byActionId.entries()].filter(([actionId]) => !completed.has(actionId)),
  );
  if (
    input.canaryActionIds.length === 0 ||
    new Set(input.canaryActionIds).size !== input.canaryActionIds.length
  ) {
    throw new Error("OFFER rollout requires unique explicit canary actions.");
  }
  const canaries = input.canaryActionIds.map((actionId) => {
    const candidate = eligible.get(actionId);
    if (!candidate) {
      throw new Error(
        `OFFER rollout canary ${actionId} is missing, completed, or ineligible.`,
      );
    }
    eligible.delete(actionId);
    return candidate;
  });
  if (
    input.batchSizes.some(
      (size) => !Number.isInteger(size) || size <= 0,
    )
  ) {
    throw new Error("OFFER rollout batch sizes must be positive integers.");
  }
  const requestedBatchTotal = input.batchSizes.reduce(
    (sum, size) => sum + size,
    0,
  );
  if (requestedBatchTotal !== eligible.size) {
    throw new Error(
      `OFFER rollout batch sizes cover ${requestedBatchTotal}, expected ${eligible.size}.`,
    );
  }

  const tiers = new Map<number, OfferRolloutCandidate[]>();
  for (const candidate of eligible.values()) {
    const rows = tiers.get(candidate.consumer_price) ?? [];
    rows.push(candidate);
    tiers.set(candidate.consumer_price, rows);
  }
  const orderedTiers = [...tiers.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, rows]) => rows.sort((left, right) => asciiCompare(left.sku, right.sku)));
  const ordered: OfferRolloutCandidate[] = [];
  while (orderedTiers.some((rows) => rows.length > 0)) {
    for (const rows of orderedTiers) {
      const candidate = rows.shift();
      if (candidate) ordered.push(candidate);
    }
  }

  const scopes: OfferRolloutScope[] = canaries.map((candidate, index) => ({
    label: `CANARY_${index + 1}`,
    candidates: [candidate],
  }));
  let offset = 0;
  for (let index = 0; index < input.batchSizes.length; index++) {
    const size = input.batchSizes[index];
    scopes.push({
      label: `BATCH_${index + 1}`,
      candidates: ordered.slice(offset, offset + size),
    });
    offset += size;
  }
  return scopes;
}

export interface OfferSettlementPolicyInput {
  /** Total wall-clock budget for this read-only invocation. */
  horizonMs: number;
  /** Target time between the start of successive full pending-action sweeps. */
  pollIntervalMs: number;
  /** Global minimum pacing between individual marketplace GET starts. */
  requestDelayMs: number;
  /** Identical DESIRED path-state observations required before closure. */
  stableReads: number;
  /** Per-GET wall-clock timeout. The adapter must honor the AbortSignal. */
  observationTimeoutMs?: number;
  /** Optional additional cap, useful for operator-controlled short probes. */
  maxReadsPerSubmission?: number | null;
}

export interface ResolvedOfferSettlementPolicy {
  horizonMs: number;
  pollIntervalMs: number;
  requestDelayMs: number;
  stableReads: number;
  observationTimeoutMs: number;
  maxReadsPerSubmission: number;
  /** Optimistic upper bound that ignores GET latency and sweep work. */
  plannedSweeps: number;
}

export const DEFAULT_OFFER_SETTLEMENT_POLICY = {
  horizonMs: 6 * 60 * 60 * 1_000,
  pollIntervalMs: 5 * 60 * 1_000,
  requestDelayMs: 5_000,
  stableReads: 3,
  observationTimeoutMs: 60_000,
  maxReadsPerSubmission: null,
} satisfies OfferSettlementPolicyInput;

const MAX_SETTLEMENT_HORIZON_MS = 72 * 60 * 60 * 1_000;
const MAX_READS_PER_SUBMISSION = 10_000;

export function resolveOfferSettlementPolicy(
  input: OfferSettlementPolicyInput,
): ResolvedOfferSettlementPolicy {
  for (const [name, value] of [
    ["horizonMs", input.horizonMs],
    ["pollIntervalMs", input.pollIntervalMs],
    ["requestDelayMs", input.requestDelayMs],
    ["stableReads", input.stableReads],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (input.horizonMs > MAX_SETTLEMENT_HORIZON_MS) {
    throw new Error("OFFER settlement horizon cannot exceed 72 hours.");
  }
  if (input.stableReads < 2 || input.stableReads > 10) {
    throw new Error("OFFER settlement stableReads must be between 2 and 10.");
  }
  if (input.requestDelayMs > input.horizonMs) {
    throw new Error("OFFER request pacing cannot exceed the settlement horizon.");
  }
  const observationTimeoutMs =
    input.observationTimeoutMs ?? Math.min(60_000, input.horizonMs);
  if (
    !Number.isInteger(observationTimeoutMs) ||
    observationTimeoutMs <= 0 ||
    observationTimeoutMs > input.horizonMs
  ) {
    throw new Error(
      "OFFER observation timeout must be a positive integer no greater than the settlement horizon.",
    );
  }
  const plannedSweeps = 1 + Math.floor(input.horizonMs / input.pollIntervalMs);
  if (plannedSweeps < input.stableReads) {
    throw new Error(
      "OFFER settlement horizon is too short for the required stable reads.",
    );
  }
  const explicitMax = input.maxReadsPerSubmission ?? plannedSweeps;
  if (
    !Number.isInteger(explicitMax) ||
    explicitMax < input.stableReads ||
    explicitMax > MAX_READS_PER_SUBMISSION
  ) {
    throw new Error(
      `OFFER maxReadsPerSubmission must be ${input.stableReads}-${MAX_READS_PER_SUBMISSION}.`,
    );
  }
  return {
    horizonMs: input.horizonMs,
    pollIntervalMs: input.pollIntervalMs,
    requestDelayMs: input.requestDelayMs,
    stableReads: input.stableReads,
    observationTimeoutMs,
    maxReadsPerSubmission: explicitMax,
    plannedSweeps,
  };
}

export type OfferSettlementClassification =
  | "DESIRED"
  | "BEFORE"
  | "NON_DESIRED";

export interface PendingOfferSettlement {
  readonly action_id: string;
  readonly sku: string;
  readonly submitted_event_id: string;
  readonly submitted_at: string;
}

export interface OfferSettlementObservation {
  readonly classification: OfferSettlementClassification;
  readonly path_state_sha256: string;
  /** Amazon-specific exact-field verification payload, opaque to scheduler. */
  readonly verification: unknown;
}

export interface OfferSettlementProgress {
  reads: number;
  consecutive_identical_reads: number;
  sweep: number;
  elapsed_ms: number;
}

export type OfferSettlementDisposition =
  | "VERIFIED"
  | "PENDING_HORIZON"
  | "PENDING_READ_LIMIT";

export interface OfferSettlementResult {
  action_id: string;
  sku: string;
  submitted_event_id: string;
  disposition: OfferSettlementDisposition;
  reads: number;
  read_errors: number;
  consecutive_identical_reads: number;
  last_classification: OfferSettlementClassification | null;
  last_path_state_sha256: string | null;
}

export interface ReadOnlyOfferSettlementDependencies {
  /** The only marketplace capability exposed to this state machine. */
  observe(
    pending: PendingOfferSettlement,
    progress: Omit<OfferSettlementProgress, "consecutive_identical_reads">,
    signal: AbortSignal,
  ): Promise<OfferSettlementObservation>;
  /** Append non-terminal local evidence if desired. */
  onObservation?(
    pending: PendingOfferSettlement,
    observation: OfferSettlementObservation,
    progress: OfferSettlementProgress,
  ): Promise<void>;
  /** Append the exact-submission VERIFIED marker. */
  onVerified(
    pending: PendingOfferSettlement,
    observation: OfferSettlementObservation,
    progress: OfferSettlementProgress,
  ): Promise<void>;
  /** Append a non-closing horizon/read-limit marker. */
  onPending?(
    pending: PendingOfferSettlement,
    result: OfferSettlementResult,
  ): Promise<void>;
  /** Optional local diagnostic callback; read errors never close pending. */
  onReadError?(
    pending: PendingOfferSettlement,
    error: unknown,
    progress: Omit<OfferSettlementProgress, "consecutive_identical_reads">,
  ): Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface MutableOfferSettlementState {
  pending: Readonly<PendingOfferSettlement>;
  reads: number;
  readErrors: number;
  consecutive: number;
  previousKey: string | null;
  last: OfferSettlementObservation | null;
  verified: boolean;
}

function validatePendingOfferSettlements(
  pending: readonly PendingOfferSettlement[],
  requireUniqueSkus = true,
): void {
  if (pending.length === 0) return;
  const actionIds = new Set<string>();
  const submissionIds = new Set<string>();
  const skus = new Set<string>();
  for (const item of pending) {
    if (!item.action_id || !item.sku || !item.submitted_event_id) {
      throw new Error("Pending OFFER settlement identity is incomplete.");
    }
    if (!Number.isFinite(new Date(item.submitted_at).getTime())) {
      throw new Error(`Pending OFFER ${item.action_id} has an invalid timestamp.`);
    }
    if (actionIds.has(item.action_id)) {
      throw new Error(`Pending OFFER action ${item.action_id} is duplicated.`);
    }
    if (submissionIds.has(item.submitted_event_id)) {
      throw new Error(
        `Pending OFFER submission ${item.submitted_event_id} is duplicated.`,
      );
    }
    if (requireUniqueSkus && skus.has(item.sku)) {
      throw new Error(`Pending OFFER SKU ${item.sku} is duplicated.`);
    }
    actionIds.add(item.action_id);
    submissionIds.add(item.submitted_event_id);
    skus.add(item.sku);
  }
}

function bindPendingToOfferSelection(input: {
  plan: OfferPlanLike;
  selection: OfferExecutionSelectionLike;
  pending: readonly PendingOfferSettlement[];
  terminalActionIds?: Iterable<string>;
}): ValidatedOfferSelectionAction[] {
  const selected = assertOfferOnlyExecutionSelection(input);
  const selectedIds = new Set(selected.map((action) => action.action_id));
  const terminal = new Set(
    [...(input.terminalActionIds ?? [])].filter((actionId) =>
      selectedIds.has(actionId)
    ),
  );
  if (selected.length !== input.pending.length + terminal.size) {
    throw new Error(
      `Read-only OFFER settlement selection covers ${selected.length} action(s), but the canonical pending/terminal sets account for ${input.pending.length + terminal.size}.`,
    );
  }
  const pendingByAction = new Map(
    input.pending.map((item) => [item.action_id, item] as const),
  );
  for (const action of selected) {
    const pending = pendingByAction.get(action.action_id);
    if (pending && terminal.has(action.action_id)) {
      throw new Error(
        `Read-only OFFER settlement action ${action.action_id} is both pending and terminal.`,
      );
    }
    if (pending ? pending.sku !== action.sku : !terminal.has(action.action_id)) {
      throw new Error(
        `Read-only OFFER settlement action ${action.action_id}/${action.sku} is not exactly bound to its canonical pending submission.`,
      );
    }
  }
  return selected;
}

function immutableClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (item == null || typeof item !== "object" || Object.isFrozen(item)) return;
    if (seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item as Record<string, unknown>)) {
      freeze(child);
    }
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

async function observeWithTimeout(input: {
  pending: PendingOfferSettlement;
  progress: Omit<OfferSettlementProgress, "consecutive_identical_reads">;
  timeoutMs: number;
  observe: ReadOnlyOfferSettlementDependencies["observe"];
}): Promise<Readonly<OfferSettlementObservation>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const observed = await Promise.race([
      input.observe(input.pending, input.progress, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `Read-only OFFER observation timed out after ${input.timeoutMs}ms.`,
            ),
          );
        }, input.timeoutMs);
      }),
    ]);
    return immutableClone(observed);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

function validateObservation(
  pending: PendingOfferSettlement,
  observation: OfferSettlementObservation,
): void {
  if (
    observation.classification !== "DESIRED" &&
    observation.classification !== "BEFORE" &&
    observation.classification !== "NON_DESIRED"
  ) {
    throw new Error(
      `Read-only OFFER observation for ${pending.action_id} has an invalid classification.`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(observation.path_state_sha256)) {
    throw new Error(
      `Read-only OFFER observation for ${pending.action_id} has an invalid path-state SHA-256.`,
    );
  }
}

function resultFor(
  state: MutableOfferSettlementState,
  disposition: OfferSettlementDisposition,
): OfferSettlementResult {
  return {
    action_id: state.pending.action_id,
    sku: state.pending.sku,
    submitted_event_id: state.pending.submitted_event_id,
    disposition,
    reads: state.reads,
    read_errors: state.readErrors,
    consecutive_identical_reads: state.consecutive,
    last_classification: state.last?.classification ?? null,
    last_path_state_sha256: state.last?.path_state_sha256 ?? null,
  };
}

/**
 * Round-robin, read-only settlement for one or many persistent OFFER
 * submissions. A sweep observes every still-open submission once, so a batch
 * of 25 does not wait a six-hour horizon for item 1 before reading item 2.
 *
 * The dependency surface deliberately has no patch/submit method. Restarting
 * this function resets the in-memory stability counter and therefore requires
 * fresh confirming reads; the immutable pending submission remains the source
 * of truth throughout.
 */
export async function runReadOnlySettlementScheduler(input: {
  pending: readonly PendingOfferSettlement[];
  policy: OfferSettlementPolicyInput;
  dependencies: ReadOnlyOfferSettlementDependencies;
  /** OFFER has one action per SKU. Generic recovery may safely contain
   * different action kinds for the same SKU, so its exact-action binder can
   * disable this additional OFFER-only invariant. */
  requireUniqueSkus?: boolean;
}): Promise<OfferSettlementResult[]> {
  validatePendingOfferSettlements(
    input.pending,
    input.requireUniqueSkus ?? false,
  );
  const policy = resolveOfferSettlementPolicy(input.policy);
  if (input.pending.length === 0) return [];

  const now = input.dependencies.now ?? (() => performance.now());
  const sleep = input.dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + policy.horizonMs;
  const states = input.pending.map<MutableOfferSettlementState>((pending) => ({
    pending: immutableClone(pending),
    reads: 0,
    readErrors: 0,
    consecutive: 0,
    previousKey: null,
    last: null,
    verified: false,
  }));
  let sweep = 0;
  let nextSweepAt = startedAt;
  let lastRequestAt: number | null = null;

  while (
    states.some(
      (state) =>
        !state.verified && state.reads < policy.maxReadsPerSubmission,
    ) &&
    now() <= deadline
  ) {
    const untilSweep = nextSweepAt - now();
    if (untilSweep > 0) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(untilSweep, remaining));
    }
    if (now() > deadline) break;
    const sweepStartedAt = now();
    sweep++;

    for (const state of states) {
      if (state.verified || state.reads >= policy.maxReadsPerSubmission) {
        continue;
      }
      if (lastRequestAt != null) {
        const pacingDelay = policy.requestDelayMs - (now() - lastRequestAt);
        if (pacingDelay > 0) {
          const remaining = deadline - now();
          if (remaining <= 0) break;
          await sleep(Math.min(pacingDelay, remaining));
        }
      }
      if (now() > deadline) break;

      lastRequestAt = now();
      const baseProgress = {
        reads: state.reads,
        sweep,
        elapsed_ms: Math.max(0, now() - startedAt),
      };
      let observation: OfferSettlementObservation;
      try {
        const remaining = Math.max(1, deadline - now());
        observation = await observeWithTimeout({
          pending: state.pending,
          progress: baseProgress,
          timeoutMs: Math.min(policy.observationTimeoutMs, remaining),
          observe: input.dependencies.observe,
        });
        validateObservation(state.pending, observation);
      } catch (error) {
        state.reads++;
        state.readErrors++;
        state.consecutive = 0;
        state.previousKey = null;
        await input.dependencies.onReadError?.(
          state.pending,
          error,
          {
            reads: state.reads,
            sweep,
            elapsed_ms: Math.max(0, now() - startedAt),
          },
        );
        continue;
      }

      state.reads++;
      state.last = observation;
      const classification = observation.classification;
      const pathStateSha256 = observation.path_state_sha256;
      const key = `${classification}:${pathStateSha256}`;
      state.consecutive = key === state.previousKey ? state.consecutive + 1 : 1;
      state.previousKey = key;
      const progress: OfferSettlementProgress = {
        reads: state.reads,
        consecutive_identical_reads: state.consecutive,
        sweep,
        elapsed_ms: Math.max(0, now() - startedAt),
      };
      const shouldVerify =
        classification === "DESIRED" &&
        state.consecutive >= policy.stableReads;
      await input.dependencies.onObservation?.(
        state.pending,
        observation,
        progress,
      );
      if (shouldVerify) {
        await input.dependencies.onVerified(
          state.pending,
          observation,
          progress,
        );
        state.verified = true;
      }
    }

    nextSweepAt = sweepStartedAt + policy.pollIntervalMs;
  }

  const horizonReached = now() >= deadline;
  const results = states.map((state) =>
    resultFor(
      state,
      state.verified
        ? "VERIFIED"
        : state.reads >= policy.maxReadsPerSubmission && !horizonReached
          ? "PENDING_READ_LIMIT"
          : "PENDING_HORIZON",
    ),
  );
  for (let index = 0; index < states.length; index++) {
    if (!states[index].verified) {
      await input.dependencies.onPending?.(states[index].pending, results[index]);
    }
  }
  return results;
}

export async function runReadOnlyOfferSettlement(input: {
  /** The canonical verifier must validate this selection before this call. */
  plan: OfferPlanLike;
  /** Exact positive set; it must equal the canonical pending set. */
  selection: OfferExecutionSelectionLike;
  pending: readonly PendingOfferSettlement[];
  /** Canonically VERIFIED/ALREADY_APPLIED selected actions make reruns idempotent. */
  terminalActionIds?: Iterable<string>;
  policy: OfferSettlementPolicyInput;
  dependencies: ReadOnlyOfferSettlementDependencies;
}): Promise<OfferSettlementResult[]> {
  validatePendingOfferSettlements(input.pending, true);
  bindPendingToOfferSelection(input);
  return runReadOnlySettlementScheduler({
    pending: input.pending,
    policy: input.policy,
    dependencies: input.dependencies,
    requireUniqueSkus: true,
  });
}
