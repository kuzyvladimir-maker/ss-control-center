// QA VALIDATION — prove the single-unit donor gate + per-listing qualification
// agent reject the multipack/caddy/case donors that slipped through before, while
// still passing genuine single-unit products. Targets the exact SKUs Vladimir
// flagged (Cheez-It Extra Cheesy, Gatorade, Mott's = were "passing" with a caddy/
// case) plus single-unit controls. No writes to Walmart.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

// SKUs to validate. flagged = should now be REJECTED (donor was a multipack) OR
// re-sourced to a real single unit; control = should still PASS honestly.
const FLAGGED = ["FaisalX-4485", "FaisalX-4497", "FaisalX-4486", "FaisalX-4499", "FaisalX-2230", "FaisalX-2226", "FaisalX-2208", "FaisalX-2207"];
const CONTROL = ["FaisalX-2034", "FaisalX-1267", "FaisalX-1269"];

async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { oxylabsWalmartSearch } = await import("./src/lib/sourcing/oxylabs-fetch.ts");
  const { unwrangleSearch } = await import("./src/lib/sourcing/retail-fetch.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const STAMP = "qaval";
  const oxUser = (process.env.OXYLABS_USERNAME || "").replace(/^['"]|['"]$/g, ""); const oxPass = (process.env.OXYLABS_PASSWORD || "").replace(/^['"]|['"]$/g, "");
  const auth = Buffer.from(`${oxUser}:${oxPass}`).toString("base64");
  async function googleImages(q: string): Promise<string[]> { const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000); try { const r = await fetch("https://realtime.oxylabs.io/v1/queries", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` }, body: JSON.stringify({ source: "google_search", query: q, parse: true, context: [{ key: "tbm", value: "isch" }] }), signal: c.signal }); const j: any = await r.json(); const str = JSON.stringify(j?.results?.[0]?.content || {}); const imgs = [...str.matchAll(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/g)].map(m => m[1]).filter(x => !/gstatic|googleusercontent|\.gif|logo|sprite/.test(x)); return [...new Set(imgs.map(x => x.split("?")[0]))]; } finally { clearTimeout(t); } }
  const cleanQuery = (t: string) => String(t || "").replace(/^\s*\d+\s*x-?\s*/i, "").replace(/\(pack of \d+\)/ig, "").replace(/\b\d+\s*-?\s*pack\b/ig, "").replace(/,.*$/, "").replace(/\s{2,}/g, " ").trim();
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 3));
  const overlap = (a: string, b: string) => { const A = norm(a), B = norm(b); if (!A.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / A.size; };

  // WATERFALL with the new single-unit donor gate. Every candidate, in every tier,
  // must pass qualifyDonorFront (brand+type+variant+singleUnit+front+whiteBg).
  const MAX_CAND = 4; // cap qualify calls per tier
  async function resolveDonor(title: string, log: string[]): Promise<{ url: string; src: string } | null> {
    const q = cleanQuery(title);
    const unit = vision.unitSizeFromTitle(title);
    const tryPool = async (imgs: string[], src: string): Promise<{ url: string; src: string } | null> => {
      for (const u of imgs.slice(0, MAX_CAND)) {
        const v = await vision.qualifyDonorFront(highResImageUrl(u), title, unit);
        const flags = `brand${+v.brand} type${+v.type} var${+v.variant} single${+v.singleUnit} front${+v.front} white${+v.whiteBg}`;
        log.push(`    ${src} cand ${v.pass ? "PASS" : "rej"} [${flags}] ${v.reason}`);
        if (v.pass) return { url: u, src };
      }
      return null;
    };
    // T1: Walmart 1P (structured) — candidates ranked by title overlap
    try { const { offers } = await oxylabsWalmartSearch(q); const imgs = offers.filter(o => o.isMarketplaceItem !== true && o.imageUrls[0]).map(o => ({ u: o.imageUrls[0], s: overlap(title, o.title || "") })).filter(o => o.s >= 0.45).sort((a, b) => b.s - a.s).map(o => o.u); log.push(`  T1 Walmart1P: ${imgs.length} cand`); const r = await tryPool(imgs, "Walmart 1P"); if (r) return r; } catch (e) { log.push(`  T1 err`); }
    // T2: Google Images (broad, real) — pick fronts, then gate each
    try { const raw = (await googleImages(q + " package")).slice(0, 14); const picks: string[] = []; const best = (await vision.pickBestFront(raw, { listingTitle: title }))?.url; if (best) picks.push(best); const pool = await vision.pickBestFrontFromPool(raw, title); if (pool && !picks.includes(pool)) picks.push(pool); log.push(`  T2 GoogleImages: ${raw.length} raw → ${picks.length} front-pick`); const r = await tryPool(picks, "Google Images"); if (r) return r; } catch (e) { log.push(`  T2 err`); }
    // T3: Sam's / Target
    for (const ret of ["samsclub", "target"] as const) { try { const rr = await unwrangleSearch(ret, q); const imgs = rr.offers.filter(o => o.imageUrls[0]).map(o => ({ u: o.imageUrls[0], s: overlap(title, o.title || "") })).filter(o => o.s >= 0.4).sort((a, b) => b.s - a.s).map(o => o.u); log.push(`  T3 ${ret}: ${imgs.length} cand`); const r = await tryPool(imgs, ret); if (r) return r; } catch (e) { log.push(`  T3 ${ret} err`); } }
    return null;
  }

  const skus = [...FLAGGED, ...CONTROL];
  const rows = (await db.execute({ sql: `SELECT q.sku, q.productName, q.titlePackCount, c.mainImageUrl before FROM WalmartListingQualityItem q LEFT JOIN WalmartCatalogItem c ON c.sku=q.sku AND c.storeIndex=1 WHERE q.storeIndex=1 AND q.sku IN (${skus.map(() => "?").join(",")})`, args: skus })).rows as any[];
  const bySku = new Map(rows.map(r => [String(r.sku), r]));

  const out: any[] = [];
  for (const sku of skus) {
    const r = bySku.get(sku); if (!r) { console.log(`\n${sku}: NOT FOUND in DB`); continue; }
    const title = String(r.productName); const pack = Number(r.titlePackCount) || 0;
    const log: string[] = [];
    console.log(`\n=== ${sku} · pack ${pack} · ${FLAGGED.includes(sku) ? "FLAGGED" : "control"}`);
    console.log(`    ${title}`);
    console.log(`    unit-size parsed: "${vision.unitSizeFromTitle(title)}"`);
    const donor = await resolveDonor(title, log);
    for (const l of log) console.log(l);
    let after: string | null = null; let tileV: any = null;
    if (donor) {
      try {
        const base = await fetchImageBuffer(highResImageUrl(donor.url));
        const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(sku, "main", STAMP));
        tileV = await vision.qualifyTiledMain(tile, title, pack);
        console.log(`    QUALIFY tile [id${+tileV.identity} cellSingle${+tileV.eachCellSingle} count${+tileV.countOk} front${+tileV.front} white${+tileV.whiteBg}] ${tileV.pass ? "✅ PASS" : "❌ FAIL"} — ${tileV.reason}`);
        if (tileV.pass) after = tile;
      } catch (e: any) { console.log(`    tile err ${e?.message}`); }
    }
    console.log(`    RESULT: ${after ? `✅ ${donor!.src}` : donor ? "❌ tile rejected by QA → generate/manual" : "✗ no single-unit donor found → generate/manual"}`);
    out.push({ sku, title, pack, before: r.before || "", after, src: donor?.src || "—", flagged: FLAGGED.includes(sku), tileV });
  }

  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} <span style="color:${r.flagged ? "#f59e0b" : "#60a5fa"}">${r.flagged ? "FLAGGED" : "control"}</span> <span style="color:${r.after ? "#22c55e" : "#ef4444"}">${r.after ? "[" + esc(r.src) + "]" : "нет годного донора → генерация"}</span></div><div style="color:#9ca3af;margin:4px 0 8px">${esc(r.title)}</div><div style="display:flex;gap:16px"><div><div style="color:#ef4444;font-size:12px">ТЕКУЩЕЕ</div>${r.before ? `<img src="${esc(r.before)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">—</div>`}</div><div><div style="color:#22c55e;font-size:12px">ПРЕДЛАГАЕМ</div>${r.after ? `<img src="${esc(r.after)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px;text-align:center;padding:8px">не нашли ЧИСТУЮ одиночную единицу — на генерацию</div>`}</div></div></div>`;
  const html = `<!doctype html><meta charset=utf8><title>QA validation</title><body style="background:#0b0d10;font-family:system-ui;max-width:1050px;margin:0 auto;padding:24px"><h1 style="color:#fff">QA: single-unit gate + qualification agent</h1><div style="color:#9ca3af;margin-bottom:16px">FLAGGED должны либо пересобраться на настоящую одиночную единицу, либо честно отклониться (донор был мультипак). Control должны пройти.</div>${out.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/qaval.html`, "text/html");
  console.log(`\n\nGALLERY: ${gu}`);
  console.log(`flagged passed-clean: ${out.filter(r => r.flagged && r.after).length}/${FLAGGED.length} · control passed: ${out.filter(r => !r.flagged && r.after).length}/${CONTROL.length}`);
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
