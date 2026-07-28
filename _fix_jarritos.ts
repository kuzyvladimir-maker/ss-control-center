// URGENT single-product fix + recipe demo: Jarritos Mineragua Sparkling Water 1.5L,
// sold as Pack of 2 / 4 / 6 (FaisalX-1856/1857/1858). Live main image is a "12 Pack"
// case tiled N times => looks like 24/48/72 small bottles, not N single 1.5L bottles.
// New engine: identify the ONE 1.5L bottle → resolve a VERIFIED single-unit donor
// (must reject the 12-pack case) → tile ×2/×4/×6 → qualifyTiledMain. NO publish.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
const TARGETS = [
  { sku: "FaisalX-1856", pack: 2, wasUrl: "" },
  { sku: "FaisalX-1857", pack: 4, wasUrl: "" },
  { sku: "FaisalX-1858", pack: 6, wasUrl: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1858/main-20260617-67970.png" },
];
const TITLE = "Jarritos Mineragua Sparkling Water, 1.5 Liter Bottle";
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { identifyProduct } = await import("./src/lib/sourcing/identify.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const client = getWalmartClient(1);
  // pull current live image for the siblings (1858 we already have)
  for (const t of TARGETS) {
    if (t.wasUrl) continue;
    try {
      const r: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(t.sku)}`)).body;
      const cur = r?.ItemResponse?.[0];
      const img = cur?.images?.[0]?.url || cur?.mainImageUrl || cur?.imageUrl || "";
      t.wasUrl = img;
      console.log(`  ${t.sku} current live image: ${img ? img.slice(0, 70) : "(none returned by getItem)"}`);
    } catch (e: any) { console.log(`  ${t.sku} getItem err ${String(e?.message || e).slice(0, 50)}`); }
  }
  // identify the single 1.5L bottle ONCE (recipe reference product)
  const id = await identifyProduct({ title: TITLE + ", 1 Count" });
  console.log(`\nIDENTIFY → base_unit="${id?.base_unit}" query="${id?.retail_search_query}" units=${id?.units_in_listing} bundle=${id?.is_bundle}`);
  // resolve ONE verified single-unit donor (shared across all pack sizes)
  let donor: any = null;
  for (let a = 0; a < 3 && !donor; a++) {
    donor = await resolveDonorPhoto(TITLE, { searchQuery: id?.retail_search_query || "Jarritos Mineragua Sparkling Water 1.5 Liter", identityTitle: id?.base_unit || TITLE, log: (m) => console.log("   " + m) });
  }
  const results: any[] = [];
  if (!donor) {
    console.log("\n✗ NO CLEAN SINGLE-BOTTLE DONOR FOUND — engine correctly refused the 12-pack; need another source");
    for (const t of TARGETS) results.push({ ...t, status: "NO_DONOR" });
  } else {
    console.log(`\n✓ donor: ${donor.src} — ${donor.url.slice(0, 70)}`);
    const base = await fetchImageBuffer(highResImageUrl(donor.url));
    for (const t of TARGETS) {
      const tile = await uploadToR2(await composeTiledMainImage(base, t.pack), multipackImageKey(t.sku, "main", "jarritosfix"));
      const v = await vision.qualifyTiledMain(tile, id?.base_unit || TITLE, t.pack);
      results.push({ ...t, nowUrl: tile, verdict: v, status: v.pass ? "PASS" : "FAIL", donorSrc: donor.src });
      console.log(`  ${t.sku} ×${t.pack} → ${v.pass ? "✓ PASS" : "✗ " + (v.reason || "").slice(0, 60)}`);
    }
  }
  writeFileSync("_fix_jarritos_result.json", JSON.stringify({ donor, id, results }, null, 2));
  // before/after gallery
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const cell = (lbl: string, url: string, col: string) => `<div><div style="color:${col};font-size:12px;font-weight:700;margin-bottom:3px">${lbl}</div>${url ? `<img src="${esc(url)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">—</div>`}</div>`;
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115">
    <div style="font-weight:700;color:#fff;font-size:15px">${esc(r.sku)} · Pack of ${r.pack} · ${r.status === "PASS" ? '<span style="color:#22c55e">✓ починено</span>' : `<span style="color:#f59e0b">${esc(r.status)}</span>`}</div>
    <div style="display:flex;gap:16px;margin-top:10px;align-items:flex-start">
      ${cell(`БЫЛО — 6 плашек по "12 Pack" = ${r.pack * 12} мелких бутылок`, r.wasUrl, "#ef4444")}
      ${cell(`СТАЛО — ${r.pack} × одна 1.5L бутылка`, r.nowUrl, "#22c55e")}
    </div>${r.verdict ? `<div style="color:#9ca3af;font-size:12px;margin-top:8px"><i>второй судья: ${esc(String(r.verdict.reason || "").slice(0, 150))}</i></div>` : ""}</div>`;
  const html = `<!doctype html><meta charset=utf8><title>Jarritos фикс</title>
  <body style="background:#0b0d10;font-family:system-ui;max-width:760px;margin:0 auto;padding:24px;color:#e5e7eb">
  <h1 style="color:#fff">Jarritos Mineragua 1.5L — было → стало</h1>
  <div style="color:#9ca3af;margin-bottom:8px">Один товар (1.5L бутылка), три листинга по фасовке 2/4/6 — это и есть «рецепт»: опознали единицу один раз, разложили по числу пака. Пока НЕ опубликовано.</div>
  ${results.map(card).join("")}</body>`;
  console.log("\nGALLERY:", await uploadToR2(Buffer.from(html), `walmart-review/jarritos-fix.html`, "text/html"));
}
main().catch(e => { console.error(e); process.exit(1); });
