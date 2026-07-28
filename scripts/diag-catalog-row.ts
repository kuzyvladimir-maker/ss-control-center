import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main() {
  const sku = process.argv[2] || "FaisalX-2272";
  // list columns
  const cols = await db.execute(`PRAGMA table_info(WalmartCatalogItem)`);
  console.log("WalmartCatalogItem columns:", (cols.rows as any[]).map(r => r.name).join(", "));
  const row = await db.execute({ sql: `SELECT * FROM WalmartCatalogItem WHERE sku=? LIMIT 1`, args: [sku] });
  const r = row.rows[0] as any;
  if (!r) { console.log("no row"); return; }
  for (const k of Object.keys(r)) {
    const v = r[k];
    const s = v == null ? "null" : String(v);
    console.log(`  ${k}: ${s.length > 120 ? s.slice(0,120)+"…("+s.length+")" : s}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
