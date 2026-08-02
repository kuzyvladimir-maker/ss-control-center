import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClient } from "@libsql/client";

import {
  PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
  PRODUCT_TRUTH_CONTROL_ZERO_HASH,
  sealProductTruthControlEvent,
} from "../product-truth-control-plane";
import { PRODUCT_TRUTH_WORKER_RESULT_VERSION } from "../product-truth-web-control-worker-contract";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function resultFile(name: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    name,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64"),
  };
}

test("remote-safe completion atomically seals once and accepts the exact receipt retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pt-control-completion-"));
  const databasePath = join(root, "control.db");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousTursoUrl = process.env.TURSO_DATABASE_URL;
  const previousTursoToken = process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = `file:${databasePath}`;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const db = createClient({ url: `file:${databasePath}` });
  try {
    const migration = await readFile(
      new URL(
        "../../../../prisma/migrations/20260726110000_product_truth_control_plane_stage_a/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.executeMultiple(migration);
    const commandId = "ptc-integration-complete-0001";
    const requestSha256 = "1".repeat(64);
    const leaseToken = "integration-lease-token-with-more-than-32-characters";
    const now = new Date();
    const future = new Date(now.getTime() + 60 * 60_000).toISOString();
    await db.execute({
      sql: `INSERT INTO "ProductTruthControlCommand" (
              "commandId", "schemaVersion", "commandKind", "gateClass", "status",
              "idempotencyKey", "requestSha256", "requestedByUserId", "requestedAt",
              "engineReleaseId", "engineCommitSha", "engineTreeSha",
              "executableTreeSha256", "environment", "databaseTargetFingerprint",
              "manifestSha256", "runId", "workerLeaseOwner",
              "workerLeaseTokenSha256", "workerLeaseExpiresAt", "workerHeartbeatAt",
              "attempts", "executionStartedAt", "executionBoundary"
            ) VALUES (?, ?, 'DOCTOR', 'READ_ONLY', 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?,
                      'PRODUCTION', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      args: [
        commandId,
        PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
        "integration-complete-idempotency",
        requestSha256,
        "integration-user",
        now.toISOString(),
        "product-truth-integration-release",
        "2".repeat(40),
        "3".repeat(40),
        "4".repeat(64),
        "5".repeat(64),
        "6".repeat(64),
        "integration-run",
        "integration-worker",
        sha256(leaseToken),
        future,
        now.toISOString(),
        now.toISOString(),
        `NO_SPEND:${requestSha256}`,
      ],
    });
    const seedPayload = Buffer.from('{"executionBoundary":"test"}\n', "utf8");
    const seedEvent = sealProductTruthControlEvent({
      eventId: "ptce-integration-complete-0001-1",
      commandId,
      sequence: 1,
      eventType: "EXECUTION_BOUNDARY",
      source: "WORKER",
      occurredAt: now.toISOString(),
      payload: seedPayload,
      previousEventHash: PRODUCT_TRUTH_CONTROL_ZERO_HASH,
    });
    await db.execute({
      sql: `INSERT INTO "ProductTruthControlEvent" (
              "eventId", "commandId", "schemaVersion", "sequence", "eventType",
              "source", "occurredAt", "payload", "payloadSha256",
              "previousEventHash", "eventHash"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        seedEvent.eventId,
        seedEvent.commandId,
        seedEvent.schemaVersion,
        seedEvent.sequence,
        seedEvent.eventType,
        seedEvent.source,
        seedEvent.occurredAt,
        seedEvent.payload,
        seedEvent.payloadSha256,
        seedEvent.previousEventHash,
        seedEvent.eventHash,
      ],
    });

    const { completeProductTruthNoSpendCommand } = await import(
      "../product-truth-web-control-worker"
    );
    const result = {
      schemaVersion: PRODUCT_TRUTH_WORKER_RESULT_VERSION,
      commandId,
      commandKind: "DOCTOR" as const,
      exitCode: 1,
      files: [
        resultFile("stderr.txt", "bounded test failure\n"),
        resultFile("stdout.txt", "no provider call\n"),
      ],
      claims: {
        shell: false as const,
        providerCalls: 0 as const,
        marketplaceMutations: 0 as const,
      },
    };
    const runtime = {} as Parameters<typeof completeProductTruthNoSpendCommand>[0]["runtime"];
    const first = await completeProductTruthNoSpendCommand({
      runtime,
      commandId,
      leaseToken,
      result,
    });
    const second = await completeProductTruthNoSpendCommand({
      runtime,
      commandId,
      leaseToken,
      result,
    });
    assert.deepEqual(first, { status: "FAILED", next: null });
    assert.deepEqual(second, first);
    const command = await db.execute({
      sql: `SELECT "status", "attempts", "exitCode", "outcome",
                   "resultArtifactId" FROM "ProductTruthControlCommand"
            WHERE "commandId" = ?`,
      args: [commandId],
    });
    const commandRow = command.rows[0]!;
    assert.equal(commandRow.status, "FAILED");
    assert.equal(Number(commandRow.attempts), 1);
    assert.equal(Number(commandRow.exitCode), 1);
    assert.equal(commandRow.outcome, "NO_SPEND_COMMAND_FAILED");
    assert.equal(typeof commandRow.resultArtifactId, "string");
    const counts = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM "ProductTruthControlArtifact" WHERE "commandId" = ?) AS artifacts,
              (SELECT COUNT(*) FROM "ProductTruthControlEvent" WHERE "commandId" = ?) AS events`,
      args: [commandId, commandId],
    });
    assert.equal(Number(counts.rows[0]!.artifacts), 1);
    assert.equal(Number(counts.rows[0]!.events), 3);
  } finally {
    db.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previousTursoUrl;
    if (previousTursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previousTursoToken;
    await rm(root, { recursive: true, force: true });
  }
});
