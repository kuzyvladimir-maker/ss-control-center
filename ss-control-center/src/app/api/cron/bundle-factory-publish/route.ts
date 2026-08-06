/**
 * The backstop that makes a publish batch survive a closed browser tab.
 *
 * Batch publishing used to be a loop inside the operator's page: closing the
 * tab abandoned the batch half-sent. This advances open batches server-side,
 * one listing per tick, so the only thing the page does is watch.
 *
 * It also decides whether the factory publishes on its own, from the operator
 * switch (see factory-mode.ts):
 *
 *   SEMI_AUTO — only advances batches a PERSON queued. Never starts one.
 *   AUTO      — additionally queues listings that are validated and waiting,
 *               within the same rolling 24-hour ceiling.
 *
 * Either way every fence is identical: validation, sealed approval, the
 * one-shot claim, one SKU per POST, and the daily cap. On top of those sit the
 * rails (see walmart-factory-rails.ts), which can stop the schedule outright:
 * a pause a person pulled, a refusal rate that says stop guessing, or a product
 * ID pool too low to spend unattended.
 */

import { NextResponse, type NextRequest } from "next/server";

import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { readFactoryMode } from "@/lib/bundle-factory/factory-mode";
import { readFactoryRails } from "@/lib/bundle-factory/walmart-factory-rails";
import { isPublishableListingStatus } from "@/lib/bundle-factory/publishable-listing-status";
import {
  enqueuePublishBatch,
  listOpenPublishBatches,
  readPublishCapState,
  tickPublishBatch,
} from "@/lib/bundle-factory/publish-queue";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Listings a person already validated, not queued, not out, not dead-UPC. */
async function findAutoPublishableDrafts(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const skus = await prisma.channelSKU.findMany({
    where: {
      channel: "WALMART",
      validation_status: "PASSED",
      live_url: null,
    },
    select: {
      upc: true,
      sku: true,
      listing_status: true,
      master_bundle_id: true,
    },
    take: limit * 4,
  });
  const publishable = skus.filter((row) =>
    isPublishableListingStatus(row.listing_status));
  if (publishable.length === 0) return [];

  // A quarantined product ID guarantees the same rejection; the schedule must
  // not spend its ceiling re-submitting listings that cannot succeed.
  const dead = await prisma.uPCPool.findMany({
    where: {
      status: "QUARANTINED",
      upc: { in: publishable.map((row) => row.upc) },
    },
    select: { upc: true },
  });
  const deadUpcs = new Set(dead.map((row) => row.upc));

  const masterIds = publishable
    .filter((row) => !deadUpcs.has(row.upc))
    .map((row) => row.master_bundle_id);
  if (masterIds.length === 0) return [];

  const drafts = await prisma.bundleDraft.findMany({
    where: { master_bundle_id: { in: masterIds } },
    orderBy: { updated_at: "asc" },
    select: { id: true },
    take: limit,
  });
  return drafts.map((row) => row.id);
}

export const GET = withErrorHandler(
  "cron-bundle-factory-publish",
  async (request: NextRequest) => {
    // Same Bearer CRON_SECRET gate as every other cron. This one can start
    // marketplace writes, so an open endpoint is not an option.
    const secret = process.env.CRON_SECRET;
    if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const mode = await readFactoryMode();
    const cap = await readPublishCapState();
    const rails = await readFactoryRails();
    const started: string[] = [];

    // A pause outranks everything, including a batch a person queued: it is the
    // handle you pull when you have just seen something wrong and want the
    // writing to stop now, not after the queue drains.
    if (rails.blocks.includes("PAUSED")) {
      return NextResponse.json({
        ok: true,
        mode,
        cap,
        rails,
        started_batches: [],
        open_batches: 0,
        ticks: [],
      });
    }

    if (mode === "AUTO" && cap.remaining > 0 && rails.allowed) {
      const drafts = await findAutoPublishableDrafts(cap.remaining);
      if (drafts.length > 0) {
        const enqueued = await enqueuePublishBatch({
          draftIds: drafts,
          actor: "factory-schedule",
          note: `AUTO mode: ${drafts.length} listing(s) queued by the schedule`,
        });
        if (enqueued.batchId) started.push(enqueued.batchId);
      }
    }

    // Advance whatever is open — including batches a person queued by hand,
    // which is the whole point of the backstop.
    const open = await listOpenPublishBatches(5);
    const ticks: Array<{ batchId: string; advanced: boolean; reason?: string }> = [];
    for (const batchId of open) {
      // One listing per batch per tick keeps a long batch from starving the
      // others and keeps the request inside its time budget.
      const result = await tickPublishBatch(batchId);
      ticks.push({
        batchId,
        advanced: result.advanced,
        ...(result.idleReason ? { reason: result.idleReason } : {}),
      });
    }

    return NextResponse.json({
      ok: true,
      mode,
      cap,
      rails,
      started_batches: started,
      open_batches: open.length,
      ticks,
    });
  },
);
