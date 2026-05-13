import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/alerts/unacknowledged
// Polled by the topbar bell every 30s.
export async function GET() {
  const alerts = await prisma.criticalAlert.findMany({
    where: { acknowledged: false, resolvedAt: null },
    orderBy: { detectedAt: "desc" },
    take: 20,
  });
  return NextResponse.json({
    alerts,
    counts: {
      critical: alerts.filter((a) => a.severity === "CRITICAL").length,
      high: alerts.filter((a) => a.severity === "HIGH").length,
      total: alerts.length,
    },
  });
}
