import { NextResponse } from "next/server";
import { getOrders } from "@/lib/amazon-sp-api/orders";
import { getFinancialEvents } from "@/lib/amazon-sp-api/finances";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Record<string, any> = {};

  results.configuredStores = getConfiguredStores();

  // Test 1: Get recent orders (last 7 days)
  try {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    const orders = await getOrders({
      storeId: "store1",
      createdAfter: sevenDaysAgo,
      maxResults: 5,
    });
    results.orders = {
      success: true,
      count: orders.length,
      sample: orders[0]?.AmazonOrderId,
    };
  } catch (err) {
    results.orders = { success: false, error: String(err) };
  }

  // Test 2: Get financial events (last 14 days)
  try {
    const fourteenDaysAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000
    ).toISOString();
    const events = await getFinancialEvents({
      storeId: "store1",
      postedAfter: fourteenDaysAgo,
      maxResults: 5,
    });
    results.finances = { success: true, eventGroups: events.length };
  } catch (err) {
    results.finances = { success: false, error: String(err) };
  }

  const allPassed = Object.values(results)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) => r.success !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .every((r: any) => r.success);

  return NextResponse.json({
    status: allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED",
    results,
  });
}
