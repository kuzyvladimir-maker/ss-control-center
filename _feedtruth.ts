// Resolve the TRUE live state of every SUBMITTED remediation row. Our DB left 85
// defective rows at feedStatus=SUBMITTED because the poller never captured the
// terminal state — but the feeds are days old and have long since finished on
// Walmart. Batched feeds mean ~14 feedIds cover all of them. checkFeedItems returns
// per-SKU ingestion status, so one call per feed tells us which SKUs actually went
// live (ok) vs failed ingestion (live listing unchanged = safe).
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const d = JSON.parse(readFileSync("_reaudit686_result.json", "utf8"));
  const defect: Record<string, string> = {}; for (const x of d) defect[x.sku] = x.defect;
  const rows = (await db.execute(`SELECT r.sku, r.storeIndex, r.feedId, r.feedStatus FROM WalmartListingRemediation r JOIN (SELECT sku, MAX(runAt) ra FROM WalmartListingRemediation WHERE feedId IS NOT NULL GROUP BY sku) x ON r.sku=x.sku AND r.runAt=x.ra`)).rows as any[];
  // SUBMITTED rows only, grouped by (storeIndex, feedId)
  const submitted = rows.filter(r => /submit/i.test(String(r.feedStatus || "")));
  const feeds = new Map<string, { store: number; feedId: string }>();
  for (const r of submitted) { const k = `${r.storeIndex}|${r.feedId}`; if (!feeds.has(k)) feeds.set(k, { store: Number(r.storeIndex), feedId: String(r.feedId) }); }
  console.log(`resolving ${submitted.length} SUBMITTED rows across ${feeds.size} feeds\n`);
  const skuState: Record<string, string> = {}; // sku -> PROCESSED_OK | INGEST_FAIL | UNKNOWN
  for (const { store, feedId } of feeds.values()) {
    let res: any = null;
    try { res = await checkFeedItems(getWalmartClient(store), feedId); } catch (e: any) { console.log(`  feed ${feedId.slice(0, 16)}… store${store} ERR ${String(e?.message || e).slice(0, 50)}`); continue; }
    if (!res) { console.log(`  feed ${feedId.slice(0, 16)}… store${store} → null`); continue; }
    let ok = 0, fail = 0;
    for (const it of res.items || []) { const good = it.ok || /SUCCESS/i.test(it.ingestionStatus || ""); skuState[it.sku] = good ? "PROCESSED_OK" : "INGEST_FAIL"; if (good) ok++; else fail++; }
    console.log(`  feed ${feedId.slice(0, 16)}… store${store} status=${res.status} items=${(res.items || []).length} ok=${ok} fail=${fail}`);
  }
  // tally for the SUBMITTED-defective set
  const subDef = submitted.filter(r => defect[r.sku] && defect[r.sku] !== "OK");
  let live = 0, safe = 0, unknown = 0;
  const liveByDefect: Record<string, number> = {};
  for (const r of subDef) { const s = skuState[r.sku]; if (s === "PROCESSED_OK") { live++; liveByDefect[defect[r.sku]] = (liveByDefect[defect[r.sku]] || 0) + 1; } else if (s === "INGEST_FAIL") safe++; else unknown++; }
  console.log(`\n=== SUBMITTED-defective (${subDef.length}) true state ===`);
  console.log(`  actually LIVE (PROCESSED_OK): ${live}`);
  console.log(`  safe (ingestion FAILED, listing unchanged): ${safe}`);
  console.log(`  unknown (feed not resolvable): ${unknown}`);
  console.log(`  newly-confirmed-live by defect:`, JSON.stringify(liveByDefect));
  writeFileSync("_feedtruth_result.json", JSON.stringify(skuState, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
