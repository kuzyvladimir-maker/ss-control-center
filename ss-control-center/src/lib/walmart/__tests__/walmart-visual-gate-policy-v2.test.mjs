import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  evaluate,
  executionProvenanceKind,
} from "../../../../scripts/walmart-visual-audit-pilot.mjs";
import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  buildBlindObservationPrompt,
} from "../catalog-visual-audit.ts";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function executionFixture() {
  return {
    provider: "codex",
    provider_mode: "zero-model-call-replay",
    vision_provider_attested: "codex_cli_subscription",
    worker_build_attested: `sha256:${"b".repeat(64)}`,
    vision_model_attested: "gpt-5.6-sol",
    vision_reasoning_effort_attested: "medium",
    cli_version_attested: "codex-cli 0.144.5",
    node_version_attested: "v20.20.1",
    runtime_platform_attested: "linux",
    runtime_arch_attested: "x64",
    prompt_version: BLIND_PROMPT_VERSION,
    observation_schema: BLIND_OBSERVATION_SCHEMA,
    preprocessor_version: "walmart-visual-preprocess/2026-07-18-v1",
    paid_api_fallback: false,
    replay_model_calls: 0,
    subscription_calls_used: 0,
    remote_writes: 0,
    database_access: 0,
  };
}

function observationFixture(imageId) {
  return {
    image_id: imageId,
    visual_role: "tiled_main",
    visible_brand_text: "Example",
    visible_product_text: "Bread",
    visible_variant_text: "Whole Wheat",
    visible_size_texts: ["20 oz"],
    external_package_count: { mode: "exact", value: 2, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Example", "Bread", "Whole Wheat", "20 oz"],
    flags: [],
  };
}

function normalCallFixture(imageCount, prefix, execution) {
  const imageIds = Array.from(
    { length: imageCount },
    (_, index) => `${prefix}-image-${index + 1}`,
  );
  const fullViewSha = imageIds.map((imageId) => sha256(`full:${imageId}`));
  const promptSha = sha256(buildBlindObservationPrompt(imageIds));
  const observations = imageIds.map(observationFixture);
  const callKey = sha256(JSON.stringify({
    provider: execution.provider,
    observation_schema: execution.observation_schema,
    prompt_sha256: promptSha,
    worker_build: execution.worker_build_attested,
    vision_contract: {
      vision_model: execution.vision_model_attested,
      vision_reasoning_effort: execution.vision_reasoning_effort_attested,
      cli_version: execution.cli_version_attested,
      node_version: execution.node_version_attested,
      runtime_platform: execution.runtime_platform_attested,
      runtime_arch: execution.runtime_arch_attested,
    },
    preprocessor_version: execution.preprocessor_version,
    full_view_sha256: fullViewSha,
  }));
  const primary = {
    call_key: callKey,
    provider: execution.provider,
    prompt_version: execution.prompt_version,
    prompt_sha256: promptSha,
    preprocessor_version: execution.preprocessor_version,
    image_ids: imageIds,
    full_view_sha256: fullViewSha,
    transport_attempts: [{
      attempt: 1,
      status: 200,
      duration_ms: 1,
      ok: true,
      error: null,
      attested_image_count: imageCount,
      worker_provider: execution.vision_provider_attested,
      worker_build: execution.worker_build_attested,
      vision_model: execution.vision_model_attested,
      vision_reasoning_effort: execution.vision_reasoning_effort_attested,
      cli_version: execution.cli_version_attested,
      node_version: execution.node_version_attested,
      runtime_platform: execution.runtime_platform_attested,
      runtime_arch: execution.runtime_arch_attested,
      worker_model_runtime_attested: true,
      worker_contract_attested: true,
    }],
    transport_ok: true,
    schema_valid: true,
    schema_error: null,
    image_count_attested: true,
    worker_contract_attested: true,
    worker_provider: execution.vision_provider_attested,
    worker_build: execution.worker_build_attested,
    vision_model: execution.vision_model_attested,
    vision_reasoning_effort: execution.vision_reasoning_effort_attested,
    cli_version: execution.cli_version_attested,
    node_version: execution.node_version_attested,
    runtime_platform: execution.runtime_platform_attested,
    runtime_arch: execution.runtime_arch_attested,
    worker_model_runtime_attested: true,
    observations,
  };
  return { primary, fallback: [], observations };
}

function caseResult(item, verdict) {
  return {
    case_id: item.case_id,
    sku: item.sku,
    verdict,
    local_visual_evidence: { local_ocr: { mode: "required" } },
  };
}

function gateFixture() {
  const execution = executionFixture();
  const passCases = Array.from({ length: 5 }, (_, index) => ({
    case_id: `pass-${index + 1}`,
    sku: `pass-sku-${index + 1}`,
    ground_truth: { verdict: "PASS" },
  }));
  const badCase = {
    case_id: "bad-1",
    sku: "bad-sku-1",
    ground_truth: { verdict: "BAD" },
  };
  const cases = [...passCases, badCase];
  const layoutPlans = [
    { name: "batch-4", batch_size: 4, shuffle_seed: null },
    { name: "batch-4-shuffled", batch_size: 4, shuffle_seed: 20260718 },
    { name: "singleton", batch_size: 1, shuffle_seed: null },
  ];
  const layouts = layoutPlans.map((layout) => ({
    ...layout,
    case_results: [
      ...passCases.map((item) => caseResult(item, "PASS")),
      caseResult(badCase, "BAD"),
    ],
    calls: layout.batch_size === 1
      ? cases.map((_, index) => normalCallFixture(
        1,
        `${layout.name}-${index}`,
        execution,
      ))
      : [
        normalCallFixture(4, `${layout.name}-0`, execution),
        normalCallFixture(2, `${layout.name}-1`, execution),
      ],
  }));
  return {
    manifest: {
      purpose: "golden-pilot",
      cases,
      layouts: layoutPlans,
    },
    layouts,
    context: {
      execution,
      sourceReportsSealedAndVerified: true,
      layoutPlanBatchMembershipVerified: true,
      revalidatedRecoveredCallKeys: [],
    },
  };
}

function setVerdict(fixture, caseId, layoutName, verdict) {
  const layout = fixture.layouts.find((item) => item.name === layoutName);
  const result = layout.case_results.find((item) => item.case_id === caseId);
  result.verdict = verdict;
}

function setVerdictEveryLayout(fixture, caseId, verdict) {
  for (const layout of fixture.layouts) setVerdict(fixture, caseId, layout.name, verdict);
}

function evaluateFixture(fixture) {
  return evaluate(fixture.manifest, fixture.layouts, "required", fixture.context);
}

test("Gate B v2 permits one fail-closed PASS/PASS/REVIEW case at exactly 80 percent", () => {
  const fixture = gateFixture();
  setVerdict(fixture, "pass-5", "singleton", "REVIEW");

  const result = evaluateFixture(fixture);
  assert.equal(result.gate_b_policy_version, "walmart-visual-gate-b/2026-07-18-v2");
  assert.equal(result.known_pass_auto_pass_rate, 0.8);
  assert.equal(result.correctness_gates.known_pass_auto_pass_rate_at_least_80pct, true);
  assert.equal(result.correctness_gates.fail_closed_cross_layout_consistency_100pct, true);
  assert.equal(result.diagnostics.cross_layout_exact_verdict_agreement_100pct, false);
  assert.equal(result.diagnostics.cross_layout_exact_verdict_agreement_rate, 5 / 6);
  assert.deepEqual(
    result.diagnostics.cross_layout_exact_verdict_disagreement_case_ids,
    ["pass-5"],
  );
  assert.equal(result.diagnostics.cross_layout_exact_verdict_agreement_blocking, false);
  assert.deepEqual(
    Object.entries(result.gate_b_required_gates)
      .filter(([, passed]) => passed !== true)
      .map(([name]) => name),
    [],
  );
  assert.equal(result.gate_b_go, true);
});

test("Gate B v2 rejects a fail-closed cohort below the 80 percent all-layout PASS floor", () => {
  const fixture = gateFixture();
  setVerdict(fixture, "pass-4", "singleton", "REVIEW");
  setVerdict(fixture, "pass-5", "singleton", "REVIEW");

  const result = evaluateFixture(fixture);
  assert.equal(result.known_pass_auto_pass_rate, 0.6);
  assert.equal(result.correctness_gates.fail_closed_cross_layout_consistency_100pct, true);
  assert.equal(result.correctness_gates.known_pass_auto_pass_rate_at_least_80pct, false);
  assert.equal(result.gate_b_go, false);
});

test("a BAD verdict on a known PASS blocks Gate B even when exactly stable", () => {
  const fixture = gateFixture();
  setVerdictEveryLayout(fixture, "pass-5", "BAD");

  const result = evaluateFixture(fixture);
  assert.equal(result.diagnostics.cross_layout_exact_verdict_agreement_100pct, true);
  assert.equal(result.correctness_gates.zero_false_bad, false);
  assert.equal(result.correctness_gates.all_known_pass_avoid_bad, false);
  assert.equal(result.correctness_gates.fail_closed_cross_layout_consistency_100pct, false);
  assert.equal(result.gate_b_go, false);
});

test("REVIEW or PASS on a known BAD blocks Gate B", async (t) => {
  await t.test("REVIEW loses required all-layout BAD detection", () => {
    const fixture = gateFixture();
    setVerdict(fixture, "bad-1", "singleton", "REVIEW");

    const result = evaluateFixture(fixture);
    assert.equal(result.correctness_gates.zero_false_pass, true);
    assert.equal(result.correctness_gates.all_known_bad_detected_every_layout, false);
    assert.equal(result.correctness_gates.fail_closed_cross_layout_consistency_100pct, false);
    assert.equal(result.gate_b_go, false);
  });

  await t.test("PASS is a false pass and a decisive cross-layout contradiction", () => {
    const fixture = gateFixture();
    setVerdict(fixture, "bad-1", "singleton", "PASS");

    const result = evaluateFixture(fixture);
    assert.equal(result.correctness_gates.zero_false_pass, false);
    assert.equal(result.correctness_gates.cross_layout_pass_bad_contradictions_zero, false);
    assert.equal(result.correctness_gates.fail_closed_cross_layout_consistency_100pct, false);
    assert.equal(result.gate_b_go, false);
  });
});

test("a PASS-to-BAD cross-layout contradiction is independently blocking", () => {
  const fixture = gateFixture();
  setVerdict(fixture, "pass-5", "batch-4-shuffled", "BAD");

  const result = evaluateFixture(fixture);
  assert.equal(result.cases.find((item) => item.case_id === "pass-5").aggregate, "REVIEW");
  assert.equal(result.correctness_gates.cross_layout_pass_bad_contradictions_zero, false);
  assert.equal(result.gate_b_go, false);
});

test("a technical outcome is never accepted as fail-closed semantic REVIEW", () => {
  const fixture = gateFixture();
  setVerdict(fixture, "pass-5", "singleton", "TECHNICAL_ERROR");

  const result = evaluateFixture(fixture);
  assert.equal(result.cases.find((item) => item.case_id === "pass-5").aggregate, "TECHNICAL_ERROR");
  assert.equal(result.correctness_gates.zero_technical_errors, false);
  assert.equal(result.correctness_gates.fail_closed_cross_layout_consistency_100pct, false);
  assert.equal(result.gate_b_go, false);
});

test("any schema fallback call blocks Gate B even when its provenance is valid", () => {
  const fixture = gateFixture();
  const fallback = normalCallFixture(1, "schema-fallback", fixture.context.execution).primary;
  fixture.layouts[0].calls[0].fallback.push(fallback);

  const result = evaluateFixture(fixture);
  assert.equal(
    executionProvenanceKind(fallback, fixture.context.execution),
    "normal_http",
  );
  assert.equal(result.correctness_gates.execution_provenance_validated_100pct, true);
  assert.equal(result.correctness_gates.schema_fallback_calls_zero, false);
  assert.equal(result.gate_b_go, false);
});

test("paid fallback and write gates are derived from execution evidence", async (t) => {
  await t.test("paid API fallback", () => {
    const fixture = gateFixture();
    fixture.context.execution.paid_api_fallback = true;
    const result = evaluateFixture(fixture);
    assert.equal(result.correctness_gates.no_paid_fallback, false);
    assert.equal(result.gate_b_go, false);
  });

  await t.test("remote write", () => {
    const fixture = gateFixture();
    fixture.context.execution.remote_writes = 1;
    const result = evaluateFixture(fixture);
    assert.equal(result.correctness_gates.no_remote_or_database_writes, false);
    assert.equal(result.gate_b_go, false);
  });

  await t.test("database write", () => {
    const fixture = gateFixture();
    fixture.context.execution.database_access = 1;
    const result = evaluateFixture(fixture);
    assert.equal(result.correctness_gates.no_remote_or_database_writes, false);
    assert.equal(result.gate_b_go, false);
  });
});

test("an unverified source-report seal blocks Gate B without invalidating normal HTTP provenance", () => {
  const fixture = gateFixture();
  fixture.context.sourceReportsSealedAndVerified = false;

  const primary = fixture.layouts[0].calls[0].primary;
  assert.equal(executionProvenanceKind(primary, fixture.context.execution), "normal_http");
  const result = evaluateFixture(fixture);
  assert.equal(result.correctness_gates.execution_provenance_validated_100pct, true);
  assert.equal(result.correctness_gates.sealed_evidence_chain_verified, false);
  assert.equal(result.gate_b_go, false);
});

test("normal HTTP provenance rejects every material attestation mutation", () => {
  const mutations = [
    ["transport_ok", (record) => { record.transport_ok = false; }],
    ["schema_valid", (record) => { record.schema_valid = false; }],
    ["image_count_attested", (record) => { record.image_count_attested = false; }],
    ["worker_contract_attested", (record) => { record.worker_contract_attested = false; }],
    ["worker_model_runtime_attested", (record) => { record.worker_model_runtime_attested = false; }],
    ["worker_provider", (record) => { record.worker_provider = "wrong-provider"; }],
    ["worker_build", (record) => { record.worker_build = `sha256:${"c".repeat(64)}`; }],
    ["vision_model", (record) => { record.vision_model = "wrong-model"; }],
    ["vision_reasoning_effort", (record) => { record.vision_reasoning_effort = "low"; }],
    ["cli_version", (record) => { record.cli_version = "codex-cli 0.0.0"; }],
    ["node_version", (record) => { record.node_version = "v0.0.0"; }],
    ["runtime_platform", (record) => { record.runtime_platform = "darwin"; }],
    ["runtime_arch", (record) => { record.runtime_arch = "arm64"; }],
    ["transport_attempt missing", (record) => { record.transport_attempts = []; }],
    ["attempt status", (record) => { record.transport_attempts[0].status = 500; }],
    ["attempt ok", (record) => { record.transport_attempts[0].ok = false; }],
    ["attempt error", (record) => { record.transport_attempts[0].error = "failed"; }],
    ["attempt image count", (record) => { record.transport_attempts[0].attested_image_count += 1; }],
    ["attempt worker provider", (record) => { record.transport_attempts[0].worker_provider = "wrong-provider"; }],
    ["attempt worker build", (record) => { record.transport_attempts[0].worker_build = `sha256:${"c".repeat(64)}`; }],
    ["attempt vision model", (record) => { record.transport_attempts[0].vision_model = "wrong-model"; }],
    ["attempt reasoning effort", (record) => { record.transport_attempts[0].vision_reasoning_effort = "low"; }],
    ["attempt CLI", (record) => { record.transport_attempts[0].cli_version = "codex-cli 0.0.0"; }],
    ["attempt Node", (record) => { record.transport_attempts[0].node_version = "v0.0.0"; }],
    ["attempt platform", (record) => { record.transport_attempts[0].runtime_platform = "darwin"; }],
    ["attempt arch", (record) => { record.transport_attempts[0].runtime_arch = "arm64"; }],
    ["attempt worker contract", (record) => { record.transport_attempts[0].worker_contract_attested = false; }],
    ["attempt model/runtime", (record) => { record.transport_attempts[0].worker_model_runtime_attested = false; }],
  ];

  const baseline = gateFixture();
  assert.equal(
    executionProvenanceKind(
      baseline.layouts[0].calls[0].primary,
      baseline.context.execution,
    ),
    "normal_http",
  );

  for (const [label, mutate] of mutations) {
    const fixture = gateFixture();
    const primary = fixture.layouts[0].calls[0].primary;
    mutate(primary);
    assert.equal(
      executionProvenanceKind(primary, fixture.context.execution),
      "invalid",
      label,
    );
    const result = evaluateFixture(fixture);
    assert.equal(
      result.correctness_gates.execution_provenance_validated_100pct,
      false,
      label,
    );
    assert.equal(result.gate_b_go, false, label);
  }
});

test("normal HTTP provenance rejects execution-contract attestation drift", () => {
  const fixture = gateFixture();
  const primary = fixture.layouts[0].calls[0].primary;
  fixture.context.execution.vision_model_attested = "different-model";

  assert.equal(executionProvenanceKind(primary, fixture.context.execution), "invalid");
  const result = evaluateFixture(fixture);
  assert.equal(result.correctness_gates.execution_provenance_validated_100pct, false);
  assert.equal(result.gate_b_go, false);
});
