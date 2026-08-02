import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  transitionWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
  type WalmartListingIntegrityControlStateName,
} from "./listing-integrity-control-plane";
import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "./listing-integrity-control-store.server";
import {
  persistWalmartListingIntegrityControlTransition,
} from "./listing-integrity-control-transition-store.server";
import {
  invokeWalmartListingIntegrityDiagnosisProcess,
  type WalmartListingIntegrityDiagnosisProcessConfig,
} from "./listing-integrity-diagnosis-process-adapter.server";
import {
  compileWalmartListingIntegrityRemediationRoute,
} from "./listing-integrity-remediation-route";
import {
  qualifyWalmartListingIntegrityCleanCandidate,
} from "./listing-integrity-single-clean-qualification.server";
import {
  WALMART_LISTING_SINGLE_DIAGNOSIS_FILENAME,
} from "./listing-integrity-single-pipeline";

const TERMINAL = new Set([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
]);
const MAX_JSON_BYTES = 100 * 1024 * 1024;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
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

function evidenceBytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

export function buildWalmartListingIntegrityDiagnosisStartEvidence(
  current: WalmartListingIntegrityControlState,
) {
  return {
    schema_version: "walmart-listing-integrity-diagnosis-start/v1",
    listing: current.identity,
    predecessor: {
      state: current.state,
      revision: current.revision,
      body_sha256: current.body_sha256,
    },
    action: "READ_ONLY_EXACT_SKU_CAPTURE_OBSERVE_DIAGNOSE",
    walmart_write_authorized: false,
    automatic_retry_allowed: false,
  } as const;
}

function boundedError(error: unknown): { message: string; fingerprint_sha256: string } {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 2_000);
  return { message, fingerprint_sha256: sha256(message) };
}

async function privateRoot(value: string): Promise<string> {
  const root = resolve(value);
  if (root !== value) fail("DIAGNOSIS_CUSTODY_INVALID", "custody root must be normalized");
  const stat = await lstat(root).catch(() => fail(
    "DIAGNOSIS_CUSTODY_INVALID",
    "custody root is missing",
  ));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(root) !== root
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    fail("DIAGNOSIS_CUSTODY_INVALID", "custody root must be private and canonical");
  }
  return root;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || await realpath(directory) !== directory) {
      fail("DIAGNOSIS_CUSTODY_INVALID", "existing case directory is not private canonical custody");
    }
  });
}

async function readJson(file: string, label: string): Promise<{
  value: Record<string, unknown>;
  bytes: Buffer;
  file_sha256: string;
}> {
  const stat = await lstat(file).catch(() => fail("DIAGNOSIS_ARTIFACT_INVALID", `${label} missing`));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 2 || stat.size > MAX_JSON_BYTES) {
    fail("DIAGNOSIS_ARTIFACT_INVALID", `${label} must be one bounded regular file`);
  }
  const bytes = await readFile(file);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    return fail("DIAGNOSIS_ARTIFACT_INVALID", `${label} is not UTF-8 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("DIAGNOSIS_ARTIFACT_INVALID", `${label} must be one object`);
  }
  return { value: value as Record<string, unknown>, bytes, file_sha256: sha256(bytes) };
}

function currentItem(items: readonly WalmartListingIntegrityControlState[]) {
  return items.find((item) => !TERMINAL.has(item.state)) ?? null;
}

async function persist(input: {
  current: WalmartListingIntegrityControlState;
  next_state: WalmartListingIntegrityControlStateName;
  evidence: unknown;
  now: string;
  role: string;
}) {
  const bytes = evidenceBytes(input.evidence);
  const next = transitionWalmartListingIntegrityControlState({
    current: input.current,
    next_state: input.next_state,
    transitioned_at: input.now,
    evidence_sha256: sha256(bytes),
  });
  return persistWalmartListingIntegrityControlTransition({
    current: input.current,
    next,
    evidence_bytes: bytes,
    evidence_role: input.role,
    created_by_principal: "walmart-listing-integrity-diagnosis-worker",
  });
}

function fileForRole(index: Record<string, unknown>, role: string): string {
  const files = Array.isArray(index.files) ? index.files : [];
  const matches = files.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).role === role
  )) as Array<Record<string, unknown>>;
  if (matches.length !== 1 || typeof matches[0]?.path !== "string") {
    fail("DIAGNOSIS_INTAKE_INVALID", `intake must contain exactly one ${role}`);
  }
  return matches[0].path;
}

function buyerSnapshotFile(index: Record<string, unknown>): string {
  return fileForRole(index, "buyer_snapshot_manifest");
}

export async function runWalmartListingIntegrityProductionDiagnosisOnce(input: {
  custody_root: string;
  process_config: WalmartListingIntegrityDiagnosisProcessConfig;
  now?: Date;
}) {
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot();
  if (snapshot.installation !== "INSTALLED" || !snapshot.run) {
    return { status: "NO_ACTIVE_CONTROL_RUN" as const, walmart_writes: 0 as const };
  }
  if (snapshot.run.status !== "ACTIVE") {
    return { status: "CONTROL_RUN_NOT_ACTIVE" as const, walmart_writes: 0 as const };
  }
  let current = currentItem(snapshot.run.items);
  if (!current) return { status: "CONTROL_QUEUE_COMPLETE" as const, walmart_writes: 0 as const };
  if (current.state !== "QUEUED" && current.state !== "DIAGNOSING") {
    return {
      status: "WAITING_NON_DIAGNOSIS_STAGE" as const,
      sku: current.identity.sku,
      state: current.state,
      walmart_writes: 0 as const,
    };
  }
  const root = await privateRoot(input.custody_root);
  const now = input.now ?? new Date();
  if (current.state === "QUEUED") {
    const started = await persist({
      current,
      next_state: "DIAGNOSING",
      now: now.toISOString(),
      role: "READ_ONLY_DIAGNOSIS_STARTED",
      evidence: buildWalmartListingIntegrityDiagnosisStartEvidence(current),
    });
    current = started.state;
  }
  const caseId = `case-${current.identity.ordinal}-${sha256(current.identity.listing_key).slice(0, 16)}`;
  const caseRoot = join(root, snapshot.run.run_id, caseId);
  await ensurePrivateDirectory(join(root, snapshot.run.run_id));
  await ensurePrivateDirectory(caseRoot);
  const captureDir = join(caseRoot, "capture");
  const intakeIndexPath = join(captureDir, "intake-index.json");
  let intakeExists = true;
  try {
    await lstat(intakeIndexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    intakeExists = false;
  }
  if (!intakeExists) {
    try {
      await invokeWalmartListingIntegrityDiagnosisProcess({
        config: input.process_config,
        command: {
          command: "inspect",
          sku: current.identity.sku,
          store_index: current.identity.store_index,
          product_truth_manifest_sha256: input.process_config.product_truth_manifest_sha256,
          output_dir: captureDir,
        },
      });
    } catch (error) {
      const result = await persist({
        current,
        next_state: "QUARANTINED_SOURCE_REQUIRED",
        now: new Date().toISOString(),
        role: "READ_ONLY_CAPTURE_FAILED",
        evidence: {
          schema_version: "walmart-listing-integrity-diagnosis-result/v1",
          listing: current.identity,
          outcome: "READ_ONLY_CAPTURE_FAILED",
          error: boundedError(error),
          walmart_writes: 0,
          retry_allowed: false,
          next_action: "REVIEW_SOURCE_OR_CONNECTIVITY_SEPARATELY",
        },
      });
      return {
        status: result.state.state,
        sku: current.identity.sku,
        result,
        walmart_writes: 0 as const,
      };
    }
  }
  const intake = await readJson(intakeIndexPath, "intake index");
  if (intake.value.listing_key !== current.identity.listing_key) {
    fail("DIAGNOSIS_IDENTITY_DRIFT", "intake listing differs from control item");
  }
  if (["SOURCE_REQUIRED", "BUYER_CAPTURE_REQUIRED"].includes(String(intake.value.status))) {
    const completedAt = new Date().toISOString();
    const result = await persist({
      current,
      next_state: "QUARANTINED_SOURCE_REQUIRED",
      now: completedAt,
      role: "READ_ONLY_DIAGNOSIS_SOURCE_REQUIRED",
      evidence: {
        schema_version: "walmart-listing-integrity-diagnosis-result/v1",
        listing: current.identity,
        outcome: intake.value.status,
        intake_index_path: intakeIndexPath,
        intake_index_file_sha256: intake.file_sha256,
        walmart_writes: 0,
        next_action: "ADVANCE_AND_ENRICH_SOURCE_SEPARATELY",
      },
    });
    return { status: result.state.state, sku: current.identity.sku, result, walmart_writes: 0 as const };
  }
  if (!["CAPTURED", "CAPTURED_SOURCE_REQUIRED"].includes(String(intake.value.status))) {
    fail("DIAGNOSIS_INTAKE_INVALID", "intake status is unsupported");
  }

  const observeDir = join(caseRoot, "observe");
  const observationsPath = join(observeDir, "observations.json");
  let observationsExist = true;
  let observeDirectoryExists = true;
  try {
    await lstat(observationsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    observationsExist = false;
  }
  try {
    await lstat(observeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    observeDirectoryExists = false;
  }
  if (!observationsExist) {
    if (observeDirectoryExists) {
      const executionIndexPath = join(observeDir, "execution-index.json");
      const executionIndex = await readJson(
        executionIndexPath,
        "prior observer execution index",
      ).catch(() => null);
      const result = await persist({
        current,
        next_state: "QUARANTINED_SOURCE_REQUIRED",
        now: new Date().toISOString(),
        role: "READ_ONLY_OBSERVER_INCOMPLETE_NO_RETRY",
        evidence: {
          schema_version: "walmart-listing-integrity-diagnosis-result/v1",
          listing: current.identity,
          outcome: executionIndex?.value.status === "UNKNOWN_OUTCOME"
            ? "OBSERVATION_UNKNOWN_OUTCOME"
            : "OBSERVATION_INCOMPLETE_OUTCOME",
          observer_execution_index_path: executionIndex ? executionIndexPath : null,
          observer_execution_index_file_sha256: executionIndex?.file_sha256 ?? null,
          walmart_writes: 0,
          retry_allowed: false,
          next_action: "RECONCILE_OBSERVER_CALL_SEPARATELY",
        },
      });
      return {
        status: result.state.state,
        sku: current.identity.sku,
        result,
        walmart_writes: 0 as const,
      };
    }
    let observed: Record<string, unknown>;
    try {
      observed = await invokeWalmartListingIntegrityDiagnosisProcess({
        config: input.process_config,
        command: { command: "observe", intake_dir: captureDir, output_dir: observeDir },
      });
    } catch (error) {
      const result = await persist({
        current,
        next_state: "QUARANTINED_SOURCE_REQUIRED",
        now: new Date().toISOString(),
        role: "READ_ONLY_OBSERVER_FAILED_NO_RETRY",
        evidence: {
          schema_version: "walmart-listing-integrity-diagnosis-result/v1",
          listing: current.identity,
          outcome: "OBSERVATION_FAILED_OR_UNKNOWN",
          error: boundedError(error),
          walmart_writes: 0,
          retry_allowed: false,
          next_action: "RECONCILE_OBSERVER_CALL_SEPARATELY",
        },
      });
      return {
        status: result.state.state,
        sku: current.identity.sku,
        result,
        walmart_writes: 0 as const,
      };
    }
    if (observed.status === "OBSERVATION_UNKNOWN_OUTCOME") {
      const result = await persist({
        current,
        next_state: "QUARANTINED_SOURCE_REQUIRED",
        now: new Date().toISOString(),
        role: "READ_ONLY_OBSERVER_UNKNOWN_OUTCOME",
        evidence: {
          schema_version: "walmart-listing-integrity-diagnosis-result/v1",
          listing: current.identity,
          outcome: "OBSERVATION_UNKNOWN_OUTCOME",
          observer_result: observed,
          walmart_writes: 0,
          retry_allowed: false,
          next_action: "RECONCILE_OBSERVER_CALL_SEPARATELY",
        },
      });
      return { status: result.state.state, sku: current.identity.sku, result, walmart_writes: 0 as const };
    }
  }
  const observations = await readJson(observationsPath, "blind observations");
  const diagnosisPath = join(caseRoot, WALMART_LISTING_SINGLE_DIAGNOSIS_FILENAME);
  let diagnosisExists = true;
  try {
    await lstat(diagnosisPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    diagnosisExists = false;
  }
  if (!diagnosisExists) {
    const buyerSnapshotRelativePath = buyerSnapshotFile(intake.value);
    try {
      await invokeWalmartListingIntegrityDiagnosisProcess({
        config: input.process_config,
        command: {
          command: "diagnose",
          product_truth: join(captureDir, fileForRole(intake.value, "product_truth")),
          buyer_snapshot: join(captureDir, buyerSnapshotRelativePath),
          buyer_pdp: join(captureDir, fileForRole(intake.value, "buyer_pdp_payload")),
          observations: observationsPath,
          asset_root: join(captureDir, dirname(buyerSnapshotRelativePath)),
          output: diagnosisPath,
        },
      });
    } catch (error) {
      const result = await persist({
        current,
        next_state: "QUARANTINED_SOURCE_REQUIRED",
        now: new Date().toISOString(),
        role: "LOCAL_DIAGNOSIS_FAILED",
        evidence: {
          schema_version: "walmart-listing-integrity-diagnosis-result/v1",
          listing: current.identity,
          outcome: "LOCAL_DIAGNOSIS_FAILED",
          error: boundedError(error),
          walmart_writes: 0,
          retry_allowed: false,
          next_action: "REVIEW_DETECTOR_EVIDENCE_SEPARATELY",
        },
      });
      return {
        status: result.state.state,
        sku: current.identity.sku,
        result,
        walmart_writes: 0 as const,
      };
    }
  }
  const diagnosis = await readJson(diagnosisPath, "diagnosis report");
  if (diagnosis.value.listing_key !== current.identity.listing_key
    || diagnosis.value.schema_version !== "walmart-listing-single-process-report/v1") {
    fail("DIAGNOSIS_IDENTITY_DRIFT", "diagnosis differs from control listing");
  }
  const body = { ...diagnosis.value };
  delete body.body_sha256;
  if (diagnosis.value.body_sha256 !== walmartListingIntegrityControlSha256(body)) {
    fail("DIAGNOSIS_REPORT_INVALID", "diagnosis body SHA differs");
  }
  const outcome = diagnosis.value.outcome as Record<string, unknown> | undefined;
  const status = outcome?.status;
  const cleanQualification = status === "CLEAN_CANDIDATE"
    ? await qualifyWalmartListingIntegrityCleanCandidate({
      intake_dir: captureDir,
      observation_dir: observeDir,
      diagnosis_path: diagnosisPath,
      output_dir: join(caseRoot, "final-gallery"),
      expected_listing_key: current.identity.listing_key,
      expected_product_truth_manifest_sha256:
        input.process_config.product_truth_manifest_sha256,
    })
    : null;
  if (cleanQualification
    && (cleanQualification.status !== "LIVE_SURFACE_PASS"
      || cleanQualification.verdict !== "PASS"
      || cleanQualification.next_sku_unblocked !== true
      || cleanQualification.walmart_writes !== 0)) {
    fail("DIAGNOSIS_CLEAN_QUALIFICATION_INVALID", "clean candidate did not qualify");
  }
  const remediationRoute = status === "BAD" || status === "REVIEW"
    ? compileWalmartListingIntegrityRemediationRoute({
      diagnosis: diagnosis.value,
      expected_listing_key: current.identity.listing_key,
      expected_sku: current.identity.sku,
    })
    : null;
  const repairableReview = status === "REVIEW"
    && remediationRoute?.status === "AUTOMATIC_ROUTE_READY";
  const nextState = status === "CLEAN_CANDIDATE"
    ? "AUDITED_PASS" as const
    : status === "BAD" || repairableReview
      ? "ISSUE_PROVEN" as const
      : "QUARANTINED_SOURCE_REQUIRED" as const;
  const result = await persist({
    current,
    next_state: nextState,
    now: new Date().toISOString(),
    role: "READ_ONLY_DIAGNOSIS_COMPLETED",
    evidence: {
      schema_version: "walmart-listing-integrity-diagnosis-result/v1",
      listing: current.identity,
      outcome: status,
      blockers: Array.isArray(outcome?.blockers) ? outcome.blockers : [],
      intake_index_path: intakeIndexPath,
      intake_index_file_sha256: intake.file_sha256,
      observations_path: observationsPath,
      observations_file_sha256: observations.file_sha256,
      diagnosis_path: diagnosisPath,
      diagnosis_file_sha256: diagnosis.file_sha256,
      remediation_route: remediationRoute,
      clean_qualification: cleanQualification,
      walmart_writes: 0,
      next_action: nextState === "ISSUE_PROVEN"
        ? remediationRoute?.status === "AUTOMATIC_ROUTE_READY"
          ? "BUILD_EXACT_REPAIR_PLAN"
          : "DOCUMENT_UNSUPPORTED_ROUTE_AND_ADVANCE"
        : nextState === "AUDITED_PASS"
          ? "ADVANCE_AFTER_VERIFIED_NO_CHANGE_GALLERY"
          : "ADVANCE_TO_NEXT_SKU",
    },
  });
  return {
    status: result.state.state,
    sku: current.identity.sku,
    outcome: status,
    case_root: caseRoot,
    result,
    walmart_writes: 0 as const,
  };
}
