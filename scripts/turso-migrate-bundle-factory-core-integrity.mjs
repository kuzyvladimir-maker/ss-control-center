/**
 * Guarded Turso deployment for the Bundle Factory core-integrity migration.
 *
 * Read-only inspection is the default. Writes require both flags:
 *   node scripts/turso-migrate-bundle-factory-core-integrity.mjs
 *   node scripts/turso-migrate-bundle-factory-core-integrity.mjs \
 *     --apply --confirm=BUNDLE_FACTORY_CORE_INTEGRITY
 *
 * This changes only our database schema/internal lifecycle bookkeeping. It
 * never calls Amazon, Walmart, image services, or any listing API.
 */

import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const CONFIRMATION = "BUNDLE_FACTORY_CORE_INTEGRITY";
const argv = new Set(process.argv.slice(2));
const apply = argv.has("--apply");
const confirmArg = process.argv.slice(2).find((arg) => arg.startsWith("--confirm="));
const confirmation = confirmArg?.slice("--confirm=".length) ?? null;
const unknown = process.argv
  .slice(2)
  .filter((arg) => arg !== "--apply" && !arg.startsWith("--confirm="));

if (unknown.length > 0) {
  throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
}
if (apply && confirmation !== CONFIRMATION) {
  throw new Error(
    `Writes are locked. Re-run with --apply --confirm=${CONFIRMATION}`,
  );
}
if (!apply && confirmation) {
  throw new Error("--confirm is only valid together with --apply");
}

function clean(value) {
  return value?.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  throw new Error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
}

const client = createClient({ url, authToken });

async function tableColumns(table) {
  const result = await client.execute(`PRAGMA table_info("${table}")`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function tableExists(table) {
  const result = await client.execute({
    sql: `SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
    args: [table],
  });
  return result.rows.length > 0;
}

async function indexInfo(table) {
  const result = await client.execute(`PRAGMA index_list("${table}")`);
  return result.rows.map((row) => ({
    name: String(row.name),
    unique: Number(row.unique) === 1,
  }));
}

try {
  const draftColumns = await tableColumns("BundleDraft");
  const skuColumns = await tableColumns("ChannelSKU");
  const workItemExists = await tableExists("GenerationWorkItem");
  const masterIndexes = await indexInfo("MasterBundle");

  const missingDraft = [
    "approved_at",
    "approved_by",
    "published_at",
    "recipe_fingerprint",
  ].filter((column) => !draftColumns.has(column));
  const missingSku = ["available_quantity", "inventory_checked_at"].filter(
    (column) => !skuColumns.has(column),
  );
  const lineageUnique = masterIndexes.some(
    (index) => index.name === "MasterBundle_generation_job_id_key" && index.unique,
  );

  console.log(
    `Bundle Factory core migration: mode=${apply ? "APPLY" : "DRY-RUN"}`,
  );
  console.log(
    `  BundleDraft missing: ${missingDraft.join(", ") || "none"}`,
  );
  console.log(`  ChannelSKU missing: ${missingSku.join(", ") || "none"}`);
  console.log(
    `  GenerationWorkItem: ${workItemExists ? "present" : "missing"}`,
  );
  console.log(
    `  generation_job_id cardinality: ${lineageUnique ? "incorrect UNIQUE" : "non-unique/ready"}`,
  );

  const statements = [];
  statements.push(`DROP INDEX IF EXISTS "MasterBundle_generation_job_id_key"`);
  statements.push(
    `CREATE INDEX IF NOT EXISTS "MasterBundle_generation_job_id_idx" ON "MasterBundle"("generation_job_id")`,
  );

  const draftDdl = {
    approved_at: `ALTER TABLE "BundleDraft" ADD COLUMN "approved_at" DATETIME`,
    approved_by: `ALTER TABLE "BundleDraft" ADD COLUMN "approved_by" TEXT`,
    published_at: `ALTER TABLE "BundleDraft" ADD COLUMN "published_at" DATETIME`,
    recipe_fingerprint: `ALTER TABLE "BundleDraft" ADD COLUMN "recipe_fingerprint" TEXT`,
  };
  for (const column of missingDraft) statements.push(draftDdl[column]);
  statements.push(
    `CREATE UNIQUE INDEX IF NOT EXISTS "BundleDraft_recipe_fingerprint_key" ON "BundleDraft"("recipe_fingerprint")`,
    `CREATE INDEX IF NOT EXISTS "BundleDraft_approved_at_idx" ON "BundleDraft"("approved_at")`,
  );

  const skuDdl = {
    available_quantity: `ALTER TABLE "ChannelSKU" ADD COLUMN "available_quantity" INTEGER`,
    inventory_checked_at: `ALTER TABLE "ChannelSKU" ADD COLUMN "inventory_checked_at" DATETIME`,
  };
  for (const column of missingSku) statements.push(skuDdl[column]);

  statements.push(`
    CREATE TABLE IF NOT EXISTS "GenerationWorkItem" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "generation_job_id" TEXT NOT NULL,
      "spec_index" INTEGER NOT NULL,
      "spec_json" TEXT NOT NULL,
      "fingerprint" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "locked_at" DATETIME,
      "last_error" TEXT,
      "bundle_draft_id" TEXT,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL,
      CONSTRAINT "GenerationWorkItem_generation_job_id_fkey"
        FOREIGN KEY ("generation_job_id") REFERENCES "GenerationJob"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "GenerationWorkItem_bundle_draft_id_fkey"
        FOREIGN KEY ("bundle_draft_id") REFERENCES "BundleDraft"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  statements.push(
    `CREATE UNIQUE INDEX IF NOT EXISTS "GenerationWorkItem_generation_job_id_spec_index_key" ON "GenerationWorkItem"("generation_job_id", "spec_index")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GenerationWorkItem_generation_job_id_fingerprint_key" ON "GenerationWorkItem"("generation_job_id", "fingerprint")`,
    `CREATE INDEX IF NOT EXISTS "GenerationWorkItem_generation_job_id_status_idx" ON "GenerationWorkItem"("generation_job_id", "status")`,
    `CREATE INDEX IF NOT EXISTS "GenerationWorkItem_bundle_draft_id_idx" ON "GenerationWorkItem"("bundle_draft_id")`,
    `CREATE INDEX IF NOT EXISTS "GenerationWorkItem_locked_at_idx" ON "GenerationWorkItem"("locked_at")`,
  );

  // Only factual marketplace lifecycle is backfilled. Historical approval is
  // deliberately not invented; operators must explicitly approve again.
  statements.push(`
    UPDATE "BundleDraft"
    SET "published_at" = (
          SELECT MIN(COALESCE(cs."published_at", cs."last_status_check_at", cs."updated_at"))
          FROM "ChannelSKU" cs
          WHERE cs."master_bundle_id" = "BundleDraft"."master_bundle_id"
            AND cs."listing_status" = 'LIVE'
        ),
        "status" = 'PUBLISHED'
    WHERE EXISTS (
      SELECT 1 FROM "ChannelSKU" cs
      WHERE cs."master_bundle_id" = "BundleDraft"."master_bundle_id"
        AND cs."listing_status" = 'LIVE'
    )
  `);
  statements.push(`
    UPDATE "ChannelSKU"
    SET "lifecycle_status" = CASE
          WHEN "listing_status" = 'LIVE' THEN 'LIVE'
          WHEN "listing_status" = 'SUBMITTED' THEN 'SUBMITTED'
          WHEN "listing_status" = 'PENDING_REVIEW' THEN 'PROCESSING'
          WHEN "listing_status" = 'FAILED' THEN 'ERROR'
          ELSE "lifecycle_status"
        END,
        "live_at" = CASE
          WHEN "listing_status" = 'LIVE' THEN COALESCE("live_at", "published_at")
          ELSE "live_at"
        END
  `);
  statements.push(`
    UPDATE "MasterBundle"
    SET "lifecycle_status" = 'LIVE'
    WHERE EXISTS (
      SELECT 1 FROM "ChannelSKU" cs
      WHERE cs."master_bundle_id" = "MasterBundle"."id"
        AND cs."listing_status" = 'LIVE'
    )
  `);
  statements.push(`
    UPDATE "GenerationJob"
    SET "bundles_approved" = 0,
        "bundles_published" = (
          SELECT COUNT(*) FROM "BundleDraft" d
          WHERE d."generation_job_id" = "GenerationJob"."id"
            AND d."published_at" IS NOT NULL
        )
  `);

  if (!apply) {
    console.log(
      `No writes made. Apply requires --apply --confirm=${CONFIRMATION}`,
    );
    process.exitCode =
      missingDraft.length || missingSku.length || !workItemExists || lineageUnique
        ? 2
        : 0;
  } else {
    await client.batch(statements, "write");

    const verifiedDraft = await tableColumns("BundleDraft");
    const verifiedSku = await tableColumns("ChannelSKU");
    const verifiedWorkItem = await tableExists("GenerationWorkItem");
    const verifiedIndexes = await indexInfo("MasterBundle");
    const missingAfter = [
      ...["approved_at", "approved_by", "published_at", "recipe_fingerprint"].filter(
        (column) => !verifiedDraft.has(column),
      ),
      ...["available_quantity", "inventory_checked_at"].filter(
        (column) => !verifiedSku.has(column),
      ),
    ];
    const uniqueAfter = verifiedIndexes.some(
      (index) => index.name === "MasterBundle_generation_job_id_key" && index.unique,
    );
    if (missingAfter.length || !verifiedWorkItem || uniqueAfter) {
      throw new Error(
        `Post-migration verification failed: missing=${missingAfter.join(",") || "none"}, work_items=${verifiedWorkItem}, lineage_unique=${uniqueAfter}`,
      );
    }
    console.log("Migration applied and schema verification passed.");
  }
} finally {
  client.close();
}
