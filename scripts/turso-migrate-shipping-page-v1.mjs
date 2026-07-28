// One-off Turso migration for the Shipping Labels Page v1 overhaul.
// - Extends ProductTypeOverride (source, aiConfidence, aiReasoning,
//   syncedToVeeqo, veeqoSyncError, updatedAt).
// - Adds PackingProfile table (signature-keyed) with all v1 fields.
// Idempotent — safe to re-run.

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

async function addColumnIfMissing(table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info("${table}")`);
  if (info.rows.some((r) => r.name === column)) {
    console.log(`  · ${table}.${column} already exists`);
    return;
  }
  await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`  + added ${table}.${column}`);
}

console.log("Extending ProductTypeOverride…");
await addColumnIfMissing("ProductTypeOverride", "source",         `"source" TEXT NOT NULL DEFAULT 'manual'`);
await addColumnIfMissing("ProductTypeOverride", "aiConfidence",   `"aiConfidence" REAL`);
await addColumnIfMissing("ProductTypeOverride", "aiReasoning",    `"aiReasoning" TEXT`);
await addColumnIfMissing("ProductTypeOverride", "syncedToVeeqo",  `"syncedToVeeqo" INTEGER NOT NULL DEFAULT 0`);
await addColumnIfMissing("ProductTypeOverride", "veeqoSyncError", `"veeqoSyncError" TEXT`);
await addColumnIfMissing("ProductTypeOverride", "updatedAt",      `"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);

console.log("\nCreating PackingProfile…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "PackingProfile" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "signature"   TEXT NOT NULL,
    "description" TEXT,
    "boxSize"     TEXT NOT NULL,
    "weight"      REAL NOT NULL,
    "weightFedex" REAL,
    "itemCount"   INTEGER NOT NULL DEFAULT 1,
    "totalQty"    INTEGER NOT NULL DEFAULT 1,
    "usedCount"   INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt"  DATETIME,
    "productEmbedding" TEXT,
    "source"      TEXT NOT NULL DEFAULT 'manual',
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(
  `CREATE UNIQUE INDEX IF NOT EXISTS "PackingProfile_signature_key" ON "PackingProfile"("signature")`
);
await client.execute(
  `CREATE INDEX IF NOT EXISTS "PackingProfile_signature_idx" ON "PackingProfile"("signature")`
);

console.log("\n✓ Migration complete.");
