/**
 * POST /api/bundle-factory/uncrustables/candidates/[candidateId]/rerender
 *
 * RENDERED / REJECTED / FAILED -> RENDER_QUEUED. Clears reject_reason and
 * last_error and resets the 8-attempt budget; the next tick re-renders.
 * Atomic CAS: a candidate in any other state returns 409.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

const RERENDERABLE_STATES = ["RENDERED", "REJECTED", "FAILED"] as const;

export const POST = withErrorHandler(
  "uncrustables-candidate-rerender",
  async (_request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const updated = await prisma.uncrustablesStudioCandidate.updateMany({
      where: { id: candidateId, state: { in: [...RERENDERABLE_STATES] } },
      data: {
        state: "RENDER_QUEUED",
        reject_reason: null,
        last_error: null,
        render_attempts: 0,
      },
    });
    if (updated.count !== 1) {
      const existing = await prisma.uncrustablesStudioCandidate.findUnique({
        where: { id: candidateId },
        select: { state: true },
      });
      if (!existing) return notFound(`Candidate ${candidateId} not found`);
      return NextResponse.json(
        {
          error: `Cannot rerender from state ${existing.state}`,
          allowed_states: RERENDERABLE_STATES,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ candidate_id: candidateId, state: "RENDER_QUEUED" });
  },
);
