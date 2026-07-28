/**
 * GET /api/bundle-factory/audit/results/[id]
 *   Returns the full audit row for a single listing, plus the linked
 *   remediation record (if any) and all active BrandConflict entries
 *   that share the ASIN — so the listing detail page can show the
 *   incident history without a second round-trip.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "audit/results/[id]",
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const result = await prisma.listingAuditResult.findUnique({
      where: { id },
      include: { remediation: true, scan: true },
    });
    if (!result) return notFound(`Audit result ${id} not found`);

    const conflicts = await prisma.brandConflict.findMany({
      where: { asin: result.asin, status: "active" },
      orderBy: { incident_date: "desc" },
    });

    return NextResponse.json({ result, conflicts });
  },
);
