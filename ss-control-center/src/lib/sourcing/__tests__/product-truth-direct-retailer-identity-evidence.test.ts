import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileProductTruthDirectRetailerIdentityEvidence,
  renderProductTruthDirectRetailerIdentityEvidence,
} from "../product-truth-direct-retailer-identity-evidence";

const CAPTURED_AT = "2026-08-01T15:00:00.000Z";

function html(nextData: unknown): Uint8Array {
  return Buffer.from(
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`,
  );
}

function walmartHtml(input: {
  itemId: string;
  title: string;
  upc: string;
  specifications?: unknown[];
  directions?: unknown[];
}): Uint8Array {
  return html({
    props: {
      pageProps: {
        initialData: {
          data: {
            product: {
              usItemId: input.itemId,
              name: input.title,
              upc: input.upc,
            },
            idml: {
              specifications: input.specifications ?? [],
              directions: input.directions ?? [],
            },
          },
        },
      },
    },
  });
}

function common(input: {
  retailer: "walmart" | "target";
  url: string;
  htmlBytes: Uint8Array;
}) {
  return compileProductTruthDirectRetailerIdentityEvidence({
    targetCanonicalVariantId: `cpv1:${"a".repeat(64)}`,
    donorProductId: "donor-1",
    offerId: "offer-1",
    retailer: input.retailer,
    productUrl: input.url,
    finalUrl: input.url,
    httpStatus: 200,
    capturedAt: CAPTURED_AT,
    htmlBytes: input.htmlBytes,
  });
}

test("Walmart exact Container type is byte-bound package-form evidence", () => {
  const evidence = common({
    retailer: "walmart",
    url: "https://www.walmart.com/ip/example/38125427?classType=REGULAR",
    htmlBytes: walmartHtml({
      itemId: "38125427",
      title: "Mueller's Wide Egg Noodles, 12 oz",
      upc: "047325908499",
      specifications: [{ name: "Container type", value: "Box" }],
    }),
  });
  assert.equal(evidence.retailerContent.normalizedGtin14, "00047325908499");
  assert.deepEqual(evidence.retailerContent.packageFormEvidence, {
    source: "WALMART_IDML_CONTAINER_TYPE",
    sourcePath: "props.pageProps.initialData.data.idml.specifications",
    rawValue: "Box",
    normalizedForm: "box",
  });
  const rendered = renderProductTruthDirectRetailerIdentityEvidence(evidence);
  assert.deepEqual(JSON.parse(rendered), evidence);
  assert.ok(rendered.endsWith("\n"));
});

test("two exact Walmart instruction phrases prove box without visual inference", () => {
  const evidence = common({
    retailer: "walmart",
    url: "https://www.walmart.com/ip/example/40838732?classType=VARIANT",
    htmlBytes: walmartHtml({
      itemId: "40838732",
      title: "Mueller's Ridged Jumbo Elbows, 16 oz",
      upc: "029200907858",
      directions: [{
        name: "Instructions",
        value: "Boil water. 1/2 Box - 3 qt. Full box - 4 qt. Drain.",
      }],
    }),
  });
  assert.equal(
    evidence.retailerContent.packageFormEvidence?.source,
    "WALMART_IDML_DIRECTIONS_EXACT_PACKAGE_USAGE",
  );
  assert.equal(
    evidence.retailerContent.packageFormEvidence?.normalizedForm,
    "box",
  );
});

test("Target primary_barcode supplies GTIN without guessing package form", () => {
  const evidence = common({
    retailer: "target",
    url: "https://www.target.com/p/example/-/A-92782650",
    htmlBytes: html({
      props: {
        pageProps: {
          item: {
            primary_barcode: "042400240518",
            product_description: {
              title: "Malt-O-Meal S&#39;mores Breakfast Cereal - 30oz",
              bullet_descriptions: ["Net weight: 30oz"],
            },
            enrichment: {},
          },
        },
      },
    }),
  });
  assert.equal(evidence.retailerContent.normalizedGtin14, "00042400240518");
  assert.equal(
    evidence.retailerContent.title,
    "Malt-O-Meal S'mores Breakfast Cereal - 30oz",
  );
  assert.equal(evidence.retailerContent.packageFormEvidence, null);
});

test("Walmart item drift and package-form contradiction fail closed", () => {
  assert.throws(
    () => common({
      retailer: "walmart",
      url: "https://www.walmart.com/ip/example/40838732",
      htmlBytes: walmartHtml({
        itemId: "99999999",
        title: "Wrong item",
        upc: "029200907858",
      }),
    }),
    /DIRECT_RETAILER_IDENTITY_ITEM_MISMATCH/,
  );
  assert.throws(
    () => common({
      retailer: "walmart",
      url: "https://www.walmart.com/ip/example/40838732",
      htmlBytes: walmartHtml({
        itemId: "40838732",
        title: "Contradictory item",
        upc: "029200907858",
        specifications: [{ name: "Container type", value: "Bag" }],
        directions: [{
          name: "Instructions",
          value: "Use 1/2 Box for one meal or the Full box for a family meal.",
        }],
      }),
    }),
    /DIRECT_RETAILER_IDENTITY_FORM_CONTRADICTION/,
  );
});
