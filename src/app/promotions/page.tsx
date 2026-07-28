"use client";
import { Megaphone } from "lucide-react";
import { ComingSoon } from "@/components/kit";

export default function PromotionsPage() {
  return (
    <ComingSoon
      title="Promotions"
      tagline="Schedule, monitor, and roll back promotional pricing across Amazon and Walmart."
      icon={<Megaphone size={20} />}
      bullets={[
        "One-click coupons and Lightning Deals via SP-API",
        "Auto-suspend underperforming promos by sell-through threshold",
        "Track promo lift vs baseline conversion",
        "Calendar view across all 5 stores",
      ]}
      eta="Phase 2 · awaiting business rules"
    />
  );
}
