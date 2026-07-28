import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const r = await db.execute(`SELECT rawData FROM WalmartOrder WHERE rawData IS NOT NULL AND rawData!='' ORDER BY rowid DESC LIMIT 1`);
  const raw = (r.rows[0] as any)?.rawData;
  try {
    const j = JSON.parse(raw);
    // find line items
    const lines = j?.orderLines?.orderLine || j?.orderLines || j?.lineItems || [];
    console.log("orderLine count:", Array.isArray(lines)?lines.length:"?");
    const l0 = Array.isArray(lines)?lines[0]:null;
    if(l0){ console.log("line keys:", Object.keys(l0).join(", ")); console.log("sku:", l0?.item?.sku || l0?.sku); console.log("qty:", JSON.stringify(l0?.orderLineQuantity)); console.log("charges sample:", JSON.stringify(l0?.charges).slice(0,200)); }
  } catch(e){ console.log("parse err", (e as Error).message); console.log(String(raw).slice(0,200)); }
}
main();
