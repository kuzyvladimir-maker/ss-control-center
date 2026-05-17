/**
 * Bundle Factory — Listing Audit overview.
 *
 * Shows:
 *   - 4 risk-summary KPIs from the most recent completed scan
 *   - Latest 10 scans (running ones first, then completed)
 *   - "Run full audit" button (client island)
 *
 * Phase 2.0a entry point — operator clicks "Run full audit" → scanner
 * starts in the background → page redirects to the scan detail view
 * where progress shows live.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep, KpiCard } from "@/components/kit";
import { ShieldAlert, AlertTriangle, CircleDot, CheckCircle2 } from "lucide-react";
import { RunAuditButton } from "./RunAuditButton";

export const dynamic = "force-dynamic";

function relativeTime(d: Date | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default async function AuditOverviewPage() {
  const [latest, recent, conflictCount] = await Promise.all([
    prisma.listingAuditScan.findFirst({
      where: { status: "completed" },
      orderBy: { completed_at: "desc" },
    }),
    prisma.listingAuditScan.findMany({
      orderBy: { started_at: "desc" },
      take: 10,
    }),
    prisma.brandConflict.count({ where: { status: "active" } }),
  ]);

  return (
    <>
      <PageHead
        title="Listing Audit"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              Scan all active Amazon listings for foreign-brand risk
            </span>
            <Sep />
            <span className="text-ink-3">
              {conflictCount} active brand conflict
              {conflictCount === 1 ? "" : "s"} in blocklist
            </span>
            {latest && (
              <>
                <Sep />
                <span className="text-ink-3">
                  Last completed scan: {relativeTime(latest.completed_at)} ·{" "}
                  {latest.total_listings} listings
                </span>
              </>
            )}
          </>
        }
        actions={<RunAuditButton />}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Blocked"
          value={latest?.blocked_count ?? 0}
          icon={<ShieldAlert size={16} />}
          iconVariant="danger"
          href={latest ? `/bundle-factory/audit/${latest.id}?risk=BLOCKED` : undefined}
        />
        <KpiCard
          label="Warning"
          value={latest?.warning_count ?? 0}
          icon={<AlertTriangle size={16} />}
          iconVariant="warn"
          href={latest ? `/bundle-factory/audit/${latest.id}?risk=WARNING` : undefined}
        />
        <KpiCard
          label="Low risk"
          value={latest?.low_risk_count ?? 0}
          icon={<CircleDot size={16} />}
          href={latest ? `/bundle-factory/audit/${latest.id}?risk=LOW_RISK` : undefined}
        />
        <KpiCard
          label="Compliant"
          value={latest?.compliant_count ?? 0}
          icon={<CheckCircle2 size={16} />}
          href={latest ? `/bundle-factory/audit/${latest.id}?risk=COMPLIANT` : undefined}
        />
      </div>

      <section>
        <h2 className="mb-2 text-[13px] font-semibold text-ink">Recent scans</h2>
        {recent.length === 0 ? (
          <div className="rounded-[14px] border border-rule bg-surface p-6 text-center text-[12.5px] text-ink-3">
            No audit scans yet. Click <span className="font-medium">Run full
            audit</span> above to start the first one.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
            <table className="min-w-full text-[12.5px] text-ink">
              <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left">Started</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-right">Listings</th>
                  <th className="px-3 py-2 text-right">Blocked</th>
                  <th className="px-3 py-2 text-right">Warning</th>
                  <th className="px-3 py-2 text-right">Low risk</th>
                  <th className="px-3 py-2 text-right">Compliant</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {recent.map((s) => (
                  <tr key={s.id} className="hover:bg-bg-elev/40">
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                      {relativeTime(s.started_at)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.total_listings}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-danger">
                      {s.blocked_count || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-warn-strong">
                      {s.warning_count || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">
                      {s.low_risk_count || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-3">
                      {s.compliant_count || "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/bundle-factory/audit/${s.id}`}
                        className="text-[11.5px] font-medium text-green-ink hover:underline"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style =
    status === "completed"
      ? "bg-green-soft text-green-ink"
      : status === "running"
        ? "bg-warn-tint text-warn-strong"
        : status === "failed"
          ? "bg-danger-tint text-danger"
          : "bg-bg-elev text-ink-3";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${style}`}
    >
      {status}
    </span>
  );
}
