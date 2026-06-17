// Vision helpers for the Listing Optimizer image fix.
//
// Wave 1 tiled whatever image came first — often the nutrition/back/lifestyle/
// promo shot → ugly main images. These use a vision model (OpenAI gpt-4o-mini)
// to (1) PICK the cleanest front-on-white product photo from a candidate pool,
// and (2) VERIFY the generated tile before we ever publish it. The verify step
// is the "do no harm" guard: if the result isn't a clean product image, we do
// NOT push it.

const MODEL = "gpt-4o-mini";

async function chat(content: any[], maxTokens = 80): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(30000),
  });
  const j: any = await r.json();
  return j?.choices?.[0]?.message?.content || "";
}
function parseJson(t: string): any { try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return null; } }

/**
 * From candidate product photos, pick the ONE best suited as a marketplace MAIN
 * image (single unit, front-facing, plain/white background). Returns the index
 * into `urls`, or -1 if none qualifies. One vision call.
 */
export async function pickCleanFrontIndex(urls: string[]): Promise<number> {
  const cands = urls.slice(0, 8);
  if (!cands.length) return -1;
  const content: any[] = [{
    type: "text",
    text: `You are given ${cands.length} candidate product photos, index 0..${cands.length - 1}.\n` +
      `Pick the ONE best suited as a marketplace MAIN product image: a single product unit, shown FRONT-facing, on a PLAIN WHITE/light background. ` +
      `Reject nutrition-facts/back-of-package, lifestyle, promotional/marketing-art, and multi-product images. ` +
      `If NONE is a clean front-on-white, return -1.\nReply JSON only: {"best": <index or -1>, "kind": "front|back|nutrition|lifestyle|promo|none"}`,
  }];
  cands.forEach((u) => content.push({ type: "image_url", image_url: { url: u, detail: "low" } }));
  try {
    const j = parseJson(await chat(content, 60));
    const b = Number(j?.best);
    return Number.isInteger(b) && b >= 0 && b < cands.length ? b : -1;
  } catch { return -1; }
}

/**
 * Verify a GENERATED main image (usually a tile of the product repeated) is
 * acceptable to publish: shows the product front-facing on a clean background.
 * The publish gate — false → do not push.
 */
export async function verifyMainImage(url: string): Promise<{ ok: boolean; kind: string }> {
  try {
    const j = parseJson(await chat([
      { type: "text", text: 'This is a candidate marketplace MAIN image (it may be the same product photo repeated in a grid to show a multipack). Is it acceptable — the product shown FRONT-facing on a clean/white background, NOT a nutrition-facts/back/lifestyle/promo image? JSON only: {"ok": true|false, "kind": "front|back|nutrition|lifestyle|promo|other"}' },
      { type: "image_url", image_url: { url, detail: "low" } },
    ], 40));
    return { ok: j?.ok === true, kind: String(j?.kind || "other") };
  } catch {
    return { ok: false, kind: "error" }; // can't verify → do not publish
  }
}
