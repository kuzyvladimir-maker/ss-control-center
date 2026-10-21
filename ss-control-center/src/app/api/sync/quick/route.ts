/**
 * POST /api/sync/quick
 *
 * Fired by the Dashboard on every page load/refresh (not just the manual
 * "Refresh" button) so tiles reflect live data instead of whatever the last
 * 2-hourly cron run left behind. Does the same `syncOrders(storeIndex, 3,
 * "updated")` pull as `/api/cron/orders-amazon`, just reachable from an
 * authenticated browser session instead of CRON_SECRET.
 *
 * Debounced via `SyncLog` (no extra table): a row in `running` status
 * younger than LOCK_TTL_MS means another request is already syncing, and a
 * `done`/`error` row younger than MIN_INTERVAL_MS means we just synced and
 * there's nothing new to pull yet. Both cases return immediately instead of
 * hitting SP-API again — this is what keeps a page that auto-refreshes
 * every few seconds from re-triggering a real sync on every poll.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncOrders } from "@/lib/sync/orders-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { activeAmazonStoreIndexes } from "@/lib/stores/active-amazon";

export const maxDuration = 30;

const JOB_NAME = "orders-amazon";
const LOCK_TTL_MS = 25_000;
const MIN_INTERVAL_MS = 45_000;

export async function POST() {
  try {
    const latest = await prisma.syncLog.findFirst({
      where: { jobName: JOB_NAME },
      orderBy: { startedAt: "desc" },
    });

    if (latest) {
      const age = Date.now() - latest.startedAt.getTime();
      if (latest.status === "running" && age < LOCK_TTL_MS) {
        return NextResponse.json({ skipped: true, reason: "in-progress" });
      }
      if (latest.status !== "running" && age < MIN_INTERVAL_MS) {
        return NextResponse.json({
          skipped: true,
          reason: "recently-synced",
          syncedAt: latest.completedAt?.toISOString() ?? latest.startedAt.toISOString(),
        });
      }
    }

    const lock = await prisma.syncLog.create({
      data: { jobName: JOB_NAME, status: "running" },
    });

    const active = await activeAmazonStoreIndexes();
    const results: Array<{ storeIndex: number; success: boolean; synced?: number; error?: string }> = [];

    for (const storeIndex of active) {
      if (!getStoreCredentials(storeIndex)) continue;
      try {
        const synced = await syncOrders(storeIndex, 3, "updated");
        results.push({ storeIndex, success: true, synced });
      } catch (err) {
        results.push({
          storeIndex,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const failed = results.filter((r) => !r.success);
    await prisma.syncLog.update({
      where: { id: lock.id },
      data: {
        status: results.some((r) => r.success) ? "done" : "error",
        completedAt: new Date(),
        itemsSynced: results.reduce((n, r) => n + (r.synced ?? 0), 0),
        error: failed.length
          ? failed.map((f) => `store${f.storeIndex}: ${f.error}`).join(" | ").slice(0, 1000)
          : null,
      },
    });

    return NextResponse.json({ skipped: false, results });
  } catch (error) {
    console.error("[sync/quick] POST failed:", error);
    return NextResponse.json({ error: "Quick sync failed" }, { status: 500 });
  }
}
