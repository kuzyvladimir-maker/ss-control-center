import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as calibrationModule from "../oxylabs-walmart-product-calibration.ts";

const {
  OXYLABS_REALTIME_QUERIES_ENDPOINT,
  OXYLABS_WALMART_PRODUCT_CALIBRATION_PLAN_SCHEMA,
  OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES,
  buildOxylabsWalmartProductCalibrationPlan,
  executeOxylabsWalmartProductCalibration,
  readBoundedOxylabsResponseBody,
  verifyOxylabsWalmartProductCalibrationPlan,
  verifyOxylabsWalmartProductCalibrationReceipt,
  verifyOxylabsWalmartProductCalibrationReceiptAgainstRawResponse,
} = calibrationModule.default ?? calibrationModule;

const ITEM_ID = "123456789";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROBE = path.join(ROOT, "scripts", "probe-walmart-buyer-pdp.ts");

test("builds the exact deterministic one-call dry-run plan", () => {
  const first = buildOxylabsWalmartProductCalibrationPlan(ITEM_ID);
  const second = buildOxylabsWalmartProductCalibrationPlan(ITEM_ID);
  assert.deepEqual(first, second);
  assert.equal(first.schema_version, OXYLABS_WALMART_PRODUCT_CALIBRATION_PLAN_SCHEMA);
  assert.equal(first.request.endpoint, OXYLABS_REALTIME_QUERIES_ENDPOINT);
  assert.deepEqual(first.request.body, {
    source: "walmart_product",
    query: ITEM_ID,
    parse: true,
  });
  assert.equal(first.execution_contract.max_primary_calls, 1);
  assert.equal(first.execution_contract.owner_approval_required, true);
  assert.equal(first.execution_contract.global_metered_run_permit_required, true);
  assert.equal(first.execution_contract.max_attempts, 1);
  assert.equal(first.execution_contract.retries, 0);
  assert.equal(first.execution_contract.fallbacks, 0);
  assert.equal(first.execution_contract.health_probes, 0);
  assert.equal(first.execution_contract.response_parsing_performed, false);
  assert.deepEqual(verifyOxylabsWalmartProductCalibrationPlan(first), first);
});

test("rejects ambiguous item IDs and any re-sealed contract mutation", () => {
  for (const value of ["", "abc", "123-456", " 123 ", "1".repeat(21)]) {
    assert.throws(() => buildOxylabsWalmartProductCalibrationPlan(value), /item_id/);
  }
  const mutated = structuredClone(buildOxylabsWalmartProductCalibrationPlan(ITEM_ID));
  mutated.execution_contract.retries = 1;
  assert.throws(() => verifyOxylabsWalmartProductCalibrationPlan(mutated), /fixed one-call contract/);
});

test("executes one transport call and never persists credentials", async () => {
  const plan = buildOxylabsWalmartProductCalibrationPlan(ITEM_ID);
  let calls = 0;
  let observed;
  const execution = await executeOxylabsWalmartProductCalibration({
    plan,
    username: "secret-user",
    password: "secret-pass",
    now: (() => {
      const values = ["2026-07-18T20:00:00.000Z", "2026-07-18T20:00:01.000Z"];
      return () => values.shift();
    })(),
    transport: async (request) => {
      calls += 1;
      observed = request;
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Oxylabs-Job-Id": "job-123",
        },
        body: new TextEncoder().encode('{"results":[{"content":{"unknown":"fixture"}}]}'),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(observed.endpoint, OXYLABS_REALTIME_QUERIES_ENDPOINT);
  assert.equal(observed.body, JSON.stringify(plan.request.body));
  assert.match(observed.headers.authorization, /^Basic /);
  assert.equal(execution.receipt.execution.primary_calls, 1);
  assert.equal(execution.receipt.execution.response_parsing_performed, false);
  assert.deepEqual(execution.receipt.response.provider_request_ids, ["x-oxylabs-job-id:job-123"]);
  assert.equal(execution.receipt.response.raw_body_bytes, execution.raw_response_bytes.length);
  assert.deepEqual(verifyOxylabsWalmartProductCalibrationReceipt(execution.receipt), execution.receipt);
  assert.deepEqual(
    verifyOxylabsWalmartProductCalibrationReceiptAgainstRawResponse(
      execution.receipt,
      execution.raw_response_bytes,
    ),
    execution.receipt,
  );
  const serialized = JSON.stringify(execution.receipt);
  assert.equal(serialized.includes("secret-user"), false);
  assert.equal(serialized.includes("secret-pass"), false);
  assert.equal(serialized.includes(observed.headers.authorization), false);
});

test("a non-2xx response is still captured once as raw calibration evidence", async () => {
  let calls = 0;
  const execution = await executeOxylabsWalmartProductCalibration({
    plan: buildOxylabsWalmartProductCalibrationPlan(ITEM_ID),
    username: "user",
    password: "pass",
    now: (() => {
      const values = ["2026-07-18T20:00:00.000Z", "2026-07-18T20:00:00.001Z"];
      return () => values.shift();
    })(),
    transport: async () => {
      calls += 1;
      return {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "rate-1" },
        body: new TextEncoder().encode('{"error":"rate limited"}'),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(execution.receipt.response.http_status, 429);
  assert.equal(execution.receipt.execution.retries, 0);
});

test("missing credentials or transport failure never triggers an implicit retry", async () => {
  let calls = 0;
  const plan = buildOxylabsWalmartProductCalibrationPlan(ITEM_ID);
  await assert.rejects(
    executeOxylabsWalmartProductCalibration({
      plan,
      username: "",
      password: "pass",
      transport: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    }),
    /username is required/,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    executeOxylabsWalmartProductCalibration({
      plan,
      username: "user",
      password: "pass",
      transport: async () => {
        calls += 1;
        throw new Error("network down");
      },
    }),
    /network down/,
  );
  assert.equal(calls, 1);
});

test("bounded response reader rejects declared or streamed oversize bodies", async () => {
  const declared = new Response("x", {
    headers: { "content-length": String(OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES + 1) },
  });
  await assert.rejects(readBoundedOxylabsResponseBody(declared), /Content-Length exceeds/);

  const streamed = new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(readBoundedOxylabsResponseBody(streamed, 3), /exceeds the byte cap/);
});

test("receipt tampering is detected independently of provider status", async () => {
  const execution = await executeOxylabsWalmartProductCalibration({
    plan: buildOxylabsWalmartProductCalibrationPlan(ITEM_ID),
    username: "user",
    password: "pass",
    now: (() => {
      const values = ["2026-07-18T20:00:00.000Z", "2026-07-18T20:00:00.001Z"];
      return () => values.shift();
    })(),
    transport: async () => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode("raw"),
    }),
  });
  const tampered = structuredClone(execution.receipt);
  tampered.response.http_status = 201;
  assert.throws(() => verifyOxylabsWalmartProductCalibrationReceipt(tampered), /body SHA mismatch/);

  const wrongRaw = new TextEncoder().encode("other");
  assert.throws(
    () => verifyOxylabsWalmartProductCalibrationReceiptAgainstRawResponse(
      execution.receipt,
      wrongRaw,
    ),
    /byte length differs|SHA differs/,
  );
});

test("CLI is dry-run by default and rejects incomplete live acknowledgement", () => {
  const dry = spawnSync(
    process.execPath,
    ["--import", "tsx", PROBE, `--item-id=${ITEM_ID}`],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, OXYLABS_USERNAME: "must-not-be-read", OXYLABS_PASSWORD: "must-not-be-read" },
    },
  );
  assert.equal(dry.status, 0, dry.stderr);
  const output = JSON.parse(dry.stdout);
  assert.equal(output.mode, "DRY_RUN_NO_NETWORK");
  assert.equal(output.plan.item_id, ITEM_ID);
  assert.equal(dry.stdout.includes("must-not-be-read"), false);

  const blocked = spawnSync(
    process.execPath,
    ["--import", "tsx", PROBE, `--item-id=${ITEM_ID}`, "--run"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env } },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /requires --ack-paid-call=1 and --max-paid-calls=1/);
});
