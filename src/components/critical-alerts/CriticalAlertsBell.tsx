"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import Link from "next/link";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Alert {
  id: string;
  channel: string;
  alertType: string;
  severity: string;
  title: string;
  message: string;
  actionUrl: string | null;
  detectedAt: string;
}

interface AlertsPayload {
  alerts: Alert[];
  counts: { critical: number; high: number; total: number };
}

/**
 * Topbar bell that polls /api/alerts/unacknowledged every 30 seconds and
 * lets the user acknowledge from the popover.
 */
export function CriticalAlertsBell() {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/alerts/unacknowledged");
        if (!r.ok) return;
        const j = (await r.json()) as AlertsPayload;
        if (!cancelled) setData(j);
      } catch {
        /* ignore — bell stays at last known state */
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const total = data?.counts.total ?? 0;
  const hasCritical = (data?.counts.critical ?? 0) > 0;

  async function acknowledge(alertId: string) {
    setBusy(alertId);
    try {
      await fetch(`/api/alerts/${alertId}/acknowledge`, { method: "POST" });
      // Optimistic: drop locally so the bell reacts instantly. Polling
      // refreshes within 30s anyway.
      setData((d) =>
        d
          ? {
              ...d,
              alerts: d.alerts.filter((a) => a.id !== alertId),
              counts: { ...d.counts, total: Math.max(0, d.counts.total - 1) },
            }
          : d
      );
    } finally {
      setBusy(null);
    }
  }

  async function acknowledgeAll() {
    if (!data || data.alerts.length === 0) return;
    setBulkBusy(true);
    try {
      await fetch("/api/alerts/acknowledge-all", { method: "POST" });
      // Optimistic: clear everything locally. The 30s poll will reconcile
      // if more alerts arrived while we were clicking.
      setData((d) =>
        d ? { ...d, alerts: [], counts: { critical: 0, high: 0, total: 0 } } : d,
      );
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Notifications${total > 0 ? `, ${total} unread` : ""}`}
        className="relative grid h-8 w-8 place-items-center rounded-md text-ink-2 hover:bg-bg-elev hover:text-ink"
      >
        <Bell size={16} />
        {total > 0 && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none text-green-cream",
              hasCritical ? "bg-danger" : "bg-warn-strong"
            )}
          >
            {total}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[360px] gap-0 p-0 border border-rule rounded-md bg-surface"
      >
        <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2">
          <div className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">
            Critical alerts
            <span className="ml-2 tabular text-ink-2">{total}</span>
          </div>
          {total > 0 && (
            <button
              type="button"
              onClick={acknowledgeAll}
              disabled={bulkBusy}
              className="rounded border border-rule bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-2 hover:border-silver-line hover:text-ink disabled:opacity-50"
            >
              {bulkBusy ? "Acknowledging…" : "Acknowledge all"}
            </button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {!data || data.alerts.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-ink-3">
              No active alerts.
            </div>
          ) : (
            data.alerts.map((a) => (
              <div
                key={a.id}
                className="border-b border-rule px-3 py-2 last:border-0"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "inline-flex rounded px-1.5 py-0.5 text-[9.5px] font-mono uppercase",
                      a.severity === "CRITICAL"
                        ? "bg-danger-tint text-danger"
                        : a.severity === "HIGH"
                          ? "bg-warn-tint text-warn-strong"
                          : "bg-bg-elev text-ink-3"
                    )}
                  >
                    {a.severity}
                  </span>
                  <span className="text-[10.5px] font-mono text-ink-3">
                    {timeAgo(a.detectedAt)}
                  </span>
                </div>
                <div className="mt-1 text-[12.5px] font-medium text-ink leading-tight">
                  {a.title}
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-2 leading-snug">
                  {a.message}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                  {a.actionUrl ? (
                    <Link
                      href={a.actionUrl}
                      onClick={() => setOpen(false)}
                      className="font-medium text-green hover:text-green-deep"
                    >
                      View →
                    </Link>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => acknowledge(a.id)}
                    disabled={busy === a.id}
                    className="rounded border border-rule bg-surface px-2 py-0.5 font-medium text-ink-2 hover:border-silver-line hover:bg-bg-elev hover:text-ink disabled:opacity-50"
                  >
                    {busy === a.id ? "Acknowledging…" : "Acknowledge"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
