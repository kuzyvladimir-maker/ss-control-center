/**
 * Bundle Factory — Settings.
 *
 * Phase 1 read-only inventory of the supporting tables:
 *   - UPC pool stats (status breakdown by prefix)
 *   - BrandAccount mapping (9 rows)
 *   - GTINExemption tracker (63 rows, grouped by brand)
 *   - MarketplaceRule cache (30 rules, grouped by channel)
 *
 * Editing UIs come later — for now, mutations go through the REST routes
 * or Prisma Studio.
 */

import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [upcByStatus, upcByPrefix, brandAccounts, gtinByBrand, ruleByChannel] =
    await Promise.all([
      prisma.uPCPool.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.uPCPool.groupBy({
        by: ["upc_prefix"],
        _count: { _all: true },
      }),
      prisma.brandAccount.findMany({
        orderBy: [{ brand: "asc" }, { channel: "asc" }],
      }),
      prisma.gTINExemption.groupBy({
        by: ["brand", "status"],
        _count: { _all: true },
      }),
      prisma.marketplaceRule.groupBy({
        by: ["channel"],
        _count: { _all: true },
      }),
    ]);

  const upcTotal = upcByStatus.reduce((s, r) => s + r._count._all, 0);

  return (
    <>
      <PageHead
        title="Settings"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              Bundle Factory configuration
            </span>
            <Sep />
            <span>
              UPC pool, brand accounts, GTIN exemption tracker, marketplace rule cache.
            </span>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* UPC pool */}
        <Panel
          title="UPC pool"
          subtitle={`${upcTotal} UPCs total`}
          empty={
            upcTotal === 0
              ? "Pool is empty. Drop the Active Listings Report into data/imports/ and re-run `npx prisma db seed`."
              : undefined
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Subtitle>By status</Subtitle>
              <table className="mt-1.5 w-full text-[12.5px] text-ink">
                <tbody>
                  {upcByStatus.map((s) => (
                    <tr key={s.status}>
                      <td className="py-0.5 font-mono text-[11.5px] text-ink-2">
                        {s.status.toLowerCase()}
                      </td>
                      <td className="py-0.5 text-right font-mono tabular-nums">
                        {s._count._all.toLocaleString("en-US")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <Subtitle>By prefix</Subtitle>
              <table className="mt-1.5 w-full text-[12.5px] text-ink">
                <tbody>
                  {upcByPrefix.map((p) => (
                    <tr key={p.upc_prefix}>
                      <td className="py-0.5 font-mono text-[11.5px] text-ink-2">
                        {p.upc_prefix}
                      </td>
                      <td className="py-0.5 text-right font-mono tabular-nums">
                        {p._count._all.toLocaleString("en-US")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>

        {/* Brand accounts */}
        <Panel title="Brand accounts" subtitle={`${brandAccounts.length} mappings`}>
          <table className="w-full text-[12.5px] text-ink">
            <thead className="text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Brand</Th>
                <Th>Channel</Th>
                <Th>Role</Th>
              </tr>
            </thead>
            <tbody>
              {brandAccounts.map((ba) => (
                <tr key={ba.id} className="border-t border-rule">
                  <Td>{ba.brand}</Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {ba.channel}
                  </Td>
                  <Td>
                    {ba.is_brand_owner ? (
                      <span className="inline-flex items-center rounded bg-green-soft px-1.5 py-0.5 text-[10.5px] font-medium text-green-ink">
                        Brand owner
                      </span>
                    ) : ba.is_authorized_seller ? (
                      <span className="inline-flex items-center rounded bg-silver-tint px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">
                        Authorized
                      </span>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* GTIN exemption */}
        <Panel
          title="GTIN exemption tracker"
          subtitle={`${gtinByBrand.reduce((s, r) => s + r._count._all, 0)} (brand × channel × category) rows`}
        >
          <table className="w-full text-[12.5px] text-ink">
            <thead className="text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Brand</Th>
                <Th>Status</Th>
                <Th className="text-right">Count</Th>
              </tr>
            </thead>
            <tbody>
              {gtinByBrand.map((g) => (
                <tr key={`${g.brand}-${g.status}`} className="border-t border-rule">
                  <Td>{g.brand}</Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {g.status.toLowerCase().replace(/_/g, " ")}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {g._count._all}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Marketplace rules */}
        <Panel
          title="Marketplace rules cache"
          subtitle={`${ruleByChannel.reduce((s, r) => s + r._count._all, 0)} rules across channels`}
        >
          <table className="w-full text-[12.5px] text-ink">
            <thead className="text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Channel</Th>
                <Th className="text-right">Rules</Th>
              </tr>
            </thead>
            <tbody>
              {ruleByChannel.map((r) => (
                <tr key={r.channel} className="border-t border-rule">
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {r.channel}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {r._count._all}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
            Source of truth is{" "}
            <code className="rounded bg-bg-elev px-1 py-0.5 font-mono text-[10.5px] text-ink-2">
              docs/marketplace-rules/
            </code>
            . This table is a hot-path cache populated by{" "}
            <code className="rounded bg-bg-elev px-1 py-0.5 font-mono text-[10.5px] text-ink-2">
              prisma/seed/marketplace-rules-seed.ts
            </code>
            .
          </p>
        </Panel>
      </div>
    </>
  );
}

function Panel({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-rule bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {subtitle && (
          <span className="font-mono text-[11px] tabular-nums text-ink-3">
            {subtitle}
          </span>
        )}
      </div>
      {empty ? (
        <p className="rounded-md border border-warn-strong/30 bg-warn-tint px-3 py-2 text-[12.5px] text-warn-strong">
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3">
      {children}
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={`pb-1.5 text-left font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`py-1 ${className}`}>{children}</td>;
}
