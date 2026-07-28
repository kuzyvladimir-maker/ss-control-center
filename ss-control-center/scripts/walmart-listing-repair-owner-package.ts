#!/usr/bin/env node

/**
 * Owner-side one-command package builder for one reviewed Walmart repair.
 *
 * `package` validates the frozen review and exact owner confirmation before any
 * network call, captures fresh read-only Walmart item/spec bytes without retry,
 * signs the one-SKU sequence/permit with the external password-free key, and
 * atomically publishes a data-only execution package. It never submits a feed.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleWalmartListingRepairOwnerAuthorization,
  inspectWalmartListingRepairOwnerTrustRoot,
  verifyCurrentWalmartListingRepairOneSkuPermit,
  verifyWalmartListingRepairSequenceAuthorization,
  walmartListingRepairOneSkuPermitSigningEnvelope,
  walmartListingRepairOwnerSigningMessage,
  walmartListingRepairSequenceSigningEnvelope,
  type WalmartListingRepairOwnerAuthorization,
  type WalmartListingRepairOwnerSigningEnvelope,
} from "../src/lib/walmart/listing-integrity-remediation-authority.ts";
import {
  captureWalmartListingRepairOwnerMaterials,
  type WalmartListingRepairMaterialCaptureResult,
} from "../src/lib/walmart/listing-integrity-remediation-owner-material-capture.ts";
import {
  buildReviewedWalmartListingRepairProductTruthArtifact,
  buildWalmartListingRepairPlanFromCompilationRequest,
  buildWalmartListingRepairSequenceBodyFromCompilationRequest,
  compileWalmartListingRepairOwnerDraft,
  finalizeWalmartListingRepairExecutionPackage,
  verifyWalmartListingRepairCompilationRequest,
  type ReviewedWalmartListingRepairProductTruthArtifact,
  type VerifiedWalmartListingRepairCompilationRequest,
} from "../src/lib/walmart/listing-integrity-remediation-owner-compiler.ts";
import {
  certifyWalmartListingRepairReviewedMain,
  type WalmartListingRepairReviewedMainEvidence,
} from "../src/lib/walmart/listing-integrity-remediation-reviewed-main-certificate.ts";
import {
  certifyWalmartListingRepairReviewedImageSet,
  type ExactReviewedImageSetArtifact,
  type WalmartListingRepairReviewedImageSetEvidence,
} from "../src/lib/walmart/listing-integrity-remediation-reviewed-image-set-certificate.ts";
import {
  canonicalWalmartListingSurgicalJson,
} from "../src/lib/walmart/listing-integrity-remediation-payload.ts";
import {
  bootstrapWalmartListingRepairConsumptionLedger,
} from "../src/lib/walmart/listing-integrity-remediation-ledger.ts";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPOSITORY_ROOT = path.resolve(PROJECT_ROOT, "..");
const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingRepairOwnerPackageArgs {
  command: "doctor" | "package";
  compilation_request?: string;
  owner_confirmation?: string;
  private_key?: string;
  custody_root?: string;
  output_dir?: string;
  verifier_release_sha256?: string;
  apply_release_sha256?: string;
  approved_by?: string;
}

export interface WalmartListingRepairOwnerPackageReport {
  schema_version: "walmart-listing-repair-owner-package-report/v1";
  status: "READY_FOR_EXPLICIT_EXECUTE";
  created_at: string;
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  changed_fields:
    | ["description", "bullets"]
    | ["description", "bullets", "main"]
    | ["description", "bullets", "main", "gallery"]
    | ["attributes"];
  product_type: string;
  artifacts: Record<string, string>;
  hashes: Record<string, string>;
  execution: {
    oauth_token_calls: 1;
    walmart_read_calls: 2 | 3;
    walmart_content_writes: 0;
    database_reads: 0;
    database_writes: 0;
    model_calls: 0;
    retries: 0;
    redirects: 0;
  };
  safety: {
    exact_listing_count: 1;
    signed_one_sku_permit: true;
    package_is_not_executed: true;
    title_unchanged: true;
    images_unchanged: boolean;
    price_unchanged: true;
    inventory_unchanged: true;
    listing_status_unchanged: true;
    mass_apply_allowed: false;
  };
  next_command: string;
  body_sha256: string;
}

function fail(message: string): never {
  throw new Error(`Walmart owner package rejected input: ${message}`);
}

function text(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function exactAbsolute(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!path.isAbsolute(parsed) || path.normalize(parsed) !== parsed) {
    fail(`${label} must be an exact normalized absolute path`);
  }
  return parsed;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
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
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function seal<T extends JsonRecord>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: sha256(canonicalJson(body)) };
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStable(
  filePath: string,
  label: string,
  maximumBytes = MAX_JSON_BYTES,
): Promise<Buffer> {
  const exact = exactAbsolute(filePath, label);
  const before = await lstat(exact).catch(() => fail(`${label} is missing`));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > maximumBytes
    || (before.mode & 0o022) !== 0 || await realpath(exact) !== exact) {
    fail(`${label} is not a stable non-writable regular file`);
  }
  const handle = await open(
    exact,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail(`${label} raced before read`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(exact);
    if (bytes.byteLength !== opened.size || !sameFile(opened, after)
      || !sameFile(after, afterPath) || await realpath(exact) !== exact) {
      fail(`${label} changed during read`);
    }
    return Buffer.from(bytes);
  } finally {
    await handle.close();
  }
}

async function loadReviewedMainEvidence(
  request: VerifiedWalmartListingRepairCompilationRequest,
): Promise<WalmartListingRepairReviewedMainEvidence | null> {
  const refs = request.repair.changed_main_evidence;
  if (!refs) return null;
  const entries = await Promise.all(
    Object.entries(refs).map(async ([role, reference]) => {
      const bytes = await readStable(
        reference.absolute_path,
        `changed MAIN evidence ${role}`,
      );
      if (sha256(bytes) !== reference.file_sha256) {
        fail(`changed MAIN evidence ${role} exact file SHA mismatch`);
      }
      return [role, {
        bytes,
        sha256: reference.file_sha256,
      }] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as WalmartListingRepairReviewedMainEvidence;
}

async function loadReviewedImageSetEvidence(
  request: VerifiedWalmartListingRepairCompilationRequest,
): Promise<WalmartListingRepairReviewedImageSetEvidence | null> {
  const refs = request.repair.changed_image_set_evidence;
  if (!refs) return null;
  const loadOne = async (
    role: string,
    reference: { absolute_path: string; file_sha256: string },
  ): Promise<ExactReviewedImageSetArtifact> => {
    const bytes = await readStable(
      reference.absolute_path,
      `changed image-set evidence ${role}`,
    );
    if (sha256(bytes) !== reference.file_sha256) {
      fail(`changed image-set evidence ${role} exact file SHA mismatch`);
    }
    return { bytes, sha256: reference.file_sha256 };
  };
  return {
    product_truth: await loadOne("product_truth", refs.product_truth),
    main_candidate_manifest: await loadOne(
      "main_candidate_manifest",
      refs.main_candidate_manifest,
    ),
    single_unit_source: await loadOne("single_unit_source", refs.single_unit_source),
    source_candidate_manifest: await loadOne(
      "source_candidate_manifest",
      refs.source_candidate_manifest,
    ),
    source_candidate_assets: await Promise.all(
      refs.source_candidate_assets.map((reference, index) =>
        loadOne(`source_candidate_assets[${index}]`, reference)),
    ),
    source_qualification: await loadOne(
      "source_qualification",
      refs.source_qualification,
    ),
    observer_plan: await loadOne("observer_plan", refs.observer_plan),
    observer_requests: await Promise.all(
      refs.observer_requests.map((reference, index) =>
        loadOne(`observer_requests[${index}]`, reference)),
    ),
    observer_responses: await Promise.all(
      refs.observer_responses.map((reference, index) =>
        loadOne(`observer_responses[${index}]`, reference)),
    ),
    curated_manifest: await loadOne("curated_manifest", refs.curated_manifest),
    curated_target_assets: await Promise.all(
      refs.curated_target_assets.map((reference, index) =>
        loadOne(`curated_target_assets[${index}]`, reference)),
    ),
    r2_staging: await loadOne("r2_staging", refs.r2_staging),
  };
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} must be UTF-8 JSON`);
  }
}

async function ownerPrivateKey(filePath: string): Promise<{
  key: KeyObject;
  key_id: string;
  public_fingerprint_sha256: string;
}> {
  const exact = exactAbsolute(filePath, "--private-key");
  if (isWithin(exact, REPOSITORY_ROOT)) {
    fail("owner private key must remain outside the repository");
  }
  const info = await lstat(exact).catch(() => fail("owner private key is missing"));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || (info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0
    || info.size < 1 || info.size > MAX_KEY_BYTES
    || await realpath(exact) !== exact) {
    fail("owner private key must be a private stable 0400/0600 regular file");
  }
  const bytes = await readStable(exact, "owner private key", MAX_KEY_BYTES);
  let key: KeyObject;
  try {
    key = createPrivateKey(bytes);
  } catch {
    return fail("owner private key must be an unencrypted password-free PEM");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail("owner private key must be Ed25519");
  }
  const publicDer = createPublicKey(key).export({ type: "spki", format: "der" });
  const fingerprint = sha256(publicDer);
  const trust = inspectWalmartListingRepairOwnerTrustRoot("PRODUCTION");
  if (!trust.ready || !trust.active_key_fingerprints.includes(fingerprint)
    || trust.active_key_ids.length !== 1) {
    fail("owner private key public half is not the pinned production trust root");
  }
  return {
    key,
    key_id: trust.active_key_ids[0]!,
    public_fingerprint_sha256: fingerprint,
  };
}

function signEnvelope<TBody>(
  envelope: WalmartListingRepairOwnerSigningEnvelope<TBody>,
  key: KeyObject,
): WalmartListingRepairOwnerAuthorization<TBody> {
  return assembleWalmartListingRepairOwnerAuthorization({
    envelope,
    signature_base64: sign(
      null,
      walmartListingRepairOwnerSigningMessage(envelope),
      key,
    ).toString("base64"),
  });
}

function addMilliseconds(instant: Date, milliseconds: number): string {
  return new Date(instant.getTime() + milliseconds).toISOString();
}

function credentials(storeIndex: number): {
  client_id: string;
  client_secret: string;
  seller_id: string;
} {
  return {
    client_id: text(
      process.env[`WALMART_CLIENT_ID_STORE${storeIndex}`],
      `WALMART_CLIENT_ID_STORE${storeIndex}`,
      512,
    ),
    client_secret: text(
      process.env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`],
      `WALMART_CLIENT_SECRET_STORE${storeIndex}`,
      2_048,
    ),
    seller_id: text(
      process.env[`WALMART_STORE${storeIndex}_SELLER_ID`],
      `WALMART_STORE${storeIndex}_SELLER_ID`,
      512,
    ),
  };
}

async function writeExclusive(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function renderJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function publishArtifacts(input: {
  output_dir: string;
  artifacts: Record<string, Uint8Array>;
}): Promise<void> {
  const output = exactAbsolute(input.output_dir, "--output-dir");
  const parent = path.dirname(output);
  const parentInfo = await lstat(parent).catch(() => fail("output parent is missing"));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
    || await realpath(parent) !== parent) {
    fail("output parent must be a real directory");
  }
  const exists = await lstat(output).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (exists) fail("--output-dir already exists");
  const temporary = path.join(
    parent,
    `.${path.basename(output)}.partial-${randomUUID()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const [name, bytes] of Object.entries(input.artifacts)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(name)) {
        fail(`unsafe output artifact name: ${name}`);
      }
      await writeExclusive(path.join(temporary, name), bytes);
    }
    await chmod(temporary, 0o700);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv: readonly string[]): WalmartListingRepairOwnerPackageArgs {
  const command = argv[0];
  if (command === "doctor") {
    if (argv.length !== 1) fail("doctor accepts no arguments");
    return { command };
  }
  if (command !== "package") {
    fail("first argument must be doctor or package");
  }
  const flags = new Map<string, string>();
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) fail(`unsupported argument: ${argument}`);
    flags.set(match[1]!, match[2]!);
  }
  const exact = [
    "compilation-request",
    "owner-confirmation",
    "private-key",
    "custody-root",
    "output-dir",
    "verifier-release-sha256",
    "apply-release-sha256",
    "approved-by",
  ] as const;
  if (flags.size !== exact.length || exact.some((flag) => !flags.has(flag))) {
    fail(`package requires exactly: ${exact.map((flag) => `--${flag}=...`).join(" ")}`);
  }
  return {
    command,
    compilation_request:
      exactAbsolute(flags.get("compilation-request"), "--compilation-request"),
    owner_confirmation: text(
      flags.get("owner-confirmation"),
      "--owner-confirmation",
    ),
    private_key: exactAbsolute(flags.get("private-key"), "--private-key"),
    custody_root: exactAbsolute(flags.get("custody-root"), "--custody-root"),
    output_dir: exactAbsolute(flags.get("output-dir"), "--output-dir"),
    verifier_release_sha256: digest(
      flags.get("verifier-release-sha256"),
      "--verifier-release-sha256",
    ),
    apply_release_sha256: digest(
      flags.get("apply-release-sha256"),
      "--apply-release-sha256",
    ),
    approved_by: text(flags.get("approved-by"), "--approved-by", 256),
  };
}

async function exactPrivateDirectory(root: string): Promise<string> {
  const exact = exactAbsolute(root, "--custody-root");
  if (isWithin(exact, REPOSITORY_ROOT)) {
    fail("custody root must remain outside the repository");
  }
  const info = await lstat(exact).catch(() => fail("custody root is missing"));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (info.mode & 0o500) !== 0o500 || await realpath(exact) !== exact) {
    fail("custody root must be a private real 0700 directory");
  }
  return exact;
}

function artifactMap(input: {
  compilationRequestBytes: Uint8Array;
  reviewedTruth: ReviewedWalmartListingRepairProductTruthArtifact;
  capture: WalmartListingRepairMaterialCaptureResult;
  sequence: unknown;
  draft: ReturnType<typeof compileWalmartListingRepairOwnerDraft>;
  permit: unknown;
  result: ReturnType<typeof finalizeWalmartListingRepairExecutionPackage>;
}): Record<string, Uint8Array> {
  const certificateName =
    input.draft.target_image_certificate_kind === "REVIEWED_CHANGED_MAIN"
      ? "reviewed-main-certificate.json"
      : input.draft.target_image_certificate_kind === "REVIEWED_CHANGED_IMAGE_SET"
        ? "reviewed-image-set-certificate.json"
        : "unchanged-image-certificate.json";
  return {
    "compilation-request.json": input.compilationRequestBytes,
    "reviewed-one-sku-product-truth.json": renderJson(input.reviewedTruth),
    "product-truth-binding.json": renderJson(input.reviewedTruth.binding),
    "sequence-authorization.json": renderJson(input.sequence),
    "repair-plan.json": renderJson(input.draft.plan),
    [certificateName]: input.draft.target_image_certificate_bytes,
    "surgical-schema-contract.json": renderJson(input.draft.schema_contract),
    "surgical-get-spec-receipt.json":
      renderJson(input.capture.materials.get_spec_receipt),
    "surgical-live-item-receipt.json":
      renderJson(input.capture.materials.live_item_receipt),
    "surgical-get-spec-request.bin":
      input.capture.materials.get_spec_request_bytes,
    "surgical-get-spec-response.bin":
      input.capture.materials.get_spec_response_bytes,
    "surgical-live-item-response.bin":
      input.capture.materials.live_item_response_bytes,
    ...(input.capture.materials.variant_group_all_items_receipt
      && input.capture.materials.variant_group_all_items_response_bytes ? {
        "variant-group-all-items-receipt.json":
          renderJson(input.capture.materials.variant_group_all_items_receipt),
        "variant-group-all-items-response.bin":
          input.capture.materials.variant_group_all_items_response_bytes,
      } : {}),
    "surgical-request-manifest.json":
      input.draft.built_request.request_manifest_bytes,
    "surgical-request-payload.json": input.draft.built_request.payload_bytes,
    "one-sku-owner-permit.json": renderJson(input.permit),
    "execution-package.json": input.result.execution_package_bytes,
  };
}

export async function executeWalmartListingRepairOwnerPackage(
  args: WalmartListingRepairOwnerPackageArgs,
  injected: {
    now?: () => Date;
    fetch_impl?: typeof fetch;
    random_uuid?: () => string;
  } = {},
): Promise<JsonRecord> {
  if (args.command === "doctor") {
    const trust = inspectWalmartListingRepairOwnerTrustRoot("PRODUCTION");
    return {
      schema_version: "walmart-listing-repair-owner-package-doctor/v1",
      status: trust.ready ? "READY" : "BLOCKED",
      production_owner_trust_root: trust,
      package_effects: {
        walmart_content_writes: 0,
        database_writes: 0,
        model_calls: 0,
      },
      package_network_contract: {
        oauth_token_calls: 1,
        exact_item_get_calls: 1,
        get_spec_post_calls: 1,
        retries: 0,
        redirects: 0,
      },
    };
  }

  const requestPath = exactAbsolute(
    args.compilation_request,
    "--compilation-request",
  );
  const [requestBytes, ownerKey, custodyRoot] = await Promise.all([
    readStable(requestPath, "compilation request"),
    ownerPrivateKey(exactAbsolute(args.private_key, "--private-key")),
    exactPrivateDirectory(exactAbsolute(args.custody_root, "--custody-root")),
  ]);
  const requestValue = parseJson(requestBytes, "compilation request");
  const request = verifyWalmartListingRepairCompilationRequest(requestValue);
  if (args.owner_confirmation !== request.owner_gate.exact_confirmation) {
    fail("owner confirmation differs from the exact frozen review");
  }
  const reviewedMainEvidence = await loadReviewedMainEvidence(request);
  const reviewedImageSetEvidence = await loadReviewedImageSetEvidence(request);
  const requestFileSha = sha256(requestBytes);
  const initialNow = (injected.now ?? (() => new Date()))();
  if (!Number.isFinite(initialNow.getTime())) fail("current time is invalid");
  const reviewedTruth =
    buildReviewedWalmartListingRepairProductTruthArtifact({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      owner_confirmation: text(
        args.owner_confirmation,
        "--owner-confirmation",
      ),
      approved_by: text(args.approved_by, "--approved-by", 256),
      created_at: initialNow.toISOString(),
    });
  const truth = reviewedTruth.binding;
  const runTag = `${new Date().toISOString().replace(/[-:.]/gu, "")}-`
    + requestFileSha.slice(0, 16);
  const ledgerRoot = path.join(custodyRoot, `ledger-${runTag}`);
  const artifactRoot = path.join(custodyRoot, `artifacts-${runTag}`);
  const ledger = await bootstrapWalmartListingRepairConsumptionLedger({
    state_directory: ledgerRoot,
  });

  const capture = await captureWalmartListingRepairOwnerMaterials({
    store_index: request.listing.store_index,
    sku: request.listing.sku,
    credentials: credentials(request.listing.store_index),
    capture_authority_public_key_spki_sha256:
      ownerKey.public_fingerprint_sha256,
    consumption_ledger: ledger.binding,
    ledger_state_directory: ledgerRoot,
    artifact_custody_root: artifactRoot,
    fetch_impl: injected.fetch_impl,
    now: injected.now,
    random_uuid: injected.random_uuid,
    // The frozen compilation request does not carry the two immutable ITEM
    // report inputs required to build variant-group evidence.  Capturing an
    // extra All Items response here would therefore be unused and would also
    // violate the package's declared two-read network contract.
    capture_variant_group: false,
  });

  const now = (injected.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) fail("current time is invalid");
  const capturedAt = new Date(request.listing.captured_at);
  if (capturedAt.getTime() > now.getTime()) {
    fail("reviewed buyer capture is from the future");
  }
  const planCreated = new Date(Math.max(
    now.getTime() - 50_000,
    capturedAt.getTime(),
  ));
  const certificateCreated = new Date(Math.max(
    now.getTime() - 40_000,
    planCreated.getTime(),
  ));
  const ids = {
    sequence_id: `sequence-${requestFileSha.slice(0, 24)}`,
    sequence_epoch: `epoch-${runTag}`,
    plan_id: `plan-${requestFileSha.slice(0, 24)}`,
    contract_id: `contract-${requestFileSha.slice(0, 24)}`,
    permit_id: `permit-${runTag}`,
    request_correlation_id: `request-${runTag}`,
    approved_by: text(args.approved_by, "--approved-by", 256),
    decision_ref: `owner-review:${request.body_sha256}`,
  };
  const timing = {
    sequence_issued_at: addMilliseconds(now, -60_000),
    sequence_expires_at: addMilliseconds(now, 60 * 60_000),
    plan_created_at: planCreated.toISOString(),
    plan_expires_at: addMilliseconds(now, 30 * 60_000),
    certificate_created_at: certificateCreated.toISOString(),
    certificate_expires_at: addMilliseconds(now, 25 * 60_000),
    request_prepared_at: now.toISOString(),
    permit_issued_at: now.toISOString(),
    permit_expires_at: addMilliseconds(now, 15 * 60_000),
    package_created_at: now.toISOString(),
  };
  const sequenceBody =
    buildWalmartListingRepairSequenceBodyFromCompilationRequest({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      environment: "PRODUCTION",
      sequence_id: ids.sequence_id,
      sequence_epoch: ids.sequence_epoch,
      issued_at: timing.sequence_issued_at,
      expires_at: timing.sequence_expires_at,
      approved_by: ids.approved_by,
      decision_ref: ids.decision_ref,
      seller_account_fingerprint_sha256:
        capture.materials.seller_account_fingerprint_sha256,
      verifier_engine_release_sha256:
        digest(args.verifier_release_sha256, "--verifier-release-sha256"),
      capture_authority_public_key_spki_sha256:
        capture.materials.capture_authority_public_key_spki_sha256,
    });
  const sequenceRaw = signEnvelope(
    walmartListingRepairSequenceSigningEnvelope({
      key_id: ownerKey.key_id,
      owner_public_key_spki_sha256:
        ownerKey.public_fingerprint_sha256,
      signed_body: sequenceBody,
    }),
    ownerKey.key,
  );
  const sequence = verifyWalmartListingRepairSequenceAuthorization(
    sequenceRaw,
    now,
  );
  let reviewedMainCertificateBytes: Uint8Array | undefined;
  let reviewedImageSetCertificateBytes: Uint8Array | undefined;
  if (request.repair.changed_fields.includes("gallery")) {
    if (!reviewedImageSetEvidence || !request.product_truth_candidate.expected) {
      fail("reviewed image-set repair lacks exact evidence or Product Truth expected facts");
    }
    const prebuiltPlan = buildWalmartListingRepairPlanFromCompilationRequest({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      owner_confirmation: text(
        args.owner_confirmation,
        "--owner-confirmation",
      ),
      sequence_authorization: sequence,
      product_truth_binding: truth,
      plan_id: ids.plan_id,
      created_at: timing.plan_created_at,
      expires_at: timing.plan_expires_at,
      verifier_engine_release_sha256:
        digest(args.verifier_release_sha256, "--verifier-release-sha256"),
      apply_engine_release_sha256:
        digest(args.apply_release_sha256, "--apply-release-sha256"),
      expected_environment: "PRODUCTION",
    });
    const certificate = await certifyWalmartListingRepairReviewedImageSet({
      now: timing.certificate_created_at,
      expires_at: timing.certificate_expires_at,
      plan: prebuiltPlan,
      expected: request.product_truth_candidate.expected,
      compilation_request_file_sha256: requestFileSha,
      compilation_request_body_sha256: request.body_sha256,
      owner_confirmation: text(
        args.owner_confirmation,
        "--owner-confirmation",
      ),
      evidence: reviewedImageSetEvidence,
    });
    reviewedImageSetCertificateBytes = Buffer.from(
      canonicalWalmartListingSurgicalJson(certificate),
      "utf8",
    );
  } else if (request.repair.changed_fields.includes("main")) {
    if (!reviewedMainEvidence || !request.product_truth_candidate.expected) {
      fail("reviewed MAIN repair lacks exact evidence or Product Truth expected facts");
    }
    const prebuiltPlan = buildWalmartListingRepairPlanFromCompilationRequest({
      compilation_request: request,
      compilation_request_file_sha256: requestFileSha,
      owner_confirmation: text(
        args.owner_confirmation,
        "--owner-confirmation",
      ),
      sequence_authorization: sequence,
      product_truth_binding: truth,
      plan_id: ids.plan_id,
      created_at: timing.plan_created_at,
      expires_at: timing.plan_expires_at,
      verifier_engine_release_sha256:
        digest(args.verifier_release_sha256, "--verifier-release-sha256"),
      apply_engine_release_sha256:
        digest(args.apply_release_sha256, "--apply-release-sha256"),
      expected_environment: "PRODUCTION",
    });
    const reviewedMainCertificate =
      await certifyWalmartListingRepairReviewedMain({
        now: timing.certificate_created_at,
        expires_at: timing.certificate_expires_at,
        plan: prebuiltPlan,
        expected: request.product_truth_candidate.expected,
        baseline_images: request.repair.baseline_images,
        compilation_request_file_sha256: requestFileSha,
        compilation_request_body_sha256: request.body_sha256,
        owner_confirmation: text(
          args.owner_confirmation,
          "--owner-confirmation",
        ),
        evidence: reviewedMainEvidence,
      });
    reviewedMainCertificateBytes = Buffer.from(
      canonicalWalmartListingSurgicalJson(reviewedMainCertificate),
      "utf8",
    );
  } else if (reviewedMainEvidence || reviewedImageSetEvidence) {
    fail("unchanged-image repair unexpectedly carries changed image evidence");
  }
  const draft = compileWalmartListingRepairOwnerDraft({
    environment: "PRODUCTION",
    compilation_request: request,
    compilation_request_file_sha256: requestFileSha,
    owner_confirmation: text(
      args.owner_confirmation,
      "--owner-confirmation",
    ),
    sequence_authorization: sequence,
    product_truth_binding: truth,
    verifier_engine_release_sha256:
      digest(args.verifier_release_sha256, "--verifier-release-sha256"),
    apply_engine_release_sha256:
      digest(args.apply_release_sha256, "--apply-release-sha256"),
    ids,
    timing,
    materials: capture.materials,
    reviewed_main_certificate_bytes: reviewedMainCertificateBytes,
    reviewed_image_set_certificate_bytes: reviewedImageSetCertificateBytes,
  });
  const permitRaw = signEnvelope(
    walmartListingRepairOneSkuPermitSigningEnvelope({
      key_id: ownerKey.key_id,
      owner_public_key_spki_sha256:
        ownerKey.public_fingerprint_sha256,
      signed_body: draft.permit_signed_body,
    }),
    ownerKey.key,
  );
  const permit = verifyCurrentWalmartListingRepairOneSkuPermit(
    permitRaw,
    now,
  );
  const result = finalizeWalmartListingRepairExecutionPackage({
    draft,
    verified_one_sku_permit: permit,
  });
  const artifacts = artifactMap({
    compilationRequestBytes: requestBytes,
    reviewedTruth,
    capture,
    sequence,
    draft,
    permit,
    result,
  });
  const artifactHashes = Object.fromEntries(
    Object.entries(artifacts).map(([name, bytes]) => [name, sha256(bytes)]),
  );
  const outputDir = exactAbsolute(args.output_dir, "--output-dir");
  const reportBody = {
    schema_version: "walmart-listing-repair-owner-package-report/v1" as const,
    status: "READY_FOR_EXPLICIT_EXECUTE" as const,
    created_at: now.toISOString(),
    listing: {
      channel: "WALMART_US" as const,
      store_index: request.listing.store_index,
      sku: request.listing.sku,
      listing_key: request.listing.listing_key,
      item_id: request.listing.item_id,
    },
    changed_fields: request.repair.changed_fields,
    product_type: capture.product_type,
    artifacts: Object.fromEntries(
      Object.keys(artifacts).map((name) => [name, path.join(outputDir, name)]),
    ),
    hashes: artifactHashes,
    execution: {
      oauth_token_calls: 1 as const,
      walmart_read_calls: (
        capture.call_counts.exact_item_get_calls
        + capture.call_counts.variant_group_all_items_get_calls
        + capture.call_counts.get_spec_post_calls
      ) as 2 | 3,
      walmart_content_writes: 0 as const,
      database_reads: 0 as const,
      database_writes: 0 as const,
      model_calls: 0 as const,
      retries: 0 as const,
      redirects: 0 as const,
    },
    safety: {
      exact_listing_count: 1 as const,
      signed_one_sku_permit: true as const,
      package_is_not_executed: true as const,
      title_unchanged: true as const,
      images_unchanged: !request.repair.changed_fields.includes("main")
        && !request.repair.changed_fields.includes("gallery"),
      price_unchanged: true as const,
      inventory_unchanged: true as const,
      listing_status_unchanged: true as const,
      mass_apply_allowed: false as const,
    },
    next_command: `doctor --out ${JSON.stringify(path.join(
      custodyRoot,
      `doctor-${runTag}.json`,
    ))}`,
  };
  const report: WalmartListingRepairOwnerPackageReport = seal(reportBody);
  artifacts["package-report.json"] = renderJson(report);
  await publishArtifacts({ output_dir: outputDir, artifacts });
  return report as unknown as JsonRecord;
}

export async function runWalmartListingRepairOwnerPackage(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  try {
    const result = await executeWalmartListingRepairOwnerPackage(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  void runWalmartListingRepairOwnerPackage();
}
