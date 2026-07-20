#!/usr/bin/env node

/**
 * Offline-only exact 161-row ChannelMAX Manual assignment builder.
 *
 * It has no browser, HTTP, Amazon, ChannelMAX, database, or upload import. The
 * output remains execution_authorized=false/uploaded=false and requires a
 * separate post-upload evidence gate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BaseOfferPreservePlan,
  BaseOfferPreserveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import { sha256 } from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import {
  SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES,
  buildSafeBaseOfferChannelMaxManualAssignment,
  type SafeBaseOfferSource,
} from "../src/lib/bundle-factory/repair/uncrustables-channelmax-safe-base-offer-manual";

const DEFAULT_OUTPUT_DIR =
  "data/repairs/channelmax-manual/" +
  "uncrustables-safe-base-offer-161-20260719-v1";

interface Options {
  outputDir: string;
  createdAt: Date;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    createdAt: new Date(),
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node --import tsx scripts/build-uncrustables-channelmax-safe-base-offer-manual.ts [options]",
          "",
          `  --output-dir=NEW_DIR  Default ${DEFAULT_OUTPUT_DIR}`,
          "  --created-at=ISO     Canonical artifact timestamp (default now)",
          "",
          "Inputs are exact pinned local artifacts. There is no upload/network path.",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--created-at=")) {
      options.createdAt = new Date(arg.slice("--created-at=".length));
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (!options.outputDir || !Number.isFinite(options.createdAt.getTime())) {
    throw new Error("--output-dir and canonical --created-at are required.");
  }
  return options;
}

async function load<T>(filePath: string): Promise<SafeBaseOfferSource<T>> {
  const bytes = await readFile(filePath);
  return {
    path: filePath,
    bytes,
    value: JSON.parse(bytes.toString("utf8")) as T,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sources = SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES;
  const [plan, fullSelection, priceMatrix, prewrite, postwrite, discovery] =
    await Promise.all([
      load<BaseOfferPreservePlan>(sources.plan.path),
      load<BaseOfferPreserveSelection>(sources.full_selection.path),
      load(sources.price_matrix.path),
      load(sources.channelmax_prewrite.path),
      load(sources.channelmax_postwrite.path),
      load(sources.manual_model_discovery.path),
    ]);
  const built = buildSafeBaseOfferChannelMaxManualAssignment({
    plan,
    fullSelection,
    priceMatrix,
    channelMaxPrewrite: prewrite,
    channelMaxPostwrite: postwrite,
    manualModelDiscovery: discovery,
    createdAt: options.createdAt,
  });

  await mkdir(path.dirname(options.outputDir), { recursive: true });
  await mkdir(options.outputDir, { recursive: false });
  const tsvPath = path.join(options.outputDir, built.manifest.tsv_file);
  const manifestPath = path.join(options.outputDir, "manifest.json");
  const tsvBytes = Buffer.from(built.tsv, "utf8");
  const manifestBytes = Buffer.from(
    `${JSON.stringify(built.manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(tsvPath, tsvBytes, { flag: "wx" });
  await writeFile(
    `${tsvPath}.sha256`,
    `${sha256(tsvBytes)}  ${path.basename(tsvPath)}\n`,
    { flag: "wx" },
  );
  await writeFile(manifestPath, manifestBytes, { flag: "wx" });
  await writeFile(
    `${manifestPath}.sha256`,
    `${sha256(manifestBytes)}  manifest.json\n`,
    { flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "OFFLINE_ONLY",
        output_dir: options.outputDir,
        manifest: manifestPath,
        manifest_file_sha256: sha256(manifestBytes),
        manifest_body_sha256: built.manifest.body_sha256,
        tsv: tsvPath,
        tsv_sha256: built.manifest.tsv_sha256,
        rows: built.manifest.rows.length,
        excluded_identity_holds: built.manifest.identity_holds.map(
          (hold) => hold.sku,
        ),
        manual_model: built.manifest.manual_model,
        uploaded: false,
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
