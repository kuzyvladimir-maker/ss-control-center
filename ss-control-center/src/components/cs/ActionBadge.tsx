"use client";

import { Badge } from "@/components/ui/badge";

const actionConfig: Record<string, { label: string; className: string }> = {
  A2Z_GUARANTEE: {
    label: "A-to-Z Guarantee",
    className: "bg-blue-100 text-blue-700 border-blue-200",
  },
  REPLACEMENT: {
    label: "Send Replacement",
    className: "bg-green-100 text-green-700 border-green-200",
  },
  REFUND: {
    label: "Issue Refund",
    className: "bg-orange-100 text-orange-700 border-orange-200",
  },
  ESCALATE: {
    label: "Escalate to Vladimir",
    className: "bg-red-100 text-red-700 border-red-200",
  },
  PHOTO_REQUEST: {
    label: "Request Photo",
    className: "bg-slate-100 text-slate-700 border-slate-200",
  },
  INFO: {
    label: "Info Response",
    className: "bg-slate-100 text-slate-700 border-slate-200",
  },
};

export default function ActionBadge({ action }: { action: string }) {
  const config = actionConfig[action] || {
    label: action,
    className: "bg-slate-100 text-slate-700",
  };

  return <Badge className={config.className}>{config.label}</Badge>;
}
