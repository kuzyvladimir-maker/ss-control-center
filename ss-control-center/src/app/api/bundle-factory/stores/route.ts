/**
 * GET /api/bundle-factory/stores
 *
 * Returns the StoreRegistry. Optional filters:
 *   ?chain=Walmart           — substring match (case-insensitive) on chain
 *   ?tier=TIER_1             — exact match on tier
 *   ?active=true|false       — filter by is_active (default: include all)
 *
 * Sorted by distance_mi ascending (closest to warehouse first).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "stores",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const chain = searchParams.get("chain");
    const tier = searchParams.get("tier");
    const activeParam = searchParams.get("active");

    const where: Record<string, unknown> = {};
    if (chain) where.chain = { contains: chain };
    if (tier) where.tier = tier;
    if (activeParam === "true") where.is_active = true;
    if (activeParam === "false") where.is_active = false;

    const stores = await prisma.storeRegistry.findMany({
      where,
      orderBy: [{ distance_mi: "asc" }],
    });

    return NextResponse.json({ stores, total: stores.length });
  }
);
