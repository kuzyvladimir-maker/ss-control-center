// One-off Turso migration: accrual meter columns on RecurringExpense. Idempotent.
//   node --env-file=.env scripts/turso-migrate-accrual.mjs
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
await addCol("RecurringExpense", "accrued", `"accrued" REAL NOT NULL DEFAULT 0`);
await addCol("RecurringExpense", "lastAccruedDate", `"lastAccruedDate" TEXT`);
console.log("✓ accrual columns ready");
client.close();
