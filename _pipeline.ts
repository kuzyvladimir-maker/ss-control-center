// THE canonical pipeline — exactly the dictated algorithm, no heuristics, no revert.
// For each multipack listing (packCount authoritative):
//   0. Qual-officer checks the CURRENT LIVE image (only when our feed is item-level
//      LIVE — for SAFE/UNKNOWN rows the live image is the old pre-fix one, so rebuild).
//      Pass → ALREADY_OK, do not touch.
//   1. Else identify the exact product from the title (bundles → BUNDLE pile).
//   2. Resolve a verified single unit of that EXACT variant.
//   3. Tile it ×packCount.
//   4. Qual-officer re-checks the rebuild. Pass → REBUILT_OK. Else NEEDS_WORK piles.
// Never "revert to one". A Pack-of-N always shows N units of the right product.
//
// Hardened for the full 743 run:
//   • title: catalog → Walmart getItem (closes the blank-title class) → SKIP
//   • packCount: remediation row → "(Pack of N)" in Walmart title → titlePackCount
//   • checkpoint/resume: _pipeline_state.json (skip done SKUs; crash-safe)
//   • PIPE_ALL=1 → all SKUs from _final_audit.json; else PIPE_SKUS='["…"]'
import { readFileSync, writeFileSync, existsSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";
// PIPE_NO_BROWSER=1 — hard kill-switch for the browser-store donor tier (Publix/BJ's/
// Aldi). Must run AFTER the .env loader above (which overwrites shell env), because
// 2026-07-07 the bulk run's ~250 browser hits tripped BJ's Akamai antibot on the
// owner's own Chrome. The browser tier is for the slow manual tail ONLY, never bulk.
if (process.env.PIPE_NO_BROWSER === "1") { delete process.env.OPENCLAW_GROCERY_URL; delete process.env.OPENCLAW_GROCERY_TOKEN; }
const CONC = 3;
const STATE_FILE = "_pipeline_state.json";
// On resume, treat NEEDS_DONOR/BUNDLE as settled too (PIPE_SKIP_SETTLED=1): NEEDS_DONOR
// exhausted every API tier — re-running it just burns slow Oxylabs/Unwrangle calls and
// stays NEEDS_DONOR (it needs the separate browser tail pass). Lets a resume finish the
// truly-new SKUs fast instead of re-grinding the hopeless ones.
const DONE = new Set(["ALREADY_OK", "REBUILT_OK", "PUBLISHED", "BUNDLE",
  ...(process.env.PIPE_SKIP_SETTLED === "1" ? ["NEEDS_DONOR", "REBUILT_FAIL"] : [])]);
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { identifyProduct } = await import("./src/lib/sourcing/identify.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const wm = getWalmartClient(1);

  const final = JSON.parse(readFileSync("_final_audit.json", "utf8"));
  const auditBySku: Record<string, any> = {}; for (const x of final) auditBySku[x.sku] = x;
  let liveState: Record<string, string> = {};
  try { liveState = JSON.parse(readFileSync("_feedtruth_all.json", "utf8")); } catch { }
  const state: Record<string, any> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const SKUS: string[] = process.env.PIPE_ALL === "1"
    ? final.map((x: any) => x.sku)
    : JSON.parse(process.env.PIPE_SKUS || "[]");
  const todo = SKUS.filter((s) => !DONE.has(state[s]?.status));
  console.log(`pipeline: ${SKUS.length} total, ${SKUS.length - todo.length} already done, ${todo.length} to process (conc=${CONC})\n`);

  const qual = async (url: string, title: string, pack: number) => {
    let v: any = null;
    for (let a = 0; a < 3; a++) { v = await vision.qualifyTiledMain(url, title, pack); if (!/error/i.test(v.reason)) break; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
    return v;
  };
  const getItemTitle = async (sku: string): Promise<string> => {
    try {
      const it: any = ((await wm.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body as any)?.ItemResponse?.[0];
      return String(it?.productName || it?.title || "").trim();
    } catch { return ""; }
  };

  let done = 0;
  const run = async (sku: string) => {
    const out: any = { sku };
    try {
      const cat = (await db.execute({ sql: "SELECT title, titlePackCount FROM WalmartCatalogItem WHERE sku=? LIMIT 1", args: [sku] })).rows[0] as any;
      const rem = (await db.execute({ sql: "SELECT packCount, mainImageUrl FROM WalmartListingRemediation WHERE sku=? AND feedId IS NOT NULL ORDER BY runAt DESC LIMIT 1", args: [sku] })).rows[0] as any;
      // title: catalog → Walmart getItem → skip
      let title = String(cat?.title || "").replace(/\s*—.*$/, "").trim();
      if (!title) { title = (await getItemTitle(sku)).replace(/\s*—.*$/, "").trim(); out.titleSrc = title ? "getItem" : "none"; }
      // packCount: remediation → "(Pack of N)" in the Walmart title → titlePackCount
      let pack = Number(rem?.packCount) || 0;
      if (!pack) { const m = title.match(/\(pack of\s*(\d+)\)/i); if (m) pack = Number(m[1]); }
      if (!pack) pack = Number(cat?.titlePackCount) || 0;
      const liveUrl = auditBySku[sku]?.url || rem?.mainImageUrl || "";
      Object.assign(out, { title, pack, liveUrl, live: liveState[sku] || "UNKNOWN" });
      if (!title || pack < 2) { out.status = "SKIP"; out.why = !title ? "no title anywhere" : "no packCount"; return; }
      // 0 — current image already correct? (only meaningful if our image is item-level LIVE)
      if (out.live === "LIVE" && liveUrl) {
        const v0 = await qual(liveUrl, title, pack);
        if (v0.pass) { out.status = "ALREADY_OK"; return; }
        out.liveFail = v0.reason;
      } else { out.liveFail = "our feed never ingested — old image still live"; }
      // 1 — identify exact product
      let id: any = null; try { id = await identifyProduct({ title }); } catch { }
      out.baseUnit = id?.base_unit || title;
      if (id?.is_bundle) { out.status = "BUNDLE"; out.components = id?.components?.length || 0; return; }
      // 2 — verified single-unit donor of that variant
      let donor: any = null;
      for (let a = 0; a < 2 && !donor; a++) { try { donor = await resolveDonorPhoto(title, { searchQuery: id?.retail_search_query, identityTitle: id?.base_unit || title }); } catch { } }
      if (!donor) { out.status = "NEEDS_DONOR"; return; }
      out.donorSrc = donor.src;
      // 3 — tile ×packCount ; 4 — qual-officer
      const base = await fetchImageBuffer(highResImageUrl(donor.url));
      const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(sku, "main", "pipeline"));
      out.newUrl = tile;
      const v1 = await qual(tile, id?.base_unit || title, pack);
      out.newReason = v1.reason;
      out.status = v1.pass ? "REBUILT_OK" : "REBUILT_FAIL";
    } catch (e: any) {
      out.status = "ERR"; out.why = String(e?.message || e).slice(0, 100);
    } finally {
      state[sku] = out; save(); done++;
      console.log(`  [${done}/${todo.length}] ${sku} Pack of ${out.pack ?? "?"} → ${out.status}${out.donorSrc ? " (" + out.donorSrc + ")" : ""}${DONE.has(out.status) ? "" : "  " + String(out.why || out.liveFail || "").slice(0, 60)}`);
    }
  };
  for (let i = 0; i < todo.length; i += CONC) await Promise.all(todo.slice(i, i + CONC).map(run));

  // summary + gallery over the WHOLE state (incl. previously done)
  const all = SKUS.map((s) => state[s]).filter(Boolean);
  const by: Record<string, number> = {}; for (const r of all) by[r.status] = (by[r.status] || 0) + 1;
  console.log("\n=== RESULT ===", JSON.stringify(by));
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const tag: Record<string, string> = { ALREADY_OK: '<span style="color:#22c55e">УЖЕ ОК — не трогаем</span>', PUBLISHED: '<span style="color:#22c55e">ОПУБЛИКОВАНО</span>', REBUILT_OK: '<span style="color:#22c55e">ПЕРЕСОБРАНО ✓ (к публикации)</span>', REBUILT_FAIL: '<span style="color:#f59e0b">пересобрал — гейт не пропустил</span>', NEEDS_DONOR: '<span style="color:#f59e0b">нет чистого донора</span>', BUNDLE: '<span style="color:#a78bfa">бандл — отдельная обработка</span>', ERR: '<span style="color:#ef4444">ошибка</span>', SKIP: '<span style="color:#64748b">пропуск</span>' };
  const cell = (l: string, u: string, c: string) => `<div><div style="color:${c};font-size:11px;font-weight:700">${l}</div>${u ? `<img loading="lazy" src="${esc(u)}" style="width:230px;height:230px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:230px;height:230px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">—</div>`}</div>`;
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:12px;margin:10px 0;background:#0f1115">
    <div style="color:#fff;font-weight:700">${esc(r.sku)} · Pack of ${r.pack} · ${tag[r.status] || r.status}</div>
    <div style="color:#cbd5e1;font-size:12px;margin:2px 0 6px">${esc(r.title || "")}</div>
    <div style="display:flex;gap:14px">${cell(r.live === "LIVE" ? "СЕЙЧАС на Walmart" : "наш фид не встал (на Walmart старая)", r.liveUrl, r.status === "ALREADY_OK" ? "#22c55e" : "#ef4444")}${r.newUrl ? cell("ПЕРЕСОБРАНО", r.newUrl, "#22c55e") : ""}</div>
    ${r.liveFail && r.status !== "ALREADY_OK" ? `<div style="color:#9ca3af;font-size:12px;margin-top:6px"><i>${esc(String(r.liveFail).slice(0, 130))}</i></div>` : ""}</div>`;
  const order = ["REBUILT_OK", "REBUILT_FAIL", "NEEDS_DONOR", "BUNDLE", "ERR", "SKIP", "ALREADY_OK", "PUBLISHED"];
  const html = `<!doctype html><meta charset=utf8><title>Полный прогон — все листинги</title>
  <body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px;color:#e5e7eb">
  <h1 style="color:#fff">Полный прогон: ${all.length} листингов</h1>
  <div style="color:#9ca3af;margin-bottom:12px">${order.map((s) => by[s] ? `${s}: <b>${by[s]}</b>` : "").filter(Boolean).join(" · ")}. Пересобранное НЕ опубликовано — ждёт твоего ОК.</div>
  ${order.flatMap((s) => all.filter((r) => r.status === s)).map(card).join("")}</body>`;
  console.log("GALLERY:", await uploadToR2(Buffer.from(html), `walmart-review/full-run.html`, "text/html"));
}
main().catch((e) => { console.error(e); process.exit(1); });
