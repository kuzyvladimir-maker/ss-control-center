import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  claimDonorHarvestState,
  completedHarvestFieldsFromDonorProduct,
  DONOR_HARVEST_STORE_CONTRACT_ERROR,
  DonorHarvestSeedConflictError,
  getDonorHarvestState,
  listExpiredDonorHarvestLeases,
  listClaimableDonorHarvestStates,
  parseDonorHarvestStateRow,
  persistDonorHarvestTransition,
  reapExpiredDonorHarvestLeases,
  seedDonorHarvestState,
  serializeDonorHarvestState,
} from "../donor-harvest-store";
import { createDonorHarvestState } from "../donor-harvest-lifecycle";

const T0 = "2026-07-18T20:00:00.000Z";

async function migratedDb(donorIds: string[] = ["donor-1"]): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.execute("PRAGMA foreign_keys=ON");
  await db.execute("CREATE TABLE DonorProduct (id TEXT PRIMARY KEY)");
  for (const donorId of donorIds) {
    await db.execute({ sql: "INSERT INTO DonorProduct(id) VALUES (?)", args: [donorId] });
  }
  const migrationUrl = new URL(
    "../../../../prisma/migrations/20260718233000_donor_harvest_lifecycle/migration.sql",
    import.meta.url,
  );
  await db.executeMultiple(await readFile(migrationUrl, "utf8"));
  return db;
}

function seedInput(donorProductId = "donor-1") {
  return {
    donorProductId,
    source: " TARGET ",
    retailerProductId: `TCIN-${donorProductId}`,
    requestedFields: ["Nutrition", "gallery", "ingredients", "gallery"],
    maxAttempts: 3,
    now: T0,
  };
}

function claimEvent(suffix: string) {
  return {
    type: "claim" as const,
    at: T0,
    runId: `run-${suffix}`,
    approvalId: `approval-${suffix}`,
    leaseOwner: `worker-${suffix}`,
    leaseToken: `lease-${suffix}`,
    leaseExpiresAt: "2026-07-18T20:05:00.000Z",
  };
}

test("serializes and parses the pure lifecycle without weakening its invariants", () => {
  const state = createDonorHarvestState(seedInput());
  const serialized = serializeDonorHarvestState(state);
  const parsed = parseDonorHarvestStateRow({ id: "harvest-1", ...serialized });
  assert.deepEqual(parsed, { id: "harvest-1", ...state });

  assert.throws(
    () => parseDonorHarvestStateRow({
      id: "harvest-bad",
      ...serialized,
      requestedFields: "not-json",
    }),
    /must contain valid JSON/,
  );
});

test("fails closed when the lifecycle migration is absent", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute("CREATE TABLE DonorProduct (id TEXT PRIMARY KEY)");
    await assert.rejects(
      listClaimableDonorHarvestStates(db, { now: T0 }),
      (error: unknown) => (
        error instanceof Error && error.message.includes(DONOR_HARVEST_STORE_CONTRACT_ERROR)
      ),
    );
  } finally {
    await db.close();
  }
});

test("store source contains no legacy DonorProduct selection path", async () => {
  const sourceUrl = new URL("../donor-harvest-store.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  assert.doesNotMatch(source, /\b(?:FROM|JOIN)\s+["'`]?(?:main\.)?["'`]?DonorProduct\b/i);
});

test("seed is canonical and idempotent but rejects changed work intent", async () => {
  const db = await migratedDb();
  try {
    const first = await seedDonorHarvestState(db, seedInput());
    const second = await seedDonorHarvestState(db, {
      ...seedInput(),
      source: "target",
      requestedFields: ["ingredients", "gallery", "nutrition"],
      now: "2026-07-18T21:00:00Z",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.state.id, first.state.id);
    assert.equal(second.state.source, "target");
    assert.deepEqual(second.state.requestedFields, ["gallery", "ingredients", "nutrition"]);

    await assert.rejects(
      seedDonorHarvestState(db, {
        ...seedInput(),
        requestedFields: ["gallery", "ingredients", "nutrition", "description"],
      }),
      DonorHarvestSeedConflictError,
    );
    const count = await db.execute("SELECT COUNT(*) AS count FROM DonorHarvestState");
    assert.equal(Number(count.rows[0]?.count), 1);
  } finally {
    await db.close();
  }
});

test("claimable listing excludes future and terminal rows", async () => {
  const db = await migratedDb(["ready", "future", "terminal"]);
  try {
    const ready = await seedDonorHarvestState(db, seedInput("ready"));
    await seedDonorHarvestState(db, {
      ...seedInput("future"),
      nextEligibleAt: "2026-07-18T21:00:00Z",
    });
    const terminal = await seedDonorHarvestState(db, seedInput("terminal"));
    const terminalState = await persistDonorHarvestTransition(db, terminal.state, {
      type: "source_unavailable",
      at: "2026-07-18T20:00:01Z",
      reason: "SOURCE_CAPABILITY_UNSUPPORTED",
    });
    assert.equal(terminalState?.status, "source_unavailable");

    const claimable = await listClaimableDonorHarvestStates(db, { now: T0 });
    assert.deepEqual(claimable.map((state) => state.id), [ready.state.id]);
  } finally {
    await db.close();
  }
});

test("two concurrent CAS claims produce exactly one winner", async () => {
  const db = await migratedDb();
  try {
    const seeded = await seedDonorHarvestState(db, seedInput());
    const claims = await Promise.all([
      claimDonorHarvestState(db, seeded.state, claimEvent("a")),
      claimDonorHarvestState(db, seeded.state, claimEvent("b")),
    ]);
    const winners = claims.filter((state) => state !== null);
    assert.equal(winners.length, 1);

    const stored = await getDonorHarvestState(db, seeded.state.id);
    assert.equal(stored?.status, "running");
    assert.equal(stored?.version, 1);
    assert.equal(stored?.leaseToken, winners[0]?.leaseToken);
  } finally {
    await db.close();
  }
});

test("non-claim transitions also use version CAS and retain the winning lease", async () => {
  const db = await migratedDb();
  try {
    const seeded = await seedDonorHarvestState(db, seedInput());
    const running = await claimDonorHarvestState(db, seeded.state, claimEvent("only"));
    assert.ok(running);

    const starts = await Promise.all([
      persistDonorHarvestTransition(db, running, {
        type: "source_attempt_started",
        at: "2026-07-18T20:00:01Z",
      }),
      persistDonorHarvestTransition(db, running, {
        type: "source_attempt_started",
        at: "2026-07-18T20:00:01Z",
      }),
    ]);
    assert.equal(starts.filter((state) => state !== null).length, 1);
    const stored = await getDonorHarvestState(db, running.id);
    assert.equal(stored?.attempts, 1);
    assert.equal(stored?.version, 2);
    assert.equal(stored?.leaseToken, "lease-only");
  } finally {
    await db.close();
  }
});

test("expired lease reaper retries only a boundary proven to be pre-reservation", async () => {
  const db = await migratedDb();
  try {
    const seeded = await seedDonorHarvestState(db, seedInput());
    const running = await claimDonorHarvestState(db, seeded.state, claimEvent("expired"));
    assert.ok(running);
    const expired = await listExpiredDonorHarvestLeases(db, {
      now: "2026-07-18T20:05:01Z",
    });
    assert.deepEqual(expired.map((state) => state.id), [running.id]);

    const reaped = await reapExpiredDonorHarvestLeases(db, {
      now: "2026-07-18T20:05:01Z",
      retryDelayMs: 60_000,
      meteredBoundaryFor: () => "not_observed",
    });
    assert.equal(reaped.scanned, 1);
    assert.equal(reaped.requeuedPreReservation, 1);
    assert.equal(reaped.terminalAmbiguous, 0);
    assert.equal(reaped.lostRaces, 0);
    assert.equal(reaped.states[0]?.status, "retry_wait");
    assert.equal(reaped.states[0]?.attempts, 0);
    assert.equal(reaped.states[0]?.nextEligibleAt, "2026-07-18T20:06:01.000Z");
  } finally {
    await db.close();
  }
});

test("expired lease reaper fails closed for a marker, receipt, missing probe, or probe error", async () => {
  for (const scenario of ["marker", "receipt", "missing_probe", "probe_error"] as const) {
    const db = await migratedDb();
    try {
      const seeded = await seedDonorHarvestState(db, seedInput());
      let running = await claimDonorHarvestState(db, seeded.state, claimEvent(scenario));
      assert.ok(running);
      if (scenario === "marker") {
        running = await persistDonorHarvestTransition(db, running, {
          type: "source_attempt_started",
          at: "2026-07-18T20:00:01Z",
        });
        assert.ok(running);
      }
      const boundary = scenario === "receipt"
        ? () => "observed_or_unknown" as const
        : scenario === "probe_error"
          ? () => { throw new Error("ledger unavailable"); }
          : scenario === "marker"
            ? () => "not_observed" as const
            : undefined;
      const reaped = await reapExpiredDonorHarvestLeases(db, {
        now: "2026-07-18T20:05:01Z",
        retryDelayMs: 60_000,
        meteredBoundaryFor: boundary,
      });
      assert.equal(reaped.requeuedPreReservation, 0, scenario);
      assert.equal(reaped.terminalAmbiguous, 1, scenario);
      assert.equal(reaped.states[0]?.status, "error", scenario);
      assert.equal(
        reaped.states[0]?.terminalReason,
        "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
        scenario,
      );
      assert.equal(reaped.states[0]?.nextEligibleAt, null, scenario);
    } finally {
      await db.close();
    }
  }
});

test("maps only conservatively complete current DonorProduct fields", () => {
  const completed = completedHarvestFieldsFromDonorProduct({
    title: "Product",
    description: " ",
    ingredients: "water, salt",
    nutritionFacts: '{"calories":100}',
    mainImageUrl: "https://example.test/main.jpg",
    imageUrls: JSON.stringify([
      "https://example.test/1.jpg",
      "https://example.test/2.jpg",
      "https://example.test/3.jpg",
      "https://example.test/4.jpg",
      "https://example.test/5.jpg",
    ]),
  }, ["title", "description", "ingredients", "nutrition", "gallery", "unknown"]);
  assert.deepEqual(completed, ["gallery", "ingredients", "nutrition", "title"]);

  assert.deepEqual(
    completedHarvestFieldsFromDonorProduct(
      { mainImageUrl: "https://example.test/main.jpg", imageUrls: '["one.jpg"]' },
      ["gallery", "main_image"],
    ),
    ["main_image"],
  );
});
