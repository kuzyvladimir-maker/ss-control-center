import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartItemAssociationsRequest,
  buildWalmartSkuTemplateMapContract,
  findExactWalmartShippingAssociation,
} from "../walmart-shipping-template-association";

const expectation = {
  sku: "BF-WM-RITZ-2",
  shipping_template_id: "template-free-1",
  fulfillment_center_id: "FC-1",
};

test("builds the exact one-SKU SKU_TEMPLATE_MAP multipart contract", () => {
  const result = buildWalmartSkuTemplateMapContract(expectation);
  assert.deepEqual(result.params, { feedType: "SKU_TEMPLATE_MAP" });
  assert.deepEqual(result.payload, {
    ItemFeedHeader: {
      sellingChannel: "marketplace",
      locale: "en",
      version: "1.0",
    },
    ItemFeed: [{
      sku: "BF-WM-RITZ-2",
      actionType: "Add",
      shippingTemplateId: "template-free-1",
      fulfillmentCenterId: "FC-1",
    }],
  });
  assert.deepEqual(JSON.parse(result.file.content), result.payload);
  assert.equal(result.payload_sha256.length, 64);
});

test("builds the official item-association request shape", () => {
  assert.deepEqual(
    buildWalmartItemAssociationsRequest("BF-WM-RITZ-2"),
    { items: [{ sku: "BF-WM-RITZ-2" }] },
  );
});

test("accepts only the exact template and fulfillment-center association", () => {
  const result = findExactWalmartShippingAssociation({
    items: [{
      sku: "BF-WM-RITZ-2",
      associations: [{
        shippingTemplate: {
          name: "Free Shipping",
          type: "CUSTOM",
          id: "template-free-1",
        },
        shipNodeName: "Main warehouse",
        shipNode: "FC-1",
      }],
      errors: [],
    }],
  }, expectation);
  assert.deepEqual(result, {
    sku: "BF-WM-RITZ-2",
    shipping_template_id: "template-free-1",
    shipping_template_name: "Free Shipping",
    shipping_template_type: "CUSTOM",
    fulfillment_center_id: "FC-1",
    fulfillment_center_name: "Main warehouse",
  });
});

test("returns pending when Walmart has not propagated the exact mapping yet", () => {
  assert.equal(findExactWalmartShippingAssociation({
    items: [{
      sku: "BF-WM-RITZ-2",
      associations: [],
      errors: [],
    }],
  }, expectation), null);
});

test("fails closed on Walmart errors, duplicates and placeholder inputs", () => {
  assert.throws(
    () => findExactWalmartShippingAssociation({
      items: [{
        sku: "BF-WM-RITZ-2",
        associations: [],
        errors: [{ severity: "ERROR", description: "Invalid SKU" }],
      }],
    }, expectation),
    /association error/,
  );
  const duplicate = {
    shippingTemplate: {
      name: "Free Shipping",
      type: "CUSTOM",
      id: "template-free-1",
    },
    shipNodeName: "Main warehouse",
    shipNode: "FC-1",
  };
  assert.throws(
    () => findExactWalmartShippingAssociation({
      items: [{
        sku: "BF-WM-RITZ-2",
        associations: [duplicate, duplicate],
        errors: [],
      }],
    }, expectation),
    /duplicate exact associations/,
  );
  assert.throws(
    () => buildWalmartSkuTemplateMapContract({
      ...expectation,
      shipping_template_id: "TODO",
    }),
    /Shipping template ID is required/,
  );
});
