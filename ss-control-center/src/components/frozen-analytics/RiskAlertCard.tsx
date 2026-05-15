"use client";

// One predictive risk alert. Operator can apply/ignore + leave notes.
// Visual: tinted left rail, weather strip, recommendations list, footer
// actions. Wording is dense and operator-style (no marketing tone).

import { useMemo, useState } from "react";
import { Check, X, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Btn } from "@/components/kit";
import { formatTemp, formatAnomaly } from "@/lib/units";
import { regenerateRecommendations } from "@/lib/frozen-analytics/format-recommendations";

export interface RiskAlert {
  id: string;
  orderId: string;
  storeName: string | null;
  channel: string;
  sku: string;
  productName: string | null;
  shipDate: string;
  edd: string | null;
  transitDays: number | null;
  plannedCarrier: string | null;
  plannedService: string | null;
  destZip: string;
  destCity: string | null;
  destState: string | null;
  originTempF: number | null;
  originTempMaxF: number | null;
  originNormalF: number | null;
  originAnomalyF: number | null;
  originWeatherDesc: string | null;
  destTempF: number | null;
  destTempMaxF: number | null;
  destNormalF: number | null;
  destAnomalyF: number | null;
  destWeatherDesc: string | null;
  riskLevel: string;
  riskScore: number;
  triggeredRules: string[];
  recommendations: string[];
  status: string;
  userNotes: string | null;
}

// Risk colour mapping — uses Salutem tokens (NOT Tailwind named colours)
// so the page stays consistent with the rest of the system.
const RAIL: Record<string, { bg: string; rail: string; text: string }> = {
  ok: {
    bg: "var(--green-soft)",
    rail: "var(--green)",
    text: "var(--green-ink)",
  },
  low: {
    bg: "var(--green-soft)",
    rail: "var(--green-mid)",
    text: "var(--green-ink)",
  },
  medium: {
    bg: "var(--warn-tint)",
    rail: "var(--warn)",
    text: "var(--warn-strong)",
  },
  high: {
    bg: "var(--warn-tint)",
    rail: "var(--warn-strong)",
    text: "var(--warn-strong)",
  },
  critical: {
    bg: "var(--danger-tint)",
    rail: "var(--danger)",
    text: "var(--danger)",
  },
};

export default function RiskAlertCard({
  alert,
  onUpdate,
}: {
  alert: RiskAlert;
  onUpdate?: (updated: RiskAlert) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState(alert.userNotes ?? "");

  const palette = RAIL[alert.riskLevel] ?? RAIL.medium;

  // Recommendations are rebuilt client-side so they always reflect the
  // current display unit (°C by default). The server-stored
  // alert.recommendations field is kept as a historical snapshot but not
  // shown directly to avoid stale unit text.
  const recommendations = useMemo(
    () => regenerateRecommendations(alert),
    [alert],
  );

  async function patchStatus(
    status: "applied" | "ignored",
    extra?: { userNotes?: string },
  ) {
    setBusy(true);
    try {
      const res = await fetch(`/api/frozen/alerts/${alert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...extra }),
      });
      if (res.ok) {
        const data = (await res.json()) as Partial<RiskAlert>;
        onUpdate?.({ ...alert, ...data, status });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes() {
    setBusy(true);
    try {
      const res = await fetch(`/api/frozen/alerts/${alert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userNotes: notes }),
      });
      if (res.ok) {
        onUpdate?.({ ...alert, userNotes: notes });
        setNotesOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-rule bg-surface"
      style={{ borderLeftWidth: 4, borderLeftColor: palette.rail }}
    >
      {/* Header — order id, store, level pill */}
      <div className="flex items-start justify-between gap-3 px-3.5 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-ink tabular">
              {alert.orderId}
            </span>
            {alert.storeName && (
              <span className="text-[11px] text-ink-3">{alert.storeName}</span>
            )}
            <span
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider tabular"
              style={{ background: palette.bg, color: palette.text }}
            >
              {alert.riskLevel} · {alert.riskScore}
            </span>
            {alert.status !== "pending" && (
              <span
                className="rounded-sm bg-surface-tint px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-3"
              >
                {alert.status}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] text-ink-2 truncate">
            {alert.productName || alert.sku}{" "}
            <span className="text-ink-3 font-mono text-[11px]">({alert.sku})</span>
          </p>
        </div>
      </div>

      {/* Body — weather + shipping plan */}
      <div className="grid grid-cols-1 gap-3 px-3.5 py-3 sm:grid-cols-2">
        {/* Weather strip */}
        <div className="rounded-md border border-rule bg-surface-tint px-3 py-2">
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-mono">
                Tampa · {alert.shipDate}
              </div>
              <div className="mt-0.5 font-semibold text-ink tabular">
                {formatTemp(alert.originTempMaxF ?? alert.originTempF)}
                {alert.originAnomalyF != null && (
                  <span
                    className="ml-1 text-[10px] font-normal"
                    style={{
                      color:
                        alert.originAnomalyF >= 5
                          ? "var(--warn-strong)"
                          : "var(--ink-3)",
                    }}
                  >
                    {formatAnomaly(alert.originAnomalyF)}
                  </span>
                )}
              </div>
              {alert.originWeatherDesc && (
                <div className="mt-0.5 text-[11px] text-ink-3">
                  {alert.originWeatherDesc}
                </div>
              )}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-mono">
                {alert.destCity || alert.destZip} · {alert.edd || "—"}
              </div>
              <div className="mt-0.5 font-semibold text-ink tabular">
                {formatTemp(alert.destTempMaxF ?? alert.destTempF)}
                {alert.destAnomalyF != null && (
                  <span
                    className="ml-1 text-[10px] font-normal"
                    style={{
                      color:
                        alert.destAnomalyF >= 5
                          ? "var(--warn-strong)"
                          : "var(--ink-3)",
                    }}
                  >
                    {formatAnomaly(alert.destAnomalyF)}
                  </span>
                )}
              </div>
              {alert.destWeatherDesc && (
                <div className="mt-0.5 text-[11px] text-ink-3">
                  {alert.destWeatherDesc}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Shipping plan strip */}
        <div className="rounded-md border border-rule bg-surface-tint px-3 py-2 text-[12px]">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-mono">
            Plan
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
            <span className="text-ink-3">Carrier</span>
            <span className="font-medium text-ink tabular">
              {alert.plannedCarrier?.toUpperCase() || "—"}
            </span>
            <span className="text-ink-3">Service</span>
            <span className="truncate text-ink">{alert.plannedService || "—"}</span>
            <span className="text-ink-3">Transit</span>
            <span className="font-medium text-ink tabular">
              {alert.transitDays != null ? `${alert.transitDays}d` : "—"}
            </span>
            <span className="text-ink-3">Rules</span>
            <span className="font-mono text-[10px] text-ink-2">
              {alert.triggeredRules.join(" ") || "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Recommendations — regenerated client-side so units always match the
          current display preference (°C by default). */}
      {recommendations.length > 0 && (
        <div className="px-3.5 pb-3">
          <ul className="space-y-1 text-[12.5px] text-ink-2">
            {recommendations.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full"
                  style={{ background: palette.rail }}
                />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Notes panel */}
      {notesOpen && (
        <div className="border-t border-rule px-3.5 py-2.5">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What did you change?"
            className="w-full resize-y rounded-md border border-rule bg-surface px-2 py-1.5 text-[12.5px] text-ink focus:border-silver-line focus:outline-none"
            rows={2}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Btn variant="ghost" size="sm" onClick={() => setNotesOpen(false)}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              onClick={saveNotes}
              loading={busy}
            >
              Save
            </Btn>
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 border-t border-rule px-3.5 py-2 text-[11px] text-ink-3">
        <button
          type="button"
          onClick={() => setNotesOpen((v) => !v)}
          className="inline-flex items-center gap-1 hover:text-ink"
        >
          {notesOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          Notes
          {alert.userNotes && (
            <span className="ml-1 text-[10px] text-ink-2">·</span>
          )}
        </button>
        {alert.status === "pending" ? (
          <div className="flex items-center gap-2">
            <Btn
              size="sm"
              icon={<X size={12} />}
              onClick={() => patchStatus("ignored")}
              loading={busy}
            >
              Ignore
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              icon={<Check size={12} />}
              onClick={() => patchStatus("applied")}
              loading={busy}
            >
              Apply
            </Btn>
          </div>
        ) : busy ? (
          <Loader2 size={12} className="animate-spin text-ink-3" />
        ) : null}
      </div>
    </div>
  );
}
