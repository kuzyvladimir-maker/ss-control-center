// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-product-gallery.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertHttpsUrl,
  productGalleryConfirmationToken,
  productGalleryHighResolutionUrl,
  productGalleryObjectKey,
  productGallerySemanticExclusion,
  selectBalancedGallery,
  type GalleryComponentCandidates,
  type ValidatedGalleryCandidate,
} from "../repair/uncrustables-product-gallery";

function digest(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function candidate(
  componentIndex: number,
  label: string,
  ordinal: number,
  asset: number,
  sourceKind: ValidatedGalleryCandidate["source_kind"] = "donor-gallery",
): ValidatedGalleryCandidate {
  return {
    component_index: componentIndex,
    component_key: `${componentIndex}:${label}`,
    flavor: label,
    donor_id: `donor-${label}`,
    donor_title: `Uncrustables ${label}`,
    source_kind: sourceKind,
    source_ordinal: ordinal,
    source_url: `https://images.example.test/${label}-${ordinal}-${asset}.jpg`,
    lineage: [
      {
        retailer: "walmart",
        retailer_product_id: `item-${label}`,
        product_url: `https://www.walmart.com/ip/${label}`,
        source_api: "test",
        fetched_at: "2026-07-17T00:00:00.000Z",
        first_party: true,
        via: "direct",
      },
    ],
    source_sha256: digest(asset + 1000),
    source_bytes: 100_000,
    asset_sha256: digest(asset),
    asset_bytes: 90_000,
    width: 2000,
    height: 2000,
    source_format: "jpeg",
    asset_format: "jpeg",
  };
}

function group(
  componentIndex: number,
  label: string,
  candidates: ValidatedGalleryCandidate[],
): GalleryComponentCandidates {
  return {
    component_index: componentIndex,
    component_key: `${componentIndex}:${label}`,
    flavor: label,
    candidates,
  };
}

test("balanced selector distributes six slots round-robin across components", () => {
  const selected = selectBalancedGallery([
    group(0, "A", [candidate(0, "A", 0, 1), candidate(0, "A", 1, 4)]),
    group(1, "B", [candidate(1, "B", 0, 2), candidate(1, "B", 1, 5)]),
    group(2, "C", [candidate(2, "C", 0, 3), candidate(2, "C", 1, 6)]),
  ]);
  assert.deepEqual(
    selected.map((item) => `${item.flavor}${item.source_ordinal}`),
    ["A0", "B0", "C0", "A1", "B1", "C1"],
  );
});

test("selection is stable when groups and candidates arrive in a different order", () => {
  const canonical = [
    group(0, "A", [candidate(0, "A", 0, 1), candidate(0, "A", 1, 3)]),
    group(1, "B", [candidate(1, "B", 0, 2), candidate(1, "B", 1, 4)]),
  ];
  const shuffled = [
    group(1, "B", [candidate(1, "B", 1, 4), candidate(1, "B", 0, 2)]),
    group(0, "A", [candidate(0, "A", 1, 3), candidate(0, "A", 0, 1)]),
  ];
  const first = selectBalancedGallery(canonical).map((item) => item.asset_sha256);
  const second = selectBalancedGallery(shuffled).map((item) => item.asset_sha256);
  assert.deepEqual(second, first);
});

test("duplicate CDN aliases are deduplicated by normalized asset SHA", () => {
  const duplicate = candidate(1, "B", 0, 1);
  const selected = selectBalancedGallery([
    group(0, "A", [candidate(0, "A", 0, 1), candidate(0, "A", 1, 3)]),
    group(1, "B", [duplicate, candidate(1, "B", 1, 2), candidate(1, "B", 2, 4)]),
  ]);
  assert.equal(new Set(selected.map((item) => item.asset_sha256)).size, selected.length);
  assert.ok(selected.some((item) => item.flavor === "B" && item.asset_sha256 === digest(2)));
});

test("selector accepts four unique verified images when six do not exist", () => {
  const selected = selectBalancedGallery([
    group(0, "A", [candidate(0, "A", 0, 1), candidate(0, "A", 1, 3)]),
    group(1, "B", [candidate(1, "B", 0, 2), candidate(1, "B", 1, 4)]),
  ]);
  assert.equal(selected.length, 4);
});

test("selector fails closed below four unique images", () => {
  assert.throws(
    () =>
      selectBalancedGallery([
        group(0, "A", [candidate(0, "A", 0, 1)]),
        group(1, "B", [candidate(1, "B", 0, 2)]),
      ]),
    /4-6 required/,
  );
});

test("selector fails when a recipe component has no unique representation", () => {
  assert.throws(
    () =>
      selectBalancedGallery([
        group(0, "A", [candidate(0, "A", 0, 1), candidate(0, "A", 1, 2)]),
        group(1, "B", [candidate(1, "B", 0, 1)]),
      ]),
    /no unique image.*1:B/i,
  );
});

test("R2 keys are versioned and content-addressed", () => {
  const hash = "ab".repeat(32);
  assert.equal(
    productGalleryObjectKey(hash),
    `uncrustables-product-gallery/v1/ab/${hash}.jpg`,
  );
  assert.throws(() => productGalleryObjectKey("not-a-sha"), /64 hexadecimal/);
});

test("apply confirmation token is bound to the reviewed audit SHA", () => {
  const hash = "0123456789abcdef".repeat(4);
  assert.equal(
    productGalleryConfirmationToken(hash),
    "UPLOAD-UNCRUSTABLES-GALLERY-0123456789ABCDEF",
  );
  assert.notEqual(
    productGalleryConfirmationToken(`f${hash.slice(1)}`),
    productGalleryConfirmationToken(hash),
  );
});

test("only credential-free absolute HTTPS source URLs pass", () => {
  assert.doesNotThrow(() => assertHttpsUrl("image", "https://images.example.test/a.jpg"));
  assert.throws(() => assertHttpsUrl("image", "http://images.example.test/a.jpg"), /HTTPS/);
  assert.throws(() => assertHttpsUrl("image", "https://user:pass@example.test/a.jpg"), /credentials/);
  assert.throws(() => assertHttpsUrl("image", "not-a-url"), /valid URL/);
});

test("retailer CDN URLs are upgraded deterministically without changing asset identity", () => {
  assert.equal(
    productGalleryHighResolutionUrl(
      "https://target.scene7.com/is/image/Target/GUEST_abc?wid=400&hei=400",
    ),
    "https://target.scene7.com/is/image/Target/GUEST_abc?wid=2000&hei=2000&fmt=pjpeg&qlt=90",
  );
  assert.equal(
    productGalleryHighResolutionUrl(
      "https://i5.walmartimages.com/asr/example.jpeg?odnHeight=180&odnWidth=180",
    ),
    "https://i5.walmartimages.com/asr/example.jpeg",
  );
});

test("curated cross-flavor creative is rejected regardless of Scene7 rendition query", () => {
  const exclusion = productGallerySemanticExclusion(
    "https://target.scene7.com/is/image/Target/GUEST_38368b3b-2ce4-4286-b717-59a117ed5d64?wid=400&hei=400",
  );
  assert.equal(exclusion?.category, "cross-flavor-promotional");
  assert.equal(exclusion?.matched_by, "retailer_asset_id");
  assert.equal(
    productGallerySemanticExclusion(
      "https://target.scene7.com/is/image/Target/GUEST_7e4fd4de-1981-4033-b02f-07972ea3b49c?fmt=webp",
    )?.category,
    "cross-flavor-promotional",
  );
});

test("retailer ad overlay is rejected but an Only-at-Target package asset is not broadly blocked", () => {
  const overlay = productGallerySemanticExclusion(
    "https://target.scene7.com/is/image/Target/GUEST_1f95d6fa-4d80-4748-82d8-af4027023b89?wid=2000",
  );
  assert.equal(overlay?.category, "retailer-ui-or-price-overlay");
  assert.equal(
    productGallerySemanticExclusion(
      "https://target.scene7.com/is/image/Target/GUEST_physical-package-with-target-badge",
    ),
    null,
  );
});

test("curated pixel SHA rejects an exact CDN alias", () => {
  const exclusion = productGallerySemanticExclusion(
    "https://images.example.test/cdn-alias.jpg",
    "dba55cfcebb6977432cb1e9eaede451a3f6558f138f307645d2fe8e51e020c0b",
  );
  assert.equal(exclusion?.category, "cross-flavor-promotional");
  assert.equal(exclusion?.matched_by, "normalized_asset_sha256");
});
