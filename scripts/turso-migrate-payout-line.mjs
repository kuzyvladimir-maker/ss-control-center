// One-off Turso migration: PayoutLine (bucketed payout breakdown). Idempotent.
//   node --env-file=.env scripts/turso-migrate-payout-line.mjs
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS "PayoutLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payoutId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PayoutLine_payoutId_idx" ON "PayoutLine"("payoutId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PayoutLine_bucket_idx" ON "PayoutLine"("bucket")`);
console.log("✓ PayoutLine ready");
client.close();
