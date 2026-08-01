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
 *     prompt (required), channel, target_margin_pct?,
 *     Amazon only: house_brand, photo_strategy ("reuse-donor"|"generate"), image_quality,
 *     uncrustables_image_mode
 *   }
 *   Returns: { batch_id }
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { SALES_CHANNELS, isOneOf } from "@/lib/bundle-factory/enums";
import {
  studioChannelRoute,
  WALMART_CANONICAL_OPERATOR_MESSAGE,
} from "@/lib/bundle-factory/studio-channel-routing";
import {
  parseWalmartShippingTemplateDetails,
  parseWalmartShippingTemplateList,
} from "@/lib/bundle-factory/walmart-shipping-templates";
import {
  getWalmartClient,
  getWalmartStoreStatus,
} from "@/lib/walmart";
import {
  resolveWalmartStudioRequestIntent,
} from "@/lib/bundle-factory/walmart-studio-request";
import {
  WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
  WalmartStudioDraftContractError,
  buildWalmartStudioDraftWorkItems,
} from "@/lib/bundle-factory/walmart-studio-draft-contract";
import {
  WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS,
  WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS,
  WALMART_STUDIO_REFERRAL_FEE_BPS,
} from "@/lib/bundle-factory/walmart-studio-draft-economics";
import {
  diagnoseProductTruthWalmartPilotRequest,
} from "@/lib/sourcing/product-truth-read-contract";
import { openProductTruthWebReadClient } from
  "@/lib/sourcing/product-truth-web-read-client";

export const dynamic = "force-dynamic";

const HOUSE_BRANDS = ["Salutem Vita", "Starfit"] as const;
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
  let packCount: number | null = null;
  if (body.pack_count !== undefined && body.pack_count !== null) {
    const rawCount = Number(body.pack_count);
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 500) {
      return badRequest("pack_count must be a whole number from 1 to 500.");
    }
    packCount = rawCount;
  }

  if (studioChannelRoute(channel) === "CANONICAL_WALMART_OPERATOR_REQUIRED") {
    const intent = resolveWalmartStudioRequestIntent({
      prompt,
      listingCount,
      packCount,
    });
    if (intent.blockers.length > 0) {
      return NextResponse.json(
        {
          error:
            "The Walmart prompt and structured request fields disagree. " +
            intent.blockers.map((blocker) => blocker.message).join(" "),
          code: "WALMART_REQUEST_INPUT_CONFLICT",
          walmart_request: intent,
        },
        { status: 422 },
      );
    }
    const selected =
      body.walmart_shipping &&
        typeof body.walmart_shipping === "object" &&
        !Array.isArray(body.walmart_shipping)
        ? body.walmart_shipping as Record<string, unknown>
        : null;
    const storeIndex = Number(selected?.store_index);
    const templateId =
      typeof selected?.template_id === "string"
        ? selected.template_id.trim()
        : "";
    if (
      !Number.isInteger(storeIndex) ||
      storeIndex < 1 ||
      storeIndex > 5 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(templateId)
    ) {
      return badRequest(
        `${WALMART_CANONICAL_OPERATOR_MESSAGE} Select a Walmart account and one active shipping template.`,
      );
    }
    const account = getWalmartStoreStatus(storeIndex);
    if (!account.configured) {
      return badRequest(
        `Walmart account ${storeIndex} is not configured.`,
      );
    }
    const client = getWalmartClient(storeIndex);
    const [listResponse, detailResponse] = await Promise.all([
      client.requestRaw("GET", "/settings/shipping/templates", {
        noRetryOn429: true,
      }),
      client.requestRaw(
        "GET",
        `/settings/shipping/templates/${templateId}`,
        { noRetryOn429: true },
      ),
    ]);
    if (
      !listResponse.ok ||
      listResponse.status !== 200 ||
      !detailResponse.ok ||
      detailResponse.status !== 200
    ) {
      return badRequest(
        "Walmart could not reconfirm the selected shipping template.",
      );
    }
    const list = parseWalmartShippingTemplateList(
      listResponse.body,
    );
    const listRow = list.find((row) => row.id === templateId);
    const template = parseWalmartShippingTemplateDetails(
      detailResponse.body,
    );
    if (
      !listRow ||
      listRow.status !== "ACTIVE" ||
      template.status !== "ACTIVE" ||
      listRow.id !== template.id ||
      listRow.name !== template.name ||
      listRow.rate_model_type !== template.rate_model_type ||
      (
        typeof selected?.template_sha256 === "string" &&
        selected.template_sha256 !== template.template_sha256
      )
    ) {
      return badRequest(
        "The selected Walmart shipping template changed or is no longer active. Re-open it and select again.",
      );
    }
    const targetMarginBps = Math.round((targetMarginPct ?? 30) * 100);
    if (
      !Number.isSafeInteger(targetMarginBps) ||
      targetMarginBps < 1 ||
      targetMarginBps > 5_000
    ) {
      return badRequest("Walmart target margin must be between 0.01% and 50%.");
    }
    const productTruthAsOf = new Date().toISOString();
    const productTruthDb = openProductTruthWebReadClient();
    let diagnostic;
    try {
      diagnostic = await diagnoseProductTruthWalmartPilotRequest(
        productTruthDb,
        {
          query: prompt,
          asOf: productTruthAsOf,
          requireIngredients: true,
          requireNutrition: true,
          requireAllergens: true,
          limit: Math.max(20, Math.min(500, intent.listing_count * 4)),
        },
      );
    } finally {
      productTruthDb.close();
    }
    let executionWorkItems;
    try {
      executionWorkItems = buildWalmartStudioDraftWorkItems({
        candidates: diagnostic.candidates,
        listingCount: intent.listing_count,
        packCount: intent.pack_count,
        storeIndex,
        shippingTemplateId: template.id,
        shippingTemplateSha256: template.template_sha256,
        targetMarginBps,
        asOf: diagnostic.as_of,
        priceMaxAgeMs: diagnostic.price_max_age_ms,
        zip: diagnostic.zip,
      });
    } catch (error) {
      if (
        error instanceof WalmartStudioDraftContractError &&
        error.code.startsWith("INSUFFICIENT_")
      ) {
        return NextResponse.json(
          {
            error: error.message,
            code: error.code,
            catalog: diagnostic,
          },
          { status: 409 },
        );
      }
      throw error;
    }
    const batchRequest = {
      studio_version: 5,
      workflow: "CANONICAL_WALMART_NEW_SKU",
      draft_schema_version: WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
      source: "prompt",
      prompt,
      channel,
      listing_count: intent.listing_count,
      pack_count: intent.pack_count,
      execution_work_items: executionWorkItems,
      prompt_intent: {
        listing_count: intent.prompt_listing_count,
        pack_count: intent.prompt_pack_count,
      },
      target_margin_pct: targetMarginPct ?? 30,
      photo_strategy: "reuse-donor",
      walmart_shipping: {
        store_index: storeIndex,
        account_name: account.storeName,
        selected_at: new Date().toISOString(),
        template,
      },
      product_truth_admission: {
        as_of: diagnostic.as_of,
        price_max_age_ms: diagnostic.price_max_age_ms,
        zip: diagnostic.zip,
        matched_variants: diagnostic.matched_variants,
        ready_variants: diagnostic.ready_variants,
      },
      pricing_inputs: {
        packaging_cost_cents: WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS,
        shipping_label_cents: WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS,
        referral_fee_bps: WALMART_STUDIO_REFERRAL_FEE_BPS,
        target_margin_bps: targetMarginBps,
      },
      operator_contract: {
        engine: "walmart-studio-draft-engine",
        marketplace_mutation_authorized: false,
        upc_reservation_authorized: false,
        next_step:
          "Create donor-bound internal drafts for owner review. UPC reservation, certification and Walmart publication remain separate gates.",
      },
    };
    const job = await prisma.generationJob.create({
      data: {
        brief: JSON.stringify(batchRequest),
        current_stage: "WALMART_DRAFT_QUEUE",
        status: "PENDING",
        bundles_target: intent.listing_count,
        user_id: "user",
        notes: JSON.stringify({
          progress: {
            status: "PENDING",
            phase: "queued",
            step:
              `${intent.listing_count} exact Product Truth variants queued for Walmart draft generation.`,
            total: intent.listing_count,
            done: 0,
            failed: 0,
            done_flag: false,
          },
        }),
        work_items: {
          create: executionWorkItems.map((item) => ({
            spec_index: item.spec_index,
            spec_json: JSON.stringify(item),
            fingerprint: item.work_item_sha256,
          })),
        },
      },
      select: { id: true },
    });
    return NextResponse.json(
      {
        batch_id: job.id,
        workflow: "CANONICAL_WALMART_NEW_SKU",
      },
      { status: 201 },
    );
  }

  // These controls belong to the Amazon/own-brand branch only. The Walmart
  // branch above preserves manufacturer identity and exact donor imagery and
  // therefore never parses, defaults, or persists them.
  const houseBrand = isOneOf(HOUSE_BRANDS, body.house_brand) ? body.house_brand : "Salutem Vita";
  const photoStrategy = isOneOf(PHOTO_STRATEGIES, body.photo_strategy) ? body.photo_strategy : "reuse-donor";
  const imageQuality = isOneOf(IMAGE_QUALITIES, body.image_quality) ? body.image_quality : "cheaper";
  const uncrustablesImageMode = isOneOf(UNCRUSTABLES_IMAGE_MODES, body.uncrustables_image_mode)
    ? body.uncrustables_image_mode
    : "retail_boxes";

  const batchRequest = {
    studio_version: 2,
    source: "prompt",
    prompt,
    channel,
    house_brand: houseBrand,
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
