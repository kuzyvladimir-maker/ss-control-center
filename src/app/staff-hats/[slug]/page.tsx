"use client";

/**
 * Staff Hats — single hat (post description) detail.
 *
 * Client component reading the slug via useParams() (this repo's Next.js
 * conventions; see src/app/finance/funds/[id]/page.tsx). Content is the
 * in-app copy of the staff-hats wiki — Russian KB content, English UI chrome.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHead } from "@/components/kit";
import { Panel } from "@/components/kit";
import { getHat, type Hat } from "@/lib/staff-hats/data";

const KIND_LABEL: Record<Hat["kind"], string> = {
  hat: "Hat",
  vacancy: "Vacancy",
  brief: "Brief",
};

function KindBadge({ kind }: { kind: Hat["kind"] }) {
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

function BackLink() {
  return (
    <Link
      href="/staff-hats"
      className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink-2"
    >
      <ArrowLeft size={14} /> All Staff Hats
    </Link>
  );
}

export default function HatDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const hat = slug ? getHat(slug) : undefined;

  if (!hat) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <BackLink />
        <p className="mt-6 text-[13px] text-ink-2">Hat not found.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <BackLink />
      <div className="mt-3">
        <PageHead title={hat.title} subtitle={<KindBadge kind={hat.kind} />} />
      </div>

      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-ink">
            Назначение поста
          </h2>
          <p className="text-[13px] leading-relaxed text-ink-2">{hat.purpose}</p>
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-ink">Обязанности</h2>
          <ul className="space-y-1.5">
            {hat.duties.map((duty, i) => (
              <li
                key={i}
                className="flex gap-2 text-[13px] leading-relaxed text-ink-2"
              >
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                <span>{duty}</span>
              </li>
            ))}
          </ul>
        </section>

        {(hat.reportsTo || hat.manages) && (
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-ink">
              Подчинение / Руководит
            </h2>
            <div className="space-y-2">
              {hat.reportsTo && (
                <p className="text-[13px] leading-relaxed text-ink-2">
                  <span className="font-medium text-ink">Подчиняется: </span>
                  {hat.reportsTo}
                </p>
              )}
              {hat.manages && (
                <p className="text-[13px] leading-relaxed text-ink-2">
                  <span className="font-medium text-ink">Руководит: </span>
                  {hat.manages}
                </p>
              )}
            </div>
          </section>
        )}

        {hat.product && (
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-ink">
                Продукт поста
              </h2>
              {hat.productInferred && (
                <span className="inline-flex items-center rounded bg-warn-tint px-1.5 py-0.5 text-[10px] font-medium text-warn-strong">
                  inferred
                </span>
              )}
            </div>
            <p className="text-[13px] leading-relaxed text-ink-2">
              {hat.product}
            </p>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-ink">Источник</h2>
          <Panel className="bg-surface-tint p-3">
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              {hat.source.name}
            </p>
            <p className="mt-1 font-mono text-[11px] text-ink-3">
              Google Drive fileId: {hat.source.fileId}
            </p>
          </Panel>
        </section>
      </div>
    </div>
  );
}
