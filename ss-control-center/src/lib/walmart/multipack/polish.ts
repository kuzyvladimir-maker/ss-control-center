// Professional copy polish for Walmart multipack listings (CLAUDE.md Phase
// 2.6.2). Takes the donor's raw parsed bullets + description and asks Claude to
// rewrite them into clean, factual, brand-voice-compliant, keyword-rich listing
// copy. The pack-quantity message is NOT produced here — the caller adds it
// exactly once. Deterministic fallback (caller's scrubbed copy) on any failure.

import Anthropic from "@anthropic-ai/sdk";
import { WALMART_CONTENT_RULES } from "./guidelines";
import { CLAUDE } from "@/lib/ai-models";

const MODEL = CLAUDE.balanced;

export interface PolishInput {
  productName: string;      // brand + product, e.g. "BODYARMOR LYTE Peach Mango"
  donorBullets: string[];
  donorDescription: string;
  contentIssues?: string[]; // known content gaps for THIS listing (closed loop)
}
export interface PolishedCopy {
  keyFeatures: string[];
  description: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

const RULES = `${WALMART_CONTENT_RULES}

Brand voice (Salutem Solutions — STRICT, in addition to the above):
- FORBIDDEN: emojis; promo/subjective adjectives (ultimate, perfect, delightful, delicious, ideal, amazing, incredible, premium, exclusive, must-have, best, finest, exceptional, outstanding, magnificent, wonderful, fantastic, superior, top-quality, world-class, awesome); manual bullet glyphs (•, -, *); health/medical claims (cure, treat, prevent, boost, detox, heal, weight loss).
- Do NOT mention pack count, quantity, "multipack", "N-pack", or "how many ship" — that is handled elsewhere.
- Base everything on the provided donor facts; do not invent specs, certifications, or ingredients.`;

/** Rewrite donor copy into professional listing bullets + description body. */
export async function polishListingCopy(input: PolishInput): Promise<PolishedCopy | null> {
  const c = getClient();
  if (!c) return null;
  const prompt = `You are a professional e-commerce listing copywriter. Rewrite the source material for this product into clean Walmart listing copy.

PRODUCT: ${input.productName}

SOURCE BULLETS:
${input.donorBullets.map((b) => `- ${b}`).join("\n") || "(none)"}

SOURCE DESCRIPTION:
${input.donorDescription || "(none)"}

${RULES}
${input.contentIssues?.length ? `\nThis listing currently has these content gaps to fix:\n${input.contentIssues.map((i) => `- ${i}`).join("\n")}` : ""}

Return ONLY valid JSON, no prose, in this exact shape:
{"keyFeatures": ["...", "...", "...", "...", "..."], "description": "..."}
Provide 5-7 keyFeatures. The description is 150-220 words (about 800-1300 characters), factual and keyword-rich, covering what it is, what's inside, sizes, uses and storage (no pack/quantity mention).`;

  try {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as PolishedCopy;
    if (!Array.isArray(parsed.keyFeatures) || !parsed.keyFeatures.length || !parsed.description) return null;
    // Final safety net: hard-strip any glyphs/quantity the model may have slipped in.
    parsed.keyFeatures = parsed.keyFeatures.map((b) => b.replace(/^[\s•*\-–—]+/, "").trim()).filter(Boolean).slice(0, 7);
    return parsed;
  } catch (e) {
    console.warn(`[polish] Claude rewrite failed, using deterministic fallback: ${(e as Error).message}`);
    return null;
  }
}
