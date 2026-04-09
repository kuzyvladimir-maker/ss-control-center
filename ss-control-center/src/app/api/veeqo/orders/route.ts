import { NextRequest, NextResponse } from "next/server";
import { fetchAllOrders } from "@/lib/veeqo";

export async function GET(request: NextRequest) {
  try {
    const status =
      request.nextUrl.searchParams.get("status") || "awaiting_fulfillment";
    const orders = await fetchAllOrders(status);
    return NextResponse.json(orders);
  } catch (error) {
    console.error("Veeqo orders error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch orders",
      },
      { status: 500 }
    );
  }
}
