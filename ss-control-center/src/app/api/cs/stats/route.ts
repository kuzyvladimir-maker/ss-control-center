import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const now = new Date();
  const todayStart = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  todayStart.setHours(0, 0, 0, 0);

  const [today, open, critical, a2zPending] = await Promise.all([
    prisma.csCase.count({
      where: { createdAt: { gte: todayStart } },
    }),
    prisma.csCase.count({
      where: { status: "open" },
    }),
    prisma.csCase.count({
      where: { priority: "CRITICAL", status: { not: "resolved" } },
    }),
    prisma.csCase.count({
      where: { action: "A2Z_GUARANTEE", status: "open" },
    }),
  ]);

  return NextResponse.json({ today, open, critical, a2zPending });
}
