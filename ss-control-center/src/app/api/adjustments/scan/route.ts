import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getFinancialEvents,
  parseAdjustments,
} from "@/lib/amazon-sp-api/finances";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";

export async function POST() {
  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allAdjustments: any[] = [];
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

  // Save new adjustments (skip duplicates via externalId)
  let newCount = 0;
  for (const adj of allAdjustments) {
    if (!adj.orderId) continue;
    const externalId = `${adj.orderId}-${adj.date}-${adj.type}`;

    try {
      const exists = await prisma.shippingAdjustment.findUnique({
        where: { externalId },
      });
      if (!exists) {
        await prisma.shippingAdjustment.create({
          data: {
            externalId,
            channel: "Amazon",
            orderId: adj.orderId,
            amazonOrderId: adj.orderId,
            adjustmentDate: adj.date?.split("T")[0] || "",
            adjustmentType: adj.type,
            adjustmentAmount: adj.amount,
            adjustmentReason: adj.reason,
            sku: adj.sku,
          },
        });
        newCount++;
      }
    } catch {
      // skip duplicates silently
    }
  }

  return NextResponse.json({
    scanned: allAdjustments.length,
    newSaved: newCount,
    stores: stores.length,
  });
}
