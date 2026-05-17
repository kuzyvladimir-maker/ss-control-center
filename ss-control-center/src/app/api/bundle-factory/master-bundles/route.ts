/**
 * GET  /api/bundle-factory/master-bundles
 *      ?status=DRAFT|RESEARCHED|VARIATION_SELECTED|GENERATED|APPROVED|
 *              QUEUED|SUBMITTED|PROCESSING|LIVE|ERROR|...
 *      ?brand=Salutem%20Vita
 *      ?category=FROZEN_GROCERY
 *      ?include=components,channel_skus  (comma-separated)
 *      ?limit=100  (default 100, max 500)
 *
 * POST /api/bundle-factory/master-bundles
 *      Body: MasterBundle create payload (see Prisma model).
 *      Required: name, internal_slug, brand, category, composition_type,
 *      pack_count, cost_breakdown, estimated_cost_cents, suggested_price_cents,
 *      packaging_spec, main_image_url, secondary_images.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import {
  LIFECYCLE_STATES,
  PRODUCT_CATEGORIES,
  COMPOSITION_TYPES,
  isOneOf,
} from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "master-bundles",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const brand = searchParams.get("brand");
    const category = searchParams.get("category");
    const includeParam = searchParams.get("include") ?? "";
    const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 100)));

    if (status && !isOneOf(LIFECYCLE_STATES, status)) {
      return badRequest(
        `Invalid status. Allowed: ${LIFECYCLE_STATES.join(", ")}`
      );
    }
    if (category && !isOneOf(PRODUCT_CATEGORIES, category)) {
      return badRequest(
        `Invalid category. Allowed: ${PRODUCT_CATEGORIES.join(", ")}`
      );
    }

    const includes = includeParam.split(",").filter(Boolean);
    const include = {
      components: includes.includes("components"),
      channel_skus: includes.includes("channel_skus"),
    };

    const where: Record<string, unknown> = {};
    if (status) where.lifecycle_status = status;
    if (brand) where.brand = brand;
    if (category) where.category = category;

    const bundles = await prisma.masterBundle.findMany({
      where,
      include: include.components || include.channel_skus ? include : undefined,
      orderBy: { created_at: "desc" },
      take: limit,
    });
    return NextResponse.json({ bundles, total: bundles.length });
  }
);

type CreatePayload = {
  name: string;
  internal_slug: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
  total_weight_oz?: number;
  total_weight_lb?: number;
  cost_breakdown: unknown;
  estimated_cost_cents: number;
  suggested_price_cents: number;
  packaging_spec: unknown;
  main_image_url: string;
  secondary_images: unknown;
  image_generation_meta?: unknown;
  lifecycle_status?: string;
  generation_job_id?: string;
  research_pool_seed_id?: string;
  created_by_user_id?: string;
};

export const POST = withErrorHandler(
  "master-bundles[POST]",
  async (request: Request) => {
    const body = await readJson<CreatePayload>(request);
    if (!body) return badRequest("Body must be JSON");

    // Minimum-viable validation. Stage 5+ will replace with full Zod schema.
    const required = [
      "name",
      "internal_slug",
      "brand",
      "category",
      "composition_type",
      "pack_count",
      "cost_breakdown",
      "estimated_cost_cents",
      "suggested_price_cents",
      "packaging_spec",
      "main_image_url",
      "secondary_images",
    ] as const;
    for (const k of required) {
      if (body[k] === undefined || body[k] === null) {
        return badRequest(`Missing required field: ${k}`);
      }
    }
    if (!isOneOf(PRODUCT_CATEGORIES, body.category)) {
      return badRequest(`Invalid category: ${body.category}`);
    }
    if (!isOneOf(COMPOSITION_TYPES, body.composition_type)) {
      return badRequest(`Invalid composition_type: ${body.composition_type}`);
    }
    if (
      body.lifecycle_status &&
      !isOneOf(LIFECYCLE_STATES, body.lifecycle_status)
    ) {
      return badRequest(`Invalid lifecycle_status: ${body.lifecycle_status}`);
    }

    const created = await prisma.masterBundle.create({
      data: {
        name: body.name,
        internal_slug: body.internal_slug,
        brand: body.brand,
        category: body.category,
        composition_type: body.composition_type,
        pack_count: body.pack_count,
        total_weight_oz: body.total_weight_oz,
        total_weight_lb: body.total_weight_lb,
        cost_breakdown: JSON.stringify(body.cost_breakdown),
        estimated_cost_cents: body.estimated_cost_cents,
        suggested_price_cents: body.suggested_price_cents,
        packaging_spec: JSON.stringify(body.packaging_spec),
        main_image_url: body.main_image_url,
        secondary_images: JSON.stringify(body.secondary_images),
        image_generation_meta: body.image_generation_meta
          ? JSON.stringify(body.image_generation_meta)
          : null,
        lifecycle_status: body.lifecycle_status ?? "DRAFT",
        generation_job_id: body.generation_job_id,
        research_pool_seed_id: body.research_pool_seed_id,
        created_by_user_id: body.created_by_user_id,
      },
    });

    // Mirror the lifecycle transition into the audit log.
    await prisma.listingLifecycleLog.create({
      data: {
        entity_type: "MasterBundle",
        entity_id: created.id,
        master_bundle_id: created.id,
        from_status: null,
        to_status: created.lifecycle_status,
        trigger: "api_create",
        user_id: body.created_by_user_id,
      },
    });

    return NextResponse.json({ bundle: created }, { status: 201 });
  }
);
