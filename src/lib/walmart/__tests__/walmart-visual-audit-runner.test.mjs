import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateReplaySourceExecutionSafety,
  atomicCompareAndSwapJson,
  assertCheckpointAccounting,
  assertExactCheckpointPrefix,
  assertExactRunCallBudget,
  assertGoldenPilotPurpose,
  evaluate,
  parseArgs,
  readJsonIfPresent,
  reconcileRecoveredCall,
  reportBodyWithoutSeal,
  selectedLayoutPlanSha256,
  sealReport,
  validateHealthVisionContract,
  validateRecoveredCallEvidence,
  validateReplayReportBindings,
  verifySealedReport,
} from "../../../../scripts/walmart-visual-audit-pilot.mjs";
import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  buildBlindObservationPrompt,
} from "../catalog-visual-audit.ts";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function gateExecution() {
  return {
    provider: "codex",
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
    provider_mode: "zero-model-call-replay",
    replay_model_calls: 0,
    subscription_calls_used: 0,
    paid_api_fallback: false,
    remote_writes: 0,
    database_access: 0,
  };
}

function gateObservation(imageId) {
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

function normalGateCall(imageCount, prefix, execution) {
  const imageIds = Array.from({ length: imageCount }, (_, index) => `${prefix}-image-${index + 1}`);
  const fullViewSha = imageIds.map((imageId) => sha256(`full:${imageId}`));
  const promptSha = sha256(buildBlindObservationPrompt(imageIds));
  const observations = imageIds.map(gateObservation);
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

function fixture(passCount) {
  const execution = gateExecution();
  const passCases = Array.from({ length: 5 }, (_, index) => ({
    case_id: `pass-${index + 1}`,
    sku: `sku-${index + 1}`,
    ground_truth: { verdict: "PASS" },
  }));
  const badCase = {
    case_id: "bad-1",
    sku: "bad-sku-1",
    ground_truth: { verdict: "BAD" },
  };
  const cases = [...passCases, badCase];
  const caseResults = passCases.map((item, index) => ({
    case_id: item.case_id,
    sku: item.sku,
    verdict: index < passCount ? "PASS" : "REVIEW",
    local_visual_evidence: { local_ocr: { mode: "required" } },
  })).concat({
    case_id: badCase.case_id,
    sku: badCase.sku,
    verdict: "BAD",
    local_visual_evidence: { local_ocr: { mode: "required" } },
  });
  return {
    manifest: {
      cases,
      layouts: [{ name: "ordered", batch_size: 6, shuffle_seed: null }],
    },
    layouts: [{
      name: "ordered",
      batch_size: 6,
      shuffle_seed: null,
      case_results: caseResults,
      calls: [normalGateCall(cases.length, "ordered-0", execution)],
    }],
    context: {
      execution,
      sourceReportsSealedAndVerified: true,
      layoutPlanBatchMembershipVerified: true,
      revalidatedRecoveredCallKeys: [],
    },
  };
}

test("golden auto-pass gate accepts exactly 80 percent", () => {
  const { manifest, layouts, context } = fixture(4);
  const result = evaluate(manifest, layouts, "required", context);
  assert.equal(result.known_pass_auto_pass_rate, 0.8);
  assert.equal(result.correctness_gates.known_pass_auto_pass_rate_at_least_80pct, true);
  assert.equal(result.declared_layout_safety_go, true);
  assert.equal(result.algorithm_go, false);
  assert.equal(result.gate_b_go, false);
  assert.match(result.gate_b_topology_issues.join("\n"), /requires purpose=golden-pilot/);
  assert.equal("known_pass_auto_pass_rate_at_least_60pct" in result.correctness_gates, false);
});

test("Gate B GO requires ordered batch-4, seeded shuffled batch-4, and singleton", () => {
  const base = fixture(5);
  base.manifest.purpose = "golden-pilot";
  base.manifest.layouts = [
    { name: "batch-4", batch_size: 4, shuffle_seed: null },
    { name: "batch-4-shuffled", batch_size: 4, shuffle_seed: 20260718 },
    { name: "singleton", batch_size: 1, shuffle_seed: null },
  ];
  const caseResults = base.layouts[0].case_results;
  base.layouts = base.manifest.layouts.map((layout) => ({
    ...layout,
    case_results: structuredClone(caseResults),
    calls: layout.batch_size === 1
      ? Array.from({ length: 6 }, (_, index) => normalGateCall(1, `${layout.name}-${index}`, base.context.execution))
      : [
        normalGateCall(4, `${layout.name}-0`, base.context.execution),
        normalGateCall(2, `${layout.name}-1`, base.context.execution),
      ],
  }));
  const result = evaluate(base.manifest, base.layouts, "required", base.context);
  assert.equal(result.algorithm_go, true);
  assert.equal(result.gate_b_go, true);
});

test("golden auto-pass gate rejects below 80 percent", () => {
  const { manifest, layouts, context } = fixture(3);
  const result = evaluate(manifest, layouts, "required", context);
  assert.equal(result.known_pass_auto_pass_rate, 0.6);
  assert.equal(result.correctness_gates.known_pass_auto_pass_rate_at_least_80pct, false);
  assert.equal(result.algorithm_go, false);
});

test("explicitly disabled local OCR can never yield algorithm GO", () => {
  const { manifest, layouts, context } = fixture(5);
  const result = evaluate(manifest, layouts, "off", context);
  assert.equal(result.correctness_gates.required_local_ocr_completed_100pct, false);
  assert.equal(result.algorithm_go, false);
});

test("an unpinned worker model/runtime can never yield algorithm GO", () => {
  const { manifest, layouts, context } = fixture(5);
  delete layouts[0].calls[0].primary.worker_model_runtime_attested;
  const result = evaluate(manifest, layouts, "required", context);
  assert.equal(result.correctness_gates.execution_provenance_validated_100pct, false);
  assert.equal(result.diagnostics.normal_worker_model_runtime_attested_100pct, false);
  assert.equal(result.algorithm_go, false);
});

test("worker health must attest the pinned Codex model and complete runtime", () => {
  const health = {
    vision_contracts: {
      codex_cli_subscription: {
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
        cli_version: "codex-cli 0.144.5",
        node_version: "v20.20.1",
        platform: "linux",
        arch: "x64",
      },
    },
  };
  assert.deepEqual(validateHealthVisionContract(health, "codex"), {
    vision_model: "gpt-5.6-sol",
    vision_reasoning_effort: "medium",
    cli_version: "codex-cli 0.144.5",
    node_version: "v20.20.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
  });
  health.vision_contracts.codex_cli_subscription.model = "default";
  assert.throws(() => validateHealthVisionContract(health, "codex"), /required gpt-5.6-sol/);
});

test("a model run is impossible without an explicit positive call budget", () => {
  assert.throws(() => parseArgs(["--run"]), /requires an explicit positive --call-budget/);
  assert.throws(() => parseArgs(["--run", "--call-budget=0"]), /positive integer/);
  assert.equal(parseArgs(["--run", "--call-budget=6"]).callBudget, 6);
  assert.doesNotThrow(() => assertExactRunCallBudget(true, 6, 6));
  assert.throws(() => assertExactRunCallBudget(true, 7, 6), /must equal the exact 6/);
  assert.doesNotThrow(() => assertExactRunCallBudget(false, null, 6));
  assert.throws(
    () => parseArgs(["--run", "--call-budget=6", "--recover-call=evidence.json"]),
    /recovery arguments require --recover-only/,
  );
  const recovery =
    parseArgs([
      "--recover-only",
      "--recover-call=evidence.json",
      "--checkpoint=checkpoint.json",
      "--expect-consumed=21",
      "--expect-prefix=20",
      `--expect-checkpoint-sha256=${"a".repeat(64)}`,
    ]);
  assert.equal(recovery.recoverOnly, true);
  assert.equal(recovery.expectConsumed, 21);
  assert.equal(recovery.expectPrefix, 20);
  assert.throws(
    () => parseArgs([
      "--recover-only", "--recover-call=evidence.json", "--checkpoint=checkpoint.json",
      "--expect-consumed=21", "--expect-prefix=20",
      `--expect-checkpoint-sha256=${"a".repeat(64)}`, "--call-budget=24",
    ]),
    /forbids --call-budget/,
  );
  assert.throws(
    () => parseArgs(["--run", "--call-budget=24", "--expect-consumed=21"]),
    /requires --expect-checkpoint-sha256.*--expect-prefix/,
  );
  const resume = parseArgs([
    "--run", "--call-budget=24", "--expect-consumed=21", "--expect-prefix=21",
    `--expect-checkpoint-sha256=${"b".repeat(64)}`,
  ]);
  assert.equal(resume.expectPrefix, 21);
  assert.throws(
    () => parseArgs([
      "--run", "--call-budget=24", "--expect-consumed=21", "--expect-prefix=20",
      `--expect-checkpoint-sha256=${"b".repeat(64)}`,
    ]),
    /expect-prefix to equal --expect-consumed/,
  );
});

test("each selected layout has an independent checkpoint identity", () => {
  const ordered = [{ name: "batch-4", batch_size: 4, shuffle_seed: null }];
  const shuffled = [{ name: "batch-4-shuffled", batch_size: 4, shuffle_seed: 20260718 }];
  const singleton = [{ name: "singleton", batch_size: 1, shuffle_seed: null }];
  assert.match(selectedLayoutPlanSha256(ordered), /^[a-f0-9]{64}$/);
  assert.notEqual(selectedLayoutPlanSha256(ordered), selectedLayoutPlanSha256(shuffled));
  assert.notEqual(selectedLayoutPlanSha256(shuffled), selectedLayoutPlanSha256(singleton));
  assert.throws(
    () => selectedLayoutPlanSha256([...ordered, ...ordered]),
    /invalid or contains duplicate names/,
  );
});

test("runner rejects non-golden manifests until PDP/truth binding exists", () => {
  assert.doesNotThrow(() => assertGoldenPilotPurpose({ purpose: "golden-pilot" }));
  assert.throws(
    () => assertGoldenPilotPurpose({ purpose: "shadow-pilot" }),
    /restricted to purpose=golden-pilot/,
  );
  assert.throws(() => assertGoldenPilotPurpose({}), /received missing/);
});

test("checkpoint accounting rejects any consumed-but-unrecorded ambiguous call", () => {
  const clean = {
    subscription_calls_consumed: 2,
    calls: {
      first: { transport_attempts: [{}] },
      second: { transport_attempts: [{}] },
    },
  };
  assert.equal(assertCheckpointAccounting(clean, 2), 2);
  assert.throws(() => assertCheckpointAccounting(clean, 1), /expected 1 consumed calls/);

  const crashWindow = structuredClone(clean);
  crashWindow.subscription_calls_consumed = 3;
  assert.throws(() => assertCheckpointAccounting(crashWindow), /ambiguous call accounting/);

  const corruptCounter = structuredClone(clean);
  corruptCounter.subscription_calls_consumed = 1;
  assert.throws(() => assertCheckpointAccounting(corruptCounter), /ambiguous call accounting/);
});

function recoveredCallFixture() {
  const imageId = "i_0123456789abcdef";
  const observation = {
    image_id: imageId,
    visual_role: "tiled_main",
    visible_brand_text: "Example",
    visible_product_text: "Bread",
    visible_variant_text: "Wheat",
    visible_size_texts: ["20 oz"],
    external_package_count: { mode: "exact", value: 4, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Example", "Bread", "Wheat", "20 oz"],
    flags: [],
  };
  const result = { schema_version: BLIND_OBSERVATION_SCHEMA, observations: [observation] };
  const workerContract = {
    vision_model: "gpt-5.6-sol",
    vision_reasoning_effort: "medium",
    cli_version: "codex-cli 0.144.5",
    node_version: "v20.20.1",
    runtime_platform: "linux",
    runtime_arch: "x64",
  };
  const binding = {
    manifest_sha256: "1".repeat(64),
    provider: "codex",
    worker_build: `sha256:${"2".repeat(64)}`,
    worker_contract: workerContract,
    selected_layout_plan_sha256: "3".repeat(64),
    layout_name: "singleton",
    batch_index: 0,
    prompt_version: BLIND_PROMPT_VERSION,
    prompt_sha256: "4".repeat(64),
    call_key: "5".repeat(64),
    preprocessor_version: "preprocessor/v1",
    image_ids: [imageId],
    full_view_sha256: ["6".repeat(64)],
  };
  const checkpointPreSha = "8".repeat(64);
  const evidence = {
    schema_version: "walmart-visual-pilot-recovered-call/v2",
    recovery_id: "recovery-1",
    recovered_at: "2026-07-18T21:15:00.000Z",
    source: {
      kind: "codex_session_log",
      host: "openclaw",
      remote_path: "/root/.codex/sessions/2026/07/18/rollout-session-1.jsonl",
      local_file: "data/audits/session-1.jsonl",
      session_id: "session-1",
      session_log_sha256: "7".repeat(64),
      session_log_bytes: 1000,
      embedded_input_image_sha256: "9".repeat(64),
      embedded_input_image_bytes: 800,
      embedded_input_image_width: 1600,
      embedded_input_image_height: 1600,
      started_at: "2026-07-18T21:14:49.000Z",
      completed_at: "2026-07-18T21:15:00.000Z",
      duration_ms: 11000,
      input_image_count: 1,
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      cli_version: "0.144.5",
      result_canonical_sha256: sha256(canonicalJson(result)),
    },
    checkpoint: {
      pre_recovery_sha256: checkpointPreSha,
      subscription_calls_consumed: 1,
      recorded_attempts: 0,
      completed_prefix_length: 0,
    },
    binding,
    result,
  };
  const expected = {
    ...binding,
    checkpoint_pre_sha256: checkpointPreSha,
    completed_prefix_length: 0,
    planned_calls: [{ ...binding, batch_index: 0 }],
    session_proof: {
      image_link: {
        kind: "deterministic_pixel_similarity",
        cryptographic_original_byte_binding: false,
      },
    },
  };
  return { evidence, expected };
}

test("checkpoint prefix validation rejects gaps, suffixes, and identity drift", () => {
  const { evidence, expected } = recoveredCallFixture();
  const planned = expected.planned_calls[0];
  const record = {
    call_key: planned.call_key,
    provider: planned.provider,
    worker_build: planned.worker_build,
    prompt_version: planned.prompt_version,
    prompt_sha256: planned.prompt_sha256,
    preprocessor_version: planned.preprocessor_version,
    image_ids: planned.image_ids,
    full_view_sha256: planned.full_view_sha256,
    transport_attempts: [{}],
    worker_contract_attested: true,
    worker_model_runtime_attested: true,
    schema_valid: true,
    observations: evidence.result,
  };
  assert.equal(assertExactCheckpointPrefix({ calls: { [planned.call_key]: record } }, [planned], 1), true);
  assert.throws(
    () => assertExactCheckpointPrefix({ calls: {} }, [planned], 1),
    /not the exact planned prefix/,
  );
  assert.throws(
    () => assertExactCheckpointPrefix({ calls: { [planned.call_key]: record } }, [planned], 0),
    /not the exact planned prefix/,
  );
  const drifted = structuredClone(record);
  drifted.prompt_sha256 = "f".repeat(64);
  assert.throws(
    () => assertExactCheckpointPrefix({ calls: { [planned.call_key]: drifted } }, [planned], 1),
    /binding mismatch/,
  );
});

test("one completed remote session can reconcile exactly one interrupted checkpoint attempt", () => {
  const { evidence, expected } = recoveredCallFixture();
  assert.equal(validateRecoveredCallEvidence(evidence), evidence);
  const state = { subscription_calls_consumed: 1, calls: {} };
  const first = reconcileRecoveredCall(state, evidence, expected);
  assert.equal(first.applied, true);
  assert.equal(Object.keys(state.calls).length, 1);
  assert.equal(assertCheckpointAccounting(state, 1), 1);
  assert.equal(state.calls[expected.call_key].recovery.session_log_sha256, "7".repeat(64));
  assert.equal(
    state.calls[expected.call_key].transport_attempts[0].recovered_after_client_disconnect,
    true,
  );
  assert.equal(state.calls[expected.call_key].transport_attempts[0].status, null);
  assert.equal(state.calls[expected.call_key].worker_contract_attested, false);
  assert.equal(state.calls[expected.call_key].recovery_provenance_validated, true);
  const second = reconcileRecoveredCall(state, evidence, expected);
  assert.equal(second.applied, false);
});

test("recovered-call reconciliation rejects extra gaps, binding drift, and response drift", () => {
  const extraGap = recoveredCallFixture();
  assert.throws(
    () => reconcileRecoveredCall(
      { subscription_calls_consumed: 2, calls: {} },
      extraGap.evidence,
      extraGap.expected,
    ),
    /exact checkpoint gap|exact one-attempt prefix gap|exactly one interrupted attempt/,
  );

  const bindingDrift = recoveredCallFixture();
  bindingDrift.evidence.binding.batch_index += 1;
  assert.throws(
    () => reconcileRecoveredCall(
      { subscription_calls_consumed: 1, calls: {} },
      bindingDrift.evidence,
      bindingDrift.expected,
    ),
    /binding does not match the planned call/,
  );

  const responseDrift = recoveredCallFixture();
  responseDrift.evidence.result.observations[0].image_id = "i_wrong";
  responseDrift.evidence.source.result_canonical_sha256 = sha256(canonicalJson(responseDrift.evidence.result));
  assert.throws(
    () => reconcileRecoveredCall(
      { subscription_calls_consumed: 1, calls: {} },
      responseDrift.evidence,
      responseDrift.expected,
    ),
    /every supplied image_id exactly once/,
  );
});

test("technical transport outcomes are never collapsed into semantic REVIEW", () => {
  const { manifest, layouts } = fixture(5);
  layouts[0].case_results[0].verdict = "TECHNICAL_ERROR";
  layouts[0].case_results[0].technical_error = "worker schema invalid";
  const result = evaluate(manifest, layouts, "required");
  assert.equal(result.cases[0].aggregate, "TECHNICAL_ERROR");
  assert.equal(result.algorithm_go, false);
});

test("persistent JSON state only falls back on ENOENT and rejects corruption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "walmart-runner-json-"));
  const missing = path.join(directory, "missing.json");
  const corrupt = path.join(directory, "corrupt.json");
  await writeFile(corrupt, "{not-json");
  assert.deepEqual(await readJsonIfPresent(missing, { fresh: true }, "checkpoint"), { fresh: true });
  await assert.rejects(
    readJsonIfPresent(corrupt, { fresh: true }, "checkpoint"),
    /checkpoint is invalid JSON/,
  );
});

test("offline recovery uses a non-symlink compare-and-swap checkpoint write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "walmart-recovery-cas-"));
  const checkpoint = path.join(directory, "checkpoint.json");
  const original = Buffer.from("{\"version\":1}\n");
  await writeFile(checkpoint, original);
  await assert.rejects(
    atomicCompareAndSwapJson(checkpoint, "0".repeat(64), { version: 2 }),
    /changed before recovery lock/,
  );
  assert.deepEqual(await readFile(checkpoint), original);

  const success = await atomicCompareAndSwapJson(checkpoint, sha256(original), { version: 2 });
  assert.equal(success.before_sha256, sha256(original));
  assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), { version: 2 });

  const concurrent = path.join(directory, "concurrent.json");
  const concurrentOriginal = Buffer.from("{\"version\":1}\n");
  const concurrentWinner = Buffer.from("{\"version\":99}\n");
  await writeFile(concurrent, concurrentOriginal);
  await assert.rejects(
    atomicCompareAndSwapJson(concurrent, sha256(concurrentOriginal), { version: 2 }, {
      beforeCommit: () => writeFile(concurrent, concurrentWinner),
    }),
    /changed concurrently/,
  );
  assert.deepEqual(await readFile(concurrent), concurrentWinner);

  const target = path.join(directory, "target.json");
  const link = path.join(directory, "checkpoint-link.json");
  await writeFile(target, original);
  await symlink(target, link);
  await assert.rejects(
    atomicCompareAndSwapJson(link, sha256(original), { version: 2 }),
    /non-symlink/,
  );
});

test("report canonical body seal rejects any post-write mutation", () => {
  const sealed = sealReport({ schema_version: "example/v1", value: 42 });
  assert.equal(verifySealedReport(sealed), true);
  const tampered = structuredClone(sealed);
  tampered.value = 43;
  assert.throws(() => verifySealedReport(tampered), /body seal mismatch/);
  assert.throws(() => sealReport(sealed), /must not already contain/);
});

test("a sealed source report can be replayed only after removing its source seal", () => {
  const source = sealReport({ schema_version: "example/v1", value: 42 });
  const replayBody = {
    ...reportBodyWithoutSeal(source),
    value: 43,
    replayed_from: ["source.json"],
  };
  assert.equal(Object.hasOwn(replayBody, "report_seal"), false);
  const replay = sealReport(replayBody);
  assert.equal(verifySealedReport(replay), true);
  assert.notEqual(
    replay.report_seal.canonical_body_sha256,
    source.report_seal.canonical_body_sha256,
  );
});

test("replay safety evidence aggregates every sealed source instead of trusting the first", () => {
  const priors = [
    { report: { report_id: "one", execution: { paid_api_fallback: false, remote_writes: 0, database_access: 0 } } },
    { report: { report_id: "two", execution: { paid_api_fallback: true, remote_writes: 2, database_access: 3 } } },
    { report: { report_id: "three", execution: { paid_api_fallback: false, remote_writes: 5, database_access: 7 } } },
  ];
  assert.deepEqual(aggregateReplaySourceExecutionSafety(priors), {
    paid_api_fallback: true,
    remote_writes: 7,
    database_access: 10,
    attestations: [
      { report_id: "one", report_seal: null, paid_api_fallback: false, remote_writes: 0, database_access: 0 },
      { report_id: "two", report_seal: null, paid_api_fallback: true, remote_writes: 2, database_access: 3 },
      { report_id: "three", report_seal: null, paid_api_fallback: false, remote_writes: 5, database_access: 7 },
    ],
  });
  delete priors[1].report.execution.remote_writes;
  assert.equal(aggregateReplaySourceExecutionSafety(priors).remote_writes, null);
  assert.equal(aggregateReplaySourceExecutionSafety(priors).database_access, null);
});

test("layout completion requires exact cases, calls, and declared layout parameters", () => {
  const missing = fixture(5);
  missing.layouts[0].case_results.pop();
  const missingResult = evaluate(missing.manifest, missing.layouts, "required");
  assert.equal(missingResult.correctness_gates.all_planned_layouts_completed, false);
  assert.match(missingResult.layout_coverage_issues.join("\n"), /expected one result for bad-1/);

  const duplicate = fixture(5);
  duplicate.layouts[0].case_results.push(structuredClone(duplicate.layouts[0].case_results[0]));
  assert.equal(evaluate(duplicate.manifest, duplicate.layouts, "required").algorithm_go, false);

  const wrongCallCount = fixture(5);
  wrongCallCount.layouts[0].calls.length = 0;
  assert.equal(evaluate(wrongCallCount.manifest, wrongCallCount.layouts, "required").algorithm_go, false);

  const extraLayout = fixture(5);
  extraLayout.layouts.push(structuredClone(extraLayout.layouts[0]));
  extraLayout.layouts[1].name = "undeclared";
  assert.equal(evaluate(extraLayout.manifest, extraLayout.layouts, "required").algorithm_go, false);
});

test("golden gate cannot pass without complete PASS and BAD ground truth", () => {
  const { manifest, layouts } = fixture(5);
  delete manifest.cases[0].ground_truth;
  const result = evaluate(manifest, layouts, "required");
  assert.equal(result.correctness_gates.golden_ground_truth_complete_with_pass_and_bad, false);
  assert.equal(result.algorithm_go, false);
});

function replayFixture() {
  const normalizedSha = "a".repeat(64);
  const rawSha = "b".repeat(64);
  const imageId = `i_${sha256(`ordered|0|0|${normalizedSha}`).slice(0, 16)}`;
  const observation = {
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
  const promptSha = sha256(buildBlindObservationPrompt([imageId]));
  const workerBuild = `sha256:${"c".repeat(64)}`;
  const callKey = sha256(JSON.stringify({
    provider: "codex",
    observation_schema: BLIND_OBSERVATION_SCHEMA,
    prompt_sha256: promptSha,
    worker_build: workerBuild,
    normalized_image_sha256: [normalizedSha],
  }));
  const primary = {
    call_key: callKey,
    provider: "codex",
    prompt_version: BLIND_PROMPT_VERSION,
    prompt_sha256: promptSha,
    image_ids: [imageId],
    normalized_image_sha256: [normalizedSha],
    worker_contract_attested: true,
    worker_provider: "codex_cli_subscription",
    worker_build: workerBuild,
    schema_valid: true,
    observations: [observation],
  };
  const result = {
    case_id: "case-1",
    sku: "sku-1",
    verdict: "PASS",
    raw_sha256: rawSha,
    normalized_sha256: normalizedSha,
    observation: structuredClone(observation),
  };
  const report = {
    execution: {
      provider: "codex",
      observation_schema: BLIND_OBSERVATION_SCHEMA,
      prompt_version: BLIND_PROMPT_VERSION,
      vision_provider_attested: "codex_cli_subscription",
      worker_build_attested: workerBuild,
    },
    layouts: [{
      name: "ordered",
      batch_size: 1,
      shuffle_seed: null,
      calls: [{ primary, fallback: [], observations: [structuredClone(observation)] }],
      case_results: [result],
    }],
  };
  const manifest = {
    layouts: [{ name: "ordered", batch_size: 1, shuffle_seed: null }],
    cases: [{
      case_id: "case-1",
      sku: "sku-1",
      images: [{
        url: "https://example.invalid/image.jpg",
        slot: "main",
        surface: "artifact",
        buyer_facing_verified: false,
      }],
    }],
  };
  const frozenSources = new Map([["case-1", {
    record: {
      raw_sha256: rawSha,
      normalized_sha256: normalizedSha,
    },
  }]]);
  return { priors: [{ report }], manifest, frozenSources };
}

function replaySequenceFixture() {
  const rawSha = sha256("shared-raw");
  const normalizedSha = sha256("shared-normalized");
  const imageIds = [0, 1].map((position) => (
    `i_${sha256(`ordered|0|${position}|${normalizedSha}`).slice(0, 16)}`
  ));
  const observations = imageIds.map(gateObservation);
  const promptSha = sha256(buildBlindObservationPrompt(imageIds));
  const workerBuild = `sha256:${"d".repeat(64)}`;
  const primary = {
    call_key: sha256(JSON.stringify({
      provider: "codex",
      observation_schema: BLIND_OBSERVATION_SCHEMA,
      prompt_sha256: promptSha,
      worker_build: workerBuild,
      normalized_image_sha256: [normalizedSha, normalizedSha],
    })),
    provider: "codex",
    prompt_version: BLIND_PROMPT_VERSION,
    prompt_sha256: promptSha,
    image_ids: imageIds,
    normalized_image_sha256: [normalizedSha, normalizedSha],
    worker_contract_attested: true,
    worker_provider: "codex_cli_subscription",
    worker_build: workerBuild,
    schema_valid: true,
    observations,
  };
  const cases = [1, 2].map((number) => ({
    case_id: `case-${number}`,
    sku: `sku-${number}`,
    images: [{
      url: `https://example.invalid/image-${number}.jpg`,
      slot: "main",
      surface: "artifact",
      buyer_facing_verified: false,
    }],
  }));
  const caseResults = cases.map((item, index) => ({
    case_id: item.case_id,
    sku: item.sku,
    verdict: "PASS",
    raw_sha256: rawSha,
    normalized_sha256: normalizedSha,
    observation: structuredClone(observations[index]),
  }));
  return {
    priors: [{
      report: {
        execution: {
          provider: "codex",
          observation_schema: BLIND_OBSERVATION_SCHEMA,
          prompt_version: BLIND_PROMPT_VERSION,
          vision_provider_attested: "codex_cli_subscription",
          worker_build_attested: workerBuild,
        },
        layouts: [{
          name: "ordered",
          batch_size: 2,
          shuffle_seed: null,
          calls: [{ primary, fallback: [], observations: structuredClone(observations) }],
          case_results: caseResults,
        }],
      },
    }],
    manifest: {
      layouts: [{ name: "ordered", batch_size: 2, shuffle_seed: null }],
      cases,
    },
    frozenSources: new Map(cases.map((item) => [item.case_id, {
      record: { raw_sha256: rawSha, normalized_sha256: normalizedSha },
    }])),
  };
}

test("replay accepts an observation bound to call image id and frozen source hashes", () => {
  const fixture = replayFixture();
  assert.doesNotThrow(() => validateReplayReportBindings(
    fixture.priors,
    fixture.manifest,
    fixture.frozenSources,
  ));
});

test("replay enforces exact declared case membership and order inside every batch", () => {
  const fixture = replaySequenceFixture();
  assert.equal(validateReplayReportBindings(
    fixture.priors,
    fixture.manifest,
    fixture.frozenSources,
  ), true);
  const results = fixture.priors[0].report.layouts[0].case_results;
  [results[0].observation, results[1].observation] = [
    results[1].observation,
    results[0].observation,
  ];
  assert.throws(
    () => validateReplayReportBindings(fixture.priors, fixture.manifest, fixture.frozenSources),
    /case membership\/order mismatch/,
  );
});

test("replay rejects observation, source-hash, and duplicate-case mismatches", () => {
  const observationTamper = replayFixture();
  observationTamper.priors[0].report.layouts[0].case_results[0].observation.visible_product_text = "Cookies";
  assert.throws(
    () => validateReplayReportBindings(observationTamper.priors, observationTamper.manifest, observationTamper.frozenSources),
    /case\/observation binding mismatch/,
  );

  const hashTamper = replayFixture();
  hashTamper.priors[0].report.layouts[0].case_results[0].normalized_sha256 = "d".repeat(64);
  assert.throws(
    () => validateReplayReportBindings(hashTamper.priors, hashTamper.manifest, hashTamper.frozenSources),
    /case\/source hash mismatch/,
  );

  const duplicate = replayFixture();
  duplicate.priors[0].report.layouts[0].case_results.push(
    structuredClone(duplicate.priors[0].report.layouts[0].case_results[0]),
  );
  assert.throws(
    () => validateReplayReportBindings(duplicate.priors, duplicate.manifest, duplicate.frozenSources),
    /duplicate replay case result/,
  );

  const callHashTamper = replayFixture();
  callHashTamper.priors[0].report.layouts[0].calls[0].primary.normalized_image_sha256[0] = "e".repeat(64);
  assert.throws(
    () => validateReplayReportBindings(callHashTamper.priors, callHashTamper.manifest, callHashTamper.frozenSources),
    /image_id\/hash binding mismatch/,
  );

  const orphanObservation = replayFixture();
  delete orphanObservation.priors[0].report.layouts[0].case_results[0].observation;
  assert.throws(
    () => validateReplayReportBindings(orphanObservation.priors, orphanObservation.manifest, orphanObservation.frozenSources),
    /call observation is not bound to a case result/,
  );

  const nonAuthoritative = replayFixture();
  delete nonAuthoritative.priors[0].report.layouts[0].calls[0].observations;
  assert.throws(
    () => validateReplayReportBindings(nonAuthoritative.priors, nonAuthoritative.manifest, nonAuthoritative.frozenSources),
    /case\/observation binding mismatch/,
  );
});
