#!/usr/bin/env -S node --experimental-strip-types

/**
 * Execution-only, offline Walmart listing-integrity adjudicator.
 *
 * This program does not capture marketplace data and does not call a model. A
 * separately frozen run-lock chooses every source byte, image, model view,
 * observation shard, and listing. This CLI can only:
 *
 *   plan   validate the locked local inputs without writing anything;
 *   audit  rebuild source-aware decisions and create immutable report files;
 *   verify rebuild every report against the same locked bytes.
 *
 * There are deliberately no network, database, marketplace, or model clients
 * in this file.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLIND_PROMPT_VERSION,
} from "../src/lib/walmart/catalog-visual-audit.ts";
import {
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../src/lib/walmart/catalog-visual-preprocess.ts";
import {
  WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
  WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
  WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
  compileWalmartListingIntegrityReportAgainstSources,
  verifyWalmartListingIntegrityReportAgainstSources,
} from "../src/lib/walmart/listing-integrity-audit.ts";
import {
  WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
  WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA,
  WALMART_LISTING_OBSERVER_VERSION,
  WALMART_LISTING_WORKER_REQUEST_SCHEMA,
  parseWalmartListingWorkerReservationLedgerContract,
  verifyWalmartListingObservationArtifact,
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationPromptSha256,
  walmartListingObservationSha256,
} from "../src/lib/walmart/listing-integrity-observation.ts";
import { LOCAL_VISUAL_OCR_ENGINE } from "../src/lib/walmart/local-visual-ocr.ts";
import {
  verifyWalmartCatalogTruthAuditExportAgainstSources,
} from "../src/lib/walmart/catalog-truth-export.ts";
import {
  verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture,
} from "../src/lib/walmart/item-report-published-source.ts";

export const WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA =
  "walmart-listing-integrity-run-lock/v4";
export const WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE =
  "same-schema-empty-evidence/v1";
export const WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION =
  "walmart-listing-integrity-offline-executor/v4";
export const WALMART_LISTING_INTEGRITY_CODE_BUNDLE_SCHEMA =
  "walmart-listing-integrity-code-bundle/v1";
export const WALMART_LISTING_INTEGRITY_EXECUTION_PERMIT_SCHEMA =
  "walmart-listing-integrity-execution-permit/v3";
export const WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA =
  "walmart-listing-integrity-owner-execution-authorization/v1";
export const WALMART_LISTING_INTEGRITY_ALLOWANCE_RESERVATION_SCHEMA =
  "walmart-listing-integrity-allowance-reservation/v1";
export const WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM = "Ed25519";
export const WALMART_LISTING_INTEGRITY_SOURCE_FRESHNESS_SCHEMA =
  "walmart-listing-integrity-source-freshness/v1";
export const WALMART_LISTING_INTEGRITY_PREFLIGHT_CERTIFICATE_SCHEMA =
  "walmart-listing-integrity-preflight-certificate/v1";
export const WALMART_LISTING_INTEGRITY_PLAN_SCHEMA =
  "walmart-listing-integrity-execution-plan/v2";

// A 10k-shard minimal family is already ~17 MB. Keep the cap bounded while
// leaving headroom for real multi-image listing refs and partition metadata.
const MAX_RUN_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_OBSERVER_ATTEMPT_BYTES = 1024 * 1024;
const MAX_OBSERVATION_BYTES = 64 * 1024 * 1024;
const WALMART_LISTING_OBSERVER_ATTEMPT_SCHEMA =
  "walmart-listing-observation-attempt/v3";
const WALMART_LISTING_OBSERVER_EXECUTOR_VERSION =
  "walmart-listing-observer-executor/v3";
const MAX_JSON_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_LISTINGS = 10_000;
const MAX_ASSETS_PER_LISTING = 100;
const MAX_SHARDS = 100_000;
const MAX_IMAGES_PER_SHARD = 6;
const MAX_CODE_FILE_BYTES = 32 * 1024 * 1024;
const EXECUTION_PERMIT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_SOURCE_TO_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const OWNER_AUTHORIZATION_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const LOCKED_VISION_TIMEOUT_MS = 180_000;
const LOCKED_OBSERVER_RESPONSE_MARGIN_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IMAGE_ID_PATTERN = /^i_[a-z0-9][a-z0-9_-]{1,127}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIED_EXECUTION_PERMIT = Symbol("verifiedWalmartListingIntegrityExecutionPermit");
const OWNER_AUTHORIZATION_SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_LISTING_INTEGRITY_OWNER_EXECUTION_AUTHORIZATION\0v1\0",
  "utf8",
);

// This is deliberately an exact allow-list, not an open-ended manifest. A
// newly imported production module therefore makes the old bundle fail closed
// until Codex explicitly reviews and pins it.
export const WALMART_LISTING_INTEGRITY_REQUIRED_CODE_FILES = Object.freeze([
  "ops/codex-image-worker/image-preflight.js",
  "ops/codex-image-worker/prompt.js",
  "ops/codex-image-worker/server.js",
  "ops/codex-image-worker/vision-contract.js",
  "package-lock.json",
  "package.json",
  "scripts/capture-walmart-item-report-source.mjs",
  "scripts/walmart-listing-integrity-engine.mjs",
  "scripts/walmart-listing-integrity-observer.mjs",
  "scripts/walmart-visual-ocr.swift",
  "src/lib/walmart/buyer-facing-snapshot.ts",
  "src/lib/walmart/catalog-gallery-audit.ts",
  "src/lib/walmart/catalog-truth-export.ts",
  "src/lib/walmart/catalog-visual-audit.ts",
  "src/lib/walmart/catalog-visual-preprocess.ts",
  "src/lib/walmart/catalog-visual-truth-preflight.ts",
  "src/lib/walmart/exact-item-resolution.ts",
  "src/lib/walmart/item-report-published-source.ts",
  "src/lib/walmart/item-report-capture-session.ts",
  "src/lib/walmart/listing-integrity-audit.ts",
  "src/lib/walmart/listing-integrity-observation.ts",
  "src/lib/walmart/local-visual-ocr.ts",
].sort());

const HELP = `Usage:
  node --experimental-strip-types scripts/walmart-listing-integrity-engine.mjs plan \\
    --run-lock=/absolute/path/run-lock.json \\
    --expect-run-lock-sha256=<lowercase-sha256>

  node --experimental-strip-types scripts/walmart-listing-integrity-engine.mjs audit \\
    --run-lock=/absolute/path/run-lock.json \\
    --expect-run-lock-sha256=<lowercase-sha256> \\
    --preflight-certificate=/absolute/path/preflight-certificate.json \\
    --expect-preflight-certificate-sha256=<lowercase-sha256> \\
    --output-dir=/absolute/new/report-directory

  node --experimental-strip-types scripts/walmart-listing-integrity-engine.mjs verify \\
    --run-lock=/absolute/path/run-lock.json \\
    --expect-run-lock-sha256=<lowercase-sha256> \\
    --preflight-certificate=/absolute/path/preflight-certificate.json \\
    --expect-preflight-certificate-sha256=<lowercase-sha256> \\
    --reports-dir=/absolute/report-directory \\
    --require-complete

Commands are offline and execution-only. They never call a model, network,
database, or marketplace API. audit creates only exclusive (wx) local reports.
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

function safeString(value, label, maximum = 10_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function safeId(value, label) {
  const parsed = safeString(value, label, 128);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} has an invalid identifier format`);
  return parsed;
}

function sha256String(value, label) {
  const parsed = safeString(value, label, 64);
  if (!SHA256_PATTERN.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`);
  return parsed;
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = safeString(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function workerAnalyzeUrl(value, label) {
  const raw = safeString(value, label, 2_048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.toString() !== raw || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.pathname.endsWith("/analyze-claude")
    || parsed.pathname.endsWith("/analyze-claude/")) {
    throw new Error(`${label} must be canonical, credential-free, and end in /analyze-claude`);
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
    || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for loopback)`);
  }
  return raw;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
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

function exactJsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalBase64(value, label, maximum = 16_384) {
  const parsed = safeString(value, label, maximum);
  if (/\s/u.test(parsed)) throw new Error(`${label} must be canonical base64 without whitespace`);
  let bytes;
  try {
    bytes = Buffer.from(parsed, "base64");
  } catch {
    throw new Error(`${label} must be canonical base64`);
  }
  if (bytes.byteLength < 1 || bytes.toString("base64") !== parsed) {
    throw new Error(`${label} must be canonical base64`);
  }
  return { value: parsed, bytes };
}

/** Parse the one external owner key pinned into an immutable family. */
export function parseWalmartListingIntegrityOwnerExecutionAuthority(raw, label = "owner_execution_authority") {
  exactKeys(raw, [
    "algorithm", "key_id", "public_key_spki_der_base64", "public_key_spki_sha256",
  ], label);
  if (raw.algorithm !== WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM) {
    throw new Error(`${label}.algorithm must be Ed25519`);
  }
  const encoded = canonicalBase64(
    raw.public_key_spki_der_base64,
    `${label}.public_key_spki_der_base64`,
  );
  const fingerprint = sha256String(
    raw.public_key_spki_sha256,
    `${label}.public_key_spki_sha256`,
  );
  if (sha256Bytes(encoded.bytes) !== fingerprint) {
    throw new Error(`${label} public-key fingerprint mismatch`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: encoded.bytes, format: "der", type: "spki" });
  } catch {
    throw new Error(`${label} public key is not valid SPKI DER`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} public key must be Ed25519`);
  }
  return {
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: safeId(raw.key_id, `${label}.key_id`),
    public_key_spki_der_base64: encoded.value,
    public_key_spki_sha256: fingerprint,
  };
}

export function parseWalmartListingIntegritySourceFreshness(raw, label = "source_freshness") {
  exactKeys(raw, [
    "schema_version", "maximum_age_ms", "authoritative_scope_captured_at",
    "product_truth_snapshot_captured_at", "buyer_index_captured_at",
    "oldest_locked_buyer_snapshot_captured_at", "locked_buyer_snapshot_count",
    "hard_deadline",
  ], label);
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_SOURCE_FRESHNESS_SCHEMA
    || raw.maximum_age_ms !== MAX_SOURCE_TO_DEADLINE_MS) {
    throw new Error(`${label} schema/maximum age differs from the immutable 24h policy`);
  }
  const timestamps = {
    authoritative_scope_captured_at: canonicalTimestamp(
      raw.authoritative_scope_captured_at,
      `${label}.authoritative_scope_captured_at`,
    ),
    product_truth_snapshot_captured_at: canonicalTimestamp(
      raw.product_truth_snapshot_captured_at,
      `${label}.product_truth_snapshot_captured_at`,
    ),
    buyer_index_captured_at: canonicalTimestamp(
      raw.buyer_index_captured_at,
      `${label}.buyer_index_captured_at`,
    ),
    oldest_locked_buyer_snapshot_captured_at: canonicalTimestamp(
      raw.oldest_locked_buyer_snapshot_captured_at,
      `${label}.oldest_locked_buyer_snapshot_captured_at`,
    ),
  };
  const expectedDeadline = new Date(
    Math.min(...Object.values(timestamps).map((value) => Date.parse(value)))
      + MAX_SOURCE_TO_DEADLINE_MS,
  ).toISOString();
  const hardDeadline = canonicalTimestamp(raw.hard_deadline, `${label}.hard_deadline`);
  if (hardDeadline !== expectedDeadline) {
    throw new Error(`${label}.hard_deadline is not derived from the oldest exact source +24h`);
  }
  return {
    schema_version: WALMART_LISTING_INTEGRITY_SOURCE_FRESHNESS_SCHEMA,
    maximum_age_ms: MAX_SOURCE_TO_DEADLINE_MS,
    ...timestamps,
    locked_buyer_snapshot_count: safeInteger(
      raw.locked_buyer_snapshot_count,
      `${label}.locked_buyer_snapshot_count`,
      1,
    ),
    hard_deadline: hardDeadline,
  };
}

export function buildWalmartListingIntegritySourceFreshness({
  authoritative_scope_captured_at: authoritativeScopeCapturedAt,
  product_truth_snapshot_captured_at: productTruthSnapshotCapturedAt,
  buyer_index_captured_at: buyerIndexCapturedAt,
  locked_buyer_snapshot_captured_ats: lockedBuyerSnapshotCapturedAts,
}) {
  if (!Array.isArray(lockedBuyerSnapshotCapturedAts) || lockedBuyerSnapshotCapturedAts.length < 1) {
    throw new Error("source freshness requires every locked buyer snapshot timestamp");
  }
  const locked = lockedBuyerSnapshotCapturedAts.map((value, index) => (
    canonicalTimestamp(value, `locked_buyer_snapshot_captured_ats[${index}]`)
  ));
  const oldestLocked = locked.reduce((oldest, value) => (
    Date.parse(value) < Date.parse(oldest) ? value : oldest
  ));
  const input = {
    schema_version: WALMART_LISTING_INTEGRITY_SOURCE_FRESHNESS_SCHEMA,
    maximum_age_ms: MAX_SOURCE_TO_DEADLINE_MS,
    authoritative_scope_captured_at: authoritativeScopeCapturedAt,
    product_truth_snapshot_captured_at: productTruthSnapshotCapturedAt,
    buyer_index_captured_at: buyerIndexCapturedAt,
    oldest_locked_buyer_snapshot_captured_at: oldestLocked,
    locked_buyer_snapshot_count: locked.length,
  };
  const parsedTimestamps = [
    canonicalTimestamp(authoritativeScopeCapturedAt, "authoritative_scope_captured_at"),
    canonicalTimestamp(productTruthSnapshotCapturedAt, "product_truth_snapshot_captured_at"),
    canonicalTimestamp(buyerIndexCapturedAt, "buyer_index_captured_at"),
    oldestLocked,
  ];
  return parseWalmartListingIntegritySourceFreshness({
    ...input,
    hard_deadline: new Date(
      Math.min(...parsedTimestamps.map((value) => Date.parse(value)))
        + MAX_SOURCE_TO_DEADLINE_MS,
    ).toISOString(),
  });
}

function absoluteCliPath(value, label) {
  const raw = safeString(value, label, 16_384);
  if (!path.isAbsolute(raw)) throw new Error(`${label} must be absolute`);
  if (path.resolve(raw) !== raw) {
    throw new Error(`${label} must be normalized and may not contain traversal segments`);
  }
  return raw;
}

function relativeLockedPath(value, label) {
  const raw = safeString(value, label, 4_096);
  if (path.isAbsolute(raw) || raw.includes("\\")) {
    throw new Error(`${label} must be a POSIX relative path`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} may not contain empty or traversal segments`);
  }
  if (path.posix.normalize(raw) !== raw) throw new Error(`${label} must be normalized`);
  return raw;
}

function parseFileRef(value, label) {
  exactKeys(value, ["path", "sha256"], label);
  return {
    path: relativeLockedPath(value.path, `${label}.path`),
    sha256: sha256String(value.sha256, `${label}.sha256`),
  };
}

function parseAuthoritativeItemReportCaptureRefs(value) {
  const label = "run_lock.source_artifacts.authoritative_item_report_capture";
  const keys = [
    "create_request_manifest", "create_response_payload",
    "ready_status_request_manifest", "ready_status_payload",
    "download_locator_request_manifest", "download_locator_response_payload",
    "report_file_request_manifest", "downloaded_body",
    "http_create_response", "http_ready_status_response",
    "http_download_locator_response", "http_download_response", "trusted_context",
  ];
  exactKeys(value, keys, label);
  return Object.fromEntries(keys.map((key) => [
    key,
    parseFileRef(value[key], `${label}.${key}`),
  ]));
}

function parseAssetRef(value, label) {
  exactKeys(value, ["slot", "buyer_asset", "model_view", "image_id"], label);
  const slot = safeString(value.slot, `${label}.slot`, 64);
  if (slot !== "main" && !/^gallery-[1-9]\d*$/u.test(slot)) {
    throw new Error(`${label}.slot must be main or gallery-N`);
  }
  const imageId = safeString(value.image_id, `${label}.image_id`, 130);
  if (!IMAGE_ID_PATTERN.test(imageId)) throw new Error(`${label}.image_id is invalid`);
  return {
    slot,
    buyer_asset: parseFileRef(value.buyer_asset, `${label}.buyer_asset`),
    model_view: parseFileRef(value.model_view, `${label}.model_view`),
    image_id: imageId,
  };
}

function parseListingRef(value, index) {
  const label = `run_lock.listings[${index}]`;
  exactKeys(value, [
    "listing_key", "item_id", "base_input", "surface_snapshot",
    "buyer_snapshot_manifest", "seller_item_payload", "catalog_search_payload",
    "buyer_pdp_payload", "assets", "shard_ids",
  ], label);
  const listingKey = safeString(value.listing_key, `${label}.listing_key`, 1_000);
  if (!/^walmart:[1-9]\d*:.+$/u.test(listingKey)) {
    throw new Error(`${label}.listing_key must preserve exact walmart:storeIndex:rawSku scope`);
  }
  const itemId = safeString(value.item_id, `${label}.item_id`, 64);
  if (!/^\d+$/u.test(itemId)) throw new Error(`${label}.item_id must be numeric`);
  if (!Array.isArray(value.assets) || value.assets.length < 1
    || value.assets.length > MAX_ASSETS_PER_LISTING) {
    throw new Error(`${label}.assets must contain 1..${MAX_ASSETS_PER_LISTING} rows`);
  }
  const assets = value.assets.map((asset, assetIndex) => (
    parseAssetRef(asset, `${label}.assets[${assetIndex}]`)
  ));
  for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
    const expectedSlot = assetIndex === 0 ? "main" : `gallery-${assetIndex}`;
    if (assets[assetIndex].slot !== expectedSlot) {
      throw new Error(`${label}.assets must be ordered main then contiguous gallery slots`);
    }
  }
  if (new Set(assets.map((asset) => asset.image_id)).size !== assets.length) {
    throw new Error(`${label}.assets image_id values must be unique within a listing`);
  }
  if (!Array.isArray(value.shard_ids) || value.shard_ids.length < 1
    || value.shard_ids.length > assets.length) {
    throw new Error(`${label}.shard_ids must contain 1..asset-count identifiers`);
  }
  const shardIds = value.shard_ids.map((entry, shardIndex) => (
    safeId(entry, `${label}.shard_ids[${shardIndex}]`)
  ));
  if (new Set(shardIds).size !== shardIds.length) throw new Error(`${label}.shard_ids contains duplicates`);
  return {
    listing_key: listingKey,
    item_id: itemId,
    base_input: parseFileRef(value.base_input, `${label}.base_input`),
    surface_snapshot: parseFileRef(value.surface_snapshot, `${label}.surface_snapshot`),
    buyer_snapshot_manifest: parseFileRef(
      value.buyer_snapshot_manifest,
      `${label}.buyer_snapshot_manifest`,
    ),
    seller_item_payload: parseFileRef(
      value.seller_item_payload,
      `${label}.seller_item_payload`,
    ),
    catalog_search_payload: parseFileRef(
      value.catalog_search_payload,
      `${label}.catalog_search_payload`,
    ),
    buyer_pdp_payload: parseFileRef(
      value.buyer_pdp_payload,
      `${label}.buyer_pdp_payload`,
    ),
    assets,
    shard_ids: shardIds,
  };
}

function parseShardImage(value, label) {
  exactKeys(value, [
    "listing_key", "item_id", "slot", "asset_sha256", "model_view_sha256", "image_id",
  ], label);
  const slot = safeString(value.slot, `${label}.slot`, 64);
  if (slot !== "main" && !/^gallery-[1-9]\d*$/u.test(slot)) {
    throw new Error(`${label}.slot must be main or gallery-N`);
  }
  const imageId = safeString(value.image_id, `${label}.image_id`, 130);
  if (!IMAGE_ID_PATTERN.test(imageId)) throw new Error(`${label}.image_id is invalid`);
  const listingKey = safeString(value.listing_key, `${label}.listing_key`, 1_000);
  const assetSha = sha256String(value.asset_sha256, `${label}.asset_sha256`);
  if (imageId !== walmartListingObservationImageId(assetSha, slot, listingKey)) {
    throw new Error(`${label}.image_id is not derived from listing/slot/asset SHA`);
  }
  return {
    listing_key: listingKey,
    item_id: safeString(value.item_id, `${label}.item_id`, 64),
    slot,
    asset_sha256: assetSha,
    model_view_sha256: sha256String(value.model_view_sha256, `${label}.model_view_sha256`),
    image_id: imageId,
  };
}

function parseShard(value, index) {
  const label = `run_lock.shards[${index}]`;
  exactKeys(value, [
    "shard_id", "call_index", "observation_batch_path", "prompt_sha256", "images",
  ], label);
  if (!Array.isArray(value.images) || value.images.length < 1
    || value.images.length > MAX_IMAGES_PER_SHARD) {
    throw new Error(`${label}.images must contain 1..${MAX_IMAGES_PER_SHARD} rows`);
  }
  const images = value.images.map((image, imageIndex) => (
    parseShardImage(image, `${label}.images[${imageIndex}]`)
  ));
  if (new Set(images.map((image) => image.image_id)).size !== images.length) {
    throw new Error(`${label}.images contains duplicate image_id values`);
  }
  const callIndex = safeInteger(value.call_index, `${label}.call_index`);
  const canonicalSuffix = String(callIndex).padStart(6, "0");
  const shardId = safeId(value.shard_id, `${label}.shard_id`);
  const observationBatchPath = relativeLockedPath(
    value.observation_batch_path,
    `${label}.observation_batch_path`,
  );
  if (shardId !== `shard-${canonicalSuffix}`
    || observationBatchPath !== `observations/call-${canonicalSuffix}.json`) {
    throw new Error(`${label} shard_id/observation_batch_path are not canonical for call_index`);
  }
  const promptSha = sha256String(value.prompt_sha256, `${label}.prompt_sha256`);
  if (promptSha !== walmartListingObservationPromptSha256(images.map((image) => image.image_id))) {
    throw new Error(`${label}.prompt_sha256 does not rebuild from locked image IDs`);
  }
  return {
    shard_id: shardId,
    call_index: callIndex,
    observation_batch_path: observationBatchPath,
    prompt_sha256: promptSha,
    images,
  };
}

/** Stable partition identity derived only from its ordered global shard membership. */
export function walmartListingIntegrityObserverPartitionId(partitionIndex, shardIds) {
  const index = safeInteger(partitionIndex, "partition_index");
  if (!Array.isArray(shardIds) || shardIds.length < 1 || shardIds.length > 6) {
    throw new Error("partition shard_ids must contain 1..6 rows");
  }
  const parsedIds = shardIds.map((value, shardIndex) => (
    safeId(value, `partition.shard_ids[${shardIndex}]`)
  ));
  if (new Set(parsedIds).size !== parsedIds.length) {
    throw new Error("partition shard_ids contains duplicates");
  }
  const digest = sha256Bytes(Buffer.from(canonicalJson({
    partition_index: index,
    shard_ids: parsedIds,
  }), "utf8"));
  return `partition-${String(index).padStart(6, "0")}-${digest.slice(0, 16)}`;
}

function parseObserverPartitions(value, shards) {
  const expectedCount = Math.ceil(shards.length / 6);
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`run_lock.observer_partitions must contain exactly ${expectedCount} deterministic rows`);
  }
  const partitions = value.map((raw, index) => {
    const label = `run_lock.observer_partitions[${index}]`;
    exactKeys(raw, ["partition_id", "partition_index", "shard_ids"], label);
    const partitionIndex = safeInteger(raw.partition_index, `${label}.partition_index`);
    if (partitionIndex !== index) {
      throw new Error(`${label}.partition_index must be contiguous from zero`);
    }
    if (!Array.isArray(raw.shard_ids) || raw.shard_ids.length < 1
      || raw.shard_ids.length > 6) {
      throw new Error(`${label}.shard_ids must contain 1..6 rows`);
    }
    const shardIds = raw.shard_ids.map((entry, shardIndex) => (
      safeId(entry, `${label}.shard_ids[${shardIndex}]`)
    ));
    const expectedShardIds = shards
      .slice(index * 6, Math.min(shards.length, (index + 1) * 6))
      .map((shard) => shard.shard_id);
    if (!exactJsonEqual(shardIds, expectedShardIds)) {
      throw new Error(`${label}.shard_ids must be the exact deterministic global shard-order chunk`);
    }
    const expectedId = walmartListingIntegrityObserverPartitionId(index, shardIds);
    if (raw.partition_id !== expectedId) {
      throw new Error(`${label}.partition_id is not derived from its ordered shard membership`);
    }
    return {
      partition_id: expectedId,
      partition_index: index,
      shard_ids: shardIds,
    };
  });
  const flattened = partitions.flatMap((partition) => partition.shard_ids);
  if (!exactJsonEqual(flattened, shards.map((shard) => shard.shard_id))) {
    throw new Error("run_lock.observer_partitions are not disjoint and exhaustive");
  }
  return partitions;
}

function parseObserverContract(value) {
  const label = "run_lock.observer_contract";
  exactKeys(value, [
    "provider", "model", "observer_version", "observation_schema_version", "prompt_version",
    "preprocessor_version", "local_ocr_engine", "local_ocr_script_sha256", "worker_build_sha256",
    "worker_receipt_key_id", "worker_receipt_public_key_sha256",
    "worker_analyze_url",
    "vision_timeout_ms", "observer_response_margin_ms",
    "swift_executable_sha256", "xcrun_executable_sha256",
    "swift_version_output_sha256", "macos_sdk_path_sha256", "macos_sdk_version",
    "cli_version", "node_version", "platform", "arch", "health_attestation_required",
    "response_attestation_required", "attempt_count", "fallback_allowed", "max_images_per_call",
    "reservation_ledger",
  ], label);
  if (value.provider !== "claude_cli_subscription" || value.model !== "sonnet") {
    throw new Error(`${label} must lock claude_cli_subscription/sonnet`);
  }
  if (value.prompt_version !== BLIND_PROMPT_VERSION) {
    throw new Error(`${label}.prompt_version must equal ${BLIND_PROMPT_VERSION}`);
  }
  if (value.observer_version !== WALMART_LISTING_OBSERVER_VERSION
    || value.observation_schema_version !== WALMART_LISTING_OBSERVATION_BATCH_SCHEMA
    || value.local_ocr_engine !== LOCAL_VISUAL_OCR_ENGINE) {
    throw new Error(`${label} observer/observation/OCR version mismatch`);
  }
  if (value.preprocessor_version !== VISUAL_PREPROCESS_VERSION) {
    throw new Error(`${label}.preprocessor_version must equal ${VISUAL_PREPROCESS_VERSION}`);
  }
  if (value.health_attestation_required !== true
    || value.response_attestation_required !== true
    || value.attempt_count !== 1 || value.fallback_allowed !== false
    || value.max_images_per_call !== MAX_IMAGES_PER_SHARD) {
    throw new Error(`${label} safety settings are not the immutable execution contract`);
  }
  if (value.vision_timeout_ms !== LOCKED_VISION_TIMEOUT_MS
    || value.observer_response_margin_ms !== LOCKED_OBSERVER_RESPONSE_MARGIN_MS) {
    throw new Error(`${label} timeout settings differ from the reviewed one-shot contract`);
  }
  return {
    provider: "claude_cli_subscription",
    model: "sonnet",
    observer_version: WALMART_LISTING_OBSERVER_VERSION,
    observation_schema_version: WALMART_LISTING_OBSERVATION_BATCH_SCHEMA,
    prompt_version: BLIND_PROMPT_VERSION,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    local_ocr_engine: LOCAL_VISUAL_OCR_ENGINE,
    local_ocr_script_sha256: sha256String(value.local_ocr_script_sha256, `${label}.local_ocr_script_sha256`),
    worker_build_sha256: sha256String(value.worker_build_sha256, `${label}.worker_build_sha256`),
    worker_receipt_key_id: safeId(value.worker_receipt_key_id, `${label}.worker_receipt_key_id`),
    worker_receipt_public_key_sha256: sha256String(
      value.worker_receipt_public_key_sha256,
      `${label}.worker_receipt_public_key_sha256`,
    ),
    worker_analyze_url: workerAnalyzeUrl(value.worker_analyze_url, `${label}.worker_analyze_url`),
    vision_timeout_ms: LOCKED_VISION_TIMEOUT_MS,
    observer_response_margin_ms: LOCKED_OBSERVER_RESPONSE_MARGIN_MS,
    swift_executable_sha256: sha256String(
      value.swift_executable_sha256,
      `${label}.swift_executable_sha256`,
    ),
    xcrun_executable_sha256: sha256String(
      value.xcrun_executable_sha256,
      `${label}.xcrun_executable_sha256`,
    ),
    swift_version_output_sha256: sha256String(
      value.swift_version_output_sha256,
      `${label}.swift_version_output_sha256`,
    ),
    macos_sdk_path_sha256: sha256String(
      value.macos_sdk_path_sha256,
      `${label}.macos_sdk_path_sha256`,
    ),
    macos_sdk_version: safeString(value.macos_sdk_version, `${label}.macos_sdk_version`, 128),
    cli_version: safeString(value.cli_version, `${label}.cli_version`, 256),
    node_version: safeString(value.node_version, `${label}.node_version`, 128),
    platform: safeString(value.platform, `${label}.platform`, 64),
    arch: safeString(value.arch, `${label}.arch`, 64),
    reservation_ledger: parseWalmartListingWorkerReservationLedgerContract(
      value.reservation_ledger,
      `${label}.reservation_ledger`,
    ),
    health_attestation_required: true,
    response_attestation_required: true,
    attempt_count: 1,
    fallback_allowed: false,
    max_images_per_call: MAX_IMAGES_PER_SHARD,
  };
}

function parseEngineContract(value) {
  const label = "run_lock.engine_contract";
  exactKeys(value, [
    "executor_version", "listing_engine_version", "input_schema_version",
    "report_schema_version", "base_input_mode", "source_aware_required",
    "observation_artifacts_required",
  ], label);
  const expected = {
    executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
    listing_engine_version: WALMART_LISTING_INTEGRITY_ENGINE_VERSION,
    input_schema_version: WALMART_LISTING_INTEGRITY_INPUT_SCHEMA,
    report_schema_version: WALMART_LISTING_INTEGRITY_REPORT_SCHEMA,
    base_input_mode: WALMART_LISTING_INTEGRITY_BASE_INPUT_MODE,
    source_aware_required: true,
    observation_artifacts_required: true,
  };
  if (!exactJsonEqual(value, expected)) throw new Error(`${label} differs from this executor build`);
  return expected;
}

function parseAdjudicatorConstraints(value) {
  const label = "run_lock.adjudicator_constraints";
  exactKeys(value, [
    "network_calls", "model_calls", "database_reads", "database_writes",
    "marketplace_reads", "marketplace_writes", "coverage", "output_write_policy",
    "observations",
  ], label);
  const expected = {
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
  if (!exactJsonEqual(value, expected)) throw new Error(`${label} may not relax offline safety`);
  return expected;
}

function parseObserverExecutionConstraints(value, shardCount) {
  const label = "run_lock.observer_execution_constraints";
  exactKeys(value, [
    "network_target", "worker_health_calls_per_execute", "subscription_calls_total",
    "calls_per_shard", "max_calls_per_execute", "transport_attempts_per_shard",
    "retries", "fallbacks", "paid_api_calls", "openai_model_calls",
    "database_reads", "database_writes", "marketplace_reads", "marketplace_writes",
    "local_ocr_required", "execution_order", "ambiguous_attempt_policy",
    "output_write_policy",
  ], label);
  const expected = {
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
  if (!exactJsonEqual(value, expected)) {
    throw new Error(`${label} may not relax one-shot subscription execution safety`);
  }
  return expected;
}

/** Strictly validate and normalize an already parsed run-lock. */
export function parseRunLock(raw) {
  exactKeys(raw, [
    "schema_version", "run_id", "created_at", "purpose", "engine_contract",
    "observer_contract", "owner_execution_authority", "hard_source_freshness", "code_bundle_manifest",
    "source_artifacts", "shards", "listings",
    "observer_partitions", "adjudicator_constraints", "observer_execution_constraints",
  ], "run_lock");
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA) {
    throw new Error("run_lock.schema_version is unsupported");
  }
  if (raw.purpose !== "walmart_listing_integrity_frozen_family") {
    throw new Error("run_lock.purpose is invalid");
  }
  exactKeys(raw.source_artifacts, [
    "authoritative_published_scope", "authoritative_item_report_source",
    "authoritative_item_report_capture", "product_truth_snapshot", "buyer_snapshot_index",
    "catalog_truth_export",
  ], "run_lock.source_artifacts");
  if (!Array.isArray(raw.listings) || raw.listings.length < 1
    || raw.listings.length > MAX_LISTINGS) {
    throw new Error(`run_lock.listings must contain 1..${MAX_LISTINGS} rows`);
  }
  if (!Array.isArray(raw.shards) || raw.shards.length < 1 || raw.shards.length > MAX_SHARDS) {
    throw new Error(`run_lock.shards must contain 1..${MAX_SHARDS} rows`);
  }
  const listings = raw.listings.map(parseListingRef);
  const shards = raw.shards.map(parseShard);
  const listingByKey = new Map();
  const assetByListingSlot = new Map();
  const shardMembershipByListing = new Map();
  for (const listing of listings) {
    if (listingByKey.has(listing.listing_key)) {
      throw new Error(`run_lock contains duplicate listing_key ${listing.listing_key}`);
    }
    listingByKey.set(listing.listing_key, listing);
    assetByListingSlot.set(
      listing.listing_key,
      new Map(listing.assets.map((asset) => [asset.slot, asset])),
    );
    shardMembershipByListing.set(listing.listing_key, []);
  }
  const shardById = new Map();
  const callIndexes = new Set();
  const observerArtifactPaths = new Map();
  const coveredAssets = new Set();
  for (const shard of shards) {
    if (shardById.has(shard.shard_id)) throw new Error(`duplicate shard_id ${shard.shard_id}`);
    if (callIndexes.has(shard.call_index)) throw new Error(`duplicate call_index ${shard.call_index}`);
    for (const [kind, artifactPath] of [
      ["observation", shard.observation_batch_path],
      ["attempt", `${shard.observation_batch_path}.attempt.json`],
    ]) {
      const existing = observerArtifactPaths.get(artifactPath);
      if (existing) {
        throw new Error(
          `observer artifact path collision: ${artifactPath} is reserved by ${existing} and ${shard.shard_id} ${kind}`,
        );
      }
      observerArtifactPaths.set(artifactPath, `${shard.shard_id} ${kind}`);
    }
    shardById.set(shard.shard_id, shard);
    callIndexes.add(shard.call_index);
    const shardListingKeys = new Set();
    for (const image of shard.images) {
      const listing = listingByKey.get(image.listing_key);
      if (!listing || listing.item_id !== image.item_id) {
        throw new Error(`${shard.shard_id}/${image.image_id} does not bind a locked listing/item`);
      }
      const asset = assetByListingSlot.get(image.listing_key)?.get(image.slot);
      if (!asset || asset.buyer_asset.sha256 !== image.asset_sha256
        || asset.model_view.sha256 !== image.model_view_sha256
        || asset.image_id !== image.image_id) {
        throw new Error(`${shard.shard_id}/${image.image_id} differs from the locked asset binding`);
      }
      const coverageKey = `${image.listing_key}\u0000${image.slot}`;
      if (coveredAssets.has(coverageKey)) {
        throw new Error(`asset coverage is not exactly once: ${image.listing_key}/${image.slot}`);
      }
      coveredAssets.add(coverageKey);
      shardListingKeys.add(image.listing_key);
    }
    for (const listingKey of shardListingKeys) {
      shardMembershipByListing.get(listingKey).push({
        shard_id: shard.shard_id,
        call_index: shard.call_index,
      });
    }
  }
  for (let index = 0; index < shards.length; index += 1) {
    if (!callIndexes.has(index)) throw new Error("run_lock.shards call_index values must be contiguous from zero");
  }
  for (const listing of listings) {
    const derivedShardIds = shardMembershipByListing.get(listing.listing_key)
      .sort((left, right) => left.call_index - right.call_index)
      .map((shard) => shard.shard_id);
    if (!exactJsonEqual(listing.shard_ids, derivedShardIds)) {
      throw new Error(`${listing.listing_key} shard_ids do not exactly match ordered asset membership`);
    }
    for (const asset of listing.assets) {
      if (!coveredAssets.has(`${listing.listing_key}\u0000${asset.slot}`)) {
        throw new Error(`asset coverage is missing: ${listing.listing_key}/${asset.slot}`);
      }
    }
  }
  const sortedListings = [...listings].sort((left, right) => (
    left.listing_key < right.listing_key ? -1 : left.listing_key > right.listing_key ? 1 : 0
  ));
  const sortedShards = [...shards].sort((left, right) => left.call_index - right.call_index);
  const createdAt = canonicalTimestamp(raw.created_at, "run_lock.created_at");
  const observerPartitions = parseObserverPartitions(raw.observer_partitions, sortedShards);
  const sourceFreshness = parseWalmartListingIntegritySourceFreshness(
    raw.hard_source_freshness,
    "run_lock.hard_source_freshness",
  );
  if (sourceFreshness.locked_buyer_snapshot_count !== sortedListings.length) {
    throw new Error("run_lock.hard_source_freshness buyer snapshot count must equal exact listing population");
  }
  return {
    schema_version: WALMART_LISTING_INTEGRITY_RUN_LOCK_SCHEMA,
    run_id: safeId(raw.run_id, "run_lock.run_id"),
    created_at: createdAt,
    purpose: "walmart_listing_integrity_frozen_family",
    engine_contract: parseEngineContract(raw.engine_contract),
    observer_contract: parseObserverContract(raw.observer_contract),
    owner_execution_authority: parseWalmartListingIntegrityOwnerExecutionAuthority(
      raw.owner_execution_authority,
      "run_lock.owner_execution_authority",
    ),
    hard_source_freshness: sourceFreshness,
    code_bundle_manifest: parseFileRef(
      raw.code_bundle_manifest,
      "run_lock.code_bundle_manifest",
    ),
    source_artifacts: {
      authoritative_published_scope: parseFileRef(
        raw.source_artifacts.authoritative_published_scope,
        "run_lock.source_artifacts.authoritative_published_scope",
      ),
      authoritative_item_report_source: parseFileRef(
        raw.source_artifacts.authoritative_item_report_source,
        "run_lock.source_artifacts.authoritative_item_report_source",
      ),
      authoritative_item_report_capture: parseAuthoritativeItemReportCaptureRefs(
        raw.source_artifacts.authoritative_item_report_capture,
      ),
      product_truth_snapshot: parseFileRef(
        raw.source_artifacts.product_truth_snapshot,
        "run_lock.source_artifacts.product_truth_snapshot",
      ),
      buyer_snapshot_index: parseFileRef(
        raw.source_artifacts.buyer_snapshot_index,
        "run_lock.source_artifacts.buyer_snapshot_index",
      ),
      catalog_truth_export: parseFileRef(
        raw.source_artifacts.catalog_truth_export,
        "run_lock.source_artifacts.catalog_truth_export",
      ),
    },
    shards: sortedShards,
    listings: sortedListings,
    observer_partitions: observerPartitions,
    adjudicator_constraints: parseAdjudicatorConstraints(raw.adjudicator_constraints),
    observer_execution_constraints: parseObserverExecutionConstraints(
      raw.observer_execution_constraints,
      sortedShards.length,
    ),
  };
}

export const WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ACTION =
  "WALMART_LISTING_INTEGRITY_OBSERVE";

const OWNER_AUTHORIZATION_CLAIMS = Object.freeze({
  one_reservation_per_partition: true,
  transport_attempts_per_call: 1,
  retries: 0,
  fallbacks: 0,
  paid_api_calls: 0,
  openai_model_calls: 0,
  database_reads: 0,
  database_writes: 0,
  marketplace_reads: 0,
  marketplace_writes: 0,
});

function parseOwnerAuthorizationGrant(raw, index) {
  const label = `owner_authorization.signed_body.partition_grants[${index}]`;
  exactKeys(raw, [
    "partition_id", "partition_index", "shard_ids", "call_indexes", "call_ceiling",
  ], label);
  if (!Array.isArray(raw.shard_ids) || raw.shard_ids.length < 1 || raw.shard_ids.length > 6
    || !Array.isArray(raw.call_indexes) || raw.call_indexes.length !== raw.shard_ids.length) {
    throw new Error(`${label} must bind 1..6 exact shard_ids and equally many call_indexes`);
  }
  const shardIds = raw.shard_ids.map((value, shardIndex) => (
    safeId(value, `${label}.shard_ids[${shardIndex}]`)
  ));
  const callIndexes = raw.call_indexes.map((value, callIndex) => (
    safeInteger(value, `${label}.call_indexes[${callIndex}]`)
  ));
  if (new Set(shardIds).size !== shardIds.length
    || new Set(callIndexes).size !== callIndexes.length
    || callIndexes.some((value, callIndex) => callIndex > 0 && value <= callIndexes[callIndex - 1])) {
    throw new Error(`${label} shard_ids/call_indexes must be unique and calls strictly increasing`);
  }
  const callCeiling = safeInteger(raw.call_ceiling, `${label}.call_ceiling`, 1);
  if (callCeiling !== shardIds.length || callCeiling !== callIndexes.length) {
    throw new Error(`${label}.call_ceiling must equal its exact shard/call population`);
  }
  return {
    partition_id: safeId(raw.partition_id, `${label}.partition_id`),
    partition_index: safeInteger(raw.partition_index, `${label}.partition_index`),
    shard_ids: shardIds,
    call_indexes: callIndexes,
    call_ceiling: callCeiling,
  };
}

function parseOwnerAuthorizationBody(raw) {
  const label = "owner_authorization.signed_body";
  exactKeys(raw, [
    "action", "approval_id", "run_lock_sha256", "run_id",
    "preflight_certificate_sha256", "partition_grants", "total_call_ceiling",
    "issued_at", "expires_at", "source_freshness_deadline", "claims",
  ], label);
  if (raw.action !== WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ACTION) {
    throw new Error(`${label}.action is unsupported`);
  }
  if (!Array.isArray(raw.partition_grants) || raw.partition_grants.length < 1) {
    throw new Error(`${label}.partition_grants must be non-empty`);
  }
  const partitionGrants = raw.partition_grants.map(parseOwnerAuthorizationGrant);
  if (new Set(partitionGrants.map((grant) => grant.partition_id)).size !== partitionGrants.length
    || partitionGrants.some((grant, index) => (
      index > 0 && grant.partition_index <= partitionGrants[index - 1].partition_index
    ))) {
    throw new Error(`${label}.partition_grants must be unique and ordered by partition_index`);
  }
  const totalCallCeiling = safeInteger(
    raw.total_call_ceiling,
    `${label}.total_call_ceiling`,
    1,
  );
  if (totalCallCeiling !== partitionGrants.reduce((sum, grant) => sum + grant.call_ceiling, 0)) {
    throw new Error(`${label}.total_call_ceiling must equal the exact signed grant population`);
  }
  const issuedAt = canonicalTimestamp(raw.issued_at, `${label}.issued_at`);
  const expiresAt = canonicalTimestamp(raw.expires_at, `${label}.expires_at`);
  const freshnessDeadline = canonicalTimestamp(
    raw.source_freshness_deadline,
    `${label}.source_freshness_deadline`,
  );
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(freshnessDeadline) <= Date.parse(issuedAt)) {
    throw new Error(`${label} expiry and source freshness deadline must be strictly after issued_at`);
  }
  if (!exactJsonEqual(raw.claims, OWNER_AUTHORIZATION_CLAIMS)) {
    throw new Error(`${label}.claims may not relax one-shot/no-mutation safety`);
  }
  return {
    action: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ACTION,
    approval_id: safeId(raw.approval_id, `${label}.approval_id`),
    run_lock_sha256: sha256String(raw.run_lock_sha256, `${label}.run_lock_sha256`),
    run_id: safeId(raw.run_id, `${label}.run_id`),
    preflight_certificate_sha256: sha256String(
      raw.preflight_certificate_sha256,
      `${label}.preflight_certificate_sha256`,
    ),
    partition_grants: partitionGrants,
    total_call_ceiling: totalCallCeiling,
    issued_at: issuedAt,
    expires_at: expiresAt,
    source_freshness_deadline: freshnessDeadline,
    claims: OWNER_AUTHORIZATION_CLAIMS,
  };
}

/** Build the only canonical body an external owner signer is asked to approve. */
export function buildWalmartListingIntegrityOwnerExecutionAuthorizationBody({
  run_lock: runLock,
  run_lock_sha256: runLockSha256,
  preflight_certificate_sha256: preflightCertificateSha256,
  approval_id: approvalId,
  partition_ids: partitionIds,
  issued_at: issuedAt,
  expires_at: expiresAt,
  source_freshness_deadline: sourceFreshnessDeadline,
}) {
  if (!runLock || !Array.isArray(runLock.observer_partitions) || !Array.isArray(runLock.shards)) {
    throw new Error("owner authorization body requires a parsed family run-lock");
  }
  if (!Array.isArray(partitionIds) || partitionIds.length < 1) {
    throw new Error("owner authorization requires at least one exact partition_id");
  }
  const requested = partitionIds.map((value, index) => (
    safeId(value, `partition_ids[${index}]`)
  ));
  if (new Set(requested).size !== requested.length) {
    throw new Error("owner authorization partition_ids contains duplicates");
  }
  const partitionById = new Map(runLock.observer_partitions.map((row) => [row.partition_id, row]));
  const shardById = new Map(runLock.shards.map((row) => [row.shard_id, row]));
  const grants = requested.map((partitionId) => {
    const partition = partitionById.get(partitionId);
    if (!partition) throw new Error(`${partitionId} is not present in the immutable family`);
    const callIndexes = partition.shard_ids.map((shardId) => {
      const callIndex = shardById.get(shardId)?.call_index;
      if (!Number.isSafeInteger(callIndex)) throw new Error(`${partitionId}/${shardId} call binding is missing`);
      return callIndex;
    });
    return {
      partition_id: partition.partition_id,
      partition_index: partition.partition_index,
      shard_ids: [...partition.shard_ids],
      call_indexes: callIndexes,
      call_ceiling: partition.shard_ids.length,
    };
  });
  if (grants.some((grant, index) => (
    index > 0 && grant.partition_index <= grants[index - 1].partition_index
  ))) {
    throw new Error("owner authorization partition_ids must follow exact family partition order");
  }
  const requestedFreshnessDeadline = canonicalTimestamp(
    sourceFreshnessDeadline,
    "source_freshness_deadline",
  );
  const body = parseOwnerAuthorizationBody({
    action: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ACTION,
    approval_id: approvalId,
    run_lock_sha256: runLockSha256,
    run_id: runLock.run_id,
    preflight_certificate_sha256: preflightCertificateSha256,
    partition_grants: grants,
    total_call_ceiling: grants.reduce((sum, grant) => sum + grant.call_ceiling, 0),
    issued_at: issuedAt,
    expires_at: expiresAt,
    source_freshness_deadline: requestedFreshnessDeadline,
    claims: OWNER_AUTHORIZATION_CLAIMS,
  });
  const familyHardDeadline = Date.parse(runLock.hard_source_freshness.hard_deadline);
  if (Date.parse(body.issued_at) < Date.parse(runLock.created_at)) {
    throw new Error("requested authorization predates the immutable family run-lock");
  }
  if (Date.parse(body.expires_at) > familyHardDeadline
    || Date.parse(body.source_freshness_deadline) > familyHardDeadline) {
    throw new Error("requested authorization deadline exceeds the immutable family hard deadline");
  }
  return body;
}

export function walmartListingIntegrityOwnerAuthorizationSigningMessage(envelope) {
  return Buffer.concat([
    OWNER_AUTHORIZATION_SIGNING_DOMAIN,
    Buffer.from(canonicalJson(envelope), "utf8"),
  ]);
}

/** Verify one canonical external Ed25519 authorization against the family-pinned key. */
export function parseWalmartListingIntegrityOwnerExecutionAuthorization(raw, expected = {}) {
  const label = "owner_authorization";
  exactKeys(raw, [
    "schema_version", "algorithm", "key_id", "owner_public_key_spki_sha256",
    "signed_body", "signature_base64", "signature_sha256", "authorization_sha256",
  ], label);
  const authority = parseWalmartListingIntegrityOwnerExecutionAuthority(
    expected.owner_execution_authority,
    "expected.owner_execution_authority",
  );
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA
    || raw.algorithm !== WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM
    || raw.key_id !== authority.key_id
    || raw.owner_public_key_spki_sha256 !== authority.public_key_spki_sha256) {
    throw new Error("owner authorization key/schema differs from the immutable family trust root");
  }
  const signedBody = parseOwnerAuthorizationBody(raw.signed_body);
  const signature = canonicalBase64(raw.signature_base64, `${label}.signature_base64`, 256);
  if (signature.bytes.byteLength !== 64) throw new Error(`${label}.signature_base64 must encode 64 bytes`);
  const signatureSha = sha256String(raw.signature_sha256, `${label}.signature_sha256`);
  if (signatureSha !== sha256Bytes(signature.bytes)) throw new Error(`${label}.signature_sha256 mismatch`);
  const envelope = {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: authority.key_id,
    owner_public_key_spki_sha256: authority.public_key_spki_sha256,
    signed_body: signedBody,
  };
  const publicKey = createPublicKey({
    key: Buffer.from(authority.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    null,
    walmartListingIntegrityOwnerAuthorizationSigningMessage(envelope),
    publicKey,
    signature.bytes,
  )) {
    throw new Error("owner authorization Ed25519 signature is invalid");
  }
  const unsigned = {
    ...envelope,
    signature_base64: signature.value,
    signature_sha256: signatureSha,
  };
  const authorizationSha = sha256Bytes(Buffer.from(canonicalJson(unsigned), "utf8"));
  if (raw.authorization_sha256 !== authorizationSha) {
    throw new Error(`${label}.authorization_sha256 mismatch`);
  }
  const runLock = expected.run_lock;
  if (expected.run_lock_sha256 !== undefined
    && signedBody.run_lock_sha256 !== expected.run_lock_sha256) {
    throw new Error("owner authorization is bound to a different family run-lock");
  }
  if (expected.run_id !== undefined && signedBody.run_id !== expected.run_id) {
    throw new Error("owner authorization is bound to a different run_id");
  }
  if (expected.preflight_certificate_sha256 !== undefined
    && signedBody.preflight_certificate_sha256 !== expected.preflight_certificate_sha256) {
    throw new Error("owner authorization is bound to a different preflight certificate");
  }
  if (runLock !== undefined) {
    const familyHardDeadline = Date.parse(runLock.hard_source_freshness.hard_deadline);
    if (Date.parse(signedBody.issued_at) < Date.parse(runLock.created_at)) {
      throw new Error("owner authorization predates the immutable family run-lock");
    }
    if (Date.parse(signedBody.expires_at) > familyHardDeadline
      || Date.parse(signedBody.source_freshness_deadline) > familyHardDeadline) {
      throw new Error("owner authorization deadline exceeds the immutable family hard deadline");
    }
    const shardById = new Map(runLock.shards.map((shard) => [shard.shard_id, shard]));
    for (const grant of signedBody.partition_grants) {
      const partition = runLock.observer_partitions.find((row) => (
        row.partition_id === grant.partition_id
      ));
      const callIndexes = grant.shard_ids.map((shardId) => shardById.get(shardId)?.call_index);
      if (!partition || partition.partition_index !== grant.partition_index
        || !exactJsonEqual(partition.shard_ids, grant.shard_ids)
        || !exactJsonEqual(callIndexes, grant.call_indexes)) {
        throw new Error(`${grant.partition_id} owner grant differs from exact family shard/call scope`);
      }
    }
  }
  const parsed = { ...unsigned, authorization_sha256: authorizationSha };
  if (expected.now !== undefined) {
    assertWalmartListingIntegrityOwnerAuthorizationIssuanceWindow(parsed, expected.now);
  }
  return parsed;
}

export function assembleWalmartListingIntegrityOwnerExecutionAuthorization({
  owner_execution_authority: authorityRaw,
  signed_body: signedBody,
  signature_base64: signatureBase64,
  expected = {},
}) {
  const authority = parseWalmartListingIntegrityOwnerExecutionAuthority(authorityRaw);
  const envelope = {
    schema_version: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_INTEGRITY_OWNER_AUTHORIZATION_ALGORITHM,
    key_id: authority.key_id,
    owner_public_key_spki_sha256: authority.public_key_spki_sha256,
    signed_body: parseOwnerAuthorizationBody(signedBody),
  };
  const signature = canonicalBase64(signatureBase64, "signature_base64", 256);
  const unsigned = {
    ...envelope,
    signature_base64: signature.value,
    signature_sha256: sha256Bytes(signature.bytes),
  };
  return parseWalmartListingIntegrityOwnerExecutionAuthorization({
    ...unsigned,
    authorization_sha256: sha256Bytes(Buffer.from(canonicalJson(unsigned), "utf8")),
  }, {
    ...expected,
    owner_execution_authority: authority,
  });
}

export function assertWalmartListingIntegrityOwnerAuthorizationIssuanceWindow(
  authorization,
  now = new Date(),
) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error("owner authorization clock is invalid");
  const body = authorization?.signed_body;
  if (!body || Date.parse(body.issued_at) > nowMs + OWNER_AUTHORIZATION_CLOCK_SKEW_MS) {
    throw new Error("owner authorization issued_at is in the future beyond clock skew");
  }
  const effectiveDeadline = Math.min(
    Date.parse(body.expires_at),
    Date.parse(body.source_freshness_deadline),
  );
  if (nowMs < Date.parse(body.issued_at) - OWNER_AUTHORIZATION_CLOCK_SKEW_MS) {
    throw new Error("owner authorization window has not started");
  }
  if (nowMs >= effectiveDeadline) {
    throw new Error("owner authorization or source freshness deadline has expired");
  }
  return new Date(effectiveDeadline).toISOString();
}

function allowanceReservationId(body) {
  const bodySha = sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
  return `allowance-reservation-${String(body.sequence).padStart(6, "0")}-${bodySha}`;
}

export function parseWalmartListingIntegrityAllowanceReservation(raw, expected = {}) {
  const label = "allowance_reservation";
  exactKeys(raw, ["schema_version", "reservation_id", "body_sha256", "body"], label);
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_ALLOWANCE_RESERVATION_SCHEMA) {
    throw new Error(`${label}.schema_version is unsupported`);
  }
  exactKeys(raw.body, [
    "authorization_sha256", "sequence", "previous_reservation_sha256", "approval_id",
    "run_lock_sha256", "run_id", "partition_id", "partition_index", "shard_ids",
    "call_indexes", "call_ceiling", "reserved_at",
  ], `${label}.body`);
  const authorization = expected.owner_authorization;
  if (!authorization) throw new Error(`${label} requires a verified owner authorization`);
  if (!Array.isArray(raw.body.shard_ids) || !Array.isArray(raw.body.call_indexes)) {
    throw new Error(`${label}.body shard_ids and call_indexes must be arrays`);
  }
  const sequence = safeInteger(raw.body.sequence, `${label}.body.sequence`);
  const grant = authorization.signed_body.partition_grants[sequence];
  if (!grant) throw new Error(`${label} sequence exceeds the signed authorization grants`);
  const body = {
    authorization_sha256: sha256String(
      raw.body.authorization_sha256,
      `${label}.body.authorization_sha256`,
    ),
    sequence,
    previous_reservation_sha256: sha256String(
      raw.body.previous_reservation_sha256,
      `${label}.body.previous_reservation_sha256`,
    ),
    approval_id: safeId(raw.body.approval_id, `${label}.body.approval_id`),
    run_lock_sha256: sha256String(raw.body.run_lock_sha256, `${label}.body.run_lock_sha256`),
    run_id: safeId(raw.body.run_id, `${label}.body.run_id`),
    partition_id: safeId(raw.body.partition_id, `${label}.body.partition_id`),
    partition_index: safeInteger(raw.body.partition_index, `${label}.body.partition_index`),
    shard_ids: raw.body.shard_ids.map((value, index) => (
      safeId(value, `${label}.body.shard_ids[${index}]`)
    )),
    call_indexes: raw.body.call_indexes.map((value, index) => (
      safeInteger(value, `${label}.body.call_indexes[${index}]`)
    )),
    call_ceiling: safeInteger(raw.body.call_ceiling, `${label}.body.call_ceiling`, 1),
    reserved_at: canonicalTimestamp(raw.body.reserved_at, `${label}.body.reserved_at`),
  };
  const expectedPrevious = sequence === 0
    ? authorization.authorization_sha256
    : expected.previous_reservation_sha256;
  if (body.authorization_sha256 !== authorization.authorization_sha256
    || body.approval_id !== authorization.signed_body.approval_id
    || body.run_lock_sha256 !== authorization.signed_body.run_lock_sha256
    || body.run_id !== authorization.signed_body.run_id
    || body.partition_id !== grant.partition_id
    || body.partition_index !== grant.partition_index
    || !exactJsonEqual(body.shard_ids, grant.shard_ids)
    || !exactJsonEqual(body.call_indexes, grant.call_indexes)
    || body.call_ceiling !== grant.call_ceiling
    || (expectedPrevious !== undefined && body.previous_reservation_sha256 !== expectedPrevious)
    || Date.parse(body.reserved_at) < Date.parse(authorization.signed_body.issued_at)
    || Date.parse(body.reserved_at) >= Math.min(
      Date.parse(authorization.signed_body.expires_at),
      Date.parse(authorization.signed_body.source_freshness_deadline),
    )) {
    throw new Error(`${label} differs from the signed grant or immutable ledger chain`);
  }
  const bodySha = sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
  if (raw.body_sha256 !== bodySha || raw.reservation_id !== allowanceReservationId(body)) {
    throw new Error(`${label} seal mismatch`);
  }
  return {
    schema_version: WALMART_LISTING_INTEGRITY_ALLOWANCE_RESERVATION_SCHEMA,
    reservation_id: allowanceReservationId(body),
    body_sha256: bodySha,
    body,
  };
}

export function buildWalmartListingIntegrityAllowanceReservation({
  owner_authorization: authorization,
  sequence,
  previous_reservation_sha256: previousReservationSha256,
  reserved_at: reservedAt,
}) {
  const grant = authorization?.signed_body?.partition_grants?.[sequence];
  if (!grant) throw new Error("allowance reservation sequence is not an authorized grant");
  const body = {
    authorization_sha256: authorization.authorization_sha256,
    sequence,
    previous_reservation_sha256: previousReservationSha256,
    approval_id: authorization.signed_body.approval_id,
    run_lock_sha256: authorization.signed_body.run_lock_sha256,
    run_id: authorization.signed_body.run_id,
    partition_id: grant.partition_id,
    partition_index: grant.partition_index,
    shard_ids: [...grant.shard_ids],
    call_indexes: [...grant.call_indexes],
    call_ceiling: grant.call_ceiling,
    reserved_at: reservedAt,
  };
  const bodySha = sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
  return parseWalmartListingIntegrityAllowanceReservation({
    schema_version: WALMART_LISTING_INTEGRITY_ALLOWANCE_RESERVATION_SCHEMA,
    reservation_id: allowanceReservationId(body),
    body_sha256: bodySha,
    body,
  }, {
    owner_authorization: authorization,
    previous_reservation_sha256: previousReservationSha256,
  });
}

export function walmartListingIntegrityAllowanceReservationRelativePath(
  authorizationSha256,
  reservation,
) {
  const authorizationSha = sha256String(
    authorizationSha256,
    "authorization_sha256",
  );
  const sequence = safeInteger(reservation?.body?.sequence, "allowance reservation sequence");
  const partitionId = safeId(
    reservation?.body?.partition_id,
    "allowance reservation partition_id",
  );
  return `permits/allowance-ledger/${authorizationSha}/${String(sequence).padStart(6, "0")}-${partitionId}.json`;
}

function executionAuthorizationBinding(authorization) {
  return {
    authorization_sha256: authorization.authorization_sha256,
    approval_id: authorization.signed_body.approval_id,
    key_id: authorization.key_id,
    owner_public_key_spki_sha256: authorization.owner_public_key_spki_sha256,
    signature_sha256: authorization.signature_sha256,
    issued_at: authorization.signed_body.issued_at,
    expires_at: authorization.signed_body.expires_at,
    source_freshness_deadline: authorization.signed_body.source_freshness_deadline,
    effective_deadline: new Date(Math.min(
      Date.parse(authorization.signed_body.expires_at),
      Date.parse(authorization.signed_body.source_freshness_deadline),
    )).toISOString(),
  };
}

function executionPermitId(bodyWithoutId) {
  const digest = sha256Bytes(Buffer.from(canonicalJson(bodyWithoutId), "utf8"));
  return `permit-${String(bodyWithoutId.partition_index).padStart(6, "0")}-${digest.slice(0, 20)}`;
}

/** Strict parser shared by the issuer, observer, and historical adjudicator. */
export function parseWalmartListingIntegrityExecutionPermitBody(raw, expected = {}) {
  const label = "execution_permit.body";
  exactKeys(raw, [
    "schema_version", "permit_id", "run_lock_sha256", "run_id", "partition_id",
    "partition_index", "shard_ids", "preflight_certificate_sha256", "created_at",
    "expires_at", "owner_authorization", "authorization_binding", "allowance_reservation",
  ], label);
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_EXECUTION_PERMIT_SCHEMA) {
    throw new Error(`${label}.schema_version is unsupported`);
  }
  const authority = expected.owner_execution_authority
    ?? expected.run_lock?.owner_execution_authority;
  const authorization = parseWalmartListingIntegrityOwnerExecutionAuthorization(
    raw.owner_authorization,
    {
      owner_execution_authority: authority,
      run_lock: expected.run_lock,
      run_lock_sha256: expected.run_lock_sha256,
      run_id: expected.run_id,
      preflight_certificate_sha256: expected.preflight_certificate_sha256,
    },
  );
  const reservation = parseWalmartListingIntegrityAllowanceReservation(
    raw.allowance_reservation,
    { owner_authorization: authorization },
  );
  if (!Array.isArray(raw.shard_ids) || raw.shard_ids.length < 1 || raw.shard_ids.length > 6) {
    throw new Error(`${label}.shard_ids must contain 1..6 rows`);
  }
  const shardIds = raw.shard_ids.map((value, index) => (
    safeId(value, `${label}.shard_ids[${index}]`)
  ));
  if (new Set(shardIds).size !== shardIds.length) {
    throw new Error(`${label}.shard_ids contains duplicates`);
  }
  const createdAt = canonicalTimestamp(raw.created_at, `${label}.created_at`);
  const expiresAt = canonicalTimestamp(raw.expires_at, `${label}.expires_at`);
  const effectiveDeadlineMs = Math.min(
    Date.parse(authorization.signed_body.expires_at),
    Date.parse(authorization.signed_body.source_freshness_deadline),
  );
  const expectedExpiry = new Date(Math.min(
    Date.parse(createdAt) + EXECUTION_PERMIT_WINDOW_MS,
    effectiveDeadlineMs,
  )).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || expiresAt !== expectedExpiry) {
    throw new Error(`${label}.expires_at must equal the bounded 24h/authorization/freshness deadline`);
  }
  const binding = executionAuthorizationBinding(authorization);
  if (!exactJsonEqual(raw.authorization_binding, binding)) {
    throw new Error(`${label}.authorization_binding differs from the signed owner authorization`);
  }
  const bodyWithoutId = {
    schema_version: WALMART_LISTING_INTEGRITY_EXECUTION_PERMIT_SCHEMA,
    run_lock_sha256: sha256String(raw.run_lock_sha256, `${label}.run_lock_sha256`),
    run_id: safeId(raw.run_id, `${label}.run_id`),
    partition_id: safeId(raw.partition_id, `${label}.partition_id`),
    partition_index: safeInteger(raw.partition_index, `${label}.partition_index`),
    shard_ids: shardIds,
    preflight_certificate_sha256: sha256String(
      raw.preflight_certificate_sha256,
      `${label}.preflight_certificate_sha256`,
    ),
    created_at: createdAt,
    expires_at: expiresAt,
    owner_authorization: authorization,
    authorization_binding: binding,
    allowance_reservation: reservation,
  };
  const expectedId = executionPermitId(bodyWithoutId);
  if (raw.permit_id !== expectedId) throw new Error(`${label}.permit_id mismatch`);
  if (bodyWithoutId.run_lock_sha256 !== authorization.signed_body.run_lock_sha256
    || bodyWithoutId.run_id !== authorization.signed_body.run_id
    || bodyWithoutId.preflight_certificate_sha256
      !== authorization.signed_body.preflight_certificate_sha256
    || bodyWithoutId.partition_id !== reservation.body.partition_id
    || bodyWithoutId.partition_index !== reservation.body.partition_index
    || !exactJsonEqual(bodyWithoutId.shard_ids, reservation.body.shard_ids)
    || bodyWithoutId.created_at !== reservation.body.reserved_at) {
    throw new Error("execution permit differs from its signed authorization/reservation");
  }
  return { ...bodyWithoutId, permit_id: expectedId };
}

export function buildWalmartListingIntegrityExecutionPermitBody({
  run_lock: runLock,
  run_lock_sha256: runLockSha256,
  run_id: runId,
  partition,
  preflight_certificate_sha256: certificateSha256,
  created_at: createdAt,
  owner_authorization: ownerAuthorization,
  allowance_reservation: allowanceReservation,
}) {
  const parsedAuthorization = parseWalmartListingIntegrityOwnerExecutionAuthorization(
    ownerAuthorization,
    {
      owner_execution_authority: runLock?.owner_execution_authority,
      run_lock: runLock,
      run_lock_sha256: runLockSha256,
      run_id: runId,
      preflight_certificate_sha256: certificateSha256,
    },
  );
  const effectiveDeadlineMs = Math.min(
    Date.parse(parsedAuthorization.signed_body.expires_at),
    Date.parse(parsedAuthorization.signed_body.source_freshness_deadline),
  );
  const created = canonicalTimestamp(createdAt, "created_at");
  const withoutId = {
    schema_version: WALMART_LISTING_INTEGRITY_EXECUTION_PERMIT_SCHEMA,
    run_lock_sha256: sha256String(runLockSha256, "run_lock_sha256"),
    run_id: safeId(runId, "run_id"),
    partition_id: safeId(partition?.partition_id, "partition.partition_id"),
    partition_index: safeInteger(partition?.partition_index, "partition.partition_index"),
    shard_ids: Array.isArray(partition?.shard_ids) ? [...partition.shard_ids] : partition?.shard_ids,
    preflight_certificate_sha256: sha256String(certificateSha256, "preflight_certificate_sha256"),
    created_at: created,
    expires_at: new Date(Math.min(
      Date.parse(created) + EXECUTION_PERMIT_WINDOW_MS,
      effectiveDeadlineMs,
    )).toISOString(),
    owner_authorization: parsedAuthorization,
    authorization_binding: executionAuthorizationBinding(parsedAuthorization),
    allowance_reservation: allowanceReservation,
  };
  return parseWalmartListingIntegrityExecutionPermitBody({
    ...withoutId,
    permit_id: executionPermitId(withoutId),
  }, {
    owner_execution_authority: runLock?.owner_execution_authority,
    run_lock: runLock,
    run_lock_sha256: runLockSha256,
    run_id: runId,
    partition,
    preflight_certificate_sha256: certificateSha256,
  });
}

export function parseWalmartListingIntegrityExecutionPermit(raw, expected = {}) {
  exactKeys(raw, ["sha256", "body"], "execution_permit");
  const body = parseWalmartListingIntegrityExecutionPermitBody(raw.body, expected);
  const digest = sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
  if (raw.sha256 !== digest) throw new Error("execution_permit.sha256 mismatch");
  if (expected.run_lock_sha256 !== undefined && body.run_lock_sha256 !== expected.run_lock_sha256) {
    throw new Error("execution permit is bound to a different family run-lock");
  }
  if (expected.run_id !== undefined && body.run_id !== expected.run_id) {
    throw new Error("execution permit is bound to a different run_id");
  }
  if (expected.preflight_certificate_sha256 !== undefined
    && body.preflight_certificate_sha256 !== expected.preflight_certificate_sha256) {
    throw new Error("execution permit is bound to a different preflight certificate");
  }
  if (expected.family_created_at !== undefined
    && Date.parse(body.created_at) < Date.parse(canonicalTimestamp(
      expected.family_created_at,
      "expected.family_created_at",
    ))) {
    throw new Error("execution permit predates its immutable family run-lock");
  }
  if (expected.partition !== undefined) {
    const partition = expected.partition;
    if (body.partition_id !== partition.partition_id
      || body.partition_index !== partition.partition_index
      || !exactJsonEqual(body.shard_ids, partition.shard_ids)) {
      throw new Error("execution permit is bound to a different observer partition");
    }
  }
  if (expected.shard_id !== undefined && !body.shard_ids.includes(expected.shard_id)) {
    throw new Error("execution permit does not authorize the observation shard");
  }
  const parsed = { sha256: digest, body };
  Object.defineProperty(parsed, VERIFIED_EXECUTION_PERMIT, { value: true });
  return parsed;
}

/** Only a trusted parsed permit has a clock gate; the immutable family never expires. */
export function assertExecutionPermitWindow(permit, now = new Date()) {
  if (!permit?.[VERIFIED_EXECUTION_PERMIT]) {
    throw new Error("execution permit must first be verified against the family owner trust root");
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error("execution clock is invalid");
  if (nowMs < Date.parse(permit.body.created_at)) {
    throw new Error("execution permit window has not started");
  }
  if (nowMs >= Date.parse(permit.body.expires_at)) {
    throw new Error("execution permit window has expired");
  }
  return permit;
}

/** @deprecated Compatibility export; v3 callers must pass a permit, never a family lock. */
export function assertRunLockExecutionWindow(permit, now = new Date()) {
  return assertExecutionPermitWindow(permit, now);
}

function parseAuthoritativePopulation(value, label) {
  exactKeys(value, [
    "scope_snapshot_id", "scope_body_sha256", "scope_captured_at",
    "authoritative_published_count", "auditable_count", "truth_review_count",
    "unsupported_count", "exact_population_reconciliation",
  ], label);
  if (value.exact_population_reconciliation !== true) {
    throw new Error(`${label}.exact_population_reconciliation must be true`);
  }
  return {
    scope_snapshot_id: safeString(value.scope_snapshot_id, `${label}.scope_snapshot_id`, 256),
    scope_body_sha256: sha256String(value.scope_body_sha256, `${label}.scope_body_sha256`),
    scope_captured_at: canonicalTimestamp(value.scope_captured_at, `${label}.scope_captured_at`),
    authoritative_published_count: safeInteger(
      value.authoritative_published_count,
      `${label}.authoritative_published_count`,
    ),
    auditable_count: safeInteger(value.auditable_count, `${label}.auditable_count`),
    truth_review_count: safeInteger(value.truth_review_count, `${label}.truth_review_count`),
    unsupported_count: safeInteger(value.unsupported_count, `${label}.unsupported_count`),
    exact_population_reconciliation: true,
  };
}

export function parseWalmartListingIntegrityPreflightCertificate(raw) {
  const label = "preflight_certificate";
  exactKeys(raw, ["schema_version", "certificate_id", "body_sha256", "body"], label);
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_PREFLIGHT_CERTIFICATE_SCHEMA) {
    throw new Error(`${label}.schema_version is unsupported`);
  }
  const bodyLabel = `${label}.body`;
  exactKeys(raw.body, [
    "run_id", "run_lock_sha256", "family_created_at", "executor_version",
    "code_bundle_id", "code_bundle_manifest_sha256", "listing_count", "image_count",
    "shard_count", "partition_count", "authoritative_population",
    "deterministic_listing_order", "deterministic_shard_order", "observer_partitions",
    "semantic_listings_verified", "assurance",
  ], bodyLabel);
  if (raw.body.executor_version !== WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION) {
    throw new Error(`${bodyLabel}.executor_version differs from this engine`);
  }
  const listingCount = safeInteger(raw.body.listing_count, `${bodyLabel}.listing_count`, 1);
  const shardCount = safeInteger(raw.body.shard_count, `${bodyLabel}.shard_count`, 1);
  const partitionCount = safeInteger(raw.body.partition_count, `${bodyLabel}.partition_count`, 1);
  if (!Array.isArray(raw.body.deterministic_listing_order)
    || raw.body.deterministic_listing_order.length !== listingCount) {
    throw new Error(`${bodyLabel}.deterministic_listing_order count mismatch`);
  }
  const listingOrder = raw.body.deterministic_listing_order.map((row, index) => {
    const rowLabel = `${bodyLabel}.deterministic_listing_order[${index}]`;
    exactKeys(row, ["index", "listing_key", "report_file"], rowLabel);
    if (row.index !== index) throw new Error(`${rowLabel}.index must be contiguous from zero`);
    return {
      index,
      listing_key: safeString(row.listing_key, `${rowLabel}.listing_key`, 1_000),
      report_file: relativeLockedPath(row.report_file, `${rowLabel}.report_file`),
    };
  });
  if (!Array.isArray(raw.body.deterministic_shard_order)
    || raw.body.deterministic_shard_order.length !== shardCount) {
    throw new Error(`${bodyLabel}.deterministic_shard_order count mismatch`);
  }
  const shardOrder = raw.body.deterministic_shard_order.map((row, index) => {
    const rowLabel = `${bodyLabel}.deterministic_shard_order[${index}]`;
    exactKeys(row, [
      "call_index", "shard_id", "image_count", "observation_batch_path", "partition_id",
    ], rowLabel);
    if (row.call_index !== index) throw new Error(`${rowLabel}.call_index must be contiguous from zero`);
    return {
      call_index: index,
      shard_id: safeId(row.shard_id, `${rowLabel}.shard_id`),
      image_count: safeInteger(row.image_count, `${rowLabel}.image_count`, 1),
      observation_batch_path: relativeLockedPath(
        row.observation_batch_path,
        `${rowLabel}.observation_batch_path`,
      ),
      partition_id: safeId(row.partition_id, `${rowLabel}.partition_id`),
    };
  });
  if (!Array.isArray(raw.body.observer_partitions)
    || raw.body.observer_partitions.length !== partitionCount) {
    throw new Error(`${bodyLabel}.observer_partitions count mismatch`);
  }
  const partitions = raw.body.observer_partitions.map((row, index) => {
    const rowLabel = `${bodyLabel}.observer_partitions[${index}]`;
    exactKeys(row, ["partition_id", "partition_index", "shard_ids"], rowLabel);
    if (row.partition_index !== index || !Array.isArray(row.shard_ids)
      || row.shard_ids.length < 1 || row.shard_ids.length > 6) {
      throw new Error(`${rowLabel} has invalid index or shard count`);
    }
    return {
      partition_id: safeId(row.partition_id, `${rowLabel}.partition_id`),
      partition_index: index,
      shard_ids: row.shard_ids.map((entry, shardIndex) => (
        safeId(entry, `${rowLabel}.shard_ids[${shardIndex}]`)
      )),
    };
  });
  const assuranceExpected = {
    source_byte_hashes_verified: true,
    executing_code_bytes_verified: true,
    asset_byte_hashes_verified: true,
    semantic_source_preflight_verified: true,
    bounded_listing_loader: true,
    observation_batches_read: false,
    reports_written: 0,
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
  };
  if (!exactJsonEqual(raw.body.assurance, assuranceExpected)) {
    throw new Error(`${bodyLabel}.assurance differs from the offline semantic preflight contract`);
  }
  const body = {
    run_id: safeId(raw.body.run_id, `${bodyLabel}.run_id`),
    run_lock_sha256: sha256String(raw.body.run_lock_sha256, `${bodyLabel}.run_lock_sha256`),
    family_created_at: canonicalTimestamp(raw.body.family_created_at, `${bodyLabel}.family_created_at`),
    executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
    code_bundle_id: safeString(raw.body.code_bundle_id, `${bodyLabel}.code_bundle_id`, 80),
    code_bundle_manifest_sha256: sha256String(
      raw.body.code_bundle_manifest_sha256,
      `${bodyLabel}.code_bundle_manifest_sha256`,
    ),
    listing_count: listingCount,
    image_count: safeInteger(raw.body.image_count, `${bodyLabel}.image_count`, 1),
    shard_count: shardCount,
    partition_count: partitionCount,
    authoritative_population: parseAuthoritativePopulation(
      raw.body.authoritative_population,
      `${bodyLabel}.authoritative_population`,
    ),
    deterministic_listing_order: listingOrder,
    deterministic_shard_order: shardOrder,
    observer_partitions: partitions,
    semantic_listings_verified: safeInteger(
      raw.body.semantic_listings_verified,
      `${bodyLabel}.semantic_listings_verified`,
      1,
    ),
    assurance: assuranceExpected,
  };
  if (!/^sha256:[a-f0-9]{64}$/u.test(body.code_bundle_id)) {
    throw new Error(`${bodyLabel}.code_bundle_id must be content-addressed`);
  }
  const bodySha = sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
  if (raw.body_sha256 !== bodySha
    || raw.certificate_id !== `walmart-listing-preflight-${bodySha}`) {
    throw new Error(`${label} seal mismatch`);
  }
  return {
    schema_version: WALMART_LISTING_INTEGRITY_PREFLIGHT_CERTIFICATE_SCHEMA,
    certificate_id: `walmart-listing-preflight-${bodySha}`,
    body_sha256: bodySha,
    body,
  };
}

function parseFlag(argument) {
  const equals = argument.indexOf("=");
  if (!argument.startsWith("--") || equals <= 2) throw new Error(`unsupported argument: ${argument}`);
  return [argument.slice(2, equals), argument.slice(equals + 1)];
}

/** Strict CLI parser; unknown/repeated flags are rejected. */
export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("argv must be an array");
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return { help: true };
  if (argv.length === 2 && ["plan", "audit", "verify"].includes(argv[0]) && argv[1] === "--help") {
    return { help: true };
  }
  const command = argv[0];
  if (command !== "plan" && command !== "audit" && command !== "verify") {
    throw new Error("first argument must be plan, audit, verify, or --help");
  }
  const flags = new Map();
  let requireComplete = false;
  for (const argument of argv.slice(1)) {
    if (argument === "--require-complete") {
      if (requireComplete) throw new Error("--require-complete was repeated");
      requireComplete = true;
      continue;
    }
    const [name, value] = parseFlag(argument);
    if (flags.has(name)) throw new Error(`--${name} was repeated`);
    flags.set(name, value);
  }
  const allowed = command === "plan"
    ? new Set(["run-lock", "expect-run-lock-sha256"])
    : command === "audit"
      ? new Set([
        "run-lock", "expect-run-lock-sha256", "preflight-certificate",
        "expect-preflight-certificate-sha256", "output-dir",
      ])
      : new Set([
        "run-lock", "expect-run-lock-sha256", "preflight-certificate",
        "expect-preflight-certificate-sha256", "reports-dir",
      ]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) throw new Error(`unsupported flag for ${command}: --${name}`);
  }
  for (const name of allowed) {
    if (!flags.has(name)) throw new Error(`${command} requires --${name}=...`);
  }
  if (command !== "verify" && requireComplete) {
    throw new Error("--require-complete is valid only for verify");
  }
  if (command === "verify" && !requireComplete) {
    throw new Error("verify requires --require-complete");
  }
  const parsed = {
    help: false,
    command,
    run_lock: absoluteCliPath(flags.get("run-lock"), "--run-lock"),
    expect_run_lock_sha256: sha256String(
      flags.get("expect-run-lock-sha256"),
      "--expect-run-lock-sha256",
    ),
  };
  if (command === "audit") {
    parsed.output_dir = absoluteCliPath(flags.get("output-dir"), "--output-dir");
  }
  if (command === "audit" || command === "verify") {
    parsed.preflight_certificate = absoluteCliPath(
      flags.get("preflight-certificate"),
      "--preflight-certificate",
    );
    parsed.expect_preflight_certificate_sha256 = sha256String(
      flags.get("expect-preflight-certificate-sha256"),
      "--expect-preflight-certificate-sha256",
    );
  }
  if (command === "verify") {
    parsed.reports_dir = absoluteCliPath(flags.get("reports-dir"), "--reports-dir");
    parsed.require_complete = true;
  }
  return parsed;
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

async function assertCreatableDirectoryHasNoSymlinkParents(targetPath, label) {
  const parent = path.dirname(targetPath);
  await assertExistingPathHasNoSymlinks(parent, "directory", `${label} parent`);
  try {
    await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must not already exist`);
}

function resolveLockedPath(lockDirectory, relativePath, label) {
  const resolved = path.resolve(lockDirectory, ...relativePath.split("/"));
  const relation = path.relative(lockDirectory, resolved);
  if (relation === "" || relation.startsWith(`..${path.sep}`) || relation === ".." || path.isAbsolute(relation)) {
    throw new Error(`${label} must resolve strictly below the run-lock directory`);
  }
  return resolved;
}

async function readBoundBytes(lockDirectory, ref, maximumBytes, label) {
  const file = resolveLockedPath(lockDirectory, ref.path, label);
  const info = await assertExistingPathHasNoSymlinks(file, "file", label);
  if (info.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const bytes = await readFile(file);
  if (bytes.byteLength !== info.size) throw new Error(`${label} changed while being read`);
  const digest = sha256Bytes(bytes);
  if (digest !== ref.sha256) throw new Error(`${label} exact-byte SHA-256 mismatch`);
  return { path: file, bytes };
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

async function readBoundJson(lockDirectory, ref, label) {
  const loaded = await readBoundBytes(lockDirectory, ref, MAX_JSON_SOURCE_BYTES, label);
  return { ...loaded, value: parseJsonBytes(loaded.bytes, label) };
}

/**
 * Verify the durable append-only reservation prefix for one permit. Historical
 * callers intentionally do not apply wall-clock expiry; signature, exact scope,
 * hashes, filesystem immutability, and every predecessor link still apply.
 */
export async function verifyWalmartListingIntegrityAllowanceLedgerForPermit({
  lock_directory: lockDirectory,
  run_lock: runLock,
  run_lock_sha256: runLockSha256,
  preflight_certificate_sha256: preflightCertificateSha256,
  permit,
  cache = new Map(),
}) {
  const parsedPermit = permit?.[VERIFIED_EXECUTION_PERMIT]
    ? permit
    : parseWalmartListingIntegrityExecutionPermit(permit, {
      run_lock: runLock,
      owner_execution_authority: runLock.owner_execution_authority,
      run_lock_sha256: runLockSha256,
      run_id: runLock.run_id,
      preflight_certificate_sha256: preflightCertificateSha256,
      family_created_at: runLock.created_at,
    });
  const authorization = parsedPermit.body.owner_authorization;
  const targetReservation = parsedPermit.body.allowance_reservation;
  let state = cache.get(authorization.authorization_sha256);
  if (!state) {
    state = { reservations: [], previous_reservation_sha256: authorization.authorization_sha256 };
    cache.set(authorization.authorization_sha256, state);
  }
  const targetSequence = targetReservation.body.sequence;
  for (let sequence = state.reservations.length; sequence <= targetSequence; sequence += 1) {
    const grant = authorization.signed_body.partition_grants[sequence];
    if (!grant) throw new Error("allowance ledger sequence exceeds signed owner authorization");
    const expectedSkeleton = {
      body: { sequence, partition_id: grant.partition_id },
    };
    const relative = walmartListingIntegrityAllowanceReservationRelativePath(
      authorization.authorization_sha256,
      expectedSkeleton,
    );
    const absolute = resolveLockedPath(lockDirectory, relative, `allowance ledger event ${sequence}`);
    const info = await assertExistingPathHasNoSymlinks(
      absolute,
      "file",
      `allowance ledger event ${sequence}`,
    );
    if ((info.mode & 0o777) !== 0o444) {
      throw new Error(`allowance ledger event ${sequence} mode must be exactly 0444`);
    }
    if (info.size > MAX_CONTROL_ARTIFACT_BYTES) {
      throw new Error(`allowance ledger event ${sequence} exceeds its byte cap`);
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== info.size) {
      throw new Error(`allowance ledger event ${sequence} changed while being read`);
    }
    const reservation = parseWalmartListingIntegrityAllowanceReservation(
      parseJsonBytes(bytes, `allowance ledger event ${sequence}`),
      {
        owner_authorization: authorization,
        previous_reservation_sha256: state.previous_reservation_sha256,
      },
    );
    state.reservations.push(reservation);
    state.previous_reservation_sha256 = reservation.body_sha256;
  }
  const persisted = state.reservations[targetSequence];
  if (!persisted || !exactJsonEqual(persisted, targetReservation)) {
    throw new Error("execution permit allowance reservation differs from durable ledger event");
  }
  return parsedPermit;
}

async function readExternalPreflightCertificate(options) {
  if (!options.preflight_certificate || !options.expect_preflight_certificate_sha256) {
    return null;
  }
  await assertExistingPathHasNoSymlinks(
    options.preflight_certificate,
    "file",
    "--preflight-certificate",
  );
  const info = await lstat(options.preflight_certificate);
  if ((info.mode & 0o777) !== 0o444) {
    throw new Error("preflight certificate mode must be exactly 0444");
  }
  if (info.size > MAX_CONTROL_ARTIFACT_BYTES) throw new Error("preflight certificate exceeds its byte cap");
  const bytes = await readFile(options.preflight_certificate);
  if (bytes.byteLength !== info.size) throw new Error("preflight certificate changed while being read");
  const exactByteSha = sha256Bytes(bytes);
  if (exactByteSha !== options.expect_preflight_certificate_sha256) {
    throw new Error("preflight certificate exact-byte SHA-256 differs from expectation");
  }
  return {
    exact_byte_sha256: exactByteSha,
    certificate: parseWalmartListingIntegrityPreflightCertificate(
      parseJsonBytes(bytes, "preflight certificate"),
    ),
  };
}

async function readExternalExecutionPermit(options) {
  if (!options.execution_permit || !options.expect_execution_permit_sha256) {
    throw new Error("partition execution requires an exact external execution permit");
  }
  await assertExistingPathHasNoSymlinks(options.execution_permit, "file", "--execution-permit");
  const info = await lstat(options.execution_permit);
  if ((info.mode & 0o777) !== 0o444) {
    throw new Error("execution permit mode must be exactly 0444");
  }
  if (info.size > MAX_CONTROL_ARTIFACT_BYTES) throw new Error("execution permit exceeds its byte cap");
  const bytes = await readFile(options.execution_permit);
  if (bytes.byteLength !== info.size) throw new Error("execution permit changed while being read");
  const exactByteSha = sha256Bytes(bytes);
  if (exactByteSha !== options.expect_execution_permit_sha256) {
    throw new Error("execution permit exact-byte SHA-256 differs from expectation");
  }
  return {
    exact_byte_sha256: exactByteSha,
    envelope: parseJsonBytes(bytes, "execution permit"),
  };
}

async function loadAuthoritativeItemReportCapture(lockDirectory, refs) {
  const bytes = async (key) => (
    await readBoundBytes(
      lockDirectory,
      refs[key],
      MAX_JSON_SOURCE_BYTES,
      `authoritative_item_report_capture.${key}`,
    )
  ).bytes;
  const json = async (key) => parseJsonBytes(
    await bytes(key),
    `authoritative_item_report_capture.${key}`,
  );
  const [
    createRequest, createResponse, readyRequest, readyPayload,
    locatorRequest, locatorResponse, fileRequest, downloadedBody,
    createHttp, readyHttp, locatorHttp, downloadHttp, trustedContext,
  ] = await Promise.all([
    bytes("create_request_manifest"),
    bytes("create_response_payload"),
    bytes("ready_status_request_manifest"),
    bytes("ready_status_payload"),
    bytes("download_locator_request_manifest"),
    bytes("download_locator_response_payload"),
    bytes("report_file_request_manifest"),
    bytes("downloaded_body"),
    json("http_create_response"),
    json("http_ready_status_response"),
    json("http_download_locator_response"),
    json("http_download_response"),
    json("trusted_context"),
  ]);
  return {
    capture: {
      create_request_manifest_bytes: new Uint8Array(createRequest),
      create_response_payload_bytes: new Uint8Array(createResponse),
      ready_status_request_manifest_bytes: new Uint8Array(readyRequest),
      ready_status_payload_bytes: new Uint8Array(readyPayload),
      download_locator_request_manifest_bytes: new Uint8Array(locatorRequest),
      download_locator_response_payload_bytes: new Uint8Array(locatorResponse),
      report_file_request_manifest_bytes: new Uint8Array(fileRequest),
      downloaded_body_bytes: new Uint8Array(downloadedBody),
      http: {
        create_response: createHttp,
        ready_status_response: readyHttp,
        download_locator_response: locatorHttp,
        download_response: downloadHttp,
      },
    },
    trusted_context: trustedContext,
  };
}

function parseCodeBundleManifest(raw) {
  const label = "code_bundle_manifest";
  exactKeys(raw, ["schema_version", "bundle_id", "runtime", "files"], label);
  if (raw.schema_version !== WALMART_LISTING_INTEGRITY_CODE_BUNDLE_SCHEMA) {
    throw new Error(`${label}.schema_version is unsupported`);
  }
  exactKeys(raw.runtime, ["node_version", "platform", "arch"], `${label}.runtime`);
  const runtime = {
    node_version: safeString(raw.runtime.node_version, `${label}.runtime.node_version`, 128),
    platform: safeString(raw.runtime.platform, `${label}.runtime.platform`, 64),
    arch: safeString(raw.runtime.arch, `${label}.runtime.arch`, 64),
  };
  if (runtime.node_version !== process.version || runtime.platform !== process.platform
    || runtime.arch !== process.arch) {
    throw new Error(`${label}.runtime differs from the executing Node runtime`);
  }
  if (!Array.isArray(raw.files)
    || raw.files.length !== WALMART_LISTING_INTEGRITY_REQUIRED_CODE_FILES.length) {
    throw new Error(`${label}.files must contain the exact reviewed production code set`);
  }
  const files = raw.files.map((entry, index) => {
    const entryLabel = `${label}.files[${index}]`;
    exactKeys(entry, ["path", "sha256"], entryLabel);
    return {
      path: relativeLockedPath(entry.path, `${entryLabel}.path`),
      sha256: sha256String(entry.sha256, `${entryLabel}.sha256`),
    };
  });
  const actualPaths = files.map((entry) => entry.path);
  if (!exactJsonEqual(actualPaths, WALMART_LISTING_INTEGRITY_REQUIRED_CODE_FILES)) {
    throw new Error(`${label}.files paths/order differ from the reviewed production code set`);
  }
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_CODE_BUNDLE_SCHEMA,
    runtime,
    files,
  };
  const expectedBundleId = `sha256:${sha256Bytes(Buffer.from(canonicalJson(body), "utf8"))}`;
  if (raw.bundle_id !== expectedBundleId) throw new Error(`${label}.bundle_id mismatch`);
  return { ...body, bundle_id: expectedBundleId };
}

async function readCurrentCodeFiles() {
  const files = [];
  for (const relativePath of WALMART_LISTING_INTEGRITY_REQUIRED_CODE_FILES) {
    const absolute = path.resolve(PACKAGE_ROOT, ...relativePath.split("/"));
    const relation = path.relative(PACKAGE_ROOT, absolute);
    if (relation.startsWith(`..${path.sep}`) || relation === ".." || path.isAbsolute(relation)) {
      throw new Error(`code bundle path escapes package root: ${relativePath}`);
    }
    const info = await assertExistingPathHasNoSymlinks(
      absolute,
      "file",
      `code bundle ${relativePath}`,
    );
    if (info.size > MAX_CODE_FILE_BYTES) {
      throw new Error(`code bundle ${relativePath} exceeds ${MAX_CODE_FILE_BYTES} bytes`);
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== info.size) {
      throw new Error(`code bundle ${relativePath} changed while being read`);
    }
    files.push({ path: relativePath, sha256: sha256Bytes(bytes) });
  }
  return files;
}

/** Build the manifest bytes that a separate run-lock builder must freeze. */
export async function buildCurrentCodeBundleManifest() {
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_CODE_BUNDLE_SCHEMA,
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    files: await readCurrentCodeFiles(),
  };
  return {
    ...body,
    bundle_id: `sha256:${sha256Bytes(Buffer.from(canonicalJson(body), "utf8"))}`,
  };
}

export async function verifyCurrentCodeBundleManifest(raw) {
  const parsed = parseCodeBundleManifest(raw);
  const actualFiles = await readCurrentCodeFiles();
  if (!exactJsonEqual(parsed.files, actualFiles)) {
    const mismatches = parsed.files
      .filter((entry, index) => entry.sha256 !== actualFiles[index]?.sha256)
      .map((entry) => entry.path)
      .slice(0, 20);
    throw new Error(`code_bundle_manifest does not match executing bytes: ${mismatches.join("|")}`);
  }
  return parsed;
}

function partitionForShard(runLock, shardId) {
  const matches = runLock.observer_partitions.filter((partition) => (
    partition.shard_ids.includes(shardId)
  ));
  if (matches.length !== 1) {
    throw new Error(`${shardId} must belong to exactly one observer partition`);
  }
  return matches[0];
}

function verifyObservationPermitAndTiming({
  batch,
  runLock,
  runLockSha256,
  shard,
  preflightCertificateSha256,
}) {
  if (!isRecord(batch.execution_permit)) {
    throw new Error(`${shard.shard_id} observation lacks its execution permit`);
  }
  const partition = partitionForShard(runLock, shard.shard_id);
  const permit = parseWalmartListingIntegrityExecutionPermit(batch.execution_permit, {
    run_lock: runLock,
    owner_execution_authority: runLock.owner_execution_authority,
    run_lock_sha256: runLockSha256,
    run_id: runLock.run_id,
    partition,
    shard_id: shard.shard_id,
    preflight_certificate_sha256: preflightCertificateSha256,
    family_created_at: runLock.created_at,
  });
  if (batch.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA) {
    if (batch.terminal_state !== "BLOCKED_AMBIGUOUS"
      || batch.audit_outcome !== "TECH_ERROR"
      || batch.execution?.pass_eligible !== false) {
      throw new Error(`${shard.shard_id} terminal artifact is not fail-closed`);
    }
    return permit;
  }
  const receiptBody = batch?.worker_receipt?.body;
  if (!isRecord(receiptBody)) throw new Error(`${shard.shard_id} signed worker receipt body is missing`);
  const reservation = canonicalTimestamp(
    receiptBody.reservation_reserved_at,
    `${shard.shard_id} worker_receipt.body.reservation_reserved_at`,
  );
  const issued = canonicalTimestamp(
    receiptBody.issued_at,
    `${shard.shard_id} worker_receipt.body.issued_at`,
  );
  const reservationMs = Date.parse(reservation);
  const issuedMs = Date.parse(issued);
  const maximumIssuedMs = reservationMs + runLock.observer_contract.vision_timeout_ms
    + runLock.observer_contract.observer_response_margin_ms;
  if (batch.created_at !== reservation
    || reservationMs < Date.parse(permit.body.created_at)
    || reservationMs >= Date.parse(permit.body.expires_at)
    || issuedMs < reservationMs || issuedMs > maximumIssuedMs) {
    throw new Error(`${shard.shard_id} signed worker timing is outside its locked permit/timeout bounds`);
  }
  const request = receiptBody.request_attestation;
  if (!isRecord(request)
    || request.execution_permit_sha256 !== permit.sha256
    || request.partition_id !== partition.partition_id) {
    throw new Error(`${shard.shard_id} signed worker request does not bind its execution permit/partition`);
  }
  return permit;
}

function workerContractFromRunLock(runLock) {
  const observer = runLock.observer_contract;
  return {
    worker_build: `sha256:${observer.worker_build_sha256}`,
    model: "sonnet",
    reasoning_effort: null,
    cli_version: observer.cli_version,
    node_version: observer.node_version,
    runtime_platform: observer.platform,
    runtime_arch: observer.arch,
    vision_timeout_ms: observer.vision_timeout_ms,
    reservation_ledger: observer.reservation_ledger,
  };
}

function parseObserverAttemptBody(raw, { runLock, runLockSha256, shard,
  preflightCertificateSha256, label }) {
  exactKeys(raw, [
    "schema_version", "executor_version", "run_lock_sha256", "shard_id", "call_index",
    "call_key", "reserved_at", "observation_batch_path", "provider", "worker_contract",
    "execution_permit", "prompt", "image_bindings", "local_ocr_sha256",
    "request_attestation", "execution_policy", "body_sha256",
  ], label);
  const { body_sha256: rawBodySha, ...body } = raw;
  const partition = partitionForShard(runLock, shard.shard_id);
  const permit = parseWalmartListingIntegrityExecutionPermit(raw.execution_permit, {
    run_lock: runLock,
    owner_execution_authority: runLock.owner_execution_authority,
    run_lock_sha256: runLockSha256,
    run_id: runLock.run_id,
    partition,
    shard_id: shard.shard_id,
    preflight_certificate_sha256: preflightCertificateSha256,
    family_created_at: runLock.created_at,
  });
  const reservedAt = canonicalTimestamp(raw.reserved_at, `${label}.reserved_at`);
  if (Date.parse(reservedAt) < Date.parse(permit.body.created_at)
    || Date.parse(reservedAt) >= Date.parse(permit.body.expires_at)) {
    throw new Error(`${label} reservation is outside its permit window`);
  }
  const requiredPermitHeadroomMs = runLock.observer_contract.vision_timeout_ms
    + runLock.observer_contract.observer_response_margin_ms;
  if (Date.parse(permit.body.expires_at) - Date.parse(reservedAt)
    < requiredPermitHeadroomMs) {
    throw new Error(`${label} reservation lacks the immutable worker timeout/response headroom`);
  }
  const workerContract = workerContractFromRunLock(runLock);
  const expectedCallKey = walmartListingObservationCallKey({
    run_lock_sha256: runLockSha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    worker_contract: workerContract,
    prompt_sha256: shard.prompt_sha256,
    image_bindings: shard.images,
  });
  const expectedRequest = {
    schema_version: WALMART_LISTING_WORKER_REQUEST_SCHEMA,
    run_lock_sha256: runLockSha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    call_key: expectedCallKey,
    prompt_sha256: shard.prompt_sha256,
    execution_permit_sha256: permit.sha256,
    partition_id: partition.partition_id,
    image_sha256: shard.images.map((row) => row.model_view_sha256),
  };
  const expectedPolicy = {
    transport_attempts: 1,
    retries: 0,
    fallbacks: 0,
    paid_api_calls: 0,
    openai_model_calls: 0,
    output_write_policy: "immutable_wx_0444",
  };
  if (raw.schema_version !== WALMART_LISTING_OBSERVER_ATTEMPT_SCHEMA
    || raw.executor_version !== WALMART_LISTING_OBSERVER_EXECUTOR_VERSION
    || raw.run_lock_sha256 !== runLockSha256
    || raw.shard_id !== shard.shard_id
    || raw.call_index !== shard.call_index
    || raw.call_key !== expectedCallKey
    || raw.observation_batch_path !== shard.observation_batch_path
    || raw.provider !== "claude_cli_subscription"
    || !exactJsonEqual(raw.worker_contract, workerContract)
    || !exactJsonEqual(raw.execution_permit, permit)
    || !exactJsonEqual(raw.prompt, {
      version: BLIND_PROMPT_VERSION,
      sha256: shard.prompt_sha256,
    })
    || !exactJsonEqual(raw.image_bindings, shard.images)
    || !exactJsonEqual(raw.request_attestation, expectedRequest)
    || !exactJsonEqual(raw.execution_policy, expectedPolicy)) {
    throw new Error(`${label} differs from the immutable call contract`);
  }
  sha256String(raw.local_ocr_sha256, `${label}.local_ocr_sha256`);
  const bodySha = sha256String(rawBodySha, `${label}.body_sha256`);
  if (bodySha !== walmartListingObservationSha256(body)) {
    throw new Error(`${label} body SHA mismatch`);
  }
  return {
    ...raw,
    reserved_at: reservedAt,
    execution_permit: permit,
    body_sha256: bodySha,
  };
}

function verifyTerminalAttemptBody(raw, { terminal, runLock, runLockSha256, shard,
  preflightCertificateSha256 }) {
  const attempt = parseObserverAttemptBody(raw, {
    runLock,
    runLockSha256,
    shard,
    preflightCertificateSha256,
    label: `${shard.shard_id} terminal attempt`,
  });
  const workerContract = workerContractFromRunLock(runLock);
  const expectedCallKey = walmartListingObservationCallKey({
    run_lock_sha256: runLockSha256,
    shard_id: shard.shard_id,
    call_index: shard.call_index,
    worker_contract: workerContract,
    prompt_sha256: shard.prompt_sha256,
    image_bindings: shard.images,
  });
  if (terminal.attempt_body_sha256 !== attempt.body_sha256
    || terminal.reserved_at !== attempt.reserved_at
    || terminal.call_key !== expectedCallKey
    || !exactJsonEqual(terminal.execution_permit, attempt.execution_permit)
    || !exactJsonEqual(terminal.worker_contract, workerContract)
    || !exactJsonEqual(terminal.prompt, attempt.prompt)
    || !exactJsonEqual(terminal.image_bindings, shard.images)) {
    throw new Error(`${shard.shard_id} terminal does not exactly bind its immutable attempt`);
  }
  return attempt;
}

function verifySuccessfulAttemptBody(raw, { batch, runLock, runLockSha256, shard,
  preflightCertificateSha256 }) {
  const attempt = parseObserverAttemptBody(raw, {
    runLock,
    runLockSha256,
    shard,
    preflightCertificateSha256,
    label: `${shard.shard_id} successful attempt`,
  });
  const receiptBody = batch?.worker_receipt?.body;
  if (!isRecord(receiptBody)) {
    throw new Error(`${shard.shard_id} successful observation lacks its signed worker receipt`);
  }
  const signedReservation = canonicalTimestamp(
    receiptBody.reservation_reserved_at,
    `${shard.shard_id} successful receipt reservation_reserved_at`,
  );
  const signedIssuedAt = canonicalTimestamp(
    receiptBody.issued_at,
    `${shard.shard_id} successful receipt issued_at`,
  );
  const attemptMs = Date.parse(attempt.reserved_at);
  const signedReservationMs = Date.parse(signedReservation);
  const signedIssuedMs = Date.parse(signedIssuedAt);
  const requiredObservationWindowMs = runLock.observer_contract.vision_timeout_ms
    + runLock.observer_contract.observer_response_margin_ms;
  if (batch.call_key !== attempt.call_key
    || !exactJsonEqual(batch.execution_permit, attempt.execution_permit)
    || !exactJsonEqual(batch.worker_contract, attempt.worker_contract)
    || !exactJsonEqual(batch.prompt, attempt.prompt)
    || !exactJsonEqual(batch.image_bindings, attempt.image_bindings)
    || !exactJsonEqual(receiptBody.request_attestation, attempt.request_attestation)
    || walmartListingObservationSha256(batch.local_ocr) !== attempt.local_ocr_sha256) {
    throw new Error(`${shard.shard_id} successful observation does not exactly bind its immutable pre-POST attempt`);
  }
  if (attemptMs > signedReservationMs
    || signedIssuedMs < signedReservationMs
    || signedIssuedMs > attemptMs + requiredObservationWindowMs) {
    throw new Error(`${shard.shard_id} successful observation timing does not satisfy the required pre-POST ordering within the immutable worker window`);
  }
  return attempt;
}

async function readImmutableObserverJson(targetPath, label, maximumBytes) {
  const before = await assertExistingPathHasNoSymlinks(targetPath, "file", label);
  if ((before.mode & 0o777) !== 0o444) throw new Error(`${label} mode must be exactly 0444`);
  if (before.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const bytes = await readFile(targetPath);
  const after = await lstat(targetPath);
  if (!after.isFile()
    || after.isSymbolicLink()
    || bytes.byteLength !== before.size
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mode !== before.mode
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs) {
    throw new Error(`${label} changed while being read`);
  }
  return parseJsonBytes(bytes, label);
}

async function verifyObserverAttemptSibling({
  observationPath,
  artifact,
  runLock,
  runLockSha256,
  shard,
  preflightCertificateSha256,
}) {
  const attemptPath = `${observationPath}.attempt.json`;
  const terminal = artifact.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA;
  const label = `${shard.shard_id} ${terminal ? "terminal" : "successful"} attempt sibling`;
  const parsed = await readImmutableObserverJson(
    attemptPath,
    label,
    MAX_OBSERVER_ATTEMPT_BYTES,
  );
  return terminal
    ? verifyTerminalAttemptBody(parsed, {
      terminal: artifact,
      runLock,
      runLockSha256,
      shard,
      preflightCertificateSha256,
    })
    : verifySuccessfulAttemptBody(parsed, {
      batch: artifact,
      runLock,
      runLockSha256,
      shard,
      preflightCertificateSha256,
    });
}

function validateBaseInput(baseInput, listingRef) {
  exactKeys(baseInput, [
    "schema_version", "listing", "source_bindings", "expected", "surface", "images",
  ], `${listingRef.listing_key} base_input`);
  if (baseInput.schema_version !== WALMART_LISTING_INTEGRITY_INPUT_SCHEMA) {
    throw new Error(`${listingRef.listing_key} base_input schema is unsupported`);
  }
  if (!isRecord(baseInput.listing)
    || baseInput.listing.listing_key !== listingRef.listing_key
    || baseInput.listing.item_id !== listingRef.item_id) {
    throw new Error(`${listingRef.listing_key} base_input listing identity mismatch`);
  }
  exactKeys(baseInput.images, ["assets", "evidence", "duplicate_summary"], `${listingRef.listing_key} base_input.images`);
  if (!Array.isArray(baseInput.images.evidence) || baseInput.images.evidence.length !== 0
    || baseInput.images.duplicate_summary !== null) {
    throw new Error(`${listingRef.listing_key} base_input must have empty evidence and null duplicate_summary`);
  }
  if (!Array.isArray(baseInput.images.assets)
    || baseInput.images.assets.length !== listingRef.assets.length) {
    throw new Error(`${listingRef.listing_key} base_input asset population mismatch`);
  }
  for (let index = 0; index < listingRef.assets.length; index += 1) {
    const lockedAsset = listingRef.assets[index];
    const inputAsset = baseInput.images.assets[index];
    if (!isRecord(inputAsset) || inputAsset.slot !== lockedAsset.slot
      || inputAsset.sha256 !== lockedAsset.buyer_asset.sha256) {
      throw new Error(`${listingRef.listing_key}/${lockedAsset.slot} base_input asset binding mismatch`);
    }
  }
}

/**
 * Mass-safe observer bootstrap. It verifies the immutable family, executing
 * code, reusable semantic certificate, and one fresh partition permit, then
 * opens only the buyer/model bytes selected by that partition. It never reads
 * the full Product Truth/common-source set and never loops unrelated listings.
 */
export async function loadPinnedObserverPartitionContext(options) {
  const runLockPath = absoluteCliPath(options.run_lock, "--run-lock");
  const expectedRunLockSha = sha256String(
    options.expect_run_lock_sha256,
    "--expect-run-lock-sha256",
  );
  await assertExistingPathHasNoSymlinks(runLockPath, "file", "--run-lock");
  const runLockInfo = await lstat(runLockPath);
  if (runLockInfo.size > MAX_RUN_LOCK_BYTES) throw new Error("run-lock exceeds its byte cap");
  const runLockBytes = await readFile(runLockPath);
  if (runLockBytes.byteLength !== runLockInfo.size) throw new Error("run-lock changed while being read");
  const runLockSha = sha256Bytes(runLockBytes);
  if (runLockSha !== expectedRunLockSha) {
    throw new Error("run-lock exact-byte SHA-256 differs from --expect-run-lock-sha256");
  }
  const runLock = parseRunLock(parseJsonBytes(runLockBytes, "run-lock"));
  const lockDirectory = path.dirname(runLockPath);
  const codeBundle = await readBoundJson(
    lockDirectory,
    runLock.code_bundle_manifest,
    "code_bundle_manifest",
  );
  const verifiedCodeBundle = await verifyCurrentCodeBundleManifest(codeBundle.value);
  const preflight = await readExternalPreflightCertificate({
    preflight_certificate: absoluteCliPath(
      options.preflight_certificate,
      "--preflight-certificate",
    ),
    expect_preflight_certificate_sha256: sha256String(
      options.expect_preflight_certificate_sha256,
      "--expect-preflight-certificate-sha256",
    ),
  });
  if (!preflight) throw new Error("observer partition requires a preflight certificate");
  const context = {
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    lock_directory: lockDirectory,
    code_bundle_manifest: verifiedCodeBundle,
    code_bundle_manifest_sha256: runLock.code_bundle_manifest.sha256,
    preflight_certificate: preflight.certificate,
    preflight_certificate_sha256: preflight.exact_byte_sha256,
    listings: runLock.listings.map((ref) => ({ ref })),
  };
  assertPreflightCertificateMatchesRunLockMetadata(context);
  const partitionId = safeId(options.partition_id, "--partition-id");
  const partition = runLock.observer_partitions.find((row) => row.partition_id === partitionId);
  if (!partition) throw new Error("--partition-id is not present in the family run-lock");
  const permitFile = await readExternalExecutionPermit({
    execution_permit: absoluteCliPath(options.execution_permit, "--execution-permit"),
    expect_execution_permit_sha256: sha256String(
      options.expect_execution_permit_sha256,
      "--expect-execution-permit-sha256",
    ),
  });
  const permit = parseWalmartListingIntegrityExecutionPermit(permitFile.envelope, {
    run_lock: runLock,
    owner_execution_authority: runLock.owner_execution_authority,
    run_lock_sha256: runLockSha,
    run_id: runLock.run_id,
    partition,
    preflight_certificate_sha256: preflight.exact_byte_sha256,
    family_created_at: runLock.created_at,
  });
  await verifyWalmartListingIntegrityAllowanceLedgerForPermit({
    lock_directory: lockDirectory,
    run_lock: runLock,
    run_lock_sha256: runLockSha,
    preflight_certificate_sha256: preflight.exact_byte_sha256,
    permit,
  });
  const shardById = new Map(runLock.shards.map((shard) => [shard.shard_id, shard]));
  const shards = partition.shard_ids.map((shardId) => {
    const shard = shardById.get(shardId);
    if (!shard) throw new Error(`${partition.partition_id} references a missing shard`);
    return shard;
  });
  const listingByKey = new Map(runLock.listings.map((listing) => [listing.listing_key, listing]));
  const selectedListingKeys = [...new Set(shards.flatMap((shard) => (
    shard.images.map((image) => image.listing_key)
  )))];
  const selectedListings = selectedListingKeys.map((listingKey) => {
    const ref = listingByKey.get(listingKey);
    if (!ref) throw new Error(`${partition.partition_id} references an unlocked listing`);
    return { ref };
  });
  const selectedAssetBytes = new Map();
  const selectedModelViews = new Map();
  for (const shard of shards) {
    for (const image of shard.images) {
      const listing = listingByKey.get(image.listing_key);
      const asset = listing?.assets.find((row) => row.slot === image.slot);
      if (!asset) throw new Error(`${shard.shard_id}/${image.image_id} asset binding is missing`);
      const buyer = await readBoundBytes(
        lockDirectory,
        asset.buyer_asset,
        MAX_ASSET_BYTES,
        `${shard.shard_id}/${image.image_id} buyer asset`,
      );
      const model = await readBoundBytes(
        lockDirectory,
        asset.model_view,
        MAX_ASSET_BYTES,
        `${shard.shard_id}/${image.image_id} model view`,
      );
      const preprocessed = await preprocessCatalogVisual(buyer.bytes);
      const full = preprocessed.views.filter((view) => view.role === "full");
      if (full.length !== 1 || full[0].sha256 !== image.model_view_sha256
        || !Buffer.from(full[0].bytes).equals(model.bytes)) {
        throw new Error(`${shard.shard_id}/${image.image_id} selected model view does not rebuild`);
      }
      if (selectedAssetBytes.has(image.image_id) || selectedModelViews.has(image.image_id)) {
        throw new Error(`${partition.partition_id} repeats selected image ${image.image_id}`);
      }
      selectedAssetBytes.set(image.image_id, new Uint8Array(buyer.bytes));
      selectedModelViews.set(image.image_id, new Uint8Array(model.bytes));
    }
  }
  return {
    ...context,
    partition,
    execution_permit: permit,
    execution_permit_file_sha256: permitFile.exact_byte_sha256,
    shards,
    listings: selectedListings,
    selected_asset_bytes: selectedAssetBytes,
    selected_model_views: selectedModelViews,
    common_sources_read: false,
  };
}

export async function loadPinnedContext(options, { observationsRequired }) {
  await assertExistingPathHasNoSymlinks(options.run_lock, "file", "--run-lock");
  const runLockInfo = await lstat(options.run_lock);
  if (runLockInfo.size > MAX_RUN_LOCK_BYTES) throw new Error("run-lock exceeds its byte cap");
  const runLockBytes = await readFile(options.run_lock);
  if (runLockBytes.byteLength !== runLockInfo.size) throw new Error("run-lock changed while being read");
  const actualRunLockSha = sha256Bytes(runLockBytes);
  if (actualRunLockSha !== options.expect_run_lock_sha256) {
    throw new Error("run-lock exact-byte SHA-256 differs from --expect-run-lock-sha256");
  }
  const runLock = parseRunLock(parseJsonBytes(runLockBytes, "run-lock"));
  const preflightCertificate = await readExternalPreflightCertificate(options);
  if (observationsRequired && !preflightCertificate) {
    throw new Error("audit/verify require the exact external preflight certificate");
  }
  if (preflightCertificate
    && (preflightCertificate.certificate.body.run_lock_sha256 !== actualRunLockSha
      || preflightCertificate.certificate.body.run_id !== runLock.run_id)) {
    throw new Error("preflight certificate is bound to a different family run-lock");
  }
  const lockDirectory = path.dirname(options.run_lock);
  const codeBundle = await readBoundJson(
    lockDirectory,
    runLock.code_bundle_manifest,
    "code_bundle_manifest",
  );
  const verifiedCodeBundle = await verifyCurrentCodeBundleManifest(codeBundle.value);
  const productTruth = await readBoundJson(
    lockDirectory,
    runLock.source_artifacts.product_truth_snapshot,
    "product_truth_snapshot",
  );
  const buyerIndex = await readBoundJson(
    lockDirectory,
    runLock.source_artifacts.buyer_snapshot_index,
    "buyer_snapshot_index",
  );
  const catalogTruth = await readBoundJson(
    lockDirectory,
    runLock.source_artifacts.catalog_truth_export,
    "catalog_truth_export",
  );
  const authoritativeScope = await readBoundJson(
    lockDirectory,
    runLock.source_artifacts.authoritative_published_scope,
    "authoritative_published_scope",
  );
  const authoritativeItemReport = await readBoundJson(
    lockDirectory,
    runLock.source_artifacts.authoritative_item_report_source,
    "authoritative_item_report_source",
  );
  const authoritativeItemReportCapture = await loadAuthoritativeItemReportCapture(
    lockDirectory,
    runLock.source_artifacts.authoritative_item_report_capture,
  );
  // Listing-local JSON and image bytes are deliberately loaded on demand.
  // Keeping every buyer/gallery image resident at once made a full catalog run
  // scale with total catalog bytes instead of the largest single listing.
  const listings = runLock.listings.map((ref) => ({ ref }));
  const observationByPath = new Map();
  const allowanceLedgerCache = new Map();
  for (const shard of runLock.shards) {
    const absolute = resolveLockedPath(
      lockDirectory,
      shard.observation_batch_path,
      `${shard.shard_id} observation_batch_path`,
    );
    if (!observationsRequired) continue;
    const observationLabel = `${shard.shard_id} observation batch`;
    const batch = verifyWalmartListingObservationArtifact(
      await readImmutableObserverJson(absolute, observationLabel, MAX_OBSERVATION_BYTES),
      actualRunLockSha,
    );
    const observer = runLock.observer_contract;
    if (batch.run_lock_sha256 !== actualRunLockSha
      || batch.shard_id !== shard.shard_id
      || batch.call_index !== shard.call_index
      || batch.prompt.sha256 !== shard.prompt_sha256
      || !exactJsonEqual(batch.image_bindings, shard.images)
      || batch.worker_contract.worker_build !== `sha256:${observer.worker_build_sha256}`
      || batch.worker_contract.model !== observer.model
      || batch.worker_contract.cli_version !== observer.cli_version
      || batch.worker_contract.node_version !== observer.node_version
      || batch.worker_contract.runtime_platform !== observer.platform
      || batch.worker_contract.runtime_arch !== observer.arch
      || batch.worker_contract.vision_timeout_ms !== observer.vision_timeout_ms
      || !exactJsonEqual(batch.worker_contract.reservation_ledger, observer.reservation_ledger)
      || (batch.schema_version === WALMART_LISTING_OBSERVATION_BATCH_SCHEMA
        && (batch.worker_receipt.key_id !== observer.worker_receipt_key_id
          || batch.worker_receipt.public_key_spki_sha256
            !== observer.worker_receipt_public_key_sha256
          || batch.local_ocr.some((row) => (
            row.ocr_script_sha256 !== observer.local_ocr_script_sha256
          ))))) {
      throw new Error(`${shard.shard_id} sealed observation batch differs from the immutable run-lock`);
    }
    const observationPermit = verifyObservationPermitAndTiming({
      batch,
      runLock,
      runLockSha256: actualRunLockSha,
      shard,
      preflightCertificateSha256: preflightCertificate.exact_byte_sha256,
    });
    await verifyWalmartListingIntegrityAllowanceLedgerForPermit({
      lock_directory: lockDirectory,
      run_lock: runLock,
      run_lock_sha256: actualRunLockSha,
      preflight_certificate_sha256: preflightCertificate.exact_byte_sha256,
      permit: observationPermit,
      cache: allowanceLedgerCache,
    });
    await verifyObserverAttemptSibling({
      observationPath: absolute,
      artifact: batch,
      runLock,
      runLockSha256: actualRunLockSha,
      shard,
      preflightCertificateSha256: preflightCertificate.exact_byte_sha256,
    });
    observationByPath.set(shard.observation_batch_path, batch);
  }
  return {
    run_lock: runLock,
    run_lock_sha256: actualRunLockSha,
    lock_directory: lockDirectory,
    code_bundle_manifest: verifiedCodeBundle,
    code_bundle_manifest_sha256: runLock.code_bundle_manifest.sha256,
    preflight_certificate: preflightCertificate?.certificate ?? null,
    preflight_certificate_sha256: preflightCertificate?.exact_byte_sha256 ?? null,
    common_sources: {
      authoritative_published_scope: authoritativeScope.value,
      authoritative_item_report_source: authoritativeItemReport.value,
      authoritative_item_report_capture: authoritativeItemReportCapture.capture,
      authoritative_item_report_trusted_context:
        authoritativeItemReportCapture.trusted_context,
      product_truth_snapshot: productTruth.value,
      buyer_snapshot_index: buyerIndex.value,
      catalog_truth_export: catalogTruth.value,
    },
    listings,
    observation_by_path: observationByPath,
  };
}

/**
 * Load and verify one listing at a time. Callers must discard the returned
 * image maps before advancing so catalog execution remains memory bounded.
 */
export async function loadPinnedListingContext(context, listingRef) {
  const lockDirectory = context.lock_directory;
  const baseInput = await readBoundJson(
    lockDirectory,
    listingRef.base_input,
    `${listingRef.listing_key} base_input`,
  );
  validateBaseInput(baseInput.value, listingRef);
  const surface = await readBoundJson(
    lockDirectory,
    listingRef.surface_snapshot,
    `${listingRef.listing_key} surface_snapshot`,
  );
  const buyer = await readBoundJson(
    lockDirectory,
    listingRef.buyer_snapshot_manifest,
    `${listingRef.listing_key} buyer_snapshot_manifest`,
  );
  const sellerPayload = await readBoundJson(
    lockDirectory,
    listingRef.seller_item_payload,
    `${listingRef.listing_key} seller_item_payload`,
  );
  const catalogPayload = await readBoundJson(
    lockDirectory,
    listingRef.catalog_search_payload,
    `${listingRef.listing_key} catalog_search_payload`,
  );
  const buyerPayload = await readBoundJson(
    lockDirectory,
    listingRef.buyer_pdp_payload,
    `${listingRef.listing_key} buyer_pdp_payload`,
  );
  const assetBytes = new Map();
  const modelViews = new Map();
  for (const asset of listingRef.assets) {
    const buyerAsset = await readBoundBytes(
      lockDirectory,
      asset.buyer_asset,
      MAX_ASSET_BYTES,
      `${listingRef.listing_key}/${asset.slot} buyer_asset`,
    );
    const modelView = await readBoundBytes(
      lockDirectory,
      asset.model_view,
      MAX_ASSET_BYTES,
      `${listingRef.listing_key}/${asset.slot} model_view`,
    );
    const preprocessed = await preprocessCatalogVisual(buyerAsset.bytes);
    const fullViews = preprocessed.views.filter((view) => view.role === "full");
    if (preprocessed.source.sha256 !== asset.buyer_asset.sha256 || fullViews.length !== 1
      || fullViews[0].sha256 !== asset.model_view.sha256
      || !Buffer.from(fullViews[0].bytes).equals(modelView.bytes)) {
      throw new Error(`${listingRef.listing_key}/${asset.slot} model view does not rebuild from buyer bytes`);
    }
    assetBytes.set(asset.slot, new Uint8Array(buyerAsset.bytes));
    modelViews.set(asset.slot, new Uint8Array(modelView.bytes));
  }
  return {
    ref: listingRef,
    base_input: baseInput.value,
    surface_snapshot: surface.value,
    buyer_snapshot_manifest: buyer.value,
    seller_item_payload: sellerPayload.value,
    catalog_search_payload: catalogPayload.value,
    buyer_pdp_payload: buyerPayload.value,
    asset_bytes: assetBytes,
    model_views: modelViews,
  };
}

function observationsArray(batch, label) {
  if (!isRecord(batch?.result) || !Array.isArray(batch.result.observations)) {
    throw new Error(`${label}.result.observations must be an array`);
  }
  return batch.result.observations;
}

function observationEvidenceRows(batch, label) {
  if (!Array.isArray(batch.local_ocr)) {
    throw new Error(`${label}.local_ocr must be an array`);
  }
  return batch.local_ocr;
}

/**
 * Deterministically join locked shard membership to precomputed observations.
 * The source-aware production verifier independently validates every raw batch;
 * this join is not a trust decision.
 */
export function assembleListingInput(baseInput, listingRef, shards, observationByPath) {
  validateBaseInput(baseInput, listingRef);
  const evidenceBySlot = new Map();
  for (const shard of shards) {
    const batch = observationByPath.get(shard.observation_batch_path);
    if (!batch) throw new Error(`${shard.shard_id} observation batch is missing`);
    if (batch.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA) {
      for (const image of shard.images.filter((row) => (
        row.listing_key === listingRef.listing_key
      ))) {
        if (evidenceBySlot.has(image.slot)) {
          throw new Error(`${listingRef.listing_key}/${image.slot} has duplicate terminal evidence`);
        }
        evidenceBySlot.set(image.slot, {
          slot: image.slot,
          asset_sha256: image.asset_sha256,
          state: "technical_error",
          error: `immutable terminal ${batch.artifact_id}/${batch.body_sha256}; ambiguous attempt ${batch.attempt_body_sha256}; model result unavailable and retry forbidden`,
        });
      }
      continue;
    }
    const observations = observationsArray(batch, shard.shard_id);
    const observationByImageId = new Map();
    for (const observation of observations) {
      if (!isRecord(observation)) throw new Error(`${shard.shard_id} contains a non-object observation`);
      const imageId = safeString(observation.image_id, `${shard.shard_id} observation.image_id`, 130);
      if (observationByImageId.has(imageId)) throw new Error(`${shard.shard_id} duplicates observation ${imageId}`);
      observationByImageId.set(imageId, observation);
    }
    const auxiliaryByImageId = new Map();
    for (const row of observationEvidenceRows(batch, shard.shard_id)) {
      if (!isRecord(row)) throw new Error(`${shard.shard_id} contains non-object evidence_by_image`);
      const imageId = safeString(row.image_id, `${shard.shard_id} evidence image_id`, 130);
      if (auxiliaryByImageId.has(imageId)) throw new Error(`${shard.shard_id} duplicates auxiliary OCR ${imageId}`);
      auxiliaryByImageId.set(imageId, {
        auxiliary_ocr: row.auxiliary_ocr,
        local_ocr_truncated: row.truncated,
      });
    }
    for (const image of shard.images.filter((row) => row.listing_key === listingRef.listing_key)) {
      const observation = observationByImageId.get(image.image_id);
      const localOcr = auxiliaryByImageId.get(image.image_id);
      if (!observation || localOcr === undefined) {
        throw new Error(`${shard.shard_id}/${image.image_id} lacks exact observation/OCR evidence`);
      }
      if (evidenceBySlot.has(image.slot)) {
        throw new Error(`${listingRef.listing_key}/${image.slot} has duplicate observation evidence`);
      }
      evidenceBySlot.set(image.slot, {
        slot: image.slot,
        asset_sha256: image.asset_sha256,
        state: "observed",
        observation,
        auxiliary_ocr: localOcr.auxiliary_ocr,
        local_ocr_truncated: localOcr.local_ocr_truncated,
      });
    }
  }
  const evidence = listingRef.assets.map((asset) => {
    const row = evidenceBySlot.get(asset.slot);
    if (!row) throw new Error(`${listingRef.listing_key}/${asset.slot} observation evidence is missing`);
    return row;
  });
  return {
    ...baseInput,
    images: {
      ...baseInput.images,
      evidence,
      duplicate_summary: null,
    },
  };
}

function relevantShards(context, listingRef) {
  const wanted = new Set(listingRef.shard_ids);
  return context.run_lock.shards.filter((shard) => wanted.has(shard.shard_id));
}

function buildSources(context, listingContext, shards) {
  const artifacts = shards.map((shard) => {
    const batch = context.observation_by_path.get(shard.observation_batch_path);
    if (!batch) throw new Error(`${shard.shard_id} observation batch is missing`);
    return batch;
  });
  const observationBatches = artifacts.filter((artifact) => (
    artifact.schema_version === WALMART_LISTING_OBSERVATION_BATCH_SCHEMA
  ));
  const terminalArtifacts = artifacts.filter((artifact) => (
    artifact.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA
  ));
  return {
    ...context.common_sources,
    buyer_snapshot_manifest: listingContext.buyer_snapshot_manifest,
    seller_item_payload: listingContext.seller_item_payload,
    catalog_search_payload: listingContext.catalog_search_payload,
    buyer_pdp_payload: listingContext.buyer_pdp_payload,
    surface_snapshot: listingContext.surface_snapshot,
    asset_bytes: listingContext.asset_bytes,
    // These fields are consumed by the observation-aware source verifier. They
    // are intentionally passed even on an older build so PASS remains blocked.
    observation_batches: observationBatches,
    observation_terminal_artifacts: terminalArtifacts,
    run_lock_sha256: context.run_lock_sha256,
    code_bundle_id: context.code_bundle_manifest.bundle_id,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256,
    worker_receipt_key_id: context.run_lock.observer_contract.worker_receipt_key_id,
    worker_receipt_public_key_sha256:
      context.run_lock.observer_contract.worker_receipt_public_key_sha256,
    observation_shards: shards,
    observer_contract: context.run_lock.observer_contract,
  };
}

function assertPassHasVerifiedObservations(report, listingKey, hasTechnicalTerminal = false) {
  if (hasTechnicalTerminal && report?.overall_verdict === "PASS") {
    throw new Error(`${listingKey}: PASS is forbidden when an image has a technical terminal`);
  }
  if (report?.overall_verdict === "PASS"
    && report?.assurance?.observation_artifacts_verified !== true) {
    throw new Error(`${listingKey}: PASS is forbidden until observation artifacts are source-verified`);
  }
}

export function reportFilename(index, listingKey) {
  const ordinal = String(index + 1).padStart(6, "0");
  return `report-${ordinal}-${sha256Bytes(Buffer.from(listingKey, "utf8")).slice(0, 16)}.json`;
}

function preflightAssurance() {
  return {
    source_byte_hashes_verified: true,
    executing_code_bytes_verified: true,
    asset_byte_hashes_verified: true,
    semantic_source_preflight_verified: true,
    bounded_listing_loader: true,
    observation_batches_read: false,
    reports_written: 0,
    network_calls: 0,
    model_calls: 0,
    database_reads: 0,
    database_writes: 0,
    marketplace_reads: 0,
    marketplace_writes: 0,
  };
}

function deterministicListingOrder(context) {
  return context.listings.map((listing, index) => ({
    index,
    listing_key: listing.ref.listing_key,
    report_file: reportFilename(index, listing.ref.listing_key),
  }));
}

function deterministicShardOrder(context) {
  return context.run_lock.shards.map((shard) => ({
    call_index: shard.call_index,
    shard_id: shard.shard_id,
    image_count: shard.images.length,
    observation_batch_path: shard.observation_batch_path,
    partition_id: partitionForShard(context.run_lock, shard.shard_id).partition_id,
  }));
}

export function buildWalmartListingIntegrityPreflightCertificate(context, semantic) {
  const body = {
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_sha256,
    family_created_at: context.run_lock.created_at,
    executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
    code_bundle_id: context.code_bundle_manifest.bundle_id,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256,
    listing_count: context.listings.length,
    image_count: context.run_lock.shards.reduce((sum, shard) => sum + shard.images.length, 0),
    shard_count: context.run_lock.shards.length,
    partition_count: context.run_lock.observer_partitions.length,
    authoritative_population: semantic.population,
    deterministic_listing_order: deterministicListingOrder(context),
    deterministic_shard_order: deterministicShardOrder(context),
    observer_partitions: context.run_lock.observer_partitions,
    semantic_listings_verified: semantic.listings_verified,
    assurance: preflightAssurance(),
  };
  const bodySha = sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
  return parseWalmartListingIntegrityPreflightCertificate({
    schema_version: WALMART_LISTING_INTEGRITY_PREFLIGHT_CERTIFICATE_SCHEMA,
    certificate_id: `walmart-listing-preflight-${bodySha}`,
    body_sha256: bodySha,
    body,
  });
}

export function assertPreflightCertificateMatchesContext(context, population) {
  if (!context.preflight_certificate) throw new Error("preflight certificate is missing");
  const expected = buildWalmartListingIntegrityPreflightCertificate(context, {
    population,
    listings_verified: context.listings.length,
  });
  if (!exactJsonEqual(context.preflight_certificate, expected)) {
    throw new Error("preflight certificate does not exactly bind this full family/source population");
  }
  return expected;
}

/**
 * Rebuild only family metadata already sealed by the full semantic plan. This
 * is the O(run-lock + selected partition) check used before later batches; it
 * deliberately does not reopen every Product Truth/buyer source artifact.
 */
export function assertPreflightCertificateMatchesRunLockMetadata(context) {
  const certificate = context.preflight_certificate;
  if (!certificate) throw new Error("preflight certificate is missing");
  const familyContext = {
    ...context,
    listings: context.run_lock.listings.map((ref) => ({ ref })),
  };
  const expected = buildWalmartListingIntegrityPreflightCertificate(familyContext, {
    population: certificate.body.authoritative_population,
    listings_verified: certificate.body.semantic_listings_verified,
  });
  if (certificate.body.semantic_listings_verified !== context.run_lock.listings.length
    || !exactJsonEqual(certificate, expected)) {
    throw new Error("preflight certificate metadata does not exactly bind the full family run-lock");
  }
  return certificate;
}

async function compileAll(context, compileAgainstSources) {
  const compiled = [];
  for (let index = 0; index < context.listings.length; index += 1) {
    const listingContext = await loadPinnedListingContext(context, context.listings[index].ref);
    const shards = relevantShards(context, listingContext.ref);
    const input = assembleListingInput(
      listingContext.base_input,
      listingContext.ref,
      shards,
      context.observation_by_path,
    );
    const sources = buildSources(context, listingContext, shards);
    const report = await compileAgainstSources(input, sources);
    assertPassHasVerifiedObservations(
      report,
      listingContext.ref.listing_key,
      shards.some((shard) => (
        context.observation_by_path.get(shard.observation_batch_path)?.schema_version
          === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA
      )),
    );
    compiled.push({
      index,
      listing_key: listingContext.ref.listing_key,
      filename: reportFilename(index, listingContext.ref.listing_key),
      report,
    });
  }
  return compiled;
}

function preflightInput(listingContext) {
  return {
    ...listingContext.base_input,
    images: {
      ...listingContext.base_input.images,
      evidence: listingContext.ref.assets.map((asset) => ({
        slot: asset.slot,
        asset_sha256: asset.buyer_asset.sha256,
        state: "technical_error",
        error: "intentional offline semantic preflight: blind observation not executed",
      })),
      duplicate_summary: null,
    },
  };
}

function preflightSources(context, listingContext) {
  return {
    ...context.common_sources,
    buyer_snapshot_manifest: listingContext.buyer_snapshot_manifest,
    seller_item_payload: listingContext.seller_item_payload,
    catalog_search_payload: listingContext.catalog_search_payload,
    buyer_pdp_payload: listingContext.buyer_pdp_payload,
    surface_snapshot: listingContext.surface_snapshot,
    asset_bytes: listingContext.asset_bytes,
    run_lock_sha256: context.run_lock_sha256,
    code_bundle_id: context.code_bundle_manifest.bundle_id,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256,
    worker_receipt_key_id: context.run_lock.observer_contract.worker_receipt_key_id,
    worker_receipt_public_key_sha256:
      context.run_lock.observer_contract.worker_receipt_public_key_sha256,
    observation_batches: [],
  };
}

function exactKeySet(label, actual, expected) {
  if (!exactJsonEqual(actual, expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((key) => !actualSet.has(key)).slice(0, 20);
    const unexpected = actual.filter((key) => !expectedSet.has(key)).slice(0, 20);
    throw new Error(`${label} differs from authoritative scope; missing=${missing.join("|") || "none"}; unexpected=${unexpected.join("|") || "none"}`);
  }
}

/**
 * Prove that "complete" means the entire captured PUBLISHED population was
 * dispositioned, not merely every row that happened to be placed in a lock.
 */
export function reconcileAuthoritativePopulation(context) {
  const scope = verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture(
    context.common_sources.authoritative_published_scope,
    context.common_sources.authoritative_item_report_source,
    context.common_sources.authoritative_item_report_capture,
    context.common_sources.authoritative_item_report_trusted_context,
  );
  const catalog = verifyWalmartCatalogTruthAuditExportAgainstSources(
    context.common_sources.catalog_truth_export,
    context.common_sources.product_truth_snapshot,
    context.common_sources.buyer_snapshot_index,
  );
  const lockAt = Date.parse(context.run_lock.created_at);
  const scopeAt = Date.parse(scope.captured_at);
  const productTruthAt = Date.parse(context.common_sources.product_truth_snapshot.captured_at);
  const buyerAt = Date.parse(catalog.buyer_index.captured_at);
  const pinnedFreshness = context.run_lock.hard_source_freshness;
  if (scopeAt > lockAt || productTruthAt > lockAt || buyerAt > lockAt
    || lockAt - scopeAt > MAX_SOURCE_TO_DEADLINE_MS
    || lockAt - productTruthAt > MAX_SOURCE_TO_DEADLINE_MS
    || lockAt - buyerAt > MAX_SOURCE_TO_DEADLINE_MS
    || pinnedFreshness.authoritative_scope_captured_at !== scope.captured_at
    || pinnedFreshness.product_truth_snapshot_captured_at
      !== context.common_sources.product_truth_snapshot.captured_at
    || pinnedFreshness.buyer_index_captured_at !== catalog.buyer_index.captured_at) {
    throw new Error("authoritative scope/Product Truth/buyer index freshness differs from the immutable 24h contract");
  }
  const caseByKey = new Map(catalog.cases.map((row) => [row.listing_key, row]));
  const missingTruth = scope.rows
    .map((row) => row.listing_key)
    .filter((key) => !caseByKey.has(key));
  if (missingTruth.length) {
    throw new Error(`authoritative PUBLISHED population has ${missingTruth.length} listings without a Product Truth disposition: ${missingTruth.slice(0, 20).join("|")}`);
  }
  const populationKeys = scope.rows.map((row) => row.listing_key);
  const auditableCases = populationKeys
    .map((key) => caseByKey.get(key))
    .filter((row) => row.disposition === "auditable");
  const auditableKeys = auditableCases.map((row) => row.listing_key).sort();
  const lockedKeys = context.run_lock.listings.map((row) => row.listing_key).sort();
  exactKeySet("run-lock auditable listing set", lockedKeys, auditableKeys);
  const lockedByKey = new Map(context.run_lock.listings.map((row) => [row.listing_key, row]));
  for (const auditCase of auditableCases) {
    const locked = lockedByKey.get(auditCase.listing_key);
    if (!locked || locked.item_id !== auditCase.item_id
      || auditCase.published_status !== "PUBLISHED"
      || auditCase.lifecycle_status !== "ACTIVE") {
      throw new Error(`${auditCase.listing_key}: auditable lock identity/status differs from authoritative Product Truth case`);
    }
  }
  const truthReview = populationKeys.filter((key) => caseByKey.get(key).disposition === "truth_review").length;
  const unsupported = populationKeys.filter((key) => caseByKey.get(key).disposition === "unsupported").length;
  if (auditableKeys.length + truthReview + unsupported !== populationKeys.length) {
    throw new Error("authoritative population dispositions do not reconcile exactly once");
  }
  return {
    scope_snapshot_id: scope.snapshot_id,
    scope_body_sha256: scope.body_sha256,
    scope_captured_at: scope.captured_at,
    authoritative_published_count: populationKeys.length,
    auditable_count: auditableKeys.length,
    truth_review_count: truthReview,
    unsupported_count: unsupported,
    exact_population_reconciliation: true,
  };
}

/**
 * Exercise every source-aware check that does not require a model result. This
 * must finish before any Claude call so an invalid truth/buyer/surface bundle
 * cannot consume subscription capacity and fail only during final audit.
 */
export async function preflightPinnedContext(
  context,
  compileAgainstSources,
  populationReconciler,
) {
  const compile = compileAgainstSources ?? compileWalmartListingIntegrityReportAgainstSources;
  const population = (populationReconciler ?? reconcileAuthoritativePopulation)(context);
  const verdicts = { PASS: 0, BAD: 0, REVIEW: 0, UNSUPPORTED: 0 };
  const lockedBuyerSnapshotCapturedAts = [];
  const lockAt = Date.parse(context.run_lock.created_at);
  for (const row of context.listings) {
    const listingContext = await loadPinnedListingContext(context, row.ref);
    const buyerCapturedAt = canonicalTimestamp(
      listingContext.buyer_snapshot_manifest?.captured_at,
      `${row.ref.listing_key} buyer_snapshot_manifest.captured_at`,
    );
    if (Date.parse(buyerCapturedAt) > lockAt
      || lockAt - Date.parse(buyerCapturedAt) > MAX_SOURCE_TO_DEADLINE_MS) {
      throw new Error(`${row.ref.listing_key}: buyer snapshot is future-dated or older than 24h at freeze`);
    }
    lockedBuyerSnapshotCapturedAts.push(buyerCapturedAt);
    const report = await compile(
      preflightInput(listingContext),
      preflightSources(context, listingContext),
    );
    if (report?.overall_verdict === "PASS"
      || report?.assurance?.source_artifacts_verified !== true
      || report?.assurance?.surface_snapshot_verified !== true
      || report?.assurance?.asset_bytes_verified !== true
      || report?.assurance?.observation_artifacts_verified !== false) {
      throw new Error(`${row.ref.listing_key}: semantic preflight assurance is invalid`);
    }
    if (Object.prototype.hasOwnProperty.call(verdicts, report.overall_verdict)) {
      verdicts[report.overall_verdict] += 1;
    }
  }
  const rebuiltFreshness = buildWalmartListingIntegritySourceFreshness({
    authoritative_scope_captured_at:
      context.common_sources.authoritative_published_scope.captured_at,
    product_truth_snapshot_captured_at:
      context.common_sources.product_truth_snapshot.captured_at,
    buyer_index_captured_at: context.common_sources.buyer_snapshot_index.captured_at,
    locked_buyer_snapshot_captured_ats: lockedBuyerSnapshotCapturedAts,
  });
  if (!exactJsonEqual(rebuiltFreshness, context.run_lock.hard_source_freshness)) {
    throw new Error("run-lock source freshness does not rebuild from every exact frozen source byte");
  }
  return {
    listings_verified: context.listings.length,
    provisional_verdict_counts: verdicts,
    population,
  };
}

async function writeImmutableJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await open(file, "wx", 0o444);
  let completed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
  }
  if (!completed) throw new Error(`immutable report write did not complete: ${file}`);
}

function verdictCounts(rows) {
  const counts = { PASS: 0, BAD: 0, REVIEW: 0, UNSUPPORTED: 0 };
  for (const row of rows) {
    const verdict = row.report?.overall_verdict;
    if (Object.prototype.hasOwnProperty.call(counts, verdict)) counts[verdict] += 1;
  }
  return counts;
}

function technicalTerminalCount(context) {
  return [...context.observation_by_path.values()].filter((artifact) => (
    artifact.schema_version === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA
  )).length;
}

function emitJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runPlan(options, injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const context = await loadPinnedContext(options, { observationsRequired: false });
  const semantic = await preflightPinnedContext(
    context,
    injected.preflight_against_sources,
    injected.population_reconciler,
  );
  const preflightCertificate = buildWalmartListingIntegrityPreflightCertificate(
    context,
    semantic,
  );
  emitJson(stdout, {
    schema_version: WALMART_LISTING_INTEGRITY_PLAN_SCHEMA,
    mode: "PLAN",
    executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_sha256,
    code_bundle_id: context.code_bundle_manifest.bundle_id,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256,
    listing_count: context.listings.length,
    authoritative_population: semantic.population,
    image_count: context.run_lock.shards.reduce((sum, shard) => sum + shard.images.length, 0),
    shard_count: context.run_lock.shards.length,
    partition_count: context.run_lock.observer_partitions.length,
    deterministic_listing_order: deterministicListingOrder(context),
    deterministic_shard_order: deterministicShardOrder(context),
    observer_partitions: context.run_lock.observer_partitions,
    preflight_certificate: preflightCertificate,
    assurance: {
      ...preflightAssurance(),
      semantic_listings_verified: semantic.listings_verified,
    },
  });
}

export async function runAudit(options, injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const compileAgainstSources = injected.compile_against_sources
    ?? compileWalmartListingIntegrityReportAgainstSources;
  const context = await loadPinnedContext(options, { observationsRequired: true });
  const population = (injected.population_reconciler ?? reconcileAuthoritativePopulation)(context);
  assertPreflightCertificateMatchesContext(context, population);
  // Compile everything before the first write. A source/observation failure
  // therefore cannot leave an apparently complete output directory.
  const compiled = await compileAll(context, compileAgainstSources);
  await assertCreatableDirectoryHasNoSymlinkParents(options.output_dir, "--output-dir");
  await mkdir(options.output_dir, { mode: 0o700 });
  for (const row of compiled) {
    await writeImmutableJson(path.join(options.output_dir, row.filename), row.report);
  }
  emitJson(stdout, {
    schema_version: "walmart-listing-integrity-audit-execution/v1",
    mode: "AUDIT",
    executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_sha256,
    code_bundle_id: context.code_bundle_manifest.bundle_id,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256,
    reports_dir: options.output_dir,
    reports_written: compiled.length,
    technical_terminal_shards: technicalTerminalCount(context),
    authoritative_population: population,
    verdict_counts: verdictCounts(compiled),
    assurance: {
      coverage: "exactly_once",
      output_write_policy: "immutable_wx_reports_only",
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      marketplace_reads: 0,
      marketplace_writes: 0,
    },
  });
}

export async function runVerify(options, injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const verifyAgainstSources = injected.verify_against_sources
    ?? verifyWalmartListingIntegrityReportAgainstSources;
  const context = await loadPinnedContext(options, { observationsRequired: true });
  const population = (injected.population_reconciler ?? reconcileAuthoritativePopulation)(context);
  assertPreflightCertificateMatchesContext(context, population);
  await assertExistingPathHasNoSymlinks(options.reports_dir, "directory", "--reports-dir");
  const entries = await readdir(options.reports_dir, { withFileTypes: true });
  const expected = context.listings.map((listing, index) => ({
    index,
    listing,
    filename: reportFilename(index, listing.ref.listing_key),
  }));
  const expectedNames = new Set(expected.map((row) => row.filename));
  const actualNames = new Set();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`reports directory contains a non-regular entry: ${entry.name}`);
    }
    if (!expectedNames.has(entry.name)) throw new Error(`reports directory contains unexpected file: ${entry.name}`);
    if (actualNames.has(entry.name)) throw new Error(`reports directory repeats file: ${entry.name}`);
    actualNames.add(entry.name);
  }
  if (options.require_complete && actualNames.size !== expectedNames.size) {
    const missing = [...expectedNames].filter((name) => !actualNames.has(name));
    throw new Error(`reports directory is incomplete; missing ${missing.join(",")}`);
  }
  const verified = [];
  for (const row of expected) {
    const file = path.join(options.reports_dir, row.filename);
    await assertExistingPathHasNoSymlinks(file, "file", `report ${row.filename}`);
    const info = await lstat(file);
    if (info.size > MAX_JSON_SOURCE_BYTES) throw new Error(`report ${row.filename} exceeds byte cap`);
    const rawReport = parseJsonBytes(await readFile(file), `report ${row.filename}`);
    const listingContext = await loadPinnedListingContext(context, row.listing.ref);
    const shards = relevantShards(context, listingContext.ref);
    const input = assembleListingInput(
      listingContext.base_input,
      listingContext.ref,
      shards,
      context.observation_by_path,
    );
    const sources = buildSources(context, listingContext, shards);
    const report = await verifyAgainstSources(rawReport, input, sources);
    assertPassHasVerifiedObservations(
      report,
      listingContext.ref.listing_key,
      shards.some((shard) => (
        context.observation_by_path.get(shard.observation_batch_path)?.schema_version
          === WALMART_LISTING_OBSERVATION_TERMINAL_SCHEMA
      )),
    );
    verified.push({ report });
  }
  emitJson(stdout, {
    schema_version: "walmart-listing-integrity-verification/v1",
    mode: "VERIFY",
    executor_version: WALMART_LISTING_INTEGRITY_EXECUTOR_VERSION,
    run_id: context.run_lock.run_id,
    run_lock_sha256: context.run_lock_sha256,
    code_bundle_id: context.code_bundle_manifest.bundle_id,
    code_bundle_manifest_sha256: context.code_bundle_manifest_sha256,
    reports_dir: options.reports_dir,
    reports_verified: verified.length,
    technical_terminal_shards: technicalTerminalCount(context),
    authoritative_population: population,
    verdict_counts: verdictCounts(verified),
    complete: verified.length === context.listings.length,
    assurance: {
      coverage: "exactly_once",
      source_aware_rebuild: true,
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      marketplace_reads: 0,
      marketplace_writes: 0,
    },
  });
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const options = parseCliArgs(argv);
  if (options.help) {
    stdout.write(HELP);
    return;
  }
  if (options.command === "plan") return runPlan(options, injected);
  if (options.command === "audit") return runAudit(options, injected);
  return runVerify(options, injected);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
