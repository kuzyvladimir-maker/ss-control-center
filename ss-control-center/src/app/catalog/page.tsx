import { ProductTruthCatalog } from
  "@/components/catalog/ProductTruthCatalog";
import {
  isProductTruthCatalogView,
  type ProductTruthCatalogView,
} from "@/components/catalog/CatalogTabs";

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.view) ? params.view[0] : params.view;
  const initialView: ProductTruthCatalogView =
    isProductTruthCatalogView(requested) ? requested : "overview";
  return <ProductTruthCatalog initialView={initialView} />;
}
