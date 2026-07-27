/**
 * Bundle Factory — Drafts.
 *
 * BundleDrafts in any non-DRAFT lifecycle state (VARIATION_SELECTED,
 * GENERATED, APPROVED, ERROR, etc.) — i.e. anything actively moving
 * through the pipeline.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const drafts = await prisma.bundleDraft.findMany({
    where: { status: { not: "DRAFT" } },
    orderBy: { updated_at: "desc" },
    take: 100,
  });

  // Status tally for the subtitle line.
  const tally = drafts.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHead
        title="Drafts"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {drafts.length} drafts in flight
            </span>
            <Sep />
            <span className="font-mono tabular-nums">
              {Object.entries(tally)
                .map(([k, v]) => `${k.toLowerCase()}: ${v}`)
                .join(" · ") || "—"}
            </span>
          </>
        }
      />

      {drafts.length === 0 ? (
        <EmptyState
          title="No drafts in flight"
          body="Drafts appear here as the pipeline advances them past the initial brief. Phase 1 has no executor yet — this is wired for Phase 5."
        />
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <Th>Draft</Th>
                <Th>Brand</Th>
                <Th>Status</Th>
                <Th>Type</Th>
                <Th className="text-right">Cost (¢)</Th>
                <Th className="text-right">Price (¢)</Th>
                <Th className="text-right">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr
                  key={d.id}
                  className="border-t border-rule align-top transition-colors hover:bg-surface-tint/50"
                >
                  <Td>
                    <Link
                      href={`/bundle-factory/drafts/${d.id}`}
                      className="group block"
                    >
                      <div className="font-medium text-green-ink group-hover:underline">
                        {d.draft_name}{" "}
                        <span className="text-[11px] font-normal text-ink-3 group-hover:text-green-ink">
                          — открыть на ревью →
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                        {d.id}
                      </div>
                    </Link>
                  </Td>
                  <Td>{d.brand}</Td>
                  <Td>
                    <StatusPill status={d.status} />
                  </Td>
                  <Td className="font-mono text-[11.5px] text-ink-2">
                    {d.composition_type.toLowerCase()}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-2">
                    {d.draft_cost_cents?.toLocaleString("en-US") ?? "—"}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-2">
                    {d.draft_suggested_price_cents?.toLocaleString("en-US") ?? "—"}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-3">
                    {fmtDate(d.updated_at)}
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
  // Map lifecycle states → Salutem palette buckets.
  let cls =
    "border-rule bg-bg-elev text-ink-2"; // neutral default
  if (status === "APPROVED" || status === "LIVE") {
    cls = "border-green-soft2 bg-green-soft text-green-ink";
  } else if (status === "ERROR" || status === "SUSPENDED") {
    cls = "border-warn-strong/40 bg-warn-tint text-warn-strong";
  } else if (
    status === "VARIATION_SELECTED" ||
    status === "GENERATED" ||
    status === "QUEUED" ||
    status === "SUBMITTED" ||
    status === "PROCESSING"
  ) {
    cls = "border-info/30 bg-info-tint text-info";
  }
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

function fmtDate(d: Date): string {
  // The server renders in UTC (Vercel). Show the operator's local Eastern time
  // so timestamps match Vladimir's clock, not the server's.
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
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
