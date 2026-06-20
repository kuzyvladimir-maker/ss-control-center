// One-off Turso migration for Finance Core — Phase 1 (Funds).
//
// Mirrors prisma/migrations/20260620170000_finance_funds/migration.sql
// idempotently (CREATE TABLE IF NOT EXISTS) — safe to re-run. Also seeds the two
// system funds (Restock reserve @ priority 0, Free @ priority 9999).
//
// NOT run automatically. Run manually after merge:
//   node scripts/turso-migrate-finance-funds.mjs
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.

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

await client.execute(`
  CREATE TABLE IF NOT EXISTS "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplace" TEXT NOT NULL,
    "storeIndex" INTEGER,
    "entity" TEXT,
    "externalId" TEXT NOT NULL,
    "periodStart" TEXT,
    "periodEnd" TEXT,
    "depositDate" TEXT,
    "grossSales" REAL,
    "feesTotal" REAL,
    "netAmount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "distributed" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'settlement',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "Payout_marketplace_externalId_key" ON "Payout"("marketplace", "externalId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Payout_depositDate_idx" ON "Payout"("depositDate")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Payout_distributed_idx" ON "Payout"("distributed")`);
console.log("  + Payout ready");

await client.execute(`
  CREATE TABLE IF NOT EXISTS "Fund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "allocationType" TEXT NOT NULL DEFAULT 'percent',
    "value" REAL NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "cap" REAL,
    "balance" REAL NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Fund_group_idx" ON "Fund"("group")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Fund_active_idx" ON "Fund"("active")`);
console.log("  + Fund ready");

await client.execute(`
  CREATE TABLE IF NOT EXISTS "FundAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fundId" TEXT NOT NULL,
    "runId" TEXT,
    "payoutId" TEXT,
    "amount" REAL NOT NULL,
    "date" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "FundAllocation_fundId_idx" ON "FundAllocation"("fundId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "FundAllocation_runId_idx" ON "FundAllocation"("runId")`);
console.log("  + FundAllocation ready");

await client.execute(`
  CREATE TABLE IF NOT EXISTS "FinancePlanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runDate" TEXT NOT NULL,
    "periodStart" TEXT,
    "periodEnd" TEXT,
    "totalIn" REAL NOT NULL DEFAULT 0,
    "totalReserved" REAL NOT NULL DEFAULT 0,
    "totalDistributed" REAL NOT NULL DEFAULT 0,
    "reserveRateUsed" REAL NOT NULL DEFAULT 0,
    "payoutCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "FinancePlanRun_runDate_idx" ON "FinancePlanRun"("runDate")`);
console.log("  + FinancePlanRun ready");

// Seed system funds (idempotent: only if absent).
async function seedFund(id, name, group, priority) {
  const existing = await client.execute({
    sql: `SELECT id FROM "Fund" WHERE "isSystem" = true AND "group" = ? LIMIT 1`,
    args: [group],
  });
  if (existing.rows.length) {
    console.log(`  = ${group} system fund already present`);
    return;
  }
  await client.execute({
    sql: `INSERT INTO "Fund" ("id","name","group","allocationType","value","priority","balance","active","isSystem","updatedAt")
          VALUES (?, ?, ?, 'percent', 0, ?, 0, true, true, CURRENT_TIMESTAMP)`,
    args: [id, name, group, priority],
  });
  console.log(`  + seeded ${group} system fund "${name}"`);
}
await seedFund("fund_reserve", "Restock reserve", "RESERVE", 0);
await seedFund("fund_free", "Free / unallocated", "FREE", 9999);

console.log("\n✓ Finance Funds migration applied.");
client.close();
