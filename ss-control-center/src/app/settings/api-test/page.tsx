"use client";

import { useState, useEffect } from "react";
import { Loader2, RefreshCw, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface StoreResult {
  store: number;
  status: "ok" | "error" | "not_configured";
  message: string;
  details?: {
    marketplaces?: string;
    tokenPreview?: string;
    participationsCount?: number;
  };
}

interface TestResults {
  summary: {
    configured: number;
    connected: number;
    failed: number;
  };
  stores: StoreResult[];
  timestamp: string;
}

export default function ApiTestPage() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<TestResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const runTest = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/test");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResults(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (mounted) runTest();
  }, [mounted]);

  if (!mounted) return null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800">
          Amazon SP-API Connection Test
        </h1>
        <Button
          variant="outline"
          size="sm"
          onClick={runTest}
          disabled={loading}
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin mr-1" />
          ) : (
            <RefreshCw size={14} className="mr-1" />
          )}
          Re-test
        </Button>
      </div>

      {loading && !results && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Testing connections...</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {results && (
        <>
          {/* Summary */}
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-4 text-sm">
                <span className="text-slate-500">Summary:</span>
                {results.summary.connected > 0 && (
                  <Badge className="bg-green-100 text-green-700">
                    {results.summary.connected} connected
                  </Badge>
                )}
                {results.summary.failed > 0 && (
                  <Badge className="bg-red-100 text-red-700">
                    {results.summary.failed} failed
                  </Badge>
                )}
                <span className="text-xs text-slate-400 ml-auto">
                  {new Date(results.timestamp).toLocaleTimeString()}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Store results */}
          <div className="space-y-3">
            {results.stores.map((store) => (
              <Card
                key={store.store}
                className={
                  store.status === "ok"
                    ? "border-green-200"
                    : store.status === "error"
                      ? "border-red-200"
                      : "border-slate-200"
                }
              >
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    {store.status === "ok" && (
                      <CheckCircle size={20} className="text-green-500 mt-0.5 shrink-0" />
                    )}
                    {store.status === "error" && (
                      <XCircle size={20} className="text-red-500 mt-0.5 shrink-0" />
                    )}
                    {store.status === "not_configured" && (
                      <AlertTriangle size={20} className="text-slate-300 mt-0.5 shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-slate-800">
                          Store {store.store}
                        </span>
                        <Badge
                          className={
                            store.status === "ok"
                              ? "bg-green-100 text-green-700"
                              : store.status === "error"
                                ? "bg-red-100 text-red-700"
                                : "bg-slate-100 text-slate-400"
                          }
                        >
                          {store.status === "ok"
                            ? "Connected"
                            : store.status === "error"
                              ? "Error"
                              : "Not configured"}
                        </Badge>
                      </div>

                      {store.status === "ok" && store.details && (
                        <div className="mt-2 text-xs text-slate-500 space-y-1">
                          {store.details.marketplaces && (
                            <p>
                              <span className="text-slate-400">Marketplaces:</span>{" "}
                              {store.details.marketplaces}
                            </p>
                          )}
                          {store.details.tokenPreview && (
                            <p>
                              <span className="text-slate-400">Token:</span>{" "}
                              <code className="bg-slate-100 px-1 rounded text-[10px]">
                                {store.details.tokenPreview}
                              </code>
                            </p>
                          )}
                        </div>
                      )}

                      {store.status === "error" && (
                        <p className="mt-1 text-xs text-red-600 break-all">
                          {store.message}
                        </p>
                      )}

                      {store.status === "not_configured" && (
                        <p className="mt-1 text-xs text-slate-400">
                          {store.message}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
