"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Scale, CreditCard, Star } from "lucide-react";
import { KpiCard } from "@/components/kit";

interface HubStatsCardsProps {
  period?: number;
  store?: string;
  /** When provided, clicking a card switches to that tab */
  onCardClick?: (tabKey: string, history?: boolean) => void;
}

interface HubStats {
  unreadMessages: number | null;
  urgentMessages: number | null;
  activeAtoz: number | null;
  activeChargebacks: number | null;
  newFeedback: number | null;
  errors?: Record<string,string>;
  metadata?: Record<string,{storedTotal:number|null;latestStoredAt?:string|null;definition:string}|null>;
}

export default function HubStatsCards({
  period = 30,
  store = "all",
  onCardClick,
}: HubStatsCardsProps) {
  const [stats, setStats] = useState<HubStats>({
    unreadMessages: null,
    urgentMessages: 0,
    activeAtoz: null,
    activeChargebacks: null,
    newFeedback: null,
  });

  useEffect(() => {
    const params = new URLSearchParams({
      period: String(period),
      store,
    });
    const refresh = () => fetch(`/api/customer-hub/stats?${params.toString()}`)
      .then(async r => { const d=await r.json(); if(!r.ok) throw Error(d.error||`HTTP ${r.status}`); return d; })
      .then((data) =>
        setStats({
          unreadMessages: data.unreadMessages ?? null,
          urgentMessages: data.urgentMessages ?? 0,
          activeAtoz: data.activeAtoz ?? null,
          activeChargebacks: data.activeChargebacks ?? null,
          newFeedback: data.newFeedback ?? null,
          metadata: data.metadata, errors: data.errors,
        })
      )
      .catch(() => setStats(s => ({ ...s, unreadMessages: null, activeAtoz: null, activeChargebacks: null, newFeedback: null, errors: {all:"Counters unavailable; refresh to retry"} })));
    window.addEventListener("cs-mail-refresh",refresh);
    void refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {clearInterval(timer);window.removeEventListener("cs-mail-refresh",refresh);};
  }, [period, store]);

  const cards = [
    {
      key: "messages",
      label: "Awaiting reply (Amazon mail)",
      value: stats.unreadMessages ?? "Unknown",
      icon: <MessageSquare size={14} />,
      iconVariant: "default" as const,
      chips:
        (stats.urgentMessages ?? 0) > 0
          ? [{ label: `${stats.urgentMessages} urgent`, variant: "urgent" as const }]
          : undefined,
    },
    {
      key: "atoz",
      label: "Active A-to-Z",
      value: stats.activeAtoz ?? "Unavailable",
      icon: <Scale size={14} />,
      iconVariant: (stats.activeAtoz ?? 0) > 0 ? ("warn" as const) : ("default" as const),
    },
    {
      key: "chargebacks",
      label: "Active chargebacks",
      value: stats.activeChargebacks ?? "Unavailable",
      icon: <CreditCard size={14} />,
      iconVariant:
        (stats.activeChargebacks ?? 0) > 0 ? ("danger" as const) : ("default" as const),
    },
    {
      key: "feedback",
      label: "New feedback",
      value: stats.newFeedback ?? "Unavailable",
      icon: <Star size={14} />,
      iconVariant: "default" as const,
    },
  ];

  return (
    <div className="space-y-3">
    {Object.values(stats.errors||{}).map(e=><p key={e} role="alert" className="text-sm text-danger">{e}</p>)}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.key}
          role={onCardClick ? "button" : undefined}
          tabIndex={onCardClick ? 0 : undefined}
          className={
            onCardClick
              ? "cursor-pointer transition-all hover:-translate-y-0.5"
              : undefined
          }
          onClick={() => onCardClick?.(c.key)}
          onKeyDown={(e) => {
            if (onCardClick && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onCardClick(c.key);
            }
          }}
        >
          <KpiCard
            label={c.label}
            value={c.value}
            icon={c.icon}
            iconVariant={c.iconVariant}
            chips={c.chips}
          />
        </div>
      ))}
    </div>
    <div className="text-xs text-ink-3 space-y-1" aria-label="Counter coverage">
      {(['atoz','chargebacks','feedback'] as const).map(key=>{const meta=stats.metadata?.[key];return meta?<p key={key}><strong>{key==='atoz'?'A-to-Z':key==='chargebacks'?'Chargebacks':'Feedback'}:</strong> {meta.definition} Stored history: {meta.storedTotal ?? 'unknown'}.{meta.latestStoredAt?` Latest stored record: ${new Date(meta.latestStoredAt).toLocaleDateString('en-US')}.`:''}{key!=='feedback' && (meta.storedTotal??0)>0 && <button className="ml-2 underline" onClick={()=>onCardClick?.(key,true)}>View stored history</button>}</p>:null;})}
    </div></div>
  );
}
