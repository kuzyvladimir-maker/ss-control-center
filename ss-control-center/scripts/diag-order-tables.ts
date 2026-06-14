import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const t = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND (LOWER(name) LIKE '%order%' OR LOWER(name) LIKE '%return%' OR LOWER(name) LIKE '%sale%' OR LOWER(name) LIKE '%shipment%')`);
  console.log("order/return/sale tables:", (t.rows as any[]).map(r=>r.name).join(", ") || "(none)");
  // row counts for any walmart-ish order table
  for(const r of t.rows as any[]){
    try { const c = await db.execute(`SELECT COUNT(*) c FROM "${r.name}"`); console.log(`  ${r.name}: ${(c.rows[0] as any).c} rows`); } catch {}
  }
}
main();
