import { createHash } from "node:crypto";

import {
  matchCanonicalProduct,
  type CanonicalProductIdentity,
  type SizeDimension,
} from "./canonical-product-match";

export const CANONICAL_PRODUCT_VARIANT_KEY_VERSION =
  "canonical-product-variant-key/1.0.0" as const;
export const CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION =
  "canonical-product-variant-identity/1.0.0" as const;

export type CanonicalProductVariantKeyErrorCode =
  | "VARIANT_BRAND_REQUIRED"
  | "VARIANT_DISCRIMINATOR_REQUIRED"
  | "VARIANT_SIZE_REQUIRED"
  | "VARIANT_OUTER_PACK_INVALID"
  | "VARIANT_IDENTITY_NOT_EXACT";

export class CanonicalProductVariantKeyError extends Error {
  readonly code: CanonicalProductVariantKeyErrorCode;
  readonly reasonCodes: readonly string[];

  constructor(
    code: CanonicalProductVariantKeyErrorCode,
    reasonCodes: readonly string[] = [],
  ) {
    super(`${code}${reasonCodes.length ? `: ${reasonCodes.join(",")}` : ""}`);
    this.name = "CanonicalProductVariantKeyError";
    this.code = code;
    this.reasonCodes = reasonCodes;
  }
}

export interface NormalizedCanonicalProductVariantIdentity {
  schemaVersion: typeof CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION;
  brand: string;
  productLine: string | null;
  flavor: string | null;
  modifiers: string[];
  form: string | null;
  size: {
    dimension: SizeDimension;
    baseAmount: number;
    baseUnit: "g" | "ml" | "count";
  };
  outerPackCount: number;
}

export interface CanonicalProductVariantKey {
  canonicalVariantId: string;
  variantKey: string;
  identityHash: string;
  keyVersion: typeof CANONICAL_PRODUCT_VARIANT_KEY_VERSION;
  identityJson: string;
  normalized: NormalizedCanonicalProductVariantIdentity;
  db: {
    id: string;
    variantKey: string;
    identityHash: string;
    keyVersion: typeof CANONICAL_PRODUCT_VARIANT_KEY_VERSION;
    normalizedBrand: string;
    normalizedProductLine: string | null;
    normalizedFlavor: string | null;
    normalizedModifiersJson: string;
    normalizedForm: string | null;
    sizeDimension: SizeDimension;
    sizeBaseAmount: number;
    sizeBaseUnit: "g" | "ml" | "count";
    outerPackCount: number;
    identityJson: string;
  };
}

function tokenKey(tokens: readonly string[]): string | null {
  return tokens.length ? tokens.join(" ") : null;
}

function stableBaseAmount(value: number): number {
  // Parsing constants are deterministic, but a precision clamp keeps the JSON
  // fingerprint independent of incidental floating-point tail digits.
  return Number(value.toPrecision(15));
}

/**
 * Normalize one explicitly identified sellable package into the identity that
 * owns cross-retailer truth. Titles are deliberately excluded: a retailer's
 * copy cannot change the canonical key. Missing outer-pack evidence means one
 * ordinary package; callers must pass an explicit count for a real multipack.
 */
export function normalizeCanonicalProductVariantIdentity(
  input: CanonicalProductIdentity,
): NormalizedCanonicalProductVariantIdentity {
  const outerPackCount = input.outerPackCount ?? 1;
  if (
    !Number.isInteger(outerPackCount)
    || Number(outerPackCount) < 1
    || Number(outerPackCount) > 999
  ) {
    throw new CanonicalProductVariantKeyError("VARIANT_OUTER_PACK_INVALID");
  }

  const explicitIdentity: CanonicalProductIdentity = {
    brand: input.brand,
    productLine: input.productLine,
    flavor: input.flavor,
    modifiers: input.modifiers,
    form: input.form,
    size: input.size,
    outerPackCount: Number(outerPackCount),
    // Retailer titles are evidence for aliasing, never canonical key material.
    title: null,
  };
  const selfMatch = matchCanonicalProduct(explicitIdentity, explicitIdentity);
  const normalized = selfMatch.normalized.target;

  if (!normalized.brandTokens.length) {
    throw new CanonicalProductVariantKeyError(
      "VARIANT_BRAND_REQUIRED",
      selfMatch.reasonCodes,
    );
  }
  if (
    !normalized.productLineTokens.length
    && !normalized.flavorTokens.length
    && !normalized.formTokens.length
  ) {
    throw new CanonicalProductVariantKeyError(
      "VARIANT_DISCRIMINATOR_REQUIRED",
      selfMatch.reasonCodes,
    );
  }
  if (!normalized.size) {
    throw new CanonicalProductVariantKeyError(
      "VARIANT_SIZE_REQUIRED",
      selfMatch.reasonCodes,
    );
  }
  if (selfMatch.verdict !== "EXACT_IDENTITY") {
    throw new CanonicalProductVariantKeyError(
      "VARIANT_IDENTITY_NOT_EXACT",
      selfMatch.reasonCodes,
    );
  }

  return {
    schemaVersion: CANONICAL_PRODUCT_VARIANT_IDENTITY_VERSION,
    brand: tokenKey(normalized.brandTokens)!,
    productLine: tokenKey(normalized.productLineTokens),
    flavor: tokenKey(normalized.flavorTokens),
    modifiers: [...normalized.modifierKeys].sort(),
    form: tokenKey(normalized.formTokens),
    size: {
      dimension: normalized.size.dimension,
      baseAmount: stableBaseAmount(normalized.size.baseAmount),
      baseUnit: normalized.size.baseUnit,
    },
    outerPackCount: Number(outerPackCount),
  };
}

/** Build the deterministic ID/key and the exact columns used by SQL upserts. */
export function buildCanonicalProductVariantKey(
  input: CanonicalProductIdentity,
): CanonicalProductVariantKey {
  const normalized = normalizeCanonicalProductVariantIdentity(input);
  // Property insertion order is fixed by the object above; arrays are sorted.
  const identityJson = JSON.stringify(normalized);
  const identityHash = createHash("sha256").update(identityJson).digest("hex");
  const variantKey = `cpv1:${identityHash}`;

  return {
    canonicalVariantId: variantKey,
    variantKey,
    identityHash,
    keyVersion: CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
    identityJson,
    normalized,
    db: {
      id: variantKey,
      variantKey,
      identityHash,
      keyVersion: CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
      normalizedBrand: normalized.brand,
      normalizedProductLine: normalized.productLine,
      normalizedFlavor: normalized.flavor,
      normalizedModifiersJson: JSON.stringify(normalized.modifiers),
      normalizedForm: normalized.form,
      sizeDimension: normalized.size.dimension,
      sizeBaseAmount: normalized.size.baseAmount,
      sizeBaseUnit: normalized.size.baseUnit,
      outerPackCount: normalized.outerPackCount,
      identityJson,
    },
  };
}
