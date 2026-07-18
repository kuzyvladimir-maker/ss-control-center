import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createClient } from "@libsql/client";
import { NextRequest, NextResponse } from "next/server";

import {
  parseApproveChannelMaxAgentJob,
  parseChannelMaxWorkerEvent,
  parseCompleteChannelMaxAgentJob,
  parseCreateChannelMaxAgentJob,
} from "../contracts";

const DIGEST = "a".repeat(64);
const CAPTURED_AT = "2026-07-18T19:00:00.000Z";
const WORKER_ACTOR_ID = "system:jackie";
const OWNER_APPROVER = {
  actor: "vladimir",
  actorId: "user-vladimir",
};
const EVIDENCE = {
  kind: "SCREENSHOT" as const,
  sha256: "b".repeat(64),
  byte_size: 1234,
  media_type: "image/png",
  captured_at: CAPTURED_AT,
  uri: "https://evidence.example/channelmax/screenshot.png",
};
const UPLOAD_SOURCE_EVIDENCE = {
  kind: "UPLOAD_SOURCE" as const,
  sha256: DIGEST,
  byte_size: 45123,
  media_type: "text/tab-separated-values",
  captured_at: CAPTURED_AT,
  uri: "https://artifacts.example/uncrustables.tsv",
};

let tempDir = "";
let service: typeof import("../service");
let db: typeof import("@/lib/prisma").prisma;

function uploadRequest(idempotencyKey: string) {
  return parseCreateChannelMaxAgentJob({
    operation: "UPLOAD_MANUAL_ASSIGNMENT",
    idempotency_key: idempotencyKey,
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
  });
}

function snapshotRequest(idempotencyKey: string, maxAttempts = 2) {
  return parseCreateChannelMaxAgentJob({
    operation: "SNAPSHOT_INVENTORY",
    idempotency_key: idempotencyKey,
    max_attempts: maxAttempts,
    payload: {
      account_id: "salutem-us",
      expected_active_rows: 162,
      include_inactive: false,
    },
  });
}

async function approveUpload(
  job: {
    id: string;
    approval_plan: Record<string, unknown> | null;
  },
  now: Date,
  nonce: string,
) {
  assert.ok(job.approval_plan);
  return service.approveChannelMaxAgentJob(
    job.id,
    parseApproveChannelMaxAgentJob(
      {
        ...job.approval_plan,
        expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
        nonce,
      },
      now,
    ),
    OWNER_APPROVER,
    now,
  );
}

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "channelmax-agent-test-"));
  const databasePath = path.join(tempDir, "bridge.db");
  process.env.DATABASE_URL = `file:${databasePath}`;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  const migration = await readFile(
    path.join(
      process.cwd(),
      "prisma/migrations/20260718193000_channelmax_agent_job/migration.sql",
    ),
    "utf8",
  );
  const client = createClient({ url: process.env.DATABASE_URL });
  await client.executeMultiple(migration);
  client.close();

  service = await import("../service");
  db = (await import("@/lib/prisma")).prisma;
});

after(async () => {
  await db?.$disconnect();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("create is idempotent and conflicting reuse is rejected", async () => {
  const input = snapshotRequest("channelmax:snapshot:idempotent");
  const first = await service.createChannelMaxAgentJob(input, "admin");
  const replay = await service.createChannelMaxAgentJob(input, "admin");
  assert.equal(first.created, true);
  assert.equal(replay.idempotent_replay, true);

  const changed = snapshotRequest("channelmax:snapshot:idempotent");
  changed.priority = 10;
  await assert.rejects(
    service.createChannelMaxAgentJob(changed, "admin"),
    /idempotency key already belongs to a different/i,
  );

  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["SNAPSHOT_INVENTORY"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T18:00:00.000Z"),
  );
  assert.equal(claimed.job?.id, first.job.id);
  await service.completeChannelMaxAgentJob(
    first.job.id,
    parseCompleteChannelMaxAgentJob({
      completion_key: "completion:idempotent-cleanup",
      lease_token: claimed.lease_token,
      status: "SUCCEEDED",
      message: "Snapshot completed.",
      result: { rows: 162 },
    }),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T18:00:01.000Z"),
  );
});

test("JACKIE_API_TOKEN cannot grant independent owner approval", async () => {
  const prior = process.env.JACKIE_API_TOKEN;
  process.env.JACKIE_API_TOKEN = "jackie-channelmax-test-token";
  try {
    const { requireChannelMaxOwnerSessionAdmin } = await import("../http");
    const result = await requireChannelMaxOwnerSessionAdmin(
      new NextRequest("https://sscc.example/api/openclaw/channelmax/jobs/x/approve", {
        headers: {
          authorization: "Bearer jackie-channelmax-test-token",
        },
      }),
    );
    assert.ok(result instanceof NextResponse);
    assert.equal(result.status, 403);
    assert.equal((await result.json()).error, "OWNER_SESSION_REQUIRED");
  } finally {
    if (prior === undefined) delete process.env.JACKIE_API_TOKEN;
    else process.env.JACKIE_API_TOKEN = prior;
  }
});

test("same worker event is replay-safe and conflicting metadata is rejected", async () => {
  const created = await service.createChannelMaxAgentJob(
    snapshotRequest("channelmax:snapshot:event-replay"),
    "admin",
  );
  const jobId = created.job.id;
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["SNAPSHOT_INVENTORY"],
      lease_seconds: 120,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:00:00.000Z"),
  );
  assert.equal(claimed.claimed, true);
  assert.ok(claimed.lease_token);

  const event = parseChannelMaxWorkerEvent(
    {
      event_key: "progress:event-replay:1",
      lease_token: claimed.lease_token,
      type: "PROGRESS",
      occurred_at: CAPTURED_AT,
      message: "Reading inventory.",
    },
    new Date(CAPTURED_AT),
  );
  await assert.rejects(
    service.appendChannelMaxAgentEvent(
      jobId,
      event,
      "system:different-worker",
      new Date(CAPTURED_AT),
    ),
    /does not own this worker lease/i,
  );
  const first = await service.appendChannelMaxAgentEvent(
    jobId,
    event,
    WORKER_ACTOR_ID,
    new Date(CAPTURED_AT),
  );
  const replay = await service.appendChannelMaxAgentEvent(
    jobId,
    event,
    WORKER_ACTOR_ID,
    new Date(CAPTURED_AT),
  );
  assert.equal(first.idempotent_replay, false);
  assert.equal(replay.idempotent_replay, true);

  await assert.rejects(
    service.appendChannelMaxAgentEvent(
      jobId,
      { ...event, message: "Different message." },
      WORKER_ACTOR_ID,
      new Date(CAPTURED_AT),
    ),
    /event_key already exists with different/i,
  );
  const storedEvent = await db.channelMaxAgentEvent.findUniqueOrThrow({
    where: {
      jobId_eventKey: { jobId, eventKey: event.event_key },
    },
  });
  await assert.rejects(
    db.channelMaxAgentEvent.update({
      where: { id: storedEvent.id },
      data: { message: "Tampered evidence." },
    }),
  );
  await assert.rejects(
    db.channelMaxAgentEvent.delete({ where: { id: storedEvent.id } }),
  );
  const immutableEvent = await db.channelMaxAgentEvent.findUniqueOrThrow({
    where: { id: storedEvent.id },
  });
  assert.equal(immutableEvent.message, "Reading inventory.");
  await service.completeChannelMaxAgentJob(
    jobId,
    parseCompleteChannelMaxAgentJob({
      completion_key: "completion:event-replay:1",
      lease_token: claimed.lease_token,
      status: "SUCCEEDED",
      message: "Snapshot captured.",
      result: { rows: 162 },
    }),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:00:01.000Z"),
  );
});

test("mutation remains unclaimable until independently owner-approved", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:pending-owner"),
    "jackie@openclaw",
  );
  assert.equal(created.job.status, "PENDING_APPROVAL");
  assert.ok(created.job.approval_plan);
  await assert.rejects(
    service.approveChannelMaxAgentJob(
      created.job.id,
      parseApproveChannelMaxAgentJob(
        {
          ...created.job.approval_plan,
          expires_at: "2026-07-18T19:00:00.000Z",
          nonce: "jackie-self-approval-0001",
        },
        new Date("2026-07-18T18:29:00.000Z"),
      ),
      { actor: "jackie@openclaw", actorId: "system:jackie" },
      new Date("2026-07-18T18:29:00.000Z"),
    ),
    /Synthetic API identities cannot grant/i,
  );
  const claim = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T18:30:00.000Z"),
  );
  assert.equal(claim.claimed, false);
});

test("lease expiry after MUTATION_STARTED becomes terminal AMBIGUOUS", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:ambiguous-lease"),
    "admin",
  );
  const jobId = created.job.id;
  await approveUpload(
    created.job,
    new Date("2026-07-18T18:59:00.000Z"),
    "owner-nonce-ambiguous-0001",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:00:00.000Z"),
  );
  const started = parseChannelMaxWorkerEvent(
    {
      event_key: "mutation:started:ambiguous-lease",
      lease_token: claimed.lease_token,
      type: "MUTATION_STARTED",
      occurred_at: CAPTURED_AT,
      message: "About to submit the exact approved TSV.",
      evidence: [UPLOAD_SOURCE_EVIDENCE],
    },
    new Date(CAPTURED_AT),
  );
  await service.appendChannelMaxAgentEvent(
    jobId,
    started,
    WORKER_ACTOR_ID,
    new Date(CAPTURED_AT),
  );
  await service.reapExpiredChannelMaxAgentJobs(
    new Date("2026-07-18T19:00:31.000Z"),
  );
  const status = await service.getChannelMaxAgentJob(jobId);
  assert.equal(status.status, "AMBIGUOUS");
  assert.equal(status.mutation_outcome, "AMBIGUOUS");
  assert.match(String(status.ambiguity_reason), /external state is unknown/i);
  await assert.rejects(
    service.appendChannelMaxAgentEvent(
      jobId,
      started,
      WORKER_ACTOR_ID,
      new Date("2026-07-18T19:00:31.000Z"),
    ),
    /lease is no longer active/i,
  );
});

test("read-only lease can retry before attempts are exhausted", async () => {
  const created = await service.createChannelMaxAgentJob(
    snapshotRequest("channelmax:snapshot:lease-retry", 2),
    "admin",
  );
  const jobId = created.job.id;
  await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["SNAPSHOT_INVENTORY"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T20:00:00.000Z"),
  );
  await service.createChannelMaxAgentJob(
    snapshotRequest("channelmax:snapshot:account-lock"),
    "admin",
  );
  const busy = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac-2",
      supported_operations: ["SNAPSHOT_INVENTORY"],
      lease_seconds: 30,
    },
    "system:other-worker",
    new Date("2026-07-18T20:00:01.000Z"),
  );
  assert.equal(busy.claimed, false);
  assert.equal(busy.busy, true);
  await service.reapExpiredChannelMaxAgentJobs(
    new Date("2026-07-18T20:00:31.000Z"),
  );
  assert.equal((await service.getChannelMaxAgentJob(jobId)).status, "QUEUED");
});

test("approved mutation completes only with receipt and immutable evidence", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:confirmed"),
    "admin",
  );
  const jobId = created.job.id;
  await approveUpload(
    created.job,
    new Date("2026-07-18T20:59:00.000Z"),
    "owner-nonce-confirmed-0001",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 120,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T21:00:00.000Z"),
  );
  await service.appendChannelMaxAgentEvent(
    jobId,
    parseChannelMaxWorkerEvent(
      {
        event_key: "mutation:started:confirmed",
        lease_token: claimed.lease_token,
        type: "MUTATION_STARTED",
        occurred_at: "2026-07-18T21:00:00.000Z",
        evidence: [
          {
            ...UPLOAD_SOURCE_EVIDENCE,
            captured_at: "2026-07-18T21:00:00.000Z",
          },
        ],
      },
      new Date("2026-07-18T21:00:00.000Z"),
    ),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T21:00:00.000Z"),
  );
  const beforeConfirmation = await service.getChannelMaxAgentJob(jobId);
  const boundPlan = beforeConfirmation.approval_plan;
  assert.ok(boundPlan);
  await assert.rejects(
    service.completeChannelMaxAgentJob(
      jobId,
      parseCompleteChannelMaxAgentJob({
        completion_key: "completion:without-confirmation",
        lease_token: claimed.lease_token,
        status: "SUCCEEDED",
        mutation_outcome: "CONFIRMED_APPLIED",
        message: "Must not pass without MUTATION_CONFIRMED.",
        result: {
          upload_task_id: "CM-123",
          upload_status: "COMPLETED",
          assignment_sha256: boundPlan.assignment_sha256,
          payload_sha256: boundPlan.payload_sha256,
          request_sha256: boundPlan.request_sha256,
          manual_model_id: boundPlan.manual_model_id,
          manual_model_name: boundPlan.manual_model_name,
          rows_expected: boundPlan.expected_active_rows,
          rows_submitted: boundPlan.expected_active_rows,
          rows_processed: boundPlan.expected_active_rows,
          rows_succeeded: boundPlan.expected_active_rows,
          rows_failed: 0,
        },
        evidence: [
          { ...EVIDENCE, captured_at: "2026-07-18T21:00:03.000Z" },
        ],
      }),
      WORKER_ACTOR_ID,
      new Date("2026-07-18T21:00:03.000Z"),
    ),
    /MUTATION_CONFIRMED evidence/i,
  );
  await service.appendChannelMaxAgentEvent(
    jobId,
    parseChannelMaxWorkerEvent(
      {
        event_key: "mutation:confirmed:confirmed",
        lease_token: claimed.lease_token,
        type: "MUTATION_CONFIRMED",
        occurred_at: "2026-07-18T21:00:04.000Z",
        message: "ChannelMAX shows the completed upload task.",
        evidence: [
          { ...EVIDENCE, captured_at: "2026-07-18T21:00:04.000Z" },
        ],
      },
      new Date("2026-07-18T21:00:04.000Z"),
    ),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T21:00:04.000Z"),
  );
  const approvedStatus = await service.getChannelMaxAgentJob(jobId);
  const approvalPlan = approvedStatus.approval_plan;
  assert.ok(approvalPlan);
  const completion = parseCompleteChannelMaxAgentJob({
    completion_key: "completion:upload:confirmed",
    lease_token: claimed.lease_token,
    status: "SUCCEEDED",
    mutation_outcome: "CONFIRMED_APPLIED",
    message: "ChannelMAX task completed without row errors.",
    result: {
      upload_task_id: "CM-123",
      upload_status: "COMPLETED",
      assignment_sha256: approvalPlan.assignment_sha256,
      payload_sha256: approvalPlan.payload_sha256,
      request_sha256: approvalPlan.request_sha256,
      manual_model_id: approvalPlan.manual_model_id,
      manual_model_name: approvalPlan.manual_model_name,
      rows_expected: approvalPlan.expected_active_rows,
      rows_submitted: approvalPlan.expected_active_rows,
      rows_processed: approvalPlan.expected_active_rows,
      rows_succeeded: approvalPlan.expected_active_rows,
      rows_failed: 0,
    },
    evidence: [{ ...EVIDENCE, captured_at: "2026-07-18T21:00:05.000Z" }],
  });
  const completed = await service.completeChannelMaxAgentJob(
    jobId,
    completion,
    WORKER_ACTOR_ID,
    new Date("2026-07-18T21:00:05.000Z"),
  );
  assert.equal(completed.job.status, "SUCCEEDED");
  assert.equal(completed.job.mutation_outcome, "CONFIRMED_APPLIED");

  const replay = await service.completeChannelMaxAgentJob(
    jobId,
    completion,
    WORKER_ACTOR_ID,
    new Date("2026-07-18T21:00:06.000Z"),
  );
  assert.equal(replay.idempotent_replay, true);
});

test("tampered stored payload invalidates the sealed approval before claim", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:tampered-payload"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T21:59:00.000Z"),
    "owner-nonce-tampered-0001",
  );
  const row = await db.channelMaxAgentJob.findUniqueOrThrow({
    where: { id: created.job.id },
  });
  await db.channelMaxAgentJob.update({
    where: { id: row.id },
    data: {
      payloadJson: row.payloadJson.replace(
        "https://artifacts.example/uncrustables.tsv",
        "https://artifacts.example/tampered.tsv",
      ),
    },
  });
  const claim = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T22:00:00.000Z"),
  );
  assert.equal(claim.claimed, false);
  assert.equal(
    (await service.getChannelMaxAgentJob(created.job.id)).status,
    "FAILED",
  );
});

test("contradictory external outcomes terminate the mutation as ambiguous", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:conflicting-outcomes"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T22:59:00.000Z"),
    "owner-nonce-conflict-0001",
  );
  const claim = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 120,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T23:00:00.000Z"),
  );
  await service.appendChannelMaxAgentEvent(
    created.job.id,
    parseChannelMaxWorkerEvent(
      {
        event_key: "mutation:started:conflict",
        lease_token: claim.lease_token,
        type: "MUTATION_STARTED",
        occurred_at: "2026-07-18T23:00:00.000Z",
        evidence: [
          {
            ...UPLOAD_SOURCE_EVIDENCE,
            captured_at: "2026-07-18T23:00:00.000Z",
          },
        ],
      },
      new Date("2026-07-18T23:00:00.000Z"),
    ),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T23:00:00.000Z"),
  );
  for (const [type, suffix, second] of [
    ["MUTATION_NOT_APPLIED", "not-applied", "01"],
    ["MUTATION_CONFIRMED", "confirmed", "02"],
  ] as const) {
    await service.appendChannelMaxAgentEvent(
      created.job.id,
      parseChannelMaxWorkerEvent(
        {
          event_key: `mutation:${suffix}:conflict`,
          lease_token: claim.lease_token,
          type,
          occurred_at: `2026-07-18T23:00:${second}.000Z`,
          evidence: [
            {
              ...EVIDENCE,
              captured_at: `2026-07-18T23:00:${second}.000Z`,
            },
          ],
        },
        new Date(`2026-07-18T23:00:${second}.000Z`),
      ),
      WORKER_ACTOR_ID,
      new Date(`2026-07-18T23:00:${second}.000Z`),
    );
  }
  const status = await service.getChannelMaxAgentJob(created.job.id);
  assert.equal(status.status, "AMBIGUOUS");
  assert.equal(status.mutation_outcome, "AMBIGUOUS");
  assert.match(String(status.ambiguity_reason), /Conflicting mutation outcomes/i);
});
