import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseProductTruthControlEnvelope,
} from "../product-truth-control-plane";
import {
  prepareProductTruthWalmartDoctorAdmissions,
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
