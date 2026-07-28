#!/usr/bin/env node

/**
 * Build one immutable, read-only evidence artifact for the narrow Walmart
 * single-member variant-group repair lane. This command performs no network,
 * database, model, or Walmart write calls.
 */

import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildWalmartListingVariantGroupRepairEvidence,
  type WalmartListingVariantGroupAllItemsReceipt,
} from "../src/lib/walmart/listing-integrity-variant-group-evidence.ts";

function fail(message: string): never {
  throw new Error(`Walmart variant-group evidence command rejected input: ${message}`);
}

function exactPath(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    fail(`${label} must be an explicit path`);
  }
  return path.resolve(value);
}

function exactString(
  value: string | undefined,
  label: string,
  maximum = 512,
): string {
  if (!value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a bounded exact string`);
  }
  return value;
}

function positiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9]\d*$/u.test(value)
    || !Number.isSafeInteger(Number(value))) {
    fail(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) {
      fail(`unsupported or duplicate argument: ${argument}`);
    }
    flags.set(match[1]!, match[2]!);
  }
  const expected = [
    "created-at",
    "store-index",
    "sku",
    "item-id",
    "flavor",
    "count",
    "catalog-source",
    "item-report",
    "seller-item",
    "get-spec-response",
    "all-items-response",
    "all-items-receipt",
    "output-dir",
  ] as const;
  if (flags.size !== expected.length
    || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  const createdAt = exactString(flags.get("created-at"), "--created-at", 64);
  if (!Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) {
    fail("--created-at must be a canonical ISO instant");
  }
  return {
    createdAt,
    storeIndex: positiveInteger(flags.get("store-index"), "--store-index"),
    sku: exactString(flags.get("sku"), "--sku"),
    itemId: exactString(flags.get("item-id"), "--item-id", 64),
    flavor: exactString(flags.get("flavor"), "--flavor"),
    count: positiveInteger(flags.get("count"), "--count"),
    catalogSource: exactPath(flags.get("catalog-source"), "--catalog-source"),
    itemReport: exactPath(flags.get("item-report"), "--item-report"),
    sellerItem: exactPath(flags.get("seller-item"), "--seller-item"),
    getSpecResponse: exactPath(
      flags.get("get-spec-response"),
      "--get-spec-response",
    ),
    allItemsResponse: exactPath(
      flags.get("all-items-response"),
      "--all-items-response",
    ),
    allItemsReceipt: exactPath(
      flags.get("all-items-receipt"),
      "--all-items-receipt",
    ),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

function parseAllItemsReceipt(
  bytes: Uint8Array,
): WalmartListingVariantGroupAllItemsReceipt {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as WalmartListingVariantGroupAllItemsReceipt;
  } catch {
    return fail("--all-items-receipt must be UTF-8 JSON");
  }
}

async function writeExclusive(
  pathname: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.outputDir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const [
    catalogSource,
    itemReport,
    sellerItem,
    getSpecResponse,
    allItemsResponse,
    allItemsReceiptBytes,
  ] = await Promise.all([
    readFile(args.catalogSource),
    readFile(args.itemReport),
    readFile(args.sellerItem),
    readFile(args.getSpecResponse),
    readFile(args.allItemsResponse),
    readFile(args.allItemsReceipt),
  ]);
  const evidence = buildWalmartListingVariantGroupRepairEvidence({
    created_at: args.createdAt,
    listing: {
      store_index: args.storeIndex,
      sku: args.sku,
      item_id: args.itemId,
    },
    target: {
      flavor: args.flavor,
      count: args.count,
      count_per_pack: 1,
      multipack_quantity: args.count,
    },
    catalog_source_bytes: catalogSource,
    decoded_item_report_bytes: itemReport,
    live_item_response_bytes: sellerItem,
    get_spec_response_bytes: getSpecResponse,
    all_items_response_bytes: allItemsResponse,
    all_items_receipt: parseAllItemsReceipt(allItemsReceiptBytes),
  });

  await mkdir(args.outputDir, { mode: 0o700 });
  const outputPath = path.join(args.outputDir, "evidence.json");
  await writeExclusive(
    outputPath,
    Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
  );
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    schema_version: evidence.schema_version,
    sku: evidence.listing.sku,
    exact_group_member_count: evidence.current_group.exact_member_count,
    evidence_body_sha256: evidence.body_sha256,
    output_path: outputPath,
    walmart_writes: 0,
  }, null, 2)}\n`);
}

const isDirect = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isDirect) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
