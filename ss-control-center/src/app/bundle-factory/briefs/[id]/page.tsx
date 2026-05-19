/**
 * Bundle Factory — Brief detail.
 *
 * Server-renders the static parts (header, brief details, stage progress)
 * then mounts the BriefDetailClient island for the research section
 * (which polls /api/bundle-factory/briefs/[id] while stage=RESEARCH is
 * IN_PROGRESS, and handles edit/delete actions).
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import { BriefDetailClient } from "./BriefDetailClient";
import { PIPELINE_STAGES } from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function BriefDetailPage({ params }: PageProps) {
  const { id } = await params;
  const brief = await prisma.bundleDraft.findUnique({ where: { id } });
  if (!brief) return notFound();

  const [researchPool, stages] = await Promise.all([
    prisma.researchPool.findMany({
      where: { generation_job_id: brief.generation_job_id },
      orderBy: [{ freshness_score: "desc" }, { created_at: "asc" }],
    }),
    prisma.generationStage.findMany({
      where: { generation_job_id: brief.generation_job_id },
      orderBy: { started_at: "asc" },
    }),
  ]);

  const channels = safeParse<string[]>(brief.target_channels) ?? [];

  return (
    <>
      <PageHead
        title={brief.draft_name}
        subtitle={
          <>
            <span className="font-medium text-ink-2">{brief.brand}</span>
            <Sep />
            <StatusPill status={brief.status} />
            <Sep />
            <span className="font-mono text-[11px] text-ink-3">{brief.id}</span>
          </>
        }
        actions={
          <Link
            href="/bundle-factory/briefs"
            className="text-[12.5px] text-ink-3 hover:text-ink-2"
          >
            ← All briefs
          </Link>
        }
      />

      <div className="rounded-[14px] border border-rule bg-surface p-5">
        <h2 className="mb-3 text-[13px] font-semibold text-ink">Brief</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          <Detail label="Category" value={brief.category.toLowerCase()} />
          <Detail
            label="Composition"
            value={brief.composition_type.toLowerCase()}
          />
          <Detail label="Pack count" value={`×${brief.pack_count}`} />
          <Detail
            label="Channels"
            value={channels.join(", ") || "—"}
            wide
          />
          <Detail
            label="Generation job"
            value={brief.generation_job_id}
            mono
          />
          <Detail
            label="Created"
            value={brief.created_at.toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          />
        </div>
      </div>

      <StageProgress
        stages={stages.map((s) => ({
          stage: s.stage,
          status: s.status,
        }))}
      />

      <BriefDetailClient
        briefId={brief.id}
        initialStatus={brief.status}
        initialPoolSize={researchPool.length}
        initialPool={researchPool.map((p) => ({
          id: p.id,
          product_name: p.product_name,
          brand: p.brand,
          pack_sizes: p.pack_sizes,
          flavors: p.flavors,
          weight_oz: p.weight_oz,
          allergens: p.allergens,
          storage_temp: p.storage_temp,
          avg_price_cents: p.avg_price_cents,
          freshness_score: p.freshness_score,
          source_url: p.source_url,
          reference_image_urls: p.reference_image_urls,
        }))}
        latestStageError={stages
          .filter((s) => s.stage === "RESEARCH" && s.status === "FAILED")
          .map((s) => s.error)
          .find((e) => Boolean(e)) ?? null}
        researchInProgress={stages.some(
          (s) => s.stage === "RESEARCH" && s.status === "IN_PROGRESS",
        )}
      />
    </>
  );
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function StatusPill({ status }: { status: string }) {
  const style =
    status === "DRAFT"
      ? "bg-bg-elev text-ink-3"
      : status === "RESEARCHED"
        ? "bg-green-soft text-green-ink"
        : status === "VARIATION_SELECTED"
          ? "bg-green-soft2 text-green-ink"
          : status === "ARCHIVED"
            ? "bg-bg-elev text-ink-3"
            : "bg-warn-tint text-warn-strong";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${style}`}
    >
      {status}
    </span>
  );
}

function Detail({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-3" : ""}>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className={`mt-0.5 text-[12.5px] ${mono ? "font-mono" : ""} text-ink`}>
        {value}
      </div>
    </div>
  );
}

function StageProgress({
  stages,
}: {
  stages: Array<{ stage: string; status: string }>;
}) {
  const byStage = new Map(stages.map((s) => [s.stage, s.status]));
  return (
    <div className="rounded-[14px] border border-rule bg-surface p-5">
      <h2 className="mb-3 text-[13px] font-semibold text-ink">Pipeline stages</h2>
      <div className="flex flex-wrap items-center gap-2">
        {PIPELINE_STAGES.map((s, i) => {
          const status = byStage.get(s);
          const color =
            status === "COMPLETED"
              ? "border-green bg-green-soft text-green-ink"
              : status === "IN_PROGRESS"
                ? "border-warn-strong bg-warn-tint text-warn-strong"
                : status === "FAILED"
                  ? "border-danger/40 bg-danger-tint text-danger"
                  : "border-rule bg-bg-elev text-ink-3";
          return (
            <div key={s} className="flex items-center gap-2">
              <span
                className={`inline-flex h-6 items-center rounded-md border px-2 text-[10.5px] font-medium uppercase tracking-wider ${color}`}
              >
                {s.toLowerCase().replace(/_/g, " ")}
              </span>
              {i < PIPELINE_STAGES.length - 1 && (
                <span className="h-px w-3 bg-rule" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
