import { createHash } from "node:crypto";

import { extractTitleOuterCountEvidence } from "./catalog-visual-truth-preflight.ts";

export const WALMART_LISTING_INTEGRITY_CATALOG_CENSUS_SCHEMA =
  "walmart-listing-integrity-catalog-census/v1" as const;
export const WALMART_LISTING_INTEGRITY_SCAN_PLAN_SCHEMA =
  "walmart-listing-integrity-scan-plan/v1" as const;
export const WALMART_LISTING_INTEGRITY_CATALOG_ORCHESTRATOR_VERSION =
  "walmart-listing-integrity-catalog-orchestrator/v1" as const;
export const WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_CALL = 6;
export const WALMART_LISTING_INTEGRITY_MAX_CALLS_PER_PARTITION = 6;
export const WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION = (
  WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_CALL
  * WALMART_LISTING_INTEGRITY_MAX_CALLS_PER_PARTITION
) as 36;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingIntegrityCatalogMirrorRow {
  sku: unknown;
  itemId: unknown;
  title: unknown;
  lifecycleStatus: unknown;
  publishedStatus: unknown;
  syncedAt: unknown;
  mainImageUrl: unknown;
}

export interface WalmartListingIntegrityRemediationHistoryRow {
  id: unknown;
  sku: unknown;
  runAt: unknown;
  feedStatus: unknown;
  ok: unknown;
  mainImageUrl: unknown;
  newTitle: unknown;
  packCount: unknown;
  changeSummary: unknown;
}

export type WalmartListingIntegrityScanDisposition =
  | "VISUAL_TRIAGE_READY"
  | "SOURCE_ACQUISITION_REQUIRED"
  | "STATUS_REVIEW"
  | "BLOCKED_SOURCE"
  | "DO_NOT_TOUCH";

interface ReusableContent {
  run_at: string;
  feed_status: string;
  transport_state: "SUBMITTED_NOT_BUYER_VERIFIED" | "PROCESSED_NOT_BUYER_VERIFIED";
  product_name: string | null;
  description: string | null;
  bullets: string[];
  attributes: JsonRecord;
  main_image_url: string | null;
  gallery_image_urls: string[];
  explicit_outer_count: number | null;
}

interface CatalogCensusRow {
  listing_key: string;
  store_index: number;
  sku: string;
  item_id: string | null;
  title: string | null;
  published_status: string | null;
  lifecycle_status: string | null;
  catalog_synced_at: string;
  title_outer_count: ReturnType<typeof extractTitleOuterCountEvidence> | null;
  reusable_evidence: {
    mirror_main_image_url: string | null;
    last_processed_main: {
      source_role: "last_applied_artifact";
      url: string;
      run_at: string;
      feed_status: "APPLIED" | "PROCESSED";
    } | null;
    last_sent_content: ReusableContent | null;
    buyer_surface_verified: false;
  };
  deterministic_findings: string[];
  scan_disposition: WalmartListingIntegrityScanDisposition;
  scan_priority: number;
  reason_codes: string[];
}

export interface WalmartListingIntegrityCatalogCensus {
  schema_version: typeof WALMART_LISTING_INTEGRITY_CATALOG_CENSUS_SCHEMA;
  orchestrator_version: typeof WALMART_LISTING_INTEGRITY_CATALOG_ORCHESTRATOR_VERSION;
  census_id: string;
  body_sha256: string;
  captured_at: string;
  store_index: number;
  source_contract: {
    catalog_population: "WalmartCatalogItem compatibility mirror";
    remediation_history: "WalmartListingRemediation immutable history";
    authority: "READ_ONLY_PROVISIONAL_NOT_BUYER_VERIFIED";
    may_issue_pass: false;
    may_authorize_walmart_write: false;
  };
  reconciliation: {
    catalog_rows: number;
    distinct_skus: number;
    duplicate_skus: 0;
    output_rows: number;
    exact_once: true;
    catalog_synced_at: string;
  };
  summary: {
    total: number;
    published: number;
    active: number;
    with_item_id: number;
    with_title: number;
    with_reusable_main: number;
    with_reusable_gallery: number;
    deterministic_conflicts: number;
    disposition_counts: Record<WalmartListingIntegrityScanDisposition, number>;
  };
  external_effects: {
    database_reads: 2;
    database_writes: 0;
    walmart_reads: 0;
    walmart_writes: 0;
    model_calls: 0;
    paid_api_calls: 0;
  };
  rows: CatalogCensusRow[];
}

export interface WalmartListingIntegrityScanTask {
  task_id: string;
  listing_key: string;
  sku: string;
  slot: "main" | `gallery-${number}`;
  source_role: "last_applied_artifact" | "last_sent_gallery" | "last_sent_main";
  url: string;
  priority: number;
}

export interface WalmartListingIntegrityScanPlan {
  schema_version: typeof WALMART_LISTING_INTEGRITY_SCAN_PLAN_SCHEMA;
  orchestrator_version: typeof WALMART_LISTING_INTEGRITY_CATALOG_ORCHESTRATOR_VERSION;
  plan_id: string;
  body_sha256: string;
  census_body_sha256: string;
  created_at: string;
  store_index: number;
  policy: {
    mode: "READ_ONLY_TRIAGE";
    images_per_call_max: 6;
    calls_per_partition_max: 6;
    images_per_partition_max: 36;
    buyer_verified_pass_allowed: false;
    walmart_writes_allowed: false;
  };
  coverage: {
    catalog_listings: number;
    listings_with_visual_tasks: number;
    listings_requiring_source_acquisition: number;
    visual_tasks: number;
    partitions: number;
    estimated_model_calls_max: number;
  };
  source_acquisition_listing_keys: string[];
  partitions: Array<{
    partition_id: string;
    partition_index: number;
    task_count: number;
    estimated_model_calls_max: number;
    tasks: WalmartListingIntegrityScanTask[];
  }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON rejects undefined");
  return encoded;
}

export function walmartListingIntegrityCatalogSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function text(value: unknown, label: string, maximum = 100_000): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} must be a string`);
  }
  const parsed = String(value).trim();
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f\u007f]/u.test(parsed)) {
    throw new Error(`${label} must be bounded, trimmed, and non-empty`);
  }
  return parsed;
}

function nullableText(value: unknown, label: string, maximum = 100_000): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, label, maximum);
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const instant = Date.parse(parsed);
  if (!Number.isFinite(instant)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(instant).toISOString();
}

function httpsUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 4_096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => (
    typeof entry === "string" && !!entry.trim() && entry.length <= 100_000
  )).map((entry) => entry.trim()).slice(0, 100);
}

function contentText(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = String(value).replace(/[\u0009-\u000d]+/gu, " ").trim();
  if (!parsed || parsed.length > maximum || /[\u0000\u0001-\u0008\u000e-\u001f\u007f]/u.test(parsed)) {
    return null;
  }
  return parsed;
}

function parseContent(row: WalmartListingIntegrityRemediationHistoryRow): ReusableContent | null {
  if (typeof row.changeSummary !== "string" || !row.changeSummary.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.changeSummary); } catch { return null; }
  if (!isRecord(parsed) || !isRecord(parsed.content)) return null;
  const content = parsed.content;
  const feedStatus = nullableText(row.feedStatus, "remediation.feedStatus", 64);
  if (feedStatus !== "SUBMITTED" && feedStatus !== "PROCESSED") return null;
  const main = httpsUrl(content.mainImageUrl);
  const gallery = Array.isArray(content.productSecondaryImageURL)
    ? content.productSecondaryImageURL.map(httpsUrl).filter((url): url is string => !!url).slice(0, 99)
    : [];
  const productName = contentText(content.productName, 10_000);
  const description = contentText(content.shortDescription, 100_000);
  const bullets = stringList(content.keyFeatures);
  const contentKeys = new Set([
    "productName", "shortDescription", "keyFeatures", "mainImageUrl",
    "productSecondaryImageURL", "multipackQuantity",
  ]);
  const attributes = Object.fromEntries(
    Object.entries(content).filter(([key]) => !contentKeys.has(key)),
  );
  if (!main && gallery.length === 0 && !productName && !description
    && bullets.length === 0 && Object.keys(attributes).length === 0) return null;
  return {
    run_at: timestamp(row.runAt, "remediation.runAt"),
    feed_status: feedStatus,
    transport_state: feedStatus === "PROCESSED"
      ? "PROCESSED_NOT_BUYER_VERIFIED"
      : "SUBMITTED_NOT_BUYER_VERIFIED",
    product_name: productName,
    description,
    bullets,
    attributes,
    main_image_url: main,
    gallery_image_urls: gallery,
    explicit_outer_count: numeric(content.multipackQuantity),
  };
}

function remediationSort(
  left: WalmartListingIntegrityRemediationHistoryRow,
  right: WalmartListingIntegrityRemediationHistoryRow,
): number {
  const time = Date.parse(String(right.runAt)) - Date.parse(String(left.runAt));
  if (time) return time;
  return codeUnitCompare(String(right.id ?? ""), String(left.id ?? ""));
}

function deriveReusableEvidence(rows: WalmartListingIntegrityRemediationHistoryRow[]) {
  const ordered = [...rows].sort(remediationSort);
  const processedMainRow = ordered.find((row) => (
    Number(row.ok) === 1
    && (row.feedStatus === "APPLIED" || row.feedStatus === "PROCESSED")
    && !!httpsUrl(row.mainImageUrl)
  ));
  const content = ordered.map(parseContent).find((value): value is ReusableContent => !!value) ?? null;
  const processedUrl = processedMainRow ? httpsUrl(processedMainRow.mainImageUrl) : null;
  return {
    last_processed_main: processedMainRow && processedUrl ? {
      source_role: "last_applied_artifact" as const,
      url: processedUrl,
      run_at: timestamp(processedMainRow.runAt, "remediation.runAt"),
      feed_status: processedMainRow.feedStatus as "APPLIED" | "PROCESSED",
    } : null,
    last_sent_content: content,
  };
}

function sealCensusBody(
  body: Omit<WalmartListingIntegrityCatalogCensus, "census_id" | "body_sha256">,
): WalmartListingIntegrityCatalogCensus {
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  return {
    ...body,
    census_id: `census-${bodySha256.slice(0, 20)}`,
    body_sha256: bodySha256,
  };
}

export function buildWalmartListingIntegrityCatalogCensus(input: {
  store_index: number;
  captured_at: string;
  catalog_rows: WalmartListingIntegrityCatalogMirrorRow[];
  remediation_rows: WalmartListingIntegrityRemediationHistoryRow[];
}): WalmartListingIntegrityCatalogCensus {
  if (!Number.isSafeInteger(input.store_index) || input.store_index < 1) {
    throw new Error("store_index must be a positive integer");
  }
  const capturedAt = timestamp(input.captured_at, "captured_at");
  if (!Array.isArray(input.catalog_rows) || input.catalog_rows.length < 1
    || input.catalog_rows.length > 10_000) {
    throw new Error("catalog_rows must contain 1..10000 rows");
  }
  if (!Array.isArray(input.remediation_rows) || input.remediation_rows.length > 1_000_000) {
    throw new Error("remediation_rows must be a bounded array");
  }
  const historyBySku = new Map<string, WalmartListingIntegrityRemediationHistoryRow[]>();
  for (const [index, row] of input.remediation_rows.entries()) {
    const sku = text(row.sku, `remediation_rows[${index}].sku`, 500);
    const bucket = historyBySku.get(sku) ?? [];
    bucket.push(row);
    historyBySku.set(sku, bucket);
  }
  const seen = new Set<string>();
  const syncInstants = new Set<string>();
  const rows: CatalogCensusRow[] = input.catalog_rows.map((raw, index) => {
    const sku = text(raw.sku, `catalog_rows[${index}].sku`, 500);
    if (seen.has(sku)) throw new Error(`duplicate catalog SKU: ${sku}`);
    seen.add(sku);
    const catalogSyncedAt = timestamp(raw.syncedAt, `catalog_rows[${index}].syncedAt`);
    syncInstants.add(catalogSyncedAt);
    const itemId = nullableText(raw.itemId, `catalog_rows[${index}].itemId`, 100);
    const title = nullableText(raw.title, `catalog_rows[${index}].title`, 10_000);
    const publishedStatus = nullableText(
      raw.publishedStatus,
      `catalog_rows[${index}].publishedStatus`,
      100,
    );
    const lifecycleStatus = nullableText(
      raw.lifecycleStatus,
      `catalog_rows[${index}].lifecycleStatus`,
      100,
    );
    const reusable = deriveReusableEvidence(historyBySku.get(sku) ?? []);
    const titleOuter = title ? extractTitleOuterCountEvidence(title) : null;
    const deterministicFindings: string[] = [];
    if (titleOuter?.status === "AMBIGUOUS") {
      deterministicFindings.push("TITLE_OUTER_COUNT_AMBIGUOUS");
    }
    const sentOuter = reusable.last_sent_content?.explicit_outer_count ?? null;
    if (titleOuter?.status === "EXACT" && sentOuter !== null && sentOuter !== titleOuter.value) {
      deterministicFindings.push("TITLE_VS_SENT_CONTENT_OUTER_COUNT_CONFLICT");
    }
    const sentTitleOuter = reusable.last_sent_content?.product_name
      ? extractTitleOuterCountEvidence(reusable.last_sent_content.product_name)
      : null;
    if (titleOuter?.status === "EXACT" && sentTitleOuter?.status === "EXACT"
      && titleOuter.value !== sentTitleOuter.value) {
      deterministicFindings.push("CATALOG_TITLE_VS_SENT_TITLE_OUTER_COUNT_CONFLICT");
    }
    const reasonCodes: string[] = [];
    let disposition: WalmartListingIntegrityScanDisposition;
    let priority: number;
    if (!itemId || !title) {
      disposition = "BLOCKED_SOURCE";
      priority = 0;
      if (!itemId) reasonCodes.push("MISSING_ITEM_ID");
      if (!title) reasonCodes.push("MISSING_TITLE");
    } else if (lifecycleStatus !== "ACTIVE") {
      disposition = "DO_NOT_TOUCH";
      priority = 5;
      reasonCodes.push("LIFECYCLE_NOT_ACTIVE");
    } else if (publishedStatus !== "PUBLISHED") {
      disposition = "STATUS_REVIEW";
      priority = 2;
      reasonCodes.push("NOT_PUBLISHED");
    } else if (reusable.last_processed_main || reusable.last_sent_content?.main_image_url
      || reusable.last_sent_content?.gallery_image_urls.length) {
      disposition = "VISUAL_TRIAGE_READY";
      priority = deterministicFindings.length > 0 || titleOuter?.status === "EXACT" ? 0 : 1;
      reasonCodes.push("REUSABLE_IMAGE_EVIDENCE_AVAILABLE");
    } else {
      disposition = "SOURCE_ACQUISITION_REQUIRED";
      priority = 3;
      reasonCodes.push("BUYER_IMAGE_SOURCE_MISSING");
    }
    if (deterministicFindings.length) reasonCodes.push("DETERMINISTIC_CONFLICT_PRESENT");
    return {
      listing_key: `walmart:${input.store_index}:${sku}`,
      store_index: input.store_index,
      sku,
      item_id: itemId,
      title,
      published_status: publishedStatus,
      lifecycle_status: lifecycleStatus,
      catalog_synced_at: catalogSyncedAt,
      title_outer_count: titleOuter,
      reusable_evidence: {
        mirror_main_image_url: httpsUrl(raw.mainImageUrl),
        ...reusable,
        buyer_surface_verified: false as const,
      },
      deterministic_findings: [...new Set(deterministicFindings)].sort(codeUnitCompare),
      scan_disposition: disposition,
      scan_priority: priority,
      reason_codes: [...new Set(reasonCodes)].sort(codeUnitCompare),
    };
  }).sort((left, right) => codeUnitCompare(left.listing_key, right.listing_key));
  if (syncInstants.size !== 1) {
    throw new Error("WalmartCatalogItem mirror is not one atomic catalog snapshot");
  }
  const dispositionCounts: Record<WalmartListingIntegrityScanDisposition, number> = {
    VISUAL_TRIAGE_READY: 0,
    SOURCE_ACQUISITION_REQUIRED: 0,
    STATUS_REVIEW: 0,
    BLOCKED_SOURCE: 0,
    DO_NOT_TOUCH: 0,
  };
  for (const row of rows) dispositionCounts[row.scan_disposition] += 1;
  return sealCensusBody({
    schema_version: WALMART_LISTING_INTEGRITY_CATALOG_CENSUS_SCHEMA,
    orchestrator_version: WALMART_LISTING_INTEGRITY_CATALOG_ORCHESTRATOR_VERSION,
    captured_at: capturedAt,
    store_index: input.store_index,
    source_contract: {
      catalog_population: "WalmartCatalogItem compatibility mirror",
      remediation_history: "WalmartListingRemediation immutable history",
      authority: "READ_ONLY_PROVISIONAL_NOT_BUYER_VERIFIED",
      may_issue_pass: false,
      may_authorize_walmart_write: false,
    },
    reconciliation: {
      catalog_rows: input.catalog_rows.length,
      distinct_skus: seen.size,
      duplicate_skus: 0,
      output_rows: rows.length,
      exact_once: true,
      catalog_synced_at: [...syncInstants][0]!,
    },
    summary: {
      total: rows.length,
      published: rows.filter((row) => row.published_status === "PUBLISHED").length,
      active: rows.filter((row) => row.lifecycle_status === "ACTIVE").length,
      with_item_id: rows.filter((row) => !!row.item_id).length,
      with_title: rows.filter((row) => !!row.title).length,
      with_reusable_main: rows.filter((row) => !!row.reusable_evidence.last_processed_main).length,
      with_reusable_gallery: rows.filter((row) => (
        (row.reusable_evidence.last_sent_content?.gallery_image_urls.length ?? 0) > 0
      )).length,
      deterministic_conflicts: rows.filter((row) => row.deterministic_findings.length > 0).length,
      disposition_counts: dispositionCounts,
    },
    external_effects: {
      database_reads: 2,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
      model_calls: 0,
      paid_api_calls: 0,
    },
    rows,
  });
}

function taskId(task: Omit<WalmartListingIntegrityScanTask, "task_id">): string {
  return `image-${walmartListingIntegrityCatalogSha256(task).slice(0, 20)}`;
}

function imageTasks(census: WalmartListingIntegrityCatalogCensus): WalmartListingIntegrityScanTask[] {
  const tasks: WalmartListingIntegrityScanTask[] = [];
  for (const row of census.rows) {
    if (row.scan_disposition !== "VISUAL_TRIAGE_READY") continue;
    const processed = row.reusable_evidence.last_processed_main;
    const sent = row.reusable_evidence.last_sent_content;
    const mainUrl = processed?.url ?? sent?.main_image_url ?? null;
    if (mainUrl) {
      const body = {
        listing_key: row.listing_key,
        sku: row.sku,
        slot: "main" as const,
        source_role: processed
          ? "last_applied_artifact" as const
          : "last_sent_main" as const,
        url: mainUrl,
        priority: row.scan_priority,
      };
      tasks.push({ task_id: taskId(body), ...body });
    }
    for (const [index, url] of (sent?.gallery_image_urls ?? []).entries()) {
      const body = {
        listing_key: row.listing_key,
        sku: row.sku,
        slot: `gallery-${index + 1}` as `gallery-${number}`,
        source_role: "last_sent_gallery" as const,
        url,
        priority: row.scan_priority,
      };
      tasks.push({ task_id: taskId(body), ...body });
    }
  }
  return tasks.sort((left, right) => (
    left.priority - right.priority
    || codeUnitCompare(left.listing_key, right.listing_key)
    || codeUnitCompare(left.slot, right.slot)
  ));
}

function sealPlanBody(
  body: Omit<WalmartListingIntegrityScanPlan, "plan_id" | "body_sha256">,
): WalmartListingIntegrityScanPlan {
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  return {
    ...body,
    plan_id: `scan-plan-${bodySha256.slice(0, 20)}`,
    body_sha256: bodySha256,
  };
}

export function buildWalmartListingIntegrityScanPlan(
  census: WalmartListingIntegrityCatalogCensus,
): WalmartListingIntegrityScanPlan {
  if (census.schema_version !== WALMART_LISTING_INTEGRITY_CATALOG_CENSUS_SCHEMA) {
    throw new Error("unsupported census schema");
  }
  const tasks = imageTasks(census);
  const partitions: WalmartListingIntegrityScanPlan["partitions"] = [];
  const listingGroups: WalmartListingIntegrityScanTask[][] = [];
  for (const task of tasks) {
    const current = listingGroups.at(-1);
    if (!current || current[0].listing_key !== task.listing_key) {
      listingGroups.push([task]);
    }
    else current.push(task);
  }
  if (listingGroups.some((group) => (
    group.length > WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION
  ))) {
    throw new Error("one listing exceeds the bounded visual partition capacity");
  }
  const groupedPartitions: WalmartListingIntegrityScanTask[][] = [];
  for (const listingTasks of listingGroups) {
    const current = groupedPartitions.at(-1);
    if (!current
      || current.length + listingTasks.length > WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION) {
      groupedPartitions.push([...listingTasks]);
    }
    else current.push(...listingTasks);
  }
  for (const partitionTasks of groupedPartitions) {
    const partitionIndex = partitions.length;
    const partitionIdentity = {
      partition_index: partitionIndex,
      task_ids: partitionTasks.map((task) => task.task_id),
    };
    partitions.push({
      partition_id: `partition-${String(partitionIndex).padStart(6, "0")}-${walmartListingIntegrityCatalogSha256(partitionIdentity).slice(0, 16)}`,
      partition_index: partitionIndex,
      task_count: partitionTasks.length,
      estimated_model_calls_max: Math.ceil(
        partitionTasks.length / WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_CALL,
      ),
      tasks: partitionTasks,
    });
  }
  const sourceAcquisition = census.rows.filter((row) => (
    row.scan_disposition === "SOURCE_ACQUISITION_REQUIRED"
    || row.scan_disposition === "BLOCKED_SOURCE"
  )).map((row) => row.listing_key);
  return sealPlanBody({
    schema_version: WALMART_LISTING_INTEGRITY_SCAN_PLAN_SCHEMA,
    orchestrator_version: WALMART_LISTING_INTEGRITY_CATALOG_ORCHESTRATOR_VERSION,
    census_body_sha256: census.body_sha256,
    created_at: census.captured_at,
    store_index: census.store_index,
    policy: {
      mode: "READ_ONLY_TRIAGE",
      images_per_call_max: WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_CALL,
      calls_per_partition_max: WALMART_LISTING_INTEGRITY_MAX_CALLS_PER_PARTITION,
      images_per_partition_max: WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION,
      buyer_verified_pass_allowed: false,
      walmart_writes_allowed: false,
    },
    coverage: {
      catalog_listings: census.rows.length,
      listings_with_visual_tasks: new Set(tasks.map((task) => task.listing_key)).size,
      listings_requiring_source_acquisition: sourceAcquisition.length,
      visual_tasks: tasks.length,
      partitions: partitions.length,
      estimated_model_calls_max: partitions.reduce(
        (sum, partition) => sum + partition.estimated_model_calls_max,
        0,
      ),
    },
    source_acquisition_listing_keys: sourceAcquisition,
    partitions,
  });
}

export function verifyWalmartListingIntegrityCatalogArtifacts(input: {
  census: WalmartListingIntegrityCatalogCensus;
  plan: WalmartListingIntegrityScanPlan;
}): { verified: true; listings: number; tasks: number; partitions: number } {
  const { census, plan } = input;
  const censusBody = { ...census } as Partial<WalmartListingIntegrityCatalogCensus>;
  delete censusBody.census_id;
  delete censusBody.body_sha256;
  const censusSha = walmartListingIntegrityCatalogSha256(censusBody);
  if (censusSha !== census.body_sha256
    || census.census_id !== `census-${censusSha.slice(0, 20)}`) {
    throw new Error("census seal mismatch");
  }
  const rebuiltPlan = buildWalmartListingIntegrityScanPlan(census);
  if (canonicalJson(rebuiltPlan) !== canonicalJson(plan)) {
    throw new Error("scan plan does not rebuild exactly from census");
  }
  const allTasks = plan.partitions.flatMap((partition) => partition.tasks);
  if (new Set(allTasks.map((task) => task.task_id)).size !== allTasks.length) {
    throw new Error("scan plan contains duplicate tasks");
  }
  if (plan.partitions.some((partition) => (
    partition.task_count !== partition.tasks.length
    || partition.task_count > WALMART_LISTING_INTEGRITY_MAX_IMAGES_PER_PARTITION
    || partition.estimated_model_calls_max > WALMART_LISTING_INTEGRITY_MAX_CALLS_PER_PARTITION
  ))) {
    throw new Error("scan plan partition bounds are invalid");
  }
  const partitionByListing = new Map<string, string>();
  for (const partition of plan.partitions) {
    for (const task of partition.tasks) {
      const previous = partitionByListing.get(task.listing_key);
      if (previous && previous !== partition.partition_id) {
        throw new Error("scan plan splits one listing across multiple partitions");
      }
      partitionByListing.set(task.listing_key, partition.partition_id);
    }
  }
  return {
    verified: true,
    listings: census.rows.length,
    tasks: allTasks.length,
    partitions: plan.partitions.length,
  };
}
