import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA,
  WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS,
  WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS,
  parseAndValidateWalmartNewSkuPolicyReviewEvidence,
  type WalmartNewSkuPolicyReviewValidationContext,
} from "../walmart-new-sku-policy-review-evidence";
import {
  WALMART_POLICY_SOURCES,
  WALMART_POLICY_VERSION,
} from "../validation/walmart-prepublication-policy";

const REVIEWED_AT = "2026-07-19T13:00:00.000Z";
const NOW = new Date("2026-07-19T14:00:00.000Z");
const POLICY_REF = "fixture-evidence://policy-review/exact-v1";
const APPROVAL_REF = "fixture-evidence://category-approval/ingestible-v1";
const POLICY_URL = WALMART_POLICY_SOURCES.find(
  (source) => source.id === "prohibited-products-overview",
)!.url;

function fixture(): {
  evidence: Record<string, unknown>;
  context: WalmartNewSkuPolicyReviewValidationContext;
} {
  const binding = {
    wave_id: "wave-policy-fixture",
    plan_sha256: "1".repeat(64),
    stage_sha256: "2".repeat(64),
    candidate_key: "candidate-policy-fixture",
    candidate_sha256: "3".repeat(64),
    store_index: 1,
    business_seller_account_fingerprint_sha256: "4".repeat(64),
    sku: "WM-ABCD-EFGH",
    upc: "012345678905",
    donor_product_id: "donor-policy-fixture",
    canonical_variant_id: "variant-policy-fixture",
    product_type: "Snack Foods",
  };
  const approval = {
    scope: "INGESTIBLE_PRODUCTS",
    status: "APPROVED" as const,
    verified_at: REVIEWED_AT,
    evidence_ref: APPROVAL_REF,
  };
  const sourceUrl = (sourceId: string): string =>
    WALMART_POLICY_SOURCES.find((source) => source.id === sourceId)!.url;
  return {
    evidence: {
      schema_version: WALMART_NEW_SKU_POLICY_REVIEW_EVIDENCE_SCHEMA,
      binding,
      policy_version: WALMART_POLICY_VERSION,
      reviewed_at: REVIEWED_AT,
      reviewer: {
        reviewer_id: "human-reviewer-17",
        role: "HUMAN_COMPLIANCE_REVIEWER",
      },
      decision: "CLEARED",
      official_sources: WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS.map(
        (sourceId) => ({
          source_id: sourceId,
          url: sourceUrl(sourceId),
          captured_at: REVIEWED_AT,
          checked_at: REVIEWED_AT,
        }),
      ),
      findings: [
        {
          finding_id: "category-preapproval",
          disposition: "REQUIRES_APPROVAL",
          summary: "The exact seller account has the required ingestible entitlement.",
          policy_source_ids: ["prohibited-products-overview"],
          required_approval_scopes: ["INGESTIBLE_PRODUCTS"],
        },
        {
          finding_id: "condition-resale-rights",
          disposition: "CLEARED",
          summary: "New-condition resale and rights evidence was reviewed for this SKU.",
          policy_source_ids: ["resold-products"],
          required_approval_scopes: [],
        },
        {
          finding_id: "food-labeling-prohibited",
          disposition: "CLEARED",
          summary: "Food identity, labeling, and prohibited-food controls were reviewed.",
          policy_source_ids: ["food-products", "prohibited-products-overview"],
          required_approval_scopes: [],
        },
        {
          finding_id: "product-claims",
          disposition: "CLEARED",
          summary: "All public product claims were reviewed against current policy.",
          policy_source_ids: ["product-claims"],
          required_approval_scopes: [],
        },
        {
          finding_id: "recall-safety",
          disposition: "CLEARED",
          summary: "Recall and product-safety controls were reviewed for the exact item.",
          policy_source_ids: ["recalled-products"],
          required_approval_scopes: [],
        },
        {
          finding_id: "territory-legal-sanctions",
          disposition: "CLEARED",
          summary: "Territory, legal, sanctions, and state restrictions were reviewed.",
          policy_source_ids: [
            "prohibited-products-overview",
            "restricted-illegal-products",
          ],
          required_approval_scopes: [],
        },
      ],
      required_category_approvals: [approval],
    },
    context: {
      expected_binding: { ...binding },
      certification_policy_review: {
        status: "CLEARED",
        reviewed_at: REVIEWED_AT,
        evidence_ref: POLICY_REF,
      },
      certification_category_approvals: [approval],
      artifact: {
        ref: POLICY_REF,
        captured_at: REVIEWED_AT,
        source_url: POLICY_URL,
      },
      now: NOW,
    },
  };
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("accepts a strict fresh human policy review bound to the exact candidate", () => {
  const { evidence, context } = fixture();
  const parsed = parseAndValidateWalmartNewSkuPolicyReviewEvidence({
    bytes: bytes(evidence),
    context,
  });
  assert.equal(parsed.decision, "CLEARED");
  assert.equal(parsed.binding.stage_sha256, context.expected_binding.stage_sha256);
  assert.equal(parsed.required_category_approvals[0]?.scope, "INGESTIBLE_PRODUCTS");
});

test("rejects arbitrary bytes and unknown JSON fields", () => {
  const { evidence, context } = fixture();
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: Buffer.from("x", "utf8"),
      context,
    }),
    /POLICY_REVIEW_JSON_INVALID/,
  );

  const withUnknown = structuredClone(evidence);
  withUnknown.self_asserted_clearance = true;
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(withUnknown),
      context,
    }),
    /POLICY_REVIEW_FIELDS_INVALID/,
  );

  const duplicateDecision = `${JSON.stringify(evidence, null, 2)}\n`.replace(
    '  "decision": "CLEARED",',
    '  "decision": "BLOCKED",\n  "decision": "CLEARED",',
  );
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: Buffer.from(duplicateDecision, "utf8"),
      context,
    }),
    /POLICY_REVIEW_JSON_NONCANONICAL/,
  );
});

test("rejects a review copied from another stage or candidate", () => {
  const { evidence, context } = fixture();
  const binding = evidence.binding as Record<string, unknown>;
  binding.stage_sha256 = "9".repeat(64);
  binding.candidate_sha256 = "8".repeat(64);
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(evidence),
      context,
    }),
    /POLICY_REVIEW_BINDING_MISMATCH:stage_sha256.*POLICY_REVIEW_BINDING_MISMATCH:candidate_sha256|POLICY_REVIEW_BINDING_MISMATCH:candidate_sha256.*POLICY_REVIEW_BINDING_MISMATCH:stage_sha256/,
  );
});

test("rejects stale review and stale official-source checks", () => {
  const { evidence, context } = fixture();
  const staleAt = "2026-07-01T13:00:00.000Z";
  evidence.reviewed_at = staleAt;
  const source = (evidence.official_sources as Array<Record<string, unknown>>)[0]!;
  source.captured_at = staleAt;
  source.checked_at = staleAt;
  context.certification_policy_review.reviewed_at = staleAt;
  context.artifact.captured_at = staleAt;
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(evidence),
      context,
    }),
    /POLICY_REVIEW_REVIEWED_AT_INVALID.*POLICY_REVIEW_SOURCE_0_INVALID/,
  );
});

test("CLEARED fails with prohibited/unresolved findings or a missing approval", () => {
  for (const disposition of ["PROHIBITED", "UNRESOLVED"] as const) {
    const { evidence, context } = fixture();
    const finding = (evidence.findings as Array<Record<string, unknown>>)[0]!;
    finding.disposition = disposition;
    finding.required_approval_scopes = [];
    assert.throws(
      () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
        bytes: bytes(evidence),
        context,
      }),
      /POLICY_REVIEW_FINDING_0_NOT_CLEARED/,
    );
  }

  const { evidence, context } = fixture();
  context.certification_category_approvals = [];
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(evidence),
      context,
    }),
    /POLICY_REVIEW_APPROVAL_BINDING_MISMATCH:INGESTIBLE_PRODUCTS/,
  );

  const shifted = fixture();
  const shiftedFindings =
    shifted.evidence.findings as Array<Record<string, unknown>>;
  const category = shiftedFindings.find(
    (finding) => finding.finding_id === "category-preapproval",
  )!;
  const condition = shiftedFindings.find(
    (finding) => finding.finding_id === "condition-resale-rights",
  )!;
  category.disposition = "CLEARED";
  category.required_approval_scopes = [];
  condition.disposition = "REQUIRES_APPROVAL";
  condition.required_approval_scopes = ["INGESTIBLE_PRODUCTS"];
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(shifted.evidence),
      context: shifted.context,
    }),
    /POLICY_REVIEW_CATEGORY_APPROVAL_DOMAIN_INVALID|POLICY_REVIEW_FINDING_1_APPROVAL_DOMAIN_INVALID/,
  );
});

test("rejects an empty or incomplete mandatory review-domain checklist", () => {
  const empty = fixture();
  empty.evidence.findings = [];
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(empty.evidence),
      context: empty.context,
    }),
    /POLICY_REVIEW_FINDINGS_INVALID/,
  );

  for (const domainId of WALMART_NEW_SKU_REQUIRED_POLICY_REVIEW_DOMAIN_IDS) {
    const missing = fixture();
    missing.evidence.findings = (
      missing.evidence.findings as Array<Record<string, unknown>>
    ).filter((finding) => finding.finding_id !== domainId);
    assert.throws(
      () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
        bytes: bytes(missing.evidence),
        context: missing.context,
      }),
      /POLICY_REVIEW_FINDINGS_INVALID/,
    );
  }
});

test("requires every pinned official source ID with its exact URL", () => {
  for (const sourceId of WALMART_NEW_SKU_REQUIRED_POLICY_SOURCE_IDS) {
    const missing = fixture();
    missing.evidence.official_sources = (
      missing.evidence.official_sources as Array<Record<string, unknown>>
    ).filter((source) => source.source_id !== sourceId);
    assert.throws(
      () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
        bytes: bytes(missing.evidence),
        context: missing.context,
      }),
      new RegExp(`POLICY_REVIEW_REQUIRED_SOURCE_MISSING:${sourceId}`),
    );
  }

  const spoofed = fixture();
  const source = (
    spoofed.evidence.official_sources as Array<Record<string, unknown>>
  )[0]!;
  source.url = "https://marketplacelearn.walmart.com/guides/different-policy";
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(spoofed.evidence),
      context: spoofed.context,
    }),
    /POLICY_REVIEW_SOURCE_0_INVALID/,
  );

  const extra = fixture();
  const extraSource = WALMART_POLICY_SOURCES.find(
    (source) => source.id === "item-spec-versioning",
  )!;
  (extra.evidence.official_sources as Array<Record<string, unknown>>).push({
    source_id: extraSource.id,
    url: extraSource.url,
    captured_at: REVIEWED_AT,
    checked_at: REVIEWED_AT,
  });
  (extra.evidence.official_sources as Array<Record<string, unknown>>).sort(
    (left, right) => String(left.source_id).localeCompare(String(right.source_id)),
  );
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(extra.evidence),
      context: extra.context,
    }),
    /POLICY_REVIEW_OFFICIAL_SOURCES_INVALID/,
  );
});

test("rejects non-canonical ISO aliases even when Date.parse accepts them", () => {
  const { evidence, context } = fixture();
  evidence.reviewed_at = "2026-07-19T09:00:00-04:00";
  context.certification_policy_review.reviewed_at =
    "2026-07-19T09:00:00-04:00";
  context.artifact.captured_at = "2026-07-19T09:00:00-04:00";
  assert.throws(
    () => parseAndValidateWalmartNewSkuPolicyReviewEvidence({
      bytes: bytes(evidence),
      context,
    }),
    /POLICY_REVIEW_REVIEWED_AT_INVALID/,
  );
});
