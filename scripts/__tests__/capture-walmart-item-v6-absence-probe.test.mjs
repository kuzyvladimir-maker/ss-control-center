import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WALMART_ITEM_V6_ABSENCE_PROBE_CONFIRMATION,
  runWalmartItemV6AbsenceProbeCli,
} from "../capture-walmart-item-v6-absence-probe.mjs";
import {
  computeWalmartSellerAccountFingerprint,
} from "../../src/lib/walmart/item-report-capture-session.ts";
import {
  canonicalWalmartItemReportJson,
} from "../../src/lib/walmart/item-report-published-source.ts";
import {
  WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES,
  verifyWalmartItemV6AbsenceProbeEvidenceFamily,
} from "../../src/lib/walmart/item-report-reissue-absence-probe-evidence.ts";

const CLIENT_ID = "absence-probe-test-client";
const SELLER_ID = "10001624309";
const EXPECTED_FINGERPRINT =
  "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127";

function credentials() {
  // The production account fingerprint is pinned. Tests inject the exact
  // client ID preimage only through a fingerprint-compatible dependency shim.
  return {
    client_id: CLIENT_ID,
    client_secret: "absence-probe-test-secret",
    seller_id: SELLER_ID,
  };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-22T15:00:00.000Z") + tick++ * 1_000);
}

function uuids() {
  let tick = 0;
  return () => `30000000-0000-4000-8000-${String(++tick).padStart(12, "0")}`;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "walmart-v6-probe-")));
  await chmod(root, 0o700);
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, out: path.join(root, "probe-test") };
}

function json(value) {
  return canonicalWalmartItemReportJson(value);
}

function fetchFor(responseValue, calls) {
  return async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/v3/token")) {
      return new Response(json({ access_token: "absence-probe-private-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(json(responseValue), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "walmart-probe-request-id",
      },
    });
  };
}

function productionFingerprintCredentials() {
  const input = credentials();
  const actual = computeWalmartSellerAccountFingerprint({
    store_index: 1,
    client_id: input.client_id,
    seller_id: input.seller_id,
  });
  assert.notEqual(actual, EXPECTED_FINGERPRINT);
  return {
    ...input,
    // The script accepts an injected fingerprint derivation below; real CLI
    // always derives it from production credentials.
  };
}

function injected(fx, fetchImpl, overrides = {}) {
  return {
    allowed_output_root: fx.root,
    credentials: productionFingerprintCredentials(),
    fetch_impl: fetchImpl,
    now: clock(),
    random_uuid: uuids(),
    expected_account_fingerprint_for_test: computeWalmartSellerAccountFingerprint({
      store_index: 1,
      client_id: CLIENT_ID,
      seller_id: SELLER_ID,
    }),
    ...overrides,
  };
}

function executeArgs(out) {
  return [
    "execute",
    "--store-index=1",
    `--out=${out}`,
    `--confirm=${WALMART_ITEM_V6_ABSENCE_PROBE_CONFIRMATION}`,
  ];
}

test("plan performs zero network calls and zero filesystem writes", async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  const result = await runWalmartItemV6AbsenceProbeCli([
    "plan",
    "--store-index=1",
    `--out=${fx.out}`,
  ], {
    allowed_output_root: fx.root,
    fetch_impl: async () => { calls += 1; throw new Error("must not run"); },
  });
  assert.equal(result.mode, "PLAN");
  assert.equal(result.network_calls, 0);
  assert.equal(result.filesystem_writes, 0);
  assert.equal(result.report_create_posts, 0);
  assert.equal(calls, 0);
  await assert.rejects(stat(fx.out), /ENOENT/);
});

test("one successful exact-zero probe uses OAuth once and GET once", async (t) => {
  const fx = await fixture(t);
  const calls = [];
  const result = await runWalmartItemV6AbsenceProbeCli(
    executeArgs(fx.out),
    injected(fx, fetchFor({
      page: 1,
      totalCount: 0,
      limit: 0,
      requests: [],
    }, calls)),
  );
  assert.equal(result.outcome, "ABSENCE_ONLY");
  assert.equal(result.absence_proven_for_exact_query, true);
  assert.equal(result.network_calls, 2);
  assert.equal(result.report_create_posts, 0);
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.method]), [
    ["/v3/token", "POST"],
    ["/v3/reports/reportRequests", "GET"],
  ]);
  const query = Object.fromEntries(new URL(calls[1].url).searchParams);
  assert.deepEqual(query, {
    reportType: "ITEM",
    reportVersion: "v6",
    src: "API",
    requestSubmissionStartDate: "2026-07-19T03:55:00Z",
    requestSubmissionEndDate: "2026-07-19T04:00:00Z",
  });
  const names = [
    "00-probe-authority.json",
    "10-get-reserved.json",
    "20-response-raw.bytes",
    "21-response-http.json",
    "22-exchange-seal.json",
    "30-result.json",
  ];
  for (const name of names) {
    const info = await stat(path.join(fx.out, name));
    assert.equal(info.mode & 0o777, 0o400);
  }
  const resultBytes = await readFile(path.join(fx.out, "30-result.json"));
  assert.equal(resultBytes.toString("utf8"), canonicalWalmartItemReportJson(JSON.parse(resultBytes)));
  const raw = await readFile(path.join(fx.out, "20-response-raw.bytes"));
  assert.equal(createHash("sha256").update(raw).digest("hex").length, 64);
  const verified = await runWalmartItemV6AbsenceProbeCli([
    "verify",
    `--out=${fx.out}`,
  ], {
    allowed_output_root: fx.root,
    expected_account_fingerprint_for_test: computeWalmartSellerAccountFingerprint({
      store_index: 1,
      client_id: CLIENT_ID,
      seller_id: SELLER_ID,
    }),
  });
  assert.equal(verified.mode, "VERIFIED");
  assert.equal(verified.exact_query_absence_verified, true);
  assert.equal(verified.network_calls, 0);
  const family = {};
  for (const name of WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES) {
    family[name] = await readFile(path.join(fx.out, name));
  }
  const byteVerified = verifyWalmartItemV6AbsenceProbeEvidenceFamily({
    artifacts: family,
    expected_probe_id: path.basename(fx.out),
    expected_account_fingerprint_for_test: computeWalmartSellerAccountFingerprint({
      store_index: 1,
      client_id: CLIENT_ID,
      seller_id: SELLER_ID,
    }),
  });
  assert.equal(byteVerified.exact_query_absence_verified, true);
  assert.equal(byteVerified.evidence_family_sha256, result.evidence_family_sha256);
});

test("a visible candidate is captured and forces stop without another call", async (t) => {
  const fx = await fixture(t);
  const calls = [];
  const result = await runWalmartItemV6AbsenceProbeCli(
    executeArgs(fx.out),
    injected(fx, fetchFor({
      page: 1,
      totalCount: 1,
      limit: 10,
      requests: [{ requestId: "candidate-request-id" }],
    }, calls)),
  );
  assert.equal(result.outcome, "CANDIDATES_FOUND");
  assert.equal(result.stop_required, true);
  assert.equal(result.absence_proven_for_exact_query, false);
  assert.equal(calls.length, 2);
});

test("an ambiguous network outcome is retained and cannot retry the directory", async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.endsWith("/v3/token")) {
      return new Response(json({ access_token: "private-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("simulated uncertain transport");
  };
  const deps = injected(fx, fetchImpl);
  await assert.rejects(
    runWalmartItemV6AbsenceProbeCli(executeArgs(fx.out), deps),
    (error) => error?.code === "NETWORK_FAILURE",
  );
  assert.equal(calls, 2);
  assert.equal((await stat(path.join(fx.out, "19-terminal-failure.json"))).mode & 0o777, 0o400);
  await assert.rejects(
    runWalmartItemV6AbsenceProbeCli(executeArgs(fx.out), deps),
    (error) => error?.code === "OUTPUT_EXISTS",
  );
  assert.equal(calls, 2);
});

test("wrong confirmation and wrong account fail before filesystem or network", async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  await assert.rejects(
    runWalmartItemV6AbsenceProbeCli([
      "execute",
      "--store-index=1",
      `--out=${fx.out}`,
      "--confirm=WRONG",
    ], { allowed_output_root: fx.root }),
    (error) => error?.code === "CONFIRMATION_MISMATCH",
  );
  await assert.rejects(
    runWalmartItemV6AbsenceProbeCli(executeArgs(fx.out), {
      allowed_output_root: fx.root,
      credentials: {
        client_id: "wrong-client",
        client_secret: "wrong-secret",
        seller_id: "wrong-seller",
      },
      fetch_impl: async () => { calls += 1; throw new Error("must not run"); },
    }),
    (error) => error?.code === "ACCOUNT_SCOPE_MISMATCH",
  );
  assert.equal(calls, 0);
  await assert.rejects(stat(fx.out), /ENOENT/);
});
