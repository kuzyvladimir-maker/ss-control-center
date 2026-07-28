// HONEST re-audit of ALL live listings we pushed to Walmart (feed sent). Runs the
// UPDATED, STRENGTHENED checks on each listing's built main image + a real-unit
// sanity check, and classifies the defect. NO Walmart writes. Free lanes,
// Claude-weighted. Output: full defect breakdown + gallery of the bad ones.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto"; // Claude-weighted free lanes
const CONC = 6;
// Real sellable-UNIT count from the title — distinguishes a genuine N-unit multipack
// ("Pack of 6", "6-Pack") from N PIECES inside ONE unit ("12 Ct", "12 Bagels",
// "1 Box", "Value Pack") which is NOT a multipack (the Thomas-bagels false positive).
function realUnits(title: string, dbPack: number): { units: number; basis: string } {
  const t = String(title || "").toLowerCase();
  const po = t.match(/pack of\s+(\d+)/) || t.match(/\b(\d+)\s*[-\s]?pack\b/) || t.match(/\b(\d+)\s*[-\s]?pk\b/);
  if (po) return { units: Number(po[1]), basis: "pack-of" };
  if (/\b1\s*box\b|value\s*pack|\bct\b|\bcount\b|\bbagels?\b|\bbars?\b|cookies|\btotal\s+\d+/.test(t)) return { units: 1, basis: "pieces-in-one-unit" };
  return { units: dbPack || 0, basis: "db-fallback" };
}
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { uploadToR2 } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  // latest built row per SKU that was actually SENT to Walmart (feedId not null)
  const rows = (await db.execute(`SELECT r.sku, r.packCount, r.mainImageUrl, r.newTitle, r.feedStatus
    FROM WalmartListingRemediation r
    JOIN (SELECT sku, MAX(runAt) ra FROM WalmartListingRemediation WHERE feedId IS NOT NULL GROUP BY sku) x
      ON r.sku=x.sku AND r.runAt=x.ra`)).rows as any[];
  console.log(`re-auditing ${rows.length} live listings (Claude-weighted, conc=${CONC})`);
  const title = (r: any) => String(r.newTitle || "").replace(/\s*—.*$/, "").trim();
  const audit = async (r: any) => {
    const t = title(r); const dbPack = Number(r.packCount) || 0;
    const ru = realUnits(t, dbPack);
    if (!r.mainImageUrl) return { r, t, ru, defect: "no-image", v: null };
    if (ru.units < 4) return { r, t, ru, defect: "not-multipack", v: null }; // shouldn't have been touched
    // strengthened qualification on the main we pushed, with retry inside ask()
    let v: any = null;
    for (let a = 0; a < 3; a++) { v = await vision.qualifyTiledMain(r.mainImageUrl, t, ru.units); if (!/error/i.test(v.reason)) break; await new Promise(res => setTimeout(res, 1500 * (a + 1))); }
    let defect = "OK";
    if (!v.identity) defect = "wrong-product";
    else if (!v.eachCellSingle) defect = "multipack-in-cell";
    else if (!v.countOk) defect = "wrong-count";
    else if (!v.front) defect = "not-face-on";
    else if (!v.whiteBg) defect = "colored-bg";
    else if (!v.pass) defect = "other-fail";
    return { r, t, ru, defect, v };
  };
  const out: any[] = []; let done = 0;
  for (let i = 0; i < rows.length; i += CONC) {
    const chunk = await Promise.all(rows.slice(i, i + CONC).map(audit));
    out.push(...chunk); done += chunk.length;
    if (done % 40 < CONC) console.log(`  ${done}/${rows.length} · OK ${out.filter(x => x.defect === "OK").length}`);
  }
  const byDefect: Record<string, number> = {};
  for (const x of out) byDefect[x.defect] = (byDefect[x.defect] || 0) + 1;
  writeFileSync("_reaudit686_result.json", JSON.stringify(out.map(x => ({ sku: x.r.sku, defect: x.defect, realUnits: x.ru.units, basis: x.ru.basis, dbPack: x.r.packCount, title: x.t, url: x.r.mainImageUrl, reason: x.v?.reason || "" })), null, 2));
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const bad = out.filter(x => x.defect !== "OK");
  const card = (x: any) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;margin:8px 0;background:#0f1115"><div style="color:#ef4444;font-weight:700">${esc(x.r.sku)} · dbPack ${x.r.packCount} · реально ${x.ru.units} (${esc(x.ru.basis)}) · <span style="color:#f59e0b">${esc(x.defect)}</span></div><div style="color:#9ca3af;margin:2px 0 5px">${esc(x.t)} — <i>${esc(String(x.v?.reason||"").slice(0,80))}</i></div>${x.r.mainImageUrl?`<img src="${esc(x.r.mainImageUrl)}" style="width:230px;height:230px;object-fit:contain;background:#fff;border-radius:6px">`:""}</div>`;
  const order = ["not-multipack","wrong-product","multipack-in-cell","wrong-count","not-face-on","colored-bg","no-image","other-fail"];
  const sections = order.filter(d=>byDefect[d]).map(d=>`<h2 style="color:#f59e0b">${d} (${byDefect[d]})</h2>${bad.filter(x=>x.defect===d).map(card).join("")}`).join("");
  const html = `<!doctype html><meta charset=utf8><title>Re-audit 686</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Честный пере-аудит живых листингов (${out.length})</h1><div style="color:#9ca3af">OK: <b style="color:#22c55e">${byDefect.OK||0}</b> · дефектных: <b style="color:#ef4444">${bad.length}</b>. Строгие гейты (реальные единицы + single-cell + identity + лицом + белый фон).</div>${sections}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/reaudit686.html`, "text/html");
  console.log(`\n=== RE-AUDIT RESULT (${out.length} live listings) ===`);
  for (const d of ["OK",...order]) if (byDefect[d]) console.log(`  ${d}: ${byDefect[d]}`);
  console.log(`GALLERY: ${gu}`);
}
main().catch(e => { console.error(e); process.exit(1); });
