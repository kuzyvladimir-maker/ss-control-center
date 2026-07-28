import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateWalmartTemplateShippingScenarios,
  parseWalmartShippingTemplateDetails,
  parseWalmartShippingTemplateList,
  WalmartShippingTemplateContractError,
} from "../walmart-shipping-templates";

test("list parser returns active account templates before inactive ones", () => {
  const templates = parseWalmartShippingTemplateList({
    totalRecords: 2,
    shippingTemplates: [
      {
        id: "2",
        name: "Old",
        type: "CUSTOM",
        status: "INACTIVE",
        rateModelType: "TIERED_PRICING",
        createdDate: 1_700_000_000_000,
        modifiedDate: 1_700_000_000_000,
      },
      {
        id: "1",
        name: "Free",
        type: "DEFAULT",
        status: "ACTIVE",
        rateModelType: "PER_SHIPMENT_PRICING",
        createdDate: 1_700_000_000_000,
        modifiedDate: 1_700_000_000_000,
      },
    ],
  });
  assert.deepEqual(templates.map((template) => template.id), ["1", "2"]);
});

test("details parser recognizes free shipping and preserves exact coverage", () => {
  const template = parseWalmartShippingTemplateDetails({
    id: "free-1",
    name: "Free Standard",
    type: "CUSTOM",
    status: "ACTIVE",
    rateModelType: "PER_SHIPMENT_PRICING",
    createdDate: 1_700_000_000_000,
    modifiedDate: 1_700_000_000_001,
    shippingMethods: [{
      shipMethod: "STANDARD",
      status: "ACTIVE",
      configurations: [{
        regions: [{
          regionCode: "C",
          regionName: "48 State",
          subRegions: [{
            subRegionCode: "SE",
            states: [{ stateCode: "FL" }, { stateCode: "GA" }],
          }],
        }],
        addressTypes: ["STREET"],
        transitTime: 4,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  assert.equal(template.is_free_shipping, true);
  assert.deepEqual(template.configurations[0]!.state_codes, ["FL", "GA"]);
  assert.match(template.template_sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    calculateWalmartTemplateShippingScenarios({
      template,
      itemPriceCents: 3_313,
      packageWeightOz: 20,
    })[0]!.customer_shipping_charge_cents,
    0,
  );
});

test("details parser normalizes Walmart-omitted unused variable charge to zero", () => {
  const perItemTemplate = parseWalmartShippingTemplateDetails({
    id: "free-per-item",
    name: "Free per item",
    type: "CUSTOM",
    status: "ACTIVE",
    rateModelType: "PER_SHIPMENT_PRICING",
    createdDate: 1_700_000_000_000,
    modifiedDate: 1_700_000_000_001,
    shippingMethods: [{
      shipMethod: "STANDARD",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State" }],
        addressTypes: ["STREET"],
        transitTime: 3,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  assert.deepEqual(
    perItemTemplate.configurations[0]!.pricing,
    {
      kind: "PER_SHIPMENT_PRICING",
      unit_of_measure: "LB",
      shipping_and_handling: { amount_cents: 0, currency: "USD" },
      charge_per_weight: { amount_cents: 0, currency: "USD" },
      charge_per_item: { amount_cents: 0, currency: "USD" },
    },
  );
  assert.equal(perItemTemplate.is_free_shipping, true);

  const perWeightTemplate = parseWalmartShippingTemplateDetails({
    id: "free-per-weight",
    name: "Free per weight",
    type: "DEFAULT",
    status: "ACTIVE",
    rateModelType: "PER_SHIPMENT_PRICING",
    createdDate: 1_700_000_000_000,
    modifiedDate: 1_700_000_000_001,
    shippingMethods: [{
      shipMethod: "VALUE",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State" }],
        addressTypes: ["STREET"],
        transitTime: 6,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  assert.equal(
    calculateWalmartTemplateShippingScenarios({
      template: perWeightTemplate,
      itemPriceCents: 3_313,
      packageWeightOz: 20,
    })[0]!.customer_shipping_charge_cents,
    0,
  );
  assert.equal(perWeightTemplate.is_free_shipping, true);
});

test("tiered template selects the exact price tier", () => {
  const template = parseWalmartShippingTemplateDetails({
    id: "tiered-1",
    name: "Tiered",
    type: "CUSTOM",
    status: "ACTIVE",
    rateModelType: "TIERED_PRICING",
    createdDate: 1_700_000_000_000,
    modifiedDate: 1_700_000_000_001,
    shippingMethods: [{
      shipMethod: "VALUE",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State" }],
        addressTypes: ["STREET"],
        transitTime: 6,
        tieredShippingCharges: [
          {
            minLimit: 0,
            maxLimit: 20,
            shipCharge: { amount: 7.99, currency: "USD" },
          },
          {
            minLimit: 20.01,
            maxLimit: -1,
            shipCharge: { amount: 0, currency: "USD" },
          },
        ],
      }],
    }],
  });
  assert.equal(
    calculateWalmartTemplateShippingScenarios({
      template,
      itemPriceCents: 2_000,
      packageWeightOz: 12,
    })[0]!.customer_shipping_charge_cents,
    799,
  );
  assert.equal(
    calculateWalmartTemplateShippingScenarios({
      template,
      itemPriceCents: 2_001,
      packageWeightOz: 12,
    })[0]!.customer_shipping_charge_cents,
    0,
  );
});

test("unknown or incomplete rate data fails closed", () => {
  assert.throws(
    () => parseWalmartShippingTemplateDetails({
      id: "bad",
      name: "Bad",
      type: "CUSTOM",
      status: "ACTIVE",
      rateModelType: "PER_SHIPMENT_PRICING",
      createdDate: 1_700_000_000_000,
      modifiedDate: 1_700_000_000_001,
      shippingMethods: [{
        shipMethod: "STANDARD",
        status: "ACTIVE",
        configurations: [{
          regions: [{ regionCode: "C", regionName: "48 State" }],
          addressTypes: ["STREET"],
          transitTime: 5,
          perShippingCharge: {
            unitOfMeasure: "LB",
            shippingAndHandling: { amount: 11.99, currency: "USD" },
          },
        }],
      }],
    }),
    WalmartShippingTemplateContractError,
  );
});
