// Turso migration: WalmartSkuFulfillment (per-SKU fulfillment speed). Additive, idempotent.
//   node -r dotenv/config scripts/turso-migrate-walmart-sku-fulfillment.mjs
import { createClient } from "@libsql/client";
function clean(v){ return v ? v.trim().replace(/^['"]|['"]$/g,"") : v; }
const url = clean(process.env.TURSO_DATABASE_URL), authToken = clean(process.env.TURSO_AUTH_TOKEN);
if(!url||!authToken){ console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1]||url}`);
const ex = await client.execute({ sql:`SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartSkuFulfillment'` });
if(ex.rows.length){ console.log("· already migrated — skip"); client.close(); process.exit(0); }
await client.batch([
  `CREATE TABLE "WalmartSkuFulfillment" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "storeIndex" INTEGER NOT NULL DEFAULT 1,
     "sku" TEXT NOT NULL,
     "orders" INTEGER NOT NULL,
     "avgHandlingDays" REAL NOT NULL,
     "minHandlingDays" INTEGER NOT NULL,
     "maxHandlingDays" INTEGER NOT NULL,
     "classification" TEXT NOT NULL,
     "carriers" TEXT,
     "lastOrderAt" DATETIME,
     "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX "WalmartSkuFulfillment_storeIndex_sku_key" ON "WalmartSkuFulfillment"("storeIndex","sku")`,
  `CREATE INDEX "WalmartSkuFulfillment_storeIndex_classification_idx" ON "WalmartSkuFulfillment"("storeIndex","classification")`,
  `CREATE INDEX "WalmartSkuFulfillment_storeIndex_avgHandlingDays_idx" ON "WalmartSkuFulfillment"("storeIndex","avgHandlingDays")`,
],"write");
try{
  await client.execute({ sql:`INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count") VALUES (?,?,CURRENT_TIMESTAMP,?,NULL,NULL,CURRENT_TIMESTAMP,1)`, args:[crypto.randomUUID(),"turso-applied","20260607160000_walmart_sku_fulfillment"] });
  console.log("✓ registered migration");
}catch(e){ console.log("  bookkeeping skip:", e.message); }
console.log("✓ done"); client.close();
