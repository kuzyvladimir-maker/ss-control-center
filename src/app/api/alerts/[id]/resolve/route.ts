import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/alerts/[id]/resolve
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const updated = await prisma.criticalAlert.update({
    where: { id },
    data: { resolvedAt: new Date(), acknowledged: true },
  });
  return NextResponse.json({ resolvedAt: updated.resolvedAt });
}
