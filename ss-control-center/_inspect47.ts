// Inspect the fresh-50 remediation set: which stamps exist, how many rows, latest.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  // Any remediation row whose main image was a fresh-50 build.
  const rows = (await db.execute(`SELECT sku, storeIndex, packCount, ok, feedStatus, mainImageUrl, newTitle, runAt FROM WalmartListingRemediation WHERE mainImageUrl LIKE '%f50%' ORDER BY runAt DESC`)).rows as any[];
  console.log(`total f50 rows: ${rows.length}`);
  // stamp = the suffix after "main-" in the R2 key
  const stampOf = (u: string) => (String(u).match(/main-([a-z0-9\-]+)\.png/i)?.[1] || "?");
  const byStamp = new Map<string, number>();
  for (const r of rows) { const s = stampOf(r.mainImageUrl); byStamp.set(s, (byStamp.get(s) || 0) + 1); }
  console.log("stamps:", [...byStamp.entries()].map(([s, n]) => `${s}=${n}`).join("  "));
  // latest run per SKU (the current built main we'd publish)
  const latest = new Map<string, any>();
  for (const r of rows) { if (!latest.has(r.sku)) latest.set(r.sku, r); }
  console.log(`unique SKUs: ${latest.size}`);
  let withMain = 0;
  for (const r of latest.values()) if (r.mainImageUrl) withMain++;
  console.log(`with a main image: ${withMain}`);
  console.log("\nsample (latest per sku, first 8):");
  for (const r of [...latest.values()].slice(0, 8)) console.log(`  ${r.sku} pack? · ${stampOf(r.mainImageUrl)} · ${String(r.newTitle || "").slice(0, 45)} · feed=${r.feedStatus} ok=${r.ok}`);
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
