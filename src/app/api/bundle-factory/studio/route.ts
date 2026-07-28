/**
 * POST /api/bundle-factory/studio
 *
 *   Phase 7 "Studio" entry. Creates a BundleDraft (status=DRAFT) from a
 *   StudioRunConfig and stashes the full config on the GenerationJob.brief so
 *   later stages can read the run's knobs (source, set type, variations,
 *   target margin, models, image strategy). The donor products are picked in
 *   the next step (the donor picker → seedPoolFromDonors).
 *
 *   Body: {
 *     listing_name, house_brand ("Salutem Vita"|"Starfit"),
 *     marketplace ("amazon"), set_type ("multipack"|"thematic"),
 *     category (ProductCategory), pack_count (2-50), variations (1-5),
 *     target_margin_pct (number, percent or fraction), text_model,
 *     image_strategy ("reuse-donor"|"generate"), image_model?
 *   }
 *   Returns: { draft_id }
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { PRODUCT_CATEGORIES, SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

const HOUSE_BRANDS = ["Salutem Vita", "Starfit"] as const;
const SET_TYPES = ["multipack", "thematic"] as const;
const TEXT_MODELS = ["opus", "sonnet"] as const;
const IMAGE_STRATEGIES = ["reuse-donor", "generate"] as const;
const IMAGE_MODELS = ["gpt-image-1", "gpt-image-2", "smart"] as const;

// House brand → the Amazon account/channel that owns its Brand Registry.
// Salutem Vita registry sits on Salutem Solutions (store1); Starfit on Sirius.
const BRAND_CHANNEL: Record<(typeof HOUSE_BRANDS)[number], string> = {
  "Salutem Vita": "AMAZON_SALUTEM",
  Starfit: "AMAZON_SIRIUS",
};

// Set type → pipeline composition type.
const SET_COMPOSITION: Record<(typeof SET_TYPES)[number], string> = {
  multipack: "SINGLE_FLAVOR",
  thematic: "MIXED_FLAVOR",
};

export const POST = withErrorHandler("studio-create", async (request: Request) => {
  const body = (await readJson<Record<string, unknown>>(request)) ?? {};

  const listingName = typeof body.listing_name === "string" ? body.listing_name.trim() : "";
  if (!listingName) return badRequest("listing_name is required");

  if (!isOneOf(HOUSE_BRANDS, body.house_brand)) {
    return badRequest(`house_brand must be one of ${HOUSE_BRANDS.join(", ")}`);
  }

  // Channel: the operator picks where to sell (any of their channels). Falls
  // back to the house brand's home Amazon account when not provided. Only the
  // Amazon channels are wired for publish today — Walmart/eBay/TikTok land next.
  const channel = isOneOf(SALES_CHANNELS, body.channel)
    ? body.channel
    : BRAND_CHANNEL[body.house_brand as (typeof HOUSE_BRANDS)[number]];
  if (!channel.startsWith("AMAZON_")) {
    return badRequest(`Channel "${channel}" is not wired for publishing yet — pick an Amazon account for now.`);
  }
  if (!isOneOf(SET_TYPES, body.set_type)) {
    return badRequest(`set_type must be one of ${SET_TYPES.join(", ")}`);
  }
  if (!isOneOf(PRODUCT_CATEGORIES, body.category)) {
    return badRequest(`category must be one of ${PRODUCT_CATEGORIES.join(", ")}`);
  }
  const packCount = Number(body.pack_count);
  if (!Number.isInteger(packCount) || packCount < 2 || packCount > 50) {
    return badRequest("pack_count must be an integer between 2 and 50");
  }
  const variations = Number(body.variations);
  if (!Number.isInteger(variations) || variations < 1 || variations > 5) {
    return badRequest("variations must be an integer between 1 and 5");
  }
  if (!isOneOf(TEXT_MODELS, body.text_model)) {
    return badRequest(`text_model must be one of ${TEXT_MODELS.join(", ")}`);
  }
  if (!isOneOf(IMAGE_STRATEGIES, body.image_strategy)) {
    return badRequest(`image_strategy must be one of ${IMAGE_STRATEGIES.join(", ")}`);
  }
  const imageModel =
    body.image_strategy === "generate"
      ? isOneOf(IMAGE_MODELS, body.image_model)
        ? body.image_model
        : "gpt-image-1"
      : null;

  // target margin is optional here (the economics module owns price); store it
  // when provided so the validator can read the per-run floor later.
  const rawMargin = Number(body.target_margin_pct);
  const targetMarginPct =
    Number.isFinite(rawMargin) && rawMargin > 0 ? rawMargin : null;

  const compositionType = SET_COMPOSITION[body.set_type as (typeof SET_TYPES)[number]];
  const marketplace = channel.startsWith("AMAZON_") ? "amazon" : "walmart";

  // Full run config — the source of truth for the studio run, read by later
  // stages from GenerationJob.brief.
  const studioConfig = {
    studio_version: 1,
    source: "donor-catalog",
    listing_name: listingName,
    house_brand: body.house_brand,
    channel,
    marketplace,
    set_type: body.set_type,
    category: body.category,
    pack_count: packCount,
    variations,
    target_margin_pct: targetMarginPct,
    text_model: body.text_model,
    image_strategy: body.image_strategy,
    image_model: imageModel,
    target_channels: [channel],
  };

  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify(studioConfig),
      current_stage: "BRIEF",
      status: "PENDING",
      bundles_target: 1,
      user_id: "user",
    },
    select: { id: true },
  });

  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: job.id,
      draft_name: listingName,
      brand: body.house_brand,
      category: body.category,
      composition_type: compositionType,
      pack_count: packCount,
      draft_components: JSON.stringify([]),
      target_channels: JSON.stringify([channel]),
      status: "DRAFT",
    },
    select: { id: true },
  });

  return NextResponse.json({ draft_id: draft.id }, { status: 201 });
});
