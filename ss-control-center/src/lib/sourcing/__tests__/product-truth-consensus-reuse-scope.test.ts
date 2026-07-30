import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  ProductTruthConsensusReuseScopeError,
  compileProductTruthConsensusReuseScope,
  renderProductTruthConsensusReuseScope,
} from "../product-truth-consensus-reuse-scope";
import {
  makeConsensusReuseEvidenceFixture,
} from "./product-truth-consensus-reuse-fixture";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("selects only current-version consensus reuse candidates", () => {
  const report = compileProductTruthConsensusReuseScope(
    makeConsensusReuseEvidenceFixture(),
  );
  assert.equal(report.counts.rawQuarantine, 386);
  assert.equal(report.counts.currentScopeMatches, 1);
  assert.equal(report.counts.currentRecipeMissing, 1);
  assert.equal(report.counts.resolvedSingleExact, 1);
  assert.equal(report.counts.exactCurrentTitlesAndQuantity, 1);
  assert.equal(report.counts.identityCoreCompatible, 1);
  assert.equal(report.counts.selected, 1);
  assert.equal(report.counts.directSingleVariant, 1);
  assert.equal(report.counts.fieldPartitionReconciliationRequired, 0);
  assert.equal(report.counts.selectedDonors, 1);
  assert.equal(report.counts.directDonors, 1);
  assert.equal(report.counts.reconciliationDonors, 0);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.lane, "DIRECT_SINGLE_VARIANT");
  assert.match(
    sha256(renderProductTruthConsensusReuseScope(report)),
    /^[a-f0-9]{64}$/,
  );
});

test("fails closed when an immutable source byte changes", () => {
  const input = makeConsensusReuseEvidenceFixture();
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

test("binds the selected row to the complete immutable review chain", () => {
  const report = compileProductTruthConsensusReuseScope(
    makeConsensusReuseEvidenceFixture(),
  );
  const candidate = report.candidates[0]!;
  assert.equal(candidate.immutableEvidence.caseId, "quarantine:FIXTURE-SELECTED");
  assert.match(
    candidate.immutableEvidence.taskCaseSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.match(
    candidate.immutableEvidence.reconciliationCaseSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(candidate.donorFirstPartyRetailers.length, 1);
});
