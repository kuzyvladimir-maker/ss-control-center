import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  type CanonicalProductIdentity,
} from "../canonical-product-match";
import {
  CANONICAL_COST_SELECTOR_VERSION,
  selectCanonicalCostEvidence,
  type CanonicalCostCandidate,
} from "../canonical-cost-selection";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
  type PriceEvidencePolicyOptions,
} from "../price-evidence-policy";

const NOW = "2026-07-18T16:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;
const policy: PriceEvidencePolicyOptions = { now: NOW, maxAgeMs: HOUR_MS };

const target: CanonicalProductIdentity = {
  brand: "Acme",
  productLine: "Crunch Chips",
  flavor: "Barbecue",
  form: "Potato Chips",
  outerPackCount: 1,
  size: "8 oz",
  title: "Acme Crunch Chips Barbecue Potato Chips 8 oz",
};

function identity(overrides: Partial<CanonicalProductIdentity> = {}): CanonicalProductIdentity {
  return {
    brand: "Acme",
    productLine: "Crunch Chips",
    flavor: "Barbecue",
    form: "Potato Chips",
    outerPackCount: 1,
    size: "8 oz",
    ...overrides,
  };
}

function candidate(overrides: Partial<CanonicalCostCandidate> = {}): CanonicalCostCandidate {
  return {
    donorOfferObservationId: "observation-exact",
    donorOfferId: "offer-exact",
    donorProductId: "product-exact",
    donorIdentity: identity(),
    rawTitle: "Acme Crunch Chips Barbecue Potato Chips 8 oz",
    rawBrand: "Acme",
    retailer: "Publix",
    via: "direct",
    price: 4.99,
    isFirstParty: true,
    inStock: true,
    zip: "33765",
    localityEvidence: "zip_scoped",
    fetchedAt: "2026-07-18T15:30:00.000Z",
    ...overrides,
  };
}

test("a cheaper adjacent flavor cannot outrank the correct exact product", () => {
  const wrongFlavor = candidate({
    donorOfferId: "offer-wrong-flavor",
    donorProductId: "product-wrong-flavor",
    donorIdentity: identity({ flavor: "Sour Cream" }),
    rawTitle: "Acme Crunch Chips Sour Cream Potato Chips 8 oz",
    price: 0.99,
  });
  const correct = candidate({ price: 5.49 });

  const result = selectCanonicalCostEvidence(target, [wrongFlavor, correct], policy);

  assert.equal(result.outcome, "FACT");
  assert.equal(result.selected?.candidate.donorOfferId, "offer-exact");
  assert.equal(result.targetComparablePrice, 5.49);
  assert.equal(result.contentDonorProductId, "product-exact");
  assert.equal(result.priceEvidenceDonorProductId, "product-exact");
  assert.equal(result.evaluations[0].match.verdict, "SIBLING_ESTIMATE");
  assert.equal(result.evaluations[0].contentDonorProductId, null);
});

test("all rows are evaluated before ranking, so five bad leading rows cannot hide a later fact", () => {
  const rows: CanonicalCostCandidate[] = [
    candidate({
      donorOfferId: "junk-brand",
      donorIdentity: identity({ brand: "Dover" }),
      rawBrand: "Dover",
      rawTitle: "Dover Crunch Chips Barbecue Potato Chips 8 oz",
      price: 0.10,
    }),
    candidate({
      donorOfferId: "junk-no-title",
      donorIdentity: null,
      rawTitle: null,
      price: 0.20,
    }),
    candidate({ donorOfferId: "junk-oos", inStock: false, price: 0.30 }),
    candidate({
      donorOfferId: "junk-stale",
      fetchedAt: "2026-07-18T10:00:00.000Z",
      price: 0.40,
    }),
    candidate({ donorOfferId: "junk-unknown-stock", inStock: null, price: 0.50 }),
    candidate({ donorOfferId: "valid-after-five", price: 6.25 }),
  ];

  const result = selectCanonicalCostEvidence(target, rows, policy);

  assert.equal(result.evaluatedCandidateCount, 6);
  assert.equal(result.evaluations.length, rows.length);
  assert.equal(result.eligibleFactCount, 1);
  assert.equal(result.selected?.candidate.donorOfferId, "valid-after-five");
  assert.equal(result.targetComparablePrice, 6.25);
});

test("cross-size estimates convert through canonical base amounts across oz and lb", () => {
  const onePound = candidate({
    donorOfferId: "offer-one-pound",
    donorProductId: "product-one-pound",
    donorIdentity: identity({ size: "1 lb" }),
    rawTitle: "Acme Crunch Chips Barbecue Potato Chips 1 lb",
    price: 6,
  });

  const result = selectCanonicalCostEvidence(target, [onePound], policy);
  const selected = result.selected;

  assert.equal(result.outcome, "ESTIMATE");
  assert.equal(selected?.match.verdict, "CROSS_SIZE_ESTIMATE");
  assert.equal(selected?.conversion?.kind, "CROSS_SIZE");
  assert.equal(selected?.conversion?.baseUnit, "g");
  assert.ok(Math.abs((selected?.conversion?.multiplier ?? 0) - 0.5) < 1e-12);
  assert.ok(Math.abs((result.targetComparablePrice ?? 0) - 3) < 1e-12);
  assert.equal(result.contentDonorProductId, null);
  assert.equal(result.priceEvidenceDonorProductId, "product-one-pound");
});

test("exact raw-title evidence uses the fail-closed bridge; an adjacent title is rejected", () => {
  const bridgedExact = candidate({
    donorOfferId: "title-exact",
    donorProductId: "title-product",
    donorIdentity: null,
  });
  const bridgedWrong = candidate({
    donorOfferId: "title-wrong",
    donorProductId: "title-wrong-product",
    donorIdentity: null,
    rawTitle: "Acme Crunch Chips Sour Cream Potato Chips 8 oz",
    price: 0.25,
  });

  const result = selectCanonicalCostEvidence(target, [bridgedWrong, bridgedExact], policy);

  assert.equal(result.selected?.candidate.donorOfferId, "title-exact");
  assert.equal(result.selected?.matchMode, "TITLE_BRIDGE");
  assert.equal(result.selected?.match.verdict, "EXACT_IDENTITY");
  assert.equal(result.evaluations[0].match.verdict, "REJECT");
});

test("sibling, size-unknown, cross-size, and Instacart estimates remain price-only", () => {
  const cases: Array<{
    name: string;
    row: CanonicalCostCandidate;
    verdict: string;
  }> = [
    {
      name: "sibling",
      row: candidate({
        donorProductId: "sibling-product",
        donorIdentity: identity({ flavor: "Sour Cream" }),
        rawTitle: "Acme Crunch Chips Sour Cream Potato Chips 8 oz",
      }),
      verdict: "SIBLING_ESTIMATE",
    },
    {
      name: "size unknown",
      row: candidate({
        donorProductId: "unknown-size-product",
        donorIdentity: identity({ size: null }),
        rawTitle: "Acme Crunch Chips Barbecue Potato Chips",
      }),
      verdict: "SIZE_UNKNOWN_ESTIMATE",
    },
    {
      name: "cross size",
      row: candidate({
        donorProductId: "cross-size-product",
        donorIdentity: identity({ size: "16 oz" }),
        rawTitle: "Acme Crunch Chips Barbecue Potato Chips 16 oz",
      }),
      verdict: "CROSS_SIZE_ESTIMATE",
    },
    {
      name: "Instacart exact",
      row: candidate({
        donorProductId: "instacart-product",
        via: "instacart",
      }),
      verdict: "EXACT_IDENTITY",
    },
  ];

  for (const row of cases) {
    const result = selectCanonicalCostEvidence(target, [row.row], policy);
    assert.equal(result.outcome, "ESTIMATE", row.name);
    assert.equal(result.selected?.match.verdict, row.verdict, row.name);
    assert.equal(result.contentDonorProductId, null, row.name);
    assert.equal(result.priceEvidenceDonorProductId, row.row.donorProductId, row.name);
  }
});

test("unknown stock, stale observations, and unscoped local prices all fail closed", () => {
  const result = selectCanonicalCostEvidence(target, [
    candidate({ donorOfferId: "unknown-stock", inStock: null }),
    candidate({
      donorOfferId: "stale",
      fetchedAt: "2026-07-18T14:59:59.999Z",
    }),
    candidate({ donorOfferId: "unscoped", localityEvidence: null }),
  ], policy);

  assert.equal(result.outcome, "UNSOURCEABLE");
  assert.equal(result.selected, null);
  assert.equal(result.contentDonorProductId, null);
  assert.equal(result.priceEvidenceDonorProductId, null);
  assert.ok(result.evaluations[0].priceEvidence.reasonCodes.includes("STOCK_UNKNOWN"));
  assert.ok(result.evaluations[1].priceEvidence.reasonCodes.includes("EVIDENCE_STALE"));
  assert.ok(result.evaluations[2].priceEvidence.reasonCodes.includes("LOCALITY_SCOPE_UNPROVEN"));
});

test("selection returns complete versioned matcher and policy provenance", () => {
  const result = selectCanonicalCostEvidence(target, [candidate()], policy);
  const selected = result.selected;

  assert.equal(result.selectorVersion, CANONICAL_COST_SELECTOR_VERSION);
  assert.equal(selected?.selectorVersion, CANONICAL_COST_SELECTOR_VERSION);
  assert.equal(selected?.match.matcherVersion, CANONICAL_PRODUCT_MATCHER_VERSION);
  assert.equal(selected?.priceEvidence.policyVersion, PRICE_EVIDENCE_POLICY_VERSION);
  assert.deepEqual(selected?.match.reasonCodes, ["IDENTITY_EXACT", "SIZE_EXACT"]);
  assert.deepEqual(selected?.priceEvidence.reasonCodes, ["EXACT_IDENTITY_DIRECT_FACT"]);
});

test("canonical variant contract rejects false factual aliases but permits typed proxy variants", () => {
  const targetVariant = `cpv1:${"a".repeat(64)}`;
  const otherVariant = `cpv1:${"b".repeat(64)}`;
  const result = selectCanonicalCostEvidence(target, [
    candidate({
      donorOfferId: "wrong-canonical-alias",
      canonicalVariantId: otherVariant,
      variantDecisionId: "decision-wrong",
      price: 0.5,
    }),
    candidate({
      donorOfferId: "right-canonical-alias",
      canonicalVariantId: targetVariant,
      variantDecisionId: "decision-right",
      price: 5,
    }),
  ], policy, { targetCanonicalVariantId: targetVariant });

  assert.equal(result.outcome, "FACT");
  assert.equal(result.selected?.candidate.donorOfferId, "right-canonical-alias");
  assert.ok(result.evaluations[0].selectorReasonCodes.includes("CANONICAL_VARIANT_MISMATCH"));

  const proxy = selectCanonicalCostEvidence(target, [candidate({
    donorOfferId: "cross-size-proxy",
    donorIdentity: identity({ size: "16 oz" }),
    rawTitle: "Acme Crunch Chips Barbecue Potato Chips 16 oz",
    canonicalVariantId: otherVariant,
    variantDecisionId: "decision-proxy",
  })], policy, { targetCanonicalVariantId: targetVariant });
  assert.equal(proxy.outcome, "ESTIMATE");
  assert.equal(proxy.selected?.match.verdict, "CROSS_SIZE_ESTIMATE");

  const unproven = selectCanonicalCostEvidence(
    target,
    [candidate()],
    policy,
    { targetCanonicalVariantId: targetVariant },
  );
  assert.equal(unproven.outcome, "UNSOURCEABLE");
  assert.ok(unproven.evaluations[0].selectorReasonCodes.includes("CANONICAL_VARIANT_UNPROVEN"));
});
