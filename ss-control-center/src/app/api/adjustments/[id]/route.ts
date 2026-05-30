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

    // Setting disputeCaseId implicitly stamps disputedAt (now) unless the
    // caller explicitly cleared it. Marking reviewed is also implied when
    // a dispute is filed — the operator clearly looked at the row.
    const data: Record<string, unknown> = {};
    if (body.reviewed !== undefined) data.reviewed = body.reviewed;
    if (body.skuDataFixed !== undefined) data.skuDataFixed = body.skuDataFixed;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.disputeCaseId !== undefined) {
      const cleaned = body.disputeCaseId
        ? String(body.disputeCaseId).trim() || null
        : null;
      data.disputeCaseId = cleaned;
      data.disputedAt = cleaned ? new Date() : null;
      if (cleaned) data.reviewed = true;
    }

    const adj = await prisma.shippingAdjustment.update({
      where: { id },
      data,
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
