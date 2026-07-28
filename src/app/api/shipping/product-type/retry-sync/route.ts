/**
 * POST /api/shipping/product-type/retry-sync
 *
 * Re-attempt Veeqo tag sync for any ProductTypeOverride row that previously
 * failed (syncedToVeeqo = false). Idempotent; call from cron, UI button, or
 * manually after fixing whatever caused the failure (rate limit, etc).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setProductTag } from "@/lib/veeqo/client";

export async function POST() {
  const pending = await prisma.productTypeOverride.findMany({
    where: { syncedToVeeqo: false },
    take: 100,
    orderBy: { updatedAt: "asc" },
  });

  const results: Array<{
    productId: number;
    type: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const row of pending) {
    try {
      await setProductTag(row.productId, row.type as "Frozen" | "Dry");
      await prisma.productTypeOverride.update({
        where: { productId: row.productId },
        data: { syncedToVeeqo: true, veeqoSyncError: null },
      });
      results.push({ productId: row.productId, type: row.type, success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.productTypeOverride.update({
        where: { productId: row.productId },
        data: { veeqoSyncError: msg.slice(0, 500) },
      });
      results.push({
        productId: row.productId,
        type: row.type,
        success: false,
        error: msg,
      });
    }
  }

  return NextResponse.json({
    attempted: pending.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
}
