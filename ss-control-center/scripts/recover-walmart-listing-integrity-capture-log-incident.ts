#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { prisma } from "@/lib/prisma";
import {
  recoverWalmartListingIntegrityCaptureLogFalseQuarantine,
  type WalmartListingIntegrityControlState,
} from "@/lib/walmart/listing-integrity-control-plane";
import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "@/lib/walmart/listing-integrity-control-store.server";
import {
  persistWalmartListingIntegrityControlTransition,
} from "@/lib/walmart/listing-integrity-control-transition-store.server";

const PRODUCT_TRUTH_MANIFEST_SHA =
  "94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c";
const RELEASE_ID = "729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c";
const MANIFEST_SHA = "65f6fff8599a8001a5a3b1dfcdaca149aae2f0456c90cc41a6b164a6ec953aff";

type Command = "inspect" | "apply";

interface Args {
  command: Command;
  run_id: string;
  listing_keys: string[];
  custody_root: string;
  output: string;
  expect_binding_sha256: string | null;
}

interface ArtifactRow {
  role: unknown;
  sha256: unknown;
  itemControlId: unknown;
}

function fail(message: string): never {
  throw new Error(`WALMART_CAPTURE_LOG_INCIDENT_RECOVERY_INVALID: ${message}`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(row[key])}`
  )).join(",")}}`;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function exactText(value: string | undefined, label: string, maximum = 768): string {
  if (!value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: string | undefined, label: string): string {
  const parsed = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function absolute(value: string | undefined, label: string): string {
  const parsed = exactText(value, label, 4_096);
  if (!isAbsolute(parsed) || resolve(parsed) !== parsed || parsed.includes("\u0000")) {
    fail(`${label} must be an absolute normalized path`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== "inspect" && command !== "apply") fail("command must be inspect or apply");
  const allowed = new Set([
    "run-id",
    "listing-keys",
    "custody-root",
    "output",
    ...(command === "apply" ? ["expect-binding-sha256"] : []),
  ]);
  const values = new Map<string, string>();
  for (const token of argv.slice(1)) {
    if (!token.startsWith("--") || !token.includes("=")) fail("flags must be exact --name=value");
    const [key, ...rest] = token.slice(2).split("=");
    const value = rest.join("=");
    if (!allowed.has(key) || values.has(key) || !value) fail(`flag --${key} is invalid`);
    values.set(key, value);
  }
  if (values.size !== allowed.size || [...allowed].some((key) => !values.has(key))) {
    fail("required flags are missing");
  }
  const listingKeys = exactText(values.get("listing-keys"), "listing-keys", 4_096).split(",");
  if (listingKeys.length < 1 || new Set(listingKeys).size !== listingKeys.length
    || listingKeys.some((value) => !/^walmart:\d+:[A-Za-z0-9._-]+$/u.test(value))) {
    fail("listing-keys must be one unique exact comma-separated scope");
  }
  return {
    command,
    run_id: exactText(values.get("run-id"), "run-id", 200),
    listing_keys: listingKeys,
    custody_root: absolute(values.get("custody-root"), "custody-root"),
    output: absolute(values.get("output"), "output"),
    expect_binding_sha256: command === "apply"
      ? exactSha(values.get("expect-binding-sha256"), "expect-binding-sha256") : null,
  };
}

async function assertPrivateDirectory(path: string) {
  const stat = await lstat(path).catch(() => fail(`private directory missing: ${path}`));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(path) !== path) {
    fail(`directory is not private canonical custody: ${path}`);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(path)));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid JSON: ${path}`);
  return value as Record<string, unknown>;
}

function caseId(item: WalmartListingIntegrityControlState): string {
  return `case-${item.identity.ordinal}-${sha256(item.identity.listing_key).slice(0, 16)}`;
}

async function buildInspection(args: Args) {
  await assertPrivateDirectory(args.custody_root);
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot();
  const run = snapshot.run;
  if (snapshot.installation !== "INSTALLED" || !run || run.status !== "ACTIVE"
    || run.run_id !== args.run_id || run.release_id_sha256 !== RELEASE_ID
    || run.manifest_sha256 !== MANIFEST_SHA) {
    fail("active control run differs from the exact incident scope");
  }
  const selected = args.listing_keys.map((listingKey) => {
    const matches = run.items.filter((item) => item.identity.listing_key === listingKey);
    if (matches.length !== 1) fail(`exact incident item missing or duplicated: ${listingKey}`);
    return matches[0]!;
  });
  if (selected.some((item, index) => index > 0
      && item.identity.ordinal <= selected[index - 1]!.identity.ordinal)) {
    fail("incident listing keys must follow strict queue order");
  }
  const entries = [];
  for (const item of selected) {
    if (!["QUARANTINED_SOURCE_REQUIRED", "DIAGNOSING"].includes(item.state)
      || item.marketplace_write_calls !== 0 || item.execution_package_sha256 !== null
      || item.owner_permit_sha256 !== null || item.feed_id !== null) {
      fail(`incident state is not recoverable: ${item.identity.listing_key}`);
    }
    const artifacts = await prisma.$queryRawUnsafe<ArtifactRow[]>(`
      SELECT a.role,a.sha256,a.itemControlId
      FROM WalmartListingIntegrityControlArtifact a
      JOIN WalmartListingIntegrityControlItem i ON i.itemControlId=a.itemControlId
      WHERE a.runId=? AND i.listingKey=? AND a.sha256=?
    `, run.run_id, item.identity.listing_key, item.evidence_sha256);
    if (artifacts.length !== 1
      || artifacts[0]?.sha256 !== item.evidence_sha256
      || artifacts[0]?.role !== (item.state === "QUARANTINED_SOURCE_REQUIRED"
        ? "READ_ONLY_CAPTURE_FAILED" : "READ_ONLY_DIAGNOSIS_STARTED")) {
      fail(`incident artifact role/hash differs: ${item.identity.listing_key}`);
    }
    const root = join(args.custody_root, run.run_id, caseId(item));
    const intakePath = join(root, "capture", "intake-index.json");
    let intake: Record<string, unknown> | null = null;
    try {
      intake = await readJson(intakePath);
    } catch (error) {
      if (item.state !== "DIAGNOSING") throw error;
    }
    if (item.state === "QUARANTINED_SOURCE_REQUIRED") {
      const execution = intake?.execution as Record<string, unknown> | undefined;
      if (intake?.status !== "CAPTURED"
        || intake.listing_key !== item.identity.listing_key
        || intake.product_truth_manifest_sha256 !== PRODUCT_TRUTH_MANIFEST_SHA
        || execution?.walmart_writes !== 0 || execution?.database_writes !== 0
        || execution?.model_calls !== 0) {
        fail(`successful zero-write capture proof differs: ${item.identity.listing_key}`);
      }
    } else {
      const files = await readdir(root).catch(() => []);
      if (intake !== null || files.length !== 0) {
        fail(`interrupted diagnosis custody is not empty: ${item.identity.listing_key}`);
      }
    }
    entries.push({
      listing_key: item.identity.listing_key,
      sku: item.identity.sku,
      ordinal: item.identity.ordinal,
      prior_state: item.state,
      prior_revision: item.revision,
      prior_state_body_sha256: item.body_sha256,
      prior_evidence_sha256: item.evidence_sha256,
      prior_artifact_role: artifacts[0]!.role,
      capture_intake_path: intake ? intakePath : null,
      capture_intake_file_sha256: intake ? sha256(await readFile(intakePath)) : null,
    });
  }
  const binding = {
    schema_version: "walmart-listing-integrity-capture-log-incident-binding/v1",
    defect: "WALMART_TRANSPORT_LOG_PREFIX_BEFORE_JSON",
    run: {
      run_id: run.run_id,
      pool_body_sha256: run.pool_body_sha256,
      release_id_sha256: run.release_id_sha256,
      manifest_sha256: run.manifest_sha256,
      updated_at: run.updated_at,
    },
    entries,
    external_effects: { walmart_writes: 0, marketplace_replays: 0 },
  };
  return { snapshot, binding, binding_sha256: sha256(canonicalBytes(binding)) };
}

async function writeExclusive(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o400 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inspection = await buildInspection(args);
  if (args.command === "inspect") {
    const result = {
      schema_version: "walmart-listing-integrity-capture-log-incident-inspection/v1",
      status: "RECOVERY_READY",
      binding: inspection.binding,
      binding_sha256: inspection.binding_sha256,
      database_writes: 0,
      walmart_writes: 0,
    };
    await writeExclusive(args.output, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.expect_binding_sha256 !== inspection.binding_sha256) {
    fail("live incident binding differs from inspected binding");
  }
  const results = [];
  for (const entry of inspection.binding.entries) {
    const current = inspection.snapshot.run!.items.find((item) => (
      item.identity.listing_key === entry.listing_key
    ))!;
    const evidence = {
      schema_version: "walmart-listing-integrity-capture-log-incident-recovery/v1",
      defect: inspection.binding.defect,
      run_id: inspection.snapshot.run!.run_id,
      listing: current.identity,
      prior_state: current.state,
      prior_state_body_sha256: current.body_sha256,
      prior_evidence_sha256: current.evidence_sha256,
      capture_intake_file_sha256: entry.capture_intake_file_sha256,
      action: "REQUEUE_WITHOUT_WALMART_REPLAY",
      walmart_writes: 0,
    };
    const bytes = canonicalBytes(evidence);
    const next = recoverWalmartListingIntegrityCaptureLogFalseQuarantine({
      current,
      recovered_at: new Date().toISOString(),
      recovery_evidence_sha256: sha256(bytes),
    });
    results.push(await persistWalmartListingIntegrityControlTransition({
      current,
      next,
      evidence_bytes: bytes,
      evidence_role: "CAPTURE_LOG_FALSE_QUARANTINE_RECOVERY",
      created_by_principal: "codex-owner-recovery",
    }));
  }
  const after = await loadWalmartListingIntegrityControlRunSnapshot();
  const recovered = args.listing_keys.map((listingKey) => (
    after.run?.items.find((item) => item.identity.listing_key === listingKey)
  ));
  if (recovered.some((item) => !item || item.state !== "QUEUED"
      || item.marketplace_write_calls !== 0)) {
    fail("post-recovery queue verification failed");
  }
  const result = {
    schema_version: "walmart-listing-integrity-capture-log-incident-apply/v1",
    status: "RECOVERED_TO_STRICT_QUEUE",
    binding_sha256: inspection.binding_sha256,
    recovered: recovered.map((item) => ({
      listing_key: item!.identity.listing_key,
      state: item!.state,
      revision: item!.revision,
      body_sha256: item!.body_sha256,
    })),
    transition_results: results,
    database_writes: results.length,
    walmart_writes: 0,
    marketplace_replays: 0,
  };
  await writeExclusive(args.output, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
