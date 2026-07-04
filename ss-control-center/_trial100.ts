// TRIAL: image waterfall on 100 fresh, DIVERSE multipack listings (not the f50).
// Waterfall per product (stop at first identity+verify pass):
//   T1 Oxylabs Walmart 1P  →  T2 Google Images (real, broad)  →  T3 Sam's/Target.
// Canonical donor per product; tile @2200; verify. Gallery + coverage. No writes.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { oxylabsWalmartSearch } = await import("./src/lib/sourcing/oxylabs-fetch.ts");
  const { unwrangleSearch } = await import("./src/lib/sourcing/retail-fetch.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const STAMP = "trial100";
  const oxUser = (process.env.OXYLABS_USERNAME || "").replace(/^['"]|['"]$/g, ""); const oxPass = (process.env.OXYLABS_PASSWORD || "").replace(/^['"]|['"]$/g, "");
  const auth = Buffer.from(`${oxUser}:${oxPass}`).toString("base64");
  async function googleImages(q: string): Promise<string[]> { const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000); try { const r = await fetch("https://realtime.oxylabs.io/v1/queries", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` }, body: JSON.stringify({ source: "google_search", query: q, parse: true, context: [{ key: "tbm", value: "isch" }] }), signal: c.signal }); const j: any = await r.json(); const str = JSON.stringify(j?.results?.[0]?.content || {}); const imgs = [...str.matchAll(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/g)].map(m => m[1]).filter(x => !/gstatic|googleusercontent|\.gif|logo|sprite/.test(x)); return [...new Set(imgs.map(x => x.split("?")[0]))]; } finally { clearTimeout(t); } }
  const cleanQuery = (t: string) => String(t || "").replace(/^\s*\d+\s*x-?\s*/i, "").replace(/\(pack of \d+\)/ig, "").replace(/\b\d+\s*-?\s*pack\b/ig, "").replace(/,.*$/, "").replace(/\s{2,}/g, " ").trim();
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 3));
  const overlap = (a: string, b: string) => { const A = norm(a), B = norm(b); if (!A.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / A.size; };
  async function tileVerify(url: string, title: string, pack: number, sku: string): Promise<string | null> {
    try { const base = await fetchImageBuffer(highResImageUrl(url)); const tile = await uploadToR2(await composeTiledMainImage(base, pack), multipackImageKey(sku, "main", STAMP)); const v = await vision.verifyMainImage(tile, pack); return v.ok ? tile : null; } catch { return null; }
  }
  // WATERFALL — returns a verified donor URL (single unit) + source label, or null.
  async function resolveDonor(title: string): Promise<{ url: string; src: string } | null> {
    const q = cleanQuery(title);
    // T1: Walmart 1P (structured)
    try { const { offers } = await oxylabsWalmartSearch(q); const c = offers.filter(o => o.isMarketplaceItem !== true && o.imageUrls[0]).map(o => ({ u: o.imageUrls[0], s: overlap(title, o.title || "") })).sort((a, b) => b.s - a.s); if (c[0] && c[0].s >= 0.55 && (await vision.frontMatchesListing(highResImageUrl(c[0].u), title)).match) return { url: c[0].u, src: "Walmart 1P" }; } catch {}
    // T2: Google Images (broad real catch-all)
    try { const imgs = (await googleImages(q + " package")).slice(0, 14); const best = (await vision.pickBestFront(imgs, { listingTitle: title }))?.url || await vision.pickBestFrontFromPool(imgs, title); if (best && (await vision.frontMatchesListing(highResImageUrl(best), title)).match) return { url: best, src: "Google Images" }; } catch {}
    // T3: Sam's / Target
    for (const ret of ["samsclub", "target"] as const) { try { const r = await unwrangleSearch(ret, q); const c = r.offers.filter(o => o.imageUrls[0]).map(o => ({ u: o.imageUrls[0], s: overlap(title, o.title || "") })).sort((a, b) => b.s - a.s); if (c[0] && c[0].s >= 0.5 && (await vision.frontMatchesListing(highResImageUrl(c[0].u), title)).match) return { url: c[0].u, src: ret }; } catch {} }
    return null;
  }

  const rows = (await db.execute(`SELECT q.sku, q.productName, q.titlePackCount, c.mainImageUrl before
    FROM WalmartListingQualityItem q LEFT JOIN WalmartCatalogItem c ON c.sku=q.sku AND c.storeIndex=1
    WHERE q.storeIndex=1 AND q.titlePackCount>=2 AND q.productName IS NOT NULL
      AND q.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1)
    ORDER BY q.gmv30d DESC LIMIT 100`)).rows as any[];
  console.log(`trial listings: ${rows.length}`);
  // group by product identity
  const key = (t: string) => cleanQuery(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map<string, any[]>();
  for (const r of rows) { const k = key(r.productName); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  console.log(`unique products: ${groups.size}`);

  const out: any[] = [];
  const glist = [...groups.values()];
  const CONC = 4;
  for (let i = 0; i < glist.length; i += CONC) {
    const chunk = await Promise.all(glist.slice(i, i + CONC).map(async (members) => {
      const title = String(members[0].productName);
      const donor = await resolveDonor(title);
      const res: any[] = [];
      for (const m of members) { const pack = Number(m.titlePackCount) || 0; let after: string | null = null; if (donor) after = await tileVerify(donor.url, title, pack, m.sku); res.push({ sku: m.sku, title, pack, before: m.before || "", after, src: donor?.src || "—" }); }
      return res;
    }));
    for (const gr of chunk) out.push(...gr);
    console.log(`groups ${Math.min(i + CONC, glist.length)}/${glist.length} | done=${out.filter(r => r.after).length}/${out.length}`);
  }

  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const card = (r: any) => `<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} <span style="color:${r.after ? "#22c55e" : "#f59e0b"}">${r.after ? "[" + esc(r.src) + "]" : "нет фото"}</span></div><div style="color:#9ca3af;margin:4px 0 8px">${esc(r.title)}</div><div style="display:flex;gap:16px"><div><div style="color:#ef4444;font-size:12px">ТЕКУЩЕЕ</div>${r.before ? `<img src="${esc(r.before)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">—</div>`}</div><div><div style="color:#22c55e;font-size:12px">ПРЕДЛАГАЕМ</div>${r.after ? `<img src="${esc(r.after)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px;text-align:center;padding:8px">не нашли — на генерацию (Tier5)</div>`}</div></div></div>`;
  const ok = out.filter(r => r.after).length;
  const html = `<!doctype html><meta charset=utf8><title>ТРИАЛ 100</title><body style="background:#0b0d10;font-family:system-ui;max-width:1050px;margin:0 auto;padding:24px"><h1 style="color:#fff">Пробный прогон — 100 разных мультипаков</h1><div style="color:#9ca3af;margin-bottom:16px">Реальное фото найдено: <b style="color:#22c55e">${ok}</b>/${out.length}. В Walmart НЕ отправлено.</div>${out.map(card).join("")}</body>`;
  const gu = await uploadToR2(Buffer.from(html), `walmart-review/trial100.html`, "text/html");
  console.log(`\nCOVERAGE: ${ok}/${out.length}`);
  console.log(`GALLERY: ${gu}`);
  for (const r of out.filter(r => !r.after)) console.log(`  ✗ ${r.sku} :: ${r.title.slice(0, 50)}`);
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
