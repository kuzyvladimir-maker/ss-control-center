import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "@/lib/sourcing/canonical-product-match-provenance";

import {
  WALMART_NEW_SKU_DOCTOR_RECEIPT_SCHEMA,
  assertWalmartNewSkuEvidenceSealDraftBinding,
  assertWalmartNewSkuPlanIntegrity,
  assertWalmartNewSkuOwnerPermitCatalogAuthorityContinuity,
  assertWalmartNewSkuStageArtifactIntegrity,
  buildWalmartNewSkuCertificationTemplate,
  buildWalmartNewSkuPolicyReviewEvidenceTemplate,
  buildDeterministicWalmartMultipackContent,
  buildWalmartNewSkuPilotPlan,
  buildWalmartNewSkuStagePreview,
  buildWalmartNewSkuUpcRotationPreview,
  certifyNoExactWalmartCatalogMatch,
  certifyWalmartSellerSkuAbsent,
  fingerprintWalmartSellerAccount,
  hashWalmartNewSkuCertificationInput,
  isValidOwnerPoolUpca,
  proveExactWalmartCatalogMatch,
  sealWalmartNewSkuCertificationArtifact,
  sealWalmartNewSkuStageArtifact,
  sealWalmartNewSkuUpcRotationReceipt,
} from "../walmart-new-sku-engine";
import {
  buildWalmartExactIdentifierDuplicateGuardBinding,
  type SealedWalmartExactIdentifierDuplicateGuardBinding,
} from "../walmart-new-sku-catalog-authority";
import {
  WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS,
  WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS,
} from "../walmart-new-sku-policy-review-evidence";
import { assertCurrentWalmartSellerAccountBinding } from
  "../walmart-new-sku-engine-runtime";
import type {
  ProductTruthNewSkuView as ProductTruthRecipeInput,
  ProductTruthWalmartPilotCandidate as WalmartPilotCandidate,
} from "@/lib/sourcing/product-truth-read-contract";
import type { ProductTruthNewSkuRecipeComponentEvidence } from "@/lib/sourcing/product-truth-read-contract";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "@/lib/sourcing/product-truth-read-contract";

function component(qty = 2): ProductTruthNewSkuRecipeComponentEvidence {
  return {
    component_key: "component-0-variant-1",
    donor_product_id: "donor-1",
    canonical_variant_id: "variant-1",
    variant_decision_id: "decision-1",
    canonical_identity: {
      variantKey: "variant-1",
      identityHash: "1".repeat(64),
      keyVersion: "canonical-product-variant-key/1.0.0",
      brand: "Example Brand",
      productLine: "Crunchy Snack",
      flavor: "Sea Salt",
      modifiers: [],
      form: "bag",
      sizeDimension: "MASS",
      sizeBaseAmount: 226.796,
      sizeBaseUnit: "g",
      outerPackCount: 1,
      identity: { brand: "Example Brand", size: "8 oz" },
    },
    product_name: "Example Brand Crunchy Snack 8 oz",
    manufacturer_brand: "Example Brand",
    manufacturer_upc: "012345678905",
    flavor: "Sea Salt",
    qty,
    content_role: "EXACT",
    content_observation_id: "content-1",
    content_source_url: "https://retailer.example/item",
    content_captured_at: "2026-07-18T12:00:00.000Z",
    matcher_version: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcher_implementation_sha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcher_release_sha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    content_provenance: {
      observation_key: "2".repeat(64),
      content_hash: "3".repeat(64),
      field_hashes: { title: "4".repeat(64) },
      source_api: "fixture",
      decision_evidence_hash: "5".repeat(64),
      decision_evidence: { exact: true },
      run_id: null,
      approval_id: null,
      metered_receipt_id: null,
    },
    content_classification: {
      category: "Snack Foods",
      storage: "Shelf Stable",
      category_field: "category",
      storage_field: "storageTemp",
    },
    facts: {
      ingredients: "Potatoes, oil, salt",
      allergens: { contains: [], may_contain: [] },
      nutrition_facts: { calories: 140 },
      attributes: {},
    },
    price_evidence: {
      role: "PRICE",
      observation_id: "price-1",
      observation_key: "6".repeat(64),
      donor_offer_id: "offer-1",
      match_tier: "EXACT_IDENTITY",
      eligibility: "FACT",
      policy_version: "price-evidence-eligibility/1.0.0",
      policy_reason_codes: ["EXACT_IDENTITY_DIRECT_FACT"],
      retailer: "walmart",
      retailer_product_id: "item-1",
      via: "direct",
      source_url: "https://retailer.example/item",
      source_api: "fixture",
      observed_at: "2026-07-18T12:00:00.000Z",
      locality_evidence: "zip_scoped",
      zip: "33765",
      first_party: true,
      in_stock: true,
      package_price: 3.99,
      pack_size_seen: 1,
      price_per_unit: 3.99,
      currency: "USD",
      run_id: null,
      approval_id: null,
      metered_receipt_id: null,
    },
  };
}

function recipe(qty = 2): ProductTruthRecipeInput {
  return {
    contractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    as_of: "2026-07-18T12:00:00.000Z",
    price_max_age_ms: 86_400_000,
    zip: "33765",
    components: [component(qty)],
  };
}

function candidate(): WalmartPilotCandidate {
  return {
    donor_product_id: "donor-1",
    canonical_variant_id: "variant-1",
    title: "Example Brand Crunchy Snack 8 oz",
    brand: "Example Brand",
    flavor: "Sea Salt",
    manufacturer_upc: "012345678905",
    category: "Dry",
    storage_classification: "SHELF_STABLE",
    classification_evidence: {
      category_field: "category",
      storage_field: "storageTemp",
      content_observation_id: "content-1",
      source_api: "fixture",
    },
    content_observation_id: "content-1",
    price_observation_id: "price-1",
    observed_price: 3.99,
    price_observed_at: "2026-07-18T12:00:00.000Z",
    content_observed_at: "2026-07-18T12:00:00.000Z",
    image_count: 6,
    default_pack_counts: [2, 3],
    score: 112,
  };
}

function sellerCatalogAuthority(
  ownerDecisionRef = "owner-chat:fixture:product-truth-donor-only",
): SealedWalmartExactIdentifierDuplicateGuardBinding {
  return buildWalmartExactIdentifierDuplicateGuardBinding({
    storeIndex: 1,
    businessSellerAccountFingerprintSha256:
      fingerprintWalmartSellerAccount({
        storeIndex: 1,
        sellerId: "fixture-seller-id",
      }),
    ownerDecisionRef,
  });
}

test("owner permit requires the exact certified catalog authority binding", () => {
  const sellerAccountFingerprintSha256 = fingerprintWalmartSellerAccount({
    storeIndex: 1,
    sellerId: "fixture-seller-id",
  });
  const certifiedAuthority = sellerCatalogAuthority();
  const common = {
    store_index: 1,
    seller_account_fingerprint_sha256: sellerAccountFingerprintSha256,
  };
  assert.doesNotThrow(() =>
    assertWalmartNewSkuOwnerPermitCatalogAuthorityContinuity(
      { ...common, seller_catalog_authority: certifiedAuthority },
      { ...common, seller_catalog_authority: certifiedAuthority },
    ),
  );
  assert.throws(
    () =>
      assertWalmartNewSkuOwnerPermitCatalogAuthorityContinuity(
        {
          ...common,
          seller_catalog_authority:
            sellerCatalogAuthority("owner-chat:fixture:different-decision"),
        },
        { ...common, seller_catalog_authority: certifiedAuthority },
      ),
    /OWNER_PERMIT_CATALOG_AUTHORITY_MISMATCH/,
  );
});

function doctorBinding() {
  return {
    doctorReceiptSha256: "a".repeat(64),
    engineReleaseSha256: "b".repeat(64),
    releaseManifestSha256: "e".repeat(64),
    databaseTargetFingerprintSha256: "c".repeat(64),
    databaseSchemaSha256: "d".repeat(64),
    itemSpecVersion: "5.0.fixture-api",
    sellerCatalogAuthority: sellerCatalogAuthority(),
  };
}

test("deterministic content uses exact identity without an LLM", () => {
  const output = buildDeterministicWalmartMultipackContent({
    component: component(),
    packCount: 2,
  });
  assert.equal(
    output.title,
    "Example Brand Crunchy Snack 8 oz (Pack of 2)",
  );
  assert.equal(output.bullets.length, 5);
  assert.match(output.description, /2 identical, new retail packages/);
  assert.equal(output.generator, "deterministic-product-truth-multipack/v2");
  assert.ok(output.description.split(/\s+/).length >= 150);
  assert.ok(output.bullets.every((bullet) => bullet.length <= 80));
});

test("pilot plan is hash-sealed and cannot authorize a marketplace mutation", () => {
  const plan = buildWalmartNewSkuPilotPlan({
    createdAt: new Date("2026-07-18T13:00:00.000Z"),
    asOf: new Date("2026-07-18T12:00:00.000Z"),
    storeIndex: 1,
    sellerId: "fixture-seller-id",
    doctorBinding: doctorBinding(),
    zip: "33765",
    candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
  });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.schema_version, "walmart-new-sku-plan/1.7.0");
  assert.equal(
    WALMART_NEW_SKU_DOCTOR_RECEIPT_SCHEMA,
    "walmart-new-sku-doctor-receipt/1.7.0",
  );
  assert.equal(plan.max_live_submissions, 1);
  assert.equal(plan.marketplace_mutation_allowed, false);
  assert.equal(
    plan.seller_account_fingerprint_sha256,
    fingerprintWalmartSellerAccount({
      storeIndex: 1,
      sellerId: " FIXTURE-SELLER-ID ",
    }),
  );
  assert.doesNotThrow(() => assertWalmartNewSkuPlanIntegrity(plan));

  assert.throws(
    () => buildWalmartNewSkuPilotPlan({
      createdAt: new Date("2026-07-18T13:00:00.000Z"),
      asOf: new Date("2026-07-18T12:00:00.000Z"),
      storeIndex: 1,
      sellerId: "fixture-seller-id",
      doctorBinding: doctorBinding(),
      zip: "33765",
      maxLiveSubmissions: 2,
      candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
    }),
    /PILOT_APPLY_LIMIT_INVALID:2/,
  );
  assert.throws(
    () => buildWalmartNewSkuPilotPlan({
      createdAt: new Date("2026-07-18T13:00:00.000Z"),
      asOf: new Date("2026-07-18T12:00:00.000Z"),
      storeIndex: 1,
      sellerId: "fixture-seller-id",
      doctorBinding: doctorBinding(),
      zip: "33765",
      candidates: [
        { candidate: candidate(), recipe: recipe(), packCount: 2 },
        { candidate: candidate(), recipe: recipe(), packCount: 2 },
      ],
    }),
    /PLAN_CANDIDATE_LIMIT_EXCEEDED/,
  );

  const changed = structuredClone(plan);
  changed.candidates[0].content.title = "Drifted title";
  assert.throws(
    () => assertWalmartNewSkuPlanIntegrity(changed),
    /PLAN_HASH_MISMATCH/,
  );

  const recomputed = structuredClone(changed);
  recomputed.plan_sha256 = "0".repeat(64);
  assert.throws(
    () => assertWalmartNewSkuPlanIntegrity(recomputed),
    /PLAN_HASH_MISMATCH/,
  );
});

test("active pilot rejects every legacy full-seller-catalog authority artifact", () => {
  const binding = doctorBinding();
  assert.throws(
    () => buildWalmartNewSkuPilotPlan({
      createdAt: new Date("2026-07-18T13:00:00.000Z"),
      asOf: new Date("2026-07-18T12:00:00.000Z"),
      storeIndex: 1,
      sellerId: "fixture-seller-id",
      doctorBinding: {
        ...binding,
        sellerCatalogAuthority: {
          schema_version: "walmart-seller-catalog-authority-binding/v1",
        } as never,
      },
      zip: "33765",
      candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
    }),
    /PLAN_INPUT_CATALOG_AUTHORITY_INVALID/,
  );
});

test("seller account binding is normalized, store-scoped, and fails closed on credential drift", () => {
  const envNames = [
    "WALMART_CLIENT_ID_STORE97",
    "WALMART_CLIENT_SECRET_STORE97",
    "WALMART_STORE97_SELLER_ID",
  ] as const;
  const prior = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]]),
  );
  try {
    process.env.WALMART_CLIENT_ID_STORE97 = "fixture-client";
    process.env.WALMART_CLIENT_SECRET_STORE97 = "fixture-secret";
    process.env.WALMART_STORE97_SELLER_ID = "seller-account-a";
    const binding = {
      store_index: 97,
      seller_account_fingerprint_sha256: fingerprintWalmartSellerAccount({
        storeIndex: 97,
        sellerId: " SELLER-ACCOUNT-A ",
      }),
    };
    assert.doesNotThrow(() =>
      assertCurrentWalmartSellerAccountBinding(binding),
    );

    process.env.WALMART_STORE97_SELLER_ID = "seller-account-b";
    assert.throws(
      () => assertCurrentWalmartSellerAccountBinding(binding),
      /SELLER_ACCOUNT_BINDING_MISMATCH:STORE_97/,
    );

    delete process.env.WALMART_CLIENT_SECRET_STORE97;
    assert.throws(
      () => assertCurrentWalmartSellerAccountBinding(binding),
      /SELLER_ACCOUNT_NOT_CONFIGURED:STORE_97/,
    );
  } finally {
    for (const name of envNames) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.notEqual(
    fingerprintWalmartSellerAccount({
      storeIndex: 97,
      sellerId: "seller-account-a",
    }),
    fingerprintWalmartSellerAccount({
      storeIndex: 98,
      sellerId: "seller-account-a",
    }),
  );
});

test("pilot rejects unsupported large pack waves", () => {
  assert.throws(
    () => buildDeterministicWalmartMultipackContent({
      component: component(15),
      packCount: 15,
    }),
    /PILOT_PACK_COUNT_UNSUPPORTED/,
  );
});

test("stage identity is deterministic and the reserved UPC artifact is sealed", () => {
  const plan = buildWalmartNewSkuPilotPlan({
    createdAt: new Date("2026-07-18T13:00:00.000Z"),
    asOf: new Date("2026-07-18T12:00:00.000Z"),
    storeIndex: 1,
    sellerId: "fixture-seller-id",
    doctorBinding: doctorBinding(),
    zip: "33765",
    candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
  });
  const preview = buildWalmartNewSkuStagePreview({
    plan,
    candidateKey: plan.candidates[0].candidate_key,
  });
  assert.match(preview.proposed_sku, /^WM-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.deepEqual(
    preview,
    buildWalmartNewSkuStagePreview({
      plan,
      candidateKey: plan.candidates[0].candidate_key,
    }),
  );
  const artifact = sealWalmartNewSkuStageArtifact({
    ...preview,
    staged_at: "2026-07-18T13:05:00.000Z",
    staged_by: "owner",
    upc_pool_id: "upc-pool-1",
    upc: "012345678905",
    upc_checksum_valid: true,
    upc_pool_acquired_from: "SpeedyBarcode",
    upc_pool_recorded_owner: "Salutem Solutions LLC",
    upc_reserved_until: "2026-07-19T13:05:00.000Z",
    state: "UPC_RESERVED",
  });
  assert.doesNotThrow(() =>
    assertWalmartNewSkuStageArtifactIntegrity(artifact, plan),
  );
  const drifted = { ...artifact, upc: "012345678912" };
  assert.throws(
    () => assertWalmartNewSkuStageArtifactIntegrity(drifted, plan),
    /STAGE_HASH_MISMATCH/,
  );
});

test("owner UPC pool checksum validation is distinct from registry evidence", () => {
  assert.equal(isValidOwnerPoolUpca("012345678905"), true);
  assert.equal(isValidOwnerPoolUpca("012345678906"), false);
  assert.equal(isValidOwnerPoolUpca("123"), false);
});

test("certification template is bound to the sealed plan, stage and exact image lineage", () => {
  const plan = buildWalmartNewSkuPilotPlan({
    createdAt: new Date("2026-07-18T13:00:00.000Z"),
    asOf: new Date("2026-07-18T12:00:00.000Z"),
    storeIndex: 1,
    sellerId: "fixture-seller-id",
    doctorBinding: doctorBinding(),
    zip: "33765",
    candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
  });
  const preview = buildWalmartNewSkuStagePreview({
    plan,
    candidateKey: plan.candidates[0].candidate_key,
  });
  const stage = sealWalmartNewSkuStageArtifact({
    ...preview,
    staged_at: "2026-07-18T13:05:00.000Z",
    staged_by: "owner",
    upc_pool_id: "upc-pool-1",
    upc: "012345678905",
    upc_checksum_valid: true,
    upc_pool_acquired_from: "SpeedyBarcode",
    upc_pool_recorded_owner: "Salutem Solutions LLC",
    upc_reserved_until: "2026-07-19T13:05:00.000Z",
    state: "UPC_RESERVED",
  });
  const template = buildWalmartNewSkuCertificationTemplate({
    plan,
    stage,
    now: new Date("2026-07-18T13:06:00.000Z"),
    policyReviewEvidencePath: "/tmp/policy-review-fixture.json",
  });
  assert.equal(template.wave_id, plan.wave_id);
  assert.equal(template.stage_sha256, stage.stage_sha256);
  assert.equal(template.shipping_in_price, null);
  const templatePrepublication = template.prepublication as Record<string, unknown>;
  const templateAccount =
    templatePrepublication.seller_account_health as Record<string, unknown>;
  const templateCategory = (
    templatePrepublication.category_approvals as Array<Record<string, unknown>>
  )[0]!;
  const templatePolicy =
    templatePrepublication.sku_policy_review as Record<string, unknown>;
  const templatePricing =
    templatePrepublication.pricing_competitiveness as Record<string, unknown>;
  const templateRecall =
    templatePrepublication.recall_check as Record<string, unknown>;
  const templateCondition =
    templatePrepublication.condition as Record<string, unknown>;
  assert.match(String(templateAccount.status), /^TODO_/);
  assert.match(String(templateAccount.verified_at), /^TODO_/);
  assert.match(String(templateCategory.status), /^TODO_/);
  assert.match(String(templateCategory.verified_at), /^TODO_/);
  assert.match(String(templatePolicy.status), /^TODO_/);
  assert.match(String(templatePolicy.reviewed_at), /^TODO_/);
  assert.match(String(templatePricing.status), /^TODO_/);
  assert.equal(templatePricing.internal_pilot_ceiling_bps, 12_500);
  assert.equal(templatePricing.customer_shipping_charge_cents, 0);
  assert.match(String(templateRecall.status), /^TODO_/);
  assert.match(String(templateRecall.checked_at), /^TODO_/);
  assert.match(String(templateCondition.value), /^TODO_/);
  assert.match(String(templateCondition.verified_at), /^TODO_/);
  const images = template.images as Array<Record<string, unknown>>;
  assert.deepEqual(
    images[0].source_content_observation_ids,
    ["content-1"],
  );
  assert.equal(images[0].represented_unit_count, 2);
  const policyArtifact = (
    template.evidence_artifacts as Array<Record<string, unknown>>
  ).find((artifact) => artifact.kind === "POLICY_REVIEW");
  assert.equal(policyArtifact?.path, "/tmp/policy-review-fixture.json");
  const pricingArtifact = (
    template.evidence_artifacts as Array<Record<string, unknown>>
  ).find((artifact) => artifact.kind === "PRICE_COMPETITIVENESS");
  assert.ok(pricingArtifact);

  const policyTemplate = buildWalmartNewSkuPolicyReviewEvidenceTemplate({
    plan,
    stage,
    now: new Date("2026-07-18T13:06:00.000Z"),
  });
  const policyBinding = policyTemplate.binding as Record<string, unknown>;
  const policySources = policyTemplate.official_sources as unknown[];
  const policyFindings = policyTemplate.findings as Array<Record<string, unknown>>;
  assert.equal(policyBinding.plan_sha256, plan.plan_sha256);
  assert.equal(policyBinding.stage_sha256, stage.stage_sha256);
  assert.equal(policyBinding.sku, stage.proposed_sku);
  assert.equal(policyBinding.upc, stage.upc);
  assert.match(String(policyTemplate.decision), /^TODO_/);
  assert.equal(policySources.length, WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS.length);
  assert.equal(
    policyFindings.length,
    WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS.length,
  );
  assert.ok(
    WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS.includes("pricing-rules"),
  );
  assert.ok(
    WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS.includes(
      "pricing-competitiveness",
    ),
  );
  assert.deepEqual(
    policyFindings.find(
      (finding) => finding.finding_id === "pricing-competitiveness",
    )?.policy_source_ids,
    ["pricing-rules"],
  );
  assert.ok(
    policyFindings.every(
      (finding) => String(finding.disposition).startsWith("TODO_"),
    ),
  );

  const sealDraft = structuredClone(template);
  (sealDraft.walmart as Record<string, unknown>).product_type = "Snack Foods";
  const sealPrepublication = sealDraft.prepublication as Record<string, unknown>;
  const sealPolicyReview =
    sealPrepublication.sku_policy_review as Record<string, unknown>;
  const sealPolicyRef = "fixture-evidence://policy-review/exact-v1";
  sealPolicyReview.evidence_ref = sealPolicyRef;
  const sealPolicyRow = (
    sealDraft.evidence_artifacts as Array<Record<string, unknown>>
  ).find((artifact) => artifact.kind === "POLICY_REVIEW")!;
  sealPolicyRow.ref = sealPolicyRef;
  const sealBinding = assertWalmartNewSkuEvidenceSealDraftBinding({
    draft: sealDraft,
    plan,
    stage,
  });
  assert.equal(sealBinding.policy_evidence_path, "/tmp/policy-review-fixture.json");
  assert.equal(
    sealBinding.expected_policy_binding.candidate_key,
    stage.candidate_key,
  );
  const placeholderProductType = structuredClone(sealDraft);
  (placeholderProductType.walmart as Record<string, unknown>).product_type =
    "TODO_FROM_WALMART_ITEM_SPEC_BROWSER";
  assert.throws(
    () => assertWalmartNewSkuEvidenceSealDraftBinding({
      draft: placeholderProductType,
      plan,
      stage,
    }),
    /EVIDENCE_SEAL_PRODUCT_TYPE_MISSING/,
  );

  for (const [field, mismatch] of [
    ["wave_id", "different-wave"],
    ["candidate_key", "different-candidate"],
    ["stage_sha256", "9".repeat(64)],
  ] as const) {
    const copied = structuredClone(sealDraft);
    copied[field] = mismatch;
    assert.throws(
      () => assertWalmartNewSkuEvidenceSealDraftBinding({
        draft: copied,
        plan,
        stage,
      }),
      /EVIDENCE_SEAL_DRAFT_(?:WAVE|CANDIDATE|STAGE)_MISMATCH/,
    );
  }
  const detachedPolicy = structuredClone(sealDraft);
  const detachedPolicyRow = (
    detachedPolicy.evidence_artifacts as Array<Record<string, unknown>>
  ).find((artifact) => artifact.kind === "POLICY_REVIEW")!;
  detachedPolicyRow.ref = "fixture-evidence://policy-review/different-v1";
  assert.throws(
    () => assertWalmartNewSkuEvidenceSealDraftBinding({
      draft: detachedPolicy,
      plan,
      stage,
    }),
    /EVIDENCE_SEAL_POLICY_ROW_BINDING_INVALID/,
  );

  const certification = sealWalmartNewSkuCertificationArtifact({
    schema_version: "walmart-new-sku-certification/1.7.0",
    wave_id: plan.wave_id,
    plan_sha256: plan.plan_sha256,
    stage_sha256: stage.stage_sha256,
    candidate_key: stage.candidate_key,
    store_index: plan.store_index,
    seller_account_fingerprint_sha256:
      plan.seller_account_fingerprint_sha256,
    seller_catalog_authority: plan.seller_catalog_authority,
    bundle_draft_id: stage.bundle_draft_id,
    master_bundle_id: "master-bundle-1",
    channel_sku_id: "channel-sku-1",
    sku: stage.proposed_sku,
    upc: stage.upc,
    certified_at: "2026-07-18T13:10:00.000Z",
    certification_input_sha256: "1".repeat(64),
    validation_run_id: "validation-run-1",
    validation_status: "PASSED",
    payload_sha256: "2".repeat(64),
    product_truth_recipe_hash: "3".repeat(64),
    product_truth_binding: {
      donor_product_id: "donor-1",
      canonical_variant_id: "variant-1",
      content_observation_id: "content-1",
      price_observation_id: "price-1",
      qty: 2,
      zip: "33765",
      price_max_age_ms: 86_400_000,
      component_sha256: "4".repeat(64),
    },
    catalog_search_evidence_ref: "walmart-catalog-search://fixture",
    seller_sku_absence_evidence_ref: "walmart-seller-sku://fixture",
    seller_account_health_evidence_ref:
      "walmart-seller-account-health://fixture",
    seller_account_health_verified_at: "2026-07-18T13:09:00.000Z",
    fulfillment_compliance_evidence_ref:
      "walmart-fulfillment-compliance://fixture",
    fulfillment_compliance_verified_at: "2026-07-18T13:09:00.000Z",
    item_spec_schema_sha256: "5".repeat(64),
    source_evidence_sha256: "6".repeat(64),
    marketplace_mutation_allowed: false,
  });
  assert.equal(
    certification.schema_version,
    "walmart-new-sku-certification/1.7.0",
  );
  assert.deepEqual(
    certification.seller_catalog_authority,
    plan.seller_catalog_authority,
  );
});

test("certify seal-evidence binds plan/stage/policy bytes and writes only a new artifact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "walmart-seal-cli-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const plan = buildWalmartNewSkuPilotPlan({
    createdAt: new Date("2026-07-18T13:00:00.000Z"),
    asOf: new Date("2026-07-18T12:00:00.000Z"),
    storeIndex: 1,
    sellerId: "fixture-seller-id",
    doctorBinding: doctorBinding(),
    zip: "33765",
    candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
  });
  const stage = sealWalmartNewSkuStageArtifact({
    ...buildWalmartNewSkuStagePreview({
      plan,
      candidateKey: plan.candidates[0].candidate_key,
    }),
    staged_at: "2026-07-18T13:05:00.000Z",
    staged_by: "fixture-operator",
    upc_pool_id: "upc-pool-seal-cli",
    upc: "012345678905",
    upc_checksum_valid: true,
    upc_pool_acquired_from: "SpeedyBarcode",
    upc_pool_recorded_owner: "Salutem Solutions LLC",
    upc_reserved_until: "2026-07-19T13:05:00.000Z",
    state: "UPC_RESERVED",
  });
  const planPath = path.join(root, "plan.json");
  const stagePath = path.join(root, "stage.json");
  const draftPath = path.join(root, "draft.json");
  const outputPath = path.join(root, "sealed.json");
  const policyPath = path.join(root, "policy-review.json");
  const policyRef = "fixture-evidence://policy-review/seal-cli-v1";
  const policyTemplate = buildWalmartNewSkuPolicyReviewEvidenceTemplate({ plan, stage });
  (policyTemplate.binding as Record<string, unknown>).product_type = "Snack Foods";
  await writeFile(policyPath, `${JSON.stringify(policyTemplate, null, 2)}\n`);
  const draft = buildWalmartNewSkuCertificationTemplate({
    plan,
    stage,
    policyReviewEvidencePath: policyPath,
  });
  (draft.walmart as Record<string, unknown>).product_type = "Snack Foods";
  const prepublication = draft.prepublication as Record<string, unknown>;
  (prepublication.sku_policy_review as Record<string, unknown>).evidence_ref =
    policyRef;
  const rows = draft.evidence_artifacts as Array<Record<string, unknown>>;
  for (const [index, row] of rows.entries()) {
    if (row.kind === "POLICY_REVIEW") {
      row.ref = policyRef;
      row.path = policyPath;
    } else {
      const evidencePath = path.join(root, `evidence-${index}.txt`);
      await writeFile(evidencePath, `evidence ${index}\n`, "utf8");
      row.path = evidencePath;
    }
  }
  await Promise.all([
    writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
    writeFile(stagePath, `${JSON.stringify(stage, null, 2)}\n`),
    writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`),
  ]);

  const cli = path.join(process.cwd(), "scripts", "walmart-new-sku-engine.ts");
  const runSeal = (inputPath: string, outPath: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", cli,
        "certify",
        "--plan", planPath,
        "--stage", stagePath,
        "--evidence", inputPath,
        "--mode", "seal-evidence",
        "--out", outPath,
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

  const success = await runSeal(draftPath, outputPath);
  assert.equal(success.code, 0, success.stderr);
  const report = JSON.parse(success.stdout) as Record<string, unknown>;
  assert.equal(report.internal_database_mutated, false);
  assert.equal(report.marketplace_mutated, false);
  assert.deepEqual(report.next_argv, [
    "npm", "run", "walmart:new-sku", "--", "certify",
    "--plan", planPath,
    "--stage", stagePath,
    "--evidence", outputPath,
    "--mode", "preview",
  ]);
  const sealed = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
  for (const row of sealed.evidence_artifacts as Array<Record<string, unknown>>) {
    const bytes = await readFile(String(row.path));
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(row.byte_size, bytes.length);
  }

  const parentAlias = path.join(root, "parent-alias");
  await symlink(root, parentAlias);
  const samePhysicalOutput = await runSeal(
    outputPath,
    path.join(parentAlias, path.basename(outputPath)),
  );
  assert.equal(samePhysicalOutput.code, 1);
  assert.match(samePhysicalOutput.stderr, /new physical artifact/);

  const changedDraft = structuredClone(draft);
  changedDraft.price_cents = 1234;
  const changedDraftPath = path.join(root, "changed-draft.json");
  await writeFile(changedDraftPath, `${JSON.stringify(changedDraft, null, 2)}\n`);
  const overwrite = await runSeal(changedDraftPath, outputPath);
  assert.equal(overwrite.code, 1);
  assert.match(overwrite.stderr, /Refusing to overwrite a different artifact/);

  const aliasTarget = path.join(root, "alias-target.json");
  const symlinkOutput = path.join(root, "symlink-output.json");
  const hardlinkOutput = path.join(root, "hardlink-output.json");
  await writeFile(aliasTarget, await readFile(outputPath));
  await symlink(aliasTarget, symlinkOutput);
  const symlinkDenied = await runSeal(draftPath, symlinkOutput);
  assert.equal(symlinkDenied.code, 1);
  assert.match(symlinkDenied.stderr, /Refusing unsafe existing artifact path/);
  await link(aliasTarget, hardlinkOutput);
  const hardlinkDenied = await runSeal(draftPath, hardlinkOutput);
  assert.equal(hardlinkDenied.code, 1);
  assert.match(hardlinkDenied.stderr, /Refusing unsafe existing artifact path/);

  const foreignDraft = structuredClone(draft);
  foreignDraft.stage_sha256 = "9".repeat(64);
  const foreignDraftPath = path.join(root, "foreign-draft.json");
  await writeFile(foreignDraftPath, `${JSON.stringify(foreignDraft, null, 2)}\n`);
  const foreign = await runSeal(foreignDraftPath, path.join(root, "must-not-exist.json"));
  assert.equal(foreign.code, 1);
  assert.match(foreign.stderr, /EVIDENCE_SEAL_DRAFT_STAGE_MISMATCH/);
});

test("catalog certification accepts only an exact-identifier absence", () => {
  const noMatch = certifyNoExactWalmartCatalogMatch({
    upc: "012345678905",
    responseBody: {
      items: [{ itemId: "11", standardUpc: ["00012345678912"] }],
    },
    searchedAt: new Date("2026-07-18T13:06:00.000Z"),
    correlationId: "cid-1",
  });
  assert.equal(noMatch.result, "NO_EXACT_MATCH");
  assert.equal(noMatch.setup_method, "FULL_ITEM");

  assert.throws(
    () => certifyNoExactWalmartCatalogMatch({
      upc: "012345678905",
      responseBody: {
        items: [{ itemId: "99", standardUpc: ["00012345678905"] }],
      },
      searchedAt: new Date("2026-07-18T13:06:00.000Z"),
      correlationId: "cid-2",
    }),
    /CATALOG_EXACT_MATCH_PILOT_BLOCKED/,
  );
  assert.throws(
    () => certifyNoExactWalmartCatalogMatch({
      upc: "012345678905",
      responseBody: { items: [{ itemId: "99" }] },
      searchedAt: new Date("2026-07-18T13:06:00.000Z"),
      correlationId: "cid-3",
    }),
    /IDENTIFIERS_AMBIGUOUS/,
  );
});

test("certification confirmation changes with any operator evidence change", () => {
  const left = {
    schema_version: "walmart-new-sku-certification-input/1.5.0",
    wave_id: "wave",
    candidate_key: "candidate",
    stage_sha256: "stage",
    price_cents: 1299,
  };
  const right = { ...left, price_cents: 1399 };
  assert.notEqual(
    hashWalmartNewSkuCertificationInput(left as never),
    hashWalmartNewSkuCertificationInput(right as never),
  );
});

function specCatalogResponse(feedType: "MP_ITEM" | "MP_ITEM_MATCH") {
  const version = "5.0.20260205-21_38_48-api";
  return {
    items: [{
      feedType,
      version,
      itemSpecPayload: {
        MPItemFeedHeader: {
          locale: "en",
          version,
          businessUnit: "WALMART_US",
        },
        MPItem: [{
          Orderable: {
            productIdentifiers: {
              productIdType: "GTIN",
              productId: "00012345678905",
            },
          },
        }],
      },
    }],
  };
}

test("SPEC catalog routing rotates only MP_ITEM_MATCH and preserves MP_ITEM evidence", () => {
  const searchedAt = new Date("2026-07-18T13:06:00.000Z");
  const exact = proveExactWalmartCatalogMatch({
    upc: "012345678905",
    responseBody: specCatalogResponse("MP_ITEM_MATCH"),
    searchedAt,
    correlationId: "cid-spec-match",
  });
  assert.equal(exact.feed_type, "MP_ITEM_MATCH");
  assert.equal(exact.response_format, "SPEC");
  assert.equal(exact.walmart_item_id, null);
  assert.match(exact.match_fingerprint_sha256, /^[a-f0-9]{64}$/);

  const fullSetup = certifyNoExactWalmartCatalogMatch({
    upc: "012345678905",
    responseBody: specCatalogResponse("MP_ITEM"),
    searchedAt,
    correlationId: "cid-spec-full",
    responseFormat: "SPEC",
  });
  assert.equal(fullSetup.result, "NO_EXACT_MATCH");
  assert.equal(fullSetup.catalog_outcome, "MP_ITEM_FULL_SETUP");
  assert.equal(fullSetup.feed_type, "MP_ITEM");
  assert.match(fullSetup.response_sha256, /^[a-f0-9]{64}$/);

  const empty = certifyNoExactWalmartCatalogMatch({
    upc: "012345678905",
    responseBody: {},
    searchedAt,
    correlationId: "cid-spec-empty",
    responseFormat: "SPEC",
  });
  assert.equal(empty.catalog_outcome, "NO_MATCH");

  assert.throws(
    () => proveExactWalmartCatalogMatch({
      upc: "012345678905",
      responseBody: specCatalogResponse("MP_ITEM"),
      searchedAt,
      correlationId: "cid-not-live",
    }),
    /CATALOG_EXACT_MATCH_NOT_FOUND/,
  );
  assert.throws(
    () => proveExactWalmartCatalogMatch({
      upc: "012345678905",
      responseBody: {
        items: [
          ...specCatalogResponse("MP_ITEM_MATCH").items,
          ...specCatalogResponse("MP_ITEM_MATCH").items,
        ],
      },
      searchedAt,
      correlationId: "cid-ambiguous",
    }),
    /CATALOG_SPEC_RESULT_COUNT_AMBIGUOUS/,
  );
  assert.throws(
    () => proveExactWalmartCatalogMatch({
      upc: "012345678905",
      responseBody: {
        items: [{
          feedType: "MP_ITEM_MATCH",
          version: "5.0.20260205-21_38_48-api",
          itemSpecPayload: {},
        }],
      },
      searchedAt,
      correlationId: "cid-malformed",
    }),
    /CATALOG_SPEC_ENVELOPE_AMBIGUOUS/,
  );
});

test("seller SKU absence accepts only an authenticated exact 404", () => {
  const evidence = certifyWalmartSellerSkuAbsent({
    sku: "WM-AB12-CD34",
    httpStatus: 404,
    responseBody: { errors: [{ code: "ITEM_NOT_FOUND" }] },
    checkedAt: new Date("2026-07-18T13:00:00.000Z"),
    correlationId: "cid-seller-sku-absent",
  });
  assert.equal(evidence.result, "NOT_FOUND");
  assert.equal(evidence.http_status, 404);
  assert.equal(evidence.endpoint, "/v3/items/WM-AB12-CD34");
  assert.match(evidence.response_sha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.evidence_ref, /status=404/);

  assert.throws(
    () => certifyWalmartSellerSkuAbsent({
      sku: "WM-AB12-CD34",
      httpStatus: 200,
      responseBody: { ItemResponse: [{ sku: "WM-AB12-CD34" }] },
      checkedAt: new Date("2026-07-18T13:00:00.000Z"),
      correlationId: "cid-seller-sku-exists",
    }),
    /SELLER_SKU_ALREADY_EXISTS/,
  );
  assert.throws(
    () => certifyWalmartSellerSkuAbsent({
      sku: "WM-AB12-CD34",
      httpStatus: 429,
      responseBody: { error: "rate limited" },
      checkedAt: new Date("2026-07-18T13:00:00.000Z"),
      correlationId: "cid-seller-sku-unknown",
    }),
    /SELLER_SKU_ABSENCE_UNPROVEN_HTTP_429/,
  );

  for (const responseBody of [
    {},
    "<html>gateway not found</html>",
    { errors: [{ code: "RESOURCE_NOT_FOUND" }] },
    {
      errors: [
        { code: "ITEM_NOT_FOUND" },
        { code: "AUTHORIZATION_ERROR" },
      ],
    },
  ]) {
    assert.throws(
      () => certifyWalmartSellerSkuAbsent({
        sku: "WM-AB12-CD34",
        httpStatus: 404,
        responseBody,
        checkedAt: new Date("2026-07-18T13:00:00.000Z"),
        correlationId: "cid-ambiguous-404",
      }),
      /SELLER_SKU_ABSENCE_UNPROVEN_404_ENVELOPE/,
    );
  }
});

test("UPC rotation confirmation and receipt bind the old proof to one new sealed stage", () => {
  const plan = buildWalmartNewSkuPilotPlan({
    createdAt: new Date("2026-07-18T13:00:00.000Z"),
    asOf: new Date("2026-07-18T12:00:00.000Z"),
    storeIndex: 1,
    sellerId: "fixture-seller-id",
    doctorBinding: doctorBinding(),
    zip: "33765",
    candidates: [{ candidate: candidate(), recipe: recipe(), packCount: 2 }],
  });
  const stagePreview = buildWalmartNewSkuStagePreview({
    plan,
    candidateKey: plan.candidates[0].candidate_key,
  });
  const priorStage = sealWalmartNewSkuStageArtifact({
    ...stagePreview,
    staged_at: "2026-07-18T13:05:00.000Z",
    staged_by: "operator-a",
    upc_pool_id: "upc-pool-1",
    upc: "012345678905",
    upc_checksum_valid: true,
    upc_pool_acquired_from: "SpeedyBarcode",
    upc_pool_recorded_owner: "Salutem Solutions LLC",
    upc_reserved_until: "2026-07-19T13:05:00.000Z",
    state: "UPC_RESERVED",
  });
  const exactMatch = proveExactWalmartCatalogMatch({
    upc: priorStage.upc,
    responseBody: specCatalogResponse("MP_ITEM_MATCH"),
    searchedAt: new Date("2026-07-18T13:07:00.000Z"),
    correlationId: "cid-rotation",
  });
  const rotationPreview = buildWalmartNewSkuUpcRotationPreview({
    plan,
    stage: priorStage,
    exactMatch,
  });
  const unsignedPriorStage = Object.fromEntries(
    Object.entries(priorStage).filter(([key]) => key !== "stage_sha256"),
  ) as Omit<typeof priorStage, "stage_sha256">;
  const newStage = sealWalmartNewSkuStageArtifact({
    ...unsignedPriorStage,
    staged_at: "2026-07-18T13:07:00.000Z",
    staged_by: "operator-b",
    upc_pool_id: "upc-pool-2",
    upc: "012345678912",
    upc_checksum_valid: true,
    upc_pool_acquired_from: "SpeedyBarcode",
    upc_pool_recorded_owner: "Salutem Solutions LLC",
    upc_reserved_until: "2026-07-19T13:07:00.000Z",
  });
  const receipt = sealWalmartNewSkuUpcRotationReceipt({
    schema_version: "walmart-new-sku-upc-rotation-receipt/1.0.0",
    confirmation_sha256: rotationPreview.confirmation_sha256,
    plan_sha256: plan.plan_sha256,
    prior_stage_sha256: priorStage.stage_sha256,
    new_stage_sha256: newStage.stage_sha256,
    candidate_key: priorStage.candidate_key,
    bundle_draft_id: priorStage.bundle_draft_id,
    rotated_at: newStage.staged_at,
    rotated_by: newStage.staged_by,
    exact_match: exactMatch,
    retired_upc_pool_id: priorStage.upc_pool_id,
    retired_upc: priorStage.upc,
    retired_upc_status: "RETIRED",
    retired_upc_disposition: "FUTURE_MP_ITEM_MATCH",
    new_upc_pool_id: newStage.upc_pool_id,
    new_upc: newStage.upc,
    new_upc_status: "RESERVED",
    new_stage: newStage,
    internal_database_mutated: true,
    marketplace_mutated: false,
  }, plan, priorStage);
  assert.match(rotationPreview.confirmation_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.retired_upc_disposition, "FUTURE_MP_ITEM_MATCH");
  assert.equal(receipt.new_stage.upc, "012345678912");
});
