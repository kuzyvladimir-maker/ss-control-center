import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHANNELMAX_OWNER_APPROVAL_SCHEMA,
  ChannelMaxContractError,
  classifyExpiredChannelMaxLease,
  deriveTerminalDecision,
  parseApproveChannelMaxAgentJob,
  parseChannelMaxWorkerEvent,
  parseClaimChannelMaxAgentJob,
  parseCompleteChannelMaxAgentJob,
  parseCreateChannelMaxAgentJob,
  sha256Json,
} from "../contracts";

const DIGEST = "a".repeat(64);
const EVIDENCE = {
  kind: "SCREENSHOT",
  sha256: "b".repeat(64),
  byte_size: 1234,
  media_type: "image/png",
  captured_at: "2026-07-18T19:00:00.000Z",
  uri: "https://evidence.example/channelmax/screenshot.png",
};

function validUploadRequest() {
  return {
    operation: "UPLOAD_MANUAL_ASSIGNMENT",
    idempotency_key: "channelmax:upload:artifact-a",
    payload: {
      account_id: "salutem-us",
      expected_active_rows: 162,
      assignment_artifact: {
        download_url: "https://artifacts.example/uncrustables.tsv",
        sha256: DIGEST,
        byte_size: 45123,
        media_type: "text/tab-separated-values",
      },
      manual_model_id: "59021",
      manual_model_name: "Manual",
      selling_venue: "AmazonUS",
      required_skip_rules: ["44a", "44b"],
    },
  };
}

test("create contract accepts only the sealed high-level upload operation", () => {
  const parsed = parseCreateChannelMaxAgentJob(validUploadRequest());
  assert.equal(parsed.operation, "UPLOAD_MANUAL_ASSIGNMENT");
  assert.equal(parsed.payload.account_id, "salutem-us");
});

test("create contract rejects arbitrary browser commands and selectors", () => {
  assert.throws(
    () =>
      parseCreateChannelMaxAgentJob({
        operation: "EVALUATE_JAVASCRIPT",
        idempotency_key: "channelmax:arbitrary:1",
        payload: { account_id: "salutem-us", expected_active_rows: 162 },
      }),
    ChannelMaxContractError,
  );
  const request = validUploadRequest() as Record<string, unknown>;
  request.selector = "#upload";
  assert.throws(
    () => parseCreateChannelMaxAgentJob(request),
    /unsupported field.*selector/i,
  );
});

test("create contract cannot self-assert owner approval", () => {
  const request = {
    ...validUploadRequest(),
    owner_approval: {
      approved: true,
      assignment_sha256: DIGEST,
    },
  };
  assert.throws(
    () => parseCreateChannelMaxAgentJob(request),
    /unsupported field.*owner_approval/i,
  );
});

test("read-only jobs reject owner approval", () => {
  assert.throws(
    () =>
      parseCreateChannelMaxAgentJob({
        operation: "SNAPSHOT_INVENTORY",
        idempotency_key: "channelmax:snapshot:1",
        payload: {
          account_id: "salutem-us",
          expected_active_rows: 162,
          include_inactive: false,
        },
        owner_approval: { approved: true },
      }),
    /unsupported field.*owner_approval/i,
  );
});

test("independent approval contract binds the complete canonical plan", () => {
  const parsed = parseApproveChannelMaxAgentJob(
    {
      schema_version: CHANNELMAX_OWNER_APPROVAL_SCHEMA,
      job_id: "cm-job-123",
      operation: "UPLOAD_MANUAL_ASSIGNMENT",
      account_id: "salutem-us",
      manual_model_id: "59021",
      manual_model_name: "Manual",
      expected_active_rows: 162,
      assignment_sha256: DIGEST,
      payload_sha256: "c".repeat(64),
      request_sha256: "d".repeat(64),
      mutation_plan_sha256: "e".repeat(64),
      expires_at: "2026-07-18T20:00:00.000Z",
      nonce: "owner-approval-nonce-0001",
      step_up_assertion_id: "step-up-assertion-0001",
    },
    new Date("2026-07-18T19:00:00.000Z"),
  );
  assert.equal(parsed.assignment_sha256, DIGEST);
  assert.equal(parsed.expected_active_rows, 162);
  assert.throws(
    () =>
      parseApproveChannelMaxAgentJob(
        { ...parsed, selector: "#upload" },
        new Date("2026-07-18T19:00:00.000Z"),
      ),
    /unsupported field.*selector/i,
  );
});

test("worker event stores evidence metadata only and rejects extra commands", () => {
  const parsed = parseChannelMaxWorkerEvent(
    {
      event_key: "event:evidence:1",
      lease_token: "d".repeat(64),
      type: "EVIDENCE_CAPTURED",
      occurred_at: "2026-07-18T19:00:00.000Z",
      step: "post-upload-screenshot",
      evidence: [EVIDENCE],
    },
    new Date("2026-07-18T19:00:05.000Z"),
  );
  assert.equal(parsed.evidence[0]?.sha256, EVIDENCE.sha256);
  assert.throws(
    () =>
      parseChannelMaxWorkerEvent(
        {
          event_key: "event:bad-js:1",
          lease_token: "d".repeat(64),
          type: "PROGRESS",
          javascript: "document.querySelector('button').click()",
        },
        new Date("2026-07-18T19:00:05.000Z"),
      ),
    /unsupported field.*javascript/i,
  );
});

test("worker claims default to read-only operations and mutation fences require evidence", () => {
  const claim = parseClaimChannelMaxAgentJob({
    worker_id: "openclaw-imac",
  });
  assert.equal(claim.supported_operations.includes("UPLOAD_MANUAL_ASSIGNMENT"), false);
  assert.throws(
    () =>
      parseChannelMaxWorkerEvent(
        {
          event_key: "mutation:started:no-evidence",
          lease_token: "d".repeat(64),
          type: "MUTATION_STARTED",
          occurred_at: "2026-07-18T19:00:00.000Z",
        },
        new Date("2026-07-18T19:00:00.000Z"),
      ),
    /MUTATION_STARTED requires at least one immutable evidence/i,
  );
});

test("mutation completion requires the pre-write fence and completed task receipt", () => {
  const completion = parseCompleteChannelMaxAgentJob({
    completion_key: "complete:upload:1",
    lease_token: "d".repeat(64),
    status: "SUCCEEDED",
    mutation_outcome: "CONFIRMED_APPLIED",
    message: "Upload completed.",
    result: { upload_task_id: "CM-123", upload_status: "COMPLETED" },
    evidence: [EVIDENCE],
  });
  assert.throws(
    () =>
      deriveTerminalDecision({
        mutation: true,
        mutationStarted: false,
        operation: "UPLOAD_MANUAL_ASSIGNMENT",
        completion,
      }),
    /MUTATION_STARTED fence/i,
  );
  assert.deepEqual(
    deriveTerminalDecision({
      mutation: true,
      mutationStarted: true,
      operation: "UPLOAD_MANUAL_ASSIGNMENT",
      completion,
    }),
    { status: "SUCCEEDED", mutationOutcome: "CONFIRMED_APPLIED" },
  );
});

test("expired mutation lease is ambiguous only after external-write fence", () => {
  assert.equal(
    classifyExpiredChannelMaxLease({
      mutation: true,
      mutationStarted: true,
      attempts: 1,
      maxAttempts: 3,
    }),
    "AMBIGUOUS",
  );
  assert.equal(
    classifyExpiredChannelMaxLease({
      mutation: true,
      mutationStarted: false,
      attempts: 1,
      maxAttempts: 3,
    }),
    "REQUEUE",
  );
  assert.equal(
    classifyExpiredChannelMaxLease({
      mutation: false,
      mutationStarted: false,
      attempts: 3,
      maxAttempts: 3,
    }),
    "FAILED",
  );
});

test("canonical request/evidence digest is independent of object key order", () => {
  assert.equal(sha256Json({ a: 1, b: 2 }), sha256Json({ b: 2, a: 1 }));
});
