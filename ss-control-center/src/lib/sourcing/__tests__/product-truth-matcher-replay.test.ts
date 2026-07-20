import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
  ProductTruthMatcherReplayError,
  parseProductTruthMatcherReplayCorpus,
  runProductTruthMatcherReplay,
} from "../product-truth-matcher-replay";

const SHA = "a".repeat(64);

function quarantineCorpus() {
  return {
    schemaVersion: PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
    corpusId: "variant-mismatch-2026-07-18",
    capturedAt: "2026-07-18T20:00:00.000Z",
    source: {
      kind: "VARIANT_MISMATCH_QUARANTINE",
      artifactSha256: SHA,
      declaredCaseCount: 2,
    },
    cases: [
      {
        caseId: "case-001",
        target: { brand: "Coca-Cola", productLine: "Cola", flavor: "Original", form: "Soda", size: "12 fl oz" },
        candidate: { brand: "Coca-Cola", productLine: "Cola", flavor: "Zero Sugar", form: "Soda", size: "12 fl oz" },
        expectedVerdict: "REJECT",
      },
      {
        caseId: "case-002",
        target: { brand: "Cheez-It", productLine: "Crackers", flavor: "Original", form: "Crackers", size: "12 oz" },
        candidate: { brand: "Cheez-It", productLine: "Crackers", flavor: "Extra Cheesy", form: "Crackers", size: "12 oz" },
        expectedVerdict: "REJECT",
      },
    ],
  };
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthMatcherReplayError ? error.code : undefined;
}

test("replays a complete quarantine corpus offline and reports exact zero-false-accept certification", () => {
  const report = runProductTruthMatcherReplay({ corpus: quarantineCorpus(), requiredCaseCount: 2 });
  assert.equal(report.certification, "PASS");
  assert.deepEqual(report.counts, {
    total: 2,
    passed: 2,
    failed: 0,
    falseAccepts: 0,
    falseRejects: 0,
    tierMismatches: 0,
  });
  assert.equal(report.matcherVersion, "canonical-product-match/1.2.0");
  assert.match(report.corpusSha256, /^[a-f0-9]{64}$/);
  assert.match(report.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.claims.providerCalls, false);
});

test("refuses to certify a partial substitute for the required 386-case quarantine", () => {
  assert.throws(
    () => runProductTruthMatcherReplay({ corpus: quarantineCorpus(), requiredCaseCount: 386 }),
    (error) => code(error) === "MATCHER_REPLAY_CORPUS_INCOMPLETE",
  );
});

test("detects false accepts rather than hiding them in aggregate counts", () => {
  const corpus = quarantineCorpus();
  corpus.cases[0].candidate = structuredClone(corpus.cases[0].target);
  const report = runProductTruthMatcherReplay({ corpus, requiredCaseCount: 2 });
  assert.equal(report.certification, "FAIL");
  assert.equal(report.counts.falseAccepts, 1);
  assert.equal(report.results[0].failureClass, "FALSE_ACCEPT");
});

test("rejects non-canonical order, duplicate IDs, and source-class contradictions", () => {
  const reversed = quarantineCorpus();
  reversed.cases.reverse();
  assert.throws(() => parseProductTruthMatcherReplayCorpus(reversed), /strictly ordered/);

  const duplicate = quarantineCorpus();
  duplicate.cases[1].caseId = duplicate.cases[0].caseId;
  assert.throws(() => parseProductTruthMatcherReplayCorpus(duplicate), /unique/);

  const contradiction = quarantineCorpus();
  contradiction.cases[0].expectedVerdict = "EXACT_IDENTITY";
  assert.throws(() => parseProductTruthMatcherReplayCorpus(contradiction), /must all expect REJECT/);
});
