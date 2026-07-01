/**
 * POST /api/bundle-factory/distribution/poll-pending
 *      Query: ?olderThanMinutes=N  (default 5)
 *             ?limit=N             (default 50 — protect against runaway)
 *
 * Phase 2.5 Stage 7 — background cron-friendly endpoint. Designed to be
 * called by n8n every 5 minutes. For every ChannelSKU with
 * listing_status='SUBMITTED' whose last_status_check_at is older than
 * olderThanMinutes (or never checked), runs pollSubmissionStatus +
 * persists the result.
 *
 * Auth: uses the standard SSCC_API_TOKEN middleware. Endpoint itself
 * doesn't check the token — middleware does.
 *
 * Returns a summary the cron caller can log.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  persistPollResult,
  pollSubmissionStatus,
} from "@/lib/bundle-factory/distribution/status-poller";
import {
  healUpcConflict,
  isUpcConflictIssue,
} from "@/lib/bundle-factory/distribution/upc-burn";
import { channelTarget } from "@/lib/bundle-factory/distribution/account-map";
import { productTypeForBundle } from "@/lib/bundle-factory/attributes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SLEEP_BETWEEN_POLLS_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST = withErrorHandler(
  "distribution/poll-pending[POST]",
  async (request: Request) => {
    const url = new URL(request.url);
    const olderThanMinutes = Math.max(
      1,
      Number(url.searchParams.get("olderThanMinutes") ?? 5),
    );
    const limit = Math.max(
      1,
      Math.min(200, Number(url.searchParams.get("limit") ?? 50)),
    );
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

    const pending = await prisma.channelSKU.findMany({
      where: {
        listing_status: "SUBMITTED",
        OR: [
          { last_status_check_at: null },
          { last_status_check_at: { lt: cutoff } },
        ],
      },
      orderBy: { last_status_check_at: "asc" },
      take: limit,
    });

    const results: Array<{
      sku_id: string;
      sku: string;
      channel: string;
      new_listing_status: string;
      issues_count: number;
      healed?: { old_upc?: string; new_upc?: string; republished: boolean; reason?: string };
    }> = [];

    for (const sku of pending) {
      try {
        const r = await pollSubmissionStatus(sku);

        // Barcode-collision self-heal: a SUBMITTED Amazon listing that comes back
        // FAILED solely because its UPC is already registered to another ASIN is
        // NOT a dead end — burn that barcode, take the next AVAILABLE one, delete
        // the tainted contribution and re-publish. Leaves it SUBMITTED again so
        // the next poll picks up the fresh result. Non-UPC failures fall through
        // to the normal persist below (they must not burn the barcode).
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

    return NextResponse.json({
      cutoff: cutoff.toISOString(),
      checked: results.length,
      now_live: results.filter((r) => r.new_listing_status === "LIVE").length,
      now_failed: results.filter((r) => r.new_listing_status === "FAILED").length,
      still_submitted: results.filter((r) => r.new_listing_status === "SUBMITTED").length,
      pending_review: results.filter((r) => r.new_listing_status === "PENDING_REVIEW").length,
      results,
    });
  },
);
