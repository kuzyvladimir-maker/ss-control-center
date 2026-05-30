// Turso migration: dispute tracking fields on ShippingAdjustment.

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
  { col: "disputeCaseId", sql: `ALTER TABLE "ShippingAdjustment" ADD COLUMN "disputeCaseId" TEXT` },
  { col: "disputedAt",    sql: `ALTER TABLE "ShippingAdjustment" ADD COLUMN "disputedAt" DATETIME` },
];

const info = await client.execute({ sql: `PRAGMA table_info("ShippingAdjustment")` });
const existing = new Set(info.rows.map((r) => String(r.name)));

let applied = 0, skipped = 0;
for (const a of alters) {
  if (existing.has(a.col)) {
    console.log(`  · skip ${a.col}`);
    skipped++;
    continue;
  }
  await client.execute(a.sql);
  console.log(`  ✓ add  ${a.col}`);
  applied++;
}

const MIGRATION_NAME = "20260530030000_dispute_tracking";
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
