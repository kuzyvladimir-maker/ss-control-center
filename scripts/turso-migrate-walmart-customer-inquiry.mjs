// Turso migration: WalmartCustomerInquiry table.

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
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartCustomerInquiry'`,
});
if (probe.rows.length > 0) {
  console.log("· table already exists — skipping");
  client.close();
  process.exit(0);
}

await client.batch(
  [
    `CREATE TABLE "WalmartCustomerInquiry" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" DATETIME NOT NULL,
       "purchaseOrderId" TEXT NOT NULL,
       "customerOrderId" TEXT,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "relayEmail" TEXT NOT NULL,
       "sentByEmail" TEXT NOT NULL,
       "customerName" TEXT,
       "sku" TEXT,
       "productTitle" TEXT,
       "orderedQty" INTEGER,
       "packSize" INTEGER,
       "totalUnits" INTEGER,
       "subject" TEXT NOT NULL,
       "bodySent" TEXT NOT NULL,
       "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "status" TEXT NOT NULL DEFAULT 'SENT',
       "replyText" TEXT,
       "repliedAt" DATETIME
     )`,
    `CREATE UNIQUE INDEX "WalmartCustomerInquiry_purchaseOrderId_key"
       ON "WalmartCustomerInquiry"("purchaseOrderId")`,
    `CREATE INDEX "WalmartCustomerInquiry_status_idx"
       ON "WalmartCustomerInquiry"("status")`,
    `CREATE INDEX "WalmartCustomerInquiry_sentAt_idx"
       ON "WalmartCustomerInquiry"("sentAt")`,
    `CREATE INDEX "WalmartCustomerInquiry_customerOrderId_idx"
       ON "WalmartCustomerInquiry"("customerOrderId")`,
  ],
  "write",
);

const MIGRATION_NAME = "20260607000000_walmart_customer_inquiry";
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

console.log("✓ WalmartCustomerInquiry migration done.");
client.close();
