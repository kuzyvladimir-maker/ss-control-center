import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVeeqoItemTitle } from "../item-title";

test("appends the variant that carries the pack size (NAN health)", () => {
  assert.equal(
    buildVeeqoItemTitle({
      sku_code: "NAN-OMEGA3-2PK",
      product_title: "Omega 3 Krill Oil Dietary Supplement Softgels",
      title: "2-Pack Bundle",
    }),
    "Omega 3 Krill Oil Dietary Supplement Softgels 2-Pack Bundle",
  );

  assert.equal(
    buildVeeqoItemTitle({
      sku_code: "NAN-OMEGA3-60",
      product_title: "Omega 3 Krill Oil Dietary Supplement Softgels",
      title: "60 Softgels Bottle",
    }),
    "Omega 3 Krill Oil Dietary Supplement Softgels 60 Softgels Bottle",
  );
});

test("leaves a master title that already spells the variant out", () => {
  assert.equal(
    buildVeeqoItemTitle({
      sku_code: "X",
      product_title: "Magnesium Calm Powder 70 Servings Pouch",
      title: "70 Servings Pouch",
    }),
    "Magnesium Calm Powder 70 Servings Pouch",
  );
});

test("ignores placeholder and SKU-echo variants", () => {
  for (const title of ["Default Title", "default", "One Size", "N/A"]) {
    assert.equal(
      buildVeeqoItemTitle({ sku_code: "S1", product_title: "Krill Oil", title }),
      "Krill Oil",
    );
  }
  assert.equal(
    buildVeeqoItemTitle({ sku_code: "SS-KRILL-1", product_title: "Krill Oil", title: "SS-KRILL-1" }),
    "Krill Oil",
  );
});

test("prefers the variant field when it already holds the whole name", () => {
  assert.equal(
    buildVeeqoItemTitle({
      sku_code: "X",
      product_title: "Krill Oil",
      title: "Krill Oil 2-Pack Bundle",
    }),
    "Krill Oil 2-Pack Bundle",
  );
});

test("falls back through Veeqo's older field shapes, then to the SKU", () => {
  assert.equal(
    buildVeeqoItemTitle({ sku_code: "X", product: { title: "Master Name" } }),
    "Master Name",
  );
  assert.equal(
    buildVeeqoItemTitle({ sku_code: "X", product: { name: "Older Name" } }),
    "Older Name",
  );
  assert.equal(buildVeeqoItemTitle({ sku_code: "ONLY-SKU" }), "ONLY-SKU");
  assert.equal(buildVeeqoItemTitle(null), "");
});
