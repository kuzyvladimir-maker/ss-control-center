import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const cols = await db.execute(`PRAGMA table_info(WalmartOrder)`);
  console.log("WalmartOrder cols:", (cols.rows as any[]).map(r=>r.name).join(", "));
  const sample = await db.execute(`SELECT * FROM WalmartOrder ORDER BY rowid DESC LIMIT 1`);
  const r = sample.rows[0] as any;
  if(r){ for(const k of Object.keys(r)){ const v=String(r[k]??''); if(v.length<60) console.log(`  ${k}: ${v}`); } }
}
main();
