import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProductTruthHeartbeatRetryPolicy,
  ProductTruthWorkerLease,
  ProductTruthWorkerLeaseExpiredError,
  productTruthControlApiFailureDisposition,
  productTruthHeartbeatFailureRequiresTermination,
  retryProductTruthLeaseOperation,
  terminateProductTruthWorkerProcessTree,
} from "../product-truth-worker-lease";

test("lease accepts canonical timestamps, idempotent refresh and no regression", () => {
  assert.throws(
    () => new ProductTruthWorkerLease("2026-07-29 20:30:00Z"),
    /timestamp is not canonical/u,
  );
  const lease = new ProductTruthWorkerLease("2026-07-29T20:30:00.000Z");
  assert.equal(lease.expiresAt, "2026-07-29T20:30:00.000Z");
  lease.refresh("2026-07-29T20:30:00.000Z");
  lease.refresh("2026-07-29T20:31:00.000Z");
  assert.equal(lease.expiresAt, "2026-07-29T20:31:00.000Z");
  assert.throws(
    () => lease.refresh("2026-07-29T20:30:59.999Z"),
    /regressed/u,
  );
});

test("control conflicts distinguish transient storage errors from authority loss", () => {
  assert.deepEqual(
    productTruthControlApiFailureDisposition({
      status: 409,
      code: "P2034",
    }),
    { retryable: true, authorityRejected: false },
  );
  assert.deepEqual(
    productTruthControlApiFailureDisposition({
      status: 409,
      code: "STANDING_WAVE_WEB_REQUEST_FAILED",
    }),
    { retryable: true, authorityRejected: false },
  );
  assert.deepEqual(
    productTruthControlApiFailureDisposition({
      status: 409,
      code: "STANDING_WAVE_WEB_LEASE_INVALID",
    }),
    { retryable: false, authorityRejected: true },
  );
  assert.deepEqual(
    productTruthControlApiFailureDisposition({
      status: 409,
      code: "STANDING_WAVE_WEB_RESULT_MISMATCH",
    }),
    { retryable: false, authorityRejected: false },
  );
  assert.deepEqual(
    productTruthControlApiFailureDisposition({
      status: 401,
      code: null,
    }),
    { retryable: false, authorityRejected: false },
  );
});

test("heartbeat confirms an authority rejection once before terminating", () => {
  const policy = new ProductTruthHeartbeatRetryPolicy();
  assert.equal(
    policy.shouldRetry({ retryable: false, authorityRejected: true }),
    true,
  );
  assert.equal(
    policy.shouldRetry({ retryable: false, authorityRejected: true }),
    false,
  );
  assert.equal(
    policy.shouldRetry({ retryable: true, authorityRejected: false }),
    true,
  );
  assert.equal(
    policy.shouldRetry({ retryable: false, authorityRejected: false }),
    false,
  );
});

test("one transient control failure retries without surrendering the lease", async () => {
  let now = Date.parse("2026-07-29T20:20:00.000Z");
  const lease = new ProductTruthWorkerLease("2026-07-29T20:35:00.000Z");
  let attempts = 0;
  const value = await retryProductTruthLeaseOperation({
    lease,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    shouldRetry: () => true,
    operation: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary timeout");
      return "renewed";
    },
  });
  assert.equal(value, "renewed");
  assert.equal(attempts, 2);
  assert.equal(
    productTruthHeartbeatFailureRequiresTermination({
      lease,
      retryable: true,
      nowMs: now,
    }),
    false,
  );
  assert.equal(
    productTruthHeartbeatFailureRequiresTermination({
      lease,
      retryable: false,
      nowMs: now,
    }),
    true,
  );
});

test("lease retry fails closed before authority expires", async () => {
  let now = Date.parse("2026-07-29T20:20:00.000Z");
  const lease = new ProductTruthWorkerLease("2026-07-29T20:20:06.000Z");
  let attempts = 0;
  await assert.rejects(
    retryProductTruthLeaseOperation({
      lease,
      now: () => now,
      retryDelayMs: 2_000,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      shouldRetry: () => true,
      operation: async () => {
        attempts += 1;
        throw new Error("still unavailable");
      },
    }),
    ProductTruthWorkerLeaseExpiredError,
  );
  assert.equal(attempts, 1);
  assert.equal(lease.canContinue(now), false);
  assert.equal(
    productTruthHeartbeatFailureRequiresTermination({
      lease,
      retryable: true,
      nowMs: now,
    }),
    true,
  );
});

test("termination addresses the whole detached process group", () => {
  const processSignals: Array<[number, NodeJS.Signals]> = [];
  const childSignals: NodeJS.Signals[] = [];
  assert.equal(
    terminateProductTruthWorkerProcessTree({
      pid: 4321,
      platform: "darwin",
      killProcess: (pid, signal) => {
        processSignals.push([pid, signal]);
        return true;
      },
      killChild: (signal) => {
        childSignals.push(signal);
        return true;
      },
    }),
    "PROCESS_GROUP",
  );
  assert.deepEqual(processSignals, [[-4321, "SIGTERM"]]);
  assert.deepEqual(childSignals, []);
});
