/**
 * The publish lifecycle must survive a locked database.
 *
 * Why this exists. Turso serialises writers. The publish request competes with
 * the bundle-factory tick, the status poller and operator scripts, so losing a
 * write race is routine, not exotic. Promotion, validation and approval were
 * already wrapped in the busy retry; the four lifecycle transactions that
 * BRACKET the marketplace POST were not.
 *
 * The consequence was worse than a red banner. When the claim's neighbours were
 * refused with SQLITE_BUSY, publishing failed with "database is locked" AND the
 * claim stayed in CLAIMED — so the SKU could not be published again either. The
 * fence outlived the request it was fencing, and only a hand edit could free it.
 *
 * These tests assert the retry is real, and — just as important — that it is
 * still refused for the one thing that must never be retried.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isSqliteBusyError,
  withSqliteBusyRetry,
} from "../../sqlite-busy-retry";

/** The shapes Turso/libSQL actually produce, not an invented one. */
const REAL_BUSY_ERRORS: Error[] = [
  new Error("SQLITE_BUSY: SQLITE_BUSY: SQLite error: database is locked"),
  new Error("SqliteError: database is locked"),
  Object.assign(new Error("write failed"), {
    cause: new Error("SQLITE_BUSY: database is locked"),
  }),
];

test("the busy errors Turso really emits are all recognised", () => {
  for (const error of REAL_BUSY_ERRORS) {
    assert.equal(
      isSqliteBusyError(error),
      true,
      `not recognised: ${error.message}`,
    );
  }
});

test("an unrelated failure is not mistaken for a lock", () => {
  assert.equal(isSqliteBusyError(new Error("UNIQUE constraint failed")), false);
  assert.equal(isSqliteBusyError(new Error("network unreachable")), false);
  assert.equal(isSqliteBusyError(null), false);
});

test("a write refused by a lock is retried and then succeeds", async () => {
  let calls = 0;
  const result = await withSqliteBusyRetry(
    "walmart:claim",
    async () => {
      calls += 1;
      if (calls < 3) throw REAL_BUSY_ERRORS[0];
      return "claimed";
    },
    { sleep: async () => {} },
  );
  assert.equal(result, "claimed");
  assert.equal(calls, 3, "should have retried twice before succeeding");
});

test("a write that keeps losing eventually surfaces, it does not hang", async () => {
  let calls = 0;
  await assert.rejects(
    () => withSqliteBusyRetry(
      "walmart:claim",
      async () => {
        calls += 1;
        throw REAL_BUSY_ERRORS[0];
      },
      { attempts: 3, sleep: async () => {} },
    ),
    /database is locked/,
  );
  assert.equal(calls, 3);
});

test("a non-lock failure is not retried — it is reported at once", async () => {
  let calls = 0;
  await assert.rejects(
    () => withSqliteBusyRetry(
      "walmart:claim",
      async () => {
        calls += 1;
        throw new Error("UNIQUE constraint failed: idempotency_key");
      },
      { sleep: async () => {} },
    ),
    /UNIQUE constraint failed/,
  );
  assert.equal(calls, 1, "a constraint violation must not be retried");
});

test("every lifecycle transaction that brackets the POST is wrapped", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../walmart-publish-lifecycle.ts"),
    "utf8",
  );

  // A bare prisma.$transaction here is the defect this test exists for.
  const bare: Array<{ line: string; number: number }> = source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /prisma\.\$transaction\(/.test(line))
    .filter(({ line }) => !/withSqliteBusyRetry|typeof prisma\.\$transaction/.test(line));

  assert.deepEqual(
    bare.map((entry) => `${entry.number}: ${entry.line.trim()}`),
    [],
    "Local lifecycle writes must go through busyTx so a lost write race does "
      + "not strand the claim. The marketplace POST is not a transaction and is "
      + "never retried.",
  );

  // And the guarantee that must NOT be softened: the POST is not in a retry.
  assert.doesNotMatch(
    source,
    /withSqliteBusyRetry\([^)]*requestRaw/,
    "The marketplace POST must never be wrapped in a retry.",
  );
});
