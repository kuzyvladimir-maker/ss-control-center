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

const MODEL = "claude-haiku-4-5-20251001"; // cheap + vision-capable (legacy pickers)
// Quality-critical selection/verification uses a stronger model: Haiku could not
// tell a bread loaf's UPRIGHT FRONT from a LYING end-slice or a barcode BACK, so
// it tiled torец/back/nutrition/infographic shots. Sonnet + explicit orientation
// & barcode rules fixes that (verified against real donor pools 2026-06-30).
const STRONG_MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

async function ask(imageUrls: string[], prompt: string, maxTokens = 80, model = MODEL): Promise<string> {
  const c = getClient();
  if (!c) throw new Error("ANTHROPIC_API_KEY missing");
  const content: any[] = imageUrls.map((u) => ({ type: "image", source: { type: "url", url: u } }));
  content.push({ type: "text", text: prompt });
  const res = await c.messages.create({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] });
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}
function parseJson(t: string): any { try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return null; } }

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
  goodFront: boolean;
  conf: number;
}

const CLASSIFY_PROMPT = `You are choosing photos for an e-commerce MAIN image of a packaged grocery product. Classify THIS one photo. Return JSON only:
{"type":"front|back|nutrition|infographic|lifestyle|other","orientation":"standing|lying|na","barcode":true|false,"goodFront":true|false,"conf":0.0-1.0}
- type "front" = the sealed retail PACKAGE with its BRAND NAME label facing the camera.
- Soft/floppy package (bread loaf/bag): "standing" = the loaf stands vertically (tall), its printed front label facing you; "lying" = it lies flat and you mainly see the top or the cut-END/side panel. Rigid box/can/bottle = "na".
- "barcode": true if a UPC barcode strip is clearly visible (that side is the BACK/side, not the front).
- "goodFront": true ONLY if type=front AND (standing or na) AND barcode=false AND it is a SINGLE package with the brand label clearly readable. Otherwise false.
Reject as NOT goodFront: back/side, nutrition panels, infographics with callout text, lifestyle/prepared-food, a loaf lying showing its end/slice face, multi-pack bundles, or any photo with a visible barcode.`;

export async function classifyProductPhoto(url: string): Promise<PhotoClass> {
  const fallback: PhotoClass = { type: "error", orientation: "na", barcode: false, goodFront: false, conf: 0 };
  try {
    const j = parseJson(await ask([url], CLASSIFY_PROMPT, 120, STRONG_MODEL));
    if (!j) return fallback;
    return {
      type: j.type ?? "other", orientation: j.orientation ?? "na",
      barcode: j.barcode === true, goodFront: j.goodFront === true,
      conf: typeof j.conf === "number" ? j.conf : 0,
    };
  } catch { return fallback; }
}

/** Pick the single best UPRIGHT FRONT photo to tile. Returns its url + class, or
 *  null if NO good product-front exists in the pool (→ enrich / manual / skip). */
export async function pickBestFront(urls: string[]): Promise<{ url: string; cls: PhotoClass } | null> {
  const cands = urls.slice(0, 12);
  if (!cands.length) return null;
  const cls = await Promise.all(cands.map((u) => classifyProductPhoto(u)));
  const fronts = cls
    .map((c, i) => ({ url: cands[i], cls: c }))
    .filter((x) => x.cls.goodFront && x.cls.conf >= 0.6);
  // Prefer a full STANDING package over a rigid/ambiguous one, then confidence.
  fronts.sort((a, b) =>
    (Number(b.cls.orientation === "standing") - Number(a.cls.orientation === "standing")) ||
    (b.cls.conf - a.cls.conf));
  return fronts[0] ?? null;
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
