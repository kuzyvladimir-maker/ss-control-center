/**
 * Walmart has to be able to download our images, and only ours are moved.
 *
 * The first item we ever submitted was rejected with ERR_EXT_DATA_0101171 —
 * "we couldn't download the image from your URL ... the host domain is blocked".
 * The file itself was correct: 2200×2200 PNG, 2.85 MB, fully opaque on a white
 * background, HTTP 200 in a browser. The host was the problem: Cloudflare's
 * `*.r2.dev` address is development-only, rate-limited, and bot-filters some
 * clients outright.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  marketplaceImageUrl,
  marketplaceImageUrls,
} from "../marketplace-image-url";

const R2 = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev";

test("our own images are served from a host Walmart can reach", () => {
  const rewritten = marketplaceImageUrl(`${R2}/walmart-new-sku/draft-main/abc.png`);
  assert.match(rewritten, /^https:\/\/[^/]+\/api\/public-image\//u);
  assert.doesNotMatch(rewritten, /r2\.dev/u);
});

test("the key survives the move, so the bytes are the same object", () => {
  const key = "walmart-new-sku/draft-main/a50f3b93.png";
  assert.ok(marketplaceImageUrl(`${R2}/${key}`).endsWith(`/api/public-image/${key}`));
});

test("the URL still ends in an image extension, which Walmart requires", () => {
  for (const extension of ["png", "jpg", "jpeg"]) {
    const url = marketplaceImageUrl(`${R2}/walmart-new-sku/x.${extension}`);
    assert.ok(url.endsWith(`.${extension}`), url);
  }
});

test("donor images stay exactly where they are", () => {
  // These are reachable already, and proxying someone else's asset through our
  // own domain would be traffic we pay for and a URL we would have to keep alive.
  const untouched = [
    "https://i5.walmartimages.com/asr/abc.jpeg",
    "https://images.salsify.com/image/upload/x.jpg",
    "https://m.media-amazon.com/images/I/x.jpg",
  ];
  for (const url of untouched) {
    assert.equal(marketplaceImageUrl(url), url);
  }
});

test("an already-rewritten URL is not rewritten twice", () => {
  const once = marketplaceImageUrl(`${R2}/walmart-new-sku/x.png`);
  assert.equal(marketplaceImageUrl(once), once);
});

test("empty and missing values are passed through, not invented", () => {
  assert.equal(marketplaceImageUrl(null), "");
  assert.equal(marketplaceImageUrl(undefined), "");
  assert.equal(marketplaceImageUrl("   "), "");
});

test("a gallery keeps its order and drops nothing", () => {
  const gallery = [
    `${R2}/walmart-new-sku/one.png`,
    "https://i5.walmartimages.com/asr/two.jpeg",
    `${R2}/walmart-new-sku/three.png`,
  ];
  const result = marketplaceImageUrls(gallery);
  assert.equal(result.length, 3);
  assert.match(result[0]!, /api\/public-image\/walmart-new-sku\/one\.png$/u);
  assert.equal(result[1], gallery[1]);
  assert.match(result[2]!, /api\/public-image\/walmart-new-sku\/three\.png$/u);
});
