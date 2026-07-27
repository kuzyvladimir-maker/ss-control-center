"use client";

import { DecisionBadge, relativeTime, useFetchOnce } from "./CompliancePageClient";

interface AuditLogEntry {
  id: string;
  bundle_draft_id: string;
  channel_sku_id: string | null;
  event_type: string;
  event_details: string;
  actor: string;
  decision: string | null;
  created_at: string;
}

function summariseDetails(json: string): string {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return "";
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.rule_summary)) {
      const failed = obj.rule_summary
        .filter(
          (r): r is { rule_id: string; passed: boolean } =>
            typeof r === "object" &&
            r !== null &&
            (r as { passed?: unknown }).passed === false,
        )
        .map((r) => r.rule_id);
      if (failed.length > 0) return `failed: ${failed.join(", ")}`;
      return "all rules passed";
    }
    return JSON.stringify(parsed).slice(0, 120);
  } catch {
    return "";
  }
}

export function AuditLogTab({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error } = useFetchOnce<{
    entries: AuditLogEntry[];
  }>("/api/bundle-factory/compliance/audit-log?limit=200", refreshKey);

  if (loading) return <Empty label="Loading…" />;
  if (error) return <Empty label={`Error: ${error}`} error />;
  if (!data || data.entries.length === 0)
    return (
      <Empty label="No audit-log entries yet. Every gate run, manual override, and pattern-detector trigger writes one row here." />
    );

  return (
    <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
      <table className="min-w-full text-[12.5px] text-ink">
        <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-3 py-2 text-left">When</th>
            <th className="px-3 py-2 text-left">Event</th>
            <th className="px-3 py-2 text-left">Actor</th>
            <th className="px-3 py-2 text-left">Decision</th>
            <th className="px-3 py-2 text-left">Bundle draft</th>
            <th className="px-3 py-2 text-left">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {data.entries.map((e) => (
            <tr key={e.id} className="hover:bg-bg-elev/40">
              <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                {relativeTime(e.created_at)}
              </td>
              <td className="px-3 py-2 text-ink-2">{e.event_type}</td>
              <td className="px-3 py-2 text-ink-3">{e.actor}</td>
              <td className="px-3 py-2">
                {e.decision ? <DecisionBadge decision={e.decision} /> : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-[11.5px] text-ink-2">
                {e.bundle_draft_id.slice(0, 14)}…
              </td>
              <td className="px-3 py-2 text-ink-3">
                {summariseDetails(e.event_details)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ label, error = false }: { label: string; error?: boolean }) {
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
