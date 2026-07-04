// Smoke test the shared resolveDonorPhoto module (the prod live-waterfall path):
// one title that hits Walmart 1P, one that only Google Images finds.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const { qualifyTiledMain } = await import("./src/lib/sourcing/vision.ts");
  const cases = [
    { title: "Cheez-It Extra Cheesy Cheese Crackers, Baked Snack Crackers, 12.4 oz (Pack of 4)", pack: 4 },
    { title: "Arnold Superior Seeded Keto Bread Loaf, 20 oz (Pack of 6)", pack: 6 },
  ];
  for (const c of cases) {
    console.log(`\n=== ${c.title}`);
    const dp = await resolveDonorPhoto(c.title, { log: (m) => console.log(m) });
    if (!dp) { console.log("  → no single-unit donor"); continue; }
    console.log(`  donor: ${dp.src} — ${dp.url.slice(0, 70)}`);
    const base = await fetchImageBuffer(highResImageUrl(dp.url));
    const tile = await uploadToR2(await composeTiledMainImage(base, c.pack), multipackImageKey(`smoke-${c.pack}`, "main", "smoke"));
    const tv = await qualifyTiledMain(tile, c.title, c.pack);
    console.log(`  tile qualify: ${tv.pass ? "✅ PASS" : "❌ FAIL"} [id${+tv.identity} cell${+tv.eachCellSingle} count${+tv.countOk} front${+tv.front} white${+tv.whiteBg}] ${tv.reason}`);
    console.log(`  tile: ${tile}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
