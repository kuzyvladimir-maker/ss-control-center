#!/usr/bin/env node
/**
 * Give a listing a fresh UPC after Walmart quarantined its own.
 *
 * `ERR_EXT_DATA_0101119` means the product ID already exists in Walmart's
 * catalog under different details, so that pool number is dead forever. The
 * SKU keeps pointing at it and can never be published until it is swapped.
 *
 * Repo-resident twin of the machine-local `_rotate_upc.ts`, so the same repair
 * is available from any machine. Read-only without `--apply`.
 *
 *   npx tsx --env-file=.env scripts/walmart-rotate-upc.ts <SKU>
 *   npx tsx --env-file=.env scripts/walmart-rotate-upc.ts <SKU> --apply
 */

import { prisma } from "../src/lib/prisma";
import {
  UpcRotationRefused,
  rotateQuarantinedUpc,
} from "../src/lib/bundle-factory/rotate-quarantined-upc";

async function main(): Promise<void> {
  const skuCode = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!skuCode || skuCode.startsWith("--")) {
    throw new Error("usage: walmart-rotate-upc.ts <SKU> [--apply]");
  }

  const sku = await prisma.channelSKU.findFirst({
    where: { sku: skuCode, channel: "WALMART" },
    select: {
      id: true, sku: true, upc: true, upc_pool_id: true,
      listing_status: true, live_url: true,
    },
  });
  if (!sku) throw new Error(`No Walmart ChannelSKU ${skuCode}`);

  const pool = sku.upc_pool_id
    ? await prisma.uPCPool.findUnique({
        where: { id: sku.upc_pool_id },
        select: { status: true, notes: true },
      })
    : null;
  const available = await prisma.uPCPool.count({
    where: { status: "AVAILABLE", assigned_to_id: null },
  });

  console.log(`${sku.sku}`);
  console.log(`  current UPC : ${sku.upc} (pool status ${pool?.status ?? "unknown"})`);
  console.log(`  listing     : ${sku.listing_status}${sku.live_url ? ` — LIVE ${sku.live_url}` : ""}`);
  console.log(`  pool free   : ${available}`);
  if (pool?.notes) console.log(`  quarantine  : ${pool.notes.split("\n").at(-1)}`);

  if (!apply) {
    console.log("\nDRY RUN — pass --apply to swap the number.");
    return;
  }
  try {
    const rotation = await rotateQuarantinedUpc(sku.id);
    console.log(`\n✓ ${rotation.sku}: ${rotation.previous_upc} → ${rotation.new_upc}`);
    console.log("  Re-publish the listing to submit it under the new number.");
  } catch (error) {
    if (error instanceof UpcRotationRefused) {
      console.error(`\n✗ refused: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
