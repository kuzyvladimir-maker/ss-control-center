/**
 * Verify the exact sealed MAIN-only Uncrustables plan/selection against the
 * offline patch-intent artifact. Local reads/writes only; zero external calls.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ListingItem } from "@/lib/amazon-sp-api/listings";
import {
  MAIN_MEDIA_ONLY_PROFILE,
  buildActionPatches,
  readRepairExecutionSelection,
  readRepairPlan,
  sha256,
  stableJson,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

const PREFLIGHT_SCHEMA =
  "uncrustables-owner-relaxed-main-amazon-preflight/v1" as const;
const VALIDATION_SCHEMA =
  "uncrustables-owner-relaxed-main-amazon-preflight-validation/v1" as const;

interface Options {
  planPath: string | null;
  selectionPath: string | null;
  preflightPath: string | null;
  outputDir: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    planPath: null,
    selectionPath: null,
    preflightPath: null,
    outputDir: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npx tsx scripts/verify-uncrustables-owner-relaxed-main-amazon-preflight.ts \\",
          "  --plan=PATH --selection=PATH --preflight=PATH --output-dir=PATH",
          "",
          "Local reads/writes only; zero Amazon calls and zero external mutations.",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--selection=")) {
      options.selectionPath = arg.slice("--selection=".length).trim();
    } else if (arg.startsWith("--preflight=")) {
      options.preflightPath = arg.slice("--preflight=".length).trim();
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (
    !options.planPath ||
    !options.selectionPath ||
    !options.preflightPath ||
    !options.outputDir
  ) {
    throw new Error(
      "--plan, --selection, --preflight, and --output-dir are required.",
    );
  }
  return options;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

async function readBytes(file: string): Promise<Buffer> {
  return readFile(file);
}

async function writeImmutableJson(
  file: string,
  value: unknown,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(file, bytes, { flag: "wx" });
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, {
    flag: "wx",
  });
  return { path: file, sha256: digest, bytes: bytes.length };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const planPath = path.resolve(options.planPath!);
  const selectionPath = path.resolve(options.selectionPath!);
  const preflightPath = path.resolve(options.preflightPath!);
  const outputDir = path.resolve(options.outputDir!);

  try {
    await access(outputDir);
    throw new Error(`Output directory already exists: ${outputDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const [plan, preflightBytes] = await Promise.all([
    readRepairPlan(planPath),
    readBytes(preflightPath),
  ]);
  const selection = await readRepairExecutionSelection(selectionPath, plan);
  const preflight = JSON.parse(preflightBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert(
    preflight.schema_version === PREFLIGHT_SCHEMA &&
      preflight.immutable === true &&
      preflight.status ===
        "OFFLINE_PATCH_INTENT_READY_VALIDATION_PREVIEW_NOT_RUN",
    "Offline preflight schema/state is invalid.",
  );
  assert(
    selection.profile === MAIN_MEDIA_ONLY_PROFILE &&
      selection.selected_actions === 24 &&
      selection.selected_skus.length === 24 &&
      selection.requested_action_kinds?.length === 1 &&
      selection.requested_action_kinds[0] === "MEDIA",
    "Selection is not the exact 24-action MAIN-only profile.",
  );
  assert(
    plan.scope.entries === 24 &&
      plan.scope.blocked === 0 &&
      plan.semantic_audit.checked === 24 &&
      plan.semantic_audit.failed === 0 &&
      plan.semantic_audit.blocked === 0,
    "Plan scope or semantic audit is not a clean exact 24-row cohort.",
  );
  assert(
    plan.desired_manifest_source != null,
    "Plan has no sealed desired-manifest source.",
  );

  const [planBytes, selectionBytes, desiredBytes, ledgerBytes] =
    await Promise.all([
      readBytes(planPath),
      readBytes(selectionPath),
      readBytes(plan.desired_manifest_source.path),
      readBytes(plan.source_ledger.path),
    ]);
  assert(
    sha256(desiredBytes) === plan.desired_manifest_source.sha256,
    "Desired-manifest bytes no longer match the plan binding.",
  );
  assert(
    sha256(ledgerBytes) === plan.source_ledger.sha256,
    "Ledger bytes no longer match the plan binding.",
  );
  const desiredManifest = JSON.parse(desiredBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  const desiredRows = desiredManifest.main_image_patch_rows;
  assert(
    Array.isArray(desiredRows) && desiredRows.length === 24,
    "Desired manifest does not contain 24 exact MAIN rows.",
  );
  const desiredBySku = new Map(
    desiredRows.map((row) => {
      assert(isRecord(row) && typeof row.sku === "string", "Invalid desired row.");
      return [row.sku, row] as const;
    }),
  );

  const preflightRows = preflight.rows;
  assert(
    Array.isArray(preflightRows) && preflightRows.length === 24,
    "Offline preflight does not contain 24 rows.",
  );
  const preflightBySku = new Map(
    preflightRows.map((row) => {
      assert(
        isRecord(row) && typeof row.sku === "string",
        "Invalid offline-preflight row.",
      );
      return [row.sku, row] as const;
    }),
  );
  assert(
    desiredBySku.size === 24 && preflightBySku.size === 24,
    "Desired/preflight SKU uniqueness failed.",
  );

  const selectedActionIds = new Set(selection.selected_action_ids);
  const selected = plan.entries.flatMap((entry) =>
    entry.actions
      .filter((action) => selectedActionIds.has(action.action_id))
      .map((action) => ({ entry, action })),
  );
  assert(selected.length === 24, "Plan resolves fewer or more than 24 selected actions.");

  const validatedRows = selected.map(({ entry, action }) => {
    const preflightRow = preflightBySku.get(entry.sku);
    const desiredRow = desiredBySku.get(entry.sku);
    assert(preflightRow && desiredRow, `Missing bound row for ${entry.sku}.`);
    assert(
      action.kind === "MEDIA" &&
        action.desired.kind === "MEDIA" &&
        typeof action.desired.value.main_image_url === "string" &&
        action.desired.value.gallery_slots.length === 0 &&
        (action.desired.value.delete_gallery_slots?.length ?? 0) === 0,
      `Selected action ${action.action_id} is not MAIN-only.`,
    );
    assert(
      entry.asin === preflightRow.asin &&
        entry.asin === desiredRow.asin &&
        entry.store_index === preflightRow.store_index &&
        entry.audited_product_type === preflightRow.audited_product_type,
      `Plan/preflight identity mismatch for ${entry.sku}.`,
    );
    const desiredMain = preflightRow.desired_main;
    assert(
      isRecord(desiredMain) &&
        action.desired.value.main_image_url === desiredMain.url &&
        desiredRow.desired_main_url === desiredMain.url &&
        desiredRow.desired_main_sha256 === desiredMain.sha256,
      `Desired MAIN URL/SHA binding mismatch for ${entry.sku}.`,
    );
    const live = {
      sku: entry.sku,
      summaries: [],
      attributes: {
        main_product_image_locator: [
          {
            media_location: preflightRow.current_main_locator,
            marketplace_id: "ATVPDKIKX0DER",
          },
        ],
      },
      issues: [],
      offers: [],
      fulfillmentAvailability: [],
    } as unknown as ListingItem;
    const actualPatches = buildActionPatches(action, live);
    assert(
      Array.isArray(preflightRow.intended_patch) &&
        stableJson(actualPatches) === stableJson(preflightRow.intended_patch),
      `Surgical patch builder differs from sealed patch intent for ${entry.sku}.`,
    );
    assert(
      actualPatches.length === 1 &&
        actualPatches[0].op === "replace" &&
        actualPatches[0].path ===
          "/attributes/main_product_image_locator",
      `Unexpected patch path or operation for ${entry.sku}.`,
    );
    return {
      sku: entry.sku,
      asin: entry.asin,
      action_id: action.action_id,
      product_type: entry.audited_product_type,
      desired_main_url: desiredMain.url,
      desired_main_sha256: desiredMain.sha256,
      patch_sha256: sha256(stableJson(actualPatches)),
      status: "PASS_MAIN_ONLY_EXACT_PATCH",
    };
  });

  assert(
    stableJson(validatedRows.map((row) => row.sku)) ===
      stableJson(selection.selected_skus),
    "Validated row order differs from the sealed selection.",
  );
  const report = {
    schema_version: VALIDATION_SCHEMA,
    immutable: true,
    generated_at: new Date().toISOString(),
    status: "PASS_OFFLINE_READY_FOR_FUTURE_AMAZON_VALIDATION_PREVIEW",
    sources: {
      plan: { path: planPath, file_sha256: sha256(planBytes), plan_sha256: plan.sha256 },
      selection: {
        path: selectionPath,
        file_sha256: sha256(selectionBytes),
        selection_sha256: selection.sha256,
        profile: selection.profile,
      },
      preflight: { path: preflightPath, file_sha256: sha256(preflightBytes) },
      desired_manifest: {
        path: plan.desired_manifest_source.path,
        file_sha256: plan.desired_manifest_source.sha256,
      },
      source_ledger: {
        path: plan.source_ledger.path,
        file_sha256: plan.source_ledger.sha256,
      },
    },
    summary: {
      rows: validatedRows.length,
      selected_actions: selection.selected_actions,
      exact_main_replace_patches: validatedRows.length,
      semantic_pass: plan.semantic_audit.passed,
      blockers: 0,
      amazon_get_calls: 0,
      amazon_validation_preview_calls: 0,
      amazon_mutations: 0,
      database_calls: 0,
      external_uploads: 0,
    },
    next_gate: {
      required_mode: "VALIDATION_PREVIEW",
      executed: false,
      reason_not_executed:
        "This verifier is intentionally offline; no Amazon PATCH, including VALIDATION_PREVIEW, was authorized for this task.",
    },
    rows: validatedRows,
  };

  await mkdir(outputDir, { recursive: true });
  const artifact = await writeImmutableJson(
    path.join(outputDir, "offline-main-only-validation.json"),
    report,
  );
  console.log(
    JSON.stringify(
      {
        validation_artifact: artifact,
        status: report.status,
        rows: validatedRows.length,
        profile: selection.profile,
        blockers: 0,
        amazon_calls: 0,
        external_mutations: 0,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
