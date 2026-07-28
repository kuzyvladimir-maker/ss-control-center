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
import {
  getPricingModel,
} from "@/lib/bundle-factory/pricing-config";
import { computeListingPrice } from "@/lib/bundle-factory/listing-pricing";
import { buildRichAmazonAttributes } from "@/lib/bundle-factory/attributes/build-amazon-attributes";
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
          channel_browse_node: true,
          validation_status: true,
          validation_errors: true,
          validated_at: true,
          validation_attempt_count: true,
          // Full attribute set (Phase 2.1 filler) + ship specs — surfaced in
          // the preview so the operator sees EVERY field that will publish.
          attributes: true,
          upc: true,
          country_of_origin: true,
          package_weight_oz: true,
          package_length_in: true,
          package_width_in: true,
          package_height_in: true,
          // Phase 2.5 distribution fields
          listing_status: true,
          submission_id: true,
          published_at: true,
          distribution_errors: true,
          distribution_attempt_count: true,
          last_status_check_at: true,
          asin: true,
          live_url: true,
        },
      })
    : [];
  const channelSkuByChannel: Record<
    string,
    {
      sku_id: string;
      sku: string;
      channel_browse_node: string | null;
      validation_status: string;
      validation_errors: string | null;
      validated_at: Date | null;
      validation_attempt_count: number;
      attributes: string | null;
      upc: string | null;
      country_of_origin: string | null;
      package_weight_oz: number | null;
      package_length_in: number | null;
      package_width_in: number | null;
      package_height_in: number | null;
      listing_status: string;
      submission_id: string | null;
      published_at: Date | null;
      distribution_errors: string | null;
      distribution_attempt_count: number;
      asin: string | null;
      live_url: string | null;
    }
  > = {};
  for (const cs of channelSkus) {
    channelSkuByChannel[cs.channel] = {
      sku_id: cs.id,
      sku: cs.sku,
      channel_browse_node: cs.channel_browse_node,
      validation_status: cs.validation_status,
      validation_errors: cs.validation_errors,
      validated_at: cs.validated_at,
      validation_attempt_count: cs.validation_attempt_count,
      attributes: cs.attributes,
      upc: cs.upc,
      country_of_origin: cs.country_of_origin,
      package_weight_oz: cs.package_weight_oz,
      package_length_in: cs.package_length_in,
      package_width_in: cs.package_width_in,
      package_height_in: cs.package_height_in,
      listing_status: cs.listing_status,
      submission_id: cs.submission_id,
      published_at: cs.published_at,
      distribution_errors: cs.distribution_errors,
      distribution_attempt_count: cs.distribution_attempt_count,
      asin: cs.asin,
      live_url: cs.live_url,
    };
  }

  // Auto retail price — the full cost-buildup calculator (goods + cooler/ice/box
  // + marketplace fees, solved for the target margin). Same math promote-draft
  // uses to set the published price, so the preview shows the REAL number.
  const pricingModel = await getPricingModel();
  const masterForPrice = draft.master_bundle_id
    ? await prisma.masterBundle.findUnique({
        where: { id: draft.master_bundle_id },
        select: { total_weight_oz: true },
      })
    : null;
  const priceWeightLb = masterForPrice?.total_weight_oz
    ? masterForPrice.total_weight_oz / 16
    : null;
  const priceCalc = computeListingPrice(
    {
      brand: draft.brand,
      cogs_cents: draft.draft_cost_cents ?? 0,
      weight_lb: priceWeightLb,
      unit_count: draft.pack_count,
      category: draft.category,
    },
    pricingModel,
  );
  const previewPriceCents = priceCalc.selling_price_cents;

  const channels = safeParse<string[]>(draft.target_channels) ?? [];
  const variants = draft.variation_matrix
    ? safeParse<Variant[]>(draft.variation_matrix.variants_json) ?? []
    : [];
  const selectedIdx = draft.variation_matrix?.selected_variant_idx ?? null;
  const selectedVariant =
    selectedIdx != null ? variants[selectedIdx] : undefined;

  // The bundle's components reference DonorProduct rows by id (a studio-built
  // component's research_pool_id IS the DonorProduct id). We load them ONCE and
  // use them for BOTH the photo gallery and the attribute preview below.
  const poolIds = (selectedVariant?.composition ?? [])
    .map((c) => c.research_pool_id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const donorRows = poolIds.length
    ? await prisma.donorProduct.findMany({
        where: { id: { in: poolIds } },
        select: {
          id: true,
          mainImageUrl: true,
          imageUrls: true,
          ingredients: true,
          size: true,
          unitMeasure: true,
          category: true,
          upc: true,
        },
      })
    : [];
  const donorById = new Map(donorRows.map((d) => [d.id, d]));
  // ResearchPool fallback for brief-built drafts (their component ids point at
  // ResearchPool rows, not DonorProduct).
  const poolRows = poolIds.length
    ? await prisma.researchPool.findMany({
        where: { id: { in: poolIds } },
        select: { id: true, reference_image_urls: true },
      })
    : [];
  const poolById = new Map(poolRows.map((p) => [p.id, p.reference_image_urls]));

  // Donor photos — the operator wants EVERY photo in the preview. Only the
  // title (main) image is generated; the rest are pulled from the donor
  // catalog. Order: generated main first, then per-component donor photos
  // (mainImageUrl + the imageUrls JSON array), then any draft-stored secondary
  // images, then the ResearchPool fallback. Deduped, order-preserving.
  const donorPhotos: string[] = [];
  {
    const seen = new Set<string>();
    const pushUrl = (u: unknown) => {
      if (typeof u !== "string") return;
      const url = u.trim();
      if (!url || seen.has(url)) return;
      seen.add(url);
      donorPhotos.push(url);
    };
    pushUrl(draft.draft_main_image_url);
    // Preserve composition order.
    for (const pid of poolIds) {
      const d = donorById.get(pid);
      if (d) {
        pushUrl(d.mainImageUrl);
        for (const u of safeParse<string[]>(d.imageUrls) ?? []) pushUrl(u);
      }
      for (const u of safeParse<string[]>(poolById.get(pid)) ?? []) pushUrl(u);
    }
    for (const u of safeParse<string[]>(draft.draft_secondary_images) ?? []) {
      pushUrl(u);
    }
  }

  // Attribute preview — at GENERATED stage there is no ChannelSKU yet, so the
  // rich attributes aren't stored anywhere. We preview only factual donor
  // ingredients, item count, and category-derived storage fields. Allergens
  // and expiration stay absent until reviewed manufacturer evidence exists.
  // Post-promotion the client prefers the real ChannelSKU.attributes.
  const primaryDonor = poolIds.length ? donorById.get(poolIds[0]) : undefined;
  const previewAttributes: Array<{ label: string; value: string }> = [];
  {
    const push = (label: string, value: string | null | undefined) => {
      const v = (value ?? "").toString().trim();
      if (v) previewAttributes.push({ label, value: v });
    };
    push("Brand", draft.brand);
    push("Number of items", String(draft.pack_count));
    if (primaryDonor?.size) push("Net content / size", primaryDonor.size);
    push("Category", draft.category.replace(/_/g, " ").toLowerCase());
    if (/FROZEN/i.test(draft.category)) push("Storage", "Keep frozen");
    else if (/REFRIGERATED/i.test(draft.category)) push("Storage", "Keep refrigerated");
    push("Country of origin", "United States");
    if (primaryDonor?.upc) push("Donor UPC (reference)", primaryDonor.upc);
    // Ingredient keyword scanning is deliberately not used as an authoritative
    // allergen declaration in either preview or publish.
    const rich = buildRichAmazonAttributes({
      ingredients: primaryDonor?.ingredients ?? null,
      packCount: draft.pack_count,
      category: draft.category,
    });
    const temp = rich.temperature_rating;
    if (Array.isArray(temp) && temp[0] && typeof temp[0] === "object") {
      push("Storage temperature", String((temp[0] as { value?: unknown }).value ?? ""));
    }
    const ing = primaryDonor?.ingredients?.trim();
    if (ing) push("Ingredients", ing.slice(0, 600));
    const allergens = rich.allergen_information;
    if (Array.isArray(allergens) && allergens.length > 0) {
      push(
        "Allergen information",
        allergens
          .map((a) => (a && typeof a === "object" ? (a as { value?: unknown }).value : a))
          .filter(Boolean)
          .join(", "),
      );
    }
  }

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
        previewPriceCents={previewPriceCents}
        pricing={{
          input: {
            cogs_cents: draft.draft_cost_cents ?? 0,
            weight_lb: priceWeightLb,
            category: draft.category,
            brand: draft.brand,
            unit_count: draft.pack_count,
          },
          model: pricingModel,
          result: priceCalc,
        }}
        donorPhotos={donorPhotos}
        previewAttributes={previewAttributes}
        brand={draft.brand}
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
            channel_browse_node: cs?.channel_browse_node ?? null,
            validation_status: cs?.validation_status ?? "PENDING",
            validation_errors_json: cs?.validation_errors ?? null,
            validation_attempt_count: cs?.validation_attempt_count ?? 0,
            // Full attribute set + ship specs for the preview.
            attributes_json: cs?.attributes ?? null,
            upc: cs?.upc ?? null,
            country_of_origin: cs?.country_of_origin ?? null,
            package_weight_oz: cs?.package_weight_oz ?? null,
            package_length_in: cs?.package_length_in ?? null,
            package_width_in: cs?.package_width_in ?? null,
            package_height_in: cs?.package_height_in ?? null,
            // Phase 2.5
            listing_status: cs?.listing_status ?? "PENDING",
            submission_id: cs?.submission_id ?? null,
            distribution_errors_json: cs?.distribution_errors ?? null,
            distribution_attempt_count: cs?.distribution_attempt_count ?? 0,
            asin: cs?.asin ?? null,
            live_url: cs?.live_url ?? null,
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
