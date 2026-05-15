// PATCH /api/frozen/alerts/[id]
//
// Operator action on a risk alert. Fields:
//   status                  — pending | applied | ignored | resolved
//   userNotes               — free text
//   shippingChoiceFollowed  — boolean (for learning loop)
//   appliedBy               — operator name (defaults to "Vladimir")

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface PatchBody {
  status?: string;
  userNotes?: string;
  shippingChoiceFollowed?: boolean;
  appliedBy?: string;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json()) as PatchBody;

  const data: Record<string, unknown> = {};
  if (body.status) {
    data.status = body.status;
    if (body.status === "applied") data.appliedAt = new Date();
  }
  if (body.userNotes !== undefined) data.userNotes = body.userNotes;
  if (body.shippingChoiceFollowed !== undefined) {
    data.shippingChoiceFollowed = body.shippingChoiceFollowed;
  }
  if (body.appliedBy) data.appliedBy = body.appliedBy;

  try {
    const updated = await prisma.frozenRiskAlert.update({
      where: { id },
      data,
    });
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}
