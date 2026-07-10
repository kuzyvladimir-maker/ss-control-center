// NEW-SCHEME generator: build tiled MAIN images from COGS-enriched donors.
// Per the division-of-labor contract I do NOT identify or retail-search — the donor
// (variant + gallery) already exists in EnrichedReadySku. My job = IMAGE QC + tiling:
// find a clean SINGLE-unit white-bg FRONT in the donor gallery, tile it ×qty, QC the
// tile, upload to R2. Publishing is a SEPARATE step.
//
// ROBUSTNESS (2026-07-08): the shared vision router (askVisionJson) is contended with
// the COGS sweep, so calls transiently error. classifyProductPhoto/qualifyDonorFront
// return a reason containing "error" on failure — we RETRY those and NEVER treat a
// vision error as "not a front" (that would falsely bounce a good SKU to enrich). A
// SKU with only vision-errors is left ERR (re-run picks it up); a SKU whose gallery
// genuinely has no clean single-unit front → DONOR_FAIL → Setting.enrich_priority_skus
// for COGS to re-harvest. I trust COGS's variant match (contract), so I gate on image
// quality (front/whiteBg/singleUnit), only RECORDING brand/variant for later audit.
//
// Usage: npx tsx _gen_enriched.ts [LIMIT] [CONC]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";

const STATE = "_gen_enriched_state.json";
const LIMIT = process.argv[2] ? Number(process.argv[2]) : Infinity;
const CONC = process.argv[3] ? Number(process.argv[3]) : 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isErr = (s: string) => /error/i.test(s || "");

// Words whose presence flips the product into a DIFFERENT one. If a listing says "Dr
// Pepper" and the donor says "Diet Dr Pepper", they are not the same drink — no vision
// call needed to know that. Asymmetric presence of ANY of these = wrong donor. Kept
// deliberately small: only words that are never mere decoration.
const MODIFIERS = ["diet", "zero", "decaf", "decaffeinated", "caffeine", "whole", "honey", "xxtra", "flamin", "unsweetened", "sugarfree", "lite", "reduced", "gluten", "organic", "spicy", "original", "classic", "smoked", "toasted"];
const words = (s: string) => new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
/** Returns the offending modifier, or "" when listing and donor agree on all of them. */
function modifierMismatch(listing: string, donor: string): string {
  const L = words(listing), D = words(donor);
  for (const m of MODIFIERS) if (L.has(m) !== D.has(m)) return m;
  return "";
}

/** Owner's rule (2026-07-10): **we sell no frozen goods on Walmart** — frozen is an Amazon-only
 *  line (the Uncrustables cooler bundles). Confirmed in the catalog: 0 of 4243 Walmart listings
 *  mention "frozen". So a frozen donor behind a Walmart listing is not a storage note, it is a
 *  DIFFERENT PRODUCT. This fired the moment COGS's frozen fix (which correctly stopped discarding
 *  frozen donors, for Amazon's sake) reached the Walmart catalog: a "Vegetable Blend 15 oz"
 *  listing drew "Corn Cob Bites 16 oz (Frozen)", and "Carrots Sliced" drew "Veggie Tots".
 *
 *  Directional on purpose: reject a frozen donor unless the listing itself says frozen. Kept as
 *  its own check rather than a MODIFIERS entry, because the reason is a channel policy, not a
 *  word — pointing this generator at Amazon must NOT inherit it. */
const frozen = (s: string) => /\bfrozen\b/i.test(s || "");
function frozenDonorMismatch(listing: string, donor: string): boolean {
  return frozen(donor) && !frozen(listing);
}

/** The listing title minus its multipack phrasing. The DONOR front is a SINGLE unit, so
 *  handing "…(Pack of 2)" to the single-unit gate makes it reject perfectly good fronts.
 *  qualifyTiledMain still gets the full title (it takes packCount separately). */
function baseListingTitle(listing: string): string {
  return (listing || "")
    .replace(/\(?\s*pack\s+of\s+\d+\s*\)?/gi, " ")
    .replace(/\b\d+\s*[-\s]?\s*pack\b/gi, " ")
    .replace(/\bquantity\s+of\s+\d+\b/gi, " ")
    .replace(/\b\d+\s*[-\s]?\s*ct\b/gi, " ")
    .replace(/\b\d+\s*x\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–,.]+|[\s\-–,]+$/g, "") // "2x-Foo" would leave a stray leading dash
    .trim();
}

async function main() {
  const newwork: any[] = JSON.parse(readFileSync("_newwork.json", "utf8"));
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

  const vision = await import("./src/lib/sourcing/vision.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const wm = getWalmartClient(1);

  // Process NEVER-SEEN SKUs + prior vision-ERRors only. Do NOT re-chew settled
  // DONOR_FAIL/TILE_FAIL here — each re-does the full gallery + rescue (~16 vision
  // calls) and mostly re-fails (banner'd donors pending COGS's Target fix), which
  // starves throughput. Reprocess those in a dedicated pass after COGS re-sources.
  const todoSkus = newwork.filter((w) => !state[w.sku] || state[w.sku].status === "ERR").map((w) => w.sku).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const rowBySku = new Map<string, any>();
  for (let i = 0; i < todoSkus.length; i += 200) {
    const chunk = todoSkus.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku, qty, donorTitle, donorImageUrls, donorMainImage FROM EnrichedReadySku WHERE sku IN (${chunk.map(() => "?").join(",")})`, args: chunk })).rows;
    for (const r of rows) rowBySku.set(String(r.sku), r);
  }

  // THE LISTING TITLE IS THE ONLY GROUND TRUTH. (2026-07-09)
  // We used to tile-QC against donorTitle, so a wrong-variant donor matched its own
  // label and sailed through: listing "Dr Pepper 2L (Pack of 4)" got a main image of
  // four DIET Dr Pepper bottles, because the donor was titled "Diet Dr Pepper" and its
  // image agreed with itself. The customer-facing title was never consulted. From now
  // on the identity gate compares the tile to what the buyer actually sees.
  const listingTitle = new Map<string, string>();
  for (let i = 0; i < todoSkus.length; i += 200) {
    const chunk = todoSkus.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku,title FROM WalmartCatalogItem WHERE sku IN (${chunk.map(() => "?").join(",")})`, args: chunk })).rows;
    for (const r of rows) if (r.title) listingTitle.set(String(r.sku), String(r.title));
  }
  console.log(`generating ${todoSkus.length} tiles (CONC ${CONC}) · listing titles: ${listingTitle.size}/${todoSkus.length}\n`);

  // WalmartCatalogItem is a nightly mirror and lags: 232 of the 1191 SKUs in scope are
  // PUBLISHED+ACTIVE on Walmart yet carry no title here. Failing closed on those would
  // strand a fifth of the catalog in ERR forever, so fall back to the live Items API —
  // still OUR listing data (productName), not a retail search. Memoised per SKU.
  const fetching = new Map<string, Promise<string>>();
  const resolveListingTitle = async (sku: string): Promise<string> => {
    const cached = listingTitle.get(sku);
    if (cached) return cached;
    if (!fetching.has(sku)) {
      fetching.set(sku, (async () => {
        try {
          const body = (await wm.requestRaw("GET", `/items/${encodeURIComponent(sku)}`)).body as any;
          const it: any = body?.ItemResponse?.[0];
          const name = String(it?.productName || "").trim();
          if (name) listingTitle.set(sku, name);
          return name;
        } catch { return ""; }
      })());
    }
    return fetching.get(sku)!;
  };

  const needEnrich: string[] = [];
  let ok = 0, donorFail = 0, tileFail = 0, err = 0, done = 0;

  // Find a clean single-unit white-bg FRONT in [main, ...gallery]. Donor-first: the
  // donor's own main image is almost always it (1 call). Returns {url} | {err} | {none}.
  const pickFront = async (urls: string[], title: string): Promise<{ url?: string; err?: boolean; audit?: any }> => {
    let sawError = false;
    for (const u of urls) {
      let dv: any = null;
      for (let a = 0; a < 4; a++) { dv = await vision.qualifyDonorFront(u, title); if (!isErr(dv.reason)) break; await sleep(2000 * (a + 1)); }
      if (isErr(dv.reason)) { sawError = true; continue; }
      // image-quality gate (mine): clean single unit, front, white bg. Variant = COGS's.
      if (dv.front && dv.whiteBg && dv.singleUnit) return { url: u, audit: { brand: dv.brand, variant: dv.variant } };
    }
    // RESCUE (COGS 18:23 suggestion): per-image gates can miss a usable front in a big
    // gallery. Show the WHOLE pool to the model in ONE call and let it pick the best
    // product-only white-bg front, then CONFIRM that pick with qualifyDonorFront before
    // tiling. This salvages SKUs whose clean frame wasn't the strict per-image winner.
    // If the pool genuinely has only banner'd/lifestyle/panel images, it returns null.
    if (!sawError) {
      try {
        const rescued = await vision.pickBestFrontFromPool(urls, title);
        if (rescued) {
          let dv: any = null;
          for (let a = 0; a < 4; a++) { dv = await vision.qualifyDonorFront(rescued, title); if (!isErr(dv.reason)) break; await sleep(2000 * (a + 1)); }
          if (!isErr(dv.reason) && dv.front && dv.whiteBg && dv.singleUnit) return { url: rescued, audit: { brand: dv.brand, variant: dv.variant, rescued: true } };
        }
      } catch { }
    }
    return sawError ? { err: true } : {};
  };

  const gen = async (sku: string) => {
    try {
      const r = rowBySku.get(sku);
      if (!r) { state[sku] = { sku, status: "ERR", reason: "not in EnrichedReadySku" }; err++; return; }
      const qty = Number(r.qty) || 0;
      const title = String(r.donorTitle || "");
      const listing = await resolveListingTitle(sku);
      if (!listing) { state[sku] = { sku, status: "ERR", reason: "no listing title in mirror nor Walmart Items API (cannot verify identity)" }; err++; return; }

      // CHEAP GUARD before we spend any vision: a modifier word that appears on one side
      // and not the other means the donor is a DIFFERENT product (Diet vs regular,
      // Whole vs plain, Zero Sugar vs sugared). Bounce to COGS instead of tiling it.
      const mism = modifierMismatch(listing, title);
      if (mism) {
        state[sku] = { sku, status: "VARIANT_MISMATCH", reason: `donor≠listing on "${mism}"`, listing, donorTitle: title };
        needEnrich.push(sku); donorFail++; return;
      }
      if (frozenDonorMismatch(listing, title)) {
        state[sku] = { sku, status: "VARIANT_MISMATCH", reason: "frozen donor for a Walmart listing (we sell no frozen on Walmart)", listing, donorTitle: title };
        needEnrich.push(sku); donorFail++; return;
      }

      let gallery: string[] = []; try { gallery = JSON.parse(String(r.donorImageUrls || "[]")); } catch { }
      const main = String(r.donorMainImage || "");
      const urls = [...new Set([main, ...gallery].filter(Boolean))];
      if (!urls.length) { state[sku] = { sku, status: "DONOR_FAIL", reason: "empty gallery" }; needEnrich.push(sku); donorFail++; return; }

      // Check the donor front against the LISTING (pack phrasing stripped) — a wrong donor
      // is rejected here, before we waste a tile + upload on it.
      const fr = await pickFront(urls, baseListingTitle(listing));
      if (fr.err) { state[sku] = { sku, status: "ERR", reason: "vision errors during front-pick (retry later)" }; err++; return; }
      if (!fr.url) { state[sku] = { sku, status: "DONOR_FAIL", reason: "no clean single-unit white-bg front in gallery" }; needEnrich.push(sku); donorFail++; return; }

      const base = await fetchImageBuffer(highResImageUrl(fr.url));
      const buf = qty >= 2 ? await composeTiledMainImage(base, qty) : base; // qty<2 → single unit, no tiling
      const url = await uploadToR2(buf, multipackImageKey(sku, "main", "enriched"));

      if (qty >= 2) {
        // Identity gate against the LISTING title (not the donor's own label) — this is
        // what the buyer sees, and the only reference that can catch a wrong-variant donor.
        let tv: any = null;
        for (let a = 0; a < 4; a++) { tv = await vision.qualifyTiledMain(url, listing, qty); if (!isErr(tv.reason)) break; await sleep(2000 * (a + 1)); }
        if (isErr(tv.reason)) { state[sku] = { sku, status: "ERR", reason: "vision errors during tile-QC (retry later)", newUrl: url, qty }; err++; return; }
        if (!tv.pass) { state[sku] = { sku, status: "TILE_FAIL", reason: tv.reason, newUrl: url, qty, front: fr.url, listing }; tileFail++; return; }
        state[sku] = { sku, status: "GEN_OK", newUrl: url, qty, donorTitle: title, listing, front: fr.url, audit: fr.audit, tileReason: tv.reason };
      } else {
        state[sku] = { sku, status: "GEN_OK", newUrl: url, qty, donorTitle: title, listing, front: fr.url, audit: fr.audit, note: "single-unit" };
      }
      ok++;
    } catch (e: any) { state[sku] = { sku, status: "ERR", reason: String(e?.message || e).slice(0, 90) }; err++; }
    finally { done++; save(); if (done % 10 === 0 || done === todoSkus.length) console.log(`  [${done}/${todoSkus.length}] ok ${ok} · donorFail ${donorFail} · tileFail ${tileFail} · err ${err}`); }
  };

  for (let i = 0; i < todoSkus.length; i += CONC) await Promise.all(todoSkus.slice(i, i + CONC).map(gen));

  // push GENUINE donor-failures (not vision-errors) into the enrich queue for COGS
  if (needEnrich.length) {
    const ex = (await db.execute(`SELECT value FROM Setting WHERE key='enrich_priority_skus'`)).rows;
    let existing: string[] = []; if (ex.length) { try { existing = JSON.parse(String(ex[0].value)) || []; } catch { } }
    const merged = [...new Set([...existing, ...needEnrich])];
    if (ex.length) await db.execute({ sql: `UPDATE Setting SET value=? WHERE key='enrich_priority_skus'`, args: [JSON.stringify(merged)] });
    else await db.execute({ sql: `INSERT INTO Setting (id,key,value) VALUES (?,?,?)`, args: [randomUUID(), "enrich_priority_skus", JSON.stringify(merged)] });
    console.log(`\n${needEnrich.length} genuine donor-failures → enrich_priority_skus (now ${merged.length})`);
  }
  const all = Object.values(state);
  const c = (s: string) => all.filter((x: any) => x.status === s).length;
  console.log(`\n=== GEN cumulative === GEN_OK ${c("GEN_OK")} · DONOR_FAIL ${c("DONOR_FAIL")} · TILE_FAIL ${c("TILE_FAIL")} · ERR ${c("ERR")}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
