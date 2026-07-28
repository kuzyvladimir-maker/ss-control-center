// FIX DEMO — rebuild 20 representative live-defective listings correctly and show
// before→after. NO Walmart writes. Two paths:
//  • REVERT (not-multipack): the listing is a SINGLE unit that never should have been
//    tiled; "after" = one clean single-unit donor front + corrected single title.
//  • REBUILD (everything else): identify the real product → resolve a verified
//    single-unit donor → tile ×units → qualifyTiledMain. "after" = the passing tile
//    (or an honest "still no clean donor" if the waterfall + gates reject).
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
const PICK = [
  "FaisalX-1119", "FaisalX-4972", "FaisalX-4158", "FaisalX-4397",            // revert
  "FaisalX-1140", "FaisalX-1138", "FaisalX-1131", "FaisalX-1134",            // wrong-product
  "FaisalX-1114", "FaisalX-1122", "FaisalX-1162", "FaisalX-1176",
  "FaisalX-4016", "FaisalX-4089", "FaisalX-3453", "FaisalX-4401",            // multipack-in-cell
  "FaisalX-2076", "RizwanX-138", "RizwanX-2412",                            // not-face-on
  "RizwanX-3009",                                                           // colored-bg
];
// corrected single-unit title for reverts: drop our appended "— N-Pack (...)" suffix
const singleTitle = (t: string) => String(t || "").replace(/\s*[—-]\s*\d+\s*-?\s*pack\b.*$/i, "").replace(/\s{2,}/g, " ").trim();
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { identifyProduct } = await import("./src/lib/sourcing/identify.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const final = JSON.parse(readFileSync("_final_audit.json", "utf8"));
  const bySku: Record<string, any> = {}; for (const x of final) bySku[x.sku] = x;
  const items = PICK.map(s => bySku[s]).filter(Boolean);
  console.log(`fixing ${items.length} listings\n`);
  const results: any[] = [];
  const fix = async (x: any) => {
    const title = String(x.title || "");
    let id: any = null; try { id = await identifyProduct({ title }); } catch { }
    let donor: any = null;
    for (let a = 0; a < 2 && !donor; a++) { try { donor = await resolveDonorPhoto(title, { searchQuery: id?.retail_search_query, identityTitle: id?.base_unit || title }); } catch { } }
    const out: any = { sku: x.sku, defect: x.defect, wasUrl: x.url, wasTitle: title, action: x.defect === "not-multipack" ? "REVERT" : "REBUILD", donorSrc: donor?.src || null };
    if (!donor) { out.status = "NO_DONOR"; results.push(out); console.log(`  ${x.sku} [${out.action}] ✗ no clean donor`); return; }
    try {
      if (x.defect === "not-multipack") {
        // single unit, un-tiled — just the verified donor front at high res
        const buf = await fetchImageBuffer(highResImageUrl(donor.url));
        out.nowUrl = await uploadToR2(buf, multipackImageKey(x.sku, "main", "fixdemo"));
        out.nowTitle = singleTitle(title);
        out.status = "REVERTED";
        console.log(`  ${x.sku} [REVERT] ✓ single unit (${donor.src})  title→ "${out.nowTitle.slice(0, 40)}"`);
      } else {
        const units = Number(x.units) || 0;
        const base = await fetchImageBuffer(highResImageUrl(donor.url));
        const tile = await uploadToR2(await composeTiledMainImage(base, units), multipackImageKey(x.sku, "main", "fixdemo"));
        const v = await vision.qualifyTiledMain(tile, id?.base_unit || title, units);
        out.nowUrl = tile; out.verdict = v;
        out.status = v.pass ? "REBUILT_PASS" : "REBUILT_FAIL";
        console.log(`  ${x.sku} [REBUILD ×${units}] ${v.pass ? "✓ PASS" : "✗ " + (v.reason || "").slice(0, 50)} (${donor.src})`);
      }
    } catch (e: any) { out.status = "ERR"; out.err = String(e?.message || e).slice(0, 80); console.log(`  ${x.sku} ERR ${out.err}`); }
    results.push(out);
  };
  const CONC = 3;
  for (let i = 0; i < items.length; i += CONC) await Promise.all(items.slice(i, i + CONC).map(fix));
  writeFileSync("_fix_demo_result.json", JSON.stringify(results, null, 2));
  const ok = results.filter(r => r.status === "REVERTED" || r.status === "REBUILT_PASS").length;
  console.log(`\nDONE: ${ok}/${items.length} fixed & passing`);
  // gallery
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const badge = (r: any) => r.status === "REBUILT_PASS" || r.status === "REVERTED" ? `<span style="color:#22c55e">✓ ${r.status}</span>` : `<span style="color:#f59e0b">${r.status}</span>`;
  const cell = (lbl: string, url: string, sub: string, col: string) => `<div><div style="color:${col};font-size:11px;font-weight:700">${lbl}</div><div style="color:#9ca3af;font-size:11px;height:28px;overflow:hidden">${esc(sub)}</div>${url ? `<img src="${esc(url)}" style="width:230px;height:230px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:230px;height:230px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">—</div>`}</div>`;
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:12px;margin:10px 0;background:#0f1115">
    <div style="font-weight:700;color:#fff">${esc(r.sku)} · ${esc(r.defect)} · ${esc(r.action)} · ${badge(r)} ${r.donorSrc ? `<span style="color:#64748b;font-weight:400">донор: ${esc(r.donorSrc)}</span>` : ""}</div>
    <div style="display:flex;gap:14px;margin-top:8px">
      ${cell("БЫЛО (сейчас живёт на Walmart)", r.wasUrl, r.wasTitle, "#ef4444")}
      ${cell("СТАЛО (наш фикс)", r.nowUrl, r.nowTitle || r.wasTitle, "#22c55e")}
    </div>${r.verdict ? `<div style="color:#9ca3af;font-size:12px;margin-top:6px"><i>${esc(String(r.verdict.reason || "").slice(0, 130))}</i></div>` : ""}</div>`;
  const okR = results.filter(r => r.status === "REVERTED" || r.status === "REBUILT_PASS");
  const badR = results.filter(r => !(r.status === "REVERTED" || r.status === "REBUILT_PASS"));
  const html = `<!doctype html><meta charset=utf8><title>Фикс-демо: было → стало</title>
  <body style="background:#0b0d10;font-family:system-ui;max-width:1080px;margin:0 auto;padding:24px;color:#e5e7eb">
  <h1 style="color:#fff">Фикс-демо: было → стало (${okR.length}/${results.length})</h1>
  <div style="color:#9ca3af;margin-bottom:12px">Пересобрано новым движком (identify → verified single-unit donor → плашки ×N → второй судья). Пока НЕ опубликовано — жду твоего ОК.</div>
  ${okR.map(card).join("")}
  ${badR.length ? `<h2 style="color:#f59e0b">Ещё не удалось (честно) — ${badR.length}</h2>${badR.map(card).join("")}` : ""}
  </body>`;
  console.log("GALLERY:", await uploadToR2(Buffer.from(html), `walmart-review/fix-demo.html`, "text/html"));
}
main().catch(e => { console.error(e); process.exit(1); });
