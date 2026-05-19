/**
 * Bundle Factory — Compliance Gate dashboard.
 *
 * Four tabs (per docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md):
 *   1. Recent Decisions  — last 50 ComplianceCheck rows
 *   2. Blocked Drafts    — BundleDraft.compliance_status='BLOCKED'
 *   3. Brand Conflicts   — Rule 7's permanent blocklist + add form
 *   4. Audit Log         — paginated ComplianceAuditLog
 *
 * Server-side renders top-line KPIs from the database. Tab bodies are
 * client islands that fetch their data on activation (`CompliancePageClient`).
 */

import { prisma } from "@/lib/prisma";
import {
  PageHead,
  Sep,
  KpiCard,
} from "@/components/kit";
import {
  ShieldCheck,
  ShieldAlert,
  ListChecks,
  History,
} from "lucide-react";
import { CompliancePageClient } from "./CompliancePageClient";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const [totalChecks, canPublish, blocked, activeConflicts] = await Promise.all([
    prisma.complianceCheck.count(),
    prisma.complianceCheck.count({ where: { decision: "CAN_PUBLISH" } }),
    prisma.bundleDraft.count({ where: { compliance_status: "BLOCKED" } }),
    prisma.brandConflict.count({ where: { status: "active" } }),
  ]);

  return (
    <>
      <PageHead
        title="Compliance Gate"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              Protective gate between AI content generation and publish
            </span>
            <Sep />
            <span className="text-ink-3">
              {totalChecks} total checks · {canPublish} approved · {blocked}{" "}
              blocked drafts
            </span>
          </>
        }
        actions={
          <a
            href="https://github.com/kuzyvladimir-maker/ss-control-center/blob/main/docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 select-none items-center justify-center rounded-md border border-rule bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-bg-elev hover:text-ink"
          >
            View spec
          </a>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Total checks"
          value={totalChecks}
          icon={<ListChecks size={16} />}
        />
        <KpiCard
          label="Can publish"
          value={canPublish}
          icon={<ShieldCheck size={16} />}
        />
        <KpiCard
          label="Blocked drafts"
          value={blocked}
          icon={<ShieldAlert size={16} />}
          iconVariant="danger"
        />
        <KpiCard
          label="Active conflicts"
          value={activeConflicts}
          icon={<History size={16} />}
          iconVariant="warn"
        />
      </div>

      <CompliancePageClient />
    </>
  );
}
