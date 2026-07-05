// Enumerate EVERYTHING we've already touched (WalmartListingRemediation) — the set
// Vladimir wants finalized to 100% before any new batch.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const tot = (await db.execute(`SELECT COUNT(DISTINCT sku) n FROM WalmartListingRemediation`)).rows[0] as any;
  console.log(`distinct SKUs ever touched: ${tot.n}`);
  const byStamp = (await db.execute(`SELECT CASE
      WHEN mainImageUrl LIKE '%f50%' THEN 'fresh-50'
      WHEN mainImageUrl LIKE '%trial100%' THEN 'trial-100'
      WHEN mainImageUrl LIKE '%qual50%' THEN 'qual50'
      WHEN mainImageUrl IS NULL OR mainImageUrl='' THEN '(no main)'
      ELSE 'other' END AS batch,
      COUNT(DISTINCT sku) n
    FROM WalmartListingRemediation GROUP BY batch ORDER BY n DESC`)).rows as any[];
  console.log("by batch (distinct SKUs):");
  for (const r of byStamp) console.log(`  ${r.batch}: ${r.n}`);
  const feed = (await db.execute(`SELECT feedStatus, COUNT(DISTINCT sku) n FROM WalmartListingRemediation GROUP BY feedStatus`)).rows as any[];
  console.log("by feedStatus:");
  for (const r of feed) console.log(`  ${r.feedStatus}: ${r.n}`);
  // latest per sku: how many have a main image at all
  const latestMain = (await db.execute(`SELECT COUNT(*) n FROM (SELECT sku, MAX(runAt) ra FROM WalmartListingRemediation GROUP BY sku) x
    JOIN WalmartListingRemediation r ON r.sku=x.sku AND r.runAt=x.ra WHERE r.mainImageUrl IS NOT NULL AND r.mainImageUrl!=''`)).rows[0] as any;
  console.log(`latest-per-sku WITH a built main: ${latestMain.n}`);
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
