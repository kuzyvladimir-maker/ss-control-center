import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseProductTruthControlEnvelope,
} from "../product-truth-control-plane";
import {
  latestProductTruthControlRowsByRun,
  prepareProductTruthWalmartDoctorAdmissions,
  productTruthWalmartPreExecutionExpiryCode,
  productTruthWalmartStartedExecutionExpiryCode,
} from "../product-truth-web-control-admission";
import {
  buildProductTruthWalmartCollectionBatch,
} from "../product-truth-walmart-collection-contract";
import type {
  ProductTruthWebControlRuntimeActive,
} from "../product-truth-web-control-runtime";

const runtime: ProductTruthWebControlRuntimeActive = {
  schemaVersion: "product-truth-web-control-runtime/1.0.0",
  status: "ACTIVE",
  stage: "LOCAL_NO_SPEND",
  engine: {
    commandSchemaVersion: "product-truth-control-command/1.0.0",
    releaseId: "product-truth-web-control-test-r1",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    executableTreeSha256: "c".repeat(64),
  },
  target: {
    environment: "LOCAL",
    databaseTargetFingerprint: "d".repeat(64),
    manifestSha256: "e".repeat(64),
  },
  unwrangleReserveFloor: 100,
  workerTokenSha256: "f".repeat(64),
  claims: {
    commandAdmission: true,
    controlDatabaseWrites: true,
    workerClaims: true,
    processSpawnInWebRuntime: false,
    providerCallsInWebRuntime: false,
    marketplaceMutations: false,
    meteredExecutionAdmission: false,
  },
};

function batch() {
  return batchAt("2026-07-28T20:00:00.000Z");
}

function batchAt(requestedAt: string) {
  return buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-0001",
    requestedAt,
    prompt: "Create two exact Campbell soup listings",
    listingCount: 2,
    packCount: 3,
    unwrangleReserveFloor: 100,
    candidates: [
      {
        donorProductId: "donor-1",
        canonicalVariantId: "variant-1",
        title: "Campbell Soup One",
        query: "Campbell Soup One exact Walmart item",
        missingFields: ["FRESH_LOCAL_PRICE"],
      },
      {
        donorProductId: "donor-2",
        canonicalVariantId: "variant-2",
        title: "Campbell Soup Two",
        query: "Campbell Soup Two exact Walmart item",
        missingFields: ["FRESH_LOCAL_PRICE"],
      },
    ],
  });
}

test("retry in one release reuses logical commands despite fresh TTL timestamps", () => {
  const first = prepareProductTruthWalmartDoctorAdmissions({
    batch: batchAt("2026-07-28T20:00:00.000Z"),
    runtime,
  });
  const retry = prepareProductTruthWalmartDoctorAdmissions({
    batch: batchAt("2026-07-28T20:01:00.000Z"),
    runtime,
  });
  assert.deepEqual(
    retry.map((entry) => entry.commandId),
    first.map((entry) => entry.commandId),
  );
  assert.deepEqual(
    retry.map((entry) => entry.idempotencyKey),
    first.map((entry) => entry.idempotencyKey),
  );
  assert.notDeepEqual(
    retry.map((entry) => entry.requestSha256),
    first.map((entry) => entry.requestSha256),
  );
});

test("owner status shows only the latest immutable attempt per logical product", () => {
  const rows = [
    { runId: "batch-01", commandId: "old-01" },
    { runId: "batch-02", commandId: "old-02" },
    { runId: "batch-01", commandId: "new-01" },
    { runId: "batch-02", commandId: "new-02" },
  ];
  assert.deepEqual(latestProductTruthControlRowsByRun(rows), [
    { runId: "batch-01", commandId: "new-01" },
    { runId: "batch-02", commandId: "new-02" },
  ]);
  assert.throws(
    () => latestProductTruthControlRowsByRun([{ runId: null }]),
    /logical run binding/u,
  );
});

test("prepares deterministic independent DOCTOR admissions only", () => {
  const first = prepareProductTruthWalmartDoctorAdmissions({
    batch: batch(),
    runtime,
  });
  const second = prepareProductTruthWalmartDoctorAdmissions({
    batch: batch(),
    runtime,
  });
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map((entry) => entry.commandId)).size, 2);
  for (const admission of first) {
    const envelope = parseProductTruthControlEnvelope(admission.envelope);
    assert.equal(envelope.commandKind, "DOCTOR");
    assert.equal(envelope.gateClass, "READ_ONLY");
    assert.equal(envelope.authority.ownerKeyId, null);
    assert.equal(envelope.claims.noMarketplaceMutation, true);
    assert.deepEqual(
      admission.events.map((event) => event.eventType),
      ["REQUESTED", "ARTIFACTS_VALIDATED", "ADMITTED"],
    );
  }
});

test("admission implementation has no provider, process, shell, or Walmart writer surface", async () => {
  const sourceUrl = new URL(
    "../product-truth-web-control-admission.ts",
    import.meta.url,
  );
  const source = await readFile(sourceUrl, "utf8");
  assert.doesNotMatch(
    source,
    /child_process|spawn\(|exec\(|fetch\(|WalmartClient|MP_ITEM|SKU_TEMPLATE_MAP/u,
  );
  assert.doesNotMatch(
    source,
    /from "\.\/(?:donor-catalog|oxylabs-fetch|retail-fetch)"/u,
  );
  assert.match(
    source,
    /requestBytes:\s*Buffer\.from\(\s*renderProductTruthOperationalJson\(targetedRequest\)/u,
  );
});

test("expired pre-execution states stop looking like enrichment is still running", () => {
  const now = new Date("2026-08-01T18:30:00.000Z");
  assert.equal(productTruthWalmartPreExecutionExpiryCode({
    status: "CLAIMED",
    attempts: 0,
    executionStartedAt: null,
    workerLeaseExpiresAt: new Date("2026-08-01T18:29:59.000Z"),
    ownerAuthorizationExpiresAt: new Date("2026-08-01T18:45:00.000Z"),
    now,
  }), "WORKER_START_NOT_CONFIRMED_ZERO_ATTEMPT");
  assert.equal(productTruthWalmartPreExecutionExpiryCode({
    status: "ADMITTED",
    attempts: 0,
    executionStartedAt: null,
    workerLeaseExpiresAt: null,
    ownerAuthorizationExpiresAt: new Date("2026-08-01T18:29:59.000Z"),
    now,
  }), "OWNER_AUTHORIZATION_EXPIRED_BEFORE_EXECUTION");
  assert.equal(productTruthWalmartPreExecutionExpiryCode({
    status: "RUNNING",
    attempts: 1,
    executionStartedAt: new Date("2026-08-01T18:00:00.000Z"),
    workerLeaseExpiresAt: new Date("2026-08-01T18:45:00.000Z"),
    ownerAuthorizationExpiresAt: new Date("2026-08-01T18:45:00.000Z"),
    now,
  }), null);
});

test("a new engine release changes command identity but not batch identity", () => {
  // Commands are release-scoped audit records; the batch is the owner-facing
  // durable identity. During the 2026-08-01 incident every deploy hid the
  // in-flight batch because reads also filtered on the engine pins.
  const nextRelease: ProductTruthWebControlRuntimeActive = {
    ...runtime,
    engine: {
      ...runtime.engine,
      releaseId: "product-truth-web-control-test-r2",
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      executableTreeSha256: "3".repeat(64),
    },
  };
  const first = prepareProductTruthWalmartDoctorAdmissions({
    batch: batch(),
    runtime,
  });
  const redeployed = prepareProductTruthWalmartDoctorAdmissions({
    batch: batch(),
    runtime: nextRelease,
  });
  // Same logical run IDs (same batch) — status reads reduce to the newest
  // attempt per run, so the batch stays one batch across releases.
  assert.deepEqual(
    redeployed.map((entry) => entry.runId),
    first.map((entry) => entry.runId),
  );
  // New release admits its own immutable command rows for the audit trail.
  assert.notDeepEqual(
    redeployed.map((entry) => entry.commandId),
    first.map((entry) => entry.commandId),
  );
});

test("a second collection attempt gets its own batch identity", () => {
  const base = batch();
  const retryFirstAttempt = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-0001",
    requestedAt: "2026-07-28T21:00:00.000Z",
    prompt: "Create two exact Campbell soup listings",
    listingCount: 2,
    packCount: 3,
    unwrangleReserveFloor: 100,
    candidates: base.jobs.map((job) => ({
      donorProductId: job.target.donorProductId,
      canonicalVariantId: job.target.canonicalVariantId,
      title: job.target.title,
      query: job.target.query,
      missingFields: job.target.missingFields,
    })),
    attempt: 1,
  });
  const secondAttempt = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: "owner-0001",
    requestedAt: "2026-07-28T21:00:00.000Z",
    prompt: "Create two exact Campbell soup listings",
    listingCount: 2,
    packCount: 3,
    unwrangleReserveFloor: 100,
    candidates: base.jobs.map((job) => ({
      donorProductId: job.target.donorProductId,
      canonicalVariantId: job.target.canonicalVariantId,
      title: job.target.title,
      query: job.target.query,
      missingFields: job.target.missingFields,
    })),
    attempt: 2,
  });
  // Attempt 1 preserves the exact historical identity.
  assert.equal(retryFirstAttempt.batchId, base.batchId);
  // Attempt 2 is a new paid lifecycle: new batch, new run IDs, and therefore
  // fresh immutable budget rows — never a METERED_BUDGET_PERMIT_CONFLICT and
  // never inherited authority from the first attempt.
  assert.notEqual(secondAttempt.batchId, base.batchId);
  assert.ok(secondAttempt.jobs.every(
    (job, index) => job.runId !== base.jobs[index]!.runId,
  ));
});

test("started execution with a dead lease is terminal ambiguous, never live", () => {
  const now = new Date("2026-08-02T05:00:00.000Z");
  // Worker started paid execution, then its lease expired and no terminal
  // write ever landed (production commands ptc-b183b91c…, ptc-23f38f37…).
  assert.equal(
    productTruthWalmartStartedExecutionExpiryCode({
      status: "RUNNING",
      executionStartedAt: new Date("2026-08-02T01:25:31.636Z"),
      workerLeaseExpiresAt: new Date("2026-08-02T01:43:54.526Z"),
      now,
    }),
    "ENRICHMENT_WORKER_SIGNAL_LOST_AFTER_START",
  );
  // A live lease keeps the command presented as running.
  assert.equal(
    productTruthWalmartStartedExecutionExpiryCode({
      status: "RUNNING",
      executionStartedAt: new Date("2026-08-02T01:25:31.636Z"),
      workerLeaseExpiresAt: new Date("2026-08-02T05:30:00.000Z"),
      now,
    }),
    null,
  );
  // Execution that never started stays with the pre-execution disposition.
  assert.equal(
    productTruthWalmartStartedExecutionExpiryCode({
      status: "CLAIMED",
      executionStartedAt: null,
      workerLeaseExpiresAt: new Date("2026-08-02T01:43:54.526Z"),
      now,
    }),
    null,
  );
});
