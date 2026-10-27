// One-off Turso migration: Personal Finance Phase 2 — obligations registry. Idempotent.
//   node --env-file=.env scripts/turso-migrate-personal-registry.mjs
//
// Additive only (deployed code keeps working): every Debt / CreditCard row gains its
// balance date + source + status badge + exact next due date; new tables
// ObligationEvent (court installments, hearings, tax windows, one-off payments) and
// PersonalAsset (the asset side of net worth). See docs/wiki/personal-finance.md.
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);

async function addCol(table, col, ddl) {
  try { await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`); console.log(`  + ${table}.${col}`); }
  catch (e) { if (String(e).includes("duplicate column")) console.log(`  = ${table}.${col} exists`); else throw e; }
}
async function idx(name, sql) { await client.execute(sql); console.log(`  ~ ${name}`); }

// 1. Registry fields on Debt.
for (const c of ["creditor", "entity", "accountRef", "balanceAsOf", "balanceSource", "balanceNote", "standing",
  "standingSince", "standingNote", "alert", "nextDueDate", "maturityDate", "registryKey"]) {
  await addCol("Debt", c, `"${c}" TEXT`);
}
await addCol("Debt", "amountKnown", `"amountKnown" INTEGER NOT NULL DEFAULT 1`);

// 2. Registry fields on CreditCard.
await addCol("CreditCard", "minPaymentDue", `"minPaymentDue" REAL`);
for (const c of ["balanceAsOf", "balanceSource", "balanceNote", "standing", "standingSince", "standingNote",
  "alert", "nextDueDate", "registryKey"]) {
  await addCol("CreditCard", c, `"${c}" TEXT`);
}
await addCol("CreditCard", "closed", `"closed" INTEGER NOT NULL DEFAULT 0`);

// 3. ObligationEvent — dated calendar points a day-of-month rule can't express.
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ObligationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "debtId" TEXT,
    "cardId" TEXT,
    "date" TEXT NOT NULL,
    "endDate" TEXT,
    "time" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" REAL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "source" TEXT,
    "note" TEXT,
    "registryKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log("  + ObligationEvent");

// 4. PersonalAsset — bank accounts, vehicles, … with value date + source.
await client.execute(`
  CREATE TABLE IF NOT EXISTS "PersonalAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "owner" TEXT,
    "entity" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'cash',
    "institution" TEXT,
    "last4" TEXT,
    "value" REAL NOT NULL,
    "valueAsOf" TEXT,
    "valueSource" TEXT,
    "alert" TEXT,
    "active" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "registryKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log("  + PersonalAsset");

// 5. Indexes.
await idx("Debt_registryKey_idx", `CREATE INDEX IF NOT EXISTS "Debt_registryKey_idx" ON "Debt"("registryKey")`);
await idx("CreditCard_registryKey_idx", `CREATE INDEX IF NOT EXISTS "CreditCard_registryKey_idx" ON "CreditCard"("registryKey")`);
await idx("ObligationEvent_scope_idx", `CREATE INDEX IF NOT EXISTS "ObligationEvent_scope_idx" ON "ObligationEvent"("scope")`);
await idx("ObligationEvent_date_idx", `CREATE INDEX IF NOT EXISTS "ObligationEvent_date_idx" ON "ObligationEvent"("date")`);
await idx("ObligationEvent_debtId_idx", `CREATE INDEX IF NOT EXISTS "ObligationEvent_debtId_idx" ON "ObligationEvent"("debtId")`);
await idx("ObligationEvent_cardId_idx", `CREATE INDEX IF NOT EXISTS "ObligationEvent_cardId_idx" ON "ObligationEvent"("cardId")`);
await idx("ObligationEvent_registryKey_idx", `CREATE INDEX IF NOT EXISTS "ObligationEvent_registryKey_idx" ON "ObligationEvent"("registryKey")`);
await idx("PersonalAsset_scope_idx", `CREATE INDEX IF NOT EXISTS "PersonalAsset_scope_idx" ON "PersonalAsset"("scope")`);
await idx("PersonalAsset_registryKey_idx", `CREATE INDEX IF NOT EXISTS "PersonalAsset_registryKey_idx" ON "PersonalAsset"("registryKey")`);

console.log("✓ Personal registry schema ready");
client.close();
