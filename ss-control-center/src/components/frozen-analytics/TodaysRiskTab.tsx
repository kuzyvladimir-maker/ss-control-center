"use client";

// Today's Risk — predictive alerts for the next 1-3 days.
// Operator can trigger a one-off pipeline run, see counts grouped by risk
// level, and act on each card.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Play } from "lucide-react";
import { Btn } from "@/components/kit";
import RiskAlertCard, {
  type RiskAlert,
} from "./RiskAlertCard";

interface RunSummary {
  processed: number;
  frozenOrders: number;
  alertsCreated: number;
  alertsUpdated: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

const LEVELS_DESC = ["critical", "high", "medium", "low"] as const;
const LEVEL_LABEL: Record<(typeof LEVELS_DESC)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const LEVEL_TINT: Record<(typeof LEVELS_DESC)[number], string> = {
  critical: "var(--danger)",
  high: "var(--warn-strong)",
  medium: "var(--warn)",
  low: "var(--green-mid)",
};

export default function TodaysRiskTab() {
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = showResolved ? "" : "pending";
      const url = status
        ? `/api/frozen/alerts?status=${status}&min_level=low&limit=200`
        : "/api/frozen/alerts?min_level=low&limit=200";
      const res = await fetch(url);
      const data = (await res.json()) as { alerts: RiskAlert[] };
      setAlerts(data.alerts ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [showResolved]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAnalysis() {
    setRunning(true);
    try {
      const res = await fetch("/api/frozen/run-analysis", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as RunSummary;
        setLastRun(data);
        await load();
      }
    } finally {
      setRunning(false);
    }
  }

  const grouped = useMemo(() => {
    const g: Record<string, RiskAlert[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };
    for (const a of alerts) {
      if (a.riskLevel in g) g[a.riskLevel].push(a);
    }
    return g;
  }, [alerts]);

  function applyUpdate(updated: RiskAlert) {
    setAlerts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule bg-surface-tint px-3 py-2.5">
        <div className="flex items-center gap-4 text-[12.5px] tabular">
          {LEVELS_DESC.map((lvl) => (
            <span key={lvl} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: LEVEL_TINT[lvl] }}
              />
              <span className="text-ink-3">{LEVEL_LABEL[lvl]}</span>
              <span className="font-semibold text-ink">
                {grouped[lvl].length}
              </span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="h-3 w-3 accent-[var(--green)]"
            />
            Include resolved
          </label>
          <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>
            Refresh
          </Btn>
          <Btn
            variant="primary"
            icon={<Play size={13} />}
            onClick={runAnalysis}
            loading={running}
          >
            Run analysis
          </Btn>
        </div>
      </div>

      {/* Last run banner */}
      {lastRun && (
        <div className="rounded-md border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">
          Scanned {lastRun.processed} orders → {lastRun.frozenOrders} frozen ·{" "}
          {lastRun.alertsCreated} new · {lastRun.alertsUpdated} updated ·{" "}
          {lastRun.skipped} skipped · {lastRun.errors} errors ·{" "}
          {Math.round(lastRun.durationMs / 100) / 10}s
        </div>
      )}

      {/* Empty state */}
      {!loading && alerts.length === 0 && (
        <div className="rounded-lg border border-rule bg-surface py-12 text-center">
          <p className="text-[13px] text-ink-2">
            No active risk alerts for the next 3 days.
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            Press <b className="text-ink">Run analysis</b> to refresh from
            Veeqo + Open-Meteo.
          </p>
        </div>
      )}

      {loading && alerts.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={18} className="animate-spin text-ink-3" />
        </div>
      )}

      {/* Groups */}
      {LEVELS_DESC.map((lvl) =>
        grouped[lvl].length > 0 ? (
          <section key={lvl}>
            <h3 className="mb-2 flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-ink-3">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: LEVEL_TINT[lvl] }}
              />
              {LEVEL_LABEL[lvl]} ({grouped[lvl].length})
            </h3>
            <div className="space-y-2">
              {grouped[lvl].map((a) => (
                <RiskAlertCard key={a.id} alert={a} onUpdate={applyUpdate} />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}
