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

const MODEL = "claude-haiku-4-5-20251001"; // cheap + vision-capable

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

async function ask(imageUrls: string[], prompt: string, maxTokens = 80): Promise<string> {
  const c = getClient();
  if (!c) throw new Error("ANTHROPIC_API_KEY missing");
  const content: any[] = imageUrls.map((u) => ({ type: "image", source: { type: "url", url: u } }));
  content.push({ type: "text", text: prompt });
  const res = await c.messages.create({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] });
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
 * Verify a GENERATED main image (often the product tiled in a grid) is acceptable
 * to publish: the product is shown FRONT-facing. Reject back/nutrition/pure-promo.
 * The publish gate — false → do not push.
 */
export async function verifyMainImage(url: string): Promise<{ ok: boolean; kind: string }> {
  const prompt = 'The image above is a candidate marketplace MAIN image (it may be the same product photo repeated in a grid to show a multipack). Acceptable = the product is shown FRONT-facing (front/label clearly visible). Reject ONLY if it is a back-of-package, nutrition-facts panel, or pure promo/marketing art with no clear product front. Reply with JSON only: {"ok": true|false, "kind": "front|back|nutrition|lifestyle|promo|other"}';
  try {
    const j = parseJson(await ask([url], prompt, 40));
    return { ok: j?.ok === true, kind: String(j?.kind || "other") };
  } catch {
    return { ok: false, kind: "error" }; // can't verify → do not publish
  }
}
