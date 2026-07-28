// Definitive live-state resolution for EVERY audited SKU, replacing the unreliable
// DB feedStatus (which is feed-level, so it marks items PROCESSED even when their
// individual ingestion FAILED — and left many at SUBMITTED). We pull item-level
// ingestion status straight from Walmart (checkFeedItems) for every feed that our
// latest-sent row per SKU belongs to. Output: sku -> LIVE | SAFE(ingest-failed) |
// UNKNOWN, then cross-tabbed against the audit defect so we know the TRUE damage.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const d = JSON.parse(readFileSync("_reaudit686_result.json", "utf8"));
  const defect: Record<string, string> = {}; for (const x of d) defect[x.sku] = x.defect;
  const rows = (await db.execute(`SELECT r.sku, r.storeIndex, r.feedId FROM WalmartListingRemediation r JOIN (SELECT sku, MAX(runAt) ra FROM WalmartListingRemediation WHERE feedId IS NOT NULL GROUP BY sku) x ON r.sku=x.sku AND r.runAt=x.ra`)).rows as any[];
  const auditedSku = new Set(d.map((x: any) => x.sku));
  const rel = rows.filter(r => auditedSku.has(r.sku) && r.feedId);
  const feeds = new Map<string, { store: number; feedId: string }>();
  for (const r of rel) { const k = `${r.storeIndex}|${r.feedId}`; if (!feeds.has(k)) feeds.set(k, { store: Number(r.storeIndex), feedId: String(r.feedId) }); }
  console.log(`resolving item-level truth for ${rel.length} SKUs across ${feeds.size} feeds`);
  const skuState: Record<string, string> = {};
  const flist = [...feeds.values()]; const CONC = 4; let done = 0;
  const one = async (fd: { store: number; feedId: string }) => {
    for (let a = 0; a < 3; a++) {
      try { const res: any = await checkFeedItems(getWalmartClient(fd.store), fd.feedId); if (res) { for (const it of res.items || []) skuState[it.sku] = (it.ok || /SUCCESS/i.test(it.ingestionStatus || "")) ? "LIVE" : "SAFE"; return; } } catch { }
      await new Promise(r => setTimeout(r, 1200 * (a + 1)));
    }
  };
  for (let i = 0; i < flist.length; i += CONC) { await Promise.all(flist.slice(i, i + CONC).map(one)); done += Math.min(CONC, flist.length - i); if (done % 20 < CONC) console.log(`  ${done}/${flist.length} feeds`); }
  writeFileSync("_feedtruth_all.json", JSON.stringify(skuState, null, 2));
  // cross-tab defect x true-state
  const states = ["LIVE", "SAFE", "UNKNOWN"];
  const tab: Record<string, Record<string, number>> = {};
  for (const x of d) { const s = skuState[x.sku] || "UNKNOWN"; (tab[x.defect] ||= {})[s] = ((tab[x.defect] ||= {})[s] || 0) + 1; }
  console.log(`\n=== DEFECT × TRUE STATE (Walmart item-level) ===`);
  console.log("defect".padEnd(20) + states.map(s => s.padEnd(9)).join(""));
  for (const dd of Object.keys(tab).sort()) console.log(dd.padEnd(20) + states.map(s => String(tab[dd][s] || 0).padEnd(9)).join(""));
  const defective = d.filter((x: any) => x.defect !== "OK");
  const liveDef = defective.filter((x: any) => skuState[x.sku] === "LIVE");
  const safeDef = defective.filter((x: any) => skuState[x.sku] === "SAFE");
  const unkDef = defective.filter((x: any) => !skuState[x.sku]);
  console.log(`\nDefective total: ${defective.length}`);
  console.log(`  TRULY LIVE (real damage): ${liveDef.length}`);
  console.log(`  SAFE (ingestion failed, listing untouched): ${safeDef.length}`);
  console.log(`  UNKNOWN (feed not resolvable): ${unkDef.length}`);
  const lbd: Record<string, number> = {}; for (const x of liveDef) lbd[x.defect] = (lbd[x.defect] || 0) + 1;
  console.log(`  live-defective by type:`, JSON.stringify(lbd));
}
main().catch(e => { console.error(e); process.exit(1); });
