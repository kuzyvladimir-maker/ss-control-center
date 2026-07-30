import assert from "node:assert/strict";
import test from "node:test";

import {
  RETAILER_SOURCE_DETAIL_COPY_NORMALIZATION,
  verifyRetailerSourceDetailIdentity,
} from "../donor-catalog";

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
