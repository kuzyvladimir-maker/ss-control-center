/**
 * GET /api/cron/bundle-factory-tick
 *
 * Phase 5.2 — build resumability backstop.
 *
 * The studio generator advances one listing per `tickBatch` call, driven by the
 * browser polling the progress page. If the operator navigates away mid-build,
 * the browser stops ticking and the batch stalls. This cron finds GenerationJobs
 * still IN_PROGRESS and advances them server-side until done (or a time budget),
 * so an abandoned build finishes on its own.
 *
 * Only IN_PROGRESS jobs are touched — a job reaches IN_PROGRESS only after its
 * first studio tick (prompt parsed + donors sourced), so old PENDING brief-flow
 * jobs are never picked up.
 *
 * CRON_SECRET via Bearer guards external callers; Vercel cron injects it.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tickBatch } from "@/lib/bundle-factory/studio-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Stay comfortably within maxDuration; each tick is one Claude content call.
  const deadline = Date.now() + 250_000;

  const jobs = await prisma.generationJob.findMany({
    where: { status: "IN_PROGRESS" },
    select: { id: true },
    orderBy: { created_at: "asc" },
    take: 5,
  });

  const results: Array<{
    id: string;
    ticks: number;
    done: boolean;
    failed: number;
  }> = [];

  for (const job of jobs) {
    let ticks = 0;
    let done = false;
    let failed = 0;
    while (Date.now() < deadline) {
      const p = await tickBatch(job.id);
      ticks++;
      failed = p.failed;
      if (p.done_flag || p.status === "COMPLETED" || p.status === "FAILED") {
        done = true;
        break;
      }
    }
    results.push({ id: job.id, ticks, done, failed });
    if (Date.now() >= deadline) break;
  }

  return NextResponse.json({ ok: true, in_progress: jobs.length, results });
}
