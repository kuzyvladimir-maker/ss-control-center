import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getFinancialEvents,
  parseAdjustments,
} from "@/lib/amazon-sp-api/finances";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";

type ScannedAdjustment = {
  orderId?: string;
  date?: string;
  type: string;
  amount: number;
  reason?: string;
  sku?: string;
  store: string;
};

export async function POST() {
  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  const allAdjustments: ScannedAdjustment[] = [];
  const stores = getConfiguredStores();

  for (const storeId of stores) {
    try {
      const events = await getFinancialEvents({
        storeId,
        postedAfter: fourteenDaysAgo,
      });
      const adjustments = parseAdjustments(events);
      allAdjustments.push(
        ...adjustments.map((a) => ({ ...a, store: storeId }))
      );
    } catch (err) {
      console.error(`Failed to fetch adjustments for ${storeId}:`, err);
    }
  }

  // Build unique externalIds and bulk-check existence (avoid N+1 findUnique calls)
  const candidates = allAdjustments
    .filter((a) => a.orderId)
    .map((a) => ({
      adj: a,
      externalId: `${a.orderId}-${a.date}-${a.type}`,
    }));

  const existing = await prisma.shippingAdjustment.findMany({
    where: { externalId: { in: candidates.map((c) => c.externalId) } },
    select: { externalId: true },
  });
  const existingIds = new Set(existing.map((e) => e.externalId));

  const toCreate = candidates
    .filter((c) => !existingIds.has(c.externalId))
    .map(({ adj, externalId }) => ({
      externalId,
      channel: "Amazon",
      orderId: adj.orderId!,
      amazonOrderId: adj.orderId!,
      adjustmentDate: adj.date?.split("T")[0] || "",
      adjustmentType: adj.type,
      adjustmentAmount: adj.amount,
      adjustmentReason: adj.reason,
      sku: adj.sku,
    }));

  // We already filtered out existing rows via the `existingIds` set above, so
  // a plain createMany is safe. (Prisma's `skipDuplicates` flag isn't typed for
  // SQLite in this version of the client.)
  let newCount = 0;
  if (toCreate.length > 0) {
    const result = await prisma.shippingAdjustment.createMany({
      data: toCreate,
    });
    newCount = result.count;
  }

  return NextResponse.json({
    scanned: allAdjustments.length,
    newSaved: newCount,
    stores: stores.length,
  });
}
