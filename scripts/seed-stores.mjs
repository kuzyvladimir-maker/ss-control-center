// Idempotent migration + seed for the Store directory.
//
// Adds the storeIndex / sellerId bridge columns (no-op if they already exist)
// and ensures all 6 SS Control Center stores exist:
//   5 Amazon  (storeIndex 1..5)
//   1 Walmart (sellerId  10001624309)
//
// Targets Turso when TURSO_DATABASE_URL is set, otherwise the local
// SQLite dev.db so the script works in both environments.

import { createClient } from "@libsql/client";
import { resolve } from "path";

function cleanEnv(value) {
  if (!value) return value;
  return value.trim().replace(/^['"]|['"]$/g, "");
}

const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
const databaseUrl = cleanEnv(process.env.DATABASE_URL);

let client;
let target;
if (tursoUrl && tursoToken) {
  client = createClient({ url: tursoUrl, authToken: tursoToken });
  target = `Turso (${tursoUrl.split("@")[1] || tursoUrl})`;
} else if (databaseUrl) {
  client = createClient({ url: databaseUrl });
  target = `libsql (${databaseUrl})`;
} else {
  const dbPath = resolve(process.cwd(), "dev.db");
  client = createClient({ url: `file:${dbPath}` });
  target = `local SQLite (${dbPath})`;
}

console.log(`→ Target: ${target}`);

// SQLite doesn't support ADD COLUMN IF NOT EXISTS, so probe first.
async function addColumnIfMissing(table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info("${table}")`);
  const exists = info.rows.some((r) => r.name === column);
  if (exists) {
    console.log(`  · ${table}.${column} already exists`);
    return;
  }
  await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`  + added ${table}.${column}`);
}

console.log("Migrating columns…");
await addColumnIfMissing("Store", "storeIndex", `"storeIndex" INTEGER`);
await addColumnIfMissing("Store", "sellerId", `"sellerId" TEXT`);

// Seeds. Names mirror CLAUDE.md AMAZON ACCOUNTS table + the existing
// Walmart record (Seller ID 10001624309).
const STORES = [
  { name: "Salutem Solutions",                 channel: "Amazon",  storeIndex: 1, sellerId: null },
  { name: "Vladimir Personal",                 channel: "Amazon",  storeIndex: 2, sellerId: null },
  { name: "AMZ Commerce",                      channel: "Amazon",  storeIndex: 3, sellerId: null },
  { name: "Sirius International",              channel: "Amazon",  storeIndex: 4, sellerId: null },
  { name: "Retailer Distributor",              channel: "Amazon",  storeIndex: 5, sellerId: null },
  { name: "SIRIUS TRADING INTERNATIONAL LLC",  channel: "Walmart", storeIndex: null, sellerId: "10001624309" },
];

function cuid() {
  // Light-weight, collision-resistant id for seeds (Prisma's @default(cuid)
  // doesn't apply when we write via raw SQL).
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

console.log("Seeding stores…");
for (const s of STORES) {
  // Look up by channel + storeIndex (Amazon) or sellerId (Walmart) so the
  // script stays idempotent across re-runs.
  let existing;
  if (s.channel === "Amazon") {
    existing = await client.execute({
      sql: `SELECT id FROM "Store" WHERE channel = ? AND storeIndex = ?`,
      args: [s.channel, s.storeIndex],
    });
  } else {
    existing = await client.execute({
      sql: `SELECT id FROM "Store" WHERE channel = ? AND sellerId = ?`,
      args: [s.channel, s.sellerId],
    });
  }

  if (existing.rows.length > 0) {
    // Update name/active so re-runs heal any drift.
    await client.execute({
      sql: `UPDATE "Store" SET name = ?, active = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [s.name, existing.rows[0].id],
    });
    console.log(`  · ${s.channel} / ${s.name} — already exists, updated name`);
    continue;
  }

  const id = cuid();
  await client.execute({
    sql: `INSERT INTO "Store" (id, name, channel, signature, active, storeIndex, sellerId, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [id, s.name, s.channel, s.name, s.storeIndex, s.sellerId],
  });
  console.log(`  + inserted ${s.channel} / ${s.name} (${id})`);
}

const final = await client.execute(`SELECT id, name, channel, storeIndex, sellerId FROM "Store" ORDER BY channel, storeIndex`);
console.log("\nFinal Store table:");
for (const row of final.rows) {
  console.log(`  ${row.channel.padEnd(8)} ${String(row.storeIndex ?? "-").padEnd(3)} ${row.sellerId ?? "".padEnd(12)}  ${row.name}`);
}

console.log(`\n✅ Done. ${final.rows.length} stores total.`);
