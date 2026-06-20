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

export const POST = withErrorHandler("studio-generate", async (request: Request) => {
  const body = (await readJson<Record<string, unknown>>(request)) ?? {};

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 3) return badRequest("Describe what to create (a few words at least).");
  if (prompt.length > 1000) return badRequest("Prompt is too long (max 1000 chars).");

  const channel = isOneOf(SALES_CHANNELS, body.channel) ? body.channel : "AMAZON_SALUTEM";
  if (!channel.startsWith("AMAZON_")) {
    return badRequest(`Channel "${channel}" is not wired for publishing yet — pick an Amazon account for now.`);
  }

  const houseBrand = isOneOf(HOUSE_BRANDS, body.house_brand) ? body.house_brand : "Salutem Vita";
  const textModel = isOneOf(TEXT_MODELS, body.text_model) ? body.text_model : "opus";
  const photoStrategy = isOneOf(PHOTO_STRATEGIES, body.photo_strategy) ? body.photo_strategy : "reuse-donor";
  const imageQuality = isOneOf(IMAGE_QUALITIES, body.image_quality) ? body.image_quality : "cheaper";

  const rawMargin = Number(body.target_margin_pct);
  const targetMarginPct = Number.isFinite(rawMargin) && rawMargin > 0 ? rawMargin : null;

  const batchRequest = {
    studio_version: 2,
    source: "prompt",
    prompt,
    channel,
    house_brand: houseBrand,
    text_model: textModel,
    photo_strategy: photoStrategy,
    image_quality: imageQuality,
    target_margin_pct: targetMarginPct,
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
