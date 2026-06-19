/**
 * A+ Content Factory — generation engine (CONVERSION-PLAYBOOK storyboard).
 *
 * Storyboard + rules are baked from verified research (docs/wiki/aplus-conversion-
 * playbook.md): A+ is an image-led, mobile-first, scannable landing page. Basic A+
 * = 5 modules, so we use the best-supported food/gift-set order:
 *   1) HERO banner — headline states the PRIMARY BENEFIT (not just the name)
 *   2) BRAND STORY — short factual "why / who it's for" (curator framing)
 *   3) TOP 3 BENEFITS — 3-image block, each a benefit + short caption
 *   4) HOW-TO / WAYS TO SERVE — usage module that removes "how do I use it" anxiety
 *   5) WHAT'S INSIDE — factual contents in LIVE text + the curator disclaimer
 *
 * Copy is short & benefit-first; never baked into images (mobile reflow). Images are
 * premium gift-basket LIFESTYLE scenes, NO third-party logos (brands named in text only).
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  assembleDocument, headerImageText, singleSideImage, threeImageText, standardText,
  type AplusDocument, type ImageComponent,
} from "./modules";

const MODEL = "claude-opus-4-8";

export const DISCLAIMER =
  "Curated and assembled by Salutem Solutions LLC as a gift basket. The included items are packaged by their original manufacturers.";

let _client: Anthropic | null = null;
function client() { return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })); }

export interface GeneratorInput { sku: string; asin: string | null; itemName: string | null; productType: string | null; brand: string | null }

interface Slot { headline: string; body: string; imageBrief: string; imageAlt: string }
interface BenefitCell { headline: string; body: string; imageBrief: string; imageAlt: string }
export interface AplusPlan {
  documentName: string;
  hero: Slot;          // headline = PRIMARY BENEFIT
  brandStory: Slot;    // why / who it's for (factual curator framing)
  benefits: { headline: string; cells: BenefitCell[] }; // exactly 3
  serve: Slot;         // how-to / ways to serve
  whatsInside: { headline: string; body: string };      // factual contents (live text); disclaimer appended in code
}

const slotSchema = {
  type: "object", additionalProperties: false,
  properties: {
    headline: { type: "string", description: "Short headline; lead with the benefit in the first words." },
    body: { type: "string", description: "2–3 short factual sentences max." },
    imageBrief: { type: "string", description: "Image prompt: premium gift-basket LIFESTYLE/in-use scene, NO brand logos/packaging text." },
    imageAlt: { type: "string", description: "Keyword-rich alt text ≤100 chars." },
  },
  required: ["headline", "body", "imageBrief", "imageAlt"],
} as const;

const RESULT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    documentName: { type: "string" },
    hero: slotSchema,
    brandStory: slotSchema,
    benefits: {
      type: "object", additionalProperties: false,
      properties: {
        headline: { type: "string" },
        cells: {
          type: "array", description: "EXACTLY 3 benefit cells.",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              headline: { type: "string", description: "Benefit headline (≤40 chars), benefit-first." },
              body: { type: "string", description: "1 short sentence." },
              imageBrief: { type: "string", description: "In-use/lifestyle image prompt, NO logos/text." },
              imageAlt: { type: "string" },
            },
            required: ["headline", "body", "imageBrief", "imageAlt"],
          },
        },
      },
      required: ["headline", "cells"],
    },
    serve: slotSchema,
    whatsInside: {
      type: "object", additionalProperties: false,
      properties: {
        headline: { type: "string" },
        body: { type: "string", description: "Factual contents: name the included products + counts (e.g. 'Includes 8 Oscar Mayer Bun Length Franks'). Plain text." },
      },
      required: ["headline", "body"],
    },
  },
  required: ["documentName", "hero", "brandStory", "benefits", "serve", "whatsInside"],
} as const;

const SYSTEM = `You write HIGH-CONVERTING Amazon A+ Content (Basic, 5 modules) for SALUTEM SOLUTIONS own-brand gift baskets (Salutem Vita / Starfit) that CONTAIN genuine third-party-brand grocery products. A+ is an image-led, mobile-first, SCANNABLE landing page — not a text doc.

CONVERSION RULES (verified):
- HERO headline states the PRIMARY BENEFIT (what the shopper gets), not just the product name.
- Copy is SHORT and benefit-first: lead with the benefit in the first words; 2–3 short sentences per block; benefit cells = 1 sentence. No walls of text. Write to answer buyer questions, NOT as a keyword list.
- Image-led: image briefs are premium, appetizing, in-context food / gifting LIFESTYLE scenes. Each benefit image must read on its own (they stack on mobile).
- BRAND STORY: short "why / who it's for" framing (gifting, sharing, occasions) — factual, our curator role.
- HOW-TO / SERVE: concrete ways to serve/enjoy — removes "I don't know how to use it" hesitation.
- WHAT'S INSIDE: factual contents in plain text — name the included products + counts.

NON-NEGOTIABLE (a gate rejects violations):
- Brand voice: NO promo adjectives (ultimate/perfect/premium/best/amazing/delicious/ideal…), NO emojis, NO health/medical claims. Benefit-led but FACTUAL.
- A+ policy: NO pricing/discounts/free, NO shipping, NO guarantee/warranty, NO CTAs (buy now), NO contact/links, NO competitor comparison, NO time-sensitive words, NO eco-friendly/biodegradable, NO #1/best-selling.
- IP (critical): NAME included third-party brands FACTUALLY in TEXT only (e.g. "Includes 8 Oscar Mayer Bun Length Franks"). NEVER imply a relationship (authorized/official/endorsed/partner). Image briefs must contain NO brand logos, NO packaging text, NO readable labels — generic appetizing food/gift presentation only.
- NEVER put text inside the image (mobile reflow makes it unreadable) — all copy goes in the text fields.

Infer the included items from the title. Fill the storyboard: hero (benefit), brandStory, benefits (EXACTLY 3), serve, whatsInside.`;

export async function generateAplusPlan(input: GeneratorInput): Promise<AplusPlan> {
  const userPrompt = `Listing:
SKU: ${input.sku} | ASIN: ${input.asin ?? "—"}
Title: ${input.itemName ?? "—"}
Product type: ${input.productType ?? "—"}
Our brand: ${input.brand ?? "Salutem Vita"}

Fill the conversion storyboard. Short benefit-first copy, IP-safe logo-free image briefs.`;

  const resp = await client().messages.create({
    model: MODEL, max_tokens: 4096, thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: SYSTEM, messages: [{ role: "user", content: userPrompt }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("generator returned no plan");
  const plan = JSON.parse(block.text) as AplusPlan;
  plan.benefits.cells = (plan.benefits.cells ?? []).slice(0, 3);
  while (plan.benefits.cells.length < 3) plan.benefits.cells.push({ headline: "", body: "", imageBrief: plan.hero.imageBrief, imageAlt: "" });
  return plan;
}

export interface ImageSlot { key: string; brief: string; alt: string; landscape: boolean }

/** 6 image slots: hero (landscape) + brandStory + 3 benefits + serve. */
export function imageSlots(plan: AplusPlan): ImageSlot[] {
  return [
    { key: "hero", brief: plan.hero.imageBrief, alt: plan.hero.imageAlt, landscape: true },
    { key: "brandStory", brief: plan.brandStory.imageBrief, alt: plan.brandStory.imageAlt, landscape: false },
    ...plan.benefits.cells.map((c, i) => ({ key: `benefit${i}`, brief: c.imageBrief, alt: c.imageAlt, landscape: false })),
    { key: "serve", brief: plan.serve.imageBrief, alt: plan.serve.imageAlt, landscape: false },
  ];
}

/** Assemble the API content document (5 modules). refs maps slot key → ImageComponent. */
export function assembleFromPlan(plan: AplusPlan, refs: Record<string, ImageComponent> = {}): AplusDocument {
  return assembleDocument(plan.documentName, [
    headerImageText({ headline: plan.hero.headline, body: plan.hero.body, img: refs.hero }),
    singleSideImage({ position: "LEFT", headline: plan.brandStory.headline, body: plan.brandStory.body, img: refs.brandStory }),
    threeImageText({ headline: plan.benefits.headline, cells: plan.benefits.cells.map((c, i) => ({ headline: c.headline, body: c.body, img: refs[`benefit${i}`] })) }),
    singleSideImage({ position: "RIGHT", headline: plan.serve.headline, body: plan.serve.body, img: refs.serve }),
    standardText({ headline: plan.whatsInside.headline || "What's Inside", body: `${plan.whatsInside.body}\n\n${DISCLAIMER}` }),
  ]);
}
