// Turso migration: WalmartCancellationRequest table.

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

const probe = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartCancellationRequest'`,
});
if (probe.rows.length > 0) {
  console.log("· table already exists — skipping");
  client.close();
  process.exit(0);
}

await client.batch(
  [
    `CREATE TABLE "WalmartCancellationRequest" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" DATETIME NOT NULL,
       "purchaseOrderId" TEXT NOT NULL,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "customerOrderId" TEXT,
       "productName" TEXT,
       "orderTotal" REAL,
       "shipBy" DATETIME,
       "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "actionedAt" DATETIME,
       "action" TEXT NOT NULL DEFAULT 'PENDING',
       "telegramSent" BOOLEAN NOT NULL DEFAULT false,
       "notes" TEXT
     )`,
    `CREATE UNIQUE INDEX "WalmartCancellationRequest_purchaseOrderId_key"
       ON "WalmartCancellationRequest"("purchaseOrderId")`,
    `CREATE INDEX "WalmartCancellationRequest_action_idx"
       ON "WalmartCancellationRequest"("action")`,
    `CREATE INDEX "WalmartCancellationRequest_detectedAt_idx"
       ON "WalmartCancellationRequest"("detectedAt")`,
  ],
  "write",
);

const MIGRATION_NAME = "20260530040000_walmart_cancel_requests";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations"
            ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [crypto.randomUUID(), "turso-applied", MIGRATION_NAME],
  });
} catch (e) {
  console.log(`  (_prisma_migrations bookkeeping skipped: ${e.message})`);
}

console.log("✓ WalmartCancellationRequest migration done.");
client.close();
