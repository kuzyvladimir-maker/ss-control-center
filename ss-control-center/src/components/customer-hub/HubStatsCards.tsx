"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Scale, CreditCard, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface HubStatsCardsProps {
  // Period + store are accepted so the cards can refetch when the global
  // filters at the top of Customer Hub change. The /api/customer-hub/stats
  // endpoint currently ignores these and returns global counts; plumbing is
  // in place so it can start respecting them without UI changes.
  period?: number;
  store?: string;
}

export default function HubStatsCards({
  period = 30,
  store = "all",
}: HubStatsCardsProps) {
  const [stats, setStats] = useState({
    unreadMessages: 0,
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
      .then(setStats)
      .catch(() => {});
  }, [period, store]);

  const cards = [
    { label: "Unread Messages", value: stats.unreadMessages, icon: MessageSquare, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Active A-to-Z", value: stats.activeAtoz, icon: Scale, color: "text-red-600", bg: "bg-red-50" },
    { label: "Active Chargebacks", value: stats.activeChargebacks, icon: CreditCard, color: "text-orange-600", bg: "bg-orange-50" },
    { label: "New Feedback", value: stats.newFeedback, icon: Star, color: "text-green-600", bg: "bg-green-50" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="flex items-center gap-3 py-3">
            <div className={`rounded-lg p-2 ${c.bg}`}>
              <c.icon size={16} className={c.color} />
            </div>
            <div>
              <p className="text-[10px] text-slate-500">{c.label}</p>
              <p className={`text-xl font-bold ${c.value > 0 ? c.color : "text-slate-800"}`}>
                {c.value}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
