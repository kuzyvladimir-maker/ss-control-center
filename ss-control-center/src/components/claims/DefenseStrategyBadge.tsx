"use client";

import { Badge } from "@/components/ui/badge";

const strategyConfig: Record<string, { label: string; className: string }> = {
  BUY_SHIPPING_PROTECTION: {
    label: "Buy Shipping Protection",
    className: "bg-green-soft2 text-green-ink border-green-soft2",
  },
  PROOF_OF_DELIVERY: {
    label: "Proof of Delivery",
    className: "bg-green-soft2 text-green-deep border-green-soft2",
  },
  INR_DEFENSE: {
    label: "INR Defense",
    className: "bg-warn-tint text-warn-strong border-warn/20",
  },
  CARRIER_DELAY_DEFENSE: {
    label: "Carrier Delay",
    className: "bg-warn-tint text-warn-strong border-warn-strong",
  },
  MANUAL_REVIEW: {
    label: "Manual Review",
    className: "bg-danger-tint text-danger border-danger/20",
  },
};

const confidenceConfig: Record<string, string> = {
  HIGH: "text-green",
  MEDIUM: "text-warn",
  LOW: "text-danger",
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
    className: "bg-bg-elev text-ink-2",
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
