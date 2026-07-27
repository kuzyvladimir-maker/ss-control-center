/**
 * Pure, deterministic primitives for the verified Uncrustables product gallery.
 *
 * The I/O orchestrator lives in scripts/build-uncrustables-product-gallery.ts.
 * Keeping selection and safety-token logic here makes the production decision
 * reproducible without a database, network, Amazon, or R2 connection.
 */

import { createHash } from "node:crypto";

export const PRODUCT_GALLERY_AUDIT_SCHEMA =
  "uncrustables-product-gallery-source-audit/v1.0" as const;
export const PRODUCT_GALLERY_MANIFEST_SCHEMA =
  "uncrustables-product-gallery-manifest/v1.0" as const;
export const PRODUCT_GALLERY_TARGET = 164;
export const PRODUCT_GALLERY_MIN_IMAGES = 4;
export const PRODUCT_GALLERY_MAX_IMAGES = 6;
export const PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION =
  "uncrustables-gallery-semantic-exclusions/v1" as const;

export type ProductGallerySemanticExclusionCategory =
  | "cross-flavor-promotional"
  | "retailer-ui-or-price-overlay";

/**
 * Curated retailer assets rejected during visual review.
 *
 * Both the stable retailer asset id and the normalized pixel SHA are stored:
 * the id blocks a changed rendition of the same creative, while the SHA blocks
 * an exact-pixel CDN alias. This list deliberately does not reject an
 * "Only at Target" badge printed on a physical package.
 */
export const PRODUCT_GALLERY_CURATED_ASSET_EXCLUSIONS = [
  {
    retailer: "target",
    retailer_asset_id: "GUEST_38368b3b-2ce4-4286-b717-59a117ed5d64",
    normalized_asset_sha256:
      "dba55cfcebb6977432cb1e9eaede451a3f6558f138f307645d2fe8e51e020c0b",
    category: "cross-flavor-promotional",
    reason:
      "Cross-flavor 'A flavor for every week day' creative shows products outside a SKU's recipe.",
  },
  {
    retailer: "target",
    retailer_asset_id: "GUEST_7e4fd4de-1981-4033-b02f-07972ea3b49c",
    normalized_asset_sha256:
      "6b3749641d6a1f6ce62a8a9e201384039a368547e58c32678d7c7ff70f33feb5",
    category: "cross-flavor-promotional",
    reason:
      "Blackberry-edition variant of the cross-flavor 'A flavor for every week day' creative.",
  },
  {
    retailer: "target",
    retailer_asset_id: "GUEST_1f95d6fa-4d80-4748-82d8-af4027023b89",
    normalized_asset_sha256:
      "9ccb6d819b98714e2fbac8832558101c6472303b64bff70092ad434be579aa5a",
    category: "retailer-ui-or-price-overlay",
    reason:
      "Retailer-exclusive banner is a separate advertising overlay; exact product alternatives are available.",
  },
] as const satisfies ReadonlyArray<{
  retailer: string;
  retailer_asset_id: string;
  normalized_asset_sha256: string;
  category: ProductGallerySemanticExclusionCategory;
  reason: string;
}>;

export interface ProductGallerySemanticExclusion {
  policy_version: typeof PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION;
  retailer: string;
  retailer_asset_id: string;
  normalized_asset_sha256: string;
  category: ProductGallerySemanticExclusionCategory;
  reason: string;
  matched_by: "retailer_asset_id" | "normalized_asset_sha256";
}

export type GallerySourceKind =
  | "preflight-reviewed-front"
  | "donor-main"
  | "donor-gallery";

export interface GalleryLineage {
  retailer: string;
  retailer_product_id: string;
  product_url: string;
  source_api: string | null;
  fetched_at: string | null;
  first_party: boolean;
  via: string;
}

export interface GalleryCandidate {
  component_index: number;
  component_key: string;
  flavor: string;
  donor_id: string;
  donor_title: string;
  source_kind: GallerySourceKind;
  source_ordinal: number;
  source_url: string;
  lineage: GalleryLineage[];
}

export interface ValidatedGalleryCandidate extends GalleryCandidate {
  source_sha256: string;
  source_bytes: number;
  asset_sha256: string;
  asset_bytes: number;
  width: number;
  height: number;
  source_format: string;
  asset_format: "jpeg";
}

export interface GalleryComponentCandidates {
  component_index: number;
  component_key: string;
  flavor: string;
  candidates: ValidatedGalleryCandidate[];
}

const SOURCE_KIND_RANK: Record<GallerySourceKind, number> = {
  "preflight-reviewed-front": 0,
  "donor-main": 1,
  "donor-gallery": 2,
};

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function assertHttpsUrl(label: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain URL credentials.`);
  }
}

/** Deterministically request the original-size retailer rendition. */
export function productGalleryHighResolutionUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.hostname.includes("walmartimages.com")) parsed.search = "";
  // Target Scene7's commandless URL is a 400x400 default rendition. The GUEST
  // asset id remains the same; these fixed commands expose its 2000px source.
  if (
    parsed.hostname === "target.scene7.com" &&
    parsed.pathname.startsWith("/is/image/Target/")
  ) {
    parsed.search = "";
    parsed.searchParams.set("wid", "2000");
    parsed.searchParams.set("hei", "2000");
    parsed.searchParams.set("fmt", "pjpeg");
    parsed.searchParams.set("qlt", "90");
  }
  return parsed.toString();
}

/** Fail closed on creatives rejected during asset-level visual review. */
export function productGallerySemanticExclusion(
  sourceUrl: string,
  normalizedAssetSha256?: string,
): ProductGallerySemanticExclusion | null {
  let parsed: URL | null = null;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    // URL validation is a separate invariant. A pixel SHA match must still be
    // able to reject an alias even if the supplied locator is malformed.
  }
  for (const exclusion of PRODUCT_GALLERY_CURATED_ASSET_EXCLUSIONS) {
    const idMatch =
      exclusion.retailer === "target" &&
      parsed?.hostname.toLowerCase() === "target.scene7.com" &&
      parsed.pathname === `/is/image/Target/${exclusion.retailer_asset_id}`;
    const shaMatch =
      typeof normalizedAssetSha256 === "string" &&
      normalizedAssetSha256.toLowerCase() === exclusion.normalized_asset_sha256;
    if (idMatch || shaMatch) {
      return {
        policy_version: PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION,
        ...exclusion,
        matched_by: idMatch ? "retailer_asset_id" : "normalized_asset_sha256",
      };
    }
  }
  return null;
}

function compareCandidate(
  left: ValidatedGalleryCandidate,
  right: ValidatedGalleryCandidate,
): number {
  return (
    SOURCE_KIND_RANK[left.source_kind] - SOURCE_KIND_RANK[right.source_kind] ||
    left.source_ordinal - right.source_ordinal ||
    // Prefer the larger decoded image when two URLs have the same source role.
    right.width * right.height - left.width * left.height ||
    left.asset_sha256.localeCompare(right.asset_sha256) ||
    left.source_url.localeCompare(right.source_url)
  );
}

/**
 * Select at most six unique image contents in recipe-component round-robin
 * order. Every component must contribute at least one image. Subsequent passes
 * distribute slots evenly (A,B,C,A,B,C), preventing the first flavor in a mix
 * from monopolising the gallery.
 *
 * Uniqueness is by normalized asset SHA, not URL: retailer CDNs frequently
 * expose the same pixels through multiple aliases.
 */
export function selectBalancedGallery(
  groups: GalleryComponentCandidates[],
  options: { min?: number; max?: number } = {},
): ValidatedGalleryCandidate[] {
  const min = options.min ?? PRODUCT_GALLERY_MIN_IMAGES;
  const max = options.max ?? PRODUCT_GALLERY_MAX_IMAGES;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error("Invalid gallery min/max bounds.");
  }
  if (groups.length === 0) throw new Error("Recipe has no gallery components.");
  if (groups.length > max) {
    throw new Error(
      `Recipe has ${groups.length} components but the gallery holds at most ${max}.`,
    );
  }

  const seenComponents = new Set<string>();
  const ordered = [...groups]
    .sort(
      (left, right) =>
        left.component_index - right.component_index ||
        left.component_key.localeCompare(right.component_key),
    )
    .map((group) => {
      if (seenComponents.has(group.component_key)) {
        throw new Error(`Duplicate component key: ${group.component_key}`);
      }
      seenComponents.add(group.component_key);
      const byAsset = new Map<string, ValidatedGalleryCandidate>();
      for (const candidate of [...group.candidates].sort(compareCandidate)) {
        if (!isSha256(candidate.asset_sha256)) {
          throw new Error(`Invalid asset SHA for ${candidate.source_url}.`);
        }
        const prior = byAsset.get(candidate.asset_sha256);
        if (!prior || compareCandidate(candidate, prior) < 0) {
          byAsset.set(candidate.asset_sha256, candidate);
        }
      }
      const candidates = [...byAsset.values()].sort(compareCandidate);
      if (candidates.length === 0) {
        throw new Error(`Component ${group.component_key} has no validated images.`);
      }
      return { ...group, candidates };
    });

  const cursors = ordered.map(() => 0);
  const selected: ValidatedGalleryCandidate[] = [];
  const selectedAssets = new Set<string>();
  const representedComponents = new Set<string>();

  while (selected.length < max) {
    let progressed = false;
    for (let groupIndex = 0; groupIndex < ordered.length; groupIndex++) {
      if (selected.length >= max) break;
      const group = ordered[groupIndex];
      while (cursors[groupIndex] < group.candidates.length) {
        const candidate = group.candidates[cursors[groupIndex]++];
        if (selectedAssets.has(candidate.asset_sha256)) continue;
        selected.push(candidate);
        selectedAssets.add(candidate.asset_sha256);
        representedComponents.add(group.component_key);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }

  const missingComponents = ordered
    .map((group) => group.component_key)
    .filter((key) => !representedComponents.has(key));
  if (missingComponents.length > 0) {
    throw new Error(
      `Gallery has no unique image for recipe component(s): ${missingComponents.join(", ")}.`,
    );
  }
  if (selected.length < min) {
    throw new Error(
      `Gallery has ${selected.length} unique verified images; ${min}-${max} required.`,
    );
  }
  return selected;
}

/** Content-addressed, versioned, extension-locked R2 object key. */
export function productGalleryObjectKey(assetSha256: string): string {
  if (!isSha256(assetSha256)) throw new Error("Asset SHA must be 64 hexadecimal characters.");
  const digest = assetSha256.toLowerCase();
  return `uncrustables-product-gallery/v1/${digest.slice(0, 2)}/${digest}.jpg`;
}

/** Exact confirmation is bound to the bytes the operator visually reviewed. */
export function productGalleryConfirmationToken(auditSha256: string): string {
  if (!isSha256(auditSha256)) throw new Error("Audit SHA must be 64 hexadecimal characters.");
  return `UPLOAD-UNCRUSTABLES-GALLERY-${auditSha256.slice(0, 16).toUpperCase()}`;
}
