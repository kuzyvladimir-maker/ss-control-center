// Unified SINGLE-UNIT donor resolver — the ONE multi-source waterfall used by both
// the trial and the production remediation pipeline, so donor sourcing has ONE
// path and ONE gate. This is the fix for the 2026-07-04 multipack-tile incident,
// where the Walmart-1P / Sam's / Target tiers took the raw first offer with only a
// brand/variant identity check and let a "12 Pack" caddy / case / shrink-pack
// through, which then got tiled N times into "N multipacks".
//
// Waterfall (stop at the first candidate that passes qualifyDonorFront):
//   T1 Oxylabs Walmart 1P (structured)  →  T2 Google Images (broad, real photos)
//   →  T3 Sam's Club / Target (Unwrangle)
// EVERY candidate, in EVERY tier, must pass qualifyDonorFront: same brand + type +
// variant as the listing AND exactly ONE single unit of the listing's size (no
// case / caddy / multipack / shrink-pack / row) AND an upright front on white.

import { oxylabsWalmartSearch, oxylabsCreds } from "./oxylabs-fetch";
import { unwrangleSearch } from "./retail-fetch";
import { openClawSearch, openClawEnabled } from "./openclaw-fetch";
import { qualifyDonorFront, unitSizeFromTitle, pickBestFront, pickBestFrontFromPool } from "./vision";
import { highResImageUrl } from "../walmart/multipack/composite";

export interface DonorPhoto { url: string; src: string; reason: string }

const MAX_CAND = 4; // cap qualifyDonorFront calls per tier (cost guard)

/** Strip pack/size noise so the search query is the base product. */
function cleanQuery(t: string): string {
  return String(t || "")
    .replace(/^\s*\d+\s*x-?\s*/i, "")
    .replace(/\(pack of \d+\)/ig, "")
    .replace(/\b\d+\s*-?\s*pack\b/ig, "")
    .replace(/,.*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const normToks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3));
function overlap(a: string, b: string): number {
  const A = normToks(a), B = normToks(b);
  if (!A.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / A.size;
}

/** Google Images via Oxylabs (google_search + tbm=isch) — real product photos from
 *  the whole web, the broad catch-all that finds single units Walmart's own search
 *  buries under multipacks. Returns de-duped full image URLs. */
async function googleImages(query: string): Promise<string[]> {
  const creds = oxylabsCreds();
  if (!creds) return [];
  const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString("base64");
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 90000);
  try {
    const r = await fetch("https://realtime.oxylabs.io/v1/queries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({ source: "google_search", query, parse: true, context: [{ key: "tbm", value: "isch" }] }),
      signal: c.signal,
    });
    const j: any = await r.json();
    const str = JSON.stringify(j?.results?.[0]?.content || {});
    const imgs = [...str.matchAll(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/g)]
      .map((m) => m[1]).filter((x) => !/gstatic|googleusercontent|\.gif|logo|sprite/.test(x));
    return [...new Set(imgs.map((x) => x.split("?")[0]))];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve ONE verified single-unit donor photo for a multipack listing, or null.
 * The returned url is guaranteed to have passed qualifyDonorFront (single unit,
 * correct identity, upright front on white) — the caller still tiles it and runs
 * the final per-listing qualifyTiledMain gate.
 */
export async function resolveDonorPhoto(listingTitle: string, opts: { log?: (m: string) => void } = {}): Promise<DonorPhoto | null> {
  const log = opts.log ?? (() => {});
  const q = cleanQuery(listingTitle);
  const unit = unitSizeFromTitle(listingTitle);
  if (!q) return null;

  const tryPool = async (imgs: string[], src: string): Promise<DonorPhoto | null> => {
    for (const u of imgs.slice(0, MAX_CAND)) {
      const v = await qualifyDonorFront(highResImageUrl(u), listingTitle, unit);
      log(`  ${src} cand ${v.pass ? "PASS" : "rej"} [b${+v.brand} t${+v.type} v${+v.variant} s${+v.singleUnit} f${+v.front} w${+v.whiteBg}] ${v.reason}`);
      if (v.pass) return { url: u, src, reason: v.reason };
    }
    return null;
  };

  // T1: Walmart 1P (structured), candidates ranked by title overlap
  try {
    const { offers } = await oxylabsWalmartSearch(q);
    const imgs = offers
      .filter((o) => o.isMarketplaceItem !== true && o.imageUrls[0])
      .map((o) => ({ u: o.imageUrls[0], s: overlap(listingTitle, o.title || "") }))
      .filter((o) => o.s >= 0.45).sort((a, b) => b.s - a.s).map((o) => o.u);
    const r = await tryPool(imgs, "Walmart 1P");
    if (r) return r;
  } catch { /* next tier */ }

  // T2: OTHER STORES first (owner rule: exhaust real retailers before Google — a
  // product missing from walmart.com is usually stocked cleanly elsewhere).
  //   Unwrangle: Sam's Club, Target, Costco.  OpenClaw browser: Publix, BJ's, Aldi.
  const storeImgs = (offers: any[]): string[] => offers
    .filter((o) => o.imageUrls?.[0])
    .map((o) => ({ u: o.imageUrls[0] as string, s: overlap(listingTitle, o.title || "") }))
    .filter((o) => o.s >= 0.4).sort((a, b) => b.s - a.s).map((o) => o.u);
  for (const ret of ["samsclub", "target", "costco"] as const) {
    try { const rr = await unwrangleSearch(ret, q); const r = await tryPool(storeImgs(rr.offers), ret); if (r) return r; } catch { /* next retailer */ }
  }
  if (openClawEnabled()) {
    for (const ret of ["publix", "bjs", "aldi"] as const) {
      try { const rr = await openClawSearch(ret, q); const r = await tryPool(storeImgs(rr.offers), ret); if (r) return r; } catch { /* next retailer */ }
    }
  }

  // T3 (LAST RESORT before generation): Google Images — broad, whole-web. Real
  // retailer 1P photos above are preferred; Google is the catch-all when no store
  // we can read carries the product cleanly.
  try {
    const raw = (await googleImages(q + " package")).slice(0, 14);
    const picks: string[] = [];
    const best = (await pickBestFront(raw, { listingTitle }))?.url;
    if (best) picks.push(best);
    const pool = await pickBestFrontFromPool(raw, listingTitle);
    if (pool && !picks.includes(pool)) picks.push(pool);
    const r = await tryPool(picks, "Google Images");
    if (r) return r;
  } catch { /* fall through → caller sends to generation */ }

  return null;
}
