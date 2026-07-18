/**
 * Build an immutable, plan-bound Uncrustables forward execution selection.
 *
 * The emitted artifact selects only TEXT_COUNT, STRUCTURED_ATTRIBUTES, and
 * MEDIA actions. OFFER/list-price paths are sealed as forbidden. This command
 * is fully offline and never calls Amazon or the database.
 *
 *   npx tsx scripts/build-uncrustables-repair-execution-selection.ts \
 *     --plan=data/repairs/generated/URP-....json \
 *     --output-dir=data/repairs/execution-selections
 */

import {
  readRepairPlan,
  repairExecutionSelection,
  verifyRepairExecutionSelection,
  writeImmutableRepairExecutionSelection,
  type RepairActionKind,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

const DEFAULT_OUTPUT_DIR = "data/repairs/execution-selections";
const CONTENT_ACTION_KINDS: RepairActionKind[] = [
  "TEXT_COUNT",
  "STRUCTURED_ATTRIBUTES",
  "MEDIA",
];

interface CliOptions {
  planPath: string | null;
  outputDir: string;
  skus: string[] | null;
  actionKinds: RepairActionKind[];
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/build-uncrustables-repair-execution-selection.ts --plan=PATH [options]",
    "",
    "  --plan=PATH        Existing immutable Uncrustables repair plan (required).",
    `  --output-dir=PATH  Immutable output directory (default ${DEFAULT_OUTPUT_DIR}).`,
    "  --skus=A,B         Exact positive SKU set (default all plan SKUs).",
    "  --action-kinds=A,B Exact action kinds (default TEXT_COUNT,STRUCTURED_ATTRIBUTES,MEDIA).",
    "  --help             Show this help.",
    "",
    "Selections are SHA-sealed and resolved only from the immutable source plan.",
    "This command makes no Amazon call, database call, upload, or marketplace mutation.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    planPath: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    skus: null,
    actionKinds: CONTENT_ACTION_KINDS,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--skus=")) {
      options.skus = arg.slice("--skus=".length).split(",")
        .map((sku) => sku.trim()).filter(Boolean);
      if (options.skus.length === 0) throw new Error("--skus cannot be empty.");
    } else if (arg.startsWith("--action-kinds=")) {
      const valid = new Set<RepairActionKind>([
        "TEXT_COUNT",
        "STRUCTURED_ATTRIBUTES",
        "MEDIA",
        "OFFER",
      ]);
      const requested = arg.slice("--action-kinds=".length).split(",")
        .map((kind) => kind.trim()).filter(Boolean);
      if (
        requested.length === 0 ||
        requested.some((kind) => !valid.has(kind as RepairActionKind))
      ) {
        throw new Error("--action-kinds contains an empty or unknown kind.");
      }
      options.actionKinds = requested as RepairActionKind[];
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.planPath) throw new Error("--plan=PATH is required.");
  if (!options.outputDir) throw new Error("--output-dir cannot be empty.");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plan = await readRepairPlan(options.planPath!);
  const selection = repairExecutionSelection(plan, {
    sourcePlanPath: options.planPath,
    skus: options.skus,
    actionKinds: options.actionKinds,
  });
  verifyRepairExecutionSelection(plan, selection);
  const outputPath = await writeImmutableRepairExecutionSelection(
    options.outputDir,
    selection,
  );
  console.log(
    JSON.stringify(
      {
        immutable_execution_selection: outputPath,
        source_plan: options.planPath,
        source_plan_sha256: plan.sha256,
        selection_sha256: selection.sha256,
        profile: selection.profile,
        selected_skus: selection.selected_skus.length,
        selected_actions: selection.selected_actions,
        action_kinds: selection.requested_action_kinds,
        forbidden_patch_paths: selection.forbidden_patch_paths,
        required_confirmation: selection.confirmation_token,
      },
      null,
      2,
    ),
  );
  console.log("No Amazon call, database call, upload, or marketplace mutation was made.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
