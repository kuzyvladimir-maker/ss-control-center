/**
 * GET /api/bundle-factory/uncrustables/candidates/[candidateId]
 *
 * Full candidate detail (all render/review/stage fields) + its run header.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "uncrustables-candidate-detail",
  async (_request: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
    const { candidateId } = await ctx.params;
    const candidate = await prisma.uncrustablesStudioCandidate.findUnique({
      where: { id: candidateId },
      include: { run: { select: { id: true, name: true, status: true } } },
    });
    if (!candidate) return notFound(`Candidate ${candidateId} not found`);
    return NextResponse.json({
      ...candidate,
      recipe: safeParse(candidate.recipe_json),
      bullets: safeParse(candidate.bullets_json),
      reference_urls_parsed: candidate.reference_urls ? safeParse(candidate.reference_urls) : null,
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
