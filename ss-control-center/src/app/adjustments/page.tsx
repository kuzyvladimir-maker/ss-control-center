"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  DollarSign,
  AlertTriangle,
  TrendingDown,
  Download,
} from "lucide-react";
import {
  Btn,
  FilterTabs,
  KpiCard,
  PageHead,
  Panel,
  PanelBody,
  PanelHeader,
  Sep,
  StoreAvatar,
} from "@/components/kit";
import { ChevronRight, Info, RefreshCw } from "lucide-react";
import AdjustmentsTable from "@/components/adjustments/AdjustmentsTable";
import AdjustmentsRegistry from "@/components/adjustments/AdjustmentsRegistry";
import SkuIssuesPanel from "@/components/adjustments/SkuIssuesPanel";
import {
  BoardLoading,
  CronHealthPanel,
  DisputeCases,
  DisputeSummary,
  StaleCronBanner,
  useDisputeBoard,
} from "@/components/adjustments/DisputeBoard";
import {
  AutopilotLearning,
  AutopilotQueue,
  useAutopilot,
} from "@/components/adjustments/DisputeAutopilot";
import { presetPeriod, ruDay, type Period } from "@/components/adjustments/PeriodPicker";

/**
 * Страница /adjustments.
 *
 * Наверху — то, что смотрят каждый день: сводка споров за период и кейсы.
 * Всё тяжёлое (очередь, реестр на тысячу строк, плейбук, кроны) — во вкладках,
 * чтобы страница помещалась в 2–3 экрана. Вкладки не размонтируются при
 * переключении: фильтры реестра и раскрытые строки сохраняются.
 */
type TabId = "queue" | "registry" | "learning" | "crons";

/** Свёрнутый по умолчанию блок внутри вкладки. */
function Accordion({
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-tint"
      >
        <ChevronRight size={14} className={`text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-[13.5px] font-semibold text-ink">{title}</span>
        {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
      </button>
      {open && <div className="border-t border-rule">{children}</div>}
    </Panel>
  );
}

interface Stats {
  thisMonth: number;
  thisMonthCount: number;
  last30Days: number;
  last30Count: number;
  amazonTotal: number;
  walmartTotal: number;
  problematicSkus: number;
  carriers?: Array<{ carrier: string; count: number; total: number }>;
  filtersApplied?: { channel: string; carrier: string; days: number };
}

interface SyncLogEntry {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  itemsSynced: number;
  error: string | null;
}

export default function AdjustmentsPage() {
  const [mounted, setMounted] = useState(false);

  // Stats
  const [stats, setStats] = useState<Stats | null>(null);

  // Adjustments list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [adjTotal, setAdjTotal] = useState(0);
  const [adjLoading, setAdjLoading] = useState(false);
  const [filters, setFilters] = useState({
    channel: "",
    days: "30",
    sku: "",
    carrier: "",
  });

  // Старая таблица по умолчанию свёрнута — рабочая поверхность теперь реестр.
  const [showLegacy, setShowLegacy] = useState(false);
  const [showSku, setShowSku] = useState(false);

  // Вкладка и период сводки
  const [tab, setTab] = useState<TabId>("queue");
  const [period, setPeriod] = useState<Period>(() => presetPeriod("all"));
  const boardState = useDisputeBoard(period);
  const autopilot = useAutopilot();

  // SKU profiles
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [skuProfiles, setSkuProfiles] = useState<any[]>([]);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.channel) params.set("channel", filters.channel);
      if (filters.carrier) params.set("carrier", filters.carrier);
      params.set("days", filters.days);
      const res = await fetch(`/api/adjustments/stats?${params.toString()}`);
      setStats(await res.json());
    } catch {
      // ignore
    }
  }, [filters]);

  const fetchAdjustments = useCallback(async () => {
    setAdjLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.channel) params.set("channel", filters.channel);
      if (filters.carrier) params.set("carrier", filters.carrier);
      params.set("days", filters.days);
      if (filters.sku) params.set("sku", filters.sku);
      const res = await fetch(`/api/adjustments?${params.toString()}`);
      const data = await res.json();
      setAdjustments(data.adjustments || []);
      setAdjTotal(data.total || 0);
    } catch {
      console.error("Failed to fetch adjustments");
    } finally {
      setAdjLoading(false);
    }
  }, [filters]);

  const fetchSkuProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/adjustments/sku-profiles");
      setSkuProfiles(await res.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchSyncLog = useCallback(async () => {
    try {
      const res = await fetch("/api/adjustments/sync-log");
      const data = await res.json();
      setSyncLog(data.entries || []);
    } catch {
      // ignore
    }
  }, []);

  const reloadBoard = boardState.reload;
  const reloadAutopilot = autopilot.reload;
  const refreshAll = useCallback(() => {
    if (showLegacy) {
      fetchStats();
      fetchAdjustments();
    }
    fetchSkuProfiles();
    fetchSyncLog();
    reloadBoard();
    reloadAutopilot();
  }, [showLegacy, fetchStats, fetchAdjustments, fetchSkuProfiles, fetchSyncLog, reloadBoard, reloadAutopilot]);

  /**
   * Three-step sync:
   *   1/3 Amazon Financial Events (real-time, ~5-10s, dollar totals only)
   *   2/3 Amazon Settlement Reports (~30-60s, adds order-id + SKU linkage)
   *   3/3 Walmart Recon Reports (~10-30s per available date,
   *       mirrors adjustment rows into ShippingAdjustment with
   *       channel='Walmart')
   */
  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      setSyncMessage("Step 1/3 — Amazon Financial Events…");
      const scanRes = await fetch("/api/adjustments/scan", { method: "POST" });
      const scanJson = await scanRes.json();
      if (!scanRes.ok) {
        throw new Error(scanJson.error || `Scan failed (${scanRes.status})`);
      }

      setSyncMessage(
        `Step 2/3 — Amazon Settlement Reports… (FE added ${scanJson.totalNewSaved} new)`,
      );
      const settleRes = await fetch("/api/adjustments/settlement-sync", {
        method: "POST",
      });
      const settleJson = await settleRes.json();
      if (!settleRes.ok) {
        throw new Error(
          settleJson.error || `Settlement sync failed (${settleRes.status})`,
        );
      }

      setSyncMessage(
        `Step 3/3 — Walmart Recon Reports… (Settlement +${settleJson.totalInserted}, ${settleJson.totalEnriched} enriched)`,
      );
      const walmartRes = await fetch("/api/adjustments/walmart/sync", {
        method: "POST",
        // Cap to last 8 settlement dates to keep the live sync snappy;
        // the daily cron walks the full history.
        body: JSON.stringify({ maxDates: 8 }),
        headers: { "Content-Type": "application/json" },
      });
      const walmartJson = await walmartRes.json();
      if (!walmartRes.ok) {
        // Don't fail the whole sync on Walmart-only errors — the
        // Walmart credentials may not be set for every environment.
        console.warn("Walmart sync failed:", walmartJson);
      }

      const walmartSummary = walmartRes.ok
        ? ` Walmart: +${walmartJson.totalAdjustmentsInserted ?? 0} adj inserted, ${walmartJson.totalAdjustmentsEnriched ?? 0} enriched.`
        : " Walmart sync skipped (check WALMART_* env).";

      setSyncMessage(
        `Done. Amazon FE: +${scanJson.totalNewSaved}. ` +
          `Settlement: +${settleJson.totalInserted}, ${settleJson.totalEnriched} enriched.` +
          walmartSummary,
      );
      refreshAll();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    if (mounted) {
      fetchSkuProfiles();
      fetchSyncLog();
    }
  }, [mounted, fetchSkuProfiles, fetchSyncLog]);

  // Старая таблица и её KPI грузятся, только когда её раскрыли.
  useEffect(() => {
    if (mounted && showLegacy) {
      fetchStats();
      fetchAdjustments();
    }
  }, [mounted, showLegacy, fetchStats, fetchAdjustments]);

  if (!mounted) return null;

  // Tab filter — filters adjustments by type / channel
  const channelTabs = [
    { id: "", label: "All", count: adjTotal },
    {
      id: "Amazon",
      label: "Amazon",
      count: adjustments.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => a.channel === "Amazon"
      ).length,
    },
    {
      id: "Walmart",
      label: "Walmart",
      count: adjustments.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => a.channel === "Walmart"
      ).length,
    },
  ];

  const { board, loading: boardLoading, error: boardError } = boardState;
  const tabs = [
    { id: "queue" as const, label: "Очередь споров", count: autopilot.data ? autopilot.fileable.length : undefined },
    { id: "registry" as const, label: "Реестр списаний" },
    { id: "learning" as const, label: "Плейбук и обучение" },
    {
      id: "crons" as const,
      label: "Здоровье крон",
      ...(board?.anyStale ? { tone: "danger" as const } : {}),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHead
        title="Adjustments"
        subtitle={
          board ? (
            <>
              <span className="tabular">
                Списания в базе: {ruDay(board.dataRange.firstCharge)} – {ruDay(board.dataRange.lastCharge)}
              </span>
              <Sep />
              <span className="font-mono text-[10.5px] uppercase tracking-wider">
                SP-API Finances v2024-06-19
              </span>
            </>
          ) : (
            <span>Loading…</span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <Btn
              icon={
                syncing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )
              }
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </Btn>
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={refreshAll}
              disabled={syncing}
            >
              Refresh
            </Btn>
          </div>
        }
      />

      {(syncMessage || syncError) && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-4 py-2.5 text-[12.5px] ${
            syncError
              ? "border-danger/20 bg-danger-tint text-danger-strong"
              : "border-rule bg-surface-tint text-ink-2"
          }`}
        >
          {syncError ? (
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={14} className="mt-0.5 shrink-0 text-ink-3" />
          )}
          <div>
            <strong className="text-ink">
              {syncError ? "Sync failed." : "Sync"}
            </strong>{" "}
            {syncError || syncMessage}
          </div>
        </div>
      )}

      {/* Сводка споров за период и кейсы — то, что смотрят каждый день */}
      {board ? (
        <>
          <StaleCronBanner board={board} />
          <DisputeSummary
            board={board}
            period={period}
            onPeriodChange={setPeriod}
            loading={boardLoading}
            onReload={reloadBoard}
          />
          <DisputeCases board={board} />
        </>
      ) : (
        <BoardLoading error={boardError} />
      )}

      {/* Остальное — во вкладках */}
      <FilterTabs<TabId> tabs={tabs} active={tab} onChange={setTab} />

      <div className={tab === "queue" ? "space-y-4" : "hidden"}>
        <AutopilotQueue data={autopilot.data} error={autopilot.error} />
      </div>

      <div className={tab === "registry" ? "space-y-4" : "hidden"}>
        <Panel>
          <PanelHeader
            title="Реестр списаний"
            right={
              <span className="text-[11.5px] text-ink-3">
                строка — одно списание; клик раскрывает начисление и историю спора
              </span>
            }
          />
          <PanelBody>
            <AdjustmentsRegistry />
          </PanelBody>
        </Panel>

        {/* Старая таблица. Оставлена свёрнутой: на ней висит копирование текста
            обращения и ручная отметка Case ID, которыми Владимир пользовался до
            реестра. Удалять до переноса этих сценариев нельзя. */}
        <Accordion
          title="Старая таблица (до реестра)"
          hint="KPI по каналам, чипы перевозчиков, копирование текста обращения"
          open={showLegacy}
          onToggle={() => setShowLegacy((v) => !v)}
        >
          <div className="space-y-4 p-4">
            {adjLoading && <Loader2 size={14} className="animate-spin text-ink-3" />}
            {stats && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <button
                  type="button"
                  onClick={() => setFilters({ ...filters, channel: "", carrier: "" })}
                  className="text-left transition-transform hover:scale-[1.01]"
                >
                  <KpiCard
                    label="This month"
                    value={`$${Math.abs(stats.thisMonth).toFixed(2)}`}
                    icon={<TrendingDown size={14} />}
                    iconVariant="warn"
                    trend={{ value: `${stats.thisMonthCount} adj`, positive: false }}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setFilters({ ...filters, channel: "", carrier: "" })}
                  className="text-left transition-transform hover:scale-[1.01]"
                >
                  <KpiCard
                    label="Last 30 days"
                    value={`$${Math.abs(stats.last30Days).toFixed(2)}`}
                    icon={<DollarSign size={14} />}
                    trend={{ value: `${stats.last30Count} adj`, positive: false }}
                  />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setFilters({
                      ...filters,
                      channel: filters.channel === "Amazon" ? "" : "Amazon",
                    })
                  }
                  className={`text-left transition-transform hover:scale-[1.01] ${
                    filters.channel === "Amazon" ? "ring-2 ring-warn rounded-lg" : ""
                  }`}
                >
                  <KpiCard
                    label={filters.channel === "Amazon" ? "Amazon (active)" : "Amazon"}
                    value={`$${Math.abs(stats.amazonTotal).toFixed(2)}`}
                    icon={<StoreAvatar store="salutem" size="sm" />}
                  />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setFilters({
                      ...filters,
                      channel: filters.channel === "Walmart" ? "" : "Walmart",
                    })
                  }
                  className={`text-left transition-transform hover:scale-[1.01] ${
                    filters.channel === "Walmart" ? "ring-2 ring-warn rounded-lg" : ""
                  }`}
                >
                  <KpiCard
                    label={filters.channel === "Walmart" ? "Walmart (active)" : "Walmart"}
                    value={`$${Math.abs(stats.walmartTotal).toFixed(2)}`}
                    icon={<StoreAvatar store="walmart" size="sm" />}
                  />
                </button>
              </div>
            )}

            {stats?.carriers && stats.carriers.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3">
                  Carrier:
                </span>
                <button
                  type="button"
                  onClick={() => setFilters({ ...filters, carrier: "" })}
                  className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                    !filters.carrier
                      ? "border-ink bg-ink text-bg"
                      : "border-rule bg-surface text-ink-2 hover:bg-surface-tint"
                  }`}
                >
                  All
                </button>
                {stats.carriers.map((c) => {
                  const label = c.carrier === "__none__" ? "Unknown" : c.carrier;
                  const active = filters.carrier === c.carrier;
                  return (
                    <button
                      key={c.carrier}
                      type="button"
                      onClick={() =>
                        setFilters({
                          ...filters,
                          carrier: active ? "" : c.carrier,
                        })
                      }
                      className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                        active
                          ? "border-ink bg-ink text-bg"
                          : "border-rule bg-surface text-ink-2 hover:bg-surface-tint"
                      }`}
                    >
                      <span className="font-medium">{label}</span>
                      <span className="ml-1.5 opacity-70 tabular">
                        {c.count} · ${Math.abs(c.total).toFixed(2)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <FilterTabs
              tabs={channelTabs}
              active={filters.channel}
              onChange={(id) => setFilters({ ...filters, channel: id })}
              rightSlot={
                <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3 tabular">
                  {adjTotal} rows · last {filters.days}d
                </span>
              }
            />

            <div className="max-h-[600px] overflow-auto">
              <AdjustmentsTable
                adjustments={adjustments}
                total={adjTotal}
                filters={filters}
                onFiltersChange={(f) =>
                  setFilters({
                    channel: f.channel,
                    days: f.days,
                    sku: f.sku,
                    carrier: f.carrier ?? "",
                  })
                }
              />
            </div>
          </div>
        </Accordion>

        <Accordion
          title="SKU с системными расхождениями"
          hint={
            stats && stats.problematicSkus > 0
              ? `${stats.problematicSkus} SKU поправлены 3+ раза за 30 дней — обновить SKU Database v2`
              : "нужно обновить SKU Database v2"
          }
          open={showSku}
          onToggle={() => setShowSku((v) => !v)}
        >
          <div className="p-4">
            <SkuIssuesPanel profiles={skuProfiles} />
          </div>
        </Accordion>
      </div>

      <div className={tab === "learning" ? "space-y-4" : "hidden"}>
        <AutopilotLearning data={autopilot.data} error={autopilot.error} />
      </div>

      <div className={tab === "crons" ? "space-y-4" : "hidden"}>
        {board && <CronHealthPanel board={board} />}

        {/* SP-API отдаёт списания с задержкой ~48 часов */}
        <div className="flex items-start gap-2 rounded-lg border border-rule bg-surface-tint px-4 py-2.5 text-[12.5px] text-ink-2">
          <Info size={14} className="mt-0.5 shrink-0 text-ink-3" />
          <div>
            <strong className="text-ink">Задержка SP-API.</strong> Amazon публикует корректировки
            доставки в Finances примерно через 48 часов после события — самые свежие строки
            появятся после следующего сбора.
          </div>
        </div>

        <Panel>
          <PanelHeader title="История ручных и ночных синхронизаций" count={syncLog.length} />
          <PanelBody className="max-h-[420px] overflow-auto">
            {syncLog.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">
                No syncs yet. Click <strong>Sync now</strong> above, or wait
                for the nightly cron at 08:30 UTC.
              </p>
            ) : (
              <table className="w-full text-[12.5px] tabular">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-rule text-left text-ink-3">
                    <th className="py-2 font-medium">Started</th>
                    <th className="font-medium">Job</th>
                    <th className="font-medium">Status</th>
                    <th className="font-medium tabular text-right">Items</th>
                    <th className="font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {syncLog.map((e) => {
                    const dur =
                      e.completedAt && e.startedAt
                        ? Math.round(
                            (new Date(e.completedAt).getTime() -
                              new Date(e.startedAt).getTime()) /
                              1000,
                          )
                        : null;
                    return (
                      <tr key={e.id} className="border-b border-rule/40">
                        <td className="py-2 text-ink-2">
                          {new Date(e.startedAt).toLocaleString()}
                        </td>
                        <td className="text-ink">{e.jobName}</td>
                        <td>
                          <span
                            className={
                              e.status === "done"
                                ? "text-success"
                                : e.status === "error"
                                  ? "text-danger"
                                  : "text-ink-3"
                            }
                          >
                            {e.status}
                          </span>
                        </td>
                        <td className="text-right text-ink">{e.itemsSynced}</td>
                        <td className="text-ink-3">
                          {dur != null ? `${dur}s` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
