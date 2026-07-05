// TRUNK finalize: rebuild ALL backlog fails (_verifyall_fails.json) with the new
// engine — full store waterfall (Walmart→Sam's/Target/Costco→Publix/BJ's/Aldi→
// Google) + BOTH free vision lanes (Codex + Claude, round-robin). Canonical donor
// per product. qualifyTiledMain gates each. Before/after gallery + saved results.
// NO Walmart writes.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto"; // both free lanes (Codex + Claude)
const CONC = 3;
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const fails: any[] = JSON.parse(readFileSync("_verifyall_fails.json", "utf8"));
  console.log(`rebuilding ${fails.length} backlog fails (2 lanes, conc=${CONC})`);
  const STAMP = "rebuildall";
  const key = (t: string) => String(t || "").toLowerCase().replace(/\bpack of \d+\b/g, "").replace(/\b\d+\s*-?\s*(pack|pk|ct|count)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map<string, any[]>();
  for (const it of fails) { const k = key(it.title); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(it); }
  const glist = [...groups.values()];
  console.log(`unique products: ${glist.size ?? glist.length}`);

  const out: any[] = [];
  let done = 0;
  const processGroup = async (members: any[]) => {
    const title = members[0].title;
    let donor: any = null;
    try { donor = await resolveDonorPhoto(title); } catch {}
    for (const m of members) {
      let newUrl: string | null = null; let v: any = null;
      const pack = Number(m.pack) || 0;
      if (donor && pack >= 2) {
        try {
          const base = await fetchImageBuffer(highResImageUrl(donor.url));
          const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(m.sku, "main", STAMP));
          v = await vision.qualifyTiledMain(tile, title, pack);
          if (v.pass) newUrl = tile;
        } catch (e: any) { v = { reason: "err " + e?.message }; }
      }
      out.push({ sku: m.sku, pack, title, oldUrl: m.oldUrl, feed: m.feed, newUrl, src: donor?.src || "—", v });
    }
    done += members.length;
    console.log(`  done ${done}/${fails.length} · fixed ${out.filter(r => r.newUrl).length} · [grp ${title.slice(0,40)} → ${donor ? donor.src : "NO DONOR"}]`);
  };
  for (let i = 0; i < glist.length; i += CONC) {
    await Promise.all(glist.slice(i, i + CONC).map(processGroup));
  }

  const fixed = out.filter(r => r.newUrl);
  writeFileSync("_rebuildall_result.json", JSON.stringify(fixed.map(r => ({ sku: r.sku, newUrl: r.newUrl, pack: r.pack, src: r.src })), null, 2));
  writeFileSync("_rebuildall_stillfail.json", JSON.stringify(out.filter(r => !r.newUrl).map(r => ({ sku: r.sku, pack: r.pack, title: r.title })), null, 2));
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const cell = (label: string, url: string, color: string) => `<div><div style="color:${color};font-size:11px">${label}</div>${url ? `<img src="${esc(url)}" style="width:230px;height:230px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:230px;height:230px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">нет</div>`}</div>`;
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;margin:8px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} · <span style="color:${r.newUrl ? "#22c55e" : "#ef4444"}">${r.newUrl ? "ИСПРАВЛЕНО (" + esc(r.src) + ")" : "донор не найден → генерация"}</span></div><div style="color:#9ca3af;margin:2px 0 5px">${esc(r.title)}</div><div style="display:flex;gap:12px">${cell("БЫЛО", r.oldUrl, "#ef4444")}${cell("СТАЛО", r.newUrl, "#22c55e")}</div></div>`;
  const html = `<!doctype html><meta charset=utf8><title>Rebuild backlog</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Пересборка бэклога (${out.length})</h1><div style="color:#9ca3af">Исправлено: <b style="color:#22c55e">${fixed.length}</b>/${out.length}. Обе дорожки, $0. В Walmart НЕ отправлено.</div>${out.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/rebuild-backlog.html`, "text/html");
  console.log(`\nREBUILT: ${fixed.length}/${out.length} fixed`);
  console.log(`GALLERY: ${gu}`);
  console.log(`results: _rebuildall_result.json · still-failing: _rebuildall_stillfail.json`);
}
main().catch(e => { console.error(e); process.exit(1); });
