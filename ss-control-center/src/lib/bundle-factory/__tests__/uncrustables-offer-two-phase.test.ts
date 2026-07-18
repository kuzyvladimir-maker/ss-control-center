// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-offer-two-phase.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  DEFAULT_OFFER_SETTLEMENT_POLICY,
  OFFER_ONLY_EXECUTION_PROFILE,
  assertOfferOnlyExecutionSelection,
  assertOfferSubmitOnlyMayStart,
  partitionOfferRolloutCandidates,
  resolveOfferSettlementPolicy,
  runReadOnlyOfferSettlement,
  type OfferExecutionSelectionLike,
  type OfferPlanLike,
  type OfferSettlementClassification,
  type PendingOfferSettlement,
} from "../repair/uncrustables-offer-two-phase";

const SHA = "a".repeat(64);
const PATH_SHA_A = "1".repeat(64);
const PATH_SHA_B = "2".repeat(64);

function plan(): OfferPlanLike {
  return {
    entries: [
      {
        sku: "AA-OFFER",
        actions: [
          { action_id: "AA-OFFER:offer", kind: "OFFER" },
          { action_id: "AA-OFFER:media", kind: "MEDIA" },
        ],
      },
      {
        sku: "BB-OFFER",
        actions: [{ action_id: "BB-OFFER:offer", kind: "OFFER" }],
      },
    ],
  };
}

function selection(
  actionIds = ["AA-OFFER:offer", "BB-OFFER:offer"],
): OfferExecutionSelectionLike {
  return {
    sha256: SHA,
    profile: OFFER_ONLY_EXECUTION_PROFILE,
    requested_action_kinds: ["OFFER"],
    selected_action_ids: actionIds,
    selected_actions: actionIds.length,
  };
}

function fakeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    sleep: async (milliseconds: number) => {
      value += milliseconds;
    },
  };
}

function pending(action: "AA" | "BB"): PendingOfferSettlement {
  return {
    action_id: `${action}-OFFER:offer`,
    sku: `${action}-OFFER`,
    submitted_event_id: `${action.toLowerCase()}-submission`,
    submitted_at: "2026-07-18T09:11:11.024Z",
  };
}

test("OFFER-only selection rejects hidden MEDIA and duplicate actions", () => {
  assert.deepEqual(
    assertOfferOnlyExecutionSelection({ plan: plan(), selection: selection() }),
    [
      { action_id: "AA-OFFER:offer", sku: "AA-OFFER" },
      { action_id: "BB-OFFER:offer", sku: "BB-OFFER" },
    ],
  );

  assert.throws(
    () =>
      assertOfferOnlyExecutionSelection({
        plan: plan(),
        selection: selection(["AA-OFFER:media"]),
      }),
    /has kind MEDIA/,
  );

  const duplicate = selection(["AA-OFFER:offer", "AA-OFFER:offer"]);
  assert.throws(
    () => assertOfferOnlyExecutionSelection({ plan: plan(), selection: duplicate }),
    /duplicate, or inconsistent action set/,
  );
});

test("submit-only fails before Amazon when any submission is pending or terminal", () => {
  assert.throws(
    () =>
      assertOfferSubmitOnlyMayStart({
        plan: plan(),
        selection: selection(),
        pendingActionIds: ["AC-OLD:offer"],
      }),
    /Run read-only settlement first; no PATCH is authorized/,
  );
  assert.throws(
    () =>
      assertOfferSubmitOnlyMayStart({
        plan: plan(),
        selection: selection(),
        pendingActionIds: [],
        terminalActionIds: ["AA-OFFER:offer"],
      }),
    /includes terminal action/,
  );
});

test("read-only settlement is exactly bound to the sealed OFFER selection", async () => {
  let observations = 0;
  await assert.rejects(
    runReadOnlyOfferSettlement({
      plan: plan(),
      selection: selection(),
      pending: [pending("AA")],
      policy: {
        horizonMs: 1_000,
        pollIntervalMs: 100,
        requestDelayMs: 1,
        stableReads: 2,
      },
      dependencies: {
        observe: async () => {
          observations++;
          return {
            classification: "DESIRED",
            path_state_sha256: PATH_SHA_A,
            verification: { ok: true },
          };
        },
        onVerified: async () => {},
      },
    }),
    /selection covers 2 action\(s\).*pending\/terminal sets account for 1/,
  );
  assert.equal(observations, 0);
});

test("six-hour policy supports more than the legacy 60-read ceiling", () => {
  const policy = resolveOfferSettlementPolicy(
    DEFAULT_OFFER_SETTLEMENT_POLICY,
  );
  assert.equal(policy.horizonMs, 6 * 60 * 60 * 1_000);
  assert.equal(policy.pollIntervalMs, 5 * 60 * 1_000);
  assert.equal(policy.plannedSweeps, 73);
  assert.equal(policy.maxReadsPerSubmission, 73);
  assert.ok(policy.maxReadsPerSubmission > 60);
});

test("rollout partition is exact, stratified, and excludes completed actions", () => {
  const candidates = [
    ["DONE", 76.99],
    ["CANARY-A", 76.99],
    ["CANARY-B", 297.99],
    ["A-1", 76.99],
    ["A-2", 76.99],
    ["B-1", 85.99],
    ["B-2", 85.99],
    ["C-1", 130.99],
    ["D-1", 252.99],
    ["E-1", 297.99],
  ].map(([sku, price]) => ({
    action_id: `${sku}:offer`,
    sku: String(sku),
    asin: `ASIN-${sku}`,
    consumer_price: Number(price),
    product_type: "GROCERY",
  }));
  const scopes = partitionOfferRolloutCandidates({
    candidates,
    completedActionIds: ["DONE:offer"],
    canaryActionIds: ["CANARY-A:offer", "CANARY-B:offer"],
    batchSizes: [4, 3],
  });

  assert.deepEqual(scopes.map((scope) => [scope.label, scope.candidates.length]), [
    ["CANARY_1", 1],
    ["CANARY_2", 1],
    ["BATCH_1", 4],
    ["BATCH_2", 3],
  ]);
  assert.deepEqual(
    scopes[2].candidates.map((candidate) => candidate.sku),
    ["A-1", "B-1", "C-1", "D-1"],
  );
  const all = scopes.flatMap((scope) =>
    scope.candidates.map((candidate) => candidate.action_id),
  );
  assert.equal(new Set(all).size, 9);
  assert.equal(all.includes("DONE:offer"), false);
  assert.throws(
    () =>
      partitionOfferRolloutCandidates({
        candidates,
        completedActionIds: ["DONE:offer"],
        canaryActionIds: ["CANARY-A:offer", "CANARY-B:offer"],
        batchSizes: [6],
      }),
    /cover 6, expected 7/,
  );
});

test("final 162-row plan partitions the exact 161 remaining OFFER actions", async () => {
  const raw = JSON.parse(
    await readFile(
      "data/repairs/generated/uncrustables-amazon-final-162-20260718-v8/" +
        "URP-20260718T083203612Z-8badb989fc9b.json",
      "utf8",
    ),
  ) as {
    sha256: string;
    entries: Array<{
      sku: string;
      asin: string;
      audited_product_type: string;
      actions: Array<{
        action_id: string;
        kind: string;
        desired: { value?: { consumer_price?: number } };
      }>;
    }>;
  };
  assert.equal(
    raw.sha256,
    "8badb989fc9bc5ee9c7ced63029ef9c8cea01d1b494c5766330709dfcf17c477",
  );
  assert.equal(raw.entries.length, 162);
  assert.equal(
    raw.entries.every(
      (entry) => entry.actions.filter((action) => action.kind === "OFFER").length === 1,
    ),
    true,
  );
  const candidates = raw.entries.map((entry) => {
    const offer = entry.actions.find((action) => action.kind === "OFFER");
    assert.ok(offer);
    assert.equal(typeof offer.desired.value?.consumer_price, "number");
    return {
      action_id: offer.action_id,
      sku: entry.sku,
      asin: entry.asin,
      consumer_price: offer.desired.value!.consumer_price!,
      product_type: entry.audited_product_type,
    };
  });
  const scopes = partitionOfferRolloutCandidates({
    candidates,
    completedActionIds: ["AC-AS4J-B64F:offer"],
    canaryActionIds: ["AG-ASKV-W9EN:offer", "AY-AS5F-JEY9:offer"],
    batchSizes: [8, 24, 40, 48, 39],
  });

  assert.deepEqual(scopes.map((scope) => scope.candidates.length), [
    1,
    1,
    8,
    24,
    40,
    48,
    39,
  ]);
  assert.deepEqual(
    scopes.slice(0, 2).map((scope) => scope.candidates[0].sku),
    ["AG-ASKV-W9EN", "AY-AS5F-JEY9"],
  );
  const selected = scopes.flatMap((scope) => scope.candidates);
  assert.equal(selected.length, 161);
  assert.equal(new Set(selected.map((row) => row.action_id)).size, 161);
  assert.equal(selected.some((row) => row.sku === "AC-AS4J-B64F"), false);
  assert.deepEqual(
    scopes[2].candidates.reduce<Record<string, number>>((counts, row) => {
      const key = row.consumer_price.toFixed(2);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    { "76.99": 2, "85.99": 2, "130.99": 2, "252.99": 1, "297.99": 1 },
  );
  const scopeDigest = createHash("sha256")
    .update(
      JSON.stringify(
        scopes.map((scope) => ({
          label: scope.label,
          action_ids: scope.candidates.map((row) => row.action_id),
        })),
      ),
    )
    .digest("hex");
  assert.equal(
    scopeDigest,
    "3f2419d1d7193331bada6c7dbcaa1a80e1a0b124da0b44f55fe38cbd80fad54a",
  );
});

test("round-robin settlement closes only stable DESIRED exact path state", async () => {
  const clock = fakeClock();
  const reads = new Map<string, number>();
  const order: string[] = [];
  const verified: string[] = [];
  const results = await runReadOnlyOfferSettlement({
    plan: plan(),
    selection: selection(),
    pending: [pending("AA"), pending("BB")],
    policy: {
      horizonMs: 20_000,
      pollIntervalMs: 1_000,
      requestDelayMs: 10,
      stableReads: 3,
    },
    dependencies: {
      now: clock.now,
      sleep: clock.sleep,
      observe: async (item) => {
        order.push(item.action_id);
        const count = (reads.get(item.action_id) ?? 0) + 1;
        reads.set(item.action_id, count);
        const classification: OfferSettlementClassification =
          item.action_id.startsWith("AA") && count <= 5
            ? "NON_DESIRED"
            : "DESIRED";
        return {
          classification,
          path_state_sha256:
            classification === "DESIRED" ? PATH_SHA_B : PATH_SHA_A,
          verification: { ok: classification === "DESIRED" },
        };
      },
      onVerified: async (item) => {
        verified.push(item.action_id);
      },
      onObservation: async (item, observation) => {
        assert.equal(Object.isFrozen(item), true);
        assert.equal(Object.isFrozen(observation), true);
        assert.equal(Object.isFrozen(observation.verification), true);
        assert.equal(
          Reflect.set(
            observation as unknown as Record<string, unknown>,
            "classification",
            "NON_DESIRED",
          ),
          false,
        );
      },
    },
  });

  assert.deepEqual(verified, ["BB-OFFER:offer", "AA-OFFER:offer"]);
  assert.deepEqual(
    results.map((result) => [result.action_id, result.disposition, result.reads]),
    [
      ["AA-OFFER:offer", "VERIFIED", 8],
      ["BB-OFFER:offer", "VERIFIED", 3],
    ],
  );
  assert.deepEqual(order.slice(0, 6), [
    "AA-OFFER:offer",
    "BB-OFFER:offer",
    "AA-OFFER:offer",
    "BB-OFFER:offer",
    "AA-OFFER:offer",
    "BB-OFFER:offer",
  ]);
});

test("stable NON_DESIRED never closes and remains pending through horizon", async () => {
  const clock = fakeClock();
  let verified = 0;
  const pendingMarkers: string[] = [];
  const [result] = await runReadOnlyOfferSettlement({
    plan: plan(),
    selection: selection(["AA-OFFER:offer"]),
    pending: [pending("AA")],
    policy: {
      horizonMs: 3_000,
      pollIntervalMs: 1_000,
      requestDelayMs: 1,
      stableReads: 2,
    },
    dependencies: {
      now: clock.now,
      sleep: clock.sleep,
      observe: async () => ({
        classification: "NON_DESIRED",
        path_state_sha256: PATH_SHA_A,
        verification: { ok: false },
      }),
      onVerified: async () => {
        verified++;
      },
      onPending: async (_item, outcome) => {
        pendingMarkers.push(outcome.disposition);
      },
    },
  });

  assert.equal(verified, 0);
  assert.equal(result.disposition, "PENDING_HORIZON");
  assert.equal(result.last_classification, "NON_DESIRED");
  assert.equal(result.consecutive_identical_reads, 4);
  assert.deepEqual(pendingMarkers, ["PENDING_HORIZON"]);
});

test("digest changes and read errors reset the stable-DESIRED counter", async () => {
  const clock = fakeClock();
  let read = 0;
  let verifiedProgress = 0;
  const [result] = await runReadOnlyOfferSettlement({
    plan: plan(),
    selection: selection(["AA-OFFER:offer"]),
    pending: [pending("AA")],
    policy: {
      horizonMs: 10_000,
      pollIntervalMs: 1_000,
      requestDelayMs: 1,
      stableReads: 3,
    },
    dependencies: {
      now: clock.now,
      sleep: clock.sleep,
      observe: async () => {
        read++;
        if (read === 2) throw new Error("transient GET failure");
        return {
          classification: "DESIRED",
          path_state_sha256: read < 4 ? PATH_SHA_A : PATH_SHA_B,
          verification: { ok: true },
        };
      },
      onVerified: async (_item, _observation, progress) => {
        verifiedProgress = progress.consecutive_identical_reads;
      },
    },
  });

  assert.equal(result.disposition, "VERIFIED");
  assert.equal(result.read_errors, 1);
  assert.equal(result.reads, 6);
  assert.equal(verifiedProgress, 3);
});

test("explicit read cap leaves submission open for a later recovery run", async () => {
  const clock = fakeClock();
  const [result] = await runReadOnlyOfferSettlement({
    plan: plan(),
    selection: selection(["AA-OFFER:offer"]),
    pending: [pending("AA")],
    policy: {
      horizonMs: 10_000,
      pollIntervalMs: 1_000,
      requestDelayMs: 1,
      stableReads: 2,
      maxReadsPerSubmission: 3,
    },
    dependencies: {
      now: clock.now,
      sleep: clock.sleep,
      observe: async () => ({
        classification: "BEFORE",
        path_state_sha256: PATH_SHA_A,
        verification: { ok: false },
      }),
      onVerified: async () => {
        throw new Error("BEFORE must never close a pending submission");
      },
    },
  });

  assert.equal(result.disposition, "PENDING_READ_LIMIT");
  assert.equal(result.reads, 3);
  assert.equal(result.last_classification, "BEFORE");
});

test("a hung observation is aborted and cannot overrun the scheduler indefinitely", async () => {
  const startedAt = Date.now();
  const [result] = await runReadOnlyOfferSettlement({
    plan: plan(),
    selection: selection(["AA-OFFER:offer"]),
    pending: [pending("AA")],
    policy: {
      horizonMs: 100,
      pollIntervalMs: 10,
      requestDelayMs: 1,
      stableReads: 2,
      observationTimeoutMs: 5,
      maxReadsPerSubmission: 3,
    },
    dependencies: {
      observe: async (_item, _progress, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted GET")),
            { once: true },
          );
        }),
      onVerified: async () => {
        throw new Error("a timed-out observation must never verify");
      },
    },
  });

  assert.equal(result.disposition, "PENDING_READ_LIMIT");
  assert.equal(result.reads, 3);
  assert.equal(result.read_errors, 3);
  assert.ok(Date.now() - startedAt < 500);
});
