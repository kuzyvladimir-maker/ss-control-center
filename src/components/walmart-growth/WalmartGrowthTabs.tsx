"use client";

import { useState } from "react";
import { PageHead } from "@/components/kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionCenter } from "./ActionCenter";
import { BuyBoxPanel } from "./BuyBoxPanel";
import { ListingIntegrityPanel } from "./ListingIntegrityPanel";
import { ListingOptimizer } from "./ListingOptimizer";
import type { ListingIntegrityShadowData } from "@/lib/walmart/listing-integrity-shadow-contract";

export function WalmartGrowthTabs({
  integrityData,
}: {
  integrityData: ListingIntegrityShadowData;
}) {
  // The old "Listing Quality" tab is folded into the Optimizer: its
  // seller score + 6 component gauges live in the health strip, and Walmart's
  // per-listing issues are now inline + actionable (Fix / Ask AI) in the
  // candidate table. Action Center is renamed "Overview".
  const [tab, setTab] = useState("integrity");

  return (
    <div className="space-y-5">
      <PageHead
        title="Walmart Growth"
        subtitle="Grow Sales — scan, diagnose, and fix what's costing sales, driven live off the Marketplace API"
      />
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="integrity">Listing Integrity</TabsTrigger>
          <TabsTrigger value="optimizer">Listing Optimizer</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="buy-box">Buy Box</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
        </TabsList>
        <TabsContent value="integrity" className="mt-4">
          <ListingIntegrityPanel data={integrityData} />
        </TabsContent>
        <TabsContent value="optimizer" className="mt-4">
          <ListingOptimizer />
        </TabsContent>
        <TabsContent value="overview" className="mt-4">
          <ActionCenter onJump={() => setTab("optimizer")} />
        </TabsContent>
        <TabsContent value="buy-box" className="mt-4">
          <BuyBoxPanel />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <div className="rounded-lg border border-rule bg-surface p-6">
            <div className="text-[14px] font-semibold text-ink">
              Pricing guardrails — Walmart
            </div>
            <p className="mt-2 max-w-2xl text-[13px] text-ink-2">
              Same engine as Amazon → Pricing (target price + floor/ceiling, one-click
              reprice). Waiting on per-product COGS for Walmart SKUs before it can
              compute a target — cost determination is tracked separately. The
              Amazon Uncrustables cost-model already validates the approach.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
