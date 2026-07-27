"use client";

import { MessageSquare, Scale, CreditCard, Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface CustomerHubTabsProps {
  counts: { messages: number; atoz: number; chargebacks: number; feedback: number };
  messagesContent: React.ReactNode;
  atozContent: React.ReactNode;
  chargebacksContent: React.ReactNode;
  feedbackContent: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

interface TabDef {
  key: string;
  title: string;
  meta: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  count: number;
  urgent?: boolean;
}

export default function CustomerHubTabs({
  counts,
  messagesContent,
  atozContent,
  chargebacksContent,
  feedbackContent,
  activeTab,
  onTabChange,
}: CustomerHubTabsProps) {
  const tabs: TabDef[] = [
    {
      key: "messages",
      title: "Messages",
      meta: "GMAIL · T1–T20",
      icon: MessageSquare,
      count: counts.messages,
      urgent: counts.messages > 0,
    },
    {
      key: "atoz",
      title: "A-to-Z claims",
      meta: "SP-API reports",
      icon: Scale,
      count: counts.atoz,
    },
    {
      key: "chargebacks",
      title: "Chargebacks",
      meta: "Gmail seller-notify",
      icon: CreditCard,
      count: counts.chargebacks,
    },
    {
      key: "feedback",
      title: "Feedback",
      meta: "SP-API reports",
      icon: Star,
      count: counts.feedback,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Tabbar — plaque style, one per tab */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.key === activeTab;
          return (
            <button
              key={t.key}
              onClick={() => onTabChange(t.key)}
              type="button"
              className={cn(
                "group flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
                active
                  ? "border-green bg-green-soft"
                  : "border-rule bg-surface hover:border-silver-line hover:bg-surface-tint"
              )}
            >
              <div
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-md",
                  active
                    ? "bg-green text-green-cream"
                    : "bg-bg-elev text-ink-2 group-hover:bg-surface-tint"
                )}
              >
                <Icon size={16} strokeWidth={1.7} />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-[13px] font-semibold truncate",
                    active ? "text-green-ink" : "text-ink"
                  )}
                >
                  {t.title}
                </div>
                <div className="mt-0.5 truncate text-[10px] font-mono uppercase tracking-wider text-ink-3">
                  {t.meta}
                </div>
              </div>
              {t.count > 0 && (
                <span
                  className={cn(
                    "inline-flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold tabular",
                    t.urgent
                      ? "bg-warn-tint text-warn-strong"
                      : active
                        ? "bg-green text-green-cream"
                        : "bg-bg-elev text-ink-2"
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active tab content */}
      <div>
        {activeTab === "messages" && messagesContent}
        {activeTab === "atoz" && atozContent}
        {activeTab === "chargebacks" && chargebacksContent}
        {activeTab === "feedback" && feedbackContent}
      </div>
    </div>
  );
}
