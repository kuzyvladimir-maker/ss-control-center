"use client";

import { useState } from "react";
import { PageHead } from "@/components/kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionCenter } from "./ActionCenter";
import { BuyBoxPanel } from "./BuyBoxPanel";
import { ListingOptimizer } from "./ListingOptimizer";

export function WalmartGrowthTabs() {
  // Three tabs. The old "Listing Quality" tab is folded into the Optimizer: its
  // seller score + 6 component gauges live in the health strip, and Walmart's
  // per-listing issues are now inline + actionable (Fix / Ask AI) in the
  // candidate table. Action Center is renamed "Overview".
  const [tab, setTab] = useState("optimizer");

  return (
    <div className="space-y-5">
      <PageHead
        title="Walmart Growth"
        subtitle="Grow Sales — scan, diagnose, and fix what's costing sales, driven live off the Marketplace API"
      />
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="optimizer">Listing Optimizer</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="buy-box">Buy Box</TabsTrigger>
        </TabsList>
        <TabsContent value="optimizer" className="mt-4">
          <ListingOptimizer />
        </TabsContent>
        <TabsContent value="overview" className="mt-4">
          <ActionCenter onJump={() => setTab("optimizer")} />
        </TabsContent>
        <TabsContent value="buy-box" className="mt-4">
          <BuyBoxPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
