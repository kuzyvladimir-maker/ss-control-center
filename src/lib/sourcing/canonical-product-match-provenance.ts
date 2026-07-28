/**
 * Immutable release identity for the pure canonical product matcher.
 *
 * Keep this descriptor dependency-free and outside the matcher source itself:
 * the recorded digest is over the exact final bytes of
 * `canonical-product-match.ts`, so the digest must not be self-referential.
 */

export const CANONICAL_PRODUCT_MATCHER_VERSION = "canonical-product-match/1.2.1" as const;

export const CANONICAL_PRODUCT_MATCHER_PROVENANCE_SCHEMA_VERSION =
  "canonical-product-match-provenance/1.0.0" as const;

export const CANONICAL_PRODUCT_MATCHER_SOURCE_PATH =
  "src/lib/sourcing/canonical-product-match.ts" as const;

export const CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256 =
  "2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb" as const;

export const CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST = Object.freeze({
  schemaVersion: CANONICAL_PRODUCT_MATCHER_PROVENANCE_SCHEMA_VERSION,
  matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
  sourcePath: CANONICAL_PRODUCT_MATCHER_SOURCE_PATH,
  sourceSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
});

/** SHA-256 of the recursively key-sorted, compact canonical JSON release manifest. */
export const CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256 =
  "027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2" as const;

/** Backwards-compatible descriptor name for callers that predate the release manifest. */
export const CANONICAL_PRODUCT_MATCHER_PROVENANCE =
  CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST;
