import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { calculateWalmartNewSkuEconomics } from
  "../../bundle-factory/walmart-new-sku-economics.ts";
import {
  MARUCHAN_ROAST_CHICKEN_NATIONAL_RATE_PER_LB_CENTS,
  MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS,
  MARUCHAN_ROAST_CHICKEN_SERVICE_STATES,
  buildMaruchanPricePayload,
  buildMaruchanRoastChickenItemPayload,
  buildMaruchanShippingAssociationPayload,
  buildMaruchanSoutheastShippingTemplate,
  maruchanRoastChickenEconomics,
  maruchanRoastChickenTitle,
  validateMaruchanCatalogClearanceReports,
} from "../maruchan-roast-chicken-repair.ts";

const main = Object.fromEntries(
  MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => [
    row.sku,
    `https://assets.example.com/${row.sku}.jpg`,
  ]),
) as Record<(typeof MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS)[number]["sku"], string>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clearanceReport(
  row: (typeof MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS)[number],
  mainImageUrl = `https://i5.walmartimages.com/seo/${row.sku}-roast-chicken-new.jpg`,
) {
  const body = {
    schema_version: "walmart-exact-item-resolution-probe/v2",
    input: { sku: row.sku, store_index: 1 },
    resolution: {
      seller: {
        sku: row.sku,
        upc: row.upc,
        title: maruchanRoastChickenTitle(row),
      },
      catalog_search_candidate: {
        item_id: row.item_id,
        title: maruchanRoastChickenTitle(row),
        main_image_url: mainImageUrl,
      },
    },
  };
  return {
    ...body,
    seal: {
      body_sha256: createHash("sha256")
        .update(canonicalJson(body))
        .digest("hex"),
    },
  };
}

test("compiles exact Roast Chicken identity and correct Walmart count semantics", () => {
  const payload = buildMaruchanRoastChickenItemPayload({
    main_image_urls: main,
    exact_carton_image_url: "https://assets.example.com/carton.jpg",
  });
  const items = payload.MPItem as Array<Record<string, Record<string, unknown>>>;
  assert.equal(items.length, 3);
  for (let index = 0; index < items.length; index += 1) {
    const row = MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS[index];
    const visibleEnvelope = items[index].Visible;
    const visible = visibleEnvelope[
      "Prepared & Packaged Soups"
    ] as Record<string, unknown>;
    assert.equal(visible.productName, maruchanRoastChickenTitle(row));
    assert.equal(visible.countPerPack, 12);
    assert.equal(visible.multipackQuantity, row.carton_count);
    assert.equal(visible.count, row.cup_count);
    assert.deepEqual(visible.variantAttributeNames, ["multipackQuantity"]);
    assert.doesNotMatch(String(visible.shortDescription), /Chicken Flower/iu);
    assert.match(String(visible.shortDescription), /roasted-chicken-flavored broth/u);
    assert.ok(String(visible.shortDescription).split(/\s+/u).length >= 150);
    assert.ok(
      (visible.keyFeatures as string[]).every((feature) => feature.length <= 80),
    );
  }
});

test("prices meet the exact 30% contribution-margin floor", () => {
  assert.deepEqual(
    MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) =>
      maruchanRoastChickenEconomics(row).item_price_cents),
    [5283, 11139, 19749],
  );
  for (const row of MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS) {
    const economics = maruchanRoastChickenEconomics(row);
    assert.ok(economics.contribution_margin_bps >= 3000);
    assert.equal(
      (buildMaruchanPricePayload(row).pricing as Array<{
        currentPrice: { amount: number };
      }>)[0].currentPrice.amount,
      economics.item_price_cents / 100,
    );
  }
});

test("builds a free four-state template from Walmart's exact region taxonomy", () => {
  const details = {
    shippingMethods: [{
      shipMethod: "VALUE",
      configurations: [{
        regions: [{
          regionCode: "C",
          regionName: "48 State",
          subRegions: [],
        }],
        addressTypes: ["STREET"],
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
        },
      }],
    }, {
      shipMethod: "STANDARD",
      configurations: [{
        regions: [{
          regionCode: "C",
          subRegions: [{
            subRegionCode: "C1",
            states: [
              { stateCode: "AL", stateName: "Alabama" },
              { stateCode: "FL", stateName: "Florida" },
              { stateCode: "GA", stateName: "Georgia" },
              { stateCode: "SC", stateName: "South Carolina" },
              ...Array.from({ length: 45 }, (_value, index) => ({
                stateCode: `X${String(index).padStart(2, "0")}`,
              })),
            ],
          }],
        }],
        addressTypes: ["STREET", "PO_BOX"],
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  };
  const result = buildMaruchanSoutheastShippingTemplate(details);
  const methods = result.shippingMethods as Array<Record<string, unknown>>;
  const configurations = (
    methods.find((method) => method.shipMethod === "STANDARD")!
      .configurations as Array<Record<string, unknown>>
  );
  const states = (
    configurations[0].regions as Array<{
      subRegions: Array<{ states: Array<{ stateCode: string }> }>;
    }>
  ).flatMap((region) => region.subRegions)
    .flatMap((subRegion) => subRegion.states)
    .map((state) => state.stateCode)
    .sort();
  assert.deepEqual(states, [...MARUCHAN_ROAST_CHICKEN_SERVICE_STATES].sort());
  assert.equal(configurations[0].transitTime, 4);
  assert.equal(configurations.length, 2);
  const nationalCharge = configurations[1].perShippingCharge as {
    chargePerWeight: { amount: number };
  };
  assert.equal(configurations[1].transitTime, 5);
  assert.equal(nationalCharge.chargePerWeight.amount, 16);
});

test("national weight rate preserves 30% margin at observed worst-case quotes", () => {
  const worstLabels = [2943, 14785, 21691];
  for (
    let index = 0;
    index < MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.length;
    index += 1
  ) {
    const row = MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS[index];
    const base = maruchanRoastChickenEconomics(row);
    const national = calculateWalmartNewSkuEconomics({
      goodsCostCents: row.goods_cost_cents,
      packagingCostCents: row.packaging_cost_cents,
      shippingLabelCents: worstLabels[index],
      itemPriceCents: base.item_price_cents,
      customerShippingChargeCents:
        row.shipping_weight_lb
        * MARUCHAN_ROAST_CHICKEN_NATIONAL_RATE_PER_LB_CENTS,
    });
    assert.ok(national.contribution_margin_bps >= 3000);
  }
});

test("binds all three exact SKUs to one template and one warehouse", () => {
  const result = buildMaruchanShippingAssociationPayload("template-1");
  const rows = result.ItemFeed as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row.sku), [
    "FaisalX-1433",
    "FaisalX-1434",
    "FaisalX-1435",
  ]);
  assert.ok(rows.every((row) =>
    row.fulfillmentCenterId === "685099568484274177"
    && row.shippingTemplateId === "template-1"));
});

test("catalog clearance requires exact sealed corrected title and changed MAIN for every SKU", () => {
  assert.doesNotThrow(() =>
    validateMaruchanCatalogClearanceReports(
      MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) =>
        clearanceReport(row)),
    ));
  assert.throws(
    () => validateMaruchanCatalogClearanceReports(
      MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row, index) =>
        clearanceReport(
          row,
          index === 2
            ? row.incorrect_main_image_url
            : `https://i5.walmartimages.com/seo/${row.sku}-new.jpg`,
        )),
    ),
    /catalog conflict has not been cleared/u,
  );
});
