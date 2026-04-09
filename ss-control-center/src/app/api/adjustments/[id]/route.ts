import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const adj = await prisma.shippingAdjustment.findUnique({ where: { id } });
  if (!adj) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(adj);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const adj = await prisma.shippingAdjustment.update({
      where: { id },
      data: {
        ...(body.reviewed !== undefined && { reviewed: body.reviewed }),
        ...(body.skuDataFixed !== undefined && { skuDataFixed: body.skuDataFixed }),
        ...(body.notes !== undefined && { notes: body.notes }),
      },
    });

    return NextResponse.json(adj);
  } catch (error) {
    console.error("Update adjustment error:", error);
    return NextResponse.json(
      { error: "Failed to update" },
      { status: 500 }
    );
  }
}
