export const PRODUCT_TRUTH_WORKER_CONTROL_API_TIMEOUT_MS = 30_000;
export const PRODUCT_TRUTH_WORKER_HEARTBEAT_MS = 30_000;
export const PRODUCT_TRUTH_WORKER_LEASE_SAFETY_MS = 5_000;
export const PRODUCT_TRUTH_WORKER_CONTROL_RETRY_MS = 2_000;

export class ProductTruthWorkerLeaseExpiredError extends Error {
  readonly expiresAt: string;

  constructor(expiresAt: string, cause?: unknown) {
    super(`Product Truth worker lease expired at ${expiresAt}`, { cause });
    this.name = "ProductTruthWorkerLeaseExpiredError";
    this.expiresAt = expiresAt;
  }
}

function exactLeaseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== value
  ) {
    throw new Error("Product Truth worker lease timestamp is not canonical");
  }
  return timestamp;
}

export class ProductTruthWorkerLease {
  #expiresAtMs: number;

  constructor(expiresAt: string) {
    this.#expiresAtMs = exactLeaseTimestamp(expiresAt);
  }

  refresh(expiresAt: string): void {
    const next = exactLeaseTimestamp(expiresAt);
    if (next <= this.#expiresAtMs) {
      throw new Error("Product Truth worker lease did not advance");
    }
    this.#expiresAtMs = next;
  }

  get expiresAt(): string {
    return new Date(this.#expiresAtMs).toISOString();
  }

  canContinue(
    nowMs = Date.now(),
    safetyMs = PRODUCT_TRUTH_WORKER_LEASE_SAFETY_MS,
  ): boolean {
    return (
      Number.isFinite(nowMs)
      && Number.isFinite(safetyMs)
      && safetyMs >= 0
      && nowMs + safetyMs < this.#expiresAtMs
    );
  }

  remainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.#expiresAtMs - nowMs);
  }
}

export function productTruthHeartbeatFailureRequiresTermination(input: {
  lease: ProductTruthWorkerLease;
  retryable: boolean;
  nowMs?: number;
}): boolean {
  return !input.retryable || !input.lease.canContinue(input.nowMs);
}

export function terminateProductTruthWorkerProcessTree(input: {
  pid: number | undefined;
  killChild: (signal: NodeJS.Signals) => boolean;
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal: NodeJS.Signals) => true;
}): "PROCESS_GROUP" | "CHILD" {
  const platform = input.platform ?? process.platform;
  const killProcess = input.killProcess ?? (
    (pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
      return true;
    }
  );
  if (input.pid && platform !== "win32") {
    try {
      killProcess(-input.pid, "SIGTERM");
      return "PROCESS_GROUP";
    } catch {
      // The process group may already have exited; fall back to the child.
    }
  }
  input.killChild("SIGTERM");
  return "CHILD";
}

export async function retryProductTruthLeaseOperation<T>(input: {
  lease: ProductTruthWorkerLease;
  operation: () => Promise<T>;
  shouldRetry: (error: unknown) => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (
    (milliseconds: number) =>
      new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
      })
  );
  const retryDelayMs =
    input.retryDelayMs ?? PRODUCT_TRUTH_WORKER_CONTROL_RETRY_MS;
  let previousError: unknown;
  for (;;) {
    if (!input.lease.canContinue(now())) {
      throw new ProductTruthWorkerLeaseExpiredError(
        input.lease.expiresAt,
        previousError,
      );
    }
    try {
      return await input.operation();
    } catch (error) {
      if (!input.shouldRetry(error)) throw error;
      previousError = error;
      const safeRemaining =
        input.lease.remainingMs(now()) - PRODUCT_TRUTH_WORKER_LEASE_SAFETY_MS;
      if (safeRemaining <= 0) {
        throw new ProductTruthWorkerLeaseExpiredError(
          input.lease.expiresAt,
          error,
        );
      }
      await sleep(Math.min(retryDelayMs, safeRemaining));
    }
  }
}
