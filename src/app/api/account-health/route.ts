import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Legacy endpoint — redirects to /api/amazon/account-health logic
export async function GET() {
  try {
    const snapshots = await prisma.accountHealthSnapshot.findMany({
      where: { syncStatus: "done" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const latestByStore = new Map<string, typeof snapshots[0]>();
    for (const snap of snapshots) {
      if (!latestByStore.has(snap.storeId)) {
        latestByStore.set(snap.storeId, snap);
      }
    }

    const alerts = await prisma.accountAlert.findMany({
      where: { resolved: false },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      stores: Array.from(latestByStore.values()),
      alerts,
    });
  } catch {
    return NextResponse.json({ stores: [], alerts: [] });
  }
}
