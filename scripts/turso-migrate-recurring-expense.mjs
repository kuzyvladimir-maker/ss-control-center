// One-off Turso migration: RecurringExpense (OpEx master list). Idempotent.
//   node --env-file=.env scripts/turso-migrate-recurring-expense.mjs
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS "RecurringExpense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "marketplace" TEXT,
    "product" TEXT,
    "isAdSpend" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'sellerboard',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "RecurringExpense_category_idx" ON "RecurringExpense"("category")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "RecurringExpense_active_idx" ON "RecurringExpense"("active")`);
console.log("✓ RecurringExpense ready");
client.close();
