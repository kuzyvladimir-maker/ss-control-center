import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  executeDonorHarvestCandidate,
  parseDonorHarvestSource,
  reapExpiredDonorHarvestForExecution,
  type ExecuteDonorHarvestCandidateInput,
} from "../donor-harvest-executor";
import {
  claimDonorHarvestState,
  getDonorHarvestState,
  listClaimableDonorHarvestStates,
  persistDonorHarvestTransition,
  seedDonorHarvestState,
} from "../donor-harvest-store";
import {
  MeteredProviderReplayError,
  meteredProviderReservationKey,
} from "../metered-provider-call";

const T0 = "2026-07-18T20:00:00.000Z";
const PRODUCT_URL = "https://www.walmart.com/ip/123";

async function executorDb(donorIds: string[] = ["donor-1"]): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.execute("PRAGMA foreign_keys=ON");
  await db.execute(`CREATE TABLE DonorProduct (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    bullets TEXT,
    attributes TEXT,
    nutritionFacts TEXT,
    ingredients TEXT,
    mainImageUrl TEXT,
    imageUrls TEXT,
    upc TEXT,
    gtin TEXT
  )`);
  await db.execute(`CREATE TABLE DonorOffer (
    donorProductId TEXT NOT NULL,
    retailer TEXT NOT NULL,
    retailerProductId TEXT NOT NULL,
    productUrl TEXT,
    via TEXT NOT NULL,
    isFirstParty INTEGER NOT NULL,
    sellerName TEXT,
    packSizeSeen INTEGER
  )`);
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

async function seed(
  db: Client,
  donorProductId = "donor-1",
  options: {
    firstParty?: boolean;
    via?: string;
    requestedFields?: string[];
    productUrl?: string;
    sellerName?: string;
    packSizeSeen?: number;
  } = {},
) {
  const retailerProductId = `ITEM-${donorProductId}`;
  await db.execute({
    sql: `INSERT INTO DonorOffer(
            donorProductId,retailer,retailerProductId,productUrl,via,isFirstParty,
            sellerName,packSizeSeen
          ) VALUES (?,?,?,?,?,?,?,?)`,
    args: [
      donorProductId,
      "walmart",
      retailerProductId,
      options.productUrl ?? PRODUCT_URL.replace("123", donorProductId),
      options.via ?? "direct",
      options.firstParty === false ? 0 : 1,
      options.sellerName ?? "Walmart.com",
      options.packSizeSeen ?? 1,
    ],
  });
  return (await seedDonorHarvestState(db, {
    donorProductId,
    source: "unwrangle:walmart",
    retailerProductId,
    requestedFields: options.requestedFields ?? ["gallery", "description", "nutrition"],
    maxAttempts: 3,
    now: T0,
  })).state;
}

function executionInput(
  db: Client,
  candidate: Awaited<ReturnType<typeof seed>>,
  harvestDetail: NonNullable<ExecuteDonorHarvestCandidateInput["harvestDetail"]>,
): ExecuteDonorHarvestCandidateInput {
  return {
    db,
    candidate,
    runId: "run-1",
    approvalId: "approval-1",
    leaseOwner: "test-worker",
    leaseToken: `lease-${candidate.donorProductId}`,
    now: () => T0,
    harvestDetail,
  };
}

function authorization() {
  return {
    runId: "run-1",
    approvalId: "approval-1",
    provider: "unwrangle" as const,
    operation: "detail",
    reservationKey: "reservation-1",
    receiptId: "receipt-1",
  };
}

test("source allow-list excludes BJ's and strict offer preflight blocks non-first-party/direct rows", async () => {
  assert.equal(parseDonorHarvestSource("unwrangle:bjs"), null);
  assert.equal(parseDonorHarvestSource("bluecart:target"), null);
  assert.deepEqual(parseDonorHarvestSource("unwrangle:target"), {
    provider: "unwrangle",
    retailer: "target",
  });

  for (const invalid of [
    { firstParty: false, expected: "SOURCE_ITEM_NOT_EXPLICIT_FIRST_PARTY" },
    { via: "instacart", expected: "SOURCE_ITEM_NOT_DIRECT" },
    { sellerName: "Third Party Seller", expected: "SOURCE_ITEM_SELLER_NOT_WALMART_COM" },
    {
      productUrl: "https://third-party.example/item/123",
      expected: "SOURCE_ITEM_RETAILER_DOMAIN_MISMATCH",
    },
  ]) {
    const db = await executorDb();
    try {
      const candidate = await seed(db, "donor-1", invalid);
      let calls = 0;
      const result = await executeDonorHarvestCandidate(executionInput(
        db,
        candidate,
        async () => {
          calls++;
          throw new Error("must not dispatch");
        },
      ));
      assert.equal(calls, 0);
      assert.equal(result.disposition, "terminal");
      assert.equal(result.state?.status, "source_unavailable");
      assert.equal(result.state?.terminalReason, invalid.expected);
    } finally {
      await db.close();
    }
  }
});

test("targeted base-unit preflight blocks a stored retailer multipack before detail dispatch", async () => {
  const db = await executorDb();
  try {
    const candidate = await seed(db, "donor-1", { packSizeSeen: 2 });
    let calls = 0;
    const result = await executeDonorHarvestCandidate({
      ...executionInput(db, candidate, async () => {
        calls++;
        throw new Error("must not dispatch");
      }),
      requireBaseUnit: true,
    });
    assert.equal(calls, 0);
    assert.equal(result.disposition, "terminal");
    assert.equal(result.reason, "SOURCE_ITEM_NOT_BASE_UNIT");
  } finally {
    await db.close();
  }
});

test("successful guarded detail resolves the source once and terminalizes its missing fields", async () => {
  const db = await executorDb();
  try {
    const candidate = await seed(db);
    const result = await executeDonorHarvestCandidate(executionInput(
      db,
      candidate,
      async (conn, productId, options) => {
        await options.onMeteredReservation?.(authorization());
        await conn.execute({
          sql: `UPDATE DonorProduct SET imageUrls=? WHERE id=?`,
          args: [JSON.stringify(["1", "2", "3", "4", "5"]), productId],
        });
        return {
          ok: true,
          productId,
          images: 5,
          upc: null,
          hasIngredients: false,
          merged: 0,
        };
      },
    ));
    assert.equal(result.disposition, "complete");
    assert.equal(result.state?.status, "complete");
    assert.equal(result.state?.attempts, 1);
    assert.deepEqual(result.state?.completedFields, ["gallery"]);
    assert.deepEqual(result.state?.unavailableFields, ["description", "nutrition"]);
    assert.deepEqual(await listClaimableDonorHarvestStates(db, {
      now: "2026-07-19T20:00:00Z",
    }), []);
  } finally {
    await db.close();
  }
});

test("provider miss or exception after reservation is terminal and cannot spend a retry", async () => {
  for (const scenario of ["miss", "throw"] as const) {
    const db = await executorDb();
    try {
      const candidate = await seed(db);
      const result = await executeDonorHarvestCandidate(executionInput(
        db,
        candidate,
        async (_conn, productId, options) => {
          await options.onMeteredReservation?.(authorization());
          if (scenario === "throw") throw new Error("connection dropped after dispatch");
          return {
            ok: false,
            productId,
            images: 0,
            upc: null,
            hasIngredients: false,
            merged: 0,
            reason: "detail fetch failed",
          };
        },
      ));
      assert.equal(result.disposition, "terminal", scenario);
      assert.equal(result.state?.status, "error", scenario);
      assert.equal(result.state?.attempts, 1, scenario);
      assert.equal(
        result.state?.terminalReason,
        scenario === "miss"
          ? "SOURCE_DETAIL_UNAVAILABLE_AFTER_METERED_ATTEMPT"
          : "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
        scenario,
      );
      assert.deepEqual(await listClaimableDonorHarvestStates(db, {
        now: "2026-07-19T20:00:00Z",
      }), [], scenario);
    } finally {
      await db.close();
    }
  }
});

test("a pre-reservation configuration block consumes no attempt and remains explicitly delayed", async () => {
  const db = await executorDb();
  try {
    const candidate = await seed(db);
    const result = await executeDonorHarvestCandidate(executionInput(
      db,
      candidate,
      async (_conn, productId) => ({
        ok: false,
        productId,
        images: 0,
        upc: null,
        hasIngredients: false,
        merged: 0,
        reason: "detail fetch failed",
      }),
    ));
    assert.equal(result.disposition, "blocked");
    assert.equal(result.state?.status, "retry_wait");
    assert.equal(result.state?.attempts, 0);
    assert.equal(result.state?.lastBlockReason, "PRE_NETWORK_SOURCE_CONFIGURATION_BLOCKED");
  } finally {
    await db.close();
  }
});

test("a replay/control signal with an unreadable or positive ledger is terminal, not retryable", async () => {
  const db = await executorDb();
  try {
    const candidate = await seed(db);
    const result = await executeDonorHarvestCandidate(executionInput(
      db,
      candidate,
      async () => {
        throw new MeteredProviderReplayError("reservation-key", "receipt-id");
      },
    ));
    assert.equal(result.disposition, "terminal");
    assert.equal(result.state?.status, "error");
    assert.equal(result.state?.attempts, 0);
    assert.equal(result.state?.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
  } finally {
    await db.close();
  }
});

test("a claimable row with any prior metered attempt is excluded instead of silently replayed", async () => {
  const db = await executorDb();
  try {
    const candidate = await seed(db);
    let prior = await claimDonorHarvestState(db, candidate, {
      type: "claim",
      at: T0,
      runId: "old-run",
      approvalId: "old-approval",
      leaseOwner: "old-worker",
      leaseToken: "old-lease",
      leaseExpiresAt: "2026-07-18T20:01:00Z",
    });
    assert.ok(prior);
    prior = await persistDonorHarvestTransition(db, prior, {
      type: "source_attempt_started",
      at: "2026-07-18T20:00:01Z",
    });
    assert.ok(prior);
    prior = await persistDonorHarvestTransition(db, prior, {
      type: "transient_failure",
      at: "2026-07-18T20:00:02Z",
      error: "legacy retryable outcome",
      nextEligibleAt: "2026-07-18T20:00:03Z",
    });
    assert.ok(prior);
    let calls = 0;
    const result = await executeDonorHarvestCandidate(executionInput(
      db,
      prior,
      async () => {
        calls++;
        throw new Error("must not replay");
      },
    ));
    assert.equal(calls, 0);
    assert.equal(result.disposition, "terminal");
    assert.equal(result.state?.status, "error");
    assert.equal(result.state?.attempts, 1);
    assert.equal(result.state?.terminalReason, "AUTOMATIC_METERED_REPLAY_FORBIDDEN");
  } finally {
    await db.close();
  }
});

test("authorization mismatch is after the durable boundary and becomes terminal ambiguous", async () => {
  const db = await executorDb();
  try {
    const candidate = await seed(db);
    const result = await executeDonorHarvestCandidate(executionInput(
      db,
      candidate,
      async (_conn, productId, options) => {
        await options.onMeteredReservation?.({
          ...authorization(),
          approvalId: "wrong-approval",
        });
        return {
          ok: true,
          productId,
          images: 0,
          upc: null,
          hasIngredients: false,
          merged: 0,
        };
      },
    ));
    assert.equal(result.disposition, "terminal");
    assert.equal(result.state?.status, "error");
    assert.equal(result.state?.attempts, 0);
    assert.equal(result.state?.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
  } finally {
    await db.close();
  }
});

test("expired-lease wrapper consults the exact durable reservation key before retry", async () => {
  const db = await executorDb(["safe", "reserved"]);
  try {
    await db.execute(`CREATE TABLE MeteredProviderBudget (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      approvalId TEXT NOT NULL,
      provider TEXT NOT NULL
    )`);
    await db.execute(`CREATE TABLE MeteredReservationReceipt (
      budgetId TEXT NOT NULL,
      reservationKey TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
    for (const suffix of ["safe", "reserved"]) {
      await db.execute({
        sql: `INSERT INTO MeteredProviderBudget(id,runId,approvalId,provider)
              VALUES (?,?,?,?)`,
        args: [`budget-${suffix}`, `run-${suffix}`, `approval-${suffix}`, "unwrangle"],
      });
    }

    const safe = await seed(db, "safe", { productUrl: "https://www.walmart.com/ip/safe" });
    const reserved = await seed(db, "reserved", {
      productUrl: "https://www.walmart.com/ip/reserved",
    });
    for (const candidate of [safe, reserved]) {
      const claimed = await claimDonorHarvestState(db, candidate, {
        type: "claim",
        at: T0,
        runId: `run-${candidate.donorProductId}`,
        approvalId: `approval-${candidate.donorProductId}`,
        leaseOwner: "dead-worker",
        leaseToken: `lease-${candidate.donorProductId}`,
        leaseExpiresAt: "2026-07-18T20:00:01Z",
      });
      assert.ok(claimed);
    }
    const reservedKey = meteredProviderReservationKey({
      provider: "unwrangle",
      operation: "detail",
      requestFingerprint: {
        platform: "walmart_detail",
        retailer: "walmart",
        url: "https://www.walmart.com/ip/reserved",
      },
    });
    await db.execute({
      sql: `INSERT INTO MeteredReservationReceipt(
              budgetId,reservationKey,operation,status,createdAt
            ) VALUES (?,?,?,?,?)`,
      args: ["budget-reserved", reservedKey, "detail", "reserved", "2026-07-18T20:00:01Z"],
    });
    await db.execute({
      sql: `UPDATE DonorOffer SET productUrl=? WHERE donorProductId=?`,
      args: ["https://www.walmart.com/ip/reserved-url-changed", "reserved"],
    });

    const reaped = await reapExpiredDonorHarvestForExecution(db, {
      now: "2026-07-18T20:00:02Z",
      retryDelayMs: 60_000,
    });
    assert.equal(reaped.scanned, 2);
    assert.equal(reaped.requeuedPreReservation, 1);
    assert.equal(reaped.terminalAmbiguous, 1);
    assert.equal((await getDonorHarvestState(db, safe.id))?.status, "retry_wait");
    const reservedState = await getDonorHarvestState(db, reserved.id);
    assert.equal(reservedState?.status, "error");
    assert.equal(reservedState?.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");

    // Close the reservation->callback race: a receipt that appears immediately
    // after the lease was safely released is detected before the next claim.
    const safeKey = meteredProviderReservationKey({
      provider: "unwrangle",
      operation: "detail",
      requestFingerprint: {
        platform: "walmart_detail",
        retailer: "walmart",
        url: "https://www.walmart.com/ip/safe",
      },
    });
    await db.execute({
      sql: `INSERT INTO MeteredReservationReceipt(
              budgetId,reservationKey,operation,status,createdAt
            ) VALUES (?,?,?,?,?)`,
      args: ["budget-safe", safeKey, "detail", "failed", "2026-07-18T20:00:02Z"],
    });
    const safeRetry = await getDonorHarvestState(db, safe.id);
    assert.ok(safeRetry);
    let calls = 0;
    const lateReceipt = await executeDonorHarvestCandidate(executionInput(
      db,
      safeRetry,
      async () => {
        calls++;
        throw new Error("must not replay a late receipt");
      },
    ));
    assert.equal(calls, 0);
    assert.equal(lateReceipt.disposition, "terminal");
    assert.equal(lateReceipt.state?.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
  } finally {
    await db.close();
  }
});
