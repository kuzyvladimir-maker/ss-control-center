import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  transitionWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";
import {
  loadWalmartListingIntegrityControlRunSnapshot,
} from "./listing-integrity-control-store.server";
import {
  persistWalmartListingIntegrityControlTransition,
} from "./listing-integrity-control-transition-store.server";
import {
  invokeWalmartListingIntegrityRemediationProcess,
  type WalmartListingIntegrityRemediationProcessConfig,
  type WalmartListingIntegrityRemediationProcessCommand,
} from "./listing-integrity-remediation-process-adapter.server";
import {
  compileWalmartListingIntegrityRemediationRoute,
  walmartListingIntegrityRouteIsDeferredImageRepair,
  type WalmartListingIntegrityRemediationRoute,
} from "./listing-integrity-remediation-route";
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
export interface WalmartListingIntegrityProductionRemediationConfig {
  process: WalmartListingIntegrityRemediationProcessConfig;
  owner_private_key_path: string;
  owner_package_custody_root: string;
  frozen_release_id_sha256: string;
  approved_by: string;
  defer_image_repairs: boolean;
}

type JsonRecord = Record<string, unknown>;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as JsonRecord;
  return `{${Object.keys(row).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(row[key])}`
  )).join(",")}}`;
}

function evidenceBytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function exactPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail("REMEDIATION_PATH_INVALID", `${label} must be an absolute normalized path`);
  }
  return value;
}

async function privateDirectory(value: string, label: string): Promise<string> {
  const path = exactPath(value, label);
  const stat = await lstat(path).catch(() => fail(
    "REMEDIATION_CUSTODY_INVALID",
    `${label} is missing`,
  ));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(path) !== path
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    fail("REMEDIATION_CUSTODY_INVALID", `${label} must be private canonical custody`);
  }
  return path;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || await realpath(path) !== path) {
      fail("REMEDIATION_CUSTODY_INVALID", "existing directory is not private custody");
    }
  });
}

async function readJson(path: string, label: string): Promise<{
  bytes: Buffer;
  value: JsonRecord;
  file_sha256: string;
}> {
  const stat = await lstat(path).catch(() => fail(
    "REMEDIATION_ARTIFACT_INVALID",
    `${label} is missing`,
  ));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 2 || stat.size > MAX_JSON_BYTES) {
    fail("REMEDIATION_ARTIFACT_INVALID", `${label} must be one bounded regular file`);
  }
  const bytes = await readFile(path);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    return fail("REMEDIATION_ARTIFACT_INVALID", `${label} is not UTF-8 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("REMEDIATION_ARTIFACT_INVALID", `${label} must be one object`);
  }
  return { bytes, value: value as JsonRecord, file_sha256: sha256(bytes) };
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function currentItem(items: readonly WalmartListingIntegrityControlState[]) {
  return items.find((item) => !TERMINAL.has(item.state)) ?? null;
}

function caseId(current: WalmartListingIntegrityControlState): string {
  return `case-${current.identity.ordinal}-${sha256(current.identity.listing_key).slice(0, 16)}`;
}

function exactRolePath(index: JsonRecord, captureRoot: string, role: string): string {
  const files = Array.isArray(index.files) ? index.files : [];
  const matches = files.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as JsonRecord).role === role
  )) as JsonRecord[];
  if (matches.length !== 1 || typeof matches[0]?.path !== "string") {
    fail("REMEDIATION_INTAKE_INVALID", `intake must contain exactly one ${role}`);
  }
  const path = resolve(captureRoot, matches[0].path);
  const rel = relative(captureRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    fail("REMEDIATION_INTAKE_INVALID", `${role} escapes capture custody`);
  }
  return path;
}

async function persist(input: {
  current: WalmartListingIntegrityControlState;
  next_state: "REPAIR_PLANNED" | "AWAITING_OWNER" | "OWNER_APPROVED"
    | "QUARANTINED_UNRESOLVED";
  evidence: unknown;
  role: string;
  execution_package_sha256?: string;
  owner_permit_sha256?: string;
}) {
  const bytes = evidenceBytes(input.evidence);
  const next = transitionWalmartListingIntegrityControlState({
    current: input.current,
    next_state: input.next_state,
    transitioned_at: new Date().toISOString(),
    evidence_sha256: sha256(bytes),
    execution_package_sha256: input.execution_package_sha256,
    owner_permit_sha256: input.owner_permit_sha256,
  });
  return persistWalmartListingIntegrityControlTransition({
    current: input.current,
    next,
    evidence_bytes: bytes,
    evidence_role: input.role,
    created_by_principal: "walmart-listing-integrity-remediation-planner",
  });
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runExactStep(input: {
  output_dir: string;
  terminal_artifact: string;
  command: WalmartListingIntegrityRemediationProcessCommand;
  process_config: WalmartListingIntegrityRemediationProcessConfig;
  invoke: typeof invokeWalmartListingIntegrityRemediationProcess;
}): Promise<void> {
  if (await artifactExists(input.terminal_artifact)) return;
  let outputExists = true;
  try {
    await lstat(input.output_dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    outputExists = false;
  }
  if (outputExists) {
    fail(
      "REMEDIATION_STEP_INCOMPLETE_NO_RETRY",
      `${input.command.command} has custody without its terminal artifact`,
    );
  }
  await input.invoke({ config: input.process_config, command: input.command });
  if (!await artifactExists(input.terminal_artifact)) {
    fail(
      "REMEDIATION_STEP_INCOMPLETE_NO_RETRY",
      `${input.command.command} returned without its terminal artifact`,
    );
  }
}

async function quarantine(input: {
  current: WalmartListingIntegrityControlState;
  route: WalmartListingIntegrityRemediationRoute;
  reason: string;
  case_root: string;
}) {
  const result = await persist({
    current: input.current,
    next_state: "QUARANTINED_UNRESOLVED",
    role: "REMEDIATION_ROUTE_QUARANTINED",
    evidence: {
      schema_version: "walmart-listing-integrity-remediation-quarantine/v1",
      listing: input.current.identity,
      route: input.route,
      reason: input.reason.slice(0, 2_000),
      reason_fingerprint_sha256: sha256(input.reason),
      case_root: input.case_root,
      walmart_writes: 0,
      automatic_retry_allowed: false,
      automatic_replay_allowed: false,
      next_action: "ADVANCE_AND_REVIEW_QUARANTINE_SEPARATELY",
    },
  });
  return {
    status: result.state.state,
    sku: input.current.identity.sku,
    result,
    walmart_writes: 0 as const,
  };
}

export async function runWalmartListingIntegrityProductionRemediationOnce(input: {
  custody_root: string;
  config: WalmartListingIntegrityProductionRemediationConfig;
  invoke?: typeof invokeWalmartListingIntegrityRemediationProcess;
}) {
  const snapshot = await loadWalmartListingIntegrityControlRunSnapshot();
  if (snapshot.installation !== "INSTALLED" || !snapshot.run
    || snapshot.run.status !== "ACTIVE") {
    return { status: "NO_ACTIVE_CONTROL_RUN" as const, walmart_writes: 0 as const };
  }
  let current = currentItem(snapshot.run.items);
  if (!current) return { status: "CONTROL_QUEUE_COMPLETE" as const, walmart_writes: 0 as const };
  if (current.state !== "ISSUE_PROVEN") {
    return {
      status: "WAITING_NON_REMEDIATION_STAGE" as const,
      sku: current.identity.sku,
      state: current.state,
      walmart_writes: 0 as const,
    };
  }
  if (snapshot.run.release_id_sha256 !== input.config.frozen_release_id_sha256) {
    fail("REMEDIATION_RELEASE_DRIFT", "active run differs from the frozen package release");
  }
  const root = await privateDirectory(input.custody_root, "custody_root");
  await privateDirectory(input.config.owner_package_custody_root, "owner_package_custody_root");
  exactPath(input.config.owner_private_key_path, "owner_private_key_path");
  const keyStat = await lstat(input.config.owner_private_key_path).catch(() => fail(
    "REMEDIATION_KEY_INVALID",
    "owner service key is missing",
  ));
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.nlink !== 1
    || (keyStat.mode & 0o077) !== 0) {
    fail("REMEDIATION_KEY_INVALID", "owner service key must be one private regular file");
  }
  const caseRoot = join(root, snapshot.run.run_id, caseId(current));
  const captureRoot = join(caseRoot, "capture");
  const diagnosisPath = join(caseRoot, WALMART_LISTING_SINGLE_DIAGNOSIS_FILENAME);
  const [diagnosis, intake] = await Promise.all([
    readJson(diagnosisPath, "diagnosis"),
    readJson(join(captureRoot, "intake-index.json"), "intake index"),
  ]);
  const route = compileWalmartListingIntegrityRemediationRoute({
    diagnosis: diagnosis.value,
    expected_listing_key: current.identity.listing_key,
    expected_sku: current.identity.sku,
  });
  const remediationRoot = join(caseRoot, "remediation");
  await ensurePrivateDirectory(remediationRoot);
  const routePath = join(remediationRoot, "route.json");
  const routeBytes = Buffer.from(`${JSON.stringify(route, null, 2)}\n`, "utf8");
  if (!await artifactExists(routePath)) await writeExclusive(routePath, routeBytes);
  else if (sha256(await readFile(routePath)) !== sha256(routeBytes)) {
    fail("REMEDIATION_ROUTE_DRIFT", "persisted route differs from fresh diagnosis route");
  }
  if (route.status !== "AUTOMATIC_ROUTE_READY") {
    return quarantine({
      current,
      route,
      reason: route.blockers.join("; ") || "no automatic frozen route",
      case_root: caseRoot,
    });
  }
  if (walmartListingIntegrityRouteIsDeferredImageRepair({
    route,
    defer_image_repairs: input.config.defer_image_repairs,
  })) {
    return quarantine({
      current,
      route,
      reason: "IMAGE_REMEDIATION_DEFERRED_BY_OWNER_POLICY",
      case_root: caseRoot,
    });
  }
  const productTruth = exactRolePath(intake.value, captureRoot, "product_truth");
  const buyerSnapshot = exactRolePath(intake.value, captureRoot, "buyer_snapshot_manifest");
  const buyerPdp = exactRolePath(intake.value, captureRoot, "buyer_pdp_payload");
  const sellerItem = exactRolePath(intake.value, captureRoot, "seller_item_payload");
  const mainDir = join(remediationRoot, "main-candidate");
  const qualificationDir = join(remediationRoot, "main-qualification");
  const previewDir = join(remediationRoot, "preview");
  const stagingDir = join(remediationRoot, "r2-staging");
  const compilationDir = join(remediationRoot, "compilation");
  const packageDir = join(remediationRoot, "owner-package");
  const textDir = join(remediationRoot, "text-candidate");
  const textReviewPath = join(textDir, "review-certification.json");
  const imageSetDir = join(remediationRoot, "image-set-candidate");
  const imageSetQualificationDir = join(remediationRoot, "image-set-qualification");
  const curatedImageSetDir = join(remediationRoot, "image-set-curated");
  const invoke = input.invoke ?? invokeWalmartListingIntegrityRemediationProcess;
  let compilationFileSha = "";
  let ownerConfirmation = "";
  let previewPath = join(previewDir, "gallery.html");
  try {
    if (route.route === "NON_IMAGE") {
      previewPath = join(compilationDir, "review-proposal.json");
      await runExactStep({
        output_dir: compilationDir,
        terminal_artifact: join(compilationDir, "compilation-request.json"),
        command: {
          command: "build-non-image",
          product_truth: productTruth,
          diagnosis: diagnosisPath,
          buyer_snapshot: buyerSnapshot,
          buyer_pdp: buyerPdp,
          output_dir: compilationDir,
        },
        process_config: input.config.process,
        invoke,
      });
    } else if (route.route === "DESCRIPTION_BULLETS_MAIN") {
      await runExactStep({
        output_dir: mainDir,
        terminal_artifact: join(mainDir, "manifest.json"),
        command: { command: "build-main", product_truth: productTruth, diagnosis: diagnosisPath, output_dir: mainDir },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: qualificationDir,
        terminal_artifact: join(qualificationDir, "qualification.json"),
        command: { command: "qualify-main", candidate_dir: mainDir, diagnosis: diagnosisPath, output_dir: qualificationDir },
        process_config: input.config.process,
        invoke,
      });
      const qualification = await readJson(
        join(qualificationDir, "qualification.json"),
        "MAIN qualification",
      );
      if (qualification.value.status !== "PASS") {
        return quarantine({ current, route, reason: "MAIN_CANDIDATE_QUALIFICATION_FAILED", case_root: caseRoot });
      }
      await runExactStep({
        output_dir: previewDir,
        terminal_artifact: join(previewDir, "preview.json"),
        command: {
          command: "preview-main",
          product_truth: productTruth,
          diagnosis: diagnosisPath,
          buyer_snapshot: buyerSnapshot,
          buyer_pdp: buyerPdp,
          candidate_dir: mainDir,
          candidate_qualification: join(qualificationDir, "qualification.json"),
          output_dir: previewDir,
        },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: stagingDir,
        terminal_artifact: join(stagingDir, "r2-staging.json"),
        command: {
          command: "stage-main",
          candidate_dir: mainDir,
          qualification: join(qualificationDir, "qualification.json"),
          output_dir: stagingDir,
        },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: compilationDir,
        terminal_artifact: join(compilationDir, "compilation-request.json"),
        command: {
          command: "compile-main",
          preview: join(previewDir, "preview.json"),
          diagnosis: diagnosisPath,
          buyer_snapshot: buyerSnapshot,
          buyer_pdp: buyerPdp,
          seller_item: sellerItem,
          product_truth: productTruth,
          candidate_dir: mainDir,
          qualification_dir: qualificationDir,
          r2_staging: join(stagingDir, "r2-staging.json"),
          output_dir: compilationDir,
        },
        process_config: input.config.process,
        invoke,
      });
    } else if (route.route === "DESCRIPTION_BULLETS_MAIN_GALLERY") {
      await runExactStep({
        output_dir: mainDir,
        terminal_artifact: join(mainDir, "manifest.json"),
        command: { command: "build-main", product_truth: productTruth, diagnosis: diagnosisPath, output_dir: mainDir },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: imageSetDir,
        terminal_artifact: join(imageSetDir, "manifest.json"),
        command: {
          command: "build-image-set",
          product_truth: productTruth,
          diagnosis: diagnosisPath,
          main_candidate_dir: mainDir,
          output_dir: imageSetDir,
        },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: imageSetQualificationDir,
        terminal_artifact: join(imageSetQualificationDir, "qualification.json"),
        command: {
          command: "qualify-image-set",
          candidate_dir: imageSetDir,
          diagnosis: diagnosisPath,
          output_dir: imageSetQualificationDir,
        },
        process_config: input.config.process,
        invoke,
      });
      const qualification = await readJson(
        join(imageSetQualificationDir, "qualification.json"),
        "image-set qualification",
      );
      if (qualification.value.status !== "PASS") {
        return quarantine({ current, route, reason: "IMAGE_SET_QUALIFICATION_FAILED", case_root: caseRoot });
      }
      await runExactStep({
        output_dir: curatedImageSetDir,
        terminal_artifact: join(curatedImageSetDir, "manifest.json"),
        command: {
          command: "curate-image-set",
          candidate_dir: imageSetDir,
          qualification_dir: imageSetQualificationDir,
          diagnosis: diagnosisPath,
          output_dir: curatedImageSetDir,
        },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: stagingDir,
        terminal_artifact: join(stagingDir, "r2-staging.json"),
        command: {
          command: "stage-main",
          candidate_dir: curatedImageSetDir,
          qualification: join(imageSetQualificationDir, "qualification.json"),
          output_dir: stagingDir,
        },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: previewDir,
        terminal_artifact: join(previewDir, "preview.json"),
        command: {
          command: "preview-image-set",
          product_truth: productTruth,
          diagnosis: diagnosisPath,
          buyer_snapshot: buyerSnapshot,
          buyer_pdp: buyerPdp,
          curated_candidate_dir: curatedImageSetDir,
          r2_staging: join(stagingDir, "r2-staging.json"),
          output_dir: previewDir,
        },
        process_config: input.config.process,
        invoke,
      });
      await runExactStep({
        output_dir: compilationDir,
        terminal_artifact: join(compilationDir, "compilation-request.json"),
        command: {
          command: "compile-image-set",
          preview: join(previewDir, "preview.json"),
          diagnosis: diagnosisPath,
          buyer_snapshot: buyerSnapshot,
          buyer_pdp: buyerPdp,
          seller_item: sellerItem,
          product_truth: productTruth,
          main_candidate_dir: mainDir,
          source_candidate_dir: imageSetDir,
          qualification_dir: imageSetQualificationDir,
          curated_dir: curatedImageSetDir,
          r2_staging: join(stagingDir, "r2-staging.json"),
          output_dir: compilationDir,
        },
        process_config: input.config.process,
        invoke,
      });
    } else {
      previewPath = join(textDir, "review-proposal.json");
      await runExactStep({
        output_dir: textDir,
        terminal_artifact: join(textDir, "review-proposal.json"),
        command: {
          command: "build-text",
          product_truth: productTruth,
          diagnosis: diagnosisPath,
          buyer_snapshot: buyerSnapshot,
          buyer_pdp: buyerPdp,
          output_dir: textDir,
        },
        process_config: input.config.process,
        invoke,
      });
      if (!await artifactExists(textReviewPath)) {
        await invoke({
          config: input.config.process,
          command: {
            command: "review-text",
            proposal: join(textDir, "review-proposal.json"),
            diagnosis: diagnosisPath,
            buyer_snapshot: buyerSnapshot,
            buyer_pdp: buyerPdp,
            donor_audit: join(textDir, "donor-audit.json"),
            asset_root: captureRoot,
            output: textReviewPath,
          },
        });
      }
      if (!await artifactExists(textReviewPath)) {
        fail("REMEDIATION_STEP_INCOMPLETE_NO_RETRY", "text review has no certification");
      }
      const compilationPath = join(compilationDir, "compilation-request.json");
      if (!await artifactExists(compilationPath)) {
        await ensurePrivateDirectory(compilationDir);
        await invoke({
          config: input.config.process,
          command: {
            command: "compile-text",
            proposal: join(textDir, "review-proposal.json"),
            diagnosis: diagnosisPath,
            buyer_snapshot: buyerSnapshot,
            buyer_pdp: buyerPdp,
            donor_audit: join(textDir, "donor-audit.json"),
            certification: textReviewPath,
            asset_root: captureRoot,
            output: compilationPath,
          },
        });
      }
      if (!await artifactExists(compilationPath)) {
        fail("REMEDIATION_STEP_INCOMPLETE_NO_RETRY", "text compilation has no request");
      }
    }
    const compilation = await readJson(
      join(compilationDir, "compilation-request.json"),
      "compilation request",
    );
    compilationFileSha = compilation.file_sha256;
    const ownerGate = compilation.value.owner_gate as JsonRecord | undefined;
    const repair = compilation.value.repair as JsonRecord | undefined;
    if (typeof ownerGate?.exact_confirmation !== "string"
      || !ownerGate.exact_confirmation || ownerGate.current_walmart_write_authorized !== false
      || ownerGate.current_mass_run_authorized !== false
      || walmartListingIntegrityControlSha256(repair?.changed_fields)
        !== walmartListingIntegrityControlSha256(route.changed_fields)) {
      fail("REMEDIATION_OWNER_POLICY_DRIFT", "compilation request scope or owner policy differs");
    }
    ownerConfirmation = ownerGate.exact_confirmation;
    await runExactStep({
      output_dir: packageDir,
      terminal_artifact: join(packageDir, "package-report.json"),
      command: {
        command: "package",
        compilation_request: join(compilationDir, "compilation-request.json"),
        owner_confirmation: ownerConfirmation,
        private_key: input.config.owner_private_key_path,
        custody_root: input.config.owner_package_custody_root,
        output_dir: packageDir,
        verifier_release_sha256: input.config.frozen_release_id_sha256,
        apply_release_sha256: input.config.frozen_release_id_sha256,
        approved_by: input.config.approved_by,
      },
      process_config: input.config.process,
      invoke,
    });
  } catch (error) {
    return quarantine({
      current,
      route,
      reason: error instanceof Error ? `${error.name}:${error.message}` : String(error),
      case_root: caseRoot,
    });
  }
  const [packageReport, permit, executionPackage] = await Promise.all([
    readJson(join(packageDir, "package-report.json"), "package report"),
    readJson(join(packageDir, "one-sku-owner-permit.json"), "one-SKU permit"),
    readJson(join(packageDir, "execution-package.json"), "execution package"),
  ]);
  const reportListing = packageReport.value.listing as JsonRecord | undefined;
  const reportSafety = packageReport.value.safety as JsonRecord | undefined;
  const hashes = packageReport.value.hashes as JsonRecord | undefined;
  if (packageReport.value.schema_version !== "walmart-listing-repair-owner-package-report/v1"
    || packageReport.value.status !== "READY_FOR_EXPLICIT_EXECUTE"
    || reportListing?.listing_key !== current.identity.listing_key
    || reportListing.sku !== current.identity.sku
    || reportSafety?.exact_listing_count !== 1
    || reportSafety.mass_apply_allowed !== false
    || reportSafety.price_unchanged !== true
    || reportSafety.inventory_unchanged !== true
    || hashes?.["execution-package.json"] !== executionPackage.file_sha256
    || hashes?.["one-sku-owner-permit.json"] !== permit.file_sha256) {
    fail("REMEDIATION_PACKAGE_INVALID", "owner package identity, policy, or hashes differ");
  }
  const permitAuthorization = permit.value.authorization_sha256;
  if (typeof permitAuthorization !== "string" || !/^[a-f0-9]{64}$/u.test(permitAuthorization)) {
    fail("REMEDIATION_PACKAGE_INVALID", "permit authorization SHA is invalid");
  }
  const planned = await persist({
    current,
    next_state: "REPAIR_PLANNED",
    execution_package_sha256: executionPackage.file_sha256,
    role: "EXACT_REPAIR_PACKAGE_COMPILED",
    evidence: {
      schema_version: "walmart-listing-integrity-remediation-package/v1",
      listing: current.identity,
      route,
      compilation_request_path: join(compilationDir, "compilation-request.json"),
      compilation_request_file_sha256: compilationFileSha,
      package_report_path: join(packageDir, "package-report.json"),
      package_report_file_sha256: packageReport.file_sha256,
      execution_package_path: join(packageDir, "execution-package.json"),
      execution_package_file_sha256: executionPackage.file_sha256,
      walmart_writes: 0,
    },
  });
  current = planned.state;
  const awaiting = await persist({
    current,
    next_state: "AWAITING_OWNER",
    role: "EXACT_OWNER_POLICY_BOUND",
    evidence: {
      schema_version: "walmart-listing-integrity-owner-policy-binding/v1",
      listing: current.identity,
      exact_confirmation: ownerConfirmation,
      owner_confirmation_source: "OWNER_CHAT_BLANKET_CONTINUATION_AUTHORIZATION",
      walmart_writes: 0,
    },
  });
  current = awaiting.state;
  const approved = await persist({
    current,
    next_state: "OWNER_APPROVED",
    owner_permit_sha256: permitAuthorization,
    role: "SIGNED_ONE_SKU_PERMIT_ADMITTED",
    evidence: {
      schema_version: "walmart-listing-integrity-owner-permit-binding/v1",
      listing: current.identity,
      owner_permit_path: join(packageDir, "one-sku-owner-permit.json"),
      owner_permit_file_sha256: permit.file_sha256,
      owner_permit_authorization_sha256: permitAuthorization,
      execution_package_file_sha256: executionPackage.file_sha256,
      exact_listing_count: 1,
      mass_apply_allowed: false,
      walmart_writes: 0,
    },
  });
  await chmod(remediationRoot, 0o500);
  return {
    status: approved.state.state,
    sku: current.identity.sku,
    route: route.route,
    execution_package_path: join(packageDir, "execution-package.json"),
    execution_package_sha256: executionPackage.file_sha256,
    owner_permit_path: join(packageDir, "one-sku-owner-permit.json"),
    owner_permit_file_sha256: permit.file_sha256,
    owner_permit_authorization_sha256: permitAuthorization,
    preview_path: previewPath,
    walmart_writes: 0 as const,
  };
}
