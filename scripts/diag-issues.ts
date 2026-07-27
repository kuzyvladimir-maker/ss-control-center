import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const r = await db.execute(`SELECT sku, topFixComponent, issuesSummary FROM WalmartListingQualityItem WHERE sku='FaisalX-2272'`);
  const x = r.rows[0] as any;
  console.log("topFixComponent:", x.topFixComponent);
  console.log("issuesSummary raw:", String(x.issuesSummary).slice(0,600));
}
main();
