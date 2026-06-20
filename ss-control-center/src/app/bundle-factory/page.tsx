/**
 * Bundle Factory — Overview / entry page.
 *
 * Phase 7 redesign: this page must answer one question on open — "what do I
 * do here?" — so it LEADS with a single green primary action (start a build)
 * and a plain three-step explanation. The pipeline counters are demoted to a
 * quiet secondary strip; they are status, not the task.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, HeroGreenCard, HeroLabel } from "@/components/kit";
import { ArrowRight, PackageSearch, Sparkles, Eye } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function BundleFactoryOverviewPage() {
  // Parallel reads so the page renders in one round trip.
  const [
    masterCount,
    masterLiveCount,
    draftCount,
    skuCount,
    upcAvailable,
  ] = await Promise.all([
    prisma.masterBundle.count(),
    prisma.masterBundle.count({ where: { lifecycle_status: "LIVE" } }),
    prisma.bundleDraft.count(),
    prisma.channelSKU.count(),
    prisma.uPCPool.count({ where: { status: "AVAILABLE" } }),
  ]);

  return (
    <>
      <PageHead
        title="Bundle Factory"
        subtitle={
          <>
            <span>Build new gift-set listings for </span>
            <span className="font-medium text-ink-2">Salutem Vita / Starfit</span>
            <span> — from your catalog to a marketplace-ready listing you approve.</span>
          </>
        }
      />

      {/* PRIMARY ACTION — the one thing to do on this page. */}
      <HeroGreenCard className="p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <HeroLabel>Create listings</HeroLabel>
            <h2 className="mt-2 text-[22px] font-semibold leading-tight tracking-[-0.02em]">
              Build a gift-set listing from your catalog
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: "rgba(240,232,208,0.82)" }}>
              Pick products from the Reference Catalog. The engine assembles a
              compliant listing — title, bullets, description and photos, with all
              brand &amp; IP rules applied — and you approve a preview that looks
              exactly like the marketplace page before anything publishes.
            </p>
          </div>
          <div className="shrink-0">
            <Link
              href="/bundle-factory/new"
              className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-green-cream px-5 text-[14px] font-semibold text-green-ink transition-colors hover:bg-white"
            >
              Start a build
              <ArrowRight size={17} strokeWidth={2} />
            </Link>
          </div>
        </div>
      </HeroGreenCard>

      {/* HOW IT WORKS — three plain steps so the flow is obvious. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StepCard
          n={1}
          icon={<PackageSearch size={18} strokeWidth={1.7} className="text-green" />}
          title="Pick products"
          body="Choose donor products from the Reference Catalog. Missing something? Pull it in — the sourcing engine fetches it."
        />
        <StepCard
          n={2}
          icon={<Sparkles size={18} strokeWidth={1.7} className="text-green" />}
          title="Engine builds"
          body="Content + photos generated to our brand voice and policies. Price comes from the economics module at your target margin."
        />
        <StepCard
          n={3}
          icon={<Eye size={18} strokeWidth={1.7} className="text-green" />}
          title="Preview & approve"
          body="See each listing exactly as the marketplace renders it. Edit if needed, then publish. Nothing goes live without your approval."
        />
      </div>

      {/* SECONDARY — quiet status strip + section links. Not the task. */}
      <div className="rounded-[14px] border border-rule bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
            At a glance
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-3">
            <Link href="/bundle-factory/drafts" className="hover:text-ink">Drafts</Link>
            <span className="text-ink-4">·</span>
            <Link href="/bundle-factory/master-bundles" className="hover:text-ink">Master Bundles</Link>
            <span className="text-ink-4">·</span>
            <Link href="/bundle-factory/live" className="hover:text-ink">Live SKUs</Link>
            <span className="text-ink-4">·</span>
            <Link href="/bundle-factory/stores" className="hover:text-ink">Stores</Link>
            <span className="text-ink-4">·</span>
            <Link href="/bundle-factory/settings" className="hover:text-ink">Settings</Link>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-3">
          <Stat label="Master bundles" value={masterCount} sub={`${masterLiveCount} live`} />
          <Stat label="Channel SKUs" value={skuCount} />
          <Stat label="Drafts in flight" value={draftCount} href="/bundle-factory/drafts" />
          <Stat label="UPC pool" value={upcAvailable} sub="available" />
        </div>
      </div>
    </>
  );
}

function StepCard({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-green-soft font-mono text-[12px] font-semibold text-green-ink">
          {n}
        </span>
        {icon}
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: number;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-[19px] font-semibold leading-none tabular-nums text-ink">
          {value.toLocaleString("en-US")}
        </span>
        {sub && <span className="text-[11px] text-ink-3">{sub}</span>}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="block transition-opacity hover:opacity-70">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
