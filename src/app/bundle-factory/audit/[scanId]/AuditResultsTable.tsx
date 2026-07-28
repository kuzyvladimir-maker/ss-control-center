"use client";

// Client island for the audit scan detail page. Owns:
//   - Risk-category filter (URL ?risk=)
//   - Polling of /scans?id= while scan is still running
//   - Multi-select + "Mark for manual review" bulk action
//
// The initial result set is server-rendered into props; subsequent
// filtering re-fetches the API rather than client-side filtering so we
// don't blow up the table on 5k-listing scans.

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FilterTabs, Btn, RiskPill } from "@/components/kit";

type RiskCategory = "BLOCKED" | "WARNING" | "LOW_RISK" | "COMPLIANT" | "ALL";

interface AuditResultRow {
  id: string;
  asin: string;
  sku: string | null;
  account: string;
  title: string;
  brand: string;
  risk_score: number;
  risk_category: string;
  risk_reasons: string;
  detected_brands: string | null;
  remediation_status: string;
  main_image_url: string | null;
}

interface Scan {
  id: string;
  status: string;
  total_listings: number;
  blocked_count: number;
  warning_count: number;
  low_risk_count: number;
  compliant_count: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  accounts_scanned: string;
}

interface Props {
  scan: Scan;
  initialResults: AuditResultRow[];
}

export function AuditResultsTable({ scan: initialScan, initialResults }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const riskParam = (searchParams.get("risk") ?? "ALL") as RiskCategory;
  const accountParam = searchParams.get("account") ?? null;

  const [scan, setScan] = useState(initialScan);
  const [results, setResults] = useState(initialResults);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Poll scan status while running.
  useEffect(() => {
    if (scan.status !== "running" && scan.status !== "pending") return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(
          `/api/bundle-factory/audit/scans?id=${scan.id}`,
        );
        if (!r.ok) return;
        const { scan: latest } = (await r.json()) as { scan: Scan };
        setScan(latest);
        if (latest.status !== "running" && latest.status !== "pending") {
          // Final state — refresh results.
          await refreshResults(riskParam, accountParam);
        }
      } catch {
        /* swallow — next interval retries */
      }
    }, 4_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.id, scan.status]);

  async function refreshResults(risk: RiskCategory, account: string | null) {
    const qs = new URLSearchParams({ scan_id: scan.id, limit: "500" });
    if (risk !== "ALL") qs.set("risk_category", risk);
    if (account) qs.set("account", account);
    const r = await fetch(`/api/bundle-factory/audit/results?${qs}`);
    if (!r.ok) return;
    const { results: next } = (await r.json()) as { results: AuditResultRow[] };
    setResults(next);
    setSelected(new Set());
  }

  function setRisk(next: RiskCategory) {
    const url = new URL(window.location.href);
    if (next === "ALL") url.searchParams.delete("risk");
    else url.searchParams.set("risk", next);
    startTransition(() => router.replace(url.pathname + url.search));
    void refreshResults(next, accountParam);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(results.map((r) => r.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function markForManualReview() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const r = await fetch("/api/bundle-factory/audit/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_result_ids: Array.from(selected) }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      await refreshResults(riskParam, accountParam);
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  const tabs = [
    { id: "ALL" as RiskCategory, label: "All", count: scan.total_listings },
    {
      id: "BLOCKED" as RiskCategory,
      label: "Blocked",
      count: scan.blocked_count,
    },
    {
      id: "WARNING" as RiskCategory,
      label: "Warning",
      count: scan.warning_count,
    },
    {
      id: "LOW_RISK" as RiskCategory,
      label: "Low risk",
      count: scan.low_risk_count,
    },
    {
      id: "COMPLIANT" as RiskCategory,
      label: "Compliant",
      count: scan.compliant_count,
    },
  ];

  return (
    <div className="space-y-3">
      {(scan.status === "running" || scan.status === "pending") && (
        <div className="rounded-[14px] border border-warn-soft bg-warn-tint/50 px-3 py-2 text-[12.5px] text-warn-strong">
          Scan is {scan.status}. Results update as listings come in — you can
          start reviewing the table below; refresh happens automatically every
          few seconds.
        </div>
      )}

      {scan.error_message && (
        <details className="rounded-[14px] border border-danger-tint/60 bg-danger-tint/20 px-3 py-2 text-[12.5px]">
          <summary className="cursor-pointer font-medium text-danger">
            Scan had {scan.error_message.split("\n").length} error(s)
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11.5px] text-ink-2">
            {scan.error_message}
          </pre>
        </details>
      )}

      <FilterTabs
        tabs={tabs}
        active={riskParam}
        onChange={setRisk}
        rightSlot={
          selected.size > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-ink-2">
                {selected.size} selected
              </span>
              <Btn
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                disabled={bulkBusy}
              >
                Clear
              </Btn>
              <Btn
                size="sm"
                variant="primary"
                onClick={markForManualReview}
                loading={bulkBusy}
              >
                Mark for manual review
              </Btn>
            </div>
          ) : null
        }
      />

      {bulkError && (
        <div className="text-[11.5px] text-danger" role="alert">
          {bulkError}
        </div>
      )}

      {results.length === 0 ? (
        <div className="rounded-[14px] border border-rule bg-surface p-6 text-center text-[12.5px] text-ink-3">
          No listings match the current filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={
                      results.length > 0 && selected.size === results.length
                    }
                    onChange={() =>
                      selected.size === results.length
                        ? clearSelection()
                        : selectAllVisible()
                    }
                  />
                </th>
                <th className="px-3 py-2 text-left">Risk</th>
                <th className="px-3 py-2 text-left">ASIN</th>
                <th className="px-3 py-2 text-left">Account</th>
                <th className="px-3 py-2 text-left">Title</th>
                <th className="px-3 py-2 text-left">Reasons</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {results.map((r) => {
                const reasons = parseJson<string[]>(r.risk_reasons, []);
                return (
                  <tr key={r.id} className="hover:bg-bg-elev/40">
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <RiskScoreCell
                        score={r.risk_score}
                        category={r.risk_category}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <Link
                        href={`https://www.amazon.com/dp/${r.asin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[11.5px] text-green-ink hover:underline"
                      >
                        {r.asin}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-ink-2">
                      {r.account}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="max-w-[36rem] truncate text-ink">
                        {r.title}
                      </div>
                      <div className="text-[11px] text-ink-3">
                        {r.brand || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <ul className="space-y-0.5 text-[11.5px] text-ink-2">
                        {reasons.slice(0, 3).map((reason, i) => (
                          <li key={i}>· {reason}</li>
                        ))}
                        {reasons.length > 3 && (
                          <li className="text-ink-3">
                            +{reasons.length - 3} more
                          </li>
                        )}
                      </ul>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <RemediationBadge status={r.remediation_status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v as T;
  } catch {
    return fallback;
  }
}

function RiskScoreCell({
  score,
  category,
}: {
  score: number;
  category: string;
}) {
  const level =
    category === "BLOCKED"
      ? "high"
      : category === "WARNING"
        ? "medium"
        : category === "LOW_RISK"
          ? "low"
          : "ok";
  return (
    <div className="flex items-center gap-2">
      <RiskPill level={level as "high" | "medium" | "low" | "ok"} />
      <span className="font-mono text-[11.5px] tabular-nums text-ink-2">
        {score}
      </span>
    </div>
  );
}

function RemediationBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    PENDING: "bg-bg-elev text-ink-3",
    MANUAL_REVIEW: "bg-warn-tint text-warn-strong",
    REGENERATING: "bg-green-soft text-green-ink",
    UPDATED: "bg-green-soft text-green-ink",
    SKIPPED: "bg-bg-elev text-ink-3",
    FAILED: "bg-danger-tint text-danger",
  };
  const style = map[status] ?? "bg-bg-elev text-ink-3";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${style}`}
    >
      {status.toLowerCase().replace("_", " ")}
    </span>
  );
}
