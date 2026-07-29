"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Btn,
  Panel,
  PanelBody,
  PanelHeader,
} from "@/components/kit";
import { cn } from "@/lib/utils";

type StandingWaveCommand = {
  commandId: string;
  operation: "START" | "RESUME";
  workspaceKey: string;
  status: string;
  outcome: string | null;
  requestedByUserId: string;
  requestedAt: string;
  updatedAt: string;
  executionStartedAt: string | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  planSha256: string | null;
  result: {
    waveId: string | null;
    targetCount: number | null;
    completedTargetCount: number;
    ambiguousTargetCount: number;
    actualProviderUnits: number | null;
    reportSha256: string | null;
    readinessReportSha256: string | null;
  } | null;
};

type StandingWaveStatus = {
  schemaVersion: string;
  status: "ACTIVE";
  canStart: boolean;
  activeCommandId: string | null;
  resumableCommandId: string | null;
  commands: StandingWaveCommand[];
  limits: {
    maxTargets: number;
    maxLinkedListings: number;
    maxProviderUnits: number;
    concurrency: number;
    retries: number;
  };
  claims: {
    standingPolicyAuthority: true;
    ownerPromptRequired: false;
    automaticRetry: false;
    marketplaceMutations: false;
  };
};

type ApiResponse = {
  ok: boolean;
  status: string;
  code?: string;
  message?: string;
  control?: {
    status: "OFF" | "ACTIVE";
    standing_authority: boolean;
    worker_claims: boolean;
    metered_execution: boolean;
    provider_calls_from_web: false;
    marketplace_mutations: false;
  };
  wave?: StandingWaveStatus;
};

function localTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function compactSha(value: string | null): string {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
}

function statusTone(status: string): string {
  if (status === "SUCCEEDED") {
    return "border-green/20 bg-green-soft text-green-ink";
  }
  if (status === "AMBIGUOUS" || status === "FAILED") {
    return "border-warn/25 bg-warn-tint text-warn-strong";
  }
  if (["ADMITTED", "CLAIMED", "RUNNING"].includes(status)) {
    return "border-blue-300/30 bg-blue-50 text-blue-700";
  }
  return "border-rule bg-bg-elev text-ink-3";
}

function StatusBadge({ children }: { children: string }) {
  return (
    <span className={cn(
      "inline-flex rounded-full border px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
      statusTone(children),
    )}>
      {children}
    </span>
  );
}

export function ProductTruthStandingWavePanel() {
  const [payload, setPayload] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<"START" | "RESUME" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/catalog/product-truth/standing-wave", {
        method: "GET",
        cache: "no-store",
        signal,
      });
      const value = await response.json() as ApiResponse;
      if (!response.ok || !value.ok) {
        throw new Error(
          `${value.code ? `${value.code}: ` : ""}${value.message ?? `HTTP ${response.status}`}`,
        );
      }
      setPayload(value);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : "Standing-wave status failed");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const active = payload?.wave?.activeCommandId ?? null;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const latest = payload?.wave?.commands[0] ?? null;
  const submit = async (
    operation: "START" | "RESUME",
    sourceCommandId: string | null,
  ) => {
    setSubmitting(operation);
    setError(null);
    try {
      const response = await fetch("/api/catalog/product-truth/standing-wave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: `ptsw-ui-${crypto.randomUUID()}`,
          operation,
          source_command_id: sourceCommandId,
        }),
      });
      const value = await response.json() as ApiResponse;
      if (!response.ok || !value.ok) {
        throw new Error(
          `${value.code ? `${value.code}: ` : ""}${value.message ?? `HTTP ${response.status}`}`,
        );
      }
      setPayload(value);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Standing-wave admission failed");
    } finally {
      setSubmitting(null);
    }
  };

  const limits = payload?.wave?.limits;
  const isOff = payload?.control?.status === "OFF";
  const canStart = payload?.wave?.canStart === true && !submitting;
  const resumable = payload?.wave?.resumableCommandId ?? null;
  const totalUnits = useMemo(
    () => payload?.wave?.commands.reduce(
      (total, command) => total + (command.result?.actualProviderUnits ?? 0),
      0,
    ) ?? 0,
    [payload],
  );

  return (
    <Panel>
      <PanelHeader
        title="Autonomous bounded enrichment waves"
        right={(
          <div className="flex items-center gap-2">
            <StatusBadge>
              {isOff ? "OFF" : active ? "RUNNING" : "READY"}
            </StatusBadge>
            <Btn
              variant="default"
              icon={<RefreshCw size={12} />}
              onClick={() => void load()}
              loading={loading}
            >
              Refresh
            </Btn>
          </div>
        )}
      />
      <PanelBody>
        <div className="grid gap-3 xl:grid-cols-[1.25fr_1fr]">
          <div>
            <div className="flex items-start gap-2 rounded-lg border border-green/20 bg-green-soft px-3 py-2.5">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-green-ink" />
              <div>
                <div className="text-[12px] font-semibold text-ink">
                  Pinned standing authority
                </div>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-3">
                  One existing Product Truth engine, exact Phase 1 manifest,
                  first-party Walmart evidence, concurrency 1 and no automatic retry.
                  The browser only admits an immutable command; provider work runs
                  in the separately authenticated clean-checkout worker.
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["Targets", limits?.maxTargets ?? 5],
                ["Listings", limits?.maxLinkedListings ?? 100],
                ["Max units", limits?.maxProviderUnits ?? 30],
                ["Concurrency", limits?.concurrency ?? 1],
                ["Retries", limits?.retries ?? 0],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-rule bg-bg-elev/35 px-2.5 py-2">
                  <div className="text-[9.5px] uppercase tracking-wide text-ink-4">
                    {label}
                  </div>
                  <div className="mt-0.5 font-mono text-[13px] font-semibold text-ink">
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-rule bg-bg-elev/25 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-4">
              Next safe action
            </div>
            {isOff ? (
              <div className="mt-3 flex items-start gap-2 text-[11px] text-warn-strong">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                Exact release/worker/policy activation is not configured. The UI
                cannot pretend a wave started.
              </div>
            ) : active ? (
              <div className="mt-3 flex items-start gap-2 text-[11px] text-ink-2">
                <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-blue-600" />
                Command <span className="font-mono">{active}</span> is running.
                Status refreshes every five seconds.
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <Btn
                  variant="primary"
                  icon={<Play size={13} />}
                  onClick={() => void submit("START", null)}
                  loading={submitting === "START"}
                  disabled={!canStart}
                >
                  Start next bounded wave
                </Btn>
                {resumable ? (
                  <Btn
                    variant="default"
                    icon={<RotateCcw size={13} />}
                    onClick={() => void submit("RESUME", resumable)}
                    loading={submitting === "RESUME"}
                    disabled={Boolean(submitting)}
                  >
                    Resume safely
                  </Btn>
                ) : null}
                <p className="text-[9.5px] leading-relaxed text-ink-4">
                  No marketplace writes, repricing, inventory changes, delisting,
                  consumer activation or procurement.
                </p>
              </div>
            )}
            {latest?.result ? (
              <div className="mt-3 border-t border-rule pt-2 text-[10px] text-ink-3">
                Latest: {latest.result.completedTargetCount} completed ·{" "}
                {latest.result.ambiguousTargetCount} ambiguous ·{" "}
                {latest.result.actualProviderUnits ?? "unknown"} units
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-tint px-3 py-2 text-[10.5px] text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between">
          <div className="text-[10px] font-medium uppercase tracking-wide text-ink-4">
            Durable command history
          </div>
          <div className="text-[10px] text-ink-4">
            reported units in view · {totalUnits}
          </div>
        </div>
        {!payload?.wave?.commands.length ? (
          <div className="mt-2 rounded-lg border border-dashed border-rule px-3 py-6 text-center text-[11px] text-ink-4">
            {loading ? "Reading standing-wave control queue…" : "No web-admitted standing waves yet."}
          </div>
        ) : (
          <div className="mt-2 divide-y divide-rule overflow-hidden rounded-lg border border-rule">
            {payload.wave.commands.map((command) => (
              <div
                key={command.commandId}
                className="grid gap-2 bg-surface px-3 py-2.5 md:grid-cols-[1.25fr_auto_auto_auto]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {command.status === "SUCCEEDED" ? (
                      <CheckCircle2 size={13} className="text-green-ink" />
                    ) : (
                      <Clock3 size={13} className="text-ink-4" />
                    )}
                    <span className="truncate font-mono text-[10.5px] text-ink">
                      {command.commandId}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[9px] text-ink-4">
                    plan {compactSha(command.planSha256)} · report{" "}
                    {compactSha(command.result?.reportSha256 ?? null)}
                  </div>
                </div>
                <div className="self-center"><StatusBadge>{command.status}</StatusBadge></div>
                <div className="self-center text-[10px] text-ink-3">
                  {command.operation} ·{" "}
                  {command.result?.actualProviderUnits ?? "—"} units
                </div>
                <div className="self-center text-right text-[9.5px] text-ink-4">
                  {localTime(command.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
