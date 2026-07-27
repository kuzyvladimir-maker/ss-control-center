import assert from "node:assert/strict";
import { test } from "node:test";

import { projectWalmartPublicBuyerPdpHtml } from "../public-buyer-pdp.ts";
import {
  projectWalmartListingSurfaceFromBuyerPdp,
} from "../listing-integrity-audit.ts";

const ITEM_ID = "8412702942";
const MAIN = "https://i5.walmartimages.com/seo/current-main.png";
const GALLERY = "https://i5.walmartimages.com/asr/current-gallery.jpeg";

function html(overrides = {}) {
  const product = {
    usItemId: ITEM_ID,
    primaryUsItemId: ITEM_ID,
    canonicalUrl: `/ip/Pepperidge-Farm-15-Grain-Bread-Pack-of-2/${ITEM_ID}`,
    name: "Pepperidge Farm Whole Grain Thin Sliced 15 Grain Bread, 22 oz (Pack of 2)",
    shortDescription: "Pepperidge Farm Whole Grain Thin Sliced 15 Grain bread.",
    imageInfo: { allImages: [{ url: MAIN }, { url: GALLERY }] },
    ...overrides,
  };
  const payload = {
    props: { pageProps: { initialData: { data: {
      product,
      idml: {
        shortDescription: product.shortDescription,
        longDescription: "<ul><li>15 Grain thin sliced bread</li><li>100% whole grain flour</li></ul>",
        specifications: [
          { name: "Brand", value: "Pepperidge Farm" },
          { name: "Multipack quantity", value: "2" },
          { name: "Count", value: "30" },
          { name: "Product net content parent", value: "22 Ounces" },
        ],
      },
    } } } },
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

test("projects the exact primary Walmart PDP and every ordered image", () => {
  const payload = projectWalmartPublicBuyerPdpHtml(html(), ITEM_ID);
  assert.deepEqual(payload, {
    product: {
      item_id: ITEM_ID,
      product_url: `https://www.walmart.com/ip/Pepperidge-Farm-15-Grain-Bread-Pack-of-2/${ITEM_ID}`,
      title: "Pepperidge Farm Whole Grain Thin Sliced 15 Grain Bread, 22 oz (Pack of 2)",
      main_image: MAIN,
      images: [MAIN, GALLERY],
      description: "Pepperidge Farm Whole Grain Thin Sliced 15 Grain bread.",
      feature_bullets: ["15 Grain thin sliced bread", "100% whole grain flour"],
      specifications: [
        { name: "Brand", value: "Pepperidge Farm" },
        { name: "Multipack quantity", value: "2" },
        { name: "Count", value: "30" },
        { name: "Product net content parent", value: "22 Ounces" },
      ],
    },
  });
  const surface = projectWalmartListingSurfaceFromBuyerPdp(payload, {
    sku: "FaisalX-1130",
    item_id: ITEM_ID,
  });
  assert.deepEqual(surface.attribute_claims, [
    { field_path: "product.specifications[0].Brand", kind: "brand", text: "Pepperidge Farm" },
    { field_path: "product.specifications[1].Multipack quantity", kind: "outer_units", value: 2, unit: "count" },
    { field_path: "product.specifications[3].Product net content parent", kind: "net_content", value: 22, unit: "oz" },
  ]);
  assert.equal(surface.unmapped_attributes.length, 1);
});

test("rejects related-item substitution, duplicate NEXT_DATA, and duplicate images", () => {
  assert.throws(
    () => projectWalmartPublicBuyerPdpHtml(html({ usItemId: "999" }), ITEM_ID),
    /does not match the requested item ID/,
  );
  const one = html();
  assert.throws(
    () => projectWalmartPublicBuyerPdpHtml(`${one}${one}`, ITEM_ID),
    /exactly one Walmart __NEXT_DATA__/,
  );
  assert.throws(
    () => projectWalmartPublicBuyerPdpHtml(html({
      imageInfo: { allImages: [{ url: MAIN }, { url: MAIN }] },
    }), ITEM_ID),
    /duplicate URLs/,
  );
});

test("rejects unsupported specification shapes instead of dropping source fields", () => {
  const bad = html().replace(
    '"name":"Count","value":"30"',
    '"name":"Count","value":"30","hidden":true',
  );
  assert.throws(
    () => projectWalmartPublicBuyerPdpHtml(bad, ITEM_ID),
    /unsupported keys/,
  );
});
