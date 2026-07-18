/**
 * Build an immutable, read-only legacy BundleDraft recipe reservation plan.
 *
 * This command has no database or marketplace client and has deliberately no
 * --apply mode. It only reads one explicitly SHA-pinned ledger and writes one
 * new local JSON artifact with exclusive-create semantics.
 *
 * Example (Uncrustables 2026-07-17 cohort):
 *   npx tsx scripts/plan-legacy-recipe-dedup.ts \
 *     --ledger=data/audits/uncrustables-ledger-20260717T232140568Z-offline.json \
 *     --ledger-sha256=46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f \
 *     --expect-live=164 --expect-unique=144 --expect-duplicate-groups=20
 */

import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildLegacyRecipeDedupPlan,
  legacyRecipeSha256,
  verifyLegacyRecipeDedupPlan,
  type LegacyRecipeDedupLedgerLike,
} from "@/lib/bundle-factory/legacy-recipe-dedup";

interface Options {
  ledger_path: string;
  ledger_sha256: string;
  output_path: string | null;
  expected_live: number | undefined;
  expected_unique: number | undefined;
  expected_duplicate_groups: number | undefined;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/plan-legacy-recipe-dedup.ts [options]",
    "",
    "Required:",
    "  --ledger=PATH                 Complete immutable ledger to inspect.",
    "  --ledger-sha256=HEX           Exact expected SHA-256 of source bytes.",
    "",
    "Optional fail-closed cohort expectations:",
    "  --expect-live=N               Exact live fetched row count.",
    "  --expect-unique=N             Exact unique composition count.",
    "  --expect-duplicate-groups=N   Exact duplicate group count.",
    "  --output=PATH                 Exact new output path.",
    "  --help                        Show this help.",
    "",
    "There is intentionally no --apply flag. This command never connects to",
    "a database or marketplace and never deletes, merges, or changes a listing.",
  ].join("\n");
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

export function parseLegacyRecipeDedupArgs(argv: string[]): Options {
  const options: Options = {
    ledger_path: "",
    ledger_sha256: "",
    output_path: null,
    expected_live: undefined,
    expected_unique: undefined,
    expected_duplicate_groups: undefined,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("--ledger=")) {
      options.ledger_path = arg.slice("--ledger=".length).trim();
    } else if (arg.startsWith("--ledger-sha256=")) {
      options.ledger_sha256 = arg.slice("--ledger-sha256=".length).trim().toLowerCase();
    } else if (arg.startsWith("--output=")) {
      options.output_path = arg.slice("--output=".length).trim();
    } else if (arg.startsWith("--expect-live=")) {
      options.expected_live = positiveInteger(
        arg.slice("--expect-live=".length),
        "--expect-live",
      );
    } else if (arg.startsWith("--expect-unique=")) {
      options.expected_unique = positiveInteger(
        arg.slice("--expect-unique=".length),
        "--expect-unique",
      );
    } else if (arg.startsWith("--expect-duplicate-groups=")) {
      options.expected_duplicate_groups = nonNegativeInteger(
        arg.slice("--expect-duplicate-groups=".length),
        "--expect-duplicate-groups",
      );
    } else {
      throw new Error(`Unknown or forbidden option: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.ledger_path) throw new Error(`--ledger is required.\n\n${usage()}`);
  if (!/^[a-f0-9]{64}$/.test(options.ledger_sha256)) {
    throw new Error(`--ledger-sha256 must be exactly 64 lowercase hex characters.\n\n${usage()}`);
  }
  if (options.output_path === "") throw new Error("--output cannot be empty.");
  return options;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ledger";
}

async function main(): Promise<void> {
  const options = parseLegacyRecipeDedupArgs(process.argv.slice(2));
  const ledgerPath = path.resolve(options.ledger_path);
  const ledgerBytes = await readFile(ledgerPath);
  const actualSha = legacyRecipeSha256(ledgerBytes);
  if (actualSha !== options.ledger_sha256) {
    throw new Error(
      `Source ledger SHA-256 mismatch: expected ${options.ledger_sha256}, got ${actualSha}.`,
    );
  }
  let ledger: LegacyRecipeDedupLedgerLike;
  try {
    ledger = JSON.parse(ledgerBytes.toString("utf8")) as LegacyRecipeDedupLedgerLike;
  } catch {
    throw new Error(`${ledgerPath} is not valid JSON.`);
  }
  const plan = buildLegacyRecipeDedupPlan({
    ledger,
    ledgerBytes,
    ledgerPath,
    expectedLedgerSha256: options.ledger_sha256,
    expectedLiveRows: options.expected_live,
    expectedUniqueRecipes: options.expected_unique,
    expectedDuplicateGroups: options.expected_duplicate_groups,
  });
  verifyLegacyRecipeDedupPlan(plan);

  const outputPath = path.resolve(
    options.output_path ??
      path.join(
        "data/audits",
        `legacy-recipe-dedup-${safeFilename(plan.source_ledger.audit_id)}-${actualSha.slice(0, 12)}.json`,
      ),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  const handle = await open(outputPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }

  console.log(`Read-only plan: ${outputPath}`);
  console.log(`Plan SHA-256: ${plan.sha256}`);
  console.log(
    `Live=${plan.summary.live_rows} unique=${plan.summary.unique_recipes} ` +
      `duplicate_groups=${plan.summary.duplicate_groups} ` +
      `duplicate_siblings=${plan.summary.duplicate_siblings}`,
  );
  console.log("DB writes: 0; Amazon writes: 0; apply authorized: false");
}

if (process.argv[1]?.endsWith("plan-legacy-recipe-dedup.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
