import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createClient } from "@libsql/client";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

import {
  parseApproveChannelMaxAgentJob,
  parseChannelMaxWorkerEvent,
  parseChannelMaxManagedEvidenceUpload,
  parseCompleteChannelMaxAgentJob,
  parseCreateChannelMaxAgentJob,
} from "../contracts";

const ASSIGNMENT_BYTES = Buffer.from(
  "SKU\tManualModel\nUNCRUSTABLES-TEST\t59021\n",
  "utf8",
);
const DIGEST = createHash("sha256").update(ASSIGNMENT_BYTES).digest("hex");
const CAPTURED_AT = "2026-07-18T19:00:00.000Z";
const WORKER_ACTOR_ID = "system:jackie";
const OWNER_APPROVER = {
  actor: "vladimir",
  actorId: "user-vladimir",
};

let tempDir = "";
let service: typeof import("../service");
let db: typeof import("@/lib/prisma").prisma;

async function managedEvidence(
  jobId: string,
  leaseToken: string | undefined,
  kind: "SCREENSHOT" | "UPLOAD_SOURCE" | "INVENTORY_EXPORT",
  capturedAt: string,
  content: Uint8Array,
  mediaType: string,
) {
  assert.ok(leaseToken);
  const storedContent =
    kind === "SCREENSHOT"
      ? await sharp({
          create: {
            width: 320,
            height: 200,
            channels: 4,
            background: {
              r: createHash("sha256").update(content).digest()[0],
              g: createHash("sha256").update(content).digest()[1],
              b: createHash("sha256").update(content).digest()[2],
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer()
      : content;
  const stored = await service.storeChannelMaxAgentEvidence(
    jobId,
    parseChannelMaxManagedEvidenceUpload(
      {
        lease_token: leaseToken,
        kind,
        media_type: mediaType,
        captured_at: capturedAt,
      },
      new Date(capturedAt),
    ),
    storedContent,
    WORKER_ACTOR_ID,
    "https://sscc.example",
    new Date(capturedAt),
  );
  return stored.evidence;
}

function uploadRequest(idempotencyKey: string) {
  return parseCreateChannelMaxAgentJob({
    operation: "UPLOAD_MANUAL_ASSIGNMENT",
    idempotency_key: idempotencyKey,
    payload: {
      account_id: idempotencyKey.replaceAll(":", "-"),
      expected_active_rows: 162,
      assignment_artifact: {
        download_url: "https://artifacts.example/uncrustables.tsv",
        sha256: DIGEST,
        byte_size: ASSIGNMENT_BYTES.byteLength,
        media_type: "text/tab-separated-values",
      },
      manual_model_id: "59021",
      manual_model_name: "Manual",
      selling_venue: "AmazonUS",
      required_skip_rules: ["44a", "44b"],
    },
  });
}

function snapshotRequest(
  idempotencyKey: string,
  maxAttempts = 2,
  accountId = "salutem-us",
) {
  return parseCreateChannelMaxAgentJob({
    operation: "SNAPSHOT_INVENTORY",
    idempotency_key: idempotencyKey,
    max_attempts: maxAttempts,
    payload: {
      account_id: accountId,
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
  const stepUp = await db.channelMaxStepUpAssertion.create({
    data: {
      userId: OWNER_APPROVER.actorId,
      method: "PASSWORD_REAUTH",
      ceremonyId: `ceremony-${nonce}`,
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
      jobId: job.id,
    },
  });
  return service.approveChannelMaxAgentJob(
    job.id,
    parseApproveChannelMaxAgentJob(
      {
        ...job.approval_plan,
        expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
        nonce,
        step_up_assertion_id: stepUp.id,
      },
      now,
    ),
    OWNER_APPROVER,
    now,
  );
}

before(async () => {
  process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY = "true";
  tempDir = await mkdtemp(path.join(tmpdir(), "channelmax-agent-test-"));
  const databasePath = path.join(tempDir, "bridge.db");
  process.env.DATABASE_URL = `file:${databasePath}`;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  const migrations = await Promise.all(
    [
      "prisma/migrations/20260718193000_channelmax_agent_job/migration.sql",
      "prisma/migrations/20260718201500_channelmax_agent_managed_evidence/migration.sql",
    ].map((relativePath) =>
      readFile(path.join(process.cwd(), relativePath), "utf8"),
    ),
  );
  const client = createClient({ url: process.env.DATABASE_URL });
  for (const migration of migrations) await client.executeMultiple(migration);
  client.close();

  service = await import("../service");
  db = (await import("@/lib/prisma")).prisma;
});

after(async () => {
  await db?.$disconnect();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  delete process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY;
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
  const snapshotEvidence = await managedEvidence(
    first.job.id,
    claimed.lease_token,
    "SCREENSHOT",
    "2026-07-18T18:00:01.000Z",
    Buffer.from("snapshot-idempotent"),
    "image/png",
  );
  await service.completeChannelMaxAgentJob(
    first.job.id,
    parseCompleteChannelMaxAgentJob({
      completion_key: "completion:idempotent-cleanup",
      lease_token: claimed.lease_token,
      status: "SUCCEEDED",
      message: "Snapshot completed.",
      result: { rows: 162 },
      evidence: [snapshotEvidence],
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
  const completionEvidence = await managedEvidence(
    jobId,
    claimed.lease_token,
    "SCREENSHOT",
    "2026-07-18T19:00:01.000Z",
    Buffer.from("snapshot-event-replay"),
    "image/png",
  );
  const storedEvidence = await db.channelMaxAgentEvidence.findUniqueOrThrow({
    where: { uri: completionEvidence.uri },
  });
  await assert.rejects(
    db.channelMaxAgentEvidence.update({
      where: { id: storedEvidence.id },
      data: { mediaType: "image/jpeg" },
    }),
  );
  await assert.rejects(
    db.channelMaxAgentEvidence.delete({ where: { id: storedEvidence.id } }),
  );
  await assert.rejects(
    service.appendChannelMaxAgentEvent(
      jobId,
      parseChannelMaxWorkerEvent(
        {
          event_key: "evidence:mismatch:event-replay",
          lease_token: claimed.lease_token,
          type: "EVIDENCE_CAPTURED",
          occurred_at: "2026-07-18T19:00:01.000Z",
          evidence: [
            {
              ...completionEvidence,
              byte_size: completionEvidence.byte_size + 1,
            },
          ],
        },
        new Date("2026-07-18T19:00:01.000Z"),
      ),
      WORKER_ACTOR_ID,
      new Date("2026-07-18T19:00:01.000Z"),
    ),
    /does not exactly match immutable bytes/i,
  );
  await service.completeChannelMaxAgentJob(
    jobId,
    parseCompleteChannelMaxAgentJob({
      completion_key: "completion:event-replay:1",
      lease_token: claimed.lease_token,
      status: "SUCCEEDED",
      message: "Snapshot captured.",
      result: { rows: 162 },
      evidence: [completionEvidence],
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
          step_up_assertion_id: "fake-step-up-assertion",
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

test("disabled mutation release gate refuses a previously approved queued job", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:gate-disabled-claim"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T18:34:00.000Z"),
    "owner-nonce-gate-claim-0001",
  );
  delete process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY;
  try {
    await assert.rejects(
      service.claimChannelMaxAgentJob(
        {
          worker_id: "specialized-imac-worker",
          supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
          lease_seconds: 30,
        },
        WORKER_ACTOR_ID,
        new Date("2026-07-18T18:35:00.000Z"),
      ),
      /mutation execution is disabled by the production release gate/i,
    );
    assert.equal(
      (await service.getChannelMaxAgentJob(created.job.id)).status,
      "QUEUED",
    );
  } finally {
    process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY = "true";
  }
  await service.cancelChannelMaxAgentJob(
    created.job.id,
    {
      cancellation_key: "cancel:gate-disabled:claim",
      reason: "Clean up the release-gate claim test.",
    },
    "system:test",
    new Date("2026-07-18T18:35:01.000Z"),
  );
});

test("disabled mutation release gate refuses MUTATION_STARTED on an existing lease", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:gate-disabled-fence"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T18:35:00.000Z"),
    "owner-nonce-gate-fence-0001",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "specialized-imac-worker",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 60,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T18:36:00.000Z"),
  );
  const source = await managedEvidence(
    created.job.id,
    claimed.lease_token,
    "UPLOAD_SOURCE",
    "2026-07-18T18:36:01.000Z",
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  const started = parseChannelMaxWorkerEvent(
    {
      event_key: "mutation:started:gate-disabled",
      lease_token: claimed.lease_token,
      type: "MUTATION_STARTED",
      occurred_at: "2026-07-18T18:36:01.000Z",
      evidence: [source],
    },
    new Date("2026-07-18T18:36:01.000Z"),
  );
  delete process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY;
  try {
    await assert.rejects(
      service.appendChannelMaxAgentEvent(
        created.job.id,
        started,
        WORKER_ACTOR_ID,
        new Date("2026-07-18T18:36:01.000Z"),
      ),
      /mutation execution is disabled by the production release gate/i,
    );
    assert.equal(
      (await service.getChannelMaxAgentJob(created.job.id)).mutation_started_at,
      null,
    );
  } finally {
    process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY = "true";
  }
  await service.cancelChannelMaxAgentJob(
    created.job.id,
    {
      cancellation_key: "cancel:gate-disabled:fence",
      reason: "Clean up the release-gate fence test.",
    },
    "system:test",
    new Date("2026-07-18T18:36:02.000Z"),
  );
});

test("disabled mutation release gate refuses a MUTATION_STARTED acknowledgement replay", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:gate-disabled-replay"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T18:36:00.000Z"),
    "owner-nonce-gate-replay-0001",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "specialized-imac-worker",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 60,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T18:37:00.000Z"),
  );
  const source = await managedEvidence(
    created.job.id,
    claimed.lease_token,
    "UPLOAD_SOURCE",
    "2026-07-18T18:37:01.000Z",
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  const started = parseChannelMaxWorkerEvent(
    {
      event_key: "mutation:started:gate-replay",
      lease_token: claimed.lease_token,
      type: "MUTATION_STARTED",
      occurred_at: "2026-07-18T18:37:01.000Z",
      evidence: [source],
    },
    new Date("2026-07-18T18:37:01.000Z"),
  );
  await service.appendChannelMaxAgentEvent(
    created.job.id,
    started,
    WORKER_ACTOR_ID,
    new Date("2026-07-18T18:37:01.000Z"),
  );
  delete process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY;
  try {
    await assert.rejects(
      service.appendChannelMaxAgentEvent(
        created.job.id,
        started,
        WORKER_ACTOR_ID,
        new Date("2026-07-18T18:37:02.000Z"),
      ),
      /mutation execution is disabled by the production release gate/i,
    );
  } finally {
    process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY = "true";
  }
  await service.reapExpiredChannelMaxAgentJobs(
    new Date("2026-07-18T18:38:01.000Z"),
  );
  assert.equal(
    (await service.getChannelMaxAgentJob(created.job.id)).status,
    "AMBIGUOUS",
  );
});

test("duplicate mutation plan is blocked until a pre-fence cancellation releases it", async () => {
  const input = uploadRequest("channelmax:upload:duplicate-plan-a");
  const first = await service.createChannelMaxAgentJob(input, "admin");
  const duplicate = { ...input, idempotency_key: "channelmax:upload:duplicate-plan-b" };
  await assert.rejects(
    service.createChannelMaxAgentJob(duplicate, "admin"),
    /exact mutation plan is already protected/i,
  );
  const cancelled = await service.cancelChannelMaxAgentJob(
    first.job.id,
    {
      cancellation_key: "cancel:duplicate-plan:first",
      reason: "Release an unapproved duplicate-plan test job.",
    },
    "system:jackie",
    new Date("2026-07-18T18:40:00.000Z"),
  );
  assert.equal(cancelled.job.status, "CANCELLED");
  const second = await service.createChannelMaxAgentJob(duplicate, "admin");
  assert.equal(second.created, true);
  await service.cancelChannelMaxAgentJob(
    second.job.id,
    {
      cancellation_key: "cancel:duplicate-plan:second",
      reason: "Clean up the duplicate-plan retry.",
    },
    "system:jackie",
    new Date("2026-07-18T18:40:01.000Z"),
  );
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
  const uploadSource = await managedEvidence(
    jobId,
    claimed.lease_token,
    "UPLOAD_SOURCE",
    CAPTURED_AT,
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  const started = parseChannelMaxWorkerEvent(
    {
      event_key: "mutation:started:ambiguous-lease",
      lease_token: claimed.lease_token,
      type: "MUTATION_STARTED",
      occurred_at: CAPTURED_AT,
      message: "About to submit the exact approved TSV.",
      evidence: [uploadSource],
    },
    new Date(CAPTURED_AT),
  );
  await service.appendChannelMaxAgentEvent(
    jobId,
    started,
    WORKER_ACTOR_ID,
    new Date(CAPTURED_AT),
  );
  await assert.rejects(
    service.cancelChannelMaxAgentJob(
      jobId,
      {
        cancellation_key: "cancel:after-fence:ambiguous",
        reason: "This must be refused after MUTATION_STARTED.",
      },
      "system:jackie",
      new Date("2026-07-18T19:00:01.000Z"),
    ),
    /cancel is forbidden/i,
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

  const reconciliation = await service.createChannelMaxReconciliationJob(
    jobId,
    {
      idempotency_key: "channelmax:reconcile:ambiguous-lease",
      priority: 100,
      max_attempts: 2,
    },
    "jackie@openclaw",
  );
  const reconciliationClaim = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["RECONCILE_MUTATION"],
      lease_seconds: 120,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:01:00.000Z"),
  );
  assert.equal(reconciliationClaim.job?.id, reconciliation.job.id);
  const reconciliationPayload = reconciliation.job.payload as Record<
    string,
    unknown
  >;
  const reconciliationScreenshot = await managedEvidence(
    reconciliation.job.id,
    reconciliationClaim.lease_token,
    "SCREENSHOT",
    "2026-07-18T19:01:04.000Z",
    Buffer.from("reconciliation-screenshot"),
    "image/png",
  );
  const reconciliationInventory = await managedEvidence(
    reconciliation.job.id,
    reconciliationClaim.lease_token,
    "INVENTORY_EXPORT",
    "2026-07-18T19:01:04.000Z",
    Buffer.from("sku,price\nUNCRUSTABLES-TEST,29.99\n"),
    "text/csv",
  );
  const reconciled = await service.completeChannelMaxAgentJob(
    reconciliation.job.id,
    parseCompleteChannelMaxAgentJob({
      completion_key: "completion:reconcile:ambiguous-lease",
      lease_token: reconciliationClaim.lease_token,
      status: "SUCCEEDED",
      message: "Readback completed; the outcome is still ambiguous.",
      result: {
        resolution: "STILL_AMBIGUOUS",
        ambiguous_job_id: jobId,
        assignment_sha256: reconciliationPayload.assignment_sha256,
        manual_model_id: reconciliationPayload.manual_model_id,
        rows_expected: reconciliationPayload.expected_active_rows,
        rows_observed: 162,
      },
      evidence: [reconciliationScreenshot, reconciliationInventory],
    }),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:01:05.000Z"),
  );
  assert.equal(reconciled.job.status, "SUCCEEDED");
  const stillAmbiguous = await service.getChannelMaxAgentJob(jobId);
  assert.equal(stillAmbiguous.status, "AMBIGUOUS");
  assert.equal(stillAmbiguous.reconciled_by_job_id, null);
});

test("cancel and MUTATION_STARTED fence race has exactly one winner", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:cancel-fence-race"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T19:09:00.000Z"),
    "owner-nonce-cancel-fence-0001",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:10:00.000Z"),
  );
  const uploadSource = await managedEvidence(
    created.job.id,
    claimed.lease_token,
    "UPLOAD_SOURCE",
    "2026-07-18T19:10:01.000Z",
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  const started = parseChannelMaxWorkerEvent(
    {
      event_key: "mutation:started:cancel-fence-race",
      lease_token: claimed.lease_token,
      type: "MUTATION_STARTED",
      occurred_at: "2026-07-18T19:10:01.000Z",
      evidence: [uploadSource],
    },
    new Date("2026-07-18T19:10:01.000Z"),
  );

  const outcomes = await Promise.allSettled([
    service.cancelChannelMaxAgentJob(
      created.job.id,
      {
        cancellation_key: "cancel:mutation-fence-race",
        reason: "Race cancellation against the external-write fence.",
      },
      "system:test",
      new Date("2026-07-18T19:10:01.000Z"),
    ),
    service.appendChannelMaxAgentEvent(
      created.job.id,
      started,
      WORKER_ACTOR_ID,
      new Date("2026-07-18T19:10:01.000Z"),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );

  const final = await service.getChannelMaxAgentJob(created.job.id);
  const startedEvents = await db.channelMaxAgentEvent.count({
    where: { jobId: created.job.id, type: "MUTATION_STARTED" },
  });
  if (final.status === "CANCELLED") {
    assert.equal(final.mutation_started_at, null);
    assert.equal(startedEvents, 0);
  } else {
    assert.equal(final.status, "RUNNING");
    assert.ok(final.mutation_started_at);
    assert.equal(startedEvents, 1);
    await service.reapExpiredChannelMaxAgentJobs(
      new Date("2026-07-18T19:10:31.000Z"),
    );
    assert.equal(
      (await service.getChannelMaxAgentJob(created.job.id)).status,
      "AMBIGUOUS",
    );
  }
});

test("cancel and completion race cannot overwrite one another", async () => {
  const created = await service.createChannelMaxAgentJob(
    snapshotRequest(
      "channelmax:snapshot:cancel-completion-race",
      1,
      "cancel-completion-race",
    ),
    "admin",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["SNAPSHOT_INVENTORY"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:20:00.000Z"),
  );
  assert.equal(claimed.job?.id, created.job.id);
  const screenshot = await managedEvidence(
    created.job.id,
    claimed.lease_token,
    "SCREENSHOT",
    "2026-07-18T19:20:01.000Z",
    Buffer.from("cancel-completion-race"),
    "image/png",
  );
  const completion = parseCompleteChannelMaxAgentJob({
    completion_key: "completion:cancel-completion-race",
    lease_token: claimed.lease_token,
    status: "SUCCEEDED",
    message: "Snapshot completed.",
    result: { rows: 162 },
    evidence: [screenshot],
  });

  const outcomes = await Promise.allSettled([
    service.cancelChannelMaxAgentJob(
      created.job.id,
      {
        cancellation_key: "cancel:completion-race",
        reason: "Race cancellation against terminal completion.",
      },
      "system:test",
      new Date("2026-07-18T19:20:01.000Z"),
    ),
    service.completeChannelMaxAgentJob(
      created.job.id,
      completion,
      WORKER_ACTOR_ID,
      new Date("2026-07-18T19:20:01.000Z"),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );

  const final = await service.getChannelMaxAgentJob(created.job.id);
  assert.ok(final.status === "CANCELLED" || final.status === "SUCCEEDED");
  const terminalEvents = await db.channelMaxAgentEvent.findMany({
    where: {
      jobId: created.job.id,
      type: { in: ["JOB_CANCELLED", "JOB_SUCCEEDED"] },
    },
    select: { type: true },
  });
  assert.deepEqual(
    terminalEvents.map((event) => event.type),
    [final.status === "CANCELLED" ? "JOB_CANCELLED" : "JOB_SUCCEEDED"],
  );
});

test("heartbeat renewal is not reaped at the superseded lease deadline", async () => {
  const created = await service.createChannelMaxAgentJob(
    snapshotRequest(
      "channelmax:snapshot:heartbeat-reaper-race",
      1,
      "heartbeat-reaper-race",
    ),
    "admin",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["SNAPSHOT_INVENTORY"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:30:00.000Z"),
  );
  assert.equal(claimed.job?.id, created.job.id);
  const heartbeat = await service.heartbeatChannelMaxAgentJob(
    created.job.id,
    {
      lease_token: claimed.lease_token!,
      phase: "CAPTURING_INVENTORY",
      progress_percent: 50,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:30:29.000Z"),
  );
  assert.equal(heartbeat.lease_expires_at, "2026-07-18T19:30:59.000Z");

  const reapedAtOldDeadline = await service.reapExpiredChannelMaxAgentJobs(
    new Date("2026-07-18T19:30:31.000Z"),
  );
  assert.equal(reapedAtOldDeadline, 0);
  assert.equal(
    (await service.getChannelMaxAgentJob(created.job.id)).status,
    "RUNNING",
  );

  await service.reapExpiredChannelMaxAgentJobs(
    new Date("2026-07-18T19:31:00.000Z"),
  );
  assert.equal(
    (await service.getChannelMaxAgentJob(created.job.id)).status,
    "FAILED",
  );
});

test("FAILED reconciliation bypasses success-only resolution validation", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:failed-reconciliation"),
    "admin",
  );
  await approveUpload(
    created.job,
    new Date("2026-07-18T19:39:00.000Z"),
    "owner-nonce-failed-reconciliation-0001",
  );
  const claimed = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["UPLOAD_MANUAL_ASSIGNMENT"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:40:00.000Z"),
  );
  const uploadSource = await managedEvidence(
    created.job.id,
    claimed.lease_token,
    "UPLOAD_SOURCE",
    "2026-07-18T19:40:01.000Z",
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  await service.appendChannelMaxAgentEvent(
    created.job.id,
    parseChannelMaxWorkerEvent(
      {
        event_key: "mutation:started:failed-reconciliation",
        lease_token: claimed.lease_token,
        type: "MUTATION_STARTED",
        occurred_at: "2026-07-18T19:40:01.000Z",
        evidence: [uploadSource],
      },
      new Date("2026-07-18T19:40:01.000Z"),
    ),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:40:01.000Z"),
  );
  await service.reapExpiredChannelMaxAgentJobs(
    new Date("2026-07-18T19:40:31.000Z"),
  );
  assert.equal(
    (await service.getChannelMaxAgentJob(created.job.id)).status,
    "AMBIGUOUS",
  );

  const reconciliation = await service.createChannelMaxReconciliationJob(
    created.job.id,
    {
      idempotency_key: "channelmax:reconcile:failed-outcome",
      priority: 100,
      max_attempts: 1,
    },
    "jackie@openclaw",
  );
  const reconciliationClaim = await service.claimChannelMaxAgentJob(
    {
      worker_id: "openclaw-imac",
      supported_operations: ["RECONCILE_MUTATION"],
      lease_seconds: 30,
    },
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:41:00.000Z"),
  );
  assert.equal(reconciliationClaim.job?.id, reconciliation.job.id);
  const failed = await service.completeChannelMaxAgentJob(
    reconciliation.job.id,
    parseCompleteChannelMaxAgentJob({
      completion_key: "completion:failed-reconciliation",
      lease_token: reconciliationClaim.lease_token,
      status: "FAILED",
      message: "ChannelMAX readback could not be completed.",
      result: {},
      evidence: [],
    }),
    WORKER_ACTOR_ID,
    new Date("2026-07-18T19:41:01.000Z"),
  );
  assert.equal(failed.job.status, "FAILED");
  const original = await service.getChannelMaxAgentJob(created.job.id);
  assert.equal(original.status, "AMBIGUOUS");
  assert.equal(original.reconciled_by_job_id, null);

  const retry = await service.createChannelMaxReconciliationJob(
    created.job.id,
    {
      idempotency_key: "channelmax:reconcile:after-failed-outcome",
      priority: 100,
      max_attempts: 1,
    },
    "jackie@openclaw",
  );
  await service.cancelChannelMaxAgentJob(
    retry.job.id,
    {
      cancellation_key: "cancel:reconciliation-retry",
      reason: "Clean up reconciliation lock-release regression test.",
    },
    "system:test",
    new Date("2026-07-18T19:41:02.000Z"),
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
  const uploadSource = await managedEvidence(
    jobId,
    claimed.lease_token,
    "UPLOAD_SOURCE",
    "2026-07-18T21:00:00.000Z",
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  const visualEvidence = await managedEvidence(
    jobId,
    claimed.lease_token,
    "SCREENSHOT",
    "2026-07-18T21:00:03.000Z",
    Buffer.from("confirmed-upload-task"),
    "image/png",
  );
  await service.appendChannelMaxAgentEvent(
    jobId,
    parseChannelMaxWorkerEvent(
      {
        event_key: "mutation:started:confirmed",
        lease_token: claimed.lease_token,
        type: "MUTATION_STARTED",
        occurred_at: "2026-07-18T21:00:00.000Z",
        evidence: [uploadSource],
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
        evidence: [visualEvidence],
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
        evidence: [visualEvidence],
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
    evidence: [visualEvidence],
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
  const uploadSource = await managedEvidence(
    created.job.id,
    claim.lease_token,
    "UPLOAD_SOURCE",
    "2026-07-18T23:00:00.000Z",
    ASSIGNMENT_BYTES,
    "text/tab-separated-values",
  );
  const visualBySecond = {
    "01": await managedEvidence(
      created.job.id,
      claim.lease_token,
      "SCREENSHOT",
      "2026-07-18T23:00:01.000Z",
      Buffer.from("outcome-not-applied"),
      "image/png",
    ),
    "02": await managedEvidence(
      created.job.id,
      claim.lease_token,
      "SCREENSHOT",
      "2026-07-18T23:00:02.000Z",
      Buffer.from("outcome-confirmed"),
      "image/png",
    ),
  };
  await service.appendChannelMaxAgentEvent(
    created.job.id,
    parseChannelMaxWorkerEvent(
      {
        event_key: "mutation:started:conflict",
        lease_token: claim.lease_token,
        type: "MUTATION_STARTED",
        occurred_at: "2026-07-18T23:00:00.000Z",
        evidence: [uploadSource],
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
          evidence: [visualBySecond[second]],
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

test("production mutation approval capability stays behind an explicit release gate", async () => {
  const created = await service.createChannelMaxAgentJob(
    uploadRequest("channelmax:upload:feature-disabled"),
    "admin",
  );
  delete process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY;
  try {
    assert.equal(service.channelMaxMutationApprovalEnabled(), false);
    await assert.rejects(
      service.createChannelMaxPasswordStepUp(
        created.job.id,
        OWNER_APPROVER.actorId,
        new Date("2026-07-18T23:30:00.000Z"),
      ),
      /disabled until managed immutable evidence/i,
    );
  } finally {
    process.env.CHANNELMAX_MUTATION_APPROVAL_TEST_ONLY = "true";
  }
  await service.cancelChannelMaxAgentJob(
    created.job.id,
    {
      cancellation_key: "cancel:feature-disabled",
      reason: "Clean up a fail-closed feature-gate test.",
    },
    "system:jackie",
    new Date("2026-07-18T23:30:01.000Z"),
  );
});
