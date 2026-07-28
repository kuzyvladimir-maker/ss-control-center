// DENYLIST RETRY for REBUILT_FAIL rows: the plain retry loop kept re-finding the SAME
// first-passing donor and failing identically (Maruchan bowl vs packet). Now each
// failed attempt's donor URL goes into excludeUrls, so resolveDonorPhoto reaches the
// NEXT candidate in the waterfall. Up to 3 different donors per SKU. Updates
// _pipeline_state.json in place (REBUILT_OK on success). Browser tier stays OFF.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
delete process.env.OPENCLAW_GROCERY_URL; delete process.env.OPENCLAW_GROCERY_TOKEN; // no browser stores (BJ's ban cooling)
const CONC = 2;
const STATE = "_pipeline_state.json";
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { identifyProduct } = await import("./src/lib/sourcing/identify.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const todo = Object.values(state).filter((x: any) => x.status === "REBUILT_FAIL");
  console.log(`denylist-retrying ${todo.length} REBUILT_FAIL rows (max 3 different donors each)\n`);
  const qual = async (url: string, title: string, pack: number) => {
    let v: any = null;
    for (let a = 0; a < 3; a++) { v = await vision.qualifyTiledMain(url, title, pack); if (!/error/i.test(v.reason)) break; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
    return v;
  };
  let fixed = 0, still = 0;
  const run = async (x: any) => {
    const title = x.title, pack = Number(x.pack) || 0;
    if (!title || pack < 2) { still++; return; }
    let id: any = null; try { id = await identifyProduct({ title }); } catch { }
    const exclude: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      let donor: any = null;
      try { donor = await resolveDonorPhoto(title, { searchQuery: id?.retail_search_query, identityTitle: id?.base_unit || title, excludeUrls: exclude }); } catch { }
      if (!donor) break; // waterfall exhausted
      try {
        const base = await fetchImageBuffer(highResImageUrl(donor.url));
        const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(x.sku, "main", `retry${attempt}`));
        const v = await qual(tile, id?.base_unit || title, pack);
        if (v.pass) {
          Object.assign(x, { status: "REBUILT_OK", newUrl: tile, donorSrc: donor.src, newReason: v.reason, retriedWithDenylist: true });
          writeFileSync(STATE, JSON.stringify(state, null, 1));
          fixed++;
          console.log(`  ✓ ${x.sku} fixed on donor #${attempt + 1} (${donor.src})`);
          return;
        }
        console.log(`  … ${x.sku} donor #${attempt + 1} (${donor.src}) rejected: ${(v.reason || "").slice(0, 55)}`);
      } catch (e: any) { console.log(`  … ${x.sku} donor #${attempt + 1} err ${String(e?.message || e).slice(0, 40)}`); }
      exclude.push(donor.url);
    }
    still++;
    x.retriedWithDenylist = true;
    writeFileSync(STATE, JSON.stringify(state, null, 1));
    console.log(`  ✗ ${x.sku} still failing after ${exclude.length + 1} donor attempts`);
  };
  for (let i = 0; i < todo.length; i += CONC) await Promise.all(todo.slice(i, i + CONC).map(run));
  console.log(`\n=== DENYLIST RETRY: fixed ${fixed} · still-fail ${still} ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
