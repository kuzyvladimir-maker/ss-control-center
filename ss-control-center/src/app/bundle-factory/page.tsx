/**
 * Bundle Factory — Overview page.
 *
 * Phase 1 is foundation: this page shows pipeline-wide counters drawn
 * straight from the new tables (MasterBundle, ChannelSKU, BundleDraft,
 * GenerationJob, UPCPool) so Vladimir can at-a-glance confirm the
 * database is wired and seeded. Real AI pipeline UI lands in Phase 5+.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead } from "@/components/kit";
import { Package2, Layers, FileBox, Globe2, FlaskConical } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function BundleFactoryOverviewPage() {
  // Parallel reads so the page renders in one round trip.
  const [
    masterCount,
    masterLiveCount,
    draftCount,
    skuCount,
    skuLiveCount,
    upcAvailable,
    upcAssigned,
    storeCount,
    jobsActive,
    briefsDraft,
    briefsResearching,
    briefsResearched,
  ] = await Promise.all([
    prisma.masterBundle.count(),
    prisma.masterBundle.count({ where: { lifecycle_status: "LIVE" } }),
    prisma.bundleDraft.count(),
    prisma.channelSKU.count(),
    prisma.channelSKU.count({ where: { lifecycle_status: "LIVE" } }),
    prisma.uPCPool.count({ where: { status: "AVAILABLE" } }),
    prisma.uPCPool.count({ where: { status: "ASSIGNED" } }),
    prisma.storeRegistry.count({ where: { is_active: true } }),
    prisma.generationJob.count({
      where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
    }),
    prisma.bundleDraft.count({ where: { status: "DRAFT" } }),
    prisma.generationStage.count({
      where: { stage: "RESEARCH", status: "IN_PROGRESS" },
    }),
    prisma.bundleDraft.count({ where: { status: "RESEARCHED" } }),
  ]);

  return (
    <>
      <PageHead
        title="Bundle Factory"
        subtitle={
          <>
            <span className="font-medium text-ink-2">Phase 1 foundation</span>
            <span className="text-ink-4">·</span>
            <span>
              AI-driven gift-set pipeline for Salutem Vita / Starfit across
              9 marketplace channels.
            </span>
          </>
        }
      />

      {/* KPI row — 4 metric cards. Salutem palette (cream surface, ink
          text, tabular numbers, lucide icon at 26px). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Master Bundles"
          value={masterCount}
          sub={`${masterLiveCount} live`}
          icon={<Layers size={20} strokeWidth={1.6} className="text-green" />}
        />
        <KpiCard
          label="Channel SKUs"
          value={skuCount}
          sub={`${skuLiveCount} live`}
          icon={<Globe2 size={20} strokeWidth={1.6} className="text-green-mid" />}
        />
        <KpiCard
          label="Drafts in flight"
          value={draftCount}
          sub={`${jobsActive} active jobs`}
          icon={<FileBox size={20} strokeWidth={1.6} className="text-info" />}
        />
        <KpiCard
          label="UPC Pool"
          value={upcAvailable}
          sub={`${upcAssigned} assigned · ${storeCount} stores`}
          icon={<Package2 size={20} strokeWidth={1.6} className="text-warn-strong" />}
        />
      </div>

      <div className="rounded-[14px] border border-rule bg-surface p-4">
        <div className="flex items-center gap-2">
          <FlaskConical size={16} strokeWidth={1.6} className="text-green-mid" />
          <h2 className="text-[13px] font-semibold text-ink">
            Research pipeline (Phase 2.1)
          </h2>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <MiniKpi
            label="Awaiting research"
            value={briefsDraft}
            href="/bundle-factory/briefs"
            hint="Briefs in DRAFT — click to kick off Stage 2"
          />
          <MiniKpi
            label="Researching now"
            value={briefsResearching}
            hint="Stage 2 currently calling Perplexity"
          />
          <MiniKpi
            label="Pending variation"
            value={briefsResearched}
            href="/bundle-factory/briefs"
            hint="Researched, awaiting Variation Matrix"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SectionCard
          title="Pipeline"
          body="The 7-stage pipeline (Brief → Research → Variation Matrix → Content → Image → Validation → Distribution) is scaffolded for Phase 1 but not yet executable. Drafts and Master Bundles created via API land here once the executor ships in Phase 5."
          links={[
            { href: "/bundle-factory/briefs", label: "Briefs →" },
            { href: "/bundle-factory/drafts", label: "Drafts →" },
            { href: "/bundle-factory/master-bundles", label: "Master Bundles →" },
          ]}
        />
        <SectionCard
          title="Foundation"
          body="Sourcing registry, brand/account mapping, UPC pool, and marketplace rules seed are loaded. Inspect them in the section pages below."
          links={[
            { href: "/bundle-factory/stores", label: "Stores (37) →" },
            { href: "/bundle-factory/settings", label: "Settings & UPC pool →" },
            { href: "/bundle-factory/live", label: "Live SKUs →" },
          ]}
        />
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: number;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3">
          {label}
        </div>
        {icon}
      </div>
      <div className="mt-2 font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
        {value.toLocaleString("en-US")}
      </div>
      {sub && (
        <div className="mt-2 text-[11.5px] tabular-nums text-ink-3">{sub}</div>
      )}
    </div>
  );
}

function MiniKpi({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  href?: string;
}) {
  const body = (
    <div className="rounded-lg border border-rule bg-bg-elev/40 px-3 py-2 transition-colors hover:bg-bg-elev">
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mt-1 font-mono text-[20px] font-semibold leading-none tabular-nums text-ink">
        {value.toLocaleString("en-US")}
      </div>
      {hint && (
        <div className="mt-1.5 text-[11px] leading-tight text-ink-3">{hint}</div>
      )}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function SectionCard({
  title,
  body,
  links,
}: {
  title: string;
  body: string;
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface p-4">
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-[12px] font-medium text-green hover:text-green-deep"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
