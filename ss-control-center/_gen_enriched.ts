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

async function main() {
  const newwork: any[] = JSON.parse(readFileSync("_newwork.json", "utf8"));
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

  const vision = await import("./src/lib/sourcing/vision.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

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
  console.log(`generating ${todoSkus.length} new-scheme tiles (CONC ${CONC})\n`);

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
      let gallery: string[] = []; try { gallery = JSON.parse(String(r.donorImageUrls || "[]")); } catch { }
      const main = String(r.donorMainImage || "");
      const urls = [...new Set([main, ...gallery].filter(Boolean))];
      if (!urls.length) { state[sku] = { sku, status: "DONOR_FAIL", reason: "empty gallery" }; needEnrich.push(sku); donorFail++; return; }

      const fr = await pickFront(urls, title);
      if (fr.err) { state[sku] = { sku, status: "ERR", reason: "vision errors during front-pick (retry later)" }; err++; return; }
      if (!fr.url) { state[sku] = { sku, status: "DONOR_FAIL", reason: "no clean single-unit white-bg front in gallery" }; needEnrich.push(sku); donorFail++; return; }

      const base = await fetchImageBuffer(highResImageUrl(fr.url));
      const buf = qty >= 2 ? await composeTiledMainImage(base, qty) : base; // qty<2 → single unit, no tiling
      const url = await uploadToR2(buf, multipackImageKey(sku, "main", "enriched"));

      if (qty >= 2) {
        let tv: any = null;
        for (let a = 0; a < 4; a++) { tv = await vision.qualifyTiledMain(url, title, qty); if (!isErr(tv.reason)) break; await sleep(2000 * (a + 1)); }
        if (isErr(tv.reason)) { state[sku] = { sku, status: "ERR", reason: "vision errors during tile-QC (retry later)", newUrl: url, qty }; err++; return; }
        if (!tv.pass) { state[sku] = { sku, status: "TILE_FAIL", reason: tv.reason, newUrl: url, qty, front: fr.url }; tileFail++; return; }
        state[sku] = { sku, status: "GEN_OK", newUrl: url, qty, donorTitle: title, front: fr.url, audit: fr.audit, tileReason: tv.reason };
      } else {
        state[sku] = { sku, status: "GEN_OK", newUrl: url, qty, donorTitle: title, front: fr.url, audit: fr.audit, note: "single-unit" };
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
