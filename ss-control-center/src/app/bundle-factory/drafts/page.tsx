/**
 * Bundle Factory — Drafts.
 *
 * BundleDrafts in any non-DRAFT lifecycle state (VARIATION_SELECTED,
 * GENERATED, APPROVED, ERROR, etc.) — i.e. anything actively moving
 * through the pipeline.
 *
 * The table itself is a client component: the operator publishes one listing
 * from its row, or ticks a batch and publishes all of them with one press.
 */

import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import {
  DraftsTable,
  type DraftRow,
} from "@/components/bundle-factory/DraftsTable";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const drafts = await prisma.bundleDraft.findMany({
    where: { status: { not: "DRAFT" } },
    orderBy: { updated_at: "desc" },
    take: 100,
  });

  // Walmart state per row, so the list shows whether a listing is actually
  // publishable instead of only where the draft sits in the pipeline.
  const masterBundleIds = drafts
    .map((d) => d.master_bundle_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const walmartSkus = masterBundleIds.length
    ? await prisma.channelSKU.findMany({
        where: { channel: "WALMART", master_bundle_id: { in: masterBundleIds } },
        select: {
          master_bundle_id: true,
          sku: true,
          validation_status: true,
          listing_status: true,
          live_url: true,
          price_cents: true,
        },
      })
    : [];
  const walmartByMaster = new Map(
    walmartSkus.map((row) => [row.master_bundle_id, {
      sku: row.sku,
      validation_status: row.validation_status,
      listing_status: row.listing_status,
      live_url: row.live_url,
      price_cents: row.price_cents,
    }]),
  );

  const rows: DraftRow[] = drafts.map((d) => ({
    id: d.id,
    draft_name: d.draft_name,
    brand: d.brand,
    status: d.status,
    composition_type: d.composition_type,
    draft_cost_cents: d.draft_cost_cents,
    draft_suggested_price_cents: d.draft_suggested_price_cents,
    updated_at: fmtDate(d.updated_at),
    walmart: d.master_bundle_id
      ? walmartByMaster.get(d.master_bundle_id) ?? null
      : null,
  }));

  const tally = drafts.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});
  const readyToPublish = rows.filter(
    (row) =>
      row.walmart?.validation_status === "PASSED"
      && row.walmart.live_url == null
      && ["PENDING", "FAILED"].includes(row.walmart.listing_status),
  ).length;

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
            <span className="font-medium text-green-ink">
              {readyToPublish} ready to publish
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
          body="Drafts appear here as the pipeline advances them past the initial brief."
        />
      ) : (
        <DraftsTable rows={rows} />
      )}
    </>
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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface px-5 py-10 text-center">
      <div className="text-[13.5px] font-medium text-ink">{title}</div>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-3">
        {body}
      </p>
    </div>
  );
}
