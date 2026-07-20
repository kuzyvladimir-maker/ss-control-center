#!/usr/bin/env node

/**
 * Walmart new-SKU operator engine.
 *
 * Read-only commands implemented here deliberately precede every state-changing
 * command. `plan` cannot reserve a UPC, write the application database, call a
 * metered provider, or mutate Walmart.
 *
 * Usage:
 *   npm run walmart:new-sku -- doctor --expected-engine-release-sha <sha256> \
 *     --release-manifest /abs/release-manifest.json \
 *     --release-manifest-sha /abs/release-manifest.sha256 \
 *     --item-report-catalog-source /abs/item-report-catalog-source.json \
 *     --expected-item-report-catalog-source-sha256 <sha256> --out <doctor.json>
 *   npm run walmart:new-sku -- plan --doctor-receipt <doctor.json>
 */

import { createClient, type Client } from "@libsql/client";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  inspectWalmartNewSkuSourceRelease,
  verifyWalmartNewSkuFrozenRelease,
} from "../src/lib/bundle-factory/walmart-new-sku-source-release";
import type { SealedWalmartSellerCatalogAuthorityBinding } from
  "../src/lib/bundle-factory/walmart-new-sku-catalog-authority";
import type { WalmartNewSkuCertificationArtifact } from
  "../src/lib/bundle-factory/walmart-new-sku-engine";

let liveApplyAttempted = false;

type Command =
  | "doctor"
  | "plan"
  | "stage"
  | "rotate-upc"
  | "certify"
  | "dry-run"
  | "approve"
  | "apply"
  | "owner-permit-request"
  | "owner-permit-assemble"
  | "verify"
  | "help";

export type WalmartNewSkuCliSurface = "operator" | "owner";

type CommandMode =
  | "preview"
  | "template"
  | "seal-evidence"
  | "apply-internal"
  | "live"
  | "status";

interface ParsedArgs {
  command: Command;
  storeIndex: number;
  limit: number;
  packCount: number;
  zip: string;
  asOf: Date;
  maxPriceAgeMs: number;
  out: string | null;
  planPath: string | null;
  candidateKey: string | null;
  actor: string | null;
  mode: CommandMode;
  confirm: string | null;
  stagePath: string | null;
  evidencePath: string | null;
  certificationPath: string | null;
  certificationReceiptPath: string | null;
  dryRunReceiptPath: string | null;
  approvalPath: string | null;
  doctorReceiptPath: string | null;
  applyPreviewReceiptPath: string | null;
  ownerPermitPath: string | null;
  ownerPermitRequestPath: string | null;
  detachedSignaturePath: string | null;
  permitId: string | null;
  pilotSlot: 1 | 2 | null;
  decisionRef: string | null;
  buyerEvidencePath: string | null;
  verifyReceiptPath: string | null;
  note: string | null;
  expectedEngineReleaseSha256: string | null;
  releaseManifestPath: string | null;
  releaseManifestShaPath: string | null;
  itemReportCatalogSourcePath: string | null;
  expectedItemReportCatalogSourceSha256: string | null;
}

const PILOT_STORE_INDEX = 1;
const PILOT_ZIP = "33765";
const PILOT_MAX_PRICE_AGE_HOURS = 24;
const PILOT_MAX_CANDIDATES_PER_PLAN = 1;
const PILOT_DOCTOR_AS_OF_MAX_AGE_MS = 15 * 60_000;
const PILOT_PACK_COUNTS = new Set([2, 3]);

const OPERATOR_COMMANDS = new Set<Command>([
  "doctor",
  "plan",
  "stage",
  "rotate-upc",
  "certify",
  "dry-run",
  "approve",
  "apply",
  "verify",
  "help",
]);

const OWNER_COMMANDS = new Set<Command>([
  "owner-permit-request",
  "owner-permit-assemble",
  "help",
]);

const COMMAND_MODE_FLAG_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  "doctor:preview": new Set([
    "store-index", "limit", "pack-count", "zip", "as-of",
    "max-price-age-hours", "out", "expected-engine-release-sha",
    "release-manifest", "release-manifest-sha", "item-report-catalog-source",
    "expected-item-report-catalog-source-sha256",
  ]),
  "plan:preview": new Set([
    "store-index", "limit", "pack-count", "zip", "as-of",
    "max-price-age-hours", "out", "doctor-receipt",
  ]),
  "stage:preview": new Set([
    "plan", "candidate", "mode", "doctor-receipt",
  ]),
  "stage:apply-internal": new Set([
    "plan", "candidate", "mode", "actor", "confirm", "out", "doctor-receipt",
  ]),
  "rotate-upc:preview": new Set(["plan", "stage", "mode"]),
  "rotate-upc:apply-internal": new Set([
    "plan", "stage", "mode", "actor", "confirm", "out",
  ]),
  "certify:template": new Set(["plan", "stage", "mode", "out"]),
  "certify:seal-evidence": new Set([
    "plan", "stage", "mode", "evidence", "out",
  ]),
  "certify:preview": new Set(["plan", "stage", "mode", "evidence"]),
  "certify:apply-internal": new Set([
    "plan", "stage", "mode", "evidence", "actor", "confirm", "out",
  ]),
  "dry-run:preview": new Set(["certification", "certification-receipt", "out"]),
  "approve:preview": new Set([
    "certification", "certification-receipt", "dry-run-receipt", "mode",
  ]),
  "approve:apply-internal": new Set([
    "certification", "certification-receipt", "dry-run-receipt", "mode",
    "actor", "confirm", "note", "out",
  ]),
  "apply:preview": new Set([
    "certification", "certification-receipt", "dry-run-receipt", "approval",
    "mode", "out",
  ]),
  "apply:live": new Set([
    "certification", "certification-receipt", "dry-run-receipt", "approval",
    "mode", "actor", "confirm", "doctor-receipt", "apply-preview-receipt",
    "owner-permit", "out",
  ]),
  "owner-permit-request:preview": new Set([
    "certification", "certification-receipt", "dry-run-receipt", "approval",
    "doctor-receipt", "apply-preview-receipt", "permit-id", "pilot-slot",
    "actor", "decision-ref", "out",
  ]),
  "owner-permit-assemble:preview": new Set([
    "certification", "certification-receipt", "dry-run-receipt", "approval",
    "doctor-receipt", "apply-preview-receipt", "owner-permit-request",
    "detached-signature", "out",
  ]),
  "verify:seal-evidence": new Set([
    "certification", "verify-receipt", "buyer-evidence", "mode", "out",
  ]),
  "verify:status": new Set([
    "certification", "verify-receipt", "buyer-evidence", "mode", "out",
  ]),
  "help:preview": new Set(),
};

function commandAcceptsFlagInAnyMode(command: Command, flag: string): boolean {
  const prefix = `${command}:`;
  return Object.entries(COMMAND_MODE_FLAG_ALLOWLIST).some(
    ([key, flags]) => key.startsWith(prefix) && flags.has(flag),
  );
}

function cleanEnv(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/^['"]|['"]$/g, "");
  return cleaned || undefined;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function finiteNumber(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function parseIso(value: string | undefined, label: string): Date {
  const parsed = value ? new Date(value) : new Date();
  if (
    !Number.isFinite(parsed.getTime()) ||
    (value !== undefined && value !== parsed.toISOString())
  ) {
    throw new Error(`${label} must be an exact canonical ISO UTC timestamp`);
  }
  return parsed;
}

function parseArgs(
  argv: string[],
  surface: WalmartNewSkuCliSurface,
): ParsedArgs {
  const rawCommand = argv[0] ?? "help";
  if (![
    "doctor", "plan", "stage", "rotate-upc", "certify", "dry-run", "approve", "apply",
    "owner-permit-request", "owner-permit-assemble", "verify", "help", "--help", "-h",
  ].includes(rawCommand)) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }
  const command: Command =
    rawCommand === "--help" || rawCommand === "-h"
      ? "help"
      : rawCommand as Command;
  const surfaceCommands = surface === "operator" ? OPERATOR_COMMANDS : OWNER_COMMANDS;
  if (!surfaceCommands.has(command)) {
    throw new Error(`${command} is not available on the ${surface} CLI surface`);
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [inlineKey, inlineValue] = token.split("=", 2);
    const key = inlineKey.slice(2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    if (values.has(key)) throw new Error(`--${key} was supplied more than once`);
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!commandAcceptsFlagInAnyMode(command, key)) {
      throw new Error(`${command} does not accept --${key}`);
    }
  }
  const storeIndex = positiveInteger(values.get("store-index") ?? "1", "--store-index");
  const limit = positiveInteger(values.get("limit") ?? "1", "--limit");
  const packCount = positiveInteger(values.get("pack-count") ?? "2", "--pack-count");
  const maxPriceAgeHours = finiteNumber(
    values.get("max-price-age-hours") ?? "24",
    "--max-price-age-hours",
  );
  const pilotSlotValue = values.get("pilot-slot");
  const pilotSlot = pilotSlotValue === undefined
    ? null
    : positiveInteger(pilotSlotValue, "--pilot-slot");
  if (pilotSlot !== null && pilotSlot !== 1 && pilotSlot !== 2) {
    throw new Error("--pilot-slot must be 1 or 2");
  }
  if ((command === "doctor" || command === "plan") && storeIndex !== PILOT_STORE_INDEX) {
    throw new Error(`--store-index must be exactly ${PILOT_STORE_INDEX} for this pilot`);
  }
  if (
    (command === "doctor" || command === "plan") &&
    limit !== PILOT_MAX_CANDIDATES_PER_PLAN
  ) {
    throw new Error(
      `--limit must be exactly ${PILOT_MAX_CANDIDATES_PER_PLAN} for each pilot plan`,
    );
  }
  if (
    (command === "doctor" || command === "plan") &&
    !PILOT_PACK_COUNTS.has(packCount)
  ) {
    throw new Error("--pack-count must be exactly 2 or 3 for this pilot");
  }
  const zip = values.get("zip")?.trim() || PILOT_ZIP;
  if ((command === "doctor" || command === "plan") && zip !== PILOT_ZIP) {
    throw new Error(`--zip must be exactly ${PILOT_ZIP} for this pilot`);
  }
  if (
    (command === "doctor" || command === "plan") &&
    maxPriceAgeHours !== PILOT_MAX_PRICE_AGE_HOURS
  ) {
    throw new Error(
      `--max-price-age-hours must be exactly ${PILOT_MAX_PRICE_AGE_HOURS} for this pilot`,
    );
  }
  const expectedEngineReleaseSha256 =
    values.get("expected-engine-release-sha")?.trim() || null;
  if (
    command === "doctor" &&
    !/^[a-f0-9]{64}$/.test(expectedEngineReleaseSha256 ?? "")
  ) {
    throw new Error(
      "doctor requires --expected-engine-release-sha as a lowercase SHA-256",
    );
  }
  if (command === "doctor" && !values.has("as-of")) {
    throw new Error("doctor requires --as-of as an exact canonical ISO UTC timestamp");
  }
  const releaseManifestPath = values.get("release-manifest") ?? null;
  const releaseManifestShaPath = values.get("release-manifest-sha") ?? null;
  const itemReportCatalogSourcePath =
    values.get("item-report-catalog-source") ?? null;
  const expectedItemReportCatalogSourceSha256 =
    values.get("expected-item-report-catalog-source-sha256")?.trim() ?? null;
  if (
    command === "doctor" &&
    (!releaseManifestPath || !isAbsolute(releaseManifestPath))
  ) {
    throw new Error("doctor requires absolute --release-manifest <release-manifest.json>");
  }
  if (
    command === "doctor" &&
    (!releaseManifestShaPath || !isAbsolute(releaseManifestShaPath))
  ) {
    throw new Error(
      "doctor requires absolute --release-manifest-sha <release-manifest.sha256>",
    );
  }
  if (
    command === "doctor" &&
    (!itemReportCatalogSourcePath ||
      !isAbsolute(itemReportCatalogSourcePath) ||
      resolve(itemReportCatalogSourcePath) !== itemReportCatalogSourcePath)
  ) {
    throw new Error(
      "doctor requires normalized absolute --item-report-catalog-source <catalog-source.json>",
    );
  }
  if (
    command === "doctor" &&
    !/^[a-f0-9]{64}$/.test(expectedItemReportCatalogSourceSha256 ?? "")
  ) {
    throw new Error(
      "doctor requires --expected-item-report-catalog-source-sha256 as a lowercase SHA-256",
    );
  }
  const defaultMode = command === "verify" ? "status" : "preview";
  const mode = (values.get("mode") ?? defaultMode) as CommandMode;
  const allowedModes: Record<Command, readonly CommandMode[]> = {
    doctor: ["preview"],
    plan: ["preview"],
    stage: ["preview", "apply-internal"],
    "rotate-upc": ["preview", "apply-internal"],
    certify: ["template", "seal-evidence", "preview", "apply-internal"],
    "dry-run": ["preview"],
    approve: ["preview", "apply-internal"],
    apply: ["preview", "live"],
    "owner-permit-request": ["preview"],
    "owner-permit-assemble": ["preview"],
    verify: ["seal-evidence", "status"],
    help: ["preview"],
  };
  if (!allowedModes[command].includes(mode)) {
    throw new Error(
      `${command} --mode must be one of: ${allowedModes[command].join(", ")}`,
    );
  }
  const exactSupported = COMMAND_MODE_FLAG_ALLOWLIST[`${command}:${mode}`];
  for (const key of values.keys()) {
    if (!exactSupported?.has(key)) {
      const modeLabel = values.has("mode") ? ` --mode ${mode}` : "";
      throw new Error(`${command}${modeLabel} does not accept --${key}`);
    }
  }
  return {
    command,
    storeIndex,
    limit,
    packCount,
    zip,
    asOf: parseIso(values.get("as-of"), "--as-of"),
    maxPriceAgeMs: maxPriceAgeHours * 60 * 60 * 1_000,
    out: values.get("out") ?? null,
    planPath: values.get("plan") ?? null,
    candidateKey: values.get("candidate") ?? null,
    actor: values.get("actor")?.trim() || null,
    mode,
    confirm: values.get("confirm")?.trim() || null,
    stagePath: values.get("stage") ?? null,
    evidencePath: values.get("evidence") ?? null,
    certificationPath: values.get("certification") ?? null,
    certificationReceiptPath: values.get("certification-receipt") ?? null,
    dryRunReceiptPath: values.get("dry-run-receipt") ?? null,
    approvalPath: values.get("approval") ?? null,
    doctorReceiptPath: values.get("doctor-receipt") ?? null,
    applyPreviewReceiptPath: values.get("apply-preview-receipt") ?? null,
    ownerPermitPath: values.get("owner-permit") ?? null,
    ownerPermitRequestPath: values.get("owner-permit-request") ?? null,
    detachedSignaturePath: values.get("detached-signature") ?? null,
    permitId: values.get("permit-id")?.trim() || null,
    pilotSlot: pilotSlot as 1 | 2 | null,
    decisionRef: values.get("decision-ref")?.trim() || null,
    buyerEvidencePath: values.get("buyer-evidence") ?? null,
    verifyReceiptPath: values.get("verify-receipt") ?? null,
    note: values.get("note")?.trim() || null,
    expectedEngineReleaseSha256,
    releaseManifestPath,
    releaseManifestShaPath,
    itemReportCatalogSourcePath,
    expectedItemReportCatalogSourceSha256,
  };
}

/** POSIX-shell-safe rendering for the informational command string. */
export function quoteWalmartNewSkuShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function operatorNext(
  commandArgs: readonly string[] | null,
): { next_argv: string[] | null; next_command: string | null } {
  if (commandArgs === null) {
    return { next_argv: null, next_command: null };
  }
  const nextArgv = ["npm", "run", "walmart:new-sku", "--", ...commandArgs];
  return {
    next_argv: nextArgv,
    next_command: nextArgv.map(quoteWalmartNewSkuShellArg).join(" "),
  };
}

async function readCertification(path: string) {
  const { assertWalmartNewSkuCertificationArtifactIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const absolute = resolve(path);
  const bytes = await readCanonicalBuyerEvidenceJsonFile(
    absolute,
    "Certification",
  );
  const parsed = parseCanonicalBuyerEvidenceJson(
    bytes,
    "Certification",
  ) as WalmartNewSkuCertificationArtifact;
  assertWalmartNewSkuCertificationArtifactIntegrity(parsed);
  const {
    assertCurrentWalmartSellerAccountBinding,
    assertCurrentWalmartSellerCatalogAuthorityScope,
  } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  assertCurrentWalmartSellerAccountBinding(parsed);
  assertCurrentWalmartSellerCatalogAuthorityScope(
    parsed.seller_catalog_authority,
  );
  return parsed;
}

async function readCertificationReceipt(
  path: string,
  certification: Awaited<ReturnType<typeof readCertification>>,
) {
  const { assertWalmartNewSkuCertificationReceiptIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuCertificationReceiptIntegrity(parsed, certification);
  return parsed;
}

async function readDryRunReceipt(
  path: string,
  certification: Awaited<ReturnType<typeof readCertification>>,
  now = new Date(),
) {
  const { assertWalmartNewSkuDryRunReceiptIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuDryRunReceiptIntegrity(parsed, certification, now);
  return parsed;
}

async function readApproval(
  path: string,
  certification: Awaited<ReturnType<typeof readCertification>>,
  certificationReceipt: Awaited<ReturnType<typeof readCertificationReceipt>>,
  dryRunReceipt: Awaited<ReturnType<typeof readDryRunReceipt>>,
  now = new Date(),
) {
  const { assertWalmartNewSkuApprovalArtifactIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuApprovalArtifactIntegrity(
    parsed,
    certification,
    certificationReceipt,
    dryRunReceipt,
    now,
  );
  return parsed;
}

async function readDoctorReceiptArtifact(
  path: string,
  now = new Date(),
) {
  const { assertWalmartNewSkuDoctorReceiptIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuDoctorReceiptIntegrity(parsed, now);
  return parsed;
}

async function readDoctorReceipt(
  path: string,
  certification: Awaited<ReturnType<typeof readCertification>>,
  now = new Date(),
) {
  const parsed = await readDoctorReceiptArtifact(path, now);
  if (
    parsed.store_index !== certification.store_index ||
    parsed.seller_account_fingerprint_sha256 !==
      certification.seller_account_fingerprint_sha256
  ) {
    throw new Error("Doctor receipt belongs to another Walmart seller account");
  }
  return parsed;
}

async function readApplyPreviewReceipt(
  path: string,
  approval: Awaited<ReturnType<typeof readApproval>>,
) {
  const { assertWalmartNewSkuApplyReceiptIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuApplyReceiptIntegrity(parsed, approval);
  if (parsed.mode !== "PREVIEW" || parsed.marketplace_mutation_requested !== false) {
    throw new Error("Owner permit requires an exact non-mutating apply preview receipt");
  }
  return parsed;
}

async function readOwnerPermit(
  path: string,
  certification: Awaited<ReturnType<typeof readCertification>>,
  approval: Awaited<ReturnType<typeof readApproval>>,
  doctor: Awaited<ReturnType<typeof readDoctorReceipt>>,
  applyPreview: Awaited<ReturnType<typeof readApplyPreviewReceipt>>,
  engineReleaseSha256: string,
  now = new Date(),
) {
  const { assertWalmartNewSkuOwnerPermitIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuOwnerPermitIntegrity(
    parsed,
    certification,
    approval,
    doctor,
    applyPreview,
    engineReleaseSha256,
    now,
  );
  return parsed;
}

const OWNER_PERMIT_REQUEST_MAX_BYTES = 1024 * 1024;
const ED25519_SIGNATURE_BYTES = 64;

interface OwnerPermitSigningRequestJson extends Record<string, unknown> {
  signed_body?: {
    permit_id?: unknown;
    pilot_slot?: unknown;
    approved_by?: unknown;
    decision_ref?: unknown;
    issued_at?: unknown;
    [key: string]: unknown;
  };
}

async function readRegularFileNoFollow(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const absolute = resolve(path);
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(`${label} must be an existing non-symlink regular file`);
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > maximumBytes
    ) {
      throw new Error(`${label} has an invalid file type or byte size`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1
    ) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readOwnerPermitSigningRequest(
  path: string,
): Promise<OwnerPermitSigningRequestJson> {
  const bytes = await readRegularFileNoFollow(
    path,
    OWNER_PERMIT_REQUEST_MAX_BYTES,
    "Owner permit signing request",
  );
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as OwnerPermitSigningRequestJson;
  } catch {
    throw new Error("Owner permit signing request must be valid JSON object bytes");
  }
}

async function readDetachedEd25519Signature(path: string): Promise<Buffer> {
  const bytes = await readRegularFileNoFollow(
    path,
    ED25519_SIGNATURE_BYTES,
    "Detached Ed25519 signature",
  );
  if (bytes.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error("Detached Ed25519 signature must contain exactly 64 raw bytes");
  }
  return bytes;
}

async function assertCurrentOwnerPermitDoctorContext(
  doctor: Awaited<ReturnType<typeof readDoctorReceipt>>,
  engineReleaseSha256: string,
): Promise<void> {
  const resolved = databaseConfig();
  const { resolveDatabaseTarget } = await import(
    "./product-truth-migration-plan"
  );
  const target = resolveDatabaseTarget(resolved.url);
  const db = createClient(resolved);
  let schemaSha256: string;
  try {
    schemaSha256 = await databaseSchemaSha256(db);
  } finally {
    await db.close();
  }
  const { getConfiguredWalmartSpecVersion } = await import(
    "../src/lib/bundle-factory/distribution/walmart-item-contract"
  );
  const drift: string[] = [];
  if (doctor.engine_release_sha256 !== engineReleaseSha256) {
    drift.push("engine_release_sha256");
  }
  if (doctor.database_target_fingerprint_sha256 !== target.fingerprint) {
    drift.push("database_target_fingerprint_sha256");
  }
  if (doctor.database_schema_sha256 !== schemaSha256) {
    drift.push("database_schema_sha256");
  }
  if (doctor.item_spec_version !== getConfiguredWalmartSpecVersion()) {
    drift.push("item_spec_version");
  }
  if (drift.length) {
    throw new Error(
      `Owner permit request differs from the current release/database/schema/spec: ${drift.join(",")}`,
    );
  }
  const authorityDb = createClient(resolved);
  try {
    const { assertCurrentWalmartSellerCatalogAuthority } = await import(
      "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
    );
    await assertCurrentWalmartSellerCatalogAuthority({
      db: authorityDb,
      authority: doctor.seller_catalog_authority,
      now: new Date(),
    });
  } finally {
    await authorityDb.close();
  }
}

async function requireOwnerPermitArtifacts(args: ParsedArgs) {
  const inputs = await requireApprovalInputs(args);
  if (!args.approvalPath) {
    throw new Error("owner permit command requires --approval <approval.json>");
  }
  if (!args.doctorReceiptPath) {
    throw new Error(
      "owner permit command requires --doctor-receipt <fresh-doctor.json>",
    );
  }
  if (!args.applyPreviewReceiptPath) {
    throw new Error(
      "owner permit command requires --apply-preview-receipt <preview.json>",
    );
  }
  const approval = await readApproval(
    args.approvalPath,
    inputs.certification,
    inputs.certificationReceipt,
    inputs.dryRunReceipt,
    inputs.now,
  );
  const doctor = await readDoctorReceipt(
    args.doctorReceiptPath,
    inputs.certification,
    inputs.now,
  );
  const applyPreview = await readApplyPreviewReceipt(
    args.applyPreviewReceiptPath,
    approval,
  );
  const { stableWalmartJson } = await import(
    "../src/lib/bundle-factory/walmart-listing-contract"
  );
  if (
    stableWalmartJson(doctor.seller_catalog_authority) !==
      stableWalmartJson(inputs.certification.seller_catalog_authority)
  ) {
    throw new Error(
      "Owner permit doctor catalog authority differs from certification",
    );
  }
  const engineReleaseSha256 = await walmartNewSkuEngineReleaseSha256();
  await assertCurrentOwnerPermitDoctorContext(doctor, engineReleaseSha256);
  return {
    ...inputs,
    approval,
    doctor,
    applyPreview,
    engineReleaseSha256,
  };
}

async function runOwnerPermitRequest(args: ParsedArgs): Promise<void> {
  if (!args.out) {
    throw new Error("owner-permit-request requires --out <new-request.json>");
  }
  if (!args.permitId) {
    throw new Error("owner-permit-request requires --permit-id");
  }
  if (!args.pilotSlot) {
    throw new Error("owner-permit-request requires --pilot-slot 1|2");
  }
  if (!args.actor) {
    throw new Error("owner-permit-request requires --actor <owner-identity>");
  }
  if (!args.decisionRef) {
    throw new Error("owner-permit-request requires --decision-ref <owner-decision-uri>");
  }
  const context = await requireOwnerPermitArtifacts(args);
  const { buildWalmartNewSkuOwnerPermitSigningRequest } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const request = buildWalmartNewSkuOwnerPermitSigningRequest({
    certification: context.certification,
    approval: context.approval,
    doctor: context.doctor,
    applyPreview: context.applyPreview,
    engineReleaseSha256: context.engineReleaseSha256,
    permitId: args.permitId,
    pilotSlot: args.pilotSlot,
    approvedBy: args.actor,
    decisionRef: args.decisionRef,
    now: context.now,
  });
  const content = `${JSON.stringify(request, null, 2)}\n`;
  const outputPath = resolve(args.out);
  const disposition = await writeOnce(outputPath, content);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "owner-permit-request",
    owner_codex_only: true,
    private_key_accessed: false,
    database_mutated: false,
    marketplace_mutated: false,
    engine_release_sha256: context.engineReleaseSha256,
    payload_sha256: context.certification.payload_sha256,
    signing_message_sha256: createHash("sha256")
      .update(Buffer.from(request.signing_message_base64, "base64"))
      .digest("hex"),
    request_artifact_sha256: createHash("sha256").update(content).digest("hex"),
    output: outputPath,
    disposition,
    ...operatorNext(null),
  }, null, 2)}\n`);
}

async function runOwnerPermitAssemble(args: ParsedArgs): Promise<void> {
  if (!args.ownerPermitRequestPath) {
    throw new Error(
      "owner-permit-assemble requires --owner-permit-request <request.json>",
    );
  }
  if (!args.detachedSignaturePath) {
    throw new Error(
      "owner-permit-assemble requires --detached-signature <raw-64-byte-signature>",
    );
  }
  if (!args.out) {
    throw new Error("owner-permit-assemble requires --out <new-owner-permit.json>");
  }
  const context = await requireOwnerPermitArtifacts(args);
  const request = await readOwnerPermitSigningRequest(args.ownerPermitRequestPath);
  const body = request.signed_body;
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    typeof body.permit_id !== "string" ||
    (body.pilot_slot !== 1 && body.pilot_slot !== 2) ||
    typeof body.approved_by !== "string" ||
    typeof body.decision_ref !== "string" ||
    typeof body.issued_at !== "string"
  ) {
    throw new Error("OWNER_PERMIT_SIGNING_REQUEST_BINDING_MISMATCH");
  }
  const issuedAt = new Date(body.issued_at);
  if (!Number.isFinite(issuedAt.getTime())) {
    throw new Error("OWNER_PERMIT_SIGNING_REQUEST_BINDING_MISMATCH");
  }
  const { buildWalmartNewSkuOwnerPermitSigningRequest } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const expectedRequest = buildWalmartNewSkuOwnerPermitSigningRequest({
    certification: context.certification,
    approval: context.approval,
    doctor: context.doctor,
    applyPreview: context.applyPreview,
    engineReleaseSha256: context.engineReleaseSha256,
    permitId: body.permit_id,
    pilotSlot: body.pilot_slot,
    approvedBy: body.approved_by,
    decisionRef: body.decision_ref,
    now: issuedAt,
  });
  const { stableWalmartJson } = await import(
    "../src/lib/bundle-factory/walmart-listing-contract"
  );
  if (stableWalmartJson(request) !== stableWalmartJson(expectedRequest)) {
    throw new Error("OWNER_PERMIT_SIGNING_REQUEST_BINDING_MISMATCH");
  }
  const signature = await readDetachedEd25519Signature(
    args.detachedSignaturePath,
  );
  const { assembleWalmartOwnerPermit } = await import(
    "../src/lib/bundle-factory/walmart-owner-permit"
  );
  const permit = assembleWalmartOwnerPermit({
    request: expectedRequest,
    signature_base64: signature.toString("base64"),
    now: context.now,
  });
  const content = `${JSON.stringify(permit, null, 2)}\n`;
  const outputPath = resolve(args.out);
  const disposition = await writeOnce(outputPath, content);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "owner-permit-assemble",
    owner_codex_only: true,
    private_key_accessed: false,
    signature_verified: true,
    database_mutated: false,
    marketplace_mutated: false,
    engine_release_sha256: context.engineReleaseSha256,
    payload_sha256: context.certification.payload_sha256,
    permit_sha256: permit.permit_sha256,
    output: outputPath,
    disposition,
    ...operatorNext(null),
  }, null, 2)}\n`);
}

async function runDryRun(args: ParsedArgs): Promise<void> {
  if (!args.certificationPath) {
    throw new Error("dry-run requires --certification <certification.json>");
  }
  if (!args.certificationReceiptPath) {
    throw new Error(
      "dry-run requires --certification-receipt <certification-receipt.json>",
    );
  }
  const certification = await readCertification(args.certificationPath);
  await readCertificationReceipt(args.certificationReceiptPath, certification);
  const { dryRunCertifiedWalmartNewSku } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const { sealWalmartNewSkuDryRunReceipt } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const replayedAt = new Date();
  const db = createClient(databaseConfig());
  let result: Awaited<ReturnType<typeof dryRunCertifiedWalmartNewSku>>;
  try {
    result = await dryRunCertifiedWalmartNewSku({
      productTruthDb: db,
      certification,
    });
  } finally {
    await db.close();
  }
  if (
    result.validation.status !== "PASSED" ||
    result.schema_validation.valid !== true ||
    !result.schema_validation.schema_sha256
  ) {
    throw new Error("Dry-run result is not a clean PASSED/live-spec result");
  }
  const passedLiveSpec = {
    ...result.schema_validation,
    valid: true as const,
    schema_sha256: result.schema_validation.schema_sha256,
  };
  const receipt = sealWalmartNewSkuDryRunReceipt({
    schema_version: "walmart-new-sku-dry-run-receipt/1.0.0",
    certification_sha256: certification.certification_sha256,
    channel_sku_id: result.channel_sku_id,
    sku: result.sku,
    replayed_at: replayedAt.toISOString(),
    validation_status: result.validation.status,
    validation_results: result.validation.results,
    payload_sha256: result.payload_sha256,
    payload: result.payload,
    live_spec_validation: passedLiveSpec,
    offer_handoff: result.offer_handoff,
    marketplace_mutated: false,
  }, certification, replayedAt);
  const outputPath = args.out
    ? resolve(args.out)
    : resolve(
        dirname(resolve(args.certificationPath)),
        `dry-run-${certification.candidate_key}-${receipt.receipt_sha256.slice(0, 12)}.json`,
      );
  const disposition = await writeOnce(
    outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "dry-run",
    database_mutated: false,
    marketplace_mutated: false,
    read_only_validation_replayed: true,
    live_get_spec_valid: result.schema_validation.valid,
    payload_sha256: result.payload_sha256,
    dry_run_receipt_sha256: receipt.receipt_sha256,
    output: outputPath,
    disposition,
    ...operatorNext([
      "approve",
      "--certification", resolve(args.certificationPath),
      "--certification-receipt", resolve(args.certificationReceiptPath),
      "--dry-run-receipt", outputPath,
      "--mode", "preview",
    ]),
  }, null, 2)}\n`);
}

function databaseConfig(): { url: string; authToken?: string } {
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const authToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  if (tursoUrl) {
    if (authToken) return { url: tursoUrl, authToken };
    if (!tursoUrl.startsWith("file:")) {
      throw new Error(
        "TURSO_AUTH_TOKEN is required when remote TURSO_DATABASE_URL is selected",
      );
    }
    if (
      !databaseUrl?.startsWith("file:") ||
      resolve(databaseUrl.slice("file:".length)) !==
        resolve(tursoUrl.slice("file:".length))
    ) {
      throw new Error(
        "Local TURSO_DATABASE_URL without auth is allowed only when DATABASE_URL resolves to the same file target",
      );
    }
    // Mirror src/lib/prisma.ts exactly: without a Turso token Prisma selects
    // DATABASE_URL. The equality fence above prevents read/write split-brain.
    return { url: databaseUrl };
  }
  if (!databaseUrl) {
    throw new Error("TURSO_DATABASE_URL or DATABASE_URL is required");
  }
  return { url: databaseUrl };
}

function databaseLabel(url: string): string {
  if (url.startsWith("file:")) return "local-file";
  try {
    return new URL(url.replace(/^libsql:/, "https:")).hostname || "remote-libsql";
  } catch {
    return "remote-libsql";
  }
}

async function tableExists(db: Client, table: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    args: [table],
  });
  return result.rows.length === 1;
}

async function scalar(db: Client, sql: string): Promise<number> {
  const result = await db.execute(sql);
  return Number(result.rows[0]?.value ?? 0);
}

async function databaseSchemaSha256(db: Client): Promise<string> {
  const result = await db.execute(
    `SELECT type,name,tbl_name,COALESCE(sql,'') AS sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type,name,tbl_name`,
  );
  const { sha256WalmartJson } = await import(
    "../src/lib/bundle-factory/walmart-listing-contract"
  );
  return sha256WalmartJson(result.rows.map((row) => ({
    type: String(row.type ?? ""),
    name: String(row.name ?? ""),
    table: String(row.tbl_name ?? ""),
    sql: String(row.sql ?? ""),
  })));
}

async function walmartNewSkuEngineReleaseSha256(): Promise<string> {
  return (await inspectWalmartNewSkuSourceRelease(resolve(".")))
    .engine_release_sha256;
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  const frozenRelease = await verifyWalmartNewSkuFrozenRelease({
    releaseRoot: resolve("."),
    manifestPath: args.releaseManifestPath!,
    manifestSha256Path: args.releaseManifestShaPath!,
    expectedEngineReleaseSha256: args.expectedEngineReleaseSha256!,
  });
  const engineReleaseSha256 = frozenRelease.engine_release_sha256;
  const checkedAt = new Date();
  const asOfAgeMs = checkedAt.getTime() - args.asOf.getTime();
  if (asOfAgeMs < 0 || asOfAgeMs > PILOT_DOCTOR_AS_OF_MAX_AGE_MS) {
    throw new Error(
      "DOCTOR_AS_OF_NOT_FRESH: --as-of must be no later than checked_at and " +
      "no more than 15 minutes old",
    );
  }
  const { assertProductTruthEvidenceSchema } = await import(
    "../src/lib/sourcing/product-truth-schema-gate"
  );
  const {
    listProductTruthWalmartPilotCandidates,
    readProductTruthNewSkuView,
  } = await import(
    "../src/lib/sourcing/product-truth-read-contract"
  );
  const {
    inspectWalmartSellerCatalogRecipeNovelty,
    loadWalmartSellerCatalogNoveltyIndex,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-novelty");
  const { getWalmartClient, getWalmartStoreStatus } = await import(
    "../src/lib/walmart/client"
  );
  const { getConfiguredWalmartSpecVersion } = await import(
    "../src/lib/bundle-factory/distribution/walmart-item-contract"
  );
  const resolved = databaseConfig();
  const { resolveDatabaseTarget } = await import(
    "./product-truth-migration-plan"
  );
  const target = resolveDatabaseTarget(resolved.url);
  const db = createClient(resolved);
  const blockers: string[] = [];
  const { inspectWalmartOwnerPermitTrustRoot } = await import(
    "../src/lib/bundle-factory/walmart-owner-permit"
  );
  const ownerPermitTrust = inspectWalmartOwnerPermitTrustRoot();
  if (ownerPermitTrust.active_key_ids.length !== 1) {
    blockers.push("OWNER_PERMIT_TRUST_ROOT_NOT_READY");
  }
  let productTruthReady = false;
  let productTruthError: string | null = null;
  try {
    await assertProductTruthEvidenceSchema(db);
    productTruthReady = true;
  } catch (error) {
    productTruthError = error instanceof Error ? error.message : String(error);
    blockers.push("PRODUCT_TRUTH_SCHEMA_NOT_READY");
  }

  const submissionLedgerReady =
    await tableExists(db, "MarketplaceSubmissionAttempt");
  const buyerEvidenceReady =
    await tableExists(db, "WalmartBuyerPublicationEvidence");
  if (!submissionLedgerReady) blockers.push("SUBMISSION_LEDGER_SCHEMA_NOT_READY");
  if (!buyerEvidenceReady) blockers.push("BUYER_EVIDENCE_SCHEMA_NOT_READY");
  let lifecycleSchemaReady = false;
  let lifecycleSchemaMissing: string[] = [];
  let lifecycleSchemaError: string | null = null;
  try {
    const { inspectWalmartPublishLifecycleSchema } = await import(
      "../src/lib/bundle-factory/distribution/walmart-publish-lifecycle"
    );
    const inspection = await inspectWalmartPublishLifecycleSchema();
    lifecycleSchemaReady = inspection.ready;
    lifecycleSchemaMissing = inspection.missing;
    if (!inspection.ready) blockers.push("PUBLISH_LIFECYCLE_SCHEMA_INCOMPLETE");
  } catch (error) {
    lifecycleSchemaError = error instanceof Error ? error.message : String(error);
    blockers.push("PUBLISH_LIFECYCLE_SCHEMA_UNREADABLE");
  }

  let availableUpcs = 0;
  let availableHistoricPoolUpcs = 0;
  let duplicateDraftReservations = 0;
  let probeUpc: string | null = null;
  try {
    availableUpcs = await scalar(
      db,
      `SELECT COUNT(*) AS value FROM UPCPool
       WHERE status='AVAILABLE' AND assigned_to_id IS NULL
         AND reserved_for_id IS NULL`,
    );
    availableHistoricPoolUpcs = await scalar(
      db,
      `SELECT COUNT(*) AS value FROM UPCPool
       WHERE status='AVAILABLE' AND assigned_to_id IS NULL
         AND reserved_for_id IS NULL AND gs1_validated=0`,
    );
    duplicateDraftReservations = await scalar(
      db,
      `SELECT COUNT(*) AS value FROM (
         SELECT reserved_for_id
         FROM UPCPool
         WHERE reserved_for_id IS NOT NULL
         GROUP BY reserved_for_id
         HAVING COUNT(*) > 1
       )`,
    );
    const probeRow = await db.execute(
      `SELECT upc FROM UPCPool
       WHERE status='AVAILABLE' AND assigned_to_id IS NULL
         AND reserved_for_id IS NULL
       ORDER BY COALESCE(acquired_at, created_at), id LIMIT 1`,
    );
    probeUpc = probeRow.rows[0]?.upc ? String(probeRow.rows[0].upc) : null;
    if (availableUpcs === 0) blockers.push("UPC_POOL_EMPTY");
    if (duplicateDraftReservations > 0) {
      blockers.push("UPC_DUPLICATE_DRAFT_RESERVATIONS");
    }
  } catch {
    blockers.push("UPC_POOL_UNREADABLE");
  }

  const store = getWalmartStoreStatus(args.storeIndex);
  if (!store.configured) blockers.push("WALMART_CREDENTIALS_NOT_CONFIGURED");
  const sellerId = store.sellerId;
  let sellerCatalogAuthority: SealedWalmartSellerCatalogAuthorityBinding | null = null;
  let sellerCatalogAuthorityError: string | null = null;
  if (store.configured && sellerId) {
    try {
      const clientId = process.env[`WALMART_CLIENT_ID_STORE${args.storeIndex}`];
      if (!clientId) {
        throw new Error("active Walmart client ID is missing");
      }
      const [authorityModule, captureModule, engineModule] = await Promise.all([
        import("../src/lib/bundle-factory/walmart-new-sku-catalog-authority"),
        import("../src/lib/walmart/item-report-capture-session"),
        import("../src/lib/bundle-factory/walmart-new-sku-engine"),
      ]);
      sellerCatalogAuthority =
        await authorityModule.buildWalmartSellerCatalogAuthorityBinding({
          db,
          sourcePath: args.itemReportCatalogSourcePath!,
          expectedSourceFileSha256:
            args.expectedItemReportCatalogSourceSha256!,
          storeIndex: args.storeIndex,
          businessSellerAccountFingerprintSha256:
            engineModule.fingerprintWalmartSellerAccount({
              storeIndex: args.storeIndex,
              sellerId,
            }),
          activeCaptureCredentialScopeFingerprintSha256:
            captureModule.computeWalmartSellerAccountFingerprint({
              store_index: args.storeIndex,
              client_id: clientId,
              seller_id: sellerId,
            }),
          now: checkedAt,
        });
    } catch (error) {
      sellerCatalogAuthorityError =
        error instanceof Error ? error.message : String(error);
      blockers.push("SELLER_CATALOG_AUTHORITY_NOT_READY");
    }
  } else {
    sellerCatalogAuthorityError =
      "configured Walmart seller identity is required";
    blockers.push("SELLER_CATALOG_AUTHORITY_NOT_READY");
  }
  let walmartApiProbe: {
    method: "GET";
    path: "/v3/items/walmart/search";
    response_format: "SPEC";
    upc_sha256: string;
    http_status: 200;
    correlation_id: string;
    response_sha256: string;
    authenticated_catalog_read: true;
  } | null = null;
  if (store.configured && sellerId && probeUpc) {
    try {
      const response = await getWalmartClient(args.storeIndex).requestRaw(
        "GET",
        "/items/walmart/search",
        {
          params: { upc: probeUpc, responseFormat: "SPEC" },
          noRetryOn429: true,
        },
      );
      if (!response.ok || response.status !== 200) {
        blockers.push("WALMART_AUTHENTICATED_CATALOG_READ_FAILED");
      } else {
        const { sha256WalmartJson } = await import(
          "../src/lib/bundle-factory/walmart-listing-contract"
        );
        walmartApiProbe = {
          method: "GET",
          path: "/v3/items/walmart/search",
          response_format: "SPEC",
          upc_sha256: createHash("sha256").update(probeUpc).digest("hex"),
          http_status: 200,
          correlation_id: response.correlationId,
          response_sha256: sha256WalmartJson(response.body),
          authenticated_catalog_read: true,
        };
      }
    } catch {
      blockers.push("WALMART_AUTHENTICATED_CATALOG_READ_FAILED");
    }
  } else if (store.configured) {
    blockers.push("WALMART_AUTHENTICATED_CATALOG_READ_UNAVAILABLE");
  }
  const candidates: Awaited<ReturnType<typeof listProductTruthWalmartPilotCandidates>> = [];
  let sellerCatalogSnapshot: {
    synced_at: string;
    row_count: number;
    active_row_count: number;
    sha256: string;
    authoritative_item_report_downloaded_at: string;
    authoritative_item_report_request_id_sha256: string;
    exact_recipe_collisions_excluded: number;
  } | null = null;
  if (productTruthReady) {
    try {
      const candidatePool = await listProductTruthWalmartPilotCandidates(db, {
        asOf: args.asOf,
        maxPriceAgeMs: args.maxPriceAgeMs,
        zip: args.zip,
        limit: 100,
      });
      const noveltyIndex = await loadWalmartSellerCatalogNoveltyIndex({
        db,
        storeIndex: args.storeIndex,
        now: checkedAt,
      });
      let collisionsExcluded = 0;
      for (const candidate of candidatePool) {
        const recipe = await readProductTruthNewSkuView(
          db,
          [{ donorProductId: candidate.donor_product_id, qty: args.packCount }],
          {
            asOf: args.asOf,
            maxPriceAgeMs: args.maxPriceAgeMs,
            zip: args.zip,
          },
        );
        const novelty = inspectWalmartSellerCatalogRecipeNovelty({
          index: noveltyIndex,
          component: recipe.components[0],
          now: checkedAt,
        });
        if (!novelty.novel) {
          collisionsExcluded += 1;
          continue;
        }
        candidates.push(candidate);
        if (candidates.length >= args.limit) break;
      }
      sellerCatalogSnapshot = {
        synced_at: noveltyIndex.seller_catalog_synced_at,
        row_count: noveltyIndex.seller_catalog_row_count,
        active_row_count: noveltyIndex.seller_catalog_active_row_count,
        sha256: noveltyIndex.seller_catalog_sha256,
        authoritative_item_report_downloaded_at:
          noveltyIndex.authoritative_item_report_downloaded_at,
        authoritative_item_report_request_id_sha256:
          noveltyIndex.authoritative_item_report_request_id_sha256,
        exact_recipe_collisions_excluded: collisionsExcluded,
      };
    } catch (error) {
      blockers.push("SELLER_CATALOG_NOVELTY_NOT_READY");
      sellerCatalogSnapshot = null;
      productTruthError = [
        productTruthError,
        error instanceof Error ? error.message : String(error),
      ].filter(Boolean).join("; ");
    }
  }
  if (productTruthReady && candidates.length === 0) {
    blockers.push("NO_CURRENT_CANONICAL_PILOT_CANDIDATES");
  }

  const schemaSha256 = await databaseSchemaSha256(db);
  const report = {
    engine: "walmart-new-sku-engine",
    command: "doctor",
    checked_at: checkedAt.toISOString(),
    read_only: true,
    database: databaseLabel(resolved.url),
    store: {
      store_index: args.storeIndex,
      configured: store.configured,
      store_name: store.storeName,
      seller_id_present: Boolean(store.sellerId),
    },
    item_spec: {
      configured_version: getConfiguredWalmartSpecVersion(),
      live_get_spec_required_before_certification: true,
    },
    walmart_api_probe: walmartApiProbe,
    database_target_fingerprint_sha256: target.fingerprint,
    database_schema_sha256: schemaSha256,
    engine_release_sha256: engineReleaseSha256,
    expected_engine_release_sha256: args.expectedEngineReleaseSha256,
    release_manifest_sha256: frozenRelease.manifest_sha256,
    frozen_release_verified: true,
    frozen_release_source_modes_verified: true,
    planning_scope: {
      as_of: args.asOf.toISOString(),
      zip: args.zip,
      max_price_age_ms: args.maxPriceAgeMs,
      limit: args.limit,
      pack_count: args.packCount,
    },
    owner_permit_trust: ownerPermitTrust,
    product_truth: {
      schema_ready: productTruthReady,
      error: productTruthError,
      current_candidate_count_sample: candidates.length,
    },
    seller_catalog_novelty: sellerCatalogSnapshot,
    seller_catalog_authority: sellerCatalogAuthority
      ? {
          binding_id: sellerCatalogAuthority.binding_id,
          body_sha256: sellerCatalogAuthority.body_sha256,
          source_file_sha256:
            sellerCatalogAuthority.source_artifact.file_sha256,
          source_row_count:
            sellerCatalogAuthority.source_artifact.row_count,
          mirror_row_count:
            sellerCatalogAuthority.mirror_reconciliation.row_count,
          source_downloaded_at:
            sellerCatalogAuthority.source_artifact.downloaded_at,
          mirror_synced_at:
            sellerCatalogAuthority.mirror_reconciliation.synced_at,
          exact_match:
            sellerCatalogAuthority.mirror_reconciliation.exact_match,
          error: null,
        }
      : { error: sellerCatalogAuthorityError },
    upc_pool: {
      available: availableUpcs,
      available_historic_pool_not_marked_gs1_validated: availableHistoricPoolUpcs,
      duplicate_draft_reservations: duplicateDraftReservations,
      gs1_validated_false_is_not_a_blocker: true,
    },
    publish_lifecycle: {
      submission_ledger_schema_ready: submissionLedgerReady,
      buyer_evidence_schema_ready: buyerEvidenceReady,
      canonical_schema_ready: lifecycleSchemaReady,
      missing: lifecycleSchemaMissing,
      error: lifecycleSchemaError,
      processed_feed_alone_can_mark_live: false,
    },
    ready_for_plan:
      productTruthReady &&
      candidates.length > 0 &&
      store.configured &&
      Boolean(store.sellerId) &&
      sellerCatalogAuthority !== null,
    infrastructure_ready_for_pilot: blockers.length === 0,
    ready_for_live_apply: false,
    live_apply_requires: [
      "SEALED_CANDIDATE_CERTIFICATION",
      "FRESH_DRY_RUN_RECEIPT",
      "FRESH_DOCTOR_RECEIPT",
      "SEALED_INTERNAL_APPROVAL",
      "APPLY_PREVIEW_REVIEW",
      "EXTERNAL_OWNER_PERMIT",
    ],
    blockers,
  };
  let receiptOutput: string | null = null;
  let receiptSha256: string | null = null;
  if (
    blockers.length === 0 &&
    args.out &&
    walmartApiProbe &&
    sellerId &&
    sellerCatalogAuthority
  ) {
    const {
      fingerprintWalmartSellerAccount,
      sealWalmartNewSkuDoctorReceipt,
    } = await import(
      "../src/lib/bundle-factory/walmart-new-sku-engine"
    );
    const receipt = sealWalmartNewSkuDoctorReceipt({
      schema_version: "walmart-new-sku-doctor-receipt/1.4.0",
      checked_at: checkedAt.toISOString(),
      expires_at: new Date(checkedAt.getTime() + 30 * 60_000).toISOString(),
      store_index: args.storeIndex,
      seller_account_fingerprint_sha256: fingerprintWalmartSellerAccount({
        storeIndex: args.storeIndex,
        sellerId,
      }),
      seller_catalog_authority: sellerCatalogAuthority,
      database_target_fingerprint_sha256: target.fingerprint,
      database_schema_sha256: schemaSha256,
      engine_release_sha256: engineReleaseSha256,
      expected_engine_release_sha256: args.expectedEngineReleaseSha256!,
      release_manifest_sha256: frozenRelease.manifest_sha256,
      frozen_release_verified: true,
      frozen_release_source_modes_verified: true,
      planning_scope: {
        as_of: args.asOf.toISOString(),
        zip: "33765",
        max_price_age_ms: 86_400_000,
        limit: 1,
        pack_count: args.packCount as 2 | 3,
      },
      owner_permit_key_id: ownerPermitTrust.active_key_ids[0]!,
      owner_permit_public_key_spki_sha256:
        ownerPermitTrust.active_key_fingerprints[0]!,
      item_spec_version: getConfiguredWalmartSpecVersion(),
      walmart_api_probe: walmartApiProbe,
      product_truth_schema_ready: true,
      publish_lifecycle_schema_ready: true,
      upc_pool: {
        available: availableUpcs,
        duplicate_draft_reservations: 0,
      },
      ready_for_plan: true,
      infrastructure_ready_for_pilot: true,
      ready_for_live_apply: false,
      blockers: [],
      claims: {
        read_only: true,
        provider_calls: 0,
        marketplace_mutated: false,
        listing_published: false,
        migration_applied: false,
        backfill_performed: false,
      },
    });
    receiptOutput = resolve(args.out);
    await writeOnce(receiptOutput, `${JSON.stringify(receipt, null, 2)}\n`);
    receiptSha256 = receipt.receipt_sha256;
  }
  process.stdout.write(`${JSON.stringify({
    ...report,
    doctor_receipt: receiptOutput,
    doctor_receipt_sha256: receiptSha256,
    doctor_receipt_written: Boolean(receiptOutput),
    ...operatorNext(receiptOutput ? [
      "plan",
      "--doctor-receipt", receiptOutput,
      "--store-index", String(args.storeIndex),
      "--limit", "1",
      "--pack-count", String(args.packCount),
      "--zip", args.zip,
      "--as-of", args.asOf.toISOString(),
      "--max-price-age-hours", String(PILOT_MAX_PRICE_AGE_HOURS),
    ] : null),
  }, null, 2)}\n`);
  await db.close();
  if (blockers.length > 0) process.exitCode = 2;
}

async function readExistingWriteOnceArtifact(input: {
  absolute: string;
  canonicalParent: string;
  content: string;
}): Promise<"identical" | null> {
  const before = await lstat(input.absolute).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!before) return null;
  const canonicalPath = join(input.canonicalParent, basename(input.absolute));
  const resolvedPath = await realpath(input.absolute).catch(() => null);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    resolvedPath !== canonicalPath
  ) {
    throw new Error(`Refusing unsafe existing artifact path: ${input.absolute}`);
  }
  const handle = await open(
    canonicalPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs ||
      opened.nlink !== 1
    ) {
      throw new Error(`Existing artifact changed before read: ${input.absolute}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const [parentAfter, pathAfter] = await Promise.all([
      realpath(dirname(input.absolute)).catch(() => null),
      lstat(input.absolute).catch(() => null),
    ]);
    if (
      parentAfter !== input.canonicalParent ||
      !pathAfter ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.nlink !== 1 ||
      pathAfter.nlink !== 1 ||
      bytes.byteLength !== opened.size
    ) {
      throw new Error(`Existing artifact changed during read: ${input.absolute}`);
    }
    if (bytes.toString("utf8") === input.content) return "identical";
    throw new Error(`Refusing to overwrite a different artifact: ${input.absolute}`);
  } finally {
    await handle.close();
  }
}

async function writeOnce(
  path: string,
  content: string,
  expectedCanonicalParent?: string,
): Promise<"created" | "identical"> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const canonicalParent = await realpath(dirname(absolute));
  if (
    expectedCanonicalParent &&
    canonicalParent !== expectedCanonicalParent
  ) {
    throw new Error(`Artifact output parent changed before write: ${absolute}`);
  }
  const canonicalOutput = join(canonicalParent, basename(absolute));
  const existing = await readExistingWriteOnceArtifact({
    absolute,
    canonicalParent,
    content,
  });
  if (existing) return existing;
  const temporary = join(
    canonicalParent,
    `.${basename(absolute)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(temporary, "wx");
  let temporaryStat;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    temporaryStat = await handle.stat();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, canonicalOutput);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const racedExisting = await readExistingWriteOnceArtifact({
      absolute,
      canonicalParent,
      content,
    });
    if (racedExisting) return racedExisting;
    throw new Error(`Artifact path disappeared during exclusive write: ${absolute}`);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const [parentAfter, created, resolvedCreated] = await Promise.all([
    realpath(dirname(absolute)).catch(() => null),
    lstat(absolute).catch(() => null),
    realpath(absolute).catch(() => null),
  ]);
  if (
    !temporaryStat ||
    parentAfter !== canonicalParent ||
    resolvedCreated !== canonicalOutput ||
    !created ||
    created.isSymbolicLink() ||
    !created.isFile() ||
    created.nlink !== 1 ||
    created.dev !== temporaryStat.dev ||
    created.ino !== temporaryStat.ino ||
    created.size !== temporaryStat.size
  ) {
    if (
      created?.isFile() &&
      !created.isSymbolicLink() &&
      created.dev === temporaryStat?.dev &&
      created.ino === temporaryStat?.ino
    ) {
      await unlink(canonicalOutput).catch(() => {});
    }
    throw new Error(`Artifact output path changed during exclusive write: ${absolute}`);
  }
  return "created";
}

async function runPlan(args: ParsedArgs): Promise<void> {
  if (!args.doctorReceiptPath) {
    throw new Error("plan requires --doctor-receipt <fresh-doctor.json>");
  }
  const doctor = await readDoctorReceiptArtifact(args.doctorReceiptPath);
  const {
    listProductTruthWalmartPilotCandidates,
    readProductTruthNewSkuView,
  } = await import("../src/lib/sourcing/product-truth-read-contract");
  const {
    buildWalmartNewSkuPilotPlan,
    serializeWalmartNewSkuPlan,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-engine");
  const {
    inspectWalmartSellerCatalogRecipeNovelty,
    loadWalmartSellerCatalogNoveltyIndex,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-novelty");
  const { getWalmartStoreStatus } = await import("../src/lib/walmart/client");
  const { getConfiguredWalmartSpecVersion } = await import(
    "../src/lib/bundle-factory/distribution/walmart-item-contract"
  );
  const store = getWalmartStoreStatus(args.storeIndex);
  if (!store.configured || !store.sellerId) {
    throw new Error(
      `Walmart seller account is not configured for store index ${args.storeIndex}`,
    );
  }
  const {
    fingerprintWalmartSellerAccount,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-engine");
  const engineReleaseSha256 = await walmartNewSkuEngineReleaseSha256();
  const expectedSellerFingerprint = fingerprintWalmartSellerAccount({
    storeIndex: args.storeIndex,
    sellerId: store.sellerId,
  });
  if (
    doctor.store_index !== args.storeIndex ||
    doctor.seller_account_fingerprint_sha256 !== expectedSellerFingerprint ||
    doctor.engine_release_sha256 !== engineReleaseSha256 ||
    doctor.expected_engine_release_sha256 !== engineReleaseSha256 ||
    doctor.item_spec_version !== getConfiguredWalmartSpecVersion() ||
    doctor.planning_scope.as_of !== args.asOf.toISOString() ||
    doctor.planning_scope.zip !== args.zip ||
    doctor.planning_scope.max_price_age_ms !== args.maxPriceAgeMs ||
    doctor.planning_scope.limit !== args.limit ||
    doctor.planning_scope.pack_count !== args.packCount
  ) {
    throw new Error(
      "PLAN_DOCTOR_BINDING_MISMATCH: seller/release/spec/scope differs from fresh doctor",
    );
  }
  const resolved = databaseConfig();
  const { resolveDatabaseTarget } = await import(
    "./product-truth-migration-plan"
  );
  const target = resolveDatabaseTarget(resolved.url);
  const db = createClient(resolved);
  try {
    const plannedAt = new Date();
    const schemaSha256 = await databaseSchemaSha256(db);
    if (
      doctor.database_target_fingerprint_sha256 !== target.fingerprint ||
      doctor.database_schema_sha256 !== schemaSha256
    ) {
      throw new Error(
        "PLAN_DOCTOR_DATABASE_BINDING_MISMATCH: target or schema differs from fresh doctor",
      );
    }
    const { assertCurrentWalmartSellerCatalogAuthority } = await import(
      "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
    );
    await assertCurrentWalmartSellerCatalogAuthority({
      db,
      authority: doctor.seller_catalog_authority,
      now: plannedAt,
    });
    // Over-read the canonical queue because durable BundleDraft fingerprints
    // exclude recipes already staged by an earlier wave. A plan artifact is
    // read-only and therefore is not itself a cursor/disposition.
    const candidates = await listProductTruthWalmartPilotCandidates(db, {
      asOf: args.asOf,
      maxPriceAgeMs: args.maxPriceAgeMs,
      zip: args.zip,
      limit: 100,
    });
    const sellerCatalogIndex = await loadWalmartSellerCatalogNoveltyIndex({
      db,
      storeIndex: args.storeIndex,
      now: plannedAt,
    });
    const compiled = [];
    const rejected: Array<{ donor_product_id: string; reason: string }> = [];
    for (const candidate of candidates) {
      if (compiled.length >= args.limit) break;
      const recipeFingerprint =
        `walmart:${args.storeIndex}:${candidate.canonical_variant_id}:${args.packCount}`;
      const prior = await db.execute({
        sql: `SELECT id, status FROM BundleDraft
              WHERE recipe_fingerprint=? LIMIT 1`,
        args: [recipeFingerprint],
      });
      if (prior.rows.length > 0) {
        rejected.push({
          donor_product_id: candidate.donor_product_id,
          reason:
            `ALREADY_STAGED:${String(prior.rows[0].id)}:` +
            `${String(prior.rows[0].status)}`,
        });
        continue;
      }
      try {
        const recipe = await readProductTruthNewSkuView(
          db,
          [{ donorProductId: candidate.donor_product_id, qty: args.packCount }],
          {
            asOf: args.asOf,
            maxPriceAgeMs: args.maxPriceAgeMs,
            zip: args.zip,
          },
        );
        const novelty = inspectWalmartSellerCatalogRecipeNovelty({
          index: sellerCatalogIndex,
          component: recipe.components[0],
          now: plannedAt,
        });
        if (!novelty.novel) {
          rejected.push({
            donor_product_id: candidate.donor_product_id,
            reason: `RECIPE_ALREADY_EXISTS_OR_REQUIRES_RECONCILIATION:${novelty.collisions
              .map((collision) => `${collision.source}:${collision.sku}:${collision.basis}`)
              .join(",")}`,
          });
          continue;
        }
        compiled.push({ candidate, recipe, packCount: args.packCount });
      } catch (error) {
        rejected.push({
          donor_product_id: candidate.donor_product_id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const plan = buildWalmartNewSkuPilotPlan({
      createdAt: plannedAt,
      asOf: args.asOf,
      storeIndex: args.storeIndex,
      sellerId: store.sellerId,
      doctorBinding: {
        doctorReceiptSha256: doctor.receipt_sha256,
        engineReleaseSha256,
        releaseManifestSha256: doctor.release_manifest_sha256,
        databaseTargetFingerprintSha256: target.fingerprint,
        databaseSchemaSha256: schemaSha256,
        itemSpecVersion: getConfiguredWalmartSpecVersion(),
        sellerCatalogAuthority: doctor.seller_catalog_authority,
      },
      zip: args.zip,
      maxLiveSubmissions: 1,
      candidates: compiled,
    });
    const content = serializeWalmartNewSkuPlan(plan);
    const outputPath = args.out ?? resolve(
      "data",
      "walmart-new-sku-engine",
      "waves",
      `${plan.wave_id}-${plan.plan_sha256.slice(0, 12)}`,
      "plan.json",
    );
    const disposition = await writeOnce(outputPath, content);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "plan",
      marketplace_mutated: false,
      database_mutated: false,
      metered_provider_called: false,
      wave_id: plan.wave_id,
      plan_sha256: plan.plan_sha256,
      candidate_count: plan.candidates.length,
      already_staged_excluded: rejected.filter(
        (row) => row.reason.startsWith("ALREADY_STAGED:"),
      ).length,
      rejected,
      output: resolve(outputPath),
      disposition,
      ...operatorNext([
        "stage",
        "--plan", resolve(outputPath),
        "--doctor-receipt", resolve(args.doctorReceiptPath),
        "--candidate", plan.candidates[0].candidate_key,
        "--mode", "preview",
      ]),
    }, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

async function readPlan(
  path: string,
  options: {
    doctorReceiptPath?: string | null;
    requireFreshDoctor?: boolean;
  } = {},
) {
  const {
    assertWalmartNewSkuPlanIntegrity,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-engine");
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuPlanIntegrity(parsed);
  const { assertCurrentWalmartSellerAccountBinding } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  assertCurrentWalmartSellerAccountBinding(parsed);
  const engineReleaseSha256 = await walmartNewSkuEngineReleaseSha256();
  const { getConfiguredWalmartSpecVersion } = await import(
    "../src/lib/bundle-factory/distribution/walmart-item-contract"
  );
  if (
    parsed.engine_release_sha256 !== engineReleaseSha256 ||
    parsed.item_spec_version !== getConfiguredWalmartSpecVersion()
  ) {
    throw new Error(
      "PLAN_RUNTIME_BINDING_DRIFT: release/spec differs from sealed plan",
    );
  }
  if (options.requireFreshDoctor && !options.doctorReceiptPath) {
    throw new Error("stage requires --doctor-receipt <fresh-doctor.json>");
  }
  if (options.doctorReceiptPath) {
    // Artifact integrity and every static doctor/plan binding are checked before
    // resolving credentials or opening the configured database.
    const doctor = await readDoctorReceiptArtifact(options.doctorReceiptPath);
    const { stableWalmartJson } = await import(
      "../src/lib/bundle-factory/walmart-listing-contract"
    );
    const packCounts = new Set(
      parsed.candidates.map((candidate: { pack_count: number }) => candidate.pack_count),
    );
    if (
      doctor.receipt_sha256 !== parsed.doctor_receipt_sha256 ||
      doctor.store_index !== parsed.store_index ||
      doctor.seller_account_fingerprint_sha256 !==
        parsed.seller_account_fingerprint_sha256 ||
      stableWalmartJson(doctor.seller_catalog_authority) !==
        stableWalmartJson(parsed.seller_catalog_authority) ||
      doctor.engine_release_sha256 !== parsed.engine_release_sha256 ||
      doctor.expected_engine_release_sha256 !== parsed.engine_release_sha256 ||
      doctor.release_manifest_sha256 !== parsed.release_manifest_sha256 ||
      doctor.database_target_fingerprint_sha256 !==
        parsed.database_target_fingerprint_sha256 ||
      doctor.database_schema_sha256 !== parsed.database_schema_sha256 ||
      doctor.item_spec_version !== parsed.item_spec_version ||
      doctor.planning_scope.as_of !== parsed.as_of ||
      doctor.planning_scope.zip !== parsed.zip ||
      doctor.planning_scope.limit !== 1 ||
      parsed.max_live_submissions !== 1 ||
      packCounts.size !== 1 ||
      !packCounts.has(doctor.planning_scope.pack_count) ||
      parsed.candidates.some(
        (candidate: { recipe_input: { price_max_age_ms: number } }) =>
          candidate.recipe_input.price_max_age_ms !==
            doctor.planning_scope.max_price_age_ms,
      )
    ) {
      throw new Error(
        "PLAN_DOCTOR_BINDING_DRIFT: fresh doctor differs from sealed plan",
      );
    }
  }
  const resolved = databaseConfig();
  const { resolveDatabaseTarget } = await import(
    "./product-truth-migration-plan"
  );
  const target = resolveDatabaseTarget(resolved.url);
  const db = createClient(resolved);
  let schemaSha256: string;
  try {
    schemaSha256 = await databaseSchemaSha256(db);
    const { assertCurrentWalmartSellerCatalogAuthority } = await import(
      "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
    );
    await assertCurrentWalmartSellerCatalogAuthority({
      db,
      authority: parsed.seller_catalog_authority,
      now: new Date(),
    });
  } finally {
    await db.close();
  }
  if (
    parsed.database_target_fingerprint_sha256 !== target.fingerprint ||
    parsed.database_schema_sha256 !== schemaSha256
  ) {
    throw new Error(
      "PLAN_RUNTIME_BINDING_DRIFT: database/schema differs from sealed plan",
    );
  }
  return parsed;
}

async function runStage(args: ParsedArgs): Promise<void> {
  const {
    buildWalmartNewSkuStagePreview,
    serializeWalmartNewSkuStageArtifact,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-engine");
  if (!args.planPath) throw new Error("stage requires --plan <plan.json>");
  if (!args.doctorReceiptPath) {
    throw new Error("stage requires --doctor-receipt <fresh-doctor.json>");
  }
  const plan = await readPlan(args.planPath, {
    doctorReceiptPath: args.doctorReceiptPath,
    requireFreshDoctor: true,
  });
  const candidateKey = args.candidateKey ??
    (plan.candidates.length === 1 ? plan.candidates[0].candidate_key : null);
  if (!candidateKey) {
    throw new Error("stage requires --candidate when the plan has multiple candidates");
  }
  const preview = buildWalmartNewSkuStagePreview({ plan, candidateKey });
  if (args.mode === "preview") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "stage",
      mode: "preview",
      internal_database_mutated: false,
      marketplace_mutated: false,
      preview,
      required_confirmation: plan.plan_sha256,
      ...operatorNext([
        "stage",
        "--plan", resolve(args.planPath),
        "--doctor-receipt", resolve(args.doctorReceiptPath),
        "--candidate", candidateKey,
        "--mode", "apply-internal",
        "--actor", "<operator>",
        "--confirm", plan.plan_sha256,
      ]),
    }, null, 2)}\n`);
    return;
  }
  if (!args.actor) throw new Error("apply-internal stage requires --actor");
  if (args.confirm !== plan.plan_sha256) {
    throw new Error("apply-internal stage requires --confirm equal to plan_sha256");
  }
  const { stageWalmartNewSkuCandidate } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const resolved = databaseConfig();
  const db = createClient(resolved);
  try {
    const artifact = await stageWalmartNewSkuCandidate({
      productTruthDb: db,
      plan,
      candidateKey,
      actor: args.actor,
    });
    const defaultOutput = resolve(
      dirname(resolve(args.planPath)),
      `stage-${candidateKey}-${artifact.stage_sha256.slice(0, 12)}.json`,
    );
    const outputPath = args.out ? resolve(args.out) : defaultOutput;
    const disposition = await writeOnce(
      outputPath,
      serializeWalmartNewSkuStageArtifact(artifact),
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "stage",
      mode: "apply-internal",
      internal_database_mutated: true,
      marketplace_mutated: false,
      wave_id: artifact.wave_id,
      candidate_key: artifact.candidate_key,
      proposed_sku: artifact.proposed_sku,
      upc: artifact.upc,
      upc_gs1_validated: artifact.upc_gs1_validated,
      stage_sha256: artifact.stage_sha256,
      output: outputPath,
      disposition,
      ...operatorNext([
        "certify",
        "--plan", resolve(args.planPath),
        "--stage", outputPath,
        "--mode", "template",
      ]),
    }, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

async function readStage(path: string, plan: Awaited<ReturnType<typeof readPlan>>) {
  const { assertWalmartNewSkuStageArtifactIntegrity } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  assertWalmartNewSkuStageArtifactIntegrity(parsed, plan);
  return parsed;
}

async function runRotateUpc(args: ParsedArgs): Promise<void> {
  if (!args.planPath) throw new Error("rotate-upc requires --plan <plan.json>");
  if (!args.stagePath) throw new Error("rotate-upc requires --stage <stage.json>");
  const plan = await readPlan(args.planPath);
  const stage = await readStage(args.stagePath, plan);
  const { previewWalmartNewSkuUpcRotation } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );

  if (args.mode === "preview") {
    const db = createClient(databaseConfig());
    let preview: Awaited<ReturnType<typeof previewWalmartNewSkuUpcRotation>>;
    try {
      preview = await previewWalmartNewSkuUpcRotation({
        productTruthDb: db,
        plan,
        stage,
      });
    } finally {
      await db.close();
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "rotate-upc",
      mode: "preview",
      walmart_catalog_read_performed: true,
      response_format: "SPEC",
      internal_database_mutated: false,
      marketplace_mutated: false,
      prior_stage_sha256: stage.stage_sha256,
      old_upc: stage.upc,
      exact_match: preview.exact_match,
      required_confirmation: preview.confirmation_sha256,
      ...operatorNext([
        "rotate-upc",
        "--plan", resolve(args.planPath),
        "--stage", resolve(args.stagePath),
        "--mode", "apply-internal",
        "--actor", "<operator>",
        "--confirm", preview.confirmation_sha256,
      ]),
    }, null, 2)}\n`);
    return;
  }

  if (!args.actor) throw new Error("apply-internal UPC rotation requires --actor");
  if (!args.confirm) {
    throw new Error(
      "apply-internal UPC rotation requires the preview confirmation SHA-256",
    );
  }
  const { rotateExactMatchedWalmartNewSkuUpc } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const { serializeWalmartNewSkuStageArtifact } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const db = createClient(databaseConfig());
  let result: Awaited<ReturnType<typeof rotateExactMatchedWalmartNewSkuUpc>>;
  try {
    result = await rotateExactMatchedWalmartNewSkuUpc({
      productTruthDb: db,
      plan,
      stage,
      actor: args.actor,
      confirmationSha256: args.confirm,
    });
  } finally {
    await db.close();
  }
  const baseDir = dirname(resolve(args.stagePath));
  const stagePath = args.out
    ? resolve(args.out)
    : resolve(
        baseDir,
        `stage-${stage.candidate_key}-rotated-${result.new_stage.stage_sha256.slice(0, 12)}.json`,
      );
  const receiptPath = resolve(
    dirname(stagePath),
    `upc-rotation-${stage.candidate_key}-${result.receipt.receipt_sha256.slice(0, 12)}.json`,
  );
  const [stageDisposition, receiptDisposition] = await Promise.all([
    writeOnce(
      stagePath,
      serializeWalmartNewSkuStageArtifact(result.new_stage),
    ),
    writeOnce(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "rotate-upc",
    mode: "apply-internal",
    walmart_catalog_reread_performed: true,
    response_format: "SPEC",
    internal_database_mutated: !result.idempotent_recovery,
    idempotent_recovery: result.idempotent_recovery,
    marketplace_mutated: false,
    confirmation_sha256: result.receipt.confirmation_sha256,
    prior_stage_sha256: stage.stage_sha256,
    retired_upc: stage.upc,
    retired_upc_pool_id: stage.upc_pool_id,
    retired_upc_status: "RETIRED",
    retired_upc_disposition: "FUTURE_MP_ITEM_MATCH",
    new_upc: result.new_stage.upc,
    new_upc_pool_id: result.new_stage.upc_pool_id,
    new_stage_sha256: result.new_stage.stage_sha256,
    rotation_receipt_sha256: result.receipt.receipt_sha256,
    stage: stagePath,
    stage_disposition: stageDisposition,
    receipt: receiptPath,
    receipt_disposition: receiptDisposition,
    ...operatorNext([
      "certify",
      "--plan", resolve(args.planPath),
      "--stage", stagePath,
      "--mode", "template",
    ]),
  }, null, 2)}\n`);
}

async function runCertifyEvidenceSeal(args: ParsedArgs): Promise<void> {
  if (!args.planPath) throw new Error("certify seal-evidence requires --plan <plan.json>");
  if (!args.stagePath) throw new Error("certify seal-evidence requires --stage <stage.json>");
  if (!args.evidencePath) {
    throw new Error("certify seal-evidence requires --evidence <draft-input.json>");
  }
  if (!args.out) {
    throw new Error("certify seal-evidence requires --out <new-sealed-input.json>");
  }
  const inputPath = resolve(args.evidencePath);
  const outputPath = resolve(args.out);
  if (inputPath === outputPath) {
    throw new Error("certify seal-evidence output must differ from the draft input");
  }
  const [canonicalInputPath, canonicalExistingOutputPath] = await Promise.all([
    realpath(inputPath),
    realpath(outputPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (canonicalExistingOutputPath === canonicalInputPath) {
    throw new Error(
      "certify seal-evidence output must be a new physical artifact, not an alias of the draft input",
    );
  }
  const draftBytes = await readRegularFileNoFollow(
    inputPath,
    25 * 1024 * 1024,
    "Certification evidence draft",
  );
  let draft: unknown;
  try {
    draft = JSON.parse(draftBytes.toString("utf8"));
  } catch {
    throw new Error("Certification evidence draft must be valid JSON bytes");
  }
  const [planBytes, stageBytes] = await Promise.all([
    readRegularFileNoFollow(
      resolve(args.planPath),
      25 * 1024 * 1024,
      "Evidence-seal plan",
    ),
    readRegularFileNoFollow(
      resolve(args.stagePath),
      25 * 1024 * 1024,
      "Evidence-seal stage",
    ),
  ]);
  let plan: unknown;
  let stage: unknown;
  try {
    plan = JSON.parse(planBytes.toString("utf8"));
    stage = JSON.parse(stageBytes.toString("utf8"));
  } catch {
    throw new Error("Evidence-seal plan and stage must be valid JSON bytes");
  }
  const {
    assertWalmartNewSkuEvidenceSealDraftBinding,
  } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const draftBinding = assertWalmartNewSkuEvidenceSealDraftBinding({
    draft,
    plan: plan as never,
    stage: stage as never,
  });
  const { sealWalmartNewSkuCertificationEvidenceDraft } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-evidence-sealer"
  );
  const {
    assertWalmartNewSkuPolicyReviewEvidenceBindingBytes,
  } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-policy-review-evidence"
  );
  const result = await sealWalmartNewSkuCertificationEvidenceDraft({
    draft,
    validateArtifactBytes: ({ path, index, bytes }) => {
      if (index !== draftBinding.policy_evidence_index) return;
      if (path !== draftBinding.policy_evidence_path) {
        throw new Error("POLICY_REVIEW path changed before evidence seal");
      }
      assertWalmartNewSkuPolicyReviewEvidenceBindingBytes({
        bytes,
        expected_binding: draftBinding.expected_policy_binding,
      });
    },
  });
  const disposition = await writeOnce(
    outputPath,
    `${JSON.stringify(result.sealed, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "certify",
    mode: "seal-evidence",
    input: inputPath,
    output: outputPath,
    disposition,
    evidence_artifact_count: result.evidence.length,
    evidence_artifact_bytes_sealed: true,
    changed_fields: ["evidence_artifacts[].sha256", "evidence_artifacts[].byte_size"],
    walmart_reads_performed: 0,
    internal_database_mutated: false,
    marketplace_mutated: false,
    ...operatorNext([
      "certify",
      "--plan", resolve(args.planPath),
      "--stage", resolve(args.stagePath),
      "--evidence", outputPath,
      "--mode", "preview",
    ]),
  }, null, 2)}\n`);
}

async function runCertify(args: ParsedArgs): Promise<void> {
  if (args.mode === "seal-evidence") {
    return runCertifyEvidenceSeal(args);
  }
  const {
    assertWalmartNewSkuCertificationInput,
    buildWalmartNewSkuCertificationTemplate,
    buildWalmartNewSkuPolicyReviewEvidenceTemplate,
    hashWalmartNewSkuCertificationInput,
    serializeWalmartNewSkuCertificationArtifact,
  } = await import("../src/lib/bundle-factory/walmart-new-sku-engine");
  if (!args.planPath) throw new Error("certify requires --plan <plan.json>");
  if (!args.stagePath) throw new Error("certify requires --stage <stage.json>");
  const plan = await readPlan(args.planPath);
  const stage = await readStage(args.stagePath, plan);
  const baseDir = dirname(resolve(args.stagePath));

  if (args.mode === "template") {
    const outputPath = args.out
      ? resolve(args.out)
      : resolve(baseDir, `certification-input-${stage.candidate_key}.json`);
    const policyReviewEvidencePath = resolve(
      dirname(outputPath),
      `policy-review-input-${stage.candidate_key}.json`,
    );
    if (policyReviewEvidencePath === outputPath) {
      throw new Error("Certification and policy-review template paths must be distinct");
    }
    const templateNow = new Date();
    const policyReviewTemplate =
      buildWalmartNewSkuPolicyReviewEvidenceTemplate({
        plan,
        stage,
        now: templateNow,
      });
    const template = buildWalmartNewSkuCertificationTemplate({
      plan,
      stage,
      now: templateNow,
      policyReviewEvidencePath,
    });
    const [policyReviewDisposition, disposition] = await Promise.all([
      writeOnce(
        policyReviewEvidencePath,
        `${JSON.stringify(policyReviewTemplate, null, 2)}\n`,
      ),
      writeOnce(
        outputPath,
        `${JSON.stringify(template, null, 2)}\n`,
      ),
    ]);
    const sealedEvidenceOutputPath = resolve(
      dirname(outputPath),
      `certification-input-sealed-${stage.candidate_key}.json`,
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "certify",
      mode: "template",
      internal_database_mutated: false,
      marketplace_mutated: false,
      output: outputPath,
      disposition,
      policy_review_evidence_template: policyReviewEvidencePath,
      policy_review_evidence_template_disposition: policyReviewDisposition,
      note: "A human/owner must complete every TODO decision/time and the generated fail-closed policy checklist. Then run the emitted seal-evidence command; the engine, not Claude/operator, records exact SHA-256 and byte size before preview.",
      ...operatorNext([
        "certify",
        "--plan", resolve(args.planPath),
        "--stage", resolve(args.stagePath),
        "--evidence", outputPath,
        "--mode", "seal-evidence",
        "--out", sealedEvidenceOutputPath,
      ]),
    }, null, 2)}\n`);
    return;
  }
  if (!args.evidencePath) {
    throw new Error("certify preview/apply-internal requires --evidence <input.json>");
  }
  const certification = JSON.parse(
    await readFile(resolve(args.evidencePath), "utf8"),
  );
  assertWalmartNewSkuCertificationInput({ certification, plan, stage });
  const { verifyWalmartNewSkuCertificationEvidenceArtifacts } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const verifiedEvidence =
    await verifyWalmartNewSkuCertificationEvidenceArtifacts({
      certification,
      plan,
      stage,
    });
  const certificationInputSha256 =
    hashWalmartNewSkuCertificationInput(certification);
  if (args.mode === "preview") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "certify",
      mode: "preview",
      evidence_structure_valid: true,
      evidence_artifact_count: verifiedEvidence.length,
      evidence_artifact_bytes_verified: true,
      walmart_reads_performed: 0,
      internal_database_mutated: false,
      marketplace_mutated: false,
      certification_input_sha256: certificationInputSha256,
      required_confirmation: certificationInputSha256,
      ...operatorNext([
        "certify",
        "--plan", resolve(args.planPath),
        "--stage", resolve(args.stagePath),
        "--evidence", resolve(args.evidencePath),
        "--mode", "apply-internal",
        "--actor", "<operator>",
        "--confirm", certificationInputSha256,
      ]),
    }, null, 2)}\n`);
    return;
  }
  if (!args.actor) throw new Error("apply-internal certification requires --actor");
  if (args.confirm !== certificationInputSha256) {
    throw new Error(
      "apply-internal certification requires --confirm equal to certification_input_sha256",
    );
  }
  const { certifyWalmartNewSkuCandidate } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const { sealWalmartNewSkuCertificationReceipt } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const resolved = databaseConfig();
  const db = createClient(resolved);
  try {
    const result = await certifyWalmartNewSkuCandidate({
      productTruthDb: db,
      plan,
      stage,
      certification,
      actor: args.actor,
    });
    const artifactPath = args.out
      ? resolve(args.out)
      : resolve(
          baseDir,
          `certification-${stage.candidate_key}-${result.artifact.certification_sha256.slice(0, 12)}.json`,
        );
    const receipt = sealWalmartNewSkuCertificationReceipt({
      schema_version: "walmart-new-sku-certification-receipt/1.0.0",
      certification_sha256: result.artifact.certification_sha256,
      captured_at: result.artifact.certified_at,
      payload: result.payload,
      validation: result.validation,
      sources: result.source_receipt,
    }, result.artifact);
    const receiptPath = resolve(
      baseDir,
      `certification-${stage.candidate_key}-${result.artifact.certification_sha256.slice(0, 12)}-receipt.json`,
    );
    const [artifactDisposition, receiptDisposition] = await Promise.all([
      writeOnce(
        artifactPath,
        serializeWalmartNewSkuCertificationArtifact(result.artifact),
      ),
      writeOnce(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`),
    ]);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "certify",
      mode: "apply-internal",
      internal_database_mutated: true,
      walmart_read_only_calls_performed: true,
      marketplace_mutated: false,
      validation_status: result.artifact.validation_status,
      sku: result.artifact.sku,
      upc: result.artifact.upc,
      payload_sha256: result.artifact.payload_sha256,
      certification_sha256: result.artifact.certification_sha256,
      artifact: artifactPath,
      artifact_disposition: artifactDisposition,
      receipt: receiptPath,
      receipt_disposition: receiptDisposition,
      ...operatorNext([
        "dry-run",
        "--certification", artifactPath,
        "--certification-receipt", receiptPath,
      ]),
    }, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

async function requireApprovalInputs(args: ParsedArgs) {
  if (!args.certificationPath) {
    throw new Error("command requires --certification <certification.json>");
  }
  if (!args.certificationReceiptPath) {
    throw new Error(
      "command requires --certification-receipt <certification-receipt.json>",
    );
  }
  if (!args.dryRunReceiptPath) {
    throw new Error("command requires --dry-run-receipt <dry-run-receipt.json>");
  }
  const now = new Date();
  const certification = await readCertification(args.certificationPath);
  const certificationReceipt = await readCertificationReceipt(
    args.certificationReceiptPath,
    certification,
  );
  const dryRunReceipt = await readDryRunReceipt(
    args.dryRunReceiptPath,
    certification,
    now,
  );
  return { certification, certificationReceipt, dryRunReceipt, now };
}

async function runApprove(args: ParsedArgs): Promise<void> {
  const inputs = await requireApprovalInputs(args);
  if (args.mode === "preview") {
    const {
      assertCertifiedWalmartProductTruthStillCurrent,
      replayCertifiedWalmartNewSkuLocally,
    } = await import(
      "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
    );
    const db = createClient(databaseConfig());
    try {
      await assertCertifiedWalmartProductTruthStillCurrent({
        db,
        certification: inputs.certification,
        now: inputs.now,
      });
    } finally {
      await db.close();
    }
    const current = await replayCertifiedWalmartNewSkuLocally({
      certification: inputs.certification,
    });
    if (current.payload_sha256 !== inputs.certification.payload_sha256) {
      throw new Error("Current payload differs from certification");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "approve",
      mode: "preview",
      internal_database_mutated: false,
      marketplace_mutated: false,
      payload_sha256: current.payload_sha256,
      required_confirmation: inputs.dryRunReceipt.receipt_sha256,
      ...operatorNext([
        "approve",
        "--certification", resolve(args.certificationPath!),
        "--certification-receipt", resolve(args.certificationReceiptPath!),
        "--dry-run-receipt", resolve(args.dryRunReceiptPath!),
        "--mode", "apply-internal",
        "--actor", "<owner>",
        "--confirm", inputs.dryRunReceipt.receipt_sha256,
      ]),
    }, null, 2)}\n`);
    return;
  }
  if (!args.actor) throw new Error("approval requires --actor");
  if (args.confirm !== inputs.dryRunReceipt.receipt_sha256) {
    throw new Error("approval requires --confirm equal to dry_run receipt SHA-256");
  }
  const { approveCertifiedWalmartNewSku } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const db = createClient(databaseConfig());
  let artifact: Awaited<ReturnType<typeof approveCertifiedWalmartNewSku>>;
  try {
    artifact = await approveCertifiedWalmartNewSku({
      productTruthDb: db,
      certification: inputs.certification,
      certificationReceipt: inputs.certificationReceipt,
      dryRunReceipt: inputs.dryRunReceipt,
      actor: args.actor,
      note: args.note ?? undefined,
      now: inputs.now,
    });
  } finally {
    await db.close();
  }
  const outputPath = args.out
    ? resolve(args.out)
    : resolve(
        dirname(resolve(args.certificationPath!)),
        `approval-${artifact.candidate_key}-${artifact.approval_sha256.slice(0, 12)}.json`,
      );
  const disposition = await writeOnce(
    outputPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "approve",
    mode: "apply-internal",
    internal_database_mutated: true,
    marketplace_mutated: false,
    approval_sha256: artifact.approval_sha256,
    payload_sha256: artifact.payload_sha256,
    output: outputPath,
    disposition,
    ...operatorNext([
      "apply",
      "--certification", resolve(args.certificationPath!),
      "--certification-receipt", resolve(args.certificationReceiptPath!),
      "--dry-run-receipt", resolve(args.dryRunReceiptPath!),
      "--approval", outputPath,
      "--mode", "preview",
    ]),
  }, null, 2)}\n`);
}

async function runApply(args: ParsedArgs): Promise<void> {
  const inputs = await requireApprovalInputs(args);
  if (!args.approvalPath) {
    throw new Error("apply requires --approval <approval.json>");
  }
  const approval = await readApproval(
    args.approvalPath,
    inputs.certification,
    inputs.certificationReceipt,
    inputs.dryRunReceipt,
    inputs.now,
  );
  const live = args.mode === "live";
  const engineReleaseSha256 = await walmartNewSkuEngineReleaseSha256();
  if (live && !args.actor) throw new Error("live apply requires --actor");
  const { applyCertifiedWalmartNewSku } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  let doctorReceipt;
  let applyPreviewReceipt;
  let ownerPermit;
  if (live) {
    if (!args.doctorReceiptPath) {
      throw new Error("live apply requires --doctor-receipt <fresh-doctor.json>");
    }
    if (!args.applyPreviewReceiptPath) {
      throw new Error("live apply requires --apply-preview-receipt <preview.json>");
    }
    if (!args.ownerPermitPath) {
      throw new Error("live apply requires --owner-permit <external-owner-permit.json>");
    }
    doctorReceipt = await readDoctorReceipt(
      args.doctorReceiptPath,
      inputs.certification,
      inputs.now,
    );
    applyPreviewReceipt = await readApplyPreviewReceipt(
      args.applyPreviewReceiptPath,
      approval,
    );
    ownerPermit = await readOwnerPermit(
      args.ownerPermitPath,
      inputs.certification,
      approval,
      doctorReceipt,
      applyPreviewReceipt,
      engineReleaseSha256,
      inputs.now,
    );
    if (args.confirm !== ownerPermit.permit_sha256) {
      throw new Error("live apply requires --confirm equal to owner_permit_sha256");
    }
  }
  if (live) liveApplyAttempted = true;
  const resolvedDatabase = databaseConfig();
  const { resolveDatabaseTarget } = await import(
    "./product-truth-migration-plan"
  );
  const currentTarget = resolveDatabaseTarget(resolvedDatabase.url);
  const db = createClient(resolvedDatabase);
  let result: Awaited<ReturnType<typeof applyCertifiedWalmartNewSku>>;
  try {
    if (
      doctorReceipt &&
      (doctorReceipt.database_target_fingerprint_sha256 !== currentTarget.fingerprint ||
        doctorReceipt.database_schema_sha256 !== await databaseSchemaSha256(db))
    ) {
      throw new Error("Doctor receipt database target or schema has drifted");
    }
    result = await applyCertifiedWalmartNewSku({
      productTruthDb: db,
      certification: inputs.certification,
      certificationReceipt: inputs.certificationReceipt,
      dryRunReceipt: inputs.dryRunReceipt,
      approval,
      actor: args.actor ?? "walmart-new-sku-preview",
      live,
      doctorReceipt,
      applyPreviewReceipt,
      ownerPermit,
      currentDatabaseTargetFingerprint: currentTarget.fingerprint,
      engineReleaseSha256,
      now: inputs.now,
    });
  } finally {
    await db.close();
  }
  const {
    buildWalmartNewSkuOwnerPermitTemplate,
    sealWalmartNewSkuApplyReceipt,
  } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const receipt = sealWalmartNewSkuApplyReceipt({
    schema_version: "walmart-new-sku-apply-receipt/1.0.0",
    approval_sha256: approval.approval_sha256,
    certification_sha256: inputs.certification.certification_sha256,
    channel_sku_id: inputs.certification.channel_sku_id,
    sku: inputs.certification.sku,
    requested_at: inputs.now.toISOString(),
    mode: live ? "LIVE" : "PREVIEW",
    marketplace_mutation_requested: live,
    result: result.distribution,
    latest_submission_attempt: result.latest_submission_attempt,
  }, approval);
  const outputPath = args.out
    ? resolve(args.out)
    : resolve(
        dirname(resolve(args.approvalPath)),
        `apply-${live ? "live" : "preview"}-${receipt.receipt_sha256.slice(0, 12)}.json`,
      );
  const disposition = await writeOnce(
    outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  let ownerPermitTemplate: string | null = null;
  if (!live) {
    ownerPermitTemplate = resolve(
      dirname(outputPath),
      `owner-permit-template-${inputs.certification.candidate_key}-${receipt.receipt_sha256.slice(0, 12)}.json`,
    );
    await writeOnce(
      ownerPermitTemplate,
      `${JSON.stringify(buildWalmartNewSkuOwnerPermitTemplate({
        certification: inputs.certification,
        approval,
        applyPreview: receipt,
        engineReleaseSha256,
        now: inputs.now,
      }), null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({
    ok: result.distribution.ok,
    command: "apply",
    mode: args.mode,
    marketplace_mutation_requested: live,
    distribution: result.distribution,
    latest_submission_attempt: result.latest_submission_attempt,
    receipt_sha256: receipt.receipt_sha256,
    output: outputPath,
    disposition,
    owner_permit_template: ownerPermitTemplate,
    owner_gate_required: !live,
    required_confirmation: live ? null : "EXTERNAL_OWNER_PERMIT_SHA256",
    ...operatorNext(live ? [
      "verify",
      "--certification", resolve(args.certificationPath!),
    ] : null),
  }, null, 2)}\n`);
}

async function readCanonicalBuyerEvidenceJsonFile(
  path: string,
  label: string,
): Promise<Uint8Array> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} path must be a normalized absolute path`);
  }
  const { hashWalmartNewSkuEvidenceArtifact } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-evidence-sealer"
  );
  const read = await hashWalmartNewSkuEvidenceArtifact({ path });
  return read.bytes;
}

function parseCanonicalBuyerEvidenceJson(
  bytes: Uint8Array,
  label: string,
): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON bytes`);
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
    throw new Error(
      `${label} must use exact canonical JSON bytes (2-space indent, one trailing newline, no duplicate keys)`,
    );
  }
  return parsed;
}

async function runVerifyEvidenceSeal(args: ParsedArgs): Promise<void> {
  if (!args.certificationPath) {
    throw new Error(
      "verify seal-evidence requires --certification <certification.json>",
    );
  }
  if (!args.buyerEvidencePath) {
    throw new Error(
      "verify seal-evidence requires --buyer-evidence <generated-template.json>",
    );
  }
  if (!args.verifyReceiptPath) {
    throw new Error(
      "verify seal-evidence requires --verify-receipt <immutable-verify-receipt.json>",
    );
  }
  if (!args.out) {
    throw new Error("verify seal-evidence requires --out <new-sealed-evidence.json>");
  }
  const certificationPath = args.certificationPath;
  const inputPath = args.buyerEvidencePath;
  const verifyReceiptPath = args.verifyReceiptPath;
  const outputPath = args.out;
  if (
    ![certificationPath, verifyReceiptPath, inputPath, outputPath].every(
      (value) => isAbsolute(value) && resolve(value) === value,
    )
  ) {
    throw new Error(
      "verify seal-evidence paths must be normalized absolute paths",
    );
  }
  if (
    outputPath === inputPath ||
    outputPath === certificationPath ||
    outputPath === verifyReceiptPath
  ) {
    throw new Error(
      "verify seal-evidence output must be a distinct new artifact path",
    );
  }
  const existingOutput = await lstat(outputPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existingOutput) {
    const inputStats = await lstat(inputPath).catch(() => null);
    if (
      inputStats &&
      existingOutput.dev === inputStats.dev &&
      existingOutput.ino === inputStats.ino
    ) {
      throw new Error(
        "verify seal-evidence output aliases the buyer evidence template",
      );
    }
    throw new Error("verify seal-evidence output must not already exist");
  }
  const canonicalOutputParent = await realpath(dirname(outputPath)).catch(() => null);
  if (!canonicalOutputParent) {
    throw new Error(
      "verify seal-evidence output parent must be an existing directory",
    );
  }

  const [certificationBytes, verifyReceiptBytes, draftBytes] = await Promise.all([
    readCanonicalBuyerEvidenceJsonFile(
      certificationPath,
      "Buyer evidence certification",
    ),
    readCanonicalBuyerEvidenceJsonFile(
      verifyReceiptPath,
      "Buyer evidence verify receipt",
    ),
    readCanonicalBuyerEvidenceJsonFile(inputPath, "Buyer evidence template"),
  ]);
  const certification = parseCanonicalBuyerEvidenceJson(
    certificationBytes,
    "Buyer evidence certification",
  );
  const verifyReceipt = parseCanonicalBuyerEvidenceJson(
    verifyReceiptBytes,
    "Buyer evidence verify receipt",
  );
  const draft = parseCanonicalBuyerEvidenceJson(
    draftBytes,
    "Buyer evidence template",
  );
  const {
    assertWalmartNewSkuCertificationArtifactIntegrity,
    assertWalmartNewSkuVerifyReceiptIntegrity,
  } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  assertWalmartNewSkuCertificationArtifactIntegrity(certification as never);
  assertWalmartNewSkuVerifyReceiptIntegrity(
    verifyReceipt as never,
    certification as never,
  );
  const { sealWalmartBuyerEvidenceTemplate } = await import(
    "../src/lib/bundle-factory/distribution/walmart-buyer-publication-evidence"
  );
  const sealed = await sealWalmartBuyerEvidenceTemplate({
    draft,
    certification: certification as never,
    verifyReceipt: verifyReceipt as never,
  });
  const artifactStats = await lstat(sealed.artifact.path);
  for (const [label, protectedPath] of [
    ["certification", certificationPath],
    ["verify receipt", verifyReceiptPath],
    ["buyer evidence template", inputPath],
  ] as const) {
    const protectedStats = await lstat(protectedPath);
    if (
      sealed.artifact.path === protectedPath ||
      (artifactStats.dev === protectedStats.dev &&
        artifactStats.ino === protectedStats.ino)
    ) {
      throw new Error(
        `Buyer screenshot artifact must not alias the ${label} JSON artifact`,
      );
    }
  }
  const disposition = await writeOnce(
    outputPath,
    `${JSON.stringify(sealed.sealed, null, 2)}\n`,
    canonicalOutputParent,
  );
  if (disposition !== "created") {
    throw new Error("verify seal-evidence output must be a new immutable artifact");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "verify",
    mode: "seal-evidence",
    input: inputPath,
    output: outputPath,
    disposition,
    certification_sha256:
      (certification as { certification_sha256: string }).certification_sha256,
    channel_sku_id:
      (certification as { channel_sku_id: string }).channel_sku_id,
    sku: (certification as { sku: string }).sku,
    artifact_path: sealed.artifact.path,
    artifact_sha256: sealed.artifact.sha256,
    changed_fields: ["rawEvidence.artifact.sha256"],
    database_reads_performed: 0,
    database_mutated: false,
    walmart_reads_performed: 0,
    provider_calls_performed: 0,
    marketplace_mutated: false,
    ...operatorNext([
      "verify",
      "--certification", certificationPath,
      "--verify-receipt", verifyReceiptPath,
      "--buyer-evidence", outputPath,
      "--mode", "status",
    ]),
  }, null, 2)}\n`);
}

async function runVerify(args: ParsedArgs): Promise<void> {
  if (args.mode === "seal-evidence") {
    return runVerifyEvidenceSeal(args);
  }
  if (!args.certificationPath) {
    throw new Error("verify requires --certification <certification.json>");
  }
  const certification = await readCertification(args.certificationPath);
  let buyerEvidence;
  if (args.buyerEvidencePath) {
    if (!args.verifyReceiptPath) {
      throw new Error(
        "verify status with buyer evidence requires --verify-receipt <immutable-verify-receipt.json>",
      );
    }
    const [evidenceBytes, verifyReceiptBytes, certificationBytes] = await Promise.all([
      readCanonicalBuyerEvidenceJsonFile(
        args.buyerEvidencePath,
        "Sealed buyer evidence",
      ),
      readCanonicalBuyerEvidenceJsonFile(
        args.verifyReceiptPath,
        "Buyer evidence verify receipt",
      ),
      readCanonicalBuyerEvidenceJsonFile(
        resolve(args.certificationPath),
        "Buyer evidence certification",
      ),
    ]);
    const parsed = parseCanonicalBuyerEvidenceJson(
      evidenceBytes,
      "Sealed buyer evidence",
    );
    const verifyReceipt = parseCanonicalBuyerEvidenceJson(
      verifyReceiptBytes,
      "Buyer evidence verify receipt",
    );
    const canonicalCertification = parseCanonicalBuyerEvidenceJson(
      certificationBytes,
      "Buyer evidence certification",
    );
    if (JSON.stringify(canonicalCertification) !== JSON.stringify(certification)) {
      throw new Error("Buyer evidence certification changed during verification");
    }
    const {
      assertWalmartNewSkuCertificationArtifactIntegrity,
      assertWalmartNewSkuVerifyReceiptIntegrity,
    } = await import(
      "../src/lib/bundle-factory/walmart-new-sku-engine"
    );
    assertWalmartNewSkuCertificationArtifactIntegrity(
      canonicalCertification as never,
    );
    assertWalmartNewSkuVerifyReceiptIntegrity(
      verifyReceipt as never,
      canonicalCertification as never,
    );
    const { assertWalmartBuyerEvidenceSealedBinding } = await import(
      "../src/lib/bundle-factory/distribution/walmart-buyer-publication-evidence"
    );
    buyerEvidence = assertWalmartBuyerEvidenceSealedBinding({
      evidence: parsed,
      certification: canonicalCertification as never,
      verifyReceipt: verifyReceipt as never,
    });
  } else if (args.verifyReceiptPath) {
    throw new Error("verify --verify-receipt requires --buyer-evidence");
  }
  const { verifyCertifiedWalmartNewSku } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine-runtime"
  );
  const result = await verifyCertifiedWalmartNewSku({
    certification,
    buyerEvidence,
  });
  const verifiedAt = new Date();
  const {
    WALMART_NEW_SKU_VERIFY_RECEIPT_SCHEMA,
    sealWalmartNewSkuVerifyReceipt,
  } = await import(
    "../src/lib/bundle-factory/walmart-new-sku-engine"
  );
  const receipt = sealWalmartNewSkuVerifyReceipt({
    schema_version: WALMART_NEW_SKU_VERIFY_RECEIPT_SCHEMA,
    certification_sha256: certification.certification_sha256,
    channel_sku_id: certification.channel_sku_id,
    sku: certification.sku,
    payload_sha256: certification.payload_sha256,
    submission_attempt_binding: result.submission_attempt_binding
      ? {
          attempt_id: result.submission_attempt_binding.attemptId,
          channel_sku_id: result.submission_attempt_binding.channelSkuId,
          certification_sha256:
            result.submission_attempt_binding.certificationSha256,
          payload_sha256: result.submission_attempt_binding.payloadSha256,
          seller_account_fingerprint_sha256:
            result.submission_attempt_binding.sellerAccountFingerprintSha256,
          idempotency_key: result.submission_attempt_binding.idempotencyKey,
        }
      : null,
    verified_at: verifiedAt.toISOString(),
    marketplace_mutated: false,
    local_lifecycle_reconciled: result.poll_result != null,
    buyer_evidence_recorded: result.buyer_evidence_recorded,
    poll_result: result.poll_result,
    buyer_evidence_status: result.buyer_evidence_status,
  }, certification);
  const outputPath = args.out
    ? resolve(args.out)
    : resolve(
        dirname(resolve(args.certificationPath)),
        `verify-${receipt.receipt_sha256.slice(0, 12)}.json`,
      );
  const disposition = await writeOnce(
    outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  let buyerEvidenceTemplate: string | null = null;
  const attemptId = result.buyer_evidence_status.attempt_id;
  const itemId =
    result.poll_result?.walmart_item_id ??
    result.buyer_evidence_status.walmart_item_id;
  const {
    buildPendingWalmartBuyerPublicationEvidenceTemplate,
    shouldCreatePendingWalmartBuyerEvidenceTemplate,
  } = await import(
      "../src/lib/bundle-factory/distribution/walmart-buyer-publication-evidence"
  );
  if (shouldCreatePendingWalmartBuyerEvidenceTemplate({
    buyerVerified: result.buyer_evidence_status.buyer_verified,
    buyerEvidenceRecorded: result.buyer_evidence_recorded,
    submissionAttemptId: attemptId,
    walmartItemId: itemId,
  })) {
    const template = buildPendingWalmartBuyerPublicationEvidenceTemplate({
      certificationSha256: certification.certification_sha256,
      verifyReceiptSha256: receipt.receipt_sha256,
      channelSkuId: certification.channel_sku_id,
      submissionAttemptId: attemptId!,
      sku: certification.sku,
      walmartItemId: itemId!,
    });
    buyerEvidenceTemplate = resolve(
      dirname(outputPath),
      `buyer-evidence-${certification.candidate_key}-${attemptId}-${receipt.receipt_sha256.slice(0, 12)}.json`,
    );
    await writeOnce(
      buyerEvidenceTemplate,
      `${JSON.stringify(template, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({
    ok: result.listing_status === "LIVE",
    command: "verify",
    marketplace_mutated: false,
    listing_status: result.listing_status,
    lifecycle_status: result.lifecycle_status,
    poll_result: result.poll_result,
    buyer_evidence_status: result.buyer_evidence_status,
    buyer_evidence_template: buyerEvidenceTemplate,
    receipt_sha256: receipt.receipt_sha256,
    output: outputPath,
    disposition,
    ...operatorNext(buyerEvidenceTemplate ? [
      "verify",
      "--certification", resolve(args.certificationPath),
      "--verify-receipt", outputPath,
      "--buyer-evidence", buyerEvidenceTemplate,
      "--mode", "seal-evidence",
      "--out", resolve(
        dirname(buyerEvidenceTemplate),
        `buyer-evidence-sealed-${certification.candidate_key}-${attemptId}-${receipt.receipt_sha256.slice(0, 12)}.json`,
      ),
    ] : null),
  }, null, 2)}\n`);
}

function printHelp(surface: WalmartNewSkuCliSurface): void {
  process.stdout.write(`Walmart new-SKU engine\n\n`);
  process.stdout.write(`Commands:\n`);
  if (surface === "owner") {
    process.stdout.write(`  owner-permit-request   Owner/Codex-only: emit exact bytes for an external Ed25519 signer\n\n`);
    process.stdout.write(`  owner-permit-assemble  Owner/Codex-only: verify a raw detached signature and seal the permit\n\n`);
    process.stdout.write(`This surface cannot run operator commands or mutate Walmart.\n`);
    return;
  }
  process.stdout.write(`  doctor  Read-only readiness check; independently verifies the frozen release and pinned all-status ITEM v6 source+SHA against the active seller catalog mirror; --out seals them for 30 minutes\n`);
  process.stdout.write(`  plan    Requires that fresh doctor receipt; builds a hash-sealed Product Truth pilot plan (read-only)\n\n`);
  process.stdout.write(`  stage   Preview or explicitly reserve one pool UPC in the internal DB\n\n`);
  process.stdout.write(`  rotate-upc  Re-read SPEC catalog proof; RETIRE exact MP_ITEM_MATCH UPC and reserve the next pool UPC\n\n`);
  process.stdout.write(`  certify Build template, validate evidence, then run read-only Walmart checks + internal gates\n\n`);
  process.stdout.write(`  dry-run Replay all validators and live Get Spec without a feed POST\n\n`);
  process.stdout.write(`  approve Record/reconfirm a payload-bound internal owner approval\n\n`);
  process.stdout.write(`  apply   Preview stops for an external Ed25519 owner permit; live is the only Walmart mutation path\n\n`);
  process.stdout.write(`  verify  Poll seller state; pending buyer evidence must pass engine-only --mode seal-evidence before status records it\n\n`);
  process.stdout.write(`Pilot defaults: --store-index 1 --limit 1 --pack-count 2 --zip 33765 --max-price-age-hours 24\n`);
  process.stdout.write(`Every command is non-mutating to Walmart except apply --mode live.\n`);
  process.stdout.write(`Hash-only/self-asserted owner permits are never accepted.\n`);
  process.stdout.write(`Claude/operator contract: execute only the engine-emitted exact next command; stop when next_argv is null.\n`);
  process.stdout.write(`Claude/operator must not edit code/policy/tests/schema/migrations, run SQL/curl/direct APIs, invoke owner-only schema/catalog/permit/freeze surfaces, retry ambiguous submissions, schedule/cron, or expand beyond one owner-permitted SKU and the two-SKU release cap.\n`);
}

async function dispatchWalmartNewSkuCommand(
  args: ParsedArgs,
  surface: WalmartNewSkuCliSurface,
): Promise<void> {
  if (args.command === "help") return printHelp(surface);
  if (args.command === "doctor") return runDoctor(args);
  if (args.command === "plan") return runPlan(args);
  if (args.command === "stage") return runStage(args);
  if (args.command === "rotate-upc") return runRotateUpc(args);
  if (args.command === "certify") return runCertify(args);
  if (args.command === "dry-run") return runDryRun(args);
  if (args.command === "approve") return runApprove(args);
  if (args.command === "apply") return runApply(args);
  if (args.command === "owner-permit-request") return runOwnerPermitRequest(args);
  if (args.command === "owner-permit-assemble") return runOwnerPermitAssemble(args);
  return runVerify(args);
}

export async function runWalmartNewSkuEngineProcess(
  surface: WalmartNewSkuCliSurface = "operator",
  argv = process.argv.slice(2),
): Promise<void> {
  try {
    const args = parseArgs(argv, surface);
    await dispatchWalmartNewSkuCommand(args, surface);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      marketplace_mutated: liveApplyAttempted ? "UNKNOWN_CHECK_LIFECYCLE" : false,
      recovery_action: liveApplyAttempted
        ? "Do not retry apply; run verify and inspect the durable submission attempt."
        : null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("walmart-new-sku-engine.ts")) {
  void runWalmartNewSkuEngineProcess("operator");
}
