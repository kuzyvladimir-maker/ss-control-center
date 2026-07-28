/**
 * Bundle Factory — Stores page.
 *
 * Read-only listing of the 37 pre-seeded StoreRegistry rows. Shows
 * chain / tier / type / distance / hours / delivery program. Default
 * sort = distance from 1162 Kapp Dr ascending.
 *
 * Phase 1: server-rendered with client-side chain filter; map preview
 * lands in Phase 2.
 */

import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import { StoreChainFilter } from "@/components/bundle-factory/StoreChainFilter";

export const dynamic = "force-dynamic";

export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; tier?: string }>;
}) {
  const { chain, tier } = await searchParams;

  const where: Record<string, unknown> = {};
  if (chain) where.chain = chain;
  if (tier) where.tier = tier;

  const stores = await prisma.storeRegistry.findMany({
    where,
    orderBy: [{ distance_mi: "asc" }],
  });

  // Distinct chains for the filter chips (always computed from the full
  // set so chip list stays stable while filtering).
  const allChains = await prisma.storeRegistry.findMany({
    select: { chain: true },
    distinct: ["chain"],
    orderBy: { chain: "asc" },
  });

  // Tier counts give Vladimir a quick "where am I light" overview.
  const byChain = await prisma.storeRegistry.groupBy({
    by: ["chain"],
    _count: { _all: true },
  });

  return (
    <>
      <PageHead
        title="Sourcing stores"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {stores.length} of {byChain.reduce((s, x) => s + x._count._all, 0)} stores
            </span>
            <Sep />
            <span>10-mile radius from 1162 Kapp Dr, Clearwater FL</span>
            <Sep />
            <span className="font-mono tabular-nums">
              Walmart 14 · Publix 9 · Target 3 · Winn-Dixie 3 · ALDI 2 · BJ&apos;s
              1 · Sam&apos;s 1 · Costco 1 · Whole Foods 1 · Trader Joe&apos;s 1 ·
              Fresh Market 1
            </span>
          </>
        }
      />

      <StoreChainFilter
        chains={allChains.map((c) => c.chain)}
        activeChain={chain ?? null}
        activeTier={tier ?? null}
      />

      <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
        <table className="min-w-full text-[12.5px] text-ink">
          <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
            <tr>
              <Th>Store</Th>
              <Th>Chain</Th>
              <Th>Type</Th>
              <Th>Tier</Th>
              <Th className="text-right">Distance</Th>
              <Th>Address</Th>
              <Th>Hours</Th>
              <Th>Delivery</Th>
              <Th className="text-right">Delivery fee</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {stores.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-4 py-10 text-center text-[13px] text-ink-3"
                >
                  No stores match these filters.
                </td>
              </tr>
            ) : (
              stores.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-rule align-top hover:bg-bg-elev/60"
                >
                  <Td>
                    <div className="font-medium text-ink">{s.name}</div>
                    <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                      {s.id}
                    </div>
                  </Td>
                  <Td>{s.chain}</Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {s.store_type.toLowerCase()}
                  </Td>
                  <Td>
                    <span className="inline-flex items-center rounded bg-bg-elev px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                      {s.tier}
                    </span>
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {s.distance_mi.toFixed(1)} mi
                  </Td>
                  <Td className="max-w-[260px] text-ink-2">{s.address}</Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {s.hours_text ?? "—"}
                  </Td>
                  <Td className="text-ink-2">{s.delivery_program ?? "—"}</Td>
                  <Td className="text-right font-mono tabular-nums text-ink-2">
                    {s.delivery_cost_cents === 0
                      ? "free"
                      : `$${(s.delivery_cost_cents / 100).toFixed(2)}`}
                  </Td>
                  <Td>
                    {s.is_membership_required ? (
                      <span className="inline-flex items-center gap-1 rounded bg-warn-tint px-1.5 py-0.5 text-[10.5px] font-medium text-warn-strong">
                        Membership
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-green-soft px-1.5 py-0.5 text-[10.5px] font-medium text-green-ink">
                        Open
                      </span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
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
