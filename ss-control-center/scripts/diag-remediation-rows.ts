import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const r = await db.execute(`SELECT sku, ok, feedStatus, bulletsCount, imagesCount, descriptionLength, usedAiPolish, beforeLqScore, beforeContentScore, beforePageViews30d, beforeIssueCount, notes FROM WalmartListingRemediation ORDER BY runAt DESC LIMIT 8`);
  console.log("rows:", r.rows.length);
  for(const x of r.rows as any[]) console.log(` ${x.sku}: ok=${x.ok} ${x.feedStatus} | imgs=${x.imagesCount} bullets=${x.bulletsCount} desc=${x.descriptionLength} ai=${x.usedAiPolish} | beforeLQ=${x.beforeLqScore} content=${x.beforeContentScore} views=${x.beforePageViews30d} issues=${x.beforeIssueCount}`);
}
main();
