/**
 * GET /api/amazon/growth/learnings?storeIndex
 *
 * The Learning Store: proven levers aggregated from control-adjusted (diff-in-diff)
 * outcomes of past changes. Empty until measured changes accrue.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeLearnings } from "@/lib/amazon/growth/learning-store";

export async function GET(request: NextRequest) {
  const storeIndex = Number(request.nextUrl.searchParams.get("storeIndex") ?? 1);
  const learnings = await computeLearnings(prisma, storeIndex);
  return NextResponse.json({ storeIndex, learnings });
}
