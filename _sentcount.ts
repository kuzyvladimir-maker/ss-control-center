import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]){let t="";try{t=readFileSync(f,"utf8");}catch{continue;}for(const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(m)process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");}}
async function main(){
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const q = async (s:string)=> (await db.execute(s)).rows[0] as any;
  console.log("distinct SKUs touched (any row):", (await q(`SELECT COUNT(DISTINCT sku) n FROM WalmartListingRemediation`)).n);
  console.log("distinct SKUs with a feed SENT (feedId not null):", (await q(`SELECT COUNT(DISTINCT sku) n FROM WalmartListingRemediation WHERE feedId IS NOT NULL AND feedId!=''`)).n);
  console.log("distinct SKUs ok=1 (submitted successfully):", (await q(`SELECT COUNT(DISTINCT sku) n FROM WalmartListingRemediation WHERE ok=1`)).n);
  console.log("\nby feedStatus (distinct SKUs):");
  for (const r of (await db.execute(`SELECT feedStatus, COUNT(DISTINCT sku) n FROM WalmartListingRemediation WHERE feedId IS NOT NULL GROUP BY feedStatus ORDER BY n DESC`)).rows as any[]) console.log(`  ${r.feedStatus}: ${r.n}`);
  console.log("\nby month sent (runAt):");
  for (const r of (await db.execute(`SELECT substr(runAt,1,7) mo, COUNT(DISTINCT sku) n FROM WalmartListingRemediation WHERE feedId IS NOT NULL GROUP BY mo ORDER BY mo`)).rows as any[]) console.log(`  ${r.mo}: ${r.n}`);
  db.close();
}
main().catch(e=>{console.error(e.message);process.exit(1)});
