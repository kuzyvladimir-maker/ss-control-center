// One-off Turso migration: Personal Finance (Phase 1). Idempotent.
//   node --env-file=.env scripts/turso-migrate-personal-finance.mjs
//
// Adds `scope` (business|personal) to the shared finance tables so the same
// engine serves a separate personal pool, adds personal bill/loan fields
// (owner/dueDay/apr/termMonths/kind), and creates the CreditCard + CardEntry tables.
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

// 1. scope on every shared finance table (default 'business' → existing rows unchanged).
for (const t of ["Payout", "Fund", "RecurringExpense", "Receipt", "Debt", "FinancePlanRun"]) {
  await addCol(t, "scope", `"scope" TEXT NOT NULL DEFAULT 'business'`);
}

// 2. Personal bill fields on RecurringExpense.
await addCol("RecurringExpense", "owner", `"owner" TEXT`);
await addCol("RecurringExpense", "dueDay", `"dueDay" INTEGER`);

// 3. Personal loan fields on Debt.
await addCol("Debt", "owner", `"owner" TEXT`);
await addCol("Debt", "dueDay", `"dueDay" INTEGER`);
await addCol("Debt", "apr", `"apr" REAL`);
await addCol("Debt", "termMonths", `"termMonths" INTEGER`);
await addCol("Debt", "kind", `"kind" TEXT`);

// 4. CreditCard — revolving credit line (centerpiece of Personal Finance).
await client.execute(`
  CREATE TABLE IF NOT EXISTS "CreditCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "owner" TEXT,
    "issuer" TEXT NOT NULL,
    "name" TEXT,
    "last4" TEXT,
    "creditLimit" REAL NOT NULL DEFAULT 0,
    "currentBalance" REAL NOT NULL DEFAULT 0,
    "statementBalance" REAL NOT NULL DEFAULT 0,
    "apr" REAL,
    "minPaymentFixed" REAL NOT NULL DEFAULT 0,
    "minPaymentPct" REAL NOT NULL DEFAULT 0,
    "statementDay" INTEGER,
    "dueDay" INTEGER,
    "autopay" TEXT NOT NULL DEFAULT 'none',
    "autopayAmount" REAL,
    "fundId" TEXT,
    "active" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log("  + CreditCard");

// 5. CardEntry — per-card ledger (charges / payments / interest / fees).
await client.execute(`
  CREATE TABLE IF NOT EXISTS "CardEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cardId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "description" TEXT,
    "fundId" TEXT,
    "fundEntryId" TEXT,
    "date" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log("  + CardEntry");

// 6. Indexes.
await idx("scope indexes", `CREATE INDEX IF NOT EXISTS "Payout_scope_idx" ON "Payout"("scope")`);
await idx("Fund_scope_idx", `CREATE INDEX IF NOT EXISTS "Fund_scope_idx" ON "Fund"("scope")`);
await idx("RecurringExpense_scope_idx", `CREATE INDEX IF NOT EXISTS "RecurringExpense_scope_idx" ON "RecurringExpense"("scope")`);
await idx("Debt_scope_idx", `CREATE INDEX IF NOT EXISTS "Debt_scope_idx" ON "Debt"("scope")`);
await idx("FinancePlanRun_scope_idx", `CREATE INDEX IF NOT EXISTS "FinancePlanRun_scope_idx" ON "FinancePlanRun"("scope")`);
await idx("CreditCard_scope_idx", `CREATE INDEX IF NOT EXISTS "CreditCard_scope_idx" ON "CreditCard"("scope")`);
await idx("CreditCard_owner_idx", `CREATE INDEX IF NOT EXISTS "CreditCard_owner_idx" ON "CreditCard"("owner")`);
await idx("CreditCard_active_idx", `CREATE INDEX IF NOT EXISTS "CreditCard_active_idx" ON "CreditCard"("active")`);
await idx("CardEntry_cardId_idx", `CREATE INDEX IF NOT EXISTS "CardEntry_cardId_idx" ON "CardEntry"("cardId")`);

console.log("✓ Personal Finance schema ready");
client.close();
