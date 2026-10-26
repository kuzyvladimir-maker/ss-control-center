// One-off Turso migration: NanRateSnapshot (latest NAN Health / Shopify rates
// per order + refresh queue). Additive + idempotent.
//   node --env-file=.env scripts/turso-migrate-nan-rate-snapshot.mjs
import { createClient } from "@libsql/client";

const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);

await client.execute(`CREATE TABLE IF NOT EXISTS "NanRateSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderNumber" TEXT NOT NULL,
  "shopifyOrderId" TEXT,
  "capturedAt" DATETIME,
  "destJson" TEXT,
  "packageJson" TEXT,
  "ratesJson" TEXT NOT NULL DEFAULT '[]',
  "refreshRequestedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
await client.execute(
  `CREATE UNIQUE INDEX IF NOT EXISTS "NanRateSnapshot_orderNumber_key" ON "NanRateSnapshot"("orderNumber")`,
);
console.log("✓ NanRateSnapshot ready");
client.close();
// 2026-10-26: package override from the card's Package tile.
{
  const cols = await createClient({ url, authToken }).execute(`PRAGMA table_info("NanRateSnapshot")`);
  if (!cols.rows.some((r) => r.name === "packageOverrideJson")) {
    const c2 = createClient({ url, authToken });
    await c2.execute(`ALTER TABLE "NanRateSnapshot" ADD COLUMN "packageOverrideJson" TEXT`);
    console.log("+ packageOverrideJson");
    c2.close();
  }
}
