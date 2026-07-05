// VISION via the Google Gemini API (THIRD free vision lane).
//
// A direct HTTPS call to generativelanguage.googleapis.com (not a box worker) —
// so it runs truly in parallel with the Codex + Claude lanes and doesn't share
// their subscription rate limits. Free tier + very cheap beyond it.
//
// Model is configurable (GEMINI_VISION_MODEL). Default gemini-2.5-flash: it's what
// this key can actually call (gemini-2.5-pro 404s / errors on Jimmy's tier), and it
// hit 6/6 parity with Sonnet on the single-unit donor gate (2026-07-05) — meets the
// owner's "no worse than Sonnet" bar on the structural calls. It's a smaller model,
// so on the hardest IDENTITY calls (near-identical bread brands) trust the 3-lane
// consensus over any one lane. `responseMimeType: application/json` makes Gemini
// return a clean JSON object (no code fences), so callers' parseJson works.

const GEMINI_KEY = () => (process.env.GEMINI_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
const GEMINI_MODEL = () => (process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash").trim();

function mediaType(b64: string): string {
  return b64.startsWith("/9j/") ? "image/jpeg"
    : b64.startsWith("iVBOR") ? "image/png"
    : b64.startsWith("R0lG") ? "image/gif"
    : b64.startsWith("UklG") ? "image/webp"
    : "image/jpeg";
}

/**
 * Analyze image(s) with Gemini and return the parsed JSON object, or null if the
 * key is unset / the call fails / the answer isn't JSON (caller then falls back to
 * another lane). Mirrors identifyImageViaCodex / identifyImageViaClaudeCli.
 */
export async function identifyImageViaGemini(
  b64Images: string[],
  prompt: string,
  opts?: { timeoutMs?: number; model?: string },
): Promise<Record<string, unknown> | null> {
  const key = GEMINI_KEY();
  if (!key || !b64Images.length) return null;
  const model = opts?.model || GEMINI_MODEL();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const parts: any[] = b64Images.map((b) => ({ inline_data: { mime_type: mediaType(b), data: b } }));
  parts.push({ text: prompt });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const text: string | undefined = j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("") || undefined;
    if (!text) return null;
    // responseMimeType=json → text IS the JSON object; parse defensively anyway.
    try { return JSON.parse(text); } catch {}
    const m = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try { return JSON.parse(m); } catch { return null; }
  } catch {
    return null;
  }
}
