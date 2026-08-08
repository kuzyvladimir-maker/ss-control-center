/**
 * Send several Walmart listings in ONE feed.
 *
 * Walmart's baseline is roughly ten feeds an hour, so one feed per listing caps
 * the factory at ten listings an hour no matter how fast it builds. This is the
 * volume path: one POST, many listings, every per-listing fence intact.
 *
 *   npx tsx --env-file=.env scripts/walmart-publish-batch.ts SKU-1 SKU-2 [...]
 *   npx tsx --env-file=.env scripts/walmart-publish-batch.ts --ready --limit 5
 *   npx tsx --env-file=.env scripts/walmart-publish-batch.ts --drafts ID-1 ID-2 --apply
 *
 * `--drafts` takes drafts the whole way: promote, validate and approve each one
 * WITHOUT writing to the marketplace, then send them together in one feed. That
 * is the only way to exercise the batch transport, because the single path
 * publishes as it promotes.
 *
 * Nothing is sent without --apply. The first live batch should be TWO listings:
 * an unknown POST outcome now costs every listing in the feed, and that risk is
 * worth taking only once the shape is proven small.
 */

import { prisma } from "../src/lib/prisma";
import { publishOneDraft } from "../src/lib/bundle-factory/publish-one-draft";
import { approveDraftForDistribution } from "../src/lib/bundle-factory/approval";
import { submitWalmartBatch } from "../src/lib/bundle-factory/distribution/walmart-batch-submit";
import { WALMART_BATCH_FEED_MAX_ITEMS } from "../src/lib/bundle-factory/distribution/walmart-batch-feed";
import { isPublishableListingStatus } from "../src/lib/bundle-factory/publishable-listing-status";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const READY = argv.includes("--ready");
const limitFlag = argv.indexOf("--limit");
const LIMIT = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : WALMART_BATCH_FEED_MAX_ITEMS;
const NAMED = argv.filter((arg) => !arg.startsWith("--") && arg !== String(LIMIT));

/**
 * Bring drafts to the edge of publication without publishing them.
 *
 * `apply: false` runs promote → validate → approve and stops before the
 * marketplace write, which is exactly the state `submitWalmartBatch` expects.
 */
async function prepareDrafts(draftIds: string[]): Promise<Array<{ id: string; sku: string }>> {
  const ready: Array<{ id: string; sku: string }> = [];
  for (const draftId of draftIds) {
    const result = await publishOneDraft({
      draftId,
      actor: "batch-live-test",
      apply: false,
      approvalConfirmed: true,
    } as Parameters<typeof publishOneDraft>[0]);
    // Reaching DISTRIBUTE is the goal: promotion, validation and approval are
    // done and the dry run stopped before the marketplace write. Anything that
    // stopped EARLIER genuinely refused.
    if (result.stage !== "DISTRIBUTE") {
      console.log(
        `  ! ${draftId} stopped at ${result.stage}: `
        + `${"error" in result ? result.error ?? "" : ""}`,
      );
      continue;
    }
    // publishOneDraft only approves when it is going to publish, and a dry run
    // is not. The seal is what the batch transport checks, so it is sealed here
    // explicitly — the same call the single path makes, just without the POST.
    try {
      await approveDraftForDistribution({ draftId, actor: "batch-live-test" });
    } catch (error) {
      console.log(`  ! ${draftId} could not be approved: `
        + `${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const draft = await prisma.bundleDraft.findUnique({
      where: { id: draftId },
      select: { master_bundle_id: true },
    });
    const sku = draft?.master_bundle_id
      ? await prisma.channelSKU.findFirst({
        where: { master_bundle_id: draft.master_bundle_id, channel: "WALMART" },
        select: { id: true, sku: true },
      })
      : null;
    if (!sku) {
      console.log(`  ! ${draftId} produced no Walmart listing`);
      continue;
    }
    ready.push(sku);
  }
  return ready;
}

async function resolveTargets(): Promise<Array<{ id: string; sku: string }>> {
  const draftsFlag = argv.indexOf("--drafts");
  if (draftsFlag >= 0) {
    const ids = argv.slice(draftsFlag + 1).filter((arg) => !arg.startsWith("--"));
    if (ids.length === 0) throw new Error("--drafts needs at least one draft id");
    return prepareDrafts(ids);
  }
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
