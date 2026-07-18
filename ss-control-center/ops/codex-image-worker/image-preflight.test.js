"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasSupportedImageSignature } = require("./image-preflight");

test("accepts supported raster signatures", () => {
  assert.equal(hasSupportedImageSignature(Buffer.from("89504e470d0a1a0a00000000", "hex")), true);
  assert.equal(hasSupportedImageSignature(Buffer.from("ffd8ff000000000000000000", "hex")), true);
  assert.equal(hasSupportedImageSignature(Buffer.from("524946460000000057454250", "hex")), true);
  assert.equal(hasSupportedImageSignature(Buffer.from("000000006674797061766966", "hex")), true);
});

test("rejects non-image and truncated bytes", () => {
  assert.equal(hasSupportedImageSignature(Buffer.from("not an image payload")), false);
  assert.equal(hasSupportedImageSignature(Buffer.from("ffd8", "hex")), false);
  assert.equal(hasSupportedImageSignature(null), false);
});
