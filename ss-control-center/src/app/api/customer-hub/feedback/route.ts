import { NextResponse } from "next/server";
export async function GET() {
  // TODO: fetch seller feedback
  return NextResponse.json({ feedback: [], total: 0 });
}
