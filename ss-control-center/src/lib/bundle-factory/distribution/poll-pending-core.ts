/**
 * Poll-pending core — shared by the manual POST endpoint and the cron.
 *
 * Poll every in-flight state (SUBMITTED, PENDING_REVIEW, SUBMITTING, and
 * SUBMISSION_UNKNOWN) whose last check is old enough. Marketplace transport
 * errors remain retryable and durable attempt backoff is honored.
 * A SUBMITTED Amazon listing that comes back FAILED solely because its UPC is
 * already registered to another ASIN is self-healed (burn → next barcode →
 * delete tainted contribution → re-publish). Non-UPC failures persist normally.
 */

import { prisma } from "@/lib/prisma";
import {
  persistPollResult,
  pollSubmissionStatus,
} from "./status-poller";
import { healUpcConflict, isUpcConflictIssue } from "./upc-burn";
import { channelTarget } from "./account-map";
import { productTypeForBundle } from "@/lib/bundle-factory/attributes";
import {
  getActiveWalmartSubmissionAttempt,
  WALMART_POLLABLE_LISTING_STATUSES,
} from "./walmart-publish-lifecycle";

const SLEEP_BETWEEN_POLLS_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PollPendingResultRow {
  sku_id: string;
  sku: string;
  channel: string;
  new_listing_status: string;
  issues_count: number;
  healed?: { old_upc?: string; new_upc?: string; republished: boolean; reason?: string };
}

export interface PollPendingSummary {
  cutoff: string;
  checked: number;
  now_live: number;
  now_failed: number;
  still_submitted: number;
  pending_review: number;
  submission_unknown: number;
  now_retryable: number;
  deferred_by_backoff: number;
  results: PollPendingResultRow[];
}

export async function runPollPending(opts: {
  olderThanMinutes?: number;
  limit?: number;
}): Promise<PollPendingSummary> {
  const olderThanMinutes = Math.max(1, Number(opts.olderThanMinutes ?? 5));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const pending = await prisma.channelSKU.findMany({
    where: {
      listing_status: { in: [...WALMART_POLLABLE_LISTING_STATUSES] },
      OR: [{ last_status_check_at: null }, { last_status_check_at: { lt: cutoff } }],
    },
    orderBy: { last_status_check_at: "asc" },
    // Over-fetch because some Walmart attempts may be deferred by their own
    // retry_after. The loop still caps actual network polls at `limit`.
    take: Math.min(600, limit * 3),
  });

  const results: PollPendingResultRow[] = [];
  let deferredByBackoff = 0;

  for (const sku of pending) {
    if (results.length >= limit) break;
    try {
      const target = channelTarget(sku.channel);
      if (target.kind === "walmart") {
        const activeAttempt = await getActiveWalmartSubmissionAttempt(sku.id);
        if (
          activeAttempt?.retry_after &&
          activeAttempt.retry_after.getTime() > Date.now()
        ) {
          deferredByBackoff++;
          continue;
        }
      }
      const r = await pollSubmissionStatus(sku);

      if (
        r.new_listing_status === "FAILED" &&
        target.kind === "amazon" &&
        typeof target.storeIndex === "number" &&
        isUpcConflictIssue(r.issues)
      ) {
        const mb = sku.master_bundle_id
          ? await prisma.masterBundle.findUnique({
              where: { id: sku.master_bundle_id },
              select: { brand: true, category: true },
            })
          : null;
        const heal = await healUpcConflict(sku, {
          storeIndex: target.storeIndex,
          brand: mb?.brand,
          category: mb?.category,
          productType: productTypeForBundle(),
        });
        results.push({
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          new_listing_status: heal.republished ? "SUBMITTED" : "FAILED",
          issues_count: r.issues.length,
          healed: {
            old_upc: heal.old_upc,
            new_upc: heal.new_upc,
            republished: heal.republished,
            reason: heal.reason,
          },
        });
        await sleep(SLEEP_BETWEEN_POLLS_MS);
        continue;
      }

      await persistPollResult(r);
      results.push({
        sku_id: sku.id,
        sku: sku.sku,
        channel: sku.channel,
        new_listing_status: r.new_listing_status,
        issues_count: r.issues.length,
      });
    } catch (e) {
      results.push({
        sku_id: sku.id,
        sku: sku.sku,
        channel: sku.channel,
        new_listing_status: sku.listing_status,
        issues_count: 1,
      });
      await prisma.channelSKU.update({
        where: { id: sku.id },
        data: {
          distribution_errors: JSON.stringify([
            {
              message: `Poll threw: ${e instanceof Error ? e.message : String(e)}`,
              severity: "ERROR",
            },
          ]),
          last_status_check_at: new Date(),
        },
      });
    }
    await sleep(SLEEP_BETWEEN_POLLS_MS);
  }

  return {
    cutoff: cutoff.toISOString(),
    checked: results.length,
    now_live: results.filter((r) => r.new_listing_status === "LIVE").length,
    now_failed: results.filter((r) => r.new_listing_status === "FAILED").length,
    still_submitted: results.filter((r) => r.new_listing_status === "SUBMITTED").length,
    pending_review: results.filter((r) => r.new_listing_status === "PENDING_REVIEW").length,
    submission_unknown: results.filter(
      (r) => r.new_listing_status === "SUBMISSION_UNKNOWN",
    ).length,
    now_retryable: results.filter((r) => r.new_listing_status === "RETRYABLE").length,
    deferred_by_backoff: deferredByBackoff,
    results,
  };
}
