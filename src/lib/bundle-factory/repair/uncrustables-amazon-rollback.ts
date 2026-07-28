/**
 * Immutable pre-change capture and guarded rollback for the 164 July 2026
 * Uncrustables Amazon listings.
 *
 * The module is deliberately independent from Prisma/R2 and has no implicit
 * network path. A caller supplies a read-only Amazon gateway for LIVE_SP_API
 * capture and a separate PATCH gateway for an explicitly armed rollback.
 *
 * Safety model:
 *  - the exact 164-SKU scope comes from a complete SHA-sealed ledger;
 *  - the reviewed overrides bytes are sealed and must point at that ledger;
 *  - every listing is captured as full Listings Items JSON (attributes,
 *    summaries, issues, offers, availability and procurement when returned);
 *  - inverse operations restore only paths the sealed forward plan can touch;
 *  - rollback refuses to overwrite a path whose current value is neither the
 *    expected forward value nor the original before value;
 *  - every write is validation-previewed, guarded by a fresh GET, and verified
 *    by post-write GETs;
 *  - dry run performs zero gateway calls; real rollback needs both a CLI token
 *    and an independently supplied environment token.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import type {
  ListingItem,
  ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import {
  applyPurchasableOfferMerge,
  buildActionPatches,
  buildSelectorDeletePatch,
  buildValidationPreviewPatchSet,
  canonicalPurchasableOfferStateValue,
  CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE,
  hasBlockingIssues,
  MEDIA_PATCH_PATHS,
  OFFER_PATCH_PATHS,
  quarantineUnselectedPendingRepairSubmissions,
  recoverPendingRepairSettlements,
  purchasableOfferRestoreMergeValue,
  sha256,
  stableJson,
  TEXT_STRUCTURED_ONLY_PROFILE,
  validationPreviewCheckpointDetail,
  validationPreviewGatewayContext,
  verifyRepairExecutionSelection,
  verifyRepairPlan,
  CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR,
  ImmutableCheckpointStore,
  type RepairValidationPreviewContext,
  type RepairActionKind,
  type RepairExecutionSelection,
  type UncrustablesRepairPlan,
} from "./uncrustables-surgical";

export const UNCRUSTABLES_AMAZON_SCOPE = 164 as const;
export const PRECHANGE_SNAPSHOT_SCHEMA =
  "uncrustables-amazon-prechange-snapshot/v1" as const;
export const ROLLBACK_PLAN_SCHEMA =
  "uncrustables-amazon-rollback-plan/v3" as const;
export const ROLLBACK_CHECKPOINT_SCHEMA =
  "uncrustables-amazon-rollback-checkpoint/v1" as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function seal<T extends UnknownRecord>(body: T): T & { sha256: string } {
  return { ...body, sha256: sha256(stableJson(body)) };
}

function verifySeal(value: UnknownRecord, label: string): void {
  const claimed = nonEmptyString(value.sha256);
  if (!claimed) throw new Error(`${label} has no SHA-256 seal.`);
  const body = { ...value };
  delete body.sha256;
  const actual = sha256(stableJson(body));
  if (claimed !== actual) {
    throw new Error(`${label} SHA-256 mismatch: expected ${claimed}, calculated ${actual}.`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type SnapshotCaptureMode =
  | "SEALED_LEDGER_BOOTSTRAP"
  | "LIVE_SP_API";

export interface SnapshotInputSeal {
  path: string;
  sha256: string;
  schema_version: string;
}

export interface SnapshotFieldState {
  present: boolean;
  value?: unknown;
  sha256: string;
}

export interface SnapshotImageEvidence {
  url: string;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  local_path: string | null;
  error: string | null;
}

export interface PreChangeSnapshotEntry {
  sku: string;
  asin: string;
  store_index: number;
  product_type: string;
  captured_at: string;
  capture_source: SnapshotCaptureMode;
  listing_sha256: string;
  listing: ListingItem;
  fields: Record<string, SnapshotFieldState>;
  image_urls: string[];
}

export interface UncrustablesPreChangeSnapshot {
  schema_version: typeof PRECHANGE_SNAPSHOT_SCHEMA;
  immutable: true;
  snapshot_id: string;
  created_at: string;
  completed_at: string;
  capture_mode: SnapshotCaptureMode;
  apply_eligible: boolean;
  external_mutations: false;
  source_ledger: SnapshotInputSeal & {
    audit_id: string;
    completed_at: string;
    marketplace_observed_at: string | null;
  };
  reviewed_overrides: SnapshotInputSeal & {
    reviewed_at: string;
    source_ledger_sha256: string;
  };
  policy: {
    expected_unique_skus: typeof UNCRUSTABLES_AMAZON_SCOPE;
    expected_unique_asins: typeof UNCRUSTABLES_AMAZON_SCOPE;
    marketplace_id: string;
    full_listing_json_captured: true;
    offers_requested: true;
    images_enumerated: true;
    image_binary_capture_required_for_media_rollback: true;
    amazon_writes: false;
    database_writes: false;
    r2_writes: false;
  };
  scope: {
    expected: typeof UNCRUSTABLES_AMAZON_SCOPE;
    captured: number;
    unique_skus: number;
    unique_asins: number;
    stores: number[];
  };
  image_capture: {
    unique_urls: number;
    captured: number;
    failed: number;
    complete: boolean;
    evidence: SnapshotImageEvidence[];
  };
  entries: PreChangeSnapshotEntry[];
  sha256: string;
}

interface LedgerRowLike {
  sku?: unknown;
  asin?: unknown;
  store_index?: unknown;
  live?: unknown;
}

interface LedgerLike {
  schema_version?: unknown;
  audit_id?: unknown;
  complete?: unknown;
  immutable?: unknown;
  external_mutations?: unknown;
  completed_at?: unknown;
  marketplace_observed_at?: unknown;
  rows?: unknown;
}

interface OverridesLike {
  schema_version?: unknown;
  immutable?: unknown;
  source_ledger_sha256?: unknown;
  reviewed_at?: unknown;
  repairs?: unknown;
}

interface ExactScopeRow {
  sku: string;
  asin: string;
  store_index: number;
  product_type: string;
  ledger_live: UnknownRecord;
}

interface PreparedScope {
  ledger: LedgerLike;
  overrides: OverridesLike;
  rows: ExactScopeRow[];
  ledgerSha256: string;
  overridesSha256: string;
}

function parseJsonBytes<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function finiteStoreIndex(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function prepareExactScope(input: {
  ledgerBytes: Buffer;
  overridesBytes: Buffer;
}): PreparedScope {
  const ledger = parseJsonBytes<LedgerLike>(input.ledgerBytes, "Source ledger");
  const overrides = parseJsonBytes<OverridesLike>(
    input.overridesBytes,
    "Reviewed overrides",
  );
  const ledgerSha256 = sha256(input.ledgerBytes);
  const overridesSha256 = sha256(input.overridesBytes);
  if (
    ledger.complete !== true ||
    ledger.immutable !== true ||
    ledger.external_mutations !== false ||
    !nonEmptyString(ledger.schema_version) ||
    !nonEmptyString(ledger.audit_id) ||
    !nonEmptyString(ledger.completed_at) ||
    !Array.isArray(ledger.rows)
  ) {
    throw new Error("Source ledger is not a complete immutable non-mutating ledger.");
  }
  if (
    overrides.immutable !== true ||
    !nonEmptyString(overrides.schema_version) ||
    !nonEmptyString(overrides.reviewed_at) ||
    !Array.isArray(overrides.repairs) ||
    overrides.source_ledger_sha256 !== ledgerSha256
  ) {
    throw new Error(
      "Reviewed overrides are not immutable or do not bind the exact source ledger SHA-256.",
    );
  }

  const rows: ExactScopeRow[] = [];
  for (const raw of ledger.rows as LedgerRowLike[]) {
    if (!isRecord(raw) || !isRecord(raw.live) || raw.live.fetched !== true) continue;
    const sku = nonEmptyString(raw.sku);
    const asin = nonEmptyString(raw.asin) ?? nonEmptyString(raw.live.asin);
    const storeIndex = finiteStoreIndex(raw.store_index);
    const productType = nonEmptyString(raw.live.product_type);
    if (!sku || !asin || !storeIndex || !productType) {
      throw new Error("A fetched ledger row is missing SKU, ASIN, store, or product type.");
    }
    rows.push({
      sku,
      asin,
      store_index: storeIndex,
      product_type: productType,
      ledger_live: raw.live,
    });
  }
  rows.sort((left, right) => left.sku.localeCompare(right.sku));
  const skus = new Set(rows.map((row) => row.sku));
  const asins = new Set(rows.map((row) => row.asin));
  if (
    rows.length !== UNCRUSTABLES_AMAZON_SCOPE ||
    skus.size !== UNCRUSTABLES_AMAZON_SCOPE ||
    asins.size !== UNCRUSTABLES_AMAZON_SCOPE
  ) {
    throw new Error(
      `Exact Uncrustables scope must be ${UNCRUSTABLES_AMAZON_SCOPE} unique SKUs/ASINs; got rows=${rows.length}, skus=${skus.size}, asins=${asins.size}.`,
    );
  }
  const knownSkus = skus;
  for (const repair of overrides.repairs as unknown[]) {
    if (!isRecord(repair) || !nonEmptyString(repair.sku)) {
      throw new Error("Reviewed overrides contain a malformed repair entry.");
    }
    if (!knownSkus.has(String(repair.sku))) {
      throw new Error(`Reviewed override SKU ${String(repair.sku)} is outside the exact ledger scope.`);
    }
  }
  return { ledger, overrides, rows, ledgerSha256, overridesSha256 };
}

function fieldState(present: boolean, value?: unknown): SnapshotFieldState {
  const body = present ? { present: true, value: clone(value) } : { present: false };
  return { ...body, sha256: sha256(stableJson(body)) };
}

function listingFields(listing: ListingItem): Record<string, SnapshotFieldState> {
  const attrs = isRecord(listing.attributes) ? listing.attributes : {};
  const fields: Record<string, SnapshotFieldState> = {};
  for (const key of Object.keys(attrs).sort()) {
    fields[`/attributes/${key}`] = fieldState(true, attrs[key]);
  }
  return fields;
}

function mediaUrlsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => nonEmptyString(entry.media_location))
    .filter((item): item is string => item != null);
}

function listingImageUrls(listing: ListingItem): string[] {
  const attrs = isRecord(listing.attributes) ? listing.attributes : {};
  const urls: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (
      key === "main_product_image_locator" ||
      /^other_product_image_locator_[1-8]$/.test(key)
    ) {
      urls.push(...mediaUrlsFromValue(value));
    }
  }
  return [...new Set(urls)].sort();
}

function summaryFor(listing: ListingItem) {
  return (
    listing.summaries?.find((summary) => summary.marketplaceId === MARKETPLACE_ID) ??
    listing.summaries?.[0]
  );
}

function makeEntry(input: {
  row: ExactScopeRow;
  listing: ListingItem;
  capturedAt: string;
  captureMode: SnapshotCaptureMode;
}): PreChangeSnapshotEntry {
  if (
    input.captureMode === "LIVE_SP_API" &&
    (!isRecord(input.listing.attributes) || input.listing.offers === undefined)
  ) {
    throw new Error(
      `Live capture for ${input.row.sku} is missing requested attributes/offers data.`,
    );
  }
  const summary = summaryFor(input.listing);
  if (summary?.asin !== input.row.asin) {
    throw new Error(
      `ASIN identity mismatch for ${input.row.sku}: expected ${input.row.asin}, got ${summary?.asin ?? "missing"}.`,
    );
  }
  const productType = nonEmptyString(summary.productType);
  if (!productType) throw new Error(`Live product type missing for ${input.row.sku}.`);
  const listing = clone({ ...input.listing, sku: input.row.sku });
  return {
    sku: input.row.sku,
    asin: input.row.asin,
    store_index: input.row.store_index,
    product_type: productType,
    captured_at: input.capturedAt,
    capture_source: input.captureMode,
    listing_sha256: sha256(stableJson(listing)),
    fields: listingFields(listing),
    image_urls: listingImageUrls(listing),
    listing,
  };
}

function listingFromLedger(row: ExactScopeRow): ListingItem {
  const live = row.ledger_live;
  const statuses = Array.isArray(live.amazon_statuses)
    ? live.amazon_statuses.filter((item): item is string => typeof item === "string")
    : [];
  return {
    sku: row.sku,
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID,
        asin: row.asin,
        productType: row.product_type,
        status: statuses,
        itemName: nonEmptyString(live.title) ?? undefined,
        mainImage: nonEmptyString(live.main_image_url)
          ? { link: String(live.main_image_url) }
          : undefined,
      },
    ],
    attributes: isRecord(live.raw_attributes)
      ? clone(live.raw_attributes)
      : {},
    issues: Array.isArray(live.issues) ? clone(live.issues) : [],
    offers: clone(live.raw_offers ?? []),
    fulfillmentAvailability: clone(live.fulfillment_availability ?? []),
    procurement: clone(live.procurement ?? null),
  };
}

export interface SnapshotImageLoader {
  load(url: string): Promise<SnapshotImageEvidence>;
}

export interface BuildSnapshotInput {
  ledgerPath: string;
  ledgerBytes: Buffer;
  overridesPath: string;
  overridesBytes: Buffer;
  createdAt?: Date;
  completedAt?: Date;
  imageEvidence?: SnapshotImageEvidence[];
}

function buildSnapshotBody(input: {
  prepared: PreparedScope;
  ledgerPath: string;
  overridesPath: string;
  captureMode: SnapshotCaptureMode;
  entries: PreChangeSnapshotEntry[];
  createdAt: Date;
  completedAt: Date;
  imageEvidence: SnapshotImageEvidence[];
}): Omit<UncrustablesPreChangeSnapshot, "sha256"> {
  const { prepared } = input;
  const allImageUrls = [...new Set(input.entries.flatMap((entry) => entry.image_urls))].sort();
  const evidenceMap = new Map(input.imageEvidence.map((item) => [item.url, item]));
  const evidence = allImageUrls.map(
    (url) =>
      evidenceMap.get(url) ?? {
        url,
        sha256: null,
        bytes: null,
        content_type: null,
        local_path: null,
        error: "IMAGE_BINARY_NOT_CAPTURED",
      },
  );
  const captured = evidence.filter((item) => item.sha256 != null && item.error == null).length;
  const failed = evidence.length - captured;
  return {
    schema_version: PRECHANGE_SNAPSHOT_SCHEMA,
    immutable: true,
    snapshot_id: `UAPS-${input.completedAt.toISOString().replace(/[-:.]/g, "")}-${prepared.ledgerSha256.slice(0, 12)}`,
    created_at: input.createdAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
    capture_mode: input.captureMode,
    apply_eligible: input.captureMode === "LIVE_SP_API",
    external_mutations: false,
    source_ledger: {
      path: input.ledgerPath,
      sha256: prepared.ledgerSha256,
      schema_version: String(prepared.ledger.schema_version),
      audit_id: String(prepared.ledger.audit_id),
      completed_at: String(prepared.ledger.completed_at),
      marketplace_observed_at: nonEmptyString(prepared.ledger.marketplace_observed_at),
    },
    reviewed_overrides: {
      path: input.overridesPath,
      sha256: prepared.overridesSha256,
      schema_version: String(prepared.overrides.schema_version),
      reviewed_at: String(prepared.overrides.reviewed_at),
      source_ledger_sha256: String(prepared.overrides.source_ledger_sha256),
    },
    policy: {
      expected_unique_skus: UNCRUSTABLES_AMAZON_SCOPE,
      expected_unique_asins: UNCRUSTABLES_AMAZON_SCOPE,
      marketplace_id: MARKETPLACE_ID,
      full_listing_json_captured: true,
      offers_requested: true,
      images_enumerated: true,
      image_binary_capture_required_for_media_rollback: true,
      amazon_writes: false,
      database_writes: false,
      r2_writes: false,
    },
    scope: {
      expected: UNCRUSTABLES_AMAZON_SCOPE,
      captured: input.entries.length,
      unique_skus: new Set(input.entries.map((entry) => entry.sku)).size,
      unique_asins: new Set(input.entries.map((entry) => entry.asin)).size,
      stores: [...new Set(input.entries.map((entry) => entry.store_index))].sort(
        (left, right) => left - right,
      ),
    },
    image_capture: {
      unique_urls: allImageUrls.length,
      captured,
      failed,
      complete: failed === 0,
      evidence,
    },
    entries: input.entries,
  };
}

/** Build a local, non-apply-eligible bootstrap from the last sealed live ledger. */
export function buildLedgerBootstrapSnapshot(
  input: BuildSnapshotInput,
): UncrustablesPreChangeSnapshot {
  const prepared = prepareExactScope(input);
  const createdAt = input.createdAt ?? new Date();
  const completedAt = input.completedAt ?? createdAt;
  const capturedAt =
    nonEmptyString(prepared.ledger.marketplace_observed_at) ??
    String(prepared.ledger.completed_at);
  const entries = prepared.rows.map((row) =>
    makeEntry({
      row,
      listing: listingFromLedger(row),
      capturedAt,
      captureMode: "SEALED_LEDGER_BOOTSTRAP",
    }),
  );
  const snapshot = seal(
    buildSnapshotBody({
      prepared,
      ledgerPath: input.ledgerPath,
      overridesPath: input.overridesPath,
      captureMode: "SEALED_LEDGER_BOOTSTRAP",
      entries,
      createdAt,
      completedAt,
      imageEvidence: input.imageEvidence ?? [],
    }) as unknown as UnknownRecord,
  ) as unknown as UncrustablesPreChangeSnapshot;
  verifyPreChangeSnapshot(snapshot);
  return snapshot;
}

export interface SnapshotReadGateway {
  getListing(storeIndex: number, sku: string): Promise<ListingItem>;
}

/** Capture all 164 listings through read-only Listings Items GET calls. */
export async function captureLivePreChangeSnapshot(input: BuildSnapshotInput & {
  gateway: SnapshotReadGateway;
  imageLoader?: SnapshotImageLoader;
  /** Optional evidence scope. Every listing/image URL remains in the immutable
   * snapshot, but only returned URLs are handed to the binary loader. */
  imageUrlSelector?: (
    entries: readonly PreChangeSnapshotEntry[],
  ) => Iterable<string>;
  requestDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<UncrustablesPreChangeSnapshot> {
  const prepared = prepareExactScope(input);
  const requestDelayMs = input.requestDelayMs ?? 250;
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 200) {
    throw new Error("Snapshot requestDelayMs must be an integer >= 200.");
  }
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const createdAt = input.createdAt ?? new Date();
  const entries: PreChangeSnapshotEntry[] = [];
  for (let index = 0; index < prepared.rows.length; index++) {
    const row = prepared.rows[index];
    const listing = await input.gateway.getListing(row.store_index, row.sku);
    const capturedAt = new Date().toISOString();
    entries.push(
      makeEntry({
        row,
        listing,
        capturedAt,
        captureMode: "LIVE_SP_API",
      }),
    );
    if (index < prepared.rows.length - 1) await sleep(requestDelayMs);
  }

  const allUrls = [...new Set(entries.flatMap((entry) => entry.image_urls))].sort();
  const imageEvidence: SnapshotImageEvidence[] = [];
  if (input.imageLoader) {
    const selectedUrls = input.imageUrlSelector
      ? new Set(input.imageUrlSelector(entries))
      : new Set(allUrls);
    const unknownSelected = [...selectedUrls].filter(
      (url) => !allUrls.includes(url),
    );
    if (unknownSelected.length > 0) {
      throw new Error(
        `Image evidence selector returned ${unknownSelected.length} URL(s) absent from the live snapshot.`,
      );
    }
    for (const url of allUrls.filter((item) => selectedUrls.has(item))) {
      try {
        const loaded = await input.imageLoader.load(url);
        if (loaded.url !== url || !loaded.sha256 || loaded.error) {
          throw new Error("Image loader returned incomplete or mismatched evidence.");
        }
        imageEvidence.push(loaded);
      } catch (error) {
        imageEvidence.push({
          url,
          sha256: null,
          bytes: null,
          content_type: null,
          local_path: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const completedAt = input.completedAt ?? new Date();
  const snapshot = seal(
    buildSnapshotBody({
      prepared,
      ledgerPath: input.ledgerPath,
      overridesPath: input.overridesPath,
      captureMode: "LIVE_SP_API",
      entries,
      createdAt,
      completedAt,
      imageEvidence,
    }) as unknown as UnknownRecord,
  ) as unknown as UncrustablesPreChangeSnapshot;
  verifyPreChangeSnapshot(snapshot);
  return snapshot;
}

export function verifyPreChangeSnapshot(
  snapshot: UncrustablesPreChangeSnapshot,
): void {
  if (
    snapshot.schema_version !== PRECHANGE_SNAPSHOT_SCHEMA ||
    snapshot.immutable !== true ||
    snapshot.external_mutations !== false ||
    snapshot.scope.expected !== UNCRUSTABLES_AMAZON_SCOPE ||
    snapshot.scope.captured !== UNCRUSTABLES_AMAZON_SCOPE ||
    snapshot.scope.unique_skus !== UNCRUSTABLES_AMAZON_SCOPE ||
    snapshot.scope.unique_asins !== UNCRUSTABLES_AMAZON_SCOPE ||
    snapshot.entries.length !== UNCRUSTABLES_AMAZON_SCOPE
  ) {
    throw new Error("Pre-change snapshot does not contain the exact immutable 164-listing scope.");
  }
  verifySeal(snapshot as unknown as UnknownRecord, "Pre-change snapshot");
  if (
    snapshot.reviewed_overrides.source_ledger_sha256 !==
    snapshot.source_ledger.sha256
  ) {
    throw new Error("Snapshot overrides are not bound to its source ledger.");
  }
  if (
    snapshot.apply_eligible !== (snapshot.capture_mode === "LIVE_SP_API") ||
    !Number.isFinite(new Date(snapshot.created_at).getTime()) ||
    !Number.isFinite(new Date(snapshot.completed_at).getTime()) ||
    new Date(snapshot.completed_at).getTime() <
      new Date(snapshot.created_at).getTime()
  ) {
    throw new Error("Snapshot capture mode, eligibility, or timestamps are invalid.");
  }
  const skus = new Set<string>();
  const asins = new Set<string>();
  let previousSku = "";
  for (const entry of snapshot.entries) {
    if (
      !entry.sku ||
      !entry.asin ||
      entry.sku.localeCompare(previousSku) < 0 ||
      skus.has(entry.sku) ||
      asins.has(entry.asin) ||
      entry.listing_sha256 !== sha256(stableJson(entry.listing)) ||
      summaryFor(entry.listing)?.asin !== entry.asin ||
      summaryFor(entry.listing)?.productType !== entry.product_type
    ) {
      throw new Error(`Invalid snapshot listing entry ${entry.sku || "<missing>"}.`);
    }
    const actualFields = listingFields(entry.listing);
    if (stableJson(actualFields) !== stableJson(entry.fields)) {
      throw new Error(`Snapshot field map mismatch for ${entry.sku}.`);
    }
    const actualImages = listingImageUrls(entry.listing);
    if (stableJson(actualImages) !== stableJson(entry.image_urls)) {
      throw new Error(`Snapshot image URL map mismatch for ${entry.sku}.`);
    }
    skus.add(entry.sku);
    asins.add(entry.asin);
    previousSku = entry.sku;
  }
  if (
    snapshot.capture_mode === "LIVE_SP_API" &&
    snapshot.entries.some((entry) => entry.capture_source !== "LIVE_SP_API")
  ) {
    throw new Error("LIVE_SP_API snapshot contains a non-live entry.");
  }
  const imageUrls = [
    ...new Set(snapshot.entries.flatMap((entry) => entry.image_urls)),
  ].sort();
  const evidenceUrls = snapshot.image_capture.evidence
    .map((item) => item.url)
    .sort();
  const uniqueEvidenceUrls = new Set(evidenceUrls);
  let captured = 0;
  for (const evidence of snapshot.image_capture.evidence) {
    const isCaptured = evidence.sha256 != null && evidence.error == null;
    if (isCaptured) {
      if (
        !/^[a-f0-9]{64}$/i.test(evidence.sha256 ?? "") ||
        !Number.isInteger(evidence.bytes) ||
        (evidence.bytes ?? 0) <= 0 ||
        !nonEmptyString(evidence.content_type)?.startsWith("image/") ||
        !nonEmptyString(evidence.local_path) ||
        !path.isAbsolute(String(evidence.local_path))
      ) {
        throw new Error(`Invalid captured image evidence for ${evidence.url}.`);
      }
      captured++;
    } else if (
      evidence.sha256 != null ||
      evidence.bytes != null ||
      evidence.content_type != null ||
      evidence.local_path != null ||
      !nonEmptyString(evidence.error)
    ) {
      throw new Error(`Invalid failed image evidence for ${evidence.url}.`);
    }
  }
  const failed = evidenceUrls.length - captured;
  if (
    stableJson(evidenceUrls) !== stableJson(imageUrls) ||
    uniqueEvidenceUrls.size !== evidenceUrls.length ||
    snapshot.image_capture.unique_urls !== imageUrls.length ||
    snapshot.image_capture.captured !== captured ||
    snapshot.image_capture.failed !== failed ||
    snapshot.image_capture.complete !== (failed === 0)
  ) {
    throw new Error("Snapshot image evidence summary or URL coverage is inconsistent.");
  }
}

export async function writeImmutablePreChangeSnapshot(
  outputDir: string,
  snapshot: UncrustablesPreChangeSnapshot,
): Promise<string> {
  verifyPreChangeSnapshot(snapshot);
  await mkdir(outputDir, { recursive: true });
  const file = path.join(
    outputDir,
    `${snapshot.snapshot_id}-${snapshot.sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readPreChangeSnapshot(
  file: string,
): Promise<UncrustablesPreChangeSnapshot> {
  const snapshot = JSON.parse(
    await readFile(file, "utf8"),
  ) as UncrustablesPreChangeSnapshot;
  verifyPreChangeSnapshot(snapshot);
  return snapshot;
}

export interface RollbackOperation {
  operation_id: string;
  path: string;
  forward_patch_op: ListingPatch["op"];
  before: SnapshotFieldState;
  expected_after: SnapshotFieldState;
  alternate_expected_after: SnapshotFieldState[];
  inverse_patch: ListingPatch;
  media_urls_requiring_binary_evidence: string[];
}

export interface RollbackPlanEntry {
  rollback_entry_id: string;
  sku: string;
  asin: string;
  store_index: number;
  before_product_type: string;
  forward_action_ids: string[];
  forward_action_kinds: RepairActionKind[];
  operations: RollbackOperation[];
}

export interface UncrustablesRollbackPlan {
  schema_version: typeof ROLLBACK_PLAN_SCHEMA;
  immutable: true;
  rollback_plan_id: string;
  created_at: string;
  apply_eligible: boolean;
  source_snapshot: {
    path: string;
    sha256: string;
    snapshot_id: string;
    capture_mode: SnapshotCaptureMode;
    completed_at: string;
    exact_scope: typeof UNCRUSTABLES_AMAZON_SCOPE;
  };
  source_repair_plan: {
    path: string;
    sha256: string;
    plan_id: string;
    source_ledger_sha256: string;
  };
  /** Null only for a legacy whole-plan rollback. A scoped forward execution
   * must be covered by the exact sealed selection artifact, never by a
   * superset rollback whose operator-facing token says something different. */
  source_execution_selection: {
    path: string;
    sha256: string;
    profile: RepairExecutionSelection["profile"];
    selected_actions: number;
    selected_action_ids_sha256: string;
  } | null;
  policy: {
    marketplace_id: string;
    patch_only: true;
    path_level_compare_and_swap: true;
    validation_preview_required: true;
    fresh_get_guard_required: true;
    post_write_readback_required: true;
    cli_confirmation_required: true;
    environment_confirmation_required: true;
    default_scope: "CANARY";
    maximum_errors_default: 1;
  };
  canary: {
    method: "ACTION_KIND_COVERAGE_THEN_SHA256";
    size: number;
    skus: string[];
    covered_action_kinds: RepairActionKind[];
  };
  scope: {
    snapshot_entries: typeof UNCRUSTABLES_AMAZON_SCOPE;
    repair_entries: number;
    repair_actions: number;
    rollback_entries: number;
    inverse_operations: number;
    missing_media_binary_evidence: number;
  };
  entries: RollbackPlanEntry[];
  sha256: string;
}

function attributeName(patchPath: string): string {
  const match = /^\/attributes\/([A-Za-z0-9_]+)$/.exec(patchPath);
  if (!match) throw new Error(`Unsupported rollback patch path: ${patchPath}.`);
  return match[1];
}

function stateAtPath(listing: ListingItem, patchPath: string): SnapshotFieldState {
  const attribute = attributeName(patchPath);
  const attrs = isRecord(listing.attributes) ? listing.attributes : {};
  if (attribute === "purchasable_offer") {
    const value = canonicalPurchasableOfferStateValue(listing);
    return value.length > 0 ? fieldState(true, value) : fieldState(false);
  }
  return Object.prototype.hasOwnProperty.call(attrs, attribute)
    ? fieldState(true, attrs[attribute])
    : fieldState(false);
}

function stateAfterPatch(
  patch: ListingPatch,
  before?: SnapshotFieldState,
): SnapshotFieldState {
  if (patch.op === "delete") return fieldState(false);
  if (patch.op === "merge") {
    if (patch.path !== "/attributes/purchasable_offer") {
      throw new Error(
        `Rollback planning accepts merge only for selector-aware purchasable_offer (${patch.path}).`,
      );
    }
    if (!before) {
      throw new Error(
        `Rollback merge expected-state calculation requires a sealed before state (${patch.path}).`,
      );
    }
    return fieldState(
      true,
      applyPurchasableOfferMerge(
        before.present ? before.value : [],
        patch.value,
      ),
    );
  }
  return fieldState(true, patch.value);
}

function hasRestorableB2bPrice(state: SnapshotFieldState): boolean {
  if (!state.present || !Array.isArray(state.value)) return false;
  return state.value.some((entry) => {
    if (
      !isRecord(entry) ||
      entry.marketplace_id !== MARKETPLACE_ID ||
      entry.currency !== "USD" ||
      entry.audience !== "B2B" ||
      !Array.isArray(entry.our_price)
    ) {
      return false;
    }
    return entry.our_price.some(
      (block) =>
        isRecord(block) &&
        Array.isArray(block.schedule) &&
        block.schedule.some(
          (schedule) =>
            isRecord(schedule) &&
            Number.isFinite(Number(schedule.value_with_tax)) &&
            Number(schedule.value_with_tax) > 0,
        ),
    );
  });
}

function fallbackPatchesForAction(
  action: UncrustablesRepairPlan["entries"][number]["actions"][number],
  listing: ListingItem,
): ListingPatch[] {
  if (
    action.desired.kind !== "TEXT_COUNT" ||
    !action.desired.value.fallback
  ) {
    return [];
  }
  const fallback = action.desired.value.fallback;
  return buildActionPatches(
    {
      ...action,
      desired: {
        kind: "TEXT_COUNT",
        value: {
          unit_count: fallback.unit_count,
          unit_count_type: fallback.unit_count_type,
          number_of_items: fallback.number_of_items,
          request_product_type: fallback.request_product_type,
          expected_product_type: fallback.expected_product_type,
          must_clear_issue_codes: fallback.must_clear_issue_codes,
        },
      },
    },
    listing,
  );
}

function inversePatchFor(
  patchPath: string,
  before: SnapshotFieldState,
  expectedAfter?: SnapshotFieldState,
  forwardPatchOp: ListingPatch["op"] = "replace",
): ListingPatch {
  if (forwardPatchOp === "merge") {
    if (
      patchPath !== "/attributes/purchasable_offer" ||
      !expectedAfter?.present
    ) {
      throw new Error(
        `Selector merge rollback is unsupported for ${patchPath}.`,
      );
    }
    return {
      op: "merge",
      path: patchPath,
      value: purchasableOfferRestoreMergeValue(
        before.present ? before.value : [],
        expectedAfter.value,
      ),
    };
  }
  if (before.present) {
    return { op: "replace", path: patchPath, value: clone(before.value) };
  }
  if (!expectedAfter?.present) {
    throw new Error(
      `Cannot build selector-valued inverse DELETE for absent state ${patchPath}.`,
    );
  }
  return buildSelectorDeletePatch(patchPath, expectedAfter.value);
}

function mediaUrlsFromState(patchPath: string, state: SnapshotFieldState): string[] {
  const attribute = attributeName(patchPath);
  if (
    !state.present ||
    (attribute !== "main_product_image_locator" &&
      !/^other_product_image_locator_[1-8]$/.test(attribute))
  ) {
    return [];
  }
  return mediaUrlsFromValue(state.value);
}

function selectCanary(
  entries: RollbackPlanEntry[],
  snapshotSha256: string,
  requestedSize: number,
): RollbackPlanEntry[] {
  if (!Number.isInteger(requestedSize) || requestedSize <= 0) {
    throw new Error("Canary size must be a positive integer.");
  }
  const size = Math.min(requestedSize, entries.length);
  const score = (entry: RollbackPlanEntry) =>
    createHash("sha256")
      .update(`${snapshotSha256}:${entry.sku}`)
      .digest("hex");
  const ranked = [...entries].sort((left, right) =>
    score(left).localeCompare(score(right)) || left.sku.localeCompare(right.sku),
  );
  const picked: RollbackPlanEntry[] = [];
  const pickedSkus = new Set<string>();
  const kinds: RepairActionKind[] = [
    "MEDIA",
    "OFFER",
    "TEXT_COUNT",
    "STRUCTURED_ATTRIBUTES",
  ];
  const uncovered = new Set(
    kinds.filter((kind) =>
      entries.some((entry) => entry.forward_action_kinds.includes(kind)),
    ),
  );
  // Deterministic greedy set cover: prefer the SKU that adds the most not-yet
  // covered action kinds, using the snapshot-derived rank as the tie-breaker.
  // The former one-kind-at-a-time loop could waste a slot by choosing a second
  // OFFER SKU even when the first MEDIA SKU already covered OFFER.
  while (picked.length < size && uncovered.size > 0) {
    let candidate: RollbackPlanEntry | null = null;
    let bestGain = 0;
    for (const entry of ranked) {
      if (pickedSkus.has(entry.sku)) continue;
      const gain = entry.forward_action_kinds.filter((kind) =>
        uncovered.has(kind),
      ).length;
      if (gain > bestGain) {
        candidate = entry;
        bestGain = gain;
      }
    }
    if (!candidate || bestGain === 0) break;
    picked.push(candidate);
    pickedSkus.add(candidate.sku);
    for (const kind of candidate.forward_action_kinds) uncovered.delete(kind);
  }
  for (const entry of ranked) {
    if (picked.length >= size) break;
    if (!pickedSkus.has(entry.sku)) {
      picked.push(entry);
      pickedSkus.add(entry.sku);
    }
  }
  return picked;
}

export function buildRollbackPlan(input: {
  snapshotPath: string;
  snapshot: UncrustablesPreChangeSnapshot;
  repairPlanPath: string;
  repairPlan: UncrustablesRepairPlan;
  executionSelectionPath?: string | null;
  executionSelection?: RepairExecutionSelection | null;
  canarySize?: number;
  createdAt?: Date;
}): UncrustablesRollbackPlan {
  verifyPreChangeSnapshot(input.snapshot);
  verifyRepairPlan(input.repairPlan);
  const executionSelection = input.executionSelection ?? null;
  const executionSelectionPath = input.executionSelectionPath?.trim() || null;
  if ((executionSelection == null) !== (executionSelectionPath == null)) {
    throw new Error(
      "Rollback planning requires both executionSelection and executionSelectionPath, or neither.",
    );
  }
  if (executionSelection) {
    verifyRepairExecutionSelection(input.repairPlan, executionSelection);
    if (
      executionSelection.source_plan.path != null &&
      path.resolve(executionSelection.source_plan.path) !==
        path.resolve(input.repairPlanPath)
    ) {
      throw new Error(
        "Execution selection and rollback do not bind the same source repair-plan path.",
      );
    }
  }
  if (input.repairPlan.source_ledger.sha256 !== input.snapshot.source_ledger.sha256) {
    throw new Error("Repair plan and pre-change snapshot do not share the exact source ledger SHA-256.");
  }
  if (
    input.repairPlan.desired_manifest_source &&
    (input.snapshot.reviewed_overrides.sha256 !==
      input.repairPlan.desired_manifest_source.sha256 ||
      path.resolve(input.snapshot.reviewed_overrides.path) !==
        path.resolve(input.repairPlan.desired_manifest_source.path))
  ) {
    throw new Error(
      "Pre-change snapshot overrides are not the exact reviewed manifest source sealed in the repair plan.",
    );
  }
  const snapshotBySku = new Map(
    input.snapshot.entries.map((entry) => [entry.sku, entry]),
  );
  const evidenceByUrl = new Map(
    input.snapshot.image_capture.evidence.map((item) => [item.url, item]),
  );
  const selectedActionIds = executionSelection
    ? new Set(executionSelection.selected_action_ids)
    : null;
  const selectedRepairEntries = input.repairPlan.entries
    .map((entry) => ({
      ...entry,
      actions: selectedActionIds
        ? entry.actions.filter((action) => selectedActionIds.has(action.action_id))
        : entry.actions,
    }))
    .filter((entry) => entry.actions.length > 0);
  if (executionSelection) {
    const resolvedActionIds = selectedRepairEntries.flatMap((entry) =>
      entry.actions.map((action) => action.action_id),
    );
    if (
      stableJson(resolvedActionIds) !==
      stableJson(executionSelection.selected_action_ids) ||
      stableJson(selectedRepairEntries.map((entry) => entry.sku)) !==
      stableJson(executionSelection.selected_skus)
    ) {
      throw new Error(
        "Execution selection is not an exact ordered action subset of the source repair plan.",
      );
    }
  }
  let missingMediaEvidence = 0;
  const entries: RollbackPlanEntry[] = selectedRepairEntries.map((repairEntry) => {
    const beforeEntry = snapshotBySku.get(repairEntry.sku);
    if (
      !beforeEntry ||
      beforeEntry.asin !== repairEntry.asin ||
      beforeEntry.store_index !== repairEntry.store_index
    ) {
      throw new Error(`Snapshot identity/coverage mismatch for repair SKU ${repairEntry.sku}.`);
    }
    const byPath = new Map<string, ListingPatch>();
    const alternateByPath = new Map<string, ListingPatch[]>();
    for (const action of repairEntry.actions) {
      for (const patch of buildActionPatches(action, beforeEntry.listing)) {
        const existing = byPath.get(patch.path);
        if (existing && stableJson(existing) !== stableJson(patch)) {
          throw new Error(
            `Forward actions produce conflicting values for ${repairEntry.sku} ${patch.path}.`,
          );
        }
        byPath.set(patch.path, patch);
      }
      for (const patch of fallbackPatchesForAction(action, beforeEntry.listing)) {
        const alternatives = alternateByPath.get(patch.path) ?? [];
        if (!alternatives.some((item) => stableJson(item) === stableJson(patch))) {
          alternatives.push(patch);
        }
        alternateByPath.set(patch.path, alternatives);
      }
    }
    const operations: RollbackOperation[] = [...byPath.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((patch) => {
        const before = stateAtPath(beforeEntry.listing, patch.path);
        if (
          patch.op === "merge" &&
          patch.path === "/attributes/purchasable_offer" &&
          !hasRestorableB2bPrice(before)
        ) {
          throw new Error(
            `Rollback cannot safely cover ${repairEntry.sku} B2B price: the live snapshot has no marketplace-observed selector-level before value.`,
          );
        }
        const expectedAfter = stateAfterPatch(patch, before);
        const alternateExpectedAfter = (alternateByPath.get(patch.path) ?? [])
          .map((alternate) => stateAfterPatch(alternate, before))
          .filter((state) => state.sha256 !== expectedAfter.sha256);
        const mediaUrls = mediaUrlsFromState(patch.path, before);
        for (const url of mediaUrls) {
          const evidence = evidenceByUrl.get(url);
          if (!evidence?.sha256 || evidence.error) missingMediaEvidence++;
        }
        return {
          operation_id: `INV-${sha256(`${repairEntry.sku}:${patch.path}`).slice(0, 20)}`,
          path: patch.path,
          forward_patch_op: patch.op,
          before,
          expected_after: expectedAfter,
          alternate_expected_after: alternateExpectedAfter,
          inverse_patch: inversePatchFor(
            patch.path,
            before,
            expectedAfter,
            patch.op,
          ),
          media_urls_requiring_binary_evidence: mediaUrls,
        };
      });
    if (
      executionSelection &&
      operations.some((operation) =>
        executionSelection.forbidden_patch_paths.includes(operation.path),
      )
    ) {
      throw new Error(
        `Selection-scoped rollback for ${repairEntry.sku} contains a forbidden patch path.`,
      );
    }
    if (repairEntry.actions.length > 0 && operations.length === 0) {
      throw new Error(`Repair entry ${repairEntry.sku} produced no reversible operations.`);
    }
    return {
      rollback_entry_id: `RB-${sha256(`${input.repairPlan.sha256}:${repairEntry.sku}`).slice(0, 20)}`,
      sku: repairEntry.sku,
      asin: repairEntry.asin,
      store_index: repairEntry.store_index,
      before_product_type: beforeEntry.product_type,
      forward_action_ids: repairEntry.actions.map((action) => action.action_id),
      forward_action_kinds: [
        ...new Set(repairEntry.actions.map((action) => action.kind)),
      ],
      operations,
    };
  });
  entries.sort((left, right) => left.sku.localeCompare(right.sku));
  const canary = selectCanary(
    entries,
    input.snapshot.sha256,
    input.canarySize ?? 3,
  );
  const createdAt = input.createdAt ?? new Date();
  const body: Omit<UncrustablesRollbackPlan, "sha256"> = {
    schema_version: ROLLBACK_PLAN_SCHEMA,
    immutable: true,
    rollback_plan_id: `UARP-${createdAt.toISOString().replace(/[-:.]/g, "")}-${input.repairPlan.sha256.slice(0, 12)}`,
    created_at: createdAt.toISOString(),
    apply_eligible:
      input.snapshot.capture_mode === "LIVE_SP_API" &&
      input.snapshot.apply_eligible === true &&
      input.repairPlan.desired_manifest_source != null &&
      input.repairPlan.scope.blocked === 0 &&
      input.repairPlan.semantic_audit.blocked === 0 &&
      missingMediaEvidence === 0,
    source_snapshot: {
      path: input.snapshotPath,
      sha256: input.snapshot.sha256,
      snapshot_id: input.snapshot.snapshot_id,
      capture_mode: input.snapshot.capture_mode,
      completed_at: input.snapshot.completed_at,
      exact_scope: UNCRUSTABLES_AMAZON_SCOPE,
    },
    source_repair_plan: {
      path: input.repairPlanPath,
      sha256: input.repairPlan.sha256,
      plan_id: input.repairPlan.plan_id,
      source_ledger_sha256: input.repairPlan.source_ledger.sha256,
    },
    source_execution_selection: executionSelection
      ? {
          path: executionSelectionPath as string,
          sha256: executionSelection.sha256,
          profile: executionSelection.profile,
          selected_actions: executionSelection.selected_actions,
          selected_action_ids_sha256: sha256(
            stableJson(executionSelection.selected_action_ids),
          ),
        }
      : null,
    policy: {
      marketplace_id: MARKETPLACE_ID,
      patch_only: true,
      path_level_compare_and_swap: true,
      validation_preview_required: true,
      fresh_get_guard_required: true,
      post_write_readback_required: true,
      cli_confirmation_required: true,
      environment_confirmation_required: true,
      default_scope: "CANARY",
      maximum_errors_default: 1,
    },
    canary: {
      method: "ACTION_KIND_COVERAGE_THEN_SHA256",
      size: canary.length,
      skus: canary.map((entry) => entry.sku),
      covered_action_kinds: [
        ...new Set(canary.flatMap((entry) => entry.forward_action_kinds)),
      ],
    },
    scope: {
      snapshot_entries: UNCRUSTABLES_AMAZON_SCOPE,
      repair_entries: selectedRepairEntries.length,
      repair_actions: selectedRepairEntries.reduce(
        (sum, entry) => sum + entry.actions.length,
        0,
      ),
      rollback_entries: entries.length,
      inverse_operations: entries.reduce(
        (sum, entry) => sum + entry.operations.length,
        0,
      ),
      missing_media_binary_evidence: missingMediaEvidence,
    },
    entries,
  };
  const plan = seal(body as unknown as UnknownRecord) as unknown as UncrustablesRollbackPlan;
  verifyRollbackPlan(plan);
  return plan;
}

export function verifyRollbackPlan(plan: UncrustablesRollbackPlan): void {
  if (
    plan.schema_version !== ROLLBACK_PLAN_SCHEMA ||
    plan.immutable !== true ||
    plan.source_snapshot.exact_scope !== UNCRUSTABLES_AMAZON_SCOPE ||
    plan.scope.snapshot_entries !== UNCRUSTABLES_AMAZON_SCOPE ||
    plan.policy.patch_only !== true ||
    plan.policy.path_level_compare_and_swap !== true ||
    plan.policy.validation_preview_required !== true ||
    plan.policy.fresh_get_guard_required !== true ||
    plan.policy.post_write_readback_required !== true ||
    plan.policy.cli_confirmation_required !== true ||
    plan.policy.environment_confirmation_required !== true
  ) {
    throw new Error("Rollback plan safety policy or exact scope is invalid.");
  }
  verifySeal(plan as unknown as UnknownRecord, "Rollback plan");
  const selectionSource = plan.source_execution_selection;
  if (
    selectionSource != null &&
    (!nonEmptyString(selectionSource.path) ||
      !/^[a-f0-9]{64}$/i.test(selectionSource.sha256) ||
      !Number.isInteger(selectionSource.selected_actions) ||
      selectionSource.selected_actions <= 0 ||
      !/^[a-f0-9]{64}$/i.test(selectionSource.selected_action_ids_sha256))
  ) {
    throw new Error("Rollback execution-selection binding is invalid.");
  }
  const entryIds = new Set<string>();
  const skus = new Set<string>();
  const operationIds = new Set<string>();
  const forwardActionIds = new Set<string>();
  for (const entry of plan.entries) {
    if (
      entryIds.has(entry.rollback_entry_id) ||
      skus.has(entry.sku) ||
      !entry.operations.length
    ) {
      throw new Error(`Duplicate or empty rollback entry ${entry.sku}.`);
    }
    entryIds.add(entry.rollback_entry_id);
    skus.add(entry.sku);
    if (!entry.forward_action_ids.length) {
      throw new Error(`Rollback entry ${entry.sku} has no forward action coverage.`);
    }
    for (const actionId of entry.forward_action_ids) {
      if (!nonEmptyString(actionId) || forwardActionIds.has(actionId)) {
        throw new Error(`Duplicate or invalid forward action coverage ${actionId}.`);
      }
      forwardActionIds.add(actionId);
    }
    const contentScoped =
      selectionSource?.profile === CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE ||
      selectionSource?.profile === TEXT_STRUCTURED_ONLY_PROFILE;
    if (contentScoped && entry.forward_action_kinds.includes("OFFER")) {
      throw new Error(
        `Content-only rollback entry ${entry.sku} contains OFFER coverage.`,
      );
    }
    if (
      selectionSource?.profile === TEXT_STRUCTURED_ONLY_PROFILE &&
      entry.forward_action_kinds.includes("MEDIA")
    ) {
      throw new Error(
        `Text/structured-only rollback entry ${entry.sku} contains MEDIA coverage.`,
      );
    }
    for (const operation of entry.operations) {
      attributeName(operation.path);
      if (
        contentScoped &&
        (OFFER_PATCH_PATHS as readonly string[]).includes(operation.path)
      ) {
        throw new Error(
          `Content-only rollback contains forbidden operation ${operation.path}.`,
        );
      }
      if (
        selectionSource?.profile === TEXT_STRUCTURED_ONLY_PROFILE &&
        (MEDIA_PATCH_PATHS as readonly string[]).includes(operation.path)
      ) {
        throw new Error(
          `Text/structured-only rollback contains forbidden operation ${operation.path}.`,
        );
      }
      if (operationIds.has(operation.operation_id)) {
        throw new Error(`Duplicate rollback operation ${operation.operation_id}.`);
      }
      operationIds.add(operation.operation_id);
      const expectedInverse = inversePatchFor(
        operation.path,
        operation.before,
        operation.expected_after,
        operation.forward_patch_op,
      );
      if (
        !["add", "replace", "delete", "merge"].includes(
          operation.forward_patch_op,
        ) ||
        stableJson(expectedInverse) !== stableJson(operation.inverse_patch) ||
        operation.before.sha256 !==
          fieldState(operation.before.present, operation.before.value).sha256 ||
        operation.expected_after.sha256 !==
          fieldState(
            operation.expected_after.present,
            operation.expected_after.value,
          ).sha256 ||
        operation.alternate_expected_after.some(
          (state) =>
            state.sha256 !==
            fieldState(state.present, state.value).sha256,
        )
      ) {
        throw new Error(`Invalid inverse operation ${operation.operation_id}.`);
      }
    }
  }
  if (
    plan.scope.rollback_entries !== plan.entries.length ||
    plan.scope.repair_entries !== plan.entries.length ||
    plan.scope.repair_actions !== forwardActionIds.size ||
    plan.scope.inverse_operations !==
      plan.entries.reduce((sum, entry) => sum + entry.operations.length, 0) ||
    plan.canary.skus.some((sku) => !skus.has(sku)) ||
    new Set(plan.canary.skus).size !== plan.canary.skus.length
  ) {
    throw new Error("Rollback plan scope/canary summary is inconsistent.");
  }
  if (
    selectionSource &&
    (selectionSource.selected_actions !== forwardActionIds.size ||
      selectionSource.selected_action_ids_sha256 !==
        sha256(stableJson(plan.entries.flatMap((entry) => entry.forward_action_ids))))
  ) {
    throw new Error(
      "Rollback entries do not exactly cover the sealed execution selection action IDs.",
    );
  }
}

/** Re-prove the local binary fallback for every original media URL that a
 * forward plan can replace/delete. The rollback executor normally restores the
 * original Amazon URL; these content-addressed bytes are the recovery fallback
 * if that URL is no longer ingestible. A missing/corrupt file makes both
 * forward apply and rollback fail before credentials are requested. */
export async function assertRollbackMediaEvidenceFiles(input: {
  snapshot: UncrustablesPreChangeSnapshot;
  rollbackPlan: UncrustablesRollbackPlan;
}): Promise<void> {
  verifyPreChangeSnapshot(input.snapshot);
  verifyRollbackPlan(input.rollbackPlan);
  if (input.rollbackPlan.source_snapshot.sha256 !== input.snapshot.sha256) {
    throw new Error("Rollback media evidence belongs to a different snapshot.");
  }
  const requiredUrls = new Set(
    input.rollbackPlan.entries.flatMap((entry) =>
      entry.operations.flatMap(
        (operation) => operation.media_urls_requiring_binary_evidence,
      ),
    ),
  );
  const evidenceByUrl = new Map(
    input.snapshot.image_capture.evidence.map((item) => [item.url, item]),
  );
  for (const url of [...requiredUrls].sort()) {
    const evidence = evidenceByUrl.get(url);
    if (
      !evidence?.sha256 ||
      evidence.error ||
      !evidence.local_path ||
      !Number.isInteger(evidence.bytes) ||
      (evidence.bytes ?? 0) <= 0
    ) {
      throw new Error(`Rollback media binary evidence is missing for ${url}.`);
    }
    const bytes = await readFile(evidence.local_path);
    if (
      bytes.length !== evidence.bytes ||
      sha256(bytes) !== evidence.sha256
    ) {
      throw new Error(
        `Rollback media binary evidence is missing or corrupted for ${url}.`,
      );
    }
  }
}

export async function writeImmutableRollbackPlan(
  outputDir: string,
  plan: UncrustablesRollbackPlan,
): Promise<string> {
  verifyRollbackPlan(plan);
  await mkdir(outputDir, { recursive: true });
  const file = path.join(
    outputDir,
    `${plan.rollback_plan_id}-${plan.sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readRollbackPlan(
  file: string,
): Promise<UncrustablesRollbackPlan> {
  const plan = JSON.parse(await readFile(file, "utf8")) as UncrustablesRollbackPlan;
  verifyRollbackPlan(plan);
  return plan;
}

export function rollbackConfirmationToken(
  plan: UncrustablesRollbackPlan,
): string {
  verifyRollbackPlan(plan);
  return `ROLLBACK-UNCRUSTABLES-${plan.sha256.slice(0, 16).toUpperCase()}`;
}

/** Gate used by the forward repair CLI before its first Amazon credential/API call. */
export function assertForwardApplyRollbackCoverage(input: {
  repairPlan: UncrustablesRepairPlan;
  snapshot: UncrustablesPreChangeSnapshot;
  rollbackPlan: UncrustablesRollbackPlan;
  executionSelection?: RepairExecutionSelection | null;
  executionSelectionPath?: string | null;
  selectedSkus?: string[] | null;
  limit?: number | null;
  now?: Date;
  maxSnapshotAgeMinutes?: number;
}): void {
  verifyRepairPlan(input.repairPlan);
  verifyPreChangeSnapshot(input.snapshot);
  verifyRollbackPlan(input.rollbackPlan);
  const executionSelection = input.executionSelection ?? null;
  const executionSelectionPath = input.executionSelectionPath?.trim() || null;
  if (executionSelection) {
    verifyRepairExecutionSelection(input.repairPlan, executionSelection);
    if (
      !executionSelectionPath ||
      input.selectedSkus?.length ||
      input.limit != null
    ) {
      throw new Error(
        "Selection-scoped forward apply requires its exact artifact path and cannot be combined with runtime SKU/limit narrowing.",
      );
    }
  } else if (executionSelectionPath) {
    throw new Error(
      "executionSelectionPath was supplied without a sealed execution selection.",
    );
  }
  const rollbackSelection = input.rollbackPlan.source_execution_selection;
  if (
    !input.rollbackPlan.apply_eligible ||
    input.snapshot.capture_mode !== "LIVE_SP_API" ||
    !input.snapshot.apply_eligible ||
    input.repairPlan.desired_manifest_source == null ||
    input.repairPlan.scope.blocked !== 0 ||
    input.repairPlan.semantic_audit.blocked !== 0 ||
    input.rollbackPlan.source_snapshot.sha256 !== input.snapshot.sha256 ||
    input.rollbackPlan.source_repair_plan.sha256 !== input.repairPlan.sha256 ||
    input.rollbackPlan.source_repair_plan.source_ledger_sha256 !==
      input.repairPlan.source_ledger.sha256 ||
    input.snapshot.source_ledger.sha256 !== input.repairPlan.source_ledger.sha256 ||
    input.snapshot.reviewed_overrides.sha256 !==
      input.repairPlan.desired_manifest_source.sha256 ||
    path.resolve(input.snapshot.reviewed_overrides.path) !==
      path.resolve(input.repairPlan.desired_manifest_source.path) ||
    (executionSelection == null && rollbackSelection != null) ||
    (executionSelection != null &&
      (rollbackSelection == null ||
        rollbackSelection.sha256 !== executionSelection.sha256 ||
        path.resolve(rollbackSelection.path) !==
          path.resolve(executionSelectionPath as string) ||
        rollbackSelection.profile !== executionSelection.profile ||
        rollbackSelection.selected_actions !==
          executionSelection.selected_actions ||
        rollbackSelection.selected_action_ids_sha256 !==
          sha256(stableJson(executionSelection.selected_action_ids))))
  ) {
    throw new Error("Forward apply is not covered by an apply-eligible exact live rollback set.");
  }
  let selected: UncrustablesRepairPlan["entries"];
  if (executionSelection) {
    const actionIds = new Set(executionSelection.selected_action_ids);
    selected = input.repairPlan.entries
      .map((entry) => ({
        ...entry,
        actions: entry.actions.filter((action) => actionIds.has(action.action_id)),
      }))
      .filter((entry) => entry.actions.length > 0);
    if (
      stableJson(selected.flatMap((entry) =>
        entry.actions.map((action) => action.action_id))) !==
        stableJson(executionSelection.selected_action_ids) ||
      stableJson(input.rollbackPlan.entries.flatMap((entry) =>
        entry.forward_action_ids)) !==
        stableJson(executionSelection.selected_action_ids)
    ) {
      throw new Error(
        "Selection-scoped rollback coverage is not the exact selected action set.",
      );
    }
  } else {
    const requested = input.selectedSkus?.length
      ? new Set(input.selectedSkus)
      : null;
    selected = input.repairPlan.entries.filter(
      (entry) => !requested || requested.has(entry.sku),
    );
    if (input.limit != null) selected = selected.slice(0, input.limit);
  }
  const rollbackBySku = new Map(
    input.rollbackPlan.entries.map((entry) => [entry.sku, entry]),
  );
  const snapshotBySku = new Map(
    input.snapshot.entries.map((entry) => [entry.sku, entry]),
  );
  for (const entry of selected) {
    const rollback = rollbackBySku.get(entry.sku);
    const before = snapshotBySku.get(entry.sku);
    if (
      !rollback ||
      !before ||
      rollback.asin !== entry.asin ||
      stableJson([...rollback.forward_action_ids].sort()) !==
        stableJson(entry.actions.map((action) => action.action_id).sort())
    ) {
      throw new Error(`Forward apply lacks exact rollback coverage for ${entry.sku}.`);
    }
    for (const action of entry.actions) {
      if (action.desired.kind !== "TEXT_COUNT") continue;
      const desired = action.desired.value;
      const productTypes = [
        desired.request_product_type,
        desired.expected_product_type,
        desired.fallback?.request_product_type,
        desired.fallback?.expected_product_type,
      ].filter((value): value is string => nonEmptyString(value) != null);
      if (productTypes.some((value) => value !== before.product_type)) {
        throw new Error(
          `Forward apply for ${entry.sku} attempts a product-type transition not covered by attribute-path rollback (${before.product_type} -> ${[
            ...new Set(productTypes),
          ].join("/")}).`,
        );
      }
    }
  }
  const maxAge = input.maxSnapshotAgeMinutes ?? 60;
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 24 * 60) {
    throw new Error("maxSnapshotAgeMinutes must be >0 and <=1440.");
  }
  const oldestCapturedAt = Math.min(
    ...input.snapshot.entries.map((entry) =>
      new Date(entry.captured_at).getTime(),
    ),
  );
  const ageMs = (input.now ?? new Date()).getTime() - oldestCapturedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAge * 60_000) {
    throw new Error(
      `Pre-change snapshot is stale; forward apply requires a LIVE_SP_API capture no older than ${maxAge} minutes.`,
    );
  }
}

/**
 * Compare-and-swap guard for the forward executor. The exact patch paths must
 * be represented in the inverse plan, the last fresh GET must still equal the
 * captured before state (or an idempotently applied permitted after state), and
 * the proposed value must equal the sealed primary/reviewed-fallback state.
 */
export function assertForwardPatchRollbackCovered(input: {
  rollbackPlan: UncrustablesRollbackPlan;
  storeIndex: number;
  sku: string;
  live: ListingItem;
  patches: ListingPatch[];
}): void {
  verifyRollbackPlan(input.rollbackPlan);
  const entry = input.rollbackPlan.entries.find(
    (item) => item.sku === input.sku && item.store_index === input.storeIndex,
  );
  if (!entry) {
    throw new Error(`No rollback entry covers forward patch for ${input.sku}.`);
  }
  assertEntryIdentity(entry, input.live);
  const operationByPath = new Map(
    entry.operations.map((operation) => [operation.path, operation]),
  );
  const seen = new Set<string>();
  for (const patch of input.patches) {
    if (seen.has(patch.path)) {
      throw new Error(`Forward payload repeats rollback path ${patch.path}.`);
    }
    seen.add(patch.path);
    const operation = operationByPath.get(patch.path);
    if (!operation) {
      throw new Error(
        `Forward patch path ${input.sku} ${patch.path} has no sealed inverse operation.`,
      );
    }
    if (patch.op !== operation.forward_patch_op) {
      throw new Error(
        `Forward patch operation for ${input.sku} ${patch.path} is ${patch.op}, but rollback covers only ${operation.forward_patch_op}.`,
      );
    }
    const permittedAfter = [
      operation.expected_after,
      ...operation.alternate_expected_after,
    ];
    const current = stateAtPath(input.live, patch.path);
    if (
      current.sha256 !== operation.before.sha256 &&
      !permittedAfter.some((state) => state.sha256 === current.sha256)
    ) {
      throw new Error(
        `Forward compare-and-swap conflict for ${input.sku} ${patch.path}; live state drifted after snapshot.`,
      );
    }
    const proposed = stateAfterPatch(patch, current);
    if (!permittedAfter.some((state) => state.sha256 === proposed.sha256)) {
      throw new Error(
        `Forward payload for ${input.sku} ${patch.path} differs from the sealed rollback expectation.`,
      );
    }
  }
  if (seen.size === 0) {
    throw new Error(`Forward patch for ${input.sku} is empty.`);
  }
}

export interface RollbackGateway extends SnapshotReadGateway {
  patchListing(
    storeIndex: number,
    sku: string,
    productType: string,
    patches: ListingPatch[],
    validationPreview: boolean,
    previewContext?: RepairValidationPreviewContext,
  ): Promise<UnknownRecord>;
}

export type RollbackCheckpointStatus =
  | "PREVIEW_VALID"
  | "SUBMISSION_ARMED"
  | "SUBMITTED"
  | "SETTLEMENT_PENDING"
  | "SETTLED_FORWARD"
  | "SETTLEMENT_UNRESOLVED"
  | "VERIFIED"
  | "ALREADY_ROLLED_BACK"
  | "FAILED";

export interface RollbackCheckpointEvent {
  schema_version: typeof ROLLBACK_CHECKPOINT_SCHEMA;
  immutable: true;
  event_id: string;
  created_at: string;
  rollback_plan_sha256: string;
  rollback_entry_id: string;
  sku: string;
  status: RollbackCheckpointStatus;
  detail: UnknownRecord;
  sha256: string;
}

interface PendingRollbackSubmission {
  rollback_entry_id: string;
  sku: string;
  submitted_event_id: string;
  submitted_at: string;
  detail: UnknownRecord;
}

export class ImmutableRollbackCheckpointStore {
  constructor(
    private readonly rootDir: string,
    private readonly rollbackPlanSha256: string,
    private readonly coordinationDir: string =
      CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR,
  ) {}

  private directory(): string {
    return path.join(this.rootDir, this.rollbackPlanSha256.slice(0, 20));
  }

  async acquireExecutionLease(purpose: string): Promise<() => Promise<void>> {
    const coordinationDir = path.resolve(this.coordinationDir);
    await mkdir(coordinationDir, { recursive: true });
    const leasePath = path.join(coordinationDir, "active-execution.lock");
    const leaseId = randomUUID();
    const body = {
      schema_version: "uncrustables-amazon-mutation-lease/v1",
      immutable_rollback_plan_sha256: this.rollbackPlanSha256,
      lease_id: leaseId,
      acquired_at: new Date().toISOString(),
      process_id: process.pid,
      purpose,
    };
    try {
      await writeFile(leasePath, `${JSON.stringify(body, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Amazon rollback execution lease already exists for ${this.rollbackPlanSha256}. Refusing concurrent or post-crash execution; inspect ${leasePath} and pending settlement checkpoints before manual lease removal.`,
        );
      }
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      const current = JSON.parse(await readFile(leasePath, "utf8")) as {
        lease_id?: unknown;
      };
      if (current.lease_id !== leaseId) {
        throw new Error(
          `Amazon rollback execution lease ownership changed for ${this.rollbackPlanSha256}; refusing to remove it.`,
        );
      }
      await unlink(leasePath);
      released = true;
    };
  }

  async append(
    input: Omit<
      RollbackCheckpointEvent,
      | "schema_version"
      | "immutable"
      | "event_id"
      | "created_at"
      | "rollback_plan_sha256"
      | "sha256"
    >,
  ): Promise<RollbackCheckpointEvent> {
    const body: Omit<RollbackCheckpointEvent, "sha256"> = {
      schema_version: ROLLBACK_CHECKPOINT_SCHEMA,
      immutable: true,
      event_id: randomUUID(),
      created_at: new Date().toISOString(),
      rollback_plan_sha256: this.rollbackPlanSha256,
      ...input,
    };
    const event = seal(body as unknown as UnknownRecord) as unknown as RollbackCheckpointEvent;
    const directory = this.directory();
    await mkdir(directory, { recursive: true });
    const file = path.join(
      directory,
      `${event.created_at.replace(/[-:.]/g, "")}-${event.rollback_entry_id}-${event.status}-${event.event_id}.json`,
    );
    await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return event;
  }

  async verifiedEntryIds(): Promise<Set<string>> {
    const verified = new Set<string>();
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return verified;
      throw error;
    }
    for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as RollbackCheckpointEvent;
      verifySeal(event as unknown as UnknownRecord, `Rollback checkpoint ${name}`);
      if (
        event.schema_version !== ROLLBACK_CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.rollback_plan_sha256 !== this.rollbackPlanSha256
      ) {
        throw new Error(`Invalid rollback checkpoint ${name}.`);
      }
      if (event.status === "VERIFIED" || event.status === "ALREADY_ROLLED_BACK") {
        verified.add(event.rollback_entry_id);
      }
    }
    return verified;
  }

  async pendingSubmissions(): Promise<Map<string, PendingRollbackSubmission>> {
    const pending = new Map<string, PendingRollbackSubmission>();
    let names: string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return pending;
      throw error;
    }
    const events: Array<{ name: string; event: RollbackCheckpointEvent }> = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as RollbackCheckpointEvent;
      verifySeal(event as unknown as UnknownRecord, `Rollback checkpoint ${name}`);
      if (
        event.schema_version !== ROLLBACK_CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.rollback_plan_sha256 !== this.rollbackPlanSha256
      ) {
        throw new Error(`Invalid rollback checkpoint ${name}.`);
      }
      events.push({ name, event });
    }
    events.sort(
      (left, right) =>
        left.event.created_at.localeCompare(right.event.created_at) ||
        left.name.localeCompare(right.name),
    );
    const explicitlyClosedSubmissionIds = new Set(
      events
        .filter(({ event }) =>
          event.status === "VERIFIED" ||
          event.status === "ALREADY_ROLLED_BACK")
        .map(({ event }) => event.detail.submitted_event_id)
        .filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && eventId.length > 0,
        ),
    );
    const supersededArmedEventIds = new Set(
      events
        .filter(({ event }) => event.status === "SUBMITTED")
        .map(({ event }) => event.detail.armed_event_id)
        .filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && eventId.length > 0,
        ),
    );
    for (const { event } of events) {
      if (event.status === "SUBMISSION_ARMED" || event.status === "SUBMITTED") {
        if (
          explicitlyClosedSubmissionIds.has(event.event_id) ||
          (event.status === "SUBMISSION_ARMED" &&
            supersededArmedEventIds.has(event.event_id))
        ) continue;
        pending.set(event.rollback_entry_id, {
          rollback_entry_id: event.rollback_entry_id,
          sku: event.sku,
          submitted_event_id: event.event_id,
          submitted_at: event.created_at,
          detail: structuredClone(event.detail),
        });
      } else if (event.status === "VERIFIED" || event.status === "ALREADY_ROLLED_BACK") {
        const current = pending.get(event.rollback_entry_id);
        const closedEventId = event.detail.submitted_event_id;
        if (
          current &&
          typeof closedEventId === "string" &&
          closedEventId === current.submitted_event_id
        ) {
          pending.delete(event.rollback_entry_id);
        }
      }
    }
    return pending;
  }
}

function responseDetail(response: UnknownRecord): UnknownRecord {
  return {
    status: response.status ?? null,
    submission_id: response.submissionId ?? null,
    issues: Array.isArray(response.issues) ? response.issues : [],
  };
}

function entryState(entry: RollbackPlanEntry, listing: ListingItem): {
  already: boolean;
  patches: ListingPatch[];
  conflicts: Array<{ path: string; current: SnapshotFieldState }>;
} {
  const patches: ListingPatch[] = [];
  const conflicts: Array<{ path: string; current: SnapshotFieldState }> = [];
  for (const operation of entry.operations) {
    const current = stateAtPath(listing, operation.path);
    if (current.sha256 === operation.before.sha256) continue;
    if (
      current.sha256 !== operation.expected_after.sha256 &&
      !operation.alternate_expected_after.some(
        (state) => state.sha256 === current.sha256,
      )
    ) {
      conflicts.push({ path: operation.path, current });
      continue;
    }
    patches.push(clone(operation.inverse_patch));
  }
  return { already: patches.length === 0 && conflicts.length === 0, patches, conflicts };
}

function assertEntryIdentity(entry: RollbackPlanEntry, listing: ListingItem): string {
  const summary = summaryFor(listing);
  if (summary?.asin !== entry.asin) {
    throw new Error(
      `Rollback ASIN precondition failed for ${entry.sku}: expected ${entry.asin}, got ${summary?.asin ?? "missing"}.`,
    );
  }
  const productType = nonEmptyString(summary.productType);
  if (!productType) throw new Error(`Rollback live product type missing for ${entry.sku}.`);
  return productType;
}

const EXACT_ROLLBACK_PATH_SETTLEMENT_GUARD =
  "EXACT_ROLLBACK_PATHS_V1" as const;

interface RollbackSettlementEvidence {
  schema_version: typeof EXACT_ROLLBACK_PATH_SETTLEMENT_GUARD;
  actual_patch_sha256: string;
  exact_action_paths: string[];
  before_path_state_sha256: string;
}

function rollbackPathStateSha256(
  entry: RollbackPlanEntry,
  listing: ListingItem,
): string {
  return sha256(stableJson(entry.operations
    .map((operation) => {
      const state = stateAtPath(listing, operation.path);
      return {
        path: operation.path,
        present: state.present,
        value_sha256: state.sha256,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path))));
}

function rollbackSettlementEvidence(
  entry: RollbackPlanEntry,
  listing: ListingItem,
  patches: readonly ListingPatch[],
): RollbackSettlementEvidence {
  const paths = [...new Set(patches.map((patch) => patch.path))].sort();
  const expectedPaths = entry.operations
    .filter((operation) => paths.includes(operation.path))
    .map((operation) => operation.path)
    .sort();
  if (paths.length === 0 || stableJson(paths) !== stableJson(expectedPaths)) {
    throw new Error(
      `Rollback settlement evidence does not match sealed inverse paths for ${entry.sku}.`,
    );
  }
  return {
    schema_version: EXACT_ROLLBACK_PATH_SETTLEMENT_GUARD,
    actual_patch_sha256: sha256(stableJson(patches)),
    exact_action_paths: paths,
    before_path_state_sha256: rollbackPathStateSha256(entry, listing),
  };
}

function parseRollbackSettlementEvidence(
  entry: RollbackPlanEntry,
  pending: PendingRollbackSubmission,
): RollbackSettlementEvidence {
  const raw = pending.detail.settlement_guard;
  const paths = isRecord(raw) && Array.isArray(raw.exact_action_paths)
    ? raw.exact_action_paths.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      ).sort()
    : [];
  const permitted = new Set(entry.operations.map((operation) => operation.path));
  if (
    !isRecord(raw) ||
    raw.schema_version !== EXACT_ROLLBACK_PATH_SETTLEMENT_GUARD ||
    paths.length === 0 ||
    paths.some((item) => !permitted.has(item)) ||
    !/^[a-f0-9]{64}$/.test(String(raw.actual_patch_sha256 ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(raw.before_path_state_sha256 ?? ""))
  ) {
    throw new Error(
      `Pending rollback ${entry.sku} has invalid exact-path settlement evidence.`,
    );
  }
  return {
    schema_version: EXACT_ROLLBACK_PATH_SETTLEMENT_GUARD,
    actual_patch_sha256: String(raw.actual_patch_sha256),
    exact_action_paths: paths,
    before_path_state_sha256: String(raw.before_path_state_sha256),
  };
}

interface RollbackSettlementOutcome {
  state: "ROLLED_BACK" | "STABLE_FORWARD" | "UNRESOLVED";
  attempts: number;
  consecutive_stable_reads: number;
  last_path_state_sha256: string | null;
  last_state: ReturnType<typeof entryState> | null;
}

async function pollRollbackSettlement(input: {
  entry: RollbackPlanEntry;
  gateway: RollbackGateway;
  evidence: RollbackSettlementEvidence;
  attempts: number;
  delayMs: number;
  stableReads: number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<RollbackSettlementOutcome> {
  let consecutive = 0;
  let previousKey: string | null = null;
  let lastDigest: string | null = null;
  let lastState: ReturnType<typeof entryState> | null = null;
  let lastClassification: "ROLLED_BACK" | "FORWARD" | "NON_DESIRED" | null = null;
  for (let attempt = 1; attempt <= input.attempts; attempt++) {
    await input.sleep(input.delayMs);
    const listing = await input.gateway.getListing(
      input.entry.store_index,
      input.entry.sku,
    );
    assertEntryIdentity(input.entry, listing);
    lastState = entryState(input.entry, listing);
    lastDigest = rollbackPathStateSha256(input.entry, listing);
    lastClassification = lastState.already
      ? "ROLLED_BACK"
      : lastDigest === input.evidence.before_path_state_sha256
        ? "FORWARD"
        : "NON_DESIRED";
    const key = `${lastClassification}:${lastDigest}`;
    consecutive = key === previousKey ? consecutive + 1 : 1;
    previousKey = key;
    if (lastClassification === "ROLLED_BACK" && consecutive >= input.stableReads) {
      return {
        state: "ROLLED_BACK",
        attempts: attempt,
        consecutive_stable_reads: consecutive,
        last_path_state_sha256: lastDigest,
        last_state: lastState,
      };
    }
  }
  return {
    state:
      lastClassification === "FORWARD" && consecutive >= input.stableReads
        ? "STABLE_FORWARD"
        : "UNRESOLVED",
    attempts: input.attempts,
    consecutive_stable_reads: consecutive,
    last_path_state_sha256: lastDigest,
    last_state: lastState,
  };
}

class RollbackSettlementGuardError extends Error {
  readonly hardStop = true;

  constructor(message: string) {
    super(message);
    this.name = "RollbackSettlementGuardError";
  }
}

export interface ExecuteRollbackOptions {
  apply: boolean;
  /** GET + exact CAS + Amazon VALIDATION_PREVIEW of the inverse; no mutation. */
  validationOnly?: boolean;
  scope?: "CANARY" | "ALL";
  /** Exact operator-selected partial rollback. Mutually exclusive with scope. */
  skus?: string[] | null;
  confirmation?: string | null;
  environmentConfirmation?: string | null;
  checkpointStore: ImmutableRollbackCheckpointStore;
  /** Required for a mutating rollback so a late forward PATCH cannot be
   * mistaken for an already-restored listing. */
  forwardRepairPlan?: UncrustablesRepairPlan;
  forwardExecutionSelection?: RepairExecutionSelection;
  forwardExecutionSelectionPath?: string;
  forwardCheckpointStore?: ImmutableCheckpointStore;
  requestDelayMs?: number;
  verifyAttempts?: number;
  verifyDelayMs?: number;
  settlementAttempts?: number;
  settlementDelayMs?: number;
  settlementStableReads?: number;
  maxErrors?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ExecuteRollbackResult {
  mode: "DRY_RUN" | "VALIDATION_PREVIEW" | "ROLLBACK";
  scope: "CANARY" | "ALL" | "SKUS";
  selected_entries: number;
  selected_operations: number;
  verified_entries: number;
  already_rolled_back_entries: number;
  resumed_entries: number;
  preview_valid_entries: number;
  failed_entries: number;
  recovered_pending_forward_actions: number;
  quarantined_pending_forward_actions: number;
  recovered_pending_rollback_entries: number;
  unresolved_settlements: number;
  stopped_early: boolean;
}

/** Execute guarded inverse PATCHes. `apply=false` performs zero gateway calls. */
export async function executeRollbackPlan(
  plan: UncrustablesRollbackPlan,
  gateway: RollbackGateway,
  options: ExecuteRollbackOptions,
): Promise<ExecuteRollbackResult> {
  verifyRollbackPlan(plan);
  if (options.apply && options.validationOnly) {
    throw new Error("Rollback apply and validationOnly are mutually exclusive.");
  }
  const requestedSkus = options.skus?.length
    ? new Set(options.skus.map((sku) => sku.trim()).filter(Boolean))
    : null;
  if (requestedSkus && options.scope) {
    throw new Error("Rollback exact --skus selection is mutually exclusive with CANARY/ALL scope.");
  }
  const scope = requestedSkus ? "SKUS" : options.scope ?? "CANARY";
  if (options.apply || options.validationOnly) {
    if (!plan.apply_eligible) {
      throw new Error(
        "Rollback plan is diagnostic-only and cannot be applied or live-previewed.",
      );
    }
  }
  if (options.apply) {
    const token = rollbackConfirmationToken(plan);
    if (
      options.confirmation !== token ||
      options.environmentConfirmation !== token
    ) {
      throw new Error(
        `Rollback requires both --confirm=${token} and BF_UNCRUSTABLES_ENABLE_AMAZON_ROLLBACK=${token}. No Amazon call was made.`,
      );
    }
    if (!options.forwardRepairPlan || !options.forwardCheckpointStore) {
      throw new Error(
        "Rollback apply requires the exact sealed forward repair plan and its immutable checkpoint store so late forward submissions can be settled first. No Amazon call was made.",
      );
    }
    verifyRepairPlan(options.forwardRepairPlan);
    if (options.forwardRepairPlan.sha256 !== plan.source_repair_plan.sha256) {
      throw new Error(
        "Rollback forward-settlement guard plan SHA-256 differs from the sealed rollback source. No Amazon call was made.",
      );
    }
    const selectionSource = plan.source_execution_selection;
    if (selectionSource) {
      if (!options.forwardExecutionSelection) {
        throw new Error(
          "Selection-scoped rollback requires the exact sealed forward execution selection. No Amazon call was made.",
        );
      }
      verifyRepairExecutionSelection(
        options.forwardRepairPlan,
        options.forwardExecutionSelection,
      );
      if (
        !options.forwardExecutionSelectionPath ||
        path.resolve(options.forwardExecutionSelectionPath) !==
          path.resolve(selectionSource.path) ||
        selectionSource.sha256 !== options.forwardExecutionSelection.sha256 ||
        selectionSource.profile !== options.forwardExecutionSelection.profile ||
        selectionSource.selected_actions !==
          options.forwardExecutionSelection.selected_actions ||
        selectionSource.selected_action_ids_sha256 !==
          sha256(stableJson(options.forwardExecutionSelection.selected_action_ids))
      ) {
        throw new Error(
          "Rollback forward execution selection differs from the sealed rollback source. No Amazon call was made.",
        );
      }
    } else if (
      options.forwardExecutionSelection ||
      options.forwardExecutionSelectionPath
    ) {
      throw new Error(
        "A whole-plan rollback cannot execute as a selection-scoped rollback. No Amazon call was made.",
      );
    }
  }
  const canarySkus = new Set(plan.canary.skus);
  const entries = requestedSkus
    ? plan.entries.filter((entry) => requestedSkus.has(entry.sku))
    : scope === "CANARY"
      ? plan.entries.filter((entry) => canarySkus.has(entry.sku))
      : plan.entries;
  if (requestedSkus) {
    const found = new Set(entries.map((entry) => entry.sku));
    const missing = [...requestedSkus].filter((sku) => !found.has(sku));
    if (missing.length) {
      throw new Error(`Requested rollback SKU(s) absent from plan: ${missing.join(", ")}.`);
    }
  }
  const result: ExecuteRollbackResult = {
    mode: options.apply
      ? "ROLLBACK"
      : options.validationOnly
        ? "VALIDATION_PREVIEW"
        : "DRY_RUN",
    scope,
    selected_entries: entries.length,
    selected_operations: entries.reduce(
      (sum, entry) => sum + entry.operations.length,
      0,
    ),
    verified_entries: 0,
    already_rolled_back_entries: 0,
    resumed_entries: 0,
    preview_valid_entries: 0,
    failed_entries: 0,
    recovered_pending_forward_actions: 0,
    quarantined_pending_forward_actions: 0,
    recovered_pending_rollback_entries: 0,
    unresolved_settlements: 0,
    stopped_early: false,
  };
  if (!options.apply && !options.validationOnly) return result;

  const requestDelayMs = options.requestDelayMs ?? 250;
  const verifyAttempts = options.verifyAttempts ?? 6;
  const verifyDelayMs = options.verifyDelayMs ?? 10_000;
  const settlementAttempts = options.settlementAttempts ?? 20;
  const settlementDelayMs = options.settlementDelayMs ?? 30_000;
  const settlementStableReads = options.settlementStableReads ?? 3;
  const maxErrors = options.maxErrors ?? 1;
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 200) {
    throw new Error("Rollback requestDelayMs must be an integer >=200.");
  }
  if (!Number.isInteger(verifyAttempts) || verifyAttempts < 1 || verifyAttempts > 10) {
    throw new Error("Rollback verifyAttempts must be an integer from 1 to 10.");
  }
  if (
    !Number.isInteger(settlementAttempts) ||
    settlementAttempts < 1 ||
    settlementAttempts > 60
  ) {
    throw new Error("Rollback settlementAttempts must be an integer from 1 to 60.");
  }
  if (!Number.isInteger(settlementDelayMs) || settlementDelayMs < 0) {
    throw new Error("Rollback settlementDelayMs must be a non-negative integer.");
  }
  if (
    !Number.isInteger(settlementStableReads) ||
    settlementStableReads < 2 ||
    settlementStableReads > 10 ||
    settlementStableReads > settlementAttempts
  ) {
    throw new Error(
      "Rollback settlementStableReads must be 2-10 and <= settlementAttempts.",
    );
  }
  if (!Number.isInteger(maxErrors) || maxErrors < 1) {
    throw new Error("Rollback maxErrors must be a positive integer.");
  }
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let releaseForwardLease: (() => Promise<void>) | null = null;
  if (options.apply) {
    releaseForwardLease = await (
      options.forwardCheckpointStore as ImmutableCheckpointStore
    ).acquireExecutionLease(`ROLLBACK_FORWARD_SETTLEMENT:${plan.rollback_plan_id}`);
  }
  let mutationFenceClaimed = false;
  try {
  if (options.apply) {
    await (
      options.forwardCheckpointStore as ImmutableCheckpointStore
    ).claimPendingMutationFence(`ROLLBACK_APPLY:${plan.rollback_plan_id}`);
    mutationFenceClaimed = true;
    if (options.forwardExecutionSelection) {
      const quarantined =
        await quarantineUnselectedPendingRepairSubmissions({
          plan: options.forwardRepairPlan as UncrustablesRepairPlan,
          selection: options.forwardExecutionSelection,
          checkpointStore:
            options.forwardCheckpointStore as ImmutableCheckpointStore,
        });
      result.quarantined_pending_forward_actions = quarantined.length;
    }
  }
  const selectedSkuList = entries.map((entry) => entry.sku);
  const selectedForwardActionIds = entries.flatMap(
    (entry) => entry.forward_action_ids,
  );
  const forwardRecovery = options.apply
    ? await recoverPendingRepairSettlements({
        plan: options.forwardRepairPlan as UncrustablesRepairPlan,
        gateway,
        checkpointStore: options.forwardCheckpointStore as ImmutableCheckpointStore,
        skus: selectedSkuList,
        actionIds: selectedForwardActionIds,
        attempts: settlementAttempts,
        delayMs: settlementDelayMs,
        stableReads: settlementStableReads,
        sleep,
      })
    : [];
  result.recovered_pending_forward_actions = forwardRecovery.length;
  const forwardBlockedSkus = new Set(
    forwardRecovery
      .filter((outcome) => outcome.state !== "DESIRED")
      .map((outcome) => outcome.sku),
  );
  result.unresolved_settlements += forwardRecovery.filter(
    (outcome) => outcome.state !== "DESIRED",
  ).length;
  const completed = await options.checkpointStore.verifiedEntryIds();
  const pendingRollbacks = options.apply
    ? await options.checkpointStore.pendingSubmissions()
    : new Map<string, PendingRollbackSubmission>();

  for (const entry of entries) {
    try {
      if (forwardBlockedSkus.has(entry.sku)) {
        throw new RollbackSettlementGuardError(
          `Rollback is blocked because a forward Amazon submission for ${entry.sku} has not reached a safe stable state.`,
        );
      }
      const pendingRollback = pendingRollbacks.get(entry.rollback_entry_id);
      if (pendingRollback) {
        result.recovered_pending_rollback_entries++;
        let evidence: RollbackSettlementEvidence;
        try {
          evidence = parseRollbackSettlementEvidence(entry, pendingRollback);
        } catch (error) {
          await options.checkpointStore.append({
            rollback_entry_id: entry.rollback_entry_id,
            sku: entry.sku,
            status: "SETTLEMENT_UNRESOLVED",
            detail: {
              recovery: true,
              submitted_event_id: pendingRollback.submitted_event_id,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          result.unresolved_settlements++;
          throw new RollbackSettlementGuardError(
            `Pending rollback ${entry.sku} lacks valid exact-path settlement evidence.`,
          );
        }
        await options.checkpointStore.append({
          rollback_entry_id: entry.rollback_entry_id,
          sku: entry.sku,
          status: "SETTLEMENT_PENDING",
          detail: {
            recovery: true,
            submitted_event_id: pendingRollback.submitted_event_id,
            submitted_at: pendingRollback.submitted_at,
            settlement_guard: evidence,
            attempts: settlementAttempts,
            delay_ms: settlementDelayMs,
            stable_reads_required: settlementStableReads,
          },
        });
        const recoveredSettlement = await pollRollbackSettlement({
          entry,
          gateway,
          evidence,
          attempts: settlementAttempts,
          delayMs: settlementDelayMs,
          stableReads: settlementStableReads,
          sleep,
        });
        const detail = {
          recovery: true,
          submitted_event_id: pendingRollback.submitted_event_id,
          settlement_guard: evidence,
          polling_attempts: recoveredSettlement.attempts,
          consecutive_stable_reads:
            recoveredSettlement.consecutive_stable_reads,
          last_path_state_sha256:
            recoveredSettlement.last_path_state_sha256,
        };
        if (recoveredSettlement.state === "ROLLED_BACK") {
          await options.checkpointStore.append({
            rollback_entry_id: entry.rollback_entry_id,
            sku: entry.sku,
            status: "VERIFIED",
            detail: { ...detail, recovered_late_submission: true },
          });
          result.verified_entries++;
          continue;
        }
        if (recoveredSettlement.state === "STABLE_FORWARD") {
          await options.checkpointStore.append({
            rollback_entry_id: entry.rollback_entry_id,
            sku: entry.sku,
            status: "SETTLED_FORWARD",
            detail,
          });
          throw new RollbackSettlementGuardError(
            `Prior rollback for ${entry.sku} settled at the exact pre-rollback state; this invocation will not submit a second inverse PATCH.`,
          );
        }
        await options.checkpointStore.append({
          rollback_entry_id: entry.rollback_entry_id,
          sku: entry.sku,
          status: "SETTLEMENT_UNRESOLVED",
          detail,
        });
        result.unresolved_settlements++;
        throw new RollbackSettlementGuardError(
          `Prior rollback for ${entry.sku} did not reach a stable exact-path state.`,
        );
      }
      let listing = await gateway.getListing(entry.store_index, entry.sku);
      let productType = assertEntryIdentity(entry, listing);
      let state = entryState(entry, listing);
      if (state.conflicts.length) {
        throw new Error(
          `Compare-and-swap conflict for ${entry.sku}: ${state.conflicts
            .map((item) => item.path)
            .join(", ")}.`,
        );
      }
      if (state.already) {
        await options.checkpointStore.append({
          rollback_entry_id: entry.rollback_entry_id,
          sku: entry.sku,
          status: "ALREADY_ROLLED_BACK",
          detail: { resumed_checkpoint_revalidated: completed.has(entry.rollback_entry_id) },
        });
        if (completed.has(entry.rollback_entry_id)) result.resumed_entries++;
        else result.already_rolled_back_entries++;
        continue;
      }

      if (options.validationOnly) {
        const previewSet = buildValidationPreviewPatchSet(
          state.patches,
          "ROLLBACK_INVERSE_OFFER",
        );
        const preview = await gateway.patchListing(
          entry.store_index,
          entry.sku,
          productType,
          previewSet.preview_patches,
          true,
          validationPreviewGatewayContext(
            previewSet,
            "ROLLBACK_INVERSE_OFFER",
          ),
        );
        if (preview.status !== "VALID" || hasBlockingIssues(preview)) {
          throw new Error(
            `Rollback readiness VALIDATION_PREVIEW rejected ${entry.sku}: ${JSON.stringify(responseDetail(preview))}`,
          );
        }
        await options.checkpointStore.append({
          rollback_entry_id: entry.rollback_entry_id,
          sku: entry.sku,
          status: "PREVIEW_VALID",
          detail: {
            readiness_only: true,
            ...validationPreviewCheckpointDetail(previewSet),
            ...responseDetail(preview),
          },
        });
        result.preview_valid_entries++;
        await sleep(requestDelayMs);
        continue;
      }

      let guarded = false;
      let patches = state.patches;
      let guardedPreviewSet: ReturnType<
        typeof buildValidationPreviewPatchSet
      > | null = null;
      for (let guardAttempt = 1; guardAttempt <= 2; guardAttempt++) {
        const previewSet = buildValidationPreviewPatchSet(
          patches,
          "ROLLBACK_INVERSE_OFFER",
        );
        const preview = await gateway.patchListing(
          entry.store_index,
          entry.sku,
          productType,
          previewSet.preview_patches,
          true,
          validationPreviewGatewayContext(
            previewSet,
            "ROLLBACK_INVERSE_OFFER",
          ),
        );
        if (preview.status !== "VALID" || hasBlockingIssues(preview)) {
          throw new Error(
            `Rollback VALIDATION_PREVIEW rejected ${entry.sku}: ${JSON.stringify(responseDetail(preview))}`,
          );
        }
        await options.checkpointStore.append({
          rollback_entry_id: entry.rollback_entry_id,
          sku: entry.sku,
          status: "PREVIEW_VALID",
          detail: {
            guard_attempt: guardAttempt,
            ...validationPreviewCheckpointDetail(previewSet),
            ...responseDetail(preview),
          },
        });
        await sleep(requestDelayMs);
        listing = await gateway.getListing(entry.store_index, entry.sku);
        productType = assertEntryIdentity(entry, listing);
        state = entryState(entry, listing);
        if (state.conflicts.length) {
          throw new Error(
            `Compare-and-swap conflict appeared after preview for ${entry.sku}: ${state.conflicts
              .map((item) => item.path)
              .join(", ")}.`,
          );
        }
        if (state.already) {
          await options.checkpointStore.append({
            rollback_entry_id: entry.rollback_entry_id,
            sku: entry.sku,
            status: "ALREADY_ROLLED_BACK",
            detail: { after_preview: true },
          });
          result.already_rolled_back_entries++;
          patches = [];
          break;
        }
        if (sha256(stableJson(state.patches)) === sha256(stableJson(patches))) {
          guarded = true;
          patches = state.patches;
          guardedPreviewSet = previewSet;
          break;
        }
        patches = state.patches;
      }
      if (patches.length === 0) continue;
      if (!guarded) {
        throw new Error(`Rollback paths changed during two previews for ${entry.sku}.`);
      }
      if (
        !guardedPreviewSet ||
        sha256(stableJson(guardedPreviewSet.actual_patches)) !==
          sha256(stableJson(patches))
      ) {
        throw new Error(
          `Rollback preview evidence is not bound to the actual inverse merge for ${entry.sku}.`,
        );
      }
      await sleep(requestDelayMs);
      // VALIDATION_PREVIEW is not an optimistic lock. Re-read immediately
      // before the mutating PATCH and require the exact previewed inverse
      // payload to remain valid.
      listing = await gateway.getListing(entry.store_index, entry.sku);
      productType = assertEntryIdentity(entry, listing);
      state = entryState(entry, listing);
      if (state.conflicts.length) {
        throw new Error(
          `Compare-and-swap conflict immediately before rollback write for ${entry.sku}: ${state.conflicts
            .map((item) => item.path)
            .join(", ")}.`,
        );
      }
      if (state.already) {
        await options.checkpointStore.append({
          rollback_entry_id: entry.rollback_entry_id,
          sku: entry.sku,
          status: "ALREADY_ROLLED_BACK",
          detail: { immediately_before_write: true },
        });
        result.already_rolled_back_entries++;
        continue;
      }
      if (
        sha256(stableJson(state.patches)) !== sha256(stableJson(patches))
      ) {
        throw new Error(
          `Rollback payload changed after preview for ${entry.sku}; refusing an unpreviewed PATCH.`,
        );
      }
      patches = state.patches;
      if (
        sha256(stableJson(guardedPreviewSet.actual_patches)) !==
          sha256(stableJson(patches))
      ) {
        throw new Error(
          `Rollback actual inverse merge changed after its surrogate preview for ${entry.sku}.`,
        );
      }
      const exactSettlementEvidence = rollbackSettlementEvidence(
        entry,
        listing,
        patches,
      );
      const armedCheckpoint = await options.checkpointStore.append({
        rollback_entry_id: entry.rollback_entry_id,
        sku: entry.sku,
        status: "SUBMISSION_ARMED",
        detail: {
          crash_window_guard: true,
          settlement_guard: exactSettlementEvidence,
        },
      });
      const submitted = await gateway.patchListing(
        entry.store_index,
        entry.sku,
        productType,
        patches,
        false,
      );
      if (
        !["ACCEPTED", "IN_PROGRESS"].includes(String(submitted.status ?? "")) ||
        hasBlockingIssues(submitted)
      ) {
        throw new Error(
          `Amazon did not accept rollback ${entry.sku}: ${JSON.stringify(responseDetail(submitted))}`,
        );
      }
      const submittedCheckpoint = await options.checkpointStore.append({
        rollback_entry_id: entry.rollback_entry_id,
        sku: entry.sku,
        status: "SUBMITTED",
        detail: {
          armed_event_id: armedCheckpoint.event_id,
          ...validationPreviewCheckpointDetail(guardedPreviewSet),
          settlement_guard: exactSettlementEvidence,
          ...responseDetail(submitted),
        },
      });

      await options.checkpointStore.append({
        rollback_entry_id: entry.rollback_entry_id,
        sku: entry.sku,
        status: "SETTLEMENT_PENDING",
        detail: {
          recovery: false,
          submitted_event_id: submittedCheckpoint.event_id,
          trigger: "ACCEPTED_ROLLBACK_POST_GET",
          settlement_guard: exactSettlementEvidence,
          fast_verify_attempts: verifyAttempts,
          extended_attempts: settlementAttempts,
          extended_delay_ms: settlementDelayMs,
          stable_reads_required: settlementStableReads,
        },
      });

      let verified = false;
      let lastState: ReturnType<typeof entryState> | null = null;
      let stableRolledBackReads = 0;
      let priorRolledBackDigest: string | null = null;
      for (let attempt = 1; attempt <= verifyAttempts; attempt++) {
        await sleep(attempt === 1 ? requestDelayMs : verifyDelayMs);
        const after = await gateway.getListing(entry.store_index, entry.sku);
        assertEntryIdentity(entry, after);
        lastState = entryState(entry, after);
        if (!lastState.already) {
          stableRolledBackReads = 0;
          priorRolledBackDigest = null;
          continue;
        }
        const digest = rollbackPathStateSha256(entry, after);
        stableRolledBackReads = digest === priorRolledBackDigest
          ? stableRolledBackReads + 1
          : 1;
        priorRolledBackDigest = digest;
        if (stableRolledBackReads >= settlementStableReads) {
          verified = true;
          break;
        }
      }
      if (!verified) {
        const settled = await pollRollbackSettlement({
          entry,
          gateway,
          evidence: exactSettlementEvidence,
          attempts: settlementAttempts,
          delayMs: settlementDelayMs,
          stableReads: settlementStableReads,
          sleep,
        });
        const detail = {
          recovery: false,
          submitted_event_id: submittedCheckpoint.event_id,
          settlement_guard: exactSettlementEvidence,
          fast_verify_attempts: verifyAttempts,
          extended_polling_attempts: settled.attempts,
          consecutive_stable_reads: settled.consecutive_stable_reads,
          last_path_state_sha256: settled.last_path_state_sha256,
          last_state: settled.last_state,
        };
        if (settled.state === "ROLLED_BACK") {
          verified = true;
        } else if (settled.state === "STABLE_FORWARD") {
          await options.checkpointStore.append({
            rollback_entry_id: entry.rollback_entry_id,
            sku: entry.sku,
            status: "SETTLED_FORWARD",
            detail,
          });
          throw new RollbackSettlementGuardError(
            `Rollback ${entry.sku} settled at the exact pre-write state; no second inverse PATCH was attempted.`,
          );
        } else {
          await options.checkpointStore.append({
            rollback_entry_id: entry.rollback_entry_id,
            sku: entry.sku,
            status: "SETTLEMENT_UNRESOLVED",
            detail,
          });
          result.unresolved_settlements++;
          throw new RollbackSettlementGuardError(
            `Rollback ${entry.sku} did not reach a stable exact-path state after bounded polling.`,
          );
        }
      }
      await options.checkpointStore.append({
        rollback_entry_id: entry.rollback_entry_id,
        sku: entry.sku,
        status: "VERIFIED",
        detail: {
          submitted_event_id: submittedCheckpoint.event_id,
          paths: entry.operations.map((operation) => operation.path),
        },
      });
      result.verified_entries++;
    } catch (error) {
      result.failed_entries++;
      await options.checkpointStore.append({
        rollback_entry_id: entry.rollback_entry_id,
        sku: entry.sku,
        status: "FAILED",
        detail: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (error instanceof RollbackSettlementGuardError) {
        result.stopped_early = true;
        break;
      }
      if (result.failed_entries >= maxErrors) {
        result.stopped_early = true;
        break;
      }
    }
  }
    return result;
  } finally {
    try {
      if (
        mutationFenceClaimed &&
        (await (
          options.forwardCheckpointStore as ImmutableCheckpointStore
        ).pendingSubmissions()).size === 0 &&
        (await options.checkpointStore.pendingSubmissions()).size === 0
      ) {
        await (
          options.forwardCheckpointStore as ImmutableCheckpointStore
        ).releasePendingMutationFence();
      }
    } finally {
      await releaseForwardLease?.();
    }
  }
}
