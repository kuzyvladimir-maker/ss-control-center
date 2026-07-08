// Orientation over the new EnrichedReadySku view + how it intersects the Walmart
// multipack work (what I've published vs what is newly image-ready).
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

async function main() {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const q = async (sql: string) => (await db.execute(sql)).rows;

  const total = (await q(`SELECT COUNT(DISTINCT sku) n FROM EnrichedReadySku`))[0].n;
  console.log(`EnrichedReadySku: ${total} distinct image-ready SKUs\n`);

  console.log("costStatus (distinct SKU):");
  for (const r of await q(`SELECT costStatus, COUNT(DISTINCT sku) n FROM EnrichedReadySku GROUP BY costStatus ORDER BY n DESC`)) console.log(`  ${r.costStatus}: ${r.n}`);

  console.log("\nhasIdentity (distinct SKU):");
  for (const r of await q(`SELECT hasIdentity, COUNT(DISTINCT sku) n FROM EnrichedReadySku GROUP BY hasIdentity`)) console.log(`  ${r.hasIdentity ? "yes" : "no"}: ${r.n}`);

  console.log("\ncomponents per SKU (single-donor multipack vs multi-donor bundle):");
  for (const r of await q(`SELECT ncomp, COUNT(*) skus FROM (SELECT sku, COUNT(*) ncomp FROM EnrichedReadySku GROUP BY sku) GROUP BY ncomp ORDER BY ncomp`)) console.log(`  ${r.ncomp} component(s): ${r.skus} SKUs`);

  // channel / store: is there a ChannelListing / store hint per sku?
  console.log("\nsample rows:");
  for (const r of await q(`SELECT sku, componentIdx, qty, costStatus, hasIdentity, substr(donorTitle,1,55) t, substr(donorImageUrls,1,40) imgs FROM EnrichedReadySku ORDER BY sku LIMIT 12`))
    console.log(`  ${r.sku} [c${r.componentIdx} q${r.qty}] ${r.costStatus} id=${r.hasIdentity} :: ${r.t}`);

  // how many ready SKUs already have a WalmartListingRemediation (published/attempted by me)?
  const pubbed = await q(`SELECT COUNT(DISTINCT e.sku) n FROM EnrichedReadySku e JOIN WalmartListingRemediation w ON w.sku=e.sku`);
  console.log(`\nready SKUs that already have a WalmartListingRemediation row: ${pubbed[0].n}`);
  const appliedRows = await q(`SELECT COUNT(DISTINCT e.sku) n FROM EnrichedReadySku e JOIN WalmartListingRemediation w ON w.sku=e.sku WHERE w.ok=1`);
  console.log(`ready SKUs with an OK (applied) remediation: ${appliedRows[0].n}`);

  // ready SKUs with NO remediation yet = candidate new work (still need a corrected main)
  const fresh = await q(`SELECT COUNT(DISTINCT sku) n FROM EnrichedReadySku WHERE sku NOT IN (SELECT DISTINCT sku FROM WalmartListingRemediation)`);
  console.log(`ready SKUs with NO remediation row yet (candidate NEW work): ${fresh[0].n}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
