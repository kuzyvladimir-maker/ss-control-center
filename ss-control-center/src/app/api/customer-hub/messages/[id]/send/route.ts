import { NextRequest, NextResponse } from "next/server";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // TODO: send response via SP-API Messaging
  return NextResponse.json({ id, sent: false, error: "Not implemented" });
}
