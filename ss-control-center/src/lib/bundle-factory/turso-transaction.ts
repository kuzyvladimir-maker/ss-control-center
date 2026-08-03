/**
 * Interactive-transaction timeouts sized for Turso, not for a local file.
 *
 * Prisma defaults an interactive transaction to 5 seconds of total wall clock.
 * That is generous against a local SQLite file and tight against Turso, where
 * every statement is a network round trip and writers are serialised — so a
 * transaction of a dozen ordinary statements can spend most of its budget
 * waiting rather than working.
 *
 * Publishing hit exactly that: promotion died with "A query cannot be executed
 * on an expired transaction ... 6358 ms passed", having done nothing wrong. The
 * same class of failure is recorded for the Product Truth control plane, where
 * it showed up as heartbeat 409/P2028.
 *
 * These values buy time; they do not make a slow transaction correct. Long work
 * — network calls, image rendering — still belongs OUTSIDE the transaction.
 */

/** Total time an interactive transaction may run before Prisma expires it. */
export const TURSO_TRANSACTION_TIMEOUT_MS = 30_000;

/** How long to wait for a connection before starting. */
export const TURSO_TRANSACTION_MAX_WAIT_MS = 10_000;

export const TURSO_TRANSACTION_OPTIONS = {
  timeout: TURSO_TRANSACTION_TIMEOUT_MS,
  maxWait: TURSO_TRANSACTION_MAX_WAIT_MS,
} as const;
