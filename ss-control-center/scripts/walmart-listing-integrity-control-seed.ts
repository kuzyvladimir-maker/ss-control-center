#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildWalmartListingIntegrityControlSeedPlan,
  verifyWalmartListingIntegrityControlSeedPlan,
  type WalmartListingIntegrityControlSeedPlan,
} from "../src/lib/walmart/listing-integrity-control-seed.ts";
import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "../src/lib/walmart/listing-integrity-control-store.server.ts";
import {
  seedWalmartListingIntegrityControlRun,
} from "../src/lib/walmart/listing-integrity-control-writer.server.ts";
import {
  inspectWalmartListingIntegrityGlobalAdmissionRoot,
} from "../src/lib/walmart/listing-integrity-global-admission.ts";
import {
  verifyWalmartListingIntegrityControlledPool,
  type WalmartListingIntegrityControlledPool,
} from "../src/lib/walmart/listing-integrity-operations.ts";

const RELEASE_ID = "729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c";
const MANIFEST_SHA = "65f6fff8599a8001a5a3b1dfcdaca149aae2f0456c90cc41a6b164a6ec953aff";
const GLOBAL_ADMISSION_IDENTITY_SHA =
  "971d12097b154220d0818a03af8d78679aac26bf42a024ac654e7f4256232650";
const GLOBAL_ADMISSION_ROOT =
  "/Users/vladimirkuznetsov/.ss-command-center-owner/walmart/listing-integrity-global-admission-v1";
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

type SeedCommand = "plan" | "apply";

export interface WalmartListingIntegrityControlSeedArgs {
  command: SeedCommand;
  input_path: string;
  input_file_sha256: string;
  output_dir: string | null;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function absolute(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail("CONTROL_SEED_CLI_INVALID", `${label} must be an absolute normalized path`);
  }
  return value;
}

function sha(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CONTROL_SEED_CLI_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

export function parseWalmartListingIntegrityControlSeedArgs(
  argv: readonly string[],
): WalmartListingIntegrityControlSeedArgs {
  const command = argv[0];
  if (command !== "plan" && command !== "apply") {
    fail("CONTROL_SEED_CLI_INVALID", "command must be plan or apply");
  }
  const allowed = command === "plan"
    ? new Set(["pool", "pool-file-sha256", "output-dir"])
    : new Set(["plan", "plan-file-sha256"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token || !token.startsWith("--") || token.includes("=")
      || !value || value.startsWith("--")) {
      fail("CONTROL_SEED_CLI_INVALID", "flags must be exact --name value pairs");
    }
    const key = token.slice(2);
    if (!allowed.has(key) || values.has(key)) {
      fail("CONTROL_SEED_CLI_INVALID", `flag --${key} is forbidden or repeated`);
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size || [...allowed].some((key) => !values.has(key))) {
    fail("CONTROL_SEED_CLI_INVALID", "required flags are missing");
  }
  return command === "plan" ? {
    command,
    input_path: absolute(values.get("pool"), "--pool"),
    input_file_sha256: sha(values.get("pool-file-sha256"), "--pool-file-sha256"),
    output_dir: absolute(values.get("output-dir"), "--output-dir"),
  } : {
    command,
    input_path: absolute(values.get("plan"), "--plan"),
    input_file_sha256: sha(values.get("plan-file-sha256"), "--plan-file-sha256"),
    output_dir: null,
  };
}

async function readExactJson(file: string, expectedSha: string, label: string): Promise<{
  value: unknown;
  file_sha256: string;
}> {
  const stat = await lstat(file).catch(() => fail(
    "CONTROL_SEED_ARTIFACT_INVALID",
    `${label} does not exist`,
  ));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 2 || stat.size > MAX_ARTIFACT_BYTES || await realpath(file) !== file) {
    fail("CONTROL_SEED_ARTIFACT_INVALID", `${label} must be one canonical regular file`);
  }
  const bytes = await readFile(file);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== expectedSha) {
    fail("CONTROL_SEED_ARTIFACT_INVALID", `${label} file SHA differs`);
  }
  try {
    return {
      value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
      file_sha256: actualSha,
    };
  } catch {
    return fail("CONTROL_SEED_ARTIFACT_INVALID", `${label} is not UTF-8 JSON`);
  }
}

async function writePlan(outputDir: string, plan: WalmartListingIntegrityControlSeedPlan) {
  await mkdir(dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const file = resolve(outputDir, "control-seed-plan.json");
  const handle = await open(file, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(outputDir, 0o500);
  return { file, file_sha256: fileSha256 };
}

function globalBinding() {
  return {
    root: GLOBAL_ADMISSION_ROOT,
    expected_identity_sha256: GLOBAL_ADMISSION_IDENTITY_SHA,
  };
}

export function walmartListingIntegrityControlRunBlocksFreshSeed(
  snapshot: Awaited<ReturnType<typeof loadWalmartListingIntegrityControlRunSnapshot>>,
): boolean {
  return snapshot.run !== null && snapshot.run.status !== "COMPLETED";
}

export async function runWalmartListingIntegrityControlSeed(
  args: WalmartListingIntegrityControlSeedArgs,
) {
  const [snapshot, admission] = await Promise.all([
    loadWalmartListingIntegrityControlRunSnapshot(),
    inspectWalmartListingIntegrityGlobalAdmissionRoot(globalBinding()),
  ]);
  if (snapshot.installation !== "INSTALLED") {
    fail("CONTROL_SEED_NOT_READY", "production control schema is not installed");
  }

  if (args.command === "plan") {
    const artifact = await readExactJson(
      args.input_path,
      args.input_file_sha256,
      "controlled pool",
    );
    const pool = artifact.value as WalmartListingIntegrityControlledPool;
    verifyWalmartListingIntegrityControlledPool(pool);
    const externalActiveListingKeys = admission.active_claim
      ? [admission.active_claim.listing.listing_key] : [];
    const plan = buildWalmartListingIntegrityControlSeedPlan({
      pool,
      release_id_sha256: RELEASE_ID,
      manifest_sha256: MANIFEST_SHA,
      created_at: new Date().toISOString(),
      external_active_listing_keys: externalActiveListingKeys,
    });
    const persisted = await writePlan(args.output_dir!, plan);
    const ready = !walmartListingIntegrityControlRunBlocksFreshSeed(snapshot)
      && admission.status === "AVAILABLE";
    return {
      schema_version: "walmart-listing-integrity-control-seed-result/v1",
      status: ready ? "DEFAULT_OFF_SEED_PLAN_READY" : "WAITING_FOR_PREDECESSOR",
      pool_file_sha256: artifact.file_sha256,
      run_id: plan.run.run_id,
      item_count: plan.items.length,
      plan_body_sha256: plan.body_sha256,
      plan_path: persisted.file,
      plan_file_sha256: persisted.file_sha256,
      existing_control_run_id: snapshot.run?.run_id ?? null,
      global_admission_status: admission.status,
      external_active_listing_keys: plan.external_active_listing_keys,
      database_writes: 0,
      walmart_writes: 0,
      next_command: ready
        ? `apply --plan ${persisted.file} --plan-file-sha256 ${persisted.file_sha256}`
        : null,
    };
  }

  const artifact = await readExactJson(args.input_path, args.input_file_sha256, "seed plan");
  const plan = artifact.value as WalmartListingIntegrityControlSeedPlan;
  verifyWalmartListingIntegrityControlSeedPlan(plan);
  if (plan.run.release_id_sha256 !== RELEASE_ID || plan.run.manifest_sha256 !== MANIFEST_SHA) {
    fail("CONTROL_SEED_RELEASE_MISMATCH", "seed plan is not pinned to frozen V50");
  }
  if (walmartListingIntegrityControlRunBlocksFreshSeed(snapshot)) {
    fail("CONTROL_SEED_RUN_EXISTS", "a non-completed durable control run already exists");
  }
  if (admission.status !== "AVAILABLE" || plan.external_active_listing_keys.length !== 0) {
    fail("CONTROL_SEED_PREDECESSOR_ACTIVE", "external predecessor is not terminal");
  }
  const seeded = await seedWalmartListingIntegrityControlRun({ plan });
  return {
    schema_version: "walmart-listing-integrity-control-seed-result/v1",
    status: "SEEDED_DEFAULT_OFF",
    plan_file_sha256: artifact.file_sha256,
    ...seeded,
    next_command: "npm run walmart:listing-integrity:worker -- doctor",
  };
}

async function main() {
  const args = parseWalmartListingIntegrityControlSeedArgs(process.argv.slice(2));
  const result = await runWalmartListingIntegrityControlSeed(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schema_version: "walmart-listing-integrity-control-seed-error/v1",
      status: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      automatic_retry_allowed: false,
      walmart_writes: 0,
    })}\n`);
    process.exitCode = 1;
  });
}
