import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { buildDeterministicWalmartMultipackImage } from
  "../walmart-new-sku-multipack-image";

async function sourceFixture(): Promise<Buffer> {
  const packageFace = Buffer.from(`
    <svg width="620" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="620" height="900" rx="12" fill="#d51e26"/>
      <rect y="570" width="620" height="330" fill="#f7a900"/>
      <text x="310" y="330" text-anchor="middle"
        font-family="Arial" font-size="150" font-weight="700" fill="white">BITS</text>
    </svg>
  `);
  return sharp({
    create: {
      width: 1_000,
      height: 1_000,
      channels: 3,
      background: "white",
    },
  })
    .composite([{ input: packageFace, left: 190, top: 50 }])
    .png()
    .toBuffer();
}

async function landscapeSourceFixture(): Promise<Buffer> {
  const packageFace = Buffer.from(`
    <svg width="920" height="350" xmlns="http://www.w3.org/2000/svg">
      <rect width="920" height="350" rx="36" fill="#073b8c"/>
      <rect y="235" width="920" height="115" fill="#43d6b1"/>
      <text x="460" y="220" text-anchor="middle"
        font-family="Arial" font-size="160" font-weight="700" fill="white">THINS</text>
    </svg>
  `);
  return sharp({
    create: {
      width: 1_200,
      height: 900,
      channels: 3,
      background: "white",
    },
  })
    .composite([{ input: packageFace, left: 140, top: 275 }])
    .png()
    .toBuffer();
}

test("builds deterministic exact-pixel Pack of 2 and Pack of 3 canvases", async () => {
  const source = await sourceFixture();
  const pack2a = await buildDeterministicWalmartMultipackImage({
    sourceUnitImageBytes: source,
    packCount: 2,
  });
  const pack2b = await buildDeterministicWalmartMultipackImage({
    sourceUnitImageBytes: source,
    packCount: 2,
  });
  const pack3 = await buildDeterministicWalmartMultipackImage({
    sourceUnitImageBytes: source,
    packCount: 3,
  });

  assert.equal(pack2a.output_sha256, pack2b.output_sha256);
  assert.notEqual(pack2a.output_sha256, pack3.output_sha256);
  assert.equal(pack2a.represented_unit_count, 2);
  assert.equal(pack3.represented_unit_count, 3);
  assert.deepEqual(await sharp(pack2a.bytes).metadata().then((metadata) => ({
    width: metadata.width,
    height: metadata.height,
  })), { width: 2_200, height: 2_200 });

  for (const output of [pack2a, pack3]) {
    const foreground = await sharp(output.bytes)
      .trim({ background: "white", threshold: 8 })
      .metadata();
    assert.ok(
      (foreground.width ?? 0) >= 2_050,
      `Pack of ${output.represented_unit_count} must occupy at least 93% of canvas width`,
    );
    assert.ok(
      (foreground.height ?? 0) >= 1_850,
      `Pack of ${output.represented_unit_count} must occupy at least 84% of canvas height`,
    );
  }
});

test("fills the square canvas without distortion for wide flexible packaging", async () => {
  const source = await landscapeSourceFixture();
  const outputs = await Promise.all(([2, 3] as const).map((packCount) =>
    buildDeterministicWalmartMultipackImage({
      sourceUnitImageBytes: source,
      packCount,
    })
  ));

  for (const output of outputs) {
    const foreground = await sharp(output.bytes)
      .trim({ background: "white", threshold: 8 })
      .metadata();
    assert.ok(
      (foreground.width ?? 0) >= 2_100,
      `wide Pack of ${output.represented_unit_count} must occupy at least 95% of canvas width`,
    );
    assert.ok(
      (foreground.height ?? 0) >= 2_000,
      `wide Pack of ${output.represented_unit_count} must occupy at least 90% of canvas height`,
    );
  }
});

test("builds a count-accurate Pack of 8 from the exact source package", async () => {
  const source = await sourceFixture();
  const pack8 = await buildDeterministicWalmartMultipackImage({
    sourceUnitImageBytes: source,
    packCount: 8,
  });
  assert.equal(pack8.represented_unit_count, 8);
  const foreground = await sharp(pack8.bytes)
    .trim({ background: "white", threshold: 8 })
    .metadata();
  assert.ok(
    (foreground.width ?? 0) >= 2_050,
    "Pack of 8 must occupy at least 93% of canvas width",
  );
  assert.ok(
    (foreground.height ?? 0) >= 2_050,
    "Pack of 8 must occupy at least 93% of canvas height",
  );
});

test("rejects invalid counts and empty sources", async () => {
  const source = await sourceFixture();
  await assert.rejects(
    () => buildDeterministicWalmartMultipackImage({
      sourceUnitImageBytes: source,
      packCount: 0,
    }),
    /whole number from 1 to 500/,
  );
  await assert.rejects(
    () => buildDeterministicWalmartMultipackImage({
      sourceUnitImageBytes: Buffer.alloc(0),
      packCount: 2,
    }),
    /cannot be empty/,
  );
});
