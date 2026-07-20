#!/usr/bin/env -S node --experimental-strip-types

/**
 * Strict offline freezer for Walmart listing-integrity execution bundles.
 *
 * The freezer consumes only already-captured, SHA-bound local bytes. It never
 * captures marketplace data and has no network, model, database, R2, or
 * Walmart client. It derives every generated artifact deterministically,
 * invokes the real source-aware adjudicator `plan`, and writes READY only after
 * that plan succeeds. Claude Code therefore executes a frozen bundle; it does
 * not author run-lock JSON or change the engine.
 */

import { randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  BLIND_PROMPT_VERSION,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../src/lib/walmart/catalog-visual-preprocess.ts";
import { fingerprintGalleryImage } from "../src/lib/walmart/catalog-gallery-audit.ts";
import {
  verifyWalmartCatalogTruthAuditExportAgainstSources,
} from "../src/lib/walmart/catalog-truth-export.ts";
import {
  resolveExactBuyerPdp,
} from "../src/lib/walmart/buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "../src/lib/walmart/exact-item-resolution.ts";
import {
  WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
  WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
  projectWalmartListingSurfaceFromBuyerPdp,
  sealWalmartListingSurfaceSnapshot,
  walmartListingIntegritySha256,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  parseWalmartListingWorkerReservationLedgerContract,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
} from "../src/lib/walmart/listing-integrity-observation.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../src/lib/walmart/local-visual-ocr.ts";
import {
  WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
  WALMART_LISTING_INTEGRITY_EXECUTION_PERMIT_SCHEMA,
  WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
  WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
  WALMART_LISTING_INTEGRITY_PLAN_SCHEMA,
  WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
  assembleWalmartListingIntegrityOwnerExecutionAuthorization,
  assertWalmartListingIntegrityOwnerAuthorizationIssuanceWindow,
  buildWalmartListingIntegrityAllowanceReservation,
  buildCurrentCodeBundleManifest,
  buildWalmartListingIntegrityExecutionPermitBody,
  buildWalmartListingIntegrityOwnerExecutionAuthorizationBody,
  buildWalmartListingIntegritySourceFreshness,
  parseWalmartListingIntegrityOwnerExecutionAuthority,
  parseWalmartListingIntegrityOwnerExecutionAuthorization,
  parseWalmartListingIntegrityAllowanceReservation,
  parseRunLock,
  parseWalmartListingIntegrityExecutionPermit,
  parseWalmartListingIntegrityPreflightCertificate,
  runPlan,
  sha256Bytes,
  verifyCurrentCodeBundleManifest,
  walmartListingIntegrityAllowanceReservationRelativePath,
  walmartListingIntegrityObserverPartitionId,
  walmartListingIntegrityOwnerAuthorizationSigningMessage,
} from "./walmart-listing-integrity-engine.mjs";
import { buildWorkerRequestBody } from "./walmart-listing-integrity-observer.mjs";

export const WALMART_LISTING_INTEGRITY_FREEZE_SPEC_SCHEMA =
  "walmart-listing-integrity-freeze-spec/v3";
export const WALMART_LISTING_INTEGRITY_FREEZER_VERSION =
  "walmart-listing-integrity-offline-freezer/v3";
export const WALMART_LISTING_INTEGRITY_FROZEN_MANIFEST_SCHEMA =
  "walmart-listing-integrity-frozen-manifest/v3";
export const WALMART_LISTING_INTEGRITY_READY_SCHEMA =
  "walmart-listing-integrity-ready/v3";
export const WALMART_LISTING_INTEGRITY_AUTHORIZATION_REQUEST_SCHEMA =
  "walmart-listing-integrity-owner-authorization-signing-request/v1";

const MAX_SPEC_BYTES = 16 * 1024 * 1024;
const MAX_RUN_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64;
const MAX_LISTINGS = 10_000;
const MAX_ASSETS_PER_LISTING = 100;
const MAX_SHARDS = 100_000;
const WORKER_MAX_IMAGES_PER_CALL = 6;
const CERTIFIED_IMAGES_PER_SHARD = 4;
const MAX_SHARDS_PER_PARTITION = 6;
const LOCKED_VISION_TIMEOUT_MS = 180_000;
const LOCKED_OBSERVER_RESPONSE_MARGIN_MS = 30_000;
const MUTABLE_EXECUTION_DIRECTORIES = new Set(["observations", "permits"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const execFile = promisify(execFileCallback);
const PINNED_SYSTEM_CHILD_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
});

const ATOMIC_PUBLISH_C = String.raw`
extern int renamex_np(const char *, const char *, unsigned int);
extern int *__error(void);

int main(int argc, char **argv) {
  if (argc != 3) return 64;
  if (renamex_np(argv[1], argv[2], 0x00000004u) == 0) return 0;
  return *__error() == 17 ? 73 : 74;
}
`;

const CAPTURE_KEYS = Object.freeze([
  "create_request_manifest",
  "create_response_payload",
  "ready_status_request_manifest",
  "ready_status_payload",
  "download_locator_request_manifest",
  "download_locator_response_payload",
  "report_file_request_manifest",
  "downloaded_body",
  "http_create_response",
  "http_ready_status_response",
  "http_download_locator_response",
  "http_download_response",
  "trusted_context",
]);

const COMMON_SOURCE_KEYS = Object.freeze([
  "authoritative_published_scope",
  "authoritative_item_report_source",
  "product_truth_snapshot",
  "buyer_snapshot_index",
  "catalog_truth_export",
]);

const HELP = `Usage:
  node --experimental-strip-types scripts/freeze-walmart-listing-integrity-bundle.mjs freeze \\
    --spec=/absolute/path/freeze-spec.json \\
    --output-dir=/absolute/new/bundle-directory

  node --experimental-strip-types scripts/freeze-walmart-listing-integrity-bundle.mjs permit \\
    --bundle-dir=/absolute/path/frozen-family \\
    --partition-id=partition-id-from-READY-family \\
    --owner-authorization=/absolute/path/external-owner-authorization.json

  node --experimental-strip-types scripts/freeze-walmart-listing-integrity-bundle.mjs authorization-request \\
    --bundle-dir=/absolute/path/frozen-family \\
    --approval-id=owner-approval-id \\
    --partition-ids=partition-000000-...,partition-000001-... \\
    --issued-at=canonical-UTC-ISO \\
    --expires-at=canonical-UTC-ISO \\
    --source-freshness-deadline=canonical-UTC-ISO \\
    --output=/absolute/new/signing-request.json

  node --experimental-strip-types scripts/freeze-walmart-listing-integrity-bundle.mjs authorization-assemble \\
    --bundle-dir=/absolute/path/frozen-family \\
    --request=/absolute/path/signing-request.json \\
    --signature=/absolute/path/raw-64-byte-ed25519-signature \\
    --output=/absolute/new/owner-authorization.json

All commands are offline. Freeze accepts only SHA-bound local captures, creates
a new exclusive immutable family bundle, runs the real source-aware plan, and
emits READY only on success. Authorization-request emits exact bytes for an
external owner signer; authorization-assemble verifies the detached signature
against the READY-pinned Ed25519 key. Permit atomically consumes one signed
partition allowance exactly once; it never self-authorizes or renews a grant.
No command captures data or invokes a model/network/database/marketplace.
`;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length
    || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${label} keys must be exactly ${expected.join(",")}`);
  }
}

function safeText(value, label, maximum = 10_000) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function safeId(value, label) {
  const parsed = safeText(value, label, 128);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} has an invalid identifier format`);
  return parsed;
}

function digest(value, label) {
  const parsed = safeText(value, label, 64);
  if (!SHA256_PATTERN.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`);
  return parsed;
}

function canonicalTimestamp(value, label) {
  const parsed = safeText(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function absoluteNormalizedPath(value, label) {
  const parsed = safeText(value, label, 16_384);
  if (!path.isAbsolute(parsed) || path.resolve(parsed) !== parsed) {
    throw new Error(`${label} must be an absolute normalized path without traversal segments`);
  }
  return parsed;
}

function parseAbsoluteFileRef(value, label) {
  exactKeys(value, ["path", "sha256"], label);
  return {
    path: absoluteNormalizedPath(value.path, `${label}.path`),
    sha256: digest(value.sha256, `${label}.sha256`),
  };
}

function parseObserverWorker(value) {
  const label = "freeze_spec.observer_worker";
  exactKeys(value, [
    "analyze_url", "build_sha256", "receipt_key_id", "receipt_public_key_sha256",
    "cli_version", "node_version", "platform", "arch", "vision_timeout_ms",
    "reservation_ledger",
  ], label);
  if (value.vision_timeout_ms !== LOCKED_VISION_TIMEOUT_MS) {
    throw new Error(`${label}.vision_timeout_ms must equal ${LOCKED_VISION_TIMEOUT_MS}`);
  }
  return {
    analyze_url: safeText(value.analyze_url, `${label}.analyze_url`, 2_048),
    build_sha256: digest(value.build_sha256, `${label}.build_sha256`),
    receipt_key_id: safeId(value.receipt_key_id, `${label}.receipt_key_id`),
    receipt_public_key_sha256: digest(
      value.receipt_public_key_sha256,
      `${label}.receipt_public_key_sha256`,
    ),
    cli_version: safeText(value.cli_version, `${label}.cli_version`, 256),
    node_version: safeText(value.node_version, `${label}.node_version`, 128),
    platform: safeText(value.platform, `${label}.platform`, 64),
    arch: safeText(value.arch, `${label}.arch`, 64),
    vision_timeout_ms: LOCKED_VISION_TIMEOUT_MS,
    reservation_ledger: parseWalmartListingWorkerReservationLedgerContract(
      value.reservation_ledger,
      `${label}.reservation_ledger`,
    ),
  };
}

function parseListingAsset(value, label) {
  exactKeys(value, ["slot", "file"], label);
  const slot = safeText(value.slot, `${label}.slot`, 64);
  if (slot !== "main" && !/^gallery-[1-9]\d*$/u.test(slot)) {
    throw new Error(`${label}.slot must be main or gallery-N`);
  }
  return { slot, file: parseAbsoluteFileRef(value.file, `${label}.file`) };
}

function parseListing(value, index) {
  const label = `freeze_spec.listings[${index}]`;
  exactKeys(value, [
    "listing_key", "item_id", "buyer_snapshot_manifest", "seller_item_payload",
    "catalog_search_payload", "buyer_pdp_payload", "buyer_assets",
  ], label);
  const listingKey = safeText(value.listing_key, `${label}.listing_key`, 1_000);
  if (!/^walmart:[1-9]\d*:.+$/u.test(listingKey)) {
    throw new Error(`${label}.listing_key must preserve exact walmart:storeIndex:rawSku scope`);
  }
  const itemId = safeText(value.item_id, `${label}.item_id`, 64);
  if (!/^\d+$/u.test(itemId)) throw new Error(`${label}.item_id must contain digits only`);
  if (!Array.isArray(value.buyer_assets) || value.buyer_assets.length < 1
    || value.buyer_assets.length > MAX_ASSETS_PER_LISTING) {
    throw new Error(`${label}.buyer_assets must contain 1..${MAX_ASSETS_PER_LISTING} rows`);
  }
  const buyerAssets = value.buyer_assets.map((asset, assetIndex) => (
    parseListingAsset(asset, `${label}.buyer_assets[${assetIndex}]`)
  ));
  buyerAssets.forEach((asset, assetIndex) => {
    const expected = assetIndex === 0 ? "main" : `gallery-${assetIndex}`;
    if (asset.slot !== expected) {
      throw new Error(`${label}.buyer_assets must be ordered main then contiguous gallery slots`);
    }
  });
  return {
    listing_key: listingKey,
    item_id: itemId,
    buyer_snapshot_manifest: parseAbsoluteFileRef(
      value.buyer_snapshot_manifest,
      `${label}.buyer_snapshot_manifest`,
    ),
    seller_item_payload: parseAbsoluteFileRef(
      value.seller_item_payload,
      `${label}.seller_item_payload`,
    ),
    catalog_search_payload: parseAbsoluteFileRef(
      value.catalog_search_payload,
      `${label}.catalog_search_payload`,
    ),
    buyer_pdp_payload: parseAbsoluteFileRef(
      value.buyer_pdp_payload,
      `${label}.buyer_pdp_payload`,
    ),
    buyer_assets: buyerAssets,
  };
}

/** Strictly parse a freeze specification. Unknown keys are rejected. */
export function parseWalmartListingIntegrityFreezeSpec(raw) {
  exactKeys(raw, [
    "schema_version", "run_id", "created_at", "observer_worker", "owner_execution_authority",
    "source_artifacts", "listings",
  ], "freeze_spec");
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_FREEZE_SPEC_SCHEMA) {
    throw new Error("freeze_spec.schema_version is unsupported");
  }
  exactKeys(raw.source_artifacts, [
    ...COMMON_SOURCE_KEYS,
    "authoritative_item_report_capture",
  ], "freeze_spec.source_artifacts");
  exactKeys(
    raw.source_artifacts.authoritative_item_report_capture,
    CAPTURE_KEYS,
    "freeze_spec.source_artifacts.authoritative_item_report_capture",
  );
  if (!Array.isArray(raw.listings) || raw.listings.length < 1
    || raw.listings.length > MAX_LISTINGS) {
    throw new Error(`freeze_spec.listings must contain 1..${MAX_LISTINGS} rows`);
  }
  const listings = raw.listings.map(parseListing).sort((left, right) => (
    left.listing_key < right.listing_key ? -1 : left.listing_key > right.listing_key ? 1 : 0
  ));
  if (new Set(listings.map((row) => row.listing_key)).size !== listings.length) {
    throw new Error("freeze_spec.listings contains duplicate listing_key values");
  }
  return {
    schema_version: WALMART_LISTING_INTEGRITY_FREEZE_SPEC_SCHEMA,
    run_id: safeId(raw.run_id, "freeze_spec.run_id"),
    created_at: canonicalTimestamp(raw.created_at, "freeze_spec.created_at"),
    observer_worker: parseObserverWorker(raw.observer_worker),
    owner_execution_authority: parseWalmartListingIntegrityOwnerExecutionAuthority(
      raw.owner_execution_authority,
      "freeze_spec.owner_execution_authority",
    ),
    source_artifacts: {
      ...Object.fromEntries(COMMON_SOURCE_KEYS.map((key) => [
        key,
        parseAbsoluteFileRef(
          raw.source_artifacts[key],
          `freeze_spec.source_artifacts.${key}`,
        ),
      ])),
      authoritative_item_report_capture: Object.fromEntries(CAPTURE_KEYS.map((key) => [
        key,
        parseAbsoluteFileRef(
          raw.source_artifacts.authoritative_item_report_capture[key],
          `freeze_spec.source_artifacts.authoritative_item_report_capture.${key}`,
        ),
      ])),
    },
    listings,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON rejects undefined");
  return encoded;
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertExistingPathHasNoSymlinks(targetPath, expectedKind, label) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`${label} may not contain symlinks: ${cursor}`);
  }
  const info = await lstat(resolved);
  if (expectedKind === "file" && !info.isFile()) throw new Error(`${label} must be a regular file`);
  if (expectedKind === "directory" && !info.isDirectory()) throw new Error(`${label} must be a directory`);
  return info;
}

async function assertNewOutputDirectory(outputDirectory) {
  await assertExistingPathHasNoSymlinks(
    path.dirname(outputDirectory),
    "directory",
    "--output-dir parent",
  );
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("--output-dir must not already exist");
}

async function readBoundFile(ref, maximumBytes, label) {
  const before = await assertExistingPathHasNoSymlinks(ref.path, "file", label);
  if (before.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const bytes = await readFile(ref.path);
  if (bytes.byteLength !== before.size) throw new Error(`${label} changed while being read`);
  if (sha256Bytes(bytes) !== ref.sha256) throw new Error(`${label} exact-byte SHA-256 mismatch`);
  return bytes;
}

async function writeExclusiveBytes(file, bytes, mode = 0o444) {
  const handle = await open(file, "wx", mode);
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
  }
  if (!complete) throw new Error(`exclusive write did not complete: ${file}`);
  await chmod(file, mode);
  const persisted = await readFile(file);
  if (!Buffer.from(persisted).equals(Buffer.from(bytes))) {
    throw new Error(`exclusive write readback mismatch: ${file}`);
  }
  return { sha256: sha256Bytes(persisted), bytes: persisted.byteLength };
}

async function writeGeneratedJson(root, relativePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const written = await writeExclusiveBytes(path.join(root, ...relativePath.split("/")), bytes);
  return { path: relativePath, sha256: written.sha256 };
}

async function copyBoundFile(root, relativePath, ref, maximumBytes, label) {
  const bytes = await readBoundFile(ref, maximumBytes, label);
  const written = await writeExclusiveBytes(path.join(root, ...relativePath.split("/")), bytes);
  if (written.sha256 !== ref.sha256) throw new Error(`${label} copy SHA-256 mismatch`);
  return { ref: { path: relativePath, sha256: written.sha256 }, bytes };
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Capture the exact local Apple Vision toolchain pins used by the observer. */
export async function captureWalmartListingIntegrityLocalRuntimePins(injected = {}) {
  const readFileImpl = injected.read_file ?? readFile;
  const execFileImpl = injected.exec_file ?? execFile;
  const platform = injected.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("Apple Vision OCR freezer requires macOS");
  const [swiftBytes, xcrunBytes, swiftVersion, sdkVersionResult, sdkPathResult] = await Promise.all([
    readFileImpl("/usr/bin/swift"),
    readFileImpl("/usr/bin/xcrun"),
    execFileImpl("/usr/bin/swift", ["--version"], {
      encoding: null,
      env: PINNED_SYSTEM_CHILD_ENV,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }),
    execFileImpl("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], {
      encoding: "utf8",
      env: PINNED_SYSTEM_CHILD_ENV,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }),
    execFileImpl("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
      encoding: "utf8",
      env: PINNED_SYSTEM_CHILD_ENV,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }),
  ]);
  const swiftStdout = Buffer.isBuffer(swiftVersion.stdout)
    ? swiftVersion.stdout : Buffer.from(swiftVersion.stdout);
  const sdkVersion = safeText(sdkVersionResult.stdout.trim(), "macOS SDK version", 128);
  const sdkPath = safeText(sdkPathResult.stdout.trim(), "macOS SDK path", 4_096);
  return {
    swift_executable_sha256: sha256Bytes(swiftBytes),
    xcrun_executable_sha256: sha256Bytes(xcrunBytes),
    swift_version_output_sha256: sha256Bytes(swiftStdout),
    macos_sdk_path_sha256: sha256Bytes(Buffer.from(sdkPath, "utf8")),
    macos_sdk_version: sdkVersion,
  };
}

function listingDirectory(index, listingKey) {
  return `listings/${String(index + 1).padStart(6, "0")}-${sha256Bytes(Buffer.from(listingKey, "utf8")).slice(0, 16)}`;
}

function sourceBindings(productTruth, buyerIndex, catalogExport, auditCase, buyerSnapshot, surface) {
  return {
    product_truth_snapshot_id: productTruth.snapshot_id,
    product_truth_snapshot_body_sha256: productTruth.body_sha256,
    catalog_truth_export_id: catalogExport.export_id,
    catalog_truth_export_body_sha256: catalogExport.body_sha256,
    catalog_truth_case_id: auditCase.case_id,
    catalog_truth_preflight_sha256: auditCase.preflight_sha256,
    truth_revision_id: auditCase.truth_revision.revision_id,
    truth_revision_body_sha256: auditCase.truth_revision.body_sha256,
    truth_approval_sha256: auditCase.truth_revision.approval_sha256,
    buyer_index_id: buyerIndex.index_id,
    buyer_index_body_sha256: buyerIndex.body_sha256,
    buyer_snapshot_id: buyerSnapshot.snapshot_id,
    buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
    buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
    surface_snapshot_id: surface.snapshot_id,
    surface_snapshot_body_sha256: surface.body_sha256,
    surface_payload_sha256: surface.buyer_source.buyer_payload_sha256,
  };
}

function validateRawIdentity(listing, buyerSnapshot, sellerPayload, catalogPayload, buyerPayload) {
  const sku = listing.listing_key.split(":").slice(2).join(":");
  const target = { sku, item_id: listing.item_id };
  const resolution = resolveExactWalmartItemCandidate(sku, sellerPayload, catalogPayload);
  const buyer = resolveExactBuyerPdp(buyerPayload, target);
  const hashes = buyerSnapshot.payload_hashes;
  if (!isRecord(hashes)
    || walmartListingIntegritySha256(sellerPayload) !== hashes.seller_payload_canonical_sha256
    || walmartListingIntegritySha256(catalogPayload) !== hashes.catalog_search_payload_canonical_sha256
    || walmartListingIntegritySha256(resolution) !== hashes.resolution_canonical_sha256
    || walmartListingIntegritySha256(buyerPayload) !== hashes.buyer_payload_canonical_sha256) {
    throw new Error(`${listing.listing_key}: raw payload hashes do not rebuild the buyer snapshot`);
  }
  if (!isRecord(buyerSnapshot.identity)
    || !canonicalEqual(resolution.seller, buyerSnapshot.identity.seller)
    || !canonicalEqual(
      resolution.catalog_search_candidate,
      buyerSnapshot.identity.catalog_search_candidate,
    )
    || !canonicalEqual(resolution.identity_evidence, buyerSnapshot.identity.chain_evidence?.seller_to_catalog)
    || buyer.item_id !== buyerSnapshot.identity.buyer?.item_id
    || buyer.title !== buyerSnapshot.identity.buyer?.title
    || !canonicalEqual(buyer.identity_evidence, buyerSnapshot.identity.buyer?.identity_evidence)
    || !canonicalEqual(
      buyer.identity_evidence,
      buyerSnapshot.identity.chain_evidence?.catalog_to_buyer_pdp,
    )) {
    throw new Error(`${listing.listing_key}: raw identity chain differs from buyer snapshot`);
  }
  const rawUrls = [buyer.main_image_url, ...buyer.gallery_image_urls];
  if (!Array.isArray(buyerSnapshot.assets) || buyerSnapshot.assets.length !== rawUrls.length
    || rawUrls.some((url, index) => buyerSnapshot.assets[index]?.source_url !== url)) {
    throw new Error(`${listing.listing_key}: raw PDP image population differs from buyer snapshot`);
  }
  return { target, buyer };
}

function buildObserverContract(worker, codeManifest, runtimePins) {
  const ocr = codeManifest.files.find((row) => row.path === "scripts/walmart-visual-ocr.swift");
  if (!ocr) throw new Error("code bundle does not contain the reviewed local OCR script");
  return {
    provider: "claude_cli_subscription",
    model: "sonnet",
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    observation_schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    prompt_version: BLIND_PROMPT_VERSION,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
    local_ocr_script_sha256: ocr.sha256,
    worker_build_sha256: worker.build_sha256,
    worker_receipt_key_id: worker.receipt_key_id,
    worker_receipt_public_key_sha256: worker.receipt_public_key_sha256,
    worker_analyze_url: worker.analyze_url,
    vision_timeout_ms: worker.vision_timeout_ms,
    observer_response_margin_ms: LOCKED_OBSERVER_RESPONSE_MARGIN_MS,
    ...runtimePins,
    cli_version: worker.cli_version,
    node_version: worker.node_version,
    platform: worker.platform,
    arch: worker.arch,
    reservation_ledger: worker.reservation_ledger,
    health_attestation_required: true,
    response_attestation_required: true,
    attempt_count: 1,
    fallback_allowed: false,
    max_images_per_call: WORKER_MAX_IMAGES_PER_CALL,
  };
}

function adjudicatorConstraints() {
  return {
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    coverage: "exactly_once",
    output_write_policy: "immutable_wx_reports_only",
    observations: "precomputed_source_verified_only",
  };
}

function observerExecutionConstraints(shardCount) {
  return {
    network_target: "locked_worker_only",
    worker_health_calls_per_execute: 1,
    subscription_calls_total: shardCount,
    calls_per_shard: 1,
    max_calls_per_execute: 6,
    transport_attempts_per_shard: 1,
    retries: 0,
    fallbacks: 0,
    paid_api_calls: 0,
    openai_model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
    local_ocr_required: true,
    execution_order: "partition_contiguous_prefix",
    ambiguous_attempt_policy: "offline_terminalize_technical_error_no_retry_then_resume",
    output_write_policy: "immutable_wx_attempt_and_observation_only",
  };
}

async function validateExactWorkerRequestCaps(root, runLock) {
  const viewByImageId = new Map();
  for (const listing of runLock.listings) {
    for (const asset of listing.assets) viewByImageId.set(asset.image_id, asset.model_view);
  }
  for (const shard of runLock.shards) {
    const partition = runLock.observer_partitions.find((row) => (
      row.shard_ids.includes(shard.shard_id)
    ));
    if (!partition) {
      throw new Error(`${shard.shard_id}: observer partition binding is missing`);
    }
    const images = [];
    for (const image of shard.images) {
      const ref = viewByImageId.get(image.image_id);
      if (!ref || ref.sha256 !== image.model_view_sha256) {
        throw new Error(`${shard.shard_id}/${image.image_id}: model-view path binding is missing`);
      }
      const bytes = await readFile(path.join(root, ...ref.path.split("/")));
      if (sha256Bytes(bytes) !== ref.sha256) {
        throw new Error(`${shard.shard_id}/${image.image_id}: frozen model-view SHA mismatch`);
      }
      images.push(bytes.toString("base64"));
    }
    // The real values are all fixed-length digests. Their content does not
    // affect the exact JSON body length, so this exercises the observer's own
    // production request builder/cap without a circular run-lock SHA.
    buildWorkerRequestBody(shard, {
      request_attestation: {
        schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
        run_lock_sha256: "0".repeat(64),
        shard_id: shard.shard_id,
        call_index: shard.call_index,
        call_key: "0".repeat(64),
        prompt_sha256: shard.prompt_sha256,
        execution_permit_sha256: "0".repeat(64),
        partition_id: partition.partition_id,
        image_sha256: shard.images.map((row) => row.model_view_sha256),
      },
    }, images);
  }
}

/** Deterministically chunk the certified batch-4 layout; worker cap remains six. */
export function buildWalmartListingIntegrityShards(orderedBindings) {
  if (!Array.isArray(orderedBindings) || orderedBindings.length < 1) {
    throw new Error("ordered image bindings must be a non-empty array");
  }
  const shards = [];
  for (let offset = 0; offset < orderedBindings.length; offset += CERTIFIED_IMAGES_PER_SHARD) {
    const callIndex = shards.length;
    const images = orderedBindings.slice(offset, offset + CERTIFIED_IMAGES_PER_SHARD);
    const ordinal = String(callIndex).padStart(6, "0");
    shards.push({
      shard_id: `shard-${ordinal}`,
      call_index: callIndex,
      observation_batch_path: `observations/call-${ordinal}.json`,
      prompt_sha256: walmartListingObservationPromptSha256(images.map((row) => row.image_id)),
      images,
    });
  }
  if (shards.length > MAX_SHARDS) throw new Error(`frozen execution exceeds ${MAX_SHARDS} shards`);
  return shards;
}

/** Deterministically isolate at most six certified batch-4 calls per permit. */
export function buildWalmartListingIntegrityObserverPartitions(shards) {
  if (!Array.isArray(shards) || shards.length < 1) {
    throw new Error("observer partitions require a non-empty shard array");
  }
  const partitions = [];
  for (let offset = 0; offset < shards.length; offset += MAX_SHARDS_PER_PARTITION) {
    const partitionIndex = partitions.length;
    const shardIds = shards
      .slice(offset, offset + MAX_SHARDS_PER_PARTITION)
      .map((shard, localIndex) => {
        if (shard.call_index !== offset + localIndex) {
          throw new Error("observer partition shards must have contiguous global call indexes");
        }
        return shard.shard_id;
      });
    partitions.push({
      partition_id: walmartListingIntegrityObserverPartitionId(partitionIndex, shardIds),
      partition_index: partitionIndex,
      shard_ids: shardIds,
    });
  }
  if (partitions.flatMap((partition) => partition.shard_ids).length !== shards.length) {
    throw new Error("observer partitions are not exhaustive");
  }
  return partitions;
}

async function listFrozenFiles(root, relative = "") {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`frozen output contains a symlink: ${child}`);
    if (MUTABLE_EXECUTION_DIRECTORIES.has(child)) {
      if (!entry.isDirectory()) throw new Error(`${child} must be a real directory`);
      continue;
    }
    if (entry.isDirectory()) files.push(...await listFrozenFiles(root, child));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, ...child.split("/")));
      files.push({ path: child, sha256: sha256Bytes(bytes), bytes: bytes.byteLength });
    } else throw new Error(`frozen output contains an unsupported filesystem entry: ${child}`);
  }
  return files.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

async function makeBundleDirectories(root) {
  for (const directory of [
    "code",
    "sources",
    "sources/item-report-capture",
    "listings",
    "observations",
    "permits",
  ]) {
    await mkdir(path.join(root, ...directory.split("/")), { mode: 0o700 });
  }
}

async function freezeListing({
  root,
  listing,
  index,
  catalog,
  productTruth,
  buyerIndex,
  copyFile,
}) {
  const directory = listingDirectory(index, listing.listing_key);
  await mkdir(path.join(root, ...directory.split("/")), { mode: 0o700 });
  await mkdir(path.join(root, ...`${directory}/assets`.split("/")), { mode: 0o700 });
  await mkdir(path.join(root, ...`${directory}/views`.split("/")), { mode: 0o700 });

  const auditCase = catalog.cases?.find((row) => row.listing_key === listing.listing_key);
  if (!auditCase || auditCase.item_id !== listing.item_id
    || auditCase.disposition !== "auditable" || !auditCase.preflight
    || auditCase.preflight.status !== "AUDITABLE" || !auditCase.preflight_sha256
    || !auditCase.truth_revision?.approval_sha256) {
    throw new Error(`${listing.listing_key}: catalog export case is not approved and auditable`);
  }
  const buyerEntry = buyerIndex.entries?.find((row) => row.listing_key === listing.listing_key);
  if (!buyerEntry || buyerEntry.item_id !== listing.item_id) {
    throw new Error(`${listing.listing_key}: exact buyer index entry is missing`);
  }

  const buyerManifestCopy = await copyFile(
    `${directory}/buyer-snapshot-manifest.json`,
    listing.buyer_snapshot_manifest,
    MAX_JSON_BYTES,
    `${listing.listing_key} buyer_snapshot_manifest`,
  );
  const buyerSnapshot = parseJsonBytes(
    buyerManifestCopy.bytes,
    `${listing.listing_key} buyer_snapshot_manifest`,
  );
  if (!canonicalEqual(buyerSnapshot, buyerEntry.snapshot)) {
    throw new Error(`${listing.listing_key}: buyer manifest differs from verified buyer index`);
  }
  const rawCopies = {};
  for (const [key, filename] of [
    ["seller_item_payload", "seller-item-payload.json"],
    ["catalog_search_payload", "catalog-search-payload.json"],
    ["buyer_pdp_payload", "buyer-pdp-payload.json"],
  ]) {
    const copied = await copyFile(
      `${directory}/${filename}`,
      listing[key],
      MAX_JSON_BYTES,
      `${listing.listing_key} ${key}`,
    );
    rawCopies[key] = { ref: copied.ref, value: parseJsonBytes(copied.bytes, `${listing.listing_key} ${key}`) };
  }
  const identity = validateRawIdentity(
    listing,
    buyerSnapshot,
    rawCopies.seller_item_payload.value,
    rawCopies.catalog_search_payload.value,
    rawCopies.buyer_pdp_payload.value,
  );
  if (buyerSnapshot.target?.sku !== identity.target.sku
    || buyerSnapshot.target?.item_id !== listing.item_id
    || auditCase.store_index !== Number(listing.listing_key.split(":")[1])
    || auditCase.sku !== identity.target.sku
    || auditCase.published_status !== "PUBLISHED"
    || auditCase.lifecycle_status !== "ACTIVE") {
    throw new Error(`${listing.listing_key}: listing/buyer/catalog identity or live status mismatch`);
  }

  const surfaceValue = projectWalmartListingSurfaceFromBuyerPdp(
    rawCopies.buyer_pdp_payload.value,
    identity.target,
  );
  const surfaceSnapshot = sealWalmartListingSurfaceSnapshot({
    schema_version: WALMART_LISTING_SURFACE_SNAPSHOT_SCHEMA,
    captured_at: buyerSnapshot.captured_at,
    listing: {
      channel: "WALMART_US",
      store_index: auditCase.store_index,
      sku: auditCase.sku,
      listing_key: listing.listing_key,
      item_id: listing.item_id,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
    },
    buyer_source: {
      contract: "walmart_buyer_pdp_exact_item_get",
      buyer_snapshot_id: buyerSnapshot.snapshot_id,
      buyer_snapshot_body_sha256: buyerSnapshot.body_sha256,
      buyer_payload_sha256: buyerSnapshot.payload_hashes.buyer_payload_canonical_sha256,
      exact_item_id_echo: true,
      complete_attribute_inventory: true,
    },
    surface: surfaceValue,
  });
  const surfaceRef = await writeGeneratedJson(
    root,
    `${directory}/surface-snapshot.json`,
    surfaceSnapshot,
  );

  if (listing.buyer_assets.length !== buyerSnapshot.assets.length) {
    throw new Error(`${listing.listing_key}: local buyer asset population differs from manifest`);
  }
  const frozenAssets = [];
  const inputAssets = [];
  const bindings = [];
  for (let assetIndex = 0; assetIndex < listing.buyer_assets.length; assetIndex += 1) {
    const source = listing.buyer_assets[assetIndex];
    const manifestAsset = buyerSnapshot.assets[assetIndex];
    const bytes = await readBoundFile(
      source.file,
      MAX_ASSET_BYTES,
      `${listing.listing_key}/${source.slot} buyer asset`,
    );
    const fingerprint = await fingerprintGalleryImage("gallery-1", bytes);
    if (manifestAsset.sha256 !== source.file.sha256
      || manifestAsset.bytes !== bytes.byteLength
      || manifestAsset.decoded_width !== fingerprint.width
      || manifestAsset.decoded_height !== fingerprint.height
      || manifestAsset.sha256 !== fingerprint.sha256) {
      throw new Error(`${listing.listing_key}/${source.slot}: local image bytes differ from buyer manifest`);
    }
    const preprocessed = await preprocessCatalogVisual(bytes);
    const fullViews = preprocessed.views.filter((view) => view.role === "full");
    if (preprocessed.source.sha256 !== source.file.sha256 || fullViews.length !== 1) {
      throw new Error(`${listing.listing_key}/${source.slot}: deterministic full model view is unavailable`);
    }
    const full = fullViews[0];
    if (full.bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`${listing.listing_key}/${source.slot}: model view exceeds ${MAX_ASSET_BYTES} bytes`);
    }
    const ordinal = String(assetIndex).padStart(3, "0");
    const assetRelative = `${directory}/assets/${ordinal}-${source.file.sha256}.bin`;
    const viewRelative = `${directory}/views/${ordinal}-${full.sha256}.bin`;
    const assetWritten = await writeExclusiveBytes(
      path.join(root, ...assetRelative.split("/")),
      bytes,
    );
    const viewWritten = await writeExclusiveBytes(
      path.join(root, ...viewRelative.split("/")),
      full.bytes,
    );
    const imageId = walmartListingObservationImageId(
      source.file.sha256,
      source.slot,
      listing.listing_key,
    );
    frozenAssets.push({
      slot: source.slot,
      buyer_asset: { path: assetRelative, sha256: assetWritten.sha256 },
      model_view: { path: viewRelative, sha256: viewWritten.sha256 },
      image_id: imageId,
    });
    inputAssets.push({
      slot: source.slot,
      source_url: manifestAsset.final_url,
      sha256: source.file.sha256,
      byte_length: bytes.byteLength,
      decoded_width: fingerprint.width,
      decoded_height: fingerprint.height,
      dhash64: fingerprint.dhash64,
      buyer_facing_verified: true,
      surface: "buyer_pdp",
    });
    bindings.push({
      listing_key: listing.listing_key,
      item_id: listing.item_id,
      slot: source.slot,
      asset_sha256: source.file.sha256,
      model_view_sha256: full.sha256,
      image_id: imageId,
    });
  }

  const baseInput = {
    schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    listing: {
      channel: "WALMART_US",
      store_index: auditCase.store_index,
      sku: auditCase.sku,
      listing_key: listing.listing_key,
      item_id: listing.item_id,
      published_status: "PUBLISHED",
      lifecycle_status: "ACTIVE",
      captured_at: buyerSnapshot.captured_at,
      composition: auditCase.recipe_composition,
    },
    source_bindings: sourceBindings(
      productTruth,
      buyerIndex,
      catalog,
      auditCase,
      buyerSnapshot,
      surfaceSnapshot,
    ),
    expected: auditCase.preflight.expected,
    surface: surfaceValue,
    images: {
      assets: inputAssets,
      evidence: [],
      duplicate_summary: null,
    },
  };
  const baseInputRef = await writeGeneratedJson(root, `${directory}/base-input.json`, baseInput);
  return {
    buyer_snapshot_captured_at: canonicalTimestamp(
      buyerSnapshot.captured_at,
      `${listing.listing_key} buyer snapshot captured_at`,
    ),
    run_lock_listing: {
      listing_key: listing.listing_key,
      item_id: listing.item_id,
      base_input: baseInputRef,
      surface_snapshot: surfaceRef,
      buyer_snapshot_manifest: buyerManifestCopy.ref,
      seller_item_payload: rawCopies.seller_item_payload.ref,
      catalog_search_payload: rawCopies.catalog_search_payload.ref,
      buyer_pdp_payload: rawCopies.buyer_pdp_payload.ref,
      assets: frozenAssets,
      shard_ids: [],
    },
    bindings,
  };
}

function stdoutCapture() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
      return true;
    },
  };
}

function assertPlanResult(plan, runLock, runLockSha) {
  if (!isRecord(plan)
    || plan.schema_version !== WALMART_LISTING_INTEGRITY_PLAN_SCHEMA
    || plan.mode !== "PLAN"
    || plan.run_id !== runLock.run_id
    || plan.run_lock_sha256 !== runLockSha
    || plan.listing_count !== runLock.listings.length
    || plan.shard_count !== runLock.shards.length
    || plan.partition_count !== runLock.observer_partitions.length
    || !canonicalEqual(plan.observer_partitions, runLock.observer_partitions)
    || plan.assurance?.source_byte_hashes_verified !== true
    || plan.assurance?.executing_code_bytes_verified !== true
    || plan.assurance?.asset_byte_hashes_verified !== true
    || plan.assurance?.semantic_source_preflight_verified !== true
    || plan.assurance?.observation_batches_read !== false
    || plan.assurance?.reports_written !== 0
    || plan.assurance?.network_calls !== 0
    || plan.assurance?.model_calls !== 0
    || plan.assurance?.database_reads !== 0
    || plan.assurance?.database_writes !== 0
    || plan.assurance?.marketplace_reads !== 0
    || plan.assurance?.marketplace_writes !== 0) {
    throw new Error("source-aware plan result does not satisfy freezer readiness contract");
  }
  const certificate = parseWalmartListingIntegrityPreflightCertificate(
    plan.preflight_certificate,
  );
  if (certificate.body.run_lock_sha256 !== runLockSha
    || certificate.body.run_id !== runLock.run_id
    || certificate.body.partition_count !== runLock.observer_partitions.length) {
    throw new Error("source-aware preflight certificate does not bind the frozen family");
  }
  return certificate;
}

async function recursivelyFreezeDirectories(root, relative = "") {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (MUTABLE_EXECUTION_DIRECTORIES.has(child)) continue;
    await recursivelyFreezeDirectories(root, child);
    await chmod(path.join(root, ...child.split("/")), 0o500);
  }
}

async function writeFinalArtifactAfterSealing(root, filename, value) {
  const finalRef = await writeGeneratedJson(root, filename, value);
  await recursivelyFreezeDirectories(root);
  for (const directory of MUTABLE_EXECUTION_DIRECTORIES) {
    await chmod(path.join(root, directory), 0o700);
    await syncDirectory(path.join(root, directory));
  }
  await syncDirectory(root);
  await chmod(root, 0o500);
  const rootInfo = await lstat(root);
  const finalInfo = await lstat(path.join(root, filename));
  if ((rootInfo.mode & 0o777) !== 0o500 || (finalInfo.mode & 0o777) !== 0o444) {
    throw new Error("staged frozen bundle did not reach its final read-only modes");
  }
  await syncDirectory(root);
  await syncDirectory(path.dirname(root));
  return finalRef;
}

async function verifySealedFrozenFileSet(root, manifest, manifestRef, finalRef) {
  const expected = new Map(manifest.files.map((row) => [row.path, row]));
  expected.set(manifestRef.path, { ...manifestRef, bytes: null });
  expected.set(finalRef.path, { ...finalRef, bytes: null });
  const actual = await listFrozenFiles(root);
  const actualPaths = actual.map((row) => row.path);
  const expectedPaths = [...expected.keys()].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  if (!canonicalEqual(actualPaths, expectedPaths)) {
    throw new Error("sealed frozen bundle file population differs from its manifest");
  }
  for (const row of actual) {
    const locked = expected.get(row.path);
    if (!locked || row.sha256 !== locked.sha256
      || (locked.bytes !== null && row.bytes !== locked.bytes)) {
      throw new Error(`sealed frozen bundle file differs from manifest: ${row.path}`);
    }
    const info = await lstat(path.join(root, ...row.path.split("/")));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o444) {
      throw new Error(`sealed frozen bundle file mode/type is invalid: ${row.path}`);
    }
  }
}

async function verifyEmptyExecutionDirectories(root) {
  for (const name of MUTABLE_EXECUTION_DIRECTORIES) {
    const directory = path.join(root, name);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
      throw new Error(`sealed ${name} path must be a real mode-0700 directory`);
    }
    if ((await readdir(directory)).length !== 0) {
      throw new Error(`sealed ${name} directory must be empty before publish`);
    }
  }
}

async function prepareAtomicPublisher(outputParent, bundleRoot) {
  if (process.platform !== "darwin") {
    throw new Error("atomic no-replace bundle publish requires macOS renamex_np");
  }
  const helperDirectory = await mkdtemp(path.join(outputParent, ".walmart-freezer-publish-helper-"));
  const sourcePath = path.join(helperDirectory, "publish.c");
  const helperPath = path.join(helperDirectory, "publish-no-replace");
  try {
    const clangPath = "/usr/bin/clang";
    const clangInfo = await assertExistingPathHasNoSymlinks(clangPath, "file", "atomic compiler");
    if (clangInfo.size > MAX_SPEC_BYTES) throw new Error("atomic compiler exceeds byte cap");
    const clangBytes = await readFile(clangPath);
    if (clangBytes.byteLength !== clangInfo.size) throw new Error("atomic compiler changed while read");
    const clangVersion = await execFile(clangPath, ["--version"], {
      encoding: null,
      env: PINNED_SYSTEM_CHILD_ENV,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const clangVersionBytes = Buffer.isBuffer(clangVersion.stdout)
      ? clangVersion.stdout : Buffer.from(clangVersion.stdout);
    const sourceBytes = Buffer.from(ATOMIC_PUBLISH_C, "utf8");
    await writeExclusiveBytes(sourcePath, sourceBytes, 0o400);
    await execFile("/usr/bin/clang", [
      "-x", "c", sourcePath, "-Os", "-Werror", "-o", helperPath,
    ], {
      encoding: "utf8",
      env: { ...PINNED_SYSTEM_CHILD_ENV, TMPDIR: helperDirectory },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    await chmod(helperPath, 0o500);
    const helperBytes = await readFile(helperPath);
    const sourceWritten = await writeExclusiveBytes(
      path.join(bundleRoot, "code/atomic-publish.c"),
      sourceBytes,
    );
    const helperWritten = await writeExclusiveBytes(
      path.join(bundleRoot, "code/atomic-publish-helper.bin"),
      helperBytes,
    );
    const clangVersionWritten = await writeExclusiveBytes(
      path.join(bundleRoot, "code/atomic-publish-clang-version.txt"),
      clangVersionBytes,
    );
    return {
      helper_directory: helperDirectory,
      helper_path: helperPath,
      contract: {
        mechanism: "macos_renamex_np_RENAME_EXCL",
        source: { path: "code/atomic-publish.c", sha256: sourceWritten.sha256 },
        helper_binary: {
          path: "code/atomic-publish-helper.bin",
          sha256: helperWritten.sha256,
        },
        compiler: {
          path: clangPath,
          executable_sha256: sha256Bytes(clangBytes),
          version_output: {
            path: "code/atomic-publish-clang-version.txt",
            sha256: clangVersionWritten.sha256,
          },
          arguments: ["-x", "c", "publish.c", "-Os", "-Werror", "-o", "publish-no-replace"],
        },
      },
    };
  } catch (error) {
    await chmod(helperDirectory, 0o700).catch(() => {});
    await rm(helperDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupAtomicPublisher(prepared) {
  if (!prepared) return;
  await chmod(prepared.helper_directory, 0o700).catch(() => {});
  await rm(prepared.helper_directory, { recursive: true, force: true });
}

async function publishSealedDirectoryNoReplace(stagingDirectory, targetDirectory, prepared) {
  try {
    const helperInfo = await lstat(prepared.helper_path);
    if (!helperInfo.isFile() || helperInfo.isSymbolicLink()
      || (helperInfo.mode & 0o777) !== 0o500) {
      throw new Error("atomic publish helper type/mode changed after compilation");
    }
    const helperBytes = await readFile(prepared.helper_path);
    if (sha256Bytes(helperBytes) !== prepared.contract.helper_binary.sha256) {
      throw new Error("atomic publish helper bytes changed after compilation");
    }
    await execFile(prepared.helper_path, [stagingDirectory, targetDirectory], {
      encoding: "utf8",
      env: PINNED_SYSTEM_CHILD_ENV,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    if (error?.code === 73) {
      throw new Error("--output-dir appeared at atomic commit; sealed staging bundle was not published");
    }
    const stderr = typeof error?.stderr === "string"
      ? error.stderr : Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : "";
    throw new Error(`atomic no-replace publish failed: ${stderr.trim() || error?.message || String(error)}`);
  } finally {
    await cleanupAtomicPublisher(prepared);
  }
  try {
    await lstat(stagingDirectory);
    throw new Error("atomic publish returned but staging directory still exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const target = await lstat(targetDirectory);
  if (!target.isDirectory() || target.isSymbolicLink() || (target.mode & 0o777) !== 0o500) {
    throw new Error("atomically published bundle root type/mode is invalid");
  }
}

/**
 * Internal core. Only the explicit test harness may pass injected dependencies,
 * and that path is structurally incapable of emitting READY.json.
 */
async function freezeWalmartListingIntegrityBundleCore(options, injected, productionReady) {
  const specPath = absoluteNormalizedPath(options.spec_path, "--spec");
  const requestedOutputDirectory = absoluteNormalizedPath(options.output_dir, "--output-dir");
  await assertExistingPathHasNoSymlinks(specPath, "file", "--spec");
  const specInfo = await lstat(specPath);
  if (specInfo.size > MAX_SPEC_BYTES) throw new Error(`--spec exceeds ${MAX_SPEC_BYTES} bytes`);
  const specBytes = await readFile(specPath);
  if (specBytes.byteLength !== specInfo.size) throw new Error("--spec changed while being read");
  const spec = parseWalmartListingIntegrityFreezeSpec(parseJsonBytes(specBytes, "freeze spec"));
  await assertNewOutputDirectory(requestedOutputDirectory);
  const outputParent = path.dirname(requestedOutputDirectory);
  const outputBase = path.basename(requestedOutputDirectory);
  const outputDirectory = path.join(
    outputParent,
    `.${outputBase}.freeze-staging-${randomBytes(12).toString("hex")}`,
  );
  await assertNewOutputDirectory(outputDirectory);
  await mkdir(outputDirectory, { mode: 0o700 });
  await makeBundleDirectories(outputDirectory);
  const copyFile = async (relativePath, ref, maximumBytes, label) => (
    copyBoundFile(outputDirectory, relativePath, ref, maximumBytes, label)
  );

  const freezeSpecWritten = await writeExclusiveBytes(
    path.join(outputDirectory, "freeze-spec.json"),
    specBytes,
  );
  const freezerSourcePath = fileURLToPath(import.meta.url);
  const freezerSourceInfo = await assertExistingPathHasNoSymlinks(
    freezerSourcePath,
    "file",
    "freezer source",
  );
  if (freezerSourceInfo.size > MAX_SPEC_BYTES) {
    throw new Error(`freezer source exceeds ${MAX_SPEC_BYTES} bytes`);
  }
  const freezerSourceBytes = await readFile(freezerSourcePath);
  if (freezerSourceBytes.byteLength !== freezerSourceInfo.size) {
    throw new Error("freezer source changed while being read");
  }
  const freezerSourceWritten = await writeExclusiveBytes(
    path.join(outputDirectory, "code/freezer-source.mjs"),
    freezerSourceBytes,
  );
  const freezerSourceRef = {
    path: "code/freezer-source.mjs",
    sha256: freezerSourceWritten.sha256,
  };
  const codeManifestBuilder = injected.build_code_manifest ?? buildCurrentCodeBundleManifest;
  const codeManifest = await codeManifestBuilder();
  const codeManifestRef = await writeGeneratedJson(
    outputDirectory,
    "code/code-bundle-manifest.json",
    codeManifest,
  );

  const copiedSources = {};
  const parsedSources = {};
  for (const key of COMMON_SOURCE_KEYS) {
    const copied = await copyFile(
      `sources/${key.replaceAll("_", "-")}.bin`,
      spec.source_artifacts[key],
      MAX_JSON_BYTES,
      `source_artifacts.${key}`,
    );
    copiedSources[key] = copied.ref;
    parsedSources[key] = parseJsonBytes(copied.bytes, `source_artifacts.${key}`);
  }
  copiedSources.authoritative_item_report_capture = {};
  for (const key of CAPTURE_KEYS) {
    const copied = await copyFile(
      `sources/item-report-capture/${key.replaceAll("_", "-")}.bin`,
      spec.source_artifacts.authoritative_item_report_capture[key],
      MAX_JSON_BYTES,
      `source_artifacts.authoritative_item_report_capture.${key}`,
    );
    copiedSources.authoritative_item_report_capture[key] = copied.ref;
  }

  const verifyCatalog = injected.verify_catalog_export
    ?? verifyWalmartCatalogTruthAuditExportAgainstSources;
  const catalog = verifyCatalog(
    parsedSources.catalog_truth_export,
    parsedSources.product_truth_snapshot,
    parsedSources.buyer_snapshot_index,
  );
  const frozenListings = [];
  const orderedBindings = [];
  const lockedBuyerSnapshotCapturedAts = [];
  for (let index = 0; index < spec.listings.length; index += 1) {
    const frozen = await freezeListing({
      root: outputDirectory,
      listing: spec.listings[index],
      index,
      catalog,
      productTruth: parsedSources.product_truth_snapshot,
      buyerIndex: parsedSources.buyer_snapshot_index,
      copyFile,
    });
    frozenListings.push(frozen.run_lock_listing);
    lockedBuyerSnapshotCapturedAts.push(frozen.buyer_snapshot_captured_at);
    orderedBindings.push(...frozen.bindings);
  }
  const shards = buildWalmartListingIntegrityShards(orderedBindings);
  const observerPartitions = buildWalmartListingIntegrityObserverPartitions(shards);
  for (const listing of frozenListings) {
    listing.shard_ids = shards
      .filter((shard) => shard.images.some((image) => image.listing_key === listing.listing_key))
      .map((shard) => shard.shard_id);
  }

  const runtimePins = await (injected.capture_runtime_pins
    ?? captureWalmartListingIntegrityLocalRuntimePins)();
  const sourceFreshness = buildWalmartListingIntegritySourceFreshness({
    authoritative_scope_captured_at: parsedSources.authoritative_published_scope.captured_at,
    product_truth_snapshot_captured_at: parsedSources.product_truth_snapshot.captured_at,
    buyer_index_captured_at: parsedSources.buyer_snapshot_index.captured_at,
    locked_buyer_snapshot_captured_ats: lockedBuyerSnapshotCapturedAts,
  });
  const freezeNowValue = (injected.now ?? (() => new Date()))();
  const freezeNowMs = freezeNowValue instanceof Date
    ? freezeNowValue.getTime() : Date.parse(String(freezeNowValue));
  const frozenSourceTimes = [
    sourceFreshness.authoritative_scope_captured_at,
    sourceFreshness.product_truth_snapshot_captured_at,
    sourceFreshness.buyer_index_captured_at,
    ...lockedBuyerSnapshotCapturedAts,
  ].map((value) => Date.parse(value));
  if (!Number.isFinite(freezeNowMs) || frozenSourceTimes.some((value) => value > freezeNowMs)
    || Date.parse(sourceFreshness.hard_deadline) <= freezeNowMs) {
    throw new Error("frozen source timestamps are future-dated or their hard 24h deadline already expired");
  }
  const runLock = parseRunLock({
    schema_version: WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
    run_id: spec.run_id,
    created_at: spec.created_at,
    purpose: "walmart_listing_integrity_frozen_family",
    engine_contract: {
      executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
      listing_engine_version: WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
      input_schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
      report_schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
      base_input_mode: WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
      source_aware_required: true,
      observation_artifacts_required: true,
    },
    observer_contract: buildObserverContract(spec.observer_worker, codeManifest, runtimePins),
    owner_execution_authority: spec.owner_execution_authority,
    hard_source_freshness: sourceFreshness,
    code_bundle_manifest: codeManifestRef,
    source_artifacts: copiedSources,
    shards,
    listings: frozenListings,
    observer_partitions: observerPartitions,
    adjudicator_constraints: adjudicatorConstraints(),
    observer_execution_constraints: observerExecutionConstraints(shards.length),
  });
  await validateExactWorkerRequestCaps(outputDirectory, runLock);
  const runLockRef = await writeGeneratedJson(outputDirectory, "run-lock.json", runLock);
  const runLockShaText = Buffer.from(`${runLockRef.sha256}\n`, "utf8");
  await writeExclusiveBytes(path.join(outputDirectory, "run-lock.sha256"), runLockShaText);

  // The real production plan is the final readiness gate. It independently
  // reloads every copied byte, current code byte, surface, image and complete
  // authoritative population. No READY artifact exists before this returns.
  const planStdout = stdoutCapture();
  const planRunner = injected.run_plan ?? runPlan;
  await planRunner({
    run_lock: path.join(outputDirectory, "run-lock.json"),
    expect_run_lock_sha256: runLockRef.sha256,
  }, { stdout: planStdout });
  const plan = parseJsonBytes(Buffer.from(planStdout.text, "utf8"), "source-aware plan output");
  const preflightCertificate = assertPlanResult(plan, runLock, runLockRef.sha256);
  const preflightCertificateRef = await writeGeneratedJson(
    outputDirectory,
    "preflight-certificate.json",
    preflightCertificate,
  );
  const planRef = await writeGeneratedJson(
    outputDirectory,
    "source-aware-plan.json",
    plan,
  );

  // The platform does not expose a no-replace directory rename in Node. Build
  // one tiny native commit helper, seal its exact source/binary/compiler
  // provenance into this bundle, and re-hash the executable immediately before
  // the single renamex_np(RENAME_EXCL) commit.
  const atomicPublisher = await prepareAtomicPublisher(outputParent, outputDirectory);
  try {
    const files = await listFrozenFiles(outputDirectory);
    const manifestBody = {
      schema_version: WALMART_LISTING_INTEGRITY_FROZEN_MANIFEST_SCHEMA,
      freezer_version: WALMART_LISTING_INTEGRITY_FREEZER_VERSION,
      freezer_source_sha256: freezerSourceRef.sha256,
      run_id: spec.run_id,
      run_lock_sha256: runLockRef.sha256,
      atomic_publish_contract: atomicPublisher.contract,
      files,
    };
    const manifest = {
      ...manifestBody,
      bundle_id: `sha256:${sha256Bytes(Buffer.from(canonicalJson(manifestBody), "utf8"))}`,
    };
    const manifestRef = await writeGeneratedJson(
      outputDirectory,
      "frozen-manifest.json",
      manifest,
    );
    const ready = {
    schema_version: productionReady
      ? WALMART_LISTING_INTEGRITY_READY_SCHEMA
      : "walmart-listing-integrity-test-only-not-ready/v1",
    status: productionReady ? "READY" : "TEST_ONLY_NOT_READY",
    freezer_version: WALMART_LISTING_INTEGRITY_FREEZER_VERSION,
    run_id: spec.run_id,
    created_at: spec.created_at,
    owner_execution_authority: spec.owner_execution_authority,
    hard_source_freshness: sourceFreshness,
    freeze_spec_sha256: freezeSpecWritten.sha256,
    freezer_source: freezerSourceRef,
    run_lock: runLockRef,
    code_bundle_id: codeManifest.bundle_id,
    code_bundle_manifest: codeManifestRef,
    source_aware_plan: planRef,
    preflight_certificate: preflightCertificateRef,
    frozen_manifest: manifestRef,
    frozen_bundle_id: manifest.bundle_id,
    atomic_publish_contract: atomicPublisher.contract,
    listing_count: frozenListings.length,
    image_count: orderedBindings.length,
    shard_count: shards.length,
    partition_count: observerPartitions.length,
    observation_directory: "observations",
    permit_directory: "permits",
    assurance: {
      source_aware_plan_passed: true,
      production_dependencies_non_injectable: productionReady,
      input_sources_sha_bound: true,
      input_paths_symlink_free: true,
      generated_files_exclusive_read_only: true,
      deterministic_shards_max_images: CERTIFIED_IMAGES_PER_SHARD,
      deterministic_partition_max_calls: MAX_SHARDS_PER_PARTITION,
      family_lock_has_execution_ttl: false,
      external_owner_authorization_required: true,
      one_reservation_per_partition: true,
      successful_observation_attempt_required: true,
      observer_attempt_mode: "0444",
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      marketplace_reads: 0,
      marketplace_writes: 0,
    },
  };
    const finalFilename = productionReady ? "READY.json" : "TEST_ONLY_NOT_READY.json";
    const finalRef = await writeFinalArtifactAfterSealing(
      outputDirectory,
      finalFilename,
      ready,
    );
    await verifySealedFrozenFileSet(outputDirectory, manifest, manifestRef, finalRef);
    await verifyEmptyExecutionDirectories(outputDirectory);
    await syncDirectory(outputDirectory);
    // The requested path is never visible in a partial state. Recheck it at the
    // commit boundary, atomically publish the already sealed sibling directory,
    // then fsync the parent directory entry.
    if (typeof injected.before_publish === "function") {
      await injected.before_publish({
        staging_directory: outputDirectory,
        target_directory: requestedOutputDirectory,
      });
    }
    await verifyEmptyExecutionDirectories(outputDirectory);
    if (Date.parse(runLock.created_at) > Date.now()) {
      throw new Error("family run-lock creation time is still in the future");
    }
    if (Date.parse(runLock.hard_source_freshness.hard_deadline) <= Date.now()) {
      throw new Error("family hard source-freshness deadline expired before atomic publish");
    }
    await publishSealedDirectoryNoReplace(
      outputDirectory,
      requestedOutputDirectory,
      atomicPublisher,
    );
    await syncDirectory(outputParent);
    return {
      ...ready,
      ...(productionReady
        ? { ready_artifact: finalRef }
        : { test_only_artifact: finalRef }),
      bundle_directory: requestedOutputDirectory,
    };
  } finally {
    await cleanupAtomicPublisher(atomicPublisher);
  }
}

/** Production entrypoint: verifier, code manifest, runtime pins and runPlan are non-injectable. */
export async function freezeWalmartListingIntegrityBundle(options) {
  return freezeWalmartListingIntegrityBundleCore(options, {}, true);
}

/**
 * Explicit unit-test harness. It can exercise fault paths with injected
 * dependencies but is structurally incapable of emitting READY.json.
 */
export async function freezeWalmartListingIntegrityBundleForTest(options, injected = {}) {
  return freezeWalmartListingIntegrityBundleCore(options, injected, false);
}

function bundleRelativePath(value, label) {
  const parsed = safeText(value, label, 16_384);
  if (path.isAbsolute(parsed) || parsed.includes("\\")
    || path.posix.normalize(parsed) !== parsed
    || parsed === "." || parsed.startsWith("../") || parsed.includes("/../")) {
    throw new Error(`${label} must be a normalized bundle-relative path`);
  }
  return parsed;
}

async function readBundleFileRef(root, rawRef, maximumBytes, label) {
  exactKeys(rawRef, ["path", "sha256"], label);
  const relative = bundleRelativePath(rawRef.path, `${label}.path`);
  const ref = {
    path: path.join(root, ...relative.split("/")),
    sha256: digest(rawRef.sha256, `${label}.sha256`),
  };
  const bytes = await readBoundFile(ref, maximumBytes, label);
  return { relative_ref: { path: relative, sha256: ref.sha256 }, bytes };
}

async function loadReadyBundleIssuerContext(bundleDirectory) {
  const rootInfo = await assertExistingPathHasNoSymlinks(
    bundleDirectory,
    "directory",
    "--bundle-dir",
  );
  if ((rootInfo.mode & 0o777) !== 0o500) {
    throw new Error("--bundle-dir must be the sealed mode-0500 family root");
  }
  const readyPath = path.join(bundleDirectory, "READY.json");
  const readyInfo = await assertExistingPathHasNoSymlinks(readyPath, "file", "READY.json");
  if ((readyInfo.mode & 0o777) !== 0o444 || readyInfo.size > MAX_JSON_BYTES) {
    throw new Error("READY.json must be a bounded read-only regular file");
  }
  const ready = parseJsonBytes(await readFile(readyPath), "READY.json");
  if (!isRecord(ready)
    || ready.schema_version !== WALMART_LISTING_INTEGRITY_READY_SCHEMA
    || ready.status !== "READY"
    || ready.freezer_version !== WALMART_LISTING_INTEGRITY_FREEZER_VERSION
    || ready.permit_directory !== "permits") {
    throw new Error("bundle does not contain a production READY family marker");
  }

  const frozenFreezerFile = await readBundleFileRef(
    bundleDirectory,
    ready.freezer_source,
    MAX_SPEC_BYTES,
    "READY.freezer_source",
  );
  if (frozenFreezerFile.relative_ref.path !== "code/freezer-source.mjs") {
    throw new Error("READY freezer source path is not canonical");
  }
  const currentFreezerPath = fileURLToPath(import.meta.url);
  const currentFreezerInfo = await assertExistingPathHasNoSymlinks(
    currentFreezerPath,
    "file",
    "current issuer source",
  );
  if (currentFreezerInfo.size > MAX_SPEC_BYTES) {
    throw new Error(`current issuer source exceeds ${MAX_SPEC_BYTES} bytes`);
  }
  const currentFreezerBytes = await readFile(currentFreezerPath);
  if (currentFreezerBytes.byteLength !== currentFreezerInfo.size
    || sha256Bytes(currentFreezerBytes) !== frozenFreezerFile.relative_ref.sha256) {
    throw new Error("current issuer bytes differ from READY freezer source");
  }

  const runLockFile = await readBundleFileRef(
    bundleDirectory,
    ready.run_lock,
    MAX_RUN_LOCK_BYTES,
    "READY.run_lock",
  );
  const runLock = parseRunLock(parseJsonBytes(runLockFile.bytes, "family run-lock"));
  if (runLock.run_id !== ready.run_id) throw new Error("READY/run-lock run_id mismatch");
  const readyAuthority = parseWalmartListingIntegrityOwnerExecutionAuthority(
    ready.owner_execution_authority,
    "READY.owner_execution_authority",
  );
  if (!canonicalEqual(readyAuthority, runLock.owner_execution_authority)) {
    throw new Error("READY owner execution authority differs from the immutable run-lock");
  }
  if (!canonicalEqual(ready.hard_source_freshness, runLock.hard_source_freshness)) {
    throw new Error("READY source freshness differs from the immutable run-lock");
  }

  const certificateFile = await readBundleFileRef(
    bundleDirectory,
    ready.preflight_certificate,
    MAX_JSON_BYTES,
    "READY.preflight_certificate",
  );
  const certificate = parseWalmartListingIntegrityPreflightCertificate(
    parseJsonBytes(certificateFile.bytes, "preflight certificate"),
  );
  if (certificate.body.run_lock_sha256 !== runLockFile.relative_ref.sha256
    || certificate.body.run_id !== runLock.run_id
    || !canonicalEqual(certificate.body.observer_partitions, runLock.observer_partitions)) {
    throw new Error("preflight certificate does not bind the exact frozen family/partitions");
  }

  const codeManifestFile = await readBundleFileRef(
    bundleDirectory,
    ready.code_bundle_manifest,
    MAX_JSON_BYTES,
    "READY.code_bundle_manifest",
  );
  await verifyCurrentCodeBundleManifest(
    parseJsonBytes(codeManifestFile.bytes, "code bundle manifest"),
  );
  return {
    bundle_directory: bundleDirectory,
    ready,
    run_lock_file: runLockFile,
    run_lock: runLock,
    owner_execution_authority: readyAuthority,
    preflight_certificate_file: certificateFile,
    preflight_certificate: certificate,
  };
}

async function readExternalOwnerAuthorization(file, context, now) {
  const authorizationPath = absoluteNormalizedPath(file, "--owner-authorization");
  const info = await assertExistingPathHasNoSymlinks(
    authorizationPath,
    "file",
    "--owner-authorization",
  );
  if ((info.mode & 0o777) !== 0o444 || info.size > MAX_SPEC_BYTES) {
    throw new Error("--owner-authorization must be a bounded mode-0444 regular file");
  }
  const bytes = await readFile(authorizationPath);
  if (bytes.byteLength !== info.size) throw new Error("--owner-authorization changed while read");
  const authorization = parseWalmartListingIntegrityOwnerExecutionAuthorization(
    parseJsonBytes(bytes, "owner authorization"),
    {
      owner_execution_authority: context.owner_execution_authority,
      run_lock: context.run_lock,
      run_lock_sha256: context.run_lock_file.relative_ref.sha256,
      run_id: context.run_lock.run_id,
      preflight_certificate_sha256: context.preflight_certificate_file.relative_ref.sha256,
    },
  );
  if (now !== undefined) {
    assertWalmartListingIntegrityOwnerAuthorizationIssuanceWindow(authorization, now);
  }
  return { authorization, exact_byte_sha256: sha256Bytes(bytes) };
}

async function ensureMode700Directory(directory, label) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = await assertExistingPathHasNoSymlinks(directory, "directory", label);
  if ((info.mode & 0o777) !== 0o700) throw new Error(`${label} must have mode 0700`);
}

async function reserveOwnerAuthorizationPartition({
  bundleDirectory,
  authorization,
  partitionId,
  reservedAt,
}) {
  const permitsDirectory = path.join(bundleDirectory, "permits");
  const permitsInfo = await assertExistingPathHasNoSymlinks(
    permitsDirectory,
    "directory",
    "bundle permits directory",
  );
  if ((permitsInfo.mode & 0o777) !== 0o700) {
    throw new Error("bundle permits directory must have mode 0700");
  }
  const ledgerRoot = path.join(permitsDirectory, "allowance-ledger");
  await ensureMode700Directory(ledgerRoot, "allowance ledger root");
  const authorizationDirectory = path.join(ledgerRoot, authorization.authorization_sha256);
  await ensureMode700Directory(authorizationDirectory, "authorization allowance ledger");

  const targetSequence = authorization.signed_body.partition_grants.findIndex((grant) => (
    grant.partition_id === partitionId
  ));
  if (targetSequence < 0) throw new Error("requested partition is absent from owner authorization");
  const entries = await readdir(authorizationDirectory, { withFileTypes: true });
  const ordered = entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  let previousReservationSha = authorization.authorization_sha256;
  for (let sequence = 0; sequence < ordered.length; sequence += 1) {
    const grant = authorization.signed_body.partition_grants[sequence];
    if (!grant) throw new Error("allowance ledger exceeds signed total call ceiling");
    const expectedName = `${String(sequence).padStart(6, "0")}-${grant.partition_id}.json`;
    const entry = ordered[sequence];
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== expectedName) {
      throw new Error("allowance ledger contains a non-canonical or non-append-only entry");
    }
    const eventPath = path.join(authorizationDirectory, entry.name);
    const eventInfo = await assertExistingPathHasNoSymlinks(
      eventPath,
      "file",
      `allowance ledger event ${sequence}`,
    );
    if ((eventInfo.mode & 0o777) !== 0o444 || eventInfo.size > MAX_SPEC_BYTES) {
      throw new Error(`allowance ledger event ${sequence} must be bounded immutable mode 0444`);
    }
    const eventBytes = await readFile(eventPath);
    if (eventBytes.byteLength !== eventInfo.size) {
      throw new Error(`allowance ledger event ${sequence} changed while read`);
    }
    const event = parseWalmartListingIntegrityAllowanceReservation(
      parseJsonBytes(eventBytes, `allowance ledger event ${sequence}`),
      {
        owner_authorization: authorization,
        previous_reservation_sha256: previousReservationSha,
      },
    );
    previousReservationSha = event.body_sha256;
  }
  if (targetSequence !== ordered.length) {
    throw new Error(
      targetSequence < ordered.length
        ? "owner authorization partition grant was already reserved and may never be reissued"
        : "owner authorization grants must be reserved in exact signed order",
    );
  }
  const reservation = buildWalmartListingIntegrityAllowanceReservation({
    owner_authorization: authorization,
    sequence: targetSequence,
    previous_reservation_sha256: previousReservationSha,
    reserved_at: reservedAt,
  });
  const relativePath = walmartListingIntegrityAllowanceReservationRelativePath(
    authorization.authorization_sha256,
    reservation,
  );
  const eventPath = path.join(bundleDirectory, ...relativePath.split("/"));
  const written = await writeGeneratedJson(
    path.dirname(eventPath),
    path.basename(eventPath),
    reservation,
  );
  await syncDirectory(authorizationDirectory);
  await syncDirectory(ledgerRoot);
  await syncDirectory(permitsDirectory);
  return {
    reservation,
    artifact: { path: relativePath, sha256: written.sha256 },
  };
}

async function assertNewOutputFile(file, label) {
  const output = absoluteNormalizedPath(file, label);
  await assertExistingPathHasNoSymlinks(path.dirname(output), "directory", `${label} parent`);
  try {
    await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  throw new Error(`${label} must not already exist`);
}

function ownerAuthorizationEnvelope(authority, signedBody) {
  return {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: authority.key_id,
    owner_public_key_spki_sha256: authority.public_key_spki_sha256,
    signed_body: signedBody,
  };
}

function ownerAuthorizationHumanReviewSummary(body, hardSourceFreshnessDeadline) {
  return {
    approval_id: body.approval_id,
    run_id: body.run_id,
    family_run_lock_sha256: body.run_lock_sha256,
    preflight_certificate_sha256: body.preflight_certificate_sha256,
    ordered_partition_grants: body.partition_grants,
    total_subscription_calls_authorized: body.total_call_ceiling,
    issued_at: body.issued_at,
    expires_at: body.expires_at,
    source_freshness_deadline: body.source_freshness_deadline,
    family_hard_source_freshness_deadline: hardSourceFreshnessDeadline,
    effective_deadline: new Date(Math.min(
      Date.parse(body.expires_at),
      Date.parse(body.source_freshness_deadline),
    )).toISOString(),
    one_reservation_per_partition: true,
    paid_api_calls: 0,
    openai_model_calls: 0,
    database_mutations: 0,
    marketplace_mutations: 0,
  };
}

function parseAuthorizationSigningRequest(raw, context) {
  const label = "authorization signing request";
  exactKeys(raw, [
    "schema_version", "bundle_binding", "authorization_envelope",
    "signing_message_base64", "human_review_summary",
  ], label);
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_AUTHORIZATION_REQUEST_SCHEMA) {
    throw new Error(`${label}.schema_version is unsupported`);
  }
  exactKeys(raw.bundle_binding, [
    "ready_schema_version", "run_id", "run_lock_sha256", "preflight_certificate_sha256",
  ], `${label}.bundle_binding`);
  const expectedBinding = {
    ready_schema_version: WALMART_LISTING_INTEGRITY_READY_SCHEMA,
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_file.relative_ref.sha256,
    preflight_certificate_sha256: context.preflight_certificate_file.relative_ref.sha256,
  };
  if (!canonicalEqual(raw.bundle_binding, expectedBinding)) {
    throw new Error(`${label} is bound to a different READY family`);
  }
  const envelope = raw.authorization_envelope;
  exactKeys(envelope, [
    "schema_version", "algorithm", "key_id", "owner_public_key_spki_sha256", "signed_body",
  ], `${label}.authorization_envelope`);
  if (envelope.schema_version !== WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA
    || envelope.algorithm !== WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM
    || envelope.key_id !== context.owner_execution_authority.key_id
    || envelope.owner_public_key_spki_sha256
      !== context.owner_execution_authority.public_key_spki_sha256) {
    throw new Error(`${label} authority differs from the immutable READY/run-lock key`);
  }
  const rebuiltBody = buildWalmartListingIntegrityOwnerExecutionAuthorizationBody({
    run_lock: context.run_lock,
    run_lock_sha256: context.run_lock_file.relative_ref.sha256,
    preflight_certificate_sha256: context.preflight_certificate_file.relative_ref.sha256,
    approval_id: envelope.signed_body?.approval_id,
    partition_ids: envelope.signed_body?.partition_grants?.map((grant) => grant.partition_id),
    issued_at: envelope.signed_body?.issued_at,
    expires_at: envelope.signed_body?.expires_at,
    source_freshness_deadline: envelope.signed_body?.source_freshness_deadline,
  });
  const normalizedEnvelope = ownerAuthorizationEnvelope(
    context.owner_execution_authority,
    rebuiltBody,
  );
  if (!canonicalEqual(envelope, normalizedEnvelope)) {
    throw new Error(`${label} signed body is not the canonical exact family grant set`);
  }
  const signingMessage = walmartListingIntegrityOwnerAuthorizationSigningMessage(
    normalizedEnvelope,
  ).toString("base64");
  if (raw.signing_message_base64 !== signingMessage
    || !canonicalEqual(
      raw.human_review_summary,
      ownerAuthorizationHumanReviewSummary(
        rebuiltBody,
        context.run_lock.hard_source_freshness.hard_deadline,
      ),
    )) {
    throw new Error(`${label} signing bytes or human review summary mismatch`);
  }
  return {
    schema_version: WALMART_LISTING_INTEGRITY_AUTHORIZATION_REQUEST_SCHEMA,
    bundle_binding: expectedBinding,
    authorization_envelope: normalizedEnvelope,
    signing_message_base64: signingMessage,
    human_review_summary: ownerAuthorizationHumanReviewSummary(
      rebuiltBody,
      context.run_lock.hard_source_freshness.hard_deadline,
    ),
  };
}

export async function createWalmartListingIntegrityOwnerAuthorizationRequest(
  options,
  injected = {},
) {
  const bundleDirectory = absoluteNormalizedPath(options.bundle_dir, "--bundle-dir");
  const output = await assertNewOutputFile(options.output, "--output");
  const context = await loadReadyBundleIssuerContext(bundleDirectory);
  const body = buildWalmartListingIntegrityOwnerExecutionAuthorizationBody({
    run_lock: context.run_lock,
    run_lock_sha256: context.run_lock_file.relative_ref.sha256,
    preflight_certificate_sha256: context.preflight_certificate_file.relative_ref.sha256,
    approval_id: options.approval_id,
    partition_ids: options.partition_ids,
    issued_at: options.issued_at,
    expires_at: options.expires_at,
    source_freshness_deadline: options.source_freshness_deadline,
  });
  const nowValue = (injected.now ?? (() => new Date()))();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(String(nowValue));
  if (!Number.isFinite(nowMs) || Date.parse(body.issued_at) > nowMs + 5 * 60_000) {
    throw new Error("authorization request issued_at is in the future beyond five-minute clock skew");
  }
  if (nowMs >= Math.min(Date.parse(body.expires_at), Date.parse(body.source_freshness_deadline))) {
    throw new Error("authorization request is already expired or source-stale");
  }
  const envelope = ownerAuthorizationEnvelope(context.owner_execution_authority, body);
  const request = parseAuthorizationSigningRequest({
    schema_version: WALMART_LISTING_INTEGRITY_AUTHORIZATION_REQUEST_SCHEMA,
    bundle_binding: {
      ready_schema_version: WALMART_LISTING_INTEGRITY_READY_SCHEMA,
      run_id: context.run_lock.run_id,
      run_lock_sha256: context.run_lock_file.relative_ref.sha256,
      preflight_certificate_sha256: context.preflight_certificate_file.relative_ref.sha256,
    },
    authorization_envelope: envelope,
    signing_message_base64: walmartListingIntegrityOwnerAuthorizationSigningMessage(
      envelope,
    ).toString("base64"),
    human_review_summary: ownerAuthorizationHumanReviewSummary(
      body,
      context.run_lock.hard_source_freshness.hard_deadline,
    ),
  }, context);
  const written = await writeGeneratedJson(path.dirname(output), path.basename(output), request);
  await syncDirectory(path.dirname(output));
  return {
    schema_version: WALMART_LISTING_INTEGRITY_AUTHORIZATION_REQUEST_SCHEMA,
    status: "OWNER_SIGNATURE_REQUIRED",
    signing_request: request,
    request_artifact: { path: output, sha256: written.sha256 },
  };
}

export async function assembleWalmartListingIntegrityOwnerAuthorization(
  options,
  injected = {},
) {
  const bundleDirectory = absoluteNormalizedPath(options.bundle_dir, "--bundle-dir");
  const requestPath = absoluteNormalizedPath(options.request, "--request");
  const signaturePath = absoluteNormalizedPath(options.signature, "--signature");
  const output = await assertNewOutputFile(options.output, "--output");
  const context = await loadReadyBundleIssuerContext(bundleDirectory);
  const requestInfo = await assertExistingPathHasNoSymlinks(requestPath, "file", "--request");
  if ((requestInfo.mode & 0o777) !== 0o444 || requestInfo.size > MAX_SPEC_BYTES) {
    throw new Error("--request must be a bounded immutable mode-0444 regular file");
  }
  const requestBytes = await readFile(requestPath);
  if (requestBytes.byteLength !== requestInfo.size) throw new Error("--request changed while read");
  const request = parseAuthorizationSigningRequest(
    parseJsonBytes(requestBytes, "authorization signing request"),
    context,
  );
  const signatureInfo = await assertExistingPathHasNoSymlinks(signaturePath, "file", "--signature");
  if (signatureInfo.size !== MAX_SIGNATURE_BYTES || (signatureInfo.mode & 0o222) !== 0) {
    throw new Error("--signature must be an immutable raw 64-byte detached Ed25519 signature");
  }
  const signatureBytes = await readFile(signaturePath);
  if (signatureBytes.byteLength !== MAX_SIGNATURE_BYTES) throw new Error("--signature changed while read");
  const nowValue = (injected.now ?? (() => new Date()))();
  const authorization = assembleWalmartListingIntegrityOwnerExecutionAuthorization({
    owner_execution_authority: context.owner_execution_authority,
    signed_body: request.authorization_envelope.signed_body,
    signature_base64: signatureBytes.toString("base64"),
    expected: {
      run_lock: context.run_lock,
      run_lock_sha256: context.run_lock_file.relative_ref.sha256,
      run_id: context.run_lock.run_id,
      preflight_certificate_sha256: context.preflight_certificate_file.relative_ref.sha256,
      now: nowValue,
    },
  });
  const written = await writeGeneratedJson(
    path.dirname(output),
    path.basename(output),
    authorization,
  );
  await syncDirectory(path.dirname(output));
  return {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    status: "OWNER_AUTHORIZATION_READY",
    approval_id: authorization.signed_body.approval_id,
    authorization_sha256: authorization.authorization_sha256,
    authorization_artifact: { path: output, sha256: written.sha256 },
  };
}

/** Consume one signed partition grant exactly once without changing the family SHA. */
export async function issueWalmartListingIntegrityExecutionPermit(options, injected = {}) {
  const bundleDirectory = absoluteNormalizedPath(options.bundle_dir, "--bundle-dir");
  const partitionId = safeId(options.partition_id, "--partition-id");
  const context = await loadReadyBundleIssuerContext(bundleDirectory);
  const runLock = context.run_lock;
  const runLockFile = context.run_lock_file;
  const certificateFile = context.preflight_certificate_file;
  const partition = runLock.observer_partitions.find((row) => row.partition_id === partitionId);
  if (!partition) throw new Error("--partition-id is not present in the frozen family");

  const nowValue = (injected.now ?? (() => new Date()))();
  const createdAt = nowValue instanceof Date
    ? nowValue.toISOString()
    : canonicalTimestamp(String(nowValue), "permit clock");
  const loadedAuthorization = await readExternalOwnerAuthorization(
    options.owner_authorization,
    context,
    nowValue,
  );
  const reservation = await reserveOwnerAuthorizationPartition({
    bundleDirectory,
    authorization: loadedAuthorization.authorization,
    partitionId,
    reservedAt: createdAt,
  });
  const body = buildWalmartListingIntegrityExecutionPermitBody({
    run_lock: runLock,
    run_lock_sha256: runLockFile.relative_ref.sha256,
    run_id: runLock.run_id,
    partition,
    preflight_certificate_sha256: certificateFile.relative_ref.sha256,
    created_at: createdAt,
    owner_authorization: loadedAuthorization.authorization,
    allowance_reservation: reservation.reservation,
  });
  const permit = parseWalmartListingIntegrityExecutionPermit({
    sha256: sha256Bytes(Buffer.from(canonicalJson(body), "utf8")),
    body,
  }, {
    run_lock: runLock,
    owner_execution_authority: runLock.owner_execution_authority,
    run_lock_sha256: runLockFile.relative_ref.sha256,
    run_id: runLock.run_id,
    partition,
    preflight_certificate_sha256: certificateFile.relative_ref.sha256,
    family_created_at: runLock.created_at,
  });

  const permitsDirectory = path.join(bundleDirectory, "permits");
  const permitsInfo = await assertExistingPathHasNoSymlinks(
    permitsDirectory,
    "directory",
    "bundle permits directory",
  );
  if ((permitsInfo.mode & 0o777) !== 0o700) {
    throw new Error("bundle permits directory must have mode 0700");
  }
  const partitionDirectory = path.join(permitsDirectory, partition.partition_id);
  try {
    await mkdir(partitionDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const partitionInfo = await assertExistingPathHasNoSymlinks(
    partitionDirectory,
    "directory",
    "partition permit directory",
  );
  if ((partitionInfo.mode & 0o777) !== 0o700) {
    throw new Error("partition permit directory must have mode 0700");
  }
  const filename = `${permit.body.permit_id}.json`;
  const written = await writeGeneratedJson(
    partitionDirectory,
    filename,
    permit,
  );
  await syncDirectory(partitionDirectory);
  await syncDirectory(permitsDirectory);
  return {
    schema_version: WALMART_LISTING_INTEGRITY_EXECUTION_PERMIT_SCHEMA,
    status: "PERMIT_READY",
    run_id: runLock.run_id,
    run_lock_sha256: runLockFile.relative_ref.sha256,
    partition_id: partition.partition_id,
    partition_index: partition.partition_index,
    shard_ids: partition.shard_ids,
    call_indexes: reservation.reservation.body.call_indexes,
    call_ceiling: reservation.reservation.body.call_ceiling,
    approval_id: loadedAuthorization.authorization.signed_body.approval_id,
    owner_authorization_sha256: loadedAuthorization.authorization.authorization_sha256,
    permit,
    allowance_reservation_artifact: reservation.artifact,
    permit_artifact: {
      path: `permits/${partition.partition_id}/${filename}`,
      sha256: written.sha256,
    },
  };
}

function parseFlag(argument) {
  const equals = argument.indexOf("=");
  if (!argument.startsWith("--") || equals <= 2) throw new Error(`unsupported argument: ${argument}`);
  return [argument.slice(2, equals), argument.slice(equals + 1)];
}

export function parseWalmartListingIntegrityFreezerCli(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return { help: true };
  const commands = ["freeze", "authorization-request", "authorization-assemble", "permit"];
  if (argv.length === 2
    && commands.includes(argv[0])
    && argv[1] === "--help") return { help: true };
  if (!commands.includes(argv[0])) {
    throw new Error("first argument must be freeze, authorization-request, authorization-assemble, permit, or --help");
  }
  const command = argv[0];
  const flags = new Map();
  for (const argument of argv.slice(1)) {
    const [name, value] = parseFlag(argument);
    if (flags.has(name)) throw new Error(`--${name} was repeated`);
    flags.set(name, value);
  }
  const allowed = command === "freeze"
    ? new Set(["spec", "output-dir"])
    : command === "permit"
      ? new Set(["bundle-dir", "partition-id", "owner-authorization"])
      : command === "authorization-request"
        ? new Set([
          "bundle-dir", "approval-id", "partition-ids", "issued-at", "expires-at",
          "source-freshness-deadline", "output",
        ])
        : new Set(["bundle-dir", "request", "signature", "output"]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) throw new Error(`unsupported flag for ${command}: --${name}`);
  }
  if (command === "freeze") {
    if (!flags.has("spec") || !flags.has("output-dir")) {
      throw new Error("freeze requires --spec=... and --output-dir=...");
    }
    return {
      help: false,
      command,
      spec_path: absoluteNormalizedPath(flags.get("spec"), "--spec"),
      output_dir: absoluteNormalizedPath(flags.get("output-dir"), "--output-dir"),
    };
  }
  for (const name of allowed) {
    if (!flags.has(name)) throw new Error(`${command} requires --${name}=...`);
  }
  if (command === "permit") {
    return {
      help: false,
      command,
      bundle_dir: absoluteNormalizedPath(flags.get("bundle-dir"), "--bundle-dir"),
      partition_id: safeId(flags.get("partition-id"), "--partition-id"),
      owner_authorization: absoluteNormalizedPath(
        flags.get("owner-authorization"),
        "--owner-authorization",
      ),
    };
  }
  if (command === "authorization-request") {
    const partitionIds = safeText(flags.get("partition-ids"), "--partition-ids", 16_384)
      .split(",")
      .map((value, index) => safeId(value, `--partition-ids[${index}]`));
    if (new Set(partitionIds).size !== partitionIds.length) {
      throw new Error("--partition-ids contains duplicates");
    }
    return {
      help: false,
      command,
      bundle_dir: absoluteNormalizedPath(flags.get("bundle-dir"), "--bundle-dir"),
      approval_id: safeId(flags.get("approval-id"), "--approval-id"),
      partition_ids: partitionIds,
      issued_at: canonicalTimestamp(flags.get("issued-at"), "--issued-at"),
      expires_at: canonicalTimestamp(flags.get("expires-at"), "--expires-at"),
      source_freshness_deadline: canonicalTimestamp(
        flags.get("source-freshness-deadline"),
        "--source-freshness-deadline",
      ),
      output: absoluteNormalizedPath(flags.get("output"), "--output"),
    };
  }
  return {
    help: false,
    command,
    bundle_dir: absoluteNormalizedPath(flags.get("bundle-dir"), "--bundle-dir"),
    request: absoluteNormalizedPath(flags.get("request"), "--request"),
    signature: absoluteNormalizedPath(flags.get("signature"), "--signature"),
    output: absoluteNormalizedPath(flags.get("output"), "--output"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseWalmartListingIntegrityFreezerCli(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = options.command === "freeze"
    ? await freezeWalmartListingIntegrityBundle(options)
    : options.command === "authorization-request"
      ? await createWalmartListingIntegrityOwnerAuthorizationRequest(options)
      : options.command === "authorization-assemble"
        ? await assembleWalmartListingIntegrityOwnerAuthorization(options)
        : await issueWalmartListingIntegrityExecutionPermit(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
