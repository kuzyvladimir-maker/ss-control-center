"use client";

// "Run Audit" client island for the audit overview page. Posts to
// /api/bundle-factory/audit/scan and pushes the operator straight to
// the new scan's detail page so they see progress live.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { Btn } from "@/components/kit";

export function RunAuditButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setRunning(true);
    setError(null);
    try {
      const resp = await fetch("/api/bundle-factory/audit/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initiated_by: "vladimir" }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${resp.status}`);
      }
      const { scan_id } = (await resp.json()) as { scan_id: string };
      router.push(`/bundle-factory/audit/${scan_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Btn
        variant="primary"
        onClick={go}
        loading={running}
        icon={running ? <Loader2 size={14} /> : <Play size={14} />}
      >
        {running ? "Starting…" : "Run full audit"}
      </Btn>
      {error && (
        <div className="text-[11.5px] text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
