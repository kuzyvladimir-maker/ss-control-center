import { createHash } from "node:crypto";

export const POST_LIVE_RECONCILIATION_SCHEMA =
  "uncrustables-post-live-db-reconciliation/v1" as const;
export const SURGICAL_REPAIR_PLAN_SCHEMA =
  "uncrustables-surgical-repair/v2" as const;
export const SURGICAL_CHECKPOINT_SCHEMA =
  "uncrustables-surgical-checkpoint/v1" as const;

export const UNCRUSTABLES_LIVE_COUNT = 164;
export const UNCRUSTABLES_COHORT_COUNT = 167;
export const DEFAULT_FINAL_LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const TRUE_404_SKUS = [
  "CV-ASQK-4P65",
  "PV-ASZG-X763",
  "SV-AS9L-DRRH",
] as const;
export const REVIEWED_SZ_SKU = "SZ-ASPI-JFAT" as const;
export const REVIEWED_SZ_ASIN = "B0H776M5B5" as const;
export const REVIEWED_SZ_LIVE_UPC = "664554043946" as const;
export const REVIEWED_SZ_STALE_UPC = "742259000034" as const;

const CANONICAL_PRICE_CENTS_BY_COUNT = new Map([
  [24, { consumer: 7_699, floor: 6_695 }],
  [30, { consumer: 8_599, floor: 7_475 }],
  [45, { consumer: 13_099, floor: 11_427 }],
  [90, { consumer: 25_299, floor: 21_957 }],
  [120, { consumer: 29_799, floor: 25_857 }],
]);

type UnknownRecord = Record<string, unknown>;
type TemporalValue = Date | string | null;

export interface FinalLedgerRowLike {
  sku?: unknown;
  asin?: unknown;
  channel?: unknown;
  store_index?: unknown;
  canonical?: {
    total_units?: unknown;
    component_qty_sum?: unknown;
    components?: unknown;
    pricing?: {
      suggested?: unknown;
      floor?: unknown;
    } | null;
  } | null;
  db?: {
    channel_sku?: {
      id?: unknown;
      sku?: unknown;
      upc?: unknown;
      asin?: unknown;
      listing_status?: unknown;
      lifecycle_status?: unknown;
      published_at?: unknown;
      live_at?: unknown;
    } | null;
    master?: {
      id?: unknown;
      lifecycle_status?: unknown;
      pack_count?: unknown;
    } | null;
    draft?: {
      id?: unknown;
      generation_job_id?: unknown;
      status?: unknown;
      pack_count?: unknown;
      components?: unknown;
      selected_variant?: {
        composition?: unknown;
      } | null;
    } | null;
  };
  live?: {
    fetched?: unknown;
    error?: unknown;
    asin?: unknown;
    amazon_statuses?: unknown;
    buyable?: unknown;
    discoverable?: unknown;
    issues?: unknown;
    title?: unknown;
    unit_count?: unknown;
    number_of_items?: unknown;
    consumer_offer?: {
      our_price?: unknown;
      discounted_price?: unknown;
      minimum_seller_allowed_price?: unknown;
      maximum_seller_allowed_price?: unknown;
    } | null;
    business_offers?: unknown;
    separate_business_price?: unknown;
    raw_attributes?: unknown;
  } | null;
  anomalies?: unknown;
}

export interface FinalLiveLedgerLike {
  schema_version?: unknown;
  audit_id?: unknown;
  mode?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  complete?: unknown;
  immutable?: unknown;
  external_mutations?: unknown;
  summary?: unknown;
  rows?: unknown;
}

export interface RepairActionLike {
  action_id?: unknown;
  kind?: unknown;
  desired?: { kind?: unknown } | null;
}

export interface SurgicalRepairPlanLike {
  schema_version?: unknown;
  immutable?: unknown;
  plan_id?: unknown;
  created_at?: unknown;
  sha256?: unknown;
  source_ledger?: unknown;
  media_asset_source?: unknown;
  structured_attribute_source?: unknown;
  policy?: unknown;
  scope?: unknown;
  semantic_audit?: unknown;
  entries?: unknown;
  blockers?: unknown;
}

export interface SurgicalCheckpointEventLike {
  schema_version?: unknown;
  immutable?: unknown;
  event_id?: unknown;
  created_at?: unknown;
  plan_sha256?: unknown;
  action_id?: unknown;
  sku?: unknown;
  kind?: unknown;
  status?: unknown;
  detail?: unknown;
  sha256?: unknown;
}

export interface CheckpointArtifact {
  name: string;
  file_sha256: string;
  event: SurgicalCheckpointEventLike;
}

export type ChannelSkuDbRow = UnknownRecord & {
  id: string;
  updated_at: TemporalValue;
  master_bundle_id: string;
  channel: string;
  sku: string;
  upc: string;
  upc_pool_id: string | null;
  asin: string | null;
  walmart_item_id: string | null;
  ebay_item_id: string | null;
  tiktok_product_id: string | null;
  lifecycle_status: string;
  listing_status: string;
  submitted_at: TemporalValue;
  processing_at: TemporalValue;
  live_at: TemporalValue;
  published_at: TemporalValue;
  last_status_check_at: TemporalValue;
  compliance_status: string;
  validation_status: string;
  available_quantity: number | null;
  inventory_checked_at: TemporalValue;
  price_cents: number;
  business_price_cents: number | null;
  attributes: string;
};

export type MasterBundleDbRow = UnknownRecord & {
  id: string;
  updated_at: TemporalValue;
  lifecycle_status: string;
  pack_count: number;
};

export type BundleDraftDbRow = UnknownRecord & {
  id: string;
  updated_at: TemporalValue;
  generation_job_id: string;
  master_bundle_id: string | null;
  status: string;
  published_at: TemporalValue;
  pack_count: number;
  draft_components: string;
};

export type GenerationJobDbRow = UnknownRecord & {
  id: string;
  updated_at: TemporalValue;
  bundles_published: number;
};

export type BundleComponentDbRow = UnknownRecord & {
  id: string;
  updated_at: TemporalValue;
  master_bundle_id: string;
  product_name: string;
  qty: number;
};

export type UpcPoolDbRow = UnknownRecord & {
  id: string;
  updated_at: TemporalValue;
  upc: string;
  status: string;
  assigned_to_id: string | null;
  reserved_for_id: string | null;
  reserved_at: TemporalValue;
  reserved_until: TemporalValue;
  notes: string | null;
};

/** All scalar columns must be supplied by the DB adapter. This deliberately
 * makes the optimistic digest protect fields that reconciliation never edits. */
export interface PostLiveDbSnapshot {
  channel_skus: ChannelSkuDbRow[];
  master_bundles: MasterBundleDbRow[];
  bundle_drafts: BundleDraftDbRow[];
  generation_jobs: GenerationJobDbRow[];
  bundle_components: BundleComponentDbRow[];
  upc_pool_rows: UpcPoolDbRow[];
  sz_target_upc_owner: ChannelSkuDbRow | null;
}

export interface ValidatedLedgerLiveRow {
  sku: string;
  asin: string;
  channel_sku_id: string;
  master_bundle_id: string;
  draft_id: string;
  generation_job_id: string;
  buyable: boolean;
  discoverable: boolean;
  canonical_count: number;
  canonical_price_cents: number;
  canonical_floor_cents: number;
}

export interface ValidatedLedger404Row {
  sku: (typeof TRUE_404_SKUS)[number];
  channel_sku_id: string;
  master_bundle_id: string;
  draft_id: string | null;
  generation_job_id: string | null;
}

export interface ValidatedFinalLedger {
  audit_id: string;
  started_at: string;
  completed_at: string;
  live_rows: ValidatedLedgerLiveRow[];
  true_404_rows: ValidatedLedger404Row[];
  sz_evidence: {
    sku: typeof REVIEWED_SZ_SKU;
    asin: typeof REVIEWED_SZ_ASIN;
    intended_units: 24;
    live_upc: typeof REVIEWED_SZ_LIVE_UPC;
    selected_component_product_name: string;
    selected_component_qty: 24;
  };
}

export interface ValidatedRepairPlan {
  plan_id: string;
  sha256: string;
  created_at: string;
  action_count: number;
  action_ids: string[];
  action_by_id: Map<string, { sku: string; kind: string }>;
}

export interface ValidatedCheckpointSet {
  files_sha256: string;
  event_count: number;
  terminal_action_count: number;
  latest_terminal_at: string;
}

export interface ReconciliationEntry {
  sku: string;
  asin: string;
  channel_sku_id: string;
  master_bundle_id: string;
  bundle_draft_id: string;
  generation_job_id: string;
  evidence: {
    ledger_audit_id: string;
    observed_live_at: string;
    buyable: boolean;
    discoverable: boolean;
  };
  desired: {
    channel_lifecycle_status: "LIVE";
    channel_listing_status: "LIVE";
    channel_live_at: string;
    channel_published_at: string;
    master_lifecycle_status: "LIVE";
    draft_status: "PUBLISHED";
    draft_published_at: string;
    channel_price_cents: number;
    channel_business_price_cents: number;
    channel_attributes: string;
    channel_attributes_sha256: string;
  };
  changes: string[];
}

export interface True404PreservationEntry {
  sku: (typeof TRUE_404_SKUS)[number];
  channel_sku_id: string;
  master_bundle_id: string;
  bundle_draft_id: string | null;
  row_snapshot_sha256: string;
  preserved_state: {
    asin: null;
    channel_lifecycle_status: string;
    channel_listing_status: string;
    master_lifecycle_status: string;
    draft_status: string | null;
  };
}

export interface GenerationJobReconciliation {
  generation_job_id: string;
  current_bundles_published: number;
  desired_bundles_published: number;
  basis: "COUNT_DRAFTS_WITH_PUBLISHED_AT";
  change_required: boolean;
}

export interface ReviewedSzReconciliation {
  sku: typeof REVIEWED_SZ_SKU;
  asin: typeof REVIEWED_SZ_ASIN;
  evidence: {
    intended_units: 24;
    live_upc: typeof REVIEWED_SZ_LIVE_UPC;
    stale_db_upc: typeof REVIEWED_SZ_STALE_UPC;
    selected_component_product_name: string;
    selected_component_qty: 24;
  };
  recipe_guard: {
    master_pack_count: 24;
    draft_pack_count: 24;
    draft_components_sha256: string;
    master_components_sha256: string;
  };
  upc_reconciliation: {
    channel_sku_id: string;
    current_upc: string;
    desired_upc: typeof REVIEWED_SZ_LIVE_UPC;
    current_upc_pool_id: string | null;
    desired_upc_pool_id: string;
    target_pool_row_id: string;
    desired_target_status: "ASSIGNED";
    desired_target_assigned_to_id: string;
    target_change_required: boolean;
    desired_release_status: "BURNED";
    release_pool_rows: Array<{
      id: string;
      upc: string;
      desired_note: string;
      change_required: boolean;
    }>;
    change_required: boolean;
  };
}

export interface PostLiveReconciliationPlan {
  schema_version: typeof POST_LIVE_RECONCILIATION_SCHEMA;
  immutable: true;
  plan_id: string;
  created_at: string;
  sources: {
    final_live_ledger: {
      path: string;
      file_sha256: string;
      schema_version: string;
      audit_id: string;
      started_at: string;
      completed_at: string;
      max_age_ms: number;
    };
    surgical_repair_plan: {
      path: string;
      file_sha256: string;
      plan_id: string;
      plan_sha256: string;
      actions: number;
    };
    verified_checkpoints: {
      root_dir: string;
      files_sha256: string;
      events: number;
      terminal_actions: number;
      latest_terminal_at: string;
    };
  };
  policy: {
    database_only: true;
    amazon_mutation: false;
    exact_live_rows: 164;
    exact_true_404_rows: 3;
    preserve_marketplace_ids_except_reviewed_sz_upc: true;
    reviewed_sz_upc_reconciliation: true;
    canonical_price_reconciliation: true;
    internal_list_discount_cleanup: true;
    preserve_existing_timestamps: true;
    timestamp_fill_requires_observation: true;
    approval_mutation: false;
    compliance_mutation: false;
    validation_mutation: false;
    inventory_mutation: false;
    true_404_mutation: false;
    bundles_published_basis: "COUNT_DRAFTS_WITH_PUBLISHED_AT";
  };
  scope: {
    cohort_rows: 167;
    live_rows: 164;
    true_404_skus: string[];
    channel_sku_ids: string[];
    master_bundle_ids: string[];
    cohort_bundle_draft_ids: string[];
    guarded_job_bundle_draft_ids: string[];
    generation_job_ids: string[];
    bundle_component_ids: string[];
    upc_pool_row_ids: string[];
  };
  db_snapshot: {
    sha256: string;
    channel_skus: number;
    master_bundles: number;
    bundle_drafts: number;
    generation_jobs: number;
    bundle_components: number;
    upc_pool_rows: number;
  };
  reconciliations: ReconciliationEntry[];
  true_404_preservation: True404PreservationEntry[];
  generation_jobs: GenerationJobReconciliation[];
  reviewed_sz: ReviewedSzReconciliation;
  change_summary: {
    channel_skus: number;
    master_bundles: number;
    bundle_drafts: number;
    generation_jobs: number;
    upc_pool_rows: number;
    total_rows: number;
  };
  sha256: string;
}

export interface BuildPostLiveReconciliationPlanInput {
  ledger: FinalLiveLedgerLike;
  ledger_path: string;
  ledger_file_sha256: string;
  repair_plan: SurgicalRepairPlanLike;
  repair_plan_path: string;
  repair_plan_file_sha256: string;
  checkpoint_root_dir: string;
  checkpoint_artifacts: CheckpointArtifact[];
  db_snapshot: PostLiveDbSnapshot;
  now?: Date;
  max_ledger_age_ms?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredIso(label: string, value: unknown): string {
  const string = requiredString(label, value);
  if (!Number.isFinite(Date.parse(string))) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return new Date(string).toISOString();
}

function optionalIso(label: string, value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label} is invalid.`);
    return value.toISOString();
  }
  return requiredIso(label, value);
}

function assertSha256(label: string, value: unknown): string {
  const digest = requiredString(label, value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return digest;
}

function asArray(label: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function sortedUnique(label: string, values: string[]): string[] {
  const sorted = [...values].sort();
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] === sorted[index - 1]) {
      throw new Error(`Duplicate ${label}: ${sorted[index]}.`);
    }
  }
  return sorted;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

/** Recursively stable JSON used by every immutable digest in this workflow. */
export function postLiveStableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => postLiveStableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${postLiveStableJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Undefined cannot be hashed as a value.");
  return encoded;
}

export function postLiveSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sealedObjectDigest(value: UnknownRecord): string {
  const body = { ...value };
  delete body.sha256;
  return postLiveSha256(postLiveStableJson(body));
}

function normalizedSnapshot(snapshot: PostLiveDbSnapshot): PostLiveDbSnapshot {
  return {
    channel_skus: [...snapshot.channel_skus].sort((a, b) => a.id.localeCompare(b.id)),
    master_bundles: [...snapshot.master_bundles].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    bundle_drafts: [...snapshot.bundle_drafts].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    generation_jobs: [...snapshot.generation_jobs].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    bundle_components: [...snapshot.bundle_components].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    upc_pool_rows: [...snapshot.upc_pool_rows].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    sz_target_upc_owner: snapshot.sz_target_upc_owner,
  };
}

/** Full scalar-row digest. Relation ordering cannot change the result. */
export function postLiveDbSnapshotDigest(snapshot: PostLiveDbSnapshot): string {
  return postLiveSha256(postLiveStableJson(normalizedSnapshot(snapshot)));
}

function jsonObject(label: string, value: string): UnknownRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

/** Remove only unsupported cached sale/reference-price fields. Unrelated rich
 * attributes, quantity discounts, inventory, and nutritional facts remain byte
 * for byte when no cleanup is needed. */
export function sanitizePostLiveCachedAttributes(
  sku: string,
  current: string,
): { value: string; changed: boolean } {
  const attributes = jsonObject(`${sku} ChannelSKU.attributes`, current);
  let changed = false;
  for (const key of ["list_price", "discounted_price"]) {
    if (key in attributes) {
      delete attributes[key];
      changed = true;
    }
  }
  if (Array.isArray(attributes.purchasable_offer)) {
    attributes.purchasable_offer = attributes.purchasable_offer.map((offer) => {
      if (!isRecord(offer)) return offer;
      const clean = { ...offer };
      for (const key of ["list_price", "discounted_price"]) {
        if (key in clean) {
          delete clean[key];
          changed = true;
        }
      }
      return clean;
    });
  }
  return { value: changed ? JSON.stringify(attributes) : current, changed };
}

function parsedJsonArray(label: string, value: string): UnknownRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.some((row) => !isRecord(row))) {
    throw new Error(`${label} must be a JSON object array.`);
  }
  return parsed as UnknownRecord[];
}

function amazonErrorIssueCount(issues: unknown): number {
  if (!Array.isArray(issues)) return -1;
  return issues.filter(
    (issue) =>
      isRecord(issue) && String(issue.severity ?? "").toUpperCase() === "ERROR",
  ).length;
}

function assertSummaryCount(summary: unknown, key: string, expected: number): void {
  if (!isRecord(summary) || summary[key] !== expected) {
    throw new Error(`Final ledger summary.${key} must equal ${expected}.`);
  }
}

function dollarsToCents(label: string, value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive dollar amount.`);
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(cents / 100 - amount) > 0.00001) {
    throw new Error(`${label} has more than two decimal places.`);
  }
  return cents;
}

function hasLegacyPriceAttribute(rawAttributes: unknown): boolean {
  if (!isRecord(rawAttributes)) return true;
  if ("list_price" in rawAttributes || "discounted_price" in rawAttributes) return true;
  const offers = rawAttributes.purchasable_offer;
  return (
    Array.isArray(offers) &&
    offers.some(
      (offer) =>
        isRecord(offer) &&
        ("list_price" in offer || "discounted_price" in offer),
    )
  );
}

function componentQuantitySum(value: unknown): number | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  let sum = 0;
  for (const component of value) {
    if (!isRecord(component)) return null;
    const qty = Number(component.qty);
    if (!Number.isInteger(qty) || qty <= 0) return null;
    sum += qty;
  }
  return sum;
}

export function validateFinalLiveLedger(
  ledger: FinalLiveLedgerLike,
  options: { now?: Date; max_age_ms?: number } = {},
): ValidatedFinalLedger {
  if (
    ledger.schema_version !== "uncrustables-ledger/v1.1" ||
    ledger.mode !== "live" ||
    ledger.complete !== true ||
    ledger.immutable !== true ||
    ledger.external_mutations !== false
  ) {
    throw new Error(
      "Post-live reconciliation requires a complete immutable mutation-free v1.1 live ledger.",
    );
  }
  const auditId = requiredString("Final ledger audit_id", ledger.audit_id);
  const startedAt = requiredIso("Final ledger started_at", ledger.started_at);
  const completedAt = requiredIso("Final ledger completed_at", ledger.completed_at);
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error("Final ledger completed_at precedes started_at.");
  }
  const now = options.now ?? new Date();
  const maxAge = options.max_age_ms ?? DEFAULT_FINAL_LEDGER_MAX_AGE_MS;
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error("Final ledger maximum age must be positive.");
  }
  const age = now.getTime() - Date.parse(completedAt);
  if (age < -5 * 60 * 1000 || age > maxAge) {
    throw new Error(
      `Final live ledger is not fresh (age ${Math.round(age / 1000)}s, max ${Math.round(maxAge / 1000)}s).`,
    );
  }

  const rawRows = asArray("Final ledger rows", ledger.rows);
  if (rawRows.length !== UNCRUSTABLES_COHORT_COUNT) {
    throw new Error(
      `Final ledger must contain exactly ${UNCRUSTABLES_COHORT_COUNT} rows; got ${rawRows.length}.`,
    );
  }
  assertSummaryCount(ledger.summary, "rows", UNCRUSTABLES_COHORT_COUNT);
  assertSummaryCount(ledger.summary, "live_fetch_succeeded", UNCRUSTABLES_LIVE_COUNT);
  assertSummaryCount(ledger.summary, "live_fetch_failed", TRUE_404_SKUS.length);

  const liveRows: ValidatedLedgerLiveRow[] = [];
  const missingRows: ValidatedLedger404Row[] = [];
  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  const seenChannelIds = new Set<string>();
  const seenMasterIds = new Set<string>();
  const seenLiveDraftIds = new Set<string>();
  let szEvidence: ValidatedFinalLedger["sz_evidence"] | null = null;

  for (const [index, raw] of rawRows.entries()) {
    if (!isRecord(raw)) throw new Error(`Final ledger row ${index} is malformed.`);
    const row = raw as FinalLedgerRowLike;
    const sku = requiredString(`Final ledger row ${index} SKU`, row.sku);
    if (seenSkus.has(sku)) throw new Error(`Duplicate final ledger SKU: ${sku}.`);
    seenSkus.add(sku);
    if (row.channel !== "AMAZON_SALUTEM" || row.store_index !== 1) {
      throw new Error(`${sku}: unexpected channel/store scope.`);
    }
    const dbSku = row.db?.channel_sku;
    const dbMaster = row.db?.master;
    if (!dbSku || !dbMaster) throw new Error(`${sku}: incomplete DB identity snapshot.`);
    const channelSkuId = requiredString(`${sku} ChannelSKU id`, dbSku.id);
    const masterId = requiredString(`${sku} MasterBundle id`, dbMaster.id);
    if (dbSku.sku !== sku) throw new Error(`${sku}: DB SKU identity drift.`);
    if (seenChannelIds.has(channelSkuId)) {
      throw new Error(`Duplicate final ledger ChannelSKU id: ${channelSkuId}.`);
    }
    if (seenMasterIds.has(masterId)) {
      throw new Error(`Duplicate final ledger MasterBundle id: ${masterId}.`);
    }
    seenChannelIds.add(channelSkuId);
    seenMasterIds.add(masterId);

    const live = row.live;
    if (!live) throw new Error(`${sku}: missing live result.`);
    if (live.fetched === true) {
      const asin = requiredString(`${sku} live ASIN`, live.asin);
      if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`${sku}: malformed ASIN ${asin}.`);
      if (row.asin !== asin || dbSku.asin !== asin || live.error != null) {
        throw new Error(`${sku}: ledger/live/DB ASIN identity mismatch.`);
      }
      if (seenAsins.has(asin)) throw new Error(`Duplicate final ledger ASIN: ${asin}.`);
      seenAsins.add(asin);
      const statuses = asArray(`${sku} amazon_statuses`, live.amazon_statuses).map(String);
      const buyable = live.buyable === true;
      const discoverable = live.discoverable === true;
      if (
        buyable !== statuses.includes("BUYABLE") ||
        discoverable !== statuses.includes("DISCOVERABLE")
      ) {
        throw new Error(`${sku}: Amazon status booleans disagree with amazon_statuses.`);
      }
      if (!buyable && !discoverable) {
        throw new Error(`${sku}: fetched listing has no authoritative live status.`);
      }
      const errorCount = amazonErrorIssueCount(live.issues);
      if (errorCount < 0) throw new Error(`${sku}: live issues are missing.`);
      if (errorCount > 0) {
        throw new Error(`${sku}: final live ledger still has ${errorCount} Amazon ERROR issue(s).`);
      }
      const canonicalCount = Number(row.canonical?.total_units);
      const canonicalBand = CANONICAL_PRICE_CENTS_BY_COUNT.get(canonicalCount);
      if (
        !Number.isInteger(canonicalCount) ||
        !canonicalBand ||
        Number(row.canonical?.component_qty_sum) !== canonicalCount ||
        dollarsToCents(`${sku} canonical suggested`, row.canonical?.pricing?.suggested) !==
          canonicalBand.consumer ||
        dollarsToCents(`${sku} canonical floor`, row.canonical?.pricing?.floor) !==
          canonicalBand.floor
      ) {
        throw new Error(`${sku}: final canonical count/price band is not reviewed.`);
      }
      const consumerOffer = live.consumer_offer;
      if (
        !consumerOffer ||
        dollarsToCents(`${sku} live consumer price`, consumerOffer.our_price) !==
          canonicalBand.consumer ||
        consumerOffer.discounted_price != null ||
        dollarsToCents(
          `${sku} live minimum seller price`,
          consumerOffer.minimum_seller_allowed_price,
        ) !== canonicalBand.floor ||
        dollarsToCents(
          `${sku} live maximum seller price`,
          consumerOffer.maximum_seller_allowed_price,
        ) !== canonicalBand.consumer ||
        hasLegacyPriceAttribute(live.raw_attributes)
      ) {
        throw new Error(`${sku}: final live consumer offer/list-price state is not canonical.`);
      }
      const businessOffers = asArray(`${sku} business_offers`, live.business_offers);
      const businessPrices = businessOffers
        .filter(isRecord)
        .map((offer) => offer.our_price)
        .filter((value) => value != null)
        .map((value) => dollarsToCents(`${sku} live business price`, value));
      const separateBusiness =
        live.separate_business_price == null
          ? null
          : dollarsToCents(`${sku} separate business price`, live.separate_business_price);
      if (
        !businessPrices.includes(canonicalBand.consumer) &&
        separateBusiness !== canonicalBand.consumer
      ) {
        throw new Error(`${sku}: final live B2B base price does not equal consumer price.`);
      }
      if (businessPrices.some((price) => price !== canonicalBand.consumer)) {
        throw new Error(`${sku}: final live listing retains a conflicting B2B price.`);
      }
      const draft = row.db?.draft;
      if (!draft) throw new Error(`${sku}: live listing has no BundleDraft identity.`);
      const draftId = requiredString(`${sku} BundleDraft id`, draft.id);
      const jobId = requiredString(`${sku} GenerationJob id`, draft.generation_job_id);
      if (seenLiveDraftIds.has(draftId)) {
        throw new Error(`Duplicate live BundleDraft id: ${draftId}.`);
      }
      seenLiveDraftIds.add(draftId);
      if (sku === REVIEWED_SZ_SKU) {
        const selected = draft.selected_variant?.composition;
        if (
          asin !== REVIEWED_SZ_ASIN ||
          canonicalCount !== 24 ||
          row.db?.master?.pack_count !== 24 ||
          draft.pack_count !== 24 ||
          componentQuantitySum(selected) !== 24 ||
          live.unit_count !== 24 ||
          live.number_of_items !== 24 ||
          typeof live.title !== "string" ||
          !/\b24\s*(?:count|ct)\b/i.test(live.title)
        ) {
          throw new Error(
            `${REVIEWED_SZ_SKU}: reviewed 24-count draft/selected-variant/live identity is incomplete.`,
          );
        }
        const selectedRows = selected as UnknownRecord[];
        if (selectedRows.length !== 1 || Number(selectedRows[0].qty) !== 24) {
          throw new Error(`${REVIEWED_SZ_SKU}: selected recipe must have one 24-unit component.`);
        }
        const selectedProductName = requiredString(
          `${REVIEWED_SZ_SKU} selected product name`,
          selectedRows[0].product_name,
        );
        const rawAttributes = live.raw_attributes;
        if (!isRecord(rawAttributes)) {
          throw new Error(`${REVIEWED_SZ_SKU}: missing live UPC attributes.`);
        }
        const liveUpcs = asArray(
          `${REVIEWED_SZ_SKU} external identifiers`,
          rawAttributes.externally_assigned_product_identifier,
        )
          .filter(isRecord)
          .filter((identifier) => String(identifier.type).toLowerCase() === "upc")
          .map((identifier) => String(identifier.value));
        if (
          liveUpcs.length !== 1 ||
          liveUpcs[0] !== REVIEWED_SZ_LIVE_UPC
        ) {
          throw new Error(`${REVIEWED_SZ_SKU}: live UPC evidence is not exact.`);
        }
        szEvidence = {
          sku: REVIEWED_SZ_SKU,
          asin: REVIEWED_SZ_ASIN,
          intended_units: 24,
          live_upc: REVIEWED_SZ_LIVE_UPC,
          selected_component_product_name: selectedProductName,
          selected_component_qty: 24,
        };
      }
      liveRows.push({
        sku,
        asin,
        channel_sku_id: channelSkuId,
        master_bundle_id: masterId,
        draft_id: draftId,
        generation_job_id: jobId,
        buyable,
        discoverable,
        canonical_count: canonicalCount,
        canonical_price_cents: canonicalBand.consumer,
        canonical_floor_cents: canonicalBand.floor,
      });
      continue;
    }

    if (!TRUE_404_SKUS.includes(sku as (typeof TRUE_404_SKUS)[number])) {
      throw new Error(`${sku}: unexpected failed live fetch.`);
    }
    const error = requiredString(`${sku} 404 error`, live.error);
    if (
      !/\b404\b/.test(error) ||
      !/NOT_FOUND/i.test(error) ||
      !error.includes(sku) ||
      row.asin != null ||
      dbSku.asin != null ||
      live.asin != null
    ) {
      throw new Error(`${sku}: failed fetch is not the exact ASIN-less NOT_FOUND/404 state.`);
    }
    const anomalies = asArray(`${sku} anomalies`, row.anomalies);
    if (
      !anomalies.some(
        (anomaly) => isRecord(anomaly) && anomaly.code === "AMAZON_LISTING_NOT_FOUND",
      )
    ) {
      throw new Error(`${sku}: missing AMAZON_LISTING_NOT_FOUND audit evidence.`);
    }
    missingRows.push({
      sku: sku as (typeof TRUE_404_SKUS)[number],
      channel_sku_id: channelSkuId,
      master_bundle_id: masterId,
      draft_id: row.db?.draft ? requiredString(`${sku} BundleDraft id`, row.db.draft.id) : null,
      generation_job_id: row.db?.draft
        ? requiredString(`${sku} GenerationJob id`, row.db.draft.generation_job_id)
        : null,
    });
  }

  if (liveRows.length !== UNCRUSTABLES_LIVE_COUNT) {
    throw new Error(`Expected exactly ${UNCRUSTABLES_LIVE_COUNT} fetched live rows.`);
  }
  if (!sameStringSet(missingRows.map((row) => row.sku), [...TRUE_404_SKUS])) {
    throw new Error("Final ledger does not contain the exact reviewed true-404 SKU set.");
  }
  if (!szEvidence) throw new Error("Final ledger is missing reviewed SZ evidence.");
  return {
    audit_id: auditId,
    started_at: startedAt,
    completed_at: completedAt,
    live_rows: liveRows.sort((a, b) => a.sku.localeCompare(b.sku)),
    true_404_rows: missingRows.sort((a, b) => a.sku.localeCompare(b.sku)),
    sz_evidence: szEvidence,
  };
}

function repairPlanRecord(plan: SurgicalRepairPlanLike): UnknownRecord {
  if (!isRecord(plan)) throw new Error("Surgical repair plan is malformed.");
  return plan as UnknownRecord;
}

export function validateSurgicalRepairEvidence(
  plan: SurgicalRepairPlanLike,
  ledger: ValidatedFinalLedger,
): ValidatedRepairPlan {
  const record = repairPlanRecord(plan);
  if (plan.schema_version !== SURGICAL_REPAIR_PLAN_SCHEMA || plan.immutable !== true) {
    throw new Error("Expected an immutable surgical repair v2 plan.");
  }
  const claimed = assertSha256("Surgical repair plan sha256", plan.sha256);
  if (sealedObjectDigest(record) !== claimed) {
    throw new Error("Surgical repair plan SHA-256 mismatch.");
  }
  const planId = requiredString("Surgical repair plan id", plan.plan_id);
  const createdAt = requiredIso("Surgical repair plan created_at", plan.created_at);
  const entries = asArray("Surgical repair plan entries", plan.entries);
  const blockers = asArray("Surgical repair plan blockers", plan.blockers);
  if (blockers.length !== 0) throw new Error("Surgical repair plan still has blockers.");
  if (entries.length !== UNCRUSTABLES_LIVE_COUNT) {
    throw new Error(`Surgical repair plan must contain exactly ${UNCRUSTABLES_LIVE_COUNT} entries.`);
  }
  const scope = plan.scope;
  if (
    !isRecord(scope) ||
    scope.requested_skus !== null ||
    scope.limit !== null ||
    scope.ledger_rows_considered !== UNCRUSTABLES_COHORT_COUNT ||
    scope.entries !== UNCRUSTABLES_LIVE_COUNT ||
    scope.blocked !== 0
  ) {
    throw new Error("Surgical repair plan is not an unfiltered, blocker-free full-cohort plan.");
  }
  const semantic = plan.semantic_audit;
  if (!isRecord(semantic) || semantic.blocked !== 0) {
    throw new Error("Surgical repair semantic audit still has blocked rows.");
  }
  const media = plan.media_asset_source;
  if (
    !isRecord(media) ||
    media.rows !== UNCRUSTABLES_LIVE_COUNT ||
    media.qa_verified !== true
  ) {
    throw new Error("Surgical repair plan lacks a complete 164-row QA media source.");
  }
  if (!isRecord(plan.structured_attribute_source)) {
    throw new Error("Surgical repair plan lacks sealed structured-attribute sources.");
  }
  const policy = plan.policy;
  if (
    !isRecord(policy) ||
    policy.patch_only !== true ||
    policy.validation_preview_required !== true ||
    policy.post_get_verification_required !== true ||
    policy.shelf_life_mutation !== false ||
    policy.inventory_mutation !== false ||
    policy.nutrition_mutation !== false
  ) {
    throw new Error("Surgical repair plan safety policy is incomplete or weakened.");
  }

  const expectedBySku = new Map(ledger.live_rows.map((row) => [row.sku, row]));
  const seenSkus = new Set<string>();
  const actionIds: string[] = [];
  const actionById = new Map<string, { sku: string; kind: string }>();
  for (const [index, rawEntry] of entries.entries()) {
    if (!isRecord(rawEntry)) throw new Error(`Repair entry ${index} is malformed.`);
    const sku = requiredString(`Repair entry ${index} SKU`, rawEntry.sku);
    const asin = requiredString(`${sku} repair ASIN`, rawEntry.asin);
    if (seenSkus.has(sku)) throw new Error(`Duplicate repair entry SKU: ${sku}.`);
    seenSkus.add(sku);
    const expected = expectedBySku.get(sku);
    if (!expected || expected.asin !== asin || rawEntry.store_index !== 1) {
      throw new Error(`${sku}: repair plan scope/ASIN does not match the final live ledger.`);
    }
    const actions = asArray(`${sku} repair actions`, rawEntry.actions);
    if (actions.length === 0) throw new Error(`${sku}: repair entry has no actions.`);
    const kinds = new Set<string>();
    for (const rawAction of actions) {
      if (!isRecord(rawAction)) throw new Error(`${sku}: malformed repair action.`);
      const action = rawAction as RepairActionLike;
      const actionId = requiredString(`${sku} repair action id`, action.action_id);
      const kind = requiredString(`${sku} repair action kind`, action.kind);
      if (action.desired?.kind !== kind) throw new Error(`${actionId}: action kind mismatch.`);
      if (actionById.has(actionId)) throw new Error(`Duplicate repair action id: ${actionId}.`);
      if (kinds.has(kind)) throw new Error(`${sku}: duplicate ${kind} repair action.`);
      actionIds.push(actionId);
      actionById.set(actionId, { sku, kind });
      kinds.add(kind);
    }
    for (const requiredKind of ["MEDIA", "OFFER", "STRUCTURED_ATTRIBUTES"]) {
      if (!kinds.has(requiredKind)) {
        throw new Error(`${sku}: full repair plan is missing ${requiredKind}.`);
      }
    }
  }
  if (!sameStringSet([...seenSkus], ledger.live_rows.map((row) => row.sku))) {
    throw new Error("Repair plan SKU set differs from the final live cohort.");
  }
  if (scope.actions !== actionIds.length) {
    throw new Error("Repair plan action count does not match its entries.");
  }
  return {
    plan_id: planId,
    sha256: claimed,
    created_at: createdAt,
    action_count: actionIds.length,
    action_ids: actionIds.sort(),
    action_by_id: actionById,
  };
}

export function validateCompleteCheckpoints(
  artifacts: CheckpointArtifact[],
  repair: ValidatedRepairPlan,
): ValidatedCheckpointSet {
  if (artifacts.length === 0) throw new Error("No surgical checkpoint files were supplied.");
  const names = new Set<string>();
  const eventIds = new Set<string>();
  const byAction = new Map<
    string,
    Array<{ created_at: string; event_id: string; status: string }>
  >();
  for (const [index, artifact] of artifacts.entries()) {
    const name = requiredString(`Checkpoint file ${index} name`, artifact.name);
    if (names.has(name)) throw new Error(`Duplicate checkpoint filename: ${name}.`);
    names.add(name);
    assertSha256(`${name} file SHA-256`, artifact.file_sha256);
    const event = artifact.event;
    if (!isRecord(event)) throw new Error(`${name}: malformed checkpoint event.`);
    if (
      event.schema_version !== SURGICAL_CHECKPOINT_SCHEMA ||
      event.immutable !== true ||
      event.plan_sha256 !== repair.sha256
    ) {
      throw new Error(`${name}: checkpoint does not belong to the sealed repair plan.`);
    }
    const claimed = assertSha256(`${name} event SHA-256`, event.sha256);
    if (sealedObjectDigest(event as UnknownRecord) !== claimed) {
      throw new Error(`${name}: checkpoint event SHA-256 mismatch.`);
    }
    const eventId = requiredString(`${name} event_id`, event.event_id);
    if (eventIds.has(eventId)) throw new Error(`Duplicate checkpoint event_id: ${eventId}.`);
    eventIds.add(eventId);
    const createdAt = requiredIso(`${name} created_at`, event.created_at);
    if (Date.parse(createdAt) < Date.parse(repair.created_at)) {
      throw new Error(`${name}: checkpoint predates its repair plan.`);
    }
    const actionId = requiredString(`${name} action_id`, event.action_id);
    const expected = repair.action_by_id.get(actionId);
    if (!expected) throw new Error(`${name}: unexpected repair action ${actionId}.`);
    if (event.sku !== expected.sku || event.kind !== expected.kind) {
      throw new Error(`${name}: checkpoint SKU/kind identity mismatch.`);
    }
    const status = requiredString(`${name} status`, event.status);
    if (
      ![
        "PREVIEW_VALID",
        "SUBMITTED",
        "VERIFIED",
        "ALREADY_APPLIED",
        "FAILED",
      ].includes(status) ||
      !isRecord(event.detail)
    ) {
      throw new Error(`${name}: unsupported checkpoint status/detail.`);
    }
    const list = byAction.get(actionId) ?? [];
    list.push({ created_at: createdAt, event_id: eventId, status });
    byAction.set(actionId, list);
  }

  const terminalTimes: string[] = [];
  for (const actionId of repair.action_ids) {
    const events = byAction.get(actionId);
    if (!events?.length) throw new Error(`Missing checkpoints for repair action ${actionId}.`);
    events.sort((a, b) => {
      const time = Date.parse(a.created_at) - Date.parse(b.created_at);
      return time || a.event_id.localeCompare(b.event_id);
    });
    for (let index = 1; index < events.length; index++) {
      if (events[index].created_at === events[index - 1].created_at) {
        throw new Error(`${actionId}: ambiguous checkpoints share one created_at timestamp.`);
      }
    }
    const latest = events.at(-1) as (typeof events)[number];
    if (!(["VERIFIED", "ALREADY_APPLIED"] as string[]).includes(latest.status)) {
      throw new Error(`${actionId}: latest checkpoint is ${latest.status}, not verified.`);
    }
    terminalTimes.push(latest.created_at);
  }
  if (byAction.size !== repair.action_count) {
    throw new Error("Checkpoint set contains an unexpected action row.");
  }
  const aggregate = artifacts
    .map((artifact) => ({
      name: artifact.name,
      file_sha256: artifact.file_sha256.toLowerCase(),
      event_sha256: String(artifact.event.sha256).toLowerCase(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    files_sha256: postLiveSha256(postLiveStableJson(aggregate)),
    event_count: artifacts.length,
    terminal_action_count: repair.action_count,
    latest_terminal_at: terminalTimes.sort().at(-1) as string,
  };
}

export function assertFinalLedgerAfterRepair(
  ledger: ValidatedFinalLedger,
  repair: ValidatedRepairPlan,
  checkpoints: ValidatedCheckpointSet,
): void {
  const started = Date.parse(ledger.started_at);
  const latestEvidence = Math.max(
    Date.parse(repair.created_at),
    Date.parse(checkpoints.latest_terminal_at),
  );
  if (started < latestEvidence) {
    throw new Error(
      "Final live ledger did not start after every repair action reached a verified terminal checkpoint.",
    );
  }
}

function validateDbRowSet<T extends { id: string }>(label: string, rows: T[]): string[] {
  return sortedUnique(
    `${label} id`,
    rows.map((row, index) => requiredString(`${label}[${index}].id`, row.id)),
  );
}

function mapById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function true404SnapshotDigest(input: {
  channel: ChannelSkuDbRow;
  master: MasterBundleDbRow;
  draft: BundleDraftDbRow | null;
}): string {
  return postLiveSha256(postLiveStableJson(input));
}

function changedFields(
  row: UnknownRecord,
  desired: Record<string, unknown>,
  prefix: string,
): string[] {
  return Object.entries(desired)
    .filter(([field, value]) => {
      const current = field.endsWith("_at")
        ? optionalIso(`${prefix}.${field}`, row[field])
        : row[field];
      return postLiveStableJson(current) !== postLiveStableJson(value);
    })
    .map(([field]) => `${prefix}.${field}`);
}

function desiredTimestamp(
  existing: unknown,
  fallbackExisting: unknown,
  observedAt: string,
  label: string,
): string {
  return optionalIso(label, existing) ?? optionalIso(`${label} fallback`, fallbackExisting) ?? observedAt;
}

export function assertDbSnapshotMatchesLedger(
  snapshot: PostLiveDbSnapshot,
  ledger: ValidatedFinalLedger,
): void {
  const channelIds = validateDbRowSet("ChannelSKU", snapshot.channel_skus);
  const masterIds = validateDbRowSet("MasterBundle", snapshot.master_bundles);
  validateDbRowSet("BundleDraft", snapshot.bundle_drafts);
  validateDbRowSet("GenerationJob", snapshot.generation_jobs);
  validateDbRowSet("BundleComponent", snapshot.bundle_components);
  validateDbRowSet("UPCPool", snapshot.upc_pool_rows);
  const ledgerRows = [...ledger.live_rows, ...ledger.true_404_rows];
  if (
    snapshot.channel_skus.length !== UNCRUSTABLES_COHORT_COUNT ||
    !sameStringSet(channelIds, ledgerRows.map((row) => row.channel_sku_id))
  ) {
    throw new Error("DB candidate ChannelSKU row set differs from the exact 167-row ledger cohort.");
  }
  if (
    snapshot.master_bundles.length !== UNCRUSTABLES_COHORT_COUNT ||
    !sameStringSet(masterIds, ledgerRows.map((row) => row.master_bundle_id))
  ) {
    throw new Error("DB MasterBundle row set differs from the exact ledger cohort.");
  }
  const channelById = mapById(snapshot.channel_skus);
  const masterById = mapById(snapshot.master_bundles);
  const draftById = mapById(snapshot.bundle_drafts);
  const jobById = mapById(snapshot.generation_jobs);
  const expectedDraftIds = ledgerRows
    .map((row) => row.draft_id)
    .filter((id): id is string => id != null);
  for (const row of ledgerRows) {
    const channel = channelById.get(row.channel_sku_id);
    if (
      !channel ||
      channel.sku !== row.sku ||
      channel.master_bundle_id !== row.master_bundle_id ||
      channel.channel !== "AMAZON_SALUTEM"
    ) {
      throw new Error(`${row.sku}: current ChannelSKU identity differs from the final ledger.`);
    }
    if ("asin" in row) {
      if (channel.asin !== row.asin) throw new Error(`${row.sku}: current ASIN drifted.`);
    } else if (channel.asin !== null) {
      throw new Error(`${row.sku}: true-404 ChannelSKU unexpectedly acquired an ASIN.`);
    } else {
      const master = snapshot.master_bundles.find(
        (candidate) => candidate.id === row.master_bundle_id,
      );
      const draft = row.draft_id ? draftById.get(row.draft_id) : null;
      if (
        channel.listing_status === "LIVE" ||
        channel.lifecycle_status === "LIVE" ||
        master?.lifecycle_status === "LIVE" ||
        draft?.status === "PUBLISHED"
      ) {
        throw new Error(`${row.sku}: true-404 DB row is not in a preserved non-live state.`);
      }
    }
    if (row.draft_id) {
      const draft = draftById.get(row.draft_id);
      if (
        !draft ||
        draft.master_bundle_id !== row.master_bundle_id ||
        draft.generation_job_id !== row.generation_job_id
      ) {
        throw new Error(`${row.sku}: BundleDraft lineage drifted.`);
      }
    }
  }
  const observedCohortDrafts = snapshot.bundle_drafts.filter(
    (draft) => draft.master_bundle_id && masterIds.includes(draft.master_bundle_id),
  );
  if (!sameStringSet(observedCohortDrafts.map((draft) => draft.id), expectedDraftIds)) {
    throw new Error("DB has a missing or unexpected BundleDraft attached to the cohort masters.");
  }
  const affectedJobs = [...new Set(ledger.live_rows.map((row) => row.generation_job_id))].sort();
  if (!sameStringSet([...jobById.keys()], affectedJobs)) {
    throw new Error("DB GenerationJob row set differs from live-draft lineage.");
  }
  for (const draft of snapshot.bundle_drafts) {
    if (!affectedJobs.includes(draft.generation_job_id)) {
      throw new Error(`Unexpected guarded BundleDraft ${draft.id} from another GenerationJob.`);
    }
  }
  for (const component of snapshot.bundle_components) {
    if (!masterIds.includes(component.master_bundle_id)) {
      throw new Error(`Unexpected BundleComponent ${component.id} outside the cohort masters.`);
    }
  }
  const poolById = mapById(snapshot.upc_pool_rows);
  const poolUpcs = sortedUnique(
    "guarded UPCPool UPC",
    snapshot.upc_pool_rows.map((row) => row.upc),
  );
  for (const channel of snapshot.channel_skus) {
    if (channel.upc_pool_id && !poolById.has(channel.upc_pool_id)) {
      throw new Error(`${channel.sku}: referenced UPCPool row is absent from the guard.`);
    }
  }
  for (const pool of snapshot.upc_pool_rows) {
    if (
      pool.assigned_to_id &&
      !snapshot.channel_skus.some((channel) => channel.id === pool.assigned_to_id)
    ) {
      throw new Error(`UPCPool ${pool.id} has an unexpected assignee outside the cohort.`);
    }
  }
  if (
    !poolUpcs.includes(REVIEWED_SZ_LIVE_UPC) ||
    !poolUpcs.includes(REVIEWED_SZ_STALE_UPC)
  ) {
    throw new Error("SZ target/stale UPCPool evidence is incomplete.");
  }
  const szLedger = ledger.live_rows.find((row) => row.sku === REVIEWED_SZ_SKU);
  const szChannel = szLedger ? channelById.get(szLedger.channel_sku_id) : null;
  const szMaster = szLedger ? masterById.get(szLedger.master_bundle_id) : null;
  const szDraft = szLedger ? draftById.get(szLedger.draft_id) : null;
  if (!szLedger || !szChannel || !szMaster || !szDraft) {
    throw new Error("SZ DB lineage is incomplete.");
  }
  if (
    szMaster.pack_count !== 24 ||
    szDraft.pack_count !== 24 ||
    ![REVIEWED_SZ_STALE_UPC, REVIEWED_SZ_LIVE_UPC].includes(
      szChannel.upc as typeof REVIEWED_SZ_STALE_UPC,
    )
  ) {
    throw new Error(
      "SZ DB recipe/UPC precondition failed: recipe backfill to 24 must run before post-live reconciliation.",
    );
  }
  const szDraftComponents = parsedJsonArray(
    `${REVIEWED_SZ_SKU} draft_components`,
    szDraft.draft_components,
  );
  const szMasterComponents = snapshot.bundle_components.filter(
    (component) => component.master_bundle_id === szMaster.id,
  );
  if (
    szDraftComponents.length !== 1 ||
    Number(szDraftComponents[0].qty) !== 24 ||
    szDraftComponents[0].product_name !==
      ledger.sz_evidence.selected_component_product_name ||
    szMasterComponents.length !== 1 ||
    szMasterComponents[0].qty !== 24 ||
    szMasterComponents[0].product_name !==
      ledger.sz_evidence.selected_component_product_name
  ) {
    throw new Error(
      "SZ canonical recipe is not the reviewed one-component selected variant at quantity 24.",
    );
  }
  const targetPool = snapshot.upc_pool_rows.find(
    (row) => row.upc === REVIEWED_SZ_LIVE_UPC,
  );
  const stalePool = snapshot.upc_pool_rows.find(
    (row) => row.upc === REVIEWED_SZ_STALE_UPC,
  );
  if (!targetPool || !stalePool) throw new Error("SZ UPCPool rows are not unique/exact.");
  if (
    snapshot.sz_target_upc_owner &&
    snapshot.sz_target_upc_owner.id !== szChannel.id
  ) {
    throw new Error("SZ live UPC is already owned by another ChannelSKU.");
  }
  if (szChannel.upc === REVIEWED_SZ_LIVE_UPC) {
    if (
      szChannel.upc_pool_id !== targetPool.id ||
      targetPool.status !== "ASSIGNED" ||
      targetPool.assigned_to_id !== szChannel.id
    ) {
      throw new Error("SZ live UPC is cached without an exact ASSIGNED pool link.");
    }
  } else if (
    targetPool.status !== "AVAILABLE" ||
    targetPool.assigned_to_id != null ||
    targetPool.reserved_for_id != null ||
    targetPool.reserved_at != null ||
    targetPool.reserved_until != null ||
    !snapshot.upc_pool_rows.some(
      (row) => row.upc === REVIEWED_SZ_STALE_UPC && row.assigned_to_id === szChannel.id,
    )
  ) {
    throw new Error("SZ UPCPool reassignment preconditions are not safe/exact.");
  }
}

function planDigest(plan: Omit<PostLiveReconciliationPlan, "sha256">): string {
  return postLiveSha256(postLiveStableJson(plan));
}

export function buildPostLiveReconciliationPlan(
  input: BuildPostLiveReconciliationPlanInput,
): PostLiveReconciliationPlan {
  const now = input.now ?? new Date();
  const maxAge = input.max_ledger_age_ms ?? DEFAULT_FINAL_LEDGER_MAX_AGE_MS;
  const ledger = validateFinalLiveLedger(input.ledger, { now, max_age_ms: maxAge });
  const repair = validateSurgicalRepairEvidence(input.repair_plan, ledger);
  const checkpoints = validateCompleteCheckpoints(input.checkpoint_artifacts, repair);
  assertFinalLedgerAfterRepair(ledger, repair, checkpoints);
  assertDbSnapshotMatchesLedger(input.db_snapshot, ledger);
  const ledgerFileSha = assertSha256("Final ledger file SHA-256", input.ledger_file_sha256);
  const repairFileSha = assertSha256(
    "Surgical repair plan file SHA-256",
    input.repair_plan_file_sha256,
  );

  const channelById = mapById(input.db_snapshot.channel_skus);
  const masterById = mapById(input.db_snapshot.master_bundles);
  const draftById = mapById(input.db_snapshot.bundle_drafts);
  const reconciliations: ReconciliationEntry[] = ledger.live_rows.map((row) => {
    const channel = channelById.get(row.channel_sku_id) as ChannelSkuDbRow;
    const master = masterById.get(row.master_bundle_id) as MasterBundleDbRow;
    const draft = draftById.get(row.draft_id) as BundleDraftDbRow;
    const channelLiveAt = desiredTimestamp(
      channel.live_at,
      channel.published_at,
      ledger.completed_at,
      `${row.sku} live_at`,
    );
    const channelPublishedAt = desiredTimestamp(
      channel.published_at,
      channel.live_at,
      ledger.completed_at,
      `${row.sku} published_at`,
    );
    const draftPublishedAt =
      optionalIso(`${row.sku} draft published_at`, draft.published_at) ??
      channelPublishedAt;
    const sanitizedAttributes = sanitizePostLiveCachedAttributes(
      row.sku,
      channel.attributes,
    );
    const channelDesired = {
      lifecycle_status: "LIVE",
      listing_status: "LIVE",
      live_at: channelLiveAt,
      published_at: channelPublishedAt,
      price_cents: row.canonical_price_cents,
      business_price_cents: row.canonical_price_cents,
      attributes: sanitizedAttributes.value,
    };
    const masterDesired = { lifecycle_status: "LIVE" };
    const draftDesired = { status: "PUBLISHED", published_at: draftPublishedAt };
    return {
      sku: row.sku,
      asin: row.asin,
      channel_sku_id: row.channel_sku_id,
      master_bundle_id: row.master_bundle_id,
      bundle_draft_id: row.draft_id,
      generation_job_id: row.generation_job_id,
      evidence: {
        ledger_audit_id: ledger.audit_id,
        observed_live_at: ledger.completed_at,
        buyable: row.buyable,
        discoverable: row.discoverable,
      },
      desired: {
        channel_lifecycle_status: "LIVE",
        channel_listing_status: "LIVE",
        channel_live_at: channelLiveAt,
        channel_published_at: channelPublishedAt,
        master_lifecycle_status: "LIVE",
        draft_status: "PUBLISHED",
        draft_published_at: draftPublishedAt,
        channel_price_cents: row.canonical_price_cents,
        channel_business_price_cents: row.canonical_price_cents,
        channel_attributes: sanitizedAttributes.value,
        channel_attributes_sha256: postLiveSha256(sanitizedAttributes.value),
      },
      changes: [
        ...changedFields(channel, channelDesired, "ChannelSKU"),
        ...changedFields(master, masterDesired, "MasterBundle"),
        ...changedFields(draft, draftDesired, "BundleDraft"),
      ].sort(),
    };
  });

  const true404Preservation: True404PreservationEntry[] = ledger.true_404_rows.map(
    (row) => {
      const channel = channelById.get(row.channel_sku_id) as ChannelSkuDbRow;
      const master = masterById.get(row.master_bundle_id) as MasterBundleDbRow;
      const draft = row.draft_id ? (draftById.get(row.draft_id) as BundleDraftDbRow) : null;
      return {
        sku: row.sku,
        channel_sku_id: row.channel_sku_id,
        master_bundle_id: row.master_bundle_id,
        bundle_draft_id: row.draft_id,
        row_snapshot_sha256: true404SnapshotDigest({ channel, master, draft }),
        preserved_state: {
          asin: null,
          channel_lifecycle_status: channel.lifecycle_status,
          channel_listing_status: channel.listing_status,
          master_lifecycle_status: master.lifecycle_status,
          draft_status: draft?.status ?? null,
        },
      };
    },
  );

  const szLedger = ledger.live_rows.find((row) => row.sku === REVIEWED_SZ_SKU) as
    | ValidatedLedgerLiveRow
    | undefined;
  if (!szLedger) throw new Error("Reviewed SZ row disappeared during planning.");
  const szChannel = channelById.get(szLedger.channel_sku_id) as ChannelSkuDbRow;
  const szMaster = masterById.get(szLedger.master_bundle_id) as MasterBundleDbRow;
  const szDraft = draftById.get(szLedger.draft_id) as BundleDraftDbRow;
  const targetPool = input.db_snapshot.upc_pool_rows.find(
    (row) => row.upc === REVIEWED_SZ_LIVE_UPC,
  ) as UpcPoolDbRow;
  const releasePoolRows = input.db_snapshot.upc_pool_rows
    .filter(
      (row) =>
        row.id !== targetPool.id &&
        (row.assigned_to_id === szChannel.id ||
          row.id === szChannel.upc_pool_id ||
          row.upc === REVIEWED_SZ_STALE_UPC),
    )
    .map((row) => ({
      id: row.id,
      upc: row.upc,
      desired_note:
        row.notes?.trim() ||
        `BURNED post-live: Amazon SKU ${REVIEWED_SZ_SKU} is live on UPC ${REVIEWED_SZ_LIVE_UPC}; detached stale UPC ${row.upc}.`,
      change_required: false,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const targetPoolNeedsChange =
    targetPool.status !== "ASSIGNED" ||
    targetPool.assigned_to_id !== szChannel.id ||
    targetPool.reserved_for_id != null ||
    targetPool.reserved_at != null ||
    targetPool.reserved_until != null;
  const releasePoolNeedsChange = releasePoolRows.some((desired) => {
    const current = input.db_snapshot.upc_pool_rows.find((row) => row.id === desired.id) as
      | UpcPoolDbRow
      | undefined;
    const changed = (
      !current ||
      current.status !== "BURNED" ||
      current.assigned_to_id != null ||
      current.reserved_for_id != null ||
      current.reserved_at != null ||
      current.reserved_until != null ||
      current.notes !== desired.desired_note
    );
    desired.change_required = changed;
    return changed;
  });
  const reviewedSz: ReviewedSzReconciliation = {
    sku: REVIEWED_SZ_SKU,
    asin: REVIEWED_SZ_ASIN,
    evidence: {
      intended_units: 24,
      live_upc: REVIEWED_SZ_LIVE_UPC,
      stale_db_upc: REVIEWED_SZ_STALE_UPC,
      selected_component_product_name:
        ledger.sz_evidence.selected_component_product_name,
      selected_component_qty: 24,
    },
    recipe_guard: {
      master_pack_count: 24,
      draft_pack_count: 24,
      draft_components_sha256: postLiveSha256(szDraft.draft_components),
      master_components_sha256: postLiveSha256(
        postLiveStableJson(
          input.db_snapshot.bundle_components
            .filter((component) => component.master_bundle_id === szMaster.id)
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      ),
    },
    upc_reconciliation: {
      channel_sku_id: szChannel.id,
      current_upc: szChannel.upc,
      desired_upc: REVIEWED_SZ_LIVE_UPC,
      current_upc_pool_id: szChannel.upc_pool_id,
      desired_upc_pool_id: targetPool.id,
      target_pool_row_id: targetPool.id,
      desired_target_status: "ASSIGNED",
      desired_target_assigned_to_id: szChannel.id,
      target_change_required: targetPoolNeedsChange,
      desired_release_status: "BURNED",
      release_pool_rows: releasePoolRows,
      change_required:
        szChannel.upc !== REVIEWED_SZ_LIVE_UPC ||
        szChannel.upc_pool_id !== targetPool.id ||
        targetPoolNeedsChange ||
        releasePoolNeedsChange,
    },
  };
  const szReconciliation = reconciliations.find(
    (entry) => entry.sku === REVIEWED_SZ_SKU,
  ) as ReconciliationEntry;
  if (szChannel.upc !== REVIEWED_SZ_LIVE_UPC) {
    szReconciliation.changes.push("ChannelSKU.upc");
  }
  if (szChannel.upc_pool_id !== targetPool.id) {
    szReconciliation.changes.push("ChannelSKU.upc_pool_id");
  }
  szReconciliation.changes.sort();

  const desiredDraftPublished = new Map(
    reconciliations.map((entry) => [entry.bundle_draft_id, entry.desired.draft_published_at]),
  );
  const generationJobs: GenerationJobReconciliation[] = input.db_snapshot.generation_jobs
    .map((job) => {
      const desiredCount = input.db_snapshot.bundle_drafts.filter((draft) => {
        const desired = desiredDraftPublished.get(draft.id);
        return desired != null || draft.published_at != null;
      }).filter((draft) => draft.generation_job_id === job.id).length;
      return {
        generation_job_id: job.id,
        current_bundles_published: job.bundles_published,
        desired_bundles_published: desiredCount,
        basis: "COUNT_DRAFTS_WITH_PUBLISHED_AT" as const,
        change_required: job.bundles_published !== desiredCount,
      };
    })
    .sort((a, b) => a.generation_job_id.localeCompare(b.generation_job_id));

  const changedChannels = reconciliations.filter((entry) =>
    entry.changes.some((field) => field.startsWith("ChannelSKU.")),
  ).length;
  const changedMasters = reconciliations.filter((entry) =>
    entry.changes.some((field) => field.startsWith("MasterBundle.")),
  ).length;
  const changedDrafts = reconciliations.filter((entry) =>
    entry.changes.some((field) => field.startsWith("BundleDraft.")),
  ).length;
  const changedJobs = generationJobs.filter((job) => job.change_required).length;
  const changedUpcPoolRows = [
    ...(targetPoolNeedsChange ? [targetPool.id] : []),
    ...releasePoolRows
      .filter((desired) => desired.change_required)
      .map((row) => row.id),
  ].length;
  const createdAt = now.toISOString();
  const body: Omit<PostLiveReconciliationPlan, "sha256"> = {
    schema_version: POST_LIVE_RECONCILIATION_SCHEMA,
    immutable: true,
    plan_id: `UPLR-${createdAt.replace(/[-:.]/g, "")}`,
    created_at: createdAt,
    sources: {
      final_live_ledger: {
        path: input.ledger_path,
        file_sha256: ledgerFileSha,
        schema_version: String(input.ledger.schema_version),
        audit_id: ledger.audit_id,
        started_at: ledger.started_at,
        completed_at: ledger.completed_at,
        max_age_ms: maxAge,
      },
      surgical_repair_plan: {
        path: input.repair_plan_path,
        file_sha256: repairFileSha,
        plan_id: repair.plan_id,
        plan_sha256: repair.sha256,
        actions: repair.action_count,
      },
      verified_checkpoints: {
        root_dir: input.checkpoint_root_dir,
        files_sha256: checkpoints.files_sha256,
        events: checkpoints.event_count,
        terminal_actions: checkpoints.terminal_action_count,
        latest_terminal_at: checkpoints.latest_terminal_at,
      },
    },
    policy: {
      database_only: true,
      amazon_mutation: false,
      exact_live_rows: UNCRUSTABLES_LIVE_COUNT,
      exact_true_404_rows: TRUE_404_SKUS.length,
      preserve_marketplace_ids_except_reviewed_sz_upc: true,
      reviewed_sz_upc_reconciliation: true,
      canonical_price_reconciliation: true,
      internal_list_discount_cleanup: true,
      preserve_existing_timestamps: true,
      timestamp_fill_requires_observation: true,
      approval_mutation: false,
      compliance_mutation: false,
      validation_mutation: false,
      inventory_mutation: false,
      true_404_mutation: false,
      bundles_published_basis: "COUNT_DRAFTS_WITH_PUBLISHED_AT",
    },
    scope: {
      cohort_rows: UNCRUSTABLES_COHORT_COUNT,
      live_rows: UNCRUSTABLES_LIVE_COUNT,
      true_404_skus: [...TRUE_404_SKUS],
      channel_sku_ids: validateDbRowSet("ChannelSKU", input.db_snapshot.channel_skus),
      master_bundle_ids: validateDbRowSet("MasterBundle", input.db_snapshot.master_bundles),
      cohort_bundle_draft_ids: sortedUnique(
        "cohort BundleDraft id",
        [...ledger.live_rows, ...ledger.true_404_rows]
          .map((row) => row.draft_id)
          .filter((id): id is string => id != null),
      ),
      guarded_job_bundle_draft_ids: validateDbRowSet(
        "guarded BundleDraft",
        input.db_snapshot.bundle_drafts,
      ),
      generation_job_ids: validateDbRowSet("GenerationJob", input.db_snapshot.generation_jobs),
      bundle_component_ids: validateDbRowSet(
        "BundleComponent",
        input.db_snapshot.bundle_components,
      ),
      upc_pool_row_ids: validateDbRowSet("UPCPool", input.db_snapshot.upc_pool_rows),
    },
    db_snapshot: {
      sha256: postLiveDbSnapshotDigest(input.db_snapshot),
      channel_skus: input.db_snapshot.channel_skus.length,
      master_bundles: input.db_snapshot.master_bundles.length,
      bundle_drafts: input.db_snapshot.bundle_drafts.length,
      generation_jobs: input.db_snapshot.generation_jobs.length,
      bundle_components: input.db_snapshot.bundle_components.length,
      upc_pool_rows: input.db_snapshot.upc_pool_rows.length,
    },
    reconciliations,
    true_404_preservation: true404Preservation,
    generation_jobs: generationJobs,
    reviewed_sz: reviewedSz,
    change_summary: {
      channel_skus: changedChannels,
      master_bundles: changedMasters,
      bundle_drafts: changedDrafts,
      generation_jobs: changedJobs,
      upc_pool_rows: changedUpcPoolRows,
      total_rows:
        changedChannels +
        changedMasters +
        changedDrafts +
        changedJobs +
        changedUpcPoolRows,
    },
  };
  return { ...body, sha256: planDigest(body) };
}

export function verifyPostLiveReconciliationPlan(plan: PostLiveReconciliationPlan): void {
  if (plan.schema_version !== POST_LIVE_RECONCILIATION_SCHEMA || plan.immutable !== true) {
    throw new Error("Unsupported or mutable post-live reconciliation plan.");
  }
  const { sha256: claimed, ...body } = plan;
  if (assertSha256("Post-live reconciliation plan SHA-256", claimed) !== planDigest(body)) {
    throw new Error("Post-live reconciliation plan SHA-256 mismatch.");
  }
  const policy = plan.policy;
  if (
    policy.database_only !== true ||
    policy.amazon_mutation !== false ||
    policy.exact_live_rows !== UNCRUSTABLES_LIVE_COUNT ||
    policy.exact_true_404_rows !== TRUE_404_SKUS.length ||
    policy.preserve_marketplace_ids_except_reviewed_sz_upc !== true ||
    policy.reviewed_sz_upc_reconciliation !== true ||
    policy.canonical_price_reconciliation !== true ||
    policy.internal_list_discount_cleanup !== true ||
    policy.preserve_existing_timestamps !== true ||
    policy.timestamp_fill_requires_observation !== true ||
    policy.approval_mutation !== false ||
    policy.compliance_mutation !== false ||
    policy.validation_mutation !== false ||
    policy.inventory_mutation !== false ||
    policy.true_404_mutation !== false ||
    policy.bundles_published_basis !== "COUNT_DRAFTS_WITH_PUBLISHED_AT"
  ) {
    throw new Error("Post-live reconciliation safety policy was weakened.");
  }
  if (
    plan.scope.cohort_rows !== UNCRUSTABLES_COHORT_COUNT ||
    plan.scope.live_rows !== UNCRUSTABLES_LIVE_COUNT ||
    plan.reconciliations.length !== UNCRUSTABLES_LIVE_COUNT ||
    plan.true_404_preservation.length !== TRUE_404_SKUS.length ||
    !sameStringSet(plan.scope.true_404_skus, [...TRUE_404_SKUS])
  ) {
    throw new Error("Post-live reconciliation scope is not the exact 164+3 cohort.");
  }
  const planCreatedAt = requiredIso("Post-live plan created_at", plan.created_at);
  const ledgerStartedAt = requiredIso(
    "Sealed final ledger started_at",
    plan.sources.final_live_ledger.started_at,
  );
  const ledgerCompletedAt = requiredIso(
    "Sealed final ledger completed_at",
    plan.sources.final_live_ledger.completed_at,
  );
  const latestTerminalAt = requiredIso(
    "Sealed latest repair checkpoint",
    plan.sources.verified_checkpoints.latest_terminal_at,
  );
  if (
    Date.parse(ledgerCompletedAt) < Date.parse(ledgerStartedAt) ||
    Date.parse(ledgerStartedAt) < Date.parse(latestTerminalAt) ||
    Date.parse(planCreatedAt) < Date.parse(ledgerCompletedAt) ||
    !Number.isInteger(plan.sources.final_live_ledger.max_age_ms) ||
    plan.sources.final_live_ledger.max_age_ms <= 0 ||
    plan.sources.final_live_ledger.max_age_ms > 24 * 60 * 60 * 1000
  ) {
    throw new Error("Sealed source chronology/freshness policy is invalid.");
  }
  requiredString("Sealed final ledger path", plan.sources.final_live_ledger.path);
  requiredString("Sealed surgical repair path", plan.sources.surgical_repair_plan.path);
  requiredString("Sealed checkpoint root", plan.sources.verified_checkpoints.root_dir);
  requiredString("Sealed final ledger audit_id", plan.sources.final_live_ledger.audit_id);
  requiredString("Sealed surgical repair plan_id", plan.sources.surgical_repair_plan.plan_id);
  assertSha256(
    "Sealed final ledger file SHA-256",
    plan.sources.final_live_ledger.file_sha256,
  );
  assertSha256(
    "Sealed surgical repair file SHA-256",
    plan.sources.surgical_repair_plan.file_sha256,
  );
  assertSha256(
    "Sealed surgical repair plan SHA-256",
    plan.sources.surgical_repair_plan.plan_sha256,
  );

  const skus: string[] = [];
  const asins: string[] = [];
  const channelIds: string[] = [];
  const masterIds: string[] = [];
  const draftIds: string[] = [];
  const reconciliationJobIds: string[] = [];
  const allowedChanges = new Set([
    "ChannelSKU.lifecycle_status",
    "ChannelSKU.listing_status",
    "ChannelSKU.live_at",
    "ChannelSKU.published_at",
    "ChannelSKU.price_cents",
    "ChannelSKU.business_price_cents",
    "ChannelSKU.attributes",
    "ChannelSKU.upc",
    "ChannelSKU.upc_pool_id",
    "MasterBundle.lifecycle_status",
    "BundleDraft.status",
    "BundleDraft.published_at",
  ]);
  for (const entry of plan.reconciliations) {
    skus.push(requiredString("Reconciliation SKU", entry.sku));
    const entryAsin = requiredString(`${entry.sku} ASIN`, entry.asin);
    if (!/^[A-Z0-9]{10}$/.test(entryAsin)) {
      throw new Error(`${entry.sku}: invalid sealed ASIN.`);
    }
    asins.push(entryAsin);
    channelIds.push(requiredString(`${entry.sku} ChannelSKU id`, entry.channel_sku_id));
    masterIds.push(requiredString(`${entry.sku} MasterBundle id`, entry.master_bundle_id));
    draftIds.push(requiredString(`${entry.sku} BundleDraft id`, entry.bundle_draft_id));
    reconciliationJobIds.push(
      requiredString(`${entry.sku} GenerationJob id`, entry.generation_job_id),
    );
    if (
      entry.desired.channel_lifecycle_status !== "LIVE" ||
      entry.desired.channel_listing_status !== "LIVE" ||
      entry.desired.master_lifecycle_status !== "LIVE" ||
      entry.desired.draft_status !== "PUBLISHED"
    ) {
      throw new Error(`${entry.sku}: sealed desired lifecycle state was weakened.`);
    }
    requiredIso(`${entry.sku} channel_live_at`, entry.desired.channel_live_at);
    requiredIso(`${entry.sku} channel_published_at`, entry.desired.channel_published_at);
    requiredIso(`${entry.sku} draft_published_at`, entry.desired.draft_published_at);
    if (
      !Number.isInteger(entry.desired.channel_price_cents) ||
      entry.desired.channel_price_cents <= 0 ||
      entry.desired.channel_business_price_cents !==
        entry.desired.channel_price_cents ||
      postLiveSha256(entry.desired.channel_attributes) !==
        entry.desired.channel_attributes_sha256
    ) {
      throw new Error(`${entry.sku}: sealed cached price/attribute state is invalid.`);
    }
    const sanitized = sanitizePostLiveCachedAttributes(
      entry.sku,
      entry.desired.channel_attributes,
    );
    if (sanitized.changed) {
      throw new Error(`${entry.sku}: sealed attributes still contain list/discount state.`);
    }
    if (
      entry.evidence.ledger_audit_id !== plan.sources.final_live_ledger.audit_id ||
      entry.evidence.observed_live_at !== ledgerCompletedAt ||
      (!entry.evidence.buyable && !entry.evidence.discoverable)
    ) {
      throw new Error(`${entry.sku}: sealed live evidence is incomplete.`);
    }
    sortedUnique(`${entry.sku} change`, entry.changes);
    if (entry.changes.some((change) => !allowedChanges.has(change))) {
      throw new Error(`${entry.sku}: plan contains an unapproved DB field change.`);
    }
  }
  sortedUnique("reconciliation SKU", skus);
  sortedUnique("reconciliation ASIN", asins);
  sortedUnique("live ChannelSKU id", channelIds);
  sortedUnique("live MasterBundle id", masterIds);
  sortedUnique("live BundleDraft id", draftIds);

  const true404ChannelIds: string[] = [];
  const true404MasterIds: string[] = [];
  const true404DraftIds: string[] = [];
  if (
    !sameStringSet(
      plan.true_404_preservation.map((entry) => entry.sku),
      [...TRUE_404_SKUS],
    ) ||
    plan.true_404_preservation.some((entry) => entry.preserved_state.asin !== null)
  ) {
    throw new Error("True-404 preservation set or ASIN invariant changed.");
  }
  for (const entry of plan.true_404_preservation) {
    true404ChannelIds.push(
      requiredString(`${entry.sku} preserved ChannelSKU id`, entry.channel_sku_id),
    );
    true404MasterIds.push(
      requiredString(`${entry.sku} preserved MasterBundle id`, entry.master_bundle_id),
    );
    if (entry.bundle_draft_id) {
      true404DraftIds.push(
        requiredString(`${entry.sku} preserved BundleDraft id`, entry.bundle_draft_id),
      );
    }
    assertSha256(`${entry.sku} preserved row SHA-256`, entry.row_snapshot_sha256);
    if (
      entry.preserved_state.channel_lifecycle_status === "LIVE" ||
      entry.preserved_state.channel_listing_status === "LIVE" ||
      entry.preserved_state.master_lifecycle_status === "LIVE" ||
      entry.preserved_state.draft_status === "PUBLISHED"
    ) {
      throw new Error(`${entry.sku}: sealed true-404 state is not non-live.`);
    }
  }
  sortedUnique("true-404 ChannelSKU id", true404ChannelIds);
  sortedUnique("true-404 MasterBundle id", true404MasterIds);
  sortedUnique("true-404 BundleDraft id", true404DraftIds);
  if (
    plan.sources.surgical_repair_plan.actions !==
      plan.sources.verified_checkpoints.terminal_actions ||
    !Number.isInteger(plan.sources.surgical_repair_plan.actions) ||
    plan.sources.surgical_repair_plan.actions <= 0 ||
    !Number.isInteger(plan.sources.verified_checkpoints.events) ||
    plan.sources.verified_checkpoints.events <
      plan.sources.verified_checkpoints.terminal_actions
  ) {
    throw new Error("Sealed source checkpoint count is incomplete.");
  }
  assertSha256("Sealed DB snapshot SHA-256", plan.db_snapshot.sha256);
  assertSha256("Sealed checkpoint files SHA-256", plan.sources.verified_checkpoints.files_sha256);
  for (const list of [
    plan.scope.channel_sku_ids,
    plan.scope.master_bundle_ids,
    plan.scope.cohort_bundle_draft_ids,
    plan.scope.guarded_job_bundle_draft_ids,
    plan.scope.generation_job_ids,
    plan.scope.bundle_component_ids,
    plan.scope.upc_pool_row_ids,
  ]) {
    sortedUnique("sealed row id", list);
  }
  if (
    !sameStringSet(plan.scope.channel_sku_ids, [...channelIds, ...true404ChannelIds]) ||
    !sameStringSet(plan.scope.master_bundle_ids, [...masterIds, ...true404MasterIds]) ||
    !sameStringSet(plan.scope.cohort_bundle_draft_ids, [...draftIds, ...true404DraftIds]) ||
    plan.db_snapshot.channel_skus !== plan.scope.channel_sku_ids.length ||
    plan.db_snapshot.master_bundles !== plan.scope.master_bundle_ids.length ||
    plan.db_snapshot.bundle_drafts !== plan.scope.guarded_job_bundle_draft_ids.length ||
    plan.db_snapshot.generation_jobs !== plan.scope.generation_job_ids.length
    || plan.db_snapshot.bundle_components !== plan.scope.bundle_component_ids.length
    || plan.db_snapshot.upc_pool_rows !== plan.scope.upc_pool_row_ids.length
  ) {
    throw new Error("Sealed DB row sets/counts do not match reconciliation identities.");
  }

  const generationJobIds: string[] = [];
  for (const job of plan.generation_jobs) {
    generationJobIds.push(
      requiredString("GenerationJob reconciliation id", job.generation_job_id),
    );
    if (
      job.basis !== "COUNT_DRAFTS_WITH_PUBLISHED_AT" ||
      !Number.isInteger(job.current_bundles_published) ||
      job.current_bundles_published < 0 ||
      !Number.isInteger(job.desired_bundles_published) ||
      job.desired_bundles_published < 0 ||
      job.change_required !==
        (job.current_bundles_published !== job.desired_bundles_published)
    ) {
      throw new Error(`${job.generation_job_id}: invalid published-counter plan.`);
    }
  }
  sortedUnique("GenerationJob reconciliation id", generationJobIds);
  if (
    !sameStringSet(plan.scope.generation_job_ids, generationJobIds) ||
    !sameStringSet(
      plan.scope.generation_job_ids,
      [...new Set(reconciliationJobIds)],
    )
  ) {
    throw new Error("Sealed GenerationJob scope differs from live draft lineage.");
  }

  const reviewedSz = plan.reviewed_sz;
  const szEntry = plan.reconciliations.find((entry) => entry.sku === REVIEWED_SZ_SKU);
  if (
    reviewedSz.sku !== REVIEWED_SZ_SKU ||
    reviewedSz.asin !== REVIEWED_SZ_ASIN ||
    reviewedSz.evidence.intended_units !== 24 ||
    reviewedSz.evidence.live_upc !== REVIEWED_SZ_LIVE_UPC ||
    reviewedSz.evidence.stale_db_upc !== REVIEWED_SZ_STALE_UPC ||
    reviewedSz.evidence.selected_component_qty !== 24 ||
    reviewedSz.recipe_guard.master_pack_count !== 24 ||
    reviewedSz.recipe_guard.draft_pack_count !== 24 ||
    !szEntry ||
    szEntry.channel_sku_id !==
      reviewedSz.upc_reconciliation.channel_sku_id ||
    reviewedSz.upc_reconciliation.desired_upc !== REVIEWED_SZ_LIVE_UPC ||
    reviewedSz.upc_reconciliation.desired_target_status !== "ASSIGNED" ||
    reviewedSz.upc_reconciliation.desired_target_assigned_to_id !==
      szEntry.channel_sku_id ||
    typeof reviewedSz.upc_reconciliation.target_change_required !== "boolean" ||
    reviewedSz.upc_reconciliation.desired_release_status !== "BURNED" ||
    reviewedSz.upc_reconciliation.desired_upc_pool_id !==
      reviewedSz.upc_reconciliation.target_pool_row_id
  ) {
    throw new Error("Reviewed SZ recipe/UPC reconciliation invariant changed.");
  }
  assertSha256(
    "SZ draft components SHA-256",
    reviewedSz.recipe_guard.draft_components_sha256,
  );
  assertSha256(
    "SZ master components SHA-256",
    reviewedSz.recipe_guard.master_components_sha256,
  );
  const releasePoolIds = reviewedSz.upc_reconciliation.release_pool_rows.map(
    (row) => requiredString("SZ released UPCPool id", row.id),
  );
  sortedUnique("SZ released UPCPool id", releasePoolIds);
  if (
    releasePoolIds.includes(reviewedSz.upc_reconciliation.target_pool_row_id) ||
    !plan.scope.upc_pool_row_ids.includes(
      reviewedSz.upc_reconciliation.target_pool_row_id,
    ) ||
    releasePoolIds.some((id) => !plan.scope.upc_pool_row_ids.includes(id)) ||
    reviewedSz.upc_reconciliation.release_pool_rows.some(
      (row) =>
        !row.upc ||
        !row.desired_note.trim() ||
        typeof row.change_required !== "boolean",
    )
  ) {
    throw new Error("Reviewed SZ UPCPool scope is invalid.");
  }

  const expectedChanges = {
    channel_skus: plan.reconciliations.filter((entry) =>
      entry.changes.some((field) => field.startsWith("ChannelSKU.")),
    ).length,
    master_bundles: plan.reconciliations.filter((entry) =>
      entry.changes.some((field) => field.startsWith("MasterBundle.")),
    ).length,
    bundle_drafts: plan.reconciliations.filter((entry) =>
      entry.changes.some((field) => field.startsWith("BundleDraft.")),
    ).length,
    generation_jobs: plan.generation_jobs.filter((job) => job.change_required).length,
  };
  const expectedChangedUpcPoolRows =
    (reviewedSz.upc_reconciliation.target_change_required ? 1 : 0) +
    reviewedSz.upc_reconciliation.release_pool_rows.filter(
      (row) => row.change_required,
    ).length;
  const szChannelChange = szEntry.changes.some(
    (change) => change === "ChannelSKU.upc" || change === "ChannelSKU.upc_pool_id",
  );
  if (
    !Number.isInteger(plan.change_summary.upc_pool_rows) ||
    plan.change_summary.upc_pool_rows !== expectedChangedUpcPoolRows ||
    reviewedSz.upc_reconciliation.change_required !==
      (szChannelChange || expectedChangedUpcPoolRows > 0)
  ) {
    throw new Error("Sealed UPCPool change count is invalid.");
  }
  if (
    plan.change_summary.channel_skus !== expectedChanges.channel_skus ||
    plan.change_summary.master_bundles !== expectedChanges.master_bundles ||
    plan.change_summary.bundle_drafts !== expectedChanges.bundle_drafts ||
    plan.change_summary.generation_jobs !== expectedChanges.generation_jobs ||
    (reviewedSz.upc_reconciliation.change_required &&
      plan.change_summary.upc_pool_rows === 0) ||
    (!reviewedSz.upc_reconciliation.change_required &&
      plan.change_summary.upc_pool_rows !== 0) ||
    plan.change_summary.total_rows !==
      expectedChanges.channel_skus +
        expectedChanges.master_bundles +
        expectedChanges.bundle_drafts +
        expectedChanges.generation_jobs +
        plan.change_summary.upc_pool_rows
  ) {
    throw new Error("Sealed DB change summary is inconsistent.");
  }
}

export function postLiveReconciliationConfirmation(
  plan: PostLiveReconciliationPlan,
): string {
  verifyPostLiveReconciliationPlan(plan);
  return `RECONCILE-UNCRUSTABLES-${plan.sha256.slice(0, 16).toUpperCase()}`;
}

export function assertDbSnapshotMatchesPlan(
  plan: PostLiveReconciliationPlan,
  snapshot: PostLiveDbSnapshot,
): void {
  verifyPostLiveReconciliationPlan(plan);
  const digest = postLiveDbSnapshotDigest(snapshot);
  if (digest !== plan.db_snapshot.sha256) {
    throw new Error(
      `Database snapshot drifted after planning; transaction must roll back (expected ${plan.db_snapshot.sha256}, got ${digest}).`,
    );
  }
  const checks: Array<[string, string[], string[]]> = [
    ["ChannelSKU", validateDbRowSet("ChannelSKU", snapshot.channel_skus), plan.scope.channel_sku_ids],
    ["MasterBundle", validateDbRowSet("MasterBundle", snapshot.master_bundles), plan.scope.master_bundle_ids],
    [
      "guarded BundleDraft",
      validateDbRowSet("BundleDraft", snapshot.bundle_drafts),
      plan.scope.guarded_job_bundle_draft_ids,
    ],
    [
      "GenerationJob",
      validateDbRowSet("GenerationJob", snapshot.generation_jobs),
      plan.scope.generation_job_ids,
    ],
    [
      "BundleComponent",
      validateDbRowSet("BundleComponent", snapshot.bundle_components),
      plan.scope.bundle_component_ids,
    ],
    [
      "UPCPool",
      validateDbRowSet("UPCPool", snapshot.upc_pool_rows),
      plan.scope.upc_pool_row_ids,
    ],
  ];
  for (const [label, actual, expected] of checks) {
    if (!sameStringSet(actual, expected)) throw new Error(`${label} row set drifted.`);
  }
}

function comparableRow(
  row: UnknownRecord,
  allowedChangedFields: Set<string>,
  allowUpdatedAt: boolean,
): UnknownRecord {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !allowedChangedFields.has(key) && !(allowUpdatedAt && key === "updated_at"),
    ),
  );
}

/** Verify that apply changed only the sealed lifecycle fields/counter. This is
 * intentionally independent of Prisma so rollback semantics are unit-testable. */
export function assertPostLiveReconciliationOutcome(
  plan: PostLiveReconciliationPlan,
  before: PostLiveDbSnapshot,
  after: PostLiveDbSnapshot,
): void {
  verifyPostLiveReconciliationPlan(plan);
  assertDbSnapshotMatchesPlan(plan, before);
  const beforeNormalized = normalizedSnapshot(before);
  const afterNormalized = normalizedSnapshot(after);
  const pairs = [
    ["ChannelSKU", beforeNormalized.channel_skus, afterNormalized.channel_skus],
    ["MasterBundle", beforeNormalized.master_bundles, afterNormalized.master_bundles],
    ["BundleDraft", beforeNormalized.bundle_drafts, afterNormalized.bundle_drafts],
    ["GenerationJob", beforeNormalized.generation_jobs, afterNormalized.generation_jobs],
    [
      "BundleComponent",
      beforeNormalized.bundle_components,
      afterNormalized.bundle_components,
    ],
    ["UPCPool", beforeNormalized.upc_pool_rows, afterNormalized.upc_pool_rows],
  ] as const;
  for (const [label, beforeRows, afterRows] of pairs) {
    if (!sameStringSet(beforeRows.map((row) => row.id), afterRows.map((row) => row.id))) {
      throw new Error(`${label} row set changed during reconciliation.`);
    }
  }
  const reconciliationByChannel = new Map(
    plan.reconciliations.map((entry) => [entry.channel_sku_id, entry]),
  );
  const reconciliationByMaster = new Map(
    plan.reconciliations.map((entry) => [entry.master_bundle_id, entry]),
  );
  const reconciliationByDraft = new Map(
    plan.reconciliations.map((entry) => [entry.bundle_draft_id, entry]),
  );
  const jobPlan = new Map(plan.generation_jobs.map((job) => [job.generation_job_id, job]));

  const compareRows = <T extends UnknownRecord & { id: string }>(
    label: string,
    beforeRows: T[],
    afterRows: T[],
    target: (row: T) => { desired: UnknownRecord; allowed: Set<string> } | null,
  ) => {
    const afterById = mapById(afterRows);
    for (const oldRow of beforeRows) {
      const newRow = afterById.get(oldRow.id) as T;
      const mutation = target(oldRow);
      if (!mutation) {
        if (postLiveStableJson(oldRow) !== postLiveStableJson(newRow)) {
          throw new Error(`${label} ${oldRow.id} changed outside the sealed scope.`);
        }
        continue;
      }
      if (
        postLiveStableJson(comparableRow(oldRow, mutation.allowed, true)) !==
        postLiveStableJson(comparableRow(newRow, mutation.allowed, true))
      ) {
        throw new Error(`${label} ${oldRow.id} changed an unapproved field.`);
      }
      for (const [field, desired] of Object.entries(mutation.desired)) {
        const actual = newRow[field];
        const normalizedActual = field.endsWith("_at")
          ? optionalIso(`${label} ${oldRow.id}.${field}`, actual)
          : actual;
        if (postLiveStableJson(normalizedActual) !== postLiveStableJson(desired)) {
          throw new Error(`${label} ${oldRow.id}.${field} did not reach sealed desired state.`);
        }
      }
    }
  };

  compareRows(
    "ChannelSKU",
    beforeNormalized.channel_skus,
    afterNormalized.channel_skus,
    (row) => {
      const entry = reconciliationByChannel.get(row.id);
      if (!entry) return null;
      const isSz = entry.sku === REVIEWED_SZ_SKU;
      return {
        desired: {
          lifecycle_status: entry.desired.channel_lifecycle_status,
          listing_status: entry.desired.channel_listing_status,
          live_at: entry.desired.channel_live_at,
          published_at: entry.desired.channel_published_at,
          price_cents: entry.desired.channel_price_cents,
          business_price_cents: entry.desired.channel_business_price_cents,
          attributes: entry.desired.channel_attributes,
          ...(isSz
            ? {
                upc: plan.reviewed_sz.upc_reconciliation.desired_upc,
                upc_pool_id:
                  plan.reviewed_sz.upc_reconciliation.desired_upc_pool_id,
              }
            : {}),
        },
        allowed: new Set([
          "lifecycle_status",
          "listing_status",
          "live_at",
          "published_at",
          "price_cents",
          "business_price_cents",
          "attributes",
          ...(isSz ? ["upc", "upc_pool_id"] : []),
        ]),
      };
    },
  );
  compareRows(
    "MasterBundle",
    beforeNormalized.master_bundles,
    afterNormalized.master_bundles,
    (row) => {
      const entry = reconciliationByMaster.get(row.id);
      return entry
        ? {
            desired: { lifecycle_status: entry.desired.master_lifecycle_status },
            allowed: new Set(["lifecycle_status"]),
          }
        : null;
    },
  );
  compareRows(
    "BundleComponent",
    beforeNormalized.bundle_components,
    afterNormalized.bundle_components,
    () => null,
  );
  const releasedPools = new Map(
    plan.reviewed_sz.upc_reconciliation.release_pool_rows.map((row) => [
      row.id,
      row,
    ]),
  );
  compareRows(
    "UPCPool",
    beforeNormalized.upc_pool_rows,
    afterNormalized.upc_pool_rows,
    (row) => {
      if (row.id === plan.reviewed_sz.upc_reconciliation.target_pool_row_id) {
        return {
          desired: {
            status: "ASSIGNED",
            assigned_to_id:
              plan.reviewed_sz.upc_reconciliation.desired_target_assigned_to_id,
            reserved_for_id: null,
            reserved_at: null,
            reserved_until: null,
          },
          allowed: new Set([
            "status",
            "assigned_to_id",
            "reserved_for_id",
            "reserved_at",
            "reserved_until",
          ]),
        };
      }
      const released = releasedPools.get(row.id);
      return released
        ? {
            desired: {
              status: "BURNED",
              assigned_to_id: null,
              reserved_for_id: null,
              reserved_at: null,
              reserved_until: null,
              notes: released.desired_note,
            },
            allowed: new Set([
              "status",
              "assigned_to_id",
              "reserved_for_id",
              "reserved_at",
              "reserved_until",
              "notes",
            ]),
          }
        : null;
    },
  );
  compareRows(
    "BundleDraft",
    beforeNormalized.bundle_drafts,
    afterNormalized.bundle_drafts,
    (row) => {
      const entry = reconciliationByDraft.get(row.id);
      return entry
        ? {
            desired: {
              status: entry.desired.draft_status,
              published_at: entry.desired.draft_published_at,
            },
            allowed: new Set(["status", "published_at"]),
          }
        : null;
    },
  );
  compareRows(
    "GenerationJob",
    beforeNormalized.generation_jobs,
    afterNormalized.generation_jobs,
    (row) => {
      const desired = jobPlan.get(row.id);
      return desired
        ? {
            desired: { bundles_published: desired.desired_bundles_published },
            allowed: new Set(["bundles_published"]),
          }
        : null;
    },
  );

  const afterChannelById = mapById(after.channel_skus);
  const afterMasterById = mapById(after.master_bundles);
  const afterDraftById = mapById(after.bundle_drafts);
  for (const preserved of plan.true_404_preservation) {
    const digest = true404SnapshotDigest({
      channel: afterChannelById.get(preserved.channel_sku_id) as ChannelSkuDbRow,
      master: afterMasterById.get(preserved.master_bundle_id) as MasterBundleDbRow,
      draft: preserved.bundle_draft_id
        ? (afterDraftById.get(preserved.bundle_draft_id) as BundleDraftDbRow)
        : null,
    });
    if (digest !== preserved.row_snapshot_sha256) {
      throw new Error(`${preserved.sku}: true-404 state changed during reconciliation.`);
    }
  }
  const afterSz = afterChannelById.get(
    plan.reviewed_sz.upc_reconciliation.channel_sku_id,
  ) as ChannelSkuDbRow;
  if (
    !after.sz_target_upc_owner ||
    after.sz_target_upc_owner.id !== afterSz.id ||
    postLiveStableJson(after.sz_target_upc_owner) !== postLiveStableJson(afterSz)
  ) {
    throw new Error("SZ target UPC owner did not reconcile to the exact ChannelSKU.");
  }
  const afterSzDraft = afterDraftById.get(
    plan.reconciliations.find((entry) => entry.sku === REVIEWED_SZ_SKU)
      ?.bundle_draft_id as string,
  ) as BundleDraftDbRow;
  const afterSzComponents = after.bundle_components
    .filter(
      (component) =>
        component.master_bundle_id ===
        plan.reconciliations.find((entry) => entry.sku === REVIEWED_SZ_SKU)
          ?.master_bundle_id,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    postLiveSha256(afterSzDraft.draft_components) !==
      plan.reviewed_sz.recipe_guard.draft_components_sha256 ||
    postLiveSha256(postLiveStableJson(afterSzComponents)) !==
      plan.reviewed_sz.recipe_guard.master_components_sha256
  ) {
    throw new Error("SZ reviewed 24-unit recipe changed during lifecycle reconciliation.");
  }
}
