/**
 * Reconcile Bundle Factory's local lifecycle state only after the 164 Amazon
 * listings have passed a fresh post-repair live audit.
 *
 * This CLI never calls Amazon. Planning is the default and performs only DB
 * reads plus an immutable local plan write. DB writes require a separately
 * reviewed plan, --apply, and that plan's unique confirmation token.
 *
 * Planning:
 *   npx tsx scripts/reconcile-uncrustables-post-live.ts \
 *     --ledger=data/audits/uncrustables-ledger-...-live.json \
 *     --repair-plan=data/repairs/generated/URP-....json \
 *     --checkpoint-dir=data/repairs/checkpoints
 *
 * Apply (DB only):
 *   npx tsx scripts/reconcile-uncrustables-post-live.ts \
 *     --plan=data/repairs/generated/UPLR-....json --apply \
 *     --confirm=RECONCILE-UNCRUSTABLES-0123456789ABCDEF
 */

import { config } from "dotenv";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_FINAL_LEDGER_MAX_AGE_MS,
  REVIEWED_SZ_STALE_UPC,
  assertDbSnapshotMatchesLedger,
  assertDbSnapshotMatchesPlan,
  assertFinalLedgerAfterRepair,
  assertPostLiveReconciliationOutcome,
  buildPostLiveReconciliationPlan,
  postLiveReconciliationConfirmation,
  postLiveSha256,
  validateCompleteCheckpoints,
  validateFinalLiveLedger,
  validateSurgicalRepairEvidence,
  verifyPostLiveReconciliationPlan,
  type BundleDraftDbRow,
  type BundleComponentDbRow,
  type ChannelSkuDbRow,
  type CheckpointArtifact,
  type FinalLiveLedgerLike,
  type GenerationJobDbRow,
  type MasterBundleDbRow,
  type PostLiveDbSnapshot,
  type PostLiveReconciliationPlan,
  type SurgicalRepairPlanLike,
  type UpcPoolDbRow,
} from "@/lib/bundle-factory/post-live-reconciliation";
import {
  verifyRepairPlan,
  type UncrustablesRepairPlan,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_OUTPUT_DIR = "data/repairs/generated";

interface Options {
  plan_path: string | null;
  ledger_path: string | null;
  repair_plan_path: string | null;
  checkpoint_dir: string | null;
  output_dir: string;
  max_ledger_age_ms: number;
  apply: boolean;
  confirmation: string | null;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/reconcile-uncrustables-post-live.ts [options]",
    "",
    "Build an immutable DB reconciliation plan (default; no DB/Amazon writes):",
    "  --ledger=PATH          Fresh immutable final live ledger (required).",
    "  --repair-plan=PATH     Sealed complete 164-SKU surgical repair plan (required).",
    "  --checkpoint-dir=PATH  Root containing the plan-hash checkpoint directory (required).",
    `  --output-dir=PATH      Plan output (default ${DEFAULT_OUTPUT_DIR}).`,
    "  --max-ledger-age-minutes=N",
    `                         Freshness limit (default ${DEFAULT_FINAL_LEDGER_MAX_AGE_MS / 60_000}).`,
    "",
    "Inspect or apply an existing reconciliation plan:",
    "  --plan=PATH            Existing immutable UPLR plan.",
    "  --apply                Enable the sealed DB-only changes.",
    "  --confirm=TOKEN        Exact plan-specific token printed by dry-run.",
    "  --help                 Show this help.",
    "",
    "This command has no Amazon client and never changes approval, compliance,",
    "validation, inventory, ASIN/other marketplace IDs, or the three true-404 rows.",
    "The sole identifier exception is SZ's SHA-guarded DB/UPCPool sync to its live UPC.",
  ].join("\n");
}

export function parsePostLiveReconciliationArgs(argv: string[]): Options {
  const options: Options = {
    plan_path: null,
    ledger_path: null,
    repair_plan_path: null,
    checkpoint_dir: null,
    output_dir: DEFAULT_OUTPUT_DIR,
    max_ledger_age_ms: DEFAULT_FINAL_LEDGER_MAX_AGE_MS,
    apply: false,
    confirmation: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg.startsWith("--plan=")) {
      options.plan_path = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--ledger=")) {
      options.ledger_path = arg.slice("--ledger=".length).trim();
    } else if (arg.startsWith("--repair-plan=")) {
      options.repair_plan_path = arg.slice("--repair-plan=".length).trim();
    } else if (arg.startsWith("--checkpoint-dir=")) {
      options.checkpoint_dir = arg.slice("--checkpoint-dir=".length).trim();
    } else if (arg.startsWith("--output-dir=")) {
      options.output_dir = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--confirm=")) {
      options.confirmation = arg.slice("--confirm=".length).trim();
    } else if (arg.startsWith("--max-ledger-age-minutes=")) {
      const minutes = Number(arg.slice("--max-ledger-age-minutes=".length));
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
        throw new Error("--max-ledger-age-minutes must be an integer from 1 to 1440.");
      }
      options.max_ledger_age_ms = minutes * 60_000;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (options.plan_path) {
    if (options.ledger_path || options.repair_plan_path || options.checkpoint_dir) {
      throw new Error("Use --plan by itself; its exact source paths are already sealed.");
    }
  } else if (
    !options.ledger_path ||
    !options.repair_plan_path ||
    !options.checkpoint_dir
  ) {
    throw new Error(
      "Planning requires --ledger, --repair-plan, and --checkpoint-dir.\n\n" +
        usage(),
    );
  }
  if (options.apply && !options.plan_path) {
    throw new Error("--apply requires a previously generated --plan.");
  }
  if (options.apply && !options.confirmation) {
    throw new Error("--apply requires --confirm=TOKEN.");
  }
  if (!options.apply && options.confirmation) {
    throw new Error("--confirm is accepted only together with --apply.");
  }
  return options;
}

interface LoadedSources {
  ledger_path: string;
  ledger_bytes: Buffer;
  ledger: FinalLiveLedgerLike;
  repair_plan_path: string;
  repair_plan_bytes: Buffer;
  repair_plan: SurgicalRepairPlanLike;
  checkpoint_root: string;
  checkpoint_artifacts: CheckpointArtifact[];
}

async function readJson<T>(file: string): Promise<{ path: string; bytes: Buffer; value: T }> {
  const resolved = path.resolve(file);
  const bytes = await readFile(resolved);
  let value: T;
  try {
    value = JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${resolved} is not valid JSON.`);
  }
  return { path: resolved, bytes, value };
}

async function readCheckpointArtifacts(
  root: string,
  repairPlanSha256: string,
): Promise<CheckpointArtifact[]> {
  const resolvedRoot = path.resolve(root);
  const directory = path.join(resolvedRoot, repairPlanSha256.slice(0, 20));
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    throw new Error(
      `Cannot read checkpoint directory ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(path.join(directory, name));
      let event: CheckpointArtifact["event"];
      try {
        event = JSON.parse(bytes.toString("utf8")) as CheckpointArtifact["event"];
      } catch {
        throw new Error(`Checkpoint ${name} is not valid JSON.`);
      }
      return { name, file_sha256: postLiveSha256(bytes), event };
    }),
  );
}

async function loadSources(input: {
  ledger_path: string;
  repair_plan_path: string;
  checkpoint_root: string;
}): Promise<LoadedSources> {
  const [ledger, repair] = await Promise.all([
    readJson<FinalLiveLedgerLike>(input.ledger_path),
    readJson<SurgicalRepairPlanLike>(input.repair_plan_path),
  ]);
  // Use the surgical workflow's own complete verifier in addition to the
  // reconciliation-specific cohort checks.
  verifyRepairPlan(repair.value as UncrustablesRepairPlan);
  const repairSha = String(repair.value.sha256 ?? "");
  const checkpoints = await readCheckpointArtifacts(input.checkpoint_root, repairSha);
  return {
    ledger_path: ledger.path,
    ledger_bytes: ledger.bytes,
    ledger: ledger.value,
    repair_plan_path: repair.path,
    repair_plan_bytes: repair.bytes,
    repair_plan: repair.value,
    checkpoint_root: path.resolve(input.checkpoint_root),
    checkpoint_artifacts: checkpoints,
  };
}

type SnapshotClient = Pick<
  (typeof import("@/lib/prisma"))["prisma"],
  | "channelSKU"
  | "masterBundle"
  | "bundleDraft"
  | "generationJob"
  | "bundleComponent"
  | "uPCPool"
>;

async function readDbSnapshot(
  db: SnapshotClient,
  ledger: ReturnType<typeof validateFinalLiveLedger>,
  guardedUpcPoolIds: string[] = [],
): Promise<PostLiveDbSnapshot> {
  // This repeats the live-ledger candidate predicate, then retains every
  // Amazon channel so a newly added unexpected listing cannot be hidden by an
  // exact-ID query.
  const candidateRows = await db.channelSKU.findMany({
    where: {
      OR: [
        { title: { contains: "Uncrust" } },
        { master_bundle: { name: { contains: "Uncrust" } } },
      ],
    },
    orderBy: { sku: "asc" },
  });
  const channelSkus = candidateRows.filter((row) => row.channel.startsWith("AMAZON_"));
  const masterIds = [...ledger.live_rows, ...ledger.true_404_rows].map(
    (row) => row.master_bundle_id,
  );
  const jobIds = [...new Set(ledger.live_rows.map((row) => row.generation_job_id))];
  const channelIds = channelSkus.map((row) => row.id);
  const referencedPoolIds = channelSkus
    .map((row) => row.upc_pool_id)
    .filter((id): id is string => id != null);
  const [masters, drafts, jobs, components, upcPools, targetUpcOwner] = await Promise.all([
    db.masterBundle.findMany({ where: { id: { in: masterIds } } }),
    db.bundleDraft.findMany({ where: { generation_job_id: { in: jobIds } } }),
    db.generationJob.findMany({ where: { id: { in: jobIds } } }),
    db.bundleComponent.findMany({ where: { master_bundle_id: { in: masterIds } } }),
    db.uPCPool.findMany({
      where: {
        OR: [
          { id: { in: [...new Set([...referencedPoolIds, ...guardedUpcPoolIds])] } },
          { upc: { in: [REVIEWED_SZ_STALE_UPC, ledger.sz_evidence.live_upc] } },
          { assigned_to_id: { in: channelIds } },
        ],
      },
    }),
    db.channelSKU.findUnique({ where: { upc: ledger.sz_evidence.live_upc } }),
  ]);
  return {
    channel_skus: channelSkus as unknown as ChannelSkuDbRow[],
    master_bundles: masters as unknown as MasterBundleDbRow[],
    bundle_drafts: drafts as unknown as BundleDraftDbRow[],
    generation_jobs: jobs as unknown as GenerationJobDbRow[],
    bundle_components: components as unknown as BundleComponentDbRow[],
    upc_pool_rows: upcPools as unknown as UpcPoolDbRow[],
    sz_target_upc_owner: targetUpcOwner as unknown as ChannelSkuDbRow | null,
  };
}

function assertSourceMetadata(
  plan: PostLiveReconciliationPlan,
  sources: LoadedSources,
  now: Date,
): ReturnType<typeof validateFinalLiveLedger> {
  const ledgerFileSha = postLiveSha256(sources.ledger_bytes);
  const repairFileSha = postLiveSha256(sources.repair_plan_bytes);
  if (
    ledgerFileSha !== plan.sources.final_live_ledger.file_sha256 ||
    repairFileSha !== plan.sources.surgical_repair_plan.file_sha256
  ) {
    throw new Error("A sealed source artifact changed after reconciliation planning.");
  }
  const ledger = validateFinalLiveLedger(sources.ledger, {
    now,
    max_age_ms: plan.sources.final_live_ledger.max_age_ms,
  });
  const repair = validateSurgicalRepairEvidence(sources.repair_plan, ledger);
  const checkpoints = validateCompleteCheckpoints(
    sources.checkpoint_artifacts,
    repair,
  );
  assertFinalLedgerAfterRepair(ledger, repair, checkpoints);
  if (
    ledger.audit_id !== plan.sources.final_live_ledger.audit_id ||
    ledger.started_at !== plan.sources.final_live_ledger.started_at ||
    ledger.completed_at !== plan.sources.final_live_ledger.completed_at ||
    repair.plan_id !== plan.sources.surgical_repair_plan.plan_id ||
    repair.sha256 !== plan.sources.surgical_repair_plan.plan_sha256 ||
    repair.action_count !== plan.sources.surgical_repair_plan.actions ||
    checkpoints.files_sha256 !== plan.sources.verified_checkpoints.files_sha256 ||
    checkpoints.event_count !== plan.sources.verified_checkpoints.events ||
    checkpoints.terminal_action_count !==
      plan.sources.verified_checkpoints.terminal_actions ||
    checkpoints.latest_terminal_at !==
      plan.sources.verified_checkpoints.latest_terminal_at
  ) {
    throw new Error("Sealed ledger/repair/checkpoint metadata no longer matches the plan.");
  }
  return ledger;
}

async function writePlan(
  outputDir: string,
  plan: PostLiveReconciliationPlan,
): Promise<string> {
  verifyPostLiveReconciliationPlan(plan);
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const file = path.join(
    directory,
    `${plan.plan_id}-${plan.sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

function asDbDate(label: string, value: Date | string | null): Date {
  const date = value instanceof Date ? value : value == null ? null : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) throw new Error(`${label} is invalid.`);
  return date;
}

async function applyReconciliation(
  plan: PostLiveReconciliationPlan,
  sources: LoadedSources,
  confirmation: string,
): Promise<{
  channel_skus: number;
  master_bundles: number;
  bundle_drafts: number;
  generation_jobs: number;
  upc_pool_rows: number;
}> {
  const expectedConfirmation = postLiveReconciliationConfirmation(plan);
  if (confirmation !== expectedConfirmation) {
    throw new Error(
      `Confirmation mismatch. Exact required token: ${expectedConfirmation}. No DB write was made.`,
    );
  }
  const { prisma } = await import("@/lib/prisma");
  const validatedLedger = assertSourceMetadata(plan, sources, new Date());
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await readDbSnapshot(
        tx,
        validatedLedger,
        plan.scope.upc_pool_row_ids,
      );
      assertDbSnapshotMatchesLedger(before, validatedLedger);
      assertDbSnapshotMatchesPlan(plan, before);

      const channelById = new Map(before.channel_skus.map((row) => [row.id, row]));
      const masterById = new Map(before.master_bundles.map((row) => [row.id, row]));
      const draftById = new Map(before.bundle_drafts.map((row) => [row.id, row]));
      const jobById = new Map(before.generation_jobs.map((row) => [row.id, row]));
      const poolById = new Map(before.upc_pool_rows.map((row) => [row.id, row]));
      let channelUpdates = 0;
      let masterUpdates = 0;
      let draftUpdates = 0;
      let jobUpdates = 0;
      let upcPoolUpdates = 0;

      for (const released of plan.reviewed_sz.upc_reconciliation.release_pool_rows) {
        const current = poolById.get(released.id);
        if (!current) throw new Error(`UPCPool ${released.id} disappeared.`);
        if (
          current.status !== "BURNED" ||
          current.assigned_to_id != null ||
          current.reserved_for_id != null ||
          current.reserved_at != null ||
          current.reserved_until != null ||
          current.notes !== released.desired_note
        ) {
          const updated = await tx.uPCPool.updateMany({
            where: {
              id: current.id,
              updated_at: asDbDate(`UPCPool ${current.id}.updated_at`, current.updated_at),
              upc: current.upc,
              status: current.status,
              assigned_to_id: current.assigned_to_id,
            },
            data: {
              status: "BURNED",
              assigned_to_id: null,
              reserved_for_id: null,
              reserved_at: null,
              reserved_until: null,
              notes: released.desired_note,
            },
          });
          if (updated.count !== 1) {
            throw new Error(`UPCPool ${current.id} release update failed.`);
          }
          upcPoolUpdates++;
        }
      }

      const targetPool = poolById.get(
        plan.reviewed_sz.upc_reconciliation.target_pool_row_id,
      );
      if (!targetPool) throw new Error("SZ target UPCPool row disappeared.");
      if (
        targetPool.status !== "ASSIGNED" ||
        targetPool.assigned_to_id !==
          plan.reviewed_sz.upc_reconciliation.desired_target_assigned_to_id ||
        targetPool.reserved_for_id != null ||
        targetPool.reserved_at != null ||
        targetPool.reserved_until != null
      ) {
        const updated = await tx.uPCPool.updateMany({
          where: {
            id: targetPool.id,
            updated_at: asDbDate(
              `UPCPool ${targetPool.id}.updated_at`,
              targetPool.updated_at,
            ),
            upc: plan.reviewed_sz.upc_reconciliation.desired_upc,
            status: targetPool.status,
            assigned_to_id: targetPool.assigned_to_id,
          },
          data: {
            status: "ASSIGNED",
            assigned_to_id:
              plan.reviewed_sz.upc_reconciliation.desired_target_assigned_to_id,
            reserved_for_id: null,
            reserved_at: null,
            reserved_until: null,
          },
        });
        if (updated.count !== 1) throw new Error("SZ target UPCPool claim failed.");
        upcPoolUpdates++;
      }

      for (const entry of plan.reconciliations) {
        const current = channelById.get(entry.channel_sku_id);
        if (!current) throw new Error(`${entry.sku}: ChannelSKU disappeared.`);
        const data: {
          lifecycle_status?: string;
          listing_status?: string;
          live_at?: Date;
          published_at?: Date;
          price_cents?: number;
          business_price_cents?: number;
          attributes?: string;
          upc?: string;
          upc_pool_id?: string;
        } = {};
        if (current.lifecycle_status !== entry.desired.channel_lifecycle_status) {
          data.lifecycle_status = entry.desired.channel_lifecycle_status;
        }
        if (current.listing_status !== entry.desired.channel_listing_status) {
          data.listing_status = entry.desired.channel_listing_status;
        }
        if (current.live_at == null) data.live_at = new Date(entry.desired.channel_live_at);
        if (current.published_at == null) {
          data.published_at = new Date(entry.desired.channel_published_at);
        }
        if (current.price_cents !== entry.desired.channel_price_cents) {
          data.price_cents = entry.desired.channel_price_cents;
        }
        if (
          current.business_price_cents !==
          entry.desired.channel_business_price_cents
        ) {
          data.business_price_cents = entry.desired.channel_business_price_cents;
        }
        if (current.attributes !== entry.desired.channel_attributes) {
          data.attributes = entry.desired.channel_attributes;
        }
        if (entry.sku === plan.reviewed_sz.sku) {
          if (current.upc !== plan.reviewed_sz.upc_reconciliation.desired_upc) {
            data.upc = plan.reviewed_sz.upc_reconciliation.desired_upc;
          }
          if (
            current.upc_pool_id !==
            plan.reviewed_sz.upc_reconciliation.desired_upc_pool_id
          ) {
            data.upc_pool_id =
              plan.reviewed_sz.upc_reconciliation.desired_upc_pool_id;
          }
        }
        if (Object.keys(data).length > 0) {
          const updated = await tx.channelSKU.updateMany({
            where: {
              id: current.id,
              updated_at: asDbDate(`${entry.sku} ChannelSKU.updated_at`, current.updated_at),
              sku: entry.sku,
              asin: entry.asin,
              master_bundle_id: entry.master_bundle_id,
              lifecycle_status: current.lifecycle_status,
              listing_status: current.listing_status,
              live_at: current.live_at == null ? null : asDbDate(`${entry.sku} live_at`, current.live_at),
              published_at:
                current.published_at == null
                  ? null
                  : asDbDate(`${entry.sku} published_at`, current.published_at),
            },
            data,
          });
          if (updated.count !== 1) {
            throw new Error(`${entry.sku}: ChannelSKU optimistic update failed.`);
          }
          channelUpdates++;
        }
      }

      for (const entry of plan.reconciliations) {
        const current = masterById.get(entry.master_bundle_id);
        if (!current) throw new Error(`${entry.sku}: MasterBundle disappeared.`);
        if (current.lifecycle_status !== entry.desired.master_lifecycle_status) {
          const updated = await tx.masterBundle.updateMany({
            where: {
              id: current.id,
              updated_at: asDbDate(`${entry.sku} MasterBundle.updated_at`, current.updated_at),
              lifecycle_status: current.lifecycle_status,
            },
            data: { lifecycle_status: entry.desired.master_lifecycle_status },
          });
          if (updated.count !== 1) {
            throw new Error(`${entry.sku}: MasterBundle optimistic update failed.`);
          }
          masterUpdates++;
        }
      }

      for (const entry of plan.reconciliations) {
        const current = draftById.get(entry.bundle_draft_id);
        if (!current) throw new Error(`${entry.sku}: BundleDraft disappeared.`);
        const data: { status?: string; published_at?: Date } = {};
        if (current.status !== entry.desired.draft_status) {
          data.status = entry.desired.draft_status;
        }
        if (current.published_at == null) {
          data.published_at = new Date(entry.desired.draft_published_at);
        }
        if (Object.keys(data).length > 0) {
          const updated = await tx.bundleDraft.updateMany({
            where: {
              id: current.id,
              updated_at: asDbDate(`${entry.sku} BundleDraft.updated_at`, current.updated_at),
              master_bundle_id: entry.master_bundle_id,
              generation_job_id: entry.generation_job_id,
              status: current.status,
              published_at:
                current.published_at == null
                  ? null
                  : asDbDate(`${entry.sku} draft published_at`, current.published_at),
            },
            data,
          });
          if (updated.count !== 1) {
            throw new Error(`${entry.sku}: BundleDraft optimistic update failed.`);
          }
          draftUpdates++;
        }
      }

      for (const desired of plan.generation_jobs) {
        const current = jobById.get(desired.generation_job_id);
        if (!current) throw new Error(`GenerationJob ${desired.generation_job_id} disappeared.`);
        const factualCount = await tx.bundleDraft.count({
          where: {
            generation_job_id: current.id,
            published_at: { not: null },
          },
        });
        if (factualCount !== desired.desired_bundles_published) {
          throw new Error(
            `GenerationJob ${current.id} factual published count drifted: sealed=${desired.desired_bundles_published}, current=${factualCount}.`,
          );
        }
        if (current.bundles_published !== factualCount) {
          const updated = await tx.generationJob.updateMany({
            where: {
              id: current.id,
              updated_at: asDbDate(`GenerationJob ${current.id}.updated_at`, current.updated_at),
              bundles_published: current.bundles_published,
            },
            data: { bundles_published: factualCount },
          });
          if (updated.count !== 1) {
            throw new Error(`GenerationJob ${current.id} optimistic update failed.`);
          }
          jobUpdates++;
        }
      }

      const after = await readDbSnapshot(
        tx,
        validatedLedger,
        plan.scope.upc_pool_row_ids,
      );
      assertPostLiveReconciliationOutcome(plan, before, after);
      return {
        channel_skus: channelUpdates,
        master_bundles: masterUpdates,
        bundle_drafts: draftUpdates,
        generation_jobs: jobUpdates,
        upc_pool_rows: upcPoolUpdates,
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function inspectExistingPlan(
  options: Options,
  planFile: { path: string; value: PostLiveReconciliationPlan },
): Promise<void> {
  const plan = planFile.value;
  verifyPostLiveReconciliationPlan(plan);
  const sources = await loadSources({
    ledger_path: plan.sources.final_live_ledger.path,
    repair_plan_path: plan.sources.surgical_repair_plan.path,
    checkpoint_root: plan.sources.verified_checkpoints.root_dir,
  });
  const ledger = assertSourceMetadata(plan, sources, new Date());
  const { prisma } = await import("@/lib/prisma");
  let current: PostLiveDbSnapshot;
  try {
    current = await readDbSnapshot(prisma, ledger, plan.scope.upc_pool_row_ids);
    assertDbSnapshotMatchesLedger(current, ledger);
    assertDbSnapshotMatchesPlan(plan, current);
  } finally {
    await prisma.$disconnect();
  }
  console.log(`Plan: ${planFile.path}`);
  console.log(`Plan SHA-256: ${plan.sha256}`);
  console.log(
    `Scope: live=${plan.scope.live_rows} true404=${plan.scope.true_404_skus.length} actions=${plan.sources.surgical_repair_plan.actions}`,
  );
  console.log(
    `Pending DB rows: ChannelSKU=${plan.change_summary.channel_skus} MasterBundle=${plan.change_summary.master_bundles} BundleDraft=${plan.change_summary.bundle_drafts} GenerationJob=${plan.change_summary.generation_jobs}`,
  );
  if (!options.apply) {
    console.log("DRY-RUN: source artifacts and full DB snapshot still match; no writes made.");
    console.log(
      `Apply only after review: --plan=${planFile.path} --apply --confirm=${postLiveReconciliationConfirmation(plan)}`,
    );
    return;
  }
  const result = await applyReconciliation(
    plan,
    sources,
    options.confirmation as string,
  );
  console.log(
    `APPLIED DB-only reconciliation: ChannelSKU=${result.channel_skus} MasterBundle=${result.master_bundles} BundleDraft=${result.bundle_drafts} GenerationJob=${result.generation_jobs} UPCPool=${result.upc_pool_rows}`,
  );
  console.log("Amazon writes=0; true-404 writes=0; approval/compliance/validation/inventory writes=0.");
}

async function main(): Promise<void> {
  const options = parsePostLiveReconciliationArgs(process.argv.slice(2));
  if (options.plan_path) {
    const file = await readJson<PostLiveReconciliationPlan>(options.plan_path);
    await inspectExistingPlan(options, { path: file.path, value: file.value });
    return;
  }

  const sources = await loadSources({
    ledger_path: options.ledger_path as string,
    repair_plan_path: options.repair_plan_path as string,
    checkpoint_root: options.checkpoint_dir as string,
  });
  const now = new Date();
  const ledger = validateFinalLiveLedger(sources.ledger, {
    now,
    max_age_ms: options.max_ledger_age_ms,
  });
  const repair = validateSurgicalRepairEvidence(sources.repair_plan, ledger);
  const checkpoints = validateCompleteCheckpoints(sources.checkpoint_artifacts, repair);
  assertFinalLedgerAfterRepair(ledger, repair, checkpoints);

  const { prisma } = await import("@/lib/prisma");
  let dbSnapshot: PostLiveDbSnapshot;
  try {
    dbSnapshot = await readDbSnapshot(prisma, ledger);
    assertDbSnapshotMatchesLedger(dbSnapshot, ledger);
  } finally {
    await prisma.$disconnect();
  }
  const plan = buildPostLiveReconciliationPlan({
    ledger: sources.ledger,
    ledger_path: sources.ledger_path,
    ledger_file_sha256: postLiveSha256(sources.ledger_bytes),
    repair_plan: sources.repair_plan,
    repair_plan_path: sources.repair_plan_path,
    repair_plan_file_sha256: postLiveSha256(sources.repair_plan_bytes),
    checkpoint_root_dir: sources.checkpoint_root,
    checkpoint_artifacts: sources.checkpoint_artifacts,
    db_snapshot: dbSnapshot,
    now,
    max_ledger_age_ms: options.max_ledger_age_ms,
  });
  const output = await writePlan(options.output_dir, plan);
  console.log(`Immutable reconciliation plan: ${output}`);
  console.log(`Plan SHA-256: ${plan.sha256}`);
  console.log(
    `Scope: 164 live + 3 preserved true-404; DB rows needing changes=${plan.change_summary.total_rows}`,
  );
  console.log("DRY-RUN: database writes=0; Amazon writes=0.");
  console.log(
    `After review: --plan=${output} --apply --confirm=${postLiveReconciliationConfirmation(plan)}`,
  );
}

const invokedPath = process.argv[1] ?? "";
if (/reconcile-uncrustables-post-live\.(?:ts|js)$/.test(invokedPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
