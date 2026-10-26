// One-off Turso migration: ShippingRateSnapshot (rates read from a
// marketplace admin UI, e.g. NAN Health / Shopify). Additive + idempotent.
//   node --env-file=.env scripts/turso-migrate-shipping-rate-snapshot.mjs
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

await client.execute(`CREATE TABLE IF NOT EXISTS "ShippingRateSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderNumber" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'NAN health',
  "source" TEXT,
  "capturedAt" TEXT NOT NULL,
  "dest" TEXT,
  "pkg" TEXT,
  "ratesJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
await client.execute(
  `CREATE INDEX IF NOT EXISTS "ShippingRateSnapshot_orderNumber_idx" ON "ShippingRateSnapshot"("orderNumber")`,
);
console.log("✓ ShippingRateSnapshot ready");
client.close();
