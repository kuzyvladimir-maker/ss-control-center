/**
 * GET /api/cron/sync-watchdog
 *
 * Runs every 30 min (vercel.json). Exists because the 2-hourly
 * `/api/cron/orders-amazon` sync failed silently for 32h on 2026-10-21 (an
 * expired Amazon LWA client secret for store1 — `invalid_client` on every
 * token exchange) before anyone noticed: every run wrote a SyncLog "error"
 * row, but nothing paged Vladimir and nothing retried.
 *
 * Self-heal attempt: re-run the same sync inline. A transient failure
 * (network blip, SP-API 429, Vercel/DB hiccup) usually clears on retry and
 * nothing is sent. A persistent failure (revoked/expired credentials) will
 * not clear by retrying — in that case the Telegram alert carries the exact
 * error so the fix is obvious instead of just "something is stale".
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncOrders } from "@/lib/sync/orders-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { activeAmazonStoreIndexes } from "@/lib/stores/active-amazon";
import { sendCriticalAlert } from "@/lib/telegram";

const STALE_MS = 2 * 3600000;
const ALERT_DEDUP_MS = 2 * 3600000;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const latest = await prisma.syncLog.findFirst({
    where: { jobName: "orders-amazon" },
    orderBy: { startedAt: "desc" },
  });
  const age = latest ? Date.now() - latest.startedAt.getTime() : Infinity;
  if (age <= STALE_MS) {
    return NextResponse.json({ ok: true, stale: false, ageMs: age === Infinity ? null : age });
  }

  // Self-heal: try the sync again right now, inline (not via self-fetch —
  // this route already proved the sync logic works when called directly).
  const active = await activeAmazonStoreIndexes();
  const results: Array<{ storeIndex: number; success: boolean; error?: string }> = [];
  for (const storeIndex of active) {
    if (!getStoreCredentials(storeIndex)) continue;
    try {
      await syncOrders(storeIndex, 3, "updated");
      results.push({ storeIndex, success: true });
    } catch (err) {
      results.push({
        storeIndex,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const allOk = results.length > 0 && results.every((r) => r.success);
  await prisma.syncLog.create({
    data: {
      jobName: "orders-amazon",
      status: allOk ? "done" : "error",
      completedAt: new Date(),
      error: allOk
        ? null
        : results
            .filter((r) => !r.success)
            .map((r) => `store${r.storeIndex}: ${r.error}`)
            .join(" | ")
            .slice(0, 1000),
    },
  });

  if (allOk) {
    return NextResponse.json({ ok: true, stale: true, selfHealed: true, results });
  }

  // Still broken after a live retry — page Vladimir, deduped per 2h so a
  // persistent outage doesn't spam every 30 min.
  const recentAlert = await prisma.criticalAlert.findFirst({
    where: {
      alertType: "orders-sync-stale",
      detectedAt: { gte: new Date(Date.now() - ALERT_DEDUP_MS) },
    },
  });
  let telegramSent = false;
  if (!recentAlert) {
    const hours = (age / 3600000).toFixed(1);
    const errorText = results.find((r) => !r.success)?.error ?? "unknown error";
    const store = await prisma.store.findFirst({
      where: { channel: "Amazon", active: true },
      select: { id: true },
    });
    if (store) {
      await prisma.criticalAlert.create({
        data: {
          storeId: store.id,
          channel: "Amazon",
          alertType: "orders-sync-stale",
          severity: "CRITICAL",
          metricName: "ordersSyncAgeHours",
          metricValue: hours,
          metricThreshold: ">= 2",
          title: `Amazon orders sync has been failing for ${hours}h`,
          message: `Retried just now and it failed again: ${errorText}`,
          actionUrl: "/dashboard",
        },
      });
    }
    const result = await sendCriticalAlert(
      `🚨 *Amazon orders sync down ${hours}h*\n\nSelf-heal retry just failed again:\n\`${errorText}\`\n\nSales/Awaiting ship on the Dashboard are stale until this is fixed.`
    );
    telegramSent = result.sent;
  }

  return NextResponse.json({
    ok: true,
    stale: true,
    selfHealed: false,
    results,
    alertSent: telegramSent,
    alertDeduped: !!recentAlert,
  });
}
