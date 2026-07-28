/**
 * POST /api/bundle-factory/briefs/[id]/approve-research
 *
 * Transitions a BundleDraft from RESEARCHED → VARIATION_SELECTED. This
 * is the gate between Phase 2.1 (Research) and Phase 2.2 (Variation
 * Matrix). Phase 2.2 isn't wired yet — this endpoint only flips the
 * status and writes a lifecycle log entry so the operator can curate
 * the pool and then "lock it in" for the next stage.
 *
 * Min pool size: 5 items. Below that we 400 because the variation step
 * needs enough candidates to assemble distinct bundles.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { logLifecycle } from "@/lib/bundle-factory/lifecycle-log";

export const dynamic = "force-dynamic";

const MIN_POOL_SIZE = 5;

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandler(
  "briefs[id]/approve-research[POST]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const brief = await prisma.bundleDraft.findUnique({ where: { id } });
    if (!brief) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (brief.status !== "RESEARCHED") {
      return badRequest(
        `Brief must be in RESEARCHED status to approve (current=${brief.status})`,
      );
    }

    const poolSize = await prisma.researchPool.count({
      where: { generation_job_id: brief.generation_job_id },
    });
    if (poolSize < MIN_POOL_SIZE) {
      return badRequest(
        `Research pool too small (${poolSize}/${MIN_POOL_SIZE}). Re-run research or add items manually.`,
      );
    }

    const updated = await prisma.bundleDraft.update({
      where: { id },
      data: { status: "VARIATION_SELECTED" },
    });

    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: id,
      from_status: "RESEARCHED",
      to_status: "VARIATION_SELECTED",
      reason: `Research approved (pool_size=${poolSize})`,
      actor: "user",
      details: { pool_size: poolSize },
    });

    return NextResponse.json({ brief: updated, pool_size: poolSize });
  },
);
