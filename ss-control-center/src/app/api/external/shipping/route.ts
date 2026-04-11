import { NextRequest, NextResponse } from "next/server";

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Upstream returned non-JSON response", raw: text.slice(0, 500) };
  }
}

// POST /api/external/shipping — proxy to /api/shipping/plan or /api/shipping/buy
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { action } = body as { action?: string };

    const baseUrl = request.nextUrl.origin;

    if (action === "plan") {
      const res = await fetch(`${baseUrl}/api/shipping/plan`);
      return NextResponse.json(await safeJson(res), { status: res.status });
    }

    if (action === "buy") {
      const { planId, orderIds } = body as { planId?: unknown; orderIds?: unknown };
      const res = await fetch(`${baseUrl}/api/shipping/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, orderIds }),
      });
      return NextResponse.json(await safeJson(res), { status: res.status });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("[external/shipping] proxy failed:", err);
    return NextResponse.json(
      { error: "Upstream request failed", detail: (err as Error).message },
      { status: 502 }
    );
  }
}
