#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(
  ROOT,
  "data/repairs/rollback/uncrustables-owner-relaxed-main-24-live-20260719-v2/UAPS-20260719T030109596Z-46a80e727880-b91e0e79732b.json",
);
const LIVE_GALLERY_MANIFEST_PATH = path.join(
  ROOT,
  "data/audits/uncrustables-live-gallery-fetch-20260718/manifest.json",
);
const VISUAL_AUDIT_PATH = path.join(
  ROOT,
  "data/audits/uncrustables-live-gallery-visual-audit-20260718.json",
);
const SEALED_GALLERY_PLAN_PATH = path.join(
  ROOT,
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json",
);
const FINAL_GALLERY_GATE_PATH = path.join(
  ROOT,
  "data/audits/uncrustables-final-gallery-gate-20260718-v1/UFGG-20260718T150050701Z-v1.json",
);
const OUTPUT_DIR = path.join(
  ROOT,
  "data/audits/uncrustables-owner-relaxed-gallery-audit-20260719-v1",
);

const APPROVED_CARD_URL = "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";
const APPROVED_CARD_SHA256 = "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb";
const AMAZON_IMAGE_URL_RE = /^https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+_.-]+\.jpg$/;
const REJECTED_POLICY_ISSUES = new Set([
  "NON_EXACT_MULTI_FLAVOR_PROMO",
  "RETAILER_SPECIFIC_COPY",
]);

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

for (const sourcePath of [
  SNAPSHOT_PATH,
  LIVE_GALLERY_MANIFEST_PATH,
  VISUAL_AUDIT_PATH,
  SEALED_GALLERY_PLAN_PATH,
  FINAL_GALLERY_GATE_PATH,
]) {
  if (!fs.existsSync(sourcePath)) throw new Error(`Required source is missing: ${sourcePath}`);
}
if (fs.existsSync(OUTPUT_DIR)) throw new Error(`Immutable output directory already exists: ${OUTPUT_DIR}`);

const snapshot = readJson(SNAPSHOT_PATH);
const liveGalleryManifest = readJson(LIVE_GALLERY_MANIFEST_PATH);
const visualAudit = readJson(VISUAL_AUDIT_PATH);
const sealedGalleryPlan = readJson(SEALED_GALLERY_PLAN_PATH);
const finalGalleryGate = readJson(FINAL_GALLERY_GATE_PATH);

if (snapshot.entries?.length !== 164 || snapshot.scope?.captured !== 164) {
  throw new Error(`Fresh snapshot is not the exact 164-row scope: ${snapshot.entries?.length}`);
}
if (new Set(snapshot.entries.map((entry) => entry.sku)).size !== 164) {
  throw new Error("Fresh snapshot contains duplicate SKUs");
}
if (new Set(snapshot.entries.map((entry) => entry.asin)).size !== 164) {
  throw new Error("Fresh snapshot contains duplicate ASINs");
}

const sourceFiles = [
  SNAPSHOT_PATH,
  LIVE_GALLERY_MANIFEST_PATH,
  VISUAL_AUDIT_PATH,
  SEALED_GALLERY_PLAN_PATH,
  FINAL_GALLERY_GATE_PATH,
].map((filePath) => ({ path: relative(filePath), file_sha256: sha256File(filePath) }));

const exactUrlEvidence = new Map(
  liveGalleryManifest.exact_url_fetches.map((entry) => [entry.requested_url, entry]),
);
const visualBySha = new Map(visualAudit.assets.map((entry) => [entry.sha256, entry]));
const planBySku = new Map(sealedGalleryPlan.rows.map((entry) => [entry.sku, entry]));
const freshBinaryByUrl = new Map(
  snapshot.image_capture.evidence
    .filter((entry) => entry.sha256 && !entry.error)
    .map((entry) => [entry.url, entry]),
);
const finalGateBySku = new Map(finalGalleryGate.rows.map((entry) => [entry.sku, entry]));

const verifiedLocalAssets = new Map();
function verifyPriorAsset(evidence) {
  if (!evidence?.asset?.local_path || !evidence.asset.sha256) return null;
  const filePath = path.join(path.dirname(LIVE_GALLERY_MANIFEST_PATH), evidence.asset.local_path);
  const cacheKey = `${filePath}:${evidence.asset.sha256}`;
  if (!verifiedLocalAssets.has(cacheKey)) {
    const exists = fs.existsSync(filePath);
    const actualSha256 = exists ? sha256File(filePath) : null;
    const actualBytes = exists ? fs.statSync(filePath).size : null;
    verifiedLocalAssets.set(cacheKey, {
      path: relative(filePath),
      exists,
      expected_sha256: evidence.asset.sha256,
      actual_sha256: actualSha256,
      sha256_verified: exists && actualSha256 === evidence.asset.sha256,
      expected_bytes: evidence.asset.bytes,
      actual_bytes: actualBytes,
      bytes_verified: exists && actualBytes === evidence.asset.bytes,
    });
  }
  return verifiedLocalAssets.get(cacheKey);
}

const approvedCardFetch = exactUrlEvidence.get(APPROVED_CARD_URL);
const approvedCardLocal = verifyPriorAsset(approvedCardFetch);
if (
  approvedCardFetch?.asset?.sha256 !== APPROVED_CARD_SHA256 ||
  !approvedCardLocal?.sha256_verified ||
  finalGalleryGate.fixed_card_manual_visual_verification?.file_sha256 !== APPROVED_CARD_SHA256
) {
  throw new Error("Approved price/customer-note card evidence does not match the owner-approved SHA-256");
}

const trueVisualDuplicatePairs = sealedGalleryPlan.visual_duplicate_review.pair_occurrences
  .filter((entry) => entry.classification === "TRUE_VISUAL_DUPLICATE")
  .map((entry) => ({
    sku: entry.sku,
    hashes: [entry.left.sha256, entry.right.sha256].sort(),
    prior_slots: entry.slots,
    measured_mae_64x64_greyscale: entry.measured_mae_64x64_greyscale,
    rationale: entry.rationale,
  }));

function mappingForSku(asset, sku) {
  return asset?.mappings?.find((mapping) => mapping.sku === sku) ?? null;
}

function findPlanAsset(planRow, sha256, url) {
  return planRow?.after?.secondary_assets?.find(
    (asset) => asset.sha256 === sha256 && asset.source_url === url,
  ) ?? null;
}

const rows = snapshot.entries.map((entry, index) => {
  const planRow = planBySku.get(entry.sku);
  if (!planRow || planRow.asin !== entry.asin) {
    throw new Error(`Sealed gallery plan identity mismatch for ${entry.sku}/${entry.asin}`);
  }

  const slots = [];
  const malformedSlots = [];
  for (let slotIndex = 1; slotIndex <= 8; slotIndex += 1) {
    const attribute = `/attributes/other_product_image_locator_${slotIndex}`;
    const field = entry.fields[attribute] ?? { present: false, value: [], sha256: null };
    const values = Array.isArray(field.value) ? field.value : [];
    const urls = values
      .map((value) => value?.media_location)
      .filter((value) => typeof value === "string" && value.trim().length > 0);

    if (field.present && urls.length !== 1) {
      malformedSlots.push({ slot_index: slotIndex, present: field.present, value_count: values.length, urls });
    }
    if (!field.present || urls.length === 0) continue;

    const url = urls[0];
    const prior = exactUrlEvidence.get(url) ?? null;
    const local = verifyPriorAsset(prior);
    const assetSha256 = prior?.asset?.sha256 ?? null;
    const visual = assetSha256 ? visualBySha.get(assetSha256) ?? null : null;
    const mapping = mappingForSku(visual, entry.sku);
    const planAsset = findPlanAsset(planRow, assetSha256, url);
    const freshBinary = freshBinaryByUrl.get(url) ?? null;
    const isApprovedCard = url === APPROVED_CARD_URL && assetSha256 === APPROVED_CARD_SHA256;

    const rejectedIssues = (visual?.policy_issues ?? []).filter((issue) => REJECTED_POLICY_ISSUES.has(issue));
    let relevanceStatus = "UNKNOWN";
    let relevanceBasis = "NO_EXACT_VISUAL_MAPPING";
    if (isApprovedCard) {
      relevanceStatus = "APPROVED_CARD";
      relevanceBasis = "OWNER_APPROVED_EXACT_URL_AND_SHA256";
    } else if (planAsset && planRow.after?.validation?.pass === true) {
      relevanceStatus = "RELEVANT";
      relevanceBasis = "SEALED_PLAN_AFTER_VALIDATION";
    } else if (rejectedIssues.length > 0) {
      relevanceStatus = "NOT_RELEVANT";
      relevanceBasis = rejectedIssues.join("+");
    } else if (visual?.classification === "LOW_QUALITY/INVALID") {
      relevanceStatus = "NOT_RELEVANT";
      relevanceBasis = "LOW_QUALITY_OR_INVALID";
    } else if (
      mapping?.result?.startsWith("MATCHES_") ||
      mapping?.result === "FLAVOR_NEUTRAL_SHARED_CONTEXT_MATCH" ||
      visual?.classification === "KEEP_SHARED"
    ) {
      relevanceStatus = "RELEVANT";
      relevanceBasis = mapping?.result ?? "APPROVED_SHARED_CONTEXT";
    } else if (mapping?.result === "RETAILER_SPECIFIC_ONLY_AT_TARGET_COPY_ON_AMAZON") {
      relevanceStatus = "NOT_RELEVANT";
      relevanceBasis = "RETAILER_SPECIFIC_COPY";
    } else if (mapping?.result === "NON_EXACT_MULTI_FLAVOR_PROMO_SHOWS_UNSOLD_OR_UNMAPPED_FLAVORS") {
      relevanceStatus = "NOT_RELEVANT";
      relevanceBasis = "NON_EXACT_MULTI_FLAVOR_PROMO";
    } else if (mapping?.result === "WRONG_FIXED_SLOT_1_NUTRITION_PANEL" && slotIndex === 1) {
      relevanceStatus = "NOT_RELEVANT";
      relevanceBasis = "WRONG_FIXED_SLOT_1_NUTRITION_PANEL";
    }

    slots.push({
      slot_index: slotIndex,
      attribute,
      field_sha256: field.sha256 ?? null,
      value_count: values.length,
      url,
      url_shape_valid: AMAZON_IMAGE_URL_RE.test(url),
      is_approved_card: isApprovedCard,
      asset_sha256: assetSha256,
      prior_exact_url_evidence: prior
        ? {
            http_status: prior.http?.status ?? null,
            fetched_at: prior.http?.fetched_at ?? null,
            final_url: prior.http?.final_url ?? null,
            content_type: prior.asset?.content_type ?? null,
            bytes: prior.asset?.bytes ?? null,
            width: prior.asset?.width ?? null,
            height: prior.asset?.height ?? null,
            local_file: local,
          }
        : null,
      fresh_snapshot_binary_evidence: freshBinary
        ? {
            sha256: freshBinary.sha256,
            bytes: freshBinary.bytes,
            local_path: freshBinary.local_path,
          }
        : null,
      visual_evidence: visual
        ? {
            classification: visual.classification,
            visual_subject: visual.visual_subject,
            policy_issues: visual.policy_issues,
            quality_warnings: visual.quality_warnings,
            prior_mapping_result_for_sku: mapping?.result ?? null,
          }
        : null,
      relevance_status: relevanceStatus,
      relevance_basis: relevanceBasis,
    });
  }

  const slotIndices = slots.map((slot) => slot.slot_index);
  const maxSlot = slotIndices.length ? Math.max(...slotIndices) : 0;
  const missingSlotIndices = maxSlot
    ? Array.from({ length: maxSlot }, (_, position) => position + 1).filter(
        (slotIndex) => !slotIndices.includes(slotIndex),
      )
    : [];
  const approvedCardSlots = slots.filter((slot) => slot.is_approved_card).map((slot) => slot.slot_index);
  const additionalSlots = slots.filter((slot) => !slot.is_approved_card);
  const urls = slots.map((slot) => slot.url);
  const hashes = slots.map((slot) => slot.asset_sha256).filter(Boolean);
  const duplicateUrls = unique(urls.filter((url, position) => urls.indexOf(url) !== position));
  const duplicateHashes = unique(hashes.filter((sha, position) => hashes.indexOf(sha) !== position));
  const knownVisualDuplicates = trueVisualDuplicatePairs.filter(
    (pair) => pair.sku === entry.sku && pair.hashes.every((sha) => hashes.includes(sha)),
  );
  const obviousIrrelevant = additionalSlots.filter((slot) => slot.relevance_status === "NOT_RELEVANT");
  const unknownRelevance = additionalSlots.filter((slot) => slot.relevance_status === "UNKNOWN");
  const localEvidenceProblems = slots.filter(
    (slot) =>
      !slot.prior_exact_url_evidence ||
      slot.prior_exact_url_evidence.http_status !== 200 ||
      !slot.prior_exact_url_evidence.local_file?.sha256_verified ||
      !slot.prior_exact_url_evidence.local_file?.bytes_verified,
  );
  const malformedUrlSlots = slots.filter((slot) => !slot.url_shape_valid);
  const currentOrderedUrls = slots.map((slot) => slot.url);
  const afterOrderedUrls = planRow.after.secondary_assets.map((asset) => asset.source_url);
  const beforeOrderedUrls = planRow.before.secondary_assets.map((asset) => asset.url);
  const currentMatchesSealedAfter = canonicalJson(currentOrderedUrls) === canonicalJson(afterOrderedUrls);
  const currentMatchesPriorBefore = canonicalJson(currentOrderedUrls) === canonicalJson(beforeOrderedUrls);

  const needsFixReasons = [];
  const unknownReasons = [];
  if (approvedCardSlots.length !== 1) needsFixReasons.push("APPROVED_CARD_OCCURRENCE_NOT_EXACTLY_ONE");
  if (approvedCardSlots[0] !== 1) needsFixReasons.push("APPROVED_CARD_NOT_IN_SLOT_1");
  if (additionalSlots.length < 4 || additionalSlots.length > 6) {
    needsFixReasons.push("ADDITIONAL_IMAGE_COUNT_OUTSIDE_4_TO_6");
  }
  if (missingSlotIndices.length > 0) needsFixReasons.push("NON_CONTIGUOUS_OTHER_IMAGE_SLOTS");
  if (malformedSlots.length > 0) needsFixReasons.push("MALFORMED_OTHER_IMAGE_SLOT");
  if (malformedUrlSlots.length > 0) needsFixReasons.push("MALFORMED_AMAZON_IMAGE_URL");
  if (duplicateUrls.length > 0) needsFixReasons.push("EXACT_URL_DUPLICATE");
  if (duplicateHashes.length > 0) needsFixReasons.push("EXACT_BYTE_DUPLICATE");
  if (knownVisualDuplicates.length > 0) needsFixReasons.push("KNOWN_TRUE_VISUAL_DUPLICATE");
  if (obviousIrrelevant.length > 0) needsFixReasons.push("OBVIOUSLY_IRRELEVANT_OR_WRONG_COPY_IMAGE");
  if (localEvidenceProblems.length > 0) unknownReasons.push("EXACT_LOCAL_BINARY_EVIDENCE_INCOMPLETE");
  if (unknownRelevance.length > 0) unknownReasons.push("RELAXED_RELEVANCE_NOT_PROVEN");

  const status = needsFixReasons.length > 0
    ? "NEEDS_FIX"
    : unknownReasons.length > 0
      ? "UNKNOWN"
      : "PASS";

  const finalGateRow = finalGateBySku.get(entry.sku);
  const rowBase = {
    ordinal: index + 1,
    sku: entry.sku,
    asin: entry.asin,
    store_index: entry.store_index,
    title: entry.fields["/attributes/item_name"]?.value?.[0]?.value ?? null,
    fresh_snapshot: {
      snapshot_id: snapshot.snapshot_id,
      captured_at: entry.captured_at,
      capture_source: entry.capture_source,
      listing_sha256: entry.listing_sha256,
    },
    slots,
    counts: {
      other_product_image_slots: slots.length,
      approved_card_occurrences: approvedCardSlots.length,
      additional_images_after_excluding_fixed_card: additionalSlots.length,
      relaxed_relevant_additional_images: additionalSlots.filter(
        (slot) => slot.relevance_status === "RELEVANT",
      ).length,
      obvious_irrelevant_additional_images: obviousIrrelevant.length,
      unknown_relevance_additional_images: unknownRelevance.length,
      prior_exact_local_binary_evidence: slots.length - localEvidenceProblems.length,
      fresh_snapshot_secondary_binary_evidence: slots.filter(
        (slot) => slot.fresh_snapshot_binary_evidence,
      ).length,
    },
    checks: {
      approved_card_exact_slot_1: approvedCardSlots.length === 1 && approvedCardSlots[0] === 1,
      approved_card_exact_sha256: APPROVED_CARD_SHA256,
      additional_count_4_to_6: additionalSlots.length >= 4 && additionalSlots.length <= 6,
      every_additional_image_relaxed_relevant: obviousIrrelevant.length === 0 && unknownRelevance.length === 0,
      slots_contiguous_from_1: missingSlotIndices.length === 0,
      slot_values_well_formed: malformedSlots.length === 0,
      amazon_image_url_shapes_valid: malformedUrlSlots.length === 0,
      exact_urls_unique: duplicateUrls.length === 0,
      exact_asset_sha256_unique: duplicateHashes.length === 0,
      no_known_true_visual_duplicates: knownVisualDuplicates.length === 0,
      exact_local_binary_evidence_complete: localEvidenceProblems.length === 0,
      current_matches_sealed_gallery_after: currentMatchesSealedAfter,
      current_matches_prior_live_before: currentMatchesPriorBefore,
      remote_url_reachability_freshly_checked: false,
    },
    diagnostics: {
      slot_indices: slotIndices,
      approved_card_slots: approvedCardSlots,
      missing_slot_indices: missingSlotIndices,
      malformed_slots: malformedSlots,
      malformed_url_slots: malformedUrlSlots.map((slot) => slot.slot_index),
      duplicate_urls: duplicateUrls,
      duplicate_asset_sha256: duplicateHashes,
      known_true_visual_duplicates: knownVisualDuplicates,
      obvious_irrelevant_slots: obviousIrrelevant.map((slot) => ({
        slot_index: slot.slot_index,
        sha256: slot.asset_sha256,
        relevance_basis: slot.relevance_basis,
      })),
      unknown_relevance_slots: unknownRelevance.map((slot) => slot.slot_index),
      local_evidence_problem_slots: localEvidenceProblems.map((slot) => slot.slot_index),
    },
    prior_gate_context: finalGateRow
      ? {
          gate_status: finalGateRow.gate_status,
          readback_status: finalGateRow.readback_status,
          prior_row_evidence_sha256: finalGateRow.evidence?.row_evidence_sha256 ?? null,
        }
      : null,
    status,
    needs_fix_reasons: unique(needsFixReasons),
    unknown_reasons: unique(unknownReasons),
  };
  return { ...rowBase, row_evidence_sha256: sha256Bytes(canonicalJson(rowBase)) };
});

const summary = {
  total: rows.length,
  status: countBy(rows, (row) => row.status),
  approved_card_exact_slot_1: countBy(rows, (row) => row.checks.approved_card_exact_slot_1),
  other_slot_count_distribution: countBy(rows, (row) => row.counts.other_product_image_slots),
  additional_count_distribution: countBy(
    rows,
    (row) => row.counts.additional_images_after_excluding_fixed_card,
  ),
  rows_with_obvious_irrelevant_images: rows.filter(
    (row) => row.counts.obvious_irrelevant_additional_images > 0,
  ).length,
  rows_with_unknown_relevance: rows.filter(
    (row) => row.counts.unknown_relevance_additional_images > 0,
  ).length,
  rows_with_exact_url_or_byte_duplicates: rows.filter(
    (row) => row.diagnostics.duplicate_urls.length > 0 || row.diagnostics.duplicate_asset_sha256.length > 0,
  ).length,
  rows_with_known_true_visual_duplicates: rows.filter(
    (row) => row.diagnostics.known_true_visual_duplicates.length > 0,
  ).length,
  rows_with_complete_exact_local_binary_evidence: rows.filter(
    (row) => row.checks.exact_local_binary_evidence_complete,
  ).length,
  current_matches_sealed_gallery_after: rows.filter(
    (row) => row.checks.current_matches_sealed_gallery_after,
  ).length,
  current_matches_prior_live_before: rows.filter(
    (row) => row.checks.current_matches_prior_live_before,
  ).length,
  remote_url_reachability_freshly_checked: 0,
  external_mutations: 0,
};

const generatedAt = new Date().toISOString();
const artifactBase = {
  schema_version: "uncrustables-owner-relaxed-gallery-audit/v1",
  audit_id: `UORGA-${generatedAt.replaceAll(/[-:.]/g, "")}-${sourceFiles[0].file_sha256.slice(0, 12)}`,
  created_at: generatedAt,
  immutable: true,
  offline_only: true,
  external_mutations: 0,
  scope: {
    marketplace: "AMAZON_US",
    store_index: 1,
    expected: 164,
    captured: rows.length,
    unique_skus: new Set(rows.map((row) => row.sku)).size,
    unique_asins: new Set(rows.map((row) => row.asin)).size,
  },
  owner_relaxed_policy: {
    fixed_card: {
      requirement: "other_product_image_locator_1 is the exact owner-approved price/customer-note card",
      exact_url: APPROVED_CARD_URL,
      exact_sha256: APPROVED_CARD_SHA256,
      occurrences_required: 1,
    },
    additional_images_after_fixed_card: { min: 4, max: 6 },
    relevance: {
      accepted: [
        "exact-recipe manufacturer image",
        "primary listed component image in a mix",
        "approved flavor-neutral context image",
        "sealed-plan validated image",
      ],
      rejected: [
        "image explicitly showing unsold or unmapped flavors",
        "retailer-specific Only-at-Target copy on Amazon",
        "low-quality or invalid asset",
      ],
      intentionally_not_required: [
        "every mixed-bundle component represented in gallery",
        "equal round-robin component balance",
        "rebuild solely because current order differs from the old strict desired plan",
      ],
    },
    uniqueness: "No exact URL duplicate, exact decoded-byte SHA duplicate, or previously human-confirmed true visual duplicate within one gallery",
    evidence: "Fresh SP-API slot URLs plus exact prior URL->binary SHA/local-file evidence; no fresh image HTTP fetch was performed",
    status_precedence: "NEEDS_FIX when a concrete defect exists; otherwise UNKNOWN when local/relevance evidence is missing; otherwise PASS",
  },
  approved_template_evidence: {
    exact_url: APPROVED_CARD_URL,
    exact_sha256: APPROVED_CARD_SHA256,
    local_file: approvedCardLocal,
    manual_visual_verification: finalGalleryGate.fixed_card_manual_visual_verification,
  },
  source_files: sourceFiles,
  limitations: [
    "Offline audit: current remote image HTTP reachability and buyer-facing PDP projection were not checked.",
    "Fresh snapshot captured exact current secondary locator values, but did not capture fresh secondary image bytes.",
    "A PASS therefore proves current SP-API slot structure plus exact matching local evidence, not a fresh buyer-facing binary readback.",
  ],
  summary,
  rows,
};
const artifact = { ...artifactBase, body_sha256: sha256Bytes(canonicalJson(artifactBase)) };

const csvColumns = [
  "ordinal",
  "sku",
  "asin",
  "status",
  "other_slot_count",
  "slot_indices",
  "approved_card_slots",
  "approved_card_exact_slot_1",
  "additional_after_fixed_card",
  "additional_count_4_to_6",
  "relaxed_relevant_additional",
  "obvious_irrelevant_additional",
  "unknown_relevance_additional",
  "slots_contiguous",
  "exact_urls_unique",
  "exact_asset_sha256_unique",
  "known_true_visual_duplicate_count",
  "local_binary_evidence_complete",
  "fresh_secondary_binary_evidence_count",
  "current_matches_sealed_after",
  "remote_url_reachability_freshly_checked",
  "needs_fix_reasons",
  "unknown_reasons",
  "listing_sha256",
  "row_evidence_sha256",
];
const csvRows = rows.map((row) => [
  row.ordinal,
  row.sku,
  row.asin,
  row.status,
  row.counts.other_product_image_slots,
  row.diagnostics.slot_indices,
  row.diagnostics.approved_card_slots,
  row.checks.approved_card_exact_slot_1,
  row.counts.additional_images_after_excluding_fixed_card,
  row.checks.additional_count_4_to_6,
  row.counts.relaxed_relevant_additional_images,
  row.counts.obvious_irrelevant_additional_images,
  row.counts.unknown_relevance_additional_images,
  row.checks.slots_contiguous_from_1,
  row.checks.exact_urls_unique,
  row.checks.exact_asset_sha256_unique,
  row.diagnostics.known_true_visual_duplicates.length,
  row.checks.exact_local_binary_evidence_complete,
  row.counts.fresh_snapshot_secondary_binary_evidence,
  row.checks.current_matches_sealed_gallery_after,
  row.checks.remote_url_reachability_freshly_checked,
  row.needs_fix_reasons,
  row.unknown_reasons,
  row.fresh_snapshot.listing_sha256,
  row.row_evidence_sha256,
]);
const csv = [csvColumns, ...csvRows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

const parentDir = path.dirname(OUTPUT_DIR);
const tempDir = path.join(parentDir, `.tmp-${path.basename(OUTPUT_DIR)}-${process.pid}`);
if (fs.existsSync(tempDir)) throw new Error(`Temporary output directory already exists: ${tempDir}`);
fs.mkdirSync(tempDir, { recursive: false });

const jsonName = "uncrustables-owner-relaxed-gallery-audit-20260719-v1.json";
const csvName = "uncrustables-owner-relaxed-gallery-audit-20260719-v1.csv";
const jsonPath = path.join(tempDir, jsonName);
const csvPath = path.join(tempDir, csvName);
fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
fs.writeFileSync(csvPath, csv);
fs.writeFileSync(`${jsonPath}.sha256`, `${sha256File(jsonPath)}  ${jsonName}\n`);
fs.writeFileSync(`${csvPath}.sha256`, `${sha256File(csvPath)}  ${csvName}\n`);
fs.renameSync(tempDir, OUTPUT_DIR);

console.log(JSON.stringify({
  output_dir: relative(OUTPUT_DIR),
  json: { path: relative(path.join(OUTPUT_DIR, jsonName)), sha256: sha256File(path.join(OUTPUT_DIR, jsonName)) },
  csv: { path: relative(path.join(OUTPUT_DIR, csvName)), sha256: sha256File(path.join(OUTPUT_DIR, csvName)) },
  body_sha256: artifact.body_sha256,
  summary,
}, null, 2));
