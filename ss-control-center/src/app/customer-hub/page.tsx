"use client";

import { useState } from "react";
import HubStatsCards from "@/components/customer-hub/HubStatsCards";
import StoreFilter from "@/components/customer-hub/StoreFilter";
import CustomerHubTabs from "@/components/customer-hub/CustomerHubTabs";
import MessagesTab from "@/components/customer-hub/MessagesTab";
import AtozTab from "@/components/customer-hub/AtozTab";
import ChargebacksTab from "@/components/customer-hub/ChargebacksTab";
import FeedbackTab from "@/components/customer-hub/FeedbackTab";
import WalmartCaseModal from "@/components/customer-hub/WalmartCaseModal";

export default function CustomerHubPage() {
  const [storeFilter, setStoreFilter] = useState("all");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800">Customer Hub</h1>
        <div className="flex items-center gap-3">
          <StoreFilter value={storeFilter} onChange={setStoreFilter} />
          <WalmartCaseModal />
        </div>
      </div>

      {/* Stats — fetches from /api/customer-hub/stats */}
      <HubStatsCards />

      {/* Tabs */}
      <CustomerHubTabs
        counts={{ messages: 0, atoz: 0, chargebacks: 0, feedback: 0 }}
        messagesContent={<MessagesTab />}
        atozContent={<AtozTab />}
        chargebacksContent={<ChargebacksTab />}
        feedbackContent={<FeedbackTab />}
      />
    </div>
  );
}
