import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncOrders } from "@/lib/sync/orders-sync";
import { syncFinancialEvents } from "@/lib/sync/finances-sync";
import { syncAllStores as syncAccountHealth } from "@/lib/amazon-sp-api/account-health-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function configuredStores(): number[] {
  return [1, 2, 3, 4, 5].filter((i) => getStoreCredentials(i));
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const job: string = body.job || "all";
  const storeIndex: number | undefined = body.storeIndex;

  const stores = storeIndex ? [storeIndex] : configuredStores();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Record<string, any> = {};

  // Log start
  const log = await prisma.syncLog.create({
    data: { jobName: job, storeIndex: storeIndex || null, status: "running" },
  });

  try {
    let totalSynced = 0;

    if (job === "all" || job === "orders") {
      for (const s of stores) {
        try {
          const count = await syncOrders(s);
          results[`orders_store${s}`] = { success: true, synced: count };
          totalSynced += count;
        } catch (e) {
          results[`orders_store${s}`] = {
            success: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        await sleep(1000);
      }
    }

    if (job === "all" || job === "finances") {
      for (const s of stores) {
        try {
          const count = await syncFinancialEvents(s);
          results[`finances_store${s}`] = { success: true, synced: count };
          totalSynced += count;
        } catch (e) {
          results[`finances_store${s}`] = {
            success: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        await sleep(1000);
      }
    }

    if (job === "all" || job === "health") {
      try {
        const healthResults = await syncAccountHealth();
        results.health = { success: true, stores: healthResults };
      } catch (e) {
        results.health = {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "done",
        itemsSynced: totalSynced,
        completedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      results,
      totalSynced,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
      },
    });

    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

export async function GET() {
  const recent = await prisma.syncLog.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return NextResponse.json({ recentSyncs: recent });
}
