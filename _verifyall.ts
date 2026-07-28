// FINALIZE step 1 — audit the ENTIRE touched backlog (~740 SKUs): run the
// qualification agent (qualifyTiledMain) over each listing's latest built main.
// Paid Sonnet, parallel (fast one-time audit) — free Codex would be ~4h serial.
// Retries on transient errors so a rate-limit blip never mis-marks a good listing.
// NO Walmart writes. Saves fails to _verifyall_fails.json + a gallery.
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "anthropic"; // paid, parallelizable, fast
const CONC = 6;
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { uploadToR2 } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const rows = (await db.execute(`SELECT r.sku, r.packCount, r.mainImageUrl, r.newTitle, r.feedStatus
    FROM WalmartListingRemediation r
    JOIN (SELECT sku, MAX(runAt) ra FROM WalmartListingRemediation GROUP BY sku) x ON r.sku=x.sku AND r.runAt=x.ra
    WHERE r.mainImageUrl IS NOT NULL AND r.mainImageUrl!=''`)).rows as any[];
  console.log(`auditing ${rows.length} listings (Sonnet, conc=${CONC})`);
  const title = (r: any) => String(r.newTitle || "").replace(/\s*—.*$/, "").trim();
  const verify = async (r: any) => {
    const t = title(r); const pack = Number(r.packCount) || 0;
    if (pack < 2) return { r, v: { pass: false, reason: "no pack" } };
    for (let a = 0; a < 3; a++) {
      const v = await vision.qualifyTiledMain(r.mainImageUrl, t, pack);
      if (!/error/i.test(v.reason)) return { r, v };
      await new Promise(res => setTimeout(res, 1500 * (a + 1))); // backoff on transient
    }
    return { r, v: { pass: false, reason: "verify error x3" } };
  };
  const out: any[] = [];
  let done = 0;
  for (let i = 0; i < rows.length; i += CONC) {
    const chunk = await Promise.all(rows.slice(i, i + CONC).map(verify));
    out.push(...chunk);
    done += chunk.length;
    if (done % 60 < CONC) console.log(`  ${done}/${rows.length} · pass so far ${out.filter(x => x.v.pass).length}`);
  }
  const pass = out.filter(x => x.v.pass);
  const fail = out.filter(x => !x.v.pass);
  writeFileSync("_verifyall_fails.json", JSON.stringify(fail.map(x => ({ sku: x.r.sku, pack: Number(x.r.packCount) || 0, title: title(x.r), oldUrl: x.r.mainImageUrl, feed: x.r.feedStatus, reason: x.v.reason })), null, 2));
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const card = (x: any) => `<div style="border:1px solid #333;border-radius:10px;padding:10px;margin:8px 0;background:#0f1115"><div style="color:#ef4444;font-weight:700">${esc(x.r.sku)} · pack ${x.r.packCount} · ${esc(x.r.feedStatus)} [id${+x.v.identity} cell${+x.v.eachCellSingle} cnt${+x.v.countOk}]</div><div style="color:#9ca3af;margin:2px 0 5px">${esc(title(x.r))} — <i>${esc(String(x.v.reason).slice(0,90))}</i></div><img src="${esc(x.r.mainImageUrl)}" style="width:220px;height:220px;object-fit:contain;background:#fff;border-radius:6px"></div>`;
  const html = `<!doctype html><meta charset=utf8><title>Backlog audit</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Аудит всего бэклога (${out.length})</h1><div style="color:#9ca3af">OK: <b style="color:#22c55e">${pass.length}</b> · требует пересборки: <b style="color:#ef4444">${fail.length}</b>. Sonnet. В Walmart не отправлено.</div><h2 style="color:#ef4444">Требуют пересборки (${fail.length})</h2>${fail.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/backlog-audit.html`, "text/html");
  console.log(`\nAUDIT: ${pass.length}/${out.length} pass · ${fail.length} need rebuild`);
  console.log(`GALLERY: ${gu}`);
  console.log(`fails saved: _verifyall_fails.json`);
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
