/**
 * Pure lifecycle contract for harvesting one donor from one concrete source item.
 *
 * Persistence/worker integration must use optimistic compare-and-swap on `version`.
 * A worker claims before any network call, then records `source_attempt_started` only
 * after the budget/permit governor has allowed and reserved the call. Consequently a
 * `permit_denied` transition can release a claim without consuming a source attempt.
 */

export const DONOR_HARVEST_STATUSES = [
  "pending",
  "running",
  "retry_wait",
  "partial",
  "complete",
  "source_unavailable",
  "error",
  "cancelled",
] as const;

export type DonorHarvestStatus = (typeof DONOR_HARVEST_STATUSES)[number];

export const DONOR_HARVEST_TERMINAL_STATUSES = [
  "complete",
  "source_unavailable",
  "error",
  "cancelled",
] as const satisfies readonly DonorHarvestStatus[];

export type DonorHarvestTerminalStatus = (typeof DONOR_HARVEST_TERMINAL_STATUSES)[number];

/**
 * A lease may be released for automatic retry only when the durable metered
 * ledger proves that no reservation crossed the paid-call boundary. Unknown is
 * deliberately grouped with observed: uncertainty must stop, not replay.
 */
export type DonorHarvestMeteredBoundary = "not_observed" | "observed_or_unknown";

export interface DonorHarvestIdentity {
  donorProductId: string;
  source: string;
  retailerProductId: string;
}

export interface DonorHarvestState extends DonorHarvestIdentity {
  status: DonorHarvestStatus;
  requestedFields: readonly string[];
  completedFields: readonly string[];
  unavailableFields: readonly string[];

  /** Count of source/network attempts, not scheduler claims or permit denials. */
  attempts: number;
  maxAttempts: number;
  nextEligibleAt: string | null;
  terminalReason: string | null;
  lastError: string | null;
  lastBlockReason: string | null;

  runId: string | null;
  approvalId: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  claimedAt: string | null;
  sourceAttemptStartedAt: string | null;
  finishedAt: string | null;

  /** Optimistic-lock value. Every accepted transition increments it exactly once. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDonorHarvestStateInput extends DonorHarvestIdentity {
  requestedFields: readonly string[];
  maxAttempts?: number;
  now: string;
  nextEligibleAt?: string | null;
}

export type DonorHarvestEvent =
  | {
      type: "claim";
      at: string;
      runId: string;
      approvalId?: string | null;
      leaseOwner: string;
      leaseToken: string;
      leaseExpiresAt: string;
    }
  | {
      /** Must occur after claim and before `source_attempt_started`. */
      type: "permit_denied";
      at: string;
      nextEligibleAt: string;
      reason: string;
    }
  | {
      /** Marks the exact point after which a source/network attempt is chargeable. */
      type: "source_attempt_started";
      at: string;
    }
  | {
      type: "source_result";
      at: string;
      completedFields?: readonly string[];
      unavailableFields?: readonly string[];
      /** Required while any requested field remains unresolved. */
      nextEligibleAt?: string | null;
    }
  | {
      type: "transient_failure";
      at: string;
      error: string;
      nextEligibleAt?: string | null;
    }
  | {
      /** Source capability is absent or the source item cannot supply this content. */
      type: "source_unavailable";
      at: string;
      reason: string;
      error?: string | null;
    }
  | {
      type: "permanent_failure";
      at: string;
      reason: string;
      error: string;
    }
  | {
      /** Recovery path for an expired worker lease; never creates a new attempt. */
      type: "lease_expired";
      at: string;
      meteredBoundary: DonorHarvestMeteredBoundary;
      nextEligibleAt?: string | null;
      error?: string | null;
    }
  | {
      /**
       * A durable reservation exists but the exact external/mutation outcome is
       * no longer safely attributable to the current lease. This is terminal
       * and requires operator reconciliation; it is never auto-replayed.
       */
      type: "metered_outcome_ambiguous";
      at: string;
      reason?: string;
      error: string;
    }
  | {
      type: "cancel";
      at: string;
      reason: string;
    };

export class DonorHarvestTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DonorHarvestTransitionError";
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DonorHarvestTransitionError(`${label} is required`);
  return normalized;
}

function normalizeSource(value: string): string {
  return requiredText(value, "source").normalize("NFKC").toLocaleLowerCase("en-US");
}

export function normalizeDonorHarvestFields(fields: readonly string[]): string[] {
  return [...new Set(fields.map((field) => requiredText(field, "field")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")))]
    .sort((a, b) => a.localeCompare(b, "en-US"));
}

function canonicalIso(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DonorHarvestTransitionError(`${label} must be a valid ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function futureIso(value: string, at: string, label: string): string {
  const next = canonicalIso(value, label);
  if (Date.parse(next) <= Date.parse(at)) {
    throw new DonorHarvestTransitionError(`${label} must be later than event time`);
  }
  return next;
}

function assertKnownFields(state: DonorHarvestState, fields: readonly string[], label: string): string[] {
  const normalized = normalizeDonorHarvestFields(fields);
  const requested = new Set(state.requestedFields);
  const unknown = normalized.filter((field) => !requested.has(field));
  if (unknown.length > 0) {
    throw new DonorHarvestTransitionError(`${label} contains unrequested fields: ${unknown.join(", ")}`);
  }
  return normalized;
}

function withoutLease(state: DonorHarvestState) {
  return {
    ...state,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    sourceAttemptStartedAt: null,
  };
}

function evolved(state: DonorHarvestState, at: string, patch: Partial<DonorHarvestState>): DonorHarvestState {
  const eventAt = canonicalIso(at, "event.at");
  if (Date.parse(eventAt) < Date.parse(state.updatedAt)) {
    throw new DonorHarvestTransitionError("event.at cannot be earlier than state.updatedAt");
  }
  const next = {
    ...state,
    ...patch,
    updatedAt: eventAt,
    version: state.version + 1,
  };
  assertDonorHarvestState(next);
  return next;
}

function requireStatus(state: DonorHarvestState, allowed: readonly DonorHarvestStatus[], event: string): void {
  if (!allowed.includes(state.status)) {
    throw new DonorHarvestTransitionError(`${event} is not allowed from ${state.status}`);
  }
}

function requireRunningAttempt(state: DonorHarvestState, event: string): void {
  requireStatus(state, ["running"], event);
  if (!state.sourceAttemptStartedAt) {
    throw new DonorHarvestTransitionError(`${event} requires source_attempt_started`);
  }
}

function isResolved(state: Pick<DonorHarvestState, "requestedFields" | "completedFields" | "unavailableFields">): boolean {
  const resolved = new Set([...state.completedFields, ...state.unavailableFields]);
  return state.requestedFields.every((field) => resolved.has(field));
}

export function donorHarvestIdentityKey(identity: DonorHarvestIdentity): string {
  return [
    requiredText(identity.donorProductId, "donorProductId"),
    normalizeSource(identity.source),
    requiredText(identity.retailerProductId, "retailerProductId"),
  ].map(encodeURIComponent).join("|");
}

export function createDonorHarvestState(input: CreateDonorHarvestStateInput): DonorHarvestState {
  const requestedFields = normalizeDonorHarvestFields(input.requestedFields);
  if (requestedFields.length === 0) {
    throw new DonorHarvestTransitionError("requestedFields must not be empty");
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new DonorHarvestTransitionError("maxAttempts must be a positive integer");
  }
  const now = canonicalIso(input.now, "now");
  const nextEligibleAt = input.nextEligibleAt == null
    ? now
    : canonicalIso(input.nextEligibleAt, "nextEligibleAt");
  const state: DonorHarvestState = {
    donorProductId: requiredText(input.donorProductId, "donorProductId"),
    source: normalizeSource(input.source),
    retailerProductId: requiredText(input.retailerProductId, "retailerProductId"),
    status: "pending",
    requestedFields,
    completedFields: [],
    unavailableFields: [],
    attempts: 0,
    maxAttempts,
    nextEligibleAt,
    terminalReason: null,
    lastError: null,
    lastBlockReason: null,
    runId: null,
    approvalId: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    claimedAt: null,
    sourceAttemptStartedAt: null,
    finishedAt: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
  assertDonorHarvestState(state);
  return state;
}

export function isDonorHarvestTerminal(status: DonorHarvestStatus): status is DonorHarvestTerminalStatus {
  return (DONOR_HARVEST_TERMINAL_STATUSES as readonly DonorHarvestStatus[]).includes(status);
}

export function isDonorHarvestComplete(state: DonorHarvestState): boolean {
  return state.status === "complete" && isResolved(state);
}

export function canClaimDonorHarvest(state: DonorHarvestState, now: string): boolean {
  if (!["pending", "retry_wait", "partial"].includes(state.status)) return false;
  if (state.attempts >= state.maxAttempts) return false;
  const at = canonicalIso(now, "now");
  return state.nextEligibleAt == null || Date.parse(state.nextEligibleAt) <= Date.parse(at);
}

export function assertDonorHarvestState(state: DonorHarvestState): void {
  requiredText(state.donorProductId, "donorProductId");
  if (state.source !== normalizeSource(state.source)) {
    throw new DonorHarvestTransitionError("source must be canonical lowercase text");
  }
  requiredText(state.retailerProductId, "retailerProductId");
  if (!(DONOR_HARVEST_STATUSES as readonly string[]).includes(state.status)) {
    throw new DonorHarvestTransitionError(`unknown status: ${state.status}`);
  }
  if (!Number.isSafeInteger(state.attempts) || state.attempts < 0) {
    throw new DonorHarvestTransitionError("attempts must be a non-negative integer");
  }
  if (!Number.isSafeInteger(state.maxAttempts) || state.maxAttempts < 1) {
    throw new DonorHarvestTransitionError("maxAttempts must be a positive integer");
  }
  if (state.attempts > state.maxAttempts) {
    throw new DonorHarvestTransitionError("attempts cannot exceed maxAttempts");
  }
  if (!Number.isSafeInteger(state.version) || state.version < 0) {
    throw new DonorHarvestTransitionError("version must be a non-negative integer");
  }

  const requested = normalizeDonorHarvestFields(state.requestedFields);
  const completed = normalizeDonorHarvestFields(state.completedFields);
  const unavailable = normalizeDonorHarvestFields(state.unavailableFields);
  if (requested.join("\u0000") !== state.requestedFields.join("\u0000")) {
    throw new DonorHarvestTransitionError("requestedFields must be canonical and unique");
  }
  if (completed.join("\u0000") !== state.completedFields.join("\u0000")) {
    throw new DonorHarvestTransitionError("completedFields must be canonical and unique");
  }
  if (unavailable.join("\u0000") !== state.unavailableFields.join("\u0000")) {
    throw new DonorHarvestTransitionError("unavailableFields must be canonical and unique");
  }
  assertKnownFields(state, completed, "completedFields");
  assertKnownFields(state, unavailable, "unavailableFields");
  if (completed.some((field) => unavailable.includes(field))) {
    throw new DonorHarvestTransitionError("a field cannot be both completed and unavailable");
  }

  canonicalIso(state.createdAt, "createdAt");
  canonicalIso(state.updatedAt, "updatedAt");
  for (const [label, value] of [
    ["nextEligibleAt", state.nextEligibleAt],
    ["leaseExpiresAt", state.leaseExpiresAt],
    ["claimedAt", state.claimedAt],
    ["sourceAttemptStartedAt", state.sourceAttemptStartedAt],
    ["finishedAt", state.finishedAt],
  ] as const) {
    if (value != null) canonicalIso(value, label);
  }

  if (state.status === "running") {
    requiredText(state.runId ?? "", "runId");
    requiredText(state.leaseOwner ?? "", "leaseOwner");
    requiredText(state.leaseToken ?? "", "leaseToken");
    if (!state.claimedAt || !state.leaseExpiresAt) {
      throw new DonorHarvestTransitionError("running state requires claim and lease timestamps");
    }
  } else if (state.leaseOwner || state.leaseToken || state.leaseExpiresAt || state.sourceAttemptStartedAt) {
    throw new DonorHarvestTransitionError("non-running state cannot retain an active lease or attempt marker");
  }

  if (state.status === "complete" && !isResolved(state)) {
    throw new DonorHarvestTransitionError("complete requires every requested field completed or unavailable");
  }
  if (
    state.attempts >= state.maxAttempts
    && !isDonorHarvestTerminal(state.status)
    && !(state.status === "running" && state.sourceAttemptStartedAt)
  ) {
    throw new DonorHarvestTransitionError("max attempts requires an in-flight final attempt or terminal state");
  }
  if (["source_unavailable", "error", "cancelled"].includes(state.status) && !state.terminalReason) {
    throw new DonorHarvestTransitionError(`${state.status} requires terminalReason`);
  }
  if (isDonorHarvestTerminal(state.status)) {
    if (!state.finishedAt) throw new DonorHarvestTransitionError("terminal state requires finishedAt");
    if (state.nextEligibleAt != null) {
      throw new DonorHarvestTransitionError("terminal state cannot have nextEligibleAt");
    }
  } else if (state.finishedAt != null || state.terminalReason != null) {
    throw new DonorHarvestTransitionError("non-terminal state cannot have terminal metadata");
  }
}

export function transitionDonorHarvest(
  state: DonorHarvestState,
  event: DonorHarvestEvent,
): DonorHarvestState {
  assertDonorHarvestState(state);
  const at = canonicalIso(event.at, "event.at");

  switch (event.type) {
    case "claim": {
      if (!canClaimDonorHarvest(state, at)) {
        throw new DonorHarvestTransitionError(`${state.status} harvest is not claimable at ${at}`);
      }
      const leaseExpiresAt = futureIso(event.leaseExpiresAt, at, "leaseExpiresAt");
      return evolved(state, at, {
        status: "running",
        runId: requiredText(event.runId, "runId"),
        approvalId: event.approvalId == null ? null : requiredText(event.approvalId, "approvalId"),
        leaseOwner: requiredText(event.leaseOwner, "leaseOwner"),
        leaseToken: requiredText(event.leaseToken, "leaseToken"),
        leaseExpiresAt,
        claimedAt: at,
        sourceAttemptStartedAt: null,
        nextEligibleAt: null,
        lastBlockReason: null,
      });
    }

    case "permit_denied": {
      requireStatus(state, ["running"], event.type);
      if (state.sourceAttemptStartedAt) {
        throw new DonorHarvestTransitionError("permit_denied must precede source_attempt_started");
      }
      const released = withoutLease(state);
      return evolved(released, at, {
        status: "retry_wait",
        nextEligibleAt: futureIso(event.nextEligibleAt, at, "nextEligibleAt"),
        lastBlockReason: requiredText(event.reason, "reason"),
      });
    }

    case "source_attempt_started": {
      requireStatus(state, ["running"], event.type);
      if (state.sourceAttemptStartedAt) {
        throw new DonorHarvestTransitionError("source attempt is already started");
      }
      if (state.attempts >= state.maxAttempts) {
        throw new DonorHarvestTransitionError("source attempt cap is already exhausted");
      }
      return evolved(state, at, {
        attempts: state.attempts + 1,
        sourceAttemptStartedAt: at,
        lastBlockReason: null,
      });
    }

    case "source_result": {
      requireRunningAttempt(state, event.type);
      const newCompleted = assertKnownFields(state, event.completedFields ?? [], "completedFields");
      const newUnavailable = assertKnownFields(state, event.unavailableFields ?? [], "unavailableFields");
      const completedSet = new Set([...state.completedFields, ...newCompleted]);
      const unavailableSet = new Set([
        ...state.unavailableFields.filter((field) => !completedSet.has(field)),
        ...newUnavailable.filter((field) => !completedSet.has(field)),
      ]);
      const completedFields = normalizeDonorHarvestFields([...completedSet]);
      const unavailableFields = normalizeDonorHarvestFields([...unavailableSet]);
      const released = withoutLease(state);
      const resolved = isResolved({ requestedFields: state.requestedFields, completedFields, unavailableFields });
      if (resolved) {
        return evolved(released, at, {
          status: "complete",
          completedFields,
          unavailableFields,
          nextEligibleAt: null,
          terminalReason: null,
          lastError: null,
          finishedAt: at,
        });
      }
      if (state.attempts >= state.maxAttempts) {
        return evolved(released, at, {
          status: "error",
          completedFields,
          unavailableFields,
          nextEligibleAt: null,
          terminalReason: "MAX_ATTEMPTS_EXHAUSTED",
          lastError: "Source attempt cap reached with unresolved requested fields",
          finishedAt: at,
        });
      }
      if (!event.nextEligibleAt) {
        throw new DonorHarvestTransitionError("incomplete source_result requires nextEligibleAt");
      }
      const hasAnyProgress = completedFields.length + unavailableFields.length > 0;
      return evolved(released, at, {
        status: hasAnyProgress ? "partial" : "retry_wait",
        completedFields,
        unavailableFields,
        nextEligibleAt: futureIso(event.nextEligibleAt, at, "nextEligibleAt"),
        lastError: null,
      });
    }

    case "transient_failure": {
      requireRunningAttempt(state, event.type);
      const released = withoutLease(state);
      const error = requiredText(event.error, "error");
      if (state.attempts >= state.maxAttempts) {
        return evolved(released, at, {
          status: "error",
          nextEligibleAt: null,
          terminalReason: "MAX_ATTEMPTS_EXHAUSTED",
          lastError: error,
          finishedAt: at,
        });
      }
      if (!event.nextEligibleAt) {
        throw new DonorHarvestTransitionError("transient_failure requires nextEligibleAt before the attempt cap");
      }
      return evolved(released, at, {
        status: "retry_wait",
        nextEligibleAt: futureIso(event.nextEligibleAt, at, "nextEligibleAt"),
        lastError: error,
      });
    }

    case "source_unavailable": {
      requireStatus(state, ["pending", "running", "retry_wait", "partial"], event.type);
      const released = withoutLease(state);
      return evolved(released, at, {
        status: "source_unavailable",
        nextEligibleAt: null,
        terminalReason: requiredText(event.reason, "reason"),
        lastError: event.error == null ? state.lastError : requiredText(event.error, "error"),
        finishedAt: at,
      });
    }

    case "permanent_failure": {
      requireRunningAttempt(state, event.type);
      const released = withoutLease(state);
      return evolved(released, at, {
        status: "error",
        nextEligibleAt: null,
        terminalReason: requiredText(event.reason, "reason"),
        lastError: requiredText(event.error, "error"),
        finishedAt: at,
      });
    }

    case "lease_expired": {
      requireStatus(state, ["running"], event.type);
      if (!state.leaseExpiresAt || Date.parse(at) < Date.parse(state.leaseExpiresAt)) {
        throw new DonorHarvestTransitionError("lease_expired is not allowed before leaseExpiresAt");
      }
      if (
        event.meteredBoundary !== "not_observed"
        && event.meteredBoundary !== "observed_or_unknown"
      ) {
        throw new DonorHarvestTransitionError("lease_expired requires an explicit metered boundary decision");
      }
      const released = withoutLease(state);
      const error = event.error == null ? "Worker lease expired" : requiredText(event.error, "error");
      if (state.sourceAttemptStartedAt || event.meteredBoundary === "observed_or_unknown") {
        return evolved(released, at, {
          status: "error",
          nextEligibleAt: null,
          terminalReason: "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
          lastError: error,
          finishedAt: at,
        });
      }
      if (!event.nextEligibleAt) {
        throw new DonorHarvestTransitionError("lease_expired requires nextEligibleAt before the attempt cap");
      }
      return evolved(released, at, {
        status: "retry_wait",
        nextEligibleAt: futureIso(event.nextEligibleAt, at, "nextEligibleAt"),
        lastError: error,
      });
    }

    case "metered_outcome_ambiguous": {
      requireStatus(state, ["pending", "running", "retry_wait", "partial"], event.type);
      const released = withoutLease(state);
      return evolved(released, at, {
        status: "error",
        nextEligibleAt: null,
        terminalReason: event.reason == null
          ? "METERED_ATTEMPT_OUTCOME_AMBIGUOUS"
          : requiredText(event.reason, "reason"),
        lastError: requiredText(event.error, "error"),
        finishedAt: at,
      });
    }

    case "cancel": {
      requireStatus(state, ["pending", "running", "retry_wait", "partial"], event.type);
      const released = withoutLease(state);
      return evolved(released, at, {
        status: "cancelled",
        nextEligibleAt: null,
        terminalReason: requiredText(event.reason, "reason"),
        finishedAt: at,
      });
    }
  }
}
