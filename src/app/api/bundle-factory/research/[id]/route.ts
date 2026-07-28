/**
 * PATCH  /api/bundle-factory/research/[id]
 *        Edits a single ResearchPool row (Vladimir curating Perplexity's
 *        guesses).
 *
 * DELETE /api/bundle-factory/research/[id]
 *        Removes the row from the pool. Hard delete is fine here — the
 *        pool itself is regeneratable via re-running research.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const SCALAR_FIELDS = [
  "product_name",
  "brand",
  "manufacturer",
  "upc",
  "ingredients",
  "storage_temp",
  "expiration_days",
  "avg_price_cents",
  "source_store_id",
  "source_url",
  "freshness_score",
  "weight_oz",
  "weight_lb",
] as const;

export const PATCH = withErrorHandler(
  "research[id][PATCH]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const item = await prisma.researchPool.findUnique({ where: { id } });
    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await readJson<Record<string, unknown>>(request);
    if (!body) return badRequest("Body must be JSON");

    const data: Record<string, unknown> = {};

    for (const k of SCALAR_FIELDS) {
      if (body[k] !== undefined) data[k] = body[k];
    }

    if (body.flavors !== undefined) {
      data.flavors = JSON.stringify(body.flavors);
    }
    if (body.pack_sizes !== undefined) {
      data.pack_sizes = JSON.stringify(body.pack_sizes);
    }
    if (body.allergens !== undefined) {
      data.allergens = JSON.stringify(body.allergens);
    }
    if (body.reference_image_urls !== undefined) {
      data.reference_image_urls = JSON.stringify(body.reference_image_urls);
    }

    if (Object.keys(data).length === 0) {
      return badRequest("No editable fields supplied");
    }

    const updated = await prisma.researchPool.update({
      where: { id },
      data,
    });
    return NextResponse.json({ research: updated });
  },
);

export const DELETE = withErrorHandler(
  "research[id][DELETE]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    await prisma.researchPool.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  },
);
