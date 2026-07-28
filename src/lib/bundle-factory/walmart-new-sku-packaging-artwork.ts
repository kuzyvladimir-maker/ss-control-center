export const WALMART_PACKAGING_ARTWORK_REVIEW_SCHEMA =
  "walmart-packaging-artwork-review/1.0.0" as const;

export type WalmartPackagingArtworkDisposition =
  | "APPROVED_CURRENT"
  | "REJECTED_OLDER_PACKAGING"
  | "REJECTED_OTHER_PRODUCT"
  | "REJECTED_IDENTITY_UNPROVEN";

export interface WalmartReviewedPackagingImage {
  url: string;
  canonical_variant_id: string;
  package_artwork_revision_id: string;
  disposition: WalmartPackagingArtworkDisposition;
  review_evidence_ref: string;
}

export interface WalmartPackagingArtworkReview {
  schema_version: typeof WALMART_PACKAGING_ARTWORK_REVIEW_SCHEMA;
  canonical_variant_id: string;
  approved_package_artwork_revision_id: string;
  reviewed_at: string;
  images: WalmartReviewedPackagingImage[];
}

export interface WalmartPackagingArtworkSelection {
  main_image_url: string;
  image_urls: string[];
  package_artwork_revision_id: string;
  review_evidence_refs: string[];
  excluded_images: Array<{
    url: string;
    disposition: Exclude<
      WalmartPackagingArtworkDisposition,
      "APPROVED_CURRENT"
    >;
  }>;
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function exactHttpsUrl(value: string, label: string): string {
  const url = new URL(requiredText(value, label));
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

function canonicalRevisionId(value: string, label: string): string {
  const revisionId = requiredText(value, label);
  if (!/^par1:[a-f0-9]{64}$/.test(revisionId)) {
    throw new Error(`${label} must be a par1 packaging-artwork revision ID`);
  }
  return revisionId;
}

/**
 * Fail-closed packaging-art selector for Walmart new-SKU galleries.
 *
 * Every discovered donor image must be explicitly reviewed. Only images marked
 * APPROVED_CURRENT for the exact canonical variant and the one approved
 * packaging revision are returned. Older packaging and other-product promotion
 * tiles remain in the audit result but cannot enter the listing gallery.
 */
export function selectCurrentWalmartPackagingArtwork(input: {
  canonicalVariantId: string;
  mainImageUrl: string;
  discoveredImageUrls: string[];
  review: WalmartPackagingArtworkReview;
}): WalmartPackagingArtworkSelection {
  const canonicalVariantId = requiredText(
    input.canonicalVariantId,
    "canonicalVariantId",
  );
  if (!/^cpv1:[a-f0-9]{64}$/.test(canonicalVariantId)) {
    throw new Error("canonicalVariantId must be a canonical cpv1 key");
  }
  if (input.review.schema_version !== WALMART_PACKAGING_ARTWORK_REVIEW_SCHEMA) {
    throw new Error("packaging-artwork review schema is not current");
  }
  if (input.review.canonical_variant_id !== canonicalVariantId) {
    throw new Error("packaging-artwork review targets another canonical variant");
  }
  const approvedRevisionId = canonicalRevisionId(
    input.review.approved_package_artwork_revision_id,
    "approved_package_artwork_revision_id",
  );
  const reviewedAtMs = Date.parse(input.review.reviewed_at);
  if (
    !Number.isFinite(reviewedAtMs) ||
    new Date(reviewedAtMs).toISOString() !== input.review.reviewed_at
  ) {
    throw new Error("packaging-artwork reviewed_at must be canonical ISO UTC");
  }

  const mainImageUrl = exactHttpsUrl(input.mainImageUrl, "mainImageUrl");
  const discovered = [...new Set([
    mainImageUrl,
    ...input.discoveredImageUrls.map((url, index) =>
      exactHttpsUrl(url, `discoveredImageUrls[${index}]`)
    ),
  ])];
  const reviews = new Map<string, WalmartReviewedPackagingImage>();
  for (const [index, image] of input.review.images.entries()) {
    const url = exactHttpsUrl(image.url, `review.images[${index}].url`);
    if (reviews.has(url)) {
      throw new Error(`duplicate packaging-artwork review for ${url}`);
    }
    canonicalRevisionId(
      image.package_artwork_revision_id,
      `review.images[${index}].package_artwork_revision_id`,
    );
    requiredText(
      image.review_evidence_ref,
      `review.images[${index}].review_evidence_ref`,
    );
    reviews.set(url, { ...image, url });
  }

  const missingReviews = discovered.filter((url) => !reviews.has(url));
  if (missingReviews.length > 0) {
    throw new Error(
      `every discovered image requires packaging-artwork review: ${missingReviews.join(", ")}`,
    );
  }
  const unrelatedReviews = [...reviews.keys()].filter(
    (url) => !discovered.includes(url),
  );
  if (unrelatedReviews.length > 0) {
    throw new Error(
      `packaging-artwork review contains images outside the donor discovery: ${unrelatedReviews.join(", ")}`,
    );
  }

  const approved: WalmartReviewedPackagingImage[] = [];
  const excluded: WalmartPackagingArtworkSelection["excluded_images"] = [];
  for (const url of discovered) {
    const image = reviews.get(url)!;
    if (image.disposition === "APPROVED_CURRENT") {
      if (image.canonical_variant_id !== canonicalVariantId) {
        throw new Error(`approved image targets another canonical variant: ${url}`);
      }
      if (image.package_artwork_revision_id !== approvedRevisionId) {
        throw new Error(`approved gallery mixes packaging-artwork revisions: ${url}`);
      }
      approved.push(image);
      continue;
    }
    excluded.push({
      url,
      disposition: image.disposition,
    });
  }
  if (!approved.some((image) => image.url === mainImageUrl)) {
    throw new Error("mainImageUrl is not approved as current packaging artwork");
  }
  if (approved.length < 2) {
    throw new Error("at least two current exact-variant images are required");
  }

  return {
    main_image_url: mainImageUrl,
    image_urls: approved.map((image) => image.url),
    package_artwork_revision_id: approvedRevisionId,
    review_evidence_refs: [
      ...new Set(approved.map((image) => image.review_evidence_ref)),
    ].sort(),
    excluded_images: excluded,
  };
}
