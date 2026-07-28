// One-off Turso migration: Debt (company debts in the Debt fund). Idempotent.
//   node --env-file=.env scripts/turso-migrate-debt.mjs
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS "Debt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fundId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "paid" REAL NOT NULL DEFAULT 0,
    "description" TEXT,
    "dateIncurred" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Debt_fundId_idx" ON "Debt"("fundId")`);
console.log("✓ Debt ready");
client.close();
