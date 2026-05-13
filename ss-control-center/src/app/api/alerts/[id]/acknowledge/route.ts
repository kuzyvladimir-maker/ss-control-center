import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth-server";

// POST /api/alerts/[id]/acknowledge
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const me = await getCurrentUser(request);
  const updated = await prisma.criticalAlert.update({
    where: { id },
    data: {
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: me?.username ?? "api-token",
    },
  });
  return NextResponse.json({ acknowledgedAt: updated.acknowledgedAt });
}
