/**
 * Bundle Factory — Live SKUs.
 *
 * ChannelSKUs in LIVE status, grouped by channel. Each row links out to
 * the marketplace listing (live_url) when available.
 */

import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";

export const dynamic = "force-dynamic";

export default async function LiveSkusPage() {
  const skus = await prisma.channelSKU.findMany({
    where: { lifecycle_status: "LIVE" },
    orderBy: [{ channel: "asc" }, { live_at: "desc" }],
    take: 500,
  });

  // Group by channel for the section headers.
  const byChannel = skus.reduce<Record<string, typeof skus>>((acc, s) => {
    (acc[s.channel] ??= []).push(s);
    return acc;
  }, {});

  const total30dUnits = skus.reduce(
    (sum, s) => sum + (s.units_sold_30d ?? 0),
    0
  );
  const total30dRevenue = skus.reduce(
    (sum, s) => sum + (s.revenue_30d_cents ?? 0),
    0
  );

  return (
    <>
      <PageHead
        title="Live SKUs"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {skus.length} live listings across {Object.keys(byChannel).length} channels
            </span>
            <Sep />
            <span className="font-mono tabular-nums">
              30d units: {total30dUnits.toLocaleString("en-US")}
            </span>
            <Sep />
            <span className="font-mono tabular-nums">
              30d revenue: ${(total30dRevenue / 100).toLocaleString("en-US")}
            </span>
          </>
        }
      />

      {skus.length === 0 ? (
        <EmptyState
          title="No live SKUs yet"
          body="ChannelSKUs land here once they pass marketplace processing. Phase 1 has no distributor wired — Phase 9+ ships SP-API + Walmart pushes."
        />
      ) : (
        <div className="space-y-5">
          {Object.entries(byChannel).map(([channel, channelSkus]) => (
            <section key={channel}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-[12.5px] font-semibold uppercase tracking-wider text-ink-2">
                  {channel}
                </h2>
                <span className="font-mono text-[11px] text-ink-3 tabular-nums">
                  {channelSkus.length}
                </span>
              </div>
              <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
                <table className="min-w-full text-[12.5px] text-ink">
                  <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
                    <tr>
                      <Th>Title</Th>
                      <Th>SKU</Th>
                      <Th>UPC</Th>
                      <Th>Marketplace ID</Th>
                      <Th className="text-right">Price (¢)</Th>
                      <Th className="text-right">30d units</Th>
                      <Th className="text-right">Live since</Th>
                      <Th>Link</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelSkus.map((s) => (
                      <tr key={s.id} className="border-t border-rule align-top">
                        <Td className="max-w-[420px]">
                          <div className="truncate font-medium text-ink">
                            {s.title}
                          </div>
                        </Td>
                        <Td className="font-mono text-[11.5px] text-ink-2">
                          {s.sku}
                        </Td>
                        <Td className="font-mono text-[11.5px] text-ink-2">
                          {s.upc}
                        </Td>
                        <Td className="font-mono text-[11.5px] text-ink-2">
                          {s.asin ??
                            s.walmart_item_id ??
                            s.ebay_item_id ??
                            s.tiktok_product_id ??
                            "—"}
                        </Td>
                        <Td className="text-right font-mono tabular-nums">
                          {s.price_cents.toLocaleString("en-US")}
                        </Td>
                        <Td className="text-right font-mono tabular-nums text-ink-2">
                          {s.units_sold_30d?.toLocaleString("en-US") ?? "0"}
                        </Td>
                        <Td className="text-right font-mono tabular-nums text-ink-3">
                          {s.live_at ? fmtDate(s.live_at) : "—"}
                        </Td>
                        <Td>
                          {s.live_url ? (
                            <a
                              href={s.live_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[12px] font-medium text-green hover:text-green-deep"
                            >
                              Open →
                            </a>
                          ) : (
                            <span className="text-ink-4">—</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
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
