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

async function main() {
  // Ensure column exists (SQLite ADD COLUMN is a no-op-safe via try/catch).
  try { await db.execute(`ALTER TABLE WalmartListingQualityItem ADD COLUMN titlePackCount INTEGER`); console.log("added column titlePackCount"); }
  catch { console.log("column titlePackCount already exists"); }

  const rows = await db.execute(`SELECT id, sku, productName FROM WalmartListingQualityItem WHERE storeIndex=1`);
  let set = 0, multipacks = 0;
  for (const r of rows.rows as any[]) {
    const n = packFromTitle(r.productName || "");
    if (n) multipacks++;
    await db.execute({ sql: `UPDATE WalmartListingQualityItem SET titlePackCount=? WHERE id=?`, args: [n, r.id] });
    set++;
  }
  console.log(`scanned ${set} items · ${multipacks} parsed as multipacks (titlePackCount set)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
