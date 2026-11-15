"use client";

import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import MailInboxPanel from "@/components/customer-hub/MailInboxPanel";
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
import WalmartSyncButton from "@/components/customer-hub/WalmartSyncButton";
import { Btn, PageHead, Sep } from "@/components/kit";

interface HubStats {
  unreadMessages: number | null;
  urgentMessages: number;
  activeAtoz: number;
  activeChargebacks: number;
  newFeedback: number;
}

export default function CustomerHubPage() {
  const [storeFilter, setStoreFilter] = useState("all");
  const [period, setPeriod] = useState(30);
  const [activeTab, setActiveTab] = useState("messages");
  // Deep link: /customer-hub?tab=atoz (Dashboard A-to-Z chip) etc.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && ["messages", "atoz", "chargebacks", "feedback"].includes(t)) setActiveTab(t);
  }, []);
  const [stats, setStats] = useState<HubStats>({
    unreadMessages: null,
    urgentMessages: 0,
    activeAtoz: 0,
    activeChargebacks: 0,
    newFeedback: 0,
  });
  const [syncedAt, setSyncedAt] = useState<string>(new Date().toISOString());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({
      period: String(period),
      store: storeFilter,
    });
    const refresh = () => fetch(`/api/customer-hub/stats?${params.toString()}`)
      .then((r) => r.json())
      .then((data) =>
        setStats({
          unreadMessages: data.unreadMessages ?? null,
          urgentMessages: data.urgentMessages ?? 0,
          activeAtoz: data.activeAtoz ?? 0,
          activeChargebacks: data.activeChargebacks ?? 0,
          newFeedback: data.newFeedback ?? 0,
        })
      )
      .catch(() => setStats(s => ({ ...s, unreadMessages: null })));
    void refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [period, storeFilter, syncedAt]);

  const totalAttention =
    (stats.unreadMessages ?? 0) +
    stats.activeAtoz +
    stats.activeChargebacks +
    stats.newFeedback;

  async function syncNow() {
    setSyncing(true);
    try {
      await fetch("/api/customer-hub/mail-inbox", { cache: "no-store" });
      window.dispatchEvent(new Event("cs-mail-refresh"));
      setSyncedAt(new Date().toISOString());
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Customer Hub"
        
        subtitle={
          <>
            <span>
              <strong className="text-ink tabular">{totalAttention}</strong>{" "}
              {totalAttention === 1 ? "item" : "items"} need your attention{stats.unreadMessages === null ? " · mail count unknown" : ""}
            </span>
            <Sep />
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
              Amazon mail · Coverage below
            </span>
          </>
        }
        actions={
          <>
            <PeriodFilter value={period} onChange={setPeriod} />
            <StoreFilter value={storeFilter} onChange={setStoreFilter} />
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={syncNow}
              loading={syncing}
            >
              {syncing ? "Refreshing…" : "Refresh view"}
            </Btn>
            <WalmartSyncButton />
            <WalmartCaseModal />
            <Btn variant="primary" icon={<ArrowRight size={13} />}>
              Process next
            </Btn>
          </>
        }
      />

      <MailInboxPanel showQueue={false} />

      {/* KPI row */}
      <HubStatsCards
        period={period}
        store={storeFilter}
        onCardClick={(tab: string) => setActiveTab(tab)}
      />

      {/* Losses dashboard — collapsible */}
      <LossesDashboard
        key={`${period}-${storeFilter}`}
        period={period}
        store={storeFilter}
      />

      {/* Tabs — plaque style from mockup */}
      <CustomerHubTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        counts={{
          messages: stats.unreadMessages,
          atoz: stats.activeAtoz,
          chargebacks: stats.activeChargebacks,
          feedback: stats.newFeedback,
        }}
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
