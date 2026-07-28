import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const r = await db.execute(`SELECT sku, units30, sales30, orders30, returns30, units180, sales180 FROM WalmartSkuPerf ORDER BY sales180 DESC LIMIT 8`);
  for(const x of r.rows as any[]) console.log(` ${x.sku}: 30d $${x.sales30}/${x.units30}u/${x.returns30}ret · 180d $${x.sales180}/${x.units180}u`);
  const agg = await db.execute(`SELECT COUNT(*) c, SUM(sales180) s, SUM(units180) u, SUM(returns180) r FROM WalmartSkuPerf`);
  const a = agg.rows[0] as any; console.log(`\nSKUs with sales: ${a.c} · 180d total $${a.s} / ${a.u} units / ${a.r} returns`);
}
main();
