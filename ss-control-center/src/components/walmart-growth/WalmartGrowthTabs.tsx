"use client";

import { useState } from "react";
import { PageHead } from "@/components/kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionCenter } from "./ActionCenter";
import { ListingQualityDashboard } from "./ListingQualityDashboard";
import { BuyBoxPanel } from "./BuyBoxPanel";
import { RemediationPanel } from "./RemediationPanel";

type LqFilter =
  | "all"
  | "trafficNoConversion"
  | "outOfStock"
  | "noReviews"
  | "noFastShip"
  | "inStockHasTraffic"
  | "content";

export function WalmartGrowthTabs() {
  const [tab, setTab] = useState("action-center");
  const [lqFilter, setLqFilter] = useState<LqFilter>("trafficNoConversion");

  function jumpToWorklist(filter: string) {
    setLqFilter(filter as LqFilter);
    setTab("listing-quality");
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Walmart Growth"
        subtitle="Grow Sales — scan, diagnose, and fix what's costing sales, driven live off the Marketplace API"
      />
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="action-center">Action Center</TabsTrigger>
          <TabsTrigger value="listing-quality">Listing Quality</TabsTrigger>
          <TabsTrigger value="remediation">Remediation</TabsTrigger>
          <TabsTrigger value="buy-box">Buy Box</TabsTrigger>
        </TabsList>
        <TabsContent value="action-center" className="mt-4">
          <ActionCenter onJump={jumpToWorklist} />
        </TabsContent>
        <TabsContent value="listing-quality" className="mt-4">
          <ListingQualityDashboard filter={lqFilter} onFilterChange={setLqFilter} />
        </TabsContent>
        <TabsContent value="remediation" className="mt-4">
          <RemediationPanel />
        </TabsContent>
        <TabsContent value="buy-box" className="mt-4">
          <BuyBoxPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
