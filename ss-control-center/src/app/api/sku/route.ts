import { NextRequest, NextResponse } from "next/server";
import { fetchSkuDatabase } from "@/lib/google-sheets";

export async function GET(request: NextRequest) {
  try {
    const search = request.nextUrl.searchParams.get("search")?.toLowerCase();

    let rows = await fetchSkuDatabase();

    if (search) {
      rows = rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(search) ||
          r.productTitle.toLowerCase().includes(search)
      );
    }

    return NextResponse.json({
      total: rows.length,
      rows,
    });
  } catch (error) {
    console.error("SKU fetch error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch SKU data",
      },
      { status: 500 }
    );
  }
}
