// Turso migration: per-SKU performance rollup (sales / units / returns) over
// 30 / 90 / 180 day windows, computed from our own WalmartOrder history (the
// Walmart listing-quality API returns empty GMV for us). Powers the Listing
// Optimizer's health badges, sortable columns and performance filters.
//
//   node --env-file=.env --env-file=.env.local scripts/turso-migrate-sku-perf.mjs

import { createClient } from "@libsql/client";
import crypto from "crypto";
function clean(v){ return v ? v.trim().replace(/^['"]|['"]$/g,"") : v; }
const url = clean(process.env.TURSO_DATABASE_URL), authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO creds"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);

const exists = await client.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartSkuPerf'` });
if (exists.rows.length) { console.log("· already migrated — skipping"); client.close(); process.exit(0); }

await client.batch([
  `CREATE TABLE "WalmartSkuPerf" (
     "sku" TEXT NOT NULL,
     "storeIndex" INTEGER NOT NULL DEFAULT 1,
     "units30" INTEGER NOT NULL DEFAULT 0, "sales30" REAL NOT NULL DEFAULT 0, "orders30" INTEGER NOT NULL DEFAULT 0, "returns30" INTEGER NOT NULL DEFAULT 0,
     "units90" INTEGER NOT NULL DEFAULT 0, "sales90" REAL NOT NULL DEFAULT 0, "orders90" INTEGER NOT NULL DEFAULT 0, "returns90" INTEGER NOT NULL DEFAULT 0,
     "units180" INTEGER NOT NULL DEFAULT 0, "sales180" REAL NOT NULL DEFAULT 0, "orders180" INTEGER NOT NULL DEFAULT 0, "returns180" INTEGER NOT NULL DEFAULT 0,
     "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY ("storeIndex","sku")
   )`,
  `CREATE INDEX "WalmartSkuPerf_sales30_idx" ON "WalmartSkuPerf"("storeIndex","sales30")`,
], "write");

try {
  await client.execute({ sql: `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count") VALUES (?,?,CURRENT_TIMESTAMP,?,NULL,NULL,CURRENT_TIMESTAMP,1)`, args: [crypto.randomUUID(), "turso-applied", "20260614170000_walmart_sku_perf"] });
  console.log("✓ registered migration");
} catch (e) { console.log(`  (bookkeeping skipped: ${e?.message})`); }
console.log("✓ perf table done."); client.close();
