/**
 * Transitional contract while SkuComponent still has one legacy donorProductId.
 * That field is consumed as CONTENT truth, therefore only an exact identity
 * verdict may populate it. Estimate evidence remains pricing provenance but
 * must not leak photos, UPC, ingredients or nutrition into a listing.
 */
export function contentDonorIdForCostMethod(
  costMethod: string | null | undefined,
  priceEvidenceDonorProductId: string | null | undefined,
): string | null {
  return costMethod === "exact" && priceEvidenceDonorProductId
    ? priceEvidenceDonorProductId
    : null;
}
