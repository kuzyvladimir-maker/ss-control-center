"use client";

import { useEffect, useState } from "react";
import {
  TrendingDown,
  ChevronDown,
  ChevronUp,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface LossBreakdown {
  refunds: { amount: number; count: number };
  partialRefunds: { amount: number; count: number };
  replacements: { amount: number; count: number };
  atozLost: { amount: number; count: number };
  chargebacksLost: { amount: number; count: number };
}

interface LossesResponse {
  period: number;
  store: string;
  total: number;
  breakdown: LossBreakdown;
  saved: { amount: number; count: number };
  config: { cogsPercent: number; replacementLabelCost: number };
}

interface LossesDashboardProps {
  period: number;
  store: string;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function BreakdownRow({
  label,
  amount,
  count,
  unit = "orders",
}: {
  label: string;
  amount: number;
  count: number;
  unit?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-ink-2">{label}</span>
      <div className="text-xs">
        <span className="font-medium text-ink">{fmtMoney(amount)}</span>
        <span className="text-ink-3 ml-2">
          ({count} {unit})
        </span>
      </div>
    </div>
  );
}

export default function LossesDashboard({
  period,
  store,
}: LossesDashboardProps) {
  const [data, setData] = useState<LossesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Parent passes a fresh `key` when period/store change, so this effect
  // only runs once per mount. Loading starts true and flips to false after
  // the first fetch completes.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      period: String(period),
      store,
    });
    fetch(`/api/customer-hub/losses?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: LossesResponse) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, store]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-3 text-xs text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Loading losses…
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="py-3 text-xs text-danger">
          {error || "No loss data available"}
        </CardContent>
      </Card>
    );
  }

  const { total, breakdown, saved } = data;

  return (
    <Card>
      <CardContent className="p-0">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-tint transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-danger-tint p-2">
              <TrendingDown size={16} className="text-danger" />
            </div>
            <div className="text-left">
              <p className="text-[10px] text-ink-3">
                Total losses · last {period} day{period !== 1 ? "s" : ""}
              </p>
              <p className="text-xl font-bold text-danger">{fmtMoney(total)}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {saved.amount > 0 && (
              <div className="text-right">
                <p className="text-[10px] text-ink-3 flex items-center gap-1 justify-end">
                  <ShieldCheck size={10} className="text-green" /> Saved
                </p>
                <p className="text-sm font-medium text-green">
                  {fmtMoney(saved.amount)}
                </p>
                <p className="text-[10px] text-ink-3">
                  {saved.count} claim{saved.count !== 1 ? "s" : ""} won
                </p>
              </div>
            )}
            {expanded ? (
              <ChevronUp size={16} className="text-ink-3" />
            ) : (
              <ChevronDown size={16} className="text-ink-3" />
            )}
          </div>
        </button>

        {expanded && (
          <div className="border-t border-slate-100 px-4 py-3 space-y-0">
            <BreakdownRow
              label="Refunds"
              amount={breakdown.refunds.amount}
              count={breakdown.refunds.count}
            />
            <BreakdownRow
              label="Partial refunds"
              amount={breakdown.partialRefunds.amount}
              count={breakdown.partialRefunds.count}
            />
            <BreakdownRow
              label="Replacements"
              amount={breakdown.replacements.amount}
              count={breakdown.replacements.count}
            />
            <BreakdownRow
              label="A-to-Z lost"
              amount={breakdown.atozLost.amount}
              count={breakdown.atozLost.count}
              unit="claims"
            />
            <BreakdownRow
              label="Chargebacks lost"
              amount={breakdown.chargebacksLost.amount}
              count={breakdown.chargebacksLost.count}
              unit="claims"
            />
            {total === 0 && (
              <p className="text-[10px] text-ink-3 pt-2 text-center">
                No losses recorded in this period.
              </p>
            )}
            <p className="text-[10px] text-ink-3 pt-2 border-t border-slate-100 mt-2">
              COGS {data.config.cogsPercent}% · replacement label{" "}
              {fmtMoney(data.config.replacementLabelCost)} · configurable in
              Settings
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
