/**
 * Pure, read-only planning primitives for the live Uncrustables gallery repair.
 *
 * Input is deliberately limited to the sealed live-gallery fetch and its
 * human visual audit. No historical donor manifest, database state, R2 state,
 * or future `verified` flag participates in selection.
 */

import {
  selectBalancedGallery,
  type GalleryComponentCandidates,
  type ValidatedGalleryCandidate,
} from "./uncrustables-product-gallery";

export const LIVE_GALLERY_SURGICAL_PLAN_SCHEMA =
  "uncrustables-live-gallery-surgical-plan/v1.0" as const;

export const LIVE_GALLERY_FIXED_CARD = {
  url: "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg",
  sha256: "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb",
} as const;

export const LIVE_GALLERY_DISALLOWED_SHA256 = new Set([
  // Cross-flavor "A flavor for every weekday" collage.
  "c853706f6c23c5fa5b686d0c57947130b7ea0e9d726f76f0f0a60869fb9c1ea1",
  // "Only at Target" lifestyle creative.
  "8618f3c2f1b432e5ce3e3ca051d932effee4390716214c2879c11a08fb12d9f4",
  // Nutrition panel found in the three incorrect GALLERY_1 slots. It has
  // audit policy issues and is excluded entirely from this surgical pool.
  "f63f70d84b9aed42c3ced1ad85d7f1e54c3bb804e54d4aadd702a14b3d3dcbf4",
]);

/**
 * Visually reviewed, flavor-neutral context assets. The order is the stable
 * fallback priority. Product-specific imagery is always selected first, and
 * these assets are used only to reach the four-image minimum.
 */
export const LIVE_GALLERY_SHARED_FALLBACK_PRIORITY = [
  "09e96cd0c9e270c588d480e2232a5d69115f0b75748edfc5278873044831ef3e",
  "eca4b46ee9583ea5836574ac88816536a3314ab27ec6b9944ed7ea7f762c8f9f",
  "43e494be94fc441ea3f6467c15bb2f4731304b54abed318d6dadefe49318167f",
  "668d4486eeef1366970855fc3bf2e538aa50aba3a477ea5dea17b062bb27e0e9",
] as const;

const SHARED_FALLBACK_SHA256 = new Set<string>(
  LIVE_GALLERY_SHARED_FALLBACK_PRIORITY,
);

export interface LiveGalleryVisualAsset {
  sha256: string;
  exact_urls: string[];
  local_path: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
  classification:
    | "KEEP_SHARED"
    | "WRONG_SLOT_OR_COPY"
    | "RECIPE_SPECIFIC_NEEDS_MAPPING"
    | "LOW_QUALITY/INVALID";
  visual_subject: string;
  source_primary_recipe_keys: string[];
  policy_issues: string[];
  quality_warnings: string[];
  mapping_count: number;
  mappings: Array<{
    mapping_ordinal: number;
    sku: string;
    asin: string;
    slot: string;
  }>;
}

export interface LiveGalleryCurrentAsset {
  slot: string;
  url: string;
  sha256: string;
}

export interface LiveGallerySkuConclusion {
  ordinal: number;
  sku: string;
  asin: string;
  title: string | null;
  expected_total_units: number;
  expected_total_source: string;
  recipe_keys: string[];
  recipe_components: unknown[];
  secondary_image_count: number;
  product_image_count_excluding_approved_card: number;
  secondary_assets: LiveGalleryCurrentAsset[];
  conclusion: string;
  defects: unknown[];
}

export type PlannedGalleryAssetRole =
  | "FIXED_PRICE_THANK_YOU_CARD"
  | "EXACT_RECIPE_COMPONENT"
  | "FLAVOR_NEUTRAL_SHARED_CONTEXT";

export interface PlannedGalleryAsset {
  slot: `GALLERY_${number}`;
  slot_index: number;
  role: PlannedGalleryAssetRole;
  component_index: number | null;
  component_key: string | null;
  represented_recipe_keys: string[];
  source_url: string;
  sha256: string;
  local_path: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  classification: LiveGalleryVisualAsset["classification"];
  visual_subject: string;
  policy_issues: string[];
  quality_warnings: string[];
}

export interface GalleryValidationResult {
  pass: boolean;
  errors: string[];
  component_asset_counts: Record<string, number>;
  exact_component_sequence: string[];
  secondary_count: number;
  product_or_context_count: number;
  unique_sha_count: number;
}

export interface SurgicalGalleryRowPlan {
  ordinal: number;
  sku: string;
  asin: string;
  title: string | null;
  expected_total_units: number;
  expected_total_source: string;
  recipe_keys: string[];
  recipe_components: unknown[];
  source_visual_audit_conclusion: string;
  action: "KEEP" | "REBUILD_GALLERY";
  write_required: boolean;
  reason_codes: string[];
  before: {
    secondary_assets: LiveGalleryCurrentAsset[];
    validation: GalleryValidationResult;
  };
  after: {
    secondary_assets: PlannedGalleryAsset[];
    validation: GalleryValidationResult;
  };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function slotNumber(slot: string): number {
  const match = /^GALLERY_(\d+)$/.exec(slot);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function exactUrl(asset: LiveGalleryVisualAsset): string {
  const url = asset.exact_urls[0];
  if (!url || !url.startsWith("https://")) {
    throw new Error(`Asset ${asset.sha256} has no exact HTTPS URL.`);
  }
  return url;
}

function assetSourceOrdinal(
  asset: LiveGalleryVisualAsset,
  auditAssetIndex: number,
): number {
  const minimumObservedSlot = Math.min(
    ...asset.mappings.map((mapping) => slotNumber(mapping.slot)),
  );
  // Preserve the manufacturer's observed gallery ordering first, then the
  // exact visual-audit order. The multiplier leaves room for the latter.
  return minimumObservedSlot * 10_000 + auditAssetIndex;
}

function toCandidate(
  asset: LiveGalleryVisualAsset,
  auditAssetIndex: number,
  componentIndex: number,
  componentKey: string,
): ValidatedGalleryCandidate {
  if (asset.format !== "jpeg") {
    throw new Error(`Eligible asset ${asset.sha256} is not JPEG.`);
  }
  const mapping = asset.mappings[0];
  return {
    component_index: componentIndex,
    component_key: componentKey,
    flavor: componentKey,
    donor_id: mapping ? `${mapping.sku}/${mapping.asin}` : asset.sha256,
    donor_title: asset.visual_subject,
    source_kind: "donor-gallery",
    source_ordinal: assetSourceOrdinal(asset, auditAssetIndex),
    source_url: exactUrl(asset),
    lineage: mapping
      ? [
          {
            retailer: "amazon-live-gallery",
            retailer_product_id: mapping.asin,
            product_url: `https://www.amazon.com/dp/${mapping.asin}`,
            source_api: null,
            fetched_at: null,
            first_party: false,
            via: "sealed-live-fetch-plus-human-visual-audit",
          },
        ]
      : [],
    source_sha256: asset.sha256,
    source_bytes: asset.bytes,
    asset_sha256: asset.sha256,
    asset_bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    source_format: asset.format,
    asset_format: "jpeg",
  };
}

export function indexLiveGalleryVisualAssets(
  assets: LiveGalleryVisualAsset[],
): Map<string, LiveGalleryVisualAsset> {
  const bySha = new Map<string, LiveGalleryVisualAsset>();
  for (const asset of assets) {
    if (!isSha256(asset.sha256)) {
      throw new Error(`Invalid visual-audit asset SHA: ${asset.sha256}`);
    }
    if (bySha.has(asset.sha256)) {
      throw new Error(`Duplicate visual-audit asset SHA: ${asset.sha256}`);
    }
    if (!Number.isInteger(asset.bytes) || asset.bytes < 1) {
      throw new Error(`Invalid byte count for ${asset.sha256}.`);
    }
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height)) {
      throw new Error(`Invalid dimensions for ${asset.sha256}.`);
    }
    exactUrl(asset);
    bySha.set(asset.sha256, asset);
  }
  const fixed = bySha.get(LIVE_GALLERY_FIXED_CARD.sha256);
  if (!fixed || fixed.classification !== "KEEP_SHARED") {
    throw new Error("Owner-approved fixed card is absent from the visual audit.");
  }
  if (!fixed.exact_urls.includes(LIVE_GALLERY_FIXED_CARD.url)) {
    throw new Error("Owner-approved fixed card URL does not match the visual audit.");
  }
  return bySha;
}

function plannedAsset(
  asset: LiveGalleryVisualAsset,
  slotIndex: number,
  role: PlannedGalleryAssetRole,
  componentIndex: number | null,
  componentKey: string | null,
): PlannedGalleryAsset {
  return {
    slot: `GALLERY_${slotIndex}`,
    slot_index: slotIndex,
    role,
    component_index: componentIndex,
    component_key: componentKey,
    represented_recipe_keys:
      role === "EXACT_RECIPE_COMPONENT" && componentKey
        ? [componentKey]
        : [],
    source_url: exactUrl(asset),
    sha256: asset.sha256,
    local_path: asset.local_path,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    classification: asset.classification,
    visual_subject: asset.visual_subject,
    policy_issues: [...asset.policy_issues],
    quality_warnings: [...asset.quality_warnings],
  };
}

function inferPlannedAsset(
  current: LiveGalleryCurrentAsset,
  slotIndex: number,
  recipeKeys: string[],
  bySha: ReadonlyMap<string, LiveGalleryVisualAsset>,
): PlannedGalleryAsset {
  const asset = bySha.get(current.sha256);
  if (!asset) {
    return {
      slot: `GALLERY_${slotIndex}`,
      slot_index: slotIndex,
      role: "FLAVOR_NEUTRAL_SHARED_CONTEXT",
      component_index: null,
      component_key: null,
      represented_recipe_keys: [],
      source_url: current.url,
      sha256: current.sha256,
      local_path: "",
      bytes: 0,
      width: 0,
      height: 0,
      format: "unknown",
      classification: "LOW_QUALITY/INVALID",
      visual_subject: "UNKNOWN_TO_VISUAL_AUDIT",
      policy_issues: ["UNKNOWN_TO_VISUAL_AUDIT"],
      quality_warnings: [],
    };
  }
  if (asset.sha256 === LIVE_GALLERY_FIXED_CARD.sha256) {
    return plannedAsset(
      asset,
      slotIndex,
      "FIXED_PRICE_THANK_YOU_CARD",
      null,
      null,
    );
  }
  if (
    asset.classification === "RECIPE_SPECIFIC_NEEDS_MAPPING" &&
    asset.source_primary_recipe_keys.length === 1
  ) {
    const componentKey = asset.source_primary_recipe_keys[0];
    const componentIndex = recipeKeys.indexOf(componentKey);
    return plannedAsset(
      asset,
      slotIndex,
      "EXACT_RECIPE_COMPONENT",
      componentIndex >= 0 ? componentIndex : null,
      componentIndex >= 0 ? componentKey : null,
    );
  }
  return plannedAsset(
    asset,
    slotIndex,
    "FLAVOR_NEUTRAL_SHARED_CONTEXT",
    null,
    null,
  );
}

function roundRobinSequenceIsValid(sequence: number[], componentCount: number): boolean {
  if (componentCount < 2) return true;
  return sequence.every((componentIndex, index) =>
    componentIndex === index % componentCount,
  );
}

export function validateLiveGalleryPlanSequence(
  recipeKeys: string[],
  gallery: PlannedGalleryAsset[],
): GalleryValidationResult {
  const errors: string[] = [];
  const componentAssetCounts = Object.fromEntries(
    recipeKeys.map((key) => [key, 0]),
  ) as Record<string, number>;
  const exactComponentSequence: string[] = [];

  if (recipeKeys.length < 1 || uniqueStrings(recipeKeys).length !== recipeKeys.length) {
    errors.push("INVALID_OR_DUPLICATE_RECIPE_KEYS");
  }
  if (gallery.length < 5 || gallery.length > 7) {
    errors.push("SECONDARY_COUNT_OUT_OF_RANGE");
  }
  const fixedOccurrences = gallery.filter(
    (asset) => asset.sha256 === LIVE_GALLERY_FIXED_CARD.sha256,
  );
  if (fixedOccurrences.length !== 1) errors.push("FIXED_CARD_OCCURRENCE_NOT_ONE");
  if (
    gallery[0]?.sha256 !== LIVE_GALLERY_FIXED_CARD.sha256 ||
    gallery[0]?.source_url !== LIVE_GALLERY_FIXED_CARD.url ||
    gallery[0]?.slot !== "GALLERY_1"
  ) {
    errors.push("FIXED_CARD_NOT_EXACT_GALLERY_1");
  }

  const seenSha = new Set<string>();
  const componentSequence: number[] = [];
  for (const [index, asset] of gallery.entries()) {
    if (asset.slot_index !== index + 1 || asset.slot !== `GALLERY_${index + 1}`) {
      errors.push("NON_CONTIGUOUS_GALLERY_SLOTS");
    }
    if (!isSha256(asset.sha256)) errors.push("INVALID_ASSET_SHA256");
    if (seenSha.has(asset.sha256)) errors.push("DUPLICATE_ASSET_SHA256");
    seenSha.add(asset.sha256);
    if (LIVE_GALLERY_DISALLOWED_SHA256.has(asset.sha256)) {
      errors.push("DISALLOWED_ASSET_SHA256");
    }
    if (asset.policy_issues.length > 0) errors.push("ASSET_HAS_POLICY_ISSUES");
    if (index === 0) continue;

    if (asset.role === "EXACT_RECIPE_COMPONENT") {
      if (
        asset.classification !== "RECIPE_SPECIFIC_NEEDS_MAPPING" ||
        asset.represented_recipe_keys.length !== 1 ||
        asset.component_index == null ||
        asset.component_key == null ||
        recipeKeys[asset.component_index] !== asset.component_key ||
        asset.represented_recipe_keys[0] !== asset.component_key
      ) {
        errors.push("NON_EXACT_RECIPE_COMPONENT_ASSET");
        continue;
      }
      componentAssetCounts[asset.component_key] =
        (componentAssetCounts[asset.component_key] ?? 0) + 1;
      componentSequence.push(asset.component_index);
      exactComponentSequence.push(asset.component_key);
      continue;
    }
    if (asset.role === "FLAVOR_NEUTRAL_SHARED_CONTEXT") {
      if (
        asset.classification !== "KEEP_SHARED" ||
        !SHARED_FALLBACK_SHA256.has(asset.sha256)
      ) {
        errors.push("UNAPPROVED_SHARED_CONTEXT_ASSET");
      }
      continue;
    }
    errors.push("FIXED_CARD_OUTSIDE_GALLERY_1");
  }

  for (const key of recipeKeys) {
    if ((componentAssetCounts[key] ?? 0) < 1) {
      errors.push(`MISSING_RECIPE_COMPONENT:${key}`);
    }
  }
  if (recipeKeys.length > 1) {
    const counts = recipeKeys.map((key) => componentAssetCounts[key] ?? 0);
    if (Math.max(...counts) - Math.min(...counts) > 1) {
      errors.push("UNBALANCED_RECIPE_COMPONENT_COUNTS");
    }
    if (!roundRobinSequenceIsValid(componentSequence, recipeKeys.length)) {
      errors.push("NOT_RECIPE_COMPONENT_ROUND_ROBIN");
    }
  }
  const productOrContextCount = Math.max(0, gallery.length - 1);
  if (productOrContextCount < 4 || productOrContextCount > 6) {
    errors.push("PRODUCT_OR_CONTEXT_COUNT_OUT_OF_RANGE");
  }

  const deduplicatedErrors = uniqueStrings(errors);
  return {
    pass: deduplicatedErrors.length === 0,
    errors: deduplicatedErrors,
    component_asset_counts: componentAssetCounts,
    exact_component_sequence: exactComponentSequence,
    secondary_count: gallery.length,
    product_or_context_count: productOrContextCount,
    unique_sha_count: seenSha.size,
  };
}

export function buildReplacementLiveGallery(
  recipeKeys: string[],
  visualAssets: LiveGalleryVisualAsset[],
): PlannedGalleryAsset[] {
  const bySha = indexLiveGalleryVisualAssets(visualAssets);
  const indexedAssets = visualAssets.map((asset, index) => ({ asset, index }));
  const groups: GalleryComponentCandidates[] = recipeKeys.map(
    (componentKey, componentIndex) => {
      const candidates = indexedAssets
        .filter(({ asset }) =>
          asset.classification === "RECIPE_SPECIFIC_NEEDS_MAPPING" &&
          asset.policy_issues.length === 0 &&
          !LIVE_GALLERY_DISALLOWED_SHA256.has(asset.sha256) &&
          asset.source_primary_recipe_keys.length === 1 &&
          asset.source_primary_recipe_keys[0] === componentKey,
        )
        .map(({ asset, index }) =>
          toCandidate(asset, index, componentIndex, componentKey),
        );
      return {
        component_index: componentIndex,
        component_key: componentKey,
        flavor: componentKey,
        candidates,
      };
    },
  );

  const selected = selectBalancedGallery(groups, { min: 1, max: 6 });
  const selectedSha = new Set(selected.map((candidate) => candidate.asset_sha256));
  const productAndContext: Array<{
    asset: LiveGalleryVisualAsset;
    role: PlannedGalleryAssetRole;
    componentIndex: number | null;
    componentKey: string | null;
  }> = selected.map((candidate) => {
    const asset = bySha.get(candidate.asset_sha256);
    if (!asset) throw new Error(`Selected unknown asset ${candidate.asset_sha256}.`);
    return {
      asset,
      role: "EXACT_RECIPE_COMPONENT",
      componentIndex: candidate.component_index,
      componentKey: candidate.component_key,
    };
  });

  for (const sha of LIVE_GALLERY_SHARED_FALLBACK_PRIORITY) {
    if (productAndContext.length >= 4) break;
    if (selectedSha.has(sha)) continue;
    const asset = bySha.get(sha);
    if (!asset || asset.classification !== "KEEP_SHARED") {
      throw new Error(`Required shared fallback ${sha} is not audit-approved.`);
    }
    if (asset.policy_issues.length > 0) {
      throw new Error(`Required shared fallback ${sha} has policy issues.`);
    }
    productAndContext.push({
      asset,
      role: "FLAVOR_NEUTRAL_SHARED_CONTEXT",
      componentIndex: null,
      componentKey: null,
    });
    selectedSha.add(sha);
  }
  if (productAndContext.length < 4) {
    throw new Error(`Recipe ${recipeKeys.join("+")} cannot reach four safe assets.`);
  }

  const fixed = bySha.get(LIVE_GALLERY_FIXED_CARD.sha256)!;
  const gallery = [
    plannedAsset(
      fixed,
      1,
      "FIXED_PRICE_THANK_YOU_CARD",
      null,
      null,
    ),
    ...productAndContext.map((entry, index) =>
      plannedAsset(
        entry.asset,
        index + 2,
        entry.role,
        entry.componentIndex,
        entry.componentKey,
      ),
    ),
  ];
  const validation = validateLiveGalleryPlanSequence(recipeKeys, gallery);
  if (!validation.pass) {
    throw new Error(
      `Replacement gallery ${recipeKeys.join("+")} failed: ${validation.errors.join(",")}`,
    );
  }
  return gallery;
}

export function buildLiveGallerySurgicalRowPlan(
  row: LiveGallerySkuConclusion,
  visualAssets: LiveGalleryVisualAsset[],
): SurgicalGalleryRowPlan {
  const bySha = indexLiveGalleryVisualAssets(visualAssets);
  const beforePlanned = row.secondary_assets.map((asset, index) =>
    inferPlannedAsset(asset, index + 1, row.recipe_keys, bySha),
  );
  const beforeValidation = validateLiveGalleryPlanSequence(
    row.recipe_keys,
    beforePlanned,
  );
  const keep = beforeValidation.pass;
  const after = keep
    ? beforePlanned
    : buildReplacementLiveGallery(row.recipe_keys, visualAssets);
  const afterValidation = validateLiveGalleryPlanSequence(row.recipe_keys, after);
  if (!afterValidation.pass) {
    throw new Error(`${row.sku}/${row.asin} after-gallery is invalid.`);
  }
  return {
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    title: row.title,
    expected_total_units: row.expected_total_units,
    expected_total_source: row.expected_total_source,
    recipe_keys: [...row.recipe_keys],
    recipe_components: row.recipe_components,
    source_visual_audit_conclusion: row.conclusion,
    action: keep ? "KEEP" : "REBUILD_GALLERY",
    write_required: !keep,
    reason_codes: keep ? [] : [...beforeValidation.errors],
    before: {
      secondary_assets: row.secondary_assets,
      validation: beforeValidation,
    },
    after: {
      secondary_assets: after,
      validation: afterValidation,
    },
  };
}

