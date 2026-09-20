#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "../src/lib/walmart/listing-integrity-control-store.server.ts";
import {
  completeWalmartListingIntegrityGlobalAdmission,
  inspectWalmartListingIntegrityGlobalAdmissionRoot,
} from "../src/lib/walmart/listing-integrity-global-admission.ts";
import {
  buildWalmartListingIntegrityMainFailureDisposition,
  verifyWalmartListingIntegrityMainFailureDisposition,
  type WalmartListingIntegrityMainFailureDisposition,
} from "../src/lib/walmart/listing-integrity-main-failure-disposition.ts";
import {
  publishMainFailureDisposition,
} from "../src/lib/walmart/listing-integrity-production-cycle.server.ts";
import {
  runWalmartListingIntegrityControlSeed,
} from "./walmart-listing-integrity-control-seed.ts";
import {
  runWalmartListingIntegrityControlWorker,
  walmartListingIntegrityRemediationConfig,
} from "./walmart-listing-integrity-control-worker.ts";
import {
  invokeWalmartListingIntegrityRemediationProcess,
} from "../src/lib/walmart/listing-integrity-remediation-process-adapter.server.ts";
import {
  buildWalmartListingIntegrityRunCompletionEvidence,
} from "../src/lib/walmart/listing-integrity-control-run-completion.ts";
import {
  completeWalmartListingIntegrityControlRun,
} from "../src/lib/walmart/listing-integrity-control-writer.server.ts";

const RELEASE_ID = "729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c";
const GLOBAL_ADMISSION_IDENTITY_SHA =
  "971d12097b154220d0818a03af8d78679aac26bf42a024ac654e7f4256232650";
const GLOBAL_ADMISSION_ROOT =
  "/Users/vladimirkuznetsov/.ss-command-center-owner/walmart/listing-integrity-global-admission-v1";
const PRODUCT_TRUTH_MANIFEST_SHA =
  "94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c";
export const walmartListingIntegrityControlReadmission = Object.freeze({
  relativePath:
    "data/audits/walmart-listing-integrity-readmission/20260802T002700Z-v14-false-negative-v1/readmission.json",
  fileSha256:
    "e527bcd195267bd255207259e08c62ece7cb9cf55afeadf87f2848b4f7098252",
});
const POLL_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_REPORT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CATALOG_SNAPSHOT_AGE_MS = 15 * 60 * 1_000;
const CONTROL_ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const walmartListingIntegrityReservedListingKeys = Object.freeze([
  "walmart:1:FaisalX-1435",
]);
const TERMINAL = new Set([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
]);
const OPERATOR = new Set([
  "OWNER_APPROVED",
  "APPLY_REQUESTING",
  "APPLIED",
  "PROPAGATING",
  "LIVE_REREAD",
]);

type SuccessorCommand = "doctor" | "once" | "watch";

export interface WalmartListingIntegritySuccessorArgs {
  command: SuccessorCommand;
  custody_root: string | null;
  status_path: string | null;
  max_audits: number;
}

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_SUCCESSOR_INVALID: ${message}`);
}

function absolute(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail(`${label} must be an absolute normalized path`);
  }
  return value;
}

export function parseWalmartListingIntegritySuccessorArgs(
  argv: readonly string[],
): WalmartListingIntegritySuccessorArgs {
  const command = argv[0];
  if (command !== "doctor" && command !== "once" && command !== "watch") {
    fail("command must be doctor, once, or watch");
  }
  if (command === "doctor") {
    if (argv.length !== 1) fail("doctor accepts no flags");
    return { command, custody_root: null, status_path: null, max_audits: 0 };
  }
  const allowed = command === "watch"
    ? new Set(["custody-root", "status-path", "max-audits"])
    : new Set(["custody-root", "max-audits"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || token.includes("=") || !value || value.startsWith("--")) {
      fail("flags must be exact --name value pairs");
    }
    const key = token.slice(2);
    if (!allowed.has(key) || values.has(key)) fail(`flag --${key} is forbidden or repeated`);
    values.set(key, value);
  }
  if (values.size !== allowed.size || [...allowed].some((key) => !values.has(key))) {
    fail("required flags are missing");
  }
  const rawMaximum = values.get("max-audits")!;
  if (!/^[1-9]\d*$/u.test(rawMaximum)) fail("--max-audits must be between 1 and 10");
  const maximum = Number(rawMaximum);
  if (!Number.isSafeInteger(maximum) || maximum > 10) {
    fail("--max-audits must be between 1 and 10");
  }
  return {
    command,
    custody_root: absolute(values.get("custody-root"), "--custody-root"),
    status_path: command === "watch"
      ? absolute(values.get("status-path"), "--status-path") : null,
    max_audits: maximum,
  };
}

function binding() {
  return {
    root: GLOBAL_ADMISSION_ROOT,
    expected_identity_sha256: GLOBAL_ADMISSION_IDENTITY_SHA,
  };
}

async function exactPrivateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("custody root is not private");
  }
}

function safeStamp() {
  return new Date().toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
}

export function verifyWalmartListingIntegritySuccessorCatalogSnapshot(
  result: Record<string, unknown>,
  outputDir: string,
) {
  const local = result.local_artifacts as Record<string, unknown> | undefined;
  const freshness = result.freshness as Record<string, unknown> | undefined;
  const effects = result.external_effects as Record<string, unknown> | undefined;
  if (result.status !== "AUTHORITATIVE_READ_ONLY_PLAN_READY"
    || local?.output_dir !== outputDir
    || typeof local?.census_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(local.census_sha256)
    || typeof local?.plan_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(local.plan_sha256)
    || freshness?.verified !== true
    || freshness?.authority !== "AUTHORITATIVE_ITEM_CATALOG_REPORT_MIRROR"
    || typeof freshness?.report_request_id !== "string"
    || !freshness.report_request_id
    || !Number.isSafeInteger(freshness.report_age_ms)
    || Number(freshness.report_age_ms) < 0
    || Number(freshness.report_age_ms) > MAX_CATALOG_REPORT_AGE_MS
    || !Number.isSafeInteger(freshness.snapshot_age_ms)
    || Number(freshness.snapshot_age_ms) < 0
    || Number(freshness.snapshot_age_ms) > MAX_CATALOG_SNAPSHOT_AGE_MS
    || !Number.isSafeInteger(freshness.catalog_rows)
    || Number(freshness.catalog_rows) < 1
    || effects?.database_writes !== 0
    || effects?.walmart_reads !== 0
    || effects?.walmart_writes !== 0
    || effects?.model_calls !== 0
    || effects?.paid_api_calls !== 0) {
    fail("authoritative catalog snapshot result is invalid or not fresh");
  }
  return {
    census_sha256: local.census_sha256,
    plan_sha256: local.plan_sha256,
    freshness,
  };
}

async function invokeFreshCatalogSnapshot(root: string, engineRoot: string) {
  const outputDir = join(
    root,
    "data/audits/walmart-listing-integrity-catalog",
    `${safeStamp()}-successor-authoritative-v5-${randomBytes(4).toString("hex")}`,
  );
  const child = spawn(process.execPath, [
    `--env-file=${join(root, ".env")}`,
    "--experimental-strip-types",
    join(engineRoot, "scripts/walmart-listing-integrity-catalog.mjs"),
    "snapshot",
    "--store-index=1",
    `--output-dir=${outputDir}`,
  ], {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
  });
  const exitCode = await new Promise<number | null>((accept, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("authoritative catalog snapshot timed out"));
    }, 5 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      accept(code);
    });
  });
  if (exitCode !== 0 || bytes < 2 || bytes > MAX_OUTPUT_BYTES) {
    fail(`authoritative catalog snapshot failed: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
  }
  const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
  const verified = verifyWalmartListingIntegritySuccessorCatalogSnapshot(result, outputDir);
  return {
    output_dir: outputDir,
    census_path: join(outputDir, "catalog-census.json"),
    census_sha256: verified.census_sha256,
    plan_path: join(outputDir, "scan-plan.json"),
    plan_sha256: verified.plan_sha256,
    freshness: verified.freshness,
  };
}

async function invokeBuilder(
  root: string,
  engineRoot: string,
  catalog: Awaited<ReturnType<typeof invokeFreshCatalogSnapshot>>,
) {
  const outputDir = join(
    root,
    "data/audits/walmart-listing-integrity-operations",
    `${safeStamp()}-successor-controlled-pool-10-v7-${randomBytes(4).toString("hex")}`,
  );
  const args = [
    `--env-file=${join(root, ".env")}`,
    "--import",
    "tsx",
    join(engineRoot, "scripts/build-walmart-listing-integrity-controlled-pool.ts"),
    `--census=${catalog.census_path}`,
    `--expect-census-sha256=${catalog.census_sha256}`,
    `--plan=${catalog.plan_path}`,
    `--expect-plan-sha256=${catalog.plan_sha256}`,
    `--manifest-sha256=${PRODUCT_TRUTH_MANIFEST_SHA}`,
    `--completed-root=${join(root, "data/audits/walmart-listing-integrity-post-canary")}`,
    `--quarantine-root=${join(root, "data/audits/walmart-listing-integrity-quarantine")}`,
    `--reserved-listing-keys=${walmartListingIntegrityReservedListingKeys.join(",")}`,
    `--readmission-artifact=${join(
      root,
      walmartListingIntegrityControlReadmission.relativePath,
    )}`,
    `--expect-readmission-sha256=${walmartListingIntegrityControlReadmission.fileSha256}`,
    "--limit=10",
    `--output-dir=${outputDir}`,
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
  });
  const exitCode = await new Promise<number | null>((accept, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("controlled-pool builder timed out"));
    }, 10 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      accept(code);
    });
  });
  if (exitCode !== 0 || bytes < 2 || bytes > MAX_OUTPUT_BYTES) {
    fail(`controlled-pool builder failed: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
  }
  const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
  if (result.status !== "READ_ONLY_CONTROLLED_POOL_READY"
    || typeof result.pool_file_sha256 !== "string"
    || result.output_dir !== outputDir) {
    fail("controlled-pool builder result is invalid");
  }
  const catalogFreshness = result.catalog_freshness as Record<string, unknown> | undefined;
  const items = Array.isArray(result.items) ? result.items : null;
  const sourceRequiredItems = Array.isArray(result.source_required_preview)
    ? result.source_required_preview : null;
  if (catalogFreshness?.verified !== true
    || catalogFreshness.report_request_id !== catalog.freshness.report_request_id
    || !items || !sourceRequiredItems) {
    fail("controlled-pool freshness differs from the exact catalog snapshot");
  }
  return {
    output_dir: outputDir,
    pool_path: join(outputDir, "controlled-pool.json"),
    pool_file_sha256: result.pool_file_sha256,
    pool_body_sha256: result.pool_body_sha256,
    items,
    source_required_items: sourceRequiredItems,
    processed_control_listing_keys: result.processed_control_listing_keys,
    source_readiness: result.source_readiness,
    catalog_freshness: catalogFreshness,
  };
}

async function seedIfNeeded(root: string, engineRoot: string) {
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot();
  if (snapshot.run && snapshot.run.status !== "COMPLETED") {
    return {
      status: "CONTROL_RUN_ALREADY_PRESENT" as const,
      snapshot,
      seed: null,
      pool: null,
      catalog: null,
    };
  }
  const catalog = await invokeFreshCatalogSnapshot(root, engineRoot);
  const pool = await invokeBuilder(root, engineRoot, catalog);
  if (pool.items.length === 0 && pool.source_required_items.length === 0) {
    return {
      status: "CATALOG_COMPLETE" as const,
      snapshot,
      seed: null,
      pool,
      catalog,
    };
  }
  const seedOutput = join(
    "/Users/vladimirkuznetsov/.ss-command-center-owner/walmart",
    `${safeStamp()}-control-seed-${randomBytes(4).toString("hex")}`,
  );
  const planned = await runWalmartListingIntegrityControlSeed({
    command: "plan",
    input_path: pool.pool_path,
    input_file_sha256: pool.pool_file_sha256,
    output_dir: seedOutput,
  });
  if (planned.status !== "DEFAULT_OFF_SEED_PLAN_READY") {
    return {
      status: "SEED_PLAN_NOT_READY" as const,
      snapshot,
      seed: planned,
      pool,
      catalog,
    };
  }
  if (typeof planned.plan_path !== "string"
    || typeof planned.plan_file_sha256 !== "string") {
    fail("seed planner READY result lacks exact plan path or SHA-256");
  }
  const seeded = await runWalmartListingIntegrityControlSeed({
    command: "apply",
    input_path: planned.plan_path,
    input_file_sha256: planned.plan_file_sha256,
    output_dir: null,
  });
  return {
    status: "CONTROL_RUN_SEEDED" as const,
    snapshot,
    seed: seeded,
    pool,
    catalog,
  };
}

function activeItem(snapshot: Awaited<ReturnType<typeof loadWalmartListingIntegrityControlRunSnapshot>>) {
  return snapshot.run?.items.find((item) => !TERMINAL.has(item.state)) ?? null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(",")}}`;
}

function controlCaseId(item: {
  identity: { ordinal: number; listing_key: string };
}): string {
  return `case-${item.identity.ordinal}-${createHash("sha256")
    .update(item.identity.listing_key).digest("hex").slice(0, 16)}`;
}

async function artifactExists(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function exactJson(file: string): Promise<Record<string, unknown>> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 2 || stat.size > MAX_OUTPUT_BYTES) {
    fail(`invalid exact JSON artifact: ${file}`);
  }
  const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(file)));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`JSON artifact is not one object: ${file}`);
  }
  return value as Record<string, unknown>;
}

async function exactPrivateArtifactBytes(file: string): Promise<Buffer> {
  const stat = await lstat(file).catch(() => fail(`private artifact is absent: ${file}`));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 2 || stat.size > MAX_OUTPUT_BYTES
    || (stat.mode & 0o077) !== 0 || await realpath(file) !== file) {
    fail(`private artifact is not one exact owner-only file: ${file}`);
  }
  return readFile(file);
}

export async function recoverPublishedMainFailureAdmission(input: {
  root: string;
  custody_root?: string;
  snapshot: Awaited<ReturnType<typeof loadWalmartListingIntegrityControlRunSnapshot>>;
  admission: Awaited<ReturnType<typeof inspectWalmartListingIntegrityGlobalAdmissionRoot>>;
  admission_binding?: ReturnType<typeof binding>;
}) {
  const claim = input.admission.active_claim;
  if (!claim || !input.snapshot.run) return null;
  const terminal = input.snapshot.run.items.find((item) => (
    item.state === "QUARANTINED_UNRESOLVED"
    && item.identity.listing_key === claim.listing.listing_key
    && item.identity.sku === claim.listing.sku
    && item.identity.store_index === claim.listing.store_index
    && item.execution_package_sha256 === claim.execution_package_artifact_sha256
    && item.owner_permit_sha256 === claim.permit_authorization_sha256
  ));
  if (!terminal) return null;
  if (input.snapshot.run.release_id_sha256 !== claim.frozen_release_id_sha256) {
    fail("terminal run release differs from active global admission");
  }
  const quarantineRoot = join(
    input.root,
    "data/audits/walmart-listing-integrity-quarantine",
  );
  let directories;
  try {
    directories = (await readdir(quarantineRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") directories = [];
    else throw error;
  }
  const matches: Array<{
    disposition: WalmartListingIntegrityMainFailureDisposition;
    file_sha256: string;
  }> = [];
  for (const directory of directories) {
    const dispositionPath = join(quarantineRoot, directory, "failure-disposition.json");
    const shaPath = join(quarantineRoot, directory, "failure-disposition.sha256");
    if (!(await artifactExists(dispositionPath)) || !(await artifactExists(shaPath))) continue;
    const bytes = await readFile(dispositionPath);
    const fileSha = sha256(bytes);
    if ((await readFile(shaPath)).toString("utf8") !== `${fileSha}\n`) {
      fail(`quarantine exact-file SHA differs: ${dispositionPath}`);
    }
    const value = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    ) as WalmartListingIntegrityMainFailureDisposition;
    if (value.schema_version
        !== "walmart-listing-integrity-main-terminal-failure-disposition/v1") {
      continue;
    }
    verifyWalmartListingIntegrityMainFailureDisposition(value);
    if (value.listing.listing_key === claim.listing.listing_key
      && value.listing.sku === claim.listing.sku
      && value.listing.store_index === claim.listing.store_index
      && value.bindings.execution_package_artifact_sha256
        === claim.execution_package_artifact_sha256
      && value.bindings.permit_authorization_sha256
        === claim.permit_authorization_sha256
      && value.bindings.plan_body_sha256 === claim.plan_body_sha256
      && value.bindings.frozen_release_id_sha256 === claim.frozen_release_id_sha256) {
      matches.push({ disposition: value, file_sha256: fileSha });
    }
  }
  let dispositionRebuiltFromReceipt = false;
  if (matches.length > 1) fail("multiple exact MAIN failure dispositions match admission");
  if (matches.length === 0) {
    const custodyRoot = input.custody_root
      ? resolve(input.custody_root) : fail("terminal MAIN recovery lacks custody root");
    if (!isAbsolute(input.custody_root!) || custodyRoot !== input.custody_root
      || await realpath(custodyRoot) !== custodyRoot) {
      fail("terminal MAIN recovery custody root is not canonical");
    }
    const caseRoot = resolve(
      custodyRoot,
      input.snapshot.run.run_id,
      controlCaseId(terminal),
    );
    const caseRelative = relative(custodyRoot, caseRoot);
    if (!caseRelative || caseRelative.startsWith("..") || isAbsolute(caseRelative)) {
      fail("terminal MAIN recovery case escaped custody root");
    }
    const qualificationRevision = terminal.revision - 1;
    if (!Number.isSafeInteger(qualificationRevision) || qualificationRevision < 1) {
      fail("terminal MAIN recovery lacks exact predecessor revision");
    }
    const receiptPath = join(
      caseRoot,
      "operator",
      `r${qualificationRevision}-qualify`,
      "receipt.json",
    );
    const receiptBytes = await exactPrivateArtifactBytes(receiptPath);
    let receipt: Record<string, unknown>;
    try {
      receipt = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(receiptBytes));
    } catch {
      return fail("terminal MAIN Qualification receipt is not exact UTF-8 JSON");
    }
    const qualification = receipt.qualification;
    if (!qualification || typeof qualification !== "object" || Array.isArray(qualification)
      || typeof (qualification as Record<string, unknown>).qualified_at !== "string") {
      fail("terminal MAIN Qualification receipt lacks qualified_at");
    }
    const disposition = buildWalmartListingIntegrityMainFailureDisposition({
      operator_receipt_bytes: receiptBytes,
      expected_listing: {
        listing_key: terminal.identity.listing_key,
        sku: terminal.identity.sku,
        store_index: terminal.identity.store_index,
      },
      expected_execution_package_sha256: claim.execution_package_artifact_sha256,
      expected_owner_permit_sha256: claim.permit_authorization_sha256,
      expected_plan_body_sha256: claim.plan_body_sha256,
      expected_frozen_release_id_sha256: claim.frozen_release_id_sha256,
      created_at: (qualification as Record<string, unknown>).qualified_at as string,
    });
    if (disposition.listing.item_id !== claim.listing.item_id) {
      fail("rebuilt MAIN disposition item ID differs from global admission");
    }
    const published = await publishMainFailureDisposition({
      workspace_root: input.root,
      disposition,
    });
    matches.push({
      disposition,
      file_sha256: published.disposition_file_sha256,
    });
    dispositionRebuiltFromReceipt = true;
  }
  const match = matches[0]!;
  const archived = await completeWalmartListingIntegrityGlobalAdmission({
    binding: input.admission_binding ?? binding(),
    claim: {
      listing: claim.listing,
      permit_authorization_sha256: claim.permit_authorization_sha256,
      execution_package_artifact_sha256: claim.execution_package_artifact_sha256,
      plan_body_sha256: claim.plan_body_sha256,
      frozen_release_id_sha256: claim.frozen_release_id_sha256,
      claimed_at: claim.claimed_at,
    },
    completed_at: match.disposition.created_at,
    outcome: "QUARANTINED_UNRESOLVED",
    evidence_file_sha256: match.file_sha256,
  });
  return {
    status: "RECOVERED_PUBLISHED_MAIN_FAILURE_ADMISSION" as const,
    listing_key: claim.listing.listing_key,
    disposition_id: match.disposition.disposition_id,
    disposition_file_sha256: match.file_sha256,
    disposition_rebuilt_from_receipt: dispositionRebuiltFromReceipt,
    archived,
    walmart_writes: 0 as const,
  };
}

async function verifyQualifiedGallery(input: {
  verification_path: string;
  listing_key: string;
  sku: string;
  item_id: string;
  execution_package_sha256: string;
}): Promise<string> {
  const verification = await exactJson(input.verification_path);
  const body = { ...verification };
  delete body.body_sha256;
  const listing = verification.listing as Record<string, unknown> | undefined;
  const boundary = verification.qualification_boundary as Record<string, unknown> | undefined;
  const checks = verification.checks as Record<string, unknown> | undefined;
  if (verification.status !== "LIVE_SURFACE_PASS"
    || verification.body_sha256 !== sha256(Buffer.from(canonical(body), "utf8"))
    || listing?.listing_key !== input.listing_key
    || listing?.sku !== input.sku
    || listing?.item_id !== input.item_id
    || verification.execution_package_file_sha256 !== input.execution_package_sha256
    || boundary?.next_sku_unblocked !== true
    || !checks || Object.values(checks).some((value) => value !== true)) {
    fail(`qualified gallery differs from exact PASS boundary: ${input.sku}`);
  }
  return String(verification.body_sha256);
}

export async function verifyAuditedPassGallery(input: {
  verification_path: string;
  listing_key: string;
  sku: string;
  item_id: string;
}): Promise<string> {
  const verification = await exactJson(input.verification_path);
  const body = { ...verification };
  delete body.body_sha256;
  const listing = verification.listing as Record<string, unknown> | undefined;
  const boundary = verification.qualification_boundary as Record<string, unknown> | undefined;
  const checks = verification.checks as Record<string, unknown> | undefined;
  if (verification.schema_version
      !== "walmart-listing-integrity-no-change-verification/v1"
    || verification.status !== "LIVE_SURFACE_PASS"
    || verification.completion_mode !== "AUDITED_NO_CHANGE"
    || verification.feed_id !== null
    || verification.exact_payload_sha256 !== null
    || verification.body_sha256 !== sha256(Buffer.from(canonical(body), "utf8"))
    || listing?.listing_key !== input.listing_key
    || listing?.sku !== input.sku
    || listing?.item_id !== input.item_id
    || boundary?.buyer_facing_live_surface_verified !== true
    || boundary?.source_aware_qualification_receipt_emitted !== true
    || boundary?.no_walmart_write_required !== true
    || boundary?.next_sku_unblocked !== true
    || !checks || Object.keys(checks).length < 14
    || Object.values(checks).some((value) => value !== true)) {
    fail(`audited no-change gallery differs from exact PASS boundary: ${input.sku}`);
  }
  return String(verification.body_sha256);
}

function safeGallerySegment(value: string): string {
  const prefix = value.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80) || "sku";
  return `${prefix}-${sha256(Buffer.from(value, "utf8")).slice(0, 12)}`;
}

export async function publishCompletedGallery(input: {
  root: string;
  source_dir: string;
  sku: string;
  completion_mode: "REPAIRED" | "AUDITED_NO_CHANGE";
  body_sha256: string;
}) {
  const sourceVerification = await readFile(join(
    input.source_dir,
    "live-canary-verification.json",
  ));
  const sourceHtml = await readFile(join(input.source_dir, "before-after-gallery.html"));
  const completedRoot = join(
    input.root,
    "data/audits/walmart-listing-integrity-post-canary",
  );
  const destination = join(
    completedRoot,
    `${safeGallerySegment(input.sku)}-${input.completion_mode.toLowerCase()}-${input.body_sha256.slice(0, 16)}`,
  );
  const verificationPath = join(destination, "live-canary-verification.json");
  const galleryPath = join(destination, "before-after-gallery.html");
  if (await artifactExists(verificationPath) || await artifactExists(galleryPath)) {
    if (!(await artifactExists(verificationPath)) || !(await artifactExists(galleryPath))
      || !Buffer.from(await readFile(verificationPath)).equals(sourceVerification)
      || !Buffer.from(await readFile(galleryPath)).equals(sourceHtml)) {
      fail(`published gallery custody differs for ${input.sku}`);
    }
    return {
      status: "GALLERY_ALREADY_PUBLISHED" as const,
      destination,
      verification_file_sha256: sha256(sourceVerification),
      gallery_file_sha256: sha256(sourceHtml),
    };
  }
  await mkdir(completedRoot, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await mkdir(temporary, { mode: 0o700 });
  await writeFile(join(temporary, "live-canary-verification.json"), sourceVerification, {
    flag: "wx",
    mode: 0o400,
  });
  await writeFile(join(temporary, "before-after-gallery.html"), sourceHtml, {
    flag: "wx",
    mode: 0o400,
  });
  await rename(temporary, destination);
  return {
    status: "GALLERY_PUBLISHED" as const,
    destination,
    verification_file_sha256: sha256(sourceVerification),
    gallery_file_sha256: sha256(sourceHtml),
  };
}

async function ensureTerminalGalleries(input: {
  root: string;
  engine_root: string;
  custody_root: string;
  snapshot: Awaited<ReturnType<typeof loadWalmartListingIntegrityControlRunSnapshot>>;
}) {
  if (!input.snapshot.run) return [];
  const outcomes: Array<Record<string, unknown>> = [];
  for (const item of input.snapshot.run.items.filter((row) => (
    row.state === "QUALIFIED_PASS" || row.state === "AUDITED_PASS"
  ))) {
    const caseRoot = join(
      input.custody_root,
      input.snapshot.run.run_id,
      controlCaseId(item),
    );
    const galleryDir = join(caseRoot, "final-gallery");
    const verificationPath = join(galleryDir, "live-canary-verification.json");
    if (item.state === "AUDITED_PASS") {
      if (!(await artifactExists(verificationPath))) {
        fail(`AUDITED_PASS lacks mandatory no-change gallery: ${item.identity.sku}`);
      }
      const bodySha = await verifyAuditedPassGallery({
        verification_path: verificationPath,
        listing_key: item.identity.listing_key,
        sku: item.identity.sku,
        item_id: item.identity.item_id,
      });
      const published = await publishCompletedGallery({
        root: input.root,
        source_dir: galleryDir,
        sku: item.identity.sku,
        completion_mode: "AUDITED_NO_CHANGE",
        body_sha256: bodySha,
      });
      outcomes.push({
        sku: item.identity.sku,
        status: "NO_CHANGE_GALLERY_PASS",
        published,
      });
      continue;
    }
    const executionPackageSha = item.execution_package_sha256;
    if (!executionPackageSha) {
      fail(`QUALIFIED_PASS lacks execution package SHA: ${item.identity.sku}`);
    }
    if (await artifactExists(verificationPath)) {
      const bodySha = await verifyQualifiedGallery({
        verification_path: verificationPath,
        listing_key: item.identity.listing_key,
        sku: item.identity.sku,
        item_id: item.identity.item_id,
        execution_package_sha256: executionPackageSha,
      });
      const published = await publishCompletedGallery({
        root: input.root,
        source_dir: galleryDir,
        sku: item.identity.sku,
        completion_mode: "REPAIRED",
        body_sha256: bodySha,
      });
      outcomes.push({ sku: item.identity.sku, status: "GALLERY_ALREADY_PASS", published });
      continue;
    }
    const qualificationRevision = item.revision - 1;
    if (qualificationRevision < 1) fail("qualified item has no predecessor revision");
    const qualificationRoot = join(
      caseRoot,
      "operator",
      `r${qualificationRevision}-qualify`,
    );
    const packagePath = join(caseRoot, "remediation", "owner-package", "execution-package.json");
    const packageBytes = await readFile(packagePath);
    if (sha256(packageBytes) !== executionPackageSha) {
      fail(`qualified package differs from control state: ${item.identity.sku}`);
    }
    const result = await invokeWalmartListingIntegrityRemediationProcess({
      config: walmartListingIntegrityRemediationConfig(
        input.root,
        input.engine_root,
      ).process,
      command: {
        command: "build-live-gallery",
        before_dir: join(caseRoot, "capture"),
        after_dir: join(qualificationRoot, "capture.evidence"),
        execution_package: packagePath,
        qualification_receipt: join(qualificationRoot, "receipt.json"),
        output_dir: galleryDir,
      },
    });
    if (result.status !== "LIVE_SURFACE_PASS"
      || result.verdict !== "PASS"
      || result.next_sku_unblocked !== true) {
      fail(`recovered factual gallery did not PASS: ${item.identity.sku}`);
    }
    const bodySha = await verifyQualifiedGallery({
      verification_path: verificationPath,
      listing_key: item.identity.listing_key,
      sku: item.identity.sku,
      item_id: item.identity.item_id,
      execution_package_sha256: executionPackageSha,
    });
    const published = await publishCompletedGallery({
      root: input.root,
      source_dir: galleryDir,
      sku: item.identity.sku,
      completion_mode: "REPAIRED",
      body_sha256: bodySha,
    });
    outcomes.push({ sku: item.identity.sku, status: "GALLERY_RECOVERED_PASS", published });
  }
  return outcomes;
}

async function preparedInputs(input: {
  custody_root: string;
  snapshot: Awaited<ReturnType<typeof loadWalmartListingIntegrityControlRunSnapshot>>;
}) {
  const current = activeItem(input.snapshot);
  if (!current || !input.snapshot.run || !OPERATOR.has(current.state)) {
    fail("prepared inputs requested outside the operator lifecycle");
  }
  const caseId = controlCaseId(current);
  const packageRoot = join(
    input.custody_root,
    input.snapshot.run.run_id,
    caseId,
    "remediation",
    "owner-package",
  );
  const packagePath = join(packageRoot, "execution-package.json");
  const permitPath = join(packageRoot, "one-sku-owner-permit.json");
  const [packageBytes, permitBytes] = await Promise.all([
    readFile(packagePath),
    readFile(permitPath),
  ]);
  const packageSha = sha256(packageBytes);
  const permitFileSha = sha256(permitBytes);
  if (packageSha !== current.execution_package_sha256) {
    fail("prepared execution package differs from the control state");
  }
  return {
    package_path: packagePath,
    package_sha256: packageSha,
    permit_path: permitPath,
    permit_file_sha256: permitFileSha,
  };
}

export async function runWalmartListingIntegritySuccessorOnce(input: {
  cwd?: string;
  custody_root: string;
  max_audits: number;
}) {
  const root = resolve(input.cwd ?? process.cwd());
  const engineRoot = CONTROL_ENGINE_ROOT;
  await exactPrivateRoot(input.custody_root);
  const [initialAdmission, beforeSnapshot] = await Promise.all([
    inspectWalmartListingIntegrityGlobalAdmissionRoot(binding()),
    loadWalmartListingIntegrityControlRunSnapshot(),
  ]);
  let admission = initialAdmission;
  const beforeActive = activeItem(beforeSnapshot);
  const occupiedByCurrent = admission.status === "OCCUPIED"
    && admission.active_claim?.listing.listing_key === beforeActive?.identity.listing_key
    && OPERATOR.has(beforeActive?.state ?? "");
  let recoveredMainFailure = null;
  if (admission.status !== "AVAILABLE" && !occupiedByCurrent) {
    recoveredMainFailure = await recoverPublishedMainFailureAdmission({
      root,
      custody_root: input.custody_root,
      snapshot: beforeSnapshot,
      admission,
    });
    if (!recoveredMainFailure) {
      return {
        status: "WAITING_FOR_PREDECESSOR_QUALIFICATION",
        active_listing_key: admission.active_claim?.listing.listing_key ?? null,
        walmart_writes: 0,
        release_id_sha256: RELEASE_ID,
      };
    }
    admission = await inspectWalmartListingIntegrityGlobalAdmissionRoot(binding());
    if (admission.status !== "AVAILABLE") {
      fail("recovered MAIN failure did not release global admission");
    }
  }
  const bootstrap = await seedIfNeeded(root, engineRoot);
  if (bootstrap.status === "CATALOG_COMPLETE") {
    return {
      status: "CATALOG_COMPLETE",
      recovered_main_failure: recoveredMainFailure,
      bootstrap,
      completed_skus: Array.isArray(bootstrap.pool.processed_control_listing_keys)
        ? bootstrap.pool.processed_control_listing_keys.length : null,
      remaining_candidates: 0,
      next_action: "BUILD_FINAL_CATALOG_INTEGRITY_REPORT",
      walmart_writes: 0,
    };
  }
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot();
  const galleries = await ensureTerminalGalleries({
    root,
    engine_root: engineRoot,
    custody_root: input.custody_root,
    snapshot,
  });
  const completed = snapshot.run?.items.filter((item) => TERMINAL.has(item.state)).length ?? 0;
  const current = activeItem(snapshot);
  if (!current && snapshot.run?.status === "ACTIVE" && snapshot.run.items.length > 0) {
    const completedAt = new Date().toISOString();
    const completionEvidence = buildWalmartListingIntegrityRunCompletionEvidence({
      run: snapshot.run,
      galleries,
      completed_at: completedAt,
    });
    const completionBytes = Buffer.from(
      `${JSON.stringify(completionEvidence, null, 2)}\n`,
      "utf8",
    );
    const closed = await completeWalmartListingIntegrityControlRun({
      expected_run: {
        run_id: snapshot.run.run_id,
        pool_body_sha256: snapshot.run.pool_body_sha256,
        release_id_sha256: snapshot.run.release_id_sha256,
        manifest_sha256: snapshot.run.manifest_sha256,
        status: "ACTIVE",
        updated_at: snapshot.run.updated_at,
        items: snapshot.run.items,
      },
      evidence_bytes: completionBytes,
    });
    return {
      status: "CONTROL_EPOCH_COMPLETED",
      recovered_main_failure: recoveredMainFailure,
      bootstrap,
      galleries,
      completed_skus: snapshot.run.items.length,
      completion: closed,
      next_action: "BUILD_FRESH_CATALOG_AND_SEED_NEXT_EPOCH",
      walmart_writes: 0,
    };
  }
  if (!current) {
    return {
      status: "CONTROL_QUEUE_COMPLETE",
      recovered_main_failure: recoveredMainFailure,
      bootstrap,
      galleries,
      completed_skus: completed,
      walmart_writes: 0,
    };
  }
  if (completed >= input.max_audits) {
    return {
      status: "SUCCESSOR_LIMIT_REACHED",
      recovered_main_failure: recoveredMainFailure,
      bootstrap,
      galleries,
      completed_skus: completed,
      requested_skus: input.max_audits,
      walmart_writes: 0,
    };
  }
  let result: Awaited<ReturnType<typeof runWalmartListingIntegrityControlWorker>>;
  if (current.state === "QUEUED" || current.state === "DIAGNOSING") {
    result = await runWalmartListingIntegrityControlWorker({
      command: "audit-once",
      permit_path: null,
      permit_file_sha256: null,
      package_path: null,
      package_sha256: null,
      custody_root: input.custody_root,
    }, { workspace_root: root, engine_root: engineRoot });
  } else if (current.state === "ISSUE_PROVEN") {
    result = await runWalmartListingIntegrityControlWorker({
      command: "prepare-once",
      permit_path: null,
      permit_file_sha256: null,
      package_path: null,
      package_sha256: null,
      custody_root: input.custody_root,
    }, { workspace_root: root, engine_root: engineRoot });
  } else if (OPERATOR.has(current.state)) {
    const prepared = await preparedInputs({ custody_root: input.custody_root, snapshot });
    result = await runWalmartListingIntegrityControlWorker({
      command: "once",
      permit_path: prepared.permit_path,
      permit_file_sha256: prepared.permit_file_sha256,
      package_path: prepared.package_path,
      package_sha256: prepared.package_sha256,
      custody_root: input.custody_root,
    }, { workspace_root: root, engine_root: engineRoot });
  } else {
    return {
      status: "STOPPED_ON_UNSUPPORTED_CONTROL_STATE",
      bootstrap,
      galleries,
      sku: current.identity.sku,
      state: current.state,
      completed_skus: completed,
      walmart_writes: 0,
    };
  }
  const command = "command" in result ? result.command : null;
  return {
    status: "SUCCESSOR_ACTIVE_CYCLE_PROGRESS",
    recovered_main_failure: recoveredMainFailure,
    bootstrap,
    galleries,
    sku: current.identity.sku,
    prior_state: current.state,
    result,
    completed_skus: completed,
    requested_skus: input.max_audits,
    walmart_writes: command === "execute" ? 1 : 0,
    next_action: "CONTINUE_SAME_STRICT_SEQUENCE",
  };
}

async function writeStatus(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
  await rename(temporary, file);
}

async function doctor() {
  const [snapshot, admission] = await Promise.all([
    loadWalmartListingIntegrityControlRunSnapshot(),
    inspectWalmartListingIntegrityGlobalAdmissionRoot(binding()),
  ]);
  return {
    schema_version: "walmart-listing-integrity-successor-doctor/v1",
    status: admission.status === "AVAILABLE" ? "READY" : "WAITING_PREDECESSOR",
    admission_status: admission.status,
    active_listing_key: admission.active_claim?.listing.listing_key ?? null,
    control_installation: snapshot.installation,
    control_run_id: snapshot.run?.run_id ?? null,
    walmart_writes: 0,
  };
}

async function main() {
  const args = parseWalmartListingIntegritySuccessorArgs(process.argv.slice(2));
  if (args.command === "doctor") {
    process.stdout.write(`${JSON.stringify(await doctor())}\n`);
    return;
  }
  if (args.command === "once") {
    process.stdout.write(`${JSON.stringify(await runWalmartListingIntegritySuccessorOnce({
      custody_root: args.custody_root!,
      max_audits: args.max_audits,
    }))}\n`);
    return;
  }
  while (true) {
    const result = await runWalmartListingIntegritySuccessorOnce({
      custody_root: args.custody_root!,
      max_audits: args.max_audits,
    });
    await writeStatus(args.status_path!, {
      schema_version: "walmart-listing-integrity-successor-watch-status/v1",
      checked_at: new Date().toISOString(),
      pid: process.pid,
      ...result,
    });
    if (["SUCCESSOR_LIMIT_REACHED", "CONTROL_QUEUE_COMPLETE", "CATALOG_COMPLETE",
      "STOPPED_ON_UNSUPPORTED_CONTROL_STATE"].includes(result.status)) return;
    const nested = "result" in result && result.result && typeof result.result === "object"
      ? result.result as Record<string, unknown> : null;
    const waitMs = result.status === "WAITING_FOR_PREDECESSOR_QUALIFICATION"
      ? POLL_MS
      : nested?.status === "APPLIED_PROPAGATING"
        || nested?.status === "PENDING_PROPAGATION"
        ? 5 * POLL_MS
        : 1_000;
    await new Promise((accept) => setTimeout(accept, waitMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    const args = (() => {
      try {
        return parseWalmartListingIntegritySuccessorArgs(process.argv.slice(2));
      } catch {
        return null;
      }
    })();
    if (args?.status_path) {
      await writeStatus(args.status_path, {
        schema_version: "walmart-listing-integrity-successor-watch-status/v1",
        status: "STOPPED_ON_ERROR",
        checked_at: new Date().toISOString(),
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
        walmart_writes: 0,
      }).catch(() => undefined);
    }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
