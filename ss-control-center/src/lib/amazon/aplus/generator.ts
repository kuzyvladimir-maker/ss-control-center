/**
 * A+ Content Factory — generation engine.
 *
 * Claude produces a PROFESSIONAL A+ storyboard for an own-brand gift set:
 * SEO/semantic-keyword text + a per-module image brief. Images are premium
 * gift-basket LIFESTYLE scenes with NO third-party logos (the IP-safe choice —
 * third-party brands are named only in TEXT, never logo-forward in imagery).
 *
 * Hard rules encoded in the system prompt (and re-checked by qualification.ts):
 *   docs/wiki/aplus-content-knowledge-base.md + aplus-ip-giftset-rules.md.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  assembleDocument, headerImageText, singleSideImage, standardText, productDescription,
  type AplusDocument, type ImageComponent, type ModuleJSON,
} from "./modules";

const MODEL = "claude-opus-4-8"; // A+ is brand-facing — generate at top quality.

let _client: Anthropic | null = null;
function client() { return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })); }

export interface GeneratorInput {
  sku: string;
  asin: string | null;
  itemName: string | null;
  productType: string | null;
  brand: string | null;
}

export interface PlannedModule {
  kind: "header" | "side" | "text" | "description";
  headline?: string;
  body: string;
  imagePosition?: "LEFT" | "RIGHT";
  imageBrief?: string; // prompt for a premium gift-basket lifestyle image, NO third-party logos
  imageAlt?: string; // keyword-rich alt text (≤100)
}
export interface AplusPlan {
  documentName: string;
  modules: PlannedModule[];
  heroImageBrief: string;
}

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentName: { type: "string", description: "Internal name for the A+ doc (not shown to shoppers)." },
    heroImageBrief: { type: "string", description: "Image-generation prompt for the hero: a premium, professional gift-basket lifestyle scene. NO third-party brand logos or packaging text. Photorealistic, high-res, warm gifting mood." },
    modules: {
      type: "array",
      description: "5–6 modules ideal, hard max 7.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["header", "side", "text", "description"] },
          headline: { type: "string" },
          body: { type: "string" },
          imagePosition: { type: "string", enum: ["LEFT", "RIGHT"] },
          imageBrief: { type: "string", description: "If this module has an image: a prompt for a premium gift-basket lifestyle image, NO third-party logos." },
          imageAlt: { type: "string", description: "Keyword-rich alt text, max 100 chars." },
        },
        required: ["kind", "body"],
      },
    },
  },
  required: ["documentName", "heroImageBrief", "modules"],
} as const;

const SYSTEM = `You write Amazon A+ Content for SALUTEM SOLUTIONS own-brand gift baskets (brands: Salutem Vita / Starfit) that CONTAIN genuine third-party-brand grocery products. Produce a professional, conversion-focused storyboard.

NON-NEGOTIABLE RULES (a downstream gate will reject violations):
- Brand voice: NO promotional adjectives (ultimate/perfect/premium/best/amazing/exclusive/finest/delicious/ideal…), NO emojis, NO health/medical claims (cure/treat/prevent/boost/detox/weight loss). Plain, factual, professional.
- A+ policy: NO pricing/discounts/"free", NO shipping claims, NO guarantee/warranty, NO purchase CTAs ("buy now"), NO contact info or links, NO competitor comparisons, NO time-sensitive words, NO eco-friendly/biodegradable/compostable, NO "#1/best-selling/top-rated".
- INTELLECTUAL PROPERTY (critical): you MAY NAME the included third-party brands FACTUALLY (e.g. "Includes 8 Oscar Mayer Bun Length Franks"). You may NOT use words implying a relationship: authorized/official/endorsed/licensed/partner. NEVER describe third-party LOGOS in image briefs — image briefs depict a generic premium gift-basket lifestyle scene with NO brand logos/packaging text. Do NOT add defensive trademark paragraphs (no "not affiliated", no "trademarks belong to owners").
- REQUIRED: include the curator disclaimer text somewhere in a body field, verbatim: "Curated and assembled by Salutem Solutions LLC as a gift basket. The included items are packaged by their original manufacturers."
- SEO: weave the product's natural semantic keywords into headlines and body (A+ text is a conversion lever; keywords also belong in image alt-text).

STORYBOARD (aim for 5–6 modules, max 7): 1) header (hero) — what the gift basket is; 2) side image — what's inside, naming contents factually; 3) side image — occasions / how to enjoy (factual); 4) text — the curator disclaimer + assembly note; 5) description — factual summary. Keep each body tight and factual.`;

export async function generateAplusPlan(input: GeneratorInput): Promise<AplusPlan> {
  const userPrompt = `Generate an A+ storyboard for this listing:
SKU: ${input.sku}
ASIN: ${input.asin ?? "—"}
Title: ${input.itemName ?? "—"}
Product type: ${input.productType ?? "—"}
Brand (ours): ${input.brand ?? "Salutem Vita"}

Infer the included items from the title. Name third-party brands only factually. Return the storyboard.`;

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("generator returned no plan");
  return JSON.parse(block.text) as AplusPlan;
}

/** Assemble the API content document from a plan + ready image refs (by module
 *  index). Modules whose image isn't ready are emitted as text (still valid +
 *  publishable); the image is an enhancement added once generated. */
export function assembleFromPlan(plan: AplusPlan, imageRefs: Record<number, ImageComponent> = {}): AplusDocument {
  const modules: ModuleJSON[] = [];
  plan.modules.forEach((m, i) => {
    const img = imageRefs[i];
    if (m.kind === "header") modules.push(headerImageText({ headline: (m.headline ?? "").slice(0, 150), body: m.body.slice(0, 6000), img }));
    else if (m.kind === "side" && img) modules.push(singleSideImage({ position: m.imagePosition ?? "LEFT", headline: (m.headline ?? "").slice(0, 160), body: m.body.slice(0, 1000), img }));
    else if (m.kind === "description") modules.push(productDescription({ body: m.body.slice(0, 6000) }));
    else modules.push(standardText({ headline: (m.headline ?? "").slice(0, 160), body: m.body.slice(0, 5000) }));
  });
  return assembleDocument(plan.documentName, modules);
}
