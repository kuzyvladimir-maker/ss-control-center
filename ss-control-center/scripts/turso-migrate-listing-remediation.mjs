// Turso migration: Walmart listing remediation event log.
//
// One row per change we APPLY to a listing (the multipack fix, and future
// content edits). Captures WHAT changed + the item's metrics BEFORE the change
// and (filled later by the measure-after job) AFTER — so we can learn which
// edits actually moved listing-quality score, conversion, page views, and GMV.
//
// Additive only. Idempotent — exits early if the table already exists.
//
//   node -r dotenv/config scripts/turso-migrate-listing-remediation.mjs

import { createClient } from "@libsql/client";
import crypto from "crypto";

function clean(v) { return v ? v.trim().replace(/^['"]|['"]$/g, "") : v; }
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN"); process.exit(1); }

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const existing = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartListingRemediation'`,
});
if (existing.rows.length > 0) {
  console.log("· already migrated (WalmartListingRemediation present) — skipping");
  client.close();
  process.exit(0);
}

console.log("Creating WalmartListingRemediation…");
await client.batch(
  [
    `CREATE TABLE "WalmartListingRemediation" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "sku" TEXT NOT NULL,
       "wpid" TEXT,
       "upc" TEXT,
       "buyerItemId" TEXT,
       "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       -- what we changed
       "changeType" TEXT NOT NULL DEFAULT 'multipack',
       "feedId" TEXT,
       "feedType" TEXT,
       "feedStatus" TEXT,
       "ok" BOOLEAN NOT NULL DEFAULT false,
       "packCount" INTEGER,
       "newTitle" TEXT,
       "titleChanged" BOOLEAN NOT NULL DEFAULT false,
       "bulletsCount" INTEGER,
       "imagesCount" INTEGER,
       "descriptionLength" INTEGER,
       "mainImageUrl" TEXT,
       "usedAiPolish" BOOLEAN NOT NULL DEFAULT false,
       "changeSummary" TEXT,           -- JSON: full detail of the applied content

       -- metrics BEFORE the change (snapshot from WalmartListingQualityItem)
       "beforeCapturedAt" DATETIME,
       "beforeLqScore" REAL,
       "beforeContentScore" REAL,
       "beforeConversionRate30d" REAL,
       "beforePageViews30d" INTEGER,
       "beforeGmv30d" REAL,
       "beforeUnits30d" INTEGER,
       "beforeIssueCount" INTEGER,

       -- metrics AFTER (filled by measure-after job once a later sweep lands)
       "afterCapturedAt" DATETIME,
       "afterLqScore" REAL,
       "afterContentScore" REAL,
       "afterConversionRate30d" REAL,
       "afterPageViews30d" INTEGER,
       "afterGmv30d" REAL,
       "afterUnits30d" INTEGER,
       "afterIssueCount" INTEGER,

       "notes" TEXT,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX "WalmartListingRemediation_sku_runAt_idx" ON "WalmartListingRemediation"("sku", "runAt")`,
    `CREATE INDEX "WalmartListingRemediation_runAt_idx" ON "WalmartListingRemediation"("runAt")`,
    `CREATE INDEX "WalmartListingRemediation_after_idx" ON "WalmartListingRemediation"("afterCapturedAt")`,
  ],
  "write",
);

const MIGRATION_NAME = "20260614120000_walmart_listing_remediation";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations"
            ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [crypto.randomUUID(), "turso-applied", MIGRATION_NAME],
  });
  console.log(`✓ registered ${MIGRATION_NAME}`);
} catch (e) {
  console.log(`  (_prisma_migrations bookkeeping skipped: ${e instanceof Error ? e.message : e})`);
}
console.log("✓ remediation migration done.");
client.close();
