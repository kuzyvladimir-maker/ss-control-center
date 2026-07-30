import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  ProductTruthConsensusReuseResolutionError,
  reconcileProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseResolution,
} from "../product-truth-consensus-reuse-resolution";
import {
  buildProductTruthConsensusReuseWaves,
  type ProductTruthConsensusReuseDonorPreflightState,
} from "../product-truth-consensus-reuse-preflight";
import type {
  ProductTruthConsensusReuseCandidate,
  ProductTruthConsensusReuseScope,
} from "../product-truth-consensus-reuse-scope";

const ROOT = resolve(process.cwd(), "..");
const SSC = resolve(ROOT, "ss-control-center");
const BASE_SCOPE = resolve(
  SSC,
  "data/audits/product-truth-consensus-reuse/"
    + "20260729T232631Z-v4/consensus-reuse-scope.json",
);
const SNAPSHOT = resolve(
  SSC,
  "data/audits/product-truth-legacy-bridge/"
    + "20260729T151401Z-post-publix-url-size-v70-audit/"
    + "source-snapshot.json",
);
const RESOLUTION = resolve(
  ROOT,
  "release-artifacts/product-truth-consensus-reuse-resolution-2026-07-30/"
    + "resolution.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function inputs() {
  const [baseScopeJson, resolutionJson, snapshotJson] = await Promise.all([
    readFile(BASE_SCOPE, "utf8"),
    readFile(RESOLUTION, "utf8"),
    readFile(SNAPSHOT, "utf8"),
  ]);
  return {
    generatedAt: "2026-07-30T00:31:00.000Z",
    baseScope:
      JSON.parse(baseScopeJson) as ProductTruthConsensusReuseScope,
    baseScopeJson,
    baseScopeSha256: sha256(baseScopeJson),
    resolution:
      JSON.parse(resolutionJson) as ProductTruthConsensusReuseResolution,
    resolutionJson,
    resolutionSha256: sha256(resolutionJson),
    canonicalBindingSnapshot: JSON.parse(snapshotJson) as unknown,
    canonicalBindingSnapshotJson: snapshotJson,
    canonicalBindingSnapshotSha256: sha256(snapshotJson),
  };
}

test("resolves all field partitions and exact binding collision", async () => {
  const result = reconcileProductTruthConsensusReuseScope(await inputs());
  assert.equal(result.counts.selected, 51);
  assert.equal(result.counts.directSingleVariant, 51);
  assert.equal(result.counts.fieldPartitionReconciliationRequired, 0);
  assert.equal(result.counts.directDonors, 32);
  assert.equal(result.counts.reconciliationDonors, 0);
  assert.equal(result.reconciliationGroups.length, 0);
  assert.equal(result.resolvedReconciliationGroups?.length, 5);
  assert.ok(
    result.candidates.every(
      (candidate) => candidate.lane === "DIRECT_SINGLE_VARIANT",
    ),
  );
  for (
    const candidates of Map.groupBy(
      result.candidates,
      (candidate) => candidate.donorProductId,
    ).values()
  ) {
    assert.equal(
      new Set(
        candidates.map(
          (candidate) => candidate.proposedCanonicalVariant.id,
        ),
      ).size,
      1,
    );
  }
  const collision = result.candidates.filter(
    (candidate) =>
      candidate.donorProductId
        === "0ee386db-cf57-48c0-aecf-7364c0dbbce2",
  );
  assert.equal(collision.length, 2);
  assert.ok(
    collision.every(
      (candidate) =>
        candidate.proposedCanonicalVariant.id
          === "cpv1:66a15f356a99a30d94d507b6fb1f1cdf6d158694df277393dba886158ea018c4",
    ),
  );
});

test("fails closed when resolution bytes drift", async () => {
  const input = await inputs();
  input.resolutionJson = `${input.resolutionJson}\n`;
  assert.throws(
    () => reconcileProductTruthConsensusReuseScope(input),
    (error: unknown) => {
      assert.ok(error instanceof ProductTruthConsensusReuseResolutionError);
      assert.equal(
        error.code,
        "CONSENSUS_REUSE_RESOLUTION_SOURCE_HASH_MISMATCH",
      );
      return true;
    },
  );
});

test("fails closed when chosen partition variant is not group evidence", async () => {
  const input = await inputs();
  input.resolution.fieldPartitionResolutions[0]!.chosenCanonicalVariantId =
    "cpv1:0000000000000000000000000000000000000000000000000000000000000000";
  input.resolutionJson = JSON.stringify(input.resolution);
  input.resolutionSha256 = sha256(input.resolutionJson);
  assert.throws(
    () => reconcileProductTruthConsensusReuseScope(input),
    (error: unknown) => {
      assert.ok(error instanceof ProductTruthConsensusReuseResolutionError);
      assert.equal(
        error.code,
        "CONSENSUS_REUSE_RESOLUTION_REVIEW_INVALID",
      );
      return true;
    },
  );
});

test("row budget includes an exact existing canonical variant projection", () => {
  const donorProductId = "donor-existing";
  const listingKey = "walmart:1:existing-variant";
  const candidate = {
    donorProductId,
    listingKey,
  } as ProductTruthConsensusReuseCandidate;
  const donorState: ProductTruthConsensusReuseDonorPreflightState = {
    donorProductId,
    listingKeys: [listingKey],
    proposedCanonicalVariantId:
      "cpv1:0000000000000000000000000000000000000000000000000000000000000000",
    variantState: "REUSE",
    decisionState: "REUSE",
    existingDecision: {
      id: "decision-existing",
      decidedAt: "2026-07-29T12:09:50.985Z",
    },
    donorTransitionRequired: false,
    sourceIdentity: {
      identityKey: "existing",
      identityStatus: "exact_confirmed",
      brand: "brand",
      productLine: "line",
      flavor: null,
      containerType: null,
      size: "1 oz",
    },
    sourceIdentitySha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    blockers: [],
  };
  const waves = buildProductTruthConsensusReuseWaves({
    candidates: [candidate],
    donorStates: [donorState],
  });
  assert.equal(waves.length, 1);
  assert.equal(waves[0]!.canonicalVariantCreates, 0);
  assert.equal(waves[0]!.canonicalVariantReuses, 1);
  assert.equal(waves[0]!.decisionCreates, 0);
  assert.equal(waves[0]!.decisionReuses, 1);
  assert.equal(waves[0]!.maximumRows, 7);
});
