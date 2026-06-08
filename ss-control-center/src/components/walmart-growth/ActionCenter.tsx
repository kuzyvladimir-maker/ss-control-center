"use client";

/**
 * Walmart Growth — Action Center (the "doctor").
 *
 * Not a data dump: a ranked, plain-language list of what's wrong, why it costs
 * sales, how many items, and the action to take. Reads /api/walmart/growth/
 * diagnosis. Jump actions deep-link into the Listing Quality / Buy Box worklist
 * filtered to the affected items.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ArrowRight, Lock, Wrench, Hand } from "lucide-react";
import { Btn, Panel } from "@/components/kit";
import { cn } from "@/lib/utils";

type Severity = "critical" | "high" | "medium" | "low";
type ActionKind = "auto" | "semi" | "manual" | "gated";
interface Diagnosis {
  id: string;
  severity: Severity;
  title: string;
  problem: string;
  why: string;
  itemsAffected: number | null;
  metric?: string;
  recommendation: string;
  action: { kind: ActionKind; label: string; endpoint?: string; jumpFilter?: string; note?: string };
}
interface DiagnosisResult {
  generatedAt: string;
  sellerScore: number | null;
  headline: string;
  diagnoses: Diagnosis[];
  shipping: { maxTransitDays: number | null; templateCount: number; hasFastTemplate: boolean } | null;
}

const SEV: Record<Severity, { label: string; bg: string; color: string; dot: string }> = {
  critical: { label: "Critical", bg: "var(--danger-tint)", color: "var(--danger)", dot: "var(--danger)" },
  high: { label: "High", bg: "var(--warn-tint)", color: "var(--warn-strong)", dot: "var(--warn)" },
  medium: { label: "Medium", bg: "var(--silver-tint)", color: "var(--silver-dark)", dot: "var(--silver-dark)" },
  low: { label: "Low", bg: "var(--green-soft)", color: "var(--green-ink)", dot: "var(--green)" },
};

const KIND_ICON = { auto: Wrench, semi: Wrench, manual: Hand, gated: Lock } as const;

export function ActionCenter({ onJump }: { onJump: (filter: string) => void }) {
  const [data, setData] = useState<DiagnosisResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/walmart/growth/diagnosis");
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] text-ink-2">
          {loading && !data ? "Diagnosing…" : data?.headline ?? "No diagnosis yet."}
        </div>
        <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>
          Re-scan
        </Btn>
      </div>

      {data && data.diagnoses.length === 0 && !loading ? (
        <Panel>
          <div className="p-8 text-center text-[13px] text-ink-3">
            No major issues detected — or no data yet. Run a Listing Quality sync first.
          </div>
        </Panel>
      ) : (
        <div className="space-y-3">
          {data?.diagnoses.map((dg) => {
            const sev = SEV[dg.severity];
            const Icon = KIND_ICON[dg.action.kind];
            return (
              <Panel key={dg.id} className="overflow-hidden">
                <div className="flex gap-3 p-4">
                  <div className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: sev.dot }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{ background: sev.bg, color: sev.color }}
                      >
                        {sev.label}
                      </span>
                      <span className="text-[14px] font-semibold text-ink">{dg.title}</span>
                      {dg.metric && (
                        <span className="rounded bg-bg-elev px-1.5 py-0.5 text-[11px] font-medium text-ink-2 tabular">
                          {dg.metric}
                        </span>
                      )}
                      {dg.itemsAffected != null && (
                        <span className="text-[11.5px] text-ink-3 tabular">
                          {dg.itemsAffected.toLocaleString()} items
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[12.5px] text-ink-2">{dg.problem}</p>
                    <p className="mt-1 text-[12px] text-ink-3">
                      <span className="font-medium text-ink-2">Why it matters: </span>
                      {dg.why}
                    </p>
                    <p className="mt-1.5 text-[12.5px]">
                      <span className="font-medium text-green-ink">Fix: </span>
                      <span className="text-ink-2">{dg.recommendation}</span>
                    </p>
                    {dg.action.note && (
                      <p className="mt-1 text-[11px] text-ink-4">{dg.action.note}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-start">
                    {dg.action.jumpFilter ? (
                      <Btn
                        variant="outline"
                        icon={<ArrowRight size={13} />}
                        onClick={() => onJump(dg.action.jumpFilter!)}
                      >
                        {dg.action.label}
                      </Btn>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium",
                          dg.action.kind === "gated"
                            ? "bg-bg-elev text-ink-3"
                            : "bg-surface-tint text-ink-2 border border-rule"
                        )}
                      >
                        <Icon size={13} />
                        {dg.action.label}
                      </span>
                    )}
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {data?.shipping && (
        <p className="px-1 text-[11px] text-ink-4">
          Shipping templates: {data.shipping.templateCount} configured
          {data.shipping.maxTransitDays ? `, up to ${data.shipping.maxTransitDays}-day declared transit` : ""}
          {data.shipping.hasFastTemplate ? " (a fast ≤3-day template exists)" : " (no fast ≤3-day template)"}.
        </p>
      )}
    </div>
  );
}
