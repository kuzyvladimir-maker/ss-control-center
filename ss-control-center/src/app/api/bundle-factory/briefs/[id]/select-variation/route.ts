/**
 * POST /api/bundle-factory/briefs/[id]/select-variation
 *      Body: { variant_idx: number }
 *
 * Records which variant the operator chose from the VariationMatrix.
 * Brief stays at status=VARIATION_SELECTED; the next step is
 * /drafts/[id]/generate-content which fires Stage 4.
 *
 * Idempotent — re-selecting overwrites the prior choice.
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

interface Body {
  variant_idx?: unknown;
}

export const POST = withErrorHandler(
  "briefs[id]/select-variation[POST]",
  async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const body = await readJson<Body>(request);
    if (!body || typeof body.variant_idx !== "number") {
      return badRequest("variant_idx (number) is required");
    }
    if (!Number.isInteger(body.variant_idx) || body.variant_idx < 0) {
      return badRequest("variant_idx must be a non-negative integer");
    }

    const brief = await prisma.bundleDraft.findUnique({
      where: { id },
      include: { variation_matrix: true },
    });
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!brief.variation_matrix) {
      return badRequest(
        "No VariationMatrix for this brief — generate variants first",
      );
    }

    // Validate that the index is within the variants_json range.
    let variantsLength = 0;
    try {
      const parsed = JSON.parse(brief.variation_matrix.variants_json);
      if (Array.isArray(parsed)) variantsLength = parsed.length;
    } catch {
      return badRequest("VariationMatrix is malformed — regenerate variants");
    }
    if (body.variant_idx >= variantsLength) {
      return badRequest(
        `variant_idx ${body.variant_idx} is out of range (have ${variantsLength} variants)`,
      );
    }

    const updated = await prisma.variationMatrix.update({
      where: { bundle_draft_id: id },
      data: {
        selected_variant_idx: body.variant_idx,
        selected_at: new Date(),
      },
    });

    return NextResponse.json({
      variation_matrix_id: updated.id,
      selected_variant_idx: updated.selected_variant_idx,
      selected_at: updated.selected_at,
    });
  },
);
