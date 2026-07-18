import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUYER_SNAPSHOT_SCHEMA,
  captureWalmartBuyerSnapshot,
  resolveExactBuyerPdp,
  resolveExactSellerItem,
  sha256,
  validateExactItemResolution,
  writeImmutableWalmartBuyerSnapshot,
} from "../buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "../exact-item-resolution.ts";

const target = {
  sku: "Exact-SKU-1",
  item_id: "123456789",
  expected_title: "Brand Blue 4 Pack",
};
const sellerTitle = "Brand Blue 4 Pack";
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 0,
]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function exactResolution() {
  return resolveExactWalmartItemCandidate(target.sku, {
    ItemResponse: [{
      sku: target.sku,
      productName: sellerTitle,
      upc: "123456789012",
      gtin: "00123456789012",
      wpid: "ALPHANUMERIC-WPID",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
    }],
  }, {
    items: [{
      itemId: target.item_id,
      standardUpc: ["00123456789012"],
      title: sellerTitle,
      isMarketPlaceItem: true,
      images: [{ url: "https://i5.walmartimages.com/catalog-candidate.png" }],
    }],
  });
}

function validBuyer(itemId = target.item_id) {
  return { product: {
    item_id: itemId,
    product_url: `https://www.walmart.com/ip/brand-blue/${itemId}`,
    title: "Buyer title",
    main_image: "https://i5.walmartimages.com/main.png",
    images: [{ link: "https://i5.walmartimages.com/gallery.jpg" }],
  } };
}

test("legacy seller parser selects exact SKU but never treats WPID as itemId", () => {
  const resolved = resolveExactSellerItem({
    ItemResponse: [
      { sku: "Related-SKU", itemId: "777", productName: "Wrong" },
      {
        sku: target.sku,
        mart: { itemId: target.item_id },
        wpid: "ALPHANUMERIC-WPID",
        productName: "Correct",
      },
    ],
  }, target);
  assert.equal(resolved.sku, target.sku);
  assert.equal(resolved.item_id, target.item_id);
  assert.equal(resolved.title, "Correct");

  assert.throws(
    () => resolveExactSellerItem({
      ItemResponse: [{ sku: target.sku, wpid: "ALPHANUMERIC-WPID" }],
    }, target),
    /no itemId evidence/,
  );
});

test("legacy seller parser fails closed on missing SKU or conflicting numeric IDs", () => {
  assert.throws(
    () => resolveExactSellerItem({
      ItemResponse: [{ sku: "Related-SKU", itemId: target.item_id }],
    }, target),
    /exact-SKU seller row, found 0/,
  );
  assert.throws(
    () => resolveExactSellerItem({
      ItemResponse: [{
        sku: target.sku,
        itemId: target.item_id,
        mart: { itemId: "999" },
      }],
    }, target),
    /conflicting itemId evidence/,
  );
});

test("buyer PDP requires exact item identity evidence and extracts MAIN plus gallery", () => {
  const resolved = resolveExactBuyerPdp(validBuyer(), target);
  assert.equal(resolved.item_id, target.item_id);
  assert.equal(resolved.main_image_url, "https://i5.walmartimages.com/main.png");
  assert.deepEqual(
    resolved.gallery_image_urls,
    ["https://i5.walmartimages.com/gallery.jpg"],
  );
});

test("buyer PDP rejects missing, mismatched, and conflicting item identity", () => {
  const base = {
    title: "Brand Blue",
    main_image: "https://i5.walmartimages.com/main.jpeg",
  };
  assert.throws(() => resolveExactBuyerPdp({ product: base }, target), /no itemId evidence/);
  assert.throws(
    () => resolveExactBuyerPdp({ product: { ...base, item_id: "999" } }, target),
    /buyer PDP itemId 999 != requested/,
  );
  assert.throws(
    () => resolveExactBuyerPdp({ product: {
      ...base,
      item_id: target.item_id,
      product_url: "https://www.walmart.com/ip/wrong/999",
    } }, target),
    /conflicting itemId evidence/,
  );
});

test("operational capture proves seller -> GTIN -> catalog itemId -> PDP chain", async () => {
  const resolution = exactResolution();
  const requestedImages = [];
  const draft = await captureWalmartBuyerSnapshot(target, {
    async getExactItemResolution(sku) {
      assert.equal(sku, target.sku);
      return resolution;
    },
    async getBuyerPdpByItemId(itemId) {
      assert.equal(itemId, target.item_id);
      return validBuyer(itemId);
    },
    async getImage(url) {
      requestedImages.push(url);
      return { status: 200, bytes: url.endsWith(".png") ? png : jpeg, final_url: url };
    },
  }, new Date("2026-07-18T20:00:00.000Z"));

  assert.equal(draft.schema_version, BUYER_SNAPSHOT_SCHEMA);
  assert.equal(draft.identity.buyer_facing_verified, true);
  assert.equal(draft.identity.seller.wpid, "ALPHANUMERIC-WPID");
  assert.equal(draft.identity.catalog_search_candidate.item_id, target.item_id);
  assert.ok(draft.identity.chain_evidence.seller_to_catalog.includes(
    `catalog.unique_numeric_public_itemId=${target.item_id}`,
  ));
  assert.ok(draft.identity.chain_evidence.catalog_to_buyer_pdp.includes(
    `product.item_id=${target.item_id}`,
  ));
  assert.deepEqual(requestedImages, [
    "https://i5.walmartimages.com/main.png",
    "https://i5.walmartimages.com/gallery.jpg",
  ]);
  assert.deepEqual(draft.assets.map((asset) => asset.slot), ["MAIN", "GALLERY_1"]);
  assert.equal(draft.assets[0].sha256, sha256(png));
  assert.equal(draft.assets[1].sha256, sha256(jpeg));
  assert.deepEqual(draft.source_contract, {
    seller: "walmart_marketplace_exact_sku_get",
    candidate: "walmart_catalog_search_exact_upc",
    buyer: "walmart_buyer_pdp_exact_item_get",
    positional_or_fuzzy_fallbacks: 0,
    database_writes: 0,
    walmart_writes: 0,
    r2_writes: 0,
  });
  assert.equal(
    draft.payload_hashes.seller_payload_canonical_sha256,
    resolution.source_hashes.seller_payload_canonical_sha256,
  );
  assert.equal(
    draft.payload_hashes.catalog_search_payload_canonical_sha256,
    resolution.source_hashes.catalog_search_payload_canonical_sha256,
  );
  assert.match(draft.payload_hashes.resolution_canonical_sha256, /^[a-f0-9]{64}$/);
  assert.match(draft.payload_hashes.buyer_payload_canonical_sha256, /^[a-f0-9]{64}$/);
});

test("resolution chain failure occurs before buyer PDP or image GET", async () => {
  const invalid = structuredClone(exactResolution());
  invalid.sku = "Wrong-SKU";
  let buyerCalls = 0;
  let imageCalls = 0;
  await assert.rejects(() => captureWalmartBuyerSnapshot(target, {
    async getExactItemResolution() { return invalid; },
    async getBuyerPdpByItemId() { buyerCalls++; return {}; },
    async getImage() { imageCalls++; return { bytes: png }; },
  }), /resolution SKU does not match target/);
  assert.equal(buyerCalls, 0);
  assert.equal(imageCalls, 0);
});

test("target and catalog candidate itemId must match before PDP GET", async () => {
  const invalid = structuredClone(exactResolution());
  invalid.catalog_search_candidate.item_id = "999";
  let buyerCalls = 0;
  await assert.rejects(() => captureWalmartBuyerSnapshot(target, {
    async getExactItemResolution() { return invalid; },
    async getBuyerPdpByItemId() { buyerCalls++; return {}; },
    async getImage() { return { bytes: png }; },
  }), /catalog candidate itemId 999 != requested/);
  assert.equal(buyerCalls, 0);
});

test("candidate cannot claim buyer-facing verification before PDP", () => {
  const invalid = structuredClone(exactResolution());
  invalid.buyer_facing_verified = true;
  assert.throws(
    () => validateExactItemResolution(invalid, target),
    /pre-PDP resolution must have buyer_facing_verified=false/,
  );
});

test("invalid source hash or missing chain evidence fails closed", () => {
  const badHash = structuredClone(exactResolution());
  badHash.source_hashes.seller_payload_canonical_sha256 = "not-a-hash";
  assert.throws(
    () => validateExactItemResolution(badHash, target),
    /seller payload hash must be a lowercase SHA-256/,
  );

  const badEvidence = structuredClone(exactResolution());
  badEvidence.identity_evidence = badEvidence.identity_evidence.filter(
    (entry) => !entry.startsWith("catalog.unique_numeric_public_itemId="),
  );
  assert.throws(
    () => validateExactItemResolution(badEvidence, target),
    /identity evidence does not prove the chain/,
  );
});

test("only exact PDP echo flips verified; mismatch happens before image GET", async () => {
  let imageCalls = 0;
  await assert.rejects(() => captureWalmartBuyerSnapshot(target, {
    async getExactItemResolution() { return exactResolution(); },
    async getBuyerPdpByItemId() { return validBuyer("999"); },
    async getImage() { imageCalls++; return { bytes: png }; },
  }), /buyer PDP itemId 999 != requested/);
  assert.equal(imageCalls, 0);
});

test("image endpoint returning HTML fails raster preflight", async () => {
  await assert.rejects(() => captureWalmartBuyerSnapshot(target, {
    async getExactItemResolution() { return exactResolution(); },
    async getBuyerPdpByItemId() { return validBuyer(); },
    async getImage() {
      return { status: 200, bytes: new TextEncoder().encode("<html>captcha</html>") };
    },
  }), /not a supported raster image/);
});

test("immutable writer content-seals assets and reuses only an identical snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wm-buyer-snapshot-test-"));
  try {
    const draft = await captureWalmartBuyerSnapshot(target, {
      async getExactItemResolution() { return exactResolution(); },
      async getBuyerPdpByItemId() {
        return { product: {
          item_id: target.item_id,
          title: "Buyer title",
          main_image: "https://i5.walmartimages.com/main.png",
        } };
      },
      async getImage() { return { status: 200, bytes: png }; },
    }, new Date("2026-07-18T20:00:00.000Z"));
    const first = await writeImmutableWalmartBuyerSnapshot(root, draft);
    const second = await writeImmutableWalmartBuyerSnapshot(root, draft);
    assert.equal(second.directory, first.directory);
    assert.equal(second.snapshot.body_sha256, first.snapshot.body_sha256);
    const bytes = await readFile(
      path.join(first.directory, first.snapshot.assets[0].local_path),
    );
    assert.equal(sha256(bytes), first.snapshot.assets[0].sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
