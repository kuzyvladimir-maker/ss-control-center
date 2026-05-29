// Turso migration: Adjustments Phase A.
//
// Recreates ShippingAdjustment to:
//   • make orderId nullable (PostageBilling_PostageAdjustment carries none)
//   • add storeId, currency, rawType columns
//   • add (channel,createdAt) / (adjustmentDate) / (sku) indexes
//
// Idempotent — checks for the rawType column first and exits if already
// migrated.
//
//   node -r dotenv/config scripts/turso-migrate-adjustments-phase-a.mjs

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

// Idempotency probe — if rawType column exists, this migration already ran.
const cols = await client.execute({
  sql: `PRAGMA table_info("ShippingAdjustment")`,
});
const hasRawType = cols.rows.some((r) => String(r.name) === "rawType");
if (hasRawType) {
  console.log("· already migrated (rawType column present) — skipping");
  client.close();
  process.exit(0);
}

// Safety: verify the table is empty before recreating. The 2026-05-22
// audit confirmed 0 rows on prod, but re-check at runtime in case
// something landed since.
const count = await client.execute({
  sql: `SELECT COUNT(*) AS n FROM "ShippingAdjustment"`,
});
const n = Number(count.rows[0]?.n ?? 0);
if (n > 0) {
  console.error(
    `✗ ShippingAdjustment is not empty (${n} rows). Aborting — manual review needed before destructive recreate.`,
  );
  process.exit(2);
}

console.log("Recreating ShippingAdjustment…");

await client.batch(
  [
    `PRAGMA defer_foreign_keys=ON`,
    `PRAGMA foreign_keys=OFF`,
    `CREATE TABLE "new_ShippingAdjustment" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "externalId" TEXT NOT NULL,
       "channel" TEXT NOT NULL,
       "storeId" TEXT,
       "currency" TEXT,
       "orderId" TEXT,
       "amazonOrderId" TEXT,
       "walmartOrderId" TEXT,
       "adjustmentDate" TEXT NOT NULL,
       "adjustmentType" TEXT NOT NULL,
       "adjustmentAmount" REAL NOT NULL,
       "adjustmentReason" TEXT,
       "rawType" TEXT,
       "sku" TEXT,
       "productName" TEXT,
       "carrier" TEXT,
       "service" TEXT,
       "declaredWeightLbs" REAL,
       "declaredDimL" REAL,
       "declaredDimW" REAL,
       "declaredDimH" REAL,
       "originalLabelCost" REAL,
       "adjustedWeightLbs" REAL,
       "adjustedDimL" REAL,
       "adjustedDimW" REAL,
       "adjustedDimH" REAL,
       "reviewed" BOOLEAN NOT NULL DEFAULT false,
       "skuDataFixed" BOOLEAN NOT NULL DEFAULT false,
       "notes" TEXT
     )`,
    `DROP TABLE "ShippingAdjustment"`,
    `ALTER TABLE "new_ShippingAdjustment" RENAME TO "ShippingAdjustment"`,
    `CREATE UNIQUE INDEX "ShippingAdjustment_externalId_key" ON "ShippingAdjustment"("externalId")`,
    `CREATE INDEX "ShippingAdjustment_channel_createdAt_idx" ON "ShippingAdjustment"("channel", "createdAt")`,
    `CREATE INDEX "ShippingAdjustment_adjustmentDate_idx" ON "ShippingAdjustment"("adjustmentDate")`,
    `CREATE INDEX "ShippingAdjustment_sku_idx" ON "ShippingAdjustment"("sku")`,
    `PRAGMA foreign_keys=ON`,
    `PRAGMA defer_foreign_keys=OFF`,
  ],
  "write",
);

// Register as applied in Prisma's bookkeeping table so subsequent
// `prisma migrate deploy` against this Turso doesn't try to re-apply.
const MIGRATION_NAME = "20260529000000_adjustments_phase_a_real_types";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations"
            ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [
      crypto.randomUUID(),
      "turso-applied",
      MIGRATION_NAME,
    ],
  });
  console.log(`✓ registered ${MIGRATION_NAME} in _prisma_migrations`);
} catch (e) {
  // Table missing or row exists — non-fatal.
  console.log(
    `  (_prisma_migrations bookkeeping skipped: ${e instanceof Error ? e.message : e})`,
  );
}

console.log("✓ Phase A migration done.");
client.close();
