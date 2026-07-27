import { WalmartGrowthTabs } from "@/components/walmart-growth/WalmartGrowthTabs";
import { loadListingIntegrityShadowData } from "@/lib/walmart/listing-integrity-shadow.server";

export default async function WalmartGrowthPage() {
  const integrityData = await loadListingIntegrityShadowData();
  return <WalmartGrowthTabs integrityData={integrityData} />;
}
