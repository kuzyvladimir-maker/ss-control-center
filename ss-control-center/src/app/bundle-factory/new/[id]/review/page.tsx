import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, AlertTriangle } from "lucide-react";

import { PageHead } from "@/components/kit";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface PreviewEconomics {
  item_price_cents?: number;
  minimum_customer_shipping_charge_cents?: number;
  maximum_customer_shipping_charge_cents?: number;
  minimum_customer_total_cents?: number;
  maximum_customer_total_cents?: number;
  target_margin_bps?: number;
  shipping_template_name?: string;
  is_free_shipping?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function previewEconomics(value: string | null): PreviewEconomics | null {
  if (!value) return null;
  try {
    return record(JSON.parse(value))?.economics as PreviewEconomics ?? null;
  } catch {
    return null;
  }
}

function money(cents: number | undefined): string {
  return typeof cents === "number" && Number.isFinite(cents)
    ? `$${(cents / 100).toFixed(2)}`
    : "—";
}

export default async function WalmartDraftBatchReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await prisma.generationJob.findUnique({
    where: { id },
    include: {
      work_items: {
        orderBy: { spec_index: "asc" },
        include: { bundle_draft: true },
      },
    },
  });
  if (!job) notFound();
  let brief: Record<string, unknown> = {};
  try {
    brief = JSON.parse(job.brief) as Record<string, unknown>;
  } catch {
    notFound();
  }
  if (brief.workflow !== "CANONICAL_WALMART_NEW_SKU") notFound();

  const ready = job.work_items.filter(
    (item) => item.status === "SUCCEEDED" && item.bundle_draft,
  );
  const failed = job.work_items.filter((item) => item.status === "FAILED");

  return (
    <>
      <PageHead
        title="Walmart draft review"
        subtitle={
          <span>
            {ready.length} of {job.bundles_target} internal drafts are ready.
            No UPC has been reserved and nothing has been published.
          </span>
        }
      />

      <Link
        href={`/bundle-factory/new/${job.id}`}
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={1.8} /> Batch progress
      </Link>

      {failed.length > 0 && (
        <div className="flex max-w-5xl items-start gap-2 rounded-[12px] border border-warn/30 bg-warn-tint p-4 text-[12.5px] text-warn-strong">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <div>
            {failed.length} draft{failed.length === 1 ? "" : "s"} failed.
            {failed.map((item) => (
              <div key={item.id} className="mt-1">
                #{item.spec_index + 1}: {item.last_error ?? "Unknown error"}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid max-w-5xl gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ready.map((item) => {
          const draft = item.bundle_draft!;
          const economics = previewEconomics(draft.approval_notes);
          const minShipping = economics?.minimum_customer_shipping_charge_cents;
          const maxShipping = economics?.maximum_customer_shipping_charge_cents;
          const shipping = minShipping === maxShipping
            ? money(minShipping)
            : `${money(minShipping)}–${money(maxShipping)}`;
          const minTotal = economics?.minimum_customer_total_cents;
          const maxTotal = economics?.maximum_customer_total_cents;
          const total = minTotal === maxTotal
            ? money(minTotal)
            : `${money(minTotal)}–${money(maxTotal)}`;
          return (
            <article
              key={item.id}
              className="overflow-hidden rounded-[14px] border border-rule bg-surface"
            >
              <div className="relative aspect-square bg-white">
                {draft.draft_main_image_url ? (
                  <Image
                    src={draft.draft_main_image_url}
                    alt={draft.draft_title ?? draft.draft_name}
                    fill
                    unoptimized
                    sizes="(min-width: 1280px) 320px, (min-width: 768px) 45vw, 90vw"
                    className="object-contain p-3"
                  />
                ) : null}
              </div>
              <div className="space-y-3 border-t border-rule p-4">
                <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
                  Draft {item.spec_index + 1} · Pack of {draft.pack_count}
                </div>
                <h2 className="text-[14px] font-semibold leading-snug text-ink">
                  {draft.draft_title ?? draft.draft_name}
                </h2>
                <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                  <div>
                    <div className="text-ink-3">Item price</div>
                    <div className="font-mono font-semibold text-ink">
                      {money(economics?.item_price_cents)}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-3">Buyer shipping</div>
                    <div className="font-mono font-semibold text-ink">
                      {shipping}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-ink-3">Customer total</div>
                    <div className="font-mono font-semibold text-ink">
                      {total}
                    </div>
                  </div>
                </div>
                <Link
                  href={`/bundle-factory/new/${job.id}/review/${draft.id}`}
                  className="inline-flex items-center gap-1 text-[12.5px] font-medium text-green-ink hover:underline"
                >
                  Open Walmart buyer preview
                  <ArrowRight size={14} />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
