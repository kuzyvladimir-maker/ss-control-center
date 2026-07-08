// Recompute _newwork.json against the CURRENT EnrichedReadySku (COGS grew it 517→1773).
// Work = single-component, clean/estimate, image-ready SKUs that are NOT yet applied
// (no ok=1 WalmartListingRemediation). The generator skips already-GEN_OK via its state
// file, so re-scoping just widens coverage. Multi-component bundles are deferred.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const rows = (await db.execute(`
    SELECT e.sku, e.qty, e.costStatus, e.donorTitle
    FROM EnrichedReadySku e
    WHERE e.sku IN (SELECT sku FROM EnrichedReadySku GROUP BY sku HAVING COUNT(*)=1)
      AND e.costStatus IN ('clean','estimate')
      AND e.sku NOT IN (SELECT DISTINCT sku FROM WalmartListingRemediation WHERE ok=1)`)).rows;
  const work = rows.map((r: any) => ({ sku: String(r.sku), qty: Number(r.qty), cs: r.costStatus, title: r.donorTitle }));
  writeFileSync("_newwork.json", JSON.stringify(work, null, 1));
  const byQty: Record<string, number> = {}; for (const w of work) byQty[w.qty] = (byQty[w.qty] || 0) + 1;
  console.log(`_newwork.json = ${work.length} single-component ready-not-applied SKUs`);
  console.log(`qty dist: ${JSON.stringify(byQty)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
