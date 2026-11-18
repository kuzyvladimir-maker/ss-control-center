"use client";

import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import ExecutionPanel from "@/components/customer-hub/ExecutionPanel";
import ScreenQueuePanel from "@/components/customer-hub/ScreenQueuePanel";
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
  activeAtoz: number | null;
  activeChargebacks: number | null;
  newFeedback: number | null;
  totalConversations: number | null;
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
    activeAtoz: null,
    activeChargebacks: null,
    newFeedback: null, totalConversations: null,
  });
  const [syncedAt, setSyncedAt] = useState<string>(new Date().toISOString());
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const [refreshNotice,setRefreshNotice]=useState<string|null>(null);
  const [processRequest,setProcessRequest]=useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({
      period: String(period),
      store: storeFilter,
    });
    const refresh = () => fetch(`/api/customer-hub/stats?${params.toString()}`)
      .then(async r => { if(!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) =>
        setStats({
          unreadMessages: data.unreadMessages ?? null,
          urgentMessages: data.urgentMessages ?? 0,
          activeAtoz: data.activeAtoz ?? null,
          activeChargebacks: data.activeChargebacks ?? null,
          newFeedback: data.newFeedback ?? null, totalConversations: data.totalConversations ?? null,
        })
      )
      .catch(() => setStats(s => ({ ...s, unreadMessages: null, activeAtoz: null, activeChargebacks: null, newFeedback: null, totalConversations: null })));
    window.addEventListener("cs-mail-refresh",refresh);
    void refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {clearInterval(timer);window.removeEventListener("cs-mail-refresh",refresh);};
  }, [period, storeFilter, syncedAt]);

  async function syncNow() {
    setSyncing(true); setRefreshError(null); setRefreshNotice(null);
    try {
      const results=await Promise.all(['/api/customer-hub/mail-inbox?view=all','/api/customer-hub/stats'].map(url=>fetch(url,{cache:'no-store'})));
      for(const r of results) {const d=await r.json();if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);if(d.errors && !Array.isArray(d.errors) && Object.keys(d.errors).length)throw Error(Object.values(d.errors).join('; '));}
      window.dispatchEvent(new Event("cs-mail-refresh"));
      setSyncedAt(new Date().toISOString());
      setRefreshNotice("View refreshed from saved data. Use Refresh mail status to request a new mail check.");
    } catch(e) {setRefreshError(e instanceof Error ? e.message : "Refresh failed");} finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHead
        title={`Ждут ответа: ${stats.unreadMessages ?? "Не проверено"}`}
        
        subtitle={
          <>
            <span>Customer Hub · Seller Central</span>
            <Sep />
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
              Прямой экранный снимок · без почтовых предположений
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
            <Btn variant="primary" icon={<ArrowRight size={13} />} onClick={()=>{setActiveTab("messages");setProcessRequest(n=>n+1);setRefreshNotice("Исполнение приостановлено: нужна проверка ветки на VPS. Ничего не отправлено.");}}>
              Process next
            </Btn>
          </>
        }
      />

      {refreshError && <p role="alert" className="text-danger">{refreshError}</p>}
      {refreshNotice && <p role="status" className="text-sm text-ink-2">{refreshNotice}</p>}
      <ScreenQueuePanel />
      <ExecutionPanel />

      {/* KPI row */}
      <HubStatsCards
        period={period}
        store={storeFilter}
        onCardClick={(tab: string, history?: boolean) => {setActiveTab(tab); if(history)setPeriod(365);}}
      />

      {/* Losses dashboard — collapsible */}
      <LossesDashboard
        key={`${period}-${storeFilter}-${syncedAt}`}
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
        messagesContent={<MessagesTab period={period} processRequest={processRequest} />}
        atozContent={
          <AtozTab
            key={`atoz-${period}-${storeFilter}-${syncedAt}`}
            period={period}
            store={storeFilter}
          />
        }
        chargebacksContent={
          <ChargebacksTab
            key={`cb-${period}-${storeFilter}-${syncedAt}`}
            period={period}
            store={storeFilter}
          />
        }
        feedbackContent={<FeedbackTab key={syncedAt} />}
      />
    </div>
  );
}
