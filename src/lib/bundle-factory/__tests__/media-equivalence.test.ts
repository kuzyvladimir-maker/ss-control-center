import assert from "node:assert/strict";
import { test } from "node:test";

import sharp from "sharp";

import { PerceptualMediaEquivalence } from "../repair/media-equivalence";

test("different Amazon nutrition-panel URLs require exact identity even when pixels could look alike", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("Amazon-to-Amazon comparison must not fetch or use MAE");
  }) as typeof fetch;
  try {
    const equivalence = new PerceptualMediaEquivalence(255);
    assert.equal(
      await equivalence.equivalent(
        "https://m.media-amazon.com/images/I/nutrition-210-cal.jpg",
        "https://m.media-amazon.com/images/I/nutrition-220-cal.jpg",
      ),
      false,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("perceptual equivalence remains available for a source-to-Amazon rehost", async () => {
  const originalFetch = globalThis.fetch;
  const pixels = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .png()
    .toBuffer();
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(new Uint8Array(pixels), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(pixels.length),
      },
    });
  }) as typeof fetch;
  try {
    const equivalence = new PerceptualMediaEquivalence();
    assert.equal(
      await equivalence.equivalent(
        "https://approved-source.r2.dev/card.png",
        "https://m.media-amazon.com/images/I/rehosted-card.jpg",
      ),
      true,
    );
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
