// Turso migration: add outboundLabelCost column to AmazonOrderShipment.
// Idempotent — checks for column existence first.
//
//   node -r dotenv/config scripts/turso-migrate-outbound-label-cost.mjs

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

const cols = await client.execute({
  sql: `PRAGMA table_info("AmazonOrderShipment")`,
});
const has = cols.rows.some((r) => String(r.name) === "outboundLabelCost");
if (has) {
  console.log("· column already exists — skipping");
  client.close();
  process.exit(0);
}

await client.execute(
  `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "outboundLabelCost" REAL`,
);
console.log("✓ Added AmazonOrderShipment.outboundLabelCost");

const MIGRATION_NAME = "20260530010000_add_outbound_label_cost";
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

client.close();
