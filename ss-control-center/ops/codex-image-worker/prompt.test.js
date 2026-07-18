"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt, REQUIRED_IMAGE_MODEL } = require("./prompt");

test("labels every donor reference in a multi-flavor recipe", () => {
  const prompt = buildPrompt("render exact recipe", "2048x2048", [
    "/tmp/ref-1.png",
    "/tmp/ref-2.png",
    "/tmp/ref-3.png",
    "/tmp/ref-4.png",
  ]);

  assert.match(prompt, /ref-1\.png is the KIT ANCHOR/);
  assert.match(prompt, /ref-2\.png is DONOR PRODUCT REFERENCE #1 for recipe component #1/);
  assert.match(prompt, /ref-3\.png is DONOR PRODUCT REFERENCE #2 for recipe component #2/);
  assert.match(prompt, /ref-4\.png is DONOR PRODUCT REFERENCE #3 for recipe component #3/);
  assert.match(prompt, /Pass ALL 4 files to image_gen in this exact order/);
  assert.match(prompt, new RegExp(REQUIRED_IMAGE_MODEL));
  assert.doesNotMatch(prompt, /Pass BOTH files/);
});

test("keeps a single reference explicitly scoped to the application prompt", () => {
  const prompt = buildPrompt("render", "1536x1536", ["/tmp/ref-1.png"]);
  assert.match(prompt, /Reference image ref-1\.png/);
  assert.match(prompt, /only the roles assigned to it by the application prompt/);
  assert.match(prompt, /square image/);
});
