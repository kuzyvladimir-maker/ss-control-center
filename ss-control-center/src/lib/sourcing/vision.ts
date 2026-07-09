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
import { identifyImageViaCodex, identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";
import { identifyImageViaGemini } from "./gemini-vision";

const MODEL = CLAUDE.cheap; // cheap + vision-capable (legacy pickers)
// Quality-critical selection/verification uses a stronger model: Haiku could not
// tell a bread loaf's UPRIGHT FRONT from a LYING end-slice or a barcode BACK, so
// it tiled torец/back/nutrition/infographic shots. Sonnet + explicit orientation
// & barcode rules fixes that (verified against real donor pools 2026-06-30).
const STRONG_MODEL = CLAUDE.balanced;
// Bump when the CLASSIFY_PROMPT rules change so the cache doesn't serve stale
// classifications made under the old prompt (cache key = model + this version).
const CLASSIFY_VER = "v2-solo";
const CLASSIFY_KEY = `${STRONG_MODEL}@${CLASSIFY_VER}`;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

// Vision provider: the FREE ChatGPT-subscription path (GPT-5.4, high reasoning, via
// the Codex worker on the box, $0/call) is PRIMARY, paid Anthropic (Sonnet) is the
// RESERVE — mirrors identify.ts. Force one with SS_VISION_PROVIDER=codex|anthropic;
// default "auto" = Codex-first, Sonnet-reserve. NOTE the Codex worker is a SERIAL
// ~23s/call queue shared with Bundle Factory image gen, so a large sweep must keep
// per-SKU calls low (batch multi-image where possible).
function visionProvider(): "codex" | "claude" | "gemini" | "anthropic" | "auto" {
  const p = (process.env.SS_VISION_PROVIDER || "auto").toLowerCase();
  return p === "codex" || p === "claude" || p === "gemini" || p === "anthropic" ? p : "auto";
}
// In-flight counters for the THREE free lanes (Codex + Claude CLI + Gemini API).
// The dispatcher sends each call to the lane with FEWER calls in flight (load-
// balance), so the idler/faster lane naturally takes more work and a rate-limited
// lane sheds to the others — better than a fixed round-robin.
let _codexInflight = 0;
let _claudeInflight = 0;
let _geminiInflight = 0;
// Per-lane cooldown (circuit breaker): when a lane errors (hits its subscription/
// free-tier limit) we mark it "down" for a cooldown window and stop routing to it,
// so the load converges onto the healthy lane (Claude, biggest headroom). Retried
// automatically once the window passes. Owner's "use all 3, then coast on Claude".
let _codexDownUntil = 0;
let _claudeDownUntil = 0;
let _geminiDownUntil = 0;

// Vision only needs enough pixels to read the package label and count the units — not
// the full 2200×2200 PNG we render for Walmart. Shipping the raw tile cost us dearly:
//   • 2200px PNG  → 1.85 MB of base64 PER CALL
//   • codex persists every call's transcript WITH the embedded image → +4.3 GB/day,
//     which filled the box's disk (158G) and made nginx 500 on every image (it must
//     buffer bodies >~16KB to a temp file).
//   • large bodies are also slower to upload/encode on every single call.
// 1536px JPEG q85 is 6.6× smaller (287 KB b64) and still leaves ~384px per cell on a
// 12-unit tile — enough to read "Seasoned Twisted" vs "Dipping Sticks", which is what
// the wrong-variant gate depends on. 1024px (256px/cell) was measured as too tight.
// All three lanes accept JPEG: gemini sniffs the mime from the base64 magic bytes
// ("/9j/"), and the codex/claude worker detects format from content.
const VISION_MAX_PX = Number(process.env.SS_VISION_MAX_PX ?? 1536);
const VISION_JPEG_Q = Number(process.env.SS_VISION_JPEG_Q ?? 85);

async function downscaleForVision(raw: Buffer): Promise<Buffer> {
  if (VISION_MAX_PX <= 0) return raw; // escape hatch / A-B control: send the original bytes
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(raw)
      .resize(VISION_MAX_PX, VISION_MAX_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: VISION_JPEG_Q })
      .toBuffer();
  } catch {
    return raw; // never fail a QC call over an encode hiccup — send the original
  }
}

async function fetchB64(url: string): Promise<string | null> {
  // Retry transient failures. The R2 public dev endpoint (pub-*.r2.dev) intermittently
  // returns a Cloudflare 5xx "Internal Error" HTML page under load, and a single-shot
  // fetch would return null → the caller skips the free lanes → the whole qualify call
  // fails with "tile qualify error" on a perfectly good image. A few backoff retries
  // make image qualification robust to that flakiness (2xx eventually wins).
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return (await downscaleForVision(Buffer.from(await r.arrayBuffer()))).toString("base64");
    } catch { /* transient — retry */ }
    if (a < 3) await new Promise((res) => setTimeout(res, 600 * (a + 1)));
  }
  return null;
}

async function ask(imageUrls: string[], prompt: string, maxTokens = 80, model: string = MODEL): Promise<string> {
  const provider = visionProvider();
  // Retry budget for the FREE lanes: rate-limits are transient, so on an all-lanes
  // miss we WAIT (backoff — which also self-throttles and eases the limit) and retry
  // before giving up. This is the fix for the "found the donor but the tile-check
  // errored on a throttle → marked FAIL" undercount (branch B). Tune via env.
  const RETRIES = Math.max(0, Number(process.env.SS_VISION_RETRIES ?? 3));
  // TIER 1 — FREE lanes, $0: Codex (GPT-5.4) + Claude CLI (Sonnet) + Gemini API.
  // "auto" load-balances least-in-flight-first with cross-fallback; multi-image uses
  // the native-multi lanes (Gemini/Codex). The object is re-stringified so callers'
  // parseJson works. After RETRIES: a forced free provider gives up (do-no-harm);
  // "auto" drops to the paid Sonnet reserve below.
  if (provider !== "anthropic") {
    let b64s: string[] = [];
    try { b64s = (await Promise.all(imageUrls.map(fetchB64))).filter((b): b is string => !!b); } catch { /* fetch fail → paid reserve */ }
    if (b64s.length === imageUrls.length && b64s.length > 0) {
      const codex = async () => { _codexInflight++; try { return await identifyImageViaCodex(b64s, prompt); } finally { _codexInflight--; } };
      const claude = async () => { _claudeInflight++; try { return await identifyImageViaClaudeCli(b64s, prompt); } finally { _claudeInflight--; } };
      const gemini = async () => { _geminiInflight++; try { return await identifyImageViaGemini(b64s, prompt); } finally { _geminiInflight--; } };
      const once = async (): Promise<Record<string, unknown> | null> => {
        if (provider === "claude") return claude();
        if (provider === "codex") return codex();
        if (provider === "gemini") return gemini();
        // Use ALL THREE lanes in parallel while healthy; when a lane errors (hits its
        // limit) COOL IT DOWN and skip it, so the load coasts onto Claude (biggest
        // subscription). Score = (in-flight+1)×weight (Claude cheapest → preferred);
        // Codex last (weak $20). Multi-image skips serial-read Claude.
        // Lane priority (lower weight = preferred). FLIPPED 2026-07-07: the Claude
        // lane burns the owner's Max 20x subscription, which is shared with the
        // OpenClaw agents and all Claude Code chats — a day of bulk vision runs ate
        // ~half the weekly cap. Gemini (free tier, own quota) goes first, Codex
        // (ChatGPT sub, upgrading to Pro) second, Claude LAST-RESORT reserve.
        const W_CLAUDE = Number(process.env.SS_W_CLAUDE ?? 5);
        const W_GEMINI = Number(process.env.SS_W_GEMINI ?? 1);
        const W_CODEX = Number(process.env.SS_W_CODEX ?? 2);
        const COOLDOWN = Number(process.env.SS_LANE_COOLDOWN_MS ?? 45000);
        const now = Date.now();
        type Lane = { fn: () => Promise<Record<string, unknown> | null>; score: number; down: number; cool: () => void; clear: () => void };
        const all: Lane[] = [
          { fn: claude, score: (_claudeInflight + 1) * W_CLAUDE, down: _claudeDownUntil, cool: () => { _claudeDownUntil = Date.now() + COOLDOWN; }, clear: () => { _claudeDownUntil = 0; } },
          { fn: gemini, score: (_geminiInflight + 1) * W_GEMINI, down: _geminiDownUntil, cool: () => { _geminiDownUntil = Date.now() + COOLDOWN; }, clear: () => { _geminiDownUntil = 0; } },
          { fn: codex, score: (_codexInflight + 1) * W_CODEX, down: _codexDownUntil, cool: () => { _codexDownUntil = Date.now() + COOLDOWN; }, clear: () => { _codexDownUntil = 0; } },
        ].filter((_, i) => b64s.length <= 2 || i !== 0); // multi-image: drop serial Claude (index 0)
        let avail = all.filter((l) => now >= l.down);
        if (!avail.length) avail = all; // all cooling → try anyway (may have recovered)
        avail.sort((a, b) => a.score - b.score);
        let r: Record<string, unknown> | null = null;
        for (const l of avail) { r = await l.fn(); if (r) { l.clear(); break; } l.cool(); }
        return r;
      };
      for (let a = 0; a <= RETRIES; a++) {
        try { const r = await once(); if (r && typeof r === "object") return JSON.stringify(r); } catch { /* transient */ }
        if (a < RETRIES) await new Promise((res) => setTimeout(res, 2500 * (a + 1) * (a + 1))); // 2.5s, 10s, 22.5s …
      }
    }
    if (provider !== "auto") throw new Error(`${provider} vision unavailable after ${RETRIES} retries`);
  }
  // TIER 2 — paid Anthropic reserve (Sonnet). Only for "auto" (after free retries) or
  // forced "anthropic". Sends image URLs directly.
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
- "goodFront": true ONLY if type=front AND whiteBg=true AND (standing or na) AND barcode=false AND it shows ONE SINGLE product package ALONE with the brand label clearly readable. Otherwise false. The WHITE background is required — Walmart's main-image rule; a photo on a colored/red/orange/blue background, a marketing banner, or a busy scene is NOT goodFront even if the package is clearly visible.
Reject as NOT goodFront: back/side, nutrition panels, infographics with callout text, lifestyle/prepared-food, a loaf lying showing its end/slice face, multi-pack bundles, or any photo with a visible barcode.
ALSO reject as NOT goodFront if the photo shows the product together with ANY OTHER distinct item or prop — e.g. a cup, bowl, plate, a second/different product, a free-gift item, or a "2-pack/X-pack offer" bundle graphic. We want the product BY ITSELF, nothing else in the frame.
ALSO reject as NOT goodFront if the photo shows MORE THAN ONE unit of the product — a group, row, stack, or pile of 2+ identical packages/cups/cans. We tile a SINGLE unit into a grid ourselves, so the source MUST be exactly ONE unit; a photo already showing several units would multiply into a wrong, cluttered count.`;

export async function classifyProductPhoto(url: string): Promise<PhotoClass> {
  const fallback: PhotoClass = { type: "error", orientation: "na", barcode: false, whiteBg: false, goodFront: false, conf: 0 };
  const cached = await classFromCache(url, CLASSIFY_KEY);
  if (cached) return cached; // ~free — the big re-run cost saver
  try {
    const j = parseJson(await ask([url], CLASSIFY_PROMPT, 120, STRONG_MODEL));
    if (!j) return fallback;
    const out: PhotoClass = {
      type: j.type ?? "other", orientation: j.orientation ?? "na",
      barcode: j.barcode === true, whiteBg: j.whiteBg === true, goodFront: j.goodFront === true,
      conf: typeof j.conf === "number" ? j.conf : 0,
    };
    await classToCache(url, CLASSIFY_KEY, out);
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
  // The shortcut is UNSAFE when a listingTitle is given: preferUrl is the pool's
  // first image, which — because donor pools got polluted with same-brand but
  // DIFFERENT-variant products — may be a clean front of the WRONG product. When
  // we know the listing, do the full variant-aware selection below instead so we
  // pick a SAME-variant front, not merely the first clean one. (2026-07-01 fix.)
  if (opts?.preferUrl && !opts?.listingTitle) {
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
    // Still require a WHITE background here — that's what excludes marketing
    // banners / lifestyle / infographics (all colored bg). We only relax the
    // classifier's "goodFront" perfectionism, not the white-background rule.
    fronts = all.filter((x) => x.cls.type === "front" && x.cls.whiteBg && x.cls.orientation !== "lying" && !x.cls.barcode);
  }
  if (!fronts.length) return null;

  // Flavor/variant match — drop wrong-flavor fronts from a mixed pool. FAIL-CLOSED
  // (2026-07-01 fix): if we know the listing and NONE of the fronts are the same
  // product+variant, return null rather than tiling a wrong-variant front. The old
  // "keep all on no match" is exactly what let a generic same-brand front (e.g.
  // Pepperidge "Soft White" buns) land on a different product (rye / hot-dog / Sara
  // Lee). A downstream identity gate double-checks, but we never even offer a
  // known-wrong candidate here.
  if (opts?.listingTitle && fronts.length > 1) {
    const matched = await filterMatchingVariant(fronts.map((f) => f.url), opts.listingTitle);
    const kept = fronts.filter((f) => matched.includes(f.url));
    if (kept.length) fronts = kept;
    else return null;
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
  const prompt = `Listing: "${listingTitle}". Above are ${cands.length} candidate photos, index 0..${cands.length - 1} in order. Pick the index of the photo that best works as the MAIN image: ONE SINGLE retail PRODUCT PACKAGE shown BY ITSELF, its front/brand label toward the camera, on a PLAIN WHITE background.
ACCEPT: a rigid box / can / bottle shown normally; OR a soft package (bread loaf, bun bag) STANDING with its printed front label facing you — as long as it is ONE unit on a white/very-light background.
REJECT — do NOT pick these; return {"index": -1} if they are all you have:
- a NON-WHITE / colored / red / orange / blue background, or any marketing BANNER with large text overlays (e.g. "MADE FROM 100% FRESH ROMA TOMATOES", "THE START TO GREAT-TASTING MEALS");
- lifestyle / serving / recipe scenes (a hand, a bowl or plate of prepared food, a kitchen scene) — even if a package appears in it;
- Nutrition-Facts or Ingredients panels, or infographics that are mostly callout text;
- the BACK / side, or a visible barcode;
- MORE THAN ONE unit in the photo — a case, flat, tray, row, stack, or group of several packages/cans/cups (we tile a SINGLE unit ourselves; a multi-unit source multiplies into a hugely wrong count — DANGEROUS);
- the product shown together with OTHER items or props (a cup, bowl, second product, free gift) or a "2-pack / X-pack offer" bundle.
It is BETTER to return {"index": -1} (we will then search other retailers) than to pick a colored-background, banner, lifestyle, infographic, multi-unit, or bundle photo. Prefer the flavor/variant matching the listing. Return JSON only: {"index": N} for a CLEAN single product-package front on white, or {"index": -1} if none qualify.`;
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

/**
 * IDENTITY GATE (fail-closed) — the fix for the 2026-07-01 wrong-image batch.
 *
 * Does the package in this photo depict the SAME product as the listing —
 * same BRAND, same product TYPE, and same FLAVOR/VARIANT? Called right before we
 * tile+publish a donor as a listing's MAIN image, so a generic same-brand front
 * (the polluted-pool failure mode) can never be published on a different product.
 * Returns match:false on any error/ambiguity — we would rather leave the current
 * image untouched (do-no-harm) than publish a mismatch.
 */
export async function frontMatchesListing(url: string, listingTitle: string): Promise<{ match: boolean; reason: string }> {
  if (!listingTitle) return { match: false, reason: "no listing title" };
  const prompt = `Listing title: "${listingTitle}".
The image above is a single retail product package we intend to use as this listing's MAIN photo.
Read the BRAND NAME and the FLAVOR/VARIANT text printed on the package label. Decide if it is the SAME product as the listing title. It MATCHES only if ALL of these hold:
- SAME BRAND (the brand on the package equals the brand in the title, e.g. "Pepperidge Farm" ≠ "Sara Lee");
- SAME product TYPE (hamburger/slider buns ≠ hot-dog buns ≠ sliced sandwich bread ≠ English muffins ≠ bagels);
- SAME FLAVOR/VARIANT (e.g. "Soft White" ≠ "Sweet Hawaiian" ≠ "Whole Wheat" ≠ "Honey Wheat" ≠ "Multigrain" ≠ "Rye" ≠ "Oatmeal" ≠ "Butter").
Judge from the LABEL TEXT you can actually read, not from the general shape/color. If the label is unreadable, or you are not confident it is the same product+variant, answer false.
Return JSON only: {"match": true|false, "brandOnPackage": "<brand>", "variantOnPackage": "<variant>", "reason": "<short why>"}`;
  try {
    const j = parseJson(await ask([url], prompt, 150, STRONG_MODEL));
    const reason = String(j?.reason || [j?.brandOnPackage, j?.variantOnPackage].filter(Boolean).join(" ") || "").slice(0, 90);
    return { match: j?.match === true, reason };
  } catch {
    return { match: false, reason: "identity check error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-UNIT DONOR GATE + PER-LISTING QUALIFICATION AGENT
//
// The 2026-07-04 incident: donor selection on the Walmart-1P / Sam's / Target
// tiers took the raw first-offer image and only checked brand/variant identity.
// It never checked that the photo is ONE single unit — so a "12 Pack" caddy, a
// case, or a shrink-wrapped multipack passed, and tiling it N times produced
// "N multipacks" (a 'pack 4' listing looked like 4 packs of 12). These two gates
// close that hole: qualifyDonorFront vets EVERY candidate before tiling, and
// qualifyTiledMain re-inspects the FINISHED tile point-by-point before publish.
// Both are fail-closed (any error / ambiguity → pass:false, do-no-harm).
// ─────────────────────────────────────────────────────────────────────────────

/** Read the PER-UNIT size from a multipack title (the size of ONE unit, not the
 *  pack). "Cheez-It ... 21 oz (Pack of 4)" → "21 oz"; "Gatorade ... 28 fl oz,
 *  (Pack of 8)" → "28 fl oz". Empty string if no size token is present. */
export function unitSizeFromTitle(title: string): string {
  let t = String(title || "");
  // strip the multipack marker first so we read the PER-UNIT size, not the pack
  t = t.replace(/\(?\s*pack of \d+\s*\)?/ig, " ").replace(/\b\d+\s*-?\s*pack\b/ig, " ");
  const sizes = [...t.matchAll(/\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ounce|ct\b|count|lb|kg|g\b|ml|l\b)/ig)]
    .map((m) => m[0].replace(/\s+/g, " ").trim());
  // First size token = the per-unit size. A multi-size join ("10 oz, 5 oz") would
  // be a confusing "ONE unit =" hint in the prompt; the singleUnit check is
  // independent of this hint anyway, so the primary size is enough.
  return sizes[0] ?? "";
}

export interface DonorVerdict {
  brand: boolean; type: boolean; variant: boolean;
  singleUnit: boolean; front: boolean; whiteBg: boolean;
  pass: boolean; reason: string;
}

/**
 * DONOR QUALIFICATION (fail-closed) — the ONE gate every candidate donor photo
 * must pass before we tile it, in ANY tier (Walmart 1P, Google, Sam's, Target).
 * Judges every point in a single Sonnet call:
 *   brand / type / variant  — same product as the listing (identity)
 *   singleUnit              — EXACTLY ONE sellable unit of the listing's size,
 *                             not a case / caddy / multipack / shrink-pack / row
 *   front / whiteBg         — upright front on a white background (Walmart rule)
 * `pass` = all six true.
 */
export async function qualifyDonorFront(url: string, listingTitle: string, unitSize?: string): Promise<DonorVerdict> {
  const fail = (reason: string): DonorVerdict => ({ brand: false, type: false, variant: false, singleUnit: false, front: false, whiteBg: false, pass: false, reason });
  if (!listingTitle) return fail("no listing title");
  const size = (unitSize || unitSizeFromTitle(listingTitle)).trim();
  const unitLine = size
    ? `This listing sells a pack of a SINGLE retail unit. ONE unit = ${size}.`
    : `This listing sells a pack of a SINGLE retail unit (the base single package named in the title).`;
  const prompt = `Listing title: "${listingTitle}".
${unitLine}
The image above is ONE candidate photo we may TILE to build the multipack main image. Judge each point strictly and INDEPENDENTLY. Return JSON only:
{"brand":true|false,"type":true|false,"variant":true|false,"singleUnit":true|false,"front":true|false,"whiteBg":true|false,"reason":"<short>"}
- "brand": the brand printed on the package equals the brand in the title.
- "type": same product type (e.g. cheese crackers ≠ sandwich crackers; potato chips ≠ tortilla chips; juice bottle ≠ juice box).
- "variant": same flavor/variant line (e.g. "Extra Cheesy" ≠ "Original"; "Lemon Lime" ≠ "Glacier Freeze").
- "singleUnit": TRUE only if the photo shows EXACTLY ONE sellable unit of the size above, BY ITSELF. Answer FALSE if it shows a CASE, a shrink-wrapped multipack, a tray/caddy of several boxes, a row/stack/group of 2+ units, OR a package whose PRINTED pack-count on the front (e.g. "12 PACK", "8 COUNT", "6 CT", "CASE") means the package itself is a BUNDLE of several units rather than the single unit named in the title. We tile ONE unit N times ourselves — a multi-unit source multiplies into a hugely wrong, dangerous quantity.
- "front": the package's UPRIGHT FRONT with the brand label toward the camera — NOT the back/side, NOT a visible barcode, NOT a Nutrition-Facts panel, NOT a soft package lying on its end/side, NOT a prepared-food serving (bowl/plate), NOT an infographic/marketing banner.
- "whiteBg": plain WHITE or very-light background (colored/lifestyle backgrounds are false).`;
  try {
    const j = parseJson(await ask([url], prompt, 140, STRONG_MODEL));
    if (!j) return fail("unparseable");
    const v = {
      brand: j.brand === true, type: j.type === true, variant: j.variant === true,
      singleUnit: j.singleUnit === true, front: j.front === true, whiteBg: j.whiteBg === true,
    };
    const pass = v.brand && v.type && v.variant && v.singleUnit && v.front && v.whiteBg;
    return { ...v, pass, reason: String(j.reason || "").slice(0, 100) };
  } catch {
    return fail("donor qualify error");
  }
}

/** Generic JSON vision question over image URLs — for one-off qualification passes
 *  (e.g. the promo-banner sweep) so scripts don't re-implement lane dispatch. */
export async function askVisionJson(imageUrls: string[], prompt: string, maxTokens = 140): Promise<any> {
  try { return parseJson(await ask(imageUrls, prompt, maxTokens, STRONG_MODEL)); } catch { return null; }
}

export interface TileVerdict {
  identity: boolean; eachCellSingle: boolean; countOk: boolean;
  front: boolean; whiteBg: boolean;
  pass: boolean; reason: string;
}

/**
 * PER-LISTING QUALIFICATION AGENT (fail-closed) — inspects the FINISHED tiled main
 * image point-by-point before it can be published. This is the safety net that
 * catches a multipack donor that slipped the donor gate: if each tile itself shows
 * several units (a "12 pack" box, a 6-bottle shrink-pack, a case), eachCellSingle
 * is false and the listing does NOT pass. `pass` = all points true.
 */
export async function qualifyTiledMain(url: string, listingTitle: string, packCount: number): Promise<TileVerdict> {
  const fail = (reason: string): TileVerdict => ({ identity: false, eachCellSingle: false, countOk: false, front: false, whiteBg: false, pass: false, reason });
  const prompt = `The image above is a FINISHED marketplace MAIN image. We built it by TILING one product unit into a grid to represent a multipack of ${packCount} units of the listing: "${listingTitle}".
Judge each point strictly and INDEPENDENTLY. Return JSON only:
{"identity":true|false,"eachCellSingle":true|false,"countOk":true|false,"front":true|false,"whiteBg":true|false,"reason":"<short>"}
- "identity": the product shown is the SAME brand + type + flavor/variant as the listing title.
- "eachCellSingle": EACH repeated tile shows EXACTLY ONE single retail PACKAGE. CRUCIAL: a single sealed package is ONE unit EVEN IF it naturally holds several loose pieces inside — one bag of 8 hamburger buns, one tray of 6 English muffins, one bag of bagels, one box of 18 tea bags, one bag of tortilla chips, one bag of cookies are EACH one unit and MUST be judged true. The test: are the items in a tile INDIVIDUALLY-SOLD packages bundled together, or loose pieces inside ONE package? Answer FALSE ONLY when a single tile shows SEVERAL SEPARATE packages bundled — a "12 pack"/"6 pack" case of individually-wrapped bottles/cans/boxes, a shrink-wrapped bundle of multiple bottles, a caddy/tray holding several boxes, or a printed multi-pack graphic. (The critical error to catch is a tile that is ITSELF a case/multipack of separate packages — NOT a normal package that happens to contain multiple pieces.)
- "countOk": the total number of repeated units visible in the grid is about ${packCount}.
- "front": every unit is shown FACE-ON — its WIDE FRONT PANEL with the full brand + product name toward the camera, clearly readable. For a SOFT package (bread loaf, bun/bagel bag) this is the long printed FACE; it is FALSE if the loaf stands on its END/heel or is angled so you see mainly the narrow top/side with only a sliver of label (a common bad case — the wide front must face the camera). Also FALSE for back/side/barcode, Nutrition-Facts panel, a package lying down, a serving/prepared food, or an infographic.
- "whiteBg": plain white background.`;
  try {
    const j = parseJson(await ask([url], prompt, 140, STRONG_MODEL));
    if (!j) return fail("unparseable");
    const v = {
      identity: j.identity === true, eachCellSingle: j.eachCellSingle === true,
      countOk: j.countOk === true, front: j.front === true, whiteBg: j.whiteBg === true,
    };
    const pass = v.identity && v.eachCellSingle && v.countOk && v.front && v.whiteBg;
    return { ...v, pass, reason: String(j.reason || "").slice(0, 100) };
  } catch {
    return fail("tile qualify error");
  }
}
