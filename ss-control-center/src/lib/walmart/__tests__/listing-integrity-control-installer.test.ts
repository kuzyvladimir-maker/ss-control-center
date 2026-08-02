import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createClient } from "@libsql/client";

import {
  inspectWalmartListingIntegrityControlMigration,
  installWalmartListingIntegrityControlMigration,
} from "../listing-integrity-control-installer.ts";

const MIGRATION = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801172000_walmart_listing_integrity_control_plane_stage_a",
  "migration.sql",
);

async function database() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(`
    CREATE TABLE "_prisma_migrations" (
      id TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      finished_at DATETIME,
      migration_name TEXT NOT NULL,
      logs TEXT,
      rolled_back_at DATETIME,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_steps_count INTEGER UNSIGNED NOT NULL DEFAULT 0
    );
  `);
  return client;
}

test("exact installer applies and records only the additive default-OFF migration", async () => {
  const client = await database();
  const migrationSql = await readFile(MIGRATION, "utf8");
  try {
    const before = await inspectWalmartListingIntegrityControlMigration({
      client,
      migration_sql: migrationSql,
    });
    assert.equal(before.status, "NOT_INSTALLED");
    const installed = await installWalmartListingIntegrityControlMigration({
      client,
      migration_sql: migrationSql,
      now: "2026-08-01T18:30:00.000Z",
    });
    assert.equal(installed.status, "INSTALLED_DEFAULT_OFF");
    assert.equal(installed.after.runtime_stage_after_install, "OFF");
    assert.equal(installed.walmart_writes, 0);

    const again = await installWalmartListingIntegrityControlMigration({
      client,
      migration_sql: migrationSql,
      now: "2026-08-01T18:31:00.000Z",
    });
    assert.equal(again.status, "ALREADY_INSTALLED");
    assert.equal(again.database_writes, 0);
  } finally {
    client.close();
  }
});

test("installer fails closed on partial schema instead of repairing it", async () => {
  const client = await database();
  const migrationSql = await readFile(MIGRATION, "utf8");
  try {
    await client.execute("CREATE TABLE WalmartListingIntegrityControlRun (runId TEXT)");
    const inspection = await inspectWalmartListingIntegrityControlMigration({
      client,
      migration_sql: migrationSql,
    });
    assert.equal(inspection.status, "PARTIAL_FAIL_CLOSED");
    await assert.rejects(
      installWalmartListingIntegrityControlMigration({
        client,
        migration_sql: migrationSql,
        now: "2026-08-01T18:30:00.000Z",
      }),
      /refusing to repair or overwrite partial schema/,
    );
  } finally {
    client.close();
  }
});
