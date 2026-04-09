"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, Camera, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import StoreTabs from "@/components/cs/StoreTabs";
import ImageUploader, { type ImageItem } from "@/components/cs/ImageUploader";
import AnalysisPanel from "@/components/cs/AnalysisPanel";
import ResponseEditor from "@/components/cs/ResponseEditor";
import CaseHistoryTable from "@/components/cs/CaseHistoryTable";
import type { CsAnalysisResult, CsCase } from "@/types";

interface StoreInfo {
  index: number;
  configured: boolean;
  channel: string;
  name: string;
  comingSoon?: boolean;
  error?: string;
}

export default function CustomerServicePage() {
  const [mounted, setMounted] = useState(false);

  // Stores
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [activeStore, setActiveStore] = useState(1);

  // Analyze tab
  const [images, setImages] = useState<ImageItem[]>([]);
  const [result, setResult] = useState<
    (CsAnalysisResult & { trackingUrl?: string | null }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isResponded, setIsResponded] = useState(false);

  // History tab
  const [cases, setCases] = useState<CsCase[]>([]);
  const [casesTotal, setCasesTotal] = useState(0);
  const [casesLoading, setCasesLoading] = useState(false);
  const [filters, setFilters] = useState({
    channel: "",
    category: "",
    priority: "",
    status: "",
  });

  const [todayCount, setTodayCount] = useState(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch stores
  useEffect(() => {
    if (!mounted) return;
    fetch("/api/amazon/stores")
      .then((r) => r.json())
      .then((d) => {
        setStores(d.stores || []);
        const first = (d.stores || []).find(
          (s: StoreInfo) => s.configured && !s.comingSoon
        );
        if (first) setActiveStore(first.index);
      })
      .catch(() => {});
  }, [mounted]);

  const fetchCases = useCallback(async () => {
    setCasesLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.channel) params.set("channel", filters.channel);
      if (filters.category) params.set("category", filters.category);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.status) params.set("status", filters.status);
      params.set("limit", "50");
      const res = await fetch(`/api/cs/cases?${params.toString()}`);
      const data = await res.json();
      setCases(data.cases || []);
      setCasesTotal(data.total || 0);
    } catch {
      /* ignore */
    } finally {
      setCasesLoading(false);
    }
  }, [filters]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/cs/stats");
      const data = await res.json();
      setTodayCount(data.today || 0);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (mounted) {
      fetchCases();
      fetchStats();
    }
  }, [mounted, fetchCases, fetchStats]);

  const analyze = async () => {
    if (images.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setIsResponded(false);
    try {
      const res = await fetch("/api/cs/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: images.map((img) => img.base64) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setResult(data);
      fetchCases();
      fetchStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  };

  const markResponded = async () => {
    if (!result?.id) return;
    try {
      await fetch(`/api/cs/cases/${result.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "responded" }),
      });
      setIsResponded(true);
      fetchCases();
    } catch {
      /* ignore */
    }
  };

  if (!mounted) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Badge variant="secondary">Today: {todayCount} cases</Badge>
      </div>

      {/* Store Tabs */}
      <StoreTabs
        stores={stores}
        activeStore={activeStore}
        onSelect={setActiveStore}
      />

      {/* Main content */}
      <Tabs defaultValue="analyze">
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="analyze" className="gap-1.5 px-4">
            <Camera size={15} />
            Analyze Case
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5 px-4">
            <History size={15} />
            Case History
          </TabsTrigger>
        </TabsList>

        {/* ========== ANALYZE TAB ========== */}
        <TabsContent value="analyze">
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Upload */}
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Camera size={16} />
                    Upload Screenshots
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ImageUploader
                    images={images}
                    onImagesChange={(imgs) => {
                      setImages(imgs);
                      setResult(null);
                      setError(null);
                    }}
                    disabled={loading}
                  />
                  <Button
                    onClick={analyze}
                    disabled={images.length === 0 || loading}
                    className="mt-3 w-full bg-blue-600 hover:bg-blue-700"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 animate-spin" size={14} />
                        Analyzing...
                      </>
                    ) : (
                      `Analyze ${images.length || 0} Screenshot${images.length !== 1 ? "s" : ""}`
                    )}
                  </Button>
                  {error && (
                    <p className="mt-2 text-xs text-red-600">{error}</p>
                  )}
                </CardContent>
              </Card>

              {/* Analysis */}
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Case Analysis</CardTitle>
                </CardHeader>
                <CardContent>
                  {result ? (
                    <AnalysisPanel result={result} />
                  ) : (
                    <p className="text-xs text-slate-400">
                      Upload and analyze screenshots to see results
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Response */}
            {result?.response && (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center justify-between">
                    Recommended Response
                    <Button
                      onClick={analyze}
                      variant="outline"
                      size="sm"
                      disabled={loading}
                    >
                      <RefreshCw size={12} className="mr-1" />
                      Regenerate
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponseEditor
                    response={result.response}
                    onMarkResponded={markResponded}
                    isResponded={isResponded}
                  />

                  <Separator className="my-3" />

                  {/* Supplier Reorder */}
                  {result.action === "REPLACEMENT" && (
                    <div className="rounded-md bg-orange-50 border border-orange-300 p-3 text-xs mb-3">
                      <p className="font-semibold text-orange-800 mb-1">
                        SUPPLIER REORDER REQUIRED
                      </p>
                      <p className="text-orange-700">
                        {result.product || "Product"} | {result.orderId || "—"} | {result.customerName || "—"}
                      </p>
                      <div className="mt-2 flex gap-3 text-[10px]">
                        <label className="flex items-center gap-1 text-orange-700">
                          <input type="checkbox" className="rounded" />
                          Ordered from supplier
                        </label>
                        <label className="flex items-center gap-1 text-orange-700">
                          <input type="checkbox" className="rounded" />
                          Shipped to customer
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Internal Notes */}
                  {result.internalNotes && (
                    <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                      <strong>Internal Notes:</strong>
                      <p className="mt-1 whitespace-pre-wrap">
                        {result.internalNotes}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* ========== HISTORY TAB ========== */}
        <TabsContent value="history">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center justify-between">
                Case History
                {casesLoading && (
                  <Loader2 size={14} className="animate-spin text-slate-400" />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CaseHistoryTable
                cases={cases}
                total={casesTotal}
                filters={filters}
                onFiltersChange={setFilters}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
