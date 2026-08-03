// Turso migration: publish queue — PublishBatch / PublishBatchItem.
//
// Additive only: no existing table is altered, so this cannot disturb the
// MarketplaceSubmissionAttempt ledger that enforces one SKU / one POST.
// Idempotent: probes each table before creating, and re-probes afterwards so a
// run either proves the tables are there or fails loudly.
//
// Mirrors prisma/migrations/20260803190000_publish_batch_queue.

import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

/** Fall back to .env.local so the script runs the same from any machine. */
function fromEnvFile(key) {
  const file = join(APP_ROOT, ".env.local");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === key) return clean(trimmed.slice(eq + 1));
  }
  return undefined;
}

const url = clean(process.env.TURSO_DATABASE_URL) ?? fromEnvFile("TURSO_DATABASE_URL");
const authToken = clean(process.env.TURSO_AUTH_TOKEN) ?? fromEnvFile("TURSO_AUTH_TOKEN");
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

async function tableExists(name) {
  const probe = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    args: [name],
  });
  return probe.rows.length > 0;
}

if (await tableExists("PublishBatch")) {
  console.log("· PublishBatch already exists — skip");
} else {
  await client.batch(
    [
      `CREATE TABLE "PublishBatch" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "marketplace" TEXT NOT NULL,
         "actor" TEXT NOT NULL,
         "requested_total" INTEGER NOT NULL,
         "status" TEXT NOT NULL DEFAULT 'QUEUED',
         "daily_cap_at_creation" INTEGER NOT NULL,
         "note" TEXT,
         "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updated_at" DATETIME NOT NULL,
         "started_at" DATETIME,
         "finished_at" DATETIME
       )`,
      `CREATE INDEX "PublishBatch_status_idx" ON "PublishBatch"("status")`,
      `CREATE INDEX "PublishBatch_marketplace_created_at_idx" ON "PublishBatch"("marketplace", "created_at")`,
    ],
    "write",
  );
  console.log("· PublishBatch created");
}

if (await tableExists("PublishBatchItem")) {
  console.log("· PublishBatchItem already exists — skip");
} else {
  await client.batch(
    [
      `CREATE TABLE "PublishBatchItem" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "publish_batch_id" TEXT NOT NULL,
         "bundle_draft_id" TEXT NOT NULL,
         "sku" TEXT,
         "position" INTEGER NOT NULL,
         "status" TEXT NOT NULL DEFAULT 'PENDING',
         "failed_stage" TEXT,
         "posted" BOOLEAN NOT NULL DEFAULT false,
         "attempts" INTEGER NOT NULL DEFAULT 0,
         "locked_at" DATETIME,
         "submission_id" TEXT,
         "last_error" TEXT,
         "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updated_at" DATETIME NOT NULL,
         "started_at" DATETIME,
         "finished_at" DATETIME,
         CONSTRAINT "PublishBatchItem_publish_batch_id_fkey"
           FOREIGN KEY ("publish_batch_id") REFERENCES "PublishBatch" ("id")
           ON DELETE CASCADE ON UPDATE CASCADE
       )`,
      `CREATE UNIQUE INDEX "PublishBatchItem_publish_batch_id_bundle_draft_id_key"
         ON "PublishBatchItem"("publish_batch_id", "bundle_draft_id")`,
      `CREATE INDEX "PublishBatchItem_publish_batch_id_status_idx"
         ON "PublishBatchItem"("publish_batch_id", "status")`,
      `CREATE INDEX "PublishBatchItem_locked_at_idx" ON "PublishBatchItem"("locked_at")`,
      `CREATE INDEX "PublishBatchItem_bundle_draft_id_idx" ON "PublishBatchItem"("bundle_draft_id")`,
    ],
    "write",
  );
  console.log("· PublishBatchItem created");
}

// A migration that cannot prove its own result is not a migration.
const present = [];
for (const name of ["PublishBatch", "PublishBatchItem"]) {
  const ok = await tableExists(name);
  present.push(`${name}=${ok ? "present" : "MISSING"}`);
  if (!ok) {
    console.error(`✗ ${name} is missing after migration`);
    process.exit(1);
  }
}
const counts = await client.execute(
  `SELECT (SELECT COUNT(*) FROM "PublishBatch") AS batches,
          (SELECT COUNT(*) FROM "PublishBatchItem") AS items`,
);
console.log(`✓ ${present.join(" / ")}`);
console.log(`✓ rows: ${JSON.stringify(counts.rows[0])}`);
process.exit(0);
