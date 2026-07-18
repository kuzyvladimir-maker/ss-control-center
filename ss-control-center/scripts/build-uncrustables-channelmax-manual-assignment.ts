/** Offline-only builder for the exact ChannelMAX Manual-model upload file. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildUncrustablesChannelMaxManualAssignment,
  verifyUncrustablesChannelMaxManualAssignmentManifest,
} from "@/lib/bundle-factory/repair/uncrustables-channelmax-manual";
import { verifyUncrustablesLaunchPricingManifest } from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";
import { sha256 } from "@/lib/bundle-factory/repair/uncrustables-surgical";

interface Options {
  launchPricing: string;
  manualModelId: string;
  manualModelName: string;
  outputDir: string;
  createdAt: Date;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    launchPricing: "",
    manualModelId: "",
    manualModelName: "",
    outputDir: "data/repairs/channelmax-manual",
    createdAt: new Date(),
  };
  for (const arg of argv) {
    if (arg.startsWith("--launch-pricing=")) {
      options.launchPricing = arg.slice("--launch-pricing=".length);
    } else if (arg.startsWith("--manual-model-id=")) {
      options.manualModelId = arg.slice("--manual-model-id=".length);
    } else if (arg.startsWith("--manual-model-name=")) {
      options.manualModelName = arg.slice("--manual-model-name=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg.startsWith("--created-at=")) {
      options.createdAt = new Date(arg.slice("--created-at=".length));
    } else if (arg === "--help") {
      console.log(
        "Usage: npx tsx scripts/build-uncrustables-channelmax-manual-assignment.ts --launch-pricing=PATH --manual-model-id=ID --manual-model-name=NAME [--output-dir=PATH] [--created-at=ISO]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (
    !options.launchPricing ||
    !options.manualModelId ||
    !options.manualModelName
  ) {
    throw new Error(
      "--launch-pricing, --manual-model-id, and --manual-model-name are required; there are no historical defaults.",
    );
  }
  if (!Number.isFinite(options.createdAt.getTime())) {
    throw new Error("--created-at must be a valid ISO timestamp.");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const launchBytes = await readFile(options.launchPricing);
  const launch = verifyUncrustablesLaunchPricingManifest(
    JSON.parse(launchBytes.toString("utf8")),
  );
  const built = buildUncrustablesChannelMaxManualAssignment({
    launchPricingManifest: launch,
    launchPricingPath: path.resolve(options.launchPricing),
    launchPricingSha256: sha256(launchBytes),
    manualModelId: options.manualModelId,
    manualModelName: options.manualModelName,
    createdAt: options.createdAt,
  });
  verifyUncrustablesChannelMaxManualAssignmentManifest(built.manifest);
  await mkdir(options.outputDir, { recursive: true });
  const tsvPath = path.join(options.outputDir, built.manifest.tsv_file);
  const manifestPath = `${tsvPath}.manifest.json`;
  await writeFile(tsvPath, built.tsv, { encoding: "utf8", flag: "wx" });
  await writeFile(manifestPath, `${JSON.stringify(built.manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        mode: "OFFLINE_NO_EXTERNAL_WRITES",
        tsv: tsvPath,
        manifest: manifestPath,
        rows: built.manifest.active_rows,
        manual_model_id: built.manifest.manual_model.id,
        uploaded: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
