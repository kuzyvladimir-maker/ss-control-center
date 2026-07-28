import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import type {
  ChannelMaxEvidenceRef,
  ChannelMaxWorkerEventInput,
  CompleteChannelMaxAgentJobInput,
} from "../contracts";
import { sha256Json } from "../contracts";
import {
  buildChannelMaxVcCanaryJobRequest,
  channelMaxVcCanaryArtifact,
  CHANNELMAX_VC_CANARY,
  CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA,
  ChannelMaxVcCanaryError,
  executeChannelMaxVcCanaryProduction,
  executeChannelMaxVcCanaryTestOnly,
  parseChannelMaxVcCanaryClaim,
  type ChannelMaxVcAnalysisPreview,
  type ChannelMaxVcBrowserPort,
  type ChannelMaxVcCanaryDirection,
  type ChannelMaxVcClaim,
  type ChannelMaxVcControlPlanePort,
  type ChannelMaxVcLocalEvidence,
  type ChannelMaxVcRowSnapshot,
} from "../uncrustables-same-model-canary";

const NOW = new Date("2026-07-18T23:00:00.000Z");

function claimFixture(
  direction: ChannelMaxVcCanaryDirection,
  overrides: Record<string, unknown> = {},
) {
  const request = buildChannelMaxVcCanaryJobRequest(direction);
  const jobId = `cm-vc-${direction.toLowerCase()}-001`;
  const payloadSha256 = sha256Json(request.payload);
  const requestSha256 = sha256Json(request);
  const mutationPlanSha256 = sha256Json({
    operation: request.operation,
    payload: request.payload,
  });
  return {
    claimed: true,
    lease_token: "a".repeat(64),
    lease_expires_at: "2026-07-18T23:05:00.000Z",
    job: {
      id: jobId,
      operation: request.operation,
      mutation: true,
      account_id: CHANNELMAX_VC_CANARY.account_id,
      payload: request.payload,
      payload_sha256: payloadSha256,
      request_sha256: requestSha256,
      mutation_plan_sha256: mutationPlanSha256,
      idempotency_key: request.idempotency_key,
      priority: request.priority,
      attempts: 1,
      max_attempts: 1,
      owner_approval: {
        approved: true,
        approved_by: "vladimir",
        approved_by_id: "user-vladimir",
        approved_at: "2026-07-18T22:59:00.000Z",
        assignment_sha256: channelMaxVcCanaryArtifact(direction).sha256,
        approval_sha256: "b".repeat(64),
        expires_at: "2026-07-18T23:30:00.000Z",
        nonce: "vc-canary-owner-nonce-0001",
        step_up_assertion_id: "step-up-vc-001",
        step_up_method: "PASSWORD_REAUTH",
        step_up_ceremony_id: "ceremony-vc-001",
        step_up_verified_at: "2026-07-18T22:58:30.000Z",
      },
      approval_plan: {
        schema_version: "channelmax-owner-approval/v1",
        job_id: jobId,
        operation: request.operation,
        account_id: CHANNELMAX_VC_CANARY.account_id,
        manual_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
        manual_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
        expected_active_rows: 1,
        assignment_sha256: channelMaxVcCanaryArtifact(direction).sha256,
        payload_sha256: payloadSha256,
        request_sha256: requestSha256,
        mutation_plan_sha256: mutationPlanSha256,
      },
      ...overrides,
    },
    protocol: {
      before_external_write:
        "POST MUTATION_STARTED and wait for its successful acknowledgement; otherwise DO NOT click Upload/Submit.",
      after_external_write:
        "Report CONFIRMED_APPLIED, CONFIRMED_NOT_APPLIED, or AMBIGUOUS with evidence; never guess and never retry an ambiguous mutation.",
    },
  };
}

function state(
  direction: ChannelMaxVcCanaryDirection,
  phase: "PREWRITE" | "POSTWRITE",
) {
  if (direction === "FORWARD") {
    return phase === "PREWRITE"
      ? CHANNELMAX_VC_CANARY.rollback
      : CHANNELMAX_VC_CANARY.forward;
  }
  return phase === "PREWRITE"
    ? CHANNELMAX_VC_CANARY.forward
    : CHANNELMAX_VC_CANARY.rollback;
}

class FakeBrowser implements ChannelMaxVcBrowserPort {
  submitCalls = 0;
  verifyCalls = 0;
  log: string[] = [];
  throwOnSubmit = false;

  constructor(
    readonly direction: ChannelMaxVcCanaryDirection,
    readonly timeline: string[] = [],
  ) {}

  private note(value: string): void {
    this.log.push(value);
    this.timeline.push(`browser:${value}`);
  }

  async assertExactContext() {
    this.note("context");
    return {
      protocol: "https:" as const,
      host: CHANNELMAX_VC_CANARY.host,
      selectedSiteId: CHANNELMAX_VC_CANARY.selected_site_id,
      selectedSiteName: CHANNELMAX_VC_CANARY.selected_site_name,
    };
  }

  async snapshot(
    direction: ChannelMaxVcCanaryDirection,
    phase: "PREWRITE" | "POSTWRITE",
    uploadTaskId: string | null,
  ): Promise<ChannelMaxVcRowSnapshot> {
    this.note(`snapshot:${phase}`);
    const expected = state(direction, phase);
    return {
      schema_version: CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA,
      captured_at:
        phase === "PREWRITE"
          ? "2026-07-18T23:00:01.000Z"
          : "2026-07-18T23:00:10.000Z",
      phase,
      direction,
      account_id: CHANNELMAX_VC_CANARY.account_id,
      selected_site_id: CHANNELMAX_VC_CANARY.selected_site_id,
      selected_site_name: CHANNELMAX_VC_CANARY.selected_site_name,
      assignment_sha256: channelMaxVcCanaryArtifact(direction).sha256,
      baseline_inventory_snapshot_sha256:
        CHANNELMAX_VC_CANARY.prewrite_snapshot_sha256,
      upload_task_id: uploadTaskId,
      row: {
        sku: CHANNELMAX_VC_CANARY.sku,
        asin: CHANNELMAX_VC_CANARY.asin,
        repricing_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
        repricing_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
        minimum_price: expected.minimum_price,
        maximum_price: expected.maximum_price,
      },
    };
  }

  async captureScreenshot(
    label: "ANALYZED" | "POSTWRITE" | "AMBIGUOUS",
  ): Promise<ChannelMaxVcLocalEvidence> {
    this.note(`screenshot:${label}`);
    return {
      kind: "SCREENSHOT",
      mediaType: "image/png",
      capturedAt: "2026-07-18T23:00:10.000Z",
      bytes: Buffer.from(`fake-png:${label}`),
    };
  }

  async analyzeExactArtifact(): Promise<ChannelMaxVcAnalysisPreview> {
    this.note("analyze");
    const expected =
      this.direction === "FORWARD"
        ? CHANNELMAX_VC_CANARY.forward
        : CHANNELMAX_VC_CANARY.rollback;
    return {
      columns: [
        "SKU",
        "ASIN",
        "SellingVenue",
        "MinSellingPrice",
        "MaxSellingPrice",
      ],
      rows: 1,
      sku: CHANNELMAX_VC_CANARY.sku,
      asin: CHANNELMAX_VC_CANARY.asin,
      sellingVenue: "AmazonUS",
      minimumPrice: expected.minimum_price,
      maximumPrice: expected.maximum_price,
      validateOnly: false,
      dontTouchExistingSkus: false,
      unmatchedColumns: 0,
      errors: 0,
    };
  }

  async submitAnalyzedFileOnce() {
    this.note("submit");
    this.submitCalls += 1;
    if (this.throwOnSubmit) throw new Error("connection reset after click");
    return { uploadTaskId: "CM-VC-327781" };
  }

  async verifyUploadTask(uploadTaskId: string) {
    this.note("verify-task");
    this.verifyCalls += 1;
    return {
      uploadTaskId,
      status: "COMPLETED" as const,
      rowsProcessed: 1,
      rowsSucceeded: 1,
      rowsFailed: 0,
    };
  }
}

class FakeControlPlane implements ChannelMaxVcControlPlanePort {
  events: ChannelMaxWorkerEventInput[] = [];
  completions: CompleteChannelMaxAgentJobInput[] = [];
  log: string[] = [];

  constructor(
    readonly direction: ChannelMaxVcCanaryDirection,
    readonly timeline: string[] = [],
  ) {}

  private note(value: string): void {
    this.log.push(value);
    this.timeline.push(`control:${value}`);
  }

  async downloadArtifact() {
    this.note("download");
    return channelMaxVcCanaryArtifact(this.direction).bytes;
  }

  async uploadEvidence(
    _claim: ChannelMaxVcClaim,
    evidence: ChannelMaxVcLocalEvidence,
  ): Promise<ChannelMaxEvidenceRef> {
    this.note(`evidence:${evidence.kind}`);
    return {
      kind: evidence.kind,
      sha256: createHash("sha256").update(evidence.bytes).digest("hex"),
      byte_size: evidence.bytes.byteLength,
      media_type: evidence.mediaType,
      captured_at: evidence.capturedAt,
      uri: `https://ss-control-center.vercel.app/api/openclaw/channelmax/jobs/cm-vc/evidence/${this.log.length}`,
    };
  }

  async heartbeat() {}

  async appendEvent(_jobId: string, input: ChannelMaxWorkerEventInput) {
    this.note(`event:${input.type}`);
    this.events.push(input);
  }

  async complete(_jobId: string, input: CompleteChannelMaxAgentJobInput) {
    this.note(`complete:${input.status}`);
    this.completions.push(input);
  }
}

before(() => {
  process.env.CHANNELMAX_VC_CANARY_TEST_ONLY = "true";
});

after(() => {
  delete process.env.CHANNELMAX_VC_CANARY_TEST_ONLY;
});

test("sealed forward and rollback artifacts contain only the exact same-model VC row", () => {
  const forward = channelMaxVcCanaryArtifact("FORWARD");
  const rollback = channelMaxVcCanaryArtifact("ROLLBACK");
  assert.equal(forward.byteSize, 103);
  assert.equal(rollback.byteSize, 103);
  assert.equal(forward.sha256, CHANNELMAX_VC_CANARY.forward.assignment_sha256);
  assert.equal(rollback.sha256, CHANNELMAX_VC_CANARY.rollback.assignment_sha256);
  for (const artifact of [forward, rollback]) {
    const text = artifact.bytes.toString("utf8");
    assert.match(text, /VC-ASV1-378P\tB0H786L5MW\tAmazonUS/);
    assert.doesNotMatch(text, /SZ-ASPI-JFAT|TY-AST2-JE9P|VN-AS1A-D572/);
    assert.equal(text.split("\r\n").filter(Boolean).length, 2);
  }
});

test("claim requires the exact one-attempt request and real-admin approval", () => {
  const valid = parseChannelMaxVcCanaryClaim(claimFixture("FORWARD"), NOW);
  assert.equal(valid.job.direction, "FORWARD");
  assert.equal(valid.job.maxAttempts, 1);

  const synthetic = claimFixture("FORWARD");
  (synthetic.job.owner_approval as Record<string, unknown>).approved_by_id =
    "system:jackie";
  assert.throws(
    () => parseChannelMaxVcCanaryClaim(synthetic, NOW),
    (error: unknown) =>
      error instanceof ChannelMaxVcCanaryError &&
      error.code === "OWNER_APPROVAL_INVALID",
  );

  const retryable = claimFixture("FORWARD", { max_attempts: 2 });
  assert.throws(
    () => parseChannelMaxVcCanaryClaim(retryable, NOW),
    (error: unknown) =>
      error instanceof ChannelMaxVcCanaryError &&
      error.code === "CANARY_JOB_BINDING_MISMATCH",
  );
});

test("forward executes one fenced submit, verifies task and postwrite state, then emits rollback/hold specs", async () => {
  const timeline: string[] = [];
  const browser = new FakeBrowser("FORWARD", timeline);
  const controlPlane = new FakeControlPlane("FORWARD", timeline);
  const result = await executeChannelMaxVcCanaryTestOnly({
    rawClaim: claimFixture("FORWARD"),
    browser,
    controlPlane,
    now: () => new Date(NOW),
  });
  assert.equal(result.outcome, "CONFIRMED_APPLIED");
  assert.equal(browser.submitCalls, 1);
  assert.equal(browser.verifyCalls, 1);
  assert.equal(
    controlPlane.events.filter((event) => event.type === "MUTATION_STARTED").length,
    1,
  );
  assert.ok(
    timeline.indexOf("control:event:MUTATION_STARTED") <
      timeline.indexOf("browser:submit"),
  );
  assert.equal(controlPlane.completions[0]?.status, "SUCCEEDED");
  assert.equal(controlPlane.completions[0]?.mutation_outcome, "CONFIRMED_APPLIED");
  assert.equal(
    (result.rollbackJob.payload as { assignment_artifact: { sha256: string } })
      .assignment_artifact.sha256,
    CHANNELMAX_VC_CANARY.rollback.assignment_sha256,
  );
  assert.equal(result.verifyTaskJob?.operation, "VERIFY_UPLOAD_TASK");
  assert.equal(result.holdJob?.operation, "OBSERVE_POST_UPLOAD_HOLD");
});

test("rollback uses its own exact approval/artifact and restores old bounds under model 59021", async () => {
  const browser = new FakeBrowser("ROLLBACK");
  const controlPlane = new FakeControlPlane("ROLLBACK");
  const result = await executeChannelMaxVcCanaryTestOnly({
    rawClaim: claimFixture("ROLLBACK"),
    browser,
    controlPlane,
    now: () => new Date(NOW),
  });
  assert.equal(result.direction, "ROLLBACK");
  assert.equal(result.outcome, "CONFIRMED_APPLIED");
  assert.equal(browser.submitCalls, 1);
  const completion = controlPlane.completions[0]!;
  assert.equal(
    completion.result.assignment_sha256,
    CHANNELMAX_VC_CANARY.rollback.assignment_sha256,
  );
  assert.equal(completion.result.manual_model_id, "59021");
});

test("an exception after the fence is terminal ambiguity and never retries submit", async () => {
  const browser = new FakeBrowser("FORWARD");
  browser.throwOnSubmit = true;
  const controlPlane = new FakeControlPlane("FORWARD");
  const result = await executeChannelMaxVcCanaryTestOnly({
    rawClaim: claimFixture("FORWARD"),
    browser,
    controlPlane,
    now: () => new Date(NOW),
  });
  assert.equal(result.outcome, "AMBIGUOUS");
  assert.equal(browser.submitCalls, 1);
  assert.equal(browser.verifyCalls, 0);
  assert.equal(controlPlane.completions[0]?.status, "AMBIGUOUS");
  assert.equal(controlPlane.completions[0]?.mutation_outcome, "AMBIGUOUS");
  assert.equal(
    controlPlane.events.filter((event) => event.type === "MUTATION_AMBIGUOUS")
      .length,
    1,
  );
});

test("production entrypoint remains hard disabled before touching any port", async () => {
  const browser = new FakeBrowser("FORWARD");
  const controlPlane = new FakeControlPlane("FORWARD");
  await assert.rejects(
    executeChannelMaxVcCanaryProduction({
      rawClaim: claimFixture("FORWARD"),
      browser,
      controlPlane,
    }),
    (error: unknown) =>
      error instanceof ChannelMaxVcCanaryError &&
      error.code === "PRODUCTION_RELEASE_GATE_DISABLED",
  );
  assert.equal(browser.log.length, 0);
  assert.equal(controlPlane.log.length, 0);
});
