/**
 * GET /api/bundle-factory/compliance/audit-log
 *   ?event_type=gate_check|manual_override|pattern_detected|auto_fix
 *   ?bundle_draft_id=<id>
 *   ?limit=100  default 100, max 1000
 *
 * Paginated ComplianceAuditLog dump powering the "Audit Log" tab.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

const EVENT_TYPES = [
  "gate_check",
  "manual_override",
  "pattern_detected",
  "auto_fix",
] as const;

export const GET = withErrorHandler(
  "compliance/audit-log",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const eventType = searchParams.get("event_type");
    const bundleDraftId = searchParams.get("bundle_draft_id");
    const limit = Math.min(
      1000,
      Math.max(1, intParam(searchParams, "limit", 100)),
    );

    if (
      eventType &&
      !EVENT_TYPES.includes(eventType as (typeof EVENT_TYPES)[number])
    ) {
      return badRequest(
        `Invalid event_type. Allowed: ${EVENT_TYPES.join(", ")}`,
      );
    }

    const entries = await prisma.complianceAuditLog.findMany({
      where: {
        ...(eventType ? { event_type: eventType } : {}),
        ...(bundleDraftId ? { bundle_draft_id: bundleDraftId } : {}),
      },
      orderBy: { created_at: "desc" },
      take: limit,
    });

    return NextResponse.json({ entries, count: entries.length });
  },
);
