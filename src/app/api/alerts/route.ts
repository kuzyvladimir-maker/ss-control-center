import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/alerts?storeId=&channel=&severity=
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const where: Record<string, unknown> = {};
  const storeId = sp.get("storeId");
  const channel = sp.get("channel");
  const severity = sp.get("severity");
  if (storeId) where.storeId = storeId;
  if (channel) where.channel = channel;
  if (severity) where.severity = severity;

  const [alerts, total] = await Promise.all([
    prisma.criticalAlert.findMany({
      where,
      orderBy: { detectedAt: "desc" },
      take: 100,
    }),
    prisma.criticalAlert.count({ where }),
  ]);
  return NextResponse.json({ alerts, total });
}
