// Turso migration: remediation run queue. The frontend enqueues SKUs to remediate;
// the batch CLI (walmart-multipack-batch.ts --from-queue) drains it. Keeps heavy
// work (image gen, Claude, feeds) off the serverless request path.
//
//   node --env-file=.env --env-file=.env.local scripts/turso-migrate-remediation-queue.mjs

import { createClient } from "@libsql/client";
import crypto from "crypto";

function clean(v) { return v ? v.trim().replace(/^['"]|['"]$/g, "") : v; }
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const existing = await client.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartRemediationQueue'` });
if (existing.rows.length > 0) { console.log("· already migrated — skipping"); client.close(); process.exit(0); }

await client.batch([
  `CREATE TABLE "WalmartRemediationQueue" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "storeIndex" INTEGER NOT NULL DEFAULT 1,
     "sku" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | error
     "requestedBy" TEXT,
     "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "startedAt" DATETIME,
     "finishedAt" DATETIME,
     "feedId" TEXT,
     "result" TEXT,
     "error" TEXT
   )`,
  `CREATE UNIQUE INDEX "WalmartRemediationQueue_sku_active_key"
     ON "WalmartRemediationQueue"("storeIndex","sku") WHERE status IN ('queued','running')`,
  `CREATE INDEX "WalmartRemediationQueue_status_idx" ON "WalmartRemediationQueue"("status","queuedAt")`,
], "write");

const NAME = "20260614150000_walmart_remediation_queue";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [crypto.randomUUID(), "turso-applied", NAME],
  });
  console.log(`✓ registered ${NAME}`);
} catch (e) { console.log(`  (bookkeeping skipped: ${e?.message})`); }
console.log("✓ queue migration done.");
client.close();
