"use client";

/**
 * Amazon Growth — tab shell. Mirror of Walmart Growth, with a store switcher
 * (Amazon Grow spans two selling accounts: Salutem = store1, AMZ Commerce =
 * store3). Action Center diagnoses → jump into the Listing Health worklist
 * filtered to the affected listings. See docs/wiki/amazon-growth-roadmap.md.
 */

import { useState } from "react";
import { PageHead } from "@/components/kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionCenter } from "./ActionCenter";
import { ListingHealthDashboard } from "./ListingHealthDashboard";
import { BuyBoxPanel } from "./BuyBoxPanel";
import { OptimizerResults } from "./OptimizerResults";
import { BulkFixPanel } from "./BulkFixPanel";
import { ChangeLogPanel } from "./ChangeLogPanel";
import { RecoveryPanel } from "./RecoveryPanel";
import { PricingDashboard } from "@/components/pricing/PricingDashboard";

export interface AmazonStore {
  index: number;
  label: string;
}

export const AMAZON_STORES: AmazonStore[] = [
  { index: 1, label: "Salutem Solutions" },
  { index: 3, label: "AMZ Commerce" },
];

type FilterId = "all" | "suppressed" | "hasErrors" | "lowScore" | "notBuyable";

export function AmazonGrowthTabs() {
  const [tab, setTab] = useState("action-center");
  const [storeIndex, setStoreIndex] = useState(1);
  const [healthFilter, setHealthFilter] = useState<FilterId>("hasErrors");

  function jumpToWorklist(filter: string) {
    setHealthFilter(filter as FilterId);
    setTab("listing-health");
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Amazon Growth"
        subtitle="Grow Sales — a computed Listing Health score, the suppressed-listing backlog, and the fixes that move search rank, driven live off the SP-API"
      />

      {/* Store switcher — Amazon Grow spans two selling accounts */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">Account</span>
        {AMAZON_STORES.map((s) => (
          <button
            key={s.index}
            type="button"
            onClick={() => setStoreIndex(s.index)}
            className={
              "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors " +
              (storeIndex === s.index
                ? "bg-green-soft text-green-ink"
                : "text-ink-2 hover:bg-bg-elev hover:text-ink")
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="action-center">Action Center</TabsTrigger>
          <TabsTrigger value="listing-health">Listing Health</TabsTrigger>
          <TabsTrigger value="optimizer">Listing Optimizer</TabsTrigger>
          <TabsTrigger value="buy-box">Buy Box</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="recovery">Recovery</TabsTrigger>
          <TabsTrigger value="change-log">Change Log</TabsTrigger>
        </TabsList>
        <TabsContent value="action-center" className="mt-4">
          <ActionCenter storeIndex={storeIndex} onJump={jumpToWorklist} />
        </TabsContent>
        <TabsContent value="listing-health" className="mt-4">
          <ListingHealthDashboard storeIndex={storeIndex} filter={healthFilter} onFilterChange={setHealthFilter} />
        </TabsContent>
        <TabsContent value="optimizer" className="mt-4 space-y-5">
          <BulkFixPanel storeIndex={storeIndex} />
          <OptimizerResults storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="buy-box" className="mt-4">
          <BuyBoxPanel storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <PricingDashboard storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="recovery" className="mt-4">
          <RecoveryPanel storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="change-log" className="mt-4">
          <ChangeLogPanel storeIndex={storeIndex} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
