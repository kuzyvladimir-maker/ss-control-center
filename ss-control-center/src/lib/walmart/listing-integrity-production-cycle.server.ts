import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  transitionWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";
import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "./listing-integrity-control-store.server";
import {
  admitAndPersistWalmartListingIntegrityOperatorReceipt,
  persistWalmartListingIntegrityControlTransition,
} from "./listing-integrity-control-transition-store.server";
import {
  invokeWalmartListingIntegrityRemediationProcess,
  type WalmartListingIntegrityRemediationProcessConfig,
} from "./listing-integrity-remediation-process-adapter.server";
import {
  invokeWalmartListingIntegrityFrozenPreflightProcess,
  type WalmartListingIntegrityFrozenProcessConfig,
} from "./listing-integrity-frozen-process-adapter.server";
import {
  buildWalmartListingIntegrityFrozenWorkerInvocation,
  type WalmartListingIntegrityFrozenWorkerBinding,
} from "./listing-integrity-frozen-operator-worker";
import {
  buildWalmartListingIntegrityFrozenWorkOrder,
} from "./listing-integrity-frozen-work-order";
import {
  runWalmartListingIntegrityProductionWorkerOnce,
} from "./listing-integrity-production-worker.server";
import {
  authorizeWalmartListingIntegrityRuntimeForOneSku,
} from "./listing-integrity-runtime-authority";
import {
  buildWalmartListingIntegrityMainFailureDisposition,
  verifyWalmartListingIntegrityMainFailureDisposition,
} from "./listing-integrity-main-failure-disposition";
import {
  completeWalmartListingIntegrityGlobalAdmission,
  inspectWalmartListingIntegrityGlobalAdmissionRoot,
} from "./listing-integrity-global-admission";

const ADVANCE_TERMINAL = new Set([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
]);
const OPERATOR_STATES = new Set([
  "OWNER_APPROVED",
  "APPLY_REQUESTING",
  "APPLIED",
  "PROPAGATING",
  "LIVE_REREAD",
]);
const MAX_PRIVATE_ARTIFACT_BYTES = 512 * 1024 * 1024;

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

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function exactPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail("PRODUCTION_CYCLE_PATH_INVALID", `${label} must be an absolute normalized path`);
  }
  return value;
}

async function assertPrivateDirectory(value: string): Promise<string> {
  const path = exactPath(value, "custody_root");
  const stat = await lstat(path).catch(() => fail(
    "PRODUCTION_CYCLE_CUSTODY_INVALID",
    "custody root does not exist",
  ));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(path) !== path
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    fail(
      "PRODUCTION_CYCLE_CUSTODY_INVALID",
      "custody root must be one owner-private canonical directory",
    );
  }
  return path;
}

async function writePrivateArtifact(input: {
  root: string;
  prefix: string;
  bytes: Uint8Array;
}): Promise<{ path: string; sha256: string }> {
  if (input.bytes.byteLength < 2 || input.bytes.byteLength > MAX_PRIVATE_ARTIFACT_BYTES) {
    fail("PRODUCTION_CYCLE_ARTIFACT_INVALID", "private artifact size is invalid");
  }
  const path = join(input.root, `${input.prefix}-${randomUUID()}.json`);
  const handle = await open(path, "wx", 0o400).catch(() => fail(
    "PRODUCTION_CYCLE_ARTIFACT_WRITE_FAILED",
    "private artifact could not be created exclusively",
  ));
  try {
    await handle.writeFile(input.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, sha256: sha256(input.bytes) };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || await realpath(path) !== path) {
      fail("PRODUCTION_CYCLE_CUSTODY_INVALID", "operator step directory is not private");
    }
  });
}

async function writeNamedPrivateArtifact(input: {
  path: string;
  bytes: Uint8Array;
}): Promise<{ path: string; sha256: string }> {
  if (input.bytes.byteLength < 2 || input.bytes.byteLength > MAX_PRIVATE_ARTIFACT_BYTES) {
    fail("PRODUCTION_CYCLE_ARTIFACT_INVALID", "named artifact size is invalid");
  }
  const handle = await open(input.path, "wx", 0o400).catch(() => fail(
    "PRODUCTION_CYCLE_ARTIFACT_WRITE_FAILED",
    "exact named artifact already exists or could not be created",
  ));
  try {
    await handle.writeFile(input.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: input.path, sha256: sha256(input.bytes) };
}

async function privateArtifactExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && (stat.mode & 0o077) === 0
      && stat.size >= 2 && stat.size <= MAX_PRIVATE_ARTIFACT_BYTES;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function exactCaseRoot(input: {
  custody_root: string;
  execution_package_path: string;
}): string {
  if (basename(input.execution_package_path) !== "execution-package.json") {
    fail("PRODUCTION_CYCLE_PACKAGE_INVALID", "package filename is not canonical");
  }
  const packageRoot = dirname(input.execution_package_path);
  const remediationRoot = dirname(packageRoot);
  const caseRoot = dirname(remediationRoot);
  const rel = relative(input.custody_root, caseRoot);
  if (basename(packageRoot) !== "owner-package"
    || basename(remediationRoot) !== "remediation"
    || !rel || rel.startsWith("..") || isAbsolute(rel)) {
    fail("PRODUCTION_CYCLE_PACKAGE_INVALID", "package is outside its exact case custody");
  }
  return caseRoot;
}

function parseOperatorReceipt(input: {
  bytes: Uint8Array;
  command: "doctor" | "plan";
}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(input.bytes));
  } catch {
    return fail("PRODUCTION_CYCLE_PREFLIGHT_INVALID", "preflight receipt is not UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("PRODUCTION_CYCLE_PREFLIGHT_INVALID", "preflight receipt is not an object");
  }
  const receipt = parsed as Record<string, unknown>;
  const body = { ...receipt };
  delete body.body_sha256;
  if (receipt.schema_version !== "walmart-listing-repair-operator-receipt/v1"
    || receipt.command !== input.command
    || receipt.body_sha256 !== walmartListingIntegrityControlSha256(body)) {
    fail("PRODUCTION_CYCLE_PREFLIGHT_INVALID", "preflight receipt identity or seal differs");
  }
  return receipt;
}

async function exactFileSha(pathValue: string, expectedSha: string): Promise<void> {
  const path = exactPath(pathValue, "execution_package_path");
  if (!/^[a-f0-9]{64}$/u.test(expectedSha)) {
    fail("PRODUCTION_CYCLE_PACKAGE_INVALID", "execution package SHA is invalid");
  }
  const stat = await lstat(path).catch(() => fail(
    "PRODUCTION_CYCLE_PACKAGE_INVALID",
    "execution package does not exist",
  ));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > MAX_PRIVATE_ARTIFACT_BYTES
    || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) {
    fail("PRODUCTION_CYCLE_PACKAGE_INVALID", "execution package is not one private exact file");
  }
  if (sha256(await readFile(path)) !== expectedSha) {
    fail("PRODUCTION_CYCLE_PACKAGE_INVALID", "execution package bytes changed");
  }
}

function replaceState(
  items: readonly WalmartListingIntegrityControlState[],
  next: WalmartListingIntegrityControlState,
): WalmartListingIntegrityControlState[] {
  return items.map((item) => (
    item.identity.listing_key === next.identity.listing_key ? next : item
  ));
}

function currentItem(items: readonly WalmartListingIntegrityControlState[]) {
  return items.find((item) => !ADVANCE_TERMINAL.has(item.state)) ?? null;
}

function safeSegment(value: string): string {
  const prefix = value.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80) || "sku";
  return `${prefix}-${sha256(value).slice(0, 12)}`;
}

export async function publishMainFailureDisposition(input: {
  workspace_root: string;
  disposition: ReturnType<typeof buildWalmartListingIntegrityMainFailureDisposition>;
}) {
  verifyWalmartListingIntegrityMainFailureDisposition(input.disposition);
  const bytes = Buffer.from(`${JSON.stringify(input.disposition, null, 2)}\n`, "utf8");
  const fileSha256 = sha256(bytes);
  const root = join(
    exactPath(input.workspace_root, "workspace_root"),
    "data/audits/walmart-listing-integrity-quarantine",
  );
  const destination = join(
    root,
    `${safeSegment(input.disposition.listing.sku)}-${input.disposition.disposition_id}`,
  );
  const dispositionPath = join(destination, "failure-disposition.json");
  const shaPath = join(destination, "failure-disposition.sha256");
  if (await privateArtifactExists(dispositionPath) || await privateArtifactExists(shaPath)) {
    if (!(await privateArtifactExists(dispositionPath))
      || !(await privateArtifactExists(shaPath))
      || !Buffer.from(await readFile(dispositionPath)).equals(bytes)
      || (await readFile(shaPath)).toString("utf8") !== `${fileSha256}\n`) {
      fail("PRODUCTION_CYCLE_QUARANTINE_INVALID", "published MAIN quarantine differs");
    }
    return {
      status: "QUARANTINE_ALREADY_PUBLISHED" as const,
      disposition_path: dispositionPath,
      disposition_file_sha256: fileSha256,
    };
  }
  await mkdir(root, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  await writeNamedPrivateArtifact({
    path: join(temporary, "failure-disposition.json"),
    bytes,
  });
  await writeNamedPrivateArtifact({
    path: join(temporary, "failure-disposition.sha256"),
    bytes: Buffer.from(`${fileSha256}\n`, "utf8"),
  });
  await rename(temporary, destination);
  return {
    status: "QUARANTINE_PUBLISHED" as const,
    disposition_path: dispositionPath,
    disposition_file_sha256: fileSha256,
  };
}

async function completeMainFailureAdmission(input: {
  process_config: WalmartListingIntegrityFrozenProcessConfig;
  current: WalmartListingIntegrityControlState;
  disposition_file_sha256: string;
  completed_at: string;
}) {
  const binding = {
    root: input.process_config.global_admission_root,
    expected_identity_sha256: input.process_config.global_admission_identity_sha256,
  };
  const inspected = await inspectWalmartListingIntegrityGlobalAdmissionRoot(binding);
  if (inspected.status === "AVAILABLE") {
    return { status: "GLOBAL_ADMISSION_ALREADY_AVAILABLE" as const, terminal: null };
  }
  const claim = inspected.active_claim;
  if (!claim || claim.listing.listing_key !== input.current.identity.listing_key
    || claim.listing.sku !== input.current.identity.sku
    || claim.listing.store_index !== input.current.identity.store_index
    || claim.execution_package_artifact_sha256
      !== input.current.execution_package_sha256
    || claim.permit_authorization_sha256 !== input.current.owner_permit_sha256
    || claim.frozen_release_id_sha256 !== input.process_config.release_id_sha256) {
    fail(
      "PRODUCTION_CYCLE_QUARANTINE_ADMISSION_MISMATCH",
      "active admission differs from terminal MAIN failure",
    );
  }
  const terminal = await completeWalmartListingIntegrityGlobalAdmission({
    binding,
    claim: {
      listing: claim.listing,
      permit_authorization_sha256: claim.permit_authorization_sha256,
      execution_package_artifact_sha256: claim.execution_package_artifact_sha256,
      plan_body_sha256: claim.plan_body_sha256,
      frozen_release_id_sha256: claim.frozen_release_id_sha256,
      claimed_at: claim.claimed_at,
    },
    completed_at: input.completed_at,
    outcome: "QUARANTINED_UNRESOLVED",
    evidence_file_sha256: input.disposition_file_sha256,
  });
  return { status: "GLOBAL_ADMISSION_QUARANTINED" as const, terminal };
}

export async function runWalmartListingIntegrityProductionCycleOnce(input: {
  owner_permit: unknown;
  execution_package_path: string;
  execution_package_sha256: string;
  custody_root: string;
  process_config: WalmartListingIntegrityFrozenProcessConfig;
  reporting_process_config: WalmartListingIntegrityRemediationProcessConfig;
  now?: Date;
}) {
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot();
  if (snapshot.installation !== "INSTALLED" || !snapshot.run) {
    return {
      status: snapshot.installation === "NOT_INSTALLED"
        ? "CONTROL_PLANE_NOT_INSTALLED" as const
        : "NO_ACTIVE_CONTROL_RUN" as const,
      walmart_writes: 0 as const,
    };
  }
  const run = snapshot.run;
  if (run.status !== "ACTIVE") {
    return { status: "CONTROL_RUN_NOT_ACTIVE" as const, walmart_writes: 0 as const };
  }
  if (run.release_id_sha256 !== input.process_config.release_id_sha256
    || run.manifest_sha256 !== input.process_config.manifest_sha256) {
    fail("PRODUCTION_CYCLE_RELEASE_DRIFT", "active control run differs from process config");
  }
  const custodyRoot = await assertPrivateDirectory(input.custody_root);
  await exactFileSha(input.execution_package_path, input.execution_package_sha256);
  const caseRoot = exactCaseRoot({
    custody_root: custodyRoot,
    execution_package_path: input.execution_package_path,
  });
  let items = [...run.items];
  let current = currentItem(items);
  if (!current) {
    return { status: "CONTROL_QUEUE_COMPLETE" as const, walmart_writes: 0 as const };
  }
  if (!OPERATOR_STATES.has(current.state)) {
    return {
      status: "WAITING_NON_OPERATOR_STAGE" as const,
      state: current.state,
      sku: current.identity.sku,
      walmart_writes: 0 as const,
    };
  }
  if (current.execution_package_sha256 !== input.execution_package_sha256) {
    fail("PRODUCTION_CYCLE_PACKAGE_DRIFT", "package differs from active control state");
  }
  const now = input.now ?? new Date();
  let authority = authorizeWalmartListingIntegrityRuntimeForOneSku({
    current,
    owner_permit: input.owner_permit,
    worker_release_id_sha256: run.release_id_sha256,
    now,
  });
  const preflightPrefix = `${current.identity.sku}-r${current.revision}`;
  const needsExecute = current.state === "OWNER_APPROVED"
    || current.state === "APPLY_REQUESTING";
  const needsQualify = current.state === "LIVE_REREAD";
  let doctorArtifact: { path: string; sha256: string } | null = null;
  let planArtifact: { path: string; sha256: string } | null = null;
  if (needsExecute || needsQualify) {
    const doctorBytes = await invokeWalmartListingIntegrityFrozenPreflightProcess({
      config: input.process_config,
      operator_args: ["doctor"],
    });
    const doctor = parseOperatorReceipt({ bytes: doctorBytes, command: "doctor" });
    if (doctor.status !== "READY") {
      fail("PRODUCTION_CYCLE_DOCTOR_NO_GO", "frozen doctor is not READY");
    }
    doctorArtifact = await writePrivateArtifact({
      root: custodyRoot,
      prefix: `${preflightPrefix}-doctor`,
      bytes: doctorBytes,
    });
  }
  if (needsExecute) {
    if (!doctorArtifact) fail("PRODUCTION_CYCLE_PREFLIGHT_INVALID", "doctor artifact is absent");
    const planBytes = await invokeWalmartListingIntegrityFrozenPreflightProcess({
      config: input.process_config,
      operator_args: [
        "plan",
        "--package", input.execution_package_path,
        "--package-sha256", input.execution_package_sha256,
        "--doctor-receipt", doctorArtifact.path,
        "--doctor-receipt-sha256", doctorArtifact.sha256,
      ],
    });
    const plan = parseOperatorReceipt({ bytes: planBytes, command: "plan" });
    if (plan.status !== "READY_TO_EXECUTE_ONE_SKU"
      || plan.execution_package_artifact_sha256 !== input.execution_package_sha256
      || plan.permit_authorization_sha256 !== current.owner_permit_sha256) {
      fail("PRODUCTION_CYCLE_PLAN_NO_GO", "frozen plan differs from exact package/permit");
    }
    planArtifact = await writePrivateArtifact({
      root: custodyRoot,
      prefix: `${preflightPrefix}-plan`,
      bytes: planBytes,
    });
  }

  let applyRequestingTransition = null;
  if (current.state === "OWNER_APPROVED") {
    if (Date.parse(authority.permit_expires_at) - now.getTime() < 5 * 60_000) {
      fail(
        "PRODUCTION_CYCLE_PERMIT_WINDOW_TOO_SHORT",
        "owner permit has less than five minutes remaining before APPLY_REQUESTING",
      );
    }
    const evidence = canonicalBytes({
      schema_version: "walmart-listing-integrity-apply-requesting-evidence/v1",
      action: "ADMIT_EXACT_ONE_SKU_APPLY_REQUESTING",
      listing_key: current.identity.listing_key,
      current_state_body_sha256: current.body_sha256,
      execution_package_sha256: current.execution_package_sha256,
      owner_permit_authorization_sha256:
        authority.owner_permit_authorization_sha256,
      frozen_release_id_sha256: run.release_id_sha256,
      admitted_at: now.toISOString(),
      walmart_writes: 0,
      automatic_retry_allowed: false,
      automatic_replay_allowed: false,
    });
    const next = transitionWalmartListingIntegrityControlState({
      current,
      next_state: "APPLY_REQUESTING",
      transitioned_at: now.toISOString(),
      evidence_sha256: sha256(evidence),
    });
    applyRequestingTransition = await persistWalmartListingIntegrityControlTransition({
      current,
      next,
      evidence_bytes: evidence,
      evidence_role: "ONE_SKU_APPLY_REQUESTING_ADMISSION",
      created_by_principal: "walmart-listing-integrity-production-cycle",
    });
    items = replaceState(items, next);
    current = next;
    authority = authorizeWalmartListingIntegrityRuntimeForOneSku({
      current,
      owner_permit: input.owner_permit,
      worker_release_id_sha256: run.release_id_sha256,
      now,
    });
  }

  const binding: WalmartListingIntegrityFrozenWorkerBinding = {
    run_release_id_sha256: run.release_id_sha256,
    run_manifest_sha256: run.manifest_sha256,
    worker_release_id_sha256: input.process_config.release_id_sha256,
    worker_manifest_sha256: input.process_config.manifest_sha256,
    global_admission_identity_sha256:
      input.process_config.global_admission_identity_sha256,
  };
  const invocation = buildWalmartListingIntegrityFrozenWorkerInvocation({
    current,
    binding,
    authority,
  });
  const prefix = `${current.identity.sku}-r${current.revision}`;
  const operatorRoot = join(caseRoot, "operator");
  const operatorStepRoot = join(operatorRoot, `r${current.revision}-${invocation.command}`);
  await ensurePrivateDirectory(operatorRoot);
  await ensurePrivateDirectory(operatorStepRoot);
  const qualificationCaptureDir = invocation.command === "qualify"
    ? join(operatorStepRoot, "capture.evidence") : null;

  const operatorArgs = invocation.command === "execute"
    ? [
      "execute",
      "--package", input.execution_package_path,
      "--package-sha256", input.execution_package_sha256,
      "--doctor-receipt", doctorArtifact!.path,
      "--doctor-receipt-sha256", doctorArtifact!.sha256,
      "--plan-receipt", planArtifact!.path,
      "--plan-receipt-sha256", planArtifact!.sha256,
      "--confirm", `EXECUTE_ONE_WALMART_SKU:${invocation.listing_key}:${invocation.plan_body_sha256}`,
    ]
    : invocation.command === "resume"
      ? [
        "resume",
        "--package", input.execution_package_path,
        "--package-sha256", input.execution_package_sha256,
        "--confirm", `RESUME_EXACT_FEED_GET_ONLY:${invocation.owner_permit_sha256}`,
      ]
      : [
        "qualify",
        "--package", input.execution_package_path,
        "--package-sha256", input.execution_package_sha256,
        "--doctor-receipt", doctorArtifact!.path,
        "--doctor-receipt-sha256", doctorArtifact!.sha256,
        "--capture-dir", qualificationCaptureDir!,
      ];
  const preparedAt = new Date();
  const workOrder = buildWalmartListingIntegrityFrozenWorkOrder({
    work_order_id: `wliwork-${randomUUID()}`,
    invocation,
    operator_args: operatorArgs,
    created_at: preparedAt.toISOString(),
    expires_at: new Date(preparedAt.getTime() + 15 * 60_000).toISOString(),
  });
  const workOrderArtifact = await writePrivateArtifact({
    root: custodyRoot,
    prefix: `${prefix}-${invocation.command}-work-order`,
    bytes: canonicalBytes(workOrder),
  });
  const operatorReceiptPath = join(operatorStepRoot, "receipt.json");
  let operatorReceiptArtifact: { path: string; sha256: string } | null = null;
  const result = await (async () => {
    if (await privateArtifactExists(operatorReceiptPath)) {
      const receiptBytes = await readFile(operatorReceiptPath);
      operatorReceiptArtifact = {
        path: operatorReceiptPath,
        sha256: sha256(receiptBytes),
      };
      const persisted = await admitAndPersistWalmartListingIntegrityOperatorReceipt({
        stage: "ONE_SKU",
        current,
        receipt_bytes: receiptBytes,
      });
      return {
        status: "OPERATOR_RECEIPT_PERSISTED" as const,
        listing_key: current.identity.listing_key,
        invocation_called: false as const,
        receipt_recovered_without_operator_invocation: true as const,
        persisted,
      };
    }
    return runWalmartListingIntegrityProductionWorkerOnce({
      authority,
      items,
      binding,
      work_order: workOrder,
      process_config: input.process_config,
      now: preparedAt,
      persist_receipt: async (receipt) => {
        operatorReceiptArtifact = await writeNamedPrivateArtifact({
          path: operatorReceiptPath,
          bytes: receipt.receipt_bytes,
        });
        return admitAndPersistWalmartListingIntegrityOperatorReceipt(receipt);
      },
    });
  })();
  let quarantine: Record<string, unknown> | null = null;
  if (result.status === "OPERATOR_RECEIPT_PERSISTED"
    && result.persisted.state.state === "QUARANTINED_UNRESOLVED"
    && invocation.command === "qualify") {
    const qualificationReceiptArtifact = operatorReceiptArtifact as {
      path: string;
      sha256: string;
    } | null;
    if (!qualificationReceiptArtifact) {
      fail(
        "PRODUCTION_CYCLE_QUARANTINE_INVALID",
        "terminal MAIN failure lacks exact Qualification receipt",
      );
    }
    const receiptBytes = await readFile(qualificationReceiptArtifact.path);
    if (sha256(receiptBytes) !== qualificationReceiptArtifact.sha256) {
      fail(
        "PRODUCTION_CYCLE_QUARANTINE_INVALID",
        "terminal Qualification receipt changed before quarantine",
      );
    }
    const disposition = buildWalmartListingIntegrityMainFailureDisposition({
      operator_receipt_bytes: receiptBytes,
      expected_listing: {
        listing_key: current.identity.listing_key,
        sku: current.identity.sku,
        store_index: current.identity.store_index,
      },
      expected_execution_package_sha256: input.execution_package_sha256,
      expected_owner_permit_sha256: current.owner_permit_sha256!,
      expected_plan_body_sha256: invocation.plan_body_sha256,
      expected_frozen_release_id_sha256: input.process_config.release_id_sha256,
      created_at: new Date().toISOString(),
    });
    const published = await publishMainFailureDisposition({
      workspace_root: input.reporting_process_config.workspace_engine_root,
      disposition,
    });
    const admission = await completeMainFailureAdmission({
      process_config: input.process_config,
      current,
      disposition_file_sha256: published.disposition_file_sha256,
      completed_at: disposition.created_at,
    });
    quarantine = {
      disposition,
      published,
      admission,
      marketplace_write_authorized: false,
      automatic_reapply_allowed: false,
    };
  }
  let gallery: Record<string, unknown> | null = null;
  if (result.status === "OPERATOR_RECEIPT_PERSISTED"
    && result.persisted.state.state === "QUALIFIED_PASS") {
    const qualificationReceiptArtifact = operatorReceiptArtifact as {
      path: string;
      sha256: string;
    } | null;
    if (invocation.command !== "qualify" || !qualificationCaptureDir
      || !qualificationReceiptArtifact) {
      fail("PRODUCTION_CYCLE_GALLERY_INVALID", "Qualification PASS lacks exact gallery inputs");
    }
    const galleryDir = join(caseRoot, "final-gallery");
    gallery = await invokeWalmartListingIntegrityRemediationProcess({
      config: input.reporting_process_config,
      command: {
        command: "build-live-gallery",
        before_dir: join(caseRoot, "capture"),
        after_dir: qualificationCaptureDir,
        execution_package: input.execution_package_path,
        qualification_receipt: qualificationReceiptArtifact.path,
        output_dir: galleryDir,
      },
    });
    if (gallery.status !== "LIVE_SURFACE_PASS"
      || gallery.verdict !== "PASS"
      || gallery.next_sku_unblocked !== true) {
      fail("PRODUCTION_CYCLE_GALLERY_INVALID", "factual gallery did not return exact PASS");
    }
  }
  return {
    status: result.status,
    sku: current.identity.sku,
    command: invocation.command,
    apply_requesting_transition: applyRequestingTransition,
    work_order: workOrderArtifact,
    doctor: doctorArtifact,
    plan: planArtifact,
    operator_receipt: operatorReceiptArtifact,
    quarantine,
    gallery,
    result,
  };
}
