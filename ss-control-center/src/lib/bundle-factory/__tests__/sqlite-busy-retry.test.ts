import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isSqliteBusyError,
  withSqliteBusyRetry,
} from "../sqlite-busy-retry";

test("a locked database is recognised however it is wrapped", () => {
  assert.ok(isSqliteBusyError(new Error("SQLITE_BUSY: database is locked")));
  assert.ok(isSqliteBusyError({ cause: new Error("SQLITE_BUSY") }));
  assert.ok(isSqliteBusyError(new Error("SQLite error: database is locked")));
  // Anything else must surface immediately rather than being retried away.
  assert.equal(isSqliteBusyError(new Error("UNIQUE constraint failed")), false);
  assert.equal(isSqliteBusyError(null), false);
});

test("a busy write is retried; any other failure is not", async () => {
  let calls = 0;
  const slept: number[] = [];
  const value = await withSqliteBusyRetry(
    "test",
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("SQLITE_BUSY: database is locked");
      return "written";
    },
    { sleep: async (ms) => void slept.push(ms) },
  );
  assert.equal(value, "written");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [150, 400], "backoff grows between attempts");

  let otherCalls = 0;
  await assert.rejects(
    () => withSqliteBusyRetry("test", async () => {
      otherCalls += 1;
      throw new Error("UNIQUE constraint failed");
    }, { sleep: async () => {} }),
    /UNIQUE constraint failed/,
  );
  assert.equal(otherCalls, 1, "a real error is not retried");
});

test("the retry never wraps the marketplace POST", async () => {
  const route = await read("../../../app/api/bundle-factory/drafts/[id]/publish/route.ts");
  // Local database work is retried…
  assert.match(route, /withSqliteBusyRetry\(\s*"publish:promote"/u);
  assert.match(route, /withSqliteBusyRetry\(\s*"publish:validate"/u);
  assert.match(route, /withSqliteBusyRetry\(\s*"publish:approve"/u);
  // …and runDistribution, which can POST to Walmart, is called plainly.
  assert.match(route, /const result = await runDistribution\(\{/u);
  assert.doesNotMatch(route, /withSqliteBusyRetry\([^)]*runDistribution/u);
});

async function read(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}
