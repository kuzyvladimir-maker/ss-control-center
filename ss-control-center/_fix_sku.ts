// Rebuild ONE SKU's main tile from an explicitly chosen donor, run the full
// listing-anchored gate, upload, and report the URL. Publishing is a separate step, so
// the image can be eyeballed first.
//
// Built for owner-reported defects (RizwanX-3699: a "Lemon Lime" listing showing GRAPE
// powder boxes). Those live in the June-16 cohort, which predates every state file the
// current pipeline keeps — so the batch scripts cannot see them.
//
// Usage: npx tsx _fix_sku.ts <sku> <donorProductId> [packCount]
//   packCount defaults to the "(Pack of N)" in the listing title. Remember: "10 Count"
//   describes the pieces inside ONE retail unit and must never shrink the pack.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";

const STATE = "_fix_sku_state.json";
const SKU = process.argv[2];
const DONOR = process.argv[3];
const PACK_ARG = process.argv[4] ? Number(process.argv[4]) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isErr = (s: string) => /error/i.test(s || "");

const MODIFIERS = ["diet", "zero", "decaf", "decaffeinated", "caffeine", "whole", "honey", "xxtra", "flamin", "unsweetened", "sugarfree", "lite", "reduced", "gluten", "organic", "spicy", "original", "classic", "smoked", "toasted"];
const words = (s: string) => new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
const modifierMismatch = (l: string, d: string) => { const L = words(l), D = words(d); for (const m of MODIFIERS) if (L.has(m) !== D.has(m)) return m; return ""; };
const frozen = (s: string) => /\bfrozen\b/i.test(s || "");
const frozenDonorMismatch = (l: string, d: string) => frozen(d) && !frozen(l);
const baseListingTitle = (l: string) => (l || "")
  .replace(/\(?\s*pack\s+of\s+\d+\s*\)?/gi, " ").replace(/\b\d+\s*[-\s]?\s*pack\b/gi, " ")
  .replace(/\bquantity\s+of\s+\d+\b/gi, " ").replace(/\b\d+\s*[-\s]?\s*ct\b/gi, " ")
  .replace(/\b\d+\s*x\b/gi, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–,.]+|[\s\-–,]+$/g, "").trim();
/** "(Pack of 6)" / "6-Pack" / "Quantity of 6" — the number of RETAIL UNITS on the tile. */
function packFromListing(l: string): number {
  const m = (l || "").match(/pack\s+of\s+(\d+)|(\d+)\s*[-\s]?pack\b|quantity\s+of\s+(\d+)/i);
  return m ? Number(m[1] || m[2] || m[3]) : 0;
}

async function main() {
  if (!SKU || !DONOR) { console.error("usage: _fix_sku.ts <sku> <donorProductId> [packCount]"); process.exit(1); }
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");

  // listing title: mirror first, live Walmart second (the mirror lags)
  let listing = "";
  const row = (await db.execute({ sql: `SELECT title FROM WalmartCatalogItem WHERE sku=?`, args: [SKU] })).rows;
  if (row.length && row[0].title) listing = String(row[0].title);
  if (!listing) {
    const body = (await getWalmartClient(1).requestRaw("GET", `/items/${encodeURIComponent(SKU)}`)).body as any;
    listing = String(body?.ItemResponse?.[0]?.productName || "");
  }
  if (!listing) { console.error("нет заголовка листинга — идентичность не проверить"); process.exit(1); }

  const d = (await db.execute({ sql: `SELECT id,title,mainImageUrl,imageUrls FROM DonorProduct WHERE id=?`, args: [DONOR] })).rows[0] as any;
  if (!d) { console.error("донор не найден"); process.exit(1); }
  let gallery: string[] = []; try { gallery = JSON.parse(String(d.imageUrls || "[]")); } catch { }
  const urls = [...new Set([String(d.mainImageUrl || ""), ...gallery].filter(Boolean))];

  const qty = PACK_ARG || packFromListing(listing);
  console.log(`SKU      ${SKU}`);
  console.log(`листинг  ${listing}`);
  console.log(`донор    ${String(d.title).slice(0, 78)}`);
  console.log(`штук на плитке: ${qty} · кадров в галерее: ${urls.length}\n`);
  if (qty < 2) { console.error("packCount < 2 — плитка не нужна"); process.exit(1); }

  const mism = modifierMismatch(listing, String(d.title));
  if (mism) { console.error(`СТОП: донор≠листинг по слову "${mism}"`); process.exit(1); }
  if (frozenDonorMismatch(listing, String(d.title))) { console.error("СТОП: замороженный донор для Walmart-листинга"); process.exit(1); }

  // clean single-unit white-bg front, judged against the LISTING (pack phrasing stripped)
  const base = baseListingTitle(listing);
  let front = "";
  for (const u of urls) {
    let dv: any = null;
    for (let a = 0; a < 4; a++) { dv = await vision.qualifyDonorFront(u, base); if (!isErr(dv.reason)) break; await sleep(2000 * (a + 1)); }
    if (isErr(dv.reason)) continue;
    if (dv.front && dv.whiteBg && dv.singleUnit) { front = u; console.log(`фронт найден: ${u.slice(0, 88)}\n  (${dv.brand || "?"} / ${dv.variant || "?"})`); break; }
  }
  if (!front) { const r = await vision.pickBestFrontFromPool(urls, base); if (r) { front = r; console.log(`фронт (rescue): ${r.slice(0, 88)}`); } }
  if (!front) { console.error("СТОП: в галерее донора нет чистого одиночного фронта"); process.exit(1); }

  const buf = await composeTiledMainImage(await fetchImageBuffer(highResImageUrl(front)), qty);
  const url = await uploadToR2(buf, multipackImageKey(SKU, "main", "ownerfix"));
  console.log(`\nплитка загружена: ${url}`);

  let tv: any = null;
  for (let a = 0; a < 4; a++) { tv = await vision.qualifyTiledMain(url, listing, qty); if (!isErr(tv.reason)) break; await sleep(2500 * (a + 1)); }
  console.log(`tile-QC: ${tv.pass ? "ПРОШЁЛ" : "ОТБИТ"} — ${tv.reason}`);

  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  state[SKU] = { sku: SKU, listing, donorId: DONOR, donorTitle: String(d.title), qty, front, newUrl: url, pass: !!tv.pass, tileReason: tv.reason };
  writeFileSync(STATE, JSON.stringify(state, null, 1));
  if (!tv.pass) process.exit(2);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
