import { NextRequest, NextResponse } from "next/server";

// POST /api/external/shipping — proxy to /api/shipping/plan or /api/shipping/buy
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  const baseUrl = request.nextUrl.origin;

  if (action === "plan") {
    const res = await fetch(`${baseUrl}/api/shipping/plan`);
    return NextResponse.json(await res.json(), { status: res.status });
  }

  if (action === "buy") {
    const res = await fetch(`${baseUrl}/api/shipping/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: body.planId, orderIds: body.orderIds }),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
