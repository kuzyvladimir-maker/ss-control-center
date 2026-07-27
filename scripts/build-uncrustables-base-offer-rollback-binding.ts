#!/usr/bin/env node

/**
 * Offline-only builder for a selection-scoped base-offer rollback binding.
 * The supplied snapshot must be a freshly completed exact 164-row LIVE_SP_API
 * capture. This script has no Amazon client import and no network capability.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BaseOfferPreservePlan,
  BaseOfferPreserveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import { sha256 } from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import {
  createBaseOfferRollbackBinding,
  type BaseOfferLiveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";
import type { UncrustablesPreChangeSnapshot } from "../src/lib/bundle-factory/repair/uncrustables-amazon-rollback";

const DEFAULT_PLAN =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json";
const DEFAULT_FULL_SELECTION =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-selection.json";
const DEFAULT_LIVE_SELECTION =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-lk-first-canary-20260719-v1/live-selection.json";

interface Options {
  plan: string;
  fullSelection: string;
  liveSelection: string;
  snapshot: string | null;
  outputDir: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    plan: DEFAULT_PLAN,
    fullSelection: DEFAULT_FULL_SELECTION,
    liveSelection: DEFAULT_LIVE_SELECTION,
    snapshot: null,
    outputDir: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node --import tsx scripts/build-uncrustables-base-offer-rollback-binding.ts --snapshot=PATH --output-dir=NEW_DIR [options]",
          "",
          `  --plan=PATH            Default ${DEFAULT_PLAN}`,
          `  --full-selection=PATH  Default ${DEFAULT_FULL_SELECTION}`,
          `  --live-selection=PATH  Default ${DEFAULT_LIVE_SELECTION}`,
          "  --snapshot=PATH        Fresh exact 164-row LIVE_SP_API snapshot (required)",
          "  --output-dir=NEW_DIR   New immutable output directory (required)",
          "",
          "No Amazon/network/database call is reachable from this builder.",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else if (arg.startsWith("--plan=")) {
      options.plan = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--full-selection=")) {
      options.fullSelection = arg.slice("--full-selection=".length).trim();
    } else if (arg.startsWith("--live-selection=")) {
      options.liveSelection = arg.slice("--live-selection=".length).trim();
    } else if (arg.startsWith("--snapshot=")) {
      options.snapshot = arg.slice("--snapshot=".length).trim();
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (!options.snapshot || !options.outputDir) {
    throw new Error("--snapshot and --output-dir are required.");
  }
  return options;
}

async function load<T>(filePath: string): Promise<{ bytes: Buffer; value: T }> {
  const bytes = await readFile(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [plan, fullSelection, liveSelection, snapshot] = await Promise.all([
    load<BaseOfferPreservePlan>(options.plan),
    load<BaseOfferPreserveSelection>(options.fullSelection),
    load<BaseOfferLiveSelection>(options.liveSelection),
    load<UncrustablesPreChangeSnapshot>(options.snapshot!),
  ]);
  const binding = createBaseOfferRollbackBinding({
    plan: plan.value,
    fullSelection: fullSelection.value,
    liveSelection: liveSelection.value,
    snapshotPath: options.snapshot!,
    snapshotBytes: snapshot.bytes,
    snapshot: snapshot.value,
    now: new Date(),
  });
  await mkdir(path.dirname(options.outputDir!), { recursive: true });
  await mkdir(options.outputDir!, { recursive: false });
  const output = path.join(options.outputDir!, "rollback-binding.json");
  const bytes = `${JSON.stringify(binding, null, 2)}\n`;
  await writeFile(output, bytes, { flag: "wx" });
  await writeFile(
    `${output}.sha256`,
    `${sha256(bytes)}  ${path.basename(output)}\n`,
    { flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        output,
        body_sha256: binding.body_sha256,
        snapshot_id: binding.snapshot.snapshot_id,
        snapshot_rows: binding.snapshot.rows,
        selected_actions: binding.entries.length,
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
