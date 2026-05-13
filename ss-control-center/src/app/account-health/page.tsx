"use client";

import { useState } from "react";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { PageHead, Btn } from "@/components/kit";
import { RefreshCw } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AmazonHealthTab } from "@/components/account-health/AmazonHealthTab";
import { WalmartHealthTab } from "@/components/account-health/WalmartHealthTab";

export default function AccountHealthPage() {
  const { hasAmazon, hasWalmart, isLoading: filterLoading } = useStoreFilter();
  const [syncing, setSyncing] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  async function refreshAll() {
    setSyncing(true);
    try {
      await Promise.allSettled([
        hasAmazon
          ? fetch("/api/account-health/amazon/sync", { method: "POST" })
          : Promise.resolve(),
        hasWalmart
          ? fetch("/api/account-health/walmart/sync", { method: "POST" })
          : Promise.resolve(),
      ]);
    } finally {
      setRefreshNonce((n) => n + 1);
      setSyncing(false);
    }
  }

  // Default to whichever channel is selected. When both, prefer Amazon.
  const defaultTab = hasAmazon ? "amazon" : hasWalmart ? "walmart" : "amazon";

  return (
    <div className="space-y-5">
      <PageHead
        title="Account Health"
        subtitle="Amazon AHR + Policy Compliance · Walmart Performance + Items"
        actions={
          <Btn
            icon={<RefreshCw size={13} />}
            onClick={refreshAll}
            loading={syncing}
          >
            {syncing ? "Syncing…" : "Refresh all"}
          </Btn>
        }
      />

      {filterLoading ? (
        <div className="rounded-lg border border-rule bg-surface p-6 text-[12px] text-ink-3">
          Loading store filter…
        </div>
      ) : !hasAmazon && !hasWalmart ? (
        <div className="rounded-lg border border-rule bg-surface p-6 text-center text-[13px] text-ink-3">
          Select at least one store to view account health.
        </div>
      ) : (
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList>
            {hasAmazon && <TabsTrigger value="amazon">Amazon</TabsTrigger>}
            {hasWalmart && <TabsTrigger value="walmart">Walmart</TabsTrigger>}
          </TabsList>

          {hasAmazon && (
            <TabsContent value="amazon" className="mt-4">
              <AmazonHealthTab refreshNonce={refreshNonce} />
            </TabsContent>
          )}

          {hasWalmart && (
            <TabsContent value="walmart" className="mt-4">
              <WalmartHealthTab refreshNonce={refreshNonce} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
