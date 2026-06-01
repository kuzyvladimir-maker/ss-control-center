// Turso migration: BoxSizePreset table + seed default sizes.

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
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='BoxSizePreset'`,
});

if (probe.rows.length === 0) {
  await client.batch(
    [
      `CREATE TABLE "BoxSizePreset" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "label" TEXT NOT NULL,
         "length" REAL NOT NULL,
         "width" REAL NOT NULL,
         "height" REAL NOT NULL,
         "builtin" BOOLEAN NOT NULL DEFAULT false,
         "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      `CREATE UNIQUE INDEX "BoxSizePreset_label_key" ON "BoxSizePreset"("label")`,
    ],
    "write",
  );
  console.log("· table created");
} else {
  console.log("· table already exists");
}

// Seed builtins (idempotent — INSERT OR IGNORE on the unique label).
const seeds = [
  ["XS", 11, 6, 8],
  ["S", 12, 12, 10],
  ["M", 13, 13, 15],
  ["L", 18, 13, 14],
  ["XL", 24, 13, 16],
  ["5x5x5", 5, 5, 5],
  ["6x6x6", 6, 6, 6],
  ["7x7x6", 7, 7, 6],
  ["10x8x6", 10, 8, 6],
  ["12x12x6", 12, 12, 6],
  ["12x12x8", 12, 12, 8],
];

let seeded = 0;
for (const [label, l, w, h] of seeds) {
  const res = await client.execute({
    sql: `INSERT OR IGNORE INTO "BoxSizePreset" ("id", "label", "length", "width", "height", "builtin")
          VALUES (?, ?, ?, ?, ?, 1)`,
    args: [crypto.randomUUID(), label, l, w, h],
  });
  if (res.rowsAffected > 0) seeded++;
}
console.log(`· seeded ${seeded} builtin preset(s)`);

const MIGRATION_NAME = "20260601000000_box_size_presets";
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

console.log("✓ BoxSizePreset migration done.");
client.close();
