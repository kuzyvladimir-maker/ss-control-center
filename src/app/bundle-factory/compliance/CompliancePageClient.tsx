"use client";

/**
 * Tabbed body for /bundle-factory/compliance.
 *
 * Each tab fetches its own data on activation. We deliberately do NOT
 * fetch all 4 tabs server-side — the tables can be hundreds of rows and
 * Vladimir typically only opens one tab per session. Loading on demand
 * keeps the page light and keeps the dashboard cheap on Turso.
 */

import { useCallback, useEffect, useState } from "react";
import { FilterTabs, type FilterTab, Btn } from "@/components/kit";
import { RecentDecisionsTab } from "./RecentDecisionsTab";
import { BlockedDraftsTab } from "./BlockedDraftsTab";
import { BrandConflictsTab } from "./BrandConflictsTab";
import { AuditLogTab } from "./AuditLogTab";

type TabId = "decisions" | "blocked" | "conflicts" | "audit-log";

export function CompliancePageClient() {
  const [active, setActive] = useState<TabId>("decisions");
  const [refreshKey, setRefreshKey] = useState(0);

  const tabs: FilterTab<TabId>[] = [
    { id: "decisions", label: "Recent Decisions" },
    { id: "blocked", label: "Blocked Drafts" },
    { id: "conflicts", label: "Brand Conflicts" },
    { id: "audit-log", label: "Audit Log" },
  ];

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <section className="mt-4 space-y-3">
      <FilterTabs
        tabs={tabs}
        active={active}
        onChange={setActive}
        rightSlot={
          <Btn size="sm" variant="ghost" onClick={refresh}>
            Refresh
          </Btn>
        }
      />

      <div>
        {active === "decisions" && <RecentDecisionsTab refreshKey={refreshKey} />}
        {active === "blocked" && <BlockedDraftsTab refreshKey={refreshKey} />}
        {active === "conflicts" && (
          <BrandConflictsTab refreshKey={refreshKey} onChange={refresh} />
        )}
        {active === "audit-log" && <AuditLogTab refreshKey={refreshKey} />}
      </div>
    </section>
  );
}

// Shared helpers re-exported for individual tab modules.
export function useFetchOnce<T>(
  url: string,
  refreshKey: number,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const json = (await r.json()) as T;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, refreshKey]);
  return { data, loading, error };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const ms = Date.now() - t;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function DecisionBadge({ decision }: { decision: string }) {
  const style =
    decision === "CAN_PUBLISH"
      ? "bg-green-soft text-green-ink"
      : decision === "BLOCKED"
        ? "bg-danger-tint text-danger"
        : "bg-bg-elev text-ink-3";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${style}`}
    >
      {decision}
    </span>
  );
}
