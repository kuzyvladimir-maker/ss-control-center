/**
 * A+ Content Factory — generation engine (CONCEPT-AWARE + conversion playbook).
 *
 * Storyboard + rules baked from verified research (docs/wiki/aplus-conversion-
 * playbook.md) AND competitor teardowns: image-led, mobile-first, scannable, with
 * ONE cohesive visual look across modules, benefit-as-icon cells, and a concrete
 * how-to / serving module. The CONCEPT (concepts.ts) tailors the template: own-food /
 * cooler / cold-pack / supplement (our brand, show the product, no curator disclaimer;
 * supplement adds FDA) vs gift-basket (third-party contents → logo-free + curator).
 *
 * Basic A+ = 5 modules. Copy short & benefit-first; NEVER baked into images (mobile).
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  assembleDocument, headerImageText, singleSideImage, threeImageText, standardText,
  type AplusDocument, type ImageComponent,
} from "./modules";
import { CONCEPT_CONFIG, CURATOR_DISCLAIMER, FDA_DISCLAIMER, type Concept } from "./concepts";
import { CLAUDE } from "@/lib/ai-models";

export type TextModel = "opus" | "sonnet";
const TEXT_MODEL_ID: Record<TextModel, string> = { opus: CLAUDE.premium, sonnet: CLAUDE.balanced };

let _client: Anthropic | null = null;
function client() { return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })); }

export interface GeneratorInput { sku: string; asin: string | null; itemName: string | null; productType: string | null; brand: string | null }

interface Slot { headline: string; body: string; imageBrief: string; imageAlt: string }
interface BenefitCell { headline: string; body: string; imageBrief: string; imageAlt: string }
export interface AplusPlan {
  documentName: string;
  hero: Slot;
  brandStory: Slot;
  benefits: { headline: string; cells: BenefitCell[] };
  serve: Slot;
  whatsInside: { headline: string; body: string };
}

const slotSchema = {
  type: "object", additionalProperties: false,
  properties: {
    headline: { type: "string", description: "Short headline; lead with the benefit in the first words." },
    body: { type: "string", description: "2–3 short factual sentences max." },
    imageBrief: { type: "string", description: "Image prompt (see system rules for branding/cohesion)." },
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
          type: "array", description: "EXACTLY 3 benefit cells; each headline is an icon-style short claim.",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              headline: { type: "string", description: "Icon-style benefit claim (≤24 chars), e.g. 'Ready in minutes'." },
              body: { type: "string", description: "1 short sentence." },
              imageBrief: { type: "string" },
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
        body: { type: "string", description: "Plain-text facts (contents/counts/ingredients/sizes per concept)." },
      },
      required: ["headline", "body"],
    },
  },
  required: ["documentName", "hero", "brandStory", "benefits", "serve", "whatsInside"],
} as const;

function buildSystem(concept: Concept): string {
  const c = CONCEPT_CONFIG[concept];
  return `You write HIGH-CONVERTING Amazon A+ Content (Basic, 5 modules) for SALUTEM SOLUTIONS. A+ is an image-led, mobile-first, SCANNABLE landing page — not a text doc.

IDEA-LED (do this first): infer WHAT this product is for — its audience, use-occasion, and the single core idea/benefit — and build the WHOLE A+ around that one idea, with imagery depicting that theme. Examples: a dog-food gift set → the idea of happy, healthy dogs and pleased dog owners (a gift for dog people); a breakfast-sandwich set → convenient ready breakfasts for school, work, lunches and short trips; a ready-meal gift set → an easy heat-and-eat solution to gift. Stay factual and within the rules below.

CONVERSION RULES (verified):
- HERO headline states the PRIMARY BENEFIT (what the shopper gets), not just the product name.
- Copy is SHORT and benefit-first: benefit in the first words; 2–3 short sentences per block; benefit cells = ONE short icon-style claim + 1 sentence. No walls of text. Answer buyer questions, not a keyword list.
- VISUAL COHESION: ALL image briefs must share ONE consistent look — same palette, lighting, surface/setting and styling — so the 5 modules read as a single designed page, not random photos.
- PHOTOREAL BRIEFS: write each imageBrief as a precise COMMERCIAL PHOTOGRAPH brief. Name the ACTUAL physical product accurately (exact cut/shape/texture/color — e.g. "bone-in beef short ribs, English cut, rib-bone cross-section visible, deep-red marbled meat", not just "meat"), plus camera/styling (angle, soft natural light, shallow depth of field, surface, garnish). Photorealistic, appetizing, true to the real product. NEVER request any text, label, logo, packaging copy or watermark in the image.
- The benefits module is 3 icon-style benefit cells. The 4th module ("${c.serveLabel}") is concrete and reduces hesitation.
- NEVER put text inside the image (mobile reflow makes it unreadable) — all copy goes in the text fields.

CONCEPT: ${c.label}.
${c.systemAddendum}
IMAGE BRANDING RULE for every brief: ${c.imageSuffix}

NON-NEGOTIABLE (a gate rejects violations):
- Brand voice: NO promo adjectives (ultimate/perfect/premium/best/amazing/delicious/ideal…), NO emojis, NO health/medical claims. Benefit-led but FACTUAL.
- A+ policy: NO pricing/discounts/free, NO shipping, NO guarantee/warranty, NO CTAs (buy now), NO contact/links, NO competitor comparison, NO time-sensitive words, NO eco-friendly/biodegradable, NO #1/best-selling.

Fill the storyboard: hero (benefit), brandStory, benefits (EXACTLY 3 icon-style cells), serve ("${c.serveLabel}"), whatsInside ("${c.whatsInsideLabel}").`;
}

export async function generateAplusPlan(input: GeneratorInput, concept: Concept, textModel: TextModel = "opus"): Promise<AplusPlan> {
  const c = CONCEPT_CONFIG[concept];
  const userPrompt = `Listing:
SKU: ${input.sku} | ASIN: ${input.asin ?? "—"}
Title: ${input.itemName ?? "—"}
Product type: ${input.productType ?? "—"}
Our brand: ${input.brand ?? "Salutem Vita"}
Concept: ${c.label}

Fill the conversion storyboard for this concept. Short benefit-first copy; cohesive image briefs; module 4 = ${c.serveLabel}; module 5 = ${c.whatsInsideLabel}.`;

  // Opus → adaptive thinking; Sonnet → thinking off (adaptive eats max_tokens → truncated JSON).
  const resp = await client().messages.create({
    model: TEXT_MODEL_ID[textModel], max_tokens: 4096,
    thinking: textModel === "opus" ? { type: "adaptive" } : { type: "disabled" },
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: buildSystem(concept), messages: [{ role: "user", content: userPrompt }],
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

function disclaimerText(concept: Concept): string {
  const d = CONCEPT_CONFIG[concept].disclaimer;
  return d === "curator" ? CURATOR_DISCLAIMER : d === "fda" ? FDA_DISCLAIMER : "";
}

/** Assemble the 5-module API document for a concept. refs maps slot key → ImageComponent. */
export function assembleFromPlan(plan: AplusPlan, concept: Concept, refs: Record<string, ImageComponent> = {}): AplusDocument {
  const disc = disclaimerText(concept);
  const lastBody = disc ? `${plan.whatsInside.body}\n\n${disc}` : plan.whatsInside.body;
  return assembleDocument(plan.documentName, [
    headerImageText({ headline: plan.hero.headline, body: plan.hero.body, img: refs.hero }),
    singleSideImage({ position: "LEFT", headline: plan.brandStory.headline, body: plan.brandStory.body, img: refs.brandStory }),
    threeImageText({ headline: plan.benefits.headline, cells: plan.benefits.cells.map((c, i) => ({ headline: c.headline, body: c.body, img: refs[`benefit${i}`] })) }),
    singleSideImage({ position: "RIGHT", headline: plan.serve.headline, body: plan.serve.body, img: refs.serve }),
    standardText({ headline: plan.whatsInside.headline || CONCEPT_CONFIG[concept].whatsInsideLabel, body: lastBody }),
  ]);
}
