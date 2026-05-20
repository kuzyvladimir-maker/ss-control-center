/**
 * Bundle Factory — Draft detail (Stage 4 view).
 *
 * Server-renders the header + the selected variant summary. The Stage 4
 * action (generate / regenerate / per-channel cards) is the
 * DraftDetailClient island.
 *
 * Lives at `/bundle-factory/drafts/[id]`. The same `id` is the
 * BundleDraft id used everywhere; the brief detail page at
 * `/bundle-factory/briefs/[id]` covers Stages 1–3.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import { DraftDetailClient } from "./DraftDetailClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DraftDetailPage({ params }: PageProps) {
  const { id } = await params;
  const draft = await prisma.bundleDraft.findUnique({
    where: { id },
    include: {
      variation_matrix: true,
      generated_content: { orderBy: { channel: "asc" } },
    },
  });
  if (!draft) return notFound();

  // Phase 2.4 — pull ChannelSKU validation state, keyed by channel so
  // the client can merge into per-channel cards.
  const channelSkus = draft.master_bundle_id
    ? await prisma.channelSKU.findMany({
        where: { master_bundle_id: draft.master_bundle_id },
        select: {
          id: true,
          channel: true,
          sku: true,
          validation_status: true,
          validation_errors: true,
          validated_at: true,
          validation_attempt_count: true,
        },
      })
    : [];
  const channelSkuByChannel: Record<
    string,
    {
      sku_id: string;
      sku: string;
      validation_status: string;
      validation_errors: string | null;
      validated_at: Date | null;
      validation_attempt_count: number;
    }
  > = {};
  for (const cs of channelSkus) {
    channelSkuByChannel[cs.channel] = {
      sku_id: cs.id,
      sku: cs.sku,
      validation_status: cs.validation_status,
      validation_errors: cs.validation_errors,
      validated_at: cs.validated_at,
      validation_attempt_count: cs.validation_attempt_count,
    };
  }

  const channels = safeParse<string[]>(draft.target_channels) ?? [];
  const variants = draft.variation_matrix
    ? safeParse<Variant[]>(draft.variation_matrix.variants_json) ?? []
    : [];
  const selectedIdx = draft.variation_matrix?.selected_variant_idx ?? null;
  const selectedVariant =
    selectedIdx != null ? variants[selectedIdx] : undefined;

  return (
    <>
      <PageHead
        title={draft.draft_name}
        subtitle={
          <>
            <span className="font-medium text-ink-2">{draft.brand}</span>
            <Sep />
            <StatusPill status={draft.status} />
            <Sep />
            <span className="font-mono text-[11px] text-ink-3">{draft.id}</span>
          </>
        }
        actions={
          <Link
            href={`/bundle-factory/briefs/${draft.id}`}
            className="text-[12.5px] text-ink-3 hover:text-ink-2"
          >
            ← Back to brief
          </Link>
        }
      />

      <div className="rounded-[14px] border border-rule bg-surface p-5">
        <h2 className="mb-3 text-[13px] font-semibold text-ink">
          Selected variant
        </h2>
        {!selectedVariant ? (
          <p className="text-[12.5px] text-ink-3">
            No variant selected yet.{" "}
            <Link
              href={`/bundle-factory/briefs/${draft.id}`}
              className="text-green-ink hover:underline"
            >
              Pick one on the brief page →
            </Link>
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <Detail label="Name" value={selectedVariant.name} wide />
            <Detail
              label="Composition"
              value={selectedVariant.composition
                .map((c) => `${c.qty}× ${c.product_name} (${c.brand})`)
                .join(", ")}
              wide
            />
            <Detail
              label="Cost"
              value={`$${(selectedVariant.cost_cents / 100).toFixed(2)}`}
            />
            <Detail
              label="Suggested price"
              value={`$${(selectedVariant.suggested_price_cents / 100).toFixed(2)}`}
            />
            <Detail
              label="Margin"
              value={`$${(selectedVariant.margin_cents / 100).toFixed(2)} (${(selectedVariant.margin_pct * 100).toFixed(0)}%)`}
            />
            <Detail
              label="Feasibility"
              value={`${selectedVariant.feasibility_score}/100`}
            />
          </div>
        )}
      </div>

      <DraftDetailClient
        draftId={draft.id}
        canGenerate={Boolean(selectedVariant)}
        targetChannels={channels}
        draftStatus={draft.status}
        initialContent={draft.generated_content.map((g) => {
          const cs = channelSkuByChannel[g.channel];
          return {
            id: g.id,
            channel: g.channel,
            template: g.template,
            title: g.title,
            bullets_json: g.bullets_json,
            description: g.description,
            compliance_status: g.compliance_status,
            compliance_attempts: g.compliance_attempts,
            manual_review_required: g.manual_review_required,
            failed_rule_ids: g.failed_rule_ids,
            generation_cost_cents: g.generation_cost_cents,
            cache_read_tokens: g.cache_read_tokens,
            cache_write_tokens: g.cache_write_tokens,
            main_image_url: g.main_image_url,
            image_generation_cost_cents: g.image_generation_cost_cents,
            image_retry_count: g.image_retry_count,
            // Phase 2.4
            channel_sku_id: cs?.sku_id ?? null,
            sku_code: cs?.sku ?? null,
            validation_status: cs?.validation_status ?? "PENDING",
            validation_errors_json: cs?.validation_errors ?? null,
            validation_attempt_count: cs?.validation_attempt_count ?? 0,
          };
        })}
      />
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface Variant {
  idx: number;
  name: string;
  notes: string;
  composition: Array<{
    research_pool_id: string;
    product_name: string;
    brand: string;
    qty: number;
    unit_price_cents: number;
  }>;
  cost_cents: number;
  suggested_price_cents: number;
  margin_cents: number;
  margin_pct: number;
  feasibility_score: number;
}

function safeParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
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
      : status === "RESEARCHED" || status === "VARIATION_SELECTED"
        ? "bg-green-soft text-green-ink"
        : status === "GENERATED" || status === "APPROVED"
          ? "bg-green-soft2 text-green-ink"
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
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mt-0.5 text-[12.5px] text-ink">{value}</div>
    </div>
  );
}
