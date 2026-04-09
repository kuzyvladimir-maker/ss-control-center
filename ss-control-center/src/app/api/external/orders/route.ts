import { NextRequest, NextResponse } from "next/server";

// GET /api/external/orders — proxy to Veeqo orders
export async function GET(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;
  const params = request.nextUrl.searchParams.toString();

  const res = await fetch(`${baseUrl}/api/veeqo/orders?${params}`);
  return NextResponse.json(await res.json(), { status: res.status });
}
