"use client";

/**
 * Amazon Growth — Action Center (the "doctor").
 *
 * Ranked, plain-language list of what's wrong, why it costs sales, how many
 * listings, and the action. Reads /api/amazon/growth/diagnosis. Jump actions
 * deep-link into the Listing Health worklist filtered to the affected items.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ArrowRight, Lock, Wrench, Hand, ChevronDown } from "lucide-react";
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
}

const SEV: Record<Severity, { label: string; bg: string; color: string; dot: string }> = {
  critical: { label: "Critical", bg: "var(--danger-tint)", color: "var(--danger)", dot: "var(--danger)" },
  high: { label: "High", bg: "var(--warn-tint)", color: "var(--warn-strong)", dot: "var(--warn)" },
  medium: { label: "Medium", bg: "var(--silver-tint)", color: "var(--silver-dark)", dot: "var(--silver-dark)" },
  low: { label: "Low", bg: "var(--green-soft)", color: "var(--green-ink)", dot: "var(--green)" },
};

const KIND_ICON = { auto: Wrench, semi: Wrench, manual: Hand, gated: Lock } as const;

function bigStat(dg: Diagnosis): { value: string; sub: string } {
  if (dg.metric) {
    const m = dg.metric.match(/(\d+)\s*\/\s*100/);
    if (m) return { value: m[1], sub: "/100" };
  }
  if (dg.itemsAffected != null) return { value: dg.itemsAffected.toLocaleString(), sub: "items" };
  return { value: "—", sub: "" };
}

export function ActionCenter({
  storeIndex,
  onJump,
}: {
  storeIndex: number;
  onJump: (filter: string) => void;
}) {
  const [data, setData] = useState<DiagnosisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/amazon/growth/diagnosis?storeIndex=${storeIndex}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [storeIndex]);
  useEffect(() => {
    load();
  }, [load]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] text-ink-2">
          {loading && !data ? "Diagnosing…" : (data?.headline ?? "No diagnosis yet.")}
        </div>
        <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>
          Re-scan
        </Btn>
      </div>

      {data && data.diagnoses.length === 0 && !loading ? (
        <Panel>
          <div className="p-8 text-center text-[13px] text-ink-3">
            No major issues detected — or no data yet. Run a Listing Health sync first.
          </div>
        </Panel>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data?.diagnoses.map((dg) => {
            const sev = SEV[dg.severity];
            const Icon = KIND_ICON[dg.action.kind];
            const stat = bigStat(dg);
            const isOpen = open.has(dg.id);
            return (
              <Panel key={dg.id} className="overflow-hidden">
                <div className="flex items-center gap-3 p-3" style={{ borderLeft: `3px solid ${sev.dot}` }}>
                  <div
                    className="flex h-12 w-14 shrink-0 flex-col items-center justify-center rounded-lg"
                    style={{ background: sev.bg }}
                  >
                    <span className="text-[18px] font-semibold leading-none tabular" style={{ color: sev.color }}>
                      {stat.value}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider" style={{ color: sev.color }}>
                      {stat.sub}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                        style={{ background: sev.bg, color: sev.color }}
                      >
                        {sev.label}
                      </span>
                      {dg.itemsAffected != null && (
                        <span className="text-[11px] text-ink-3 tabular">{dg.itemsAffected.toLocaleString()} listings</span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">{dg.title}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {dg.action.jumpFilter ? (
                      <Btn size="sm" variant="outline" icon={<ArrowRight size={13} />} onClick={() => onJump(dg.action.jumpFilter!)}>
                        {dg.action.label}
                      </Btn>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
                          dg.action.kind === "gated"
                            ? "bg-bg-elev text-ink-3"
                            : "bg-surface-tint text-ink-2 border border-rule",
                        )}
                      >
                        <Icon size={12} />
                        {dg.action.label}
                      </span>
                    )}
                    <button
                      onClick={() => toggle(dg.id)}
                      className="rounded p-1 text-ink-3 hover:bg-bg-elev hover:text-ink"
                      aria-label="Details"
                    >
                      <ChevronDown size={15} className={cn("transition-transform", isOpen && "rotate-180")} />
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-rule bg-bg-elev/30 px-4 py-3 text-[12px]">
                    <p className="text-ink-2">{dg.problem}</p>
                    <p className="mt-1.5 text-ink-3">
                      <span className="font-medium text-ink-2">Why it matters: </span>
                      {dg.why}
                    </p>
                    <p className="mt-1.5">
                      <span className="font-medium text-green-ink">Fix: </span>
                      <span className="text-ink-2">{dg.recommendation}</span>
                    </p>
                    {dg.action.note && <p className="mt-1 text-[11px] text-ink-4">{dg.action.note}</p>}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
