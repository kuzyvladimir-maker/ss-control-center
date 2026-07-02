/**
 * Poll-pending core — shared by the manual POST endpoint and the cron.
 *
 * For every ChannelSKU with listing_status='SUBMITTED' whose last check is
 * older than `olderThanMinutes`, poll the marketplace and persist the result.
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
      listing_status: "SUBMITTED",
      OR: [{ last_status_check_at: null }, { last_status_check_at: { lt: cutoff } }],
    },
    orderBy: { last_status_check_at: "asc" },
    take: limit,
  });

  const results: PollPendingResultRow[] = [];

  for (const sku of pending) {
    try {
      const r = await pollSubmissionStatus(sku);

      const target = channelTarget(sku.channel);
      if (
        r.new_listing_status === "FAILED" &&
        target.kind === "amazon" &&
        typeof target.storeIndex === "number" &&
        isUpcConflictIssue(r.issues)
      ) {
        const mb = sku.master_bundle_id
          ? await prisma.masterBundle.findUnique({
              where: { id: sku.master_bundle_id },
              select: { brand: true },
            })
          : null;
        const heal = await healUpcConflict(sku, {
          storeIndex: target.storeIndex,
          brand: mb?.brand,
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
        new_listing_status: "FAILED",
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
    results,
  };
}
