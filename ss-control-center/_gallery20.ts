// Contact-sheet of all 20 rows I wrongly labeled "not-multipack" — their CURRENT LIVE
// Walmart image + authoritative title + packCount, so Vladimir can eyeball ground
// truth. No gate verdict shown as truth (the gate has a bakery-tray quirk); instead a
// neutral note. This replaces my broken revert plan with a human-checkable view.
import { readFileSync } from "node:fs";
async function main() {
  for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
  const { createClient } = await import("@libsql/client");
  const { uploadToR2 } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const f = JSON.parse(readFileSync("_final_audit.json", "utf8"));
  const recheck = JSON.parse(readFileSync("_recheck_notmp_result.json", "utf8"));
  const rc: Record<string, any> = {}; for (const r of recheck) rc[r.sku] = r;
  const nm = f.filter((x: any) => x.defect === "not-multipack");
  const rows: any[] = [];
  for (const x of nm) {
    const c = (await db.execute({ sql: "SELECT title FROM WalmartCatalogItem WHERE sku=? LIMIT 1", args: [x.sku] })).rows[0] as any;
    const rem = (await db.execute({ sql: "SELECT packCount FROM WalmartListingRemediation WHERE sku=? AND feedId IS NOT NULL ORDER BY runAt DESC LIMIT 1", args: [x.sku] })).rows[0] as any;
    rows.push({ sku: x.sku, url: x.url, title: c?.title || x.title || "", pack: Number(rem?.packCount) || 0, gate: rc[x.sku]?.now || "?" });
  }
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]!));
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;background:#0f1115;width:300px">
    <div style="color:#fff;font-weight:700">${esc(r.sku)} · Pack of ${r.pack}</div>
    <div style="color:#cbd5e1;font-size:12px;height:46px;overflow:hidden;margin:3px 0">${esc(r.title.slice(0, 100))}</div>
    ${r.url ? `<img src="${esc(r.url)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : "нет"}
    <div style="color:#64748b;font-size:11px;margin-top:4px">гейт сказал: ${esc(r.gate)} <span style="color:#475569">(на выпечке гейт ошибается)</span></div></div>`;
  const html = `<!doctype html><meta charset=utf8><title>20 listings — ground truth</title>
  <body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px;color:#e5e7eb">
  <h1 style="color:#fff">20 листингов, которые я ошибочно пометил «не-мультипак»</h1>
  <div style="color:#9ca3af;margin-bottom:14px">Это их ЖИВЫЕ картинки на Walmart сейчас (packCount — сколько единиц должно быть). Смотри сам: где показан ПРАВИЛЬНЫЙ товар в правильном числе — оставляем как есть; где ДРУГОЙ товар (Oreo вместо Lance, Soft White Hamburger вместо Sweet Hawaiian) — пересобираем правильным. Реверт-на-одну отменён.</div>
  <div style="display:flex;flex-wrap:wrap;gap:12px">${rows.map(card).join("")}</div></body>`;
  console.log("GALLERY:", await uploadToR2(Buffer.from(html), `walmart-review/notmp-20.html`, "text/html"));
}
main().catch(e => { console.error(e); process.exit(1); });
