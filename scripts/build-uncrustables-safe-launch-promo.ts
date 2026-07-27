#!/usr/bin/env node

/**
 * Deterministic offline-only builder for the exact safe 161-SKU Uncrustables
 * launch-promotion cohort. It has no browser, HTTP, Amazon, ChannelMAX, DB, or
 * upload imports and cannot authorize or perform an external mutation.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SAFE_LAUNCH_PROMO_PINNED_SOURCES,
  buildSafeLaunchPromoArtifact,
  safeLaunchPromoSha256,
  type SafeLaunchPromoSource,
} from "../src/lib/bundle-factory/repair/uncrustables-safe-launch-promo";

const DEFAULT_OUTPUT_DIR =
  "data/repairs/launch-pricing/" +
  "uncrustables-safe-promo-161-20260720-20260819-v1";

interface Options {
  outputDir: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { outputDir: DEFAULT_OUTPUT_DIR };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node --import tsx scripts/build-uncrustables-safe-launch-promo.ts [options]",
          "",
          `  --output-dir=NEW_DIR  Default ${DEFAULT_OUTPUT_DIR}`,
          "",
          "All inputs are exact pinned local artifacts; no network or live write exists.",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (!options.outputDir) throw new Error("--output-dir must be non-empty.");
  return options;
}

async function load(source: {
  path: string;
  file_sha256: string;
}): Promise<SafeLaunchPromoSource> {
  return { path: source.path, bytes: await readFile(source.path) };
}

async function writeArtifact(
  outputDir: string,
  fileName: string,
  bytes: Buffer,
): Promise<void> {
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, bytes, { flag: "wx" });
  await writeFile(
    `${filePath}.sha256`,
    `${safeLaunchPromoSha256(bytes)}  ${fileName}\n`,
    { flag: "wx" },
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = SAFE_LAUNCH_PROMO_PINNED_SOURCES;
  const [launchManifest, assignments, couponSpec, salePriceSpec, safeBase, safeTsv] =
    await Promise.all([
      load(source.launch_manifest),
      load(source.assignments),
      load(source.coupon_spec),
      load(source.sale_price_spec),
      load(source.safe_base_offer_manifest),
      load(source.safe_base_offer_tsv),
    ]);
  const built = buildSafeLaunchPromoArtifact({
    launchManifest,
    assignments,
    couponSpec,
    salePriceSpec,
    safeBaseOfferManifest: safeBase,
    safeBaseOfferTsv: safeTsv,
  });

  await mkdir(path.dirname(options.outputDir), { recursive: true });
  await mkdir(options.outputDir, { recursive: false });
  const manifestBytes = Buffer.from(
    `${JSON.stringify(built.manifest, null, 2)}\n`,
    "utf8",
  );
  await Promise.all([
    writeArtifact(options.outputDir, "manifest.json", manifestBytes),
    writeArtifact(
      options.outputDir,
      built.manifest.files.assignments.file,
      Buffer.from(built.assignmentsCsv, "utf8"),
    ),
    writeArtifact(
      options.outputDir,
      built.manifest.files.coupons.file,
      Buffer.from(built.couponsCsv, "utf8"),
    ),
    writeArtifact(
      options.outputDir,
      built.manifest.files.sale_prices.file,
      Buffer.from(built.salePricesCsv, "utf8"),
    ),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "OFFLINE_ONLY",
        output_dir: options.outputDir,
        manifest_file_sha256: safeLaunchPromoSha256(manifestBytes),
        manifest_body_sha256: built.manifest.body_sha256,
        safe_promo_rows: built.manifest.scope.safe_promo_rows,
        coupon_rows: built.manifest.scope.coupon_rows,
        sale_price_rows: built.manifest.scope.sale_price_rows,
        identity_holds: built.manifest.identity_holds.map((row) => row.sku),
        owner_approval_received: false,
        execution_authorized: false,
        external_mutations: 0,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
