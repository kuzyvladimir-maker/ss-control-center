// One-off Turso migration: Receipt (photographed receipts). Idempotent.
//   node --env-file=.env scripts/turso-migrate-receipt.mjs
import { createClient } from "@libsql/client";
const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);
await client.execute(`
  CREATE TABLE IF NOT EXISTS "Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageUrl" TEXT NOT NULL,
    "merchant" TEXT,
    "total" REAL,
    "tax" REAL,
    "date" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'parsed',
    "fundId" TEXT,
    "fundEntryId" TEXT,
    "notes" TEXT,
    "rawText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Receipt_fundId_idx" ON "Receipt"("fundId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "Receipt_status_idx" ON "Receipt"("status")`);
console.log("✓ Receipt ready");
client.close();
