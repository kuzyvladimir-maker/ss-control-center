/**
 * Guarded inverse executor for a sealed Uncrustables rollback plan.
 *
 * Default invocation is offline and makes zero Amazon calls. A real rollback
 * requires --apply, an explicit CANARY/ALL scope, the plan-specific CLI token,
 * and the same token in BF_UNCRUSTABLES_ENABLE_AMAZON_ROLLBACK.
 */

import { config } from "dotenv";
import path from "node:path";

import {
  getListing,
  patchListing,
  type ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import {
  assertRollbackMediaEvidenceFiles,
  executeRollbackPlan,
  ImmutableRollbackCheckpointStore,
  readPreChangeSnapshot,
  readRollbackPlan,
  rollbackConfirmationToken,
  type RollbackGateway,
} from "@/lib/bundle-factory/repair/uncrustables-amazon-rollback";
import {
  CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT,
  ImmutableCheckpointStore,
  UNCRUSTABLES_APP_ROOT,
  assertValidationPreviewSurrogateMatches,
  readRepairExecutionSelection,
  readRepairPlan,
  sha256,
  type RepairValidationPreviewContext,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";
import { readFile } from "node:fs/promises";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_CHECKPOINT_DIR = path.join(
  UNCRUSTABLES_APP_ROOT,
  "data/repairs/rollback/checkpoints",
);
const DEFAULT_FORWARD_CHECKPOINT_DIR =
  CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT;

interface CliOptions {
  planPath: string;
  apply: boolean;
  preview: boolean;
  scope: "CANARY" | "ALL";
  scopeExplicit: boolean;
  skus: string[] | null;
  confirmation: string | null;
  checkpointDir: string;
  forwardCheckpointDir: string;
  requestDelayMs: number;
  verifyAttempts: number;
  verifyDelayMs: number;
  settlementAttempts: number;
  settlementDelayMs: number;
  settlementStableReads: number;
  maxErrors: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/rollback-uncrustables-amazon.ts --plan=PATH [options]",
    "",
    "Offline inspection (default; zero API calls):",
    "  --plan=PATH            Exact immutable rollback plan.",
    "  --scope=canary|all     Selection preview; default canary.",
    "  --skus=A,B             Exact partial rollback selection.",
    "  --preview              Live GET + rollback CAS + VALIDATION_PREVIEW; no mutation.",
    "",
    "Real rollback (mutating; all gates required):",
    "  --apply                Enable inverse Amazon PATCHes.",
    "  --scope=canary|all     Must be explicitly supplied with --apply.",
    "  --skus=A,B             Alternative explicit partial apply scope.",
    "  --confirm=TOKEN        Exact plan token shown by dry run.",
    `  --checkpoint-dir=PATH Append-only events (default ${DEFAULT_CHECKPOINT_DIR}).`,
    `  --forward-checkpoint-dir=PATH Forward apply events (default ${DEFAULT_FORWARD_CHECKPOINT_DIR}).`,
    "  --request-delay-ms=N   SP-API pacing >=200 (default 250).",
    "  --verify-attempts=N    Post-write GET attempts 1-10 (default 6).",
    "  --verify-delay-ms=N    Delay between readbacks (default 10000).",
    "  --settlement-attempts=N Extended exact-path polls, 3-60 (default 20).",
    "  --settlement-delay-ms=N Delay between extended polls, >=5000 (default 30000).",
    "  --settlement-stable-reads=N Consecutive identical reads, 2-10 (default 3).",
    "  --max-errors=N         Fail-closed fuse (default 1).",
    "",
    "Environment gate: BF_UNCRUSTABLES_ENABLE_AMAZON_ROLLBACK must equal TOKEN.",
  ].join("\n");
}

function positiveInt(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    planPath: "",
    apply: false,
    preview: false,
    scope: "CANARY",
    scopeExplicit: false,
    skus: null,
    confirmation: null,
    checkpointDir: DEFAULT_CHECKPOINT_DIR,
    forwardCheckpointDir: DEFAULT_FORWARD_CHECKPOINT_DIR,
    requestDelayMs: 250,
    verifyAttempts: 6,
    verifyDelayMs: 10_000,
    settlementAttempts: 20,
    settlementDelayMs: 30_000,
    settlementStableReads: 3,
    maxErrors: 1,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--preview") {
      options.preview = true;
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--scope=")) {
      const raw = arg.slice("--scope=".length).trim().toUpperCase();
      if (raw !== "CANARY" && raw !== "ALL") {
        throw new Error("--scope must be canary or all.");
      }
      options.scope = raw;
      options.scopeExplicit = true;
    } else if (arg.startsWith("--skus=")) {
      const values = arg
        .slice("--skus=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (!values.length) throw new Error("--skus cannot be empty.");
      options.skus = [...new Set(values)];
    } else if (arg.startsWith("--confirm=")) {
      options.confirmation = arg.slice("--confirm=".length).trim();
    } else if (arg.startsWith("--checkpoint-dir=")) {
      options.checkpointDir = arg.slice("--checkpoint-dir=".length).trim();
    } else if (arg.startsWith("--forward-checkpoint-dir=")) {
      options.forwardCheckpointDir = arg
        .slice("--forward-checkpoint-dir=".length)
        .trim();
    } else if (arg.startsWith("--request-delay-ms=")) {
      options.requestDelayMs = positiveInt(
        "--request-delay-ms",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--verify-attempts=")) {
      options.verifyAttempts = positiveInt(
        "--verify-attempts",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--verify-delay-ms=")) {
      options.verifyDelayMs = positiveInt(
        "--verify-delay-ms",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--settlement-attempts=")) {
      options.settlementAttempts = positiveInt(
        "--settlement-attempts",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--settlement-delay-ms=")) {
      options.settlementDelayMs = positiveInt(
        "--settlement-delay-ms",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--settlement-stable-reads=")) {
      options.settlementStableReads = positiveInt(
        "--settlement-stable-reads",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--max-errors=")) {
      options.maxErrors = positiveInt("--max-errors", arg.split("=", 2)[1]);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.planPath) throw new Error("--plan=PATH is required.");
  if (options.apply && options.preview) {
    throw new Error("--apply and --preview are mutually exclusive.");
  }
  if (options.skus && options.scopeExplicit) {
    throw new Error("Use either --skus or --scope, not both.");
  }
  if (options.apply && !options.scopeExplicit && !options.skus) {
    throw new Error(
      "--apply requires an explicit --scope=canary|all or --skus=A,B.",
    );
  }
  if (options.apply && !options.confirmation) {
    throw new Error("--apply requires --confirm=TOKEN.");
  }
  if (
    options.apply &&
    path.resolve(options.checkpointDir) !== path.resolve(DEFAULT_CHECKPOINT_DIR)
  ) {
    throw new Error(
      `Rollback --apply requires canonical --checkpoint-dir=${DEFAULT_CHECKPOINT_DIR}.`,
    );
  }
  if (
    options.apply &&
    path.resolve(options.forwardCheckpointDir) !==
      path.resolve(DEFAULT_FORWARD_CHECKPOINT_DIR)
  ) {
    throw new Error(
      `Rollback --apply requires canonical --forward-checkpoint-dir=${DEFAULT_FORWARD_CHECKPOINT_DIR} so pending forward mutations cannot be hidden.`,
    );
  }
  if (options.requestDelayMs < 200) {
    throw new Error("--request-delay-ms must be >=200.");
  }
  if (options.verifyAttempts > 10) {
    throw new Error("--verify-attempts must be <=10.");
  }
  if (options.settlementAttempts < 3 || options.settlementAttempts > 60) {
    throw new Error("--settlement-attempts must be between 3 and 60.");
  }
  if (options.settlementDelayMs < 5_000) {
    throw new Error("--settlement-delay-ms must be >=5000.");
  }
  if (
    options.settlementStableReads < 2 ||
    options.settlementStableReads > 10 ||
    options.settlementStableReads > options.settlementAttempts
  ) {
    throw new Error(
      "--settlement-stable-reads must be 2-10 and <= --settlement-attempts.",
    );
  }
  return options;
}

class LiveGateway implements RollbackGateway {
  private readonly sellerIds = new Map<number, string>();

  private async sellerId(storeIndex: number): Promise<string> {
    let sellerId = this.sellerIds.get(storeIndex);
    if (!sellerId) {
      sellerId = await getMerchantToken(storeIndex);
      this.sellerIds.set(storeIndex, sellerId);
    }
    return sellerId;
  }

  async getListing(storeIndex: number, sku: string) {
    return getListing(storeIndex, await this.sellerId(storeIndex), sku, {
      includedData: [
        "summaries",
        "attributes",
        "issues",
        "offers",
        "fulfillmentAvailability",
        "procurement",
      ],
    });
  }

  async patchListing(
    storeIndex: number,
    sku: string,
    productType: string,
    patches: ListingPatch[],
    validationPreview: boolean,
    previewContext?: RepairValidationPreviewContext,
  ) {
    if (!validationPreview && previewContext) {
      throw new Error(
        `Rollback preview-surrogate context is forbidden on a mutating PATCH for ${sku}.`,
      );
    }
    const hasOfferSelectorReplace = patches.some(
      (patch) =>
        patch.op === "replace" &&
        patch.path === "/attributes/purchasable_offer",
    );
    if (validationPreview && hasOfferSelectorReplace && !previewContext) {
      throw new Error(
        `Rollback offer selector-replace preview for ${sku} has no sealed inverse merge context.`,
      );
    }
    if (previewContext) {
      assertValidationPreviewSurrogateMatches({
        actualPatches: previewContext.actual_patches,
        previewPatches: patches,
        context: previewContext.offer_merge_context,
      });
    }
    return patchListing(
      storeIndex,
      await this.sellerId(storeIndex),
      sku,
      productType,
      patches,
      { validationPreview },
    ) as Promise<Record<string, unknown>>;
  }
}

async function assertSealedSources(planPath: string) {
  const plan = await readRollbackPlan(planPath);
  const snapshot = await readPreChangeSnapshot(plan.source_snapshot.path);
  if (snapshot.sha256 !== plan.source_snapshot.sha256) {
    throw new Error("Rollback source snapshot seal does not match the plan.");
  }
  const repairPlan = await readRepairPlan(plan.source_repair_plan.path);
  if (repairPlan.sha256 !== plan.source_repair_plan.sha256) {
    throw new Error("Rollback source repair plan seal does not match the plan.");
  }
  if (repairPlan.desired_manifest_source) {
    const manifestBytes = await readFile(repairPlan.desired_manifest_source.path);
    if (sha256(manifestBytes) !== repairPlan.desired_manifest_source.sha256) {
      throw new Error(
        "Rollback desired-state manifest bytes no longer match the repair plan seal.",
      );
    }
  }
  const executionSelection = plan.source_execution_selection
    ? await readRepairExecutionSelection(
        plan.source_execution_selection.path,
        repairPlan,
      )
    : null;
  if (
    plan.source_execution_selection &&
    (!executionSelection ||
      executionSelection.sha256 !== plan.source_execution_selection.sha256 ||
      executionSelection.profile !==
        plan.source_execution_selection.profile ||
      executionSelection.selected_actions !==
        plan.source_execution_selection.selected_actions ||
      sha256(JSON.stringify(executionSelection.selected_action_ids)) !==
        plan.source_execution_selection.selected_action_ids_sha256)
  ) {
    throw new Error(
      "Rollback source execution selection no longer matches the sealed rollback binding.",
    );
  }
  const ledgerBytes = await readFile(snapshot.source_ledger.path);
  const overridesBytes = await readFile(snapshot.reviewed_overrides.path);
  if (
    sha256(ledgerBytes) !== snapshot.source_ledger.sha256 ||
    sha256(overridesBytes) !== snapshot.reviewed_overrides.sha256
  ) {
    throw new Error("Rollback source ledger/overrides bytes no longer match their seals.");
  }
  await assertRollbackMediaEvidenceFiles({ snapshot, rollbackPlan: plan });
  return { plan, snapshot, repairPlan, executionSelection };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plan = await readRollbackPlan(options.planPath);
  const token = rollbackConfirmationToken(plan);
  console.log(
    JSON.stringify(
      {
        mode: options.apply
          ? "ROLLBACK"
          : options.preview
            ? "ROLLBACK_VALIDATION_PREVIEW"
            : "DRY_RUN_OFFLINE",
        rollback_plan_id: plan.rollback_plan_id,
        rollback_plan_sha256: plan.sha256,
        apply_eligible: plan.apply_eligible,
        requested_scope: options.skus ? "SKUS" : options.scope,
        requested_skus: options.skus,
        canary_skus: plan.canary.skus,
        entries: options.skus
          ? options.skus.length
          : options.scope === "CANARY"
            ? plan.canary.skus.length
            : plan.scope.rollback_entries,
        inverse_operations: plan.scope.inverse_operations,
        required_confirmation: token,
        source_execution_selection: plan.source_execution_selection,
      },
      null,
      2,
    ),
  );
  const checkpointStore = new ImmutableRollbackCheckpointStore(
    options.checkpointDir,
    plan.sha256,
  );
  if (!options.apply && !options.preview) {
    const result = await executeRollbackPlan(plan, {} as RollbackGateway, {
      apply: false,
      scope: options.skus ? undefined : options.scope,
      skus: options.skus,
      checkpointStore,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("No Amazon call, database call, upload, or marketplace mutation was made.");
    return;
  }
  // Re-prove every local prerequisite before the first credential/API call.
  const sealedSources = await assertSealedSources(options.planPath);
  const liveGateway = new LiveGateway();
  const result = await executeRollbackPlan(plan, liveGateway, {
    apply: options.apply,
    validationOnly: options.preview,
    scope: options.skus ? undefined : options.scope,
    skus: options.skus,
    confirmation: options.confirmation,
    environmentConfirmation:
      process.env.BF_UNCRUSTABLES_ENABLE_AMAZON_ROLLBACK ?? null,
    checkpointStore,
    forwardRepairPlan: options.apply ? sealedSources.repairPlan : undefined,
    forwardExecutionSelection:
      options.apply && sealedSources.executionSelection
        ? sealedSources.executionSelection
        : undefined,
    forwardExecutionSelectionPath:
      options.apply && plan.source_execution_selection
        ? plan.source_execution_selection.path
        : undefined,
    forwardCheckpointStore: options.apply
      ? new ImmutableCheckpointStore(
          options.forwardCheckpointDir,
          sealedSources.repairPlan.sha256,
        )
      : undefined,
    requestDelayMs: options.requestDelayMs,
    verifyAttempts: options.verifyAttempts,
    verifyDelayMs: options.verifyDelayMs,
    settlementAttempts: options.settlementAttempts,
    settlementDelayMs: options.settlementDelayMs,
    settlementStableReads: options.settlementStableReads,
    maxErrors: options.maxErrors,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed_entries > 0 || result.stopped_early) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
