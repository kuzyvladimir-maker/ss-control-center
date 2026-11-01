/**
 * GET /api/cron/customer-hub-reconcile
 *
 * Every 15 min (owner, topic 42, 2026-11-01 — "at least every 30 min, all 5
 * stores"): reconcile the hub against the inbox (inbox-watch.ts).
 *  - every unanswered buyer message of the last 7 days must have a live card
 *    or VPS task; if not, the card is built now (force_card);
 *  - one INBOX_SCAN task per store for the account VPS (read-only list of
 *    Seller Central "Response needed"); anything the hub closed that Seller
 *    Central still shows as Response Needed is reopened;
 *  - overdue / < 6 h / card without decision > 2 h → an alert card for topic
 *    42 (Jackie posts it like any card).
 *
 * ?dry=1 — report only, no writes. CRON_SECRET via Bearer guards callers.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { inboxStatus, reconcileInbox } from "@/lib/customer-hub/inbox-watch";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dry") === "1";
  const startedAt = new Date();
  const result = await reconcileInbox({ budgetMs: 220_000, dryRun });
  const status = await inboxStatus();

  if (!dryRun) {
    await prisma.syncLog
      .create({
        data: {
          jobName: "customer-hub-reconcile",
          startedAt,
          completedAt: new Date(),
          status: result.errors.length ? "error" : "done",
          itemsSynced: result.built.length,
          error: result.errors.join(" | ").slice(0, 1000) || null,
        },
      })
      .catch(() => undefined);
  }

  return NextResponse.json({ ok: true, dryRun, ...result, totals: status.totals, stores: status.stores });
}
