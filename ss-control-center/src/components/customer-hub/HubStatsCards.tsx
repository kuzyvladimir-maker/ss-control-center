"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Scale, CreditCard, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface HubStatsCardsProps {
  period?: number;
  store?: string;
  /** When provided, clicking a card switches to that tab */
  onCardClick?: (tabKey: string) => void;
}

interface HubStats {
  unreadMessages: number;
  urgentMessages: number;
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
    unreadMessages: 0,
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
    fetch(`/api/customer-hub/stats?${params.toString()}`)
      .then((r) => r.json())
      .then((data) =>
        setStats({
          unreadMessages: data.unreadMessages ?? 0,
          urgentMessages: data.urgentMessages ?? 0,
          activeAtoz: data.activeAtoz ?? 0,
          activeChargebacks: data.activeChargebacks ?? 0,
          newFeedback: data.newFeedback ?? 0,
        })
      )
      .catch(() => {});
  }, [period, store]);

  const cards = [
    {
      key: "messages",
      label: "Unread Messages",
      value: stats.unreadMessages,
      urgent: stats.urgentMessages,
      icon: MessageSquare,
      color: "text-green",
      bg: "bg-green-soft",
    },
    {
      key: "atoz",
      label: "Active A-to-Z",
      value: stats.activeAtoz,
      urgent: 0,
      icon: Scale,
      color: "text-danger",
      bg: "bg-danger-tint",
    },
    {
      key: "chargebacks",
      label: "Active Chargebacks",
      value: stats.activeChargebacks,
      urgent: 0,
      icon: CreditCard,
      color: "text-orange-600",
      bg: "bg-orange-50",
    },
    {
      key: "feedback",
      label: "New Feedback",
      value: stats.newFeedback,
      urgent: 0,
      icon: Star,
      color: "text-green",
      bg: "bg-green-soft",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <Card
          key={c.key}
          className={onCardClick ? "cursor-pointer hover:border-blue-300 transition-colors" : ""}
          onClick={() => onCardClick?.(c.key)}
        >
          <CardContent className="flex items-center gap-3 py-3">
            <div className={`rounded-lg p-2 ${c.bg}`}>
              <c.icon size={16} className={c.color} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-ink-3">{c.label}</p>
              <div className="flex items-center gap-1.5">
                <p
                  className={`text-xl font-bold ${
                    c.value > 0 ? c.color : "text-ink"
                  }`}
                >
                  {c.value}
                </p>
                {c.urgent > 0 && (
                  <span className="rounded-full bg-danger-tint px-1.5 py-0.5 text-[9px] font-semibold text-danger">
                    {c.urgent} urgent
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
