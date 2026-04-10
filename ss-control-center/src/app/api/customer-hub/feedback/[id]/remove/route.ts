import { NextRequest, NextResponse } from "next/server";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // TODO: request feedback removal
  return NextResponse.json({ id, requested: false, error: "Not implemented" });
}
