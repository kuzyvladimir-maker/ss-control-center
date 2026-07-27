/**
 * GET /api/bundle-factory/uncrustables/runs/[runId]
 *
 * The run board: run header + every candidate with its full render/review
 * fields, plus parsed recipe/bullets for the client. Polled by RunBoardClient
 * between ticks.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

const PENDING_STATES = ["PLANNED", "RENDER_QUEUED", "RENDERING"] as const;

export const GET = withErrorHandler(
  "uncrustables-run-board",
  async (_request: Request, ctx: { params: Promise<{ runId: string }> }) => {
    const { runId } = await ctx.params;
    const run = await prisma.uncrustablesStudioRun.findUnique({
      where: { id: runId },
      include: { candidates: { orderBy: { created_at: "asc" } } },
    });
    if (!run) return notFound(`Run ${runId} not found`);

    const candidates = run.candidates.map((c) => ({
      id: c.id,
      slug: c.slug,
      state: c.state,
      title: c.title,
      recipe: safeParse(c.recipe_json),
      bullets: safeParse(c.bullets_json),
      description: c.description,
      price_cents: c.price_cents,
      cost_cents: c.cost_cents,
      pack_count: c.pack_count,
      render_attempts: c.render_attempts,
      main_image_url: c.main_image_url,
      image_sha256: c.image_sha256,
      pixel_width: c.pixel_width,
      pixel_height: c.pixel_height,
      reviewed_by: c.reviewed_by,
      reviewed_at: c.reviewed_at,
      reject_reason: c.reject_reason,
      last_error: c.last_error,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));

    return NextResponse.json({
      run: {
        id: run.id,
        name: run.name,
        status: run.status,
        owner_order: run.owner_order,
        created_by: run.created_by,
        created_at: run.created_at,
      },
      candidates,
      pending_count: candidates.filter((c) =>
        (PENDING_STATES as readonly string[]).includes(c.state),
      ).length,
    });
  },
);

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
