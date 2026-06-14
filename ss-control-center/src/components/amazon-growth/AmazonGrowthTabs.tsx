"use client";

/**
 * Amazon Growth — tab shell. Mirror of Walmart Growth, with a store switcher
 * (Amazon Grow spans two selling accounts: Salutem = store1, AMZ Commerce =
 * store3). Phase A ships the Listing Health tab; Action Center / Buy Box /
 * Optimizer arrive in later phases. See docs/wiki/amazon-growth-roadmap.md.
 */

import { useState } from "react";
import { PageHead } from "@/components/kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListingHealthDashboard } from "./ListingHealthDashboard";

export interface AmazonStore {
  index: number;
  label: string;
}

export const AMAZON_STORES: AmazonStore[] = [
  { index: 1, label: "Salutem Solutions" },
  { index: 3, label: "AMZ Commerce" },
];

export function AmazonGrowthTabs() {
  const [tab, setTab] = useState("listing-health");
  const [storeIndex, setStoreIndex] = useState(1);

  return (
    <div className="space-y-5">
      <PageHead
        title="Amazon Growth"
        subtitle="Grow Sales — a computed Listing Health score, the suppressed-listing backlog, and the fixes that move search rank, driven live off the SP-API"
      />

      {/* Store switcher — Amazon Grow spans two selling accounts */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">
          Account
        </span>
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
          <TabsTrigger value="listing-health">Listing Health</TabsTrigger>
        </TabsList>
        <TabsContent value="listing-health" className="mt-4">
          <ListingHealthDashboard storeIndex={storeIndex} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
