/**
 * Bundle Factory — Master Bundles.
 *
 * Lists the canonical "recipes" — each row is a MasterBundle with its
 * lifecycle status and counts of attached ChannelSKUs / components.
 * Optional ?status=... filter.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  "ALL",
  "DRAFT",
  "RESEARCHED",
  "GENERATED",
  "APPROVED",
  "LIVE",
  "ERROR",
] as const;

export default async function MasterBundlesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filter =
    status && status !== "ALL" ? { lifecycle_status: status } : undefined;

  const bundles = await prisma.masterBundle.findMany({
    where: filter,
    orderBy: { created_at: "desc" },
    take: 100,
    include: {
      _count: {
        select: { components: true, channel_skus: true },
      },
    },
  });

  // Status tally — always over the unfiltered population so chip
  // counters stay informative.
  const tallyRaw = await prisma.masterBundle.groupBy({
    by: ["lifecycle_status"],
    _count: { _all: true },
  });
  const tally = Object.fromEntries(
    tallyRaw.map((r) => [r.lifecycle_status, r._count._all])
  ) as Record<string, number>;
  const total = tallyRaw.reduce((s, r) => s + r._count._all, 0);

  return (
    <>
      <PageHead
        title="Master Bundles"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {bundles.length} of {total} master bundles
            </span>
            <Sep />
            <span>Canonical product recipes — one MasterBundle fans out to multiple ChannelSKUs.</span>
          </>
        }
      />

      <div className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        {STATUS_FILTERS.map((s) => {
          const active = (status ?? "ALL") === s;
          const count = s === "ALL" ? total : (tally[s] ?? 0);
          return (
            <Link
              key={s}
              href={
                s === "ALL"
                  ? "/bundle-factory/master-bundles"
                  : `/bundle-factory/master-bundles?status=${s}`
              }
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium transition-colors",
                active
                  ? "border-green-soft2 bg-green-soft text-green-ink"
                  : "border-rule bg-surface text-ink-2 hover:bg-bg-elev hover:text-ink"
              )}
            >
              {s === "ALL" ? "All" : s.toLowerCase()}
              <span
                className={cn(
                  "tabular-nums text-[10.5px] font-semibold",
                  active ? "" : "text-ink-3"
                )}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      {bundles.length === 0 ? (
        <EmptyState
          title="No master bundles yet"
          body="Master bundles get created when a draft is approved. Phase 1 leaves this empty — Phase 5+ ships the generation pipeline."
        />
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Name</Th>
                <Th>Brand</Th>
                <Th>Category</Th>
                <Th>Type</Th>
                <Th className="text-right">Pack</Th>
                <Th className="text-right">Cost (¢)</Th>
                <Th className="text-right">Price (¢)</Th>
                <Th className="text-right">Components</Th>
                <Th className="text-right">SKUs</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((b) => (
                <tr key={b.id} className="border-t border-rule align-top">
                  <Td>
                    <div className="font-medium text-ink">{b.name}</div>
                    <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                      {b.internal_slug}
                    </div>
                  </Td>
                  <Td>{b.brand}</Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {b.category.toLowerCase()}
                  </Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {b.composition_type.toLowerCase()}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    ×{b.pack_count}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-2">
                    {b.estimated_cost_cents.toLocaleString("en-US")}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink">
                    {b.suggested_price_cents.toLocaleString("en-US")}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {b._count.components}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {b._count.channel_skus}
                  </Td>
                  <Td>
                    <StatusPill status={b.lifecycle_status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  let cls = "border-rule bg-bg-elev text-ink-2";
  if (status === "LIVE")
    cls = "border-green-soft2 bg-green-soft text-green-ink";
  else if (status === "APPROVED")
    cls = "border-green-soft2 bg-green-soft text-green-ink";
  else if (status === "ERROR" || status === "SUSPENDED")
    cls = "border-warn-strong/40 bg-warn-tint text-warn-strong";
  else if (
    status === "QUEUED" ||
    status === "SUBMITTED" ||
    status === "PROCESSING"
  )
    cls = "border-info/30 bg-info-tint text-info";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-3 py-2.5 text-left font-medium ${className}`}>{children}</th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface px-6 py-12 text-center">
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-3">
        {body}
      </p>
    </div>
  );
}
