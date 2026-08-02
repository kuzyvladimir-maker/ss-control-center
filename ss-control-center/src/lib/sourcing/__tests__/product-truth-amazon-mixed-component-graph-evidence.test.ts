import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveProductTruthAmazonComponentPackageForm,
  validateProductTruthAmazonMixedComponentGraphTopology,
} from "../product-truth-amazon-component-graph-evidence";

const components = [
  "Strawberry",
  "Grape",
  "Raspberry",
  "Chocolate",
  "Honey",
  "Peanut Butter",
].map((listingVariantLabel) => ({
  listingVariantLabel,
  retailPackageQuantity: 4,
  unitCountPerRetailPackage: 4,
}));

const exact = {
  listingKey: "amazon:1:VARIETY-96",
  listingTitle: "Uncrustables Mixed Flavors (Strawberry, Grape, Raspberry, Chocolate, Honey, Peanut Butter) - 4 Count - Pack of 24 (total 96 pieces)",
  reviewedOcr: "Strawberry Jam Grape Jelly Raspberry Spread Chocolate Hazelnut Honey Spread Peanut Butter Sandwich",
  catalogFlavorValue: "Strawberry, Grape, Raspberry, Chocolate, Honey, Peanut Butter",
  components,
  catalogOuterCount: 24,
  titleOuterCount: 24,
  titleBaseCount: 4,
  titleTotalCount: 96,
};

test("accepts a complete mixed graph only when flavor set and count math agree", () => {
  assert.deepEqual(
    validateProductTruthAmazonMixedComponentGraphTopology(exact),
    { outerCount: 24, baseCount: 4, totalCount: 96 },
  );
});

test("rejects a mixed graph when the declared total does not equal component math", () => {
  assert.throws(
    () => validateProductTruthAmazonMixedComponentGraphTopology({
      ...exact,
      titleTotalCount: 95,
    }),
    /AMAZON_MIXED_COMPONENT_GRAPH_TOPOLOGY_REJECTED/u,
  );
});

test("rejects a title/image flavor substitution instead of guessing the component", () => {
  assert.throws(
    () => validateProductTruthAmazonMixedComponentGraphTopology({
      ...exact,
      listingTitle: "Uncrustables Strawberry, Grape, Raspberry, Chocolate, Peanut Butter variety",
      reviewedOcr: "Strawberry Grape Raspberry Chocolate Honey",
      catalogFlavorValue: "Strawberry, Grape, Raspberry, Chocolate, Peanut Butter",
      components: components.slice(0, 5),
      catalogOuterCount: 20,
      titleOuterCount: 20,
      titleTotalCount: 80,
    }),
    /AMAZON_MIXED_COMPONENT_GRAPH_TOPOLOGY_REJECTED/u,
  );
});

test("accepts a reviewed carton when retailer and canonical form fields are absent", () => {
  assert.equal(
    resolveProductTruthAmazonComponentPackageForm({
      adjudicatedPackageForm: "Carton",
      targetForm: null,
      directRetailerForm: null,
    }),
    "carton",
  );
});

test("rejects missing or conflicting component package-form evidence", () => {
  assert.throws(
    () => resolveProductTruthAmazonComponentPackageForm({}),
    /AMAZON_COMPONENT_GRAPH_PACKAGE_FORM_REJECTED/u,
  );
  assert.throws(
    () => resolveProductTruthAmazonComponentPackageForm({
      adjudicatedPackageForm: "Carton",
      directRetailerForm: "bag",
    }),
    /AMAZON_COMPONENT_GRAPH_PACKAGE_FORM_REJECTED/u,
  );
});
