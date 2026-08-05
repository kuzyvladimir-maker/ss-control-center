/**
 * Watch or advance one publish batch.
 *
 * GET  — progress, for the page to poll.
 * POST — advance one listing (`{"action":"tick"}`) or stop the batch
 *        (`{"action":"cancel"}`).
 *
 * Ticking from the page is an accelerator, not the engine: the cron backstop
 * advances the same batch on its own schedule, so closing the tab only makes it
 * slower, never incomplete. Both paths go through the same durable claim, so a
 * page and the cron ticking at once cannot produce two POSTs for one listing.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import { readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  cancelPublishBatch,
  getPublishBatchProgress,
  tickPublishBatch,
} from "@/lib/bundle-factory/publish-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = withErrorHandler(
  "bundle-factory-publish-batch[GET]",
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const { id } = await context.params;
    const progress = await getPublishBatchProgress(id);
    if (!progress) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, progress });
  },
);

export const POST = withErrorHandler(
  "bundle-factory-publish-batch[POST]",
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const { id } = await context.params;
    const body = (await readJson<{ action?: unknown }>(request)) ?? {};
    const action = typeof body.action === "string" ? body.action : "tick";

    if (action === "cancel") {
      const progress = await cancelPublishBatch(id);
      return NextResponse.json({ ok: true, cancelled: true, progress });
    }
    if (action !== "tick") {
      return NextResponse.json(
        { error: 'action must be "tick" or "cancel"' },
        { status: 400 },
      );
    }

    const result = await tickPublishBatch(id);
    return NextResponse.json({ ok: true, ...result });
  },
);
