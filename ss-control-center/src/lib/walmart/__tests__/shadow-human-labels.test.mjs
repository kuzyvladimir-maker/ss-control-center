import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BUYER_SNAPSHOT_SCHEMA } from "../buyer-facing-snapshot.ts";
import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  compileWalmartCatalogTruthExport,
} from "../catalog-truth-export.ts";
import {
  WALMART_SHADOW_HUMAN_EXECUTION_EVIDENCE_SCHEMA,
  WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA,
  WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA,
  WALMART_SHADOW_REVIEWER_REGISTRY_SCHEMA,
  buildWalmartShadowHumanLabelSetAgainstSources,
  buildWalmartShadowHumanTrustedContext,
  buildWalmartShadowHumanLabelSet,
  validateWalmartShadowHumanExecutionEvidence,
  validateWalmartShadowHumanLabelSet,
  validateWalmartShadowHumanLabelSetAgainstSources,
  validateWalmartShadowHumanLabelSetAgainstExecutionEvidence,
  validateWalmartShadowHumanTrustedContext,
  validateWalmartShadowHumanLabelSetAgainstSourcesAndExecutionEvidence,
  verifyWalmartShadowHumanTrustedContextAgainstSources,
  walmartShadowHumanCaseBindingSha256,
} from "../shadow-human-labels.ts";
import {
  SHADOW_50_QUOTAS,
  WALMART_PERFORMANCE_ASSURANCE,
  WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS,
  WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS,
  WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
  WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
  WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
  WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
  buildWalmartShadow50,
  compileWalmartShadowSelectionEvidence,
  walmartListingKey,
  walmartOrdersPartitionId,
} from "../shadow-50.ts";

const MANIFEST_SHA = "a".repeat(64);
const EXPORT_SHA = "b".repeat(64);
const REVIEWER_SUBJECTS = {
  "reviewer-a": "1".repeat(64),
  "reviewer-b": "2".repeat(64),
  "reviewer-c": "3".repeat(64),
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function bodySha(value) {
  const body = structuredClone(value);
  delete body.body_sha256;
  return canonicalSha(body);
}

const SOURCE_CAPTURED_AT = "2026-07-18T16:00:00.000Z";
const SOURCE_MAIN_BYTES = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function byteSha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function listingIdentity(sku, storeIndex = 1) {
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: walmartListingKey(storeIndex, sku),
  };
}

function performanceSourceProvenance(rows, capturedAt, startsAt, endsAt) {
  const binding = (schemaVersion, kind, sourceScope, storeIndex, partition = null) => ({
    schema_version: schemaVersion,
    source_scope: sourceScope,
    seller_account_fingerprint_sha256: canonicalSha(`seller-account:${storeIndex}`),
    artifact_id: `${kind}-${sourceScope}-${storeIndex}${partition ? `-${partition.name}` : ""}`,
    body_sha256: canonicalSha(`${kind}:${sourceScope}:${storeIndex}:${partition?.name ?? "none"}`),
    captured_at: capturedAt,
    store_index: storeIndex,
    partition_id: partition?.partition_id ?? null,
    partition_starts_at_exclusive: partition?.starts_at ?? null,
    partition_ends_at_exclusive: partition?.ends_at ?? null,
  });
  const storeIndexes = [...new Set(rows.map((row) => row.store_index))].sort((left, right) => left - right);
  const partitionRows = [];
  for (const storeIndex of storeIndexes) {
    const baselineEnd = new Date(Date.parse(endsAt) - 1).toISOString();
    const tailStart = new Date(Date.parse(endsAt) - 2).toISOString();
    for (const scope of ["3PLFulfilled", "SellerFulfilled", "WFSFulfilled"]) {
      for (const partition of [
        { name: "baseline", starts_at: startsAt, ends_at: baselineEnd },
        { name: "tail", starts_at: tailStart, ends_at: endsAt },
      ]) {
        partitionRows.push(binding(
          "walmart-raw-orders-pages/v2",
          "orders",
          scope,
          storeIndex,
          {
            ...partition,
            partition_id: walmartOrdersPartitionId({
              store_index: storeIndex,
              seller_account_fingerprint_sha256: canonicalSha(`seller-account:${storeIndex}`),
              ship_node_type: scope,
              sales_window_starts_at_exclusive: startsAt,
              sales_window_ends_at_exclusive: endsAt,
              partition_starts_at_exclusive: partition.starts_at,
              partition_ends_at_exclusive: partition.ends_at,
            }),
          },
        ));
      }
    }
  }
  const orderPartitionIds = partitionRows
    .map((row) => row.partition_id)
    .sort();
  return {
    source_bindings: {
      published_population: storeIndexes.map((storeIndex) => binding(
        "walmart-performance-published-population/v1", "population", "PUBLISHED", storeIndex,
      )),
      orders: partitionRows,
      returns: storeIndexes.flatMap((storeIndex) => ["WFS_N", "WFS_Y"].map((scope) => binding(
        "walmart-raw-returns-pages/v1", "returns", scope, storeIndex,
      ))),
    },
    source_reconciliation: {
      published_population_rows: rows.length,
      unique_orders: 0,
      order_lines: 0,
      eligible_sold_lines: 0,
      unique_returns: 0,
      return_lines: 0,
      replacement_order_lines_excluded: 0,
      order_lines_outside_published_population: 0,
      outcome_units_outside_sales_cohort: 0,
      outcome_units_outside_published_population: 0,
      outcome_units_suppressed_by_precedence: 0,
      cancelled_outcome_units_excluded: 0,
      order_partitions: orderPartitionIds.length,
      order_partition_ids: orderPartitionIds,
      overlapping_orders_deduplicated: 0,
      outcome_units_unknown_or_pre_window_purchase_order: 0,
      outcome_units_replacement_purchase_order: 0,
    },
  };
}

function sourceEvidence(sourceRefId, supports) {
  return {
    source_ref_id: sourceRefId,
    source_kind: "sku_reference_catalog",
    locator: `product-truth://${sourceRefId}`,
    captured_at: SOURCE_CAPTURED_AT,
    payload_sha256: canonicalSha(`payload:${sourceRefId}`),
    supports,
  };
}

function sourceTruthRevision(sku, setup) {
  const identity = {
    brand_aliases: ["Example Brand"],
    product_marker_groups: [["snack product", "snack"]],
    variant_marker_groups: [],
    forbidden_markers: [{ role: "variant", aliases: ["diet"] }],
  };
  const packageFacts = [{
    kind: "net_content",
    value: 10,
    unit: "oz",
    requirement: "if_visible",
  }];
  const revisionId = `revision-${sku}`;
  const componentId = `component-${sku}`;
  const recipeRef = `recipe-${sku}`;
  const structuredRef = `structured-${sku}`;
  const truthRef = `truth-${sku}`;
  const body = {
    revision_id: revisionId,
    listing_kind: setup.listingKind,
    category: "snacks",
    recipe: {
      recipe_id: `${revisionId}-recipe`,
      composition: "same_product",
      outer_units: setup.outerUnits,
      components: [{
        component_id: componentId,
        quantity: setup.outerUnits,
        identity,
        package_facts: packageFacts,
        source_ref_ids: [recipeRef],
      }],
      source_ref_ids: [recipeRef],
    },
    structured_record: {
      outer_units: setup.outerUnits,
      components: [{ component_id: componentId, quantity: setup.outerUnits }],
      source_ref_ids: [structuredRef],
    },
    proposed_truth: {
      outer_units: setup.outerUnits,
      identity,
      package_facts: packageFacts,
      truth_source: "recipe",
      source_ref_ids: [truthRef],
    },
    source_evidence: [
      { ...sourceEvidence(recipeRef, ["outer_units", "component_truth"]), source_kind: "recipe_record" },
      sourceEvidence(structuredRef, ["outer_units", "component_truth"]),
      sourceEvidence(truthRef, ["outer_units", "identity", "package_facts"]),
    ],
  };
  const revisionBodySha = canonicalSha(body);
  const approvalBody = {
    decision: "approved",
    revision_body_sha256: revisionBodySha,
    approved_at: SOURCE_CAPTURED_AT,
    approved_by: "owner-fixture",
    approval_authority: "product_truth_platform_owner_gate",
    approval_method: "trusted_platform_record",
  };
  return {
    revision_id: revisionId,
    body_sha256: revisionBodySha,
    approval: { ...approvalBody, approval_sha256: canonicalSha(approvalBody) },
    superseded_by_revision_id: null,
    listing_kind: body.listing_kind,
    category: body.category,
    recipe: body.recipe,
    structured_record: body.structured_record,
    proposed_truth: body.proposed_truth,
    source_evidence: body.source_evidence,
  };
}

function sourceBuyerSnapshot(sku, itemId, setup, options) {
  const title = setup.listingKind === "single"
    ? "Example Brand Snack 10 oz"
    : `Example Brand Snack Pack of ${setup.outerUnits}, 10 oz Each`;
  const actualMainSha = byteSha(SOURCE_MAIN_BYTES);
  const declaredMainSha = options.declaredMainSha ?? actualMainSha;
  const buyerEvidence = [`product.item_id=${itemId}`];
  const body = {
    schema_version: BUYER_SNAPSHOT_SCHEMA,
    captured_at: SOURCE_CAPTURED_AT,
    target: { sku, item_id: itemId },
    identity: {
      exact_sku_match: true,
      exact_item_id_match: true,
      buyer_facing_verified: true,
      seller: {
        sku,
        title,
        upc: "123456789012",
        gtin14: "00123456789012",
        wpid: `WPID-${sku}`,
        published_status: "PUBLISHED",
        lifecycle_status: "ACTIVE",
      },
      catalog_search_candidate: {
        item_id: itemId,
        title,
        main_image_url: "https://i5.walmartimages.com/catalog-candidate.png",
        is_marketplace_item: true,
        duplicate_rows_collapsed: 1,
      },
      buyer: { item_id: itemId, title, identity_evidence: buyerEvidence },
      chain_evidence: {
        seller_to_catalog: [
          `request.sku=${sku}`,
          "seller.normalized_gtin14=00123456789012",
          `catalog.unique_numeric_public_itemId=${itemId}`,
        ],
        catalog_to_buyer_pdp: buyerEvidence,
      },
    },
    source_contract: {
      seller: "walmart_marketplace_exact_sku_get",
      candidate: "walmart_catalog_search_exact_upc",
      buyer: "walmart_buyer_pdp_exact_item_get",
      positional_or_fuzzy_fallbacks: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
    },
    payload_hashes: {
      seller_payload_canonical_sha256: canonicalSha(`seller:${sku}`),
      catalog_search_payload_canonical_sha256: canonicalSha(`catalog:${itemId}`),
      resolution_canonical_sha256: canonicalSha(`resolution:${sku}:${itemId}`),
      buyer_payload_canonical_sha256: canonicalSha(`buyer:${itemId}:${title}`),
    },
    assets: [{
      slot: "MAIN",
      source_url: "https://i5.walmartimages.com/main.png",
      final_url: "https://i5.walmartimages.com/main.png",
      sha256: declaredMainSha,
      bytes: options.declaredByteLength ?? SOURCE_MAIN_BYTES.byteLength,
      media_type: "image/png",
      extension: "png",
      decoded_format: "png",
      decoded_width: options.declaredWidth ?? 1,
      decoded_height: options.declaredHeight ?? 1,
      local_path: `assets/${declaredMainSha}.png`,
    }],
  };
  const snapshotBodySha = canonicalSha(body);
  return {
    ...body,
    snapshot_id: `walmart-buyer-20260718T160000Z-${snapshotBodySha.slice(0, 12)}`,
    body_sha256: snapshotBodySha,
  };
}

function buildSourcePackage(options = {}) {
  const setupByStratum = {
    known_bad_or_return_risk: {
      listingKind: "multipack",
      outerUnits: 6,
      priorVisual: "BAD",
      remediation: "VERIFIED_APPLIED",
    },
    remediated: {
      listingKind: "multipack",
      outerUnits: 4,
      priorVisual: "PASS",
      remediation: "VERIFIED_APPLIED",
    },
    multipack: {
      listingKind: "multipack",
      outerUnits: 3,
      priorVisual: "NOT_AUDITED",
      remediation: "NOT_APPLIED",
    },
    single_unit_control: {
      listingKind: "single",
      outerUnits: 1,
      priorVisual: "NOT_AUDITED",
      remediation: "NOT_APPLIED",
    },
  };
  const nextRank = { high: 1, medium: 25, low: 61 };
  const candidateByRank = new Map();
  const truthRows = [];
  const buyerEntries = [];
  let itemCounter = 8_000_000;
  for (const [stratum, tierQuotas] of Object.entries(SHADOW_50_QUOTAS)) {
    const setup = setupByStratum[stratum];
    for (const [tier, quota] of Object.entries(tierQuotas)) {
      for (let index = 0; index < quota; index += 1) {
        const rank = nextRank[tier]++;
        itemCounter += 1;
        const sku = `${stratum}-${tier}-${String(index).padStart(2, "0")}`;
        const itemId = String(itemCounter);
        candidateByRank.set(rank, {
          ...listingIdentity(sku),
          item_id: itemId,
          setup,
          performance: {
            gross_sales_cents: 1_000_000 - rank,
            units_sold: 121 - rank,
            units_returned: 0,
            units_refunded: 0,
            units_replaced: 0,
          },
        });
        truthRows.push({
          ...listingIdentity(sku),
          item_id: itemId,
          revision: sourceTruthRevision(sku, setup),
        });
        buyerEntries.push({
          ...listingIdentity(sku),
          item_id: itemId,
          snapshot: sourceBuyerSnapshot(sku, itemId, setup, options),
        });
      }
    }
  }
  const selectionRows = [];
  for (let rank = 1; rank <= 120; rank += 1) {
    const candidate = candidateByRank.get(rank);
    if (candidate) {
      selectionRows.push(candidate);
    } else {
      itemCounter += 1;
      const sku = `population-filler-${String(rank).padStart(3, "0")}`;
      selectionRows.push({
        ...listingIdentity(sku),
        item_id: String(itemCounter),
        setup: setupByStratum.single_unit_control,
        performance: {
          gross_sales_cents: 1_000_000 - rank,
          units_sold: 121 - rank,
          units_returned: 0,
          units_refunded: 0,
          units_replaced: 0,
        },
      });
    }
  }
  const truthBody = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: SOURCE_CAPTURED_AT,
    producer: "shared_product_truth_platform",
    rows: truthRows,
  };
  const truthBodySha = canonicalSha(truthBody);
  const truthSnapshot = {
    ...truthBody,
    snapshot_id: `product-truth-${truthBodySha.slice(0, 16)}`,
    body_sha256: truthBodySha,
  };
  const buyerIndexBody = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: SOURCE_CAPTURED_AT,
    entries: buyerEntries,
  };
  const buyerIndexBodySha = canonicalSha(buyerIndexBody);
  const buyerIndex = {
    ...buyerIndexBody,
    index_id: `walmart-buyer-index-${buyerIndexBodySha.slice(0, 16)}`,
    body_sha256: buyerIndexBodySha,
  };
  const catalogTruth = compileWalmartCatalogTruthExport(truthSnapshot, buyerIndex);
  const sourceBase = {
    captured_at: "2026-07-18T16:30:00.000Z",
    channel: "WALMART_US",
    published_population_complete: true,
  };
  const canonicalRows = [...selectionRows].sort((left, right) => (
    left.listing_key < right.listing_key ? -1 : left.listing_key > right.listing_key ? 1 : 0
  ));
  const sourcePrefix = {
    [WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA]: "walmart-shadow-catalog",
    [WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA]: "walmart-shadow-performance",
    [WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA]: "walmart-shadow-prior-visual",
    [WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA]: "walmart-shadow-remediation",
  };
  const sealSelectionSource = (body) => {
    const sha = canonicalSha(body);
    return {
      ...body,
      snapshot_id: `${sourcePrefix[body.schema_version]}-${sha.slice(0, 16)}`,
      body_sha256: sha,
    };
  };
  const salesWindowEndsAt = "2026-07-18T00:00:00.000Z";
  const salesWindowStartsAt = new Date(
    Date.parse(salesWindowEndsAt) - 180 * 86_400_000,
  ).toISOString();
  const publishedCatalog = sealSelectionSource({
    schema_version: WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
    ...sourceBase,
    source_artifact: {
      schema_version: "walmart-item-report-published-source/v1",
      source_id: `walmart-item-report-published-${canonicalSha("item-source").slice(0, 16)}`,
      body_sha256: canonicalSha("item-source"),
      raw_transport_sha256: canonicalSha("item-raw-transport"),
      decoded_report_sha256: canonicalSha("item-decoded-report"),
      cutoff_at: sourceBase.captured_at,
    },
    rows: canonicalRows.map((row) => ({
      ...listingIdentity(row.sku, row.store_index),
      published_status: "PUBLISHED",
    })),
  });
  const publishedBinding = {
    artifact_id: publishedCatalog.snapshot_id,
    body_sha256: publishedCatalog.body_sha256,
    captured_at: publishedCatalog.captured_at,
  };
  const qualifiedMetadata = (kind, accepted) => ({
    cutoff_at: sourceBase.captured_at,
    source_bindings: {
      published_catalog: publishedBinding,
      evidence_ledger: {
        schema_version: `walmart-shadow-${kind}-qualified-evidence-ledger/v1`,
        ledger_id: `walmart-shadow-${kind}-ledger-${canonicalSha(`${kind}-ledger`).slice(0, 16)}`,
        body_sha256: canonicalSha(`${kind}-ledger`),
        captured_at: sourceBase.captured_at,
        mode: "QUALIFIED",
      },
    },
    source_reconciliation: {
      population_rows: canonicalRows.length,
      ledger_entries: accepted,
      evidence_accepted: accepted,
      evidence_rejected: 0,
      output_rows: canonicalRows.length,
      duplicate_listing_keys: 0,
      conflicting_evidence: 0,
      malformed_evidence: 0,
    },
  });
  const priorAccepted = canonicalRows.filter(
    (row) => row.setup.priorVisual !== "NOT_AUDITED",
  ).length;
  const remediationAccepted = canonicalRows.filter(
    (row) => row.setup.remediation === "VERIFIED_APPLIED",
  ).length;
  const selectionSources = {
    publishedCatalog,
    performance: sealSelectionSource({
      schema_version: WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
      ...sourceBase,
      sales_window: {
        starts_at: salesWindowStartsAt,
        start_exclusive: true,
        ends_at: salesWindowEndsAt,
        end_exclusive: true,
        days: 180,
      },
      outcome_observation: {
        starts_at: salesWindowStartsAt,
        cutoff_at: sourceBase.captured_at,
        end_exclusive: true,
      },
      cohort_semantics: structuredClone(WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS),
      money_semantics: structuredClone(WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS),
      assurance: structuredClone(WALMART_PERFORMANCE_ASSURANCE),
      ...performanceSourceProvenance(
        canonicalRows,
        sourceBase.captured_at,
        salesWindowStartsAt,
        salesWindowEndsAt,
      ),
      rows: canonicalRows.map((row) => ({
        ...listingIdentity(row.sku, row.store_index),
        ...row.performance,
      })),
    }),
    priorVisual: sealSelectionSource({
      schema_version: WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
      ...sourceBase,
      ...qualifiedMetadata("prior-visual", priorAccepted),
      rows: canonicalRows.map((row) => ({
        ...listingIdentity(row.sku, row.store_index),
        verdict: row.setup.priorVisual,
        label: row.setup.priorVisual === "NOT_AUDITED" ? null : {
          label_id: `prior-${row.sku}`,
          body_sha256: canonicalSha(`prior:${row.sku}:${row.setup.priorVisual}`),
          labeled_at: "2026-07-18T15:00:00.000Z",
        },
      })),
    }),
    remediation: sealSelectionSource({
      schema_version: WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
      ...sourceBase,
      ...qualifiedMetadata("remediation", remediationAccepted),
      rows: canonicalRows.map((row) => ({
        ...listingIdentity(row.sku, row.store_index),
        status: row.setup.remediation,
        verification: row.setup.remediation === "NOT_APPLIED" ? null : {
          verification_id: `remediation-${row.sku}`,
          body_sha256: canonicalSha(`remediation:${row.sku}`),
          verified_at: "2026-07-18T15:30:00.000Z",
        },
      })),
    }),
  };
  const selectionEvidence = compileWalmartShadowSelectionEvidence(
    selectionSources.publishedCatalog,
    selectionSources.performance,
    selectionSources.priorVisual,
    selectionSources.remediation,
  );
  const manifest = buildWalmartShadow50(
    catalogTruth,
    truthSnapshot,
    buyerIndex,
    selectionEvidence,
    selectionSources.publishedCatalog,
    selectionSources.performance,
    selectionSources.priorVisual,
    selectionSources.remediation,
  );
  const buyerByIdentity = new Map(
    buyerEntries.map((entry) => [
      `${entry.listing_key}\0${entry.item_id}`,
      entry.snapshot,
    ]),
  );
  return {
    shadow_manifest: manifest,
    catalog_truth_export: catalogTruth,
    reviewer_registry: reviewerRegistry(),
    local_main_assets: manifest.cases.map((item) => ({
      case_id: item.case_id,
      snapshot: buyerByIdentity.get(`${item.listing_key}\0${item.item_id}`),
      main_bytes: new Uint8Array(SOURCE_MAIN_BYTES),
    })),
  };
}

function resealTrustedContext(value) {
  const body = {
    schema_version: value.schema_version,
    shadow_manifest_body_sha256: value.shadow_manifest_body_sha256,
    catalog_truth_export_body_sha256: value.catalog_truth_export_body_sha256,
    reviewer_registry: value.reviewer_registry,
    cases: value.cases,
  };
  const sha = canonicalSha(body);
  return {
    ...body,
    context_id: `walmart-shadow-human-context-${sha.slice(0, 16)}`,
    body_sha256: sha,
  };
}

function binding(index) {
  const caseId = `case-${String(index).padStart(2, "0")}`;
  return {
    case_id: caseId,
    sku: `sku-${index}`,
    item_id: String(100000 + index),
    shadow_manifest_body_sha256: MANIFEST_SHA,
    catalog_truth_export_body_sha256: EXPORT_SHA,
    preflight_input_sha256: canonicalSha(`preflight-input:${index}`),
    preflight_result_sha256: canonicalSha(`preflight-result:${index}`),
    product_truth_snapshot_body_sha256: "c".repeat(64),
    recipe_revision_subject_sha256: canonicalSha(`revision:${index}`),
    recipe_approval_sha256: canonicalSha(`approval:${index}`),
    buyer_snapshot_body_sha256: canonicalSha(`buyer:${index}`),
    main_asset_sha256: canonicalSha(`main:${index}`),
    blinded_assignment_sha256: canonicalSha({
      case_id: caseId,
      visible_inputs: ["sealed_expected_truth", "sealed_original_main"],
    }),
  };
}

function reviewerRegistry() {
  const body = {
    schema_version: WALMART_SHADOW_REVIEWER_REGISTRY_SCHEMA,
    captured_at: "2026-07-18T17:00:00.000Z",
    reviewers: Object.entries(REVIEWER_SUBJECTS).map(([reviewer_id, subject_sha256]) => ({
      reviewer_id,
      subject_sha256,
    })),
  };
  const sha = canonicalSha(body);
  return {
    ...body,
    registry_id: `walmart-shadow-reviewers-${sha.slice(0, 16)}`,
    body_sha256: sha,
  };
}

function trustedContext(cases, registry = reviewerRegistry()) {
  const body = {
    schema_version: WALMART_SHADOW_HUMAN_TRUSTED_CONTEXT_SCHEMA,
    shadow_manifest_body_sha256: MANIFEST_SHA,
    catalog_truth_export_body_sha256: EXPORT_SHA,
    reviewer_registry: registry,
    cases,
  };
  const sha = canonicalSha(body);
  return {
    ...body,
    context_id: `walmart-shadow-human-context-${sha.slice(0, 16)}`,
    body_sha256: sha,
  };
}

function reviewerLabel(caseBinding, reviewerId, verdict = "PASS", overrides = {}) {
  return {
    case_id: caseBinding.case_id,
    case_binding_sha256: walmartShadowHumanCaseBindingSha256(caseBinding),
    reviewer_id: reviewerId,
    reviewer_subject_sha256: REVIEWER_SUBJECTS[reviewerId],
    verdict,
    defect_codes: verdict === "BAD" ? ["WRONG_PRODUCT"] : [],
    rationale: verdict === "PASS" ? "All visible facts match." : "Visible product is wrong.",
    labeled_at: "2026-07-18T18:00:00.000Z",
    ...overrides,
  };
}

function adjudication(caseBinding, labels, overrides = {}) {
  return {
    case_id: caseBinding.case_id,
    case_binding_sha256: walmartShadowHumanCaseBindingSha256(caseBinding),
    adjudicator_id: "reviewer-c",
    adjudicator_subject_sha256: REVIEWER_SUBJECTS["reviewer-c"],
    reviewer_label_sha256s: labels.map(canonicalSha),
    final_verdict: "BAD",
    defect_codes: ["WRONG_PRODUCT"],
    rationale: "Original sealed pixels show a different product.",
    adjudicated_at: "2026-07-18T18:30:00.000Z",
    ...overrides,
  };
}

function basePackage() {
  const cases = Array.from({ length: 50 }, (_, index) => binding(index + 1));
  const context = trustedContext(cases);
  return {
    context,
    input: {
      schema_version: WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA,
      trusted_context_body_sha256: context.body_sha256,
      finalized_at: "2026-07-18T19:00:00.000Z",
      reviewer_labels: cases.flatMap((item) => [
        reviewerLabel(item, "reviewer-a"),
        reviewerLabel(item, "reviewer-b"),
      ]),
      adjudications: [],
    },
  };
}

function executionEvidence(labelSet, firstPrimaryCallAt = "2026-07-18T20:00:00.000Z") {
  const body = {
    schema_version: WALMART_SHADOW_HUMAN_EXECUTION_EVIDENCE_SCHEMA,
    human_label_set_body_sha256: labelSet.body_sha256,
    shadow_manifest_body_sha256: labelSet.shadow_manifest_body_sha256,
    first_primary_call_at: firstPrimaryCallAt,
  };
  const sha = canonicalSha(body);
  return {
    ...body,
    evidence_id: `walmart-shadow-human-execution-${sha.slice(0, 16)}`,
    body_sha256: sha,
  };
}

test("source-aware builder derives exact 50 bindings from manifest/export and actual MAIN bytes", () => {
  const sources = buildSourcePackage();
  const context = buildWalmartShadowHumanTrustedContext(sources);
  assert.equal(context.cases.length, 50);
  assert.equal(context.shadow_manifest_body_sha256, sources.shadow_manifest.body_sha256);
  assert.equal(
    context.catalog_truth_export_body_sha256,
    sources.catalog_truth_export.body_sha256,
  );
  assert.deepEqual(
    context.cases.map((item) => [item.case_id, item.sku, item.item_id]),
    sources.shadow_manifest.cases.map((item) => [item.case_id, item.sku, item.item_id]),
  );
  assert.deepEqual(
    context.cases.map((item) => item.main_asset_sha256),
    sources.shadow_manifest.cases.map((item) => item.bindings.buyer_main_asset_sha256),
  );
  assert.deepEqual(
    verifyWalmartShadowHumanTrustedContextAgainstSources(context, sources),
    context,
  );
  const input = {
    schema_version: WALMART_SHADOW_HUMAN_LABEL_INPUT_SCHEMA,
    trusted_context_body_sha256: context.body_sha256,
    finalized_at: "2026-07-18T19:00:00.000Z",
    reviewer_labels: context.cases.flatMap((item) => [
      reviewerLabel(item, "reviewer-a"),
      reviewerLabel(item, "reviewer-b"),
    ]),
    adjudications: [],
  };
  const labelSet = buildWalmartShadowHumanLabelSetAgainstSources(input, context, sources);
  assert.equal(labelSet.execution_proof_status, "PENDING");
  assert.deepEqual(
    validateWalmartShadowHumanLabelSetAgainstSources(labelSet, context, sources),
    labelSet,
  );
  assert.deepEqual(
    validateWalmartShadowHumanLabelSetAgainstSourcesAndExecutionEvidence(
      labelSet,
      context,
      sources,
      executionEvidence(labelSet),
    ),
    labelSet,
  );
});

test("source-aware verifier rejects a fully re-sealed forged context", () => {
  const sources = buildSourcePackage();
  const context = buildWalmartShadowHumanTrustedContext(sources);
  const forged = structuredClone(context);
  forged.cases[0].preflight_result_sha256 = "9".repeat(64);
  const resealed = resealTrustedContext(forged);
  assert.deepEqual(validateWalmartShadowHumanTrustedContext(resealed), resealed);
  assert.throws(
    () => verifyWalmartShadowHumanTrustedContextAgainstSources(resealed, sources),
    /does not exactly match source-derived context/,
  );
});

test("source-aware verifier rejects reordered and missing context cases", () => {
  const sources = buildSourcePackage();
  const context = buildWalmartShadowHumanTrustedContext(sources);
  const reordered = structuredClone(context);
  [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  const resealedReordered = resealTrustedContext(reordered);
  assert.deepEqual(
    validateWalmartShadowHumanTrustedContext(resealedReordered),
    resealedReordered,
  );
  assert.throws(
    () => verifyWalmartShadowHumanTrustedContextAgainstSources(resealedReordered, sources),
    /does not exactly match source-derived context/,
  );

  const missing = structuredClone(context);
  missing.cases.pop();
  assert.throws(
    () => verifyWalmartShadowHumanTrustedContextAgainstSources(
      resealTrustedContext(missing),
      sources,
    ),
    /exactly 50 source-derived bindings/,
  );
});

test("source-aware builder requires exact ordered local MAIN evidence coverage", () => {
  const sources = buildSourcePackage();
  const reordered = structuredClone(sources);
  [reordered.local_main_assets[0], reordered.local_main_assets[1]] = [
    reordered.local_main_assets[1],
    reordered.local_main_assets[0],
  ];
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(reordered),
    /case\/order differs from the exact Shadow manifest/,
  );

  const missing = structuredClone(sources);
  missing.local_main_assets.pop();
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(missing),
    /local_main_assets must contain exactly 50 ordered entries/,
  );
});

test("source-aware builder rejects detached or falsely declared actual MAIN bytes", () => {
  const wrongActualBytes = buildSourcePackage();
  wrongActualBytes.local_main_assets[0].main_bytes[wrongActualBytes.local_main_assets[0].main_bytes.length - 1]
    ^= 0xff;
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(wrongActualBytes),
    /actual MAIN byte SHA-256 differs/,
  );

  const wrongDeclaredHash = buildSourcePackage({ declaredMainSha: "9".repeat(64) });
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(wrongDeclaredHash),
    /actual MAIN byte SHA-256 differs/,
  );
});

test("local MAIN preflight verifies sealed byte length and actual raster dimensions", () => {
  const wrongLength = buildSourcePackage({
    declaredByteLength: SOURCE_MAIN_BYTES.byteLength + 1,
  });
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(wrongLength),
    /actual MAIN byte length differs/,
  );

  const wrongDimensions = buildSourcePackage({ declaredWidth: 2 });
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(wrongDimensions),
    /actual MAIN raster png 1x1 differs.*png 2x1/,
  );
});

test("tampering any manifest case without rebuilding the full seal is rejected first", () => {
  const sources = buildSourcePackage();
  sources.shadow_manifest.cases[0].bindings.buyer_main_asset_sha256 = "9".repeat(64);
  assert.throws(
    () => buildWalmartShadowHumanTrustedContext(sources),
    /full body\/selection seal verification failed/,
  );
});

test("builds from the separate trusted context and leaves execution proof pending", () => {
  const { input, context } = basePackage();
  const output = buildWalmartShadowHumanLabelSet(input, context);
  assert.equal(output.cases.length, 50);
  assert.equal(output.summary.reviewer_labels, 100);
  assert.equal(output.summary.pass_cases, 50);
  assert.equal(output.summary.unresolved_final_cases, 0);
  assert.equal(output.execution_proof_status, "PENDING");
  assert(!Object.hasOwn(output.summary, "labels_sealed_before_model_execution"));
  assert.equal(output.trusted_context_body_sha256, context.body_sha256);
  assert.match(output.body_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateWalmartShadowHumanTrustedContext(context), context);
  assert.deepEqual(validateWalmartShadowHumanLabelSet(output, context), output);
});

test("requires a distinct trusted third subject for disagreement or UNRESOLVED", () => {
  const { input, context } = basePackage();
  const target = context.cases[0];
  input.reviewer_labels[1] = reviewerLabel(target, "reviewer-b", "BAD");
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(input, context),
    /disagreement or UNRESOLVED requires adjudication/,
  );

  const labels = input.reviewer_labels.slice(0, 2);
  input.adjudications = [adjudication(target, labels)];
  const output = buildWalmartShadowHumanLabelSet(input, context);
  assert.equal(output.cases[0].final_verdict, "BAD");
  assert.equal(output.cases[0].final_label_basis, "third_party_adjudication");

  const notThird = structuredClone(input);
  notThird.adjudications[0].adjudicator_id = "reviewer-a";
  notThird.adjudications[0].adjudicator_subject_sha256 = REVIEWER_SUBJECTS["reviewer-a"];
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(notThird, context),
    /distinct third trusted subject/,
  );

  const unresolved = basePackage();
  unresolved.input.reviewer_labels[0] = reviewerLabel(
    unresolved.context.cases[0],
    "reviewer-a",
    "UNRESOLVED",
  );
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(unresolved.input, unresolved.context),
    /UNRESOLVED requires adjudication/,
  );
});

test("reviewer IDs and immutable subjects must both match the trusted registry", () => {
  const wrongSubject = basePackage();
  wrongSubject.input.reviewer_labels[0].reviewer_subject_sha256 = REVIEWER_SUBJECTS["reviewer-b"];
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(wrongSubject.input, wrongSubject.context),
    /identity is not bound to the trusted registry/,
  );

  const duplicate = basePackage();
  duplicate.input.reviewer_labels[1].reviewer_id = "reviewer-a";
  duplicate.input.reviewer_labels[1].reviewer_subject_sha256 = REVIEWER_SUBJECTS["reviewer-a"];
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(duplicate.input, duplicate.context),
    /distinct trusted subjects/,
  );

  const duplicateRegistrySubjects = reviewerRegistry();
  duplicateRegistrySubjects.reviewers[1].subject_sha256 = duplicateRegistrySubjects.reviewers[0].subject_sha256;
  const registryBody = {
    schema_version: duplicateRegistrySubjects.schema_version,
    captured_at: duplicateRegistrySubjects.captured_at,
    reviewers: duplicateRegistrySubjects.reviewers,
  };
  duplicateRegistrySubjects.body_sha256 = canonicalSha(registryBody);
  duplicateRegistrySubjects.registry_id = `walmart-shadow-reviewers-${duplicateRegistrySubjects.body_sha256.slice(0, 16)}`;
  const cases = Array.from({ length: 50 }, (_, index) => binding(index + 1));
  assert.throws(
    () => validateWalmartShadowHumanTrustedContext(
      trustedContext(cases, duplicateRegistrySubjects),
    ),
    /reviewer subject contains duplicates/,
  );
});

test("raw label input cannot author cases or detach a blinded assignment", () => {
  const extraCases = basePackage();
  extraCases.input.cases = extraCases.context.cases;
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(extraCases.input, extraCases.context),
    /unsupported fields: cases/,
  );

  const changedAssignment = basePackage();
  const alteredCases = structuredClone(changedAssignment.context.cases);
  alteredCases[0].blinded_assignment_sha256 = "9".repeat(64);
  const alteredContext = trustedContext(alteredCases);
  changedAssignment.input.trusted_context_body_sha256 = alteredContext.body_sha256;
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(changedAssignment.input, alteredContext),
    /case binding SHA mismatch/,
  );

  const riskLeak = basePackage();
  riskLeak.input.reviewer_labels[0].risk_stratum = "known_bad";
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(riskLeak.input, riskLeak.context),
    /unsupported fields: risk_stratum/,
  );

  const modelLeak = basePackage();
  modelLeak.input.reviewer_labels[0].model_verdict = "BAD";
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(modelLeak.input, modelLeak.context),
    /unsupported fields: model_verdict/,
  );
});

test("trusted context requires exactly 50 unique source-derived identities", () => {
  const missing = basePackage();
  assert.throws(
    () => validateWalmartShadowHumanTrustedContext(
      trustedContext(missing.context.cases.slice(0, 49)),
    ),
    /exactly 50 source-derived bindings/,
  );

  const duplicateSku = structuredClone(missing.context.cases);
  duplicateSku[1].sku = duplicateSku[0].sku;
  assert.throws(
    () => validateWalmartShadowHumanTrustedContext(trustedContext(duplicateSku)),
    /case SKU contains duplicates/,
  );

  const detachedManifest = structuredClone(missing.context.cases);
  detachedManifest[0].shadow_manifest_body_sha256 = EXPORT_SHA;
  assert.throws(
    () => validateWalmartShadowHumanTrustedContext(trustedContext(detachedManifest)),
    /trusted case is detached from the Shadow manifest/,
  );

  const missingLabel = basePackage();
  missingLabel.input.reviewer_labels.pop();
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(missingLabel.input, missingLabel.context),
    /exactly 100 reviewer labels/,
  );
});

test("uses canonical millisecond timestamps and strict event ordering", () => {
  const late = basePackage();
  late.input.reviewer_labels[0].labeled_at = late.input.finalized_at;
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(late.input, late.context),
    /strictly predate finalization/,
  );

  const nonCanonical = basePackage();
  nonCanonical.input.reviewer_labels[0].labeled_at = "2026-07-18T18:00:00.000000001Z";
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(nonCanonical.input, nonCanonical.context),
    /canonical millisecond/,
  );

  const beforeRegistry = basePackage();
  beforeRegistry.input.reviewer_labels[0].labeled_at = "2026-07-18T17:00:00.000Z";
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(beforeRegistry.input, beforeRegistry.context),
    /predates the trusted reviewer registry/,
  );

  const equalAdjudication = basePackage();
  const target = equalAdjudication.context.cases[0];
  equalAdjudication.input.reviewer_labels[1] = reviewerLabel(target, "reviewer-b", "BAD");
  const labels = equalAdjudication.input.reviewer_labels.slice(0, 2);
  equalAdjudication.input.adjudications = [adjudication(target, labels, {
    adjudicated_at: "2026-07-18T18:00:00.000Z",
  })];
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(equalAdjudication.input, equalAdjudication.context),
    /must strictly follow both reviewer labels/,
  );
});

test("enforces decisive verdict semantics", () => {
  const badWithoutDefect = basePackage();
  badWithoutDefect.input.reviewer_labels[0].verdict = "BAD";
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(badWithoutDefect.input, badWithoutDefect.context),
    /BAD must carry/,
  );

  const passWithDefect = basePackage();
  passWithDefect.input.reviewer_labels[0].defect_codes = ["WRONG_PRODUCT"];
  assert.throws(
    () => buildWalmartShadowHumanLabelSet(passWithDefect.input, passWithDefect.context),
    /PASS must not carry/,
  );
});

test("serialized tampering and final-case reordering fail against trusted context", () => {
  const { input, context } = basePackage();
  const output = buildWalmartShadowHumanLabelSet(input, context);

  const tampered = structuredClone(output);
  tampered.cases[0].binding.main_asset_sha256 = "9".repeat(64);
  assert.throws(
    () => validateWalmartShadowHumanLabelSet(tampered, context),
    /body SHA mismatch/,
  );

  const resealedOnlyAtTop = structuredClone(output);
  resealedOnlyAtTop.cases[0].reviewer_labels[0].rationale = "Changed";
  resealedOnlyAtTop.body_sha256 = bodySha(resealedOnlyAtTop);
  assert.throws(
    () => validateWalmartShadowHumanLabelSet(resealedOnlyAtTop, context),
    /reviewer label SHA mismatch/,
  );

  const reordered = structuredClone(output);
  [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  reordered.body_sha256 = bodySha(reordered);
  assert.throws(
    () => validateWalmartShadowHumanLabelSet(reordered, context),
    /binding\/order differs from trusted context/,
  );
});

test("actual first-primary-call evidence is required for the temporal proof", () => {
  const { input, context } = basePackage();
  const output = buildWalmartShadowHumanLabelSet(input, context);
  const evidence = executionEvidence(output);
  assert.deepEqual(validateWalmartShadowHumanExecutionEvidence(evidence), evidence);
  assert.deepEqual(
    validateWalmartShadowHumanLabelSetAgainstExecutionEvidence(output, context, evidence),
    output,
  );

  const wrongSet = executionEvidence(output);
  wrongSet.human_label_set_body_sha256 = "9".repeat(64);
  const wrongBody = {
    schema_version: wrongSet.schema_version,
    human_label_set_body_sha256: wrongSet.human_label_set_body_sha256,
    shadow_manifest_body_sha256: wrongSet.shadow_manifest_body_sha256,
    first_primary_call_at: wrongSet.first_primary_call_at,
  };
  wrongSet.body_sha256 = canonicalSha(wrongBody);
  wrongSet.evidence_id = `walmart-shadow-human-execution-${wrongSet.body_sha256.slice(0, 16)}`;
  assert.throws(
    () => validateWalmartShadowHumanLabelSetAgainstExecutionEvidence(output, context, wrongSet),
    /detached from the exact human label set/,
  );

  const callAtFinalization = executionEvidence(output, output.finalized_at);
  assert.throws(
    () => validateWalmartShadowHumanLabelSetAgainstExecutionEvidence(
      output,
      context,
      callAtFinalization,
    ),
    /not finalized before the first primary model call/,
  );

  const nonCanonicalCall = executionEvidence(output);
  nonCanonicalCall.first_primary_call_at = "2026-07-18T20:00:00Z";
  const nonCanonicalBody = {
    schema_version: nonCanonicalCall.schema_version,
    human_label_set_body_sha256: nonCanonicalCall.human_label_set_body_sha256,
    shadow_manifest_body_sha256: nonCanonicalCall.shadow_manifest_body_sha256,
    first_primary_call_at: nonCanonicalCall.first_primary_call_at,
  };
  nonCanonicalCall.body_sha256 = canonicalSha(nonCanonicalBody);
  nonCanonicalCall.evidence_id = `walmart-shadow-human-execution-${nonCanonicalCall.body_sha256.slice(0, 16)}`;
  assert.throws(
    () => validateWalmartShadowHumanExecutionEvidence(nonCanonicalCall),
    /canonical millisecond/,
  );
});
