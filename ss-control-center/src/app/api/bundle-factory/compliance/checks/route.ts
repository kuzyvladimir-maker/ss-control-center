/**
 * GET /api/bundle-factory/compliance/checks
 *   ?bundle_draft_id=<id>      optional — narrow to one draft
 *   ?decision=CAN_PUBLISH|BLOCKED   optional filter
 *   ?limit=50                  default 50, max 500
 *
 * Returns recent ComplianceCheck records, newest first. The dashboard's
 * "Recent Decisions" tab calls this with no filters.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

const ALLOWED_DECISIONS = ["CAN_PUBLISH", "BLOCKED"] as const;

export const GET = withErrorHandler(
  "compliance/checks",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const bundleDraftId = searchParams.get("bundle_draft_id");
    const decision = searchParams.get("decision");
    const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 50)));

    if (
      decision &&
      !ALLOWED_DECISIONS.includes(decision as (typeof ALLOWED_DECISIONS)[number])
    ) {
      return badRequest(
        `Invalid decision. Allowed: ${ALLOWED_DECISIONS.join(", ")}`,
      );
    }

    const checks = await prisma.complianceCheck.findMany({
      where: {
        ...(bundleDraftId ? { bundle_draft_id: bundleDraftId } : {}),
        ...(decision ? { decision } : {}),
      },
      orderBy: { created_at: "desc" },
      take: limit,
    });

    return NextResponse.json({ checks, count: checks.length });
  },
);
