/**
 * Bundle Factory — Briefs list.
 *
 * Shows BundleDrafts grouped by status (DRAFT, RESEARCHED, others
 * collapsed). Phase 2.1 adds a "+ New Brief" action linking to
 * `/bundle-factory/briefs/new` and makes every row clickable into the
 * detail page.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";

export const dynamic = "force-dynamic";

const VISIBLE_STATUSES = [
  "DRAFT",
  "RESEARCHED",
  "VARIATION_SELECTED",
  "GENERATED",
  "APPROVED",
] as const;

export default async function BriefsPage() {
  const briefs = await prisma.bundleDraft.findMany({
    where: { status: { in: [...VISIBLE_STATUSES] } },
    orderBy: { created_at: "desc" },
    take: 200,
  });

  const draftCount = briefs.filter((b) => b.status === "DRAFT").length;
  const researchedCount = briefs.filter((b) => b.status === "RESEARCHED").length;

  return (
    <>
      <PageHead
        title="Briefs"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {briefs.length} active
            </span>
            <Sep />
            <span className="text-ink-3">
              {draftCount} draft · {researchedCount} researched
            </span>
          </>
        }
        actions={
          <Link
            href="/bundle-factory/briefs/new"
            className="inline-flex h-7 select-none items-center justify-center rounded-md border border-green bg-green px-2.5 text-[12px] font-medium text-cream hover:bg-green-deep"
          >
            + New Brief
          </Link>
        }
      />

      {briefs.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Draft</Th>
                <Th>Brand</Th>
                <Th>Status</Th>
                <Th>Category</Th>
                <Th>Type</Th>
                <Th className="text-right">Pack</Th>
                <Th>Channels</Th>
                <Th className="text-right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {briefs.map((b) => {
                const channels = safeParse<string[]>(b.target_channels) ?? [];
                return (
                  <tr
                    key={b.id}
                    className="border-t border-rule align-top hover:bg-bg-elev/40"
                  >
                    <Td>
                      <Link
                        href={`/bundle-factory/briefs/${b.id}`}
                        className="font-medium text-ink hover:text-green-ink"
                      >
                        {b.draft_name}
                      </Link>
                      <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                        {b.id}
                      </div>
                    </Td>
                    <Td>{b.brand}</Td>
                    <Td>
                      <StatusPill status={b.status} />
                    </Td>
                    <Td className="font-mono text-[11.5px] text-ink-2">
                      {b.category.toLowerCase()}
                    </Td>
                    <Td className="font-mono text-[11.5px] text-ink-2">
                      {b.composition_type.toLowerCase()}
                    </Td>
                    <Td className="text-right font-mono tabular-nums">
                      ×{b.pack_count}
                    </Td>
                    <Td className="text-ink-2">
                      {channels.length === 0 ? "—" : channels.length}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-ink-3">
                      {fmtDate(b.created_at)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
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

function StatusPill({ status }: { status: string }) {
  const style =
    status === "DRAFT"
      ? "bg-bg-elev text-ink-3"
      : status === "RESEARCHED"
        ? "bg-green-soft text-green-ink"
        : status === "VARIATION_SELECTED" || status === "GENERATED"
          ? "bg-green-soft2 text-green-ink"
          : "bg-warn-tint text-warn-strong";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ${style}`}
    >
      {status}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[14px] border border-rule bg-surface px-6 py-12 text-center">
      <div className="text-[14px] font-semibold text-ink">No briefs yet</div>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-3">
        Start a brief to describe a bundle idea — research will then find
        retail candidates near Clearwater.
      </p>
      <div className="mt-4">
        <Link
          href="/bundle-factory/briefs/new"
          className="inline-flex h-9 select-none items-center justify-center rounded-md border border-green bg-green px-4 text-[13px] font-medium text-cream hover:bg-green-deep"
        >
          + New Brief
        </Link>
      </div>
    </div>
  );
}
