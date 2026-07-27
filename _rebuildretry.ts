// Retry the backlog rebuild MISSES gently (recovers false misses from transient
// rate-limit blips in the big run). Parks own-brand (Vladimir provides originals).
// Gentle: conc=2, per-listing retry on transient error. Merges with the big run's
// fixes → one combined result + gallery. NO Walmart writes.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto"; // both free lanes, gentle pace
const CONC = 2;
const OWN_BRAND = /\bstarfit\b|salutem\s*vita|salutem\s*solutions|nicotinamide|lion'?s?\s*mane/i;
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const stillfail: any[] = JSON.parse(readFileSync("_rebuildall_stillfail.json", "utf8"));
  const alreadyFixed: any[] = JSON.parse(readFileSync("_rebuildall_result.json", "utf8"));
  const own = stillfail.filter(x => OWN_BRAND.test(x.title));
  const retry = stillfail.filter(x => !OWN_BRAND.test(x.title));
  writeFileSync("_ownbrand_park.json", JSON.stringify(own, null, 2));
  console.log(`stillfail ${stillfail.length}: parking ${own.length} own-brand, retrying ${retry.length}`);

  const STAMP = "retry50";
  const key = (t: string) => String(t || "").toLowerCase().replace(/\bpack of \d+\b/g, "").replace(/\b\d+\s*-?\s*(pack|pk|ct|count)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map<string, any[]>();
  for (const it of retry) { const k = key(it.title); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(it); }
  const glist = [...groups.values()];
  console.log(`retry unique products: ${glist.length}`);

  const newFixed: any[] = []; const stillNo: any[] = [];
  let done = 0;
  const processGroup = async (members: any[]) => {
    const title = members[0].title;
    // up to 3 attempts to find a donor (guards transient vision errors in the gate)
    let donor: any = null;
    for (let a = 0; a < 3 && !donor; a++) {
      try { donor = await resolveDonorPhoto(title); } catch {}
      if (!donor && a < 2) await sleep(2000 * (a + 1));
    }
    for (const m of members) {
      const pack = Number(m.pack) || 0; let newUrl: string | null = null; let v: any = null;
      if (donor && pack >= 2) {
        for (let a = 0; a < 3 && !newUrl; a++) {
          try {
            const base = await fetchImageBuffer(highResImageUrl(donor.url));
            const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(m.sku, "main", STAMP));
            v = await vision.qualifyTiledMain(tile, title, pack);
            if (v.pass) { newUrl = tile; break; }
            if (!/error/i.test(v.reason)) break; // real reject → stop retrying
          } catch { /* transient */ }
          if (a < 2) await sleep(2000 * (a + 1));
        }
      }
      if (newUrl) newFixed.push({ sku: m.sku, pack, title, oldUrl: m.oldUrl, newUrl, src: donor.src, v });
      else stillNo.push({ sku: m.sku, pack, title, oldUrl: m.oldUrl, reason: donor ? (v?.reason || "reject") : "no donor" });
    }
    done += members.length;
    console.log(`  retry ${done}/${retry.length} · recovered ${newFixed.length} · [${title.slice(0,38)} → ${donor ? donor.src : "NO DONOR"}]`);
  };
  for (let i = 0; i < glist.length; i += CONC) await Promise.all(glist.slice(i, i + CONC).map(processGroup));

  // Combined = big-run fixes + retry recoveries.
  const allFixed = [...alreadyFixed, ...newFixed.map(r => ({ sku: r.sku, newUrl: r.newUrl, pack: r.pack, src: r.src }))];
  writeFileSync("_backlog_final_fixed.json", JSON.stringify(allFixed, null, 2));
  writeFileSync("_backlog_final_nodonor.json", JSON.stringify(stillNo, null, 2));

  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const cell = (label: string, url: string, color: string) => `<div><div style="color:${color};font-size:11px">${label}</div>${url ? `<img src="${esc(url)}" style="width:210px;height:210px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:210px;height:210px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">нет</div>`}</div>`;
  const card = (r: any, ok: boolean) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;margin:8px 0;background:#0f1115"><div style="color:${ok ? "#22c55e" : "#ef4444"};font-weight:700">${esc(r.sku)} · pack ${r.pack} · ${ok ? "ИСПРАВЛЕНО (" + esc(r.src) + ")" : esc(r.reason || "нет донора")}</div><div style="color:#9ca3af;margin:2px 0 5px">${esc(r.title)}</div><div style="display:flex;gap:12px">${cell("БЫЛО", r.oldUrl, "#ef4444")}${cell("СТАЛО", r.newUrl || "", "#22c55e")}</div></div>`;
  const html = `<!doctype html><meta charset=utf8><title>Backlog retry</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Перегон промахов — итог</h1><div style="color:#9ca3af">Всего восстановлено этим перегоном: <b style="color:#22c55e">${newFixed.length}</b>. Осталось без донора: <b style="color:#f59e0b">${stillNo.length}</b>. Own-brand в парковке: <b>${own.length}</b> (твои оригиналы). Итого исправлено по бэклогу: <b style="color:#22c55e">${allFixed.length}</b>.</div><h2 style="color:#22c55e">Восстановлено (${newFixed.length})</h2>${newFixed.map(r => card(r, true)).join("")}<h2 style="color:#f59e0b">Реально без донора (${stillNo.length})</h2>${stillNo.map(r => card(r, false)).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/backlog-retry.html`, "text/html");
  console.log(`\nRETRY recovered ${newFixed.length} · still no-donor ${stillNo.length} · own-brand parked ${own.length}`);
  console.log(`TOTAL backlog fixed: ${allFixed.length}`);
  console.log(`GALLERY: ${gu}`);
}
main().catch(e => { console.error(e); process.exit(1); });
