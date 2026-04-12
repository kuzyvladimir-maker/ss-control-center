"use client";

import { useState } from "react";
import HubStatsCards from "@/components/customer-hub/HubStatsCards";
import StoreFilter from "@/components/customer-hub/StoreFilter";
import PeriodFilter from "@/components/customer-hub/PeriodFilter";
import LossesDashboard from "@/components/customer-hub/LossesDashboard";
import CustomerHubTabs from "@/components/customer-hub/CustomerHubTabs";
import MessagesTab from "@/components/customer-hub/MessagesTab";
import AtozTab from "@/components/customer-hub/AtozTab";
import ChargebacksTab from "@/components/customer-hub/ChargebacksTab";
import FeedbackTab from "@/components/customer-hub/FeedbackTab";
import WalmartCaseModal from "@/components/customer-hub/WalmartCaseModal";

export default function CustomerHubPage() {
  const [storeFilter, setStoreFilter] = useState("all");
  const [period, setPeriod] = useState(30);
  const [activeTab, setActiveTab] = useState("messages");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800">Customer Hub</h1>
        <div className="flex items-center gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <StoreFilter value={storeFilter} onChange={setStoreFilter} />
          <WalmartCaseModal />
        </div>
      </div>

      {/* Stats — 4 cards with live counts. Click a card to switch tab */}
      <HubStatsCards
        period={period}
        store={storeFilter}
        onCardClick={(tab: string) => setActiveTab(tab)}
      />

      {/* Losses dashboard — collapsible. Remounts on period/store change so
          the inner useEffect re-runs without needing setState in the body. */}
      <LossesDashboard
        key={`${period}-${storeFilter}`}
        period={period}
        store={storeFilter}
      />

      {/* Tabs — period + store are passed down so filtering is
          synchronized with the dashboard above */}
      <CustomerHubTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        counts={{ messages: 0, atoz: 0, chargebacks: 0, feedback: 0 }}
        messagesContent={<MessagesTab />}
        atozContent={
          <AtozTab
            key={`atoz-${period}-${storeFilter}`}
            period={period}
            store={storeFilter}
          />
        }
        chargebacksContent={
          <ChargebacksTab
            key={`cb-${period}-${storeFilter}`}
            period={period}
            store={storeFilter}
          />
        }
        feedbackContent={<FeedbackTab />}
      />
    </div>
  );
}
