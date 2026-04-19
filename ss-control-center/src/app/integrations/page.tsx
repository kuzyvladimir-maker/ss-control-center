"use client";

import { useState, useEffect } from "react";
import { Loader2, CheckCircle, XCircle, Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMounted } from "@/lib/use-mounted";

interface Integration {
  name: string;
  status: "connected" | "not_configured" | "error";
  detail: string;
}

export default function IntegrationsPage() {
  const mounted = useMounted();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.json())
      .then((d) => setIntegrations(d.integrations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (!mounted) return null;

  const connected = integrations.filter((i) => i.status === "connected").length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold text-ink">Integrations</h1>
        <p className="text-xs text-ink-3">
          {connected}/{integrations.length} services connected
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Checking connections...</span>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Service Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {integrations.map((item) => (
              <div
                key={item.name}
                className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-0"
              >
                <div className="flex items-center gap-3">
                  {item.status === "connected" ? (
                    <CheckCircle size={16} className="text-green-500" />
                  ) : item.status === "error" ? (
                    <XCircle size={16} className="text-red-500" />
                  ) : (
                    <Settings size={16} className="text-ink-4" />
                  )}
                  <span className="text-sm font-medium text-ink">
                    {item.name}
                  </span>
                </div>
                <span
                  className={`text-xs ${
                    item.status === "connected"
                      ? "text-green"
                      : item.status === "error"
                        ? "text-danger"
                        : "text-ink-3"
                  }`}
                >
                  {item.detail}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
