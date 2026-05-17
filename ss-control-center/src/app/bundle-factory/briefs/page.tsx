/**
 * Bundle Factory — Briefs.
 *
 * Shows BundleDrafts in DRAFT state — the inbox of pipeline jobs the user
 * has started but not yet run. Phase 1 surface is a read-only list; the
 * actual "kick off pipeline" button lands in Phase 5+.
 */

import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
  const briefs = await prisma.bundleDraft.findMany({
    where: { status: "DRAFT" },
    orderBy: { created_at: "desc" },
    take: 100,
  });

  return (
    <>
      <PageHead
        title="Briefs"
        subtitle={
          <>
            <span className="font-medium text-ink-2">{briefs.length} briefs</span>
            <Sep />
            <span>BundleDrafts queued in DRAFT status, awaiting pipeline kickoff.</span>
          </>
        }
      />

      {briefs.length === 0 ? (
        <EmptyState
          title="No briefs yet"
          body="Create one via POST /api/bundle-factory/briefs (the in-app form lands in Phase 5)."
        />
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Draft name</Th>
                <Th>Brand</Th>
                <Th>Category</Th>
                <Th>Type</Th>
                <Th className="text-right">Pack</Th>
                <Th>Target channels</Th>
                <Th className="text-right">Created</Th>
              </tr>
            </thead>
            <tbody>
              {briefs.map((b) => {
                const channels = safeParse<string[]>(b.target_channels) ?? [];
                return (
                  <tr key={b.id} className="border-t border-rule align-top">
                    <Td>
                      <div className="font-medium text-ink">{b.draft_name}</div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                        {b.id}
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
                    <Td className="text-ink-2">
                      {channels.length === 0 ? "—" : channels.join(", ")}
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
