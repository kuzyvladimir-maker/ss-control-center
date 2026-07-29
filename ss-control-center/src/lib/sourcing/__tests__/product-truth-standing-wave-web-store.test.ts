import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";

import { createClient } from "@libsql/client";

import {
  PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
} from "../product-truth-standing-wave-web-contract";
import type {
  ProductTruthStandingWaveWebRuntimeActive,
} from "../product-truth-standing-wave-web-runtime";

let store: typeof import("../product-truth-standing-wave-web-store");
let prismaModule: typeof import("@/lib/prisma");

const runtime: ProductTruthStandingWaveWebRuntimeActive = {
  schemaVersion: "product-truth-standing-wave-web-runtime/1.0.0",
  status: "ACTIVE",
  base: {
    schemaVersion: "product-truth-web-control-runtime/1.0.0",
    status: "ACTIVE",
    stage: "PRODUCTION_READ_ONLY",
    engine: {
      commandSchemaVersion: "product-truth-control-command/1.0.0",
      releaseId: "product-truth-standing-web-store-r1",
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      executableTreeSha256: "3".repeat(64),
    },
    target: {
      environment: "PRODUCTION",
      databaseTargetFingerprint: "4".repeat(64),
      manifestSha256: "5".repeat(64),
    },
    unwrangleReserveFloor: 15000,
    workerTokenSha256: "6".repeat(64),
    claims: {
      commandAdmission: true,
      controlDatabaseWrites: true,
      workerClaims: true,
      processSpawnInWebRuntime: false,
      providerCallsInWebRuntime: false,
      marketplaceMutations: false,
      meteredExecutionAdmission: false,
    },
  },
  standingProviderPolicySha256: "7".repeat(64),
  standingNoPaidPolicySha256: "8".repeat(64),
  limits: {
    maxTargets: 5,
    maxLinkedListings: 100,
    maxProviderUnits: 30,
    concurrency: 1,
    retries: 0,
  },
  claims: {
    standingPolicyAuthority: true,
    ownerPromptRequired: false,
    durableAdmission: true,
    workerClaims: true,
    processSpawnInWebRuntime: false,
    providerCallsInWebRuntime: false,
    marketplaceMutations: false,
  },
};

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "pt-standing-web-store-"));
  const url = `file:${join(root, "control.db")}`;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = url;
  const db = createClient({ url });
  const stageA = await readFile(
    join(
      process.cwd(),
      "prisma/migrations/20260726110000_product_truth_control_plane_stage_a/migration.sql",
    ),
    "utf8",
  );
  const legacyArtifactBytes = Buffer.from('{"legacy":true}\n', "utf8");
  const legacyEventBytes = Buffer.from('{"status":"SUCCEEDED"}\n', "utf8");
  await db.executeMultiple(stageA);
  await db.execute({
    sql: `
      INSERT INTO "ProductTruthControlCommand" (
        "commandId","schemaVersion","commandKind","gateClass","status",
        "idempotencyKey","requestSha256","requestedByUserId","requestedAt",
        "engineReleaseId","engineCommitSha","engineTreeSha",
        "executableTreeSha256","environment","databaseTargetFingerprint",
        "manifestSha256","requestArtifactId"
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,
    args: [
      "legacy-readiness-command-0001",
      "product-truth-control-command/1.0.0",
      "READINESS",
      "READ_ONLY",
      "SUCCEEDED",
      "legacy-readiness-idempotency-0001",
      "a".repeat(64),
      "legacy-owner-0001",
      "2026-07-28T12:00:00.000Z",
      "legacy-release-0001",
      "b".repeat(40),
      "c".repeat(40),
      "d".repeat(64),
      "PRODUCTION",
      "e".repeat(64),
      "f".repeat(64),
      "legacy-request-artifact-0001",
    ],
  });
  await db.execute({
    sql: `
      INSERT INTO "ProductTruthControlArtifact" (
        "artifactId","commandId","schemaVersion","role","mediaType","content",
        "byteSize","sha256","locator","createdAt","createdByPrincipal"
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `,
    args: [
      "legacy-request-artifact-0001",
      "legacy-readiness-command-0001",
      "product-truth-control-artifact/1.0.0",
      "REQUEST",
      "application/json",
      legacyArtifactBytes,
      legacyArtifactBytes.byteLength,
      digest(legacyArtifactBytes),
      "db://product-truth-control/legacy-readiness-command-0001/legacy-request-artifact-0001",
      "2026-07-28T12:00:00.000Z",
      "legacy-owner-0001",
    ],
  });
  await db.execute({
    sql: `
      INSERT INTO "ProductTruthControlEvent" (
        "eventId","commandId","schemaVersion","sequence","eventType","source",
        "occurredAt","payload","payloadSha256","previousEventHash","eventHash"
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `,
    args: [
      "legacy-event-0001",
      "legacy-readiness-command-0001",
      "product-truth-control-event/1.0.0",
      1,
      "SUCCEEDED",
      "SERVER",
      "2026-07-28T12:00:00.000Z",
      legacyEventBytes,
      digest(legacyEventBytes),
      "0".repeat(64),
      digest("legacy-event-0001"),
    ],
  });
  const standingWave = await readFile(
    join(
      process.cwd(),
      "prisma/migrations/20260729190000_product_truth_standing_wave_control/migration.sql",
    ),
    "utf8",
  );
  await db.executeMultiple(standingWave);
  const preserved = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM "ProductTruthControlCommand"
        WHERE "commandId" = 'legacy-readiness-command-0001') AS commands,
      (SELECT COUNT(*) FROM "ProductTruthControlArtifact"
        WHERE "artifactId" = 'legacy-request-artifact-0001') AS artifacts,
      (SELECT COUNT(*) FROM "ProductTruthControlEvent"
        WHERE "eventId" = 'legacy-event-0001') AS events
  `);
  assert.deepEqual(
    preserved.rows[0],
    { commands: 1, artifacts: 1, events: 1 },
  );
  assert.equal((await db.execute("PRAGMA foreign_key_check")).rows.length, 0);
  db.close();
  store = await import("../product-truth-standing-wave-web-store");
  prismaModule = await import("@/lib/prisma");
});

after(async () => {
  await prismaModule.prisma.$disconnect();
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function file(name: string, bytes: Buffer, mediaType = "application/json") {
  return {
    name,
    mediaType,
    byteSize: bytes.byteLength,
    sha256: digest(bytes),
    contentBase64: bytes.toString("base64"),
  };
}

function completedResult(commandId: string) {
  const plan = Buffer.from("{}\n");
  const report = Buffer.from("{}\n");
  const index = Buffer.from("{}\n");
  const readiness = Buffer.from('{"counts":{"denominator":5935}}\n');
  const planSha = digest(plan);
  const reportSha = digest(report);
  const indexSha = digest(index);
  const readinessSha = digest(readiness);
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
    commandId,
    operation: "START",
    exitCode: 0,
    outcome: "COMPLETED",
    waveId: "ptsw-web-store-0001",
    targetCount: 5,
    completedTargetCount: 3,
    ambiguousTargetCount: 2,
    actualProviderUnits: 25,
    planSha256: planSha,
    reportSha256: reportSha,
    readinessReportSha256: readinessSha,
    files: [
      file("artifact-index.json", index),
      file("artifact-index.sha256", Buffer.from(`${indexSha}\n`), "text/plain"),
      file("readiness-report.json.gz", gzipSync(readiness), "application/gzip"),
      file("readiness-report.sha256", Buffer.from(`${readinessSha}\n`), "text/plain"),
      file("wave-plan.json", plan),
      file("wave-plan.sha256", Buffer.from(`${planSha}\n`), "text/plain"),
      file("wave-report.json", report),
      file("wave-report.sha256", Buffer.from(`${reportSha}\n`), "text/plain"),
    ],
    claims: {
      shell: false,
      automaticRetry: false,
      retries: 0,
      marketplaceMutations: 0,
      priceOrInventoryChanges: 0,
      delistings: 0,
      consumerActivations: 0,
      procurementActions: 0,
    },
  };
}

test("durable standing-wave command admits, leases, completes and exposes exact result", async () => {
  const base = new Date(Date.now() - 10 * 60_000);
  const commandId = await store.admitProductTruthStandingWaveWebCommand({
    runtime,
    requestedByUserId: "user-owner-0001",
    requestId: "request-start-0001",
    operation: "START",
    now: base,
  });
  assert.match(commandId, /^ptswc-[a-f0-9]{32}$/u);
  await assert.rejects(
    prismaModule.prisma.productTruthControlCommand.create({
      data: {
        commandId: `ptswc-${"a".repeat(32)}`,
        schemaVersion: "product-truth-standing-wave-web-request/1.0.0",
        commandKind: "STANDING_WAVE",
        gateClass: "STANDING_METERED_EXECUTE",
        status: "ADMITTED",
        idempotencyKey: "standing-wave-direct-insert-0001",
        requestSha256: "9".repeat(64),
        requestedByUserId: "user-owner-0001",
        requestedAt: base,
        engineReleaseId: runtime.base.engine.releaseId,
        engineCommitSha: runtime.base.engine.commitSha,
        engineTreeSha: runtime.base.engine.treeSha,
        executableTreeSha256: runtime.base.engine.executableTreeSha256,
        environment: "PRODUCTION",
        databaseTargetFingerprint:
          runtime.base.target.databaseTargetFingerprint,
        manifestSha256: runtime.base.target.manifestSha256,
      },
    }),
    (error: unknown) =>
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "P2003",
  );
  assert.equal(
    await prismaModule.prisma.productTruthControlCommand.count({
      where: {
        commandKind: "STANDING_WAVE",
        status: { in: ["ADMITTED", "CLAIMED", "RUNNING"] },
      },
    }),
    1,
  );
  assert.equal(
    await store.admitProductTruthStandingWaveWebCommand({
      runtime,
      requestedByUserId: "user-owner-0001",
      requestId: "request-start-0001",
      operation: "START",
      now: new Date(base.getTime() + 60_000),
    }),
    commandId,
  );
  await assert.rejects(
    store.admitProductTruthStandingWaveWebCommand({
      runtime: {
        ...runtime,
        standingProviderPolicySha256: "9".repeat(64),
      },
      requestedByUserId: "user-owner-0001",
      requestId: "request-start-0001",
      operation: "START",
      now: new Date(base.getTime() + 60_000),
    }),
    /STANDING_WAVE_WEB_IDEMPOTENCY_COLLISION/u,
  );
  const claim = await store.claimProductTruthStandingWaveWebCommand({
    runtime,
    workerId: "standing-worker-0001",
    now: new Date(base.getTime() + 2 * 60_000),
  });
  assert.ok(claim);
  assert.equal(claim.operation, "START");
  await store.startProductTruthStandingWaveWebCommand({
    commandId,
    leaseToken: claim.lease_token,
    now: new Date(base.getTime() + 3 * 60_000),
  });
  const repeatedStart = await store.startProductTruthStandingWaveWebCommand({
    commandId,
    leaseToken: claim.lease_token,
    now: new Date(base.getTime() + 3 * 60_000 + 1_000),
  });
  assert.equal(repeatedStart.status, "RUNNING");
  assert.equal(
    await prismaModule.prisma.productTruthControlEvent.count({
      where: { commandId, eventType: "EXECUTION_BOUNDARY" },
    }),
    1,
  );
  const completion = await store.completeProductTruthStandingWaveWebCommand({
    runtime,
    commandId,
    leaseToken: claim.lease_token,
    result: completedResult(commandId),
    now: new Date(base.getTime() + 4 * 60_000),
  });
  assert.equal(completion.status, "SUCCEEDED");
  const repeatedCompletion =
    await store.completeProductTruthStandingWaveWebCommand({
      runtime,
      commandId,
      leaseToken: claim.lease_token,
      result: completedResult(commandId),
      now: new Date(base.getTime() + 4 * 60_000 + 1_000),
    });
  assert.equal(repeatedCompletion.status, "SUCCEEDED");
  assert.equal(
    await prismaModule.prisma.productTruthControlArtifact.count({
      where: { commandId, role: "RESULT" },
    }),
    1,
  );
  assert.equal(
    await prismaModule.prisma.productTruthControlEvent.count({
      where: { commandId, eventType: "SUCCEEDED" },
    }),
    1,
  );
  const status = await store.readProductTruthStandingWaveWebStatus({
    runtime,
    now: new Date(base.getTime() + 5 * 60_000),
  });
  assert.equal(status.canStart, true);
  assert.equal(status.commands[0]?.result?.actualProviderUnits, 25);
  assert.equal(status.commands[0]?.result?.completedTargetCount, 3);
  assert.equal(status.commands[0]?.status, "SUCCEEDED");
});

test("expired post-boundary lease becomes terminal ambiguous and requires a new resume command", async () => {
  const base = new Date();
  const source = await store.admitProductTruthStandingWaveWebCommand({
    runtime,
    requestedByUserId: "user-owner-0001",
    requestId: "request-start-0002",
    operation: "START",
    now: base,
  });
  const claim = await store.claimProductTruthStandingWaveWebCommand({
    runtime,
    workerId: "standing-worker-0001",
    now: new Date(base.getTime() + 60_000),
  });
  assert.ok(claim);
  await store.startProductTruthStandingWaveWebCommand({
    commandId: source,
    leaseToken: claim.lease_token,
    now: new Date(base.getTime() + 2 * 60_000),
  });
  await prismaModule.prisma.productTruthControlCommand.update({
    where: { commandId: source },
    data: { workerLeaseExpiresAt: new Date(Date.now() - 1_000) },
  });
  const ambiguous = await store.readProductTruthStandingWaveWebStatus({
    runtime,
    now: new Date(base.getTime() + 3 * 60_000),
  });
  assert.equal(
    ambiguous.commands.find((command) => command.commandId === source)?.status,
    "AMBIGUOUS",
  );
  assert.equal(ambiguous.resumableCommandId, source);

  await assert.rejects(
    store.admitProductTruthStandingWaveWebCommand({
      runtime: {
        ...runtime,
        standingProviderPolicySha256: "9".repeat(64),
      },
      requestedByUserId: "user-owner-0001",
      requestId: "request-resume-drift-0002",
      operation: "RESUME",
      sourceCommandId: source,
      now: new Date(base.getTime() + 4 * 60_000),
    }),
    /STANDING_WAVE_WEB_RESUME_BINDING_DRIFT/u,
  );
  const resume = await store.admitProductTruthStandingWaveWebCommand({
    runtime,
    requestedByUserId: "user-owner-0001",
    requestId: "request-resume-0002",
    operation: "RESUME",
    sourceCommandId: source,
    now: new Date(base.getTime() + 4 * 60_000),
  });
  const status = await store.readProductTruthStandingWaveWebStatus({
    runtime,
    now: new Date(base.getTime() + 4 * 60_000 + 1_000),
  });
  assert.equal(status.activeCommandId, resume);
  assert.equal(
    status.commands.find((command) => command.commandId === resume)?.workspaceKey,
    source,
  );
  assert.equal(
    status.commands.find((command) => command.commandId === resume)?.operation,
    "RESUME",
  );

  const resumeClaim = await store.claimProductTruthStandingWaveWebCommand({
    runtime,
    workerId: "standing-worker-0001",
    now: new Date(base.getTime() + 5 * 60_000),
  });
  assert.ok(resumeClaim);
  await prismaModule.prisma.productTruthControlCommand.update({
    where: { commandId: resume },
    data: { workerLeaseExpiresAt: new Date(Date.now() - 1_000) },
  });
  const recovered = await store.readProductTruthStandingWaveWebStatus({
    runtime,
    now: new Date(),
  });
  assert.equal(
    recovered.commands.find((command) => command.commandId === resume)?.status,
    "ADMITTED",
  );
  assert.equal(
    recovered.commands.find((command) => command.commandId === resume)?.attempts,
    0,
  );
  const durable = await prismaModule.prisma.productTruthControlCommand.findUnique({
    where: { commandId: resume },
    select: { zeroAttemptEvidenceArtifactId: true },
  });
  assert.match(
    durable?.zeroAttemptEvidenceArtifactId ?? "",
    /^pta-[a-f0-9]{32}-zero-[a-f0-9]{8}$/u,
  );
});
