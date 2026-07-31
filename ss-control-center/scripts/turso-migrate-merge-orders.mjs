// Apply the Merge Orders tables to Turso.
//
// Idempotent: every statement is CREATE ... IF NOT EXISTS, so re-running is a
// no-op. Mirrors prisma/migrations/20260731130000_merge_orders/migration.sql —
// a migration sitting in the working tree does NOT mean the schema reached
// Turso, so this is the step that actually proves it.
//
//   node scripts/turso-migrate-merge-orders.mjs          # apply
//   node scripts/turso-migrate-merge-orders.mjs --check  # verify only
//
// Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from .env (or .env.local).

import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@libsql/client";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, "").trim();
      // .env.local wins, matching Next.js precedence.
      if (file === ".env.local" || env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

const env = loadEnv();
if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing from env");
  process.exit(1);
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "MergeGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "channelKind" TEXT NOT NULL,
    "storeName" TEXT,
    "primaryOrderId" TEXT NOT NULL,
    "productType" TEXT,
    "boxSize" TEXT,
    "weight" REAL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "service" TEXT,
    "price" REAL,
    "labelPdfUrl" TEXT,
    "boughtAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "MergeGroup_status_idx" ON "MergeGroup"("status")`,
  `CREATE INDEX IF NOT EXISTS "MergeGroup_checksum_idx" ON "MergeGroup"("checksum")`,
  `CREATE TABLE IF NOT EXISTS "MergeGroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "allocationId" TEXT,
    "walmartPurchaseOrderId" TEXT,
    "shipmentSyncedAt" DATETIME,
    "shipmentSyncError" TEXT,
    CONSTRAINT "MergeGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MergeGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MergeGroupMember_groupId_orderId_key" ON "MergeGroupMember"("groupId", "orderId")`,
  `CREATE INDEX IF NOT EXISTS "MergeGroupMember_orderId_idx" ON "MergeGroupMember"("orderId")`,
];

const EXPECTED_COLUMNS = {
  MergeGroup: [
    "id", "checksum", "channelKind", "storeName", "primaryOrderId",
    "productType", "boxSize", "weight", "status", "trackingNumber",
    "carrier", "service", "price", "labelPdfUrl", "boughtAt",
    "createdAt", "updatedAt",
  ],
  MergeGroupMember: [
    "id", "groupId", "orderId", "orderNumber", "allocationId",
    "walmartPurchaseOrderId", "shipmentSyncedAt", "shipmentSyncError",
  ],
};

const db = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});

const checkOnly = process.argv.includes("--check");

if (!checkOnly) {
  for (const sql of STATEMENTS) {
    await db.execute(sql);
  }
  console.log(`applied ${STATEMENTS.length} statement(s)`);
}

// Verify by reading the schema back — "the migration ran" is not the same
// claim as "the table is there with the right columns".
let ok = true;
for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
  const info = await db.execute(`PRAGMA table_info("${table}")`);
  const actual = info.rows.map((r) => String(r.name));
  const missing = expected.filter((c) => !actual.includes(c));
  if (actual.length === 0) {
    console.error(`  ✗ ${table}: table does not exist`);
    ok = false;
  } else if (missing.length) {
    console.error(`  ✗ ${table}: missing columns ${missing.join(", ")}`);
    ok = false;
  } else {
    const count = await db.execute(`SELECT count(*) AS c FROM "${table}"`);
    console.log(
      `  ✓ ${table}: ${actual.length} columns, ${count.rows[0].c} row(s)`,
    );
  }
}

process.exit(ok ? 0 : 1);
