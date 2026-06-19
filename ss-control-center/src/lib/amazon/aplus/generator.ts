/**
 * A+ Content Factory — generation engine (IMAGE-FORWARD).
 *
 * A+ is a visual landing page inside the product card, not a text doc. So we use
 * a fixed, image-forward storyboard where almost every module carries a strong
 * image and the text is SHORT (headline + a sentence). Claude fills the copy +
 * the per-image briefs; we generate 7 images (hero + inside + 4-grid + serve).
 *
 * IP-safe: image briefs depict premium gift-basket LIFESTYLE scenes with NO
 * third-party logos/packaging text; brands are named only in text, factually.
 * Rules: docs/wiki/aplus-content-knowledge-base.md + aplus-ip-giftset-rules.md.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  assembleDocument, headerImageText, singleSideImage, fourImageText, standardText,
  type AplusDocument, type ImageComponent,
} from "./modules";

const MODEL = "claude-opus-4-8";

export const DISCLAIMER =
  "Curated and assembled by Salutem Solutions LLC as a gift basket. The included items are packaged by their original manufacturers.";

let _client: Anthropic | null = null;
function client() { return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })); }

export interface GeneratorInput { sku: string; asin: string | null; itemName: string | null; productType: string | null; brand: string | null }

interface Slot { headline: string; body: string; imageBrief: string; imageAlt: string }
interface GridCell { caption: string; body: string; imageBrief: string; imageAlt: string }
export interface AplusPlan {
  documentName: string;
  hero: Slot;
  inside: Slot;
  grid: { headline: string; cells: GridCell[] };
  serve: Slot;
}

const slotSchema = {
  type: "object", additionalProperties: false,
  properties: {
    headline: { type: "string", description: "Short headline (≤70 chars)." },
    body: { type: "string", description: "1–2 short factual sentences." },
    imageBrief: { type: "string", description: "Image prompt: premium gift-basket LIFESTYLE scene, NO brand logos/packaging text." },
    imageAlt: { type: "string", description: "Keyword-rich alt text ≤100 chars." },
  },
  required: ["headline", "body", "imageBrief", "imageAlt"],
} as const;

const RESULT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    documentName: { type: "string" },
    hero: slotSchema,
    inside: slotSchema,
    grid: {
      type: "object", additionalProperties: false,
      properties: {
        headline: { type: "string", description: "Short section headline." },
        cells: {
          type: "array", description: "EXACTLY 4 cells (use occasions / what's inside / pairings).",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              caption: { type: "string", description: "≤30 char caption." },
              body: { type: "string", description: "1 short sentence." },
              imageBrief: { type: "string", description: "Lifestyle image prompt, NO logos/text." },
              imageAlt: { type: "string" },
            },
            required: ["caption", "body", "imageBrief", "imageAlt"],
          },
        },
      },
      required: ["headline", "cells"],
    },
    serve: slotSchema,
  },
  required: ["documentName", "hero", "inside", "grid", "serve"],
} as const;

const SYSTEM = `You write Amazon A+ Content (Basic) for SALUTEM SOLUTIONS own-brand gift baskets (Salutem Vita / Starfit) that CONTAIN genuine third-party-brand grocery products. A+ is a VISUAL landing page: every module has a strong image and SHORT text. Keep copy tight — headlines short, bodies 1–2 sentences, grid captions ≤30 chars. Do NOT write long paragraphs.

You fill a fixed storyboard: hero (banner), inside (what's in the set), grid (4 lifestyle/use-occasion cells), serve (ways to enjoy). A required disclaimer module is added automatically — do NOT write it.

NON-NEGOTIABLE (a gate rejects violations):
- Brand voice: NO promo adjectives (ultimate/perfect/premium/best/amazing/delicious/ideal…), NO emojis, NO health claims.
- A+ policy: NO pricing/discounts/free, NO shipping, NO guarantee/warranty, NO CTAs (buy now), NO contact/links, NO competitor comparison, NO time-sensitive words, NO eco-friendly/biodegradable, NO #1/best-selling.
- IP (critical): you MAY NAME included third-party brands FACTUALLY in text (e.g. "Includes 8 Oscar Mayer Bun Length Franks"). NEVER imply a relationship (authorized/official/endorsed/partner). IMAGE BRIEFS must depict a premium gift-basket LIFESTYLE scene with NO brand logos, NO packaging text, NO readable labels — generic appetizing food/gift presentation only.
- SEO: weave the product's natural keywords into headlines and image alt-text.

Infer the included items from the title. Return the storyboard.`;

export async function generateAplusPlan(input: GeneratorInput): Promise<AplusPlan> {
  const userPrompt = `Listing:
SKU: ${input.sku} | ASIN: ${input.asin ?? "—"}
Title: ${input.itemName ?? "—"}
Product type: ${input.productType ?? "—"}
Our brand: ${input.brand ?? "Salutem Vita"}

Fill the image-forward storyboard (hero, inside, grid of EXACTLY 4 cells, serve). Short text, IP-safe image briefs.`;

  const resp = await client().messages.create({
    model: MODEL, max_tokens: 4096, thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: SYSTEM, messages: [{ role: "user", content: userPrompt }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("generator returned no plan");
  const plan = JSON.parse(block.text) as AplusPlan;
  // Normalize the grid to exactly 4 cells.
  plan.grid.cells = (plan.grid.cells ?? []).slice(0, 4);
  while (plan.grid.cells.length < 4) plan.grid.cells.push({ caption: "", body: "", imageBrief: plan.hero.imageBrief, imageAlt: "" });
  return plan;
}

export interface ImageSlot { key: string; brief: string; alt: string; landscape: boolean }

/** The 7 image slots to generate for a plan (hero + inside + 4 grid + serve). */
export function imageSlots(plan: AplusPlan): ImageSlot[] {
  return [
    { key: "hero", brief: plan.hero.imageBrief, alt: plan.hero.imageAlt, landscape: true },
    { key: "inside", brief: plan.inside.imageBrief, alt: plan.inside.imageAlt, landscape: false },
    ...plan.grid.cells.map((c, i) => ({ key: `grid${i}`, brief: c.imageBrief, alt: c.imageAlt, landscape: false })),
    { key: "serve", brief: plan.serve.imageBrief, alt: plan.serve.imageAlt, landscape: false },
  ];
}

/** Assemble the API content document. refs maps slot key → uploaded ImageComponent. */
export function assembleFromPlan(plan: AplusPlan, refs: Record<string, ImageComponent> = {}): AplusDocument {
  return assembleDocument(plan.documentName, [
    headerImageText({ headline: plan.hero.headline, body: plan.hero.body, img: refs.hero }),
    singleSideImage({ position: "LEFT", headline: plan.inside.headline, body: plan.inside.body, img: refs.inside }),
    fourImageText({ headline: plan.grid.headline, cells: plan.grid.cells.map((c, i) => ({ headline: c.caption, body: c.body, img: refs[`grid${i}`] })) }),
    singleSideImage({ position: "RIGHT", headline: plan.serve.headline, body: plan.serve.body, img: refs.serve }),
    standardText({ headline: "About This Gift Set", body: DISCLAIMER }),
  ]);
}
