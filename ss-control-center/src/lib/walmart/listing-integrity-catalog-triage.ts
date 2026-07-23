import {
  BLIND_PROMPT_VERSION,
  buildBlindObservationPrompt,
  normalizeVisibleText,
  type BlindObservation,
  type ImageSlot,
} from "./catalog-visual-audit.ts";
import {
  walmartListingObservationCallKey,
  walmartListingObservationImageId,
  walmartListingObservationSha256,
  type WalmartListingObservationImageBinding,
  type WalmartListingObservationWorkerContract,
} from "./listing-integrity-observation.ts";
import { createHash } from "node:crypto";
import type {
  WalmartListingIntegrityCatalogCensus,
  WalmartListingIntegrityScanPlan,
  WalmartListingIntegrityScanTask,
} from "./listing-integrity-catalog-orchestrator.ts";

export const WALMART_LISTING_CATALOG_TRIAGE_PLAN_SCHEMA =
  "walmart-listing-integrity-catalog-triage-plan/v2" as const;
export const WALMART_LISTING_CATALOG_TRIAGE_REPORT_SCHEMA =
  "walmart-listing-integrity-catalog-triage-report/v2" as const;
export const WALMART_LISTING_CATALOG_TRIAGE_VERSION =
  "walmart-listing-integrity-catalog-triage/v2" as const;
export const WALMART_LISTING_CATALOG_TRIAGE_MAX_IMAGES_PER_CALL = 6;
export const WALMART_LISTING_CATALOG_TRIAGE_MAX_CALLS = 6;

type JsonRecord = Record<string, unknown>;

export type WalmartListingCatalogTriageStatus =
  | "SUSPECTED_BAD"
  | "REVIEW_REQUIRED"
  | "NO_DEFECT_OBSERVED_NOT_PASS";

export interface WalmartListingCatalogTriagePreparedAsset {
  task: WalmartListingIntegrityScanTask;
  source_asset_sha256: string;
  model_asset: {
    path: string;
    sha256: string;
    bytes: number;
    media_type: "image/jpeg" | "image/png";
    width: number;
    height: number;
  };
}

interface WalmartListingCatalogTriageListingTruth {
  listing_key: string;
  sku: string;
  item_id: string;
  title: string;
  title_outer_count: number | null;
  deterministic_findings: string[];
  evidence_authority: "READ_ONLY_PROVISIONAL_NOT_BUYER_VERIFIED";
}

export interface WalmartListingCatalogTriagePlan {
  schema_version: typeof WALMART_LISTING_CATALOG_TRIAGE_PLAN_SCHEMA;
  triage_version: typeof WALMART_LISTING_CATALOG_TRIAGE_VERSION;
  body_sha256: string;
  created_at: string;
  source_binding: {
    census_file_sha256: string;
    census_body_sha256: string;
    scan_plan_file_sha256: string;
    scan_plan_body_sha256: string;
    capture_index_file_sha256: string;
    capture_index_body_sha256: string;
    partition_id: string;
  };
  policy: {
    mode: "READ_ONLY_VISUAL_TRIAGE";
    images_per_call_max: 6;
    calls_max: 6;
    retries: 0;
    fallbacks: 0;
    paid_api_calls: 0;
    walmart_reads: 0;
    walmart_writes: 0;
    database_writes: 0;
    may_issue_pass: false;
    may_prepare_repair: false;
  };
  policy_sha256: string;
  scope_sha256: string;
  worker_contract: WalmartListingObservationWorkerContract;
  listings: WalmartListingCatalogTriageListingTruth[];
  assets: Array<WalmartListingCatalogTriagePreparedAsset & {
    image_id: string;
    binding: WalmartListingObservationImageBinding;
  }>;
  calls: Array<{
    call_index: number;
    shard_id: string;
    call_key: string;
    prompt_version: typeof BLIND_PROMPT_VERSION;
    /** Exact UTF-8 prompt submitted to the worker; sealed into the immutable plan. */
    prompt: string;
    prompt_sha256: string;
    image_ids: string[];
    model_asset_paths: string[];
    request_character_estimate: number;
  }>;
}

export interface WalmartListingCatalogTriageFinding {
  code:
    | "DETERMINISTIC_CATALOG_CONFLICT"
    | "MAIN_QUANTITY_MISMATCH"
    | "MAIN_MULTIPLE_DISTINCT_PRODUCTS"
    | "VISIBLE_BRAND_NOT_IN_TITLE"
    | "VISIBLE_PRODUCT_NOT_IN_TITLE"
    | "GALLERY_BRAND_DRIFT"
    | "MAIN_NOT_AVAILABLE_IN_PARTITION"
    | "MAIN_IDENTITY_UNREADABLE"
    | "MAIN_QUANTITY_UNVERIFIED";
  severity: "SUSPECTED_BAD" | "REVIEW";
  image_ids: string[];
  evidence: string;
}

export interface WalmartListingCatalogTriageListingResult {
  listing_key: string;
  sku: string;
  item_id: string;
  title: string;
  status: WalmartListingCatalogTriageStatus;
  findings: WalmartListingCatalogTriageFinding[];
  image_ids: string[];
  limitations: string[];
}

export interface WalmartListingCatalogTriageReport {
  schema_version: typeof WALMART_LISTING_CATALOG_TRIAGE_REPORT_SCHEMA;
  triage_version: typeof WALMART_LISTING_CATALOG_TRIAGE_VERSION;
  plan_body_sha256: string;
  partition_id: string;
  policy: {
    buyer_surface_verified: false;
    pass_allowed: false;
    repair_allowed: false;
    walmart_writes: 0;
  };
  summary: {
    listings: number;
    suspected_bad: number;
    review_required: number;
    no_defect_observed_not_pass: number;
  };
  listings: WalmartListingCatalogTriageListingResult[];
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/")
    || value.includes("\\") || value.split("/").some((part) => part === ".." || !part)) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function seal<T extends JsonRecord>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingObservationSha256(body) };
}

function exactCount(row: WalmartListingIntegrityCatalogCensus["rows"][number]): number | null {
  return row.title_outer_count?.status === "EXACT" ? row.title_outer_count.value : null;
}

export function buildWalmartListingCatalogTriagePlan(input: {
  created_at: string;
  census: WalmartListingIntegrityCatalogCensus;
  census_file_sha256: string;
  scan_plan: WalmartListingIntegrityScanPlan;
  scan_plan_file_sha256: string;
  capture_index_file_sha256: string;
  capture_index_body_sha256: string;
  partition_id: string;
  prepared_assets: WalmartListingCatalogTriagePreparedAsset[];
  worker_contract: WalmartListingObservationWorkerContract;
  selected_listing_keys?: string[];
}): WalmartListingCatalogTriagePlan {
  digest(input.census_file_sha256, "census_file_sha256");
  digest(input.scan_plan_file_sha256, "scan_plan_file_sha256");
  digest(input.capture_index_file_sha256, "capture_index_file_sha256");
  digest(input.capture_index_body_sha256, "capture_index_body_sha256");
  const created = new Date(input.created_at);
  if (!Number.isFinite(created.getTime()) || created.toISOString() !== input.created_at) {
    throw new Error("created_at must be canonical UTC ISO-8601");
  }
  const partition = input.scan_plan.partitions.find((row) => row.partition_id === input.partition_id);
  if (!partition) throw new Error("partition is absent from the sealed scan plan");
  if (partition.estimated_model_calls_max > WALMART_LISTING_CATALOG_TRIAGE_MAX_CALLS) {
    throw new Error("partition exceeds the triage call cap");
  }
  const selectedListingKeys = input.selected_listing_keys
    ? [...new Set(input.selected_listing_keys)]
    : [...new Set(partition.tasks.map((task) => task.listing_key))];
  if (!selectedListingKeys.length
    || selectedListingKeys.length !== (input.selected_listing_keys?.length ?? selectedListingKeys.length)) {
    throw new Error("selected listing keys must be non-empty and unique");
  }
  const partitionListingKeys = new Set(partition.tasks.map((task) => task.listing_key));
  if (selectedListingKeys.some((listingKey) => !partitionListingKeys.has(listingKey))) {
    throw new Error("selected listing is absent from the partition");
  }
  const selectedSet = new Set(selectedListingKeys);
  const selectedTasks = partition.tasks.filter((task) => selectedSet.has(task.listing_key));
  if (input.prepared_assets.length !== selectedTasks.length
    || input.prepared_assets.some((asset, index) => (
      JSON.stringify(asset.task) !== JSON.stringify(selectedTasks[index])
    ))) {
    throw new Error("prepared assets differ from the exact partition task order");
  }
  const listingKeys = [...new Set(selectedTasks.map((task) => task.listing_key))];
  const censusByKey = new Map(input.census.rows.map((row) => [row.listing_key, row]));
  const listings = listingKeys.map((listingKey) => {
    const row = censusByKey.get(listingKey);
    if (!row || !row.item_id || !row.title) {
      throw new Error(`${listingKey} lacks title/item identity in the census`);
    }
    return {
      listing_key: row.listing_key,
      sku: row.sku,
      item_id: row.item_id,
      title: row.title,
      title_outer_count: exactCount(row),
      deterministic_findings: [...row.deterministic_findings],
      evidence_authority: "READ_ONLY_PROVISIONAL_NOT_BUYER_VERIFIED" as const,
    };
  });
  const listingByKey = new Map(listings.map((row) => [row.listing_key, row]));
  const assets = input.prepared_assets.map((asset, index) => {
    digest(asset.source_asset_sha256, `prepared_assets[${index}].source_asset_sha256`);
    digest(asset.model_asset.sha256, `prepared_assets[${index}].model_asset.sha256`);
    safeRelativePath(asset.model_asset.path, `prepared_assets[${index}].model_asset.path`);
    positiveInteger(asset.model_asset.bytes, `prepared_assets[${index}].model_asset.bytes`);
    positiveInteger(asset.model_asset.width, `prepared_assets[${index}].model_asset.width`);
    positiveInteger(asset.model_asset.height, `prepared_assets[${index}].model_asset.height`);
    const listing = listingByKey.get(asset.task.listing_key);
    if (!listing || listing.sku !== asset.task.sku) {
      throw new Error(`prepared_assets[${index}] listing identity mismatch`);
    }
    const binding: WalmartListingObservationImageBinding = {
      listing_key: listing.listing_key,
      item_id: listing.item_id,
      slot: asset.task.slot as ImageSlot,
      asset_sha256: asset.source_asset_sha256,
      model_view_sha256: asset.model_asset.sha256,
      image_id: walmartListingObservationImageId(
        asset.source_asset_sha256,
        asset.task.slot as ImageSlot,
        listing.listing_key,
      ),
    };
    return { ...asset, image_id: binding.image_id, binding };
  });
  if (new Set(assets.map((asset) => asset.image_id)).size !== assets.length) {
    throw new Error("triage image IDs are not unique");
  }
  const policy = {
    mode: "READ_ONLY_VISUAL_TRIAGE" as const,
    images_per_call_max: 6 as const,
    calls_max: 6 as const,
    retries: 0 as const,
    fallbacks: 0 as const,
    paid_api_calls: 0 as const,
    walmart_reads: 0 as const,
    walmart_writes: 0 as const,
    database_writes: 0 as const,
    may_issue_pass: false as const,
    may_prepare_repair: false as const,
  };
  const sourceBinding = {
    census_file_sha256: input.census_file_sha256,
    census_body_sha256: input.census.body_sha256,
    scan_plan_file_sha256: input.scan_plan_file_sha256,
    scan_plan_body_sha256: input.scan_plan.body_sha256,
    capture_index_file_sha256: input.capture_index_file_sha256,
    capture_index_body_sha256: input.capture_index_body_sha256,
    partition_id: input.partition_id,
  };
  const policySha256 = walmartListingObservationSha256(policy);
  const scopeSha256 = walmartListingObservationSha256({
    source_binding: sourceBinding,
    policy_sha256: policySha256,
    listings,
    assets,
  });
  const calls = [];
  for (let offset = 0; offset < assets.length; offset += WALMART_LISTING_CATALOG_TRIAGE_MAX_IMAGES_PER_CALL) {
    const callAssets = assets.slice(offset, offset + WALMART_LISTING_CATALOG_TRIAGE_MAX_IMAGES_PER_CALL);
    const callIndex = calls.length;
    const imageIds = callAssets.map((asset) => asset.image_id);
    const shardId = `catalog-triage-${String(callIndex).padStart(2, "0")}-${walmartListingObservationSha256(imageIds).slice(0, 16)}`;
    const prompt = buildBlindObservationPrompt(imageIds);
    const promptSha256 = textSha256(prompt);
    const bindings = callAssets.map((asset) => asset.binding);
    const callKey = walmartListingObservationCallKey({
      run_lock_sha256: scopeSha256,
      shard_id: shardId,
      call_index: callIndex,
      worker_contract: input.worker_contract,
      prompt_sha256: promptSha256,
      image_bindings: bindings,
    });
    const promptCharacters = prompt.length;
    const imageCharacters = callAssets.reduce((sum, asset) => (
      sum + Math.ceil(asset.model_asset.bytes / 3) * 4
    ), 0);
    calls.push({
      call_index: callIndex,
      shard_id: shardId,
      call_key: callKey,
      prompt_version: BLIND_PROMPT_VERSION,
      prompt,
      prompt_sha256: promptSha256,
      image_ids: imageIds,
      model_asset_paths: callAssets.map((asset) => asset.model_asset.path),
      request_character_estimate: promptCharacters + imageCharacters + 20_000,
    });
  }
  if (calls.length > WALMART_LISTING_CATALOG_TRIAGE_MAX_CALLS
    || calls.some((call) => call.image_ids.length > WALMART_LISTING_CATALOG_TRIAGE_MAX_IMAGES_PER_CALL
      || call.request_character_estimate > 20_000_000)) {
    throw new Error("prepared triage calls exceed worker bounds");
  }
  return seal({
    schema_version: WALMART_LISTING_CATALOG_TRIAGE_PLAN_SCHEMA,
    triage_version: WALMART_LISTING_CATALOG_TRIAGE_VERSION,
    created_at: input.created_at,
    source_binding: sourceBinding,
    policy,
    policy_sha256: policySha256,
    scope_sha256: scopeSha256,
    worker_contract: input.worker_contract,
    listings,
    assets,
    calls,
  }) as WalmartListingCatalogTriagePlan;
}

export function verifyWalmartListingCatalogTriagePlan(
  plan: WalmartListingCatalogTriagePlan,
): { verified: true; listings: number; images: number; calls: number } {
  if (plan.schema_version !== WALMART_LISTING_CATALOG_TRIAGE_PLAN_SCHEMA
    || plan.triage_version !== WALMART_LISTING_CATALOG_TRIAGE_VERSION) {
    throw new Error("unsupported catalog triage plan schema/version");
  }
  const body = { ...plan } as Partial<WalmartListingCatalogTriagePlan>;
  delete body.body_sha256;
  if (walmartListingObservationSha256(body) !== plan.body_sha256
    || walmartListingObservationSha256(plan.policy) !== plan.policy_sha256) {
    throw new Error("catalog triage plan seal mismatch");
  }
  if (plan.policy.mode !== "READ_ONLY_VISUAL_TRIAGE"
    || plan.policy.walmart_writes !== 0
    || plan.policy.database_writes !== 0
    || plan.policy.may_issue_pass !== false
    || plan.policy.may_prepare_repair !== false
    || plan.policy.retries !== 0
    || plan.policy.fallbacks !== 0
    || plan.policy.paid_api_calls !== 0) {
    throw new Error("catalog triage plan policy is unsafe");
  }
  if (walmartListingObservationSha256({
    source_binding: plan.source_binding,
    policy_sha256: plan.policy_sha256,
    listings: plan.listings,
    assets: plan.assets,
  }) !== plan.scope_sha256) {
    throw new Error("catalog triage scope seal mismatch");
  }
  if (plan.calls.length < 1 || plan.calls.length > WALMART_LISTING_CATALOG_TRIAGE_MAX_CALLS
    || new Set(plan.assets.map((asset) => asset.image_id)).size !== plan.assets.length
    || new Set(plan.listings.map((listing) => listing.listing_key)).size !== plan.listings.length) {
    throw new Error("catalog triage plan population is invalid");
  }
  const assetByImage = new Map(plan.assets.map((asset) => [asset.image_id, asset]));
  const called = plan.calls.flatMap((call) => call.image_ids);
  if (called.length !== plan.assets.length
    || new Set(called).size !== called.length
    || called.some((imageId, index) => imageId !== plan.assets[index].image_id)) {
    throw new Error("catalog triage calls do not cover exact assets in order");
  }
  for (const call of plan.calls) {
    if (call.image_ids.length < 1 || call.image_ids.length > WALMART_LISTING_CATALOG_TRIAGE_MAX_IMAGES_PER_CALL
      || call.prompt_version !== BLIND_PROMPT_VERSION
      || typeof call.prompt !== "string"
      || call.prompt.length < 1
      || call.prompt.length > 200_000
      || call.prompt_sha256 !== textSha256(call.prompt)
      || !call.prompt.startsWith(`Prompt version: ${call.prompt_version}.`)
      || call.image_ids.some((imageId, index) => (
        !call.prompt.includes(`attached image ${index + 1} -> ${imageId}`)
      ))
      || call.model_asset_paths.some((pathname, index) => (
        pathname !== assetByImage.get(call.image_ids[index])?.model_asset.path
      ))) {
      throw new Error(`catalog triage call ${call.call_index} shape is invalid`);
    }
    const bindings = call.image_ids.map((imageId) => assetByImage.get(imageId)?.binding);
    if (bindings.some((binding) => !binding)
      || call.call_key !== walmartListingObservationCallKey({
        run_lock_sha256: plan.scope_sha256,
        shard_id: call.shard_id,
        call_index: call.call_index,
        worker_contract: plan.worker_contract,
        prompt_sha256: call.prompt_sha256,
        image_bindings: bindings as WalmartListingObservationImageBinding[],
      })) {
      throw new Error(`catalog triage call ${call.call_index} binding is invalid`);
    }
  }
  return { verified: true, listings: plan.listings.length, images: plan.assets.length, calls: plan.calls.length };
}

const IDENTITY_STOPWORDS = new Set([
  "and", "the", "with", "for", "from", "of", "a", "an", "pack", "packs",
  "count", "ct", "each", "size", "new", "original", "flavor", "flavored",
]);

function identityTokens(value: string | null): string[] {
  if (!value) return [];
  return normalizeVisibleText(value).split(" ").filter((token) => (
    token.length >= 3 && !IDENTITY_STOPWORDS.has(token) && !/^\d+$/u.test(token)
  ));
}

function phraseSupportedByTitle(titleTokens: Set<string>, phrase: string | null): boolean | null {
  const tokens = identityTokens(phrase);
  if (!tokens.length) return null;
  return tokens.some((token) => titleTokens.has(token));
}

function pushFinding(
  findings: WalmartListingCatalogTriageFinding[],
  finding: WalmartListingCatalogTriageFinding,
): void {
  const identity = `${finding.code}:${finding.image_ids.join(",")}:${finding.evidence}`;
  if (!findings.some((existing) => (
    `${existing.code}:${existing.image_ids.join(",")}:${existing.evidence}` === identity
  ))) findings.push(finding);
}

export function adjudicateWalmartListingCatalogTriage(input: {
  plan: WalmartListingCatalogTriagePlan;
  observations: BlindObservation[];
}): WalmartListingCatalogTriageReport {
  verifyWalmartListingCatalogTriagePlan(input.plan);
  const expectedIds = input.plan.assets.map((asset) => asset.image_id);
  const observationById = new Map(input.observations.map((row) => [row.image_id, row]));
  if (input.observations.length !== expectedIds.length
    || observationById.size !== expectedIds.length
    || expectedIds.some((imageId) => !observationById.has(imageId))) {
    throw new Error("triage observations must cover every planned image exactly once");
  }
  const results = input.plan.listings.map((listing) => {
    const listingAssets = input.plan.assets.filter((asset) => (
      asset.task.listing_key === listing.listing_key
    ));
    const rows = listingAssets.map((asset) => ({
      asset,
      observation: observationById.get(asset.image_id)!,
    }));
    const findings: WalmartListingCatalogTriageFinding[] = [];
    for (const deterministic of listing.deterministic_findings) {
      pushFinding(findings, {
        code: "DETERMINISTIC_CATALOG_CONFLICT",
        severity: "SUSPECTED_BAD",
        image_ids: [],
        evidence: deterministic,
      });
    }
    const titleTokens = new Set(identityTokens(listing.title));
    for (const { asset, observation } of rows) {
      const brandSupported = phraseSupportedByTitle(titleTokens, observation.visible_brand_text);
      const productSupported = phraseSupportedByTitle(titleTokens, observation.visible_product_text);
      if (observation.readable_identity === "clear" && brandSupported === false) {
        pushFinding(findings, {
          code: "VISIBLE_BRAND_NOT_IN_TITLE",
          severity: "SUSPECTED_BAD",
          image_ids: [asset.image_id],
          evidence: `visible brand ${JSON.stringify(observation.visible_brand_text)} is absent from title`,
        });
      }
      if (observation.readable_identity === "clear" && productSupported === false) {
        pushFinding(findings, {
          code: "VISIBLE_PRODUCT_NOT_IN_TITLE",
          severity: brandSupported === false ? "SUSPECTED_BAD" : "REVIEW",
          image_ids: [asset.image_id],
          evidence: `visible product ${JSON.stringify(observation.visible_product_text)} is absent from title`,
        });
      }
    }
    const main = rows.find((row) => row.asset.task.slot === "main");
    if (!main) {
      pushFinding(findings, {
        code: "MAIN_NOT_AVAILABLE_IN_PARTITION",
        severity: "REVIEW",
        image_ids: [],
        evidence: "the partition has no MAIN image for this listing",
      });
    }
    else {
      const observation = main.observation;
      if (observation.multiple_distinct_products === "yes") {
        pushFinding(findings, {
          code: "MAIN_MULTIPLE_DISTINCT_PRODUCTS",
          severity: "SUSPECTED_BAD",
          image_ids: [main.asset.image_id],
          evidence: "MAIN visibly contains multiple distinct products",
        });
      }
      if (observation.readable_identity === "none") {
        pushFinding(findings, {
          code: "MAIN_IDENTITY_UNREADABLE",
          severity: "REVIEW",
          image_ids: [main.asset.image_id],
          evidence: "MAIN product identity is not readable",
        });
      }
      if (listing.title_outer_count !== null) {
        const visible = observation.external_package_count;
        if (visible.mode === "exact" && visible.value !== listing.title_outer_count) {
          pushFinding(findings, {
            code: "MAIN_QUANTITY_MISMATCH",
            severity: "SUSPECTED_BAD",
            image_ids: [main.asset.image_id],
            evidence: `title expects ${listing.title_outer_count}; MAIN visibly shows ${visible.value}`,
          });
        }
        else if (visible.mode !== "exact") {
          pushFinding(findings, {
            code: "MAIN_QUANTITY_UNVERIFIED",
            severity: "REVIEW",
            image_ids: [main.asset.image_id],
            evidence: `title expects ${listing.title_outer_count}; MAIN outer count is ${visible.mode}`,
          });
        }
      }
    }
    const clearBrands = rows.flatMap(({ asset, observation }) => (
      observation.readable_identity === "clear" && observation.visible_brand_text
        ? [{ imageId: asset.image_id, brand: normalizeVisibleText(observation.visible_brand_text) }]
        : []
    ));
    const brandGroups = new Map<string, string[]>();
    for (const row of clearBrands) {
      const ids = brandGroups.get(row.brand) ?? [];
      ids.push(row.imageId);
      brandGroups.set(row.brand, ids);
    }
    if (brandGroups.size > 1) {
      pushFinding(findings, {
        code: "GALLERY_BRAND_DRIFT",
        severity: "SUSPECTED_BAD",
        image_ids: clearBrands.map((row) => row.imageId),
        evidence: `gallery exposes multiple brands: ${[...brandGroups.keys()].join(" | ")}`,
      });
    }
    const status: WalmartListingCatalogTriageStatus = findings.some((finding) => (
      finding.severity === "SUSPECTED_BAD"
    ))
      ? "SUSPECTED_BAD"
      : findings.length
        ? "REVIEW_REQUIRED"
        : "NO_DEFECT_OBSERVED_NOT_PASS";
    return {
      listing_key: listing.listing_key,
      sku: listing.sku,
      item_id: listing.item_id,
      title: listing.title,
      status,
      findings,
      image_ids: rows.map((row) => row.asset.image_id),
      limitations: [
        "Historical sent/applied image evidence is not a fresh buyer-facing Walmart reread.",
        "NO_DEFECT_OBSERVED_NOT_PASS is a triage outcome and can never qualify a listing as PASS.",
        "No repair or Walmart mutation is authorized by this report.",
      ],
    };
  });
  return {
    schema_version: WALMART_LISTING_CATALOG_TRIAGE_REPORT_SCHEMA,
    triage_version: WALMART_LISTING_CATALOG_TRIAGE_VERSION,
    plan_body_sha256: input.plan.body_sha256,
    partition_id: input.plan.source_binding.partition_id,
    policy: {
      buyer_surface_verified: false,
      pass_allowed: false,
      repair_allowed: false,
      walmart_writes: 0,
    },
    summary: {
      listings: results.length,
      suspected_bad: results.filter((row) => row.status === "SUSPECTED_BAD").length,
      review_required: results.filter((row) => row.status === "REVIEW_REQUIRED").length,
      no_defect_observed_not_pass: results.filter((row) => (
        row.status === "NO_DEFECT_OBSERVED_NOT_PASS"
      )).length,
    },
    listings: results,
  };
}
