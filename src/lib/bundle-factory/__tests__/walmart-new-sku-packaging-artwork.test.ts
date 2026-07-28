import assert from "node:assert/strict";
import test from "node:test";

import {
  selectCurrentWalmartPackagingArtwork,
  WALMART_PACKAGING_ARTWORK_REVIEW_SCHEMA,
  type WalmartPackagingArtworkReview,
} from "../walmart-new-sku-packaging-artwork";

const canonicalVariantId = `cpv1:${"a".repeat(64)}`;
const currentRevisionId = `par1:${"b".repeat(64)}`;
const oldRevisionId = `par1:${"c".repeat(64)}`;
const main = "https://images.example/current-main.jpg";
const lifestyle = "https://images.example/current-lifestyle.jpg";
const oldPackage = "https://images.example/old-package.jpg";
const otherProduct = "https://images.example/other-product.jpg";

function review(): WalmartPackagingArtworkReview {
  return {
    schema_version: WALMART_PACKAGING_ARTWORK_REVIEW_SCHEMA,
    canonical_variant_id: canonicalVariantId,
    approved_package_artwork_revision_id: currentRevisionId,
    reviewed_at: "2026-07-26T20:00:00.000Z",
    images: [
      {
        url: main,
        canonical_variant_id: canonicalVariantId,
        package_artwork_revision_id: currentRevisionId,
        disposition: "APPROVED_CURRENT",
        review_evidence_ref: "image-review:current-main",
      },
      {
        url: lifestyle,
        canonical_variant_id: canonicalVariantId,
        package_artwork_revision_id: currentRevisionId,
        disposition: "APPROVED_CURRENT",
        review_evidence_ref: "image-review:current-lifestyle",
      },
      {
        url: oldPackage,
        canonical_variant_id: canonicalVariantId,
        package_artwork_revision_id: oldRevisionId,
        disposition: "REJECTED_OLDER_PACKAGING",
        review_evidence_ref: "image-review:old-package",
      },
      {
        url: otherProduct,
        canonical_variant_id: canonicalVariantId,
        package_artwork_revision_id: currentRevisionId,
        disposition: "REJECTED_OTHER_PRODUCT",
        review_evidence_ref: "image-review:other-product",
      },
    ],
  };
}

test("keeps only exact current artwork and records exclusions", () => {
  const selected = selectCurrentWalmartPackagingArtwork({
    canonicalVariantId,
    mainImageUrl: main,
    discoveredImageUrls: [main, oldPackage, lifestyle, otherProduct],
    review: review(),
  });

  assert.deepEqual(selected.image_urls, [main, lifestyle]);
  assert.equal(selected.package_artwork_revision_id, currentRevisionId);
  assert.deepEqual(selected.excluded_images, [
    { url: oldPackage, disposition: "REJECTED_OLDER_PACKAGING" },
    { url: otherProduct, disposition: "REJECTED_OTHER_PRODUCT" },
  ]);
});

test("fails closed when any discovered image lacks review", () => {
  const inputReview = review();
  inputReview.images.pop();
  assert.throws(
    () => selectCurrentWalmartPackagingArtwork({
      canonicalVariantId,
      mainImageUrl: main,
      discoveredImageUrls: [main, oldPackage, lifestyle, otherProduct],
      review: inputReview,
    }),
    /every discovered image requires packaging-artwork review/,
  );
});

test("fails closed when approved images mix packaging generations", () => {
  const inputReview = review();
  const lifestyleReview = inputReview.images.find(
    (image) => image.url === lifestyle,
  )!;
  lifestyleReview.package_artwork_revision_id = oldRevisionId;
  assert.throws(
    () => selectCurrentWalmartPackagingArtwork({
      canonicalVariantId,
      mainImageUrl: main,
      discoveredImageUrls: [main, oldPackage, lifestyle, otherProduct],
      review: inputReview,
    }),
    /mixes packaging-artwork revisions/,
  );
});

test("fails closed when the donor main image is not current", () => {
  const inputReview = review();
  inputReview.images.find((image) => image.url === main)!.disposition =
    "REJECTED_OLDER_PACKAGING";
  assert.throws(
    () => selectCurrentWalmartPackagingArtwork({
      canonicalVariantId,
      mainImageUrl: main,
      discoveredImageUrls: [main, oldPackage, lifestyle, otherProduct],
      review: inputReview,
    }),
    /mainImageUrl is not approved/,
  );
});
