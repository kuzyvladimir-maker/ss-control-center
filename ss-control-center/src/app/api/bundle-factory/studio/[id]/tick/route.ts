/**
 * POST /api/bundle-factory/studio/[id]/tick
 *
 *   Advances the prompt-driven batch by one unit of work and returns the live
 *   progress. The client polls this until progress.done_flag is true. Each
 *   tick is short (parse+source on the first, one listing thereafter) so it
 *   stays within serverless limits.
 *
 *   Returns: BatchProgress { status, phase, step, total, done, failed, done_flag }
 */

import { NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { tickBatch } from "@/lib/bundle-factory/studio-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withErrorHandler(
  "studio-tick",
  async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const progress = await tickBatch(id);
    return NextResponse.json(progress, { status: 200 });
  },
);
