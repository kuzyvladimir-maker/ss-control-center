// Re-run all fresh-50 through Movement #1 and QUALIFY vs the ideal spec — v2.
// Fixes from owner review:
//  (1) CANONICAL donor per product: SKUs that are the same product (differ only by
//      pack count) share ONE donor image (union their pools) → consistent photo.
//  (2) verifyMainImage: structural front-gate rejects back/side/nutrition-panel/lying.
//  (3) keep: if a SKU's CURRENT main is already a correct front, don't churn it.
// Image: cleaned query -> union pool (matched-first) -> identity -> (if none) deep
// enrich Oxylabs(1P Walmart)+Unwrangle -> tile @2200 -> verify. Text vs spec.
// Buckets ideal/partial/manual + 3 galleries. NO Walmart writes. Background.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { ensureDonorImage, titleMatchesListing } = await import("./src/lib/sourcing/enrich.ts");
  const { oxylabsWalmartSearch } = await import("./src/lib/sourcing/oxylabs-fetch.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const STAMP = "qual50-3";

  const rows = (await db.execute(`SELECT sku, newTitle, packCount, upc, mainImageUrl, bulletsCount, descriptionLength FROM WalmartListingRemediation WHERE mainImageUrl LIKE '%-f50%'`)).rows as any[];
  console.log(`rows: ${rows.length}`);

  const productName = (t: string) => String(t || "").replace(/\s*—.*$/, "").trim();
  const cleanQuery = (t: string) => productName(t).replace(/^\s*\d+\s*x-?\s*/i, "").replace(/\(pack of \d+\)/ig, "").replace(/\b\d+\s*-?\s*pack\b/ig, "").replace(/\s{2,}/g, " ").trim();
  // Product identity key — same product across different pack counts collapses to one key.
  const productKey = (t: string) => productName(t).toLowerCase()
    .replace(/^\s*\d+\s*x-?\s*/, "").replace(/\bpack of \d+\b/g, "")
    .replace(/\b\d+\s*-?\s*(pack|pk|ct|count)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

  async function poolFor(sku: string, title: string): Promise<string[]> {
    const r = (await db.execute({ sql: `SELECT imageUrls, title FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL`, args: [sku] })).rows as any[];
    const m: string[] = [], o: string[] = [];
    for (const row of r) { let a: any[] = []; try { a = JSON.parse((row as any).imageUrls || "[]"); } catch {} const b = titleMatchesListing(title, String((row as any).title || "")) ? m : o; for (const u of a) if (typeof u === "string" && u.startsWith("http")) b.push(u.split("?")[0]); }
    return [...m, ...o];
  }
  const dedup = (a: string[]) => { const s = new Set<string>(), o: string[] = []; for (const u of a) if (u && !s.has(u)) { s.add(u); o.push(u); } return o; };
  async function chooseDonor(pool: string[], title: string): Promise<string | null> {
    if (!pool.length) return null;
    const d = (await vision.pickBestFront(pool, { listingTitle: title }))?.url || await vision.pickBestFrontFromPool(pool, title);
    if (!d) return null;
    return (await vision.frontMatchesListing(highResImageUrl(d), title)).match ? d : null;
  }

  interface R { sku: string; title: string; pack: number; before: string; after: string | null; via: string; imgNote: string; textGaps: string[]; bucket: string; }
  function textGaps(row: any): string[] {
    const g: string[] = []; const tl = String(row.newTitle || "").length; const b = Number(row.bulletsCount) || 0; const d = Number(row.descriptionLength) || 0;
    if (!(tl > 0 && tl <= 150)) g.push(`title ${tl}зн (1-150)`);
    if (!(b >= 3 && b <= 10)) g.push(`bullets ${b} (3-10)`);
    if (!(d >= 700)) g.push(`описание ~${Math.round(d / 5)}сл (≥150)`);
    return g;
  }

  // group by product identity
  const groups = new Map<string, any[]>();
  for (const row of rows) { const k = productKey(row.newTitle); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(row); }
  console.log(`unique products: ${groups.size} (from ${rows.length} SKUs)`);

  const results: R[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const overlap = (a: string, b: string) => { const A = new Set(norm(a)), B = new Set(norm(b)); if (!A.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / A.size; };

  async function processGroup(members: any[]): Promise<R[]> {
    const gTitle = productName(members[0].newTitle);
    let canonical: string | null = null;
    let via = "oxylabs-1P";
    // TIER 1: Walmart's OWN product photo for the EXACT 1P title match (deterministic,
    // consistent) — not a noisy vision pick over a mixed pool.
    try {
      const { offers } = await oxylabsWalmartSearch(cleanQuery(members[0].newTitle));
      const cands = offers.filter((o) => o.isMarketplaceItem !== true && o.imageUrls[0])
        .map((o) => ({ url: o.imageUrls[0], s: overlap(gTitle, o.title || "") }))
        .sort((a, b) => b.s - a.s);
      if (cands[0] && cands[0].s >= 0.6 && (await vision.frontMatchesListing(highResImageUrl(cands[0].url), gTitle)).match) canonical = cands[0].url;
    } catch {}
    // TIER 2 fallback: choose from UNION of members' catalog pools; else deep-enrich + re-pool.
    if (!canonical) {
      let union = dedup((await Promise.all(members.map((m) => poolFor(m.sku, gTitle)))).flat());
      canonical = await chooseDonor(union, gTitle); via = "pool(group)";
      if (!canonical) {
        try { await ensureDonorImage(db, { sku: members[0].sku, upc: members[0].upc, title: cleanQuery(members[0].newTitle), deep: true }); } catch {}
        union = dedup((await Promise.all(members.map((m) => poolFor(m.sku, gTitle)))).flat());
        canonical = await chooseDonor(union, gTitle); via = "enrich(group)";
      }
    }
    // 2) per-member: canonical tile (verified) → else keep good current main → else manual
    const out: R[] = [];
    for (const row of members) {
      const r: R = { sku: row.sku, title: productName(row.newTitle), pack: Number(row.packCount) || 0, before: row.mainImageUrl || "", after: null, via, imgNote: "", textGaps: textGaps(row), bucket: "" };
      try {
        if (canonical) {
          const base = await fetchImageBuffer(highResImageUrl(canonical));
          const tileUrl = await uploadToR2(await composeTiledMainImage(base, r.pack), multipackImageKey(row.sku, "main", STAMP));
          const v = await vision.verifyMainImage(tileUrl, r.pack);
          if (v.ok) r.after = tileUrl; else r.imgNote = `тайл отклонён verify (${v.kind})`;
        }
        if (!r.after && r.before) { // keep already-correct current main
          const acc = await vision.mainImageAcceptable(r.before, r.pack);
          if (acc.good && (await vision.frontMatchesListing(r.before, r.title)).match) { r.after = r.before; r.via = "kept (уже верное)"; r.imgNote = ""; }
        }
        if (!r.after && !r.imgNote) r.imgNote = "нет верного фото ни в одном источнике";
      } catch (e: any) { r.imgNote = `err: ${String(e?.message || e).slice(0, 60)}`; }
      r.bucket = r.after && r.textGaps.length === 0 ? "ideal" : r.after ? "partial" : "manual";
      out.push(r);
    }
    return out;
  }

  const groupList = [...groups.values()];
  const CONC = 3;
  for (let i = 0; i < groupList.length; i += CONC) {
    const chunk = await Promise.all(groupList.slice(i, i + CONC).map(processGroup));
    for (const gr of chunk) results.push(...gr);
    console.log(`groups ${Math.min(i + CONC, groupList.length)}/${groupList.length} | ideal=${results.filter(r => r.bucket === "ideal").length} partial=${results.filter(r => r.bucket === "partial").length} manual=${results.filter(r => r.bucket === "manual").length}`);
  }

  const esc = (s: string) => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const card = (r: R) => `<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115">
  <div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} <span style="color:#6b7280;font-weight:400">[${esc(r.via)}]</span></div>
  <div style="color:#9ca3af;margin:4px 0 8px">${esc(r.title)}</div>
  ${r.textGaps.length ? `<div style="color:#f59e0b;font-size:12px;margin-bottom:6px">текст: ${esc(r.textGaps.join(" · "))}</div>` : `<div style="color:#22c55e;font-size:12px;margin-bottom:6px">текст: ок по эталону</div>`}
  <div style="display:flex;gap:16px"><div><div style="color:#ef4444;font-size:12px">БЫЛО</div>${r.before ? `<img src="${esc(r.before)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px">нет фото</div>`}</div>
  <div><div style="color:#22c55e;font-size:12px">СТАЛО</div>${r.after ? `<img src="${esc(r.after)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">` : `<div style="width:280px;height:280px;display:flex;align-items:center;justify-content:center;background:#1f2937;color:#9ca3af;border-radius:6px;text-align:center;padding:8px">${esc(r.imgNote)}</div>`}</div></div></div>`;
  const page = (title: string, list: R[]) => `<!doctype html><meta charset=utf8><title>${title}</title><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">${title}</h1><div style="color:#9ca3af;margin-bottom:12px">${list.length} листингов · один товар = одно каноничное фото</div>${list.map(card).join("")}</body>`;

  const ideal = results.filter(r => r.bucket === "ideal"), partial = results.filter(r => r.bucket === "partial"), manual = results.filter(r => r.bucket === "manual");
  const u1 = await uploadToR2(Buffer.from(page(`✅ Идеальные (фото верное + текст по эталону) — ${ideal.length}`, ideal)), `walmart-review/qual50-ideal-${STAMP}.html`, "text/html");
  const u2 = await uploadToR2(Buffer.from(page(`⚠️ Частичные (фото верное, текст дотянуть) — ${partial.length}`, partial)), `walmart-review/qual50-partial-${STAMP}.html`, "text/html");
  const u3 = await uploadToR2(Buffer.from(page(`❌ На ручную (нет верного фото) — ${manual.length}`, manual)), `walmart-review/qual50-manual-${STAMP}.html`, "text/html");
  console.log(`\nRESULT: ideal=${ideal.length} partial=${partial.length} manual=${manual.length} of ${results.length}`);
  console.log(`ideal:   ${u1}`); console.log(`partial: ${u2}`); console.log(`manual:  ${u3}`);
  for (const r of manual) console.log(`  ❌ ${r.sku} [${r.via}] :: ${r.title.slice(0, 45)}`);
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
