#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const INPUT_AUDIT_PATH = path.join(
  ROOT,
  "data/audits/uncrustables-owner-relaxed-gallery-audit-20260719-v1/uncrustables-owner-relaxed-gallery-audit-20260719-v1.json",
);
const SEALED_GALLERY_PLAN_PATH = path.join(
  ROOT,
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json",
);
const OUTPUT_DIR = path.join(
  ROOT,
  "data/audits/uncrustables-minimal-gallery-adjudication-20260719-v2",
);

const APPROVED_CARD_URL = "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";
const APPROVED_CARD_SHA256 = "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb";
const MULTI_FLAVOR_CONTEXT_SHA256 = "c853706f6c23c5fa5b686d0c57947130b7ea0e9d726f76f0f0a60869fb9c1ea1";
const TARGET_CONTEXT_SHA256 = "8618f3c2f1b432e5ce3e3ca051d932effee4390716214c2879c11a08fb12d9f4";
const NUTRITION_PANEL_SHA256 = "f63f70d84b9aed42c3ced1ad85d7f1e54c3bb804e54d4aadd702a14b3d3dcbf4";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function unique(values) {
  return [...new Set(values)];
}

function countBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = String(selector(row));
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const sourcePath of [INPUT_AUDIT_PATH, SEALED_GALLERY_PLAN_PATH]) {
  assert(fs.existsSync(sourcePath), `Required source is missing: ${sourcePath}`);
}
assert(!fs.existsSync(OUTPUT_DIR), `Immutable output directory already exists: ${OUTPUT_DIR}`);

const inputAudit = readJson(INPUT_AUDIT_PATH);
const sealedGalleryPlan = readJson(SEALED_GALLERY_PLAN_PATH);
const { body_sha256: inputBodySha256, ...inputAuditBody } = inputAudit;
assert(
  sha256Bytes(canonicalJson(inputAuditBody)) === inputBodySha256,
  "Input owner-relaxed gallery audit body SHA-256 does not verify",
);
assert(inputAudit.scope?.captured === 164 && inputAudit.rows?.length === 164, "Input audit is not 164 rows");
assert(sealedGalleryPlan.rows?.length === 164, "Sealed gallery plan is not 164 rows");
assert(new Set(inputAudit.rows.map((row) => row.sku)).size === 164, "Input audit has duplicate SKU rows");
assert(new Set(inputAudit.rows.map((row) => row.asin)).size === 164, "Input audit has duplicate ASIN rows");

const planBySku = new Map(sealedGalleryPlan.rows.map((row) => [row.sku, row]));
const manualAssetEvidence = [
  {
    sha256: MULTI_FLAVOR_CONTEXT_SHA256,
    local_path: `data/audits/uncrustables-live-gallery-fetch-20260718/assets/sha256-${MULTI_FLAVOR_CONTEXT_SHA256}.jpg`,
    manual_result: "KEEP_OWNER_RELAXED_BRAND_CONTEXT",
    observed_subject:
      "A genuine Smucker's Uncrustables brand collage with several real flavors and the contextual copy 'A flavor for every week day'; it does not state that every pictured flavor is included in the offer.",
    policy_effect:
      "Multi-flavor context is not an automatic defect. It is rejected only if it explicitly asserts a different bundle composition, which this asset does not.",
  },
  {
    sha256: TARGET_CONTEXT_SHA256,
    local_path: `data/audits/uncrustables-live-gallery-fetch-20260718/assets/sha256-${TARGET_CONTEXT_SHA256}.jpg`,
    manual_result: "KEEP_OWNER_RELAXED_RETAILER_CONTEXT",
    observed_subject:
      "Lifestyle photo of a real sandwich with 'Only at Target' and 'A perfect morning snack'; it does not depict or assert a different product, flavor, pack, or quantity.",
    policy_effect:
      "Retailer-specific context is not an automatic defect under the owner-approved relaxed norm.",
  },
  {
    sha256: NUTRITION_PANEL_SHA256,
    local_path: `data/audits/uncrustables-live-gallery-fetch-20260718/assets/sha256-${NUTRITION_PANEL_SHA256}.jpg`,
    manual_result: "KEEP_CONTENT_BUT_MOVE_OUT_OF_REQUIRED_SLOT_1",
    observed_subject:
      "A legible Nutrition Facts panel (one sandwich, 58 g). It contains no conflicting flavor, product, or listing-total claim.",
    policy_effect:
      "The defect is structural placement in the fixed-card slot, not an explicitly wrong product image.",
  },
].map((entry) => {
  const absolutePath = path.join(ROOT, entry.local_path);
  assert(fs.existsSync(absolutePath), `Manual evidence asset is missing: ${entry.local_path}`);
  assert(sha256File(absolutePath) === entry.sha256, `Manual evidence asset SHA mismatch: ${entry.local_path}`);
  return { ...entry, file_sha256_verified: true, bytes: fs.statSync(absolutePath).size };
});

function findPlanAsset(planRow, slot) {
  return planRow.after?.secondary_assets?.find(
    (asset) => asset.sha256 === slot.asset_sha256 && asset.source_url === slot.url,
  ) ?? null;
}

function adjudicateAsset(slot, planRow) {
  const mapping = slot.visual_evidence?.prior_mapping_result_for_sku ?? null;
  const planAsset = findPlanAsset(planRow, slot);
  const common = {
    slot_index: slot.slot_index,
    url: slot.url,
    asset_sha256: slot.asset_sha256,
    local_binary_verified:
      slot.prior_exact_url_evidence?.local_file?.sha256_verified === true &&
      slot.prior_exact_url_evidence?.local_file?.bytes_verified === true,
    visual_classification: slot.visual_evidence?.classification ?? null,
    visual_subject: slot.visual_evidence?.visual_subject ?? null,
    prior_mapping_result_for_sku: mapping,
    sealed_plan_role: planAsset?.role ?? null,
    sealed_plan_represented_recipe_keys: planAsset?.represented_recipe_keys ?? [],
  };

  if (slot.is_approved_card) {
    return { ...common, verdict: "KEEP_APPROVED_FIXED_CARD", basis: "OWNER_APPROVED_EXACT_URL_AND_SHA256" };
  }
  if (slot.asset_sha256 === MULTI_FLAVOR_CONTEXT_SHA256) {
    return {
      ...common,
      verdict: "KEEP_OWNER_RELAXED_MULTI_FLAVOR_CONTEXT",
      basis: "MANUAL_VISUAL_REVIEW_NO_BUNDLE_COMPOSITION_ASSERTION",
    };
  }
  if (slot.asset_sha256 === TARGET_CONTEXT_SHA256) {
    return {
      ...common,
      verdict: "KEEP_OWNER_RELAXED_RETAILER_CONTEXT",
      basis: "MANUAL_VISUAL_REVIEW_NO_DIFFERENT_PRODUCT_ASSERTION",
    };
  }
  if (slot.asset_sha256 === NUTRITION_PANEL_SHA256) {
    return {
      ...common,
      verdict: "KEEP_AFTER_REQUIRED_CARD_REORDER",
      basis: "MANUAL_VISUAL_REVIEW_NO_CONFLICTING_PRODUCT_OR_FLAVOR_CLAIM",
    };
  }
  if (planAsset && planRow.after?.validation?.pass === true) {
    return { ...common, verdict: "KEEP_SEALED_PLAN_VALIDATED", basis: "EXACT_RECIPE_OR_APPROVED_CONTEXT" };
  }
  if (
    mapping?.startsWith("MATCHES_") ||
    mapping === "FLAVOR_NEUTRAL_SHARED_CONTEXT_MATCH" ||
    slot.visual_evidence?.classification === "KEEP_SHARED"
  ) {
    return { ...common, verdict: "KEEP_RECIPE_OR_NEUTRAL_CONTEXT", basis: mapping ?? "APPROVED_SHARED_CONTEXT" };
  }
  if (
    slot.visual_evidence?.classification === "LOW_QUALITY/INVALID" ||
    slot.relevance_basis === "LOW_QUALITY_OR_INVALID"
  ) {
    return { ...common, verdict: "FIX_INVALID_ASSET", basis: "EXACT_VISUAL_AUDIT_INVALID" };
  }
  if (slot.relevance_status === "NOT_RELEVANT") {
    return { ...common, verdict: "FIX_EXPLICIT_WRONG_PRODUCT_OR_CLAIM", basis: slot.relevance_basis };
  }
  return { ...common, verdict: "HOLD_RELEVANCE_UNPROVEN", basis: slot.relevance_basis ?? "NO_MAPPING" };
}

function hardViolations(row, assetAdjudications) {
  const reasons = [];
  if (!row.checks.approved_card_exact_slot_1) reasons.push("APPROVED_CARD_NOT_EXACT_SLOT_1");
  if (!row.checks.additional_count_4_to_6) reasons.push("ADDITIONAL_IMAGE_COUNT_OUTSIDE_4_TO_6");
  if (!row.checks.slots_contiguous_from_1) reasons.push("NON_CONTIGUOUS_OTHER_IMAGE_SLOTS");
  if (!row.checks.slot_values_well_formed) reasons.push("MALFORMED_OR_MISSING_SLOT_VALUE");
  if (!row.checks.amazon_image_url_shapes_valid) reasons.push("MALFORMED_IMAGE_URL");
  if (!row.checks.exact_urls_unique) reasons.push("EXACT_URL_DUPLICATE");
  if (!row.checks.exact_asset_sha256_unique) reasons.push("EXACT_BYTE_DUPLICATE");
  if (!row.checks.no_known_true_visual_duplicates) reasons.push("KNOWN_TRUE_VISUAL_DUPLICATE");
  for (const asset of assetAdjudications) {
    if (asset.verdict === "FIX_INVALID_ASSET") reasons.push(`INVALID_ASSET_SLOT_${asset.slot_index}`);
    if (asset.verdict === "FIX_EXPLICIT_WRONG_PRODUCT_OR_CLAIM") {
      reasons.push(`EXPLICIT_WRONG_PRODUCT_OR_CLAIM_SLOT_${asset.slot_index}`);
    }
  }
  return unique(reasons);
}

function holdReasons(row, assetAdjudications) {
  const reasons = [];
  if (!row.checks.exact_local_binary_evidence_complete) reasons.push("LOCAL_BINARY_EVIDENCE_INCOMPLETE");
  for (const asset of assetAdjudications) {
    if (asset.verdict === "HOLD_RELEVANCE_UNPROVEN") reasons.push(`RELEVANCE_UNPROVEN_SLOT_${asset.slot_index}`);
  }
  return unique(reasons);
}

const rows = inputAudit.rows.map((row) => {
  const planRow = planBySku.get(row.sku);
  assert(planRow, `Missing sealed plan recipe for ${row.sku}`);
  assert(planRow.asin === row.asin, `ASIN mismatch between audit and recipe evidence for ${row.sku}`);
  const assetAdjudications = row.slots.map((slot) => adjudicateAsset(slot, planRow));
  const violations = hardViolations(row, assetAdjudications);
  const holds = holdReasons(row, assetAdjudications);
  const disposition = holds.length > 0 ? "HOLD" : violations.length > 0 ? "FIX" : "KEEP";
  const rowBase = {
    ordinal: row.ordinal,
    sku: row.sku,
    asin: row.asin,
    store_index: row.store_index,
    title: row.title,
    listing_sha256: row.fresh_snapshot.listing_sha256,
    source_row_evidence_sha256: row.row_evidence_sha256,
    recipe_evidence: {
      recipe_keys: planRow.recipe_keys,
      recipe_components: planRow.recipe_components,
      expected_total_units: planRow.expected_total_units,
      expected_total_source: planRow.expected_total_source,
      sealed_plan_row_sha256: sha256Bytes(canonicalJson(planRow)),
    },
    gallery_counts: {
      current_other_slots: row.counts.other_product_image_slots,
      current_additional_after_card: row.counts.additional_images_after_excluding_fixed_card,
      approved_card_slots: row.diagnostics.approved_card_slots,
    },
    asset_adjudications: assetAdjudications,
    hard_violation_codes: violations,
    hold_reason_codes: holds,
    relaxed_exceptions_applied: unique(
      assetAdjudications
        .filter((asset) => asset.verdict.includes("OWNER_RELAXED"))
        .map((asset) => asset.verdict),
    ),
    disposition,
  };
  return { ...rowBase, row_evidence_sha256: sha256Bytes(canonicalJson(rowBase)) };
});

assert(rows.length === 164, "Adjudication did not preserve the exact 164-row denominator");

function currentDesiredSlots(sourceRow, desiredUrls) {
  const currentByIndex = new Map(sourceRow.slots.map((slot) => [slot.slot_index, slot]));
  return desiredUrls.map((entry, index) => {
    const slotIndex = index + 1;
    const before = currentByIndex.get(slotIndex) ?? null;
    return {
      slot_index: slotIndex,
      attribute: `/attributes/other_product_image_locator_${slotIndex}`,
      url: entry.url,
      asset_sha256: entry.sha256,
      source_role: entry.role,
      represented_recipe_keys: entry.represented_recipe_keys ?? [],
      change_kind: !before ? "ADD" : before.url === entry.url ? "KEEP" : "REPLACE",
      expected_before: before
        ? { url: before.url, asset_sha256: before.asset_sha256, field_sha256: before.field_sha256 }
        : null,
    };
  });
}

function desiredForFix(row) {
  const sourceRow = inputAudit.rows.find((candidate) => candidate.sku === row.sku);
  const planRow = planBySku.get(row.sku);
  assert(sourceRow && planRow, `Missing desired-media inputs for ${row.sku}`);

  let desiredUrls;
  let strategy;
  if (row.sku === "UA-ASAO-RE7Q" || row.sku === "VC-ASV1-378P") {
    const card = sourceRow.slots.find((slot) => slot.is_approved_card);
    const slotOne = sourceRow.slots.find((slot) => slot.slot_index === 1);
    assert(card?.slot_index === 7 && slotOne, `Expected exact slot-1/slot-7 swap inputs for ${row.sku}`);
    desiredUrls = sourceRow.slots
      .slice()
      .sort((left, right) => left.slot_index - right.slot_index)
      .map((slot) => ({
        url: slot.url,
        sha256: slot.asset_sha256,
        role:
          slot.is_approved_card
            ? "FIXED_PRICE_THANK_YOU_CARD"
            : findPlanAsset(planRow, slot)?.role ?? "PRESERVE_CURRENT",
        represented_recipe_keys: findPlanAsset(planRow, slot)?.represented_recipe_keys ?? [],
      }));
    desiredUrls[0] = {
      url: card.url,
      sha256: card.asset_sha256,
      role: "FIXED_PRICE_THANK_YOU_CARD",
      represented_recipe_keys: [],
    };
    desiredUrls[6] = {
      url: slotOne.url,
      sha256: slotOne.asset_sha256,
      role: "PRESERVE_NUTRITION_PANEL_AFTER_CARD_REORDER",
      represented_recipe_keys: [],
    };
    strategy = "SWAP_SLOT_1_AND_SLOT_7_ONLY";
  } else if (row.sku === "SZ-ASPI-JFAT") {
    const exactRecipeAssets = planRow.after.secondary_assets.filter(
      (asset) => asset.role === "EXACT_RECIPE_COMPONENT" && asset.represented_recipe_keys?.includes("PB_BLACKBERRY"),
    );
    assert(exactRecipeAssets.length >= 4, "Fewer than four exact PB_BLACKBERRY gallery assets are available");
    const chosen = exactRecipeAssets.slice(0, 4);
    for (const asset of chosen) {
      const absolutePath = path.join(ROOT, asset.local_path);
      assert(fs.existsSync(absolutePath), `Desired exact asset is missing: ${asset.local_path}`);
      assert(sha256File(absolutePath) === asset.sha256, `Desired exact asset SHA mismatch: ${asset.local_path}`);
      assert(fs.statSync(absolutePath).size === asset.bytes, `Desired exact asset byte mismatch: ${asset.local_path}`);
    }
    desiredUrls = [
      {
        url: APPROVED_CARD_URL,
        sha256: APPROVED_CARD_SHA256,
        role: "FIXED_PRICE_THANK_YOU_CARD",
        represented_recipe_keys: [],
      },
      ...chosen.map((asset) => ({
        url: asset.source_url,
        sha256: asset.sha256,
        role: "EXACT_RECIPE_COMPONENT",
        represented_recipe_keys: asset.represented_recipe_keys,
      })),
    ];
    strategy = "ADD_MINIMUM_FOUR_EXACT_PB_BLACKBERRY_ASSETS";
  } else {
    throw new Error(`No deterministic minimal repair strategy exists for FIX row ${row.sku}`);
  }

  const slots = currentDesiredSlots(sourceRow, desiredUrls);
  const changedSlots = slots.filter((slot) => slot.change_kind !== "KEEP");
  const desiredHashes = slots.map((slot) => slot.asset_sha256);
  const additionalCount = slots.filter((slot) => slot.asset_sha256 !== APPROVED_CARD_SHA256).length;
  assert(slots[0].url === APPROVED_CARD_URL && slots[0].asset_sha256 === APPROVED_CARD_SHA256, `${row.sku} desired slot 1 is not the approved card`);
  assert(additionalCount >= 4 && additionalCount <= 6, `${row.sku} desired additional count is outside 4..6`);
  assert(new Set(slots.map((slot) => slot.url)).size === slots.length, `${row.sku} desired URLs are not unique`);
  assert(new Set(desiredHashes).size === desiredHashes.length, `${row.sku} desired asset bytes are not unique`);

  const actionBase = {
    action_id: `${row.sku}:minimal_gallery_repair`,
    sku: row.sku,
    asin: row.asin,
    store_index: row.store_index,
    expected_listing_sha256: row.listing_sha256,
    source_adjudication_row_sha256: row.row_evidence_sha256,
    strategy,
    hard_violation_codes: row.hard_violation_codes,
    before_slots: sourceRow.slots.map((slot) => ({
      slot_index: slot.slot_index,
      url: slot.url,
      asset_sha256: slot.asset_sha256,
      field_sha256: slot.field_sha256,
    })),
    desired_slots: slots,
    slot_diff: changedSlots,
    delete_slot_indices: sourceRow.slots
      .map((slot) => slot.slot_index)
      .filter((slotIndex) => slotIndex > slots.length),
    desired_validation: {
      approved_card_exact_slot_1: true,
      approved_card_occurrences: 1,
      additional_image_count: additionalCount,
      exact_urls_unique: true,
      exact_asset_sha256_unique: true,
      exact_recipe_assets: slots.filter(
        (slot) =>
          slot.source_role === "EXACT_RECIPE_COMPONENT" || slot.represented_recipe_keys.length > 0,
      ).length,
    },
  };
  return { ...actionBase, action_sha256: sha256Bytes(canonicalJson(actionBase)) };
}

const fixRows = rows.filter((row) => row.disposition === "FIX");
const desiredActions = fixRows.map(desiredForFix);
assert(desiredActions.length === 3, `Expected exactly 3 minimal gallery actions, got ${desiredActions.length}`);

const sourceFiles = [INPUT_AUDIT_PATH, SEALED_GALLERY_PLAN_PATH].map((filePath) => ({
  path: relative(filePath),
  file_sha256: sha256File(filePath),
}));
const createdAt = new Date().toISOString();
const summary = {
  total: rows.length,
  dispositions: countBy(rows, (row) => row.disposition),
  minimal_fix_skus: fixRows.map((row) => row.sku),
  hard_violation_distribution: countBy(
    rows.flatMap((row) => row.hard_violation_codes),
    (reason) => reason,
  ),
  explicit_wrong_product_or_claim_rows: rows.filter((row) =>
    row.hard_violation_codes.some((reason) => reason.startsWith("EXPLICIT_WRONG_PRODUCT_OR_CLAIM")),
  ).length,
  rows_relaxed_from_prior_needs_fix_to_keep: rows.filter((row) => {
    const source = inputAudit.rows.find((candidate) => candidate.sku === row.sku);
    return source?.status === "NEEDS_FIX" && row.disposition === "KEEP";
  }).length,
  rows_with_multi_flavor_context_kept: rows.filter((row) =>
    row.asset_adjudications.some((asset) => asset.verdict === "KEEP_OWNER_RELAXED_MULTI_FLAVOR_CONTEXT"),
  ).length,
  rows_with_target_context_kept: rows.filter((row) =>
    row.asset_adjudications.some((asset) => asset.verdict === "KEEP_OWNER_RELAXED_RETAILER_CONTEXT"),
  ).length,
  desired_media_actions: desiredActions.length,
  external_mutations: 0,
};

const artifactBase = {
  schema_version: "uncrustables-minimal-gallery-adjudication/v1",
  adjudication_id: `UMGA-${createdAt.replaceAll(/[-:.]/g, "")}-${sourceFiles[0].file_sha256.slice(0, 12)}`,
  created_at: createdAt,
  immutable: true,
  offline_only: true,
  execution_authorized: false,
  external_mutations: 0,
  supersedes: {
    artifact_directory: "data/audits/uncrustables-minimal-gallery-adjudication-20260719-v1",
    reason:
      "Corrects desired_validation.exact_recipe_assets for preserved exact-recipe assets; dispositions and sparse slot diffs are unchanged.",
  },
  scope: {
    marketplace: "AMAZON_US",
    store_index: 1,
    expected: 164,
    adjudicated: rows.length,
    unique_skus: new Set(rows.map((row) => row.sku)).size,
  },
  owner_approved_minimal_policy: {
    hard_violations_only: [
      "approved fixed price/thank-you card is not exactly other_product_image_locator_1",
      "additional image count after the fixed card is below 4 or above 6",
      "broken, missing, malformed, non-contiguous, exact-duplicate, or proven true-visual-duplicate asset/slot",
      "an image explicitly depicts or asserts a different product, flavor, pack, quantity, or bundle composition in a misleading way",
    ],
    not_automatic_defects: [
      "genuine multi-flavor brand context that does not claim all pictured flavors are included",
      "Only-at-Target lifestyle context that does not depict or assert a different sold product",
      "primary-component imagery in a mixed bundle",
      "different ordering from the former strict sealed gallery plan",
    ],
    preserve_rule: "Keep current assets unless one of the enumerated hard violations is proven.",
    status_contract: {
      KEEP: "No hard violation and sufficient exact local evidence.",
      FIX: "A concrete hard violation is proven and a deterministic minimal desired state is available.",
      HOLD: "Relevance or binary evidence is insufficient to make a safe gallery decision.",
    },
  },
  source_files: sourceFiles,
  manual_asset_evidence: manualAssetEvidence,
  limitations: [
    "Offline-only adjudication; no image HTTP fetch, Amazon mutation, buyer-facing PDP readback, or generation was performed.",
    "Current remote reachability still requires fresh pre-apply capture and post-apply Amazon readback.",
    "This artifact adjudicates gallery media only and does not clear independent offer, catalog-identity, promotion, or ChannelMAX gates.",
  ],
  summary,
  rows,
};
const artifact = { ...artifactBase, body_sha256: sha256Bytes(canonicalJson(artifactBase)) };

const desiredManifestBase = {
  schema_version: "uncrustables-minimal-gallery-desired-media/v1",
  manifest_id: `UMGDM-${createdAt.replaceAll(/[-:.]/g, "")}-${artifact.body_sha256.slice(0, 12)}`,
  created_at: createdAt,
  immutable: true,
  offline_only: true,
  execution_authorized: false,
  external_mutations: 0,
  adjudication_body_sha256: artifact.body_sha256,
  source_files: sourceFiles,
  scope: { total_adjudicated: rows.length, fix_actions: desiredActions.length },
  safety: {
    required_before_any_apply: [
      "fresh exact Amazon listing capture for store 1, SKU, ASIN, marketplace, and merchant",
      "compare fresh slot URLs and field/listing hashes to expected_before; any drift blocks the action",
      "capture immutable rollback for every changed slot",
      "Amazon VALIDATION_PREVIEW for the exact sparse media diff",
      "separate owner/network execution gate",
    ],
    required_after_any_apply: [
      "immediate exact Amazon attribute readback",
      "buyer-facing image/order verification",
      "delayed repeat readback to detect overwrite or propagation drift",
    ],
    no_offer_price_promo_or_channelmax_changes: true,
  },
  actions: desiredActions,
};
const desiredManifest = {
  ...desiredManifestBase,
  body_sha256: sha256Bytes(canonicalJson(desiredManifestBase)),
};

const csvColumns = [
  "ordinal",
  "sku",
  "asin",
  "disposition",
  "recipe_keys",
  "expected_total_units",
  "current_other_slots",
  "current_additional_after_card",
  "approved_card_slots",
  "hard_violation_codes",
  "hold_reason_codes",
  "relaxed_exceptions_applied",
  "explicit_wrong_product_or_claim",
  "source_row_evidence_sha256",
  "row_evidence_sha256",
];
const csvRows = rows.map((row) => [
  row.ordinal,
  row.sku,
  row.asin,
  row.disposition,
  row.recipe_evidence.recipe_keys,
  row.recipe_evidence.expected_total_units,
  row.gallery_counts.current_other_slots,
  row.gallery_counts.current_additional_after_card,
  row.gallery_counts.approved_card_slots,
  row.hard_violation_codes,
  row.hold_reason_codes,
  row.relaxed_exceptions_applied,
  row.hard_violation_codes.some((reason) => reason.startsWith("EXPLICIT_WRONG_PRODUCT_OR_CLAIM")),
  row.source_row_evidence_sha256,
  row.row_evidence_sha256,
]);
const csv = [csvColumns, ...csvRows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

const parentDir = path.dirname(OUTPUT_DIR);
const tempDir = path.join(parentDir, `.tmp-${path.basename(OUTPUT_DIR)}-${process.pid}`);
assert(!fs.existsSync(tempDir), `Temporary output directory already exists: ${tempDir}`);
fs.mkdirSync(tempDir, { recursive: false });

const jsonName = "uncrustables-minimal-gallery-adjudication-20260719-v2.json";
const csvName = "uncrustables-minimal-gallery-adjudication-20260719-v2.csv";
const manifestName = "uncrustables-minimal-gallery-desired-media-20260719-v2.json";
const outputFiles = [
  { name: jsonName, bytes: JSON.stringify(artifact, null, 2) + "\n" },
  { name: csvName, bytes: csv },
  { name: manifestName, bytes: JSON.stringify(desiredManifest, null, 2) + "\n" },
];
for (const output of outputFiles) {
  const outputPath = path.join(tempDir, output.name);
  fs.writeFileSync(outputPath, output.bytes);
  fs.writeFileSync(`${outputPath}.sha256`, `${sha256File(outputPath)}  ${output.name}\n`);
}
fs.renameSync(tempDir, OUTPUT_DIR);

console.log(
  JSON.stringify(
    {
      output_dir: relative(OUTPUT_DIR),
      adjudication: {
        path: relative(path.join(OUTPUT_DIR, jsonName)),
        file_sha256: sha256File(path.join(OUTPUT_DIR, jsonName)),
        body_sha256: artifact.body_sha256,
      },
      csv: {
        path: relative(path.join(OUTPUT_DIR, csvName)),
        file_sha256: sha256File(path.join(OUTPUT_DIR, csvName)),
      },
      desired_manifest: {
        path: relative(path.join(OUTPUT_DIR, manifestName)),
        file_sha256: sha256File(path.join(OUTPUT_DIR, manifestName)),
        body_sha256: desiredManifest.body_sha256,
      },
      summary,
    },
    null,
    2,
  ),
);
