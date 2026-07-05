// Rebuild the 37 fresh-50 mains that FAILED the new qualification agent (wrong
// product / wrong variant) using the NEW engine: resolveDonorPhoto (Walmart 1P →
// Google Images → Sam's/Target, single-unit + identity gated) + qualifyTiledMain.
// Canonical donor per product. Codex ($0). Before/after gallery. NO Walmart writes.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "codex";
const FAILS = ["FaisalX-1269","FaisalX-1267","FaisalX-1264","FaisalX-1258","FaisalX-1257","FaisalX-1248","FaisalX-1243","FaisalX-1242","FaisalX-1236","FaisalX-1231","FaisalX-1227","FaisalX-1215","FaisalX-1210","FaisalX-1209","FaisalX-1204","FaisalX-1198","FaisalX-1192","FaisalX-1191","FaisalX-1182","FaisalX-1180","FaisalX-1179","FaisalX-1176","FaisalX-1171","FaisalX-1162","FaisalX-1159","FaisalX-1158","FaisalX-1156","FaisalX-1148","FaisalX-1144","FaisalX-1140","FaisalX-1138","FaisalX-1134","FaisalX-1132","FaisalX-1131","FaisalX-1122","FaisalX-1114","Extra-01"];
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const STAMP = "fix50";
  // pull each failed SKU's built title + pack + OLD wrong main
  const rows = (await db.execute({ sql: `SELECT sku, packCount, mainImageUrl, newTitle, runAt FROM WalmartListingRemediation WHERE sku IN (${FAILS.map(() => "?").join(",")}) AND mainImageUrl LIKE '%f50%' ORDER BY runAt DESC`, args: FAILS })).rows as any[];
  const latest = new Map<string, any>();
  for (const r of rows) if (!latest.has(r.sku)) latest.set(r.sku, r);
  const items = FAILS.map(sku => latest.get(sku)).filter(Boolean).map((r: any) => ({
    sku: r.sku, pack: Number(r.packCount) || 0, oldUrl: r.mainImageUrl,
    title: String(r.newTitle || "").replace(/\s*—.*$/, "").trim(),
  }));
  console.log(`rebuilding ${items.length} failed mains (Codex, free)`);
  // canonical group by product identity
  const key = (t: string) => t.toLowerCase().replace(/\bpack of \d+\b/g, "").replace(/\b\d+\s*-?\s*(pack|pk|ct|count)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map<string, typeof items>();
  for (const it of items) { const k = key(it.title); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(it); }
  console.log(`unique products: ${groups.size}`);

  const out: any[] = [];
  let gi = 0;
  for (const members of groups.values()) {
    gi++;
    const title = members[0].title;
    const donor = await resolveDonorPhoto(title);
    console.log(`[grp ${gi}/${groups.size}] ${title.slice(0,45)} → ${donor ? donor.src : "NO DONOR"}`);
    for (const m of members) {
      let newUrl: string | null = null; let v: any = null;
      if (donor) {
        try {
          const base = await fetchImageBuffer(highResImageUrl(donor.url));
          const tile = await uploadToR2(await composeTiledMainImage(base, m.pack), multipackImageKey(m.sku, "main", STAMP));
          v = await vision.qualifyTiledMain(tile, title, m.pack);
          if (v.pass) newUrl = tile;
        } catch (e: any) { v = { reason: "err " + e?.message }; }
      }
      out.push({ ...m, newUrl, src: donor?.src || "—", v });
      console.log(`    ${m.sku} pack${m.pack} ${newUrl ? "✅ FIXED" : "❌ still no"} ${v ? `[id${+v.identity} cell${+v.eachCellSingle}] ${String(v.reason).slice(0,50)}` : ""}`);
    }
  }
  const fixed = out.filter(r => r.newUrl);
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const cell = (label: string, url: string, color: string) => `<div><div style="color:${color};font-size:11px">${label}</div>${url ? `<img src="${esc(url)}" style="width:250px;height:250px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:250px;height:250px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">нет</div>`}</div>`;
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:12px;margin:10px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} · <span style="color:${r.newUrl ? "#22c55e" : "#ef4444"}">${r.newUrl ? "ИСПРАВЛЕНО (" + esc(r.src) + ")" : "не нашли донора"}</span></div><div style="color:#9ca3af;margin:3px 0 6px">${esc(r.title)}${r.v ? ` — <i>${esc(String(r.v.reason).slice(0,80))}</i>` : ""}</div><div style="display:flex;gap:14px">${cell("БЫЛО (чужой товар)", r.oldUrl, "#ef4444")}${cell("СТАЛО (новый движок)", r.newUrl, "#22c55e")}</div></div>`;
  const html = `<!doctype html><meta charset=utf8><title>Fix 37</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Fresh-50: пересборка 37 кривых новым движком</h1><div style="color:#9ca3af">Исправлено: <b style="color:#22c55e">${fixed.length}</b>/${out.length}. Codex, $0. В Walmart НЕ отправлено.</div>${out.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/fix37.html`, "text/html");
  console.log(`\nFIXED: ${fixed.length}/${out.length}`);
  console.log(`GALLERY: ${gu}`);
  console.log("still-failing:"); for (const r of out.filter(r => !r.newUrl)) console.log(`  ${r.sku} :: ${r.title.slice(0,45)}`);
  // persist the new mains so a submit step can pick them up without recompute
  const { writeFileSync } = await import("node:fs");
  writeFileSync("_fix37_result.json", JSON.stringify(fixed.map(r => ({ sku: r.sku, newUrl: r.newUrl, pack: r.pack, src: r.src })), null, 2));
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
