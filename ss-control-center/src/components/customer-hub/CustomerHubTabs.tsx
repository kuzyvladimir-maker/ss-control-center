"use client";

import { MessageSquare, Scale, CreditCard, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

interface CustomerHubTabsProps {
  counts: { messages: number; atoz: number; chargebacks: number; feedback: number };
  messagesContent: React.ReactNode;
  atozContent: React.ReactNode;
  chargebacksContent: React.ReactNode;
  feedbackContent: React.ReactNode;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[9px] font-bold">
      {count}
    </Badge>
  );
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
  return (
    <Tabs
      defaultValue="messages"
      value={activeTab}
      onValueChange={onTabChange}
    >
      <TabsList variant="line" className="mb-4">
        <TabsTrigger value="messages" className="gap-1 px-4">
          <MessageSquare size={14} />
          Messages
          <CountBadge count={counts.messages} />
        </TabsTrigger>
        <TabsTrigger value="atoz" className="gap-1 px-4">
          <Scale size={14} />
          A-to-Z Claims
          <CountBadge count={counts.atoz} />
        </TabsTrigger>
        <TabsTrigger value="chargebacks" className="gap-1 px-4">
          <CreditCard size={14} />
          Chargebacks
          <CountBadge count={counts.chargebacks} />
        </TabsTrigger>
        <TabsTrigger value="feedback" className="gap-1 px-4">
          <Star size={14} />
          Feedback
          <CountBadge count={counts.feedback} />
        </TabsTrigger>
      </TabsList>

      <TabsContent value="messages">{messagesContent}</TabsContent>
      <TabsContent value="atoz">{atozContent}</TabsContent>
      <TabsContent value="chargebacks">{chargebacksContent}</TabsContent>
      <TabsContent value="feedback">{feedbackContent}</TabsContent>
    </Tabs>
  );
}
