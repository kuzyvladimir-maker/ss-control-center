/**
 * Build a WAVE live-selection over the sealed 2026-07-19 v3 base-offer preserve
 * plan: the remaining actions after the LK canary, split deterministically into
 * fixed-size waves (plan order). Offline only; validated by the engine's own
 * assertBaseOfferLiveSelection before writing.
 *
 * Usage:
 *   npx tsx scripts/build-uncrustables-base-offer-wave-selection.ts \
 *     --wave=1 [--wave-size=54] [--exclude-skus=LK-AS7X-K43B] --output-dir=DIR
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertBaseOfferLiveSelection,
  createBaseOfferLiveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";
import { sha256 } from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";

const SOURCE_DIR =
  "data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3";
const PLAN_PATH = `${SOURCE_DIR}/base-offer-preserve-plan.json`;
const FULL_SELECTION_PATH = `${SOURCE_DIR}/base-offer-preserve-selection.json`;

interface Options {
  wave: number;
  waveSize: number;
  excludeSkus: Set<string>;
  outputDir: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    wave: 0,
    waveSize: 54,
    excludeSkus: new Set(["LK-AS7X-K43B"]),
    outputDir: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--wave=")) options.wave = Number(arg.slice(7));
    else if (arg.startsWith("--wave-size=")) options.waveSize = Number(arg.slice(12));
    else if (arg.startsWith("--exclude-skus="))
      options.excludeSkus = new Set(arg.slice(15).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg.startsWith("--output-dir=")) options.outputDir = arg.slice(13).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.wave) || options.wave < 1) throw new Error("--wave must be >= 1.");
  if (!Number.isInteger(options.waveSize) || options.waveSize < 1 || options.waveSize > 60) {
    throw new Error("--wave-size must be 1..60 (authorization TTL bounds a wave).");
  }
  if (!options.outputDir) throw new Error("--output-dir is required.");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plan = JSON.parse((await readFile(PLAN_PATH)).toString("utf8"));
  const fullSelection = JSON.parse((await readFile(FULL_SELECTION_PATH)).toString("utf8"));

  // Plan order is the sealed deterministic order.
  const allIds: string[] = fullSelection.selected_action_ids;
  const remaining = allIds.filter((id) => {
    const sku = id.split(":")[2];
    return !options.excludeSkus.has(sku);
  });
  const start = (options.wave - 1) * options.waveSize;
  const ids = remaining.slice(start, start + options.waveSize);
  if (ids.length === 0) throw new Error(`Wave ${options.wave} is empty (remaining ${remaining.length}).`);

  const selection = createBaseOfferLiveSelection({
    plan,
    fullSelection,
    kind: "WAVE",
    actionIds: ids,
  });
  assertBaseOfferLiveSelection(plan, fullSelection, selection);

  await mkdir(options.outputDir!, { recursive: true });
  const outPath = join(options.outputDir!, `live-selection-wave-${options.wave}.json`);
  const serialized = `${JSON.stringify(selection, null, 2)}\n`;
  await writeFile(outPath, serialized, { flag: "wx" });
  await writeFile(`${outPath}.sha256`, `${sha256(Buffer.from(serialized))}\n`, { flag: "wx" });
  console.log(`selection: ${selection.selection_id}`);
  console.log(`actions:   ${ids.length} (wave ${options.wave}, size ${options.waveSize}, remaining total ${remaining.length})`);
  console.log(`written:   ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.message}\n${error.stack?.split("\n").slice(1, 6).join("\n")}` : error);
  process.exit(1);
});
