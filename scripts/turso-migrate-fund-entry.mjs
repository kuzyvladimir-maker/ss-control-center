// One-off Turso migration: FundEntry (fund ledger). Idempotent.
//   node --env-file=.env scripts/turso-migrate-fund-entry.mjs
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS "FundEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fundId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "dueDate" TEXT,
    "runId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "FundEntry_fundId_idx" ON "FundEntry"("fundId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "FundEntry_status_idx" ON "FundEntry"("status")`);
console.log("✓ FundEntry ready");
client.close();
