"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Thermometer,
  Package,
  BarChart3,
  RefreshCw,
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
} from "@/components/kit";
import IncidentsTable from "@/components/frozen-analytics/IncidentsTable";
import SkuRiskTable from "@/components/frozen-analytics/SkuRiskTable";
import PatternsDashboard from "@/components/frozen-analytics/PatternsDashboard";
import WalmartBaselineCard from "@/components/frozen-analytics/WalmartBaselineCard";

type TabKey = "incidents" | "sku-risk" | "patterns";

export default function FrozenAnalyticsPage() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("incidents");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [incidents, setIncidents] = useState<any[]>([]);
  const [incidentsTotal, setIncidentsTotal] = useState(0);
  const [incidentsLoading, setIncidentsLoading] = useState(false);
  const [incidentFilters, setIncidentFilters] = useState({
    carrier: "",
    service: "",
    days: "90",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [skuProfiles, setSkuProfiles] = useState<any[]>([]);
  const [skuLoading, setSkuLoading] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [patterns, setPatterns] = useState<any>(null);
  const [patternsLoading, setPatternsLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchIncidents = useCallback(async () => {
    setIncidentsLoading(true);
    try {
      const params = new URLSearchParams();
      if (incidentFilters.carrier) params.set("carrier", incidentFilters.carrier);
      params.set("days", incidentFilters.days);
      const res = await fetch(`/api/frozen/incidents?${params.toString()}`);
      const data = await res.json();
      setIncidents(data.incidents || []);
      setIncidentsTotal(data.total || 0);
    } catch {
      /* ignore */
    } finally {
      setIncidentsLoading(false);
    }
  }, [incidentFilters]);

  const fetchSkuProfiles = useCallback(async () => {
    setSkuLoading(true);
    try {
      const res = await fetch("/api/frozen/sku-risk");
      const data = await res.json();
      setSkuProfiles(data || []);
    } catch {
      /* ignore */
    } finally {
      setSkuLoading(false);
    }
  }, []);

  const fetchPatterns = useCallback(async () => {
    setPatternsLoading(true);
    try {
      const res = await fetch("/api/frozen/patterns");
      const data = await res.json();
      setPatterns(data);
    } catch {
      /* ignore */
    } finally {
      setPatternsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mounted) {
      fetchIncidents();
      fetchSkuProfiles();
      fetchPatterns();
    }
  }, [mounted, fetchIncidents, fetchSkuProfiles, fetchPatterns]);

  if (!mounted) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thawed = incidents.filter((i: any) => i.outcome === "thawed").length;
  const thawRate =
    incidentsTotal > 0 ? ((thawed / incidentsTotal) * 100).toFixed(1) : "0.0";
  const highRiskSkus = skuProfiles.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => p.riskLevel === "high" || p.riskLevel === "critical"
  ).length;

  return (
    <div className="space-y-5">
      <PageHead
        title="Frozen Analytics"
        subtitle={
          <>
            <span>Tampa, FL origin</span>
            <Sep />
            <span className="font-mono text-[10.5px] uppercase tracking-wider">
              Open-Meteo · temp-correlated
            </span>
            <Sep />
            <span className="tabular">
              Last {incidentFilters.days}d window
            </span>
          </>
        }
        actions={
          <>
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={() => {
                fetchIncidents();
                fetchSkuProfiles();
                fetchPatterns();
              }}
            >
              Refresh
            </Btn>
          </>
        }
      />

      {/* Walmart baseline */}
      <WalmartBaselineCard />

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Incidents"
          value={incidentsTotal}
          icon={<Thermometer size={14} />}
          iconVariant={incidentsTotal > 0 ? "warn" : "default"}
        />
        <KpiCard
          label="Thaw rate"
          value={`${thawRate}%`}
          icon={<Thermometer size={14} />}
          iconVariant={Number(thawRate) > 10 ? "danger" : "default"}
          trend={{
            value: `${thawed} thawed`,
            positive: Number(thawRate) < 5,
          }}
        />
        <KpiCard
          label="SKU profiles"
          value={skuProfiles.length}
          icon={<Package size={14} />}
          chips={
            highRiskSkus > 0
              ? [{ label: `${highRiskSkus} high risk`, variant: "urgent" }]
              : undefined
          }
        />
        <KpiCard
          label="Patterns detected"
          value={patterns?.patterns?.length ?? 0}
          icon={<BarChart3 size={14} />}
        />
      </div>

      {/* Tabs */}
      <FilterTabs
        tabs={[
          { id: "incidents", label: "Incidents log", count: incidentsTotal },
          { id: "sku-risk", label: "SKU risk", count: skuProfiles.length },
          {
            id: "patterns",
            label: "Patterns",
            count: patterns?.patterns?.length ?? 0,
          },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id)}
      />

      {/* Active panel */}
      {activeTab === "incidents" && (
        <Panel>
          <PanelHeader
            title="Frozen delivery incidents"
            right={
              incidentsLoading ? (
                <Loader2 size={14} className="animate-spin text-ink-3" />
              ) : (
                <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3 tabular">
                  {incidentsTotal} total
                </span>
              )
            }
          />
          <PanelBody>
            <IncidentsTable
              incidents={incidents}
              total={incidentsTotal}
              filters={incidentFilters}
              onFiltersChange={setIncidentFilters}
            />
          </PanelBody>
        </Panel>
      )}

      {activeTab === "sku-risk" && (
        <Panel>
          <PanelHeader
            title="SKU risk analysis"
            right={
              skuLoading ? (
                <Loader2 size={14} className="animate-spin text-ink-3" />
              ) : (
                <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3 tabular">
                  {skuProfiles.length} SKUs
                </span>
              )
            }
          />
          <PanelBody>
            <SkuRiskTable profiles={skuProfiles} />
          </PanelBody>
        </Panel>
      )}

      {activeTab === "patterns" && (
        <Panel>
          <PanelHeader title="Patterns & insights" />
          <PanelBody>
            {patternsLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 size={20} className="animate-spin text-ink-3" />
              </div>
            ) : patterns ? (
              <PatternsDashboard data={patterns} />
            ) : (
              <p className="py-8 text-center text-[13px] text-ink-3">No data yet</p>
            )}
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}
