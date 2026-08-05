#!/usr/bin/env node
/**
 * Publish one Walmart listing from the command line, by SKU.
 *
 * Calls the SAME `publishOneDraft` the Publish button calls — promote,
 * validate, approve, submit — so the command line and the UI cannot drift into
 * different behaviour. Repo-resident twin of the machine-local
 * `_publish_one.ts`.
 *
 * Dry run by default. `--apply` performs a real, irreversible marketplace POST
 * for that one SKU; the durable claim still guarantees one POST per listing.
 *
 *   npx tsx --env-file=.env scripts/walmart-publish-one.ts <SKU>
 *   npx tsx --env-file=.env scripts/walmart-publish-one.ts <SKU> --apply
 */

import { prisma } from "../src/lib/prisma";
import { publishOneDraft } from "../src/lib/bundle-factory/publish-one-draft";

async function main(): Promise<void> {
  const skuCode = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!skuCode || skuCode.startsWith("--")) {
    throw new Error("usage: walmart-publish-one.ts <SKU> [--apply]");
  }

  const sku = await prisma.channelSKU.findFirst({
    where: { sku: skuCode, channel: "WALMART" },
    select: {
      id: true, sku: true, upc: true, price_cents: true, title: true,
      listing_status: true, validation_status: true, master_bundle_id: true,
    },
  });
  if (!sku) throw new Error(`No Walmart ChannelSKU ${skuCode}`);

  const draft = await prisma.bundleDraft.findFirst({
    where: { master_bundle_id: sku.master_bundle_id },
    select: { id: true, status: true },
  });
  if (!draft) throw new Error(`No draft owns ${skuCode}`);

  console.log(`${sku.sku} — ${sku.title.slice(0, 70)}`);
  console.log(
    `  draft ${draft.id} (${draft.status})`
    + ` · $${(sku.price_cents / 100).toFixed(2)}`
    + ` · upc ${sku.upc}`
    + ` · ${sku.validation_status}/${sku.listing_status}`,
  );
  console.log(apply ? "\n→ REAL submission\n" : "\n→ dry run\n");

  const result = await publishOneDraft({
    draftId: draft.id,
    channels: ["WALMART"],
    actor: "walmart-publish-one",
    apply,
  });
  console.log(JSON.stringify(result, null, 1).slice(0, 4000));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
