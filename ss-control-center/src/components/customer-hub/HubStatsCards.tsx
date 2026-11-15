"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Scale, CreditCard, Star } from "lucide-react";
import { KpiCard } from "@/components/kit";

interface HubStatsCardsProps {
  period?: number;
  store?: string;
  /** When provided, clicking a card switches to that tab */
  onCardClick?: (tabKey: string) => void;
}

interface HubStats {
  unreadMessages: number | null;
  urgentMessages: number | null;
  activeAtoz: number;
  activeChargebacks: number;
  newFeedback: number;
}

export default function HubStatsCards({
  period = 30,
  store = "all",
  onCardClick,
}: HubStatsCardsProps) {
  const [stats, setStats] = useState<HubStats>({
    unreadMessages: null,
    urgentMessages: 0,
    activeAtoz: 0,
    activeChargebacks: 0,
    newFeedback: 0,
  });

  useEffect(() => {
    const params = new URLSearchParams({
      period: String(period),
      store,
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
      value: stats.activeAtoz,
      icon: <Scale size={14} />,
      iconVariant: stats.activeAtoz > 0 ? ("warn" as const) : ("default" as const),
    },
    {
      key: "chargebacks",
      label: "Active chargebacks",
      value: stats.activeChargebacks,
      icon: <CreditCard size={14} />,
      iconVariant:
        stats.activeChargebacks > 0 ? ("danger" as const) : ("default" as const),
    },
    {
      key: "feedback",
      label: "New feedback",
      value: stats.newFeedback,
      icon: <Star size={14} />,
      iconVariant: "default" as const,
    },
  ];

  return (
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
  );
}
