// Re-audit v2 — fixes the blank-title hole in v1. v1 read the remediation row's
// newTitle, which is EMPTY for image-only feeds (514/743 rows), so identity
// (brand/variant) went unverified: "OK" on a blank title only means structure was
// fine, and "wrong-product" on a blank title is unreliable. Here we pull the
// AUTHORITATIVE title from WalmartCatalogItem and RE-JUDGE only the identity-
// dependent verdicts (OK, wrong-product) that had a blank title. Structural verdicts
// (multipack-in-cell / not-face-on / colored-bg / wrong-count) are title-independent
// and kept as-is. Output: corrected classification for the re-judged rows.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
const CONC = 6;
function realUnits(title: string, packHint: number): { units: number; basis: string } {
  const t = String(title || "").toLowerCase();
  const po = t.match(/pack of\s+(\d+)/) || t.match(/\b(\d+)\s*[-\s]?pack\b/) || t.match(/\b(\d+)\s*[-\s]?pk\b/);
  if (po) return { units: Number(po[1]), basis: "pack-of" };
  if (/\b1\s*box\b|value\s*pack|\bct\b|\bcount\b|\bbagels?\b|\bbars?\b|cookies|\btotal\s+\d+/.test(t)) return { units: 1, basis: "pieces-in-one-unit" };
  return { units: packHint || 0, basis: "pack-hint" };
}
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const v1 = JSON.parse(readFileSync("_reaudit686_result.json", "utf8"));
  const cat: Record<string, any> = {};
  for (const r of (await db.execute("SELECT sku, title, titlePackCount FROM WalmartCatalogItem")).rows as any[]) cat[r.sku] = r;
  // only re-judge identity-dependent verdicts that were made on a BLANK title AND now have a real catalog title
  const targets = v1.filter((x: any) => (x.defect === "OK" || x.defect === "wrong-product") && !(x.title || "").trim() && x.url && cat[x.sku]?.title);
  console.log(`re-judging ${targets.length} identity-dependent blank-title rows with authoritative catalog titles (conc=${CONC})`);
  const judge = async (x: any) => {
    const title = String(cat[x.sku].title).replace(/\s*—.*$/, "").trim();
    const ru = realUnits(title, Number(cat[x.sku].titlePackCount) || x.realUnits || 0);
    if (ru.units < 4) return { sku: x.sku, was: x.defect, now: "not-multipack", title, units: ru.units, basis: ru.basis, reason: "real title = pieces-in-one-unit" };
    let v: any = null;
    for (let a = 0; a < 3; a++) { v = await vision.qualifyTiledMain(x.url, title, ru.units); if (!/error/i.test(v.reason)) break; await new Promise(r => setTimeout(r, 1500 * (a + 1))); }
    let now = "OK";
    if (!v.identity) now = "wrong-product";
    else if (!v.eachCellSingle) now = "multipack-in-cell";
    else if (!v.countOk) now = "wrong-count";
    else if (!v.front) now = "not-face-on";
    else if (!v.whiteBg) now = "colored-bg";
    else if (!v.pass) now = "other-fail";
    return { sku: x.sku, was: x.defect, now, title, units: ru.units, basis: ru.basis, reason: v?.reason || "" };
  };
  const out: any[] = []; let done = 0;
  for (let i = 0; i < targets.length; i += CONC) { const c = await Promise.all(targets.slice(i, i + CONC).map(judge)); out.push(...c); done += c.length; if (done % 60 < CONC) console.log(`  ${done}/${targets.length}`); }
  writeFileSync("_reaudit_v2_result.json", JSON.stringify(out, null, 2));
  // transition matrix
  const flips: Record<string, number> = {};
  for (const r of out) { const k = `${r.was} -> ${r.now}`; flips[k] = (flips[k] || 0) + 1; }
  console.log("\n=== TRANSITIONS (blank-title rows, was=v1 verdict, now=with real title) ===");
  for (const [k, n] of Object.entries(flips).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  // net effect on the whole audit
  const wasOK = out.filter(r => r.was === "OK");
  const nowBadFromOK = wasOK.filter(r => r.now !== "OK");
  const wasWP = out.filter(r => r.was === "wrong-product");
  const nowOkFromWP = wasWP.filter(r => r.now === "OK" || r.now === "not-multipack");
  console.log(`\nHidden defects surfaced (v1 said OK, real title says defective): ${nowBadFromOK.length}/${wasOK.length}`);
  console.log(`False alarms cleared (v1 said wrong-product, real title says OK/not-mp): ${nowOkFromWP.length}/${wasWP.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
