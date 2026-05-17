// POST /api/alerts/acknowledge-all
//
// Marks every currently un-acknowledged CriticalAlert as acknowledged
// in one shot, so the operator doesn't have to click "Acknowledge" 20
// times when the bell fills up. Accepts an optional `{ severity: "…" }`
// body to scope the clear (e.g. only CRITICAL). Returns the count.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth-server";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const severity =
    typeof body?.severity === "string" ? body.severity : undefined;
  const me = await getCurrentUser(request);
  const result = await prisma.criticalAlert.updateMany({
    where: {
      acknowledged: false,
      ...(severity ? { severity } : {}),
    },
    data: {
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: me?.username ?? "api-token",
    },
  });
  return NextResponse.json({ acknowledged: result.count });
}
