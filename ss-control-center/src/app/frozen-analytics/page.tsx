"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Thermometer, Package, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import IncidentsTable from "@/components/frozen-analytics/IncidentsTable";
import SkuRiskTable from "@/components/frozen-analytics/SkuRiskTable";
import PatternsDashboard from "@/components/frozen-analytics/PatternsDashboard";
import WalmartBaselineCard from "@/components/frozen-analytics/WalmartBaselineCard";

export default function FrozenAnalyticsPage() {
  const [mounted, setMounted] = useState(false);

  // Incidents state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [incidents, setIncidents] = useState<any[]>([]);
  const [incidentsTotal, setIncidentsTotal] = useState(0);
  const [incidentsLoading, setIncidentsLoading] = useState(false);
  const [incidentFilters, setIncidentFilters] = useState({
    carrier: "",
    service: "",
    days: "90",
  });

  // SKU Risk state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [skuProfiles, setSkuProfiles] = useState<any[]>([]);
  const [skuLoading, setSkuLoading] = useState(false);

  // Patterns state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [patterns, setPatterns] = useState<any>(null);
  const [patternsLoading, setPatternsLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch incidents
  const fetchIncidents = useCallback(async () => {
    setIncidentsLoading(true);
    try {
      const params = new URLSearchParams();
      if (incidentFilters.carrier)
        params.set("carrier", incidentFilters.carrier);
      params.set("days", incidentFilters.days);
      const res = await fetch(`/api/frozen/incidents?${params.toString()}`);
      const data = await res.json();
      setIncidents(data.incidents || []);
      setIncidentsTotal(data.total || 0);
    } catch {
      console.error("Failed to fetch incidents");
    } finally {
      setIncidentsLoading(false);
    }
  }, [incidentFilters]);

  // Fetch SKU risk profiles
  const fetchSkuProfiles = useCallback(async () => {
    setSkuLoading(true);
    try {
      const res = await fetch("/api/frozen/sku-risk");
      const data = await res.json();
      setSkuProfiles(data || []);
    } catch {
      console.error("Failed to fetch SKU risk");
    } finally {
      setSkuLoading(false);
    }
  }, []);

  // Fetch patterns
  const fetchPatterns = useCallback(async () => {
    setPatternsLoading(true);
    try {
      const res = await fetch("/api/frozen/patterns");
      const data = await res.json();
      setPatterns(data);
    } catch {
      console.error("Failed to fetch patterns");
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

  return (
    <div className="space-y-6">
      <WalmartBaselineCard />
      <Tabs defaultValue="incidents">
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="incidents" className="gap-1.5 px-4">
            <Thermometer size={15} />
            Incidents Log
          </TabsTrigger>
          <TabsTrigger value="sku-risk" className="gap-1.5 px-4">
            <Package size={15} />
            SKU Risk Analysis
          </TabsTrigger>
          <TabsTrigger value="patterns" className="gap-1.5 px-4">
            <BarChart3 size={15} />
            Patterns & Insights
          </TabsTrigger>
        </TabsList>

        {/* Incidents Tab */}
        <TabsContent value="incidents">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                Frozen Delivery Incidents
                {incidentsLoading && (
                  <Loader2 size={16} className="animate-spin text-slate-400" />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <IncidentsTable
                incidents={incidents}
                total={incidentsTotal}
                filters={incidentFilters}
                onFiltersChange={setIncidentFilters}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* SKU Risk Tab */}
        <TabsContent value="sku-risk">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                SKU Risk Analysis
                {skuLoading && (
                  <Loader2 size={16} className="animate-spin text-slate-400" />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SkuRiskTable profiles={skuProfiles} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Patterns Tab */}
        <TabsContent value="patterns">
          {patternsLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 size={24} className="animate-spin text-slate-400" />
            </div>
          ) : patterns ? (
            <PatternsDashboard data={patterns} />
          ) : (
            <p className="text-sm text-slate-400 text-center py-8">
              No data yet
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
