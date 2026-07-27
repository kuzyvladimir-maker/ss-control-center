export const PRODUCT_TRUTH_LISTING_KEY_VERSION =
  "product-truth-listing-key/1.0.0" as const;
export const SKU_COST_LISTING_SCOPE_LINK_VERSION =
  "sku-cost-listing-scope-link/1.0.0" as const;

export interface ProductTruthListingScopeIdentity {
  channel: string;
  storeIndex: number;
  sku: string;
  listingKey: string;
  keyVersion: typeof PRODUCT_TRUTH_LISTING_KEY_VERSION;
}

export class ProductTruthListingScopeInputError extends Error {
  readonly code = "PRODUCT_TRUTH_LISTING_SCOPE_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProductTruthListingScopeInputError";
  }
}

/**
 * Canonical listing identity. `sku` is deliberately preserved byte-for-byte:
 * case-folding, trimming, or cross-account dedup would change the marketplace
 * listing grain and is therefore rejected rather than normalized.
 */
export function buildProductTruthListingScope(input: {
  channel: string;
  storeIndex: number;
  sku: string;
}): ProductTruthListingScopeIdentity {
  const channel = input.channel.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(channel)) {
    throw new ProductTruthListingScopeInputError(
      "channel must be a non-empty canonical channel token",
    );
  }
  if (!Number.isSafeInteger(input.storeIndex) || input.storeIndex <= 0) {
    throw new ProductTruthListingScopeInputError(
      "storeIndex must be a positive safe integer",
    );
  }
  if (!input.sku || input.sku !== input.sku.trim()) {
    throw new ProductTruthListingScopeInputError(
      "sku must be a non-empty exact raw marketplace SKU without surrounding whitespace",
    );
  }
  return {
    channel,
    storeIndex: input.storeIndex,
    sku: input.sku,
    listingKey: `${channel}:${input.storeIndex}:${input.sku}`,
    keyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
  };
}
