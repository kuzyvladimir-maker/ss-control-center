/**
 * POST /api/bundle-factory/uncrustables/candidates/[candidateId]/reject
 * Body: { reason: string }
 *
 * RENDERED -> REJECTED -> RENDER_QUEUED, per the plan's state machine
 * (REJECTED -> RENDER_QUEUED)*. The reject reason is stored and stays
 * visible on the board/review page as context for the next render cycle;
 * the attempt budget resets so the new cycle gets its full 8 tries.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  "uncrustables-candidate-reject",
  async (request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const body = await readJson<{ reason?: string }>(request);
    const reason = body?.reason?.trim();
    if (!reason) return badRequest("reason is required");

    // Step 1: RENDERED -> REJECTED (atomic CAS; records the human decision).
    const rejected = await prisma.uncrustablesStudioCandidate.updateMany({
      where: { id: candidateId, state: "RENDERED" },
      data: { state: "REJECTED", reject_reason: reason },
    });
    if (rejected.count !== 1) {
      const existing = await prisma.uncrustablesStudioCandidate.findUnique({
        where: { id: candidateId },
        select: { state: true },
      });
      if (!existing) return notFound(`Candidate ${candidateId} not found`);
      return NextResponse.json(
        { error: `Cannot reject from state ${existing.state}; only RENDERED` },
        { status: 409 },
      );
    }

    // Step 2: REJECTED -> RENDER_QUEUED (the loop edge of the state machine).
    await prisma.uncrustablesStudioCandidate.updateMany({
      where: { id: candidateId, state: "REJECTED" },
      data: { state: "RENDER_QUEUED", render_attempts: 0, last_error: null },
    });

    return NextResponse.json({
      candidate_id: candidateId,
      state: "RENDER_QUEUED",
      reject_reason: reason,
    });
  },
);
