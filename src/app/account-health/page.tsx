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
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  async function refreshAll() {
    setSyncing(true);
    setSyncMsg("Requesting Amazon reports…");
    try {
      // Phase 1 — kick off reports for both channels in parallel.
      await Promise.allSettled([
        hasAmazon
          ? fetch("/api/account-health/amazon/sync", { method: "POST" })
          : Promise.resolve(),
        hasWalmart
          ? fetch("/api/account-health/walmart/sync", { method: "POST" })
          : Promise.resolve(),
      ]);

      // Phase 2 — Amazon Reports API is async (30s..3min per store).
      // Poll the /poll endpoint until every job closes or we time out
      // after ~5 min. Walmart is synchronous so it's already done above.
      if (hasAmazon) {
        const deadline = Date.now() + 5 * 60 * 1000;
        let attempts = 0;
        while (Date.now() < deadline) {
          attempts++;
          setSyncMsg(`Polling Amazon reports… (attempt ${attempts})`);
          const r = await fetch("/api/account-health/amazon/poll", {
            method: "POST",
          });
          const j = (await r.json()) as {
            done: boolean;
            pendingCount: number;
          };
          // Trigger a tab re-fetch each pass so completed stores light up
          // progressively instead of all at the end.
          setRefreshNonce((n) => n + 1);
          if (j.done) {
            setSyncMsg(null);
            break;
          }
          await new Promise((r2) => setTimeout(r2, 15_000));
        }
      }
    } finally {
      setRefreshNonce((n) => n + 1);
      setSyncing(false);
      setSyncMsg(null);
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
          <div className="flex items-center gap-2">
            {syncMsg && (
              <span className="text-[11px] text-ink-3">{syncMsg}</span>
            )}
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={refreshAll}
              loading={syncing}
            >
              {syncing ? "Syncing…" : "Refresh all"}
            </Btn>
          </div>
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
