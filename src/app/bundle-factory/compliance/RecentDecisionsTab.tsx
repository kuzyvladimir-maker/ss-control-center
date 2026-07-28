"use client";

import { DecisionBadge, relativeTime, useFetchOnce } from "./CompliancePageClient";

interface ComplianceCheckRow {
  id: string;
  bundle_draft_id: string;
  channel_sku_id: string | null;
  decision: string;
  hard_rules_passed: string;
  hard_rules_failed: string;
  detected_brands: string | null;
  detected_logos: string | null;
  cost_cents: number;
  created_at: string;
}

function parseFailedReasons(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r: unknown) =>
        typeof r === "object" && r !== null
          ? String((r as Record<string, unknown>).rule_id ?? "")
          : "",
      )
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export function RecentDecisionsTab({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error } = useFetchOnce<{
    checks: ComplianceCheckRow[];
  }>("/api/bundle-factory/compliance/checks?limit=50", refreshKey);

  if (loading) return <EmptyState label="Loading…" />;
  if (error) return <EmptyState label={`Error: ${error}`} error />;
  if (!data || data.checks.length === 0)
    return (
      <EmptyState label="No compliance checks yet. They appear here once the Bundle Factory pipeline runs its first gate evaluation." />
    );

  return (
    <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
      <table className="min-w-full text-[12.5px] text-ink">
        <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-3 py-2 text-left">When</th>
            <th className="px-3 py-2 text-left">Decision</th>
            <th className="px-3 py-2 text-left">Bundle draft</th>
            <th className="px-3 py-2 text-left">Failed rules</th>
            <th className="px-3 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {data.checks.map((c) => {
            const failed = parseFailedReasons(c.hard_rules_failed);
            return (
              <tr key={c.id} className="hover:bg-bg-elev/40">
                <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                  {relativeTime(c.created_at)}
                </td>
                <td className="px-3 py-2">
                  <DecisionBadge decision={c.decision} />
                </td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-ink-2">
                  {c.bundle_draft_id.slice(0, 14)}…
                </td>
                <td className="px-3 py-2 text-ink-2">
                  {failed.length === 0 ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <span>{failed.join(", ")}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-3">
                  {(c.cost_cents / 100).toFixed(2)}¢
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({
  label,
  error = false,
}: {
  label: string;
  error?: boolean;
}) {
  return (
    <div
      className={`rounded-[14px] border p-6 text-center text-[12.5px] ${
        error
          ? "border-danger/30 bg-danger-tint/40 text-danger"
          : "border-rule bg-surface text-ink-3"
      }`}
    >
      {label}
    </div>
  );
}
