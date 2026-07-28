/**
 * POST /api/bundle-factory/briefs/[id]/generate-variations
 *
 * Stage 3 — deterministic composition variant generator. Reads the
 * curated ResearchPool for the brief's generation_job_id, runs
 * `generateVariants`, and upserts a single VariationMatrix row for
 * this BundleDraft.
 *
 * Brief must be in status=VARIATION_SELECTED (Phase 2.1's
 * approve-research transition lands here). Status does NOT change in
 * this step — the variant isn't actually chosen yet.
 *
 * No AI call, no cost. Idempotent — re-running overwrites the prior
 * VariationMatrix and clears selected_variant_idx.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { generateVariants } from "@/lib/bundle-factory/variation-matrix";
import type { CompositionType } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandler(
  "briefs[id]/generate-variations[POST]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (brief.status !== "VARIATION_SELECTED") {
      return badRequest(
        `Brief must be in VARIATION_SELECTED to generate variants (current=${brief.status})`,
      );
    }

    const pool = await prisma.researchPool.findMany({
      where: { generation_job_id: brief.generation_job_id },
      orderBy: [{ freshness_score: "desc" }, { created_at: "asc" }],
    });
    if (pool.length < 1) {
      return badRequest(
        "Research pool is empty — re-run research before generating variants",
      );
    }

    const variants = generateVariants({
      pool: pool.map((p) => ({
        id: p.id,
        product_name: p.product_name,
        brand: p.brand,
        avg_price_cents: p.avg_price_cents,
        freshness_score: p.freshness_score,
        storage_temp: p.storage_temp,
        pack_sizes: p.pack_sizes,
        flavors: p.flavors,
      })),
      composition_type: brief.composition_type as CompositionType,
      pack_count: brief.pack_count,
    });

    if (variants.length === 0) {
      return badRequest(
        "Variant generator returned zero variants — check pool quality",
      );
    }

    const upserted = await prisma.variationMatrix.upsert({
      where: { bundle_draft_id: id },
      create: {
        bundle_draft_id: id,
        variants_json: JSON.stringify(variants),
        selected_variant_idx: null,
        generation_cost_cents: 0,
        generated_at: new Date(),
      },
      update: {
        variants_json: JSON.stringify(variants),
        selected_variant_idx: null,
        generated_at: new Date(),
        selected_at: null,
      },
    });

    return NextResponse.json({
      variation_matrix_id: upserted.id,
      variants,
      count: variants.length,
    });
  },
);
