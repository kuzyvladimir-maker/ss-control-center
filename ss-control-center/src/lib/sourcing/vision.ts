// Vision helpers for the Listing Optimizer image fix — on CLAUDE (Anthropic).
//
// (Was OpenAI gpt-4o-mini, but that account's quota was exhausted overnight →
// every call returned insufficient_quota → the worker thought every product had
// "no clean front" and skipped. Anthropic has budget, so we use Claude vision.)
//
// (1) pickCleanFrontIndex — choose the best FRONT-facing product photo from a
//     candidate pool (prefer white bg, accept any front; reject back/nutrition/
//     pure-promo). (2) verifyMainImage — confirm the generated tile shows the
//     product front-facing before we ever publish it (the do-no-harm gate).

import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE } from "@/lib/ai-models";

const MODEL = CLAUDE.cheap; // cheap + vision-capable (legacy pickers)
// Quality-critical selection/verification uses a stronger model: Haiku could not
// tell a bread loaf's UPRIGHT FRONT from a LYING end-slice or a barcode BACK, so
// it tiled torец/back/nutrition/infographic shots. Sonnet + explicit orientation
// & barcode rules fixes that (verified against real donor pools 2026-06-30).
const STRONG_MODEL = CLAUDE.balanced;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

async function ask(imageUrls: string[], prompt: string, maxTokens = 80, model: string = MODEL): Promise<string> {
  const c = getClient();
  if (!c) throw new Error("ANTHROPIC_API_KEY missing");
  const content: any[] = imageUrls.map((u) => ({ type: "image", source: { type: "url", url: u } }));
  content.push({ type: "text", text: prompt });
  const res = await c.messages.create({ model, max_tokens: maxTokens, thinking: { type: "disabled" }, messages: [{ role: "user", content }] });
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}
function parseJson(t: string): any { try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return null; } }

// ── Classification CACHE ──────────────────────────────────────────────────
// A product photo's classification (front/back/nutrition/white-bg/…) never
// changes, but every full run used to re-classify all 16 candidates per SKU on
// the STRONG model — the main API cost. We cache each result by (url, model) in
// Turso so re-runs are ~free. Transparent: no DB handle threaded through callers.
import { createClient, type Client } from "@libsql/client";
let _cacheDb: Client | null | undefined;
let _cacheReady: Promise<void> | null = null;
function cacheDb(): Client | null {
  if (_cacheDb !== undefined) return _cacheDb;
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  if (!url) { _cacheDb = null; return null; }
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  try { _cacheDb = createClient({ url, authToken }); } catch { _cacheDb = null; }
  return _cacheDb;
}
async function cacheEnsure(d: Client): Promise<void> {
  if (!_cacheReady) _cacheReady = d.execute(`CREATE TABLE IF NOT EXISTS ImageClassification (url TEXT NOT NULL, model TEXT NOT NULL, type TEXT, orientation TEXT, barcode INTEGER, whiteBg INTEGER, goodFront INTEGER, conf REAL, createdAt TEXT, PRIMARY KEY (url, model))`).then(() => {});
  await _cacheReady;
}
// In-memory layer over the DB cache: within one run (e.g. the 1857 sweep) each
// URL is read from Turso at most once, then served from RAM — avoids thousands of
// serial network round-trips.
const _memClass = new Map<string, PhotoClass>();
async function classFromCache(url: string, model: string): Promise<PhotoClass | null> {
  const key = `${model}|${url}`;
  const mem = _memClass.get(key); if (mem) return mem;
  const d = cacheDb(); if (!d) return null;
  try {
    await cacheEnsure(d);
    const r = await d.execute({ sql: `SELECT type,orientation,barcode,whiteBg,goodFront,conf FROM ImageClassification WHERE url=? AND model=?`, args: [url, model] });
    const row: any = r.rows[0]; if (!row) return null;
    const c: PhotoClass = { type: row.type ?? "other", orientation: row.orientation ?? "na", barcode: !!row.barcode, whiteBg: !!row.whiteBg, goodFront: !!row.goodFront, conf: Number(row.conf) || 0 };
    _memClass.set(key, c);
    return c;
  } catch { return null; }
}
async function classToCache(url: string, model: string, c: PhotoClass): Promise<void> {
  if (c.type === "error") return; // never cache a failed call
  _memClass.set(`${model}|${url}`, c);
  const d = cacheDb(); if (!d) return;
  try {
    await cacheEnsure(d);
    await d.execute({ sql: `INSERT INTO ImageClassification (url,model,type,orientation,barcode,whiteBg,goodFront,conf,createdAt) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(url,model) DO UPDATE SET type=excluded.type,orientation=excluded.orientation,barcode=excluded.barcode,whiteBg=excluded.whiteBg,goodFront=excluded.goodFront,conf=excluded.conf`, args: [url, model, c.type, c.orientation, c.barcode ? 1 : 0, c.whiteBg ? 1 : 0, c.goodFront ? 1 : 0, c.conf, new Date().toISOString()] });
  } catch { /* cache is best-effort */ }
}

/**
 * From candidate product photos, pick the ONE best as a marketplace MAIN image:
 * the product shown FRONT-facing (front/label visible). Prefer white background,
 * but accept any front-facing shot. Returns index into `urls`, or -1 only if NO
 * image shows the product front.
 */
export async function pickCleanFrontIndex(urls: string[]): Promise<number> {
  const cands = urls.slice(0, 8);
  if (!cands.length) return -1;
  const prompt = `Above are ${cands.length} candidate product photos, index 0..${cands.length - 1} (in order).\n` +
    `Pick the ONE best to use as a marketplace MAIN image: it MUST show the actual RETAIL PRODUCT AS SOLD — its PACKAGING (the can, box, bag, bottle, jar, or pouch) with the BRAND LABEL clearly visible and front-facing. This is the package the shopper receives. ` +
    `Strongly prefer a plain white/light background.\n` +
    `REJECT (never pick): a photo of the PREPARED/COOKED food or a SERVING of it (e.g. a bowl/plate/cup of the soup), recipe or serving-suggestion shots, nutrition-facts panels, back-of-package, lifestyle scenes, and pure promo/marketing art. The PACKAGE WITH ITS LABEL must be the main subject. ` +
    `Return -1 ONLY if no image shows the product package with its label.\nReply with JSON only: {"best": <index or -1>}`;
  try {
    const j = parseJson(await ask(cands, prompt, 50));
    const b = Number(j?.best);
    return Number.isInteger(b) && b >= 0 && b < cands.length ? b : -1;
  } catch { return -1; }
}

/**
 * Rank the candidate photos best-first for use as the package-front source.
 * Returns up to `top` indices (best first); empty if none show the package.
 * Used to RETRY: if the best pick's tile fails verification, try the next.
 */
export async function pickFrontRanked(urls: string[], top = 3): Promise<number[]> {
  const cands = urls.slice(0, 8);
  if (!cands.length) return [];
  const prompt = `Above are ${cands.length} candidate product photos, index 0..${cands.length - 1} (in order).\n` +
    `Rank the ones that show the actual RETAIL PRODUCT PACKAGE (can/box/bag/bottle/jar/pouch) with the BRAND LABEL clearly visible, front-facing — best first. Prefer plain white/light backgrounds. ` +
    `EXCLUDE: prepared/cooked food or a serving (e.g. a bowl/plate of soup), recipe/serving-suggestion shots, nutrition panels, back-of-package, lifestyle, and promo art. ` +
    `Return JSON only: {"ranked": [indices best-first, up to ${top}]}. Empty array if none show the package.`;
  try {
    const j = parseJson(await ask(cands, prompt, 60));
    const arr = Array.isArray(j?.ranked) ? j.ranked : [];
    return arr.map((x: any) => Number(x)).filter((i: number) => Number.isInteger(i) && i >= 0 && i < cands.length).slice(0, top);
  } catch { return []; }
}

/**
 * Verify a GENERATED main image (often the product tiled in a grid) is acceptable
 * to publish: the product is shown FRONT-facing. Reject back/nutrition/pure-promo.
 * The publish gate — false → do not push.
 */
export async function verifyMainImage(url: string, packCount?: number): Promise<{ ok: boolean; kind: string }> {
  const cnt = packCount && packCount >= 2
    ? ` It should show about ${packCount} identical units; reject if the count is clearly wrong.`
    : "";
  const prompt = `The image above is a candidate marketplace MAIN image — the retail PACKAGE repeated in a grid to show a multipack.${cnt} Acceptable = every unit is the product's UPRIGHT FRONT (the standing package with its brand label toward the camera). Reject if it is: the BACK/side or a visible barcode, a Nutrition-Facts panel, an infographic/marketing graphic, prepared/served food (a bowl/plate), or a soft package (bread loaf) LYING on its side/end so you see the end-slice instead of the standing front. Reply with JSON only: {"ok": true|false, "kind": "front|lying|back|nutrition|infographic|serving|promo|other"}`;
  try {
    const j = parseJson(await ask([url], prompt, 40, STRONG_MODEL));
    return { ok: j?.ok === true, kind: String(j?.kind || "other") };
  } catch {
    return { ok: false, kind: "error" }; // can't verify → do not publish
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STRONG selector (Sonnet) — the reliable replacement for pickFrontRanked. It
// classifies EACH candidate photo and picks the best UPRIGHT SINGLE-UNIT FRONT,
// rejecting back/side/barcode, nutrition panels, infographics, lifestyle/serving,
// multi-pack bundles, and loaves lying on their end. See vision review 2026-06-30.
// ─────────────────────────────────────────────────────────────────────────────

export interface PhotoClass {
  type: "front" | "back" | "nutrition" | "infographic" | "lifestyle" | "other" | "error";
  orientation: "standing" | "lying" | "na";
  barcode: boolean;
  whiteBg: boolean;
  goodFront: boolean;
  conf: number;
}

const CLASSIFY_PROMPT = `You are choosing photos for an e-commerce MAIN image of a packaged grocery product. Classify THIS one photo. Return JSON only:
{"type":"front|back|nutrition|infographic|lifestyle|other","orientation":"standing|lying|na","barcode":true|false,"whiteBg":true|false,"goodFront":true|false,"conf":0.0-1.0}
- type "front" = the sealed retail PACKAGE with its BRAND NAME label facing the camera.
- Soft/floppy package (bread loaf/bag): "standing" = the loaf stands vertically (tall), its printed front label facing you; "lying" = it lies flat and you mainly see the top or the cut-END/side panel. Rigid box/can/bottle = "na".
- "barcode": true if a UPC barcode strip is clearly visible (that side is the BACK/side, not the front).
- "whiteBg": true only if the background is plain WHITE or very light grey (Walmart requires a white main-image background); false for colored/orange/lifestyle backgrounds.
- "goodFront": true ONLY if type=front AND (standing or na) AND barcode=false AND it is a SINGLE package with the brand label clearly readable. Otherwise false.
Reject as NOT goodFront: back/side, nutrition panels, infographics with callout text, lifestyle/prepared-food, a loaf lying showing its end/slice face, multi-pack bundles, or any photo with a visible barcode.`;

export async function classifyProductPhoto(url: string): Promise<PhotoClass> {
  const fallback: PhotoClass = { type: "error", orientation: "na", barcode: false, whiteBg: false, goodFront: false, conf: 0 };
  const cached = await classFromCache(url, STRONG_MODEL);
  if (cached) return cached; // ~free — the big re-run cost saver
  try {
    const j = parseJson(await ask([url], CLASSIFY_PROMPT, 120, STRONG_MODEL));
    if (!j) return fallback;
    const out: PhotoClass = {
      type: j.type ?? "other", orientation: j.orientation ?? "na",
      barcode: j.barcode === true, whiteBg: j.whiteBg === true, goodFront: j.goodFront === true,
      conf: typeof j.conf === "number" ? j.conf : 0,
    };
    await classToCache(url, STRONG_MODEL, out);
    return out;
  } catch { return fallback; }
}

/** From a MIXED-variant pool (e.g. many Nissin flavors), keep only the fronts that
 *  are the SAME product + SAME flavor/variant as the listing — so we never tile the
 *  wrong flavor. Returns matching urls; empty if none clearly match (caller falls back). */
async function filterMatchingVariant(urls: string[], listingTitle: string): Promise<string[]> {
  const cands = urls.slice(0, 8);
  if (cands.length < 2) return cands;
  const prompt = `The listing is: "${listingTitle}". Above are ${cands.length} candidate product photos, index 0..${cands.length - 1} (in order). Which show the SAME product as the listing — same brand AND the SAME flavor/variant? Match the flavor EXACTLY: e.g. "Korean Spicy Beef" must NOT match "Teriyaki Chicken"; "Whole Wheat" must NOT match "White". Return JSON only: {"match":[indices that are the same product+flavor]}. Empty array if none clearly match.`;
  try {
    const j = parseJson(await ask(cands, prompt, 60, STRONG_MODEL));
    const arr = Array.isArray(j?.match) ? j.match : [];
    return arr.map((i: any) => cands[Number(i)]).filter((u: any): u is string => typeof u === "string");
  } catch { return []; }
}

/** Pick the single best UPRIGHT FRONT photo to tile. Returns its url + class, or
 *  null if NO good product-front exists in the pool (→ enrich / manual / skip).
 *  Pass listingTitle so a mixed-flavor pool doesn't yield the wrong variant, and
 *  prefer a WHITE background (Walmart main-image rule). */
export async function pickBestFront(urls: string[], opts?: { listingTitle?: string; preferUrl?: string }): Promise<{ url: string; cls: PhotoClass } | null> {
  // DONOR-FIRST shortcut: the donor's OWN primary image is almost always a clean
  // white-bg front of the correct product+flavor (Walmart requires a white main).
  // Verify just IT (1 call) — if it's a good white-bg front, use it and skip
  // classifying the whole pool. Turns the common case from 16 calls into 1.
  if (opts?.preferUrl) {
    const pc = await classifyProductPhoto(opts.preferUrl);
    if (pc.goodFront && pc.conf >= 0.6 && pc.whiteBg) return { url: opts.preferUrl, cls: pc };
  }
  const cands = urls.slice(0, 16);
  if (!cands.length) return null;
  const cls = await Promise.all(cands.map((u) => classifyProductPhoto(u)));
  const all = cls.map((c, i) => ({ url: cands[i], cls: c }));
  let fronts = all.filter((x) => x.cls.goodFront && x.cls.conf >= 0.6);
  // LENIENT FALLBACK (Vladimir 2026-07-01): don't return "no photo" when a USABLE
  // front exists. If nothing passed the strict goodFront gate, take the best real
  // front the classifier saw — type=front, not lying, no barcode — even if it
  // wasn't flagged "goodFront" (imperfect background / lower confidence). An
  // imperfect real front beats an empty listing. Only pure lifestyle / nutrition /
  // infographic / back stay excluded.
  if (!fronts.length) {
    fronts = all.filter((x) => x.cls.type === "front" && x.cls.orientation !== "lying" && !x.cls.barcode);
  }
  if (!fronts.length) return null;

  // Flavor/variant match — drop wrong-flavor fronts from a mixed pool.
  if (opts?.listingTitle && fronts.length > 1) {
    const matched = await filterMatchingVariant(fronts.map((f) => f.url), opts.listingTitle);
    const kept = fronts.filter((f) => matched.includes(f.url));
    if (kept.length) fronts = kept; // else keep all (don't strand on a fuzzy match)
  }

  // Prefer WHITE background (Walmart rule), then a full standing package, then conf.
  fronts.sort((a, b) =>
    (Number(b.cls.whiteBg) - Number(a.cls.whiteBg)) ||
    (Number(b.cls.orientation === "standing") - Number(a.cls.orientation === "standing")) ||
    (b.cls.conf - a.cls.conf));
  return fronts[0] ?? null;
}

/** RESCUE pick (Vladimir's approach): when the per-image strict gate leaves a SKU
 *  with no main, show the WHOLE pool to Sonnet in ONE call and let it choose the
 *  single best product-front directly — comparative judgment beats per-image
 *  pass/fail, and the prompt is practical (a standing bread loaf with its label
 *  facing the camera IS a valid front). Returns the chosen url, or null if the
 *  pool genuinely has no package front. */
export async function pickBestFrontFromPool(urls: string[], listingTitle: string): Promise<string | null> {
  const cands = urls.slice(0, 12); // one multi-image call (token budget)
  if (!cands.length) return null;
  const prompt = `Listing: "${listingTitle}". Above are ${cands.length} candidate photos, index 0..${cands.length - 1} in order. Pick the index of the SINGLE best photo to use as the MAIN product image — the clearest view of the retail PACKAGE with its brand label facing the camera.
IMPORTANT: a bread loaf, bun bag, or other SOFT package standing with its printed FRONT label toward the camera IS a valid front — accept it. A rigid box/can/bottle shown normally is a valid front.
Reject ONLY: prepared/served food (a bowl, plate, sandwich, or serving scene), a Nutrition-Facts panel, a marketing infographic that is mostly callout text, or the BACK/side with a visible barcode.
Prefer a plain WHITE background and the flavor/variant that matches the listing. Return JSON only: {"index": N} for the best, or {"index": -1} if NONE of them show the product package front.`;
  try {
    const j = parseJson(await ask(cands, prompt, 40, STRONG_MODEL));
    const i = Number(j?.index);
    return Number.isInteger(i) && i >= 0 && i < cands.length ? cands[i] : null;
  } catch { return null; }
}

/** Keep/replace gate: is the CURRENT main image already an acceptable multipack
 *  main — a grid of UPRIGHT product FRONTS in ~the right count? If yes we leave it
 *  alone (no churn); if no (lying/back/serving/nutrition/infographic) we replace. */
export async function mainImageAcceptable(url: string, packCount: number): Promise<{ good: boolean; subject: string }> {
  const prompt = `This is the CURRENT main image of a multipack listing selling ${packCount} units (the same package repeated in a grid). First judge how the package is shown, then decide.
"subject": "front" = UPRIGHT STANDING package, brand label toward camera; "lying" = a soft package (bread loaf/bag) lying flat/horizontal or shown from its end-slice/side (even if the brand label is visible — lying is NOT acceptable, we require it standing upright); "back" = back/side or visible barcode; "nutrition"; "infographic"; "serving" = prepared/served food (bowl/plate); "other".
"good": true ONLY if subject="front" (upright standing, or a rigid box/can/bottle shown normally) AND it depicts roughly ${packCount} units. For bread/soft packages a LYING/end-slice orientation is good=false even with a readable label.
Return JSON only: {"subject":"front|lying|back|nutrition|infographic|serving|other","good":true|false}`;
  try {
    const j = parseJson(await ask([url], prompt, 50, STRONG_MODEL));
    return { good: j?.good === true, subject: String(j?.subject || "other") };
  } catch {
    return { good: false, subject: "error" };
  }
}
