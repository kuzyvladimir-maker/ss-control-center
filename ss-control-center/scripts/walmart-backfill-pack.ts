// Backfill a pack count parsed from the listing TITLE onto WalmartListingQualityItem.
// Our SkuShippingData/SkuCost tables only carry pack counts for ~30 SKUs, but
// ~3,300 listings are multipacks whose title states the count ("Pack of 8",
// "6-Count", "12 ct"). The Optimizer filter needs this to see the real catalog.
//
// Adds column titlePackCount (idempotent) and populates it. Re-run after sweeps.
//   npx tsx scripts/walmart-backfill-pack.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";

const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

/** Parse a pack/unit count from a product title. Returns null if not a multipack. */
export function packFromTitle(title: string): number | null {
  if (!title) return null;
  const t = title.toLowerCase();
  const pats = [
    /\bpack of\s*(\d{1,3})\b/,
    /\b(\d{1,3})\s*[-\s]?pack\b/,
    /\b(\d{1,3})\s*[-\s]?count\b/,
    /\b(\d{1,3})\s*[-\s]?ct\b/,
    /\(\s*(\d{1,3})\s*(?:pack|count|ct|pk)\s*\)/,
    /\bcase of\s*(\d{1,3})\b/,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m) { const n = parseInt(m[1], 10); if (n >= 2 && n <= 144) return n; }
  }
  return null;
}

async function backfill(table: string, titleCol: string) {
  try { await db.execute(`ALTER TABLE ${table} ADD COLUMN titlePackCount INTEGER`); console.log(`${table}: added column titlePackCount`); }
  catch { console.log(`${table}: column exists`); }
  const rows = await db.execute(`SELECT id, ${titleCol} AS title FROM ${table} WHERE storeIndex=1`);
  let multipacks = 0;
  for (const r of rows.rows as any[]) {
    const n = packFromTitle(r.title || "");
    if (n) multipacks++;
    await db.execute({ sql: `UPDATE ${table} SET titlePackCount=? WHERE id=?`, args: [n, r.id] });
  }
  console.log(`${table}: scanned ${rows.rows.length} · ${multipacks} multipacks`);
}

async function main() {
  await backfill("WalmartListingQualityItem", "productName");
  await backfill("WalmartCatalogItem", "title");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
