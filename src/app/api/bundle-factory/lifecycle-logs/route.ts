/**
 * GET /api/bundle-factory/lifecycle-logs
 *     ?entity_id=...           — single entity audit trail
 *     ?entity_type=MasterBundle|ChannelSKU
 *     ?master_bundle_id=...
 *     ?channel_sku_id=...
 *     ?limit=200 (default 100, max 500)
 *
 * Read-only. Phase 1 writers are the master-bundles + channel-skus POST
 * handlers; future stages will append rows as state transitions occur.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "lifecycle-logs",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const entityId = searchParams.get("entity_id");
    const entityType = searchParams.get("entity_type");
    const masterBundleId = searchParams.get("master_bundle_id");
    const channelSkuId = searchParams.get("channel_sku_id");
    const limit = Math.min(500, Math.max(1, intParam(searchParams, "limit", 100)));

    if (entityType && entityType !== "MasterBundle" && entityType !== "ChannelSKU") {
      return badRequest('entity_type must be "MasterBundle" or "ChannelSKU"');
    }

    const where: Record<string, unknown> = {};
    if (entityId) where.entity_id = entityId;
    if (entityType) where.entity_type = entityType;
    if (masterBundleId) where.master_bundle_id = masterBundleId;
    if (channelSkuId) where.channel_sku_id = channelSkuId;

    const logs = await prisma.listingLifecycleLog.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
    });
    return NextResponse.json({ logs, total: logs.length });
  }
);
