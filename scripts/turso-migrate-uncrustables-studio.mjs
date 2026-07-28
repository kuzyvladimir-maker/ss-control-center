// Turso migration: Uncrustables Studio Phase A — three tables
// (UncrustablesStudioRun / UncrustablesStudioCandidate /
//  UncrustablesOwnerApprovalManifestRecord).
// Owner gate: «го» 2026-07-27. Idempotent: probes each table before creating.
// Mirrors prisma/migrations/20260727063000_uncrustables_studio_phase_a.

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
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

if (await tableExists("UncrustablesStudioRun")) {
  console.log("· UncrustablesStudioRun already exists — skip");
} else {
  await client.batch(
    [
      `CREATE TABLE "UncrustablesStudioRun" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "name" TEXT NOT NULL,
         "status" TEXT NOT NULL DEFAULT 'ACTIVE',
         "owner_order" TEXT NOT NULL,
         "created_by" TEXT NOT NULL,
         "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updated_at" DATETIME NOT NULL
       )`,
      `CREATE INDEX "UncrustablesStudioRun_status_idx" ON "UncrustablesStudioRun"("status")`,
    ],
    "write",
  );
  console.log("· UncrustablesStudioRun created");
}

if (await tableExists("UncrustablesStudioCandidate")) {
  console.log("· UncrustablesStudioCandidate already exists — skip");
} else {
  await client.batch(
    [
      `CREATE TABLE "UncrustablesStudioCandidate" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "run_id" TEXT NOT NULL,
         "slug" TEXT NOT NULL,
         "state" TEXT NOT NULL DEFAULT 'PLANNED',
         "recipe_json" TEXT NOT NULL,
         "title" TEXT NOT NULL,
         "bullets_json" TEXT NOT NULL,
         "description" TEXT NOT NULL,
         "price_cents" INTEGER NOT NULL,
         "cost_cents" INTEGER,
         "pack_count" INTEGER NOT NULL,
         "render_attempts" INTEGER NOT NULL DEFAULT 0,
         "prompt" TEXT,
         "reference_urls" TEXT,
         "main_image_url" TEXT,
         "image_sha256" TEXT,
         "pixel_width" INTEGER,
         "pixel_height" INTEGER,
         "reviewed_by" TEXT,
         "reviewed_at" DATETIME,
         "reject_reason" TEXT,
         "draft_id" TEXT,
         "master_bundle_id" TEXT,
         "channel_sku_id" TEXT,
         "sku" TEXT,
         "proof_id" TEXT,
         "manifest_record_id" TEXT,
         "submission_id" TEXT,
         "asin" TEXT,
         "last_error" TEXT,
         "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updated_at" DATETIME NOT NULL,
         CONSTRAINT "UncrustablesStudioCandidate_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "UncrustablesStudioRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
       )`,
      `CREATE UNIQUE INDEX "UncrustablesStudioCandidate_run_id_slug_key" ON "UncrustablesStudioCandidate"("run_id", "slug")`,
      `CREATE INDEX "UncrustablesStudioCandidate_state_idx" ON "UncrustablesStudioCandidate"("state")`,
      `CREATE INDEX "UncrustablesStudioCandidate_run_id_idx" ON "UncrustablesStudioCandidate"("run_id")`,
    ],
    "write",
  );
  console.log("· UncrustablesStudioCandidate created");
}

if (await tableExists("UncrustablesOwnerApprovalManifestRecord")) {
  console.log("· UncrustablesOwnerApprovalManifestRecord already exists — skip");
} else {
  await client.batch(
    [
      `CREATE TABLE "UncrustablesOwnerApprovalManifestRecord" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "manifest_id" TEXT NOT NULL,
         "sha256" TEXT NOT NULL,
         "body_json" TEXT NOT NULL,
         "entry_count" INTEGER NOT NULL,
         "approved_by" TEXT NOT NULL,
         "captured_at" DATETIME NOT NULL,
         "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      `CREATE UNIQUE INDEX "UncrustablesOwnerApprovalManifestRecord_manifest_id_key" ON "UncrustablesOwnerApprovalManifestRecord"("manifest_id")`,
      `CREATE UNIQUE INDEX "UncrustablesOwnerApprovalManifestRecord_sha256_key" ON "UncrustablesOwnerApprovalManifestRecord"("sha256")`,
    ],
    "write",
  );
  console.log("· UncrustablesOwnerApprovalManifestRecord created");
}

const check = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name IN
        ('UncrustablesStudioRun','UncrustablesStudioCandidate','UncrustablesOwnerApprovalManifestRecord')
        ORDER BY name`,
});
console.log(
  `✓ present: ${check.rows.map((r) => r.name).join(", ")} (${check.rows.length}/3)`,
);
client.close();
