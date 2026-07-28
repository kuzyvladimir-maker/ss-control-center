import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BUYER_SNAPSHOT_SCHEMA } from "../buyer-facing-snapshot.ts";
import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  catalogTruthCanonicalSha256,
  compileWalmartCatalogTruthExport,
  verifyWalmartCatalogTruthAuditExport,
} from "../catalog-truth-export.ts";
import {
  SHADOW_50_ACCEPTANCE_GATES,
  SHADOW_50_QUOTAS,
  WALMART_SHADOW_50_SCHEMA,
  WALMART_SHADOW_50_SEED,
  WALMART_SHADOW_LISTING_CHANNEL,
  WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS,
  WALMART_PERFORMANCE_ASSURANCE,
  WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS,
  WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
  WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
  WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
  WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
  buildWalmartShadow50,
  canonicalWalmartShadowJson,
  compileWalmartShadowSelectionEvidence,
  sealWalmartShadowSelectionEvidence,
  verifyWalmartShadow50Manifest,
  verifyWalmartShadow50ManifestAgainstSources,
  verifyWalmartShadowPriorVisualSource,
  verifyWalmartShadowRemediationSource,
  verifyWalmartShadowSelectionEvidence,
  verifyWalmartShadowSelectionEvidenceAgainstSources,
  walmartListingKey,
  walmartOrdersPartitionId,
  walmartShadowCanonicalSha256,
} from "../shadow-50.ts";

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

test("public Shadow canonical JSON and SHA-256 stay deterministic for normal inputs", () => {
  const left = { z: [3, { b: false, a: "truth" }], a: 1 };
  const right = { a: 1, z: [3, { a: "truth", b: false }] };
  const expectedJson = canonicalJson(right);

  assert.equal(canonicalWalmartShadowJson(left), expectedJson);
  assert.equal(canonicalWalmartShadowJson(right), expectedJson);
  assert.equal(walmartShadowCanonicalSha256(left), sha(expectedJson));
  assert.equal(walmartShadowCanonicalSha256(right), sha(expectedJson));
});

test("public Shadow hashing rejects depth before recursive serialization or cloning", () => {
  let deeplyNested = { leaf: true };
  for (let depth = 0; depth < 5_000; depth += 1) deeplyNested = { nested: deeplyNested };

  const assertDepthBudgetError = (operation) => assert.throws(
    operation,
    (error) => {
      assert.equal(error instanceof RangeError, false);
      assert.match(error.message, /Walmart Shadow JSON depth budget/);
      return true;
    },
  );

  assertDepthBudgetError(() => walmartShadowCanonicalSha256(deeplyNested));
  assertDepthBudgetError(() => sealWalmartShadowSelectionEvidence(deeplyNested));
});

test("public Shadow JSON guard rejects broad key and node budgets deterministically", () => {
  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 50_001 }, (_, index) => [`key_${index}`, null]),
  );
  const tooManyNodes = new Array(500_000).fill(null);

  assert.throws(
    () => walmartShadowCanonicalSha256(tooManyKeys),
    /per-object Walmart Shadow JSON key budget/,
  );
  assert.throws(
    () => walmartShadowCanonicalSha256(tooManyNodes),
    /Walmart Shadow JSON node budget/,
  );
});

test("public Shadow JSON guard rejects per-string and aggregate string budgets", () => {
  const oneMegabyte = "x".repeat(1024 * 1024);

  assert.throws(
    () => walmartShadowCanonicalSha256(`${oneMegabyte}x`),
    /per-string Walmart Shadow JSON budget/,
  );
  assert.throws(
    () => walmartShadowCanonicalSha256(new Array(17).fill(oneMegabyte)),
    /aggregate string Walmart Shadow JSON budget/,
  );
});

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function listingIdentity(sku, storeIndex = 1) {
  return {
    channel: WALMART_SHADOW_LISTING_CHANNEL,
    store_index: storeIndex,
    sku,
    listing_key: walmartListingKey(storeIndex, sku),
  };
}

const SOURCE_ID_PREFIX = {
  [WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA]: "walmart-shadow-catalog",
  [WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA]: "walmart-shadow-performance",
  [WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA]: "walmart-shadow-prior-visual",
  [WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA]: "walmart-shadow-remediation",
};

function sealSelectionSource(body) {
  const bodySha = sha(body);
  return {
    ...structuredClone(body),
    snapshot_id: `${SOURCE_ID_PREFIX[body.schema_version]}-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function resealSelectionSource(source) {
  const body = structuredClone(source);
  delete body.snapshot_id;
  delete body.body_sha256;
  return sealSelectionSource(body);
}

const HASHES = {
  catalog: sha("published-catalog"),
  performance: sha("performance"),
  priorVisual: sha("prior-visual"),
  remediation: sha("remediation"),
  evidence: sha("reference-catalog-evidence"),
};

const stratumSetup = {
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

const CATALOG_CAPTURED_AT = "2026-07-17T12:00:00.000Z";

function publishedSourceArtifact(cutoffAt) {
  return {
    schema_version: "walmart-item-report-published-source/v1",
    source_id: `walmart-item-report-published-${HASHES.catalog.slice(0, 16)}`,
    body_sha256: HASHES.catalog,
    raw_transport_sha256: sha("raw-item-report-transport"),
    decoded_report_sha256: sha("decoded-item-report"),
    cutoff_at: cutoffAt,
  };
}

function performanceSourceProvenance(rows, capturedAt, startsAt, endsAt) {
  const binding = (schemaVersion, kind, sourceScope, storeIndex, partition = null) => ({
    schema_version: schemaVersion,
    source_scope: sourceScope,
    seller_account_fingerprint_sha256: sha(`seller-account:${storeIndex}`),
    artifact_id: `${kind}-${sourceScope}-${storeIndex}${partition ? `-${partition.name}` : ""}`,
    body_sha256: sha(`${kind}:${sourceScope}:${storeIndex}:${partition?.name ?? "none"}`),
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
              seller_account_fingerprint_sha256: sha(`seller-account:${storeIndex}`),
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
    .sort(compareCodeUnits);
  return {
    source_bindings: {
      published_population: storeIndexes.map((storeIndex) => binding(
        "walmart-performance-published-population/v1",
        "population",
        "PUBLISHED",
        storeIndex,
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

function catalogDigest(value) {
  return catalogTruthCanonicalSha256(value);
}

function productIdentity({ brandAsProduct = false } = {}) {
  return {
    brand_aliases: [brandAsProduct ? "Dr Pepper" : "Example Brand"],
    product_marker_groups: brandAsProduct ? [] : [["snack product", "snack"]],
    variant_marker_groups: [],
    forbidden_markers: [{ role: "variant", aliases: ["diet"] }],
  };
}

function packageFacts() {
  return [{ kind: "net_content", value: 10, unit: "oz", requirement: "if_visible" }];
}

function sourceEvidence(sourceRefId, sourceKind, supports) {
  return {
    source_ref_id: sourceRefId,
    source_kind: sourceKind,
    locator: `product-truth://${sourceRefId}`,
    captured_at: CATALOG_CAPTURED_AT,
    payload_sha256: HASHES.evidence,
    supports,
  };
}

function truthRevision({ sku, category, setup, brandAsProduct, composition = "same_product" }) {
  const identity = productIdentity({ brandAsProduct });
  const facts = packageFacts();
  const componentId = `component-${sku}`;
  const revisionId = `revision-${sku}`;
  const body = {
    revision_id: revisionId,
    listing_kind: setup.listingKind,
    category,
    recipe: {
      recipe_id: `${revisionId}-recipe`,
      composition,
      outer_units: setup.outerUnits,
      components: [{
        component_id: componentId,
        quantity: setup.outerUnits,
        identity,
        package_facts: facts,
        source_ref_ids: [`recipe-${sku}`],
      }],
      source_ref_ids: [`recipe-${sku}`],
    },
    structured_record: {
      outer_units: setup.outerUnits,
      components: [{ component_id: componentId, quantity: setup.outerUnits }],
      source_ref_ids: [`structured-${sku}`],
    },
    proposed_truth: {
      outer_units: setup.outerUnits,
      identity,
      package_facts: facts,
      truth_source: "recipe",
      source_ref_ids: [`truth-${sku}`],
    },
    source_evidence: [
      sourceEvidence(`recipe-${sku}`, "recipe_record", ["outer_units", "component_truth"]),
      sourceEvidence(`structured-${sku}`, "sku_reference_catalog", ["outer_units", "component_truth"]),
      sourceEvidence(`truth-${sku}`, "sku_reference_catalog", ["outer_units", "identity", "package_facts"]),
    ],
  };
  const bodySha = catalogDigest(body);
  const approvalBody = {
    decision: "approved",
    revision_body_sha256: bodySha,
    approved_at: CATALOG_CAPTURED_AT,
    approved_by: "owner-fixture",
    approval_authority: "product_truth_platform_owner_gate",
    approval_method: "trusted_platform_record",
  };
  return {
    revision_id: revisionId,
    body_sha256: bodySha,
    approval: { ...approvalBody, approval_sha256: catalogDigest(approvalBody) },
    superseded_by_revision_id: null,
    listing_kind: body.listing_kind,
    category: body.category,
    recipe: body.recipe,
    structured_record: body.structured_record,
    proposed_truth: body.proposed_truth,
    source_evidence: body.source_evidence,
  };
}

function truthRow({ sku, itemId, category, setup, brandAsProduct = false }) {
  return {
    ...listingIdentity(sku),
    item_id: itemId,
    revision: truthRevision({ sku, category, setup, brandAsProduct }),
  };
}

function sealTruthSnapshot(rows) {
  const body = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: CATALOG_CAPTURED_AT,
    producer: "shared_product_truth_platform",
    rows,
  };
  const bodySha = catalogDigest(body);
  return { ...body, snapshot_id: `product-truth-${bodySha.slice(0, 16)}`, body_sha256: bodySha };
}

function buyerSnapshot({ sku, itemId, setup, brandAsProduct = false }) {
  const productName = brandAsProduct ? "Dr Pepper" : "Example Brand Snack";
  const title = setup.listingKind === "single"
    ? `${productName} 10 oz`
    : `${productName} Pack of ${setup.outerUnits}, 10 oz Each`;
  const mainSha = catalogDigest(`main:${sku}:${itemId}`);
  const buyerEvidence = [`product.item_id=${itemId}`];
  const body = {
    schema_version: BUYER_SNAPSHOT_SCHEMA,
    captured_at: CATALOG_CAPTURED_AT,
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
      seller_payload_canonical_sha256: catalogDigest(`seller:${sku}`),
      catalog_search_payload_canonical_sha256: catalogDigest(`catalog:${itemId}`),
      resolution_canonical_sha256: catalogDigest(`resolution:${sku}:${itemId}`),
      buyer_payload_canonical_sha256: catalogDigest(`buyer:${itemId}:${title}`),
    },
    assets: [{
      slot: "MAIN",
      source_url: "https://i5.walmartimages.com/main.png",
      final_url: "https://i5.walmartimages.com/main.png",
      sha256: mainSha,
      bytes: 1234,
      media_type: "image/png",
      extension: "png",
      decoded_format: "png",
      decoded_width: 1200,
      decoded_height: 1200,
      local_path: `assets/${mainSha}.png`,
    }],
  };
  const bodySha = catalogDigest(body);
  return {
    ...body,
    snapshot_id: `walmart-buyer-20260717T120000Z-${bodySha.slice(0, 12)}`,
    body_sha256: bodySha,
  };
}

function sealBuyerIndex(entries) {
  const body = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: CATALOG_CAPTURED_AT,
    entries,
  };
  const bodySha = catalogDigest(body);
  return { ...body, index_id: `walmart-buyer-index-${bodySha.slice(0, 16)}`, body_sha256: bodySha };
}

function buyerIndexEntry(snapshot, storeIndex = 1) {
  return {
    ...listingIdentity(snapshot.target.sku, storeIndex),
    item_id: snapshot.target.item_id,
    snapshot,
  };
}

function resealForgedCatalogExport(value) {
  const cases = value.cases.map((item) => {
    const body = structuredClone(item);
    delete body.case_id;
    return {
      case_id: `walmart-truth-case-${catalogDigest(body).slice(0, 20)}`,
      ...body,
    };
  });
  const body = {
    schema_version: value.schema_version,
    product_truth_snapshot: value.product_truth_snapshot,
    buyer_index: value.buyer_index,
    summary: value.summary,
    cases,
  };
  const bodySha = catalogDigest(body);
  return {
    ...body,
    export_id: `walmart-truth-audit-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function resealShadowManifest(value) {
  const draft = structuredClone(value);
  delete draft.manifest_id;
  delete draft.selection_sha256;
  delete draft.body_sha256;
  const selectionMaterial = {
    seed: draft.seed,
    source_bindings: draft.source_bindings,
    selection_policy: draft.selection_policy,
    cases: draft.cases,
    distribution: draft.distribution,
    acceptance_gates: draft.acceptance_gates,
  };
  const selectionSha = sha(selectionMaterial);
  const body = {
    schema_version: draft.schema_version,
    manifest_id: `walmart-shadow-50-${selectionSha.slice(0, 16)}`,
    selection_sha256: selectionSha,
    ...selectionMaterial,
  };
  return { ...body, body_sha256: sha(body) };
}

function makeFixture(extraPerCell = 1) {
  const populationSize = 120;
  const nextRank = { high: 1, medium: 25, low: 61 };
  const candidateRowsByRank = new Map();
  const truthRows = [];
  const buyerEntries = [];
  let itemCounter = 3_000_000;
  for (const [stratum, tierQuotas] of Object.entries(SHADOW_50_QUOTAS)) {
    const setup = stratumSetup[stratum];
    for (const [tier, quota] of Object.entries(tierQuotas)) {
      for (let index = 0; index < quota + extraPerCell; index += 1) {
        const rank = nextRank[tier]++;
        itemCounter += 1;
        const sku = `${stratum}-${tier}-${index}`;
        const itemId = String(itemCounter);
        const row = {
          ...listingIdentity(sku),
          item_id: itemId,
          performance: {
            gross_sales_cents: 1_000_000 - rank,
            units_sold: populationSize + 1 - rank,
            units_returned: 0,
            units_refunded: 0,
            units_replaced: 0,
          },
          prior_visual: {
            verdict: setup.priorVisual,
            label: setup.priorVisual === "NOT_AUDITED" ? null : {
              label_id: `prior-label-${sku}`,
              body_sha256: sha(`prior-label:${sku}:${setup.priorVisual}`),
              labeled_at: "2026-07-17T19:00:00Z",
            },
          },
          remediation: {
            status: setup.remediation,
            verification: setup.remediation === "NOT_APPLIED" ? null : {
              verification_id: `remediation-verification-${sku}`,
              body_sha256: sha(`remediation-verification:${sku}`),
              verified_at: "2026-07-17T19:30:00Z",
            },
          },
        };
        candidateRowsByRank.set(rank, row);
        const catalogInput = {
          sku,
          itemId,
          category: `category-${index % 5}`,
          setup,
          brandAsProduct: truthRows.length === 0,
        };
        truthRows.push(truthRow(catalogInput));
        buyerEntries.push(buyerIndexEntry(buyerSnapshot(catalogInput)));
      }
    }
  }
  const rows = [];
  for (let rank = 1; rank <= populationSize; rank += 1) {
    const candidate = candidateRowsByRank.get(rank);
    if (candidate) {
      rows.push(candidate);
      continue;
    }
    itemCounter += 1;
    rows.push({
      ...listingIdentity(`population-filler-${rank}`),
      item_id: String(itemCounter),
      performance: {
        gross_sales_cents: 1_000_000 - rank,
        units_sold: populationSize + 1 - rank,
        units_returned: 0,
        units_refunded: 0,
        units_replaced: 0,
      },
      prior_visual: { verdict: "NOT_AUDITED", label: null },
      remediation: { status: "NOT_APPLIED", verification: null },
    });
  }
  const productTruthSnapshot = sealTruthSnapshot(truthRows);
  const buyerIndex = sealBuyerIndex(buyerEntries);
  const truth = compileWalmartCatalogTruthExport(productTruthSnapshot, buyerIndex);
  const end = "2026-07-17T00:00:00.000Z";
  const start = new Date(Date.parse(end) - 180 * 86_400_000).toISOString();
  const sourceBase = {
    captured_at: "2026-07-17T20:00:00.000Z",
    channel: "WALMART_US",
    published_population_complete: true,
  };
  const canonicalRows = [...rows].sort((left, right) => (
    compareCodeUnits(left.listing_key, right.listing_key)
  ));
  const publishedCatalog = sealSelectionSource({
    schema_version: WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
    ...sourceBase,
    source_artifact: publishedSourceArtifact(sourceBase.captured_at),
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
        ledger_id: `walmart-shadow-${kind}-ledger-${sha(`${kind}-ledger`).slice(0, 16)}`,
        body_sha256: sha(`${kind}-ledger`),
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
    (row) => row.prior_visual.verdict !== "NOT_AUDITED",
  ).length;
  const remediationAccepted = canonicalRows.filter(
    (row) => row.remediation.status === "VERIFIED_APPLIED",
  ).length;
  const selectionSources = {
    publishedCatalog,
    performance: sealSelectionSource({
      schema_version: WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
      ...sourceBase,
      sales_window: {
        starts_at: start,
        start_exclusive: true,
        ends_at: end,
        end_exclusive: true,
        days: 180,
      },
      outcome_observation: {
        starts_at: start,
        cutoff_at: sourceBase.captured_at,
        end_exclusive: true,
      },
      cohort_semantics: structuredClone(WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS),
      money_semantics: structuredClone(WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS),
      assurance: structuredClone(WALMART_PERFORMANCE_ASSURANCE),
      ...performanceSourceProvenance(canonicalRows, sourceBase.captured_at, start, end),
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
        ...row.prior_visual,
      })),
    }),
    remediation: sealSelectionSource({
      schema_version: WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
      ...sourceBase,
      ...qualifiedMetadata("remediation", remediationAccepted),
      rows: canonicalRows.map((row) => ({
        ...listingIdentity(row.sku, row.store_index),
        ...row.remediation,
      })),
    }),
  };
  const selection = compileWalmartShadowSelectionEvidence(
    selectionSources.publishedCatalog,
    selectionSources.performance,
    selectionSources.priorVisual,
    selectionSources.remediation,
  );
  return { truth, productTruthSnapshot, buyerIndex, selection, selectionSources };
}

function buildFixtureManifest(fixture) {
  return buildWalmartShadow50(
    fixture.truth,
    fixture.productTruthSnapshot,
    fixture.buyerIndex,
    fixture.selection,
    fixture.selectionSources.publishedCatalog,
    fixture.selectionSources.performance,
    fixture.selectionSources.priorVisual,
    fixture.selectionSources.remediation,
  );
}

function withSharedBuyerItem(fixture, firstSku, secondSku) {
  const updated = structuredClone(fixture);
  const first = updated.productTruthSnapshot.rows.find((row) => row.sku === firstSku);
  const second = updated.productTruthSnapshot.rows.find((row) => row.sku === secondSku);
  assert.ok(first);
  assert.ok(second);
  second.item_id = first.item_id;
  updated.productTruthSnapshot = sealTruthSnapshot(updated.productTruthSnapshot.rows);

  const secondEntryIndex = updated.buyerIndex.entries.findIndex(
    (entry) => entry.listing_key === second.listing_key,
  );
  assert.notEqual(secondEntryIndex, -1);
  updated.buyerIndex.entries[secondEntryIndex] = buyerIndexEntry(buyerSnapshot({
    sku: second.sku,
    itemId: first.item_id,
    setup: {
      listingKind: second.revision.listing_kind,
      outerUnits: second.revision.proposed_truth.outer_units,
    },
  }), second.store_index);
  updated.buyerIndex = sealBuyerIndex(updated.buyerIndex.entries);
  updated.truth = compileWalmartCatalogTruthExport(
    updated.productTruthSnapshot,
    updated.buyerIndex,
  );
  return updated;
}

test("v3 selects deterministic exact quotas from sealed listing-key source snapshots", () => {
  const fixture = makeFixture(1);
  const first = buildFixtureManifest(fixture);
  const second = buildFixtureManifest(structuredClone(fixture));

  assert.equal(first.schema_version, WALMART_SHADOW_50_SCHEMA);
  assert.equal(first.seed, WALMART_SHADOW_50_SEED);
  assert.equal(first.selection_policy.truth_schema, "walmart-visual-audit/v3");
  assert.equal(
    first.selection_policy.operational_status,
    "SOURCE_SCHEMAS_READY_UPSTREAM_PROVENANCE_AND_REVENUE_CALIBRATION_NO_GO",
  );
  assert.equal(first.source_bindings.selection_evidence.source_recompile_verified, true);
  assert.equal(first.source_bindings.selection_evidence.upstream_provenance_verified, false);
  assert.equal(first.cases.length, 50);
  assert.ok(first.cases.every((item) => item.lifecycle_status === "ACTIVE"));
  assert.equal(first.manifest_id, second.manifest_id);
  assert.equal(first.body_sha256, second.body_sha256);
  assert.deepEqual(first.cases.map((item) => item.sku), second.cases.map((item) => item.sku));
  assert.deepEqual(first.distribution.strata, {
    known_bad_or_return_risk: 15,
    remediated: 15,
    multipack: 10,
    single_unit_control: 10,
  });
  assert.deepEqual(first.distribution.sales_tiers, { high: 20, medium: 16, low: 14 });
  assert.equal(new Set(first.cases.map((item) => item.sku)).size, 50);
  assert.equal(new Set(first.cases.map((item) => item.item_id)).size, 50);
  assert.equal(first.source_bindings.catalog_truth_export.body_sha256, fixture.truth.body_sha256);
  assert.equal(first.source_bindings.selection_evidence.body_sha256, fixture.selection.body_sha256);
  assert.equal(
    first.source_bindings.catalog_truth_export.product_truth_snapshot_body_sha256,
    fixture.productTruthSnapshot.body_sha256,
  );
  assert.equal(
    first.source_bindings.catalog_truth_export.buyer_index_body_sha256,
    fixture.buyerIndex.body_sha256,
  );
  assert.equal(verifyWalmartShadow50Manifest(first), true);
  assert.equal(
    verifyWalmartShadow50ManifestAgainstSources(
      first,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ).body_sha256,
    first.body_sha256,
  );
});

test("full source population has no public item-id or seller-WPID identity dependency", () => {
  const fixture = makeFixture(1);
  for (const source of Object.values(fixture.selectionSources)) {
    for (const row of source.rows) {
      assert.equal(Object.hasOwn(row, "item_id"), false);
      assert.equal(Object.hasOwn(row, "seller_wpid"), false);
      assert.equal(row.listing_key, walmartListingKey(row.store_index, row.sku));
    }
  }

  const withSellerWpid = structuredClone(fixture.selectionSources.publishedCatalog);
  withSellerWpid.rows[0].seller_wpid = "2IAXRO7DM5YP";
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      resealSelectionSource(withSellerWpid),
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /unsupported fields: seller_wpid/,
  );
});

test("global buyer-item uniqueness deterministically backfills inside the same quota cell", () => {
  const fixture = withSharedBuyerItem(
    makeFixture(1),
    "known_bad_or_return_risk-high-0",
    "known_bad_or_return_risk-high-1",
  );
  const sharedItemId = fixture.productTruthSnapshot.rows.find(
    (row) => row.sku === "known_bad_or_return_risk-high-0",
  ).item_id;
  const manifest = buildFixtureManifest(fixture);
  const cell = manifest.cases.filter(
    (item) => item.primary_stratum === "known_bad_or_return_risk" && item.sales_tier === "high",
  );
  assert.equal(cell.length, SHADOW_50_QUOTAS.known_bad_or_return_risk.high);
  assert.equal(new Set(cell.map((item) => item.item_id)).size, cell.length);
  assert.equal(cell.filter((item) => item.item_id === sharedItemId).length, 1);
  assert.equal(new Set(manifest.cases.map((item) => item.item_id)).size, 50);
});

test("selected quota fails closed when duplicate buyer IDs leave too few unique cases", () => {
  const fixture = withSharedBuyerItem(
    makeFixture(0),
    "known_bad_or_return_risk-high-0",
    "known_bad_or_return_risk-high-1",
  );
  const first = fixture.productTruthSnapshot.rows.find(
    (row) => row.sku === "known_bad_or_return_risk-high-0",
  );

  assert.equal(
    fixture.truth.cases.filter((item) => item.item_id === first.item_id).length,
    2,
    "Product Truth may bind two listings to the same exact buyer product",
  );
  assert.throws(
    () => buildFixtureManifest(fixture),
    /need 6 unique-buyer-item AUDITABLE candidates, found 5/,
  );
});

test("fixed policy exports are deeply frozen and built manifests are mutation-isolated", () => {
  assert.equal(Object.isFrozen(SHADOW_50_QUOTAS), true);
  assert.equal(Object.isFrozen(SHADOW_50_QUOTAS.known_bad_or_return_risk), true);
  assert.equal(Object.isFrozen(SHADOW_50_ACCEPTANCE_GATES), true);
  assert.equal(Object.isFrozen(SHADOW_50_ACCEPTANCE_GATES.safety), true);
  assert.equal(
    Reflect.set(SHADOW_50_ACCEPTANCE_GATES.safety, "shadow_execution_ready", true),
    false,
  );
  assert.equal(Reflect.set(SHADOW_50_QUOTAS.known_bad_or_return_risk, "high", 5), false);

  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);
  const originalBodySha = manifest.body_sha256;
  assert.equal(Object.isFrozen(manifest.acceptance_gates), false);
  assert.equal(Object.isFrozen(manifest.selection_policy.quotas), false);

  manifest.acceptance_gates.safety.shadow_execution_ready = true;
  manifest.selection_policy.quotas.known_bad_or_return_risk.high = 5;
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.shadow_execution_ready, false);
  assert.equal(SHADOW_50_QUOTAS.known_bad_or_return_risk.high, 6);
  assert.equal(verifyWalmartShadow50Manifest(resealShadowManifest(manifest)), false);

  const fresh = buildFixtureManifest(fixture);
  assert.equal(fresh.body_sha256, originalBodySha);
  assert.equal(fresh.acceptance_gates.safety.shadow_execution_ready, false);
  assert.equal(fresh.selection_policy.quotas.known_bad_or_return_risk.high, 6);
  assert.equal(verifyWalmartShadow50Manifest(fresh), true);
});

test("manifest seed is the single precommitted operational seed", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);
  assert.equal(manifest.seed, WALMART_SHADOW_50_SEED);

  assert.throws(
    () => buildWalmartShadow50(
      fixture.truth,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
      "caller-selected-seed",
    ),
    /custom shadow seed is unsupported/,
  );

  const customSeed = structuredClone(manifest);
  customSeed.seed = "caller-selected-seed";
  assert.equal(verifyWalmartShadow50Manifest(resealShadowManifest(customSeed)), false);
});

test("category distribution safely supports object-prototype-like category names", () => {
  const fixture = makeFixture(1);
  const draft = structuredClone(buildFixtureManifest(fixture));
  const specialCategories = ["__proto__", "constructor", "toString"];
  specialCategories.forEach((category, index) => {
    draft.cases[index].category = category;
  });
  const categoryCounts = new Map();
  for (const item of draft.cases) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  }
  draft.distribution.categories = Object.fromEntries(categoryCounts);
  const resealed = resealShadowManifest(draft);

  assert.equal(Object.hasOwn(resealed.distribution.categories, "__proto__"), true);
  assert.equal(resealed.distribution.categories.__proto__, 1);
  assert.equal(resealed.distribution.categories.constructor, 1);
  assert.equal(resealed.distribution.categories.toString, 1);
  assert.equal(verifyWalmartShadow50Manifest(resealed), true);
});

test("listing identity is case-sensitive, store-scoped, and canonically code-unit ordered", () => {
  const capturedAt = "2026-07-17T20:00:00.000Z";
  const endsAt = "2026-07-17T00:00:00.000Z";
  const startsAt = new Date(Date.parse(endsAt) - 180 * 86_400_000).toISOString();
  const identities = [
    listingIdentity("Z-sku"),
    listingIdentity("a-sku"),
    listingIdentity("z-sku"),
    listingIdentity("é-sku"),
    listingIdentity("Z-sku", 2),
  ];
  const sourceBase = {
    captured_at: capturedAt,
    channel: "WALMART_US",
    published_population_complete: true,
  };
  const published = sealSelectionSource({
    schema_version: WALMART_SHADOW_PUBLISHED_CATALOG_SOURCE_SCHEMA,
    ...sourceBase,
    source_artifact: publishedSourceArtifact(sourceBase.captured_at),
    rows: identities.map((row) => ({ ...row, published_status: "PUBLISHED" })),
  });
  const zeroEvidenceMetadata = (kind) => ({
    cutoff_at: sourceBase.captured_at,
    source_bindings: {
      published_catalog: {
        artifact_id: published.snapshot_id,
        body_sha256: published.body_sha256,
        captured_at: published.captured_at,
      },
      evidence_ledger: {
        schema_version: `walmart-shadow-${kind}-qualified-evidence-ledger/v1`,
        ledger_id: `walmart-shadow-${kind}-ledger-${sha(`${kind}-zero`).slice(0, 16)}`,
        body_sha256: sha(`${kind}-zero`),
        captured_at: sourceBase.captured_at,
        mode: "ZERO_EVIDENCE",
      },
    },
    source_reconciliation: {
      population_rows: identities.length,
      ledger_entries: 0,
      evidence_accepted: 0,
      evidence_rejected: 0,
      output_rows: identities.length,
      duplicate_listing_keys: 0,
      conflicting_evidence: 0,
      malformed_evidence: 0,
    },
  });
  const performance = sealSelectionSource({
    schema_version: WALMART_SHADOW_PERFORMANCE_SOURCE_SCHEMA,
    ...sourceBase,
    sales_window: {
      starts_at: startsAt,
      start_exclusive: true,
      ends_at: endsAt,
      end_exclusive: true,
      days: 180,
    },
    outcome_observation: {
      starts_at: startsAt,
      cutoff_at: sourceBase.captured_at,
      end_exclusive: true,
    },
    cohort_semantics: structuredClone(WALMART_SHADOW_PERFORMANCE_COHORT_SEMANTICS),
    money_semantics: structuredClone(WALMART_SHADOW_PERFORMANCE_MONEY_SEMANTICS),
    assurance: structuredClone(WALMART_PERFORMANCE_ASSURANCE),
    ...performanceSourceProvenance(
      identities,
      sourceBase.captured_at,
      startsAt,
      endsAt,
    ),
    rows: identities.map((row) => ({
      ...row,
      gross_sales_cents: 0,
      units_sold: 0,
      units_returned: 0,
      units_refunded: 0,
      units_replaced: 0,
    })),
  });
  const priorVisual = sealSelectionSource({
    schema_version: WALMART_SHADOW_PRIOR_VISUAL_SOURCE_SCHEMA,
    ...sourceBase,
    ...zeroEvidenceMetadata("prior-visual"),
    rows: identities.map((row) => ({ ...row, verdict: "NOT_AUDITED", label: null })),
  });
  const remediation = sealSelectionSource({
    schema_version: WALMART_SHADOW_REMEDIATION_SOURCE_SCHEMA,
    ...sourceBase,
    ...zeroEvidenceMetadata("remediation"),
    rows: identities.map((row) => ({ ...row, status: "NOT_APPLIED", verification: null })),
  });
  const evidence = compileWalmartShadowSelectionEvidence(
    published,
    performance,
    priorVisual,
    remediation,
  );
  assert.deepEqual(evidence.rows.map((row) => row.listing_key), [
    "walmart:1:Z-sku",
    "walmart:1:a-sku",
    "walmart:1:z-sku",
    "walmart:1:é-sku",
    "walmart:2:Z-sku",
  ]);
  assert.equal(evidence.rows[0].sku, "Z-sku");
  assert.equal(evidence.rows[4].sku, "Z-sku");
  assert.notEqual(evidence.rows[0].listing_key, evidence.rows[4].listing_key);
});

test("v3 derives sales tiers, risk, and strata from raw sealed metrics", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);
  const risky = manifest.cases.find((item) => item.primary_stratum === "known_bad_or_return_risk");
  const remediated = manifest.cases.find((item) => item.primary_stratum === "remediated");
  const control = manifest.cases.find((item) => item.primary_stratum === "single_unit_control");
  assert.equal(risky.risk.prior_visual_bad, true);
  assert.equal(risky.risk.risk_tuple[0], 1);
  assert.equal(remediated.risk.prior_visual_bad, false);
  assert.equal(remediated.risk.remediation_applied, true);
  assert.equal(control.listing_kind, "single");
  assert.equal(control.expected.outer_units, 1);

  const callerDerivedField = structuredClone(fixture.selectionSources.performance);
  callerDerivedField.rows[0].risk_score = 999;
  const resealed = resealSelectionSource(callerDerivedField);
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealed,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /risk_score|must have exact keys/,
  );
});

test("180-day 3-unit/15-percent return rule is derived, not caller asserted", () => {
  const fixture = makeFixture(0);
  const performance = structuredClone(fixture.selectionSources.performance);
  const priorVisual = structuredClone(fixture.selectionSources.priorVisual);
  const row = performance.rows.find((item) => item.sku === "known_bad_or_return_risk-high-0");
  const prior = priorVisual.rows.find((item) => item.sku === row.sku);
  row.units_sold = 10;
  row.units_returned = 2;
  prior.verdict = "PASS";
  fixture.selectionSources.performance = resealSelectionSource(performance);
  fixture.selectionSources.priorVisual = resealSelectionSource(priorVisual);
  fixture.selection = compileWalmartShadowSelectionEvidence(
    fixture.selectionSources.publishedCatalog,
    fixture.selectionSources.performance,
    fixture.selectionSources.priorVisual,
    fixture.selectionSources.remediation,
  );

  const manifest = buildFixtureManifest(fixture);
  const derived = manifest.cases.find((item) => item.sku === row.sku);
  assert.ok(derived);
  assert.equal(derived.risk.prior_visual_bad, false);
  assert.equal(derived.risk.elevated_return_risk, true);
  assert.equal(derived.risk.return_rate_ppm, 200_000);
  assert.equal(derived.primary_stratum, "known_bad_or_return_risk");
});

test("return, refund, and replacement buckets remain distinct while risk uses their exact sum", () => {
  const fixture = makeFixture(0);
  const performance = structuredClone(fixture.selectionSources.performance);
  const priorVisual = structuredClone(fixture.selectionSources.priorVisual);
  const row = performance.rows.find((item) => item.sku === "known_bad_or_return_risk-high-0");
  const prior = priorVisual.rows.find((item) => item.listing_key === row.listing_key);
  row.units_sold = 10;
  row.units_returned = 0;
  row.units_refunded = 1;
  row.units_replaced = 1;
  prior.verdict = "PASS";
  fixture.selectionSources.performance = resealSelectionSource(performance);
  fixture.selectionSources.priorVisual = resealSelectionSource(priorVisual);
  fixture.selection = compileWalmartShadowSelectionEvidence(
    fixture.selectionSources.publishedCatalog,
    fixture.selectionSources.performance,
    fixture.selectionSources.priorVisual,
    fixture.selectionSources.remediation,
  );

  const evidenceRow = fixture.selection.rows.find((item) => item.listing_key === row.listing_key);
  assert.deepEqual(evidenceRow.performance, {
    gross_sales_cents: row.gross_sales_cents,
    units_sold: 10,
    units_returned: 0,
    units_refunded: 1,
    units_replaced: 1,
    return_risk_units: 2,
  });
  const derived = buildFixtureManifest(fixture).cases.find(
    (item) => item.listing_key === row.listing_key,
  );
  assert.equal(derived.risk.units_returned, 0);
  assert.equal(derived.risk.units_refunded, 1);
  assert.equal(derived.risk.units_replaced, 1);
  assert.equal(derived.risk.return_risk_units, 2);
  assert.equal(derived.risk.return_rate_ppm, 200_000);
});

test("performance cohort fails closed on outcome overflow or outcomes beyond sold units", () => {
  const fixture = makeFixture(1);
  const beyondSold = structuredClone(fixture.selectionSources.performance);
  beyondSold.rows[0].units_sold = 1;
  beyondSold.rows[0].units_returned = 1;
  beyondSold.rows[0].units_refunded = 1;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealSelectionSource(beyondSold),
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /cannot exceed units_sold|outcome units exceed units_sold/,
  );

  const overflowing = structuredClone(fixture.selectionSources.performance);
  overflowing.rows[0].units_sold = Number.MAX_SAFE_INTEGER;
  overflowing.rows[0].units_returned = Number.MAX_SAFE_INTEGER;
  overflowing.rows[0].units_refunded = 1;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealSelectionSource(overflowing),
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /exceeds Number.MAX_SAFE_INTEGER|outcome units exceed units_sold/,
  );
});

test("MAX_SAFE cohort ppm and ordering are exact without Number multiplication/subtraction overflow", () => {
  const fixture = makeFixture(1);
  const performance = structuredClone(fixture.selectionSources.performance);
  const row = performance.rows.find((item) => item.sku === "known_bad_or_return_risk-high-0");
  row.gross_sales_cents = Number.MAX_SAFE_INTEGER;
  row.units_sold = Number.MAX_SAFE_INTEGER;
  row.units_returned = Number.MAX_SAFE_INTEGER - 1;
  row.units_refunded = 0;
  row.units_replaced = 0;
  fixture.selectionSources.performance = resealSelectionSource(performance);
  fixture.selection = compileWalmartShadowSelectionEvidence(
    fixture.selectionSources.publishedCatalog,
    fixture.selectionSources.performance,
    fixture.selectionSources.priorVisual,
    fixture.selectionSources.remediation,
  );
  const derived = buildFixtureManifest(fixture).cases.find(
    (item) => item.listing_key === row.listing_key,
  );
  assert.ok(derived);
  assert.equal(derived.sales_tier, "high");
  assert.equal(derived.risk.return_rate_ppm, 1_000_000);
  assert.equal(derived.risk.return_risk_units, Number.MAX_SAFE_INTEGER - 1);
});

test("brand-as-product AUDITABLE truth may have empty product marker groups", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);
  const drPepper = manifest.cases.find((item) => item.expected.identity.brand_aliases[0] === "Dr Pepper");
  assert.ok(drPepper);
  assert.deepEqual(drPepper.expected.identity.product_marker_groups, []);
});

test("v3 refuses quota borrowing after a non-AUDITABLE or unsupported case is blocked", () => {
  const fixture = makeFixture(0);
  const blockedSource = structuredClone(fixture.productTruthSnapshot);
  const targetIndex = blockedSource.rows.findIndex((item) => item.sku === "multipack-low-0");
  assert.notEqual(targetIndex, -1);
  const sourceRow = blockedSource.rows[targetIndex];
  sourceRow.revision = truthRevision({
    sku: sourceRow.sku,
    category: sourceRow.revision.category,
    setup: { listingKind: "bundle", outerUnits: 3 },
    brandAsProduct: false,
    composition: "mixed_bundle",
  });
  const productTruthSnapshot = sealTruthSnapshot(blockedSource.rows);
  const blocked = compileWalmartCatalogTruthExport(productTruthSnapshot, fixture.buyerIndex);
  assert.throws(
    () => buildWalmartShadow50(
      blocked,
      productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /multipack\/low: need 3 unique-buyer-item AUDITABLE candidates, found 2/,
  );
});

test("missing buyer binding blocks an otherwise AUDITABLE case", () => {
  const fixture = makeFixture(0);
  const buyerIndex = sealBuyerIndex(fixture.buyerIndex.entries.filter(
    (item) => item.sku !== "single_unit_control-low-0",
  ));
  const missingBuyer = compileWalmartCatalogTruthExport(fixture.productTruthSnapshot, buyerIndex);
  assert.throws(
    () => buildWalmartShadow50(
      missingBuyer,
      fixture.productTruthSnapshot,
      buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /single_unit_control\/low: need 3 unique-buyer-item AUDITABLE candidates, found 2/,
  );
});

test("detached legacy candidate arrays and unsealed inputs are rejected", () => {
  const fixture = makeFixture(1);
  assert.throws(
    () => buildWalmartShadow50(
      [{ sku: "detached", expected: { title: "Detached" } }],
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /catalog truth audit export must be an object/,
  );

  const unsealedTruth = structuredClone(fixture.truth);
  delete unsealedTruth.body_sha256;
  assert.throws(
    () => buildWalmartShadow50(
      unsealedTruth,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /missing required fields: body_sha256/,
  );

  const unsealedSelection = structuredClone(fixture.selection);
  delete unsealedSelection.body_sha256;
  assert.throws(
    () => buildWalmartShadow50(
      fixture.truth,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      unsealedSelection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /missing required fields: body_sha256/,
  );
});

test("canonical source and manifest seals detect any post-seal mutation", () => {
  const fixture = makeFixture(1);
  assert.equal(verifyWalmartShadowSelectionEvidence(fixture.selection), true);

  const truthTamper = structuredClone(fixture.truth);
  truthTamper.cases[0].preflight.expected.title = "Wrong product after seal";
  assert.throws(
    () => buildWalmartShadow50(
      truthTamper,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /preflight_sha256 does not match preflight|body_sha256 does not match/,
  );

  const selectionTamper = structuredClone(fixture.selection);
  selectionTamper.rows[0].performance.gross_sales_cents += 1;
  assert.equal(verifyWalmartShadowSelectionEvidence(selectionTamper), false);
  assert.throws(
    () => buildWalmartShadow50(
      fixture.truth,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      selectionTamper,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /selection evidence canonical body seal mismatch/,
  );

  const manifest = buildFixtureManifest(fixture);
  const manifestTamper = structuredClone(manifest);
  manifestTamper.cases[0].bindings.buyer_main_asset_sha256 = sha("tampered-main");
  assert.equal(verifyWalmartShadow50Manifest(manifestTamper), false);
});

test("strict manifest verifier rejects fully re-sealed empty cases and false safety readiness", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);

  const emptyDraft = structuredClone(manifest);
  emptyDraft.cases = [];
  emptyDraft.distribution = {
    strata: {
      known_bad_or_return_risk: 0,
      remediated: 0,
      multipack: 0,
      single_unit_control: 0,
    },
    sales_tiers: { high: 0, medium: 0, low: 0 },
    categories: {},
    listing_kinds: { single: 0, multipack: 0 },
  };
  const emptyForged = resealShadowManifest(emptyDraft);
  assert.equal(verifyWalmartShadow50Manifest(emptyForged), false);

  const unsafeDraft = structuredClone(manifest);
  unsafeDraft.acceptance_gates.safety.shadow_execution_ready = true;
  const unsafeForged = resealShadowManifest(unsafeDraft);
  assert.equal(verifyWalmartShadow50Manifest(unsafeForged), false);
});

test("strict manifest verifier rejects re-sealed contradictory case and source claims", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);

  const caseDraft = structuredClone(manifest);
  caseDraft.cases[0].risk.prior_visual_bad = false;
  assert.equal(verifyWalmartShadow50Manifest(resealShadowManifest(caseDraft)), false);

  const inactiveDraft = structuredClone(manifest);
  inactiveDraft.cases[0].lifecycle_status = "RETIRED";
  assert.equal(verifyWalmartShadow50Manifest(resealShadowManifest(inactiveDraft)), false);

  const sourceDraft = structuredClone(manifest);
  sourceDraft.source_bindings.catalog_truth_export.body_sha256 = sha("forged-export");
  assert.equal(verifyWalmartShadow50Manifest(resealShadowManifest(sourceDraft)), false);
});

test("source-aware manifest verifier rejects coherent re-sealed external fact forgery", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);
  const forgedDraft = structuredClone(manifest);
  forgedDraft.cases[0].expected.title = "Forged Different Product Pack of 99";
  forgedDraft.cases[0].bindings.preflight_result_canonical_sha256 = sha("forged-preflight");
  forgedDraft.cases[0].bindings.buyer_main_asset_sha256 = sha("forged-main-asset");
  const forgedExportSha = sha("coherently-forged-catalog-export");
  forgedDraft.source_bindings.catalog_truth_export.body_sha256 = forgedExportSha;
  forgedDraft.source_bindings.catalog_truth_export.export_id =
    `walmart-truth-audit-${forgedExportSha.slice(0, 16)}`;
  const forged = resealShadowManifest(forgedDraft);

  // Self-verification can prove strict shape and internal consistency only.
  assert.equal(verifyWalmartShadow50Manifest(forged), true);
  assert.throws(
    () => verifyWalmartShadow50ManifestAgainstSources(
      forged,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /does not exactly match deterministic compilation from Product Truth/,
  );
});

test("a fully re-sealed forged AUDITABLE result is rejected against Product Truth sources", () => {
  const fixture = makeFixture(1);
  const forgedDraft = structuredClone(fixture.truth);
  forgedDraft.cases[0].preflight.expected.title = "Forged Different Product Pack of 99";
  forgedDraft.cases[0].preflight_sha256 = catalogDigest(forgedDraft.cases[0].preflight);
  const forged = resealForgedCatalogExport(forgedDraft);

  // A canonical body hash is only an integrity check relative to itself.
  assert.equal(verifyWalmartCatalogTruthAuditExport(forged).body_sha256, forged.body_sha256);
  assert.throws(
    () => buildWalmartShadow50(
      forged,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      fixture.selection,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /does not exactly match deterministic compilation from trusted sources/,
  );
});

test("a fully re-sealed forged selection row is rejected against all four frozen sources", () => {
  const fixture = makeFixture(1);
  const forgedBody = structuredClone(fixture.selection);
  delete forgedBody.body_sha256;
  forgedBody.rows[0].performance.gross_sales_cents += 50_000;
  const forged = sealWalmartShadowSelectionEvidence(forgedBody);

  assert.equal(verifyWalmartShadowSelectionEvidence(forged), true);
  assert.throws(
    () => verifyWalmartShadowSelectionEvidenceAgainstSources(
      forged,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /does not exactly match deterministic compilation from four frozen sources/,
  );
  assert.throws(
    () => buildWalmartShadow50(
      fixture.truth,
      fixture.productTruthSnapshot,
      fixture.buyerIndex,
      forged,
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /does not exactly match deterministic compilation from four frozen sources/,
  );
});

test("source, preflight, truth, buyer, and MAIN hashes are bound per selected case", () => {
  const fixture = makeFixture(1);
  const manifest = buildFixtureManifest(fixture);
  for (const item of manifest.cases) {
    assert.match(item.bindings.source_truth_case_canonical_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.bindings.selection_row_canonical_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.bindings.preflight_input_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.bindings.preflight_result_canonical_sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.bindings.evidence_payload_sha256s.includes(HASHES.evidence));
    assert.equal(item.bindings.evidence_payload_sha256s.length, 2);
    assert.ok(item.bindings.evidence_payload_sha256s.every((value) => /^[a-f0-9]{64}$/.test(value)));
    assert.match(item.bindings.truth_revision_body_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.bindings.truth_approval_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.bindings.buyer_snapshot_body_sha256, /^[a-f0-9]{64}$/);
    assert.match(item.bindings.buyer_main_asset_sha256, /^[a-f0-9]{64}$/);
  }
});

test("selection compiler rejects missing, extra, and mismatched source populations", () => {
  const fixture = makeFixture(1);
  const missing = structuredClone(fixture.selectionSources.performance);
  missing.rows.pop();
  missing.source_reconciliation.published_population_rows -= 1;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealSelectionSource(missing),
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /performance source population does not exactly match/,
  );

  const extra = structuredClone(fixture.selectionSources.priorVisual);
  extra.rows.push({
    ...listingIdentity("zz-extra-published-row"),
    verdict: "NOT_AUDITED",
    label: null,
  });
  extra.source_reconciliation.population_rows += 1;
  extra.source_reconciliation.output_rows += 1;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      resealSelectionSource(extra),
      fixture.selectionSources.remediation,
    ),
    /prior visual source population does not exactly match/,
  );

  const mismatch = structuredClone(fixture.selectionSources.remediation);
  Object.assign(mismatch.rows[0], listingIdentity("000-mismatched-listing"));
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      resealSelectionSource(mismatch),
    ),
    /remediation source population does not exactly match/,
  );
});

test("selection sources reject wrong window, duplicate listing identities, and non-canonical hashes", () => {
  const fixture = makeFixture(1);
  const wrongWindow = structuredClone(fixture.selectionSources.performance);
  wrongWindow.sales_window.days = 90;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealSelectionSource(wrongWindow),
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /sales_window.days must be 180/,
  );

  const duplicateListing = structuredClone(fixture.selectionSources.publishedCatalog);
  Object.assign(duplicateListing.rows[1], {
    channel: duplicateListing.rows[0].channel,
    store_index: duplicateListing.rows[0].store_index,
    sku: duplicateListing.rows[0].sku,
    listing_key: duplicateListing.rows[0].listing_key,
  });
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      resealSelectionSource(duplicateListing),
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /duplicate listing_key/,
  );

  const collidingKey = structuredClone(fixture.selectionSources.priorVisual);
  collidingKey.rows[0].listing_key = collidingKey.rows[1].listing_key;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      resealSelectionSource(collidingKey),
      fixture.selectionSources.remediation,
    ),
    /listing_key must exactly equal/,
  );

  const invalidStore = structuredClone(fixture.selectionSources.remediation);
  invalidStore.rows[0].store_index = 0;
  invalidStore.rows[0].listing_key = `walmart:0:${invalidStore.rows[0].sku}`;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      resealSelectionSource(invalidStore),
    ),
    /store_index must be a safe integer >= 1/,
  );

  const callerItemId = structuredClone(fixture.selectionSources.performance);
  callerItemId.rows[0].item_id = "123456789";
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealSelectionSource(callerItemId),
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /item_id|must have exact keys/,
  );

  const uppercaseHash = structuredClone(fixture.selectionSources.performance);
  uppercaseHash.rows[0].gross_sales_cents += 1;
  const resealed = resealSelectionSource(uppercaseHash);
  resealed.body_sha256 = resealed.body_sha256.toUpperCase();
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      resealed,
      fixture.selectionSources.priorVisual,
      fixture.selectionSources.remediation,
    ),
    /must be a lowercase SHA-256/,
  );
});

test("performance v3 rejects legacy boundaries, missing partitions, account rebinding, and reconciliation drift", () => {
  const fixture = makeFixture(1);
  const compileWithPerformance = (performance) => compileWalmartShadowSelectionEvidence(
    fixture.selectionSources.publishedCatalog,
    resealSelectionSource(performance),
    fixture.selectionSources.priorVisual,
    fixture.selectionSources.remediation,
  );

  const legacyWindow = structuredClone(fixture.selectionSources.performance);
  delete legacyWindow.sales_window.start_exclusive;
  delete legacyWindow.sales_window.end_exclusive;
  assert.throws(
    () => compileWithPerformance(legacyWindow),
    /sales_window .*exact keys/,
  );

  const missingOrderScope = structuredClone(fixture.selectionSources.performance);
  missingOrderScope.source_bindings.orders = missingOrderScope.source_bindings.orders.filter(
    (binding) => binding.source_scope !== "WFSFulfilled",
  );
  assert.throws(
    () => compileWithPerformance(missingOrderScope),
    /must (?:contain exact scopes|bind baseline and post-cutoff tail)/,
  );

  const reboundAccount = structuredClone(fixture.selectionSources.performance);
  reboundAccount.source_bindings.returns[0].seller_account_fingerprint_sha256 = sha("other-account");
  assert.throws(
    () => compileWithPerformance(reboundAccount),
    /seller account fingerprints (?:must match within each store|do not match)/,
  );

  const reconciliationDrift = structuredClone(fixture.selectionSources.performance);
  reconciliationDrift.source_reconciliation.replacement_order_lines_excluded = 1;
  assert.throws(
    () => compileWithPerformance(reconciliationDrift),
    /replacement_order_lines_excluded cannot exceed order_lines/,
  );
});

test("qualified prior/remediation sources cannot detach from population or promote zero evidence", () => {
  const fixture = makeFixture(1);
  const detached = structuredClone(fixture.selectionSources.priorVisual);
  detached.source_bindings.published_catalog.body_sha256 = sha("different-published-source");
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      resealSelectionSource(detached),
      fixture.selectionSources.remediation,
    ),
    /detached from the exact authoritative PUBLISHED source/,
  );

  const zeroPromoted = structuredClone(fixture.selectionSources.priorVisual);
  zeroPromoted.source_bindings.evidence_ledger.mode = "ZERO_EVIDENCE";
  zeroPromoted.source_reconciliation.ledger_entries = 0;
  zeroPromoted.source_reconciliation.evidence_accepted = 0;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      resealSelectionSource(zeroPromoted),
      fixture.selectionSources.remediation,
    ),
    /source_reconciliation does not match compiled rows|ZERO_EVIDENCE/,
  );

  const conflicting = structuredClone(fixture.selectionSources.remediation);
  conflicting.source_reconciliation.conflicting_evidence = 1;
  assert.throws(
    () => compileWalmartShadowSelectionEvidence(
      fixture.selectionSources.publishedCatalog,
      fixture.selectionSources.performance,
      fixture.selectionSources.priorVisual,
      resealSelectionSource(conflicting),
    ),
    /integrity counters must all be zero/,
  );
});

test("public prior/remediation verifiers throw and return canonical parsed artifacts", () => {
  const fixture = makeFixture(1);

  assert.deepEqual(
    verifyWalmartShadowPriorVisualSource(fixture.selectionSources.priorVisual),
    fixture.selectionSources.priorVisual,
  );
  assert.deepEqual(
    verifyWalmartShadowRemediationSource(fixture.selectionSources.remediation),
    fixture.selectionSources.remediation,
  );

  const forgedPrior = structuredClone(fixture.selectionSources.priorVisual);
  forgedPrior.rows[0].verdict = "PASS";
  assert.throws(
    () => verifyWalmartShadowPriorVisualSource(forgedPrior),
    /body_sha256 does not match/,
  );

  const invalidRemediation = structuredClone(fixture.selectionSources.remediation);
  invalidRemediation.rows[0].status = "VERIFIED_APPLIED";
  invalidRemediation.rows[0].verification = null;
  assert.throws(
    () => verifyWalmartShadowRemediationSource(resealSelectionSource(invalidRemediation)),
    /must be verified|source_reconciliation does not match/,
  );
});

test("acceptance contract remains zero-write and zero-classification-error", () => {
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.selected_cases_exactly, 50);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.auditable_preflight_rate, 1);
  assert.equal(
    SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.selection_source_recompile_verified,
    true,
  );
  assert.equal(
    SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.published_upstream_source_aware_verified,
    false,
  );
  assert.equal(
    SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.performance_upstream_source_aware_verified,
    false,
  );
  assert.equal(
    SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.prior_visual_upstream_source_aware_verified,
    false,
  );
  assert.equal(
    SHADOW_50_ACCEPTANCE_GATES.scope_and_identity.remediation_upstream_source_aware_verified,
    false,
  );
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.visual_correctness.false_passes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.visual_correctness.false_bads, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.visual_correctness.review_rate_max, 0.25);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.database_writes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.walmart_writes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.r2_writes, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.remediation_actions, 0);
  assert.equal(SHADOW_50_ACCEPTANCE_GATES.safety.shadow_execution_ready, false);
});
