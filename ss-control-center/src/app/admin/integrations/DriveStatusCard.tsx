"use client";

// Live snapshot of the Google Drive integration config — reads
// /api/integrations/drive-status and presents the env-var presence as
// green/red ticks so the operator can verify Vercel without leaving the
// admin page.

import { useEffect, useState } from "react";
import { Check, X, AlertTriangle, RefreshCw, CloudOff, Cloud } from "lucide-react";
import { Btn } from "@/components/kit";

interface DriveStatus {
  configured: boolean;
  reason: string | null;
  env: Record<string, boolean>;
  legacyServiceAccountWarning: string | null;
}

const REQUIRED_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_DRIVE_ROOT_FOLDER",
] as const;

export default function DriveStatusCard() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/drive-status");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setStatus(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="rounded border border-rule bg-surface p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {status?.configured ? (
            <Cloud size={16} className="text-green-ink" />
          ) : (
            <CloudOff size={16} className="text-warn-strong" />
          )}
          <div className="font-medium text-ink">Google Drive — status</div>
        </div>
        <Btn
          icon={<RefreshCw size={12} />}
          onClick={load}
          loading={loading}
          size="sm"
        >
          Refresh
        </Btn>
      </div>

      {error && (
        <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {status && (
        <>
          <div
            className={
              status.configured
                ? "rounded border border-green/30 bg-green-soft p-2 text-[12.5px] text-green-ink"
                : "rounded border border-warn-strong/40 bg-warn-tint p-2 text-[12.5px] text-warn-strong"
            }
          >
            {status.configured
              ? "Configured — purchased label PDFs will be uploaded to Drive."
              : `Not configured: ${status.reason}`}
          </div>

          <div className="space-y-1 text-[12px]">
            <div className="text-[10.5px] uppercase tracking-wider text-ink-3 font-mono">
              Env vars (production)
            </div>
            {REQUIRED_KEYS.map((k) => {
              const present = status.env[k];
              return (
                <div key={k} className="flex items-center gap-2 font-mono">
                  {present ? (
                    <Check size={12} className="text-green-ink" />
                  ) : (
                    <X size={12} className="text-danger" />
                  )}
                  <span className={present ? "text-ink" : "text-danger"}>
                    {k}
                  </span>
                </div>
              );
            })}
            {status.env.GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID && (
              <div className="flex items-center gap-2 font-mono text-ink-3">
                <Check size={12} className="text-ink-3" />
                <span>GOOGLE_DRIVE_SHIPPING_LABELS_FOLDER_ID (legacy alias)</span>
              </div>
            )}
          </div>

          {status.legacyServiceAccountWarning && (
            <div className="rounded border border-warn-strong bg-warn-tint p-2 text-[11.5px] text-warn-strong flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{status.legacyServiceAccountWarning}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
