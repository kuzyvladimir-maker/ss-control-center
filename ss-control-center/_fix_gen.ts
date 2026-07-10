// REMEDIATION generator (2026-07-09). Rebuild the MAIN tile for SKUs whose live image
// shows the WRONG product, using a CORRECT donor that already exists in DonorProduct.
//
// Why this script exists: the original tile-QC compared the tile to the DONOR's own
// title, so a wrong-variant donor validated itself and shipped (a "Dr Pepper" listing
// went live with four DIET Dr Pepper bottles). _reqc_published.ts re-judged every live
// tile against the LISTING title and found 195 bad; _suggest_donors.ts found a correct
// donor already in our paid catalog for 100 of them. This script regenerates those.
//
// No retail search, no Unwrangle credits: donors are read from DonorProduct by id.
// Every gate here anchors on the LISTING title — never the donor's.
//
// Usage: npx tsx _fix_gen.ts [LIMIT] [CONC]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";

const STATE = "_fix_gen_state.json";
const LIMIT = process.argv[2] ? Number(process.argv[2]) : Infinity;
const CONC = process.argv[3] ? Number(process.argv[3]) : 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isErr = (s: string) => /error/i.test(s || "");

const MODIFIERS = ["diet", "zero", "decaf", "decaffeinated", "caffeine", "whole", "honey", "xxtra", "flamin", "unsweetened", "sugarfree", "lite", "reduced", "gluten", "organic", "spicy", "original", "classic", "smoked", "toasted"];
const words = (s: string) => new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
function modifierMismatch(listing: string, donor: string): string {
  const L = words(listing), D = words(donor);
  for (const m of MODIFIERS) if (L.has(m) !== D.has(m)) return m;
  return "";
}
/** Owner's rule (2026-07-10): no frozen goods on Walmart — frozen is Amazon-only. 0 of 4243
 *  Walmart listings say "frozen", so a frozen donor here is a different product, not a storage
 *  note. See _gen_enriched.ts for the full rationale; deliberately NOT a MODIFIERS entry. */
const frozen = (s: string) => /\bfrozen\b/i.test(s || "");
function frozenDonorMismatch(listing: string, donor: string): boolean {
  return frozen(donor) && !frozen(listing);
}

/** The donor front is a SINGLE unit, so the multipack phrasing must go before we ask
 *  the single-unit gate whether the photo matches. qualifyTiledMain gets the full title. */
function baseListingTitle(listing: string): string {
  return (listing || "")
    .replace(/\(?\s*pack\s+of\s+\d+\s*\)?/gi, " ")
    .replace(/\b\d+\s*[-\s]?\s*pack\b/gi, " ")
    .replace(/\bquantity\s+of\s+\d+\b/gi, " ")
    .replace(/\b\d+\s*[-\s]?\s*ct\b/gi, " ")
    .replace(/\b\d+\s*x\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–,.]+|[\s\-–,]+$/g, "")
    .trim();
}

async function main() {
  const sugg: any[] = JSON.parse(readFileSync("_suggested_donors.json", "utf8")).filter((x: any) => x.suggestions.length);
  const reqc: Record<string, any> = JSON.parse(readFileSync("_reqc_state.json", "utf8"));
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

  const vision = await import("./src/lib/sourcing/vision.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

  const todo = sugg.filter((s) => !state[s.sku] || state[s.sku].status === "ERR").slice(0, LIMIT === Infinity ? undefined : LIMIT);

  // pull the replacement donors' galleries in one shot
  const ids = [...new Set(todo.map((s) => s.suggestions[0].id))];
  const donor = new Map<string, { title: string; main: string; gallery: string[] }>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT id,title,mainImageUrl,imageUrls FROM DonorProduct WHERE id IN (${chunk.map(() => "?").join(",")})`, args: chunk })).rows;
    for (const r of rows) {
      let g: string[] = []; try { g = JSON.parse(String(r.imageUrls || "[]")); } catch { }
      donor.set(String(r.id), { title: String(r.title || ""), main: String(r.mainImageUrl || ""), gallery: g });
    }
  }
  console.log(`к перегенерации: ${todo.length} · доноров-замен: ${donor.size} (CONC ${CONC})\n`);

  let ok = 0, donorFail = 0, tileFail = 0, err = 0, done = 0;

  const pickFront = async (urls: string[], title: string): Promise<{ url?: string; err?: boolean; audit?: any }> => {
    let sawError = false;
    for (const u of urls) {
      let dv: any = null;
      for (let a = 0; a < 4; a++) { dv = await vision.qualifyDonorFront(u, title); if (!isErr(dv.reason)) break; await sleep(2000 * (a + 1)); }
      if (isErr(dv.reason)) { sawError = true; continue; }
      if (dv.front && dv.whiteBg && dv.singleUnit) return { url: u, audit: { brand: dv.brand, variant: dv.variant } };
    }
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

  const gen = async (s: any) => {
    const sku = s.sku;
    try {
      const listing: string = s.listing || reqc[sku]?.listing || "";
      const qty = Number(reqc[sku]?.qty) || 0;
      if (!listing || qty < 2) { state[sku] = { sku, status: "ERR", reason: `bad inputs (listing=${!!listing} qty=${qty})` }; err++; return; }

      const d = donor.get(s.suggestions[0].id);
      if (!d) { state[sku] = { sku, status: "ERR", reason: "replacement donor row missing" }; err++; return; }

      // The suggester is title-based. Re-assert the modifier guard here so a bad suggestion
      // can never reach the tiler: "Whole Wheat" must not be replaced by "Honey Wheat".
      const mism = modifierMismatch(listing, d.title);
      if (mism) { state[sku] = { sku, status: "SUGGEST_BAD", reason: `replacement≠listing on "${mism}"`, listing, newDonorTitle: d.title }; donorFail++; return; }
      if (frozenDonorMismatch(listing, d.title)) { state[sku] = { sku, status: "SUGGEST_BAD", reason: "frozen replacement donor for a Walmart listing", listing, newDonorTitle: d.title }; donorFail++; return; }

      const urls = [...new Set([d.main, ...d.gallery].filter(Boolean))];
      if (!urls.length) { state[sku] = { sku, status: "DONOR_FAIL", reason: "replacement donor has empty gallery" }; donorFail++; return; }

      const fr = await pickFront(urls, baseListingTitle(listing));
      if (fr.err) { state[sku] = { sku, status: "ERR", reason: "vision errors during front-pick (retry later)" }; err++; return; }
      if (!fr.url) { state[sku] = { sku, status: "DONOR_FAIL", reason: "no clean single-unit white-bg front in replacement gallery" }; donorFail++; return; }

      const base = await fetchImageBuffer(highResImageUrl(fr.url));
      const buf = await composeTiledMainImage(base, qty);
      // stamp "fix1" → new R2 key, so Walmart sees a changed URL and re-ingests
      const url = await uploadToR2(buf, multipackImageKey(sku, "main", "fix1"));

      let tv: any = null;
      for (let a = 0; a < 4; a++) { tv = await vision.qualifyTiledMain(url, listing, qty); if (!isErr(tv.reason)) break; await sleep(2000 * (a + 1)); }
      if (isErr(tv.reason)) { state[sku] = { sku, status: "ERR", reason: "vision errors during tile-QC (retry later)", newUrl: url, qty }; err++; return; }
      if (!tv.pass) { state[sku] = { sku, status: "TILE_FAIL", reason: tv.reason, newUrl: url, qty, listing, newDonorTitle: d.title }; tileFail++; return; }

      state[sku] = { sku, status: "GEN_OK", newUrl: url, qty, listing, oldDonorTitle: s.currentDonor, newDonorTitle: d.title, newDonorId: s.suggestions[0].id, front: fr.url, audit: fr.audit, tileReason: tv.reason };
      ok++;
    } catch (e: any) { state[sku] = { sku, status: "ERR", reason: String(e?.message || e).slice(0, 90) }; err++; }
    finally { done++; save(); if (done % 5 === 0 || done === todo.length) console.log(`  [${done}/${todo.length}] ok ${ok} · donorFail ${donorFail} · tileFail ${tileFail} · err ${err}`); }
  };

  for (let i = 0; i < todo.length; i += CONC) await Promise.all(todo.slice(i, i + CONC).map(gen));

  const all = Object.values(state);
  const c = (st: string) => all.filter((x: any) => x.status === st).length;
  console.log(`\n=== FIX-GEN === GEN_OK ${c("GEN_OK")} · SUGGEST_BAD ${c("SUGGEST_BAD")} · DONOR_FAIL ${c("DONOR_FAIL")} · TILE_FAIL ${c("TILE_FAIL")} · ERR ${c("ERR")}`);
  for (const x of all.filter((y: any) => y.status === "GEN_OK") as any[]) console.log(`  ✓ ${x.sku} q${x.qty}  ${x.newUrl}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
