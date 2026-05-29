/**
 * Per-store financial events sync — used by the dashboard fan-out.
 *
 * Uses the same parser + externalId scheme as /api/adjustments/scan.
 */

import { prisma } from "@/lib/prisma";
import {
  getFinancialEvents,
  parseAdjustments,
  buildAdjustmentExternalId,
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

  const parsed = parseAdjustments(events);
  let synced = 0;

  for (const adj of parsed) {
    const externalId = buildAdjustmentExternalId(adj, storeId);
    try {
      const exists = await prisma.shippingAdjustment.findUnique({
        where: { externalId },
      });
      if (!exists) {
        await prisma.shippingAdjustment.create({
          data: {
            externalId,
            channel: "Amazon",
            storeId,
            currency: adj.currency,
            orderId: adj.orderId ?? null,
            amazonOrderId: adj.orderId ?? null,
            adjustmentDate: adj.postedDate.split("T")[0] || "",
            adjustmentType: adj.type,
            rawType: adj.rawType,
            adjustmentAmount: adj.amount,
            adjustmentReason: adj.reason,
            sku: adj.sku ?? null,
          },
        });
        synced++;
      }
    } catch {
      // Race-condition dedup: another worker may have inserted between
      // findUnique and create. externalId is @unique so the second insert
      // throws — fine.
    }
  }

  return synced;
}
