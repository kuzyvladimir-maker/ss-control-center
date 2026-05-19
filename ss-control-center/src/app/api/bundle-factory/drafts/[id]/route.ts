/**
 * GET /api/bundle-factory/drafts/[id]
 *
 * Returns the full BundleDraft + its VariationMatrix + its
 * GeneratedContent rows. Used by `/bundle-factory/drafts/[id]` to render
 * per-channel content cards with compliance status.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(
  "drafts[id]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;

    const draft = await prisma.bundleDraft.findUnique({
      where: { id },
      include: {
        variation_matrix: true,
        generated_content: {
          orderBy: { channel: "asc" },
        },
      },
    });
    if (!draft) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // ResearchPool comes from the same generation_job for convenience.
    const pool = await prisma.researchPool.findMany({
      where: { generation_job_id: draft.generation_job_id },
      orderBy: [{ freshness_score: "desc" }, { created_at: "asc" }],
    });

    return NextResponse.json({ draft, research_pool: pool });
  },
);
