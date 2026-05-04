// One-off migration: create the 3 new Procurement tables on Turso.
// Each statement uses IF NOT EXISTS so the script is idempotent.

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "SKUStorePriority" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "ProcurementSyncQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" DATETIME,
    "errorMessage" TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS "ProcurementNotificationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "notifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "SKUStorePriority_sku_idx" ON "SKUStorePriority"("sku")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SKUStorePriority_sku_storeName_key" ON "SKUStorePriority"("sku", "storeName")`,
  `CREATE INDEX IF NOT EXISTS "ProcurementSyncQueue_status_idx" ON "ProcurementSyncQueue"("status")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProcurementNotificationLog_orderId_key" ON "ProcurementNotificationLog"("orderId")`,
  `CREATE INDEX IF NOT EXISTS "ProcurementNotificationLog_notifiedAt_idx" ON "ProcurementNotificationLog"("notifiedAt")`,
];

for (const sql of STATEMENTS) {
  const head = sql.replace(/\s+/g, " ").slice(0, 80);
  try {
    await client.execute(sql);
    console.log(`OK  ${head}`);
  } catch (e) {
    console.error(`ERR ${head}`);
    console.error("    ", e.message ?? e);
    process.exit(2);
  }
}

console.log("\n✓ All procurement tables ensured on Turso.");
process.exit(0);
