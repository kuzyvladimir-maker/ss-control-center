import assert from "node:assert/strict";
import test from "node:test";

import {
  RETAILER_SOURCE_DETAIL_COPY_NORMALIZATION,
  evaluateRetailerSourceDetailEscalation,
  verifyRetailerSourceDetailIdentity,
} from "../donor-catalog";
import { scoreOffer } from "../retail-fetch";

const walmartOffer = {
  retailer: "walmart",
  retailerProductId: "123456789",
  productUrl: "https://www.walmart.com/ip/Birds-Eye/123456789",
};

const target = {
  brand: "Birds Eye",
  product_line: "Fire Roasted Corn",
  container_type: "Bag",
  size: "12 oz",
  outer_pack_count: 1,
};

function scoredSearchOffer(title: string) {
  return scoreOffer({
    ...walmartOffer,
    price: 2.48,
    currency: "USD",
    inStock: true,
    zip: "33765",
    localityEvidence: "zip_scoped" as const,
    observedAt: "2026-07-30T08:00:00.000Z",
    title,
    description: null,
    keyFeatures: [],
    imageUrls: [],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct" as const,
  }, target);
}

test("paid detail admission requires exact size before missing-form escalation", () => {
  const exact = evaluateRetailerSourceDetailEscalation({
    target,
    offer: scoredSearchOffer("Birds Eye Fire Roasted Corn, 12 oz"),
  });
  assert.equal(exact.admitted, true);
  assert.equal(exact.reason, "MISSING_FORM_ONLY");
  assert.deepEqual(exact.blockers, []);

  const adjacentSize = evaluateRetailerSourceDetailEscalation({
    target,
    offer: scoredSearchOffer("Birds Eye Fire Roasted Corn, 28 oz"),
  });
  assert.equal(adjacentSize.admitted, false);
  assert.ok(
    adjacentSize.blockers.includes("SOURCE_DETAIL_SEARCH_SIZE_NOT_EXACT"),
  );

  const contradictoryUrl = evaluateRetailerSourceDetailEscalation({
    target,
    offer: {
      ...scoredSearchOffer("Birds Eye Fire Roasted Corn, 12 oz"),
      productUrl:
        "https://www.walmart.com/ip/Birds-Eye-Fire-Roasted-Corn-28-oz/123456789",
    },
  });
  assert.equal(contradictoryUrl.admitted, false);
  assert.ok(
    contradictoryUrl.blockers.includes(
      "SOURCE_DETAIL_SEARCH_URL_SIZE_CONTRADICTION",
    ),
  );
});

test("an explicit competing package form blocks paid detail", () => {
  const canTarget = {
    brand: "Pringles",
    product_line: "Potato Crisps Chips",
    flavor: "Ranch",
    container_type: "can",
    size: "5.5 oz",
    outer_pack_count: 1,
  };
  const offer = scoreOffer({
    ...walmartOffer,
    price: 2.24,
    currency: "USD",
    inStock: true,
    zip: "33765",
    localityEvidence: "zip_scoped" as const,
    observedAt: "2026-07-30T08:00:00.000Z",
    title: "Pringles Ranch Potato Crisps Chips, 5.5 oz Canister",
    description: null,
    keyFeatures: [],
    imageUrls: [],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct" as const,
  }, canTarget);
  const decision = evaluateRetailerSourceDetailEscalation({
    target: canTarget,
    offer,
  });

  assert.equal(decision.admitted, false);
  assert.ok(
    decision.blockers.includes("SOURCE_DETAIL_SEARCH_CONTAINER_CONTRADICTION"),
  );
});

test("individual copy words cannot authorize paid detail", () => {
  const boundedPhrase = evaluateRetailerSourceDetailEscalation({
    target,
    offer: scoredSearchOffer(
      "Birds Eye Fire Roasted Corn with 4g of Fiber per Serving, 12 oz Bag",
    ),
  });
  assert.equal(boundedPhrase.admitted, true);
  assert.equal(boundedPhrase.reason, "BOUNDED_COPY_ONLY");

  const unboundedWords = evaluateRetailerSourceDetailEscalation({
    target,
    offer: scoredSearchOffer(
      "Birds Eye Fire Roasted Corn Fiber Serving, 12 oz Bag",
    ),
  });
  assert.equal(unboundedWords.admitted, false);
  assert.ok(
    unboundedWords.blockers.includes(
      "SOURCE_DETAIL_SEARCH_COPY_NOT_BOUNDED_EXACT_PHRASE",
    ),
  );
});

test("same-item structured container type can supply only the missing form token", () => {
  const result = verifyRetailerSourceDetailIdentity({
    ...walmartOffer,
    target,
    detail: {
      title: "Birds Eye Fire Roasted Corn, 12 oz",
      retailerProductId: "123456789",
      productUrl: "https://www.walmart.com/ip/Birds-Eye/123456789",
      specifications: [{ name: "Container type", value: "Bag" }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.identityMatch?.verdict, "EXACT_IDENTITY");
  assert.equal(result.identityEvidenceTitle, "Birds Eye Fire Roasted Corn, 12 oz Bag");
  assert.equal(result.structuredForm?.value, "Bag");
  assert.match(
    result.identityEvidenceNormalization ?? "",
    new RegExp(`^${RETAILER_SOURCE_DETAIL_COPY_NORMALIZATION.replaceAll(".", "\\.")}:`),
  );
});

test("bounded full-phrase copy normalization preserves exact identity", () => {
  const result = verifyRetailerSourceDetailIdentity({
    ...walmartOffer,
    target,
    detail: {
      title:
        "Birds Eye Fire Roasted Corn with 4g of Fiber per Serving, Frozen Vegetables, 12 oz Bag",
      retailerProductId: "123456789",
      productUrl: "https://www.walmart.com/ip/Birds-Eye/123456789",
      specifications: [{ name: "Container type", value: "Bag" }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.identityMatch?.verdict, "EXACT_IDENTITY");
  assert.match(
    result.identityEvidenceNormalization ?? "",
    /full-fiber-per-serving-claim\+terminal-frozen-vegetables-category/,
  );
});

test("different structured form fails closed", () => {
  const result = verifyRetailerSourceDetailIdentity({
    ...walmartOffer,
    target,
    detail: {
      title: "Birds Eye Fire Roasted Corn, 12 oz",
      retailerProductId: "123456789",
      productUrl: "https://www.walmart.com/ip/Birds-Eye/123456789",
      specifications: [{ name: "Container type", value: "Box" }],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("SOURCE_DETAIL_STRUCTURED_FORM_MISMATCH"));
  assert.ok(result.blockers.includes("SOURCE_DETAIL_IDENTITY_NOT_EXACT"));
});

test("different retailer item binding fails closed", () => {
  const result = verifyRetailerSourceDetailIdentity({
    ...walmartOffer,
    target,
    detail: {
      title: "Birds Eye Fire Roasted Corn, 12 oz",
      retailerProductId: "987654321",
      productUrl: "https://www.walmart.com/ip/Birds-Eye/987654321",
      specifications: [{ name: "Container type", value: "Bag" }],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("SOURCE_DETAIL_RESPONSE_ITEM_ID_MISMATCH"));
  assert.ok(result.blockers.includes("SOURCE_DETAIL_RESPONSE_URL_MISMATCH"));
});

test("adjacent flavor cannot be repaired by structured form", () => {
  const result = verifyRetailerSourceDetailIdentity({
    ...walmartOffer,
    target: {
      brand: "Birds Eye",
      product_line: "Cheesy Broccoli",
      container_type: "Bag",
      size: "10.8 oz",
      outer_pack_count: 1,
    },
    detail: {
      title: "Birds Eye Cheddar Broccoli, 10.8 oz",
      retailerProductId: "123456789",
      productUrl: "https://www.walmart.com/ip/Birds-Eye/123456789",
      specifications: [{ name: "Container type", value: "Bag" }],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("SOURCE_DETAIL_IDENTITY_NOT_EXACT"));
});

test("missing structured form cannot fill a missing target form", () => {
  const result = verifyRetailerSourceDetailIdentity({
    ...walmartOffer,
    target,
    detail: {
      title: "Birds Eye Fire Roasted Corn, 12 oz",
      retailerProductId: "123456789",
      productUrl: "https://www.walmart.com/ip/Birds-Eye/123456789",
      specifications: [{ name: "Food condition", value: "Frozen" }],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("SOURCE_DETAIL_IDENTITY_NOT_EXACT"));
});
