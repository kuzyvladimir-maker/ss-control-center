/**
 * Bundle Factory — Audit scan detail.
 *
 * Server-renders the scan summary + initial result set; the interactive
 * table (filtering, polling, bulk actions) lives in
 * AuditResultsTable.tsx as a client island.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import { ArrowLeft } from "lucide-react";
import { AuditResultsTable } from "./AuditResultsTable";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ scanId: string }>;
  searchParams: Promise<{ risk?: string; account?: string }>;
}

export default async function AuditScanDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { scanId } = await params;
  const sp = await searchParams;

  const scan = await prisma.listingAuditScan.findUnique({
    where: { id: scanId },
  });
  if (!scan) return notFound();

  const results = await prisma.listingAuditResult.findMany({
    where: {
      scan_id: scanId,
      ...(sp.risk &&
      ["BLOCKED", "WARNING", "LOW_RISK", "COMPLIANT"].includes(sp.risk)
        ? { risk_category: sp.risk }
        : {}),
      ...(sp.account ? { account: sp.account } : {}),
    },
    orderBy: [{ risk_score: "desc" }, { created_at: "asc" }],
    take: 500,
  });

  // Convert to plain JSON (Dates as ISO strings) for the client island —
  // matches the shape /api/.../scans?id= returns when polling.
  const scanPlain = {
    ...scan,
    started_at: scan.started_at.toISOString(),
    completed_at: scan.completed_at
      ? scan.completed_at.toISOString()
      : null,
  };

  const accounts: string[] = (() => {
    try {
      const parsed = JSON.parse(scan.accounts_scanned);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  return (
    <>
      <div className="-mb-3">
        <Link
          href="/bundle-factory/audit"
          className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
        >
          <ArrowLeft size={14} /> Back to audit overview
        </Link>
      </div>
      <PageHead
        title="Scan detail"
        subtitle={
          <>
            <span className="font-mono text-[11.5px] text-ink-3">
              {scan.id}
            </span>
            <Sep />
            <span className="text-ink-2">
              {scan.total_listings} listings · {accounts.length} account
              {accounts.length === 1 ? "" : "s"}: {accounts.join(", ")}
            </span>
            <Sep />
            <span className="text-ink-3">
              {scan.completed_at
                ? `Completed ${scan.completed_at.toLocaleString()}`
                : `Started ${scan.started_at.toLocaleString()}`}
            </span>
          </>
        }
      />

      <AuditResultsTable scan={scanPlain} initialResults={results} />
    </>
  );
}
