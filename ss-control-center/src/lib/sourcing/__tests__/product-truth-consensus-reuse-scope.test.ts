import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  ProductTruthConsensusReuseScopeError,
  compileProductTruthConsensusReuseScope,
  renderProductTruthConsensusReuseScope,
} from "../product-truth-consensus-reuse-scope";
import type {
  ProductTruthRecipeRepairScope,
} from "../product-truth-recipe-repair-scope";

const ROOT = resolve(process.cwd(), "..");
const SSC = resolve(ROOT, "ss-control-center");
const PACKET = resolve(
  ROOT,
  "release-artifacts/product-truth-matcher-adjudication-2026-07-19",
);
const GENERATED_AT = "2026-07-29T23:26:31.000Z";

type Artifact = {
  json: string;
  sha256: string;
  value: unknown;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function artifact(path: string): Promise<Artifact> {
  const json = await readFile(path, "utf8");
  return {
    json,
    sha256: sha256(json),
    value: JSON.parse(json),
  };
}

async function inputs() {
  const [
    rawSource,
    corpus,
    acceptanceReviewA,
    acceptanceReviewB,
    blindTask,
    frozenReviewA,
    frozenReviewB,
    reconciliationMap,
    recipeRepairScope,
  ] = await Promise.all([
    artifact(resolve(SSC, "_gen_enriched_state.json")),
    artifact(resolve(
      PACKET,
      "assembled-v22-post-blind-consensus-final/corpus.json",
    )),
    artifact(resolve(
      PACKET,
      "assembled-v22-post-blind-consensus-final/review-a.json",
    )),
    artifact(resolve(
      PACKET,
      "assembled-v22-post-blind-consensus-final/review-b.json",
    )),
    artifact(resolve(PACKET, "prepared-v21-final/review-task-a.json")),
    artifact(resolve(
      PACKET,
      "reviews/codex-review-a/review-a-decision.json",
    )),
    artifact(resolve(
      PACKET,
      "reviews/codex-review-b/review-b-decision.json",
    )),
    artifact(resolve(
      PACKET,
      "reconciliation-v21-final/canonical-adjudication-map.json",
    )),
    artifact(resolve(
      SSC,
      "data/audits/product-truth-recipe-repair-scope/"
        + "20260729T231006Z-full-denominator-v2/recipe-repair-scope.json",
    )),
  ]);
  return {
    generatedAt: GENERATED_AT,
    rawSource: rawSource.value,
    rawSourceJson: rawSource.json,
    rawSourceSha256: rawSource.sha256,
    corpus: corpus.value,
    corpusJson: corpus.json,
    corpusSha256: corpus.sha256,
    acceptanceReviewA: acceptanceReviewA.value,
    acceptanceReviewAJson: acceptanceReviewA.json,
    acceptanceReviewASha256: acceptanceReviewA.sha256,
    acceptanceReviewB: acceptanceReviewB.value,
    acceptanceReviewBJson: acceptanceReviewB.json,
    acceptanceReviewBSha256: acceptanceReviewB.sha256,
    blindTask: blindTask.value,
    blindTaskJson: blindTask.json,
    blindTaskSha256: blindTask.sha256,
    frozenReviewA: frozenReviewA.value,
    frozenReviewAJson: frozenReviewA.json,
    frozenReviewASha256: frozenReviewA.sha256,
    frozenReviewB: frozenReviewB.value,
    frozenReviewBJson: frozenReviewB.json,
    frozenReviewBSha256: frozenReviewB.sha256,
    reconciliationMap: reconciliationMap.value,
    reconciliationMapJson: reconciliationMap.json,
    reconciliationMapSha256: reconciliationMap.sha256,
    recipeRepairScope:
      recipeRepairScope.value as ProductTruthRecipeRepairScope,
    recipeRepairScopeJson: recipeRepairScope.json,
    recipeRepairScopeSha256: recipeRepairScope.sha256,
  };
}

test("selects only current-version consensus reuse candidates", async () => {
  const report = compileProductTruthConsensusReuseScope(await inputs());
  assert.equal(report.counts.rawQuarantine, 386);
  assert.equal(report.counts.currentScopeMatches, 380);
  assert.equal(report.counts.currentRecipeMissing, 319);
  assert.equal(report.counts.resolvedSingleExact, 63);
  assert.equal(report.counts.exactCurrentTitlesAndQuantity, 58);
  assert.equal(report.counts.identityCoreCompatible, 56);
  assert.equal(report.counts.selected, 51);
  assert.equal(report.counts.directSingleVariant, 42);
  assert.equal(report.counts.fieldPartitionReconciliationRequired, 9);
  assert.equal(report.counts.selectedDonors, 32);
  assert.equal(report.counts.directDonors, 28);
  assert.equal(report.counts.reconciliationDonors, 4);
  assert.equal(
    new Set(report.candidates.map((candidate) => candidate.listingKey)).size,
    51,
  );
  assert.equal(
    new Set(
      report.candidates.map((candidate) =>
        candidate.immutableEvidence.sourceRowSha256),
    ).size,
    51,
  );
  assert.equal(
    sha256(renderProductTruthConsensusReuseScope(report)),
    "b536d131297609f66feeecaa10746e7d2eceed48a844fb8a1f5d6df319a6b412",
  );
});

test("fails closed when an immutable source byte changes", async () => {
  const input = await inputs();
  input.rawSourceJson = `${input.rawSourceJson}\n`;
  assert.throws(
    () => compileProductTruthConsensusReuseScope(input),
    (error: unknown) => {
      assert.ok(error instanceof ProductTruthConsensusReuseScopeError);
      assert.equal(error.code, "CONSENSUS_REUSE_SOURCE_HASH_MISMATCH");
      return true;
    },
  );
});

test("keeps one donor out of direct lane when variants conflict", async () => {
  const report = compileProductTruthConsensusReuseScope(await inputs());
  const group = report.reconciliationGroups.find(
    (candidate) =>
      candidate.donorProductId
        === "bd21db92-b685-4cd5-b822-9a1b16ab402e",
  );
  assert.ok(group);
  assert.deepEqual(group.listingKeys, [
    "walmart:1:RizwanX-314",
    "walmart:1:RizwanX-315",
  ]);
  assert.equal(group.proposedCanonicalVariantIds.length, 2);
  assert.ok(
    report.candidates
      .filter((candidate) => group.listingKeys.includes(candidate.listingKey))
      .every(
        (candidate) =>
          candidate.lane === "FIELD_PARTITION_RECONCILIATION_REQUIRED",
      ),
  );
});
