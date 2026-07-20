/**
 * Default-deny fence for metered Product Truth providers.
 *
 * An API key proves only that a provider can be called; it is not budget
 * approval. Every paid/metered adapter must reserve a call here immediately
 * before its network request. In Phase 0 no permit is configured, therefore
 * every metered request fails before HTTP/SDK execution.
 *
 * This in-process reservation is a containment layer, not the final distributed
 * budget ledger. A DB-backed atomic ledger is still required before parallel or
 * serverless paid waves are authorised.
 */

export const METERED_PROVIDERS = ["unwrangle", "bluecart", "oxylabs", "anthropic", "gemini", "openai"] as const;
export type MeteredProvider = (typeof METERED_PROVIDERS)[number];

export type MeteredProviderAllowance = {
  operations: string[];
  maxCalls: number;
  maxUnits?: number;
};

export type MeteredRunPermit = {
  version: 1;
  runId: string;
  approvalId: string;
  approvedBy: "owner";
  issuedAt: string;
  expiresAt: string;
  providers: Partial<Record<MeteredProvider, MeteredProviderAllowance>>;
};

export type MeteredCallRequest = {
  provider: MeteredProvider;
  operation: string;
  units?: number;
};

export type GuardEnv = {
  SS_METERED_RUN_PERMIT?: string;
  SS_METERED_RUN_CONFIRM?: string;
};
type Usage = { calls: number; units: number };

export type MeteredCallDecision =
  | { allowed: true; permit: MeteredRunPermit; nextUsage: Usage }
  | {
      allowed: false;
      code:
        | "PERMIT_MISSING"
        | "PERMIT_INVALID"
        | "PERMIT_NOT_CURRENT"
        | "PERMIT_TOO_LONG"
        | "CONFIRMATION_MISMATCH"
        | "PROVIDER_NOT_ALLOWED"
        | "OPERATION_NOT_ALLOWED"
        | "CALL_BUDGET_EXHAUSTED"
        | "UNIT_BUDGET_EXHAUSTED"
        | "REQUEST_INVALID";
      reason: string;
    };

const MAX_PERMIT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const usageByRunProvider = new Map<string, Usage>();

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function encodeMeteredRunPermit(permit: MeteredRunPermit): string {
  return Buffer.from(JSON.stringify(permit), "utf8").toString("base64url");
}

export function decodeMeteredRunPermit(raw: string): MeteredRunPermit | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MeteredRunPermit;
    if (parsed?.version !== 1 || parsed.approvedBy !== "owner") return null;
    if (!nonEmptyString(parsed.runId) || !nonEmptyString(parsed.approvalId)) return null;
    if (!nonEmptyString(parsed.issuedAt) || !nonEmptyString(parsed.expiresAt)) return null;
    if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) return null;
    for (const [provider, allowance] of Object.entries(parsed.providers)) {
      if (!(METERED_PROVIDERS as readonly string[]).includes(provider)) return null;
      if (!allowance || typeof allowance !== "object") return null;
      const a = allowance as MeteredProviderAllowance;
      if (!Array.isArray(a.operations) || !a.operations.length || !a.operations.every(nonEmptyString)) return null;
      if (!Number.isInteger(a.maxCalls) || a.maxCalls <= 0) return null;
      if (a.maxUnits !== undefined && !finitePositive(a.maxUnits)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function expectedMeteredRunConfirmation(permit: Pick<MeteredRunPermit, "runId" | "approvalId">): string {
  return `APPROVE_METERED_RUN:${permit.runId}:${permit.approvalId}`;
}

/** Read only a currently valid, explicitly confirmed owner permit. */
export function currentMeteredRunPermit(
  env?: GuardEnv,
  nowMs = Date.now(),
): MeteredRunPermit | null {
  const source: GuardEnv = env ?? {
    SS_METERED_RUN_PERMIT: process.env.SS_METERED_RUN_PERMIT,
    SS_METERED_RUN_CONFIRM: process.env.SS_METERED_RUN_CONFIRM,
  };
  const raw = source.SS_METERED_RUN_PERMIT?.trim();
  const permit = raw ? decodeMeteredRunPermit(raw) : null;
  if (!permit) return null;
  const issuedAt = Date.parse(permit.issuedAt);
  const expiresAt = Date.parse(permit.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  if (issuedAt > nowMs || expiresAt <= nowMs || expiresAt <= issuedAt) return null;
  if (expiresAt - issuedAt > MAX_PERMIT_LIFETIME_MS) return null;
  if (source.SS_METERED_RUN_CONFIRM !== expectedMeteredRunConfirmation(permit)) return null;
  return permit;
}

export function evaluateMeteredCall(
  request: MeteredCallRequest,
  env: GuardEnv,
  currentUsage: Usage = { calls: 0, units: 0 },
  nowMs = Date.now(),
): MeteredCallDecision {
  const units = request.units ?? 1;
  if (!nonEmptyString(request.operation) || !finitePositive(units)) {
    return { allowed: false, code: "REQUEST_INVALID", reason: "operation and positive finite units are required" };
  }
  const raw = env.SS_METERED_RUN_PERMIT?.trim();
  if (!raw) {
    return { allowed: false, code: "PERMIT_MISSING", reason: "no owner-approved metered run permit is configured" };
  }
  const permit = decodeMeteredRunPermit(raw);
  if (!permit) {
    return { allowed: false, code: "PERMIT_INVALID", reason: "metered run permit is malformed or violates the v1 contract" };
  }
  const issuedAt = Date.parse(permit.issuedAt);
  const expiresAt = Date.parse(permit.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > nowMs || expiresAt <= nowMs || expiresAt <= issuedAt) {
    return { allowed: false, code: "PERMIT_NOT_CURRENT", reason: "metered run permit is not currently valid" };
  }
  if (expiresAt - issuedAt > MAX_PERMIT_LIFETIME_MS) {
    return { allowed: false, code: "PERMIT_TOO_LONG", reason: "metered run permit lifetime exceeds 24 hours" };
  }
  if (env.SS_METERED_RUN_CONFIRM !== expectedMeteredRunConfirmation(permit)) {
    return { allowed: false, code: "CONFIRMATION_MISMATCH", reason: "explicit run confirmation does not match runId and approvalId" };
  }
  const allowance = permit.providers[request.provider];
  if (!allowance) {
    return { allowed: false, code: "PROVIDER_NOT_ALLOWED", reason: `${request.provider} is not allowed by this run permit` };
  }
  if (!allowance.operations.includes(request.operation)) {
    return { allowed: false, code: "OPERATION_NOT_ALLOWED", reason: `${request.provider}:${request.operation} is not allowed by this run permit` };
  }
  if (currentUsage.calls + 1 > allowance.maxCalls) {
    return { allowed: false, code: "CALL_BUDGET_EXHAUSTED", reason: `${request.provider} call cap ${allowance.maxCalls} is exhausted` };
  }
  if (allowance.maxUnits !== undefined && currentUsage.units + units > allowance.maxUnits) {
    return { allowed: false, code: "UNIT_BUDGET_EXHAUSTED", reason: `${request.provider} unit cap ${allowance.maxUnits} is exhausted` };
  }
  return {
    allowed: true,
    permit,
    nextUsage: { calls: currentUsage.calls + 1, units: currentUsage.units + units },
  };
}

export class MeteredProviderBlockedError extends Error {
  readonly code: Extract<MeteredCallDecision, { allowed: false }>["code"];
  readonly provider: MeteredProvider;
  readonly operation: string;

  constructor(request: MeteredCallRequest, decision: Extract<MeteredCallDecision, { allowed: false }>) {
    super(`METERED_PROVIDER_BLOCKED ${request.provider}:${request.operation} [${decision.code}] ${decision.reason}`);
    this.name = "MeteredProviderBlockedError";
    this.code = decision.code;
    this.provider = request.provider;
    this.operation = request.operation;
  }
}

/** Reserve one metered call synchronously, before any HTTP/SDK work begins. */
export function assertMeteredProviderCall(request: MeteredCallRequest, env?: GuardEnv): MeteredRunPermit {
  const source: GuardEnv = env ?? {
    SS_METERED_RUN_PERMIT: process.env.SS_METERED_RUN_PERMIT,
    SS_METERED_RUN_CONFIRM: process.env.SS_METERED_RUN_CONFIRM,
  };
  const raw = source.SS_METERED_RUN_PERMIT?.trim();
  const permit = raw ? decodeMeteredRunPermit(raw) : null;
  const usageKey = permit ? `${permit.runId}:${request.provider}` : `blocked:${request.provider}`;
  const currentUsage = usageByRunProvider.get(usageKey) ?? { calls: 0, units: 0 };
  const decision = evaluateMeteredCall(request, source, currentUsage);
  if (!decision.allowed) throw new MeteredProviderBlockedError(request, decision);
  usageByRunProvider.set(usageKey, decision.nextUsage);
  return decision.permit;
}

export function isMeteredProviderBlockedError(error: unknown): error is MeteredProviderBlockedError {
  return error instanceof MeteredProviderBlockedError;
}

/** Test-only reset for deterministic counter assertions. */
export function resetMeteredCallUsageForTests(): void {
  usageByRunProvider.clear();
}
