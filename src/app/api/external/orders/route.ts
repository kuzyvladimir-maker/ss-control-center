import { NextRequest, NextResponse } from "next/server";

// GET /api/external/orders — proxy to Veeqo orders
export async function GET(request: NextRequest) {
  try {
    const baseUrl = request.nextUrl.origin;
    const params = request.nextUrl.searchParams.toString();

    const res = await fetch(`${baseUrl}/api/veeqo/orders?${params}`);
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: "Upstream returned non-JSON response", raw: text.slice(0, 500) };
    }
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[external/orders] proxy failed:", err);
    return NextResponse.json(
      { error: "Upstream request failed", detail: (err as Error).message },
      { status: 502 }
    );
  }
}
