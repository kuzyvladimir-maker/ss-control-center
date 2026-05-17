import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncOrders } from "@/lib/sync/orders-sync";
import { syncFinancialEvents } from "@/lib/sync/finances-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

// Vercel default function timeout is 10s on Hobby and 60s on Pro. Fanning
// out every sync pipeline (5 stores × 2 jobs + Walmart + Account Health +
// Procurement) easily takes 60–90s, so bump the ceiling so the Dashboard
// "Refresh" button doesn't return half-way through.
export const maxDuration = 300;

// Account Health is intentionally NOT synced from this endpoint anymore.
// The hand-rolled metrics in account-health-sync.ts diverge from Amazon's
// official numbers (FBA filtering / proprietary shipment events we can't see),
// so it would overwrite the good Reports-API snapshot with wrong data every
// time the Dashboard Refresh button or Settings "Sync all" is pressed.
// Account Health flows through its own pipeline now:
//   - daily cron        /api/cron/account-health-amazon  (uses Reports API)
//   - manual refresh    /account-health "Refresh all" button

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

    if (job === "health") {
      // Defensive: anything still calling /api/sync?job=health gets pointed
      // at the right place rather than silently running the legacy path.
      results.health = {
        success: false,
        error:
          "Account Health is no longer synced via /api/sync. Use the daily cron or the Refresh button on /account-health.",
      };
    }

    // Fan out to the rest of the sync pipelines (Walmart orders, Account
    // Health Amazon + Walmart, Procurement priority). They live as cron
    // routes that take the same Bearer secret Vercel uses internally,
    // so we just call them with our own origin. Each runs independently:
    // failures of one don't poison the others or the JSON response we
    // hand back to the Refresh button.
    if (job === "all") {
      const fanOut = await fanOutToCronJobs(request);
      Object.assign(results, fanOut);
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

// Trigger the cron-only sync handlers (Walmart, Account Health,
// Procurement) from the user-facing /api/sync POST. They authenticate
// via Bearer ${CRON_SECRET}, the same header Vercel adds for scheduled
// runs, so as long as the env var is set we can call ourselves and the
// Authorization check passes.
async function fanOutToCronJobs(
  request: NextRequest,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    out["cronFanOut"] = {
      success: false,
      error:
        "CRON_SECRET not set — can't authenticate self-call to cron routes. " +
        "Walmart / Account Health / Procurement won't be refreshed by this " +
        "button until CRON_SECRET is configured on the Vercel project.",
    };
    return out;
  }

  // request.nextUrl.origin gives us the live host (preview deploys, prod,
  // localhost) without needing a hard-coded URL.
  const origin = request.nextUrl.origin;
  const jobs: Array<{ key: string; path: string }> = [
    { key: "walmart", path: "/api/cron/walmart" },
    { key: "accountHealthAmazon", path: "/api/cron/account-health-amazon" },
    { key: "accountHealthWalmart", path: "/api/cron/account-health-walmart" },
    { key: "procurementPriority", path: "/api/cron/procurement-priority" },
  ];

  const settled = await Promise.allSettled(
    jobs.map(async (j) => {
      const r = await fetch(`${origin}${j.path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      });
      const body = await r.json().catch(() => ({}));
      return { key: j.key, ok: r.ok, status: r.status, body };
    }),
  );

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const s = settled[i];
    if (s.status === "fulfilled") {
      out[j.key] = {
        success: s.value.ok,
        status: s.value.status,
        result: s.value.body,
      };
    } else {
      out[j.key] = {
        success: false,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      };
    }
  }
  return out;
}
