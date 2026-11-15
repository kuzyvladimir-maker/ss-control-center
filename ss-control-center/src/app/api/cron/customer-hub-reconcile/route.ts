/** Retire disabled browser inbox tasks and report Amazon mail-source health. */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { inboxStatus, reconcileInbox } from "@/lib/customer-hub/inbox-watch";

export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dry") === "1";
  const startedAt = new Date();
  const result = await reconcileInbox({ budgetMs: 120_000, dryRun });
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
