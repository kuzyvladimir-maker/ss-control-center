import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  canClaimDonorHarvest,
  createDonorHarvestState,
  donorHarvestIdentityKey,
  isDonorHarvestComplete,
  isDonorHarvestTerminal,
  transitionDonorHarvest,
} from "../donor-harvest-lifecycle";

const T0 = "2026-07-18T20:00:00.000Z";

function initial(options: { maxAttempts?: number; requestedFields?: string[] } = {}) {
  return createDonorHarvestState({
    donorProductId: "donor-1",
    source: " TARGET ",
    retailerProductId: "TCIN-123",
    requestedFields: options.requestedFields ?? ["Gallery", "ingredients", "gallery", "Nutrition"],
    maxAttempts: options.maxAttempts,
    now: T0,
  });
}

function claim(state: ReturnType<typeof initial>, at: string, suffix = "1") {
  return transitionDonorHarvest(state, {
    type: "claim",
    at,
    runId: `run-${suffix}`,
    approvalId: `approval-${suffix}`,
    leaseOwner: `worker-${suffix}`,
    leaseToken: `lease-${suffix}`,
    leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
  });
}

test("creates a canonical source/item identity and canonical requested fields", () => {
  const state = initial();
  assert.equal(state.source, "target");
  assert.deepEqual(state.requestedFields, ["gallery", "ingredients", "nutrition"]);
  assert.equal(state.status, "pending");
  assert.equal(state.attempts, 0);
  assert.equal(state.version, 0);
  assert.equal(
    donorHarvestIdentityKey(state),
    "donor-1|target|TCIN-123",
  );
});

test("permit denial releases the claim without consuming a source attempt", () => {
  const running = claim(initial(), T0);
  assert.equal(running.attempts, 0);

  const blocked = transitionDonorHarvest(running, {
    type: "permit_denied",
    at: "2026-07-18T20:00:01Z",
    nextEligibleAt: "2026-07-18T21:00:00Z",
    reason: "OWNER_BUDGET_PERMIT_MISSING",
  });
  assert.equal(blocked.status, "retry_wait");
  assert.equal(blocked.attempts, 0);
  assert.equal(blocked.lastError, null);
  assert.equal(blocked.lastBlockReason, "OWNER_BUDGET_PERMIT_MISSING");
  assert.equal(blocked.leaseToken, null);
  assert.equal(canClaimDonorHarvest(blocked, "2026-07-18T20:59:59Z"), false);
  assert.equal(canClaimDonorHarvest(blocked, "2026-07-18T21:00:00Z"), true);
});

test("source attempt is counted only after permit and can be started once per claim", () => {
  const running = claim(initial(), T0);
  const started = transitionDonorHarvest(running, {
    type: "source_attempt_started",
    at: "2026-07-18T20:00:01Z",
  });
  assert.equal(started.attempts, 1);
  assert.throws(
    () => transitionDonorHarvest(started, {
      type: "source_attempt_started",
      at: "2026-07-18T20:00:02Z",
    }),
    /already started/,
  );
  assert.throws(
    () => transitionDonorHarvest(started, {
      type: "permit_denied",
      at: "2026-07-18T20:00:02Z",
      nextEligibleAt: "2026-07-18T21:00:00Z",
      reason: "TOO_LATE",
    }),
    /must precede/,
  );
});

test("transient failures are bounded and max attempts becomes terminal error", () => {
  let state = initial({ maxAttempts: 2, requestedFields: ["gallery"] });
  state = claim(state, T0, "a");
  state = transitionDonorHarvest(state, {
    type: "source_attempt_started",
    at: "2026-07-18T20:00:01Z",
  });
  state = transitionDonorHarvest(state, {
    type: "transient_failure",
    at: "2026-07-18T20:00:02Z",
    error: "HTTP 503",
    nextEligibleAt: "2026-07-18T20:10:00Z",
  });
  assert.equal(state.status, "retry_wait");
  assert.equal(state.attempts, 1);

  state = claim(state, "2026-07-18T20:10:00Z", "b");
  state = transitionDonorHarvest(state, {
    type: "source_attempt_started",
    at: "2026-07-18T20:10:01Z",
  });
  state = transitionDonorHarvest(state, {
    type: "transient_failure",
    at: "2026-07-18T20:10:02Z",
    error: "HTTP 503 again",
  });
  assert.equal(state.status, "error");
  assert.equal(state.attempts, 2);
  assert.equal(state.terminalReason, "MAX_ATTEMPTS_EXHAUSTED");
  assert.equal(isDonorHarvestTerminal(state.status), true);
  assert.equal(canClaimDonorHarvest(state, "2026-07-19T00:00:00Z"), false);
});

test("known unsupported source becomes terminal without a source attempt", () => {
  const state = transitionDonorHarvest(initial({ requestedFields: ["gallery"] }), {
    type: "source_unavailable",
    at: "2026-07-18T20:00:01Z",
    reason: "SOURCE_CAPABILITY_UNSUPPORTED",
  });
  assert.equal(state.status, "source_unavailable");
  assert.equal(state.attempts, 0);
  assert.equal(state.terminalReason, "SOURCE_CAPABILITY_UNSUPPORTED");
  assert.equal(canClaimDonorHarvest(state, "2026-07-19T00:00:00Z"), false);
  assert.throws(
    () => claim(state, "2026-07-19T00:00:00Z"),
    /not claimable/,
  );
});

test("complete requires every requested field completed or explicitly unavailable", () => {
  let state = initial({ requestedFields: ["gallery", "ingredients", "nutrition"] });
  state = claim(state, T0, "a");
  state = transitionDonorHarvest(state, {
    type: "source_attempt_started",
    at: "2026-07-18T20:00:01Z",
  });
  state = transitionDonorHarvest(state, {
    type: "source_result",
    at: "2026-07-18T20:00:02Z",
    completedFields: ["gallery"],
    unavailableFields: ["ingredients"],
    nextEligibleAt: "2026-07-18T20:10:00Z",
  });
  assert.equal(state.status, "partial");
  assert.equal(isDonorHarvestComplete(state), false);

  state = claim(state, "2026-07-18T20:10:00Z", "b");
  state = transitionDonorHarvest(state, {
    type: "source_attempt_started",
    at: "2026-07-18T20:10:01Z",
  });
  state = transitionDonorHarvest(state, {
    type: "source_result",
    at: "2026-07-18T20:10:02Z",
    completedFields: ["nutrition"],
  });
  assert.equal(state.status, "complete");
  assert.deepEqual(state.completedFields, ["gallery", "nutrition"]);
  assert.deepEqual(state.unavailableFields, ["ingredients"]);
  assert.equal(isDonorHarvestComplete(state), true);
});

test("partial result on the final allowed attempt terminates instead of looping", () => {
  let state = initial({ maxAttempts: 1, requestedFields: ["gallery", "nutrition"] });
  state = claim(state, T0);
  state = transitionDonorHarvest(state, {
    type: "source_attempt_started",
    at: "2026-07-18T20:00:01Z",
  });
  state = transitionDonorHarvest(state, {
    type: "source_result",
    at: "2026-07-18T20:00:02Z",
    completedFields: ["gallery"],
  });
  assert.equal(state.status, "error");
  assert.equal(state.terminalReason, "MAX_ATTEMPTS_EXHAUSTED");
  assert.deepEqual(state.completedFields, ["gallery"]);
});

test("expired pre-network lease does not consume an attempt", () => {
  const running = claim(initial(), T0);
  assert.throws(
    () => transitionDonorHarvest(running, {
      type: "lease_expired",
      at: "2026-07-18T20:01:01Z",
      meteredBoundary: "invalid" as "not_observed",
      nextEligibleAt: "2026-07-18T20:05:00Z",
    }),
    /explicit metered boundary decision/,
  );
  assert.throws(
    () => transitionDonorHarvest(running, {
      type: "lease_expired",
      at: "2026-07-18T20:00:30Z",
      meteredBoundary: "not_observed",
      nextEligibleAt: "2026-07-18T20:05:00Z",
    }),
    /before leaseExpiresAt/,
  );
  const recovered = transitionDonorHarvest(running, {
    type: "lease_expired",
    at: "2026-07-18T20:01:01Z",
    meteredBoundary: "not_observed",
    nextEligibleAt: "2026-07-18T20:05:00Z",
  });
  assert.equal(recovered.status, "retry_wait");
  assert.equal(recovered.attempts, 0);
});

test("expired lease after a reservation marker or unknown boundary is terminal and never replayed", () => {
  let started = claim(initial({ maxAttempts: 3 }), T0);
  started = transitionDonorHarvest(started, {
    type: "source_attempt_started",
    at: "2026-07-18T20:00:01Z",
  });
  const marked = transitionDonorHarvest(started, {
    type: "lease_expired",
    at: "2026-07-18T20:01:01Z",
    meteredBoundary: "not_observed",
  });
  assert.equal(marked.status, "error");
  assert.equal(marked.attempts, 1);
  assert.equal(marked.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
  assert.equal(canClaimDonorHarvest(marked, "2026-07-19T00:00:00Z"), false);

  const unmarked = claim(initial(), T0, "unknown");
  const unknown = transitionDonorHarvest(unmarked, {
    type: "lease_expired",
    at: "2026-07-18T20:01:01Z",
    meteredBoundary: "observed_or_unknown",
  });
  assert.equal(unknown.status, "error");
  assert.equal(unknown.attempts, 0);
  assert.equal(unknown.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
});

test("a late durable reservation can terminalize a row even after its lease was safely released", () => {
  const running = claim(initial(), T0);
  const released = transitionDonorHarvest(running, {
    type: "lease_expired",
    at: "2026-07-18T20:01:01Z",
    meteredBoundary: "not_observed",
    nextEligibleAt: "2026-07-18T20:05:00Z",
  });
  const terminal = transitionDonorHarvest(released, {
    type: "metered_outcome_ambiguous",
    at: "2026-07-18T20:01:02Z",
    error: "reservation callback lost its state CAS",
  });
  assert.equal(terminal.status, "error");
  assert.equal(terminal.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
  assert.equal(terminal.nextEligibleAt, null);
});

test("rejects unrequested result fields and non-future retry timestamps", () => {
  let state = claim(initial({ requestedFields: ["gallery"] }), T0);
  state = transitionDonorHarvest(state, {
    type: "source_attempt_started",
    at: "2026-07-18T20:00:01Z",
  });
  assert.throws(
    () => transitionDonorHarvest(state, {
      type: "source_result",
      at: "2026-07-18T20:00:02Z",
      completedFields: ["ingredients"],
      nextEligibleAt: "2026-07-18T20:10:00Z",
    }),
    /unrequested fields/,
  );
  assert.throws(
    () => transitionDonorHarvest(state, {
      type: "transient_failure",
      at: "2026-07-18T20:00:02Z",
      error: "timeout",
      nextEligibleAt: "2026-07-18T20:00:02Z",
    }),
    /later than event time/,
  );
});

test("migration enforces complete-field resolution at the database boundary", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute("CREATE TABLE DonorProduct (id TEXT PRIMARY KEY)");
    await db.execute({ sql: "INSERT INTO DonorProduct(id) VALUES (?)", args: ["donor-1"] });
    const migrationUrl = new URL(
      "../../../../prisma/migrations/20260718233000_donor_harvest_lifecycle/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migrationUrl, "utf8"));

    const insert = `INSERT INTO DonorHarvestState (
      id, donorProductId, source, retailerProductId, status,
      requestedFields, completedFields, unavailableFields, finishedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await assert.rejects(
      db.execute({
        sql: insert,
        args: [
          "harvest-unresolved", "donor-1", "target", "tcin-1", "complete",
          '["gallery"]', "[]", "[]", "2026-07-18T20:00:00Z",
        ],
      }),
      /HARVEST_COMPLETE_WITH_UNRESOLVED_FIELDS/,
    );
    await db.execute({
      sql: insert,
      args: [
        "harvest-resolved", "donor-1", "target", "tcin-2", "complete",
        '["gallery","nutrition"]', '["gallery"]', '["nutrition"]', "2026-07-18T20:00:00Z",
      ],
    });
    const saved = await db.execute({
      sql: "SELECT status FROM DonorHarvestState WHERE id=?",
      args: ["harvest-resolved"],
    });
    assert.equal(saved.rows[0]?.status, "complete");
  } finally {
    await db.close();
  }
});
