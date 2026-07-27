import { ProductTruthCatalog } from
  "@/components/catalog/ProductTruthCatalog";

/**
 * Backward-compatible page alias. This route now renders immutable canonical
 * variants and exact observations, not mutable DonorProduct materializations.
 */
export default function ReferenceCatalogAliasPage() {
  return <ProductTruthCatalog initialView="products" />;
}
