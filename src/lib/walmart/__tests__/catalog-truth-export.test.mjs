import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
  WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
  WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
  canonicalCatalogTruthJson,
  catalogTruthCanonicalSha256,
  compileWalmartCatalogTruthExport,
  verifyWalmartCatalogTruthAuditExport,
  verifyWalmartCatalogTruthAuditExportAgainstSources,
} from "../catalog-truth-export.ts";
const BUYER_SNAPSHOT_SCHEMA = "walmart-buyer-facing-snapshot/v3";

const CAPTURED_AT = "2026-07-18T20:00:00.000Z";

function digest(value) {
  return catalogTruthCanonicalSha256(value);
}

function identity() {
  return {
    brand_aliases: ["Pepperidge Farm"],
    product_marker_groups: [["Thin Sliced Bread", "Whole Grain Bread"]],
    variant_marker_groups: [["15 Grain"]],
    forbidden_markers: [{ role: "variant", aliases: ["Oatmeal"] }],
  };
}

function packageFacts() {
  return [{ kind: "net_content", value: 22, unit: "oz", requirement: "required" }];
}

function evidence(source_ref_id, source_kind, supports) {
  return {
    source_ref_id,
    source_kind,
    locator: `product-truth://${source_ref_id}`,
    captured_at: CAPTURED_AT,
    payload_sha256: digest(`payload:${source_ref_id}`),
    supports,
  };
}

function revisionBody({
  revisionId = "truth-revision-1",
  listingKind = "multipack",
  composition = "same_product",
  quantity = 6,
  category = "Bread",
} = {}) {
  const component = {
    component_id: "PF-15GRAIN-22OZ",
    quantity,
    identity: identity(),
    package_facts: packageFacts(),
    source_ref_ids: ["recipe"],
  };
  return {
    revision_id: revisionId,
    listing_kind: listingKind,
    category,
    recipe: {
      recipe_id: `${revisionId}-recipe`,
      composition,
      outer_units: quantity,
      components: [component],
      source_ref_ids: ["recipe"],
    },
    structured_record: {
      outer_units: quantity,
      components: [{ component_id: component.component_id, quantity }],
      source_ref_ids: ["structured"],
    },
    proposed_truth: {
      outer_units: quantity,
      identity: identity(),
      package_facts: packageFacts(),
      truth_source: "manual_verified",
      source_ref_ids: ["truth"],
    },
    source_evidence: [
      evidence("recipe", "recipe_record", ["outer_units", "component_truth"]),
      evidence("structured", "sku_reference_catalog", ["outer_units", "component_truth"]),
      evidence("truth", "sku_reference_catalog", ["outer_units", "identity", "package_facts"]),
    ],
  };
}

function revision(options = {}) {
  const body = revisionBody(options);
  const bodySha = digest(body);
  let approval = null;
  if (options.approved !== false) {
    const approvalBody = {
      decision: "approved",
      revision_body_sha256: bodySha,
      approved_at: CAPTURED_AT,
      approved_by: "owner-fixture",
      approval_authority: "product_truth_platform_owner_gate",
      approval_method: "trusted_platform_record",
    };
    approval = { ...approvalBody, approval_sha256: digest(approvalBody) };
  }
  return {
    revision_id: body.revision_id,
    body_sha256: bodySha,
    approval,
    superseded_by_revision_id: options.supersededBy ?? null,
    listing_kind: body.listing_kind,
    category: body.category,
    recipe: body.recipe,
    structured_record: body.structured_record,
    proposed_truth: body.proposed_truth,
    source_evidence: body.source_evidence,
  };
}

function truthRow({
  sku = "PF-BREAD-6",
  itemId = "123456789",
  storeIndex = 1,
  revisionOptions = {},
} = {}) {
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: `walmart:${storeIndex}:${sku}`,
    item_id: itemId,
    revision: revision(revisionOptions),
  };
}

function sealTruthSnapshot(rows) {
  const body = {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    captured_at: CAPTURED_AT,
    producer: "shared_product_truth_platform",
    rows,
  };
  const bodySha = digest(body);
  return {
    ...body,
    snapshot_id: `product-truth-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function buyerSnapshot({
  sku = "PF-BREAD-6",
  itemId = "123456789",
  title = "Pepperidge Farm 15 Grain Thin Sliced Bread, 22 oz, Pack of 6",
  publishedStatus = "PUBLISHED",
  lifecycleStatus = "ACTIVE",
} = {}) {
  const mainSha = digest(`main:${sku}:${itemId}`);
  const buyerEvidence = [`product.item_id=${itemId}`];
  const body = {
    schema_version: BUYER_SNAPSHOT_SCHEMA,
    captured_at: CAPTURED_AT,
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
        wpid: "ALPHANUMERIC-WPID",
        published_status: publishedStatus,
        lifecycle_status: lifecycleStatus,
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
      seller_payload_canonical_sha256: digest(`seller:${sku}`),
      catalog_search_payload_canonical_sha256: digest(`catalog:${itemId}`),
      resolution_canonical_sha256: digest(`resolution:${sku}:${itemId}`),
      buyer_payload_canonical_sha256: digest(`buyer:${itemId}:${title}`),
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
  const bodySha = digest(body);
  return {
    ...body,
    snapshot_id: `walmart-buyer-20260718T200000Z-${bodySha.slice(0, 12)}`,
    body_sha256: bodySha,
  };
}

function resealBuyerSnapshot(snapshot) {
  const body = {
    schema_version: snapshot.schema_version,
    captured_at: snapshot.captured_at,
    target: snapshot.target,
    identity: snapshot.identity,
    source_contract: snapshot.source_contract,
    payload_hashes: snapshot.payload_hashes,
    assets: snapshot.assets,
  };
  const bodySha = digest(body);
  return {
    ...snapshot,
    snapshot_id: `walmart-buyer-20260718T200000Z-${bodySha.slice(0, 12)}`,
    body_sha256: bodySha,
  };
}

function sealBuyerIndex(entries) {
  const body = {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    captured_at: CAPTURED_AT,
    entries,
  };
  const bodySha = digest(body);
  return {
    ...body,
    index_id: `walmart-buyer-index-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

function buyerIndexEntry(snapshot, storeIndex = 1) {
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku: snapshot.target.sku,
    listing_key: `walmart:${storeIndex}:${snapshot.target.sku}`,
    item_id: snapshot.target.item_id,
    snapshot,
  };
}

function validSources() {
  return {
    truth: sealTruthSnapshot([truthRow()]),
    buyers: sealBuyerIndex([buyerIndexEntry(buyerSnapshot())]),
  };
}

test("compiles approved shared truth plus exact buyer binding into a sealed auditable case", () => {
  const { truth, buyers } = validSources();
  const first = compileWalmartCatalogTruthExport(truth, buyers);
  const second = compileWalmartCatalogTruthExport(structuredClone(truth), structuredClone(buyers));

  assert.equal(first.schema_version, WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA);
  assert.equal(first.body_sha256, second.body_sha256);
  assert.equal(first.export_id, second.export_id);
  assert.deepEqual(first.summary, {
    total_cases: 1,
    auditable_cases: 1,
    truth_review_cases: 0,
    unsupported_cases: 0,
  });
  assert.equal(first.cases[0].disposition, "auditable");
  assert.equal(first.cases[0].published_status, "PUBLISHED");
  assert.equal(first.cases[0].lifecycle_status, "ACTIVE");
  assert.equal(first.cases[0].recipe_composition, "same_product");
  assert.equal(first.cases[0].preflight.status, "AUDITABLE");
  assert.equal(first.cases[0].preflight.expected.outer_units, 6);
  assert.match(first.cases[0].truth_revision.approval_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.cases[0].buyer_snapshot.main_asset_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyWalmartCatalogTruthAuditExport(first), first);
  assert.deepEqual(
    verifyWalmartCatalogTruthAuditExportAgainstSources(first, truth, buyers),
    first,
  );
  assert.equal(
    catalogTruthCanonicalSha256({ b: 2, a: 1 }),
    catalogTruthCanonicalSha256({ a: 1, b: 2 }),
  );
  assert.equal(canonicalCatalogTruthJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("tampered outer, revision, approval, buyer, and index seals all fail closed", () => {
  const { truth, buyers } = validSources();

  const outer = structuredClone(truth);
  outer.rows[0].revision.category = "Tampered";
  assert.throws(
    () => compileWalmartCatalogTruthExport(outer, buyers),
    /snapshot body/,
  );

  const revisionTamper = structuredClone(truth);
  revisionTamper.rows[0].revision.category = "Tampered";
  const resealedOuter = sealTruthSnapshot(revisionTamper.rows);
  assert.throws(
    () => compileWalmartCatalogTruthExport(resealedOuter, buyers),
    /canonical revision body/,
  );

  const approvalTamper = structuredClone(truth);
  approvalTamper.rows[0].revision.approval.approved_by = "attacker";
  const resealedApprovalOuter = sealTruthSnapshot(approvalTamper.rows);
  assert.throws(
    () => compileWalmartCatalogTruthExport(resealedApprovalOuter, buyers),
    /canonical approval body/,
  );

  const buyerTamper = structuredClone(buyers);
  buyerTamper.entries[0].snapshot.identity.buyer.title = "Wrong sealed title";
  const resealedIndexOnly = sealBuyerIndex(buyerTamper.entries);
  assert.throws(
    () => compileWalmartCatalogTruthExport(truth, resealedIndexOnly),
    /canonical buyer snapshot body/,
  );

  const indexTamper = structuredClone(buyers);
  indexTamper.captured_at = "2026-07-19T00:00:00.000Z";
  assert.throws(
    () => compileWalmartCatalogTruthExport(truth, indexTamper),
    /canonical index body/,
  );
});

test("listing identity is store-aware while duplicate buyer item IDs remain representable", () => {
  const duplicateSkuRows = [
    truthRow(),
    truthRow({
      sku: "PF-BREAD-6",
      itemId: "987654321",
      revisionOptions: { revisionId: "truth-revision-2" },
    }),
  ];
  assert.throws(
    () => compileWalmartCatalogTruthExport(
      sealTruthSnapshot(duplicateSkuRows),
      sealBuyerIndex([]),
    ),
    /duplicate listing_key walmart:1:PF-BREAD-6/,
  );

  const sameItemDifferentListings = [
    truthRow(),
    truthRow({
      sku: "PF-BREAD-OTHER",
      itemId: "123456789",
      revisionOptions: { revisionId: "truth-revision-2" },
    }),
    truthRow({
      storeIndex: 2,
      sku: "PF-BREAD-6",
      itemId: "123456789",
      revisionOptions: { revisionId: "truth-revision-3" },
    }),
  ];
  const represented = compileWalmartCatalogTruthExport(
    sealTruthSnapshot(sameItemDifferentListings),
    sealBuyerIndex([]),
  );
  assert.equal(represented.cases.length, 3);
  assert.deepEqual(
    represented.cases.map((entry) => entry.listing_key),
    ["walmart:1:PF-BREAD-6", "walmart:1:PF-BREAD-OTHER", "walmart:2:PF-BREAD-6"],
  );

  const duplicateBuyerItem = [
    buyerIndexEntry(buyerSnapshot()),
    buyerIndexEntry(buyerSnapshot({ sku: "OTHER-SKU", itemId: "123456789" })),
  ];
  assert.doesNotThrow(
    () => compileWalmartCatalogTruthExport(
      sealTruthSnapshot([truthRow()]),
      sealBuyerIndex(duplicateBuyerItem),
    ),
  );
});

test("listing_key is derived exactly and SKU identity remains case-sensitive", () => {
  const rows = [
    truthRow({
      sku: "Case-SKU",
      itemId: "111111111",
      revisionOptions: { revisionId: "case-upper" },
    }),
    truthRow({
      sku: "case-SKU",
      itemId: "222222222",
      revisionOptions: { revisionId: "case-lower" },
    }),
  ];
  const result = compileWalmartCatalogTruthExport(
    sealTruthSnapshot(rows),
    sealBuyerIndex([]),
  );
  assert.deepEqual(
    result.cases.map((entry) => entry.listing_key),
    ["walmart:1:Case-SKU", "walmart:1:case-SKU"],
  );

  const forged = rows.map((row) => structuredClone(row));
  forged[0].listing_key = "walmart:2:Case-SKU";
  assert.throws(
    () => compileWalmartCatalogTruthExport(
      sealTruthSnapshot(forged),
      sealBuyerIndex([]),
    ),
    /listing_key must equal walmart:1:Case-SKU/,
  );
});

test("unapproved and superseded truth revisions remain truth_review and never produce expected truth", () => {
  const rows = [
    truthRow({
      sku: "UNAPPROVED-SKU",
      itemId: "111111111",
      revisionOptions: { revisionId: "unapproved-revision", approved: false },
    }),
    truthRow({
      sku: "SUPERSEDED-SKU",
      itemId: "222222222",
      revisionOptions: {
        revisionId: "superseded-revision",
        supersededBy: "replacement-revision",
      },
    }),
  ];
  const buyers = [
    buyerIndexEntry(buyerSnapshot({ sku: "UNAPPROVED-SKU", itemId: "111111111" })),
    buyerIndexEntry(buyerSnapshot({ sku: "SUPERSEDED-SKU", itemId: "222222222" })),
  ];
  const result = compileWalmartCatalogTruthExport(
    sealTruthSnapshot(rows),
    sealBuyerIndex(buyers),
  );
  assert.deepEqual(result.summary, {
    total_cases: 2,
    auditable_cases: 0,
    truth_review_cases: 2,
    unsupported_cases: 0,
  });
  const bySku = new Map(result.cases.map((entry) => [entry.sku, entry]));
  assert.deepEqual(bySku.get("UNAPPROVED-SKU").compiler_reasons, [
    "TRUTH_REVISION_UNAPPROVED",
  ]);
  assert.equal(bySku.get("UNAPPROVED-SKU").preflight, null);
  assert.deepEqual(bySku.get("SUPERSEDED-SKU").compiler_reasons, [
    "TRUTH_REVISION_SUPERSEDED",
  ]);
  assert.equal(bySku.get("SUPERSEDED-SKU").preflight, null);
  verifyWalmartCatalogTruthAuditExport(result);
});

test("missing or non-exact buyer binding is review, never positional fallback", () => {
  const truth = sealTruthSnapshot([truthRow()]);
  const missing = compileWalmartCatalogTruthExport(truth, sealBuyerIndex([]));
  assert.equal(missing.cases[0].disposition, "truth_review");
  assert.deepEqual(missing.cases[0].compiler_reasons, ["BUYER_SNAPSHOT_MISSING"]);
  assert.equal(missing.cases[0].buyer_snapshot, null);
  assert.equal(missing.cases[0].preflight, null);

  const mismatched = compileWalmartCatalogTruthExport(
    truth,
    sealBuyerIndex([buyerIndexEntry(buyerSnapshot({ itemId: "999999999" }))]),
  );
  assert.equal(mismatched.cases[0].disposition, "truth_review");
  assert.deepEqual(mismatched.cases[0].compiler_reasons, ["BUYER_BINDING_NOT_EXACT"]);
  assert.equal(mismatched.cases[0].buyer_snapshot, null);
  assert.equal(mismatched.cases[0].preflight, null);
});

test("caller-supplied expected, risk, or stratum fields are rejected even when resealed", () => {
  const { truth, buyers } = validSources();

  const risk = structuredClone(truth);
  risk.rows[0].risk_score = 99;
  assert.throws(
    () => compileWalmartCatalogTruthExport(sealTruthSnapshot(risk.rows), buyers),
    /unsupported fields: risk_score/,
  );

  const expected = structuredClone(truth);
  expected.rows[0].revision.expected = { outer_units: 999 };
  assert.throws(
    () => compileWalmartCatalogTruthExport(sealTruthSnapshot(expected.rows), buyers),
    /unsupported fields: expected/,
  );

  const stratum = buyerSnapshot();
  stratum.target.stratum = "known_bad_or_return_risk";
  const resealed = resealBuyerSnapshot(stratum);
  assert.throws(
    () => compileWalmartCatalogTruthExport(
      truth,
      sealBuyerIndex([buyerIndexEntry(resealed)]),
    ),
    /unsupported fields: stratum/,
  );
});

test("mixed or variety recipe is preserved as unsupported, not guessed into a single-product case", () => {
  const row = truthRow({
    revisionOptions: {
      revisionId: "variety-revision",
      listingKind: "variety",
      composition: "variety_pack",
    },
  });
  const result = compileWalmartCatalogTruthExport(
    sealTruthSnapshot([row]),
    sealBuyerIndex([buyerIndexEntry(buyerSnapshot())]),
  );
  assert.equal(result.cases[0].disposition, "unsupported");
  assert.equal(result.cases[0].preflight.status, "UNSUPPORTED");
  assert(
    result.cases[0].preflight.reasons.some((reason) => reason.code === "MIXED_BUNDLE_UNSUPPORTED"),
  );
  verifyWalmartCatalogTruthAuditExport(result);
});

test("an exact but unpublished buyer snapshot cannot become an auditable case", () => {
  const result = compileWalmartCatalogTruthExport(
    sealTruthSnapshot([truthRow()]),
    sealBuyerIndex([
      buyerIndexEntry(buyerSnapshot({ publishedStatus: "UNPUBLISHED" })),
    ]),
  );
  assert.equal(result.cases[0].disposition, "truth_review");
  assert.equal(result.cases[0].preflight.status, "AUDITABLE");
  assert.deepEqual(result.cases[0].compiler_reasons, ["BUYER_LISTING_NOT_PUBLISHED"]);
  verifyWalmartCatalogTruthAuditExport(result);
});

test("an exact but inactive buyer snapshot cannot become an auditable case", () => {
  const result = compileWalmartCatalogTruthExport(
    sealTruthSnapshot([truthRow()]),
    sealBuyerIndex([
      buyerIndexEntry(buyerSnapshot({ lifecycleStatus: "RETIRED" })),
    ]),
  );
  assert.equal(result.cases[0].disposition, "truth_review");
  assert.equal(result.cases[0].preflight.status, "AUDITABLE");
  assert.equal(result.cases[0].lifecycle_status, "RETIRED");
  assert.deepEqual(result.cases[0].compiler_reasons, ["BUYER_LISTING_NOT_ACTIVE"]);
  verifyWalmartCatalogTruthAuditExport(result);
});

test("a sealed buyer manifest cannot substitute a non-Walmart image host", () => {
  const { truth } = validSources();
  const impostor = buyerSnapshot();
  impostor.assets[0].source_url = "https://example.test/lookalike.png";
  const resealed = resealBuyerSnapshot(impostor);
  assert.throws(
    () => compileWalmartCatalogTruthExport(
      truth,
      sealBuyerIndex([buyerIndexEntry(resealed)]),
    ),
    /must use a walmartimages\.com host/,
  );
});

test("export verifier detects case, preflight, summary, and top-level seal tampering", () => {
  const { truth, buyers } = validSources();
  const exportArtifact = compileWalmartCatalogTruthExport(truth, buyers);

  const caseTamper = structuredClone(exportArtifact);
  caseTamper.cases[0].category = "Wrong";
  assert.throws(
    () => verifyWalmartCatalogTruthAuditExport(caseTamper),
    /case_id does not match/,
  );

  const preflightTamper = structuredClone(exportArtifact);
  preflightTamper.cases[0].preflight.expected.outer_units = 99;
  assert.throws(
    () => verifyWalmartCatalogTruthAuditExport(preflightTamper),
    /preflight_sha256 does not match/,
  );

  const summaryTamper = structuredClone(exportArtifact);
  summaryTamper.summary.auditable_cases = 0;
  assert.throws(
    () => verifyWalmartCatalogTruthAuditExport(summaryTamper),
    /summary does not match/,
  );

  const sealTamper = structuredClone(exportArtifact);
  sealTamper.product_truth_snapshot.captured_at = "2026-07-19T00:00:00.000Z";
  assert.throws(
    () => verifyWalmartCatalogTruthAuditExport(sealTamper),
    /canonical export body/,
  );
});

test("source-aware verifier rejects a fully re-sealed forged AUDITABLE preflight", () => {
  const { truth, buyers } = validSources();
  const original = compileWalmartCatalogTruthExport(truth, buyers);
  const forged = structuredClone(original);
  forged.cases[0].preflight.expected.outer_units = 99;
  forged.cases[0].preflight_sha256 = digest(forged.cases[0].preflight);
  const caseBody = structuredClone(forged.cases[0]);
  delete caseBody.case_id;
  forged.cases[0].case_id = `walmart-truth-case-${digest(caseBody).slice(0, 20)}`;
  const exportBody = {
    schema_version: forged.schema_version,
    product_truth_snapshot: forged.product_truth_snapshot,
    buyer_index: forged.buyer_index,
    summary: forged.summary,
    cases: forged.cases,
  };
  forged.body_sha256 = digest(exportBody);
  forged.export_id = `walmart-truth-audit-${forged.body_sha256.slice(0, 16)}`;

  // Self-consistency is intentionally a weaker check; trusted-source replay is
  // what prevents a caller from replacing truth and recalculating unsigned hashes.
  assert.doesNotThrow(() => verifyWalmartCatalogTruthAuditExport(forged));
  assert.throws(
    () => verifyWalmartCatalogTruthAuditExportAgainstSources(
      forged,
      truth,
      buyers,
    ),
    /does not exactly match deterministic compilation from trusted sources/,
  );
});
