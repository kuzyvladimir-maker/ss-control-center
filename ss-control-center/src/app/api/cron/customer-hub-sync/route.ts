/**
 * GET /api/cron/customer-hub-sync
 *
 * Every 30 min: ingest new Amazon buyer messages from the Gmail mailboxes of
 * ACTIVE Amazon stores into the Customer Hub (same code path as the hub's
 * Sync button — src/lib/customer-hub/sync-messages.ts).
 *
 * Before 2026-10-18 there was no cron at all; ingest ran only when someone
 * pressed Sync, last on 2026-05-30, so the hub (and the Dashboard "Cases
 * open" tile) read 0 while 100+ buyer emails sat in amazon@salutem.solutions.
 *
 * ?window=14d — optional wider Gmail lookback for a one-off backfill
 * (1–30 days). CRON_SECRET via Bearer guards external callers.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncBuyerMessagesFromGmail } from "@/lib/customer-hub/sync-messages";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const w = request.nextUrl.searchParams.get("window");
  const window =
    w && /^\d{1,2}d$/.test(w) && parseInt(w, 10) >= 1 && parseInt(w, 10) <= 30
      ? w
      : "2d";

  const stores = await prisma.store.findMany({
    where: { channel: "Amazon", active: true, storeIndex: { not: null } },
    select: { storeIndex: true },
  });
  const storeIndexes = stores.map((s) => s.storeIndex as number);

  const startedAt = new Date();
  const result = await syncBuyerMessagesFromGmail({ window, storeIndexes });

  await prisma.syncLog
    .create({
      data: {
        jobName: "customer-hub-sync",
        startedAt,
        completedAt: new Date(),
        status: result.errors?.length && result.accounts === 0 ? "error" : "done",
        itemsSynced: result.synced,
        error: result.errors?.join(" | ").slice(0, 1000) ?? null,
      },
    })
    .catch(() => undefined);

  return NextResponse.json({ ok: true, window, storeIndexes, ...result });
}
