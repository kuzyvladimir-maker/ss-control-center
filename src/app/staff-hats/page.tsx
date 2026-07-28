"use client";

/**
 * Staff Hats — list of post hats (job descriptions).
 *
 * Real established hats are grouped separately from hiring artifacts
 * (vacancies + interview briefs), which are visually distinct so they're
 * never mistaken for settled job descriptions. Each card drills into
 * `/staff-hats/<slug>`.
 */

import Link from "next/link";
import { PageHead } from "@/components/kit";
import { Panel } from "@/components/kit";
import { HATS, type Hat } from "@/lib/staff-hats/data";

const KIND_LABEL: Record<Hat["kind"], string> = {
  hat: "Hat",
  vacancy: "Vacancy",
  brief: "Brief",
};

function KindBadge({ kind }: { kind: Hat["kind"] }) {
  // Hats read as settled (green-soft). Vacancies/briefs read as "not yet a
  // real hat" (warn-tint) so they're visually distinct.
  const cls =
    kind === "hat"
      ? "bg-green-soft text-green-ink"
      : "bg-warn-tint text-warn-strong";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function HatCard({ hat }: { hat: Hat }) {
  return (
    <Link href={`/staff-hats/${hat.slug}`} className="block">
      <Panel className="h-full p-4 transition-colors hover:bg-surface-tint">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[14px] font-semibold leading-snug text-ink">
            {hat.title}
          </h3>
          <KindBadge kind={hat.kind} />
        </div>
        <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-ink-2">
          {hat.purpose}
        </p>
      </Panel>
    </Link>
  );
}

export default function StaffHatsPage() {
  const hats = HATS.filter((h) => h.kind === "hat");
  const artifacts = HATS.filter((h) => h.kind !== "hat");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
      <PageHead title="Staff Hats" subtitle="Job descriptions & post hats" />

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">Hats</h2>
          <span className="text-[11.5px] tabular text-ink-3">{hats.length}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {hats.map((hat) => (
            <HatCard key={hat.slug} hat={hat} />
          ))}
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">
            Vacancies / Briefs
          </h2>
          <span className="text-[11.5px] tabular text-ink-3">
            {artifacts.length}
          </span>
        </div>
        <p className="mb-3 text-[12px] text-ink-3">
          Hiring artifacts — not yet established post hats.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {artifacts.map((hat) => (
            <HatCard key={hat.slug} hat={hat} />
          ))}
        </div>
      </section>
    </div>
  );
}
