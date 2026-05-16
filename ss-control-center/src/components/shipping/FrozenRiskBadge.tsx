"use client";

// Compact badge + expandable panel shown on a Shipping Labels row when there
// is an active FrozenRiskAlert for that order. The operator can:
//   • see the predicted risk level at a glance (coloured chip)
//   • expand to read the destination weather + recommendations
//   • click Agree → marks the alert as `applied` (learning loop counts this
//     as "operator acted on the recommendation")
//   • click Disagree → marks as `ignored` (operator decided it's a false
//     positive)
// The buttons do NOT change anything in Veeqo. They drive the learning loop
// in the Patterns dashboard. Surfacing the recommendation here is the whole
// point — the operator sees it at the moment they're about to buy the label.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Check, X, Loader2 } from "lucide-react";
import { formatTemp, formatAnomaly } from "@/lib/units";
import { regenerateRecommendations } from "@/lib/frozen-analytics/format-recommendations";

export interface ShippingFrozenAlert {
  id: string;
  orderId: string; // Veeqo order number e.g. "113-4567890"
  riskLevel: string; // ok | low | medium | high | critical
  riskScore: number;
  shipDate: string;
  edd: string | null;
  transitDays: number | null;
  plannedCarrier: string | null;
  plannedService: string | null;
  destCity: string | null;
  destState: string | null;
  destZip: string;
  originTempF: number | null;
  destTempF: number | null;
  originTempMaxF: number | null;
  destTempMaxF: number | null;
  originAnomalyF: number | null;
  destAnomalyF: number | null;
  originWeatherDesc: string | null;
  destWeatherDesc: string | null;
  triggeredRules: string[];
  status: string;
  sku: string;
}

// Risk-level → display colour. Salutem tokens only — no hard-coded hex.
const PALETTE: Record<
  string,
  { bg: string; rail: string; text: string; label: string }
> = {
  low: {
    bg: "var(--green-soft)",
    rail: "var(--green-mid)",
    text: "var(--green-ink)",
    label: "LOW",
  },
  medium: {
    bg: "var(--warn-tint)",
    rail: "var(--warn)",
    text: "var(--warn-strong)",
    label: "MED",
  },
  high: {
    bg: "var(--warn-tint)",
    rail: "var(--warn-strong)",
    text: "var(--warn-strong)",
    label: "HIGH",
  },
  critical: {
    bg: "var(--danger-tint)",
    rail: "var(--danger)",
    text: "var(--danger)",
    label: "CRITICAL",
  },
};

export default function FrozenRiskBadge({
  alert: initial,
  onUpdate,
}: {
  alert: ShippingFrozenAlert;
  onUpdate?: (updated: ShippingFrozenAlert) => void;
}) {
  const [alert, setAlert] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const palette = PALETTE[alert.riskLevel] ?? PALETTE.medium;

  const recommendations = useMemo(
    () => regenerateRecommendations(alert),
    [alert],
  );

  async function patch(status: "applied" | "ignored") {
    setBusy(true);
    try {
      const res = await fetch(`/api/frozen/alerts/${alert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          shippingChoiceFollowed: status === "applied",
        }),
      });
      if (res.ok) {
        const next = { ...alert, status };
        setAlert(next);
        onUpdate?.(next);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-rule bg-surface-tint">
      {/* Header — clickable chip strip */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider tabular"
            style={{ background: palette.bg, color: palette.text }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: palette.rail }}
            />
            Frozen risk · {palette.label} · {alert.riskScore}
          </span>
          {alert.status === "applied" && (
            <span className="rounded-sm bg-green-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-green-ink">
              Applied
            </span>
          )}
          {alert.status === "ignored" && (
            <span className="rounded-sm bg-bg-elev px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-3">
              Ignored
            </span>
          )}
          {/* One-line summary so the operator can read without opening */}
          {!open && (
            <span className="truncate text-[11.5px] text-ink-2">
              {alert.destCity || alert.destZip}{" "}
              {alert.destState && `· ${alert.destState}`}{" "}
              <span className="font-mono">
                · {formatTemp(alert.destTempMaxF ?? alert.destTempF)} at delivery
              </span>
            </span>
          )}
        </span>
        <span className="text-ink-3">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {/* Body */}
      {open && (
        <div className="border-t border-rule px-3 pb-3 pt-2 text-[12px]">
          {/* Weather strip */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded border border-rule bg-surface px-2.5 py-1.5">
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
            <div className="rounded border border-rule bg-surface px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-mono">
                {alert.destCity || alert.destZip} · EDD {alert.edd || "—"}
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

          {/* Triggered rules */}
          {alert.triggeredRules.length > 0 && (
            <div className="mt-2 text-[10.5px] text-ink-3 font-mono">
              Rules: {alert.triggeredRules.join(" · ")}
            </div>
          )}

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12px] text-ink-2">
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
          )}

          {/* Footer actions — only meaningful when alert is still pending */}
          {alert.status === "pending" && (
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => patch("ignored")}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-surface px-2.5 py-1 text-[11.5px] text-ink hover:bg-bg-elev disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <X size={11} />
                )}
                Disagree
              </button>
              <button
                type="button"
                onClick={() => patch("applied")}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-green bg-green px-2.5 py-1 text-[11.5px] text-green-cream hover:bg-green-deep disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Check size={11} />
                )}
                Agree — apply recommendation
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
