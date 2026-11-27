import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeUnavailableRates,
  fetchLiveRatesWithRetry,
} from "../rate-requote-retry";

const rate = { name: "ups-ground" };

test("accepts the first non-empty pool without sleeping", async () => {
  const result = await fetchLiveRatesWithRetry<typeof rate>(
    async () => ({ available: [rate] }),
    { sleep: async () => assert.fail("a non-empty pool should not sleep") },
  );

  assert.deepEqual(result, { rates: [rate], attempts: 1, emptyDiag: null });
});

test("retries empty pools with the default delays, then accepts the hit", async () => {
  const events: string[] = [];
  let calls = 0;
  const result = await fetchLiveRatesWithRetry(
    async () => {
      events.push("fetch");
      calls++;
      return { available: calls === 3 ? [rate] : [] };
    },
    { sleep: async (ms) => { events.push(`sleep ${ms}`); } },
  );

  assert.deepEqual(events, ["fetch", "sleep 600", "fetch", "sleep 1400", "fetch"]);
  assert.deepEqual(result, { rates: [rate], attempts: 3, emptyDiag: null });
});

test("reports the final empty pool's unavailable reasons and errors", async () => {
  const result = await fetchLiveRatesWithRetry(
    async () => ({
      available: [],
      unavailable: [
        { reason: "Carrier declined" },
        { message: "No pickup available" },
        { message: "Third message omitted" },
      ],
      errors: { base: ["Request pending"] },
      error_messages: ["Rate engine busy"],
    }),
    { sleep: async () => {} },
  );

  assert.deepEqual(result, {
    rates: [],
    attempts: 3,
    emptyDiag: "attempts=3, unavailableCount=3 (Carrier declined; No pickup available), " +
      "errors=Request pending, error_messages=Rate engine busy",
  });
});

test("handles null and undefined responses with a custom retry schedule", async () => {
  const responses = [null, undefined];
  const sleeps: number[] = [];
  const result = await fetchLiveRatesWithRetry(async () => responses.shift(), {
    retryDelaysMs: [500],
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(sleeps, [500]);
  assert.deepEqual(result, { rates: [], attempts: 2, emptyDiag: "attempts=2" });
});

test("propagates a thrown HTTP error without retrying it", async () => {
  const error = new Error("Veeqo API error 403");
  await assert.rejects(
    fetchLiveRatesWithRetry(
      async () => { throw error; },
      { sleep: async () => assert.fail("an HTTP error should not sleep") },
    ),
    (thrown) => thrown === error,
  );
});

test("describeUnavailableRates summarizes carrier rejection reasons and fallback keys", () => {
  assert.equal(
    describeUnavailableRates({
      available: [],
      unavailable: [
        { title: "UPS Ground", reason: "Weight must be > 0" },
        { service_name: "FedEx 2Day", error_messages: ["Invalid postal code"] },
      ],
    }),
    "unavail=2 (UPS Ground: Weight must be > 0; FedEx 2Day: Invalid postal code)",
  );
  assert.equal(
    describeUnavailableRates({ available: [], status: "empty" }),
    "keys=[available,status]",
  );
  assert.equal(describeUnavailableRates(null), "emptyResponse");
});
