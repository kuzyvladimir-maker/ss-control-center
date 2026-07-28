import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createClient } from "@libsql/client";

import {
  encodeMeteredRunPermit,
  expectedMeteredRunConfirmation,
  resetMeteredCallUsageForTests,
  type MeteredProvider,
  type MeteredRunPermit,
} from "../metered-call-guard";
import { MeteredBudgetLedgerContractError } from "../metered-budget-store";
import {
  MeteredBudgetLedgerUnavailableError,
  MeteredProviderAuthorizationCallbackError,
  MeteredProviderReplayError,
  isMeteredProviderControlError,
  meteredProviderReservationKey,
  withMeteredProviderCall,
} from "../metered-provider-call";

const migrationUrl = new URL(
  "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
  import.meta.url,
);

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  resetMeteredCallUsageForTests();
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

function permit(
  runId: string,
  provider: MeteredProvider = "unwrangle",
  operations = ["search"],
): MeteredRunPermit {
  const now = Date.now();
  return {
    version: 1,
    runId,
    approvalId: `owner-${runId}`,
    approvedBy: "owner",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    providers: {
      [provider]: { operations, maxCalls: 10, maxUnits: 10 },
    },
  };
}

function envFor(p: MeteredRunPermit, databaseUrl?: string) {
  return {
    SS_METERED_RUN_PERMIT: encodeMeteredRunPermit(p),
    SS_METERED_RUN_CONFIRM: expectedMeteredRunConfirmation(p),
    DATABASE_URL: databaseUrl,
  };
}

async function migratedDatabase(): Promise<{ directory: string; url: string }> {
  const directory = await mkdtemp(join(tmpdir(), "metered-provider-call-"));
  temporaryDirectories.add(directory);
  const url = `file:${join(directory, "ledger.db")}`;
  const db = createClient({ url });
  try {
    await db.executeMultiple(await readFile(migrationUrl, "utf8"));
  } finally {
    await db.close();
  }
  return { directory, url };
}

test("reservation keys are deterministic, order-independent and opaque", () => {
  const first = meteredProviderReservationKey({
    provider: "unwrangle",
    operation: "search",
    requestFingerprint: { query: "secret-query", retailer: "target" },
  });
  const reordered = meteredProviderReservationKey({
    provider: "unwrangle",
    operation: "search",
    requestFingerprint: { retailer: "target", query: "secret-query" },
  });
  const changed = meteredProviderReservationKey({
    provider: "unwrangle",
    operation: "search",
    requestFingerprint: { query: "different", retailer: "target" },
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^mpr_v1_[a-f0-9]{64}$/);
  assert.equal(first.includes("secret-query"), false);
});

test("missing permit preserves MeteredProviderBlockedError before DB and network", async () => {
  let networkCalls = 0;
  await assert.rejects(
    withMeteredProviderCall(
      { provider: "unwrangle", operation: "search", requestFingerprint: { query: "x" } },
      async () => { networkCalls += 1; },
      {},
    ),
    (error: unknown) => error instanceof Error
      && error.name === "MeteredProviderBlockedError"
      && isMeteredProviderControlError(error),
  );
  assert.equal(networkCalls, 0);
});

test("valid permit with no ledger URL fails closed with zero network calls", async () => {
  const p = permit("missing-ledger-url");
  let networkCalls = 0;
  await assert.rejects(
    withMeteredProviderCall(
      { provider: "unwrangle", operation: "search", requestFingerprint: { query: "x" } },
      async () => { networkCalls += 1; },
      envFor(p),
    ),
    MeteredBudgetLedgerUnavailableError,
  );
  assert.equal(networkCalls, 0);
});

test("valid permit with an unmigrated ledger fails closed with zero network calls", async () => {
  const p = permit("missing-ledger-schema");
  let networkCalls = 0;
  await assert.rejects(
    withMeteredProviderCall(
      { provider: "unwrangle", operation: "search", requestFingerprint: { query: "x" } },
      async () => { networkCalls += 1; },
      envFor(p, "file::memory:"),
    ),
    (error: unknown) => error instanceof MeteredBudgetLedgerContractError
      && isMeteredProviderControlError(error),
  );
  assert.equal(networkCalls, 0);
});

test("one durable reservation authorizes one call, settles success and blocks replay", async () => {
  const { url } = await migratedDatabase();
  const p = permit("success-and-replay");
  const env = envFor(p, url);
  let networkCalls = 0;
  let authorizationCallbacks = 0;
  const events: string[] = [];
  const input = {
    provider: "unwrangle" as const,
    operation: "search",
    requestFingerprint: { query: "same request", retailer: "target" },
    onAuthorized: () => {
      authorizationCallbacks += 1;
      events.push("authorized");
    },
  };

  const result = await withMeteredProviderCall(input, async () => {
    networkCalls += 1;
    events.push("network");
    return "ok";
  }, env);
  assert.equal(result, "ok");

  await assert.rejects(
    withMeteredProviderCall(input, async () => {
      networkCalls += 1;
      return "must-not-run";
    }, env),
    MeteredProviderReplayError,
  );
  assert.equal(networkCalls, 1);
  assert.equal(authorizationCallbacks, 1);
  assert.deepEqual(events, ["authorized", "network"]);

  const db = createClient({ url });
  try {
    const receipts = await db.execute("SELECT status FROM MeteredReservationReceipt");
    const settlements = await db.execute("SELECT outcome FROM MeteredReservationSettlement");
    assert.deepEqual(receipts.rows.map((row) => String(row.status)), ["succeeded"]);
    assert.deepEqual(settlements.rows.map((row) => String(row.outcome)), ["success"]);
  } finally {
    await db.close();
  }
});

test("network failure is settled once and then returned to the adapter", async () => {
  const { url } = await migratedDatabase();
  const p = permit("network-failure");
  const expected = new Error("synthetic transport failure?api_key=super-secret");
  let networkCalls = 0;

  await assert.rejects(
    withMeteredProviderCall(
      { provider: "unwrangle", operation: "search", requestFingerprint: { query: "failure" } },
      async () => {
        networkCalls += 1;
        throw expected;
      },
      envFor(p, url),
    ),
    (error: unknown) => error === expected,
  );
  assert.equal(networkCalls, 1);

  const db = createClient({ url });
  try {
    const row = await db.execute(`SELECT r.status, s.outcome, s.detail
      FROM MeteredReservationReceipt r
      JOIN MeteredReservationSettlement s ON s.reservationId = r.id`);
    assert.equal(row.rows[0]?.status, "failed");
    assert.equal(row.rows[0]?.outcome, "failure");
    assert.equal(String(row.rows[0]?.detail).includes("super-secret"), false);
    assert.match(String(row.rows[0]?.detail), /\[REDACTED\]/);
  } finally {
    await db.close();
  }
});

test("authorization callback failure settles without invoking the provider", async () => {
  const { url } = await migratedDatabase();
  const p = permit("callback-failure");
  let networkCalls = 0;

  await assert.rejects(
    withMeteredProviderCall(
      {
        provider: "unwrangle",
        operation: "search",
        requestFingerprint: { query: "callback" },
        onAuthorized: () => { throw new Error("lifecycle write failed"); },
      },
      async () => { networkCalls += 1; },
      envFor(p, url),
    ),
    MeteredProviderAuthorizationCallbackError,
  );
  assert.equal(networkCalls, 0);

  const db = createClient({ url });
  try {
    const row = await db.execute(`SELECT r.status, s.outcome
      FROM MeteredReservationReceipt r
      JOIN MeteredReservationSettlement s ON s.reservationId = r.id`);
    assert.equal(row.rows[0]?.status, "failed");
    assert.equal(row.rows[0]?.outcome, "failure");
  } finally {
    await db.close();
  }
});
