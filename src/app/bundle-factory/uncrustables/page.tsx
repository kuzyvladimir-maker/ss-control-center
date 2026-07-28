/**
 * Uncrustables Studio — runs list.
 *
 * Phase A of the studio embedding (uncrustables-studio-integration-plan.md):
 * every run is a batch of recipe candidates moving through the render ->
 * review state machine. This page lists runs with per-state tallies and
 * links into each run board.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";

export const dynamic = "force-dynamic";

const STATE_ORDER = [
  "PLANNED",
  "RENDER_QUEUED",
  "RENDERING",
  "RENDERED",
  "REJECTED",
  "APPROVED",
  "STAGED",
  "VALIDATED",
  "PROOFED",
  "SUBMITTED",
  "LIVE",
  "FAILED",
];

export default async function UncrustablesStudioPage() {
  const runs = await prisma.uncrustablesStudioRun.findMany({
    orderBy: { created_at: "desc" },
    take: 100,
    include: { candidates: { select: { state: true } } },
  });

  return (
    <>
      <PageHead
        title="Uncrustables Studio"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {runs.length} run{runs.length === 1 ? "" : "s"}
            </span>
            <Sep />
            <span>Amazon lane, retail-boxes MAIN conveyor</span>
          </>
        }
        actions={
          <Link
            href="/bundle-factory/uncrustables/new"
            className="inline-flex h-9 shrink-0 items-center rounded-md border border-green-soft2 bg-green-soft px-4 text-[12.5px] font-medium text-green-ink transition-colors hover:bg-green-soft2"
          >
            New run
          </Link>
        }
      />

      {runs.length === 0 ? (
        <div className="rounded-[14px] border border-rule bg-surface px-6 py-10 text-center">
          <p className="text-[13px] font-medium text-ink">No runs yet</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Create a run to plan recipes, render MAIN candidates and review them.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Run</th>
                <th className="px-4 py-2.5 text-left font-medium">Candidates</th>
                <th className="px-4 py-2.5 text-left font-medium">States</th>
                <th className="px-4 py-2.5 text-left font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {runs.map((run) => {
                const tally = run.candidates.reduce<Record<string, number>>((acc, c) => {
                  acc[c.state] = (acc[c.state] ?? 0) + 1;
                  return acc;
                }, {});
                return (
                  <tr key={run.id} className="hover:bg-bg-elev">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/bundle-factory/uncrustables/${run.id}`}
                        className="font-medium text-ink underline-offset-2 hover:underline"
                      >
                        {run.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">
                      {run.candidates.length}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-[11.5px] tabular-nums text-ink-2">
                        {STATE_ORDER.filter((s) => tally[s])
                          .map((s) => `${s.toLowerCase()}: ${tally[s]}`)
                          .join(" · ") || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-3">
                      {run.created_at.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
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
