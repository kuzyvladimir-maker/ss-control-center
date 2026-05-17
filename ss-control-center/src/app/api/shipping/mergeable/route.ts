// GET /api/shipping/mergeable
//
// Returns groups of awaiting-fulfillment orders that share a delivery
// signature (same channel + store + recipient + address). The UI uses
// this to surface a "X mergeable pairs" banner on Shipping Labels with
// a deep-link to Veeqo, where the operator does the actual merge click
// (Veeqo's public API has no merge endpoint — see
// docs/wiki/merge-orders-design.md).

import { NextResponse } from "next/server";
import { fetchAllOrders } from "@/lib/veeqo/client";
import {
  findMergeableGroups,
  veeqoMergeableUrl,
} from "@/lib/shipping/mergeable";

export const maxDuration = 60;

export async function GET() {
  try {
    // Veeqo's "awaiting_fulfillment" status covers everything that could
    // still be merged. We don't filter by ship_by here — merge candidacy
    // is independent of ship-by, and a customer can place two orders
    // with different ship-by dates that still go in one box.
    const orders = await fetchAllOrders("awaiting_fulfillment");
    const groups = findMergeableGroups(orders);
    return NextResponse.json({
      groupCount: groups.length,
      orderCount: groups.reduce((sum, g) => sum + g.orders.length, 0),
      veeqoUrl: veeqoMergeableUrl(),
      groups,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[shipping/mergeable] failed:", reason);
    return NextResponse.json(
      { error: reason, groupCount: 0, orderCount: 0, groups: [] },
      { status: 500 },
    );
  }
}
