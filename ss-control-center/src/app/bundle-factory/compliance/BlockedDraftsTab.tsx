"use client";

import { relativeTime, useFetchOnce } from "./CompliancePageClient";

interface BlockedDraftRow {
  id: string;
  draft_name: string;
  brand: string;
  category: string;
  pack_count: number;
  status: string;
  compliance_status: string;
  compliance_check_id: string | null;
  compliance_blocked_at: string | null;
  compliance_blocked_reasons: string | null;
  draft_title: string | null;
  target_channels: string;
  created_at: string;
  updated_at: string;
}

function parseReasons(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function BlockedDraftsTab({ refreshKey }: { refreshKey: number }) {
  const { data, loading, error } = useFetchOnce<{
    drafts: BlockedDraftRow[];
  }>("/api/bundle-factory/compliance/blocked-drafts?limit=100", refreshKey);

  if (loading) return <Empty label="Loading…" />;
  if (error) return <Empty label={`Error: ${error}`} error />;
  if (!data || data.drafts.length === 0)
    return (
      <Empty label="No drafts are currently blocked. New drafts that fail the gate will appear here for manual review." />
    );

  return (
    <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
      <table className="min-w-full text-[12.5px] text-ink">
        <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-3 py-2 text-left">Blocked at</th>
            <th className="px-3 py-2 text-left">Draft</th>
            <th className="px-3 py-2 text-left">Brand</th>
            <th className="px-3 py-2 text-left">Failed rules</th>
            <th className="px-3 py-2 text-left">Title</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {data.drafts.map((d) => {
            const reasons = parseReasons(d.compliance_blocked_reasons);
            return (
              <tr key={d.id} className="hover:bg-bg-elev/40">
                <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                  {relativeTime(d.compliance_blocked_at)}
                </td>
                <td className="px-3 py-2 text-ink">
                  {d.draft_name || (
                    <span className="font-mono text-[11.5px] text-ink-2">
                      {d.id.slice(0, 14)}…
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-2">{d.brand}</td>
                <td className="px-3 py-2 text-ink-2">
                  {reasons.length === 0 ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    reasons.join(", ")
                  )}
                </td>
                <td className="px-3 py-2 text-ink-3">
                  {d.draft_title ?? "—"}
                </td>
              </tr>
            );
          })}
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
