import assert from "node:assert/strict";
import test from "node:test";

import { evaluate, parseArgs } from "../../../../scripts/walmart-visual-audit-pilot.mjs";

function fixture(passCount) {
  const cases = Array.from({ length: 5 }, (_, index) => ({
    case_id: `pass-${index + 1}`,
    sku: `sku-${index + 1}`,
    ground_truth: { verdict: "PASS" },
  }));
  const caseResults = cases.map((item, index) => ({
    case_id: item.case_id,
    sku: item.sku,
    verdict: index < passCount ? "PASS" : "REVIEW",
    local_visual_evidence: { local_ocr: { mode: "required" } },
  }));
  return {
    manifest: {
      cases,
      layouts: [{ name: "ordered" }],
    },
    layouts: [{
      name: "ordered",
      case_results: caseResults,
      calls: [{
        primary: {
          schema_valid: true,
          worker_contract_attested: true,
          image_count_attested: true,
        },
        fallback: [],
        observations: [{}],
      }],
    }],
  };
}

test("golden auto-pass gate accepts exactly 80 percent", () => {
  const { manifest, layouts } = fixture(4);
  const result = evaluate(manifest, layouts, "required");
  assert.equal(result.known_pass_auto_pass_rate, 0.8);
  assert.equal(result.correctness_gates.known_pass_auto_pass_rate_at_least_80pct, true);
  assert.equal(result.algorithm_go, true);
  assert.equal("known_pass_auto_pass_rate_at_least_60pct" in result.correctness_gates, false);
});

test("golden auto-pass gate rejects below 80 percent", () => {
  const { manifest, layouts } = fixture(3);
  const result = evaluate(manifest, layouts, "required");
  assert.equal(result.known_pass_auto_pass_rate, 0.6);
  assert.equal(result.correctness_gates.known_pass_auto_pass_rate_at_least_80pct, false);
  assert.equal(result.algorithm_go, false);
});

test("explicitly disabled local OCR can never yield algorithm GO", () => {
  const { manifest, layouts } = fixture(5);
  const result = evaluate(manifest, layouts, "off");
  assert.equal(result.correctness_gates.required_local_ocr_completed_100pct, false);
  assert.equal(result.algorithm_go, false);
});

test("a model run is impossible without an explicit positive call budget", () => {
  assert.throws(() => parseArgs(["--run"]), /requires an explicit positive --call-budget/);
  assert.throws(() => parseArgs(["--run", "--call-budget=0"]), /positive integer/);
  assert.equal(parseArgs(["--run", "--call-budget=6"]).callBudget, 6);
});

test("technical transport outcomes are never collapsed into semantic REVIEW", () => {
  const { manifest, layouts } = fixture(5);
  layouts[0].case_results[0].verdict = "TECHNICAL_ERROR";
  layouts[0].case_results[0].technical_error = "worker schema invalid";
  const result = evaluate(manifest, layouts, "required");
  assert.equal(result.cases[0].aggregate, "TECHNICAL_ERROR");
  assert.equal(result.algorithm_go, false);
});
