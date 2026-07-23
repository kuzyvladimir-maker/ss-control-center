/**
 * Fail-closed one-shot executor for the independently authorized Walmart ITEM
 * v6 replacement request.
 *
 * The module is intentionally standalone and dependency-injected at the HTTP
 * boundary. It performs no DB, model, paid-provider, listing, or prior-session
 * operation. The signed authorization is irreversibly moved to REQUESTING in
 * the single-custody consumption ledger before the transport factory can be
 * opened (and therefore before OAuth or Walmart network access can begin).
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { builtinModules } from "node:module";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  consumeWalmartItemReportReissueAuthorizationV2,
  openWalmartItemReportReissueConsumptionLedgerV2,
  terminalizeWalmartItemReportReissueAuthorizationV2,
  type WalmartItemReportReissueAuthorizationRequestingReceiptV2,
} from "./item-report-reissue-consumption-ledger-v2.ts";
import {
  WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256,
  WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_SCHEMA,
  assertWalmartItemReportReissueAuthorizationCurrent,
  buildWalmartItemReportReissueReplacementPlanV2,
  verifyWalmartItemReportReissueDelegatedAuthorizationV1,
  verifyWalmartItemReportReissueOwnerDispositionV2,
  type WalmartItemReportReissueConsumptionLedgerBindingV2,
  type WalmartItemReportReissueExecutionAuthorization,
  type WalmartItemReportReissueOwnerDispositionV2Environment,
  type WalmartItemReportReissueReplacementPlanV2,
} from "./item-report-reissue-owner-disposition-v2.ts";
import {
  WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
  canonicalWalmartItemReportJson,
  walmartItemReportTrustedExchangeSha256,
  walmartItemReportSha256,
  walmartItemReportUtf8Sha256,
  type HttpResponseCaptureMetadata,
} from "./item-report-published-source.ts";
import {
  WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
  computeWalmartSellerAccountFingerprint,
  type WalmartItemReportAtomicTransport,
  type WalmartItemReportAtomicTransportRequest,
  type WalmartItemReportAtomicTransportResponse,
  type WalmartItemReportHttpCallCounts,
} from "./item-report-capture-session.ts";

export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_POLICY =
  "walmart-item-report-reissue-executor/2.0.0" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PREFLIGHT_SCHEMA =
  "walmart-item-report-reissue-executor-preflight/v2" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA =
  "walmart-item-report-reissue-execution-checkpoint/v2" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_SCHEMA =
  "walmart-item-report-reissue-v2-frozen-engine/1.0.0" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_POLICY =
  "walmart-item-report-reissue-v2-engine-freeze-policy/1.0.0" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT =
  "scripts/walmart-item-report-reissue-v2-frozen-executor.mjs" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE =
  "walmart-item-report-reissue-v2-frozen-executor.bundle.mjs" as const;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS = 60_000;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PRE_BURN_HEADROOM_MS = 65_000;
export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES = 1024 * 1024;

export const WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER = Object.freeze([
  "execute-create",
  "--engine-manifest",
  "--expect-engine-manifest-sha256",
  "--expect-frozen-bundle-sha256",
  "--source-evidence",
  "--expect-source-evidence-sha256",
  "--owner-disposition",
  "--expect-owner-disposition-sha256",
  "--ledger-state-directory",
  "--store-index",
] as const);

const CREATE_BODY = Buffer.from("{}", "utf8");
const LOADED_EXECUTOR_MODULE_PATH = fileURLToPath(import.meta.url);
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o400;
const REQUIRED_ENGINE_SOURCE_INPUTS = Object.freeze([
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
  "scripts/capture-walmart-item-report-source.mjs",
  "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts",
  "src/lib/walmart/item-report-reissue-executor-v2.ts",
  "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  "src/lib/walmart/owner-control-trust-root.ts",
  "src/lib/walmart/item-report-reissue-permit.ts",
  "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts",
  "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
  "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts",
  "src/lib/walmart/item-report-capture-session.ts",
  "src/lib/walmart/item-report-published-source.ts",
]);
const REQUIRED_CERTIFICATION_BINDINGS = Object.freeze({
  CAPTURE_SESSION_TEST: "src/lib/walmart/__tests__/item-report-capture-session.test.mjs",
  EXECUTOR_ENTRYPOINT: "scripts/walmart-item-report-reissue-v2-frozen-executor.mjs",
  EXECUTOR_ENTRYPOINT_TEST:
    "scripts/__tests__/walmart-item-report-reissue-v2-frozen-executor.test.mjs",
  EXECUTOR_FREEZER: "scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs",
  EXECUTOR_FREEZER_TEST:
    "scripts/__tests__/freeze-walmart-item-report-reissue-v2-executor-engine.test.mjs",
  EXECUTOR_MODULE: "src/lib/walmart/item-report-reissue-executor-v2.ts",
  EXECUTOR_TEST: "src/lib/walmart/__tests__/item-report-reissue-executor-v2.test.mjs",
  FREEZER_PRIMITIVE: "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs",
  FREEZER_PRIMITIVE_TEST:
    "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs",
  LEDGER_MODULE: "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts",
  LEDGER_TEST:
    "src/lib/walmart/__tests__/item-report-reissue-consumption-ledger-v2.test.mjs",
  OWNER_DISPOSITION_MODULE: "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  OWNER_DISPOSITION_TEST:
    "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs",
  OWNER_CONTROL_TRUST_ROOT: "src/lib/walmart/owner-control-trust-root.ts",
  ABSENCE_PROBE_EVIDENCE_MODULE:
    "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts",
  ABSENCE_PROBE_EVIDENCE_TEST:
    "scripts/__tests__/capture-walmart-item-v6-absence-probe.test.mjs",
  SOURCE_EVIDENCE_MODULE: "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
  SOURCE_EVIDENCE_TEST:
    "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs",
  SOURCE_EVIDENCE_RENEWAL_MODULE:
    "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts",
  SOURCE_EVIDENCE_RENEWAL_TEST:
    "src/lib/walmart/__tests__/item-report-reissue-source-evidence-renewal-v1.test.mjs",
} as const);
const NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((name) => (
    name.startsWith("node:") ? [name] : [name, `node:${name}`]
  )),
);
const CONTINUATION_ENTRYPOINT = "scripts/capture-walmart-item-report-source.mjs";
const CONTINUATION_PHASES = Object.freeze(["poll", "download", "compile"] as const);

type JsonRecord = Record<string, unknown>;

export interface WalmartItemReportReissueExecutorV2Artifact {
  bytes: Uint8Array;
  expected_artifact_sha256: string;
}

export interface WalmartItemReportReissueExecutorV2ActiveAccount {
  store_index: number;
  seller_id: string;
  client_id: string;
  /** Test-only escape hatch for the fixed incident fingerprint fixture. */
  test_only_seller_account_fingerprint_sha256?: string;
}

export interface WalmartItemReportReissueExecutorV2Input {
  frozen_engine_manifest: WalmartItemReportReissueExecutorV2Artifact;
  frozen_bundle: WalmartItemReportReissueExecutorV2Artifact;
  source_evidence: WalmartItemReportReissueExecutorV2Artifact;
  owner_disposition: WalmartItemReportReissueExecutorV2Artifact;
  expected_environment?: WalmartItemReportReissueOwnerDispositionV2Environment;
  /** Test fixture trust root; production frozen callers must omit this. */
  owner_trust_env?: NodeJS.ProcessEnv;
  active_account: WalmartItemReportReissueExecutorV2ActiveAccount;
  ledger_state_directory: string;
  capture_root: string;
}

export interface WalmartItemReportReissueExecutorV2TransportAccountBinding {
  channel: "WALMART_US";
  store_index: number;
  seller_id: string;
  seller_account_fingerprint_sha256: string;
}

export interface WalmartItemReportReissueExecutorV2Transport
  extends WalmartItemReportAtomicTransport {
  get_http_call_counts(): WalmartItemReportHttpCallCounts;
  /** Derived by the transport factory from the same credentials used for OAuth. */
  get_account_binding(): WalmartItemReportReissueExecutorV2TransportAccountBinding;
}

export interface WalmartItemReportReissueExecutorV2Dependencies {
  /** Must construct a fresh, unused transport. Called only after ledger burn. */
  open_transport(): WalmartItemReportReissueExecutorV2Transport;
  now?: () => Date;
  after_immutable_write?: (relative_path: string) => void | Promise<void>;
}

export interface WalmartItemReportReissueExecutorV2Preflight {
  schema_version: typeof WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PREFLIGHT_SCHEMA;
  policy_id: typeof WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_POLICY;
  status: "READY_FOR_IRREVERSIBLE_SINGLE_EXECUTION";
  engine_manifest_artifact_sha256: string;
  frozen_bundle_artifact_sha256: string;
  source_evidence_artifact_sha256: string;
  owner_disposition_artifact_sha256: string;
  authorization_sha256: string;
  effective_deadline: string;
  account_scope: {
    channel: "WALMART_US";
    store_index: number;
    seller_id: string;
    seller_account_fingerprint_sha256: string;
  };
  replacement: WalmartItemReportReissueReplacementPlanV2;
  consumption_ledger: WalmartItemReportReissueConsumptionLedgerBindingV2;
  ledger_state_directory: string;
  replacement_session_directory: string;
  request: {
    method: "POST";
    endpoint: "/v3/reports/reportRequests";
    query: { reportType: "ITEM"; reportVersion: "v6" };
    body_sha256: string;
    timeout_ms_maximum: 60_000;
    redirects: 0;
    retries: 0;
  };
  external_effects: {
    filesystem_writes: 0;
    ledger_writes: 0;
    oauth_token_calls: 0;
    walmart_api_calls: 0;
    database_calls: 0;
    model_calls: 0;
    paid_provider_calls: 0;
    listing_content_writes: 0;
    prior_session_writes: 0;
  };
  next_action: {
    kind: "IRREVERSIBLE_EXECUTE";
    authorization_will_be_burned_before_oauth: true;
    automatic_retry_allowed: false;
  };
}

export interface WalmartItemReportReissueExecutorV2Result {
  status: "REQUESTED";
  authorization_sha256: string;
  replacement_session_directory: string;
  request_id: string;
  request_id_sha256: string;
  http_status: 200 | 201;
  http_calls: WalmartItemReportHttpCallCounts;
  authorization_consumed_before_oauth: true;
  automatic_retry_allowed: false;
  prior_session_writes: 0;
  database_calls: 0;
  model_calls: 0;
  paid_provider_calls: 0;
  listing_content_writes: 0;
}

export class WalmartItemReportReissueExecutorV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissueExecutorV2Error";
    this.code = code;
  }
}

export class WalmartItemReportReissueExecutorV2ManualReviewError
  extends WalmartItemReportReissueExecutorV2Error {
  readonly reason_code: string;
  readonly replacement_session_directory: string | null;

  constructor(reasonCode: string, sessionDirectory: string | null, message: string) {
    super("MANUAL_REVIEW_REQUIRED", message);
    this.name = "WalmartItemReportReissueExecutorV2ManualReviewError";
    this.reason_code = reasonCode;
    this.replacement_session_directory = sessionDirectory;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissueExecutorV2Error(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_INPUT", `${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_FROZEN_ENGINE", `${label} has missing or extra fields`);
  }
}

function exactString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${label} must be one exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail("INVALID_INPUT", `${label} must be SHA-256`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("INVALID_INPUT", `${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotArtifact(
  artifact: WalmartItemReportReissueExecutorV2Artifact,
  label: string,
): { bytes: Buffer; sha256: string } {
  if (!isRecord(artifact) || !(artifact.bytes instanceof Uint8Array)
    || artifact.bytes.byteLength === 0) {
    fail("INVALID_INPUT", `${label} exact bytes are required`);
  }
  const bytes = Buffer.from(artifact.bytes);
  const expected = digest(artifact.expected_artifact_sha256, `${label} expected SHA-256`);
  if (sha256(bytes) !== expected) {
    fail("ARTIFACT_HASH_MISMATCH", `${label} exact bytes differ from expected SHA-256`);
  }
  return { bytes, sha256: expected };
}

function parseCanonicalJson(bytes: Uint8Array, label: string): JsonRecord {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("INVALID_ARTIFACT", `${label} must contain UTF-8 JSON`);
  }
  const parsed = record(value, label);
  if (text !== canonicalWalmartItemReportJson(parsed)) {
    fail("NON_CANONICAL_ARTIFACT", `${label} must use canonical compact JSON bytes`);
  }
  return parsed;
}

function canonicalRelative(value: unknown, label: string): string {
  const parsed = exactString(value, label);
  if (parsed.includes("\\") || path.posix.isAbsolute(parsed) || parsed === "."
    || parsed.startsWith("../") || path.posix.normalize(parsed) !== parsed) {
    fail("INVALID_FROZEN_ENGINE", `${label} must be canonical project-relative path`);
  }
  return parsed;
}

function parseHashedInventory(value: unknown, label: string): Array<{
  relative_path: string;
  byte_length: number;
  sha256: string;
}> {
  if (!Array.isArray(value) || value.length === 0) {
    fail("INVALID_FROZEN_ENGINE", `${label} must be non-empty`);
  }
  const parsed = value.map((entry, index) => {
    const item = record(entry, `${label}[${index}]`);
    exactKeys(item, ["byte_length", "relative_path", "sha256"], `${label}[${index}]`);
    return {
      relative_path: canonicalRelative(item.relative_path, `${label}[${index}].relative_path`),
      byte_length: nonNegativeInteger(item.byte_length, `${label}[${index}].byte_length`),
      sha256: digest(item.sha256, `${label}[${index}].sha256`),
    };
  });
  const sorted = [...parsed].sort((left, right) => (
    left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0
  ));
  if (canonicalWalmartItemReportJson(parsed) !== canonicalWalmartItemReportJson(sorted)
    || new Set(parsed.map((entry) => entry.relative_path)).size !== parsed.length) {
    fail("INVALID_FROZEN_ENGINE", `${label} must be sorted and unique`);
  }
  return parsed;
}

async function verifyFrozenEngine(
  manifestBytes: Uint8Array,
  manifestSha256: string,
  bundleBytes: Uint8Array,
  bundleSha256: string,
  environment: WalmartItemReportReissueOwnerDispositionV2Environment,
): Promise<{ canonical_capture_root: string }> {
  const manifest = parseCanonicalJson(manifestBytes, "frozen engine manifest");
  exactKeys(manifest, [
    "build", "bundle", "certification_files", "certification_files_sha256",
    "capture", "entrypoint", "external_runtime_imports", "policy_id",
    "project_root_realpath_sha256", "runtime", "schema_version",
    "source_inputs", "source_inputs_sha256",
  ], "frozen engine manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_SCHEMA
    || manifest.policy_id !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_POLICY) {
    fail("INVALID_FROZEN_ENGINE", "frozen engine schema/policy is not the executor release");
  }
  if (sha256(manifestBytes) !== manifestSha256 || sha256(bundleBytes) !== bundleSha256) {
    fail("ARTIFACT_HASH_MISMATCH", "frozen engine bytes drifted");
  }
  digest(manifest.project_root_realpath_sha256, "project_root_realpath_sha256");
  const bundle = record(manifest.bundle, "frozen engine bundle");
  exactKeys(bundle, ["byte_length", "file_name", "sha256"], "frozen engine bundle");
  if (bundle.file_name !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE
    || positiveInteger(bundle.byte_length, "bundle.byte_length") !== bundleBytes.byteLength
    || digest(bundle.sha256, "bundle.sha256") !== bundleSha256) {
    fail("INVALID_FROZEN_ENGINE", "frozen executor bundle binding differs");
  }
  const entrypoint = record(manifest.entrypoint, "frozen engine entrypoint");
  exactKeys(entrypoint, [
    "argument_style", "bundle_file_name", "command", "exact_argv_order",
    "source_relative_path",
  ], "frozen engine entrypoint");
  if (entrypoint.source_relative_path
      !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT
    || entrypoint.bundle_file_name !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE
    || entrypoint.command !== "execute-create"
    || entrypoint.argument_style !== "--name=value"
    || !sameJson(
      entrypoint.exact_argv_order,
      WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER,
    )) {
    fail("INVALID_FROZEN_ENGINE", "frozen engine is not the exact execute-create entrypoint");
  }
  const sourceInputs = parseHashedInventory(manifest.source_inputs, "source_inputs");
  if (digest(manifest.source_inputs_sha256, "source_inputs_sha256")
      !== sha256(Buffer.from(canonicalWalmartItemReportJson(sourceInputs), "utf8"))
    || REQUIRED_ENGINE_SOURCE_INPUTS.some((required) => !sourceInputs.some(
      (entry) => entry.relative_path === required,
    ))) {
    fail("INVALID_FROZEN_ENGINE", "frozen engine source closure is incomplete");
  }
  if (!Array.isArray(manifest.certification_files) || manifest.certification_files.length === 0) {
    fail("INVALID_FROZEN_ENGINE", "frozen engine certification inventory is empty");
  }
  const certifications = manifest.certification_files.map((entry, index) => {
    const item = record(entry, `certification_files[${index}]`);
    exactKeys(item, ["byte_length", "relative_path", "role", "sha256"],
      `certification_files[${index}]`);
    return {
      relative_path: canonicalRelative(item.relative_path, `certification_files[${index}].relative_path`),
      byte_length: nonNegativeInteger(item.byte_length, `certification_files[${index}].byte_length`),
      role: exactString(item.role, `certification_files[${index}].role`, 128),
      sha256: digest(item.sha256, `certification_files[${index}].sha256`),
    };
  });
  const sortedCertifications = [...certifications].sort((left, right) => (
    left.role < right.role ? -1
      : left.role > right.role ? 1
        : left.relative_path < right.relative_path ? -1
          : left.relative_path > right.relative_path ? 1 : 0
  ));
  if (digest(manifest.certification_files_sha256, "certification_files_sha256")
      !== sha256(Buffer.from(canonicalWalmartItemReportJson(certifications), "utf8"))
    || !sameJson(certifications, sortedCertifications)
    || new Set(certifications.map((entry) => entry.role)).size !== certifications.length
    || certifications.length !== Object.keys(REQUIRED_CERTIFICATION_BINDINGS).length
    || certifications.some((entry) => (
      REQUIRED_CERTIFICATION_BINDINGS[
        entry.role as keyof typeof REQUIRED_CERTIFICATION_BINDINGS
      ] !== entry.relative_path
    ))) {
    fail("INVALID_FROZEN_ENGINE", "frozen executor certification binding is incomplete");
  }

  const capture = record(manifest.capture, "frozen engine capture binding");
  exactKeys(capture, [
    "canonical_root", "canonical_root_realpath_sha256", "continuation_entrypoint",
    "continuation_phases", "request_phase_retired_outside_this_executor",
  ], "frozen engine capture binding");
  const canonicalCaptureRoot = exactAbsolute(capture.canonical_root, "capture.canonical_root");
  if (digest(capture.canonical_root_realpath_sha256, "capture root path SHA-256")
      !== sha256(Buffer.from(canonicalCaptureRoot, "utf8"))
    || capture.continuation_entrypoint !== CONTINUATION_ENTRYPOINT
    || !sameJson(capture.continuation_phases, CONTINUATION_PHASES)
    || capture.request_phase_retired_outside_this_executor !== true) {
    fail("INVALID_FROZEN_ENGINE", "frozen capture/continuation binding is invalid");
  }

  const runtime = record(manifest.runtime, "frozen engine runtime");
  exactKeys(runtime, [
    "arch", "exec_path_artifact_sha256", "exec_path_realpath_sha256",
    "node_options_required", "node_path_required", "node_version", "platform",
    "required_exec_argv",
  ], "frozen engine runtime");
  const nodePath = await realpath(process.execPath).catch(() => {
    fail("INVALID_FROZEN_ENGINE", "Node executable realpath cannot be resolved");
  });
  const nodeArtifact = await readStableRuntimeFile(nodePath, "Node executable", {
    single_link: false,
  });
  if (runtime.node_version !== process.version
    || runtime.platform !== process.platform
    || runtime.arch !== process.arch
    || digest(runtime.exec_path_realpath_sha256, "runtime executable path SHA-256")
      !== sha256(Buffer.from(nodePath, "utf8"))
    || digest(runtime.exec_path_artifact_sha256, "runtime executable artifact SHA-256")
      !== sha256(nodeArtifact)
    || !sameJson(runtime.required_exec_argv, [])
    || runtime.node_options_required !== "ABSENT"
    || runtime.node_path_required !== "ABSENT") {
    fail("INVALID_FROZEN_ENGINE", "frozen executor runtime differs from the current runtime");
  }

  const build = record(manifest.build, "frozen engine build");
  exactKeys(build, [
    "bundle", "charset", "esbuild_version", "external_policy", "format",
    "legal_comments", "metafile", "packages", "platform", "sourcemap", "tool",
    "tree_shaking", "write",
  ], "frozen engine build");
  if (build.tool !== "esbuild" || typeof build.esbuild_version !== "string"
    || build.esbuild_version.length === 0 || build.bundle !== true
    || build.packages !== "bundle" || build.platform !== "node" || build.format !== "esm"
    || build.sourcemap !== false || build.metafile !== true || build.write !== false
    || build.legal_comments !== "none" || build.charset !== "utf8"
    || build.tree_shaking !== false || build.external_policy !== "NODE_BUILTINS_ONLY") {
    fail("INVALID_FROZEN_ENGINE", "frozen executor build contract is invalid");
  }

  if (!Array.isArray(manifest.external_runtime_imports)
    || manifest.external_runtime_imports.length === 0
    || manifest.external_runtime_imports.some((entry) => (
      typeof entry !== "string" || !/^node:[a-z0-9_./-]+$/u.test(entry)
        || !NODE_BUILTIN_SPECIFIERS.has(entry)
    ))
    || !sameJson(
      manifest.external_runtime_imports,
      [...manifest.external_runtime_imports].sort(),
    )
    || new Set(manifest.external_runtime_imports).size
      !== manifest.external_runtime_imports.length) {
    fail("INVALID_FROZEN_ENGINE", "frozen executor external runtime closure is invalid");
  }

  if (environment === "PRODUCTION") {
    if (process.execArgv.length !== 0
      || Object.prototype.hasOwnProperty.call(process.env, "NODE_OPTIONS")
      || Object.prototype.hasOwnProperty.call(process.env, "NODE_PATH")) {
      fail("INVALID_RUNTIME", "production frozen executor requires an unmodified Node runtime");
    }
    const invoked = exactAbsolute(process.argv[1], "loaded frozen executor path");
    const loadedModulePath = await realpath(LOADED_EXECUTOR_MODULE_PATH).catch(() => null);
    if (loadedModulePath !== invoked
      || path.basename(invoked) !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE
      || await realpath(invoked).catch(() => null) !== invoked) {
      fail(
        "LOADED_CODE_BINDING_MISMATCH",
        "currently executing module is not the exact frozen bundle entrypoint",
      );
    }
    const loadedBytes = await readStableRuntimeFile(invoked, "loaded frozen executor", {
      exact_mode: FILE_MODE,
      single_link: true,
    });
    if (sha256(loadedBytes) !== bundleSha256
      || !Buffer.from(loadedBytes).equals(Buffer.from(bundleBytes))) {
      fail("LOADED_CODE_BINDING_MISMATCH", "loaded executor bytes differ from signed frozen bytes");
    }
  }
  return { canonical_capture_root: canonicalCaptureRoot };
}

function nowDate(now: (() => Date) | undefined): Date {
  const value = now?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_CLOCK", "executor clock is invalid");
  }
  return new Date(value.getTime());
}

function assertFullExecutionHeadroom(
  disposition: WalmartItemReportReissueExecutionAuthorization,
  now: Date,
): string {
  const effectiveDeadline = assertWalmartItemReportReissueAuthorizationCurrent(
    disposition,
    now,
  );
  if (Date.parse(effectiveDeadline) - now.getTime()
      < WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PRE_BURN_HEADROOM_MS) {
    fail(
      "INSUFFICIENT_AUTHORIZATION_HEADROOM",
      "authorization must retain the full request timeout plus safety margin",
    );
  }
  return effectiveDeadline;
}

function normalizeDarwinAlias(value: string): string {
  if (process.platform !== "darwin") return value;
  for (const [alias, canonical] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]]) {
    if (value === alias || value.startsWith(`${alias}/`)) {
      return `${canonical}${value.slice(alias.length)}`;
    }
  }
  return value;
}

function exactAbsolute(value: unknown, label: string): string {
  const parsed = exactString(value, label);
  if (!path.isAbsolute(parsed) || path.normalize(parsed) !== parsed || parsed.includes("\0")) {
    fail("INVALID_PATH", `${label} must be an exact normalized absolute path`);
  }
  return normalizeDarwinAlias(parsed);
}

interface StableDirectoryCustody {
  path: string;
  canonical_path: string;
  dev: string;
  ino: string;
  uid: string;
  gid: string;
  mode: number;
}

function requiredNoFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_NOFOLLOW is required for executor custody");
  }
  return fsConstants.O_NOFOLLOW;
}

function requiredDirectoryFlag(): number {
  if (typeof fsConstants.O_DIRECTORY !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_DIRECTORY is required for executor custody");
  }
  return fsConstants.O_DIRECTORY;
}

function sameFsIdentity(
  left: { dev: bigint | number; ino: bigint | number },
  right: { dev: bigint | number; ino: bigint | number },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameStableFileStat(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return sameFsIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameStableRuntimeStat(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableRuntimeFile(
  absolutePath: string,
  label: string,
  options: { exact_mode?: number; single_link?: boolean } = {},
): Promise<Buffer> {
  const before = await lstat(absolutePath).catch(() => {
    fail("INVALID_FROZEN_ENGINE", `${label} is missing`);
  });
  if (!before.isFile() || before.isSymbolicLink()
    || (options.single_link !== false && before.nlink !== 1)
    || (options.exact_mode !== undefined && (before.mode & 0o777) !== options.exact_mode)
    || await realpath(absolutePath).catch(() => null) !== absolutePath) {
    fail("INVALID_FROZEN_ENGINE", `${label} does not have stable regular-file custody`);
  }
  const handle = await open(absolutePath, fsConstants.O_RDONLY | requiredNoFollowFlag());
  try {
    const opened = await handle.stat();
    if (!sameStableRuntimeStat(before, opened)) {
      fail("INVALID_FROZEN_ENGINE", `${label} raced before descriptor read`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(absolutePath);
    if (!sameStableRuntimeStat(opened, afterHandle)
      || !sameStableRuntimeStat(afterHandle, afterPath)
      || bytes.byteLength !== afterHandle.size) {
      fail("INVALID_FROZEN_ENGINE", `${label} raced during descriptor read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameDirectoryCustody(
  left: StableDirectoryCustody,
  right: StableDirectoryCustody,
): boolean {
  return left.path === right.path
    && left.canonical_path === right.canonical_path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

async function inspectPrivateDirectory(
  directory: string,
  label: string,
): Promise<StableDirectoryCustody> {
  const pathBefore = await lstat(directory, { bigint: true }).catch(() => {
    fail("INVALID_PATH", `${label} does not exist`);
  });
  const canonicalBefore = await realpath(directory).catch(() => {
    fail("INVALID_PATH", `${label} realpath cannot be resolved`);
  });
  if (!pathBefore.isDirectory() || pathBefore.isSymbolicLink()
    || Number(pathBefore.mode & 0o777n) !== DIRECTORY_MODE
    || canonicalBefore !== directory) {
    fail("INVALID_PATH", `${label} must be one private real 0700 directory`);
  }
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | requiredNoFollowFlag() | requiredDirectoryFlag(),
  ).catch(() => {
    fail("INVALID_PATH", `${label} cannot be opened without following links`);
  });
  let opened;
  try {
    opened = await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(directory, { bigint: true }).catch(() => {
    fail("INVALID_PATH", `${label} changed while inspected`);
  });
  const canonicalAfter = await realpath(directory).catch(() => {
    fail("INVALID_PATH", `${label} realpath changed while inspected`);
  });
  if (!opened.isDirectory() || !sameFsIdentity(pathBefore, opened)
    || !sameFsIdentity(opened, pathAfter)
    || Number(opened.mode & 0o777n) !== DIRECTORY_MODE
    || Number(pathAfter.mode & 0o777n) !== DIRECTORY_MODE
    || canonicalAfter !== canonicalBefore
    || (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid()))) {
    fail("INVALID_PATH", `${label} identity, ownership, or mode is unstable`);
  }
  return {
    path: directory,
    canonical_path: canonicalAfter,
    dev: String(opened.dev),
    ino: String(opened.ino),
    uid: String(opened.uid),
    gid: String(opened.gid),
    mode: Number(opened.mode & 0o777n),
  };
}

async function assertDirectoryCustody(
  expected: StableDirectoryCustody,
  label: string,
): Promise<void> {
  if (!sameDirectoryCustody(expected, await inspectPrivateDirectory(expected.path, label))) {
    fail("INVALID_PATH", `${label} identity changed`);
  }
}

function rawSignedBody(value: JsonRecord): JsonRecord {
  return record(value.signed_body, "owner disposition signed_body");
}

function expectedReplacementFromRawDisposition(
  value: JsonRecord,
): WalmartItemReportReissueReplacementPlanV2 {
  const body = rawSignedBody(value);
  const replacement = record(body.replacement, "owner disposition replacement");
  return buildWalmartItemReportReissueReplacementPlanV2({
    session_name: exactString(replacement.session_name, "replacement.session_name", 200),
    session_authority: replacement.session_authority,
  });
}

function expectedLedgerFromRawDisposition(
  value: JsonRecord,
): WalmartItemReportReissueConsumptionLedgerBindingV2 {
  const body = rawSignedBody(value);
  return record(
    body.consumption_ledger,
    "owner disposition consumption_ledger",
  ) as unknown as WalmartItemReportReissueConsumptionLedgerBindingV2;
}

function exactAccount(
  input: WalmartItemReportReissueExecutorV2ActiveAccount,
  environment: WalmartItemReportReissueOwnerDispositionV2Environment,
): {
  channel: "WALMART_US";
  store_index: number;
  seller_id: string;
  seller_account_fingerprint_sha256: string;
} {
  const storeIndex = positiveInteger(input.store_index, "active_account.store_index");
  const sellerId = exactString(input.seller_id, "active_account.seller_id", 256);
  const clientId = exactString(input.client_id, "active_account.client_id", 512);
  const computed = computeWalmartSellerAccountFingerprint({
    store_index: storeIndex,
    client_id: clientId,
    seller_id: sellerId,
  });
  let fingerprint = computed;
  if (input.test_only_seller_account_fingerprint_sha256 !== undefined) {
    if (environment !== "TEST_FIXTURE_ONLY") {
      fail("TEST_OVERRIDE_FORBIDDEN", "account fingerprint override is forbidden in production");
    }
    fingerprint = digest(
      input.test_only_seller_account_fingerprint_sha256,
      "active_account.test_only_seller_account_fingerprint_sha256",
    );
  }
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    seller_id: sellerId,
    seller_account_fingerprint_sha256: fingerprint,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

interface PreparedExecution {
  preflight: WalmartItemReportReissueExecutorV2Preflight;
  disposition: WalmartItemReportReissueExecutionAuthorization;
  owner_disposition_bytes: Buffer;
  capture_root: string;
  capture_root_custody: StableDirectoryCustody;
}

function verifyExecutionAuthorization(
  raw: JsonRecord,
  options: Parameters<typeof verifyWalmartItemReportReissueOwnerDispositionV2>[1],
): WalmartItemReportReissueExecutionAuthorization {
  return raw.schema_version
      === WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_SCHEMA
    ? verifyWalmartItemReportReissueDelegatedAuthorizationV1(raw, options)
    : verifyWalmartItemReportReissueOwnerDispositionV2(raw, options);
}

async function prepareWalmartItemReportReissueExecutorV2(
  input: WalmartItemReportReissueExecutorV2Input,
  now: Date,
): Promise<PreparedExecution> {
  const engineManifest = snapshotArtifact(input.frozen_engine_manifest, "frozen engine manifest");
  const frozenBundle = snapshotArtifact(input.frozen_bundle, "frozen bundle");
  const sourceEvidence = snapshotArtifact(input.source_evidence, "source evidence");
  const ownerArtifact = snapshotArtifact(input.owner_disposition, "owner disposition");
  const rawDisposition = parseCanonicalJson(ownerArtifact.bytes, "owner disposition");
  const environment = input.expected_environment ?? "PRODUCTION";
  const frozenEngine = await verifyFrozenEngine(
    engineManifest.bytes,
    engineManifest.sha256,
    frozenBundle.bytes,
    frozenBundle.sha256,
    environment,
  );

  const expectedReplacement = expectedReplacementFromRawDisposition(rawDisposition);
  const signedLedger = expectedLedgerFromRawDisposition(rawDisposition);
  const firstVerification = verifyExecutionAuthorization(
    rawDisposition,
    {
      expected_environment: environment,
      env: input.owner_trust_env,
      expected_engine_release_sha256: engineManifest.sha256,
      expected_source_evidence_bytes: sourceEvidence.bytes,
      expected_source_evidence_artifact_sha256: sourceEvidence.sha256,
      expected_replacement: expectedReplacement,
      expected_consumption_ledger: signedLedger,
      now,
    },
  );

  const ledgerDirectory = exactAbsolute(
    input.ledger_state_directory,
    "ledger_state_directory",
  );
  const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: ledgerDirectory,
    expected_binding: firstVerification.signed_body.consumption_ledger,
  });
  const actualLedger = ledger.binding;
  const disposition = verifyExecutionAuthorization(
    rawDisposition,
    {
      expected_environment: environment,
      env: input.owner_trust_env,
      expected_engine_release_sha256: engineManifest.sha256,
      expected_source_evidence_bytes: sourceEvidence.bytes,
      expected_source_evidence_artifact_sha256: sourceEvidence.sha256,
      expected_replacement: expectedReplacement,
      expected_consumption_ledger: actualLedger,
      now,
    },
  );
  if (ledger.authorizations.some(
    (entry) => entry.authorization_sha256 === disposition.authorization_sha256,
  )) {
    fail(
      "AUTHORIZATION_ALREADY_CONSUMED",
      "signed authorization is already claimed, requesting, or terminal",
    );
  }
  const effectiveDeadline = assertFullExecutionHeadroom(disposition, now);
  const activeAccount = exactAccount(input.active_account, environment);
  if (!sameJson(disposition.signed_body.account_scope, activeAccount)
    || !sameJson(disposition.signed_body.replacement.session_authority.account_scope, {
      channel: activeAccount.channel,
      store_index: activeAccount.store_index,
      seller_account_fingerprint_sha256: activeAccount.seller_account_fingerprint_sha256,
    })) {
    fail("ACCOUNT_BINDING_MISMATCH", "active credentials differ from signed account scope");
  }
  const authorization = record(disposition.signed_body.authorization, "authorization");
  if (authorization.request_body_sha256
      !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256
    || authorization.maximum_request_timeout_ms !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS
    || authorization.maximum_oauth_token_calls !== 1
    || authorization.maximum_create_post_calls !== 1
    || authorization.maximum_total_http_calls !== 2
    || authorization.retry_attempts_allowed !== 0
    || authorization.redirects_followed_allowed !== 0
    || authorization.original_session_writes_allowed !== 0
    || authorization.database_calls_allowed !== 0
    || authorization.model_calls_allowed !== 0
    || authorization.paid_provider_calls_allowed !== 0
    || authorization.listing_content_writes_allowed !== 0) {
    fail("AUTHORIZATION_POLICY_MISMATCH", "owner authorization is not exact one-shot policy");
  }

  const captureRoot = exactAbsolute(input.capture_root, "capture_root");
  if (captureRoot !== frozenEngine.canonical_capture_root) {
    fail(
      "NON_CANONICAL_CAPTURE_ROOT",
      "replacement session must use the exact capture root sealed in the frozen manifest",
    );
  }
  const captureRootCustody = await inspectPrivateDirectory(captureRoot, "capture_root");
  const replacementName = disposition.signed_body.replacement.session_name;
  if (replacementName === "." || replacementName === ".."
    || replacementName.includes("/") || replacementName.includes("\\")
    || path.basename(replacementName) !== replacementName) {
    fail("INVALID_REPLACEMENT", "replacement session must be one direct child");
  }
  const sessionDirectory = path.join(captureRoot, replacementName);
  const found = await lstat(sessionDirectory).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (found) fail("REPLACEMENT_SESSION_EXISTS", "replacement session path already exists");
  if (replacementName === disposition.signed_body.prior_incident.session_name) {
    fail("ORIGINAL_SESSION_ALIAS", "replacement may not alias the quarantined session");
  }

  const preflight: WalmartItemReportReissueExecutorV2Preflight = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PREFLIGHT_SCHEMA,
    policy_id: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_POLICY,
    status: "READY_FOR_IRREVERSIBLE_SINGLE_EXECUTION",
    engine_manifest_artifact_sha256: engineManifest.sha256,
    frozen_bundle_artifact_sha256: frozenBundle.sha256,
    source_evidence_artifact_sha256: sourceEvidence.sha256,
    owner_disposition_artifact_sha256: ownerArtifact.sha256,
    authorization_sha256: disposition.authorization_sha256,
    effective_deadline: effectiveDeadline,
    account_scope: activeAccount,
    replacement: disposition.signed_body.replacement,
    consumption_ledger: disposition.signed_body.consumption_ledger,
    ledger_state_directory: ledgerDirectory,
    replacement_session_directory: sessionDirectory,
    request: {
      method: "POST",
      endpoint: "/v3/reports/reportRequests",
      query: { reportType: "ITEM", reportVersion: "v6" },
      body_sha256: sha256(CREATE_BODY),
      timeout_ms_maximum: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS,
      redirects: 0,
      retries: 0,
    },
    external_effects: {
      filesystem_writes: 0,
      ledger_writes: 0,
      oauth_token_calls: 0,
      walmart_api_calls: 0,
      database_calls: 0,
      model_calls: 0,
      paid_provider_calls: 0,
      listing_content_writes: 0,
      prior_session_writes: 0,
    },
    next_action: {
      kind: "IRREVERSIBLE_EXECUTE",
      authorization_will_be_burned_before_oauth: true,
      automatic_retry_allowed: false,
    },
  };
  return {
    preflight,
    disposition,
    owner_disposition_bytes: ownerArtifact.bytes,
    capture_root: captureRoot,
    capture_root_custody: captureRootCustody,
  };
}

export async function preflightWalmartItemReportReissueExecutorV2(
  input: WalmartItemReportReissueExecutorV2Input,
  options: { now?: Date } = {},
): Promise<WalmartItemReportReissueExecutorV2Preflight> {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("INVALID_CLOCK", "preflight clock is invalid");
  }
  return (await prepareWalmartItemReportReissueExecutorV2(input, now)).preflight;
}

async function syncDirectory(
  directory: string,
  expected?: StableDirectoryCustody,
): Promise<StableDirectoryCustody> {
  const custody = expected ?? await inspectPrivateDirectory(directory, "directory to sync");
  if (custody.path !== directory) fail("INVALID_PATH", "directory sync custody path differs");
  await assertDirectoryCustody(custody, "directory to sync");
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | requiredNoFollowFlag() | requiredDirectoryFlag(),
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (String(info.dev) !== custody.dev || String(info.ino) !== custody.ino
      || Number(info.mode & 0o777n) !== DIRECTORY_MODE) {
      fail("INVALID_PATH", "directory changed before fsync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertDirectoryCustody(custody, "directory after sync");
  return custody;
}

async function writeExclusive(
  sessionDirectory: string,
  relativePath: string,
  bytes: Uint8Array,
  dependencies: WalmartItemReportReissueExecutorV2Dependencies,
): Promise<void> {
  if (relativePath.includes("\\") || path.posix.normalize(relativePath) !== relativePath
    || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
    fail("INVALID_PATH", "immutable output path is not canonical session-relative");
  }
  const target = path.join(sessionDirectory, relativePath);
  const sessionCustody = await inspectPrivateDirectory(sessionDirectory, "replacement session");
  const parent = path.dirname(target);
  const parentCustody = await inspectPrivateDirectory(parent, "immutable output parent");
  const relativeToSession = path.relative(sessionDirectory, target);
  if (relativeToSession.startsWith(`..${path.sep}`) || relativeToSession === ".."
    || path.isAbsolute(relativeToSession)) {
    fail("INVALID_PATH", "immutable output escapes replacement session");
  }
  const handle = await open(
    target,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | requiredNoFollowFlag(),
    FILE_MODE,
  );
  let writtenStat;
  try {
    await handle.writeFile(bytes);
    await handle.chmod(FILE_MODE);
    writtenStat = await handle.stat();
    if (!writtenStat.isFile() || writtenStat.nlink !== 1
      || (writtenStat.mode & 0o777) !== FILE_MODE
      || writtenStat.size !== bytes.byteLength) {
      fail("INVALID_PATH", "immutable output descriptor custody is invalid");
    }
    const retained = Buffer.alloc(bytes.byteLength);
    if (retained.byteLength > 0) {
      const read = await handle.read(retained, 0, retained.byteLength, 0);
      if (read.bytesRead !== retained.byteLength) {
        fail("INVALID_PATH", "immutable output could not be read back completely");
      }
    }
    if (!retained.equals(Buffer.from(bytes))) {
      fail("INVALID_PATH", "immutable output bytes differ on descriptor read-back");
    }
    await handle.sync();
    const afterSync = await handle.stat();
    if (!sameStableFileStat(writtenStat, afterSync)) {
      fail("INVALID_PATH", "immutable output changed during fsync");
    }
    writtenStat = afterSync;
  } finally {
    await handle.close();
  }
  const pathStat = await lstat(target);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1
    || !sameFsIdentity(writtenStat, pathStat) || (pathStat.mode & 0o777) !== FILE_MODE
    || await realpath(target) !== target) {
    fail("INVALID_PATH", "immutable output path custody differs from descriptor");
  }
  await assertDirectoryCustody(parentCustody, "immutable output parent");
  await assertDirectoryCustody(sessionCustody, "replacement session");
  await syncDirectory(parent, parentCustody);
  await dependencies.after_immutable_write?.(relativePath);
  const verifyHandle = await open(target, fsConstants.O_RDONLY | requiredNoFollowFlag());
  try {
    const verifyBefore = await verifyHandle.stat();
    if (!sameStableFileStat(writtenStat, verifyBefore) || verifyBefore.nlink !== 1
      || (verifyBefore.mode & 0o777) !== FILE_MODE) {
      fail("INVALID_PATH", "immutable output changed after durable write");
    }
    const retained = await verifyHandle.readFile();
    const verifyAfter = await verifyHandle.stat();
    if (!sameStableFileStat(verifyBefore, verifyAfter)
      || !retained.equals(Buffer.from(bytes))) {
      fail("INVALID_PATH", "immutable output bytes changed after durable write");
    }
  } finally {
    await verifyHandle.close();
  }
  await assertDirectoryCustody(parentCustody, "immutable output parent");
  await assertDirectoryCustody(sessionCustody, "replacement session");
}

async function writeExclusiveJson(
  sessionDirectory: string,
  relativePath: string,
  value: unknown,
  dependencies: WalmartItemReportReissueExecutorV2Dependencies,
): Promise<void> {
  await writeExclusive(
    sessionDirectory,
    relativePath,
    Buffer.from(canonicalWalmartItemReportJson(value), "utf8"),
    dependencies,
  );
}

async function verifyImmutableSessionArtifact(
  sessionDirectory: string,
  relativePath: string,
  expectedBytes: Buffer,
): Promise<void> {
  const target = path.join(sessionDirectory, relativePath);
  const before = await lstat(target).catch(() => {
    fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} disappeared before final verification`);
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (before.mode & 0o777) !== FILE_MODE
    || await realpath(target).catch(() => null) !== target
    || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} lost immutable file custody`);
  }
  const handle = await open(target, fsConstants.O_RDONLY | requiredNoFollowFlag());
  try {
    const opened = await handle.stat();
    if (!sameStableFileStat(before, opened)) {
      fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} raced before final read`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(target);
    if (!sameStableFileStat(opened, afterHandle)
      || !sameStableFileStat(afterHandle, afterPath)
      || !bytes.equals(expectedBytes)) {
      fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} bytes or identity drifted`);
    }
  } finally {
    await handle.close();
  }
}

async function verifyCompleteReplacementSession(
  prepared: PreparedExecution,
  created: Awaited<ReturnType<typeof createReplacementSession>>,
): Promise<void> {
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root final verification");
  await assertDirectoryCustody(created.sessionCustody, "replacement session final verification");
  const expectedByDirectory = new Map<string, string[]>();
  for (const relativePath of created.expectedArtifacts.keys()) {
    const directory = path.posix.dirname(relativePath);
    const names = expectedByDirectory.get(directory) ?? [];
    names.push(path.posix.basename(relativePath));
    expectedByDirectory.set(directory, names);
  }
  for (const directory of ["capture", "checkpoints", "trusted", "sanitized"]) {
    const custody = created.directoryCustodies.get(directory);
    if (!custody) fail("FINAL_ARTIFACT_REVERIFY_FAILED", `missing ${directory} custody binding`);
    await assertDirectoryCustody(custody, `${directory} final verification`);
    const absolute = path.join(created.sessionDirectory, directory);
    const beforeNames = (await readdir(absolute)).sort();
    const expectedNames = (expectedByDirectory.get(directory) ?? []).sort();
    if (!sameJson(beforeNames, expectedNames)) {
      fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${directory} inventory differs at final verification`);
    }
    for (const name of expectedNames) {
      const relativePath = `${directory}/${name}`;
      const expectedBytes = created.expectedArtifacts.get(relativePath);
      if (!expectedBytes) fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} binding is missing`);
      await verifyImmutableSessionArtifact(created.sessionDirectory, relativePath, expectedBytes);
    }
    const afterNames = (await readdir(absolute)).sort();
    if (!sameJson(beforeNames, afterNames)) {
      fail("FINAL_ARTIFACT_REVERIFY_FAILED", `${directory} inventory raced during final verification`);
    }
    await assertDirectoryCustody(custody, `${directory} after final verification`);
  }
  await assertDirectoryCustody(created.sessionCustody, "replacement session after final verification");
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root after final verification");
}

async function createReplacementSession(
  prepared: PreparedExecution,
  consumptionReceipt: unknown,
  reservedAt: string,
  dependencies: WalmartItemReportReissueExecutorV2Dependencies,
): Promise<{
  sessionDirectory: string;
  receiptSha256: string;
  sessionCustody: StableDirectoryCustody;
  directoryCustodies: Map<string, StableDirectoryCustody>;
  expectedArtifacts: Map<string, Buffer>;
}> {
  const sessionDirectory = prepared.preflight.replacement_session_directory;
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root before mkdir");
  await mkdir(sessionDirectory, { mode: DIRECTORY_MODE });
  const sessionCustody = await inspectPrivateDirectory(sessionDirectory, "replacement session");
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root after mkdir");
  const directoryCustodies = new Map<string, StableDirectoryCustody>();
  for (const child of ["capture", "checkpoints", "trusted", "sanitized"]) {
    const childPath = path.join(sessionDirectory, child);
    await mkdir(childPath, { mode: DIRECTORY_MODE });
    directoryCustodies.set(
      child,
      await inspectPrivateDirectory(childPath, `replacement ${child} directory`),
    );
    await assertDirectoryCustody(sessionCustody, "replacement session while creating children");
  }
  const receiptBytes = Buffer.from(canonicalWalmartItemReportJson(consumptionReceipt), "utf8");
  const receiptSha256 = sha256(receiptBytes);
  const expectedArtifacts = new Map<string, Buffer>();
  const sessionAuthorityBytes = Buffer.from(canonicalWalmartItemReportJson(
    prepared.disposition.signed_body.replacement.session_authority,
  ), "utf8");
  const requestManifestBytes = Buffer.from(canonicalWalmartItemReportJson(
    prepared.disposition.signed_body.replacement.create_request_manifest,
  ), "utf8");
  const requestReservedBytes = Buffer.from(canonicalWalmartItemReportJson({
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
    phase: "request",
    state: "REQUESTING",
    observed_at: reservedAt,
    attempt: 1,
    post_attempt_limit: 1,
    retry_forbidden: true,
    authorization_sha256: prepared.disposition.authorization_sha256,
    consumption_receipt_sha256: receiptSha256,
    request_manifest_sha256:
      prepared.disposition.signed_body.replacement.create_request_manifest_sha256,
    request_correlation_id_sha256:
      prepared.disposition.signed_body.replacement.create_request_correlation_id_sha256,
    authorization_consumed_before_oauth: true,
  }), "utf8");
  await writeExclusiveJson(
    sessionDirectory,
    "trusted/00-session-authority.json",
    prepared.disposition.signed_body.replacement.session_authority,
    dependencies,
  );
  expectedArtifacts.set("trusted/00-session-authority.json", sessionAuthorityBytes);
  await writeExclusive(
    sessionDirectory,
    "trusted/01-owner-disposition.json",
    prepared.owner_disposition_bytes,
    dependencies,
  );
  expectedArtifacts.set("trusted/01-owner-disposition.json", prepared.owner_disposition_bytes);
  await writeExclusive(
    sessionDirectory,
    "trusted/02-consumption-receipt.json",
    receiptBytes,
    dependencies,
  );
  expectedArtifacts.set("trusted/02-consumption-receipt.json", receiptBytes);
  await writeExclusiveJson(
    sessionDirectory,
    "capture/10-create-request-manifest.json",
    prepared.disposition.signed_body.replacement.create_request_manifest,
    dependencies,
  );
  expectedArtifacts.set("capture/10-create-request-manifest.json", requestManifestBytes);
  await writeExclusive(
    sessionDirectory,
    "checkpoints/10-request-reserved.json",
    requestReservedBytes,
    dependencies,
  );
  expectedArtifacts.set("checkpoints/10-request-reserved.json", requestReservedBytes);
  for (const child of ["capture", "checkpoints", "trusted", "sanitized"]) {
    await syncDirectory(path.join(sessionDirectory, child));
  }
  await syncDirectory(sessionDirectory, sessionCustody);
  await syncDirectory(prepared.capture_root, prepared.capture_root_custody);
  return {
    sessionDirectory,
    receiptSha256,
    sessionCustody,
    directoryCustodies,
    expectedArtifacts,
  };
}

function zeroCounts(counts: WalmartItemReportHttpCallCounts): boolean {
  return counts.oauth_token_calls === 0 && counts.walmart_api_calls === 0
    && counts.presigned_file_calls === 0 && counts.total_http_calls === 0;
}

function validCounts(counts: WalmartItemReportHttpCallCounts): boolean {
  return Number.isSafeInteger(counts.oauth_token_calls) && counts.oauth_token_calls >= 0
    && Number.isSafeInteger(counts.walmart_api_calls) && counts.walmart_api_calls >= 0
    && Number.isSafeInteger(counts.presigned_file_calls) && counts.presigned_file_calls >= 0
    && Number.isSafeInteger(counts.total_http_calls) && counts.total_http_calls >= 0
    && counts.total_http_calls === counts.oauth_token_calls
      + counts.walmart_api_calls + counts.presigned_file_calls;
}

function assertTransportAccountBinding(
  transport: WalmartItemReportReissueExecutorV2Transport,
  expected: WalmartItemReportReissueExecutorV2TransportAccountBinding,
): void {
  if (typeof transport.get_account_binding !== "function") {
    fail("INVALID_TRANSPORT", "transport must expose its credential-derived account binding");
  }
  const raw = record(transport.get_account_binding(), "transport account binding");
  exactKeys(raw, [
    "channel", "seller_account_fingerprint_sha256", "seller_id", "store_index",
  ], "transport account binding");
  const parsed: WalmartItemReportReissueExecutorV2TransportAccountBinding = {
    channel: raw.channel === "WALMART_US"
      ? "WALMART_US"
      : fail("TRANSPORT_ACCOUNT_BINDING_MISMATCH", "transport channel differs"),
    store_index: positiveInteger(raw.store_index, "transport account store_index"),
    seller_id: exactString(raw.seller_id, "transport account seller_id", 256),
    seller_account_fingerprint_sha256: digest(
      raw.seller_account_fingerprint_sha256,
      "transport account fingerprint",
    ),
  };
  if (!sameJson(parsed, expected)) {
    fail(
      "TRANSPORT_ACCOUNT_BINDING_MISMATCH",
      "transport OAuth credentials differ from the signed active account",
    );
  }
}

function assertUnusedTransport(
  transport: WalmartItemReportReissueExecutorV2Transport,
  expectedAccount: WalmartItemReportReissueExecutorV2TransportAccountBinding,
): void {
  if (!transport || typeof transport.send !== "function"
    || typeof transport.get_http_call_counts !== "function"
    || typeof transport.get_account_binding !== "function") {
    fail("INVALID_TRANSPORT", "open_transport must return the exact metered transport contract");
  }
  assertTransportAccountBinding(transport, expectedAccount);
  const counts = transport.get_http_call_counts();
  if (!validCounts(counts) || !zeroCounts(counts)) {
    fail("TRANSPORT_ALREADY_USED", "executor requires a fresh transport with zero calls");
  }
}

function validateResponse(
  response: WalmartItemReportAtomicTransportResponse,
  expectedCorrelationSha256: string,
): { body: Uint8Array; http: HttpResponseCaptureMetadata } {
  if (!isRecord(response) || !Number.isSafeInteger(response.status)
    || Number(response.status) < 100 || Number(response.status) > 599
    || !isRecord(response.headers) || !(response.body instanceof Uint8Array)
    || response.body.byteLength > WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES
    || Object.values(response.headers).some((value) => typeof value !== "string")) {
    fail("INVALID_HTTP_RESPONSE", "transport returned an invalid bounded response");
  }
  const length = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === "content-length",
  )?.[1];
  if (length !== undefined && (!/^(?:0|[1-9]\d*)$/u.test(length)
    || Number(length) !== response.body.byteLength)) {
    fail("INVALID_HTTP_RESPONSE", "response Content-Length differs from exact bytes");
  }
  const headerValues = (names: readonly string[]): string[] => {
    const accepted = new Set(names.map((name) => name.toLowerCase()));
    return Object.entries(response.headers)
      .filter(([name]) => accepted.has(name.toLowerCase()))
      .map(([, value]) => exactString(value, "HTTP response header", 8192));
  };
  const optionalHeader = (names: readonly string[], label: string): string | null => {
    const values = headerValues(names);
    if (new Set(values).size > 1) {
      fail("INVALID_HTTP_RESPONSE", `${label} response headers conflict`);
    }
    return values[0] ?? null;
  };
  const contentEncoding = optionalHeader(["content-encoding"], "Content-Encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    fail("INVALID_HTTP_RESPONSE", "non-identity response encoding is forbidden");
  }
  const contentType = optionalHeader(["content-type"], "Content-Type");
  const echoedCorrelation = optionalHeader(
    ["wm_qos.correlation_id", "wm-qos-correlation-id"],
    "correlation ID",
  );
  if (echoedCorrelation !== null
    && walmartItemReportUtf8Sha256(echoedCorrelation) !== expectedCorrelationSha256) {
    fail("INVALID_HTTP_RESPONSE", "echoed correlation differs from signed request");
  }
  const echoedReportRequest = optionalHeader(
    ["wm_qos.report_request_id", "wm-report-request-id"],
    "report request ID",
  );
  return {
    body: new Uint8Array(response.body),
    http: {
      status: response.status,
      content_type: contentType,
      content_length: length === undefined ? null : Number(length),
      echoed_correlation_id_sha256: echoedCorrelation === null
        ? null
        : walmartItemReportUtf8Sha256(echoedCorrelation),
      echoed_report_request_id_sha256: echoedReportRequest === null
        ? null
        : walmartItemReportUtf8Sha256(echoedReportRequest),
    },
  };
}

function replacementRequestId(bytes: Uint8Array): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("INVALID_CREATE_RESPONSE", "replacement create response is not UTF-8 JSON");
  }
  const raw = record(value, "replacement create response");
  const requestId = exactString(raw.requestId, "replacement create requestId", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(requestId)) {
    fail("INVALID_CREATE_RESPONSE", "replacement requestId has unsafe characters");
  }
  return requestId;
}

async function terminalManualReview(
  sessionDirectory: string | null,
  reasonCode: string,
  observedAt: string,
  authorizationSha256: string,
  dependencies: WalmartItemReportReissueExecutorV2Dependencies,
  details: JsonRecord = {},
  ledgerTerminal?: {
    state_directory: string;
    expected_binding: WalmartItemReportReissueConsumptionLedgerBindingV2;
    requesting: WalmartItemReportReissueAuthorizationRequestingReceiptV2;
    state: "AMBIGUOUS" | "FAILED";
    http_status: number | null;
    response_body_sha256: string | null;
    report_request_id_sha256: string | null;
  },
): Promise<never> {
  let terminalizationErrorCode: string | null = null;
  if (ledgerTerminal !== undefined) {
    try {
      const terminalAt = new Date(Math.max(
        Date.parse(observedAt),
        Date.parse(ledgerTerminal.requesting.requesting_at),
      )).toISOString();
      let settled = false;
      let lastError: unknown = null;
      // A local terminal artifact may have been durably created before a
      // post-write verification error. Re-read and reconcile before one safe
      // local-only retry; the Walmart POST is never repeated here.
      for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
        try {
          await terminalizeWalmartItemReportReissueAuthorizationV2({
            state_directory: ledgerTerminal.state_directory,
            expected_binding: ledgerTerminal.expected_binding,
            requesting: ledgerTerminal.requesting,
            outcome: {
              state: ledgerTerminal.state,
              terminal_at: terminalAt,
              http_status: ledgerTerminal.http_status,
              response_body_sha256: ledgerTerminal.response_body_sha256,
              report_request_id_sha256: ledgerTerminal.report_request_id_sha256,
              error_code: reasonCode,
            },
          });
          settled = true;
        } catch (error) {
          lastError = error;
          const snapshot = await openWalmartItemReportReissueConsumptionLedgerV2({
            state_directory: ledgerTerminal.state_directory,
            expected_binding: ledgerTerminal.expected_binding,
          }).catch(() => null);
          const durable = snapshot?.authorizations.find(
            (entry) => entry.authorization_sha256
              === ledgerTerminal.requesting.authorization_sha256,
          );
          if (durable && new Set(["SUCCEEDED", "AMBIGUOUS", "FAILED"]).has(durable.state)) {
            settled = true;
          } else if (!durable || durable.state !== "REQUESTING") {
            break;
          }
        }
      }
      if (!settled) throw lastError ?? new Error("ledger terminal outcome is missing");
    } catch (error) {
      terminalizationErrorCode = typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code)
        : "LEDGER_TERMINALIZATION_FAILED";
    }
  }
  if (sessionDirectory !== null) {
    await writeExclusiveJson(
      sessionDirectory,
      "checkpoints/19-request-manual-review.json",
      {
        schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
        phase: "request",
        state: "MANUAL_REVIEW",
        observed_at: observedAt,
        reason_code: reasonCode,
        retry_forbidden: true,
        authorization_sha256: authorizationSha256,
        authorization_consumed: true,
        consumption_ledger_terminalization_error_code: terminalizationErrorCode,
        ...details,
      },
      dependencies,
    ).catch(() => {
      // The ledger REQUESTING fence is the authoritative burn if the local
      // explanatory checkpoint itself cannot be persisted.
    });
  }
  throw new WalmartItemReportReissueExecutorV2ManualReviewError(
    reasonCode,
    sessionDirectory,
    "replacement POST outcome is terminal/manual-review; authorization cannot be replayed",
  );
}

function ledgerTerminalInput(
  prepared: PreparedExecution,
  requesting: WalmartItemReportReissueAuthorizationRequestingReceiptV2,
  state: "AMBIGUOUS" | "FAILED",
  httpStatus: number | null = null,
  responseBodySha256: string | null = null,
  reportRequestIdSha256: string | null = null,
): NonNullable<Parameters<typeof terminalManualReview>[6]> {
  return {
    state_directory: prepared.preflight.ledger_state_directory,
    expected_binding: prepared.preflight.consumption_ledger,
    requesting,
    state,
    http_status: httpStatus,
    response_body_sha256: responseBodySha256,
    report_request_id_sha256: reportRequestIdSha256,
  };
}

async function terminalizeSucceeded(
  prepared: PreparedExecution,
  requesting: WalmartItemReportReissueAuthorizationRequestingReceiptV2,
  terminalAt: string,
  httpStatus: 200 | 201,
  responseBodySha256: string,
  reportRequestIdSha256: string,
): Promise<void> {
  await terminalizeWalmartItemReportReissueAuthorizationV2({
    state_directory: prepared.preflight.ledger_state_directory,
    expected_binding: prepared.preflight.consumption_ledger,
    requesting,
    outcome: {
      state: "SUCCEEDED",
      terminal_at: terminalAt,
      http_status: httpStatus,
      response_body_sha256: responseBodySha256,
      report_request_id_sha256: reportRequestIdSha256,
      error_code: null,
    },
  });
}

async function sendOnePost(
  transport: WalmartItemReportReissueExecutorV2Transport,
  correlationId: string,
): Promise<WalmartItemReportAtomicTransportResponse> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new WalmartItemReportReissueExecutorV2Error(
        "REQUEST_TIMEOUT",
        "replacement POST exceeded its one-shot deadline",
      ));
    }, WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS);
  });
  const request: WalmartItemReportAtomicTransportRequest = {
    kind: "walmart-api",
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    query: { reportType: "ITEM", reportVersion: "v6" },
    url: null,
    headers: {
      accept: "application/json",
      "accept-encoding": "identity",
      "content-type": "application/json",
    },
    body: CREATE_BODY,
    correlation_id: correlationId,
    redirect: "manual",
    max_response_bytes: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES,
    max_redirect_response_bytes: 64 * 1024,
    timeout_ms: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS,
    signal: controller.signal,
  };
  try {
    return await Promise.race([transport.send(request), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function executeWalmartItemReportReissueExecutorV2(
  input: WalmartItemReportReissueExecutorV2Input,
  dependencies: WalmartItemReportReissueExecutorV2Dependencies,
): Promise<WalmartItemReportReissueExecutorV2Result> {
  if (!dependencies || typeof dependencies.open_transport !== "function") {
    fail("INVALID_DEPENDENCIES", "open_transport dependency is required");
  }
  const initialNow = nowDate(dependencies.now);
  const prepared = await prepareWalmartItemReportReissueExecutorV2(input, initialNow);

  // This is the irreversible point. It must finish before open_transport,
  // OAuth, or any Walmart request can occur.
  const consumptionReceipt = await consumeWalmartItemReportReissueAuthorizationV2({
    state_directory: prepared.preflight.ledger_state_directory,
    expected_binding: prepared.preflight.consumption_ledger,
    authorization_sha256: prepared.preflight.authorization_sha256,
    claimed_at: initialNow,
    requesting_at: initialNow,
  });
  const requestingAt = nowDate(dependencies.now);
  let sessionDirectory: string | null = prepared.preflight.replacement_session_directory;
  let createdSession: Awaited<ReturnType<typeof createReplacementSession>> | null = null;
  try {
    const created = await createReplacementSession(
      prepared,
      consumptionReceipt,
      requestingAt.toISOString(),
      dependencies,
    );
    createdSession = created;
    sessionDirectory = created.sessionDirectory;
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "LOCAL_SESSION_PREPARATION_FAILED_AFTER_AUTHORIZATION_BURN",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED"),
    );
  }

  try {
    assertFullExecutionHeadroom(
      prepared.disposition,
      nowDate(dependencies.now),
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "AUTHORIZATION_HEADROOM_LOST_AFTER_BURN",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED"),
    );
  }

  let transport: WalmartItemReportReissueExecutorV2Transport;
  try {
    transport = dependencies.open_transport();
    assertUnusedTransport(transport, prepared.preflight.account_scope);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "TRANSPORT_INITIALIZATION_FAILED_AFTER_AUTHORIZATION_BURN",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED"),
    );
  }

  try {
    // This is the final synchronous gate before transport.send can open OAuth.
    // Re-read both time and credential-derived account binding at that boundary.
    assertFullExecutionHeadroom(prepared.disposition, nowDate(dependencies.now));
    assertTransportAccountBinding(transport, prepared.preflight.account_scope);
    const counts = transport.get_http_call_counts();
    if (!validCounts(counts) || !zeroCounts(counts)) {
      fail("TRANSPORT_ALREADY_USED", "transport changed before the one-shot send boundary");
    }
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "FINAL_PRE_OAUTH_GATE_FAILED",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED"),
    );
  }

  let rawResponse: WalmartItemReportAtomicTransportResponse;
  try {
    rawResponse = await sendOnePost(
      transport,
      prepared.disposition.signed_body.replacement.session_authority
        .primary_correlations.create.id,
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "AMBIGUOUS_POST_NETWORK_OUTCOME",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS"),
    );
  }

  let calls: WalmartItemReportHttpCallCounts;
  try {
    calls = transport.get_http_call_counts();
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "HTTP_CALL_ACCOUNTING_UNAVAILABLE",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS"),
    );
  }
  if (!validCounts(calls) || calls.oauth_token_calls !== 1 || calls.walmart_api_calls !== 1
    || calls.presigned_file_calls !== 0 || calls.total_http_calls !== 2) {
    return terminalManualReview(
      sessionDirectory,
      "HTTP_CALL_ACCOUNTING_VIOLATION",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS"),
    );
  }

  let response: { body: Uint8Array; http: HttpResponseCaptureMetadata };
  try {
    response = validateResponse(
      rawResponse,
      prepared.disposition.signed_body.replacement.create_request_correlation_id_sha256,
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "POST_RESPONSE_CAPTURE_INVALID",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS"),
    );
  }
  const observedAt = nowDate(dependencies.now).toISOString();
  const responseBytes = Buffer.from(response.body);
  const responseSha256 = sha256(responseBytes);
  const http = response.http;
  const httpSha256 = walmartItemReportSha256(http);
  const requestManifestBytes = Buffer.from(canonicalWalmartItemReportJson(
    prepared.disposition.signed_body.replacement.create_request_manifest,
  ), "utf8");
  const exchangeSeal = responseBytes.byteLength === 0
    ? null
    : {
        policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        sha256: walmartItemReportTrustedExchangeSha256({
          request_manifest_bytes: requestManifestBytes,
          request_correlation_id_sha256:
            prepared.disposition.signed_body.replacement.create_request_correlation_id_sha256,
          response_payload_bytes: responseBytes,
          http,
        }),
      };
  try {
    await writeExclusive(
      sessionDirectory,
      "capture/11-create-response.bin",
      responseBytes,
      dependencies,
    );
    await writeExclusiveJson(
      sessionDirectory,
      "capture/12-create-response-http.json",
      http,
      dependencies,
    );
    if (exchangeSeal !== null) {
      await writeExclusiveJson(
        sessionDirectory,
        "trusted/13-create-exchange-seal.json",
        exchangeSeal,
        dependencies,
      );
    }
    await syncDirectory(path.join(sessionDirectory, "capture"));
    await syncDirectory(path.join(sessionDirectory, "trusted"));
    await syncDirectory(sessionDirectory);
    if (!createdSession) fail("INVALID_STATE", "replacement session binding is missing");
    createdSession.expectedArtifacts.set("capture/11-create-response.bin", responseBytes);
    createdSession.expectedArtifacts.set(
      "capture/12-create-response-http.json",
      Buffer.from(canonicalWalmartItemReportJson(http), "utf8"),
    );
    if (exchangeSeal !== null) {
      createdSession.expectedArtifacts.set(
        "trusted/13-create-exchange-seal.json",
        Buffer.from(canonicalWalmartItemReportJson(exchangeSeal), "utf8"),
      );
    }
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "POST_RESPONSE_PERSISTENCE_FAILED",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      { http_status: http.status, response_body_sha256: responseSha256, response_http_sha256: httpSha256 },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "AMBIGUOUS",
        http.status,
        responseSha256,
      ),
    );
  }

  if (http.status !== 200 && http.status !== 201) {
    return terminalManualReview(
      sessionDirectory,
      "POST_HTTP_FAILURE",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      { http_status: http.status, response_body_sha256: responseSha256 },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "FAILED",
        http.status,
        responseSha256,
      ),
    );
  }
  let requestId: string;
  try {
    requestId = replacementRequestId(response.body);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "POST_RESPONSE_REQUEST_ID_INVALID",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      { http_status: http.status, response_body_sha256: responseSha256 },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "AMBIGUOUS",
        http.status,
        responseSha256,
      ),
    );
  }
  const requestIdSha256 = walmartItemReportUtf8Sha256(requestId);
  try {
    await terminalizeSucceeded(
      prepared,
      consumptionReceipt,
      observedAt,
      http.status,
      responseSha256,
      requestIdSha256,
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "LEDGER_SUCCESS_TERMINALIZATION_FAILED",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        http_status: http.status,
        response_body_sha256: responseSha256,
        report_request_id_sha256: requestIdSha256,
      },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "AMBIGUOUS",
        http.status,
        responseSha256,
        requestIdSha256,
      ),
    );
  }
  const completeCheckpoint = {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
    phase: "request",
    state: "COMPLETE",
    observed_at: observedAt,
    request_id: requestId,
    request_id_sha256: requestIdSha256,
    request_id_origin: "REPLACEMENT_POST_RESPONSE_ONLY",
    original_request_id_adopted: false,
    retry_forbidden: true,
    authorization_sha256: prepared.preflight.authorization_sha256,
    request_manifest_path: "capture/10-create-request-manifest.json",
    response_body_path: "capture/11-create-response.bin",
    response_http_path: "capture/12-create-response-http.json",
    exchange_seal_path: "trusted/13-create-exchange-seal.json",
  };
  const completeCheckpointBytes = Buffer.from(
    canonicalWalmartItemReportJson(completeCheckpoint),
    "utf8",
  );
  try {
    await writeExclusive(
      sessionDirectory,
      "checkpoints/19-request-complete.json",
      completeCheckpointBytes,
      dependencies,
    );
    if (!createdSession) fail("INVALID_STATE", "replacement session binding is missing");
    createdSession.expectedArtifacts.set(
      "checkpoints/19-request-complete.json",
      completeCheckpointBytes,
    );
    await syncDirectory(path.join(sessionDirectory, "checkpoints"));
    await syncDirectory(sessionDirectory);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "REQUEST_COMPLETE_PERSISTENCE_FAILED",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        http_status: http.status,
        response_body_sha256: responseSha256,
        report_request_id_sha256: requestIdSha256,
        consumption_ledger_state: "SUCCEEDED",
      },
    );
  }
  try {
    if (!createdSession) fail("INVALID_STATE", "replacement session binding is missing");
    await verifyCompleteReplacementSession(prepared, createdSession);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "FINAL_SESSION_REVERIFY_FAILED",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        http_status: http.status,
        response_body_sha256: responseSha256,
        report_request_id_sha256: requestIdSha256,
        consumption_ledger_state: "SUCCEEDED",
      },
    );
  }
  return {
    status: "REQUESTED",
    authorization_sha256: prepared.preflight.authorization_sha256,
    replacement_session_directory: sessionDirectory,
    request_id: requestId,
    request_id_sha256: requestIdSha256,
    http_status: http.status,
    http_calls: calls,
    authorization_consumed_before_oauth: true,
    automatic_retry_allowed: false,
    prior_session_writes: 0,
    database_calls: 0,
    model_calls: 0,
    paid_provider_calls: 0,
    listing_content_writes: 0,
  };
}
