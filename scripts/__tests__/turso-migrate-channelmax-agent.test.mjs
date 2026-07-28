import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createClient } from "@libsql/client";

import {
  APPLY_CONFIRMATION,
  applyChannelMaxMigrations,
  inspectChannelMaxSchema,
  parseMigrationArgs,
  safeMigrationErrorMessage,
} from "../turso-migrate-channelmax-agent.mjs";

let tempDirectory;
let client;

before(async () => {
  tempDirectory = await mkdtemp(path.join(tmpdir(), "channelmax-migrate-"));
  client = createClient({
    url: `file:${path.join(tempDirectory, "migration.db")}`,
  });
  await client.execute(`CREATE TABLE "_prisma_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "finished_at" DATETIME,
    "migration_name" TEXT NOT NULL,
    "logs" TEXT,
    "rolled_back_at" DATETIME,
    "started_at" DATETIME NOT NULL,
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  )`);
});

after(async () => {
  client?.close();
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("migration CLI is read-only by default and requires an exact apply ceremony", () => {
  assert.deepEqual(parseMigrationArgs([]), { mode: "check", apply: false });
  assert.deepEqual(parseMigrationArgs(["--check"]), {
    mode: "check",
    apply: false,
  });
  assert.deepEqual(parseMigrationArgs(["--dry-run"]), {
    mode: "dry-run",
    apply: false,
  });
  assert.throws(() => parseMigrationArgs(["--apply"]), /requires --confirm/i);
  assert.throws(
    () => parseMigrationArgs(["--token=must-not-be-logged"]),
    /^Error: Unsupported migration argument\.$/,
  );
  assert.deepEqual(
    parseMigrationArgs(["--apply", `--confirm=${APPLY_CONFIRMATION}`]),
    { mode: "apply", apply: true },
  );
  const sensitiveFailure = safeMigrationErrorMessage(
    new Error("fetch failed for libsql://user:secret@example.invalid"),
  );
  assert.equal(
    sensitiveFailure,
    "Database operation failed; no credentials were logged.",
  );
  assert.doesNotMatch(sensitiveFailure, /secret|example\.invalid/);
});

test("check is non-mutating and both ChannelMAX migrations apply idempotently", async () => {
  const before = await inspectChannelMaxSchema(client);
  assert.equal(before.ready, false);
  assert.ok(before.missing_tables.includes("ChannelMaxAgentJob"));
  const stillMissing = await inspectChannelMaxSchema(client);
  assert.deepEqual(stillMissing, before);

  const first = await applyChannelMaxMigrations(client);
  assert.equal(first.ready, true);
  const ledgerAfterFirst = await client.execute(
    `SELECT migration_name, checksum FROM "_prisma_migrations"
     WHERE migration_name LIKE '20260718%'
     ORDER BY migration_name`,
  );
  assert.equal(ledgerAfterFirst.rows.length, 2);
  for (const row of ledgerAfterFirst.rows) {
    assert.match(String(row.checksum), /^[a-f0-9]{64}$/);
  }

  const second = await applyChannelMaxMigrations(client);
  assert.equal(second.ready, true);
  const ledgerAfterSecond = await client.execute(
    `SELECT migration_name FROM "_prisma_migrations"
     WHERE migration_name LIKE '20260718%'`,
  );
  assert.equal(ledgerAfterSecond.rows.length, 2);
});

test("managed evidence bytes are immutable after the Turso migration", async () => {
  await client.execute({
    sql: `INSERT INTO "ChannelMaxAgentJob"
      ("id", "operation", "accountId", "payloadJson", "payloadSha256",
       "requestSha256", "idempotencyKey", "requestedBy")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "migration-test-job",
      "SNAPSHOT_INVENTORY",
      "salutem-us",
      "{}",
      "a".repeat(64),
      "b".repeat(64),
      "migration:test:job",
      "migration-test",
    ],
  });
  await client.execute({
    sql: `INSERT INTO "ChannelMaxAgentEvidence"
      ("id", "jobId", "kind", "sha256", "byteSize", "mediaType",
       "capturedAt", "uri", "content", "uploadedBy")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "migration-test-evidence",
      "migration-test-job",
      "SCREENSHOT",
      "c".repeat(64),
      3,
      "image/png",
      "2026-07-18T20:00:00.000Z",
      "https://sscc.example/evidence/migration-test-evidence",
      new Uint8Array([1, 2, 3]),
      "system:test",
    ],
  });
  await assert.rejects(
    client.execute(
      `UPDATE "ChannelMaxAgentEvidence" SET "mediaType"='image/jpeg'
       WHERE "id"='migration-test-evidence'`,
    ),
    /append-only/i,
  );
  await assert.rejects(
    client.execute(
      `DELETE FROM "ChannelMaxAgentEvidence"
       WHERE "id"='migration-test-evidence'`,
    ),
    /append-only/i,
  );
});

test("partial base schema fails closed without attempting an automatic repair", async () => {
  const partialDirectory = await mkdtemp(
    path.join(tmpdir(), "channelmax-migrate-partial-"),
  );
  const partialClient = createClient({
    url: `file:${path.join(partialDirectory, "partial.db")}`,
  });
  try {
    await partialClient.execute(
      'CREATE TABLE "ChannelMaxAgentJob" ("id" TEXT PRIMARY KEY)',
    );
    await assert.rejects(
      applyChannelMaxMigrations(partialClient),
      /Partial ChannelMAX base schema detected/i,
    );
    const tables = await partialClient.execute(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='ChannelMaxAgentEvent'",
    );
    assert.equal(tables.rows.length, 0);
  } finally {
    partialClient.close();
    await rm(partialDirectory, { recursive: true, force: true });
  }
});

test("migration ledger checksum conflict is rejected before schema writes", async () => {
  const conflictDirectory = await mkdtemp(
    path.join(tmpdir(), "channelmax-migrate-conflict-"),
  );
  const conflictClient = createClient({
    url: `file:${path.join(conflictDirectory, "conflict.db")}`,
  });
  try {
    await conflictClient.execute(`CREATE TABLE "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    await conflictClient.execute({
      sql: `INSERT INTO "_prisma_migrations"
        ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
        VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, 1)`,
      args: [
        "checksum-conflict",
        "wrong-checksum",
        "20260718193000_channelmax_agent_job",
      ],
    });
    await assert.rejects(
      applyChannelMaxMigrations(conflictClient),
      /checksum mismatch/i,
    );
    const tables = await conflictClient.execute(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='ChannelMaxAgentJob'",
    );
    assert.equal(tables.rows.length, 0);
  } finally {
    conflictClient.close();
    await rm(conflictDirectory, { recursive: true, force: true });
  }
});
