#!/usr/bin/env node
/**
 * What happened to every Walmart submission we have made.
 *
 * Reads the durable attempt ledger and, for anything not yet terminal, asks
 * Walmart for the feed's per-item result. Read-only: no feed is submitted,
 * no row is written.
 *
 * This replaces the machine-local `_ledger.mjs` / `_feed_status.ts` pair so the
 * same answer is available from any machine that has the repo.
 *
 *   npx tsx --env-file=.env scripts/walmart-submission-ledger.ts
 *   npx tsx --env-file=.env scripts/walmart-submission-ledger.ts --feed <feedId>
 */

import { prisma } from "../src/lib/prisma";
import { getWalmartClient } from "../src/lib/walmart/client";

interface FeedItemDetail {
  sku?: string;
  ingestionStatus?: string;
  ingestionErrors?: { ingestionError?: Array<{ code?: string; description?: string; type?: string }> };
}

interface FeedStatus {
  feedId?: string;
  feedStatus?: string;
  feedDate?: string;
  itemsReceived?: number;
  itemsSucceeded?: number;
  itemsFailed?: number;
  itemsProcessing?: number;
  itemsInReviewCount?: number;
  itemDetails?: { itemIngestionStatus?: FeedItemDetail[] };
}

/** GET /feeds answers { results: { feed: [ … ] } }, not a bare feed object. */
interface FeedStatusEnvelope {
  results?: { feed?: FeedStatus[] };
}

async function feedStatus(feedId: string): Promise<FeedStatus | null> {
  try {
    const res = await getWalmartClient(1).requestRaw("GET", "/feeds", {
      params: { feedId, includeDetails: "true" },
    });
    if (res.status !== 200) {
      console.log(`   feed ${feedId}: HTTP ${res.status}`);
      return null;
    }
    const envelope = res.body as FeedStatusEnvelope;
    return envelope.results?.feed?.[0] ?? null;
  } catch (error) {
    console.log(
      `   feed ${feedId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function reportFeed(status: FeedStatus): void {
  const submittedAt = status.feedDate
    ? new Date(Number(status.feedDate)).toISOString()
    : "unknown";
  const ageMinutes = status.feedDate
    ? Math.round((Date.now() - Number(status.feedDate)) / 60_000)
    : null;
  console.log(
    `   feed ${status.feedStatus}`
    + ` — received ${status.itemsReceived ?? "?"},`
    + ` ok ${status.itemsSucceeded ?? 0},`
    + ` failed ${status.itemsFailed ?? 0},`
    + ` processing ${status.itemsProcessing ?? 0}`
    + ` — submitted ${submittedAt}`
    + (ageMinutes === null ? "" : ` (${ageMinutes} min ago)`),
  );
  for (const item of status.itemDetails?.itemIngestionStatus ?? []) {
    console.log(`     · ${item.sku}: ${item.ingestionStatus}`);
    for (const error of item.ingestionErrors?.ingestionError ?? []) {
      console.log(`       ✗ ${error.code} — ${error.description}`);
    }
  }
}

async function main(): Promise<void> {
  const feedArg = process.argv[process.argv.indexOf("--feed") + 1];
  if (process.argv.includes("--feed") && feedArg) {
    const status = await feedStatus(feedArg);
    if (status) reportFeed(status);
    return;
  }

  const attempts = await prisma.marketplaceSubmissionAttempt.findMany({
    where: { marketplace: "WALMART" },
    orderBy: { created_at: "desc" },
    select: {
      id: true,
      state: true,
      authorization_basis: true,
      marketplace_submission_id: true,
      marketplace_disposition: true,
      error_json: true,
      created_at: true,
      channel_sku: {
        select: {
          submission_id: true,
          sku: true,
          upc: true,
          listing_status: true,
          lifecycle_status: true,
          live_url: true,
          price_cents: true,
          title: true,
        },
      },
    },
  });
  console.log(`${attempts.length} Walmart submission attempt(s)\n`);

  const seenFeeds = new Set<string>();
  for (const attempt of attempts) {
    const sku = attempt.channel_sku;
    console.log(
      `${sku.sku}  ${attempt.state}/${sku.listing_status}`
      + `  $${(sku.price_cents / 100).toFixed(2)}`
      + `  upc ${sku.upc}`
      + (sku.live_url ? `  LIVE ${sku.live_url}` : ""),
    );
    console.log(`   ${sku.title.slice(0, 78)}`);
    if (attempt.error_json) {
      console.log(`   error: ${attempt.error_json.slice(0, 200)}`);
    }
    // The feed id lands on the ChannelSKU; the attempt row keeps its own
    // marketplace_submission_id only when the accept path writes one.
    const feedId = attempt.marketplace_submission_id ?? sku.submission_id;
    if (feedId && !seenFeeds.has(feedId)) {
      seenFeeds.add(feedId);
      const status = await feedStatus(feedId);
      if (status) reportFeed(status);
    }
    console.log("");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
