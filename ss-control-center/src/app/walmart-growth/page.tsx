import { WalmartGrowthTabs } from "@/components/walmart-growth/WalmartGrowthTabs";
import { loadListingIntegrityShadowData } from "@/lib/walmart/listing-integrity-shadow.server";

export default async function WalmartGrowthPage() {
  // Local audit artifacts are intentionally excluded from serverless deploys.
  // Missing evidence must leave Integrity unavailable, not break every deploy.
  const integrityData = await loadListingIntegrityShadowData().catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return <WalmartGrowthTabs integrityData={integrityData} />;
}
