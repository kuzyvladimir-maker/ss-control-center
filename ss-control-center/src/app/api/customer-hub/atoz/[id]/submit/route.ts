import { NextRequest, NextResponse } from "next/server";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // TODO: submit A-to-Z response
  return NextResponse.json({ id, submitted: false, error: "Not implemented" });
}
