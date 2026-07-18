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

import {
  getListing,
  patchListing,
  type ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { PerceptualMediaEquivalence } from "@/lib/bundle-factory/repair/media-equivalence";
import {
  assertRollbackMediaEvidenceFiles,
  assertForwardApplyRollbackCoverage,
  assertForwardPatchRollbackCovered,
  readPreChangeSnapshot,
  readRollbackPlan,
  type UncrustablesRollbackPlan,
} from "@/lib/bundle-factory/repair/uncrustables-amazon-rollback";
import {
  ImmutableCheckpointStore,
  assertValidationPreviewSurrogateMatches,
  buildRepairPlan,
  confirmationToken,
  executeRepairPlan,
  readRepairPlan,
  sha256,
  writeImmutableChannelMaxArtifact,
  writeImmutablePlan,
  type DesiredRepairManifest,
  type RepairAmazonGateway,
  type RepairValidationPreviewContext,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_AUDIT_DIR = "data/audits";
const DEFAULT_OUTPUT_DIR = "data/repairs/generated";
const DEFAULT_CHECKPOINT_DIR = "data/repairs/checkpoints";
const DEFAULT_MANIFEST = "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const DEFAULT_DONOR_MANIFEST =
  "data/repairs/uncrustables-donor-enrichment-20260717.json";
const DEFAULT_PTD_PROOF =
  "data/audits/amazon-food-ptd-attribute-proof-20260718T010205Z.json";

interface CliOptions {
  planPath: string | null;
  ledgerPath: string | null;
  manifestPath: string | null;
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
  confirmation: string | null;
  skus: string[] | null;
  limit: number | null;
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
    "Usage: npx tsx scripts/repair-uncrustables-surgical.ts [options]",
    "",
    "Offline planning (default; zero Amazon/DB calls):",
    "  --ledger=PATH          Immutable live ledger or its sealed resummary.",
    `  --manifest=PATH        Reviewed overrides (default ${DEFAULT_MANIFEST}).`,
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
    "  --preview              Live GET + VALIDATION_PREVIEW only; no real PATCH.",
    "  --apply                Enable Amazon calls; requires --plan and --confirm.",
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
    ledgerPath: null,
    manifestPath: DEFAULT_MANIFEST,
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
    confirmation: null,
    skus: null,
    limit: null,
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
    } else if (arg.startsWith("--ledger=")) {
      options.ledgerPath = arg.slice("--ledger=".length).trim();
    } else if (arg.startsWith("--manifest=")) {
      options.manifestPath = arg.slice("--manifest=".length).trim();
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
    } else if (arg.startsWith("--max-errors=")) {
      options.maxErrors = positiveInt("--max-errors", arg.split("=", 2)[1]);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (options.planPath && options.ledgerPath) {
    throw new Error("Use either --plan or --ledger, not both.");
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
  if (options.apply && !options.confirmation) {
    throw new Error("--apply requires --confirm=TOKEN.");
  }
  if (options.apply && !options.rollbackPlanPath) {
    throw new Error(
      "--apply requires --rollback-plan=PATH built from a fresh exact 164-row LIVE_SP_API snapshot.",
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
  private readonly sellerIds = new Map<number, string>();
  private readonly lastListings = new Map<
    string,
    Awaited<ReturnType<typeof getListing>>
  >();

  constructor(
    private readonly rollbackPlan: UncrustablesRollbackPlan | null = null,
  ) {}

  private listingKey(storeIndex: number, sku: string): string {
    return `${storeIndex}:${sku}`;
  }

  private async sellerId(storeIndex: number): Promise<string> {
    let sellerId = this.sellerIds.get(storeIndex);
    if (!sellerId) {
      sellerId = await getMerchantToken(storeIndex);
      this.sellerIds.set(storeIndex, sellerId);
    }
    return sellerId;
  }

  async getListing(storeIndex: number, sku: string) {
    const listing = await getListing(
      storeIndex,
      await this.sellerId(storeIndex),
      sku,
      {
        includedData: [
          "summaries",
          "attributes",
          "issues",
          "offers",
          "fulfillmentAvailability",
        ],
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
  ) {
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
    if (this.rollbackPlan) {
      // VALIDATION_PREVIEW is not an optimistic lock. Close the avoidable
      // preview-to-write window with one final GET immediately before every
      // mutating PATCH, then re-run the sealed path-level CAS against it.
      const live = validationPreview
        ? this.lastListings.get(this.listingKey(storeIndex, sku))
        : await this.getListing(storeIndex, sku);
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
    const channelMax = await writeImmutableChannelMaxArtifact(options.outputDir, plan);
    console.log(`Immutable repair plan: ${planPath}`);
    console.log(`ChannelMAX TSV (not uploaded): ${channelMax.tsvPath}`);
    console.log(`ChannelMAX manifest: ${channelMax.manifestPath}`);
  }

  console.log(
    JSON.stringify(
      {
        mode: options.apply
          ? "APPLY"
          : options.preview
            ? "VALIDATION_PREVIEW"
            : "DRY_RUN_OFFLINE",
        plan_id: plan.plan_id,
        plan_sha256: plan.sha256,
        entries: plan.scope.entries,
        actions: plan.scope.actions,
        blockers: plan.scope.blocked,
        semantic_audit: plan.semantic_audit,
        selected_skus: options.skus,
        limit: options.limit,
        rollback_plan: options.rollbackPlanPath,
        required_confirmation: confirmationToken(plan),
      },
      null,
      2,
    ),
  );

  const checkpointStore = new ImmutableCheckpointStore(
    options.checkpointDir,
    plan.sha256,
  );
  if (!options.apply && !options.preview) {
    const dry = await executeRepairPlan(plan, {} as RepairAmazonGateway, {
      apply: false,
      checkpointStore,
      skus: options.planPath ? options.skus : null,
      limit: options.planPath ? options.limit : null,
    });
    console.log(JSON.stringify(dry, null, 2));
    console.log("No Amazon call, database call, upload, or marketplace mutation was made.");
    return;
  }

  let forwardRollbackPlan: UncrustablesRollbackPlan | null = null;
  if (options.apply) {
    const expectedApplyToken = confirmationToken(plan);
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
      selectedSkus: options.skus,
      limit: options.limit,
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
  const result = await executeRepairPlan(
    plan,
    new LiveGateway(forwardRollbackPlan),
    {
      apply: options.apply,
      validationOnly: options.preview,
      confirmation: options.confirmation,
      checkpointStore,
      mediaEquivalence: new PerceptualMediaEquivalence(),
      skus: options.skus,
      limit: options.limit,
      requestDelayMs: options.requestDelayMs,
      verifyAttempts: options.verifyAttempts,
      verifyDelayMs: options.verifyDelayMs,
      settlementAttempts: options.settlementAttempts,
      settlementDelayMs: options.settlementDelayMs,
      settlementStableReads: options.settlementStableReads,
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
