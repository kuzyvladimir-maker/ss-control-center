/**
 * GET /api/bundle-factory/compliance/blocked-drafts
 *   ?limit=100  default 100, max 500
 *
 * Returns BundleDraft rows with compliance_status='BLOCKED' that are
 * awaiting manual review or re-check. The dashboard's "Blocked Drafts"
 * tab calls this.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  intParam,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "compliance/blocked-drafts",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      500,
      Math.max(1, intParam(searchParams, "limit", 100)),
    );

    const drafts = await prisma.bundleDraft.findMany({
      where: { compliance_status: "BLOCKED" },
      orderBy: { compliance_blocked_at: "desc" },
      take: limit,
      select: {
        id: true,
        draft_name: true,
        brand: true,
        category: true,
        pack_count: true,
        status: true,
        compliance_status: true,
        compliance_check_id: true,
        compliance_blocked_at: true,
        compliance_blocked_reasons: true,
        draft_title: true,
        target_channels: true,
        created_at: true,
        updated_at: true,
      },
    });

    return NextResponse.json({ drafts, count: drafts.length });
  },
);
