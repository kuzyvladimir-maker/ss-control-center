import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { test } from "node:test";

import {
  BLIND_OBSERVATION_SCHEMA,
  BLIND_PROMPT_VERSION,
  WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
} from "../catalog-visual-audit.ts";
import { VISUAL_PREPROCESS_VERSION } from "../catalog-visual-preprocess.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../local-visual-ocr.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
  WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
  WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
  WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  canonicalWalmartListingObservationJson,
  parseWalmartListingWorkerReservationLedgerContract,
  sealWalmartListingObservationBatch,
  sealWalmartListingObservationTechnicalErrorTerminal,
  verifyWalmartListingObservationArtifact,
  verifyWalmartListingObservationBatch,
  verifyWalmartListingObservationTechnicalErrorTerminal,
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../listing-integrity-observation.ts";

const ASSET_SHA = "a".repeat(64);
const VIEW_SHA = "b".repeat(64);
const LISTING_KEY = "walmart:1:SKU-1";
const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_SHA = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");
const RESERVATION_LEDGER = {
  schema_version: WALMART_LISTING_WORKER_RESERVATION_LEDGER_CONTRACT_SCHEMA,
  ledger_id: "ledger-11111111-1111-4111-8111-111111111111",
  ledger_epoch: "epoch-22222222-2222-4222-8222-222222222222",
  state_directory_path_sha256: "3".repeat(64),
  directory_identity_sha256: "4".repeat(64),
  identity_artifact_sha256: "5".repeat(64),
};

function signedWorkerReceipt({
  runLockSha, shardId, callIndex, callKey, promptSha, resultSha, workerContract,
  executionPermit,
}) {
  const body = {
    issued_at: "2026-07-18T20:00:01.000Z",
    reservation_reserved_at: "2026-07-18T20:00:00.000Z",
    request_attestation: {
      schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
      run_lock_sha256: runLockSha,
      shard_id: shardId,
      call_index: callIndex,
      call_key: callKey,
      prompt_sha256: promptSha,
      execution_permit_sha256: executionPermit.sha256,
      partition_id: executionPermit.body.partition_id,
      image_sha256: [VIEW_SHA],
    },
    result_canonical_sha256: resultSha,
    worker_contract: {
      input_image_count: 1,
      vision_provider: "claude_cli_subscription",
      vision_model: "sonnet",
      vision_reasoning_effort: null,
      cli_version: workerContract.cli_version,
      node_version: workerContract.node_version,
      runtime_platform: workerContract.runtime_platform,
      runtime_arch: workerContract.runtime_arch,
      worker_build: workerContract.worker_build,
      vision_timeout_ms: workerContract.vision_timeout_ms,
      reservation_ledger: structuredClone(workerContract.reservation_ledger),
    },
    subscription_policy: {
      auth_mode: "claude_subscription_oauth",
      paid_api_environment_absent: true,
      alternate_cloud_routing_absent: true,
    },
  };
  return {
    schema_version: WALMART_LISTING_WORKER_RECEIPT_SCHEMA,
    key_id: "fixture-worker-key",
    public_key_spki_der_base64: WORKER_PUBLIC_DER.toString("base64"),
    public_key_spki_sha256: WORKER_PUBLIC_SHA,
    body,
    signature_base64: sign(
      null,
      Buffer.from(canonicalWalmartListingObservationJson(body), "utf8"),
      WORKER_KEYS.privateKey,
    ).toString("base64"),
  };
}

function fixture() {
  const imageId = walmartListingObservationImageId(ASSET_SHA, "main", LISTING_KEY);
  const imageBindings = [{
    listing_key: LISTING_KEY,
    item_id: "123456789",
    slot: "main",
    asset_sha256: ASSET_SHA,
    model_view_sha256: VIEW_SHA,
    image_id: imageId,
  }];
  const result = {
    schema_version: BLIND_OBSERVATION_SCHEMA,
    observations: [{
      image_id: imageId,
      visual_role: "tiled_main",
      visible_brand_text: "Acme",
      visible_product_text: "Bread",
      visible_variant_text: "White",
      visible_size_texts: ["20 oz"],
      external_package_count: { mode: "exact", value: 2, min: null, max: null },
      outer_package_claims: ["Pack of 2"],
      inner_contents_claims: [],
      case_package_claims: [],
      unclear_quantity_claims: [],
      grid_cell_kind: "single_sellable_package",
      front_visibility: "all",
      background: "white",
      multiple_distinct_products: "no",
      readable_identity: "clear",
      evidence: ["Acme Bread White"],
      flags: [],
    }],
  };
  const ocrOutput = {
    schema_version: WALMART_LISTING_OCR_EVIDENCE_SCHEMA,
    engine: LOCAL_VISUAL_OCR_ENGINE,
    views: [{
      view_role: "full",
      view_sha256: VIEW_SHA,
      width: 100,
      height: 100,
      observations: [],
    }],
  };
  const workerContract = {
    worker_build: `sha256:${"c".repeat(64)}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: "2.1.202",
    node_version: "v22.1.0",
    runtime_platform: "darwin",
    runtime_arch: "arm64",
    vision_timeout_ms: 180_000,
    reservation_ledger: structuredClone(RESERVATION_LEDGER),
  };
  const permitCore = {
    schema_version: WALMART_LISTING_EXECUTION_PERMIT_SCHEMA,
    run_lock_sha256: "d".repeat(64),
    run_id: "run-0001",
    partition_id: "partition-0001",
    partition_index: 0,
    shard_ids: ["shard-0001"],
    preflight_certificate_sha256: "f".repeat(64),
    created_at: "2026-07-18T19:00:00.000Z",
    expires_at: "2026-07-19T19:00:00.000Z",
    owner_authorization: { fixture: "owner-authorization" },
    authorization_binding: { fixture: "authorization-binding" },
    allowance_reservation: { fixture: "allowance-reservation" },
  };
  const permitBody = {
    ...permitCore,
    permit_id: `permit-000000-${walmartListingObservationSha256(permitCore).slice(0, 20)}`,
  };
  const executionPermit = {
    sha256: walmartListingObservationSha256(permitBody),
    body: permitBody,
  };
  const promptSha = walmartListingObservationPromptSha256([imageId]);
  const partial = {
    run_lock_sha256: "d".repeat(64),
    shard_id: "shard-0001",
    call_index: 0,
    worker_contract: workerContract,
    execution_permit: executionPermit,
    prompt_sha256: promptSha,
    image_bindings: imageBindings,
  };
  const callKey = walmartListingObservationCallKey(partial);
  const resultSha = walmartListingObservationSha256(result);
  return {
    schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: partial.run_lock_sha256,
    shard_id: partial.shard_id,
    call_index: partial.call_index,
    call_key: callKey,
    created_at: "2026-07-18T20:00:00.000Z",
    provider: "claude_cli_subscription",
    worker_contract: workerContract,
    execution_permit: executionPermit,
    worker_receipt: signedWorkerReceipt({
      runLockSha: partial.run_lock_sha256,
      shardId: partial.shard_id,
      callIndex: partial.call_index,
      callKey,
      promptSha,
      resultSha,
      workerContract,
      executionPermit,
    }),
    execution: {
      subscription_calls_consumed: 1,
      transport_attempts: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      input_image_count_attested: true,
      worker_contract_attested: true,
    },
    prompt: { version: BLIND_PROMPT_VERSION, sha256: promptSha },
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: imageBindings,
    result_canonical_sha256: resultSha,
    result,
    local_ocr: [{
      image_id: imageId,
      asset_sha256: ASSET_SHA,
      full_view_sha256: VIEW_SHA,
      preprocessor_version: VISUAL_PREPROCESS_VERSION,
      ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
      ocr_script_sha256: "e".repeat(64),
      ocr_output_sha256: walmartListingObservationSha256(ocrOutput),
      ocr_output: ocrOutput,
      truncated: false,
      auxiliary_ocr: { ocr_texts: [] },
    }],
  };
}

function fixtureWithNonemptyOcr() {
  const body = fixture();
  const trusted = {
    text: "PACK OF 2",
    confidence: WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
    bounding_box: { x: 0.1, y: 0.15, width: 0.35, height: 0.1 },
  };
  body.local_ocr[0].ocr_output.views[0].observations = [
    trusted,
    {
      text: "LOW CONFIDENCE NOISE",
      confidence: WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE - 0.01,
      bounding_box: { x: 0.1, y: 0.3, width: 0.45, height: 0.1 },
    },
  ];
  body.local_ocr[0].ocr_output_sha256 = walmartListingObservationSha256(
    body.local_ocr[0].ocr_output,
  );
  body.local_ocr[0].auxiliary_ocr = {
    ocr_texts: [{
      ...trusted,
      view_role: "full",
      view_sha256: VIEW_SHA,
    }],
  };
  return body;
}

function terminalFixture() {
  const observed = fixture();
  return {
    schema_version: WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    run_lock_sha256: observed.run_lock_sha256,
    shard_id: observed.shard_id,
    call_index: observed.call_index,
    call_key: observed.call_key,
    reserved_at: observed.created_at,
    terminalized_at: "2026-07-18T20:05:00.000Z",
    terminal_state: "BLOCKED_AMBIGUOUS",
    audit_outcome: "TECH_ERROR",
    reason_code: "attempt_reserved_without_verifiable_worker_result",
    attempt_body_sha256: "9".repeat(64),
    execution_permit: observed.execution_permit,
    worker_contract: observed.worker_contract,
    prompt: observed.prompt,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    image_bindings: observed.image_bindings,
    image_outcomes: observed.image_bindings.map((binding) => ({
      image_id: binding.image_id,
      outcome: "TECH_ERROR",
      required_action: "REVIEW",
    })),
    execution: {
      subscription_calls_consumed: "unknown_0_or_1",
      transport_attempts_maximum: 1,
      retries: 0,
      fallbacks: 0,
      paid_api_calls: 0,
      openai_model_calls: 0,
      worker_result_present: false,
      worker_receipt_present: false,
      pass_eligible: false,
    },
  };
}

function resealOuterArtifactWithoutContractValidation(raw) {
  const changed = structuredClone(raw);
  delete changed.artifact_id;
  delete changed.body_sha256;
  const bodySha = walmartListingObservationSha256(changed);
  return {
    ...changed,
    artifact_id: `walmart-claude-observation-${changed.call_index}-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function resignReceipt(receipt) {
  receipt.signature_base64 = sign(
    null,
    Buffer.from(canonicalWalmartListingObservationJson(receipt.body), "utf8"),
    WORKER_KEYS.privateKey,
  ).toString("base64");
}

function resealPermit(permit) {
  const core = { ...permit.body };
  delete core.permit_id;
  permit.body.permit_id = `permit-${String(core.partition_index).padStart(6, "0")}-${walmartListingObservationSha256(core).slice(0, 20)}`;
  permit.sha256 = walmartListingObservationSha256(permit.body);
}

test("seals and exactly verifies one pinned Claude blind observation call", () => {
  const sealed = sealWalmartListingObservationBatch(fixture());
  assert.deepEqual(verifyWalmartListingObservationBatch(sealed), sealed);
  assert.equal(sealed.execution.openai_model_calls, 0);
  assert.equal(sealed.worker_contract.model, "sonnet");
  assert.deepEqual(sealed.worker_contract.reservation_ledger, RESERVATION_LEDGER);
  assert.deepEqual(
    sealed.worker_receipt.body.worker_contract.reservation_ledger,
    RESERVATION_LEDGER,
  );
});

test("reservation-ledger parser rejects every missing, extra, malformed, or old-schema field", () => {
  assert.deepEqual(
    parseWalmartListingWorkerReservationLedgerContract(RESERVATION_LEDGER),
    RESERVATION_LEDGER,
  );
  const invalid = [
    ["schema_version", "vision-call-reservation-ledger-contract/v0"],
    ["ledger_id", "ledger-not-a-uuid"],
    ["ledger_epoch", "epoch-not-a-uuid"],
    ["state_directory_path_sha256", "A".repeat(64)],
    ["directory_identity_sha256", "4".repeat(63)],
    ["identity_artifact_sha256", "not-a-sha"],
  ];
  for (const [field, value] of invalid) {
    assert.throws(() => parseWalmartListingWorkerReservationLedgerContract({
      ...RESERVATION_LEDGER,
      [field]: value,
    }), new RegExp(field));
  }
  for (const field of Object.keys(RESERVATION_LEDGER)) {
    const missing = { ...RESERVATION_LEDGER };
    delete missing[field];
    assert.throws(
      () => parseWalmartListingWorkerReservationLedgerContract(missing),
      /fields must be exactly/,
    );
  }
  assert.throws(() => parseWalmartListingWorkerReservationLedgerContract({
    ...RESERVATION_LEDGER,
    unexpected: true,
  }), /fields must be exactly/);
});

test("signed receipt cannot switch any ledger field or worker build", () => {
  const mutations = [
    ["schema_version", "vision-call-reservation-ledger-contract/v0"],
    ["ledger_id", "ledger-33333333-3333-4333-8333-333333333333"],
    ["ledger_epoch", "epoch-44444444-4444-4444-8444-444444444444"],
    ["state_directory_path_sha256", "6".repeat(64)],
    ["directory_identity_sha256", "7".repeat(64)],
    ["identity_artifact_sha256", "8".repeat(64)],
  ];
  for (const [field, value] of mutations) {
    const body = fixture();
    body.worker_receipt.body.worker_contract.reservation_ledger[field] = value;
    resignReceipt(body.worker_receipt);
    assert.throws(
      () => sealWalmartListingObservationBatch(body),
      /reservation_ledger|exact locked request\/result\/runtime/,
      field,
    );
  }
  const changedBuild = fixture();
  changedBuild.worker_receipt.body.worker_contract.worker_build = `sha256:${"9".repeat(64)}`;
  resignReceipt(changedBuild.worker_receipt);
  assert.throws(
    () => sealWalmartListingObservationBatch(changedBuild),
    /exact locked request\/result\/runtime/,
  );
});

test("recomputes selected auxiliary OCR evidence from complete nonempty OCR output", () => {
  const sealed = sealWalmartListingObservationBatch(fixtureWithNonemptyOcr());
  assert.deepEqual(sealed.local_ocr[0].auxiliary_ocr.ocr_texts, [{
    text: "PACK OF 2",
    confidence: WALMART_VISUAL_AUXILIARY_OCR_MIN_CONFIDENCE,
    view_role: "full",
    view_sha256: VIEW_SHA,
    bounding_box: { x: 0.1, y: 0.15, width: 0.35, height: 0.1 },
  }]);
  assert.equal(sealed.local_ocr[0].truncated, false);
});

test("rejects selected OCR tamper even when an attacker reseals the outer artifact", () => {
  const sealed = sealWalmartListingObservationBatch(fixtureWithNonemptyOcr());
  const changed = structuredClone(sealed);
  changed.local_ocr[0].auxiliary_ocr.ocr_texts[0].text = "PACK OF 20";
  const attackerResealed = resealOuterArtifactWithoutContractValidation(changed);
  assert.throws(
    () => verifyWalmartListingObservationBatch(attackerResealed),
    /auxiliary_ocr\/truncated does not rebuild from OCR output/,
  );
});

test("rejects OCR full-view role or SHA mismatch", () => {
  for (const mutate of [
    (body) => { body.local_ocr[0].ocr_output.views[0].view_role = "tile_front"; },
    (body) => { body.local_ocr[0].ocr_output.views[0].view_sha256 = "1".repeat(64); },
  ]) {
    const body = fixture();
    mutate(body);
    body.local_ocr[0].ocr_output_sha256 = walmartListingObservationSha256(
      body.local_ocr[0].ocr_output,
    );
    assert.throws(
      () => sealWalmartListingObservationBatch(body),
      /ocr_output must contain the exact full view/,
    );
  }
});

test("rejects an opaque ID not derived from listing, slot, and asset SHA", () => {
  const body = fixture();
  body.image_bindings[0].image_id = "i_aaaaaaaaaaaaaaaaaaaa";
  assert.throws(() => sealWalmartListingObservationBatch(body), /image_id is not derived/);
});

test("rejects prompt, call-key, and structured result tamper", () => {
  for (const mutate of [
    (body) => { body.prompt.sha256 = "0".repeat(64); },
    (body) => { body.call_key = "0".repeat(64); },
    (body) => { body.result.observations[0].visible_brand_text = "Other"; },
  ]) {
    const body = fixture();
    mutate(body);
    assert.throws(() => sealWalmartListingObservationBatch(body));
  }
});

test("rejects retry, fallback, paid, or OpenAI execution claims", () => {
  for (const key of ["retries", "fallbacks", "paid_api_calls", "openai_model_calls"]) {
    const body = fixture();
    body.execution[key] = 1;
    assert.throws(() => sealWalmartListingObservationBatch(body), /one attested call/);
  }
});

test("rejects resealed field tamper and OCR provenance mismatch", () => {
  const sealed = sealWalmartListingObservationBatch(fixture());
  const changed = structuredClone(sealed);
  changed.worker_contract.cli_version = "attacker";
  changed.body_sha256 = walmartListingObservationSha256(
    Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "artifact_id" && key !== "body_sha256")),
  );
  assert.throws(() => verifyWalmartListingObservationBatch(changed));

  const forgedReceipt = fixture();
  forgedReceipt.worker_receipt.body.result_canonical_sha256 = "1".repeat(64);
  assert.throws(() => sealWalmartListingObservationBatch(forgedReceipt), /signature|exact locked/);

  const ocrMismatch = fixture();
  ocrMismatch.local_ocr[0].full_view_sha256 = "1".repeat(64);
  assert.throws(
    () => sealWalmartListingObservationBatch(ocrMismatch),
    /ocr_output must contain the exact full view|not bound/,
  );
});

test("v3 permit is bounded to 24h, sealed, partition-bound, and must include the shard", () => {
  for (const mutate of [
    (body) => { body.execution_permit.body.expires_at = "2026-07-19T19:00:00.001Z"; },
    (body) => { body.execution_permit.body.shard_ids = ["shard-other"]; },
    (body) => { body.execution_permit.body.partition_id = "partition-other"; },
    (body) => { body.execution_permit.body.schema_version = "walmart-listing-integrity-execution-permit/v1"; },
    (body) => { delete body.execution_permit.body.owner_authorization; },
    (body) => { body.execution_permit.body.unexpected = true; },
  ]) {
    const body = fixture();
    mutate(body);
    resealPermit(body.execution_permit);
    assert.throws(() => sealWalmartListingObservationBatch(body), /permit|exact locked/);
  }
});

test("signed reservation must precede permit expiry and issued_at stays within timeout plus margin", () => {
  for (const [reservation, issued] of [
    ["2026-07-19T19:00:00.000Z", "2026-07-19T19:00:00.000Z"],
    ["2026-07-18T20:00:00.000Z", "2026-07-18T20:03:31.000Z"],
    ["2026-07-18T20:00:01.000Z", "2026-07-18T20:00:00.000Z"],
  ]) {
    const body = fixture();
    body.worker_receipt.body.reservation_reserved_at = reservation;
    body.worker_receipt.body.issued_at = issued;
    resignReceipt(body.worker_receipt);
    assert.throws(() => sealWalmartListingObservationBatch(body), /exact locked/);
  }
});

test("observation created_at is the signed server reservation, not the client attempt clock", () => {
  const body = fixture();
  body.created_at = "2026-07-18T20:00:00.100Z";
  assert.throws(
    () => sealWalmartListingObservationBatch(body),
    /signed server reservation timestamp/,
  );
  body.worker_receipt.body.reservation_reserved_at = body.created_at;
  resignReceipt(body.worker_receipt);
  assert.doesNotThrow(() => sealWalmartListingObservationBatch(body));
});

test("signed reservation requires the full timeout plus margin of permit headroom", () => {
  const exact = fixture();
  exact.execution_permit.body.created_at = "2026-07-17T20:03:30.000Z";
  exact.execution_permit.body.expires_at = "2026-07-18T20:03:30.000Z";
  resealPermit(exact.execution_permit);
  exact.worker_receipt.body.request_attestation.execution_permit_sha256 =
    exact.execution_permit.sha256;
  exact.worker_receipt.body.reservation_reserved_at = "2026-07-18T20:00:00.000Z";
  exact.worker_receipt.body.issued_at = exact.execution_permit.body.expires_at;
  exact.created_at = exact.worker_receipt.body.reservation_reserved_at;
  resignReceipt(exact.worker_receipt);
  assert.doesNotThrow(() => sealWalmartListingObservationBatch(exact));

  const oneMillisecondShort = fixture();
  oneMillisecondShort.execution_permit.body.created_at = "2026-07-17T20:03:29.999Z";
  oneMillisecondShort.execution_permit.body.expires_at = "2026-07-18T20:03:29.999Z";
  resealPermit(oneMillisecondShort.execution_permit);
  oneMillisecondShort.worker_receipt.body.request_attestation.execution_permit_sha256 =
    oneMillisecondShort.execution_permit.sha256;
  oneMillisecondShort.worker_receipt.body.reservation_reserved_at =
    "2026-07-18T20:00:00.000Z";
  oneMillisecondShort.worker_receipt.body.issued_at = "2026-07-18T20:00:01.000Z";
  oneMillisecondShort.created_at =
    oneMillisecondShort.worker_receipt.body.reservation_reserved_at;
  resignReceipt(oneMillisecondShort.worker_receipt);
  assert.throws(
    () => sealWalmartListingObservationBatch(oneMillisecondShort),
    /exact locked request\/result\/runtime\/subscription policy mismatch/,
  );
});

test("seals an ambiguous attempt only as all-image TECH_ERROR/REVIEW", () => {
  const terminal = sealWalmartListingObservationTechnicalErrorTerminal(terminalFixture());
  assert.deepEqual(
    verifyWalmartListingObservationTechnicalErrorTerminal(terminal),
    terminal,
  );
  assert.deepEqual(verifyWalmartListingObservationArtifact(terminal), terminal);
  assert.equal(terminal.execution.pass_eligible, false);
  assert.equal(terminal.image_outcomes.every((row) => (
    row.outcome === "TECH_ERROR" && row.required_action === "REVIEW"
  )), true);
  assert.equal("result" in terminal, false);
  assert.equal("worker_receipt" in terminal, false);
  assert.deepEqual(terminal.worker_contract.reservation_ledger, RESERVATION_LEDGER);
});

test("technical-error terminal rejects PASS, partial coverage, and attempt/permit tamper", () => {
  for (const mutate of [
    (body) => { body.image_outcomes[0].outcome = "PASS"; },
    (body) => { body.image_outcomes = []; },
    (body) => { body.execution.pass_eligible = true; },
    (body) => { body.call_key = "0".repeat(64); },
    (body) => { delete body.worker_contract.reservation_ledger; },
    (body) => { body.worker_contract.reservation_ledger.unexpected = true; },
    (body) => {
      body.worker_contract.reservation_ledger.ledger_epoch =
        "epoch-44444444-4444-4444-8444-444444444444";
    },
    (body) => { body.execution_permit.body.shard_ids = ["shard-other"]; resealPermit(body.execution_permit); },
  ]) {
    const body = terminalFixture();
    mutate(body);
    assert.throws(() => sealWalmartListingObservationTechnicalErrorTerminal(body));
  }
});

test("technical-error terminal rejects a reservation without full permit headroom", () => {
  const body = terminalFixture();
  body.execution_permit.body.created_at = "2026-07-17T20:03:29.999Z";
  body.execution_permit.body.expires_at = "2026-07-18T20:03:29.999Z";
  resealPermit(body.execution_permit);
  assert.throws(
    () => sealWalmartListingObservationTechnicalErrorTerminal(body),
    /timing is outside its permit\/reservation bounds/,
  );
});
