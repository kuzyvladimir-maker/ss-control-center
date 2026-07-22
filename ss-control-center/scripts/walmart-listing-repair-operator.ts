#!/usr/bin/env node

/** Bounded operator surface for the frozen Walmart Listing Integrity repair. */

import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectWalmartListingRepairOwnerTrustReadiness,
  verifyCurrentWalmartListingRepairOneSkuPermit,
  verifyWalmartListingRepairSequenceAuthorization,
  type WalmartListingRepairOneSkuPermit,
} from "../src/lib/walmart/listing-integrity-remediation-authority.ts";
import {
  readWalmartListingRepairArtifactCustodyEvidence,
} from "../src/lib/walmart/listing-integrity-remediation-artifacts.ts";
import {
  parseWalmartListingRepairExecutionPackageBytes,
} from "../src/lib/walmart/listing-integrity-remediation-execution-package.ts";
import {
  readWalmartListingRepairPermitLedgerEvidence,
} from "../src/lib/walmart/listing-integrity-remediation-ledger.ts";
import {
  createWalmartListingRepairProductionDependencies,
} from "../src/lib/walmart/listing-integrity-remediation-production-dependencies.ts";
import {
  inspectWalmartListingRepairQualificationProductionReadiness,
} from "../src/lib/walmart/listing-integrity-remediation-qualification.ts";
import {
  executeWalmartListingRepairOneSku,
  inspectWalmartListingRepairWriterProductionReadiness,
  resumeWalmartListingRepairFeedPoll,
  type WalmartListingRepairProductionExecutionInput,
  type WalmartListingRepairWriterResult,
} from "../src/lib/walmart/listing-integrity-remediation-writer.ts";

export const WALMART_LISTING_REPAIR_OPERATOR_RECEIPT_SCHEMA =
  "walmart-listing-repair-operator-receipt/v1" as const;

type Command = "doctor" | "plan" | "execute" | "resume" | "status" | "report" | "help";
type JsonRecord = Record<string, unknown>;

interface ParsedArgs {
  command: Command;
  package_path: string | null;
  package_sha256: string | null;
  doctor_receipt_path: string | null;
  doctor_receipt_sha256: string | null;
  plan_receipt_path: string | null;
  plan_receipt_sha256: string | null;
  confirm: string | null;
  out: string | null;
}

const COMMAND_FLAGS: Readonly<Record<Command, ReadonlySet<string>>> = Object.freeze({
  doctor: new Set(["out"]),
  plan: new Set(["package", "package-sha256", "doctor-receipt", "doctor-receipt-sha256", "out"]),
  execute: new Set([
    "package", "package-sha256", "doctor-receipt", "doctor-receipt-sha256",
    "plan-receipt", "plan-receipt-sha256", "confirm", "out",
  ]),
  resume: new Set([
    "package", "package-sha256", "doctor-receipt", "doctor-receipt-sha256",
    "plan-receipt", "plan-receipt-sha256", "confirm", "out",
  ]),
  status: new Set(["package", "package-sha256", "out"]),
  report: new Set(["package", "package-sha256", "out"]),
  help: new Set<string>(),
});
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const DOCTOR_MAX_AGE_MS = 15 * 60 * 1_000;
const SHA256 = /^[a-f0-9]{64}$/u;

export class WalmartListingRepairOperatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairOperatorError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairOperatorError(code, message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("NON_CANONICAL_RECEIPT", "operator receipt rejects undefined");
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: string | null, label: string): string {
  if (!value || !SHA256.test(value)) fail("INVALID_CLI", `${label} must be lowercase SHA-256`);
  return value;
}

function exactPath(value: string | null, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    fail("INVALID_CLI", `${label} must be an absolute normalized path`);
  }
  return value;
}

function parseCommand(value: string | undefined): Command {
  const command = value ?? "help";
  if (!["doctor", "plan", "execute", "resume", "status", "report", "help"].includes(command)) {
    fail("INVALID_CLI", `unknown command ${command}`);
  }
  return command as Command;
}

export function parseWalmartListingRepairOperatorArgs(argv: readonly string[]): ParsedArgs {
  const command = parseCommand(argv[0]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") || token.includes("=")) {
      fail("INVALID_CLI", `unsupported argument ${token}`);
    }
    const key = token.slice(2);
    if (!COMMAND_FLAGS[command].has(key) || values.has(key)) {
      fail("INVALID_CLI", `flag --${key} is forbidden or repeated for ${command}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) fail("INVALID_CLI", `flag --${key} needs a value`);
    values.set(key, next);
    index += 1;
  }
  return {
    command,
    package_path: values.get("package") ?? null,
    package_sha256: values.get("package-sha256") ?? null,
    doctor_receipt_path: values.get("doctor-receipt") ?? null,
    doctor_receipt_sha256: values.get("doctor-receipt-sha256") ?? null,
    plan_receipt_path: values.get("plan-receipt") ?? null,
    plan_receipt_sha256: values.get("plan-receipt-sha256") ?? null,
    confirm: values.get("confirm") ?? null,
    out: values.get("out") ?? null,
  };
}

async function readPrivateFile(path: string, maximum = MAX_INPUT_BYTES): Promise<Uint8Array> {
  const metadata = await lstat(path).catch(() => fail("UNSAFE_INPUT", `input does not exist: ${path}`));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0 || metadata.size < 1 || metadata.size > maximum) {
    fail("UNSAFE_INPUT", `input must be one private regular non-hardlinked file: ${path}`);
  }
  if (await realpath(path) !== path) fail("UNSAFE_INPUT", `input path is not canonical: ${path}`);
  return Uint8Array.from(await readFile(path));
}

async function writeExclusivePrivate(path: string, bytes: Uint8Array): Promise<void> {
  const parent = dirname(path);
  const parentStat = await lstat(parent).catch(() => fail("UNSAFE_OUTPUT", "output parent is missing"));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0
    || await realpath(parent) !== parent) {
    fail("UNSAFE_OUTPUT", "output parent must be a private canonical directory");
  }
  const handle = await open(path, "wx", 0o400).catch(() => fail(
    "OUTPUT_EXISTS_OR_UNSAFE",
    "operator output already exists or cannot be created exclusively",
  ));
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readiness() {
  const authority = inspectWalmartListingRepairOwnerTrustReadiness();
  const qualification = inspectWalmartListingRepairQualificationProductionReadiness();
  const writer = inspectWalmartListingRepairWriterProductionReadiness();
  const ready = authority.owner_trust_root_ready
    && qualification.verifier_release_pinned
    && qualification.walmart_native_payload_validator_ready
    && qualification.frozen_apply_writer_attestation_ready
    && writer.apply_writer_release_pinned
    && writer.fixed_dependency_factory_ready
    && writer.native_one_shot_transport_ready
    && !writer.caller_dependency_injection_allowed;
  return Object.freeze({ ready, authority, qualification, writer });
}

/**
 * CLI-only release boundary. Unit tests call the exported state machine
 * directly; an actual operator process must be launched by the external
 * clean-checkout verifier and must carry its two verified hashes.
 */
export function assertWalmartListingRepairFrozenReleaseAttestation(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const current = readiness();
  const releaseId = env.WALMART_LISTING_REPAIR_FROZEN_RELEASE_ID_SHA256;
  const manifestSha = env.WALMART_LISTING_REPAIR_FROZEN_RELEASE_MANIFEST_SHA256;
  if (!releaseId || !SHA256.test(releaseId) || !manifestSha || !SHA256.test(manifestSha)
    || releaseId !== current.writer.apply_engine_release_sha256
    || releaseId !== current.qualification.verifier_engine_release_sha256) {
    fail(
      "RELEASE_ATTESTATION_REQUIRED",
      "operator CLI must be launched through the verified clean-checkout release wrapper",
    );
  }
  if (env.NODE_ENV === "test" || env.WALMART_LISTING_REPAIR_TEST_MODE === "1") {
    fail("TEST_RUNTIME_FORBIDDEN", "production operator CLI rejects test authority/runtime flags");
  }
}

function receipt(body: JsonRecord): JsonRecord {
  const exactBody = {
    schema_version: WALMART_LISTING_REPAIR_OPERATOR_RECEIPT_SCHEMA,
    ...body,
  };
  return Object.freeze({ ...exactBody, body_sha256: sha256(canonicalJson(exactBody)) });
}

function receiptBytes(value: JsonRecord): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

async function loadReceipt(input: {
  path: string | null;
  sha256: string | null;
  command: string;
}): Promise<JsonRecord> {
  const path = exactPath(input.path, `${input.command} receipt path`);
  const expectedSha = exactSha(input.sha256, `${input.command} receipt SHA`);
  const bytes = await readPrivateFile(path, 16 * 1024 * 1024);
  if (sha256(bytes) !== expectedSha) fail("RECEIPT_SHA_MISMATCH", `${input.command} receipt SHA differs`);
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(decoded);
  } catch {
    return fail("INVALID_RECEIPT", `${input.command} receipt is not exact JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || decoded !== `${canonicalJson(parsed)}\n`) {
    fail("INVALID_RECEIPT", `${input.command} receipt is not canonical`);
  }
  const raw = parsed as JsonRecord;
  if (raw.schema_version !== WALMART_LISTING_REPAIR_OPERATOR_RECEIPT_SCHEMA
    || raw.command !== input.command || typeof raw.body_sha256 !== "string") {
    fail("INVALID_RECEIPT", `${input.command} receipt identity differs`);
  }
  const body = { ...raw };
  delete body.body_sha256;
  if (sha256(canonicalJson(body)) !== raw.body_sha256) {
    fail("INVALID_RECEIPT", `${input.command} receipt body SHA differs`);
  }
  return raw;
}

function assertFreshDoctorReceipt(value: JsonRecord, now: Date): void {
  if (typeof value.evaluated_at !== "string") {
    fail("STALE_OPERATOR_RECEIPT", "doctor receipt has no canonical evaluation time");
  }
  const evaluated = new Date(value.evaluated_at);
  if (Number.isNaN(evaluated.getTime()) || evaluated.toISOString() !== value.evaluated_at
    || now.getTime() < evaluated.getTime()
    || now.getTime() - evaluated.getTime() > DOCTOR_MAX_AGE_MS) {
    fail("STALE_OPERATOR_RECEIPT", "doctor receipt is outside the 15-minute freshness window");
  }
}

async function loadExecution(args: ParsedArgs): Promise<{
  execution: WalmartListingRepairProductionExecutionInput;
  package_sha256: string;
  package_artifact_sha256: string;
}> {
  const path = exactPath(args.package_path, "--package");
  const expectedSha = exactSha(args.package_sha256, "--package-sha256");
  const bytes = await readPrivateFile(path);
  const parsed = parseWalmartListingRepairExecutionPackageBytes({
    artifact_bytes: bytes,
    expected_artifact_sha256: expectedSha,
  });
  return {
    execution: parsed.execution,
    package_sha256: String(parsed.artifact.body_sha256),
    package_artifact_sha256: parsed.artifact_sha256,
  };
}

function permitFromExecution(
  execution: WalmartListingRepairProductionExecutionInput,
): WalmartListingRepairOneSkuPermit {
  return structuredClone(execution.writer_input.one_sku_permit) as WalmartListingRepairOneSkuPermit;
}

function externalEffects(networkCalls: number | "BOUNDED_GET_ONLY" = 0) {
  return {
    network_calls: networkCalls,
    model_calls: 0,
    paid_provider_calls: 0,
    database_writes: 0,
    walmart_content_writes: networkCalls === 0 || networkCalls === "BOUNDED_GET_ONLY" ? 0 : 1,
  };
}

async function preflightExecutionPackage(
  execution: WalmartListingRepairProductionExecutionInput,
  now: Date,
) {
  const sequence = verifyWalmartListingRepairSequenceAuthorization(
    execution.writer_input.sequence_authorization,
    now,
  );
  const permit = verifyCurrentWalmartListingRepairOneSkuPermit(
    execution.writer_input.one_sku_permit,
    now,
  );
  const dependencies = createWalmartListingRepairProductionDependencies(execution);
  const built = await dependencies.payload_builder.build({
    plan: execution.writer_input.plan,
    sequence,
    permit,
    request_correlation_id_sha256: sha256(execution.writer_input.request_correlation_id),
    context: execution.writer_input.payload_context,
  });
  dependencies.exact_request_verifier.verifyExactBytes({
    plan: execution.writer_input.plan,
    sequence,
    permit,
    context: execution.writer_input.payload_context,
    request_payload_bytes: built.payload_bytes,
    request_manifest_bytes: built.request_manifest_bytes,
    request_payload_sha256: built.payload_sha256,
    request_manifest_sha256: built.request_manifest_sha256,
  });
  if (built.payload_sha256 !== permit.signed_body.request_payload_sha256
    || built.request_manifest_sha256 !== permit.signed_body.request_manifest_sha256) {
    fail("PERMIT_REQUEST_MISMATCH", "owner permit does not bind the rebuilt exact request bytes");
  }
  await dependencies.verify_target_image_certificate({
    plan: execution.writer_input.plan,
    certificate_bytes: built.qualification_support_artifacts["target-image-certificate.json"],
    context: execution.writer_input.target_image_certificate_context,
    now,
  });
  const ready = await dependencies.rebuild_sequence_ready_proof({
    sequence_authorization: execution.writer_input.sequence_authorization,
    sequence,
    plan: execution.writer_input.plan,
  });
  return { sequence, permit, built, ready };
}

function resultEvidenceHashes(result: WalmartListingRepairWriterResult) {
  const hash = (value: Uint8Array | null) => value ? sha256(value) : null;
  return {
    request_manifest_sha256: hash(result.exact_evidence.request_manifest_bytes),
    request_payload_sha256: hash(result.exact_evidence.request_payload_bytes),
    response_http_receipt_sha256: hash(result.exact_evidence.response_http_receipt_bytes),
    response_payload_sha256: hash(result.exact_evidence.response_payload_bytes),
    feed_status_http_receipt_sha256: hash(result.exact_evidence.feed_status_http_receipt_bytes),
    feed_status_payload_sha256: hash(result.exact_evidence.feed_status_payload_bytes),
  };
}

async function emit(value: JsonRecord, out: string | null): Promise<JsonRecord> {
  const bytes = receiptBytes(value);
  if (out) await writeExclusivePrivate(exactPath(out, "--out"), bytes);
  else process.stdout.write(bytes);
  return value;
}

export async function runWalmartListingRepairOperator(
  args: ParsedArgs,
  now = new Date(),
): Promise<JsonRecord> {
  if (args.command === "help") {
    return emit(receipt({
      command: "help",
      status: "OK",
      commands: ["doctor", "plan", "execute", "resume", "status", "report"],
      marketplace_write_authorized: false,
      external_effects: externalEffects(),
      next_command: "doctor --out <ABS>",
    }), args.out);
  }
  const currentReadiness = readiness();
  if (args.command === "doctor") {
    return emit(receipt({
      command: "doctor",
      evaluated_at: now.toISOString(),
      status: currentReadiness.ready ? "READY" : "NO_GO",
      readiness: currentReadiness,
      marketplace_write_authorized: false,
      external_effects: externalEffects(),
      next_command: currentReadiness.ready
        ? "plan --package <ABS> --package-sha256 <SHA> --doctor-receipt <ABS> --doctor-receipt-sha256 <SHA> --out <ABS>"
        : null,
    }), args.out);
  }

  const loaded = await loadExecution(args);
  if (args.command === "status" || args.command === "report") {
    const permit = permitFromExecution(loaded.execution);
    const ledger = await readWalmartListingRepairPermitLedgerEvidence({
      state_directory: loaded.execution.production_context.ledger_state_directory,
      expected_binding: permit.signed_body.consumption_ledger,
      permit_authorization_sha256: permit.authorization_sha256,
    });
    const state = String((ledger as JsonRecord).state ?? "NOT_INITIALIZED");
    const artifacts = state === "READY" ? null : await readWalmartListingRepairArtifactCustodyEvidence({
      custody_root: loaded.execution.production_context.artifact_custody_root,
      permit,
    });
    const nextCommand = state === "ACCEPTED"
      ? "resume"
      : state === "SUCCEEDED" ? "fresh-live-reread-and-qualification"
      : state === "REQUESTING" || state === "AMBIGUOUS"
        ? null : "owner-review-replan";
    return emit(receipt({
      command: args.command,
      evaluated_at: now.toISOString(),
      status: state,
      execution_package_artifact_sha256: loaded.package_artifact_sha256,
      execution_package_body_sha256: loaded.package_sha256,
      listing: loaded.execution.writer_input.plan.listing,
      ledger,
      artifact_custody: artifacts,
      marketplace_write_authorized: false,
      automatic_reapply_allowed: false,
      external_effects: externalEffects(),
      next_command: nextCommand,
    }), args.out);
  }

  const doctor = await loadReceipt({
    path: args.doctor_receipt_path,
    sha256: args.doctor_receipt_sha256,
    command: "doctor",
  });
  assertFreshDoctorReceipt(doctor, now);
  if (doctor.status !== "READY" || !currentReadiness.ready) {
    fail("DOCTOR_NO_GO", "doctor/current production readiness is NO-GO");
  }

  if (args.command === "plan") {
    const preflight = await preflightExecutionPackage(loaded.execution, now);
    return emit(receipt({
      command: "plan",
      evaluated_at: now.toISOString(),
      status: "READY_TO_EXECUTE_ONE_SKU",
      doctor_receipt_body_sha256: doctor.body_sha256,
      execution_package_artifact_sha256: loaded.package_artifact_sha256,
      execution_package_body_sha256: loaded.package_sha256,
      listing: preflight.permit.signed_body.listing,
      plan_id: preflight.permit.signed_body.plan_id,
      plan_body_sha256: preflight.permit.signed_body.plan_body_sha256,
      permit_authorization_sha256: preflight.permit.authorization_sha256,
      request_manifest_sha256: preflight.built.request_manifest_sha256,
      request_payload_sha256: preflight.built.payload_sha256,
      sequence_ready_proof: preflight.ready,
      marketplace_write_authorized: false,
      automatic_reapply_allowed: false,
      external_effects: externalEffects(),
      next_command: "execute",
    }), args.out);
  }

  const planReceipt = await loadReceipt({
    path: args.plan_receipt_path,
    sha256: args.plan_receipt_sha256,
    command: "plan",
  });
  if (planReceipt.status !== "READY_TO_EXECUTE_ONE_SKU"
    || planReceipt.execution_package_artifact_sha256 !== loaded.package_artifact_sha256
    || planReceipt.doctor_receipt_body_sha256 !== doctor.body_sha256) {
    fail("STALE_OPERATOR_RECEIPT", "doctor/plan receipts do not bind this execution package");
  }
  const permit = permitFromExecution(loaded.execution);
  if (planReceipt.permit_authorization_sha256 !== permit.authorization_sha256) {
    fail("STALE_OPERATOR_RECEIPT", "plan receipt does not bind the exact owner permit");
  }
  const exactConfirm = args.command === "execute"
    ? `EXECUTE_ONE_WALMART_SKU:${permit.signed_body.listing.listing_key}:${permit.signed_body.plan_body_sha256}`
    : `RESUME_EXACT_FEED_GET_ONLY:${permit.authorization_sha256}`;
  if (args.confirm !== exactConfirm) fail("CONFIRMATION_MISMATCH", `exact confirmation required: ${exactConfirm}`);

  const result = args.command === "execute"
    ? await executeWalmartListingRepairOneSku(loaded.execution)
    : await resumeWalmartListingRepairFeedPoll(loaded.execution);
  return emit(receipt({
    command: args.command,
    completed_at: now.toISOString(),
    status: result.status,
    execution_package_artifact_sha256: loaded.package_artifact_sha256,
    execution_package_body_sha256: loaded.package_sha256,
    plan_receipt_body_sha256: planReceipt.body_sha256,
    listing: result.listing,
    plan_id: result.plan_id,
    plan_body_sha256: result.plan_body_sha256,
    permit_authorization_sha256: result.permit_authorization_sha256,
    feed_id: result.feed_id,
    reason_code: result.reason_code,
    marketplace_write_calls: result.marketplace_write_calls,
    automatic_reapply_allowed: false,
    next_action: result.next_action,
    evidence_sha256: resultEvidenceHashes(result),
    transport_counts: result.transport_counts,
    external_effects: args.command === "execute"
      ? { ...result.external_effects, network_calls: result.transport_counts?.total_http_calls ?? 0 }
      : externalEffects("BOUNDED_GET_ONLY"),
    next_command: result.next_action,
  }), args.out);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseWalmartListingRepairOperatorArgs(argv);
  if (args.command !== "help") assertWalmartListingRepairFrozenReleaseAttestation();
  await runWalmartListingRepairOperator(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const payload = {
      schema_version: WALMART_LISTING_REPAIR_OPERATOR_RECEIPT_SCHEMA,
      command: process.argv[2] ?? "help",
      status: "ERROR",
      error_code: error instanceof WalmartListingRepairOperatorError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "unknown error",
      marketplace_write_authorized: false,
      automatic_reapply_allowed: false,
    };
    process.stderr.write(`${canonicalJson(payload)}\n`);
    process.exitCode = 1;
  });
}
