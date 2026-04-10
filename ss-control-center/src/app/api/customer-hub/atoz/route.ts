import { NextResponse } from "next/server";
export async function GET() {
  // TODO: fetch A-to-Z claims
  return NextResponse.json({ claims: [], total: 0 });
}
