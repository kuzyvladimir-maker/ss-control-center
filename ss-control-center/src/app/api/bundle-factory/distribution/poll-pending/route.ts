/**
 * POST /api/bundle-factory/distribution/poll-pending
 *      Query: ?olderThanMinutes=N  (default 5)
 *             ?limit=N             (default 50 — protect against runaway)
 *
 * Manual/authenticated trigger for the poll-pending loop (the scheduled one is
 * /api/cron/bundle-factory-poll-pending). Both share runPollPending() so the
 * self-heal logic never diverges.
 *
 * Auth: the standard SSCC_API_TOKEN middleware gates this path.
 */

import { NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { runPollPending } from "@/lib/bundle-factory/distribution/poll-pending-core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withErrorHandler(
  "distribution/poll-pending[POST]",
  async (request: Request) => {
    const url = new URL(request.url);
    const summary = await runPollPending({
      olderThanMinutes: Number(url.searchParams.get("olderThanMinutes") ?? 5),
      limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return NextResponse.json(summary);
  },
);
