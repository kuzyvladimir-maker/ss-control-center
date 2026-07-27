"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, RefreshCw } from "lucide-react";
import { Btn } from "@/components/kit";

const SNAPSHOT_ACCOUNT_ID = "channelmax:amznus:salutem-solutions";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function responseMessage(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["message", "error", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const key of ["error", "data", "result"]) {
    const nested = responseMessage(record[key]);
    if (nested) return nested;
  }
  return null;
}

function responseJobId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id === "string") return record.id;
  for (const key of ["job", "data", "result"]) {
    const nested = responseJobId(record[key]);
    if (nested) return nested;
  }
  return null;
}

export function ChannelMaxControls({
  storageReady,
  snapshotActive,
}: {
  storageReady: boolean;
  snapshotActive: boolean;
}) {
  const router = useRouter();
  const [enqueueing, setEnqueueing] = useState(false);
  const [notice, setNotice] = useState<
    | { kind: "success" | "error"; text: string }
    | null
  >(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [router]);

  async function enqueueSnapshot() {
    if (snapshotActive || enqueueing) return;
    setEnqueueing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/openclaw/channelmax/jobs", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "SNAPSHOT_INVENTORY",
          idempotency_key: `channelmax.snapshot.ui.${crypto.randomUUID()}`,
          priority: 10,
          max_attempts: 1,
          payload: {
            account_id: SNAPSHOT_ACCOUNT_ID,
            expected_active_rows: 164,
            include_inactive: false,
          },
        }),
      });

      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = null;
        }
      }

      if (!response.ok) {
        throw new Error(
          responseMessage(body) ??
            `ChannelMAX queue returned HTTP ${response.status}.`,
        );
      }

      const jobId = responseJobId(body);
      setNotice({
        kind: "success",
        text: jobId
          ? `Read-only snapshot ${jobId.slice(0, 10)}… queued.`
          : "Read-only inventory snapshot queued.",
      });
      router.refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not queue the read-only snapshot.",
      });
    } finally {
      setEnqueueing(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="hidden text-[11px] text-ink-3 sm:inline">
          Auto-refresh 10s
        </span>
        <Btn
          type="button"
          variant="outline"
          icon={<RefreshCw size={13} />}
          onClick={() => router.refresh()}
        >
          Refresh
        </Btn>
        <Btn
          type="button"
          variant="primary"
          icon={<Camera size={13} />}
          loading={enqueueing}
          disabled={!storageReady || snapshotActive}
          onClick={enqueueSnapshot}
        >
          {enqueueing
            ? "Queueing…"
            : snapshotActive
              ? "Snapshot in progress"
              : "Run read-only snapshot"}
        </Btn>
      </div>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`max-w-md text-right text-[11.5px] ${
            notice.kind === "error" ? "text-danger" : "text-green-ink"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
