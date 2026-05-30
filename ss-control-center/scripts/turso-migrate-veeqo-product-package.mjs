// Turso migration: add Veeqo product + package columns to
// AmazonOrderShipment and ShippingAdjustment. Idempotent.

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

const alters = [
  { table: "AmazonOrderShipment", col: "productName",      sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "productName" TEXT` },
  { table: "AmazonOrderShipment", col: "productImageUrl",  sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "productImageUrl" TEXT` },
  { table: "AmazonOrderShipment", col: "packageWeightLbs", sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageWeightLbs" REAL` },
  { table: "AmazonOrderShipment", col: "packageDimL",      sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageDimL" REAL` },
  { table: "AmazonOrderShipment", col: "packageDimW",      sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageDimW" REAL` },
  { table: "AmazonOrderShipment", col: "packageDimH",      sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageDimH" REAL` },
  { table: "AmazonOrderShipment", col: "packageName",      sql: `ALTER TABLE "AmazonOrderShipment" ADD COLUMN "packageName" TEXT` },
  { table: "ShippingAdjustment",  col: "productImageUrl",  sql: `ALTER TABLE "ShippingAdjustment" ADD COLUMN "productImageUrl" TEXT` },
  { table: "ShippingAdjustment",  col: "trackingNumber",   sql: `ALTER TABLE "ShippingAdjustment" ADD COLUMN "trackingNumber" TEXT` },
];

let applied = 0, skipped = 0;
for (const a of alters) {
  const info = await client.execute({ sql: `PRAGMA table_info("${a.table}")` });
  if (info.rows.some((r) => String(r.name) === a.col)) {
    console.log(`  · skip ${a.table}.${a.col}`);
    skipped++;
    continue;
  }
  await client.execute(a.sql);
  console.log(`  ✓ add  ${a.table}.${a.col}`);
  applied++;
}

const MIGRATION_NAME = "20260530020000_veeqo_product_and_package";
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

console.log(`\n✓ Done — applied ${applied}, skipped ${skipped}`);
client.close();
