"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";

// Amazon requires a buyer-message response within 24 hours of receipt.
// This component renders a colour-coded deadline badge:
//   > 12h remaining   → grey
//   4h < t ≤ 12h      → amber
//   0 < t ≤ 4h        → red
//   t ≤ 0             → OVERDUE (dark red, bold)
//   status SENT/RESOLVED → green "Responded" checkmark
//
// A 60-second ticker re-renders the component so countdown stays live
// while a tab is open.

interface ResponseDeadlineProps {
  createdAt: string | Date;
  status: string;
  className?: string;
}

const DEADLINE_MS = 24 * 60 * 60 * 1000;

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function ResponseDeadline({
  createdAt,
  status,
  className = "",
}: ResponseDeadlineProps) {
  const now = useNow();

  if (status === "SENT" || status === "RESOLVED") {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs text-green ${className}`}
      >
        <Check size={12} />
        Responded
      </span>
    );
  }

  const created = new Date(createdAt).getTime();
  const deadline = created + DEADLINE_MS;
  const msLeft = deadline - now;
  const hoursLeft = Math.floor(msLeft / (60 * 60 * 1000));

  if (msLeft <= 0) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs font-semibold text-danger ${className}`}
      >
        <AlertTriangle size={12} />
        OVERDUE
      </span>
    );
  }

  if (hoursLeft <= 4) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs font-medium text-danger ${className}`}
      >
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-danger" />
        {hoursLeft}h left
      </span>
    );
  }

  if (hoursLeft <= 12) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs text-warn ${className}`}
      >
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-warn-tint0" />
        {hoursLeft}h left
      </span>
    );
  }

  return (
    <span className={`text-xs text-ink-3 ${className}`}>
      {hoursLeft}h left
    </span>
  );
}
