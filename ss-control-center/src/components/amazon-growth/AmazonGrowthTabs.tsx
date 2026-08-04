"use client";

/**
 * Amazon Growth — tab shell. Mirror of Walmart Growth, with a store switcher
 * (Amazon Grow spans two selling accounts: Salutem = store1, AMZ Commerce =
 * store3). Action Center diagnoses → jump into the Listing Health worklist
 * filtered to the affected listings. See docs/wiki/amazon-growth-roadmap.md.
 */

import { useState } from "react";
import { Info } from "lucide-react";
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

// Russian explainer shown at the top of each tab — so it's always clear what the
// tab/algorithm does (chat with Vladimir is Russian; UI strings stay English).
const TAB_HELP: Record<string, string> = {
  "action-center":
    "What is on fire right now: a summary of account problems and quick jumps into the right listing list. The entry point — you see where to click.",
  "listing-health":
    "The health of every listing: our own score (Amazon has none) plus the full sales funnel. On top is the AI analyst: you pick the pool with filters, and the LLM diagnoses each listing and applies the safe fixes itself. It spends money on AI — manual launch only. The ↗ button opens the listing on Amazon.",
  optimizer:
    "Bulk safe clean-up: filter → pool → one button removes duplicate errors, strips promo words from titles, fills missing unit_count/weight. Deterministic edits only, verified before the write and reversible — free, no AI. Below is what it achieved (Impact + a map of frequent errors).",
  "buy-box":
    "Who owns the featured offer (Buy Box). Where we lose it, the traffic goes to a competitor and conversion drops because of the lost Buy Box, not because of the content.",
  pricing:
    "Prices and guard rails (margin floor/ceiling) plus repricing. Runs alongside the real cost (COGS) calculation.",
  recovery:
    "Daily sales history plus the lost champions — listings that used to sell and have since vanished or sagged. Expand a row → rebuild kit (content from a snapshot or the Amazon catalog) → Restore puts the content back. The Backfill 90d button fills the history for trends and effect measurement.",
  "change-log":
    "A log of every change: what/when/by which algorithm, before→after values, a helped/neutral/hurt verdict and the control-adjusted lift (DiD — the effect net of market movement). Any attribute edit rolls back with one button.",
};

function TabHelp({ tab }: { tab: string }) {
  const text = TAB_HELP[tab];
  if (!text) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-rule bg-bg-elev/40 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
      <Info size={14} className="mt-0.5 shrink-0 text-ink-3" />
      <span>{text}</span>
    </div>
  );
}

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
          <TabHelp tab="action-center" />
          <ActionCenter storeIndex={storeIndex} onJump={jumpToWorklist} />
        </TabsContent>
        <TabsContent value="listing-health" className="mt-4">
          <TabHelp tab="listing-health" />
          <ListingHealthDashboard storeIndex={storeIndex} filter={healthFilter} onFilterChange={setHealthFilter} />
        </TabsContent>
        <TabsContent value="optimizer" className="mt-4 space-y-5">
          <TabHelp tab="optimizer" />
          <BulkFixPanel storeIndex={storeIndex} />
          <OptimizerResults storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="buy-box" className="mt-4">
          <TabHelp tab="buy-box" />
          <BuyBoxPanel storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          <TabHelp tab="pricing" />
          <PricingDashboard storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="recovery" className="mt-4">
          <TabHelp tab="recovery" />
          <RecoveryPanel storeIndex={storeIndex} />
        </TabsContent>
        <TabsContent value="change-log" className="mt-4">
          <TabHelp tab="change-log" />
          <ChangeLogPanel storeIndex={storeIndex} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
