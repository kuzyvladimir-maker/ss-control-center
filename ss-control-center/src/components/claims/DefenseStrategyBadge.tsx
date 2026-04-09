"use client";

import { Badge } from "@/components/ui/badge";

const strategyConfig: Record<string, { label: string; className: string }> = {
  BUY_SHIPPING_PROTECTION: {
    label: "Buy Shipping Protection",
    className: "bg-green-100 text-green-700 border-green-200",
  },
  PROOF_OF_DELIVERY: {
    label: "Proof of Delivery",
    className: "bg-blue-100 text-blue-700 border-blue-200",
  },
  INR_DEFENSE: {
    label: "INR Defense",
    className: "bg-amber-100 text-amber-700 border-amber-200",
  },
  CARRIER_DELAY_DEFENSE: {
    label: "Carrier Delay",
    className: "bg-orange-100 text-orange-700 border-orange-200",
  },
  MANUAL_REVIEW: {
    label: "Manual Review",
    className: "bg-red-100 text-red-700 border-red-200",
  },
};

const confidenceConfig: Record<string, string> = {
  HIGH: "text-green-600",
  MEDIUM: "text-amber-600",
  LOW: "text-red-600",
};

interface DefenseStrategyBadgeProps {
  strategyType: string | null;
  confidence: string | null;
}

export default function DefenseStrategyBadge({
  strategyType,
  confidence,
}: DefenseStrategyBadgeProps) {
  const sc = strategyConfig[strategyType || ""] || {
    label: strategyType || "Unknown",
    className: "bg-slate-100 text-slate-600",
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge className={sc.className}>{sc.label}</Badge>
      {confidence && (
        <span
          className={`text-[10px] font-semibold ${confidenceConfig[confidence] || ""}`}
        >
          {confidence}
        </span>
      )}
    </span>
  );
}
