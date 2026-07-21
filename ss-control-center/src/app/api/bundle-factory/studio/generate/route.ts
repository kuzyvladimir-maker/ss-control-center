/**
 * POST /api/bundle-factory/studio/generate
 *
 *   Phase 7 prompt-driven mass generator — entry point. Captures the
 *   operator's plain-language request (e.g. "50 Uncrustables gift sets in
 *   different variations") plus the run options, and records it as a batch
 *   (GenerationJob). The generation engine that reads the prompt, sources
 *   products from the catalog and assembles the listings drains this batch.
 *
 *   Body: {
 *     prompt (required), channel, house_brand,
 *     text_model ("sonnet"|"opus"), photo_strategy ("reuse-donor"|"generate"),
 *     image_quality ("cheaper"|"best"), target_margin_pct?
 *   }
 *   Returns: { batch_id }
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

const HOUSE_BRANDS = ["Salutem Vita", "Starfit"] as const;
const TEXT_MODELS = ["sonnet", "opus"] as const;
const PHOTO_STRATEGIES = ["reuse-donor", "generate"] as const;
const IMAGE_QUALITIES = ["cheaper", "best"] as const;
// Own-brand (Uncrustables) main-image style: count-accurate retail cartons, or
// the individual flavor-coloured sandwich wrappers. Vladimir wants both.
const UNCRUSTABLES_IMAGE_MODES = ["retail_boxes", "individual_wraps"] as const;

export const POST = withErrorHandler("studio-generate", async (request: Request) => {
  const body = (await readJson<Record<string, unknown>>(request)) ?? {};

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 3) return badRequest("Describe what to create (a few words at least).");
  if (prompt.length > 1000) return badRequest("Prompt is too long (max 1000 chars).");

  const channel = isOneOf(SALES_CHANNELS, body.channel) ? body.channel : "AMAZON_SALUTEM";
  // Amazon (frozen + dry) and Walmart (dry multipacks — Walmart rejects frozen)
  // are wired. eBay/TikTok land later.
  if (!channel.startsWith("AMAZON_") && channel !== "WALMART") {
    return badRequest(`Channel "${channel}" is not wired yet — pick an Amazon account or Walmart.`);
  }

  const houseBrand = isOneOf(HOUSE_BRANDS, body.house_brand) ? body.house_brand : "Salutem Vita";
  const textModel = isOneOf(TEXT_MODELS, body.text_model) ? body.text_model : "opus";
  const photoStrategy = isOneOf(PHOTO_STRATEGIES, body.photo_strategy) ? body.photo_strategy : "reuse-donor";
  const imageQuality = isOneOf(IMAGE_QUALITIES, body.image_quality) ? body.image_quality : "cheaper";
  const uncrustablesImageMode = isOneOf(UNCRUSTABLES_IMAGE_MODES, body.uncrustables_image_mode)
    ? body.uncrustables_image_mode
    : "retail_boxes";

  const rawMargin = Number(body.target_margin_pct);
  const targetMarginPct = Number.isFinite(rawMargin) && rawMargin > 0 ? rawMargin : null;

  // Structured self-service knobs (owner 2026-07-21): exact flavors + listing
  // count from the module UI. Optional — a bare prompt still works. Validation
  // is strict: a malformed knob is a 400, never a silent drop that would make
  // the engine build a different assortment than the owner submitted
  // (review 2026-07-21).
  let flavorFilter: string[] = [];
  if (body.flavors !== undefined && body.flavors !== null) {
    if (!Array.isArray(body.flavors)) return badRequest("flavors must be an array of flavor keys/labels.");
    if (body.flavors.length > 40) return badRequest("Too many flavors selected (max 40).");
    for (const f of body.flavors as unknown[]) {
      if (typeof f !== "string" || f.trim().length < 2 || f.trim().length > 120) {
        return badRequest("Each flavor must be a 2–120 character string.");
      }
    }
    flavorFilter = (body.flavors as string[]).map((f) => f.trim());
  }
  let listingCount: number | null = null;
  if (body.listing_count !== undefined && body.listing_count !== null) {
    const rawCount = Number(body.listing_count);
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 500) {
      return badRequest("listing_count must be a whole number from 1 to 500.");
    }
    listingCount = rawCount;
  }

  const batchRequest = {
    studio_version: 2,
    source: "prompt",
    prompt,
    channel,
    house_brand: houseBrand,
    text_model: textModel,
    photo_strategy: photoStrategy,
    image_quality: imageQuality,
    uncrustables_image_mode: uncrustablesImageMode,
    target_margin_pct: targetMarginPct,
    ...(flavorFilter.length > 0 ? { flavor_filter: flavorFilter } : {}),
    ...(listingCount != null ? { listing_count: listingCount } : {}),
  };

  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify(batchRequest),
      current_stage: "BRIEF",
      status: "PENDING",
      bundles_target: 0, // filled by the generator once it parses the count
      user_id: "user",
    },
    select: { id: true },
  });

  return NextResponse.json({ batch_id: job.id }, { status: 201 });
});
