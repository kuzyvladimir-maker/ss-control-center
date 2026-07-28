// One-off Turso migration: TimeLog (timesheet). Idempotent.
//   node --env-file=.env scripts/turso-migrate-timelog.mjs
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS "TimeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expenseId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "TimeLog_expenseId_date_key" ON "TimeLog"("expenseId", "date")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "TimeLog_expenseId_idx" ON "TimeLog"("expenseId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "TimeLog_date_idx" ON "TimeLog"("date")`);
console.log("✓ TimeLog ready");
client.close();
