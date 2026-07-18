/**
 * Immutable-plan, PATCH-only Uncrustables repair CLI.
 *
 * Default invocation is fully offline: it reads the latest sealed ledger,
 * builds a SHA-256 plan, and emits a ChannelMAX TSV + manifest. It never calls
 * Amazon or Prisma. Live execution requires an existing plan, --apply, and the
 * plan-specific confirmation token, matching environment arm, and a fresh
 * exact 164-row live pre-change snapshot with a sealed inverse plan.
 *
 *   npx tsx scripts/repair-uncrustables-surgical.ts
 *   npx tsx scripts/repair-uncrustables-surgical.ts --skus=SZ-ASPI-JFAT --limit=1
 *   npx tsx scripts/repair-uncrustables-surgical.ts --plan=data/repairs/URP-....json
 *   npx tsx scripts/repair-uncrustables-surgical.ts --plan=... --apply \
 *     --confirm=APPLY-UNCRUSTABLES-0123456789ABCDEF --limit=1
 */

import { config } from "dotenv";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import {
  getListing,
  patchListing,
  type ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { PerceptualMediaEquivalence } from "@/lib/bundle-factory/repair/media-equivalence";
import {
  verifyUncrustablesLaunchExecutionAuthorization,
  type LaunchExecutionAuthorizationRuntimeInput,
} from "@/lib/bundle-factory/repair/uncrustables-launch-execution-authorization";
import {
  verifyUncrustablesLaunchPricingManifest,
} from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";
import {
  assertRollbackMediaEvidenceFiles,
  assertForwardApplyRollbackCoverage,
  assertForwardPatchRollbackCovered,
  readPreChangeSnapshot,
  readRollbackPlan,
  type UncrustablesRollbackPlan,
} from "@/lib/bundle-factory/repair/uncrustables-amazon-rollback";
import {
  CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT,
  OFFER_ONLY_EXECUTION_PROFILE,
  ImmutableCheckpointStore,
  assertValidationPreviewSurrogateMatches,
  assertRepairPlanLaunchPricingBinding,
  buildRepairPlan,
  confirmationToken,
  executeRepairPlan,
  readRepairExecutionSelection,
  readRepairPlan,
  sha256,
  writeImmutableChannelMaxArtifact,
  writeImmutablePlan,
  type DesiredRepairManifest,
  type RepairExecutionSelection,
  type RepairAmazonGateway,
  type RepairValidationPreviewContext,
  type OfferExecutionPhase,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_AUDIT_DIR = "data/audits";
const DEFAULT_OUTPUT_DIR = "data/repairs/generated";
const DEFAULT_CHECKPOINT_DIR = CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT;
const DEFAULT_MANIFEST = "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const DEFAULT_DONOR_MANIFEST =
  "data/repairs/uncrustables-donor-enrichment-20260717.json";
const DEFAULT_PTD_PROOF =
  "data/audits/amazon-food-ptd-attribute-proof-20260718T010205Z.json";
const SURGICAL_MUTATING_PATCH_TIMEOUT_MS = 60_000;

interface CliOptions {
  planPath: string | null;
  executionSelectionPath: string | null;
  ledgerPath: string | null;
  manifestPath: string | null;
  launchPricingManifestPath: string | null;
  launchExecutionAuthorizationPath: string | null;
  heroManifestPath: string | null;
  galleryManifestPath: string | null;
  donorManifestPath: string | null;
  ptdProofPath: string | null;
  requireStructuredAttributes: boolean;
  requireCompleteMedia: boolean;
  outputDir: string;
  checkpointDir: string;
  rollbackPlanPath: string | null;
  rollbackSnapshotMaxAgeMinutes: number;
  apply: boolean;
  preview: boolean;
  submitOnly: boolean;
  settleOnly: boolean;
  recoverPendingOnly: boolean;
  confirmation: string | null;
  skus: string[] | null;
  limit: number | null;
  requestDelayMs: number;
  verifyAttempts: number;
  verifyDelayMs: number;
  settlementAttempts: number;
  settlementDelayMs: number;
  settlementStableReads: number;
  offerSettlementHorizonHours: number;
  offerSettlementPollIntervalMs: number;
  offerSettlementRequestDelayMs: number;
  offerSettlementObservationTimeoutMs: number;
  offerSettlementMaxReadsPerSubmission: number | null;
  pendingRecoveryHorizonHours: number;
  pendingRecoveryPollIntervalMs: number;
  pendingRecoveryRequestDelayMs: number;
  pendingRecoveryObservationTimeoutMs: number;
  pendingRecoveryMaxReadsPerSubmission: number | null;
  maxErrors: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/repair-uncrustables-surgical.ts [options]",
    "",
    "Offline planning (default; zero Amazon/DB calls):",
    "  --ledger=PATH          Immutable live ledger or its sealed resummary.",
    `  --manifest=PATH        Reviewed overrides (default ${DEFAULT_MANIFEST}).`,
    "  --launch-pricing-manifest=PATH Pinned Coupon-vs-Sale-Price Layer B manifest.",
    "  --media-manifest=PATH  Complete 164-row QA-verified hero manifest.",
    "  --gallery-manifest=PATH Complete 164-row verified 4-6-image gallery manifest.",
    `  --donor-manifest=PATH Pinned reviewed donor facts (default ${DEFAULT_DONOR_MANIFEST}).`,
    `  --ptd-proof=PATH       Pinned live PTD attribute proof (default ${DEFAULT_PTD_PROOF}).`,
    "  --no-structured-attributes Non-final diagnostic plan without ingredient/allergen repair.",
    "  --no-media-manifest    Non-final diagnostic plan without full hero assets.",
    `  --output-dir=PATH      Immutable plan/ChannelMAX output (default ${DEFAULT_OUTPUT_DIR}).`,
    "  --skus=A,B             Restrict plan/execution to exact SKUs.",
    "  --limit=N              Restrict to first N selected, sorted entries.",
    "",
    "Existing-plan inspection/execution:",
    "  --plan=PATH            Read an existing SHA-sealed plan.",
    "  --execution-selection=PATH Read a SHA-sealed exact action selection; forbids --skus/--limit.",
    "  --launch-execution-authorization=PATH Current sealed ChannelMAX Manual + Coupon activation proof for OFFER apply.",
    "  --preview              Live GET + VALIDATION_PREVIEW only; no real PATCH.",
    "  --apply                Enable Amazon calls; requires --plan and --confirm.",
    "  --submit-only          With --apply, submit each exact OFFER once and leave it pending; zero post-write GETs.",
    "  --settle-only          GET-only settlement of an exact pending OFFER selection; forbids --apply/--preview.",
    "  --recover-pending-only GET-only settlement of any exact pending selection; forbids all write/preview/narrowing options.",
    "  --confirm=TOKEN        Exact plan-specific token printed in dry mode.",
    "  --rollback-plan=PATH   Apply-eligible inverse plan from a fresh exact 164-row live snapshot.",
    "  --rollback-snapshot-max-age-min=N Freshness gate before first write (default 60).",
    `  --checkpoint-dir=PATH  Append-only JSON events (default ${DEFAULT_CHECKPOINT_DIR}).`,
    "  --request-delay-ms=N   SP-API pacing, >=200 (default 250).",
    "  --verify-attempts=N    Post-GET attempts, 1-10 (default 6).",
    "  --verify-delay-ms=N    Delay between post-GET attempts (default 10000).",
    "  --settlement-attempts=N Extended exact-path polls after timeout, 3-60 (default 20).",
    "  --settlement-delay-ms=N Delay between extended polls, >=5000 (default 30000).",
    "  --settlement-stable-reads=N Consecutive identical reads, 2-10 (default 3).",
    "  --offer-settlement-horizon-hours=N GET-only horizon, 1-72 (default 6).",
    "  --offer-settlement-poll-interval-ms=N Delay between full pending sweeps, >=5000 (default 300000).",
    "  --offer-settlement-request-delay-ms=N Global GET start pacing, >=200 (default 5000).",
    "  --offer-settlement-observation-timeout-ms=N Abort one hung GET, >=1000 (default 60000).",
    "  --offer-settlement-max-reads-per-submission=N Optional short-probe cap, >=3 (default unlimited within horizon).",
    "  --pending-recovery-horizon-hours=N Generic GET-only horizon, 1-72 (default 6).",
    "  --pending-recovery-poll-interval-ms=N Delay between generic pending sweeps, >=5000 (default 300000).",
    "  --pending-recovery-request-delay-ms=N Generic GET start pacing, >=200 (default 5000).",
    "  --pending-recovery-observation-timeout-ms=N Abort one generic recovery GET, >=1000 (default 60000).",
    "  --pending-recovery-max-reads-per-submission=N Optional short-probe cap, >=3 (default unlimited within horizon).",
    "  --max-errors=N         Fail-closed fuse (default 1).",
    "  --help                  Show this help.",
    "",
    "Environment gate: BF_UNCRUSTABLES_ENABLE_AMAZON_APPLY must equal the confirmation token.",
    "There is no Listings Items PUT path and no database write path in this CLI.",
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
    planPath: null,
    executionSelectionPath: null,
    ledgerPath: null,
    manifestPath: DEFAULT_MANIFEST,
    launchPricingManifestPath: null,
    launchExecutionAuthorizationPath: null,
    heroManifestPath: null,
    galleryManifestPath: null,
    donorManifestPath: DEFAULT_DONOR_MANIFEST,
    ptdProofPath: DEFAULT_PTD_PROOF,
    requireStructuredAttributes: true,
    requireCompleteMedia: true,
    outputDir: DEFAULT_OUTPUT_DIR,
    checkpointDir: DEFAULT_CHECKPOINT_DIR,
    rollbackPlanPath: null,
    rollbackSnapshotMaxAgeMinutes: 60,
    apply: false,
    preview: false,
    submitOnly: false,
    settleOnly: false,
    recoverPendingOnly: false,
    confirmation: null,
    skus: null,
    limit: null,
    requestDelayMs: 250,
    verifyAttempts: 6,
    verifyDelayMs: 10_000,
    settlementAttempts: 20,
    settlementDelayMs: 30_000,
    settlementStableReads: 3,
    offerSettlementHorizonHours: 6,
    offerSettlementPollIntervalMs: 5 * 60_000,
    offerSettlementRequestDelayMs: 5_000,
    offerSettlementObservationTimeoutMs: 60_000,
    offerSettlementMaxReadsPerSubmission: null,
    pendingRecoveryHorizonHours: 6,
    pendingRecoveryPollIntervalMs: 5 * 60_000,
    pendingRecoveryRequestDelayMs: 5_000,
    pendingRecoveryObservationTimeoutMs: 60_000,
    pendingRecoveryMaxReadsPerSubmission: null,
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
    } else if (arg === "--submit-only") {
      options.submitOnly = true;
    } else if (arg === "--settle-only") {
      options.settleOnly = true;
    } else if (arg === "--recover-pending-only") {
      options.recoverPendingOnly = true;
    } else if (arg === "--no-manifest") {
      options.manifestPath = null;
    } else if (arg === "--no-media-manifest") {
      options.requireCompleteMedia = false;
      options.heroManifestPath = null;
    } else if (arg === "--no-structured-attributes") {
      options.requireStructuredAttributes = false;
      options.donorManifestPath = null;
      options.ptdProofPath = null;
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--execution-selection=")) {
      options.executionSelectionPath = arg
        .slice("--execution-selection=".length)
        .trim();
    } else if (arg.startsWith("--ledger=")) {
      options.ledgerPath = arg.slice("--ledger=".length).trim();
    } else if (arg.startsWith("--manifest=")) {
      options.manifestPath = arg.slice("--manifest=".length).trim();
    } else if (arg.startsWith("--launch-pricing-manifest=")) {
      options.launchPricingManifestPath = arg
        .slice("--launch-pricing-manifest=".length)
        .trim();
    } else if (arg.startsWith("--launch-execution-authorization=")) {
      options.launchExecutionAuthorizationPath = arg
        .slice("--launch-execution-authorization=".length)
        .trim();
    } else if (arg.startsWith("--media-manifest=")) {
      options.heroManifestPath = arg.slice("--media-manifest=".length).trim();
      options.requireCompleteMedia = true;
    } else if (arg.startsWith("--gallery-manifest=")) {
      options.galleryManifestPath = arg.slice("--gallery-manifest=".length).trim();
    } else if (arg.startsWith("--donor-manifest=")) {
      options.donorManifestPath = arg.slice("--donor-manifest=".length).trim();
      options.requireStructuredAttributes = true;
    } else if (arg.startsWith("--ptd-proof=")) {
      options.ptdProofPath = arg.slice("--ptd-proof=".length).trim();
      options.requireStructuredAttributes = true;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--checkpoint-dir=")) {
      options.checkpointDir = arg.slice("--checkpoint-dir=".length).trim();
    } else if (arg.startsWith("--rollback-plan=")) {
      options.rollbackPlanPath = arg.slice("--rollback-plan=".length).trim();
    } else if (arg.startsWith("--rollback-snapshot-max-age-min=")) {
      options.rollbackSnapshotMaxAgeMinutes = positiveInt(
        "--rollback-snapshot-max-age-min",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--confirm=")) {
      options.confirmation = arg.slice("--confirm=".length).trim();
    } else if (arg.startsWith("--skus=")) {
      const values = arg
        .slice("--skus=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length === 0) throw new Error("--skus cannot be empty.");
      options.skus = [...new Set(values)];
    } else if (arg.startsWith("--limit=")) {
      options.limit = positiveInt("--limit", arg.split("=", 2)[1]);
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
    } else if (arg.startsWith("--offer-settlement-horizon-hours=")) {
      options.offerSettlementHorizonHours = positiveInt(
        "--offer-settlement-horizon-hours",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--offer-settlement-poll-interval-ms=")) {
      options.offerSettlementPollIntervalMs = positiveInt(
        "--offer-settlement-poll-interval-ms",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--offer-settlement-request-delay-ms=")) {
      options.offerSettlementRequestDelayMs = positiveInt(
        "--offer-settlement-request-delay-ms",
        arg.split("=", 2)[1],
      );
    } else if (
      arg.startsWith("--offer-settlement-observation-timeout-ms=")
    ) {
      options.offerSettlementObservationTimeoutMs = positiveInt(
        "--offer-settlement-observation-timeout-ms",
        arg.split("=", 2)[1],
      );
    } else if (
      arg.startsWith("--offer-settlement-max-reads-per-submission=")
    ) {
      options.offerSettlementMaxReadsPerSubmission = positiveInt(
        "--offer-settlement-max-reads-per-submission",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--pending-recovery-horizon-hours=")) {
      options.pendingRecoveryHorizonHours = positiveInt(
        "--pending-recovery-horizon-hours",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--pending-recovery-poll-interval-ms=")) {
      options.pendingRecoveryPollIntervalMs = positiveInt(
        "--pending-recovery-poll-interval-ms",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--pending-recovery-request-delay-ms=")) {
      options.pendingRecoveryRequestDelayMs = positiveInt(
        "--pending-recovery-request-delay-ms",
        arg.split("=", 2)[1],
      );
    } else if (
      arg.startsWith("--pending-recovery-observation-timeout-ms=")
    ) {
      options.pendingRecoveryObservationTimeoutMs = positiveInt(
        "--pending-recovery-observation-timeout-ms",
        arg.split("=", 2)[1],
      );
    } else if (
      arg.startsWith("--pending-recovery-max-reads-per-submission=")
    ) {
      options.pendingRecoveryMaxReadsPerSubmission = positiveInt(
        "--pending-recovery-max-reads-per-submission",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--max-errors=")) {
      options.maxErrors = positiveInt("--max-errors", arg.split("=", 2)[1]);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (options.planPath && options.ledgerPath) {
    throw new Error("Use either --plan or --ledger, not both.");
  }
  if (options.planPath && options.launchPricingManifestPath) {
    throw new Error(
      "--launch-pricing-manifest is a plan-build input and cannot accompany --plan.",
    );
  }
  if (
    options.launchExecutionAuthorizationPath &&
    (!options.planPath || !options.apply || !options.submitOnly)
  ) {
    throw new Error(
      "--launch-execution-authorization is accepted only with --plan --apply --submit-only.",
    );
  }
  if (options.executionSelectionPath && !options.planPath) {
    throw new Error("--execution-selection requires an existing --plan file.");
  }
  if (
    options.executionSelectionPath &&
    (options.skus !== null || options.limit !== null)
  ) {
    throw new Error(
      "--execution-selection is already an exact sealed action set; --skus and --limit are forbidden.",
    );
  }
  if (options.apply && !options.planPath) {
    throw new Error(
      "--apply requires an already-reviewed --plan file; build and apply cannot happen in one invocation.",
    );
  }
  if (options.preview && !options.planPath) {
    throw new Error("--preview requires an already-reviewed --plan file.");
  }
  if (options.apply && options.preview) {
    throw new Error("--apply and --preview are mutually exclusive.");
  }
  if (
    Number(options.submitOnly) +
      Number(options.settleOnly) +
      Number(options.recoverPendingOnly) >
    1
  ) {
    throw new Error(
      "--submit-only, --settle-only, and --recover-pending-only are mutually exclusive.",
    );
  }
  if (options.submitOnly && !options.apply) {
    throw new Error("--submit-only requires --apply.");
  }
  if (options.settleOnly && (options.apply || options.preview)) {
    throw new Error("--settle-only forbids --apply and --preview.");
  }
  if (options.recoverPendingOnly && (options.apply || options.preview)) {
    throw new Error(
      "--recover-pending-only forbids --apply and --preview.",
    );
  }
  if (
    (options.submitOnly || options.settleOnly || options.recoverPendingOnly) &&
    (!options.planPath || !options.executionSelectionPath)
  ) {
    throw new Error(
      "Two-phase/recovery execution requires --plan and --execution-selection.",
    );
  }
  if (options.settleOnly && options.rollbackPlanPath) {
    throw new Error("--settle-only is read-only and forbids --rollback-plan.");
  }
  if (
    options.recoverPendingOnly &&
    (options.rollbackPlanPath || options.confirmation)
  ) {
    throw new Error(
      "--recover-pending-only is read-only and forbids --rollback-plan/--confirm.",
    );
  }
  if (options.apply && !options.confirmation) {
    throw new Error("--apply requires --confirm=TOKEN.");
  }
  if (options.apply && !options.rollbackPlanPath) {
    throw new Error(
      "--apply requires --rollback-plan=PATH built from a fresh exact 164-row LIVE_SP_API snapshot.",
    );
  }
  if (
    (options.apply || options.settleOnly || options.recoverPendingOnly) &&
    path.resolve(options.checkpointDir) !== path.resolve(DEFAULT_CHECKPOINT_DIR)
  ) {
    throw new Error(
      `Live apply/settle requires canonical --checkpoint-dir=${DEFAULT_CHECKPOINT_DIR} so rollback cannot miss armed/submitted forward mutations.`,
    );
  }
  if (options.rollbackSnapshotMaxAgeMinutes > 24 * 60) {
    throw new Error("--rollback-snapshot-max-age-min must be <=1440.");
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
  if (
    options.offerSettlementHorizonHours < 1 ||
    options.offerSettlementHorizonHours > 72
  ) {
    throw new Error("--offer-settlement-horizon-hours must be 1-72.");
  }
  if (options.offerSettlementPollIntervalMs < 5_000) {
    throw new Error("--offer-settlement-poll-interval-ms must be >=5000.");
  }
  if (options.offerSettlementRequestDelayMs < 200) {
    throw new Error("--offer-settlement-request-delay-ms must be >=200.");
  }
  if (options.offerSettlementObservationTimeoutMs < 1_000) {
    throw new Error(
      "--offer-settlement-observation-timeout-ms must be >=1000.",
    );
  }
  if (
    options.offerSettlementMaxReadsPerSubmission != null &&
    options.offerSettlementMaxReadsPerSubmission < 3
  ) {
    throw new Error(
      "--offer-settlement-max-reads-per-submission must be >=3.",
    );
  }
  if (
    options.offerSettlementMaxReadsPerSubmission != null &&
    !options.settleOnly
  ) {
    throw new Error(
      "--offer-settlement-max-reads-per-submission requires --settle-only.",
    );
  }
  if (
    options.pendingRecoveryHorizonHours < 1 ||
    options.pendingRecoveryHorizonHours > 72
  ) {
    throw new Error("--pending-recovery-horizon-hours must be 1-72.");
  }
  if (options.pendingRecoveryPollIntervalMs < 5_000) {
    throw new Error("--pending-recovery-poll-interval-ms must be >=5000.");
  }
  if (options.pendingRecoveryRequestDelayMs < 200) {
    throw new Error("--pending-recovery-request-delay-ms must be >=200.");
  }
  if (options.pendingRecoveryObservationTimeoutMs < 1_000) {
    throw new Error(
      "--pending-recovery-observation-timeout-ms must be >=1000.",
    );
  }
  if (
    options.pendingRecoveryMaxReadsPerSubmission != null &&
    options.pendingRecoveryMaxReadsPerSubmission < 3
  ) {
    throw new Error(
      "--pending-recovery-max-reads-per-submission must be >=3.",
    );
  }
  if (
    options.pendingRecoveryMaxReadsPerSubmission != null &&
    !options.recoverPendingOnly
  ) {
    throw new Error(
      "--pending-recovery-max-reads-per-submission requires --recover-pending-only.",
    );
  }
  if (options.recoverPendingOnly && options.settlementStableReads !== 3) {
    throw new Error(
      "--recover-pending-only requires --settlement-stable-reads=3.",
    );
  }
  return options;
}

async function latestLedger(): Promise<string> {
  const names = (await readdir(DEFAULT_AUDIT_DIR))
    .filter((name) => /^uncrustables-ledger-.*\.json$/.test(name));
  const candidates = await Promise.all(
    names.map(async (name) => {
      const file = path.join(DEFAULT_AUDIT_DIR, name);
      return { file, mtime: (await stat(file)).mtimeMs };
    }),
  );
  candidates.sort((left, right) => right.mtime - left.mtime);
  for (const candidate of candidates) {
    const parsed = JSON.parse(await readFile(candidate.file, "utf8")) as {
      complete?: unknown;
      immutable?: unknown;
      mode?: unknown;
      source_snapshot?: { mode?: unknown };
    };
    if (
      parsed.complete === true &&
      parsed.immutable === true &&
      (parsed.mode === "live" ||
        (parsed.mode === "offline-resummarize" &&
          parsed.source_snapshot?.mode === "live"))
    ) {
      return candidate.file;
    }
  }
  throw new Error(`No complete immutable live ledger found under ${DEFAULT_AUDIT_DIR}.`);
}

async function latestCompleteHeroManifest(): Promise<string> {
  const names = (await readdir(DEFAULT_AUDIT_DIR))
    .filter((name) => /^UHG-.*-manifest\.json$/.test(name));
  const candidates = await Promise.all(
    names.map(async (name) => {
      const file = path.join(DEFAULT_AUDIT_DIR, name);
      return { file, mtime: (await stat(file)).mtimeMs };
    }),
  );
  candidates.sort((left, right) => right.mtime - left.mtime);
  for (const candidate of candidates) {
    const parsed = JSON.parse(await readFile(candidate.file, "utf8")) as {
      immutable?: unknown;
      summary?: { target?: unknown; succeeded?: unknown; failed?: unknown };
    };
    if (
      parsed.immutable === true &&
      parsed.summary?.target === 164 &&
      parsed.summary?.succeeded === 164 &&
      parsed.summary?.failed === 0
    ) {
      return candidate.file;
    }
  }
  throw new Error(
    "No complete 164-row QA-verified hero manifest found. Pass --media-manifest=PATH after asset generation, or --no-media-manifest only for non-final diagnostics.",
  );
}

async function latestCompleteGalleryManifest(): Promise<string | null> {
  const names = (await readdir(DEFAULT_AUDIT_DIR))
    .filter((name) => /^uncrustables-product-gallery-.*\.json$/.test(name));
  const candidates = await Promise.all(
    names.map(async (name) => {
      const file = path.join(DEFAULT_AUDIT_DIR, name);
      return { file, mtime: (await stat(file)).mtimeMs };
    }),
  );
  candidates.sort((left, right) => right.mtime - left.mtime);
  for (const candidate of candidates) {
    const parsed = JSON.parse(await readFile(candidate.file, "utf8")) as {
      immutable?: unknown;
      summary?: { target?: unknown; passed?: unknown; failed?: unknown };
    };
    if (
      parsed.immutable === true &&
      parsed.summary?.target === 164 &&
      parsed.summary?.passed === 164 &&
      parsed.summary?.failed === 0
    ) return candidate.file;
  }
  return null;
}

class LiveGateway implements RepairAmazonGateway {
  readonly physicalMutationGuardContract =
    "CALL_IMMEDIATELY_BEFORE_REQUEST_V1" as const;
  private readonly sellerIds = new Map<number, string>();
  private readonly lastListings = new Map<
    string,
    Awaited<ReturnType<typeof getListing>>
  >();

  constructor(
    private readonly rollbackPlan: UncrustablesRollbackPlan | null = null,
    forbiddenPatchPaths: string[] = [],
  ) {
    this.forbiddenPatchPaths = new Set(forbiddenPatchPaths);
  }

  private readonly forbiddenPatchPaths: Set<string>;

  private assertNoForbiddenPatches(
    sku: string,
    patches: ListingPatch[],
    context: string,
  ): void {
    const forbidden = patches
      .map((patch) => patch.path)
      .filter((patchPath) => this.forbiddenPatchPaths.has(patchPath));
    if (forbidden.length > 0) {
      throw new Error(
        `${context} for ${sku} contains selection-forbidden exact patch path(s): ${[
          ...new Set(forbidden),
        ].join(", ")}. No Amazon PATCH was made.`,
      );
    }
  }

  private listingKey(storeIndex: number, sku: string): string {
    return `${storeIndex}:${sku}`;
  }

  private async sellerId(
    storeIndex: number,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    let sellerId = this.sellerIds.get(storeIndex);
    if (!sellerId) {
      sellerId = await getMerchantToken(storeIndex, signal);
      signal?.throwIfAborted();
      this.sellerIds.set(storeIndex, sellerId);
    }
    return sellerId;
  }

  async getListing(storeIndex: number, sku: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const sellerId = await this.sellerId(storeIndex, signal);
    signal?.throwIfAborted();
    const listing = await getListing(
      storeIndex,
      sellerId,
      sku,
      {
        includedData: [
          "summaries",
          "attributes",
          "issues",
          "offers",
          "fulfillmentAvailability",
        ],
        signal,
      },
    );
    this.lastListings.set(this.listingKey(storeIndex, sku), listing);
    return listing;
  }

  async patchListing(
    storeIndex: number,
    sku: string,
    productType: string,
    patches: ListingPatch[],
    validationPreview: boolean,
    previewContext?: RepairValidationPreviewContext,
    beforeMutatingRequest?: Parameters<
      RepairAmazonGateway["patchListing"]
    >[6],
  ) {
    this.assertNoForbiddenPatches(
      sku,
      patches,
      validationPreview ? "VALIDATION_PREVIEW" : "Mutating PATCH",
    );
    if (previewContext) {
      this.assertNoForbiddenPatches(
        sku,
        previewContext.actual_patches,
        "Sealed actual patch behind VALIDATION_PREVIEW",
      );
    }
    if (!validationPreview && previewContext) {
      throw new Error(
        `Preview-surrogate context is forbidden on a mutating PATCH for ${sku}.`,
      );
    }
    const hasOfferSelectorReplace = patches.some(
      (patch) =>
        patch.op === "replace" &&
        patch.path === "/attributes/purchasable_offer",
    );
    if (validationPreview && hasOfferSelectorReplace && !previewContext) {
      throw new Error(
        `Offer selector-replace preview for ${sku} has no sealed actual merge context.`,
      );
    }
    if (previewContext) {
      assertValidationPreviewSurrogateMatches({
        actualPatches: previewContext.actual_patches,
        previewPatches: patches,
        context: previewContext.offer_merge_context,
      });
    }
    const mutatingController = validationPreview ? null : new AbortController();
    const mutatingTimeout = mutatingController
      ? setTimeout(() => {
          mutatingController.abort(
            new DOMException(
              `Surgical mutating PATCH timed out after ${SURGICAL_MUTATING_PATCH_TIMEOUT_MS}ms.`,
              "AbortError",
            ),
          );
        }, SURGICAL_MUTATING_PATCH_TIMEOUT_MS)
      : null;
    try {
      if (this.rollbackPlan) {
        // VALIDATION_PREVIEW is not an optimistic lock. Close the avoidable
        // preview-to-write window with one final GET immediately before every
        // mutating PATCH, then re-run the sealed path-level CAS against it.
        // For a real submission, the same deadline covers this final GET,
        // cold seller lookup, and the one physical PATCH attempt.
        const live = validationPreview
          ? this.lastListings.get(this.listingKey(storeIndex, sku))
          : await this.getListing(storeIndex, sku, mutatingController?.signal);
        if (!live) {
          throw new Error(
            `Forward rollback guard has no fresh GET for ${sku}; refusing PATCH.`,
          );
        }
        assertForwardPatchRollbackCovered({
          rollbackPlan: this.rollbackPlan,
          storeIndex,
          sku,
          live,
          // Rollback/CAS coverage is intentionally bound to the actual merge,
          // never to the non-mutating selector-replace preview surrogate.
          patches: previewContext?.actual_patches ?? patches,
        });
      }
      const sellerId = await this.sellerId(
        storeIndex,
        mutatingController?.signal,
      );
      if (validationPreview && beforeMutatingRequest) {
        throw new Error(
          `A physical mutation guard is invalid for VALIDATION_PREVIEW on ${sku}.`,
        );
      }
      return await patchListing(
        storeIndex,
        sellerId,
        sku,
        productType,
        patches,
        {
          validationPreview,
          // A mutating Listings PATCH is physically attempted once. If its
          // response is lost, the preceding SUBMISSION_ARMED event and pending
          // fence force GET-only recovery instead of a transport-level replay.
          retries: validationPreview ? undefined : 1,
          signal: mutatingController?.signal,
          beforeRequest:
            !validationPreview && beforeMutatingRequest
              ? () =>
                  beforeMutatingRequest({
                    store_index: storeIndex,
                    marketplace_id: MARKETPLACE_ID,
                    amazon_merchant_id: sellerId,
                  })
              : undefined,
        },
      ) as Record<string, unknown>;
    } finally {
      if (mutatingTimeout != null) clearTimeout(mutatingTimeout);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let plan;
  let planPath = options.planPath;

  if (planPath) {
    plan = await readRepairPlan(planPath);
  } else {
    const ledgerPath = options.ledgerPath ?? await latestLedger();
    const ledgerBytes = await readFile(ledgerPath);
    let manifest: DesiredRepairManifest | null = null;
    let manifestSource: { path: string; bytes: Buffer } | null = null;
    if (options.manifestPath) {
      const manifestBytes = await readFile(options.manifestPath);
      manifest = JSON.parse(manifestBytes.toString("utf8")) as DesiredRepairManifest;
      manifestSource = { path: options.manifestPath, bytes: manifestBytes };
    }
    const launchPricingManifest = options.launchPricingManifestPath
      ? {
          path: options.launchPricingManifestPath,
          bytes: await readFile(options.launchPricingManifestPath),
        }
      : null;
    const heroManifestPath = options.requireCompleteMedia
      ? options.heroManifestPath ?? await latestCompleteHeroManifest()
      : null;
    const galleryManifestPath = heroManifestPath
      ? options.galleryManifestPath ?? await latestCompleteGalleryManifest()
      : null;
    const donorManifestPath = options.requireStructuredAttributes
      ? options.donorManifestPath
      : null;
    const ptdProofPath = options.requireStructuredAttributes
      ? options.ptdProofPath
      : null;
    if (options.requireStructuredAttributes && (!donorManifestPath || !ptdProofPath)) {
      throw new Error(
        "Final planning requires both --donor-manifest and --ptd-proof.",
      );
    }
    plan = buildRepairPlan({
      ledgerPath,
      ledgerBytes,
      manifest,
      manifestSource,
      launchPricingManifest,
      heroManifest: heroManifestPath
        ? { path: heroManifestPath, bytes: await readFile(heroManifestPath) }
        : null,
      galleryManifest: galleryManifestPath
        ? { path: galleryManifestPath, bytes: await readFile(galleryManifestPath) }
        : null,
      donorManifest: donorManifestPath
        ? { path: donorManifestPath, bytes: await readFile(donorManifestPath) }
        : null,
      ptdProof: ptdProofPath
        ? { path: ptdProofPath, bytes: await readFile(ptdProofPath) }
        : null,
      skus: options.skus,
      limit: options.limit,
    });
    planPath = await writeImmutablePlan(options.outputDir, plan);
    console.log(`Immutable repair plan: ${planPath}`);
    if (plan.launch_pricing_source) {
      console.log(
        "ChannelMAX bounds-only TSV intentionally not generated for a launch-aware plan; use a separately verified Manual-model assignment artifact.",
      );
    } else {
      const channelMax = await writeImmutableChannelMaxArtifact(
        options.outputDir,
        plan,
      );
      console.log(`ChannelMAX TSV (not uploaded): ${channelMax.tsvPath}`);
      console.log(`ChannelMAX manifest: ${channelMax.manifestPath}`);
    }
  }

  const executionSelection: RepairExecutionSelection | null =
    options.executionSelectionPath
      ? await readRepairExecutionSelection(options.executionSelectionPath, plan)
      : null;
  const selectedActionIds = executionSelection
    ? new Set(executionSelection.selected_action_ids)
    : null;
  let selectedEntries = plan.entries.filter(
    (entry) => !options.skus || options.skus.includes(entry.sku),
  );
  if (!executionSelection && options.limit != null) {
    selectedEntries = selectedEntries.slice(0, options.limit);
  }
  const selectedHasOffer = selectedEntries.some((entry) =>
    entry.actions.some(
      (action) =>
        action.kind === "OFFER" &&
        (!selectedActionIds || selectedActionIds.has(action.action_id)),
    ),
  );
  if (
    selectedHasOffer &&
    !plan.launch_pricing_source &&
    (options.apply || options.preview || options.submitOnly)
  ) {
    throw new Error(
      "Legacy OFFER mutation/preview is disabled: the sealed plan has no pinned Coupon-vs-Sale-Price launch source. Build a new launch-aware plan. No Amazon call was made.",
    );
  }
  if (
    options.apply &&
    selectedHasOffer &&
    (!options.submitOnly ||
      executionSelection?.profile !== OFFER_ONLY_EXECUTION_PROFILE)
  ) {
    throw new Error(
      `Every live OFFER write requires --submit-only and an exact ${OFFER_ONLY_EXECUTION_PROFILE} selection. Mixed or inline submit-and-settle execution is disabled. No Amazon call was made.`,
    );
  }
  if (
    options.recoverPendingOnly &&
    executionSelection?.source_plan.path != null &&
    path.resolve(executionSelection.source_plan.path) !== path.resolve(planPath)
  ) {
    throw new Error(
      "--recover-pending-only plan path does not match the exact source_plan.path sealed in its execution selection. No Amazon call was made.",
    );
  }
  const executionPhase: OfferExecutionPhase = options.submitOnly
    ? "SUBMIT_ONLY"
    : options.settleOnly
      ? "SETTLE_ONLY"
      : "SUBMIT_AND_SETTLE";
  if (
    (options.submitOnly || options.settleOnly) &&
    executionSelection?.profile !== OFFER_ONLY_EXECUTION_PROFILE
  ) {
    throw new Error(
      `OFFER ${executionPhase} requires an ${OFFER_ONLY_EXECUTION_PROFILE} selection. No Amazon call was made.`,
    );
  }
  const requiredConfirmation = executionSelection?.confirmation_token ??
    confirmationToken(plan);
  if (
    options.apply &&
    selectedHasOffer &&
    !options.launchExecutionAuthorizationPath
  ) {
    throw new Error(
      "Live OFFER apply requires --launch-execution-authorization with current ChannelMAX Manual and Arm A Coupon evidence. No Amazon call was made.",
    );
  }

  console.log(
    JSON.stringify(
      {
        mode: options.recoverPendingOnly
          ? "PENDING_SETTLE_ONLY"
          : options.submitOnly
          ? "OFFER_SUBMIT_ONLY"
          : options.settleOnly
            ? "OFFER_SETTLE_ONLY"
            : options.apply
              ? "APPLY"
              : options.preview
                ? "VALIDATION_PREVIEW"
                : "DRY_RUN_OFFLINE",
        execution_phase: executionPhase,
        plan_id: plan.plan_id,
        plan_sha256: plan.sha256,
        entries: plan.scope.entries,
        actions: plan.scope.actions,
        blockers: plan.scope.blocked,
        semantic_audit: plan.semantic_audit,
        selected_skus: options.skus,
        limit: options.limit,
        execution_selection: options.executionSelectionPath,
        execution_selection_sha256: executionSelection?.sha256 ?? null,
        execution_profile: executionSelection?.profile ?? null,
        execution_selection_actions:
          executionSelection?.selected_actions ?? null,
        forbidden_patch_paths:
          executionSelection?.forbidden_patch_paths ?? [],
        rollback_plan: options.rollbackPlanPath,
        required_confirmation: options.apply ? requiredConfirmation : null,
      },
      null,
      2,
    ),
  );

  const checkpointStore = new ImmutableCheckpointStore(
    options.checkpointDir,
    plan.sha256,
  );
  if (
    !options.apply &&
    !options.preview &&
    !options.settleOnly &&
    !options.recoverPendingOnly
  ) {
    const dry = await executeRepairPlan(plan, {} as RepairAmazonGateway, {
      apply: false,
      executionPhase,
      checkpointStore,
      skus: options.planPath ? options.skus : null,
      limit: options.planPath ? options.limit : null,
      executionSelection,
    });
    console.log(JSON.stringify(dry, null, 2));
    console.log("No Amazon call, database call, upload, or marketplace mutation was made.");
    return;
  }

  let forwardRollbackPlan: UncrustablesRollbackPlan | null = null;
  if (options.apply) {
    const expectedApplyToken = requiredConfirmation;
    if (
      process.env.BF_UNCRUSTABLES_ENABLE_AMAZON_APPLY !== expectedApplyToken
    ) {
      throw new Error(
        `Live apply requires BF_UNCRUSTABLES_ENABLE_AMAZON_APPLY=${expectedApplyToken}. No Amazon call was made.`,
      );
    }
    if (!options.rollbackPlanPath) {
      // parseArgs already enforces this; retain the local invariant so future
      // argument refactors cannot accidentally bypass the safety set.
      throw new Error("Live apply has no rollback plan. No Amazon call was made.");
    }
    const rollbackPlan = await readRollbackPlan(options.rollbackPlanPath);
    forwardRollbackPlan = rollbackPlan;
    const preChangeSnapshot = await readPreChangeSnapshot(
      rollbackPlan.source_snapshot.path,
    );
    assertForwardApplyRollbackCoverage({
      repairPlan: plan,
      snapshot: preChangeSnapshot,
      rollbackPlan,
      selectedSkus: executionSelection ? null : options.skus,
      limit: executionSelection ? null : options.limit,
      executionSelection,
      executionSelectionPath: options.executionSelectionPath,
      maxSnapshotAgeMinutes: options.rollbackSnapshotMaxAgeMinutes,
    });
    await assertRollbackMediaEvidenceFiles({
      snapshot: preChangeSnapshot,
      rollbackPlan,
    });
    const rollbackLedgerBytes = await readFile(
      preChangeSnapshot.source_ledger.path,
    );
    const rollbackOverridesBytes = await readFile(
      preChangeSnapshot.reviewed_overrides.path,
    );
    if (
      sha256(rollbackLedgerBytes) !== preChangeSnapshot.source_ledger.sha256 ||
      sha256(rollbackOverridesBytes) !==
        preChangeSnapshot.reviewed_overrides.sha256
    ) {
      throw new Error(
        "Rollback snapshot source ledger/overrides no longer match their sealed bytes. No Amazon call was made.",
      );
    }
  }

  // Re-prove the plan's source ledger before the first credential/API call.
  const sourceBytes = await readFile(plan.source_ledger.path);
  if (sha256(sourceBytes) !== plan.source_ledger.sha256) {
    throw new Error("Source ledger no longer matches the SHA-256 sealed in the plan.");
  }
  if (plan.desired_manifest_source) {
    const manifestBytes = await readFile(plan.desired_manifest_source.path);
    if (sha256(manifestBytes) !== plan.desired_manifest_source.sha256) {
      throw new Error(
        "Desired-state manifest no longer matches the SHA-256 sealed in the plan.",
      );
    }
  }
  let launchExecutionAuthorization:
    | LaunchExecutionAuthorizationRuntimeInput
    | undefined;
  if (plan.launch_pricing_source) {
    const launchPricingBytes = await readFile(plan.launch_pricing_source.path);
    if (sha256(launchPricingBytes) !== plan.launch_pricing_source.sha256) {
      throw new Error(
        "Launch-pricing manifest no longer matches the SHA-256 sealed in the plan.",
      );
    }
    assertRepairPlanLaunchPricingBinding(plan, launchPricingBytes, {
      requireOwnerApproval: options.apply && selectedHasOffer,
    });
    if (options.apply && selectedHasOffer) {
      if (!options.launchExecutionAuthorizationPath || !executionSelection) {
        throw new Error(
          "Launch execution authorization and exact OFFER selection are required. No Amazon call was made.",
        );
      }
      let authorizationRaw: unknown;
      try {
        authorizationRaw = JSON.parse(
          (
            await readFile(options.launchExecutionAuthorizationPath)
          ).toString("utf8"),
        );
      } catch {
        throw new Error(
          "Launch execution authorization is missing or invalid JSON. No Amazon call was made.",
        );
      }
      const launchPricingManifest = verifyUncrustablesLaunchPricingManifest(
        JSON.parse(launchPricingBytes.toString("utf8")),
      );
      const authorization = verifyUncrustablesLaunchExecutionAuthorization(
        authorizationRaw,
        {
          planSha256: plan.sha256,
          executionSelectionSha256: executionSelection.sha256,
          launchPricingSourceSha256: plan.launch_pricing_source.sha256,
          launchPricingManifest,
        },
      );
      const channelMaxSourceExportBytes = await readFile(
        authorization.channelmax.source_export.path,
      );
      const channelMaxAssignmentUploadBytes = await readFile(
        authorization.channelmax.assignment_upload.path,
      );
      const couponSourceEvidenceBytes = await readFile(
        authorization.coupons.source_evidence.path,
      );
      const evidenceArtifacts = [
        [
          authorization.channelmax.source_export,
          channelMaxSourceExportBytes,
        ],
        [
          authorization.channelmax.assignment_upload,
          channelMaxAssignmentUploadBytes,
        ],
        [authorization.coupons.source_evidence, couponSourceEvidenceBytes],
      ] as const;
      for (const [evidence, evidenceBytes] of evidenceArtifacts) {
        if (sha256(evidenceBytes) !== evidence.sha256) {
          throw new Error(
            `Launch execution evidence no longer matches its sealed SHA-256: ${evidence.path}. No Amazon call was made.`,
          );
        }
      }
      launchExecutionAuthorization = {
        authorization,
        launchPricingManifest,
        launchPricingSourceSha256: plan.launch_pricing_source.sha256,
        launchPricingSourceBytes: launchPricingBytes,
        evidence_bytes: {
          channelmax_source_export: channelMaxSourceExportBytes,
          channelmax_assignment_upload: channelMaxAssignmentUploadBytes,
          coupon_source_evidence: couponSourceEvidenceBytes,
        },
      };
    }
  }
  if (plan.media_asset_source) {
    const mediaBytes = await readFile(plan.media_asset_source.path);
    if (sha256(mediaBytes) !== plan.media_asset_source.sha256) {
      throw new Error("Hero asset manifest no longer matches the SHA-256 sealed in the plan.");
    }
    if (plan.media_asset_source.gallery_manifest) {
      const galleryBytes = await readFile(plan.media_asset_source.gallery_manifest.path);
      if (sha256(galleryBytes) !== plan.media_asset_source.gallery_manifest.sha256) {
        throw new Error("Gallery manifest no longer matches the SHA-256 sealed in the plan.");
      }
    }
  }
  if (plan.structured_attribute_source) {
    const donorBytes = await readFile(
      plan.structured_attribute_source.donor_manifest.path,
    );
    if (
      sha256(donorBytes) !==
      plan.structured_attribute_source.donor_manifest.sha256
    ) {
      throw new Error(
        "Donor manifest no longer matches the SHA-256 sealed in the plan.",
      );
    }
    const ptdBytes = await readFile(
      plan.structured_attribute_source.ptd_proof.path,
    );
    if (sha256(ptdBytes) !== plan.structured_attribute_source.ptd_proof.sha256) {
      throw new Error(
        "PTD attribute proof no longer matches the SHA-256 sealed in the plan.",
      );
    }
  }
  const liveGateway = new LiveGateway(
    forwardRollbackPlan,
    executionSelection?.forbidden_patch_paths ?? [],
  );
  const gateway: RepairAmazonGateway = options.recoverPendingOnly
    ? {
        getListing: (storeIndex, sku, signal) =>
          liveGateway.getListing(storeIndex, sku, signal),
        patchListing: (_storeIndex, sku) => {
          throw new Error(
            `CLI PENDING_SETTLE_ONLY trap forbids every PATCH for ${sku}.`,
          );
        },
      }
    : liveGateway;
  const result = await executeRepairPlan(
    plan,
    gateway,
    {
      apply: options.apply,
      executionPhase,
      recoverPendingOnly: options.recoverPendingOnly,
      validationOnly: options.preview,
      confirmation: options.confirmation,
      checkpointStore,
      mediaEquivalence: new PerceptualMediaEquivalence(),
      skus: options.skus,
      limit: options.limit,
      executionSelection,
      launchExecutionAuthorization,
      requestDelayMs: options.requestDelayMs,
      verifyAttempts: options.verifyAttempts,
      verifyDelayMs: options.verifyDelayMs,
      settlementAttempts: options.settlementAttempts,
      settlementDelayMs: options.settlementDelayMs,
      settlementStableReads: options.settlementStableReads,
      offerSettlementPolicy: options.settleOnly
        ? {
            horizonMs: options.offerSettlementHorizonHours * 60 * 60_000,
            pollIntervalMs: options.offerSettlementPollIntervalMs,
            requestDelayMs: options.offerSettlementRequestDelayMs,
            observationTimeoutMs:
              options.offerSettlementObservationTimeoutMs,
            maxReadsPerSubmission:
              options.offerSettlementMaxReadsPerSubmission,
            stableReads: options.settlementStableReads,
          }
        : undefined,
      pendingRecoveryPolicy: options.recoverPendingOnly
        ? {
            horizonMs: options.pendingRecoveryHorizonHours * 60 * 60_000,
            pollIntervalMs: options.pendingRecoveryPollIntervalMs,
            requestDelayMs: options.pendingRecoveryRequestDelayMs,
            observationTimeoutMs:
              options.pendingRecoveryObservationTimeoutMs,
            maxReadsPerSubmission:
              options.pendingRecoveryMaxReadsPerSubmission,
            stableReads: 3,
          }
        : undefined,
      maxErrors: options.maxErrors,
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.failed_actions > 0 || result.stopped_early) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
