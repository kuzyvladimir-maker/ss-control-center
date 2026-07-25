import { ProductTruthCatalog } from
  "@/components/catalog/ProductTruthCatalog";

/**
 * Backward-compatible page alias. The canonical module and all navigation live
 * under /catalog; this route no longer reads the legacy bare-SKU COGS endpoint.
 */
export default function CogsCatalogAliasPage() {
  return <ProductTruthCatalog initialView="offers" />;
}
