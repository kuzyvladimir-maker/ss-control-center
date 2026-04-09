import { NextRequest, NextResponse } from "next/server";

// POST /api/external/cs — proxy to /api/cs/analyze
export async function POST(request: NextRequest) {
  const body = await request.json();
  const baseUrl = request.nextUrl.origin;

  const res = await fetch(`${baseUrl}/api/cs/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return NextResponse.json(await res.json(), { status: res.status });
}

// GET /api/external/cs — list cases
export async function GET(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;
  const params = request.nextUrl.searchParams.toString();

  const res = await fetch(`${baseUrl}/api/cs/cases?${params}`);
  return NextResponse.json(await res.json(), { status: res.status });
}
