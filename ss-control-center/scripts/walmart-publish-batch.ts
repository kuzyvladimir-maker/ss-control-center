/**
 * Send several Walmart listings in ONE feed.
 *
 * Walmart's baseline is roughly ten feeds an hour, so one feed per listing caps
 * the factory at ten listings an hour no matter how fast it builds. This is the
 * volume path: one POST, many listings, every per-listing fence intact.
 *
 *   npx tsx --env-file=.env scripts/walmart-publish-batch.ts SKU-1 SKU-2 [...]
 *   npx tsx --env-file=.env scripts/walmart-publish-batch.ts --ready --limit 5
 *
 * Nothing is sent without --apply. The first live batch should be TWO listings:
 * an unknown POST outcome now costs every listing in the feed, and that risk is
 * worth taking only once the shape is proven small.
 */

import { prisma } from "../src/lib/prisma";
import { submitWalmartBatch } from "../src/lib/bundle-factory/distribution/walmart-batch-submit";
import { WALMART_BATCH_FEED_MAX_ITEMS } from "../src/lib/bundle-factory/distribution/walmart-batch-feed";
import { isPublishableListingStatus } from "../src/lib/bundle-factory/publishable-listing-status";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const READY = argv.includes("--ready");
const limitFlag = argv.indexOf("--limit");
const LIMIT = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : WALMART_BATCH_FEED_MAX_ITEMS;
const NAMED = argv.filter((arg) => !arg.startsWith("--") && arg !== String(LIMIT));

async function resolveTargets(): Promise<Array<{ id: string; sku: string }>> {
  if (NAMED.length > 0) {
    const rows = await prisma.channelSKU.findMany({
      where: { channel: "WALMART", sku: { in: NAMED } },
      select: { id: true, sku: true },
    });
    const found = new Set(rows.map((row) => row.sku));
    for (const sku of NAMED) {
      if (!found.has(sku)) console.log(`  ! ${sku} is not a Walmart listing — ignored`);
    }
    return rows;
  }
  if (!READY) {
    throw new Error("Name the SKUs, or pass --ready to take what is waiting.");
  }
  const rows = await prisma.channelSKU.findMany({
    where: { channel: "WALMART", validation_status: "PASSED", live_url: null },
    select: { id: true, sku: true, listing_status: true },
    orderBy: { updated_at: "asc" },
    take: Math.min(LIMIT, WALMART_BATCH_FEED_MAX_ITEMS) * 3,
  });
  return rows
    .filter((row) => isPublishableListingStatus(row.listing_status))
    .slice(0, Math.min(LIMIT, WALMART_BATCH_FEED_MAX_ITEMS))
    .map((row) => ({ id: row.id, sku: row.sku }));
}

async function main(): Promise<void> {
  const targets = await resolveTargets();
  if (targets.length === 0) {
    console.log("Nothing to send.");
    return;
  }
  console.log(`${targets.length} listing(s) in this feed:`);
  for (const target of targets) console.log(`  ${target.sku}`);

  if (!APPLY) {
    console.log("\nDry run. Pass --apply to send the feed.");
    return;
  }

  const result = await submitWalmartBatch({
    channelSkuIds: targets.map((target) => target.id),
  });

  console.log(`\noutcome: ${result.outcome}`);
  if (result.feedId) console.log(`feed:    ${result.feedId}`);
  if (result.shippingFeedId) console.log(`shipping feed: ${result.shippingFeedId}`);
  if (result.submitted.length) console.log(`sent:    ${result.submitted.join(", ")}`);
  for (const skip of result.skipped) console.log(`skipped ${skip.sku}: ${skip.reason}`);
  if (result.error) console.log(`error:   ${result.error}`);
  if (result.outcome === "UNKNOWN") {
    console.log(
      "\nThe POST outcome is unknown. Do NOT send again — read the feed and the "
      + "seller SKUs to find out what happened.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
