// Backlog re-run WITH the identify step (step 2 → step 3). For each canonical
// product: identifyProduct(title) → clean query + clean single-unit identity →
// resolveDonorPhoto(searchQuery, identityTitle) → tile ×packCount → qualifyTiledMain.
// Bundles (is_bundle) are flagged + skipped (need component handling, not a single
// tiled unit). Merges with _rebuildall_result.json (the 62 already fixed). NO writes.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
const CONC = 3;
const OWN = /\bstarfit\b|salutem\s*vita|salutem\s*solutions|nicotinamide|lion'?s?\s*mane/i;
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { identifyProduct } = await import("./src/lib/sourcing/identify.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const fails: any[] = JSON.parse(readFileSync("_rebuildall_stillfail.json", "utf8")).filter((x: any) => !OWN.test(x.title));
  const already: any[] = JSON.parse(readFileSync("_rebuildall_result.json", "utf8"));
  console.log(`rebuilding ${fails.length} with identify (own-brand excluded)`);
  const key = (t: string) => String(t || "").toLowerCase().replace(/\bpack of \d+\b/g, "").replace(/\b\d+\s*-?\s*(pack|pk|ct|count)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map<string, any[]>();
  for (const it of fails) { const k = key(it.title); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(it); }
  const glist = [...groups.values()];
  console.log(`unique products: ${glist.length}`);

  const fixed: any[] = [], stillNo: any[] = [], bundles: any[] = [];
  let done = 0;
  const proc = async (members: any[]) => {
    const title = members[0].title;
    let id: any = null; try { id = await identifyProduct({ title }); } catch {}
    if (id?.is_bundle) { for (const m of members) bundles.push({ sku: m.sku, title, components: id.components }); done += members.length; console.log(`  ${done}/${fails.length} [BUNDLE ${title.slice(0,34)} → ${id.components?.length||0} компонентов, отдельная обработка]`); return; }
    let donor: any = null;
    for (let a = 0; a < 2 && !donor; a++) {
      try { donor = await resolveDonorPhoto(title, { searchQuery: id?.retail_search_query, identityTitle: id?.base_unit || title }); } catch {}
    }
    for (const m of members) {
      const pack = Number(m.pack) || 0; let newUrl: string | null = null; let v: any = null;
      if (donor && pack >= 2) {
        try { const base = await fetchImageBuffer(highResImageUrl(donor.url)); const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(m.sku, "main", "idrun")); v = await vision.qualifyTiledMain(tile, id?.base_unit || title, pack); if (v.pass) newUrl = tile; } catch (e: any) { v = { reason: "err " + e?.message }; }
      }
      if (newUrl) fixed.push({ sku: m.sku, pack, title, oldUrl: m.oldUrl, newUrl, src: donor.src });
      else stillNo.push({ sku: m.sku, pack, title, oldUrl: m.oldUrl, reason: donor ? (v?.reason || "reject") : "no donor" });
    }
    done += members.length;
    console.log(`  ${done}/${fails.length} · fixed ${fixed.length} · [${title.slice(0,34)} → ${donor ? donor.src : "NO DONOR"}] id="${(id?.base_unit||"").slice(0,40)}"`);
  };
  for (let i = 0; i < glist.length; i += CONC) await Promise.all(glist.slice(i, i + CONC).map(proc));

  const allFixed = [...already, ...fixed.map(r => ({ sku: r.sku, newUrl: r.newUrl, pack: r.pack, src: r.src }))];
  writeFileSync("_backlog_final_fixed.json", JSON.stringify(allFixed, null, 2));
  writeFileSync("_backlog_final_nodonor.json", JSON.stringify(stillNo, null, 2));
  writeFileSync("_backlog_bundles.json", JSON.stringify(bundles, null, 2));
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const cell = (l: string, u: string, c: string) => `<div><div style="color:${c};font-size:11px">${l}</div>${u ? `<img src="${esc(u)}" style="width:220px;height:220px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:220px;height:220px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">нет</div>`}</div>`;
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;margin:8px 0;background:#0f1115"><div style="color:#22c55e;font-weight:700">${esc(r.sku)} · pack ${r.pack} · ИСПРАВЛЕНО (${esc(r.src)})</div><div style="color:#9ca3af;margin:2px 0 5px">${esc(r.title)}</div><div style="display:flex;gap:12px">${cell("БЫЛО", r.oldUrl, "#ef4444")}${cell("СТАЛО", r.newUrl, "#22c55e")}</div></div>`;
  const html = `<!doctype html><meta charset=utf8><title>Backlog identify</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Бэклог с идентификацией — итог</h1><div style="color:#9ca3af">Исправлено этим прогоном: <b style="color:#22c55e">${fixed.length}</b>. Итого по бэклогу: <b style="color:#22c55e">${allFixed.length}</b>. Нет донора: <b style="color:#f59e0b">${stillNo.length}</b>. Бандлы (отдельно): <b>${bundles.length}</b>.</div>${fixed.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/backlog-identify.html`, "text/html");
  console.log(`\nFIXED this run: ${fixed.length} · TOTAL backlog fixed: ${allFixed.length} · no-donor: ${stillNo.length} · bundles: ${bundles.length}`);
  console.log(`GALLERY: ${gu}`);
}
main().catch(e => { console.error(e); process.exit(1); });
