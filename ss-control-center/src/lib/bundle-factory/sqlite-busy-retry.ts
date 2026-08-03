/**
 * Survive a locked database instead of reporting it as a failure.
 *
 * Turso serialises writes. When two writers meet — the publish request and the
 * bundle-factory tick, the status poller, or an operator script — the loser
 * gets `SQLITE_BUSY: database is locked` and its statement DOES NOT APPLY.
 * Nothing is half-written, so trying again is the correct response, and the
 * operator saw a red "Internal server error" for a condition that resolves in
 * milliseconds.
 *
 * NEVER wrap a marketplace mutation in this. A POST whose outcome is unknown
 * is never repeated (AGENTS.md §7); this exists for local database work only,
 * where a refused write is provably a write that did not happen.
 */

const BUSY_PATTERN = /SQLITE_BUSY|database is locked/i;

/** True when the database refused the write because someone else held it. */
export function isSqliteBusyError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (BUSY_PATTERN.test(message)) return true;
  // libsql wraps the driver error; the cause carries the original code.
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isSqliteBusyError(cause);
  return false;
}

/** Backoff before attempt N (1-based), in milliseconds. */
const BACKOFF_MS = [150, 400, 900, 1_600];

export interface SqliteBusyRetryOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withSqliteBusyRetry<T>(
  label: string,
  run: () => Promise<T>,
  options: SqliteBusyRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? BACKOFF_MS.length + 1);
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === attempts) throw error;
      lastError = error;
      options.onRetry?.(attempt, error);
      console.warn(
        `[sqlite-busy] ${label}: database was locked, retry ${attempt}/${attempts - 1}`,
      );
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }
  throw lastError;
}
