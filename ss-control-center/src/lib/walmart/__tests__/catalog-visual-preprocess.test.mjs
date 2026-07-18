import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import {
  VISUAL_PREPROCESS_SCHEMA,
  VISUAL_PREPROCESS_VERSION,
  preprocessCatalogVisual,
} from "../catalog-visual-preprocess.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SNAPSHOT_ROOT = path.join(
  ROOT,
  "data/audits/walmart-visual-pilot-snapshots/walmart-main-bbf179123bd9139dbe9e/raw",
);

const REVIEW_FIXTURES = [
  ["FaisalX-1130", "fbc00888141c0e35edab443c9e307f904de3eeee04a585a902a29416960c657c.png", 2],
  ["FaisalX-1160", "02a85fa8f4a70fa606fcbb01c4c5d851debac7e6224963a43eea878a813bca26.png", 2],
  ["FaisalX-1208", "344db9b3812f45761bb26d303e5646413aebb29335fb171029720e7da3f19929.png", 2],
  ["FaisalX-2223", "0458ff70c3f1e1136fc60422408f2b84de61f926bf2e4e46782953ef1f4daa45.png", 6],
  ["FaisalX-3545", "8b71f7141cd627dd8048e9ecb75fdfe8a3aa60d1b6e41b7429c636d13a146d1d.png", 8],
  ["FaisalX-4779", "575d8140eeb86ae45849bb8210edae583103c3ae43de465c49156a97a702bb7f.png", 4],
];

async function syntheticRepeatedImage(background = "#ffffff") {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
      <rect width="1200" height="800" fill="${background}"/>
      <g transform="translate(140 80)">
        <rect width="360" height="640" rx="30" fill="#1478b8"/>
        <rect x="28" y="42" width="118" height="82" fill="#f7b718"/>
        <rect x="42" y="220" width="276" height="230" fill="#ffffff"/>
        <path d="M55 510H305V604H55Z" fill="#d94134"/>
      </g>
      <g transform="translate(700 80)">
        <rect width="360" height="640" rx="30" fill="#1478b8"/>
        <rect x="28" y="42" width="118" height="82" fill="#f7b718"/>
        <rect x="42" y="220" width="276" height="230" fill="#ffffff"/>
        <path d="M55 510H305V604H55Z" fill="#d94134"/>
      </g>
    </svg>
  `);
  return sharp(svg).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

test("preprocessing is deterministic, immutable, and provenance-complete", async () => {
  const source = await syntheticRepeatedImage();
  const before = Buffer.from(source);
  const first = await preprocessCatalogVisual(source, { analysis_max_edge: 384 });
  const second = await preprocessCatalogVisual(source, { analysis_max_edge: 384 });

  assert.deepEqual(source, before);
  assert.equal(first.schema_version, VISUAL_PREPROCESS_SCHEMA);
  assert.equal(first.preprocessor_version, VISUAL_PREPROCESS_VERSION);
  assert.equal(first.analysis.status, "confirmed_repetition");
  assert.equal(first.analysis.region_count, 2);
  assert.match(first.analysis.analysis_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.views.map((view) => [view.role, view.sha256, view.provenance_sha256]),
    second.views.map((view) => [view.role, view.sha256, view.provenance_sha256]),
  );
  for (let index = 0; index < first.views.length; index += 1) {
    assert.deepEqual(first.views[index].bytes, second.views[index].bytes);
    assert.match(first.views[index].sha256, /^[a-f0-9]{64}$/);
    assert.match(first.views[index].provenance_sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(first.views.map((view) => view.role), [
    "full",
    "tile_front",
    "bottom_label",
    "top_left_badge",
  ]);
});

test("a non-white or lifestyle-like border fails closed to the full view", async () => {
  const result = await preprocessCatalogVisual(await syntheticRepeatedImage("#4b5563"));
  assert.equal(result.analysis.status, "full_only");
  assert.equal(result.analysis.region_count, 0);
  assert.match(result.analysis.reason, /background is not confidently near-white/);
  assert.deepEqual(result.views.map((view) => view.role), ["full"]);
});

test("one product is not called a repeated layout", async () => {
  const source = await sharp({
    create: { width: 1000, height: 1000, channels: 4, background: "#ffffff" },
  }).composite([{
    input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="800"><rect width="500" height="800" rx="30" fill="#d94134"/></svg>'),
    left: 250,
    top: 100,
  }]).png().toBuffer();
  const result = await preprocessCatalogVisual(source);
  assert.equal(result.analysis.status, "full_only");
  assert.equal(result.analysis.region_count, 0);
  assert.deepEqual(result.views.map((view) => view.role), ["full"]);
});

test("derived crop coordinates stay in the oriented source coordinate space", async () => {
  const result = await preprocessCatalogVisual(await syntheticRepeatedImage());
  for (const region of result.analysis.regions) {
    assert.ok(region.left >= 0);
    assert.ok(region.top >= 0);
    assert.ok(region.left + region.width <= result.source.oriented_width);
    assert.ok(region.top + region.height <= result.source.oriented_height);
  }
  for (const view of result.views.filter((candidate) => candidate.role !== "full")) {
    const region = view.transform.source_region;
    assert.ok(region);
    assert.ok(region.left + region.width <= result.source.oriented_width);
    assert.ok(region.top + region.height <= result.source.oriented_height);
    assert.equal(view.transform.coordinate_space, "auto_oriented_source_pixels");
  }
});

const fixturesAvailable = REVIEW_FIXTURES.every(([, file]) => existsSync(path.join(SNAPSHOT_ROOT, file)));
test("six frozen REVIEW images yield conservative repeated regions and useful zoom roles", {
  skip: fixturesAvailable ? false : "frozen local REVIEW fixtures are unavailable",
}, async () => {
  for (const [sku, file, expectedRegions] of REVIEW_FIXTURES) {
    const result = await preprocessCatalogVisual(await readFile(path.join(SNAPSHOT_ROOT, file)));
    assert.equal(result.analysis.status, "confirmed_repetition", sku);
    assert.equal(result.analysis.region_count, expectedRegions, sku);
    assert.ok(result.analysis.dimension_cv <= 0.02, sku);
    assert.ok(result.analysis.mean_histogram_distance <= 0.03, sku);
    assert.equal(result.views[0].role, "full", sku);
    assert.ok(result.views.some((view) => view.role === "tile_front"), sku);
    assert.ok(result.views.some((view) => view.role === "bottom_label"), sku);
    assert.ok(result.views.some((view) => view.role === "top_left_badge"), sku);
  }
});

test("invalid bytes are rejected without fallback fabrication", async () => {
  await assert.rejects(() => preprocessCatalogVisual(Buffer.from("not an image")));
});

