// Independent re-verification of the re-audit's WRONG-PRODUCT calls. Uses a DIFFERENT
// exported judge (frontMatchesListing — separate prompt/fields than the audit's
// qualifyTiledMain) on a deterministic stride sample. If the independent judge also
// says match:false, it CONFIRMS the audit flagged a real defect; match:true DISPUTES.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
async function main() {
  const d = JSON.parse(readFileSync("_reaudit686_result.json", "utf8"));
  const { frontMatchesListing } = await import("./src/lib/sourcing/vision.ts");
  const wp = d.filter((x: any) => x.defect === "wrong-product" && x.url);
  const N = 22;
  const step = Math.max(1, Math.floor(wp.length / N));
  const sample: any[] = []; for (let i = 0; i < wp.length && sample.length < N; i += step) sample.push(wp[i]);
  console.log(`independently re-checking ${sample.length}/${wp.length} wrong-product flags via frontMatchesListing\n`);
  const check = async (x: any) => {
    let v: any = null;
    for (let a = 0; a < 3; a++) { v = await frontMatchesListing(x.url, x.title); if (!/error/i.test(v.reason)) break; await new Promise(r => setTimeout(r, 1500 * (a + 1))); }
    return { x, v };
  };
  const CONC = 4; const res: any[] = [];
  for (let i = 0; i < sample.length; i += CONC) res.push(...await Promise.all(sample.slice(i, i + CONC).map(check)));
  let confirm = 0, dispute = 0, err = 0;
  for (const { x, v } of res) {
    if (/error/i.test(v.reason)) { err++; console.log(`  ? ${x.sku} ERR`); continue; }
    if (v.match === false) { confirm++; console.log(`  CONFIRM ${x.sku} :: ${(x.title || "").slice(0, 42)} :: indep="${(v.reason || "").slice(0, 55)}"`); }
    else { dispute++; console.log(`  DISPUTE ${x.sku} :: ${(x.title || "").slice(0, 42)} :: indep says MATCH="${(v.reason || "").slice(0, 55)}"`); }
  }
  const tot = confirm + dispute;
  console.log(`\nIndependent judge CONFIRMS wrong-product: ${confirm}/${tot}${err ? ` (${err} errored)` : ""}  ·  disputes: ${dispute}`);
  console.log(`=> audit wrong-product false-positive rate ~ ${tot ? Math.round(100 * dispute / tot) : "?"}%`);
}
main().catch(e => { console.error(e); process.exit(1); });
