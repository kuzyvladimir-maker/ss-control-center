/**
 * The publish queue — a selected batch that finishes without a browser.
 *
 * Owner requirement 2026-08-03: select a batch of validated drafts, press
 * publish once, walk away. The previous implementation walked the selection in
 * the browser, so closing the tab abandoned the batch part-way through, and
 * 200 listings meant hours of an open tab.
 *
 * What this does NOT change — every one of these was bought with an incident
 * (AGENTS.md §7), and a queue is exactly the kind of code that quietly erodes
 * them:
 *
 *   · One SKU, one POST, zero retry. An item is marked `posted` BEFORE the
 *     write leaves, and nothing re-runs a posted item. When an item's fate is
 *     unknown, it ends UNKNOWN and is resolved by reading, never by sending.
 *   · Publishing stays the owner's decision. It becomes ONE decision per batch
 *     with a stated count and a daily ceiling, not the absence of a decision.
 *   · The daily ceiling counts real submissions, including ones made outside a
 *     batch, so it cannot be walked around by publishing rows by hand.
 */

import { prisma } from "@/lib/prisma";
import { publishOneDraft } from "@/lib/bundle-factory/publish-one-draft";

/** Only Walmart publishes through this queue today. */
export const PUBLISH_QUEUE_MARKETPLACE = "WALMART";

/** Setting key holding the daily ceiling, so it changes without a deploy. */
export const PUBLISH_DAILY_CAP_SETTING = "walmart_publish_daily_cap";

/**
 * Walmart's documented baseline throughput: roughly ten feeds an hour.
 * See docs/marketplace-rules/walmart/kb/feeds-maintenance-and-errors.md.
 */
export const WALMART_FEEDS_PER_HOUR = 10;

/**
 * The ceiling is what Walmart can actually take, not a number someone picked.
 *
 * It used to be a flat 25 a day. That was mine, not the owner's, and he said so
 * on 2026-08-06: "потолок может быть ограничен только количеством проходящих
 * фидов в Walmart и не меньше." So it is derived — feeds per hour × 24 —
 * and it rises on its own the moment a feed carries more than one listing.
 *
 * A setting still overrides it, for the case where someone deliberately wants
 * less. Nothing here removes the rolling window, the rails, or the fences: the
 * ceiling bounds volume, and those bound correctness.
 */
export function derivedPublishDailyCap(listingsPerFeed = 1): number {
  return WALMART_FEEDS_PER_HOUR * 24 * Math.max(1, listingsPerFeed);
}

export const PUBLISH_DAILY_CAP_DEFAULT = derivedPublishDailyCap();

/**
 * A claim older than this whose POST never happened is considered abandoned.
 * Generous on purpose: a single publish runs promote → validate → approve →
 * feed POST, and reclaiming a listing that is merely slow would be the one
 * mistake this whole module exists to prevent.
 */
const ITEM_LEASE_MS = 15 * 60 * 1000;

export interface PublishCapState {
  cap: number;
  /** Submissions actually made in the trailing 24 hours, from the ledger. */
  usedLast24h: number;
  remaining: number;
}

/**
 * The ceiling in force right now.
 *
 * A rolling 24-hour window, not a calendar day: a calendar day would allow 25
 * at 23:59 and 25 more at 00:01, which is a 50-listing burst and exactly the
 * shape that draws marketplace review.
 */
export async function readPublishCapState(
  now: Date = new Date(),
): Promise<PublishCapState> {
  const setting = await prisma.setting.findUnique({
    where: { key: PUBLISH_DAILY_CAP_SETTING },
    select: { value: true },
  });
  const parsed = setting ? Number.parseInt(setting.value, 10) : Number.NaN;
  const cap = Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : PUBLISH_DAILY_CAP_DEFAULT;

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const usedLast24h = await prisma.marketplaceSubmissionAttempt.count({
    where: {
      marketplace: PUBLISH_QUEUE_MARKETPLACE,
      created_at: { gte: since },
    },
  });

  return { cap, usedLast24h, remaining: Math.max(0, cap - usedLast24h) };
}

export interface EnqueueRejection {
  draftId: string;
  reason: string;
}

export interface EnqueueResult {
  batchId: string | null;
  queued: number;
  rejected: EnqueueRejection[];
  cap: PublishCapState;
  /** How many of the queued items cannot go out today under the ceiling. */
  deferredToday: number;
}

/**
 * Put a selection of drafts into a durable batch.
 *
 * Items over the ceiling are still queued — they simply wait for the window to
 * open. That is the honest behaviour for "publish these 200 at 25 a day", and
 * the caller is told the number so the operator is never surprised.
 */
export async function enqueuePublishBatch(input: {
  draftIds: string[];
  actor: string;
  note?: string;
  now?: Date;
}): Promise<EnqueueResult> {
  const now = input.now ?? new Date();
  const cap = await readPublishCapState(now);
  const rejected: EnqueueRejection[] = [];

  const requested = [...new Set(input.draftIds)];
  if (requested.length === 0) {
    return { batchId: null, queued: 0, rejected, cap, deferredToday: 0 };
  }

  // A draft already sitting in an unfinished batch must not be queued twice —
  // two batches racing the same draft is two POSTs waiting to happen.
  const alreadyQueued = await prisma.publishBatchItem.findMany({
    where: {
      bundle_draft_id: { in: requested },
      status: { in: ["PENDING", "RUNNING"] },
    },
    select: { bundle_draft_id: true },
  });
  const alreadyQueuedIds = new Set(
    alreadyQueued.map((row) => row.bundle_draft_id),
  );

  // BundleDraft carries master_bundle_id but has no Prisma relation to
  // MasterBundle, so the SKUs are fetched in a second pass and joined here.
  const drafts = await prisma.bundleDraft.findMany({
    where: { id: { in: requested } },
    select: { id: true, master_bundle_id: true },
  });
  const masterBundleIds = drafts
    .map((draft) => draft.master_bundle_id)
    .filter((id): id is string => id != null);
  const skus = masterBundleIds.length
    ? await prisma.channelSKU.findMany({
      where: {
        master_bundle_id: { in: masterBundleIds },
        channel: PUBLISH_QUEUE_MARKETPLACE,
      },
      select: {
        id: true,
        sku: true,
        master_bundle_id: true,
        validation_status: true,
        listing_status: true,
        live_url: true,
      },
    })
    : [];
  const skuByMasterBundle = new Map(skus.map((row) => [row.master_bundle_id, row]));
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));

  const accepted: Array<{ draftId: string; sku: string | null }> = [];
  for (const draftId of requested) {
    if (alreadyQueuedIds.has(draftId)) {
      rejected.push({ draftId, reason: "already queued in an unfinished batch" });
      continue;
    }
    const draft = draftsById.get(draftId);
    if (!draft) {
      rejected.push({ draftId, reason: "draft not found" });
      continue;
    }
    const sku = draft.master_bundle_id
      ? skuByMasterBundle.get(draft.master_bundle_id) ?? null
      : null;
    // A draft with no ChannelSKU yet is still legitimate: publishing promotes
    // it on the way through. Only refuse what is provably not publishable.
    if (sku) {
      if (sku.live_url) {
        rejected.push({ draftId, reason: "already live" });
        continue;
      }
      if (!["PENDING", "FAILED"].includes(sku.listing_status)) {
        rejected.push({
          draftId,
          reason: `listing status is ${sku.listing_status}`,
        });
        continue;
      }
      if (sku.validation_status !== "PASSED") {
        rejected.push({
          draftId,
          reason: `validation is ${sku.validation_status}`,
        });
        continue;
      }
      // The submission ledger is the authority on whether this SKU has already
      // been sent. Checking it here keeps a re-selected row from becoming a
      // second POST.
      const priorAttempt = await prisma.marketplaceSubmissionAttempt.findFirst({
        where: { channel_sku_id: sku.id },
        select: { id: true },
      });
      if (priorAttempt) {
        rejected.push({
          draftId,
          reason: "already submitted once — resolve it by reading, not resending",
        });
        continue;
      }
    }
    accepted.push({ draftId, sku: sku?.sku ?? null });
  }

  if (accepted.length === 0) {
    return { batchId: null, queued: 0, rejected, cap, deferredToday: 0 };
  }

  const batch = await prisma.publishBatch.create({
    data: {
      marketplace: PUBLISH_QUEUE_MARKETPLACE,
      actor: input.actor,
      requested_total: accepted.length,
      daily_cap_at_creation: cap.cap,
      ...(input.note !== undefined ? { note: input.note } : {}),
      status: "QUEUED",
      items: {
        create: accepted.map((entry, index) => ({
          bundle_draft_id: entry.draftId,
          sku: entry.sku,
          position: index,
        })),
      },
    },
    select: { id: true },
  });

  return {
    batchId: batch.id,
    queued: accepted.length,
    rejected,
    cap,
    deferredToday: Math.max(0, accepted.length - cap.remaining),
  };
}

export interface PublishBatchProgress {
  id: string;
  status: string;
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  unknown: number;
  cancelled: number;
  done: boolean;
  cap: PublishCapState;
  /** True when work remains but the daily ceiling is spent. */
  waitingForCap: boolean;
  items: Array<{
    id: string;
    bundleDraftId: string;
    sku: string | null;
    status: string;
    submissionId: string | null;
    lastError: string | null;
    failedStage: string | null;
  }>;
}

export async function getPublishBatchProgress(
  batchId: string,
  now: Date = new Date(),
): Promise<PublishBatchProgress | null> {
  const batch = await prisma.publishBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      status: true,
      items: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          bundle_draft_id: true,
          sku: true,
          status: true,
          submission_id: true,
          last_error: true,
          failed_stage: true,
        },
      },
    },
  });
  if (!batch) return null;

  const count = (status: string) =>
    batch.items.filter((item) => item.status === status).length;

  const pending = count("PENDING");
  const running = count("RUNNING");
  const cap = await readPublishCapState(now);

  return {
    id: batch.id,
    status: batch.status,
    total: batch.items.length,
    pending,
    running,
    succeeded: count("SUCCEEDED"),
    failed: count("FAILED"),
    unknown: count("UNKNOWN"),
    cancelled: count("CANCELLED"),
    done: pending === 0 && running === 0,
    cap,
    waitingForCap: pending > 0 && cap.remaining === 0,
    items: batch.items.map((item) => ({
      id: item.id,
      bundleDraftId: item.bundle_draft_id,
      sku: item.sku,
      status: item.status,
      submissionId: item.submission_id,
      lastError: item.last_error,
      failedStage: item.failed_stage,
    })),
  };
}

/**
 * Return abandoned claims to the queue — but only the ones that provably never
 * reached the marketplace.
 *
 * An item whose POST may have happened is moved to UNKNOWN and left there. The
 * submission ledger, not elapsed time, decides which is which.
 */
async function recoverAbandonedItems(
  batchId: string,
  now: Date,
): Promise<void> {
  const stale = await prisma.publishBatchItem.findMany({
    where: {
      publish_batch_id: batchId,
      status: "RUNNING",
      locked_at: { lt: new Date(now.getTime() - ITEM_LEASE_MS) },
    },
    select: { id: true, posted: true, bundle_draft_id: true },
  });

  for (const item of stale) {
    let posted = item.posted;
    if (!posted) {
      // Second opinion from the ledger: a claim row exists from the moment
      // before the POST, so its presence means we must not send again.
      const draft = await prisma.bundleDraft.findUnique({
        where: { id: item.bundle_draft_id },
        select: { master_bundle_id: true },
      });
      const skuRow = draft?.master_bundle_id
        ? await prisma.channelSKU.findFirst({
          where: {
            master_bundle_id: draft.master_bundle_id,
            channel: PUBLISH_QUEUE_MARKETPLACE,
          },
          select: { id: true },
        })
        : null;
      const skuId = skuRow?.id;
      if (skuId) {
        const attempt = await prisma.marketplaceSubmissionAttempt.findFirst({
          where: { channel_sku_id: skuId },
          select: { id: true },
        });
        posted = attempt != null;
      }
    }

    await prisma.publishBatchItem.update({
      where: { id: item.id },
      data: posted
        ? {
          status: "UNKNOWN",
          posted: true,
          locked_at: null,
          finished_at: now,
          last_error:
            "The run was interrupted after the submission was claimed. Its result must be read, never resent.",
        }
        : { status: "PENDING", locked_at: null },
    });
  }
}

export interface TickResult {
  advanced: boolean;
  /** Why no item was advanced, when none was. */
  idleReason?: "NO_WORK" | "CAP_REACHED" | "BATCH_CLOSED";
  itemId?: string;
  itemStatus?: string;
  progress: PublishBatchProgress;
}

/**
 * Advance one item of a batch. One listing per call, deliberately.
 *
 * Each listing is its own claim and its own feed POST, so a failure stops at
 * that listing instead of poisoning a shared request, and the caller can report
 * progress after every one.
 */
export async function tickPublishBatch(
  batchId: string,
  options: {
    now?: Date;
    /**
     * The publisher. Injectable so the queue's own behaviour — the ceiling, the
     * one-item-per-tick rule, what a refusal does to the batch — can be tested
     * without a marketplace on the other end. Production always uses the real
     * one.
     */
    publish?: typeof publishOneDraft;
  } = {},
): Promise<TickResult> {
  const publish = options.publish ?? publishOneDraft;
  const now = options.now ?? new Date();

  const batch = await prisma.publishBatch.findUnique({
    where: { id: batchId },
    select: { id: true, status: true, actor: true },
  });
  if (!batch) throw new Error(`PublishBatch ${batchId} not found`);

  const idle = async (
    reason: NonNullable<TickResult["idleReason"]>,
  ): Promise<TickResult> => ({
    advanced: false,
    idleReason: reason,
    progress: (await getPublishBatchProgress(batchId, now))!,
  });

  if (["CANCELLED", "PAUSED"].includes(batch.status)) {
    return idle("BATCH_CLOSED");
  }

  await recoverAbandonedItems(batchId, now);

  const cap = await readPublishCapState(now);
  if (cap.remaining <= 0) {
    // Not a failure: the batch simply waits for the window. Its rows stay
    // PENDING so tomorrow's tick picks them up.
    return idle("CAP_REACHED");
  }

  const next = await prisma.publishBatchItem.findFirst({
    where: { publish_batch_id: batchId, status: "PENDING" },
    orderBy: { position: "asc" },
    select: { id: true, bundle_draft_id: true },
  });

  if (!next) {
    const remaining = await prisma.publishBatchItem.count({
      where: { publish_batch_id: batchId, status: { in: ["PENDING", "RUNNING"] } },
    });
    if (remaining === 0) {
      await prisma.publishBatch.updateMany({
        where: { id: batchId, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "COMPLETED", finished_at: now },
      });
    }
    return idle("NO_WORK");
  }

  // Claim it atomically: whoever flips PENDING → RUNNING owns this listing.
  // Both the browser and the cron backstop drive this queue, so two callers
  // racing the same item is the expected case, not the exotic one.
  const claimed = await prisma.publishBatchItem.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "RUNNING", locked_at: now, started_at: now },
  });
  if (claimed.count !== 1) {
    // Someone else took it; report progress and let the next tick continue.
    return idle("NO_WORK");
  }

  await prisma.publishBatch.updateMany({
    where: { id: batchId, status: "QUEUED" },
    data: { status: "RUNNING", started_at: now },
  });
  await prisma.publishBatchItem.update({
    where: { id: next.id },
    data: { attempts: { increment: 1 } },
  });

  let itemStatus = "FAILED";
  try {
    const result = await publish({
      draftId: next.bundle_draft_id,
      channels: [PUBLISH_QUEUE_MARKETPLACE],
      actor: batch.actor,
      apply: true,
      // Durably record that a write is about to leave. If this process dies
      // between here and the marketplace, the mark is what prevents a second
      // POST — see recoverAbandonedItems.
      beforeDistribute: async () => {
        await prisma.publishBatchItem.update({
          where: { id: next.id },
          data: { posted: true },
        });
      },
    });

    if (result.stage !== "DISTRIBUTE") {
      // Refused before anything left: promote or validate said no. Nothing was
      // sent, so this is an ordinary failure the operator can fix and requeue.
      itemStatus = "FAILED";
      await prisma.publishBatchItem.update({
        where: { id: next.id },
        data: {
          status: itemStatus,
          failed_stage: result.stage,
          last_error: result.error,
          locked_at: null,
          finished_at: now,
        },
      });
    } else {
      const outcome = result.distribution.per_sku.find(
        (entry) => entry.channel === PUBLISH_QUEUE_MARKETPLACE,
      );
      // SUBMISSION_UNKNOWN is the one status that must never be retried: the
      // POST left and its result is not known.
      itemStatus = outcome?.status === "SUBMISSION_UNKNOWN"
        ? "UNKNOWN"
        : result.ok
          ? "SUCCEEDED"
          : "FAILED";
      await prisma.publishBatchItem.update({
        where: { id: next.id },
        data: {
          status: itemStatus,
          sku: outcome?.sku ?? undefined,
          submission_id: result.submissionId,
          last_error: result.error,
          failed_stage: itemStatus === "FAILED" ? "DISTRIBUTE" : null,
          locked_at: null,
          finished_at: now,
        },
      });
    }
  } catch (error) {
    // An exception says nothing about whether the POST left. `posted` does.
    const item = await prisma.publishBatchItem.findUnique({
      where: { id: next.id },
      select: { posted: true },
    });
    itemStatus = item?.posted ? "UNKNOWN" : "FAILED";
    await prisma.publishBatchItem.update({
      where: { id: next.id },
      data: {
        status: itemStatus,
        last_error: error instanceof Error ? error.message : String(error),
        failed_stage: itemStatus === "FAILED" ? "DISTRIBUTE" : null,
        locked_at: null,
        finished_at: now,
      },
    });
  }

  const remaining = await prisma.publishBatchItem.count({
    where: { publish_batch_id: batchId, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (remaining === 0) {
    await prisma.publishBatch.updateMany({
      where: { id: batchId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "COMPLETED", finished_at: now },
    });
  }

  return {
    advanced: true,
    itemId: next.id,
    itemStatus,
    progress: (await getPublishBatchProgress(batchId, now))!,
  };
}

/**
 * Stop a batch. Items already sent are untouched — this only prevents the ones
 * that have not started from ever starting.
 */
export async function cancelPublishBatch(
  batchId: string,
  now: Date = new Date(),
): Promise<PublishBatchProgress | null> {
  await prisma.publishBatchItem.updateMany({
    where: { publish_batch_id: batchId, status: "PENDING" },
    data: { status: "CANCELLED", finished_at: now },
  });
  await prisma.publishBatch.updateMany({
    where: { id: batchId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", finished_at: now },
  });
  return getPublishBatchProgress(batchId, now);
}

/** Batches the cron backstop should advance, oldest first. */
export async function listOpenPublishBatches(limit = 5): Promise<string[]> {
  const rows = await prisma.publishBatch.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { created_at: "asc" },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
