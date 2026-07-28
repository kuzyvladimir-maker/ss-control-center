// Re-check the 20 rows my broken realUnits heuristic wrongly flagged "not-multipack".
// SOURCE OF TRUTH = packCount (what we set at listing creation, matching Walmart's
// "(Pack of N)"), NOT title words. For each: run qualifyTiledMain on the CURRENT LIVE
// image with the CORRECT packCount. This proves whether the live images are actually
// fine (they should be — they show N single units) or have a real issue.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const f = JSON.parse(readFileSync("_final_audit.json", "utf8"));
  const nm = f.filter((x: any) => x.defect === "not-multipack" && x.url);
  console.log(`re-checking ${nm.length} wrongly-flagged rows with authoritative packCount\n`);
  const out: any[] = [];
  const check = async (x: any) => {
    const rem = (await db.execute({ sql: "SELECT packCount FROM WalmartListingRemediation WHERE sku=? AND feedId IS NOT NULL ORDER BY runAt DESC LIMIT 1", args: [x.sku] })).rows[0] as any;
    const cat = (await db.execute({ sql: "SELECT title FROM WalmartCatalogItem WHERE sku=? LIMIT 1", args: [x.sku] })).rows[0] as any;
    const pack = Number(rem?.packCount) || 0;
    const title = String(cat?.title || x.title || "").replace(/\s*—.*$/, "").trim();
    let v: any = null;
    for (let a = 0; a < 3; a++) { v = await vision.qualifyTiledMain(x.url, title, pack); if (!/error/i.test(v.reason)) break; await new Promise(r => setTimeout(r, 1500 * (a + 1))); }
    let now = "OK";
    if (!v.identity) now = "wrong-product";
    else if (!v.eachCellSingle) now = "multipack-in-cell";
    else if (!v.countOk) now = "wrong-count";
    else if (!v.front) now = "not-face-on";
    else if (!v.whiteBg) now = "colored-bg";
    else if (!v.pass) now = "other-fail";
    out.push({ sku: x.sku, pack, live: x.live, now, title, reason: v?.reason || "" });
    console.log(`  ${x.sku} pack=${pack} → ${now === "OK" ? "✓ OK (live image correct)" : "✗ " + now}  ${now === "OK" ? "" : "(" + (v?.reason || "").slice(0, 55) + ")"}`);
  };
  const CONC = 4;
  for (let i = 0; i < nm.length; i += CONC) await Promise.all(nm.slice(i, i + CONC).map(check));
  writeFileSync("_recheck_notmp_result.json", JSON.stringify(out, null, 2));
  const okN = out.filter(x => x.now === "OK").length;
  const byNow: Record<string, number> = {}; for (const x of out) byNow[x.now] = (byNow[x.now] || 0) + 1;
  console.log(`\n=== with correct packCount: ${okN}/${out.length} are actually FINE ===`);
  console.log("breakdown:", JSON.stringify(byNow));
}
main().catch(e => { console.error(e); process.exit(1); });
