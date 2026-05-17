/**
 * GET /api/bundle-factory/audit/scans
 *   ?id=<scanId>      → return single scan (with progress counters)
 *   ?status=running   → filter list
 *   ?limit=20         → default 20, max 100
 *
 *   When ?id is given we return the single scan or 404. Otherwise we
 *   return the most-recent scans by started_at desc.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  intParam,
  notFound,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "audit/scans",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const status = searchParams.get("status");
    const limit = Math.min(100, Math.max(1, intParam(searchParams, "limit", 20)));

    if (id) {
      const scan = await prisma.listingAuditScan.findUnique({
        where: { id },
      });
      if (!scan) return notFound(`Scan ${id} not found`);
      return NextResponse.json({ scan });
    }

    const where = status ? { status } : {};
    const scans = await prisma.listingAuditScan.findMany({
      where,
      orderBy: { started_at: "desc" },
      take: limit,
    });

    return NextResponse.json({ scans, count: scans.length });
  },
);
