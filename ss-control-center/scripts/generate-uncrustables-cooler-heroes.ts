/**
 * Resumable generation of deterministic real-carton Uncrustables cooler heroes.
 *
 * Default mode is a zero-network plan. This rejected v1/v2 compositor is kept
 * only for isolated forensics. Asset generation/upload requires all three:
 *   --experimental-deterministic-cooler
 *   --apply --confirm=GENERATE_UNCRUSTABLES_HEROES
 *
 * This script never calls Amazon and never writes Prisma. Every R2 object is
 * content-addressed/versioned; a mutable local checkpoint makes the run safe to
 * resume, followed by an immutable final manifest.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import type { Variant } from "@/lib/bundle-factory/variation-matrix";
import type { CoolerHeroBuildResult } from "@/lib/bundle-factory/cooler-hero";

const CONFIRM = "GENERATE_UNCRUSTABLES_HEROES";

interface LedgerTarget {
  sku: string;
  asin: string;
  draft_id: string;
}

interface CheckpointRow extends LedgerTarget {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  started_at?: string;
  completed_at?: string;
  result?: CoolerHeroBuildResult;
  error?: string;
}

interface Checkpoint {
  schema_version: "uncrustables-hero-generation-checkpoint/v1.0";
  run_id: string;
  source_path: string;
  source_sha256: string;
  created_at: string;
  updated_at: string;
  rows: CheckpointRow[];
}

interface Options {
  input: string;
  outputDir: string;
  apply: boolean;
  confirm: string | null;
  skus: Set<string> | null;
  limit: number | null;
  concurrency: number;
  resume: string | null;
  experimentalDeterministicCooler: boolean;
}

function parseArgs(argv: string[]): Options {
  const out: Options = {
    input: "",
    outputDir: "data/audits",
    apply: false,
    confirm: null,
    skus: null,
    limit: null,
    concurrency: 1,
    resume: null,
    experimentalDeterministicCooler: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--input=")) out.input = arg.slice(8).trim();
    else if (arg.startsWith("--output-dir=")) out.outputDir = arg.slice(13).trim();
    else if (arg === "--apply") out.apply = true;
    else if (arg.startsWith("--confirm=")) out.confirm = arg.slice(10);
    else if (arg.startsWith("--skus=")) {
      out.skus = new Set(arg.slice(7).split(",").map((value) => value.trim()).filter(Boolean));
    } else if (arg.startsWith("--limit=")) out.limit = Number(arg.slice(8));
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--resume=")) out.resume = arg.slice(9).trim();
    else if (arg === "--experimental-deterministic-cooler") {
      out.experimentalDeterministicCooler = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.input) throw new Error("--input=LEDGER is required");
  if (out.limit != null && (!Number.isInteger(out.limit) || out.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 4) {
    throw new Error("--concurrency must be 1-4");
  }
  if (out.apply && out.confirm !== CONFIRM) {
    throw new Error(`Asset generation requires --confirm=${CONFIRM}`);
  }
  if (out.apply && !out.experimentalDeterministicCooler) {
    throw new Error(
      "Rejected empty-cooler v1/v2 generation requires --experimental-deterministic-cooler",
    );
  }
  return out;
}

function stamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
}

let checkpointWriteQueue: Promise<void> = Promise.resolve();

/**
 * Serialize atomic checkpoint replacements. Multiple generation workers can
 * finish at nearly the same time; sharing one temporary filename caused one
 * worker to rename the file out from under another. Queueing also prevents an
 * older snapshot from winning an out-of-order rename.
 */
async function saveCheckpoint(file: string, checkpoint: Checkpoint): Promise<void> {
  checkpointWriteQueue = checkpointWriteQueue.then(async () => {
    checkpoint.updated_at = new Date().toISOString();
    const temp = `${file}.${checkpoint.run_id}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    await rename(temp, file);
  });
  return checkpointWriteQueue;
}

function targetsFromLedger(source: unknown, options: Options): LedgerTarget[] {
  const rows = (source as {
    rows?: Array<{
      sku: string;
      asin: string | null;
      live: { fetched?: boolean } | null;
      db: { draft: { id: string } | null };
    }>;
  }).rows;
  if (!Array.isArray(rows)) throw new Error("Ledger has no rows array");
  let targets = rows
    .filter((row) => row.live?.fetched && row.asin && row.db.draft?.id)
    .map((row) => ({ sku: row.sku, asin: row.asin!, draft_id: row.db.draft!.id }));
  if (options.skus) targets = targets.filter((row) => options.skus!.has(row.sku));
  if (options.limit != null) targets = targets.slice(0, options.limit);
  return targets;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(options.input);
  const sourceBytes = await readFile(sourcePath);
  const sourceSha = createHash("sha256").update(sourceBytes).digest("hex");
  const source = JSON.parse(sourceBytes.toString("utf8")) as unknown;
  const targets = targetsFromLedger(source, options);
  if (targets.length === 0) throw new Error("No live targets selected");

  if (!options.apply) {
    console.log(JSON.stringify({
      mode: "DRY_RUN",
      targets: targets.length,
      skus: targets.map((row) => row.sku),
      external_calls: 0,
      mutations: 0,
      apply_command_requires:
        `--experimental-deterministic-cooler --apply --confirm=${CONFIRM}`,
    }, null, 2));
    return;
  }

  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  let checkpoint: Checkpoint;
  let checkpointPath: string;
  if (options.resume) {
    checkpointPath = path.resolve(options.resume);
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
    if (checkpoint.source_sha256 !== sourceSha) throw new Error("Resume source SHA mismatch");
    const selected = new Set(targets.map((row) => row.sku));
    checkpoint.rows = checkpoint.rows.filter((row) => selected.has(row.sku));
    for (const row of checkpoint.rows) if (row.status === "RUNNING") row.status = "PENDING";
  } else {
    const now = new Date();
    checkpoint = {
      schema_version: "uncrustables-hero-generation-checkpoint/v1.0",
      run_id: `UHG-${stamp(now)}-${randomUUID().slice(0, 8)}`,
      source_path: sourcePath,
      source_sha256: sourceSha,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      rows: targets.map((target) => ({ ...target, status: "PENDING" })),
    };
    checkpointPath = path.join(outputDir, `${checkpoint.run_id}-checkpoint.json`);
    await saveCheckpoint(checkpointPath, checkpoint);
  }

  // Dynamic imports keep dotenv ahead of Prisma initialization.
  const [{ prisma }, { buildCoolerHeroWithQA }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/bundle-factory/cooler-hero"),
  ]);
  const draftIds = checkpoint.rows.map((row) => row.draft_id);
  const drafts = [] as Array<{
    id: string;
    variation_matrix: { selected_variant_idx: number | null; variants_json: string } | null;
  }>;
  for (let offset = 0; offset < draftIds.length; offset += 40) {
    drafts.push(...await prisma.bundleDraft.findMany({
      where: { id: { in: draftIds.slice(offset, offset + 40) } },
      select: {
        id: true,
        variation_matrix: { select: { selected_variant_idx: true, variants_json: true } },
      },
    }));
  }
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= checkpoint.rows.length) return;
      const row = checkpoint.rows[index];
      if (row.status === "SUCCEEDED") continue;
      row.status = "RUNNING";
      row.started_at = new Date().toISOString();
      delete row.error;
      await saveCheckpoint(checkpointPath, checkpoint);
      try {
        const draft = byId.get(row.draft_id);
        if (!draft?.variation_matrix) throw new Error("variation matrix missing");
        const variants = JSON.parse(draft.variation_matrix.variants_json) as Variant[];
        const selected = draft.variation_matrix.selected_variant_idx;
        if (selected == null || !variants[selected]) throw new Error("selected variant missing");
        const result = await buildCoolerHeroWithQA({
          variant: variants[selected],
          r2_slug: `repair-${row.draft_id}-${row.sku}`,
          stamp: stamp(new Date()).toLowerCase(),
          experimental_opt_in: options.experimentalDeterministicCooler,
        });
        row.result = result;
        row.status = result.ok && result.image_url && result.qa?.pass && result.qa.verified
          ? "SUCCEEDED"
          : "FAILED";
        if (row.status === "FAILED") row.error = result.error ?? "image/QA failed";
      } catch (error) {
        row.status = "FAILED";
        row.error = error instanceof Error ? error.message : String(error);
      }
      row.completed_at = new Date().toISOString();
      await saveCheckpoint(checkpointPath, checkpoint);
      console.log(`${row.status}\t${row.sku}\t${row.result?.image_url ?? row.error ?? ""}`);
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  await prisma.$disconnect();

  const succeeded = checkpoint.rows.filter((row) => row.status === "SUCCEEDED");
  const failed = checkpoint.rows.filter((row) => row.status !== "SUCCEEDED");
  const completed = new Date();
  // A failed run must remain resumable. Writing the final immutable filename
  // here used to poison the run: a later successful --resume hit EEXIST and
  // could never emit its complete manifest. The checkpoint is the audit trail
  // for incomplete work; only a fully successful cohort earns a final manifest.
  if (failed.length > 0) {
    console.error(`Hero generation remains incomplete; resume ${checkpointPath}.`);
    console.error(JSON.stringify({
      target: checkpoint.rows.length,
      succeeded: succeeded.length,
      failed: failed.length,
      failed_skus: failed.map((row) => row.sku),
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.join(outputDir, `${checkpoint.run_id}-manifest.json`);
  const manifest = {
    schema_version: "uncrustables-hero-generation-manifest/v1.0",
    immutable: true,
    external_mutations: { r2_asset_uploads: succeeded.length, amazon_calls: 0, database_writes: 0 },
    run_id: checkpoint.run_id,
    created_at: checkpoint.created_at,
    completed_at: completed.toISOString(),
    source_snapshot: { path: sourcePath, sha256: sourceSha },
    checkpoint_path: checkpointPath,
    summary: { target: checkpoint.rows.length, succeeded: succeeded.length, failed: failed.length },
    rows: checkpoint.rows,
  };
  const handle = await open(manifestPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  console.log(`Manifest: ${manifestPath}`);
  console.log(JSON.stringify(manifest.summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
