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
import {
  throwIfMeteredProviderControlError,
  withMeteredProviderCall,
} from "./metered-provider-call";
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
    return await withMeteredProviderCall({
      provider: "oxylabs",
      operation: "image_search",
      requestFingerprint: {
        context: [{ key: "tbm", value: "isch" }],
        parse: true,
        query,
        source: "google_search",
      },
    }, async () => {
      const r = await fetch("https://realtime.oxylabs.io/v1/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({ source: "google_search", query, parse: true, context: [{ key: "tbm", value: "isch" }] }),
        signal: c.signal,
      });
      if (!r.ok) throw new Error(`Oxylabs image search HTTP ${r.status}`);
      const j: any = await r.json();
      const str = JSON.stringify(j?.results?.[0]?.content || {});
      const imgs = [...str.matchAll(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/g)]
        .map((m) => m[1]).filter((x) => !/gstatic|googleusercontent|\.gif|logo|sprite/.test(x));
      return [...new Set(imgs.map((x) => x.split("?")[0]))];
    });
  } catch (error) {
    throwIfMeteredProviderControlError(error);
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
export async function resolveDonorPhoto(listingTitle: string, opts: { log?: (m: string) => void; searchQuery?: string; identityTitle?: string; excludeUrls?: string[] } = {}): Promise<DonorPhoto | null> {
  const log = opts.log ?? (() => {});
  // searchQuery / identityTitle come from the IDENTIFY step (step 2): a CLEAN query to
  // search by + a CLEAN single-unit identity for the gates, instead of the raw
  // multipack title. Falls back to string-cleaning the title when identify isn't given.
  const q = (opts.searchQuery || cleanQuery(listingTitle)).trim();
  const idTitle = opts.identityTitle || listingTitle;
  const unit = unitSizeFromTitle(listingTitle);
  if (!q) return null;
  // excludeUrls — donors already tried and REJECTED downstream (e.g. the finished tile
  // failed qualifyTiledMain on format/size, or carried a promo banner). Without this a
  // retry finds the SAME first-passing donor and fails identically (the Maruchan-bowl
  // loop). The caller accumulates rejects; we skip them so the waterfall reaches the
  // NEXT candidate.
  const excluded = new Set((opts.excludeUrls || []).map((u) => u.split("?")[0]));

  const tryPool = async (imgsRaw: string[], src: string): Promise<DonorPhoto | null> => {
    const imgs = imgsRaw.filter((u) => !excluded.has(u.split("?")[0]));
    for (const u of imgs.slice(0, MAX_CAND)) {
      const v = await qualifyDonorFront(highResImageUrl(u), idTitle, unit);
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
      .map((o) => ({ u: o.imageUrls[0], s: overlap(idTitle, o.title || "") }))
      .filter((o) => o.s >= 0.45).sort((a, b) => b.s - a.s).map((o) => o.u);
    const r = await tryPool(imgs, "Walmart 1P");
    if (r) return r;
  } catch (error) {
    throwIfMeteredProviderControlError(error);
    // Ordinary provider/network miss: continue to the next tier.
  }

  const storeImgs = (offers: any[]): string[] => offers
    .filter((o) => o.imageUrls?.[0])
    .map((o) => ({ u: o.imageUrls[0] as string, s: overlap(idTitle, o.title || "") }))
    .filter((o) => o.s >= 0.4).sort((a, b) => b.s - a.s).map((o) => o.u);

  // T2: fast API stores (Unwrangle — now paid): Sam's Club, Target, Costco.
  for (const ret of ["samsclub", "target", "costco"] as const) {
    try {
      const rr = await unwrangleSearch(ret, q);
      const r = await tryPool(storeImgs(rr.offers), ret);
      if (r) return r;
    } catch (error) {
      throwIfMeteredProviderControlError(error);
      // Ordinary provider/network miss: continue to the next retailer.
    }
  }

  // T3: Google Images (fast, whole-web) — real retailer photos indexed across the
  // web; catches most generic products a store search missed. Ordered BEFORE the
  // slow browser stores so a common product never has to wait on a 90s BJ's/Publix
  // browser scrape (owner observed the browser hammering BJ's on every miss).
  try {
    const raw = (await googleImages(q + " package")).slice(0, 14);
    const picks: string[] = [];
    const best = (await pickBestFront(raw, { listingTitle: idTitle }))?.url;
    if (best) picks.push(best);
    const pool = await pickBestFrontFromPool(raw, idTitle);
    if (pool && !picks.includes(pool)) picks.push(pool);
    const r = await tryPool(picks, "Google Images");
    if (r) return r;
  } catch (error) {
    throwIfMeteredProviderControlError(error);
    // Ordinary provider/network miss: continue to the browser tier.
  }

  // T4 (SLOW, LAST before generation): login-gated stores via the OpenClaw browser
  // (~90s each, and it shares the box with Vladimir's OpenClaw agents). Reached ONLY
  // when everything above missed — mainly PRIVATE LABELS sold only here (Wellsley
  // Farms → BJ's, store brands → Publix). Kept last so a generic product a fast
  // source already covers never wastes the slow browser.
  if (openClawEnabled()) {
    for (const ret of ["publix"] as const) { // bjs+aldi disabled: bjs Akamai tripped 2026-07-07; aldi not a buying source
      try {
        const rr = await openClawSearch(ret, q);
        const r = await tryPool(storeImgs(rr.offers), ret);
        if (r) return r;
      } catch (error) {
        throwIfMeteredProviderControlError(error);
        // Ordinary provider/browser miss: continue to the next retailer.
      }
    }
  }

  return null;
}
