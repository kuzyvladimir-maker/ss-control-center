"use client";

import { PageHead } from "@/components/kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListingQualityDashboard } from "./ListingQualityDashboard";
import { BuyBoxPanel } from "./BuyBoxPanel";

export function WalmartGrowthTabs() {
  return (
    <div className="space-y-5">
      <PageHead
        title="Walmart Growth"
        subtitle="Grow Sales — Listing Quality + Buy Box, driven live off the Marketplace API"
      />
      <Tabs defaultValue="listing-quality" className="w-full">
        <TabsList>
          <TabsTrigger value="listing-quality">Listing Quality</TabsTrigger>
          <TabsTrigger value="buy-box">Buy Box</TabsTrigger>
        </TabsList>
        <TabsContent value="listing-quality" className="mt-4">
          <ListingQualityDashboard />
        </TabsContent>
        <TabsContent value="buy-box" className="mt-4">
          <BuyBoxPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
