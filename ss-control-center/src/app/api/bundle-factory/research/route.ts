/**
 * GET  /api/bundle-factory/research
 *      ?brand=...
 *      ?generation_job_id=...
 *      ?limit=200 (default 100, max 500)
 *
 *   Lists ResearchPool rows (discovered products).
 *
 * POST /api/bundle-factory/research
 *      Body: ResearchPool create payload. In Phase 1 the actual AI
 *      research pipeline isn't wired — this endpoint just records seed
 *      data (placeholder).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler("research", async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const brand = searchParams.get("brand");
  const generationJobId = searchParams.get("generation_job_id");
  const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 100)));

  const where: Record<string, unknown> = {};
  if (brand) where.brand = brand;
  if (generationJobId) where.generation_job_id = generationJobId;

  const items = await prisma.researchPool.findMany({
    where,
    orderBy: { created_at: "desc" },
    take: limit,
  });
  return NextResponse.json({ research: items, total: items.length });
});

type CreatePayload = {
  research_query: string;
  product_name: string;
  brand: string;
  reference_image_urls: unknown;
  generation_job_id?: string;
  manufacturer?: string;
  upc?: string;
  flavors?: unknown;
  pack_sizes?: unknown;
  weight_oz?: number;
  weight_lb?: number;
  ingredients?: string;
  allergens?: unknown;
  nutrition?: unknown;
  storage_temp?: string;
  expiration_days?: number;
  avg_price_cents?: number;
  source_store_id?: string;
  source_url?: string;
  last_seen_in_stock?: string;
  freshness_score?: number;
};

export const POST = withErrorHandler(
  "research[POST]",
  async (request: Request) => {
    const body = await readJson<CreatePayload>(request);
    if (!body) return badRequest("Body must be JSON");
    const required = [
      "research_query",
      "product_name",
      "brand",
      "reference_image_urls",
    ] as const;
    for (const k of required) {
      if (body[k] === undefined || body[k] === null) {
        return badRequest(`Missing required field: ${k}`);
      }
    }
    const created = await prisma.researchPool.create({
      data: {
        research_query: body.research_query,
        product_name: body.product_name,
        brand: body.brand,
        reference_image_urls: JSON.stringify(body.reference_image_urls),
        generation_job_id: body.generation_job_id,
        manufacturer: body.manufacturer,
        upc: body.upc,
        flavors: body.flavors ? JSON.stringify(body.flavors) : undefined,
        pack_sizes: body.pack_sizes
          ? JSON.stringify(body.pack_sizes)
          : undefined,
        weight_oz: body.weight_oz,
        weight_lb: body.weight_lb,
        ingredients: body.ingredients,
        allergens: body.allergens
          ? JSON.stringify(body.allergens)
          : undefined,
        nutrition: body.nutrition
          ? JSON.stringify(body.nutrition)
          : undefined,
        storage_temp: body.storage_temp,
        expiration_days: body.expiration_days,
        avg_price_cents: body.avg_price_cents,
        source_store_id: body.source_store_id,
        source_url: body.source_url,
        last_seen_in_stock: body.last_seen_in_stock
          ? new Date(body.last_seen_in_stock)
          : undefined,
        freshness_score: body.freshness_score,
      },
    });
    return NextResponse.json({ research: created }, { status: 201 });
  }
);
