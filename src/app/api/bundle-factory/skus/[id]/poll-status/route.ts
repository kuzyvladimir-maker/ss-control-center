/**
 * POST /api/bundle-factory/skus/[id]/poll-status
 *
 * Manual submission-status poll for a single ChannelSKU. Re-checks
 * Amazon /listings/items/{seller}/{sku} or Walmart /feeds/{feedId}
 * and updates listing_status + distribution_errors + last_status_check_at.
 *
 * No side effects on the marketplace itself — purely a status refresh.
 * Used by the UI Poll Status button on SUBMITTED rows.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  persistPollResult,
  pollSubmissionStatus,
} from "@/lib/bundle-factory/distribution/status-poller";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandler(
  "skus[id]/poll-status[POST]",
  async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const sku = await prisma.channelSKU.findUnique({ where: { id } });
    if (!sku) {
      return NextResponse.json({ error: "ChannelSKU not found" }, { status: 404 });
    }
    const result = await pollSubmissionStatus(sku);
    await persistPollResult(result);
    return NextResponse.json(result);
  },
);
