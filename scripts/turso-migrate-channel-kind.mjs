// One-off Turso migration: add the channelKind column to
// ShippingPlanItem so the Drive folder structure can bucket by
// marketplace (Amazon / Walmart / eBay / …) rather than per
// store-account.
//
// Backfill rule: rows are left with NULL. The reader falls back to
// the legacy `channel` (store name) for those, which preserves the
// existing Drive folder layout for already-bought labels.
//
// Idempotent — safe to re-run.

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

async function addColumnIfMissing(table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info("${table}")`);
  if (info.rows.some((r) => r.name === column)) {
    console.log(`  · ${table}.${column} already exists`);
    return;
  }
  await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`  + added ${table}.${column}`);
}

console.log("Adding channelKind column to ShippingPlanItem…");
await addColumnIfMissing(
  "ShippingPlanItem",
  "channelKind",
  `"channelKind" TEXT`,
);

console.log("Done.");
