import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluate,
  executionProvenanceKind,
  verifySealedReport,
} from "../../../../scripts/walmart-visual-audit-pilot.mjs";
import { buildBlindObservationPrompt } from "../catalog-visual-audit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MANIFEST_FILE = path.join(
  ROOT,
  "data/audits/walmart-visual-pilot-golden-pairs-v3.json",
);
const REPORT_FILES = [
  path.join(
    ROOT,
    "data/audits/walmart-visual-pilot-runs",
    "walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex",
    "report-20260718T204434Z-fcb35f96d156f016.json",
  ),
  path.join(
    ROOT,
    "data/audits/walmart-visual-pilot-runs",
    "walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-3be8593f5486-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex",
    "report-20260718T210254Z-4a1f21d05c6ad2ee.json",
  ),
  path.join(
    ROOT,
    "data/audits/walmart-visual-pilot-runs",
    "walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-4ae2043186a5-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex",
    "report-20260718T214427Z-6906839a63982057.json",
  ),
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function loadFixture() {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const reports = REPORT_FILES.map((file) => JSON.parse(readFileSync(file, "utf8")));
  for (const report of reports) assert.equal(verifySealedReport(report), true);
  const layouts = reports.flatMap((report) => structuredClone(report.layouts));
  const singleton = layouts.find((layout) => layout.name === "singleton");
  const recovered = singleton.calls
    .map((call) => call.primary)
    .find((record) => record.recovery_provenance_validated === true);
  assert.ok(recovered, "sealed singleton fixture must contain the recovered call");
  const execution = structuredClone(reports.find(
    (report) => report.layouts.some((layout) => layout.name === "singleton"),
  ).execution);
  execution.provider_mode = "zero-model-call-replay";
  execution.replay_model_calls = 0;
  execution.subscription_calls_used = 0;
  const context = {
    execution,
    sourceReportsSealedAndVerified: true,
    layoutPlanBatchMembershipVerified: true,
    revalidatedRecoveredCallKeys: [recovered.call_key],
  };
  return { manifest, reports, layouts, singleton, recovered, execution, context };
}

function recoveryOptions(overrides = {}) {
  return {
    isPrimary: true,
    sourceReportsSealedAndVerified: true,
    recoveryEvidenceRevalidated: true,
    ...overrides,
  };
}

function rebindCallIdentity(record, execution) {
  record.prompt_sha256 = sha256(buildBlindObservationPrompt(record.image_ids));
  record.call_key = sha256(JSON.stringify({
    provider: record.provider,
    observation_schema: execution.observation_schema,
    prompt_sha256: record.prompt_sha256,
    worker_build: record.worker_build,
    vision_contract: {
      vision_model: execution.vision_model_attested,
      vision_reasoning_effort: execution.vision_reasoning_effort_attested,
      cli_version: execution.cli_version_attested,
      node_version: execution.node_version_attested,
      runtime_platform: execution.runtime_platform_attested,
      runtime_arch: execution.runtime_arch_attested,
    },
    preprocessor_version: record.preprocessor_version,
    full_view_sha256: record.full_view_sha256,
  }));
  return record;
}

function mutated(record, mutate) {
  const clone = structuredClone(record);
  mutate(clone);
  return clone;
}

test("Gate B v2 accepts the one raw-chain recovered primary, while mass readiness stays strict", () => {
  const { manifest, layouts, recovered, execution, context } = loadFixture();

  assert.equal(
    executionProvenanceKind(recovered, execution, recoveryOptions()),
    "recovered_raw_session",
  );
  assert.equal(
    executionProvenanceKind(
      recovered,
      execution,
      recoveryOptions({ sourceReportsSealedAndVerified: false }),
    ),
    "invalid",
    "an unsealed source must never authorize recovered provenance",
  );
  assert.equal(
    executionProvenanceKind(
      recovered,
      execution,
      recoveryOptions({ recoveryEvidenceRevalidated: false }),
    ),
    "invalid",
    "a call key absent from the raw-chain revalidation allowlist must fail closed",
  );

  const result = evaluate(manifest, layouts, "required", context);
  assert.equal(result.gate_b_go, true);
  assert.equal(result.correctness_gates.execution_provenance_validated_100pct, true);
  assert.equal(result.correctness_gates.recovered_call_count_at_most_one, true);
  assert.equal(result.correctness_gates.recovered_calls_primary_only, true);
  assert.equal(result.diagnostics.normal_http_call_count, 35);
  assert.equal(result.diagnostics.recovered_raw_session_call_count, 1);
  assert.deepEqual(result.diagnostics.invalid_execution_provenance_call_keys, []);

  assert.equal(result.diagnostics.normal_worker_image_count_attested_100pct, false);
  assert.equal(result.diagnostics.normal_worker_contract_attested_100pct, false);
  assert.equal(result.diagnostics.normal_worker_model_runtime_attested_100pct, false);
  assert.equal(result.mass_run_readiness_gates.algorithm_golden_passed, true);
  assert.equal(result.mass_run_readiness_gates.worker_image_count_attested_100pct, false);
  assert.equal(result.mass_run_readiness_gates.worker_contract_attested_100pct, false);
  assert.equal(result.mass_run_readiness_gates.worker_model_runtime_attested_100pct, false);
  assert.equal(result.mass_run_go, false);

  const withoutRawChainKey = evaluate(manifest, layouts, "required", {
    ...context,
    revalidatedRecoveredCallKeys: [],
  });
  assert.equal(withoutRawChainKey.correctness_gates.execution_provenance_validated_100pct, false);
  assert.equal(withoutRawChainKey.gate_b_go, false);

  const withoutSealedSource = evaluate(manifest, layouts, "required", {
    ...context,
    sourceReportsSealedAndVerified: false,
  });
  assert.equal(withoutSealedSource.correctness_gates.sealed_evidence_chain_verified, false);
  assert.equal(withoutSealedSource.correctness_gates.execution_provenance_validated_100pct, false);
  assert.equal(withoutSealedSource.gate_b_go, false);
});

test("Gate B v2 rejects a second individually valid recovered call", () => {
  const { manifest, layouts, recovered, execution, context } = loadFixture();
  const singleton = layouts.find((layout) => layout.name === "singleton");
  singleton.calls[0].primary = structuredClone(recovered);
  singleton.calls[0].observations = structuredClone(recovered.observations);

  assert.equal(
    executionProvenanceKind(singleton.calls[0].primary, execution, recoveryOptions()),
    "recovered_raw_session",
  );
  const result = evaluate(manifest, layouts, "required", context);
  assert.equal(result.correctness_gates.execution_provenance_validated_100pct, true);
  assert.equal(result.diagnostics.recovered_raw_session_call_count, 2);
  assert.equal(result.correctness_gates.recovered_call_count_at_most_one, false);
  assert.equal(result.gate_b_go, false);
});

test("recovered provenance is primary-only and exactly one image", () => {
  const { recovered, execution } = loadFixture();
  assert.equal(
    executionProvenanceKind(
      recovered,
      execution,
      recoveryOptions({ isPrimary: false }),
    ),
    "invalid",
  );

  const twoImages = mutated(recovered, (record) => {
    const secondImageId = "i_recovery_second_image";
    const secondFullView = sha256("recovery-second-full-view");
    const secondObservation = structuredClone(record.observations[0]);
    secondObservation.image_id = secondImageId;
    record.image_ids.push(secondImageId);
    record.full_view_sha256.push(secondFullView);
    record.observations.push(secondObservation);
    record.recovery.source_full_view_sha256.push(secondFullView);
    rebindCallIdentity(record, execution);
  });
  assert.equal(
    executionProvenanceKind(twoImages, execution, recoveryOptions()),
    "invalid",
  );
});

test("recovered provenance requires the exact v2 recovery and attempt shapes", () => {
  const { recovered, execution } = loadFixture();
  const cases = [
    ["missing recovery field", (record) => { delete record.recovery.session_log_sha256; }],
    ["v1 recovery schema", (record) => { record.recovery.schema_version = "walmart-visual-pilot-recovered-call/v1"; }],
    ["extra recovery field", (record) => { record.recovery.untrusted_extra = true; }],
    ["missing attempt field", (record) => { delete record.transport_attempts[0].remote_session_completed; }],
    ["extra attempt field", (record) => { record.transport_attempts[0].untrusted_extra = true; }],
  ];
  for (const [label, mutate] of cases) {
    assert.equal(
      executionProvenanceKind(mutated(recovered, mutate), execution, recoveryOptions()),
      "invalid",
      label,
    );
  }
});

test("recovered provenance rejects HTTP impersonation and every material proof drift", () => {
  const { recovered, execution } = loadFixture();
  const policy = recovered.recovery.deterministic_visual_binding.policy;
  const cases = [
    ["record image-count attestation", (record) => { record.image_count_attested = true; }],
    ["record worker-contract attestation", (record) => { record.worker_contract_attested = true; }],
    ["record model/runtime attestation", (record) => { record.worker_model_runtime_attested = true; }],
    ["record transport success", (record) => { record.transport_ok = true; }],
    ["record model", (record) => { record.vision_model = execution.vision_model_attested; }],
    ["record CLI", (record) => { record.cli_version = execution.cli_version_attested; }],
    ["HTTP status", (record) => { record.transport_attempts[0].status = 200; }],
    ["HTTP duration", (record) => { record.transport_attempts[0].duration_ms = 1; }],
    ["HTTP ok", (record) => { record.transport_attempts[0].ok = true; }],
    ["attempt image-count attestation", (record) => { record.transport_attempts[0].attested_image_count = 1; }],
    ["attempt worker build", (record) => { record.transport_attempts[0].worker_build = execution.worker_build_attested; }],
    ["attempt worker-contract attestation", (record) => {
      record.transport_attempts[0].worker_contract_attested = true;
    }],
    ["attempt model/runtime attestation", (record) => {
      record.transport_attempts[0].worker_model_runtime_attested = true;
    }],
    ["attempt client response", (record) => { record.transport_attempts[0].client_response_observed = true; }],
    ["recovery client response", (record) => { record.recovery.client_response_observed = true; }],
    ["recovery HTTP status", (record) => { record.recovery.http_status = 200; }],
    ["recovery transport duration", (record) => { record.recovery.transport_duration_ms = 1; }],
    ["remote model drift", (record) => { record.recovery.remote_session_model = "different-model"; }],
    ["remote CLI drift", (record) => { record.recovery.remote_session_cli_version = "0.144.6"; }],
    ["visual policy drift", (record) => {
      record.recovery.deterministic_visual_binding.policy.max_mean_absolute_error += 0.001;
    }],
    ["visual MAE outside policy", (record) => {
      record.recovery.deterministic_visual_binding.metrics.mean_absolute_error =
        policy.max_mean_absolute_error + 0.001;
    }],
    ["visual correlation outside policy", (record) => {
      record.recovery.deterministic_visual_binding.metrics.pearson_correlation =
        policy.min_pearson_correlation - 0.001;
    }],
    ["non-finite visual metric", (record) => {
      record.recovery.deterministic_visual_binding.metrics.root_mean_square_error = Number.NaN;
    }],
  ];
  for (const [label, mutate] of cases) {
    assert.equal(
      executionProvenanceKind(mutated(recovered, mutate), execution, recoveryOptions()),
      "invalid",
      label,
    );
  }
});
