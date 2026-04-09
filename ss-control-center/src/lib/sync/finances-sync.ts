import { prisma } from "@/lib/prisma";
import {
  getFinancialEvents,
  parseAdjustments,
} from "@/lib/amazon-sp-api/finances";

export async function syncFinancialEvents(
  storeIndex: number
): Promise<number> {
  const storeId = `store${storeIndex}`;
  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  const events = await getFinancialEvents({
    storeId,
    postedAfter: fourteenDaysAgo,
  });

  const adjustments = parseAdjustments(events);
  let synced = 0;

  for (const adj of adjustments) {
    if (!adj.orderId) continue;
    const externalId = `${adj.orderId}-${adj.date}-${adj.type}-${adj.amount}`;

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
        synced++;
      }
    } catch {
      // skip duplicates
    }
  }

  return synced;
}
