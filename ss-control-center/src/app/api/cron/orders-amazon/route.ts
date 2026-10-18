/**
 * GET /api/cron/orders-amazon
 *
 * Lightweight Amazon orders refresh — pulls every order CHANGED in the last
 * 3 days (LastUpdatedAfter, not CreatedAfter) per configured store and
 * upserts to `amazonOrder`, so late shipments/cancellations of older orders
 * also land. Designed to fit
 * inside Vercel Hobby's 10s function timeout, which the heavier 30-day
 * `/api/sync` doesn't reliably do.
 *
 * Why this exists: Dashboard's "Sales today" card reads from amazonOrder.
 * Without a regular sync, orders that arrive after the last Refresh button
 * press never land in the DB, so today's revenue card permanently reads
 * $0 unless Vladimir manually refreshes (which itself may time out).
 *
 * Schedule (vercel.json): every 2 hours. 3-day overlap window means each
 * order is re-pulled ~12 times before it ages out — the upsert handles
 * the duplication and picks up status changes for free.
 *
 * Auth: CRON_SECRET via Bearer header (Vercel sets this automatically).
 */

import { NextRequest, NextResponse } from "next/server";
import { syncOrders } from "@/lib/sync/orders-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { prisma } from "@/lib/prisma";
import { activeAmazonStoreIndexes } from "@/lib/stores/active-amazon";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const WINDOW_DAYS = 3;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Array<{
    storeIndex: number;
    success: boolean;
    synced?: number;
    error?: string;
  }> = [];

  // Sequential, not parallel — Amazon SP-API rate-limits per seller account,
  // running all 5 stores at once just creates 429s and burns retry budget.
  // A small sleep between stores spreads the load further.
  const active = await activeAmazonStoreIndexes();
  for (let storeIndex = 1; storeIndex <= 5; storeIndex++) {
    if (!getStoreCredentials(storeIndex)) continue;
    if (!active.has(storeIndex)) continue; // blocked / inactive account
    try {
      const synced = await syncOrders(storeIndex, WINDOW_DAYS, "updated");
      results.push({ storeIndex, success: true, synced });
    } catch (err) {
      results.push({
        storeIndex,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(500);
  }

  // One SyncLog row per run → the Dashboard "Synced Xh ago" chip reads the
  // Amazon orders feed itself. "done" if at least one store synced; per-
  // store failures (e.g. SP-API 403) are kept in `error`.
  const failed = results.filter((r) => !r.success);
  const synced = results.reduce((n, r) => n + (r.synced ?? 0), 0);
  await prisma.syncLog
    .create({
      data: {
        jobName: "orders-amazon",
        status: results.some((r) => r.success) ? "done" : "error",
        completedAt: new Date(),
        itemsSynced: synced,
        error: failed.length
          ? failed.map((f) => `store${f.storeIndex}: ${f.error}`).join(" | ").slice(0, 1000)
          : null,
      },
    })
    .catch(() => undefined);

  return NextResponse.json({
    ok: true,
    windowDays: WINDOW_DAYS,
    results,
  });
}
