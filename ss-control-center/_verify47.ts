// Verify the 47 fresh-50 BUILT main images against the NEW single-unit qualification
// agent (qualifyTiledMain) — these were built BEFORE the single-unit gate existed,
// so re-check each before trusting "under ключ". Codex ($0). NO Walmart writes.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "codex"; // force the free path
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { uploadToR2 } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  // latest built main per fresh-50 SKU
  const rows = (await db.execute(`SELECT sku, packCount, mainImageUrl, newTitle, feedStatus, runAt FROM WalmartListingRemediation WHERE mainImageUrl LIKE '%f50%' ORDER BY runAt DESC`)).rows as any[];
  const latest = new Map<string, any>();
  for (const r of rows) if (!latest.has(r.sku)) latest.set(r.sku, r);
  const set = [...latest.values()];
  console.log(`verifying ${set.length} fresh-50 built mains (Codex, free)`);
  const out: any[] = [];
  let i = 0;
  for (const r of set) {
    i++;
    const title = String(r.newTitle || "").replace(/\s*—.*$/, "").trim();
    const pack = Number(r.packCount) || 0;
    let v: any = { pass: false, reason: "no pack/url" };
    if (r.mainImageUrl && pack >= 2) { try { v = await vision.qualifyTiledMain(r.mainImageUrl, title, pack); } catch (e: any) { v = { pass: false, reason: "err " + e?.message }; } }
    out.push({ sku: r.sku, pack, title, url: r.mainImageUrl, feed: r.feedStatus, v });
    console.log(`  [${i}/${set.length}] ${r.sku} pack${pack} ${v.pass ? "✅" : "❌"} [id${+v.identity} cell${+v.eachCellSingle} cnt${+v.countOk} f${+v.front} w${+v.whiteBg}] ${String(v.reason).slice(0, 70)}`);
  }
  const pass = out.filter(r => r.v.pass);
  const fail = out.filter(r => !r.v.pass);
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:12px;margin:10px 0;background:#0f1115"><div style="color:${r.v.pass ? "#22c55e" : "#ef4444"};font-weight:700">${esc(r.sku)} · pack ${r.pack} · ${r.v.pass ? "OK" : "FAIL"} [id${+r.v.identity} cell${+r.v.eachCellSingle} cnt${+r.v.countOk} f${+r.v.front} w${+r.v.whiteBg}]</div><div style="color:#9ca3af;margin:3px 0 6px">${esc(r.title)} — <i>${esc(String(r.v.reason).slice(0,90))}</i></div><img src="${esc(r.url)}" style="width:300px;height:300px;object-fit:contain;background:#fff;border-radius:6px"></div>`;
  const html = `<!doctype html><meta charset=utf8><title>Verify 47</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Fresh-50: проверка 47 мейнов новым агентом квалификации</h1><div style="color:#9ca3af">OK: <b style="color:#22c55e">${pass.length}</b> · FAIL: <b style="color:#ef4444">${fail.length}</b>. Codex, $0. В Walmart не отправлено.</div><h2 style="color:#ef4444">FAIL (${fail.length})</h2>${fail.map(card).join("")}<h2 style="color:#22c55e">OK (${pass.length})</h2>${pass.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/verify47.html`, "text/html");
  console.log(`\nRESULT: ${pass.length}/${out.length} pass · ${fail.length} fail`);
  console.log(`GALLERY: ${gu}`);
  if (fail.length) { console.log("FAILS:"); for (const r of fail) console.log(`  ${r.sku} pack${r.pack} :: ${r.title.slice(0,45)} :: ${String(r.v.reason).slice(0,60)}`); }
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
