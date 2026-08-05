/**
 * Bundle Factory — Drafts.
 *
 * BundleDrafts in any non-DRAFT lifecycle state (VARIATION_SELECTED,
 * GENERATED, APPROVED, ERROR, etc.) — i.e. anything actively moving
 * through the pipeline.
 *
 * The list is filtered and paged on the SERVER. It used to load the newest 100
 * rows and nothing else, so "select all and publish" could never reach a batch
 * of 200 — the owner's own scenario did not fit on his own screen. Filtering to
 * "ready to publish" narrows the list to exactly the rows a batch is made of,
 * so one tick selects the whole batch.
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { PUBLISHABLE_LISTING_STATUSES } from "@/lib/bundle-factory/publishable-listing-status";
import { PageHead, Sep } from "@/components/kit";
import {
  DraftsTable,
  type DraftRow,
} from "@/components/bundle-factory/DraftsTable";
import { DraftFilters } from "@/components/bundle-factory/DraftFilters";

export const dynamic = "force-dynamic";

const PAGE_SIZES = [50, 100, 250, 500] as const;
const DEFAULT_PAGE_SIZE = 100;

function readPageSize(value: string | undefined): number {
  const parsed = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(parsed)
    ? parsed
    : DEFAULT_PAGE_SIZE;
}

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = (one("q") ?? "").trim();
  const buildId = (one("build") ?? "").trim();
  const readyOnly = one("ready") === "1";
  const pageSize = readPageSize(one("size"));
  const page = Math.max(1, Number(one("page") ?? 1) || 1);

  // "Ready to publish" is a property of the SKU, not the draft, so that filter
  // starts from the SKUs and narrows the drafts to their bundles.
  const readySkuWhere = {
    channel: "WALMART",
    validation_status: "PASSED",
    live_url: null,
    listing_status: { in: [...PUBLISHABLE_LISTING_STATUSES] },
  } satisfies Prisma.ChannelSKUWhereInput;

  let readyMasterBundleIds: string[] | null = null;
  if (readyOnly) {
    const readySkus = await prisma.channelSKU.findMany({
      where: readySkuWhere,
      select: { master_bundle_id: true },
    });
    readyMasterBundleIds = readySkus.map((row) => row.master_bundle_id);
  }

  const where: Prisma.BundleDraftWhereInput = {
    status: { not: "DRAFT" },
    ...(search ? { draft_name: { contains: search } } : {}),
    ...(buildId ? { generation_job_id: buildId } : {}),
    ...(readyMasterBundleIds
      ? { master_bundle_id: { in: readyMasterBundleIds } }
      : {}),
  };

  const [matching, drafts, readyTotal] = await Promise.all([
    prisma.bundleDraft.count({ where }),
    prisma.bundleDraft.findMany({
      where,
      orderBy: { updated_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    // Ready across the WHOLE catalogue, not just this page, so the operator
    // knows how big the batch he is assembling actually is.
    prisma.channelSKU.count({ where: readySkuWhere }),
  ]);

  const masterBundleIds = drafts
    .map((d) => d.master_bundle_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const walmartSkus = masterBundleIds.length
    ? await prisma.channelSKU.findMany({
        where: { channel: "WALMART", master_bundle_id: { in: masterBundleIds } },
        select: {
          id: true,
          master_bundle_id: true,
          sku: true,
          upc: true,
          validation_status: true,
          listing_status: true,
          live_url: true,
          price_cents: true,
        },
      })
    : [];

  // A listing whose own product ID was quarantined by a Walmart collision can
  // never publish again under that number, so the row must offer a replacement
  // instead of a Publish button that is guaranteed to fail. `burned_upcs`
  // counts how many numbers this listing has already consumed — more than one
  // means the collision is not about the number.
  const quarantined = walmartSkus.length
    ? await prisma.uPCPool.findMany({
        where: { status: "QUARANTINED" },
        select: { upc: true, notes: true },
      })
    : [];
  const quarantinedUpcs = new Set(quarantined.map((row) => row.upc));
  const burnedBySku = new Map<string, number>();
  for (const row of quarantined) {
    const match = /SKU ([A-Z0-9-]+)/.exec(row.notes ?? "");
    if (!match) continue;
    burnedBySku.set(match[1], (burnedBySku.get(match[1]) ?? 0) + 1);
  }

  const walmartByMaster = new Map(
    walmartSkus.map((row) => [row.master_bundle_id, {
      id: row.id,
      sku: row.sku,
      validation_status: row.validation_status,
      listing_status: row.listing_status,
      live_url: row.live_url,
      price_cents: row.price_cents,
      upc_quarantined: quarantinedUpcs.has(row.upc),
      burned_upcs: burnedBySku.get(row.sku) ?? 0,
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

  const totalPages = Math.max(1, Math.ceil(matching / pageSize));

  return (
    <>
      <PageHead
        title="Drafts"
        subtitle={
          <>
            <span className="font-medium text-ink-2">
              {matching} draft{matching === 1 ? "" : "s"} match
            </span>
            <Sep />
            <span className="font-medium text-green-ink">
              {readyTotal} ready to publish
            </span>
            <Sep />
            <span className="font-mono tabular-nums">
              page {page} of {totalPages}
            </span>
          </>
        }
      />

      <DraftFilters
        search={search}
        buildId={buildId}
        readyOnly={readyOnly}
        pageSize={pageSize}
        pageSizes={[...PAGE_SIZES]}
        page={page}
        totalPages={totalPages}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          body={
            search || buildId || readyOnly
              ? "No draft matches these filters. Clear them to see the whole pipeline."
              : "Drafts appear here as the pipeline advances them past the initial brief."
          }
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
